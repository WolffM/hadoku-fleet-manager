/**
 * Issue #18 — attributing a recent job to a node, and comparing it to that
 * node's own recent behaviour.
 *
 * `GET /fleet` shipped both halves of "is the fleet slower than usual right
 * now" and no way to join them: a 14-day p50 per node, and ~40 recent job
 * records whose `runner` cannot be folded onto a node by anyone but this
 * package. Two things close it, and both are pinned here:
 *
 *   1. `machine` on every `recent` record — `nodeOf`, the ONE implementation,
 *      applied at serialise time against the same node list the rollup folds
 *      with. A consumer must never re-derive it; `runners/census.ts` records
 *      that this question had five implementations and two of them disagreed.
 *
 *   2. A TRAILING TIME WINDOW per node beside the full-window figures. Three
 *      properties matter, and each has its own test below because each has its
 *      own way of being quietly wrong:
 *
 *        - it is cut on COMPLETION, not on start, so the measure cannot get
 *          quieter the slower a job gets (the `queue-health` trap);
 *        - an empty window is `null`, never `0`, so a node that completed
 *          nothing all hour does not render as the fastest box in the fleet;
 *        - the clock is a parameter, so every assertion here is against a
 *          window pinned to the millisecond rather than one moving under it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RECENT_WINDOW_MS, summarise, type JobRecord, type NodeJobStats } from '../job-history.js';
import { buildFleetReport } from '../routes/fleet.js';

const NODES = ['claw-1', 'claw-2', 'claw-3', 'hokon'];

/**
 * THE CLOCK, FIXED. Every fixture below is expressed as an offset from this and
 * `summarise` is handed it explicitly — a test that lets `Date.now()` run is a
 * test whose window boundary moves between the fixture and the assertion, and
 * it will pass a thousand times and fail on the run that straddles the edge.
 */
const NOW = Date.parse('2026-09-09T15:00:00.000Z');
const MIN = 60_000;

/** A record that STARTED `startMinAgo` minutes ago and ran `durationSec`. */
function rec(
	runner: string,
	startMinAgo: number,
	durationSec: number,
	extra: Partial<JobRecord> = {}
): JobRecord {
	return {
		repo: 'WolffM/hadoku_site',
		runId: 1,
		jobId: Math.round(startMinAgo * 1000 + durationSec),
		name: 'check',
		runner,
		labels: ['hadoku-builder'],
		startedAt: new Date(NOW - startMinAgo * MIN).toISOString(),
		durationSec,
		conclusion: 'success',
		...extra,
	};
}

const statFor = (s: { byMachine: NodeJobStats[] }, node: string): NodeJobStats =>
	s.byMachine.find((m) => m.machine === node)!;

// ── 1. attribution ──────────────────────────────────────────────────────────

test('recent records carry the NODE that served them, folded by nodeOf', () => {
	// Every runner-name shape the fleet actually produces. None of these can be
	// folded downstream, which is the whole reason the answer travels.
	const s = summarise(
		NODES,
		'hokon',
		[
			rec('jit-claw-1-hadoku-conjure-j102671642063-r34413053817-1788993392', 5, 30),
			rec('warm-claw-3-hadoku_site', 6, 40),
			rec('hokon-tenhands', 7, 50),
			rec('claw-2', 8, 60),
			rec('GitHub Actions 1000024103', 9, 70),
		],
		NOW
	);
	assert.deepEqual(
		s.recent.map((r) => [r.runner, r.machine]),
		[
			['jit-claw-1-hadoku-conjure-j102671642063-r34413053817-1788993392', 'claw-1'],
			['warm-claw-3-hadoku_site', 'claw-3'],
			['hokon-tenhands', 'hokon'],
			['claw-2', 'claw-2'],
			['GitHub Actions 1000024103', 'github-hosted'],
		],
		'a JIT mint name, a warm listener, an instance suffix, a bare node and a hosted runner'
	);
});

test('a record`s machine is the SAME key its byMachine row is under', () => {
	// The join is the point. If these two ever came from different calls or
	// different node lists, the panel would look up a p50 for a node that has no
	// row and render a comparison against undefined.
	const s = summarise(NODES, 'hokon', [rec('jit-claw-1-x-r1-2', 5, 30)], NOW);
	assert.equal(s.recent[0].machine, 'claw-1');
	assert.ok(
		s.byMachine.some((m) => m.machine === s.recent[0].machine),
		'every recent record must name a node that has a stats row'
	);
});

test('an UNKNOWN runner keeps its own name rather than being attributed', () => {
	// nodeOf's rule, and it must survive this hop: a runner nobody recognises
	// should look unrecognised, not be silently charged to a node.
	const s = summarise(NODES, 'hokon', [rec('mystery-box', 5, 30)], NOW);
	assert.equal(s.recent[0].machine, 'mystery-box');
});

// ── 2. the trailing window ──────────────────────────────────────────────────

test('each node gets a trailing p50/p95 BESIDE the full-window one, not instead', () => {
	const s = summarise(
		NODES,
		'hokon',
		[
			// claw-1, inside the hour: 60s, 120s, 300s.
			rec('claw-1', 50, 60),
			rec('claw-1', 30, 120),
			rec('claw-1', 20, 300),
			// claw-1, five days ago: 10s each. Baseline only.
			rec('claw-1', 5 * 24 * 60, 10),
			rec('claw-1', 5 * 24 * 60 + 1, 10),
		],
		NOW
	);
	const c1 = statFor(s, 'claw-1');
	// The BASELINE, over all five: [10,10,60,120,300].
	assert.equal(c1.jobs, 5);
	assert.equal(c1.medianSec, 60);
	assert.equal(c1.p95Sec, 300);
	// The TRAILING HOUR, over three: [60,120,300]. Both are on the wire, and
	// they disagree — which is exactly the comparison issue #18 asked for.
	assert.equal(c1.recentJobs, 3);
	assert.equal(c1.recentMedianSec, 120);
	assert.equal(c1.recentP95Sec, 300);
	assert.notEqual(c1.recentMedianSec, c1.medianSec, 'the trailing figure is its own number');
});

test('a node with NO jobs in the hour reports null, never 0', () => {
	// The rule this repo applies to an unprobed machine, one level down. A
	// percentile over zero samples is no data; rendering it as 0 draws the node
	// that completed nothing all hour as the fastest box in the fleet.
	const s = summarise(
		NODES,
		'hokon',
		[rec('claw-2', 5 * 24 * 60, 1000), rec('claw-1', 10, 30)],
		NOW
	);
	const c2 = statFor(s, 'claw-2');
	assert.equal(c2.jobs, 1, 'it still has a baseline row');
	assert.equal(c2.medianSec, 1000);
	assert.equal(c2.recentJobs, 0, 'a COUNT — we looked at the hour and it was empty');
	assert.equal(c2.recentMedianSec, null, '0 here would be a lie about a fast node');
	assert.equal(c2.recentP95Sec, null);
	assert.notEqual(c2.recentMedianSec, 0);
	// And the node that DID work in the hour is unaffected by its neighbour's
	// silence — an empty window is per-node, not a fleet-wide blank.
	assert.equal(statFor(s, 'claw-1').recentMedianSec, 30);
});

test('a fleet that completed NOTHING in the hour empties the window, it does not zero it', () => {
	// The whole-fleet version of the case above. This is the state a reader must
	// not see as healthy: `queuedNow` / `oldestQueuedMin` are what catch a stall,
	// because history holds completed jobs only. What must NOT happen is a wall
	// of confident zeroes suggesting every node just ran instantly.
	const s = summarise(
		NODES,
		'hokon',
		[rec('claw-1', 5 * 24 * 60, 100), rec('claw-2', 5 * 24 * 60, 200)],
		NOW
	);
	assert.deepEqual(
		s.byMachine.map((m) => [m.machine, m.recentJobs, m.recentMedianSec, m.recentP95Sec]),
		[
			['claw-1', 0, null, null],
			['claw-2', 0, null, null],
		]
	);
	// The window was still LOOKED AT, and says which hour it looked at.
	assert.equal(s.recentSince, new Date(NOW - RECENT_WINDOW_MS).toISOString());
});

/**
 * THE TRAP THIS REPO ALREADY PAID FOR ONCE.
 *
 * `queue-health` excluded runs past a one-hour ceiling from its p95, and a real
 * failure MANUFACTURED that category: every casualty eventually crossed the line
 * and left the percentile, so a 20-minute stall reddened while a two-hour one
 * went green.
 *
 * A trailing window cut on `startedAt` is the same shape. A job that ran three
 * hours and finished a minute ago STARTED three hours ago, so it would be
 * outside a one-hour start-window — and the slower the job, the more certainly
 * it falls out. Cutting on COMPLETION means every job enters the window exactly
 * once, at the moment it lands, whatever it cost.
 */
test('a long job is in the window because it FINISHED there, not where it started', () => {
	const s = summarise(
		NODES,
		'hokon',
		[
			// Started 100 minutes ago, ran 90 minutes: finished 10 minutes ago.
			// Outside the hour by start; inside it by completion.
			rec('claw-3', 100, 90 * 60),
		],
		NOW
	);
	const c3 = statFor(s, 'claw-3');
	assert.equal(c3.recentJobs, 1, 'cutting on startedAt would drop the slowest job in the fleet');
	assert.equal(c3.recentMedianSec, 5400);
});

test('a job that finished BEFORE the window is out of it — the cut is real', () => {
	// The other half: "cut on completion" must not degrade into "count
	// everything". A job that started 100 minutes ago and ran 20 finished 80
	// minutes ago and is outside the hour.
	const s = summarise(NODES, 'hokon', [rec('claw-3', 100, 20 * 60)], NOW);
	assert.equal(statFor(s, 'claw-3').recentJobs, 0);
	assert.equal(statFor(s, 'claw-3').recentMedianSec, null);
});

test('the window is a TIME window, so a burst of records cannot shrink it', () => {
	// `recent` is the last 40 RECORDS and means minutes on a busy fleet and days
	// on a quiet one. The aggregate must not inherit that: 50 jobs in the hour
	// and 1 job in the hour are both "the hour", and the boundary does not move.
	const many = Array.from({ length: 50 }, (_, i) => rec('claw-1', 5, 30, { jobId: i }));
	const s = summarise(NODES, 'hokon', [...many, rec('claw-1', 90, 30)], NOW);
	assert.equal(s.recent.length, 40, 'the record list is still capped at 40');
	assert.equal(statFor(s, 'claw-1').recentJobs, 50, 'the aggregate counts the whole hour');
	assert.equal(s.recentWindowSec, 3600);
});

test('the window moves with the clock it is handed', () => {
	// The clock is the contract. Same records, a `now` an hour later, and the
	// same job is out of the window — which is what makes every assertion above
	// a statement about the cut rather than about when the suite happened to run.
	const records = [rec('claw-1', 10, 30)];
	assert.equal(statFor(summarise(NODES, 'hokon', records, NOW), 'claw-1').recentJobs, 1);
	const later = summarise(NODES, 'hokon', records, NOW + 2 * RECENT_WINDOW_MS);
	assert.equal(statFor(later, 'claw-1').recentJobs, 0);
	assert.equal(statFor(later, 'claw-1').recentMedianSec, null);
	assert.equal(statFor(later, 'claw-1').jobs, 1, 'the baseline has no clock and does not move');
});

// ── 3. it reaches the wire ──────────────────────────────────────────────────

test('GET /fleet renders machine and both windows, including a node with no data', () => {
	// The route-level render, which is what the consumer actually reads. Built
	// through `buildFleetReport` with an injected summary so the shape is pinned
	// without a live history file.
	const jobs = summarise(
		['claw-1', 'claw-2', 'hokon'],
		'hokon',
		[
			rec('jit-claw-1-hadoku_site-r1-2', 50, 60),
			rec('jit-claw-1-hadoku_site-r1-3', 30, 120),
			rec('claw-2', 5 * 24 * 60, 1000),
		],
		NOW
	);
	const r = buildFleetReport(
		null,
		null,
		{ 'claw-1': { maxConcurrent: 2, ephemeral: true }, 'claw-2': { maxConcurrent: 2 } },
		jobs
	);
	const row = r.jobs.recent[0];
	assert.equal(row.machine, 'claw-1', 'a recent record names its node on the wire');
	const c1 = r.jobs.byMachine.find((m) => m.machine === row.machine)!;
	assert.equal(c1.recentMedianSec, 90, 'and that node has a trailing figure to compare against');
	assert.equal(c1.medianSec, 90);
	const c2 = r.jobs.byMachine.find((m) => m.machine === 'claw-2')!;
	assert.equal(c2.recentJobs, 0);
	assert.equal(c2.recentMedianSec, null, 'no data, rendered as no data');
	assert.equal(c2.medianSec, 1000, 'while its baseline is intact');
	assert.equal(r.jobs.recentWindowSec, 3600);
	assert.equal(r.jobs.recentSince, '2026-09-09T14:00:00.000Z');
});

test('GET /fleet carries failuresByZone per node — the split, not just the count', () => {
	// Issue #3 asked whether one claw fails differently from the others, and
	// `GET /fleet` could answer "claw-2: 11 failures" and nothing more. Folding a
	// failure into a zone needs `failedStep`, `failedPhase` AND §5.5's pattern
	// table, none of which this package publishes to a browser bundle — so the
	// answer travels rather than being re-derived, exactly like `machine` above.
	const jobs = summarise(
		['claw-1', 'claw-2', 'hokon'],
		'hokon',
		[
			rec('claw-2', 50, 60),
			rec('claw-2', 51, 60, { conclusion: 'failure', failedStep: 'Set up runner' }),
			rec('claw-2', 52, 60, {
				conclusion: 'failure',
				failedStep: 'Set up Python',
				failedPhase: 'run',
			}),
			rec('claw-2', 53, 60, { conclusion: 'failure', failedStep: 'Tests', failedPhase: 'run' }),
			rec('claw-2', 54, 3601, {
				conclusion: 'failure',
				failedStep: 'Post Run actions/checkout@v4',
			}),
			rec('claw-2', 55, 60, { conclusion: 'cancelled' }),
			rec('claw-1', 50, 60),
		],
		NOW
	);
	const r = buildFleetReport(
		null,
		null,
		{ 'claw-1': { maxConcurrent: 2, ephemeral: true }, 'claw-2': { maxConcurrent: 2 } },
		jobs
	);
	const c2 = r.jobs.byMachine.find((m) => m.machine === 'claw-2')!;
	assert.deepEqual(
		c2.failuresByZone,
		{ runner: 1, seam: 1, content: 1, fleet: 1, cancelled: 1 },
		'one of each, so a reverted fold cannot pass by accident'
	);
	assert.equal(
		c2.failuresByZone.runner +
			c2.failuresByZone.seam +
			c2.failuresByZone.content +
			c2.failuresByZone.fleet +
			c2.failuresByZone.cancelled,
		c2.failures,
		'the buckets account for every non-success record the count above sees'
	);
	const c1 = r.jobs.byMachine.find((m) => m.machine === 'claw-1')!;
	assert.deepEqual(
		c1.failuresByZone,
		{ runner: 0, seam: 0, content: 0, fleet: 0, cancelled: 0 },
		'a clean node renders five explicit zeros, never an absent object'
	);
});
