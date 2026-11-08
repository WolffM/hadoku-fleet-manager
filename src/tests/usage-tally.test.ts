/**
 * Repeats of one CLI call shape are tallied per hour, not logged per call
 * (fleet-manager#74): cardtable's per-minute `node-status` + `hosting-demand`
 * were 68% of November's rows and would have hit the month cap on the 19th.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { summariseUsage } from '../lib/usage-log.js';
import { STALE_CLAIM_MS, appendCliCall, readUsage } from '../lib/usage-store.js';

const dirs: string[] = [];
const fresh = (): string => {
	const d = mkdtempSync(join(tmpdir(), 'usage-tally-'));
	dirs.push(d);
	return d;
};
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const call = (at: Date, sub: string, ms: number, extra = {}) => ({
	v: 1,
	kind: 'cli',
	at: at.toISOString(),
	sub,
	exit: 0,
	signal: null,
	caller: 'pm2:cardtable',
	flags: ['--json'],
	host: 'h',
	ms,
	...extra,
});

const monthLines = (dir: string, month: string): Record<string, unknown>[] =>
	readFileSync(join(dir, `usage-${month}.jsonl`), 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);

const at = (h: number, m: number) => new Date(Date.UTC(2026, 10, 8, h, m));

void test('the first call of a shape in an hour is a full row; repeats are a tally, rolled up once the hour ends', () => {
	const dir = fresh();
	for (let m = 0; m < 60; m++)
		appendCliCall(dir, call(at(10, m), 'node-status', 100 + m), at(10, m));
	appendCliCall(dir, call(at(10, 5), 'node-status', 50, { exit: 1 }), at(10, 5));
	assert.deepEqual(
		monthLines(dir, '2026-11').map((r) => [r.kind, r.exit]),
		[
			['cli', 0],
			['cli', 1],
		],
		'a different exit code is a different shape, so a failure is never folded into successes'
	);

	appendCliCall(dir, call(at(11, 0), 'node-status', 7), at(11, 0));
	const rows = monthLines(dir, '2026-11');
	const tally = rows.find((r) => r.kind === 'cli-tally');
	assert.ok(tally, 'the hour-10 repeats rolled into one row');
	assert.equal(tally.count, 59);
	assert.equal(tally.from, at(10, 1).toISOString());
	assert.equal(tally.at, at(10, 59).toISOString());
	assert.equal(tally.msMax, 159);
	assert.equal(tally.msTotal, ((101 + 159) * 59) / 2);
	assert.equal(tally.caller, 'pm2:cardtable');
	assert.equal(rows.length, 4, 'two hour-10 shapes, one tally, one hour-11 first call');
	assert.deepEqual(readdirSync(join(dir, 'tally')), ['2026-11-08T11'], 'the rolled hour is gone');
});

void test('the reader counts every call, including repeats of the hour not rolled up yet', () => {
	const dir = fresh();
	for (let m = 0; m < 5; m++) appendCliCall(dir, call(at(9, m), 'hosting-demand', 1), at(9, m));
	for (let m = 0; m < 3; m++) appendCliCall(dir, call(at(10, m), 'hosting-demand', 1), at(10, m));
	const read = readUsage(dir, at(0, 0).getTime());
	const s = summariseUsage(read.records, {
		sinceMs: at(0, 0).getTime(),
		commands: ['hosting-demand'],
		routes: [],
	});
	assert.equal(s.commands[0].count, 8);
	assert.deepEqual(s.commands[0].callers, { 'pm2:cardtable': 8 });
	assert.deepEqual(s.commands[0].flags, { '--json': 8 });
	assert.equal(s.commands[0].lastAt, at(10, 2).toISOString());
});

void test('a tally of the last hour of a month lands in THAT month, not the next', () => {
	const dir = fresh();
	const late = new Date(Date.UTC(2026, 9, 31, 23, 10));
	appendCliCall(dir, call(late, 'x', 1), late);
	appendCliCall(dir, call(late, 'x', 1), late);
	const next = new Date(Date.UTC(2026, 10, 1, 0, 1));
	appendCliCall(dir, call(next, 'x', 1), next);
	assert.deepEqual(
		monthLines(dir, '2026-10').map((r) => r.kind),
		['cli', 'cli-tally']
	);
	assert.deepEqual(
		monthLines(dir, '2026-11').map((r) => r.kind),
		['cli']
	);
});

void test('a claim left by a dead roll-up is taken over once stale, and written exactly once', () => {
	const dir = fresh();
	appendCliCall(dir, call(at(9, 0), 'x', 1), at(9, 0));
	appendCliCall(dir, call(at(9, 1), 'x', 1), at(9, 1));
	const hourDir = join(dir, 'tally', '2026-11-08T09');
	const [f] = readdirSync(hourDir);
	const claimed = join(hourDir, f.replace('.tally', '.999999.claimed'));
	renameSync(join(hourDir, f), claimed);

	appendCliCall(dir, call(at(10, 0), 'y', 1), at(10, 0));
	assert.ok(existsSync(claimed), 'a fresh claim belongs to a live roll-up');

	const old = (at(10, 0).getTime() - STALE_CLAIM_MS - 1000) / 1000;
	utimesSync(claimed, old, old);
	appendCliCall(dir, call(at(10, 1), 'y', 1), at(10, 1));
	appendCliCall(dir, call(at(10, 2), 'y', 1), at(10, 2));
	assert.equal(monthLines(dir, '2026-11').filter((r) => r.kind === 'cli-tally').length, 1);
	assert.ok(!existsSync(hourDir));
});
