/**
 * fleet-manager#49 — `GET /fleet` re-folded the whole 14-day history on every
 * request. `job-history-fold.ts` now memoises the baseline over the store's
 * array on `historyVersion()` and the UTC day, and cuts only the trailing hour
 * per request.
 *
 * A memo is a cache, and a cache's failure is a STALE answer that looks like a
 * fresh one. So every test here pins one way it could go stale, and the memo's
 * hit is proven by object identity, never by a stopwatch: a timing assertion
 * flakes on a loaded runner, and the fleet's runners are loaded by design.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	__resetJobHistoryForTesting,
	__setHistoryPathForTesting,
	appendRecords,
	jobRecords,
	patchRecord,
	type JobRecord,
} from '../job-history-store.js';
import { foldSummary } from '../job-history-fold.js';
import { RECENT_WINDOW_MS, summarise } from '../job-history-stats.js';

const NODES = ['claw-1', 'claw-2', 'hokon'];
const NOW = Date.parse('2026-11-06T02:00:00.000Z');
const MIN = 60_000;

let jobId = 0;
function rec(
	runner: string,
	startMinAgo: number,
	durationSec: number,
	extra: Partial<JobRecord> = {}
): JobRecord {
	return {
		repo: 'WolffM/hadoku_site',
		runId: 1,
		jobId: ++jobId,
		name: 'check',
		runner,
		labels: ['hadoku-builder'],
		startedAt: new Date(NOW - startMinAgo * MIN).toISOString(),
		durationSec,
		conclusion: 'success',
		...extra,
	};
}

/** The store's own window, filled the way ingest fills it. */
function seed(...rs: JobRecord[]): void {
	appendRecords(rs);
}

const fold = (now = NOW) => foldSummary(NODES, 'hokon', jobRecords(), now, RECENT_WINDOW_MS);
/** The same fold over a COPY, which the memo never applies to. */
const fresh = (now = NOW) => foldSummary(NODES, 'hokon', [...jobRecords()], now, RECENT_WINDOW_MS);

let dir = '';
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'fold-'));
	__setHistoryPathForTesting(join(dir, 'job-history.jsonl'));
});
afterEach(() => {
	__resetJobHistoryForTesting();
	__setHistoryPathForTesting(null);
	rmSync(dir, { recursive: true, force: true });
});

test('a second request against unchanged history reuses the baseline', () => {
	seed(rec('warm-claw-1-hadoku_site', 300, 60), rec('warm-claw-2-hadoku_site', 10, 30));
	const a = fold();
	const b = fold(NOW + 15_000);
	assert.equal(b.daily, a.daily, 'same day, same version: the daily list is the memoised one');
	assert.equal(b.recent, a.recent);
});

test('the memoised answer is the answer a fresh fold gives', () => {
	seed(
		rec('warm-claw-1-hadoku_site', 2000, 61),
		rec('jit-claw-2-hadoku-conjure-j1-r2-3', 45, 120, { conclusion: 'failure' }),
		rec('warm-hokon-hadoku_site', 30, 40),
		rec('warm-hokon-hadoku_site', 20, 40, { labels: ['pm2-host'] }),
		rec('warm-claw-1-hadoku_site', 5, 90, { repo: 'WolffM/hadoku-rally', queueSec: 12 })
	);
	fold();
	assert.deepEqual(fold(NOW + 7 * MIN), fresh(NOW + 7 * MIN));
});

test('the trailing hour moves with the clock, with no history change at all', () => {
	// Finished 50 min before NOW: inside the hour at NOW, outside it 15 min later.
	seed(rec('warm-claw-1-hadoku_site', 51, 60));
	const at = (now: number) => fold(now).byMachine.find((m) => m.machine === 'claw-1')!;
	assert.equal(at(NOW).recentJobs, 1);
	assert.equal(at(NOW + 15 * MIN).recentJobs, 0);
	assert.equal(at(NOW + 15 * MIN).recentMedianSec, null, 'an empty hour is no data, never 0');
	assert.equal(at(NOW + 15 * MIN).jobs, 1, 'the baseline still holds it');
});

test('an appended record is seen on the next request', () => {
	seed(rec('warm-claw-1-hadoku_site', 30, 60));
	assert.equal(fold().total, 1);
	seed(rec('warm-claw-2-hadoku_site', 20, 60));
	const s = fold();
	assert.equal(s.total, 2);
	assert.deepEqual(s, fresh());
});

test('a record edited IN PLACE (the backfill shape) is seen at once', () => {
	const r = rec('warm-claw-1-hadoku_site', 30, 60);
	seed(r);
	assert.equal(fold().byMachine[0].failures, 0);
	patchRecord(r, { conclusion: 'failure', failedStep: 'Run tests' });
	assert.equal(fold().byMachine[0].failures, 1);
	assert.deepEqual(fold(), fresh());
});

test('a runner renamed in place is re-attributed, not kept on its old node', () => {
	// The per-record cache lives across folds, keyed on the record object; it
	// must re-derive when the fields it was derived from change.
	const r = rec('warm-claw-1-hadoku_site', 30, 60);
	seed(r);
	assert.equal(fold().byMachine[0].machine, 'claw-1');
	patchRecord(r, { runner: 'warm-claw-2-hadoku_site' });
	assert.equal(fold().byMachine[0].machine, 'claw-2');
});

test('a changed node list re-folds: attribution depends on it', () => {
	seed(rec('warm-claw-1-hadoku_site', 30, 60));
	const withClaw = foldSummary(NODES, 'hokon', jobRecords(), NOW, RECENT_WINDOW_MS);
	const without = foldSummary(['claw-2', 'hokon'], 'hokon', jobRecords(), NOW, RECENT_WINDOW_MS);
	assert.equal(withClaw.byMachine[0].machine, 'claw-1');
	assert.notEqual(without.byMachine[0].machine, 'claw-1');
});

test('the UTC day turning re-folds the daily list, with no history change', () => {
	seed(rec('warm-claw-1-hadoku_site', 30, 60));
	const before = fold();
	const after = fold(NOW + 24 * 60 * MIN);
	assert.notEqual(after.daily, before.daily);
	assert.equal(after.daily.at(-1)!.day, '2026-11-07');
	assert.equal(
		after.daily.at(-1)!.jobs,
		0,
		'a day after the first record with nothing in it is a real zero'
	);
});

test('summarise over a caller-owned array is folded fresh, never memoised', () => {
	const mine = [rec('warm-claw-1-hadoku_site', 30, 60)];
	const a = summarise(NODES, 'hokon', mine, NOW);
	mine.push(rec('warm-claw-2-hadoku_site', 20, 60));
	const b = summarise(NODES, 'hokon', mine, NOW);
	assert.equal(a.total, 1);
	assert.equal(b.total, 2, 'nothing bumps a version for an array the store does not own');
});

test('recent is the 40 newest by start, ties in history order, whatever order history holds', () => {
	// The fold picks them in one backward scan instead of sorting every record:
	// pin it to what a stable sort of the whole window gives, ties included.
	const starts = [5, 3, 3, 9, 1, 3, 7, 7, 2, 0, 4, 4, 8, 6, 3, 1, 2, 9, 5, 5];
	const rs: JobRecord[] = [];
	for (let i = 0; i < 60; i++)
		rs.push(rec('warm-claw-1-hadoku_site', starts[(i * 7) % 20] * 10, 30));
	seed(...rs);
	const expected = [...rs]
		.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
		.slice(0, 40)
		.map((r) => r.jobId);
	assert.deepEqual(
		fold().recent.map((r) => r.jobId),
		expected
	);
});

test('a job renamed in place moves to its new kind in slowest', () => {
	const rs = [1, 2, 3].map((m) =>
		rec('warm-claw-1-hadoku_site', m * 10, 100 * m, { name: 'build' })
	);
	seed(...rs);
	assert.deepEqual(
		fold().byRepo[0].slowest.map((s) => s.name),
		['build']
	);
	for (const r of rs) patchRecord(r, { name: 'e2e' });
	assert.deepEqual(
		fold().byRepo[0].slowest.map((s) => s.name),
		['e2e'],
		'the kind is cached per record, and a cached kind must follow the name'
	);
});
