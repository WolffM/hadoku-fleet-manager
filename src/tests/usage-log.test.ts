/**
 * The invocation log's record, its storage, and the router's share of it.
 * The door end-to-end (exit codes, byte-identical stdout, a failed write) is
 * `scripts/lib/usage-door.test.mjs`, which runs the built CLI.
 *
 * Every directory here is a mkdtemp NAMED through FLEET_USAGE_DIR or passed
 * directly — never the state-dir default.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	FLEET_ROUTES,
	callerOf,
	flagNames,
	flushRouteHits,
	recordRouteHit,
	subName,
	summariseUsage,
	usageDir,
	type CallerHints,
} from '../lib/usage-log.js';
import { MAX_FILE_BYTES, RETAIN_DAYS, appendUsage, readUsage } from '../lib/usage-store.js';
import { router } from '../routes/fleet.js';

const dirs: string[] = [];
const fresh = (): string => {
	const d = mkdtempSync(join(tmpdir(), 'usage-log-'));
	dirs.push(d);
	return d;
};
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

void test('flag NAMES only: values, positionals and value-shaped dashes never survive', () => {
	assert.deepEqual(
		flagNames([
			'--machine=claw-3',
			'--token',
			'ghp_SECRET',
			'list',
			'-5',
			'--json',
			'--json',
			'--=x',
			'--',
			'--after-terminator',
		]),
		['--machine', '--token', '--json']
	);
});

void test('a subcommand that is not name-shaped is not recorded as typed', () => {
	assert.equal(subName('queue-health'), 'queue-health');
	assert.equal(subName('ghp_abc def'), '<not-a-name>');
	assert.equal(subName(undefined), null);
});

void test('under a test runner the log is OFF unless a directory is named', () => {
	// This process IS under `node --test`: the default must not reach a state dir.
	const prev = process.env.FLEET_USAGE_DIR;
	try {
		delete process.env.FLEET_USAGE_DIR;
		assert.ok(process.env.NODE_TEST_CONTEXT, 'precondition: running under node --test');
		assert.equal(
			usageDir(() => {
				throw new Error('the state dir must not even be asked');
			}),
			null
		);
		process.env.FLEET_USAGE_DIR = '/some/where';
		assert.equal(
			usageDir(() => '/nope'),
			'/some/where'
		);
		process.env.FLEET_USAGE_DIR = 'off';
		assert.equal(
			usageDir(() => '/nope'),
			null
		);
	} finally {
		if (prev === undefined) delete process.env.FLEET_USAGE_DIR;
		else process.env.FLEET_USAGE_DIR = prev;
	}
});

void test('callerOf: the most specific evidence wins', () => {
	const base: CallerHints = {
		tty: false,
		ancestry: [],
		pm2: null,
		declared: null,
		ci: false,
		agent: false,
		ssh: false,
	};
	assert.equal(
		callerOf({ ...base, pm2: 'mgmt-api', declared: 'ci:queue-health' }),
		'ci:queue-health'
	);
	assert.equal(callerOf({ ...base, pm2: 'mgmt-api', agent: true }), 'pm2:mgmt-api');
	assert.equal(callerOf({ ...base, ancestry: ['sh', 'cron'] }), 'cron');
	assert.equal(callerOf({ ...base, ssh: true, tty: true }), 'ssh-tty');
	assert.equal(callerOf({ ...base, tty: true }), 'tty');
	assert.equal(callerOf(base), 'other');
});

void test('store: appends land in the month file and read back whole', () => {
	const dir = fresh();
	const at = new Date(Date.UTC(2026, 9, 28, 12));
	appendUsage(dir, { v: 1, kind: 'cli', at: at.toISOString(), sub: 'a' }, at);
	appendUsage(dir, { v: 1, kind: 'cli', at: at.toISOString(), sub: 'b' }, at);
	writeFileSync(join(dir, 'usage-2026-10.jsonl'), '{torn\n', { flag: 'a' });
	const r = readUsage(dir, Date.UTC(2026, 9, 1));
	assert.deepEqual(
		r.records.map((x) => x.sub),
		['a', 'b']
	);
	assert.equal(r.malformed, 1, 'a torn line is counted, never hidden');
	assert.equal(r.oldestMonth, '2026-10');
});

void test('store: opening a month prunes months older than the retention, never younger', () => {
	const dir = fresh();
	const now = new Date(Date.UTC(2026, 9, 28));
	// Ended 2026-04-01: 210 days before now — past RETAIN_DAYS.
	writeFileSync(join(dir, 'usage-2026-03.jsonl'), '{}\n');
	// Ended 2026-07-01: 119 days — inside it.
	writeFileSync(join(dir, 'usage-2026-06.jsonl'), '{}\n');
	writeFileSync(join(dir, 'not-ours.txt'), 'x');
	assert.ok(RETAIN_DAYS >= 120, 'the question needs 120 days of history');
	appendUsage(dir, { v: 1 }, now);
	assert.deepEqual(readdirSync(dir).sort(), [
		'not-ours.txt',
		'usage-2026-06.jsonl',
		'usage-2026-10.jsonl',
	]);
});

void test('store: a month past its cap refuses by THROWING, so the caller can say so', () => {
	const dir = fresh();
	const now = new Date(Date.UTC(2026, 9, 28));
	appendUsage(dir, { v: 1 }, now);
	writeFileSync(join(dir, 'usage-2026-10.jsonl'), Buffer.alloc(MAX_FILE_BYTES));
	assert.throws(() => appendUsage(dir, { v: 1 }, now), /cap/);
});

void test('summary: counts, last run, exit mix, unused doors and unknown names', () => {
	const rec = (sub: string, at: string, exit: number | null, extra = {}) => ({
		v: 1,
		kind: 'cli',
		at,
		sub,
		exit,
		signal: null,
		caller: 'pm2:mgmt-api',
		outcome: 'ran',
		host: 'hokon',
		flags: ['--json'],
		...extra,
	});
	const s = summariseUsage(
		[
			rec('queue-health', '2026-10-27T00:00:00.000Z', 0),
			rec('queue-health', '2026-10-28T00:00:00.000Z', 1),
			rec('queue-health', '2026-01-01T00:00:00.000Z', 0), // outside the window
			rec('qeueu-health', '2026-10-28T00:00:00.000Z', 1, { outcome: 'unknown-subcommand' }),
			rec('drain', '2026-10-28T00:00:00.000Z', null, { signal: 'SIGTERM', caller: 'tty' }),
			{ v: 2, kind: 'cli', at: '2026-10-28T00:00:00.000Z', sub: 'future-schema' },
			{
				v: 1,
				kind: 'route',
				at: '2026-10-28T00:00:00.000Z',
				method: 'GET',
				route: '/fleet',
				status: 200,
				count: 40,
				msMax: 12,
			},
		],
		{
			sinceMs: Date.parse('2026-10-01T00:00:00.000Z'),
			commands: ['queue-health', 'drain', 'register'],
			routes: FLEET_ROUTES,
		}
	);
	const qh = s.commands.find((c) => c.sub === 'queue-health');
	assert.equal(qh?.count, 2);
	assert.equal(qh?.lastAt, '2026-10-28T00:00:00.000Z');
	assert.deepEqual(qh?.exits, { 0: 1, 1: 1 });
	assert.deepEqual(qh?.callers, { 'pm2:mgmt-api': 2 });
	assert.deepEqual(s.commands.find((c) => c.sub === 'drain')?.exits, { SIGTERM: 1 });
	assert.deepEqual(s.unusedCommands, ['register']);
	assert.deepEqual(
		s.unknownCommands.map((c) => c.sub),
		['qeueu-health']
	);
	assert.deepEqual(s.routes, [
		{
			route: 'GET /fleet',
			count: 40,
			lastAt: '2026-10-28T00:00:00.000Z',
			statuses: { 200: 40 },
			msMax: 12,
		},
	]);
	assert.deepEqual(s.unusedRoutes, ['GET /fleet/ci-state', 'POST /fleet/job-history/backfill']);
	assert.equal(s.records, 5, 'the out-of-window and unknown-schema records are not counted');
});

/** The router's own table: `METHOD /pattern` and the name of each route's first handler. */
function routerRoutes(): Array<{ route: string; first: string }> {
	const stack = (
		router as unknown as {
			stack: Array<{
				route?: {
					path: string;
					methods?: Record<string, boolean>;
					stack: Array<{ name: string; method?: string }>;
				};
			}>;
		}
	).stack;
	const out: Array<{ route: string; first: string }> = [];
	for (const layer of stack) {
		if (!layer.route) continue;
		const methods = Object.keys(layer.route.methods ?? {}).filter((m) => m !== '_all');
		for (const m of methods)
			out.push({
				route: `${m.toUpperCase()} ${layer.route.path}`,
				first: layer.route.stack[0]?.name ?? '',
			});
	}
	return out;
}

void test('FLEET_ROUTES is exactly the router, and every route counts its hits first', () => {
	const routes = routerRoutes();
	assert.deepEqual(
		routes.map((r) => r.route).sort(),
		[...FLEET_ROUTES].sort(),
		'a route added to routes/fleet.ts must be added to FLEET_ROUTES, or `fleet usage` cannot call it unused'
	);
	for (const r of routes)
		assert.equal(r.first, 'countHit', `${r.route} does not record into the invocation log`);
});

void test('route hits are bucketed by pattern and status, and flushed as one line each', () => {
	const dir = fresh();
	const prev = process.env.FLEET_USAGE_DIR;
	process.env.FLEET_USAGE_DIR = dir;
	try {
		const ctx = { stateDir: () => '/must-not-be-used', version: () => '9.9.9' };
		recordRouteHit({ method: 'GET', route: '/fleet', status: 200, ms: 5 }, ctx);
		recordRouteHit({ method: 'GET', route: '/fleet', status: 200, ms: 9 }, ctx);
		recordRouteHit({ method: 'GET', route: '/fleet', status: 500, ms: 1 }, ctx);
		flushRouteHits();
		const lines = readdirSync(dir).flatMap((f) =>
			readFileSync(join(dir, f), 'utf8').trim().split('\n')
		);
		const recs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
		assert.equal(recs.length, 2);
		const ok = recs.find((r) => r.status === 200);
		assert.equal(ok?.count, 2);
		assert.equal(ok?.msMax, 9);
		assert.equal(ok?.msTotal, 14);
		assert.equal(ok?.version, '9.9.9');
		assert.equal(ok?.route, '/fleet');
		flushRouteHits();
		assert.equal(
			readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n')).length,
			2,
			'a flush with nothing pending writes nothing'
		);
	} finally {
		if (prev === undefined) delete process.env.FLEET_USAGE_DIR;
		else process.env.FLEET_USAGE_DIR = prev;
	}
});
