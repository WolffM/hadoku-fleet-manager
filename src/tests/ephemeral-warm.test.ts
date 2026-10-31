import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	WARM_ASSIGN_WINDOW_MS,
	WARM_HALF_LIFE_MS,
	WARM_HISTORY_WINDOW_MS,
	type WarmServedJob,
	planWarmCache,
	warmRepoScores,
	warmTargetRepo,
} from '../runners/ephemeral-warm.js';
import { __resetJobHistoryForTesting } from '../job-history-store.js';
import { __setHistoryPathForTesting } from '../job-history-store.js';
import { jobRecords } from '../job-history-store.js';
import { ingestRuns } from '../job-history-ingest.js';

// --- warm-cache selection (issue #16) ----------------------------------------
//
// `planWarmCache` used to fill by last-served MRU, and MRU chases the repo that
// just went quiet: on 2026-09-08 claw-1 rotated seven times in fifty minutes
// through repos that then produced nothing, and 8 of 15 settled fills served
// zero jobs. The signal is now decayed recent frequency over the node's own
// history. The locks did not change and the tests below check that they did
// not: neither a busy listener nor one inside the assign window may be rotated,
// whatever the score says.

/** `n` jobs of `repo`, all at `atMs`. */
const served = (repo: string, atMs: number, n = 1): WarmServedJob[] =>
	Array.from({ length: n }, () => ({ repo, startedAtMs: atMs }));

const NOW = 1_800_000_000_000;
const SITE = 'WolffM/hadoku_site';
const MEET = 'WolffM/hadoku-rally';

test('the window/half-life ratio is what makes "one never outvotes fifty" true', () => {
	// Issue #16's requirement is absolute ("never"), so it has to hold for the
	// worst placement, not the average one: the single job as recent as possible
	// and the fifty as old as the window allows. A job at the far edge weighs
	// 2^-(window/halfLife) of a fresh one, so one fresh job can outrank at most
	// 2^(window/halfLife) old ones. Anything below 50 satisfies the issue; the
	// shipped constants give 16.
	const ratio = 2 ** (WARM_HISTORY_WINDOW_MS / WARM_HALF_LIFE_MS);
	assert.ok(ratio < 50, `one fresh job may outrank at most ${ratio} old ones; issue #16 needs <50`);
	assert.equal(ratio, 16, 'the shipped 6h/90min pair — change both together or this bound moves');
});

test('warmTargetRepo: fifty jobs at the edge of the window outvote one at its start', () => {
	const jobs = [
		...served(SITE, NOW - WARM_HISTORY_WINDOW_MS, 50),
		...served(MEET, NOW, 1), // the freshest job in the window, and still loses
	];
	assert.equal(warmTargetRepo(jobs, NOW), SITE);
});

test('warmRepoScores: a job older than the window carries no weight at all', () => {
	const jobs = [
		...served(SITE, NOW - WARM_HISTORY_WINDOW_MS - 1000, 40),
		...served(MEET, NOW - 60_000, 1),
	];
	const scores = warmRepoScores(jobs, NOW);
	assert.equal(scores.has(SITE), false, 'out of the window is out of the vote, not down-weighted');
	assert.equal(warmTargetRepo(jobs, NOW), MEET);
});

test('warmTargetRepo: nothing in the window is null, never a guess', () => {
	assert.equal(warmTargetRepo([], NOW), null);
	assert.equal(warmTargetRepo(served(SITE, NOW - 48 * 3600_000, 500), NOW), null);
});

test('warmTargetRepo: a tie goes to the repo already in the slot', () => {
	// A tie is not a reason to pay a DELETE, a registration-token POST and a
	// provisioning ssh.
	const jobs = [...served(SITE, NOW - 1000), ...served(MEET, NOW - 1000)];
	assert.equal(warmTargetRepo(jobs, NOW, { preferRepo: MEET }), MEET);
	assert.equal(warmTargetRepo(jobs, NOW, { preferRepo: SITE }), SITE);
});

test('planWarmCache: one job from a quiet repo does not evict the busy one (issue #16)', () => {
	// The exact shape of claw-1's 2026-09-08 rotation storm: hadoku_site had been
	// firing all hour, one hadoku-rally job landed, and MRU rotated the slot onto
	// a repo that then served nothing for the next fifty minutes.
	const jobs = [
		...Array.from({ length: 40 }, (_, k) => ({
			repo: SITE,
			startedAtMs: NOW - (k + 1) * 90_000, // one a minute and a half, for an hour
		})),
		{ repo: MEET, startedAtMs: NOW - 5_000 }, // the most recent job, by a mile
	];
	const d = planWarmCache({
		current: { repo: SITE, busy: false, mintedOrRefreshedAtMs: NOW - 3600_000 },
		served: jobs,
		nowMs: NOW,
	});
	assert.deepEqual(d, { action: 'keep' }, 'frequency wins; the slot stays where the work is');
});

test('SAFETY: mutating the half-life to zero brings MRU — and the bug — straight back', () => {
	// This test is the guard on the decay itself. `halfLifeMs: 0` is the limit of
	// the formula, not a special case: with no decay time only the single most
	// recent job carries weight, so the argmax is the last-served repo, which is
	// exactly what `planWarmCache` did before issue #16. If a future change makes
	// zero mean something else — "no decay", say, so every job weighs 1 and the
	// rule silently becomes unweighted counting over the window — this test is
	// what notices.
	const jobs = [...served(SITE, NOW - 600_000, 40), { repo: MEET, startedAtMs: NOW - 5_000 }];
	const current = { repo: SITE, busy: false, mintedOrRefreshedAtMs: NOW - 3600_000 };

	// Shipped half-life: frequency wins.
	assert.deepEqual(planWarmCache({ current, served: jobs, nowMs: NOW }), { action: 'keep' });

	// Half-life zero: MRU returns, and with it the rotation onto a repo with one
	// job to its name.
	assert.deepEqual(planWarmCache({ current, served: jobs, nowMs: NOW, halfLifeMs: 0 }), {
		action: 'rotate',
		from: SITE,
		to: MEET,
	});

	// And it is genuinely MRU, not just "the newest repo sometimes wins": swap
	// which repo is most recent and the answer follows it, 40 jobs or not.
	assert.equal(
		warmTargetRepo([...served(MEET, NOW - 600_000, 40), { repo: SITE, startedAtMs: NOW }], NOW, {
			halfLifeMs: 0,
		}),
		SITE
	);
});

test('planWarmCache: the busy lock still beats the score', () => {
	const jobs = [...served(MEET, NOW - 1000, 50), ...served(SITE, NOW - 2000, 1)];
	const d = planWarmCache({
		current: { repo: SITE, busy: true, mintedOrRefreshedAtMs: NOW - 3600_000 },
		served: jobs,
		nowMs: NOW,
	});
	assert.deepEqual(d, { action: 'locked' }, 'a listener holding a job is never evicted');
});

test('planWarmCache: the assign window still beats the score', () => {
	const jobs = [...served(MEET, NOW - 1000, 50), ...served(SITE, NOW - 2000, 1)];
	const d = planWarmCache({
		current: {
			repo: SITE,
			busy: false,
			mintedOrRefreshedAtMs: NOW - (WARM_ASSIGN_WINDOW_MS - 1000),
		},
		served: jobs,
		nowMs: NOW,
	});
	assert.deepEqual(
		d,
		{ action: 'locked' },
		'idle-but-assigned is the gap the second clause covers'
	);
});

test('planWarmCache: an empty window keeps the slot rather than evicting it', () => {
	const d = planWarmCache({
		current: { repo: SITE, busy: false, mintedOrRefreshedAtMs: NOW - 3600_000 },
		served: served(MEET, NOW - 48 * 3600_000, 10),
		nowMs: NOW,
	});
	assert.deepEqual(d, { action: 'idle' }, 'no signal is not a reason to throw away a warm slot');
});

test('planWarmCache: no slot yet fills with the scored target, not the last-served one', () => {
	const jobs = [...served(SITE, NOW - 3600_000, 30), { repo: MEET, startedAtMs: NOW - 1_000 }];
	assert.deepEqual(planWarmCache({ current: null, served: jobs, nowMs: NOW }), {
		action: 'fill',
		repo: SITE,
	});
});

// --- warm-served jobs carry assignSec (issue #15) ----------------------------

test('ingestRuns: a warm-served job carries assignSec, and the halves sum', async () => {
	// P4's number — how long GitHub takes to hand a job to a listener that is
	// ALREADY long-polling — was unmeasurable because the dispatch/assign split
	// was gated on a `jit-` name's mint epoch, and a warm name carries none.
	// 298 warm records existed on 2026-09-09 and not one had an assignSec.
	const tmp = mkdtempSync(join(tmpdir(), 'warm-assign-'));
	try {
		__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
		__resetJobHistoryForTesting();
		__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
		const t = Date.now() - 2 * 3600_000;
		const iso = (sec: number) => new Date(t + sec * 1000).toISOString();
		await ingestRuns('WolffM/hadoku_site', [{ id: 91, status: 'completed' }], () =>
			Promise.resolve({
				jobs: [
					{
						id: 9101,
						name: 'check',
						runner_name: 'warm-claw-3-hadoku_site',
						labels: ['self-hosted', 'hadoku-builder'],
						created_at: iso(0),
						started_at: iso(4),
						completed_at: iso(40),
						conclusion: 'success',
					},
				],
			})
		);
		const r = jobRecords().find((x) => x.jobId === 9101);
		assert.equal(r?.queueSec, 4);
		assert.equal(r?.dispatchSec, 0, 'a standing listener predates the job — nothing was minted');
		assert.equal(r?.assignSec, 4, 'so the whole wait is GitHub assigning');
		assert.equal((r?.dispatchSec ?? -1) + (r?.assignSec ?? -1), r?.queueSec, 'the halves sum');
	} finally {
		__setHistoryPathForTesting(null);
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('ingestRuns: a plain standing runner still gets NEITHER half', async () => {
	// The warm branch keys on the `warm-` prefix, not on "has no mint epoch". A
	// resident runner has no mint either, and reporting 0 for it would claim the
	// dispatcher acted instantly on a job it never touched.
	const tmp = mkdtempSync(join(tmpdir(), 'warm-assign-'));
	try {
		__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
		__resetJobHistoryForTesting();
		__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
		const t = Date.now() - 2 * 3600_000;
		const iso = (sec: number) => new Date(t + sec * 1000).toISOString();
		await ingestRuns('WolffM/hadoku_site', [{ id: 92, status: 'completed' }], () =>
			Promise.resolve({
				jobs: [
					{
						id: 9201,
						name: 'check',
						runner_name: 'claw-3',
						labels: ['self-hosted', 'hadoku-builder'],
						created_at: iso(0),
						started_at: iso(4),
						completed_at: iso(40),
						conclusion: 'success',
					},
				],
			})
		);
		const r = jobRecords().find((x) => x.jobId === 9201);
		assert.equal(r?.dispatchSec, undefined);
		assert.equal(r?.assignSec, undefined);
	} finally {
		__setHistoryPathForTesting(null);
		rmSync(tmp, { recursive: true, force: true });
	}
});
