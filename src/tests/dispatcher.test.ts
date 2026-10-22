import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	firstSentence,
	planTick,
	singleNodeFirst,
	type PendingRun,
} from '../runners/dispatcher.js';
import { HEAVY_HOLD_SEC, type NodeState } from '../runners/placement.js';
import type { HeavyModel } from '../runners/traffic.js';
import type { SpeedModel } from '../runners/speed-tier.js';

const ORDER = ['claw-2', 'claw-1'];
const NOW = 1_787_797_008_000;
const node = (name: string, over: Partial<NodeState> = {}): NodeState => ({
	name,
	healthy: true,
	eligible: true,
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 2,
	freeMb: 8000,
	requiredMb: 900,
	minFreeMb: 1536,
	...over,
});
/** No job and no run is being served. */
const NONE = { jobIds: new Set<number>(), runIds: new Set<number>() };
/** jobId defaults to `id * 100` so the two identities stay visibly distinct in
 *  assertions — a helper that made them equal would hide the bug this file now
 *  guards against. */
const run = (id: number, over: Partial<PendingRun> = {}): PendingRun => ({
	id,
	jobId: id * 100,
	repo: 'WolffM/hadoku_site',
	repository: { full_name: 'WolffM/hadoku_site' },
	head_repository: { full_name: 'WolffM/hadoku_site', fork: false },
	event: 'push',
	...over,
});

test('a quiet fleet mints for each queued run', () => {
	const p = planTick([run(1), run(2)], [node('claw-2'), node('claw-1')], ORDER, NONE, NOW);
	assert.equal(p.mint.length, 2);
	assert.equal(p.skipped.length, 0);
	assert.match(p.mint[0].runnerName, /^jit-claw-2-hadoku_site-j100-r1-\d{10}$/);
});

test('CAPACITY BINDS WITHIN THE TICK, not just between ticks', () => {
	// The B2 bug at tick scope. Four runs against a fleet with four slots total
	// (2 nodes x maxConcurrent 2) fills it exactly; a fifth must queue. If
	// capacity were only re-read next tick, all five would be placed against the
	// same snapshot — which is how eleven builds landed on a 7.7 GB box.
	const p = planTick(
		[run(1), run(2), run(3), run(4), run(5)],
		[node('claw-2'), node('claw-1')],
		ORDER,
		NONE,
		NOW
	);
	assert.equal(p.mint.length, 4);
	assert.equal(p.skipped.length, 1);
	assert.match(p.skipped[0].reason, /no node/);
});

test('memory is consumed as it is planned, not just counted', () => {
	// One node, capacity 4 by count, but only room for two 3 GB jobs.
	const p = planTick(
		[run(1), run(2), run(3)],
		[node('claw-2', { maxConcurrent: 4, freeMb: 9000, requiredMb: 2900, minFreeMb: 1536 })],
		['claw-2'],
		NONE,
		NOW
	);
	assert.equal(p.mint.length, 2, '9000 - 2900 - 2900 = 3200, a third would breach the floor');
	assert.match(p.skipped[0].reason, /memory|no node/);
});

test('a fork PR is refused and SAID to be refused', () => {
	const p = planTick(
		[run(1, { head_repository: { full_name: 'stranger/hadoku_site' }, event: 'pull_request' })],
		[node('claw-2')],
		ORDER,
		NONE,
		NOW
	);
	assert.equal(p.mint.length, 0);
	assert.match(p.skipped[0].reason, /fork safety/);
});

test('a job already in flight is not minted for twice', () => {
	// The window between minting and the runner appearing in the API spans an
	// mgmt-api restart, so the caller rebuilds this set from live units.
	const p = planTick(
		[run(7)],
		[node('claw-2')],
		ORDER,
		{ jobIds: new Set([700]), runIds: new Set() },
		NOW
	);
	assert.equal(p.mint.length, 0);
	assert.match(p.skipped[0].reason, /already has a runner/);
});

test('a legacy unit name, which carries no job id, blocks its whole run', () => {
	// Names minted before the job-scoped format parse to `jobId: null`, so the
	// caller can only block at run level. Conservative on purpose: it drains as
	// those units exit, and over-blocking costs a tick where under-blocking
	// costs a duplicate registration.
	const p = planTick(
		[run(7)],
		[node('claw-2')],
		ORDER,
		{ jobIds: new Set(), runIds: new Set([7]) },
		NOW
	);
	assert.equal(p.mint.length, 0);
});

test('TWO WAITING JOBS OF ONE RUN GET TWO DISTINCT RUNNERS — the 409', () => {
	// The bug, as a test. A run contributes one pending entry per waiting job;
	// all of them carry the same run id and the same tick clock. Keying the name
	// on those made all three names identical, so GitHub answered the second and
	// third with `409 Already exists` (~4/day into a logger.warn nothing read)
	// and those jobs fell back onto the standing claws.
	const a = run(42, { jobId: 900_001 });
	const b = run(42, { jobId: 900_002 });
	const p = planTick([a, b], [node('claw-2', { maxConcurrent: 4 })], ORDER, NONE, NOW);
	assert.equal(p.mint.length, 2, 'both jobs must be served');
	assert.notEqual(p.mint[0].runnerName, p.mint[1].runnerName, 'names must differ');
	assert.equal(new Set(p.mint.map((m) => m.runnerName)).size, 2);
});

test('an unhealthy first tier falls through without consuming its capacity', () => {
	const p = planTick(
		[run(1)],
		[node('claw-2', { healthy: false }), node('claw-1')],
		ORDER,
		NONE,
		NOW
	);
	assert.equal(p.mint[0].node, 'claw-1');
});

test('nothing queued means nothing planned', () => {
	const p = planTick([], [node('claw-2')], ORDER, NONE, NOW);
	assert.deepEqual(p, { mint: [], skipped: [] });
});

// --- viaAffinity reaches the mint action (W §5e) --------------------------
//
// `choosePlacement` has returned `viaAffinity` since P5.1 and `planTick` dropped
// it building `MintAction`, so nothing downstream could count it. These pin the
// field AND the causal split beside it, which placement alone does not make.

test('a mint the affinity term MOVED onto a warm node says so, both ways', () => {
	// claw-1 is second in the order; plain ordering would pick claw-2.
	const p = planTick(
		[run(1)],
		[node('claw-2'), node('claw-1', { warmRepo: 'WolffM/hadoku_site' })],
		ORDER,
		NONE,
		NOW
	);
	assert.equal(p.mint[0].node, 'claw-1');
	assert.equal(p.mint[0].viaAffinity, true);
	assert.equal(p.mint[0].affinityMoved, true);
});

test('a warm node plain ordering would have picked anyway is warm, NOT moved', () => {
	// The 74 % base rate from W §3d in one mint: the warm node was already first,
	// so the term changed nothing and must not be credited with this job.
	const p = planTick(
		[run(1)],
		[node('claw-2', { warmRepo: 'WolffM/hadoku_site' }), node('claw-1')],
		ORDER,
		NONE,
		NOW
	);
	assert.equal(p.mint[0].node, 'claw-2');
	assert.equal(p.mint[0].viaAffinity, true);
	assert.equal(p.mint[0].affinityMoved, false);
});

test('a mint with no warm node for its repo carries neither', () => {
	const p = planTick(
		[run(1)],
		[node('claw-2'), node('claw-1', { warmRepo: 'WolffM/some-other-repo' })],
		ORDER,
		NONE,
		NOW
	);
	assert.equal(p.mint[0].node, 'claw-2');
	assert.equal(p.mint[0].viaAffinity, false);
	assert.equal(p.mint[0].affinityMoved, false);
});

// --- #77: planTick must decrement by the RESERVE ADMISSION USED, not the ----
// --- node's flat requiredMb, or a lower-bound job double-books its node. ----

test('#77: a lower-bound job plus an ordinary job in ONE tick — only the first may mint', () => {
	// The real wave 3t lane C shape: brave-quartet (a proven 6,313 MB floor) and
	// an ordinary 3,400 MB job both queued for the same node in one tick.
	// claw-1's slice is 9,800 MB total, nothing else running.
	//
	// FIXED arithmetic: brave-quartet mints and the tick decrements claw-1's
	// freeMb by its reserve ADMISSION (6,313), leaving 3,487 free. The ordinary
	// job then needs 3,400, which would leave only 87 against a 1,536 floor —
	// refused, correctly queued rather than overfilling the slice.
	const claw1 = node('claw-1', {
		maxConcurrent: 4,
		freeMb: 9800,
		requiredMb: 3400, // the flat/ordinary per-job figure on this node
		sliceCeilingMb: 9800,
		minFreeMb: 1536,
		requiredMbByRepo: new Map([['WolffM/brave-quartet', { mb: 6313, lowerBound: true }]]),
	});
	const p = planTick(
		[run(1, { repo: 'WolffM/brave-quartet' }), run(2, { repo: 'WolffM/ordinary-repo' })],
		[claw1],
		['claw-1'],
		NONE,
		NOW
	);
	assert.equal(p.mint.length, 1, 'only brave-quartet may mint this tick');
	assert.equal(p.mint[0].repo, 'WolffM/brave-quartet');
	assert.equal(p.skipped.length, 1, 'the ordinary job queues rather than overfilling the slice');
	assert.equal(p.skipped[0].repo, 'WolffM/ordinary-repo');
	// `choosePlacement`'s per-node memory reason lives in `passed`, not the
	// top-level summary `planTick` reports here — same shape as the existing
	// "CAPACITY BINDS WITHIN THE TICK" test above.
	assert.match(p.skipped[0].reason, /no node/);
});

test('#77: every ORDINARY repo plans EXACTLY as it does on main — no lower-bound entry anywhere', () => {
	// Same shape as the capacity test above (two jobs, one node, memory-bound),
	// but with NO requiredMbByRepo at all, proving the new decrement line
	// (`placed.requiredMb ?? chosen.requiredMb`) falls back to today's
	// arithmetic bit for bit when no lower-bound reserve is in play.
	const p = planTick(
		[run(1), run(2), run(3)],
		[node('claw-2', { maxConcurrent: 4, freeMb: 9000, requiredMb: 2900, minFreeMb: 1536 })],
		['claw-2'],
		NONE,
		NOW
	);
	assert.equal(p.mint.length, 2, '9000 - 2900 - 2900 = 3200, a third would breach the floor');
	assert.equal(p.skipped.length, 1);
	assert.match(p.skipped[0].reason, /memory|no node/);
});

test('#77: an ordinary repo with a requiredMbByRepo entry that is NOT a lower bound still plans unchanged', () => {
	// A repo measured (not capped) above or below the node figure must not move
	// the tick's arithmetic either — only `lowerBound: true` may.
	const claw2 = node('claw-2', {
		maxConcurrent: 4,
		freeMb: 9000,
		requiredMb: 2900,
		minFreeMb: 1536,
		requiredMbByRepo: new Map([['WolffM/hadoku_site', { mb: 5000, lowerBound: false }]]),
	});
	const p = planTick([run(1), run(2), run(3)], [claw2], ['claw-2'], NONE, NOW);
	assert.equal(p.mint.length, 2, 'the unconsulted 5,000 figure must not change how many fit');
	assert.equal(p.skipped.length, 1);
});

test('the counterfactual walk consumes nothing — a burst still fills the warm node first', () => {
	// Two jobs, warm claw-1 has room for exactly one. The second overflows to
	// claw-2, which plain ordering would ALSO have picked, so it is neither.
	const p = planTick(
		[run(1), run(2)],
		[node('claw-2'), node('claw-1', { warmRepo: 'WolffM/hadoku_site', maxConcurrent: 1 })],
		ORDER,
		NONE,
		NOW
	);
	assert.deepEqual(
		p.mint.map((a) => [a.node, a.viaAffinity, a.affinityMoved]),
		[
			['claw-1', true, true],
			['claw-2', false, false],
		]
	);
});

// --- #83: the slow-tier spill gate reaches `choosePlacement` through `planTick`

/** A fake satisfying the fixed B->A `SpeedModel` interface, not lane B's real
 *  thresholds — this file tests planTick's OWN wiring of queue age and job
 *  name through to it. */
function slowSpeedModel(
	opts: {
		extraSec?: number | null;
		onExtra?: (node: string, repo: string, jobName: string | undefined) => void;
	} = {}
): SpeedModel {
	return {
		tierOf: () => 'slow',
		expectedExtraSec: (node, repo, jobName) => {
			opts.onExtra?.(node, repo, jobName);
			return opts.extraSec ?? 170;
		},
		describe: () => ({ tier: 'slow', p25: 2.07, p50: null, kinds: 5 }),
	};
}

test('#83: planTick derives the spill gate’s queue age from created_at when queuedSinceMs is absent', () => {
	const slow = node('claw-5', { speedModel: slowSpeedModel() });
	const r = run(1, {
		repo: 'WolffM/hadoku-cardtable',
		created_at: new Date(NOW - 41_000).toISOString(),
	});
	const p = planTick([r], [slow], ['claw-5'], NONE, NOW);
	assert.equal(p.mint.length, 0, '41s queued is below the 170s threshold the fake reports');
});

test('#83: ...and once that derived age clears the threshold, the job mints', () => {
	const slow = node('claw-5', { speedModel: slowSpeedModel() });
	const r = run(1, {
		repo: 'WolffM/hadoku-cardtable',
		created_at: new Date(NOW - 171_000).toISOString(),
	});
	const p = planTick([r], [slow], ['claw-5'], NONE, NOW);
	assert.equal(p.mint.length, 1);
	assert.equal(p.mint[0].node, 'claw-5');
});

test('#83: run_started_at wins over created_at — a re-run is aged from the CURRENT attempt', () => {
	const slow = node('claw-5', { speedModel: slowSpeedModel() });
	// The original attempt queued ages ago (well past the threshold); the
	// current attempt only just started. If `created_at` won, this would mint.
	const r = run(1, {
		repo: 'WolffM/hadoku-cardtable',
		created_at: new Date(NOW - 10_000_000).toISOString(),
		run_started_at: new Date(NOW - 41_000).toISOString(),
	});
	const p = planTick([r], [slow], ['claw-5'], NONE, NOW);
	assert.equal(
		p.mint.length,
		0,
		'aged from the re-run’s own start (41s), not the original queueing'
	);
});

test('#83: a run with NO timestamps and no explicit queuedSinceMs is never spilled', () => {
	const slow = node('claw-5', { speedModel: slowSpeedModel() });
	const r = run(1, { repo: 'WolffM/hadoku-cardtable' });
	const p = planTick([r], [slow], ['claw-5'], NONE, NOW);
	assert.equal(p.mint.length, 0, 'an unknown queue age must never read as "waited long enough"');
});

test('#83: an explicit PendingRun.queuedSinceMs is honoured directly', () => {
	const slow = node('claw-5', { speedModel: slowSpeedModel() });
	const r = run(1, { repo: 'WolffM/hadoku-cardtable', queuedSinceMs: NOW - 171_000 });
	const p = planTick([r], [slow], ['claw-5'], NONE, NOW);
	assert.equal(p.mint.length, 1);
	assert.equal(p.mint[0].node, 'claw-5');
});

test('#83: the queued job’s own name reaches SpeedModel.expectedExtraSec', () => {
	let seenJobName: string | undefined;
	const slow = node('claw-5', {
		speedModel: slowSpeedModel({ onExtra: (_n, _r, jobName) => (seenJobName = jobName) }),
	});
	const r = run(1, {
		repo: 'WolffM/hadoku-cardtable',
		jobName: 'check',
		queuedSinceMs: NOW - 171_000,
	});
	planTick([r], [slow], ['claw-5'], NONE, NOW);
	assert.equal(seenJobName, 'check');
});

test('#83: a MISSING job name still reaches the model as undefined — expectedExtraSec’s own fallback decides, not a crash', () => {
	let seenJobName: string | undefined = 'untouched';
	const slow = node('claw-5', {
		speedModel: slowSpeedModel({ onExtra: (_n, _r, jobName) => (seenJobName = jobName) }),
	});
	const r = run(1, { repo: 'WolffM/hadoku-cardtable', queuedSinceMs: NOW - 171_000 });
	planTick([r], [slow], ['claw-5'], NONE, NOW);
	assert.equal(seenJobName, undefined);
});

// --- #102: placement spreads heavy work -------------------------------------

test('#102: three queued cardtable jobs spread across the idle claws instead of stacking on the warm one', () => {
	// claw-9 holds cardtable's warm listener; claw-3/claw-4/claw-8 are idle.
	// Before this fix, `choosePlacement` stable-sorted EVERY warm-matching job
	// to claw-9 regardless of how busy it already was — this is the exact
	// incident (#102): three Forge jobs stacked on claw-9, and `forge-e2e` took
	// 35 minutes instead of 16 alone.
	const REPO = 'WolffM/hadoku-cardtable';
	const nodes = [
		node('claw-9', { warmRepo: REPO }),
		node('claw-3'),
		node('claw-4'),
		node('claw-8'),
	];
	const order = ['claw-9', 'claw-3', 'claw-4', 'claw-8'];
	const p = planTick(
		[run(1, { repo: REPO }), run(2, { repo: REPO }), run(3, { repo: REPO })],
		nodes,
		order,
		NONE,
		NOW
	);
	assert.equal(p.mint.length, 3);
	assert.equal(
		new Set(p.mint.map((m) => m.node)).size,
		3,
		'one job lands on each of three different nodes, none doubled up'
	);
	// REVERTED (the pre-#102 unconditional affinity stable-sort): job 1 and
	// job 2 both land on claw-9 (its liveUnits of 1 is still below
	// maxConcurrent 2, so affinity tries it again regardless of busy), and
	// only job 3 overflows to claw-3 — `new Set(...).size` reads 2, not 3.
});

test('#102: a node already running 2 jobs sorts after an idle one, regardless of which repo it is running', () => {
	const p = planTick(
		[run(1)],
		[node('claw-2', { liveUnits: 2, maxConcurrent: 4 }), node('claw-1')],
		ORDER,
		NONE,
		NOW
	);
	// REVERTED (walk `order` as given, with no busy-aware re-rank): claw-2 is
	// first in `ORDER` and not AT capacity (2 < 4), so it is chosen anyway.
	assert.equal(p.mint[0].node, 'claw-1');
});

// --- #102: one heavy job per node per tick, held not doubled ----------------

const CARDTABLE = 'WolffM/hadoku-cardtable';
const FORGE: HeavyModel = {
	isHeavy: (repo, job) =>
		repo === CARDTABLE && (job === 'forge-jvm' || /^forge-e2e( \(\d+\))?$/.test(job ?? '')),
	isHeavyRepo: (repo) => repo === CARDTABLE,
};
const forge = (id: number, jobName: string, queuedSec: number): PendingRun =>
	run(id, {
		repo: CARDTABLE,
		jobName,
		jobCreatedAt: new Date(NOW - queuedSec * 1000).toISOString(),
	});

test('#102 heavy hold: four Forge jobs over three jdk21 nodes place one apiece and HOLD the fourth (run 37851403985)', () => {
	const nodes = ['claw-8', 'claw-9', 'claw-4'].map((n) =>
		node(n, { maxConcurrent: 4, heavyModel: FORGE })
	);
	const p = planTick(
		[
			forge(1, 'forge-e2e (1)', 10),
			forge(2, 'forge-e2e (2)', 10),
			forge(3, 'forge-e2e (3)', 10),
			forge(4, 'forge-jvm', 10),
		],
		nodes,
		['claw-8', 'claw-9', 'claw-4'],
		NONE,
		NOW
	);
	assert.deepEqual(p.mint.map((m) => m.node).sort(), ['claw-4', 'claw-8', 'claw-9']);
	assert.equal(p.skipped.length, 1);
	assert.equal(p.skipped[0].runId, 4);
	assert.match(
		p.skipped[0].reason,
		/claw-8: heavy hold: already running 1 heavy job\(s\) \(queued 10s < 3600s\)/
	);
	// REVERTED (no hold): busy alone sends forge-jvm to a node already
	// running a shard — the doubling that turned shards 2 and 3 red.
});

test('#102 heavy hold: the held job places once it has waited HEAVY_HOLD_SEC', () => {
	const nodes = [node('claw-4', { maxConcurrent: 4, heavyJobs: 1, heavyModel: FORGE })];
	const p = planTick([forge(4, 'forge-jvm', HEAVY_HOLD_SEC + 5)], nodes, ['claw-4'], NONE, NOW);
	assert.equal(p.mint[0]?.node, 'claw-4');
});

test('a skip line cuts each node reason to its first sentence — an excludeRepos note is a paragraph', () => {
	const note =
		'claw-5 is slow at everything (measured p10 2.07x, p50 2.91x). cardtable vitest failed here: run 37109806015.';
	assert.equal(firstSentence(note), 'claw-5 is slow at everything (measured p10 2.07x, p50 2.91x)');
	assert.equal(firstSentence('at capacity: 3/2 in flight'), 'at capacity: 3/2 in flight');
	assert.equal(firstSentence('x'.repeat(200)).length, 120);
	const p = planTick(
		[run(1, { repo: 'WolffM/hadoku-cardtable' })],
		[node('claw-5', { excludedRepos: new Map([['WolffM/hadoku-cardtable', note]]) })],
		['claw-5'],
		NONE,
		NOW
	);
	assert.match(
		p.skipped[0].reason,
		/\(claw-5: repo excluded here: claw-5 is slow at everything \(measured p10 2\.07x, p50 2\.91x\)\)$/
	);
});

// #131: a job only hokon can serve must not lose hokon's free slot to a job
// that has claws to go to. Shapes from 2026-10-20/21: tenhands
// `self-hosted, pm2-host, taskauto` (only hokon) and a cardtable Forge shard
// `self-hosted, hadoku-builder, jdk21` (hokon AND the jdk21 claws).
const HOKON_LABELS = [
	'self-hosted',
	'pm2-host',
	'taskauto',
	'av1-nvenc',
	'hadoku-builder',
	'jdk21',
];
const CLAW_LABELS = ['self-hosted', 'hadoku-builder', 'jdk21'];
const forgeShard = (id: number) =>
	run(id, { repo: 'WolffM/hadoku-cardtable', labels: ['self-hosted', 'hadoku-builder', 'jdk21'] });
const taskauto = (id: number, over: Partial<PendingRun> = {}) =>
	run(id, {
		repo: 'WolffM/hadoku-tenhands',
		labels: ['self-hosted', 'pm2-host', 'taskauto'],
		event: 'schedule',
		...over,
	});

test('#131: a hokon-only job gets hokon’s free slot even when a flexible job is ahead of it', () => {
	// hokon idle with ONE slot, claw-1 busier with room: fewest-busy-first ranks
	// hokon first for the Forge shard, which is ahead in priority (a push).
	const nodes = [
		node('hokon', { labels: HOKON_LABELS, maxConcurrent: 1 }),
		node('claw-1', { labels: CLAW_LABELS, maxConcurrent: 3, liveUnits: 1 }),
	];
	const p = planTick([forgeShard(1), taskauto(2)], nodes, ['hokon', 'claw-1'], NONE, NOW);
	const where = Object.fromEntries(p.mint.map((m) => [m.runId, m.node]));
	assert.deepEqual(where, { 1: 'claw-1', 2: 'hokon' });
	assert.equal(p.skipped.length, 0);
});

test('#131: single-node runs keep their own priority order, and so do the rest', () => {
	const nodes = [
		node('hokon', { labels: HOKON_LABELS }),
		node('claw-1', { labels: CLAW_LABELS }),
		node('claw-2', { labels: CLAW_LABELS }),
	];
	const order = singleNodeFirst(
		[forgeShard(1), taskauto(2), forgeShard(3), taskauto(4, { event: 'workflow_dispatch' })],
		nodes
	).map((r) => r.id);
	assert.deepEqual(order, [2, 4, 1, 3]);
});

test('#131: "single-node" is decided by labels, not by who is full this tick', () => {
	// hokon full: the taskauto job is still hokon's alone, and still first in
	// line for it; a node outside the eligible set does not count as a home.
	const nodes = [
		node('hokon', { labels: HOKON_LABELS, maxConcurrent: 1, liveUnits: 1 }),
		node('claw-1', { labels: CLAW_LABELS }),
		node('claw-9', { labels: [...HOKON_LABELS], eligible: false }),
	];
	assert.deepEqual(
		singleNodeFirst([forgeShard(1), taskauto(2)], nodes).map((r) => r.id),
		[2, 1]
	);
	const p = planTick([forgeShard(1), taskauto(2)], nodes, ['hokon', 'claw-1'], NONE, NOW);
	assert.deepEqual(
		p.mint.map((m) => [m.runId, m.node]),
		[[1, 'claw-1']]
	);
	assert.equal(p.skipped[0].runId, 2);
});
