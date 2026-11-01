/**
 * `fleet stats` — strict argv (run DIRECTLY, bypassing the door, same rig
 * `job-rollups.test.mjs`/`failures.test.mjs` use) PLUS a functional pass
 * over fixture T2/T4/T5/T7 stores, since this script's whole job is reading
 * those four stores and wiring them into `fleet-stats.ts` — the computation
 * itself is unit-tested in `src/tests/fleet-stats.test.ts` and is not
 * re-derived here.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, cleanupTempDirs } from './lib/test-tmpdir.mjs';

after(cleanupTempDirs);

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'stats.mjs');

const STUBS = [
	'ssh',
	'scp',
	'rsync',
	'gh',
	'sudo',
	'apt',
	'apt-get',
	'systemctl',
	'npm',
	'pnpm',
	'curl',
];

function sandbox() {
	const dir = tempDir('stats-strict-argv-');
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	mkdirSync(join(dir, 'home'));
	mkdirSync(join(dir, 'state'));
	const log = join(dir, 'touched.log');
	for (const s of STUBS) {
		writeFileSync(join(bin, s), `#!/bin/sh\necho "${s} $*" >> "${log}"\nexit 97\n`);
		chmodSync(join(bin, s), 0o755);
	}
	return { dir, bin, log };
}

function run(args, sb) {
	return spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: 'utf8',
		timeout: 15_000,
		env: {
			PATH: `${sb.bin}:${process.env.PATH}`,
			HOME: join(sb.dir, 'home'),
			HADOKU_STATE_DIR: join(sb.dir, 'state'),
			FLEET_MANIFEST_DIR: join(sb.dir, 'no-manifests'),
			HADOKU_SITE_ROOT: join(sb.dir, 'no-site'),
			REPOS_DIR: join(sb.dir, 'no-repos'),
			MGMT_API_URL: 'http://127.0.0.1:9',
			FLEET_NO_BANNER: '1',
		},
	});
}

test('fleet-manager#F8: stats.mjs run DIRECTLY with an unknown flag exits 2 and touches nothing', () => {
	const sb = sandbox();
	const r = run(['--not-a-real-flag'], sb);
	const touched = existsSync(sb.log) ? readFileSync(sb.log, 'utf8').trim() : '';
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.match(r.stdout + r.stderr, /unknown flag\(s\) --not-a-real-flag/);
	assert.equal(touched, '', `stats.mjs called external tools:\n${touched}`);
});

test('--help still answers, even in the same sandbox, and touches nothing', () => {
	const sb = sandbox();
	const r = run(['--help'], sb);
	const touched = existsSync(sb.log) ? readFileSync(sb.log, 'utf8').trim() : '';
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /fleet stats/);
	assert.equal(touched, '', `stats.mjs --help called external tools:\n${touched}`);
});

test('--days must be a positive integer', () => {
	const sb = sandbox();
	const r = run(['--days', 'nope', '--json'], sb);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, false);
	assert.match(doc.error, /--days must be a positive integer/);
});

test('an entirely empty state dir: every section is COULD NOT LOOK, never zeros, overall exit 1', () => {
	const sb = sandbox();
	const r = run(['--json'], sb);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, false);
	for (const key of ['daily', 'byRepo', 'automation', 'capacity', 'budget']) {
		assert.equal(doc[key].ok, false, `${key} should be could-not-look`);
		assert.match(doc[key].why, /\S/, `${key}.why must say something`);
		assert.equal(
			Object.hasOwn(doc[key], 'rows'),
			false,
			`${key} must carry no rows when unavailable`
		);
	}
});

test('human mode: an empty state dir prints COULD NOT LOOK for every section, never an empty table', () => {
	const sb = sandbox();
	const r = run([], sb);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const sections = r.stdout.split('\n\n').slice(1);
	assert.equal(sections.length, 5, r.stdout);
	for (const s of sections) assert.match(s, /COULD NOT LOOK:/, s);
});

// ── functional: real fixture stores, read for real ──────────────────────────

const NO_SPREAD = { n: 0, p50: null, p95: null };
function zoneCounts(partial = {}) {
	return { runner: 0, seam: 0, content: 0, fleet: 0, cancelled: 0, ...partial };
}
function rollupRow(node, repo, kind, jobs, fails = {}, queueSec = NO_SPREAD) {
	const z = zoneCounts(fails);
	const failed = Object.values(z).reduce((a, b) => a + b, 0);
	return {
		node,
		repo,
		kind,
		jobs,
		conclusions: { success: jobs - failed, failure: failed },
		failuresByZone: z,
		durationSec: NO_SPREAD,
		queueSec,
		dispatchSec: NO_SPREAD,
		assignSec: NO_SPREAD,
		setupSec: NO_SPREAD,
		byClass: {},
	};
}

function writeRollupFixture(sb, day, rows) {
	const rollup = {
		schema: 1,
		day,
		writtenAt: `${day}T06:00:00.000Z`,
		completeSince: `${day}T00:00:00.000Z`,
		records: rows.reduce((a, r) => a + r.jobs, 0),
		probesExcluded: 0,
		rows,
	};
	writeFileSync(join(sb.dir, 'state', 'job-rollups.jsonl'), `${JSON.stringify(rollup)}\n`);
}

function writeJobRunFixture(sb, job, verdict) {
	mkdirSync(join(sb.dir, 'state', 'job-runs'), { recursive: true });
	const day = new Date().toISOString().slice(0, 10);
	const row = {
		v: 1,
		job,
		startedAt: new Date().toISOString(),
		durationMs: 500,
		kind: 'gate',
		verdict,
		findings: null,
		why: null,
		host: 'test',
	};
	writeFileSync(join(sb.dir, 'state', 'job-runs', `run-${day}.jsonl`), `${JSON.stringify(row)}\n`);
}

function writeCapacityFixture(sb, rows) {
	const full = rows.map((r) => ({
		at: new Date().toISOString(),
		node: 'claw-1',
		maxConcurrent: 4,
		admissionCapacity: 4,
		admissionFree: 2,
		admissionBasis: 'dispatcher',
		state: 'free',
		drained: false,
		refusalReason: null,
		unmeasured: false,
		...r,
	}));
	writeFileSync(
		join(sb.dir, 'state', 'capacity-samples.jsonl'),
		`${full.map((r) => JSON.stringify(r)).join('\n')}\n`
	);
}

function writeBudgetFixture(sb, over = {}) {
	const row = {
		windowEnd: new Date().toISOString(),
		token: 'main',
		resource: 'core',
		limit: 5000,
		usedAtEnd: 1200,
		remainingAtEnd: 3800,
		byCaller: [{ caller: 'ci:queue-health', charged: 40, notModified: 100 }],
		restarts: 0,
		...over,
	};
	writeFileSync(join(sb.dir, 'state', 'gh-budget-history.jsonl'), `${JSON.stringify(row)}\n`);
}

test('daily/byRepo: real rollup fixture — jobs, conclusions and the weighted queue mean', () => {
	const sb = sandbox();
	const today = new Date().toISOString().slice(0, 10);
	writeRollupFixture(sb, today, [
		rollupRow(
			'*',
			'WolffM/hadoku-cardtable',
			'build',
			80,
			{ runner: 4 },
			{ n: 80, p50: 10, p95: 20 }
		),
		rollupRow('*', 'WolffM/hadoku-cardtable', 'test', 20, {}, { n: 20, p50: 30, p95: 60 }),
		rollupRow(
			'claw-1',
			'WolffM/hadoku-cardtable',
			'build',
			80,
			{ runner: 4 },
			{ n: 80, p50: 10, p95: 20 }
		),
	]);
	const r = run(['--json'], sb);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, true);
	assert.equal(doc.daily.ok, true);
	assert.equal(doc.daily.rows.length, 1);
	assert.equal(
		doc.daily.rows[0].jobs,
		100,
		'only the fleet row counts, never the per-node row too'
	);
	// weighted p50 = (80*10 + 20*30)/100 = 14
	assert.equal(doc.daily.rows[0].queueSec.p50, 14);
	assert.equal(doc.byRepo.ok, true);
	assert.equal(doc.byRepo.rows[0].repo, 'WolffM/hadoku-cardtable');
	assert.equal(doc.byRepo.rows[0].jobs, 100);
});

test('automation: a registry job with no run in window is NO RUNS, never folded into a clean verdict mix', () => {
	const sb = sandbox();
	writeJobRunFixture(sb, 'ci:fleet-coverage', 'ok');
	const r = run(['--json'], sb);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.automation.ok, true);
	const byJob = Object.fromEntries(doc.automation.rows.map((j) => [j.job, j]));
	assert.equal(byJob['ci:fleet-coverage'].runs, 1);
	assert.equal(byJob['ci:fleet-coverage'].verdictCounts.ok, 1);
	// some other registered job that this fixture never ran
	const neverRan = doc.automation.rows.find((j) => j.runs === 0);
	assert.ok(neverRan, 'at least one registry job has zero runs in this fixture');
	assert.equal(neverRan.lastRun, null);

	const human = run([], sb).stdout;
	assert.match(human, /NO RUNS observed in this window/);
});

test('capacity: at-capacity and unmeasured shares, per node, never conflated', () => {
	const sb = sandbox();
	writeCapacityFixture(sb, [
		{ admissionFree: 0 },
		{ unmeasured: true, admissionCapacity: null, admissionFree: null },
	]);
	const r = run(['--json'], sb);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.capacity.ok, true);
	const [claw1] = doc.capacity.rows;
	assert.equal(claw1.samples, 2);
	assert.equal(claw1.atCapacity, 1);
	assert.equal(claw1.unmeasured, 1);
});

test('budget: peak used/limit and top callers', () => {
	const sb = sandbox();
	writeBudgetFixture(sb);
	const r = run(['--json'], sb);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.budget.ok, true);
	assert.equal(doc.budget.rows[0].peakUsed, 1200);
	assert.equal(doc.budget.rows[0].topCallers[0].caller, 'ci:queue-health');
});

test('one section available, the rest could-not-look: overall ok true, those sections still COULD NOT LOOK', () => {
	const sb = sandbox();
	writeBudgetFixture(sb);
	const r = run(['--json'], sb);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, true, 'one real section is enough to make the command ok');
	assert.equal(doc.budget.ok, true);
	assert.equal(doc.daily.ok, false);
	assert.equal(doc.automation.ok, false);
	assert.equal(doc.capacity.ok, false);
});

test('--days narrows the rollup window — a day outside it is COULD NOT LOOK, not silently dropped', () => {
	const sb = sandbox();
	const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
	writeRollupFixture(sb, longAgo, [rollupRow('*', 'WolffM/a', 'build', 5)]);
	const r = run(['--days', '7', '--json'], sb);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.daily.ok, false);
	assert.match(doc.daily.why, /none fall in the last 7 day\(s\)/);
});
