import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

import { __setHostForTesting } from '../host.js';
import { testHost, testStateDir } from './install-test-host.js';
import { __setHistoryPathForTesting } from '../job-history-store.js';
import { __resetJobHistoryForTesting } from '../job-history-store.js';
import { jobRecords } from '../job-history-store.js';
import { FetchBudget, ingestRuns } from '../job-history-ingest.js';
import {
	closeListingGap,
	LISTING_GAP_FILE,
	LISTING_PAGE,
	MAX_GAP_PAGES,
	__resetListingGapForTesting,
	type ListedRun,
} from '../run-listing-gap.js';

/**
 * fleet-manager#9 ask 3: after the 10-25 blackout, the runs that completed
 * while runner-health was suppressed had scrolled past the end of every
 * `per_page=30` listing, and history-coverage reported the hole for a day.
 */
// Relative to the clock: ingestRuns cuts at FRESH_HORIZON_H before the REAL now.
const NOW = Date.now();
const REPO = 'WolffM/hadoku_site';
let warns: string[] = [];
let infos: string[] = [];

beforeEach(() => {
	warns = [];
	infos = [];
	__setHostForTesting({
		...testHost,
		logger: { info: (m: string) => infos.push(m), warn: (m: string) => warns.push(m), error() {} },
	});
	__resetJobHistoryForTesting();
	__setHistoryPathForTesting(join(testStateDir, 'gap-history.jsonl'));
	rmSync(join(testStateDir, 'gap-history.jsonl'), { force: true });
	rmSync(join(testStateDir, LISTING_GAP_FILE), { force: true });
	__resetListingGapForTesting();
});
afterEach(() => {
	__setHistoryPathForTesting(null);
	__setHostForTesting(testHost);
});

/** Runs `from` down to `to` inclusive, newest first, completed a minute apart. */
function runs(from: number, to: number, status = 'completed'): ListedRun[] {
	const out: ListedRun[] = [];
	for (let id = from; id >= to; id--) {
		out.push({ id, status, updated_at: new Date(NOW - (from - id) * 60_000).toISOString() });
	}
	return out;
}

/** A repo whose runs are `from` down to 1: page n of its newest-first listing. */
function pager(from: number, reads: number[] = []) {
	const all = runs(from, 1);
	return async (page: number) => {
		reads.push(page);
		return all.slice((page - 1) * LISTING_PAGE, page * LISTING_PAGE);
	};
}

const neverPaged = async () => {
	throw new Error('a healthy listing must not page back');
};

test('the first listing of a repo is never a gap', async () => {
	assert.deepEqual(await closeListingGap(REPO, runs(130, 101), neverPaged, NOW), []);
});

test('a listing that overlaps the mark, or is short, reads nothing more', async () => {
	await closeListingGap(REPO, runs(130, 101), neverPaged, NOW);
	assert.deepEqual(await closeListingGap(REPO, runs(140, 111), neverPaged, NOW), []);
	await closeListingGap('WolffM/quiet', runs(12, 1), neverPaged, NOW);
	assert.deepEqual(await closeListingGap('WolffM/quiet', runs(20, 1), neverPaged, NOW), []);
});

test('a full listing past the mark pages back to it and queues what was skipped', async () => {
	await closeListingGap(REPO, runs(130, 101), neverPaged, NOW);
	// The blackout: 70 runs completed while nothing read the listing.
	const reads: number[] = [];
	const backlog = await closeListingGap(REPO, runs(200, 171), pager(200, reads), NOW);
	assert.deepEqual(reads, [2, 3], 'page 3 reaches run 130, which closes the gap');
	assert.deepEqual(
		backlog.map((r) => r.id),
		runs(170, 131).map((r) => r.id),
		'exactly the 40 runs no listing ever showed'
	);
	assert.match(infos.join('\n'), /skipped past run 130; read 2 more page\(s\), 40 unrecorded/);
	// The next ordinary tick overlaps the new mark and reads nothing.
	await closeListingGap(REPO, runs(205, 176), neverPaged, NOW);
});

test('a run still in progress on a gap page is not queued', async () => {
	await closeListingGap(REPO, runs(130, 101), neverPaged, NOW);
	const page2 = [...runs(170, 166, 'in_progress'), ...runs(165, 141)];
	const backlog = await closeListingGap(
		REPO,
		runs(200, 171),
		async (n) => (n === 2 ? page2 : runs(140, 111)),
		NOW
	);
	assert.equal(backlog.length, 35);
	assert.ok(backlog.every((r) => r.status === 'completed'));
});

test('a page that cannot be read keeps the gap open for the next tick', async () => {
	await closeListingGap(REPO, runs(130, 101), neverPaged, NOW);
	assert.deepEqual(await closeListingGap(REPO, runs(200, 171), async () => null, NOW), []);
	assert.match(warns.join('\n'), /could not be read, so the gap stays open/);
	const reads: number[] = [];
	const backlog = await closeListingGap(REPO, runs(201, 172), pager(201, reads), NOW);
	assert.deepEqual(reads, [2, 3], 'the mark did not move, so the next tick paged again');
	assert.equal(backlog.length, 41);
});

test('a gap still open after MAX_GAP_PAGES is given up, and says the rest is lost', async () => {
	await closeListingGap(REPO, runs(130, 101), neverPaged, NOW);
	const newest = 130 + LISTING_PAGE * (MAX_GAP_PAGES + 2);
	const reads: number[] = [];
	const backlog = await closeListingGap(
		REPO,
		runs(newest, newest - LISTING_PAGE + 1),
		pager(newest, reads),
		NOW
	);
	assert.equal(reads.length, MAX_GAP_PAGES);
	assert.equal(backlog.length, LISTING_PAGE * MAX_GAP_PAGES);
	assert.match(
		warns.join('\n'),
		/older runs in the gap are lost, and history-coverage will count them/
	);
	await closeListingGap(REPO, runs(newest + 5, newest - 24), neverPaged, NOW);
});

test('nothing older than the horizon is read for, or kept', async () => {
	await closeListingGap(REPO, runs(130, 101), neverPaged, NOW);
	const later = NOW + 49 * 3600_000;
	const reads: number[] = [];
	const backlog = await closeListingGap(REPO, runs(200, 171), pager(200, reads), later);
	assert.deepEqual(reads, [2], 'page 2 is entirely past FRESH_HORIZON_H, which closes the gap');
	assert.deepEqual(backlog, []);
});

test('the mark and the backlog survive a restart', async () => {
	await closeListingGap(REPO, runs(130, 101), neverPaged, NOW);
	await closeListingGap(REPO, runs(200, 171), pager(200), NOW);
	__resetListingGapForTesting();
	const backlog = await closeListingGap(REPO, runs(200, 171), neverPaged, NOW);
	assert.equal(backlog.length, 40, 'the backlog came back, and the restored mark is not a gap');
});

test('the backlog drains through ingestRuns as safe runs, and leaves once recorded', async () => {
	await closeListingGap(REPO, runs(130, 101), neverPaged, NOW);
	const backlog = await closeListingGap(REPO, runs(200, 171), pager(200), NOW);
	const fetched: number[] = [];
	const fetchJobs = async (_repo: string, runId: number) => {
		fetched.push(runId);
		const at = new Date(NOW - 3600_000).toISOString();
		return {
			jobs: [
				{
					id: runId * 10,
					name: 'check',
					runner_name: 'jit-claw-4-x-1',
					started_at: at,
					completed_at: at,
					conclusion: 'success',
				},
			],
		} as never;
	};
	// A shared tick budget of 30 holds 10 back for at-risk listing runs.
	const budget = new FetchBudget(30);
	await ingestRuns(REPO, backlog, fetchJobs, budget, { atRisk: false });
	assert.equal(fetched.length, 20, 'the reserve stays for the listings');
	assert.equal(budget.remaining, budget.reserve);
	assert.deepEqual(
		fetched,
		runs(150, 131)
			.map((r) => r.id)
			.reverse(),
		'oldest first'
	);
	assert.equal(jobRecords().length, 20);
	const left = await closeListingGap(REPO, runs(200, 171), neverPaged, NOW);
	assert.deepEqual(
		left.map((r) => r.id),
		runs(170, 151).map((r) => r.id),
		'recorded runs leave the backlog; the rest wait for the next tick'
	);
});
