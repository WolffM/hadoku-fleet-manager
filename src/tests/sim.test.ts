/**
 * The traffic simulator (`fleet simulate`): corpus, fleet, engine, metrics and
 * the reconstructed legacy policy, each on a workload small enough to work
 * out by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { JobRecord } from '../job-history-store.js';
import type { SpeedModel } from '../runners/speed-tier.js';
import type { HeavyModel } from '../runners/heavy-model.js';
import { buildCorpus, phasesOf } from '../runners/sim-corpus.js';
import { buildFleet, capacityAt, type SimNodeSpec } from '../runners/sim-fleet.js';
import {
	baselinePolicy,
	kindRatio,
	simulate,
	soloRunSec,
	type SimPolicy,
} from '../runners/sim-engine.js';
import { historicalOutcomes, measure } from '../runners/sim-metrics.js';
import {
	legacyHoldPolicy,
	reservationPolicy,
	scarceLabelsOf,
	universalLabels,
} from '../runners/sim-policies.js';
import type { NodeState } from '../runners/placement-node-state.js';
import type { PendingRun } from '../runners/dispatcher.js';
import { HEAVY_DOUBLE_HOLD_SEC, HEAVY_HOLD_SEC } from '../runners/placement-slow.js';

const T0 = Date.parse('2026-11-01T00:00:00Z');
const iso = (sec: number): string => new Date(T0 + sec * 1000).toISOString().replace('.000Z', 'Z');
const PLAIN = ['self-hosted', 'hadoku-builder'];
const JDK = [...PLAIN, 'jdk21'];
/** The fleet's node names, as the manifest gives them to buildCorpus. */
const NODES = ['claw-1', 'claw-8', 'claw-9', 'hokon'];
const corpusOf = (records: JobRecord[]) => buildCorpus(records, NODES);

/** A job-history record: created at `createdSec`, started after `queueSec`. */
function rec(
	jobId: number,
	createdSec: number,
	over: Partial<JobRecord> & { queueSec?: number } = {}
): JobRecord {
	const queueSec = over.queueSec ?? 5;
	return {
		repo: 'WolffM/hadoku_site',
		runId: jobId,
		jobId,
		name: 'check',
		runner: `jit-claw-1-hadoku_site-j${jobId}-r${jobId}-1`,
		labels: PLAIN,
		startedAt: iso(createdSec + queueSec),
		durationSec: 100,
		queueSec,
		assignSec: 5,
		setupSec: 10,
		runSec: 80,
		cleanupSec: 10,
		conclusion: 'success',
		...over,
	};
}

const NEUTRAL: SpeedModel = {
	tierOf: () => 'unknown',
	expectedExtraSec: () => null,
	factorOf: () => null,
	describe: () => ({ tier: 'unknown', p25: null, p50: null, kinds: 0 }),
};

function node(
	name: string,
	labels: string[],
	over: Partial<SimNodeSpec> = {},
	slots = 1
): SimNodeSpec {
	return {
		name,
		labels,
		backstop: false,
		excludeRepos: new Map(),
		idleFreeMb: 30_000,
		mbPerJob: { light: 500, heavy: 1000 },
		timeline: [
			{
				atMs: 0,
				maxConcurrent: slots,
				warmHeld: 0,
				warmRepo: null,
				healthy: true,
				drained: false,
				schedulable: true,
				minFreeMb: 1536,
				requiredMb: 900,
				baseFreeMb: 30_000,
			},
		],
		...over,
	};
}

const models = (heavy?: HeavyModel) => ({ speed: NEUTRAL, heavy, reserves: new Map() });
const run = (
	records: JobRecord[],
	fleet: SimNodeSpec[],
	policy: SimPolicy = baselinePolicy(),
	heavy?: HeavyModel
) => {
	const corpus = corpusOf(records);
	return { corpus, result: simulate(corpus, fleet, models(heavy), policy, { drainSec: 3600 }) };
};
const outcomeOf = (r: ReturnType<typeof run>, jobId: number) => {
	const j = r.corpus.jobs.find((x) => x.jobId === jobId)!;
	return r.result.outcomes.find((o) => o.key === j.key)!;
};

test('corpus: arrival is start minus queue; hosted and duplicate records are counted, not replayed', () => {
	const c = corpusOf([
		rec(1, 0, { queueSec: 30 }),
		rec(1, 0, { queueSec: 30 }),
		rec(2, 10, { runner: 'GitHub Actions 7' }),
		rec(3, 20, { queueSec: undefined }),
	]);
	assert.equal(c.jobs.length, 2);
	assert.equal(c.duplicates, 1);
	assert.equal(c.hosted, 1);
	assert.equal(c.noQueueSec, 1);
	assert.equal(c.jobs[0].arrivalMs, T0);
	assert.equal(c.jobs[0].histNode, 'claw-1');
	assert.equal(
		c.jobs[1].arrivalMs,
		T0 + 25_000,
		'no queueSec: arrives at its start (25 s), never a guessed zero wait'
	);
});

test('corpus: phases sum to the duration, and a record without them is all run', () => {
	assert.deepEqual(phasesOf({ durationSec: 100, setupSec: 10, cleanupSec: 5 }), {
		setupSec: 10,
		runSec: 85,
		cleanupSec: 5,
	});
	assert.equal(phasesOf({ durationSec: 100 }), null);
	const c = corpusOf([
		rec(1, 0, { setupSec: undefined, runSec: undefined, cleanupSec: undefined }),
	]);
	assert.equal(c.noPhases, 1);
	assert.equal(c.jobs[0].runSec, 100);
});

test('corpus: a same-run job created within the gap after another ended depends on it', () => {
	const c = corpusOf([
		rec(1, 0, { runId: 9, queueSec: 0 }), // ends at 100
		rec(2, 104, { runId: 9 }), // 4 s after: a dependant
		rec(3, 200, { runId: 9 }), // 100 s after: independent
		rec(4, 104, { runId: 10 }), // another run: independent
	]);
	const by = (id: number) => c.jobs.find((j) => j.jobId === id)!;
	assert.deepEqual(by(2).dependsOn, { key: by(1).key, gapSec: 4 });
	assert.equal(by(3).dependsOn, undefined);
	assert.equal(by(4).dependsOn, undefined);
});

test('engine: a job waits for the next tick, then GitHub pickup', () => {
	const r = run([rec(1, 5)], [node('claw-1', PLAIN)]);
	const o = outcomeOf(r, 1);
	assert.equal(o.placedMs, T0 + 15_000, 'arrived at 5 s, placed on the 15 s tick');
	assert.equal(o.startMs, T0 + 20_000, 'plus the record’s 5 s pickup');
	assert.equal(o.endMs, T0 + 15_000 + 105_000, 'pickup 5 + setup 10 + run 80 + cleanup 10');
	assert.equal(o.slotSec, 105);
	assert.equal(o.runSec, 80);
	assert.equal(r.result.unserved, 0);
});

test('engine: capacity binds — a second job waits until the first frees the slot', () => {
	const r = run([rec(1, 0), rec(2, 0)], [node('claw-1', PLAIN)]);
	const [a, b] = [outcomeOf(r, 1), outcomeOf(r, 2)];
	assert.equal(a.placedMs, T0);
	assert.equal(a.endMs, T0 + 105_000);
	assert.equal(b.placedMs, T0 + 105_000, 'the tick at 105 s sees the slot free');
});

test('engine: labels route — a jdk21 job goes only to the node that carries jdk21', () => {
	const r = run([rec(1, 0, { labels: JDK })], [node('claw-1', PLAIN), node('claw-9', JDK)]);
	assert.equal(outcomeOf(r, 1).node, 'claw-9');
});

test('engine: a dependant arrives its recorded gap after its predecessor’s SIMULATED end', () => {
	// Recorded: job 1 ran alone. Simulated: one slot, and job 0 holds it first,
	// so job 1 ends later and job 2 must arrive later with it.
	const r = run(
		[
			rec(0, 0, { runId: 5, queueSec: 0 }),
			rec(1, 0, { runId: 9, queueSec: 0 }),
			rec(2, 104, { runId: 9 }),
		],
		[node('claw-1', PLAIN, {}, 1)]
	);
	const end1 = outcomeOf(r, 1).endMs!;
	assert.equal(outcomeOf(r, 2).arrivalMs, end1 + 4_000);
	assert.ok(end1 > T0 + 200_000, 'job 1 ran behind job 0');
});

test('engine: a replayed warm slot takes its repo’s job at arrival, and JIT does not get that slot', () => {
	const warm = node('claw-1', PLAIN, {}, 2);
	warm.timeline = [{ ...warm.timeline[0], warmHeld: 1, warmRepo: 'WolffM/hadoku_site' }];
	const r = run(
		[
			rec(1, 5),
			rec(2, 5, { repo: 'WolffM/hadoku-task' }),
			rec(3, 5, { repo: 'WolffM/hadoku-task' }),
		],
		[warm]
	);
	assert.equal(r.result.warmServed, 1);
	assert.equal(outcomeOf(r, 1).placedMs, T0 + 5_000, 'warm: at arrival, not the next tick');
	assert.equal(outcomeOf(r, 1).pickupSec, 3);
	assert.equal(outcomeOf(r, 2).placedMs, T0 + 15_000);
	assert.ok(outcomeOf(r, 3).placedMs! > T0 + 100_000, 'one JIT slot: the other task job waits');
});

test('engine: a node outside its timeline’s healthy window takes nothing', () => {
	const sick = node('claw-1', PLAIN);
	sick.timeline = [
		{ ...sick.timeline[0], atMs: 0, healthy: false },
		{ ...sick.timeline[0], atMs: T0 + 300_000, healthy: true },
	];
	const r = run([rec(1, 0)], [sick]);
	assert.equal(outcomeOf(r, 1).placedMs, T0 + 300_000);
	assert.equal(capacityAt(sick, T0 + 299_000).healthy, false);
});

const FORGE: HeavyModel = {
	isHeavy: (repo, job) => repo === 'WolffM/hadoku-cardtable' && /^forge/.test(job ?? ''),
	isHeavyRepo: (repo) => repo === 'WolffM/hadoku-cardtable',
} as HeavyModel;
const shard = (id: number, at: number, over: Partial<JobRecord> = {}) =>
	rec(id, at, {
		repo: 'WolffM/hadoku-cardtable',
		name: `forge-e2e (${id})`,
		labels: JDK,
		runner: `jit-claw-9-x-j${id}`,
		durationSec: 1000,
		setupSec: 0,
		runSec: 1000,
		cleanupSec: 0,
		assignSec: 0,
		queueSec: 0,
		...over,
	});

test('contention: a recorded run is divided back to solo work by its recorded overlap', () => {
	const c = corpusOf([shard(1, 0), shard(2, 0)]);
	const solo = soloRunSec(c.jobs, (j) => j.name.startsWith('forge'), 0.3);
	for (const j of c.jobs) assert.equal(Math.round(solo.get(j.key)!), Math.round(1000 / 1.3));
});

test('contention: two heavy jobs on one node each run slower by the contention factor', () => {
	const r = run(
		[shard(1, 0, { queueSec: 0 }), shard(2, 0, { queueSec: 0 })],
		[node('claw-9', JDK, {}, 2)],
		{
			name: 'no-hold',
			plan: (t) => {
				// Place both, whatever the hold says: this test is about the slowdown.
				const p = baselinePolicy().plan({ ...t, pending: t.pending.slice(0, 1) });
				const q = baselinePolicy().plan({ ...t, pending: t.pending.slice(1) });
				return { ...p, mint: [...p.mint, ...q.mint] };
			},
		},
		FORGE
	);
	const [a, b] = [outcomeOf(r, 1), outcomeOf(r, 2)];
	assert.equal(a.node, 'claw-9');
	assert.equal(b.node, 'claw-9');
	// Solo work 1000/1.3 = 769 s; doubled throughout it stretches back to 1000 s.
	assert.ok(Math.abs(a.runSec - 1000) < 16, `ran ${a.runSec}`);
});

test('kindRatio: a kind’s own medians decide a move; a thin kind falls back to the node factor', () => {
	const jobs = corpusOf([
		...[1, 2, 3].map((i) => rec(i, i * 1000, { runner: `jit-claw-8-x-j${i}`, runSec: 50 })),
		...[4, 5, 6].map((i) => rec(i, i * 1000, { runner: `jit-claw-9-x-j${i}`, runSec: 100 })),
		rec(7, 9000, { name: 'rare', runner: 'jit-claw-8-x-j7' }),
	]).jobs;
	const ratio = kindRatio(jobs, new Map(), (n) => (n === 'claw-9' ? 2 : 1));
	const onClaw8 = jobs.find((j) => j.jobId === 1)!;
	assert.equal(ratio(onClaw8, 'claw-9'), 2, 'median 100 over 50');
	assert.equal(ratio(onClaw8, 'claw-8'), 1);
	assert.equal(
		ratio(
			jobs.find((j) => j.jobId === 7)!,
			'claw-9'
		),
		2,
		'node factor 2 over 1'
	);
});

test('legacy-hold: a heavy job does not double before HEAVY_HOLD_SEC; today’s baseline doubles after HEAVY_DOUBLE_HOLD_SEC', () => {
	const fleet = [node('claw-9', JDK, {}, 4)];
	const jobs = [shard(1, 0), shard(2, 0)];
	const legacy = run(jobs, fleet, legacyHoldPolicy(), FORGE);
	const today = run(jobs, fleet, baselinePolicy(), FORGE);
	const second = (r: ReturnType<typeof run>) =>
		Math.max(outcomeOf(r, 1).placedMs!, outcomeOf(r, 2).placedMs!) - T0;
	assert.ok(second(today) >= HEAVY_DOUBLE_HOLD_SEC * 1000 && second(today) < HEAVY_HOLD_SEC * 1000);
	assert.ok(second(legacy) >= 769_000, 'legacy waits for the first shard to finish (solo 769 s)');
});

test('starvation: a policy that leaves an admissible job queued past starveSec is counted', () => {
	const never: SimPolicy = { name: 'never', plan: () => ({ mint: [], skipped: [], reserved: [] }) };
	const corpus = corpusOf([rec(1, 0)]);
	const r = simulate(corpus, [node('claw-1', PLAIN)], models(), never, {
		drainSec: 600,
		starveSec: 300,
	});
	assert.equal(r.starvedJobs, 1);
	assert.ok(r.starvedJobSec >= 290);
	assert.equal(r.unserved, 1, 'and it is reported as never served, not dropped');
});

test('measure: the oldest job in queue, work over slot time, and free claw slots', () => {
	const corpus = corpusOf([rec(1, 0, { queueSec: 60 }), rec(2, 30, { queueSec: 0 })]);
	const jobs = new Map(corpus.jobs.map((j) => [j.key, j]));
	const fleet = [node('claw-1', PLAIN, {}, 2), node('hokon', PLAIN, { backstop: true }, 4)];
	const m = measure(historicalOutcomes(corpus), jobs, fleet, {
		tickSec: 15,
		fromMs: T0,
		toMs: T0 + 300_000,
	});
	assert.equal(m.oldest.peakSec, 45, 'job 1 waits 0-60 s; the last tick it is queued is at 45 s');
	assert.equal(m.efficiency.runSec, 160);
	assert.equal(m.efficiency.slotSec, 210, 'two jobs of pickup 5 + duration 100');
	assert.equal(m.capacity.meanSlots, 2, 'the backstop is not claw capacity');
	assert.equal(m.queueSec.max, 60);
	// Both claw-1 slots are busy on the ticks at 60-120 s (job 1 placed 55 s,
	// job 2 25-130 s): 5 of the 21 ticks in 0-300 s have none free.
	assert.equal(m.classes['hadoku-builder'].freeSlots!.shareOfTicksWithFree, 16 / 21);
});

test('fleet: labels are what a node served; a backstop’s builder label is held for promotion', () => {
	const corpus = corpusOf([
		rec(1, 0, { runner: 'jit-claw-9-x-j1', labels: JDK }),
		rec(2, 0, { runner: 'hokon', labels: [...PLAIN, 'pm2-host'] }),
	]);
	const fleet = buildFleet({
		jobs: corpus.jobs,
		capacity: [
			{
				atMs: T0,
				rows: [
					{
						node: 'claw-9',
						busy: 0,
						max: 3,
						warmHeld: 1,
						warmRepo: 'WolffM/x',
						freeMb: 20_000,
						requiredMb: 900,
						minFreeMb: 2048,
						healthy: true,
						drained: false,
					},
				],
			},
			{
				atMs: T0 + 60_000,
				rows: [
					{
						node: 'claw-9',
						busy: 2,
						max: 3,
						freeMb: 16_000,
						requiredMb: 900,
						minFreeMb: 2048,
						healthy: true,
						drained: false,
					},
				],
			},
		],
		machines: { hokon: { role: 'backstop' } },
	});
	const c9 = fleet.find((s) => s.name === 'claw-9')!;
	const hk = fleet.find((s) => s.name === 'hokon')!;
	assert.deepEqual(c9.labels, ['hadoku-builder', 'jdk21', 'self-hosted']);
	assert.deepEqual(hk.labels, ['pm2-host', 'self-hosted']);
	assert.equal(hk.backstop, true);
	assert.equal(c9.mbPerJob.light, 2000, '(20,000 idle - 16,000) / 2 busy');
	assert.equal(capacityAt(c9, T0).maxConcurrent, 4, 'max 3 + 1 warm');
	assert.equal(capacityAt(c9, T0).warmRepo, 'WolffM/x');
	assert.equal(
		capacityAt(c9, T0 + 60_000).maxConcurrent,
		3,
		'the warm slot is gone a minute later'
	);
	assert.equal(capacityAt(c9, T0 + 60_000).warmRepo, null);
});

test('determinism: the same input gives the same outcomes', () => {
	const records = [rec(1, 0), rec(2, 3), rec(3, 7, { labels: JDK, runner: 'jit-claw-9-x-j3' })];
	const fleet = [node('claw-1', PLAIN), node('claw-9', JDK)];
	assert.deepEqual(run(records, fleet).result.outcomes, run(records, fleet).result.outcomes);
});

// --- the reservation policy, one tick at a time --------------------------------

const ns = (name: string, labels: string[], over: Partial<NodeState> = {}): NodeState => ({
	name,
	healthy: true,
	eligible: true,
	drained: false,
	schedulable: true,
	labels,
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 4,
	freeMb: 20_000,
	requiredMb: 900,
	minFreeMb: 1536,
	...over,
});
const pr = (jobId: number, labels: string[], over: Partial<PendingRun> = {}): PendingRun => ({
	id: jobId,
	jobId,
	repo: 'WolffM/hadoku_site',
	repository: { full_name: 'WolffM/hadoku_site' },
	head_repository: { full_name: 'WolffM/hadoku_site', fork: false },
	event: 'push',
	labels,
	jobName: 'check',
	queuedSinceMs: T0,
	...over,
});
const CT = 'WolffM/hadoku-cardtable';
/** cardtable's jdk21 job needs 4,000 MB, a lower bound: admission holds it to that. */
const BIG = new Map([[CT, { mb: 4000, lowerBound: true }]]);
const placed = (plan: { mint: { jobId: number; node: string }[] }) =>
	Object.fromEntries(plan.mint.map((m) => [m.jobId, m.node]));

test('scarce labels: a label not every claw carries; one they all carry is not', () => {
	const u = universalLabels([ns('claw-1', PLAIN), ns('claw-9', JDK)]);
	assert.deepEqual([...u].sort(), ['hadoku-builder', 'self-hosted']);
	assert.deepEqual(scarceLabelsOf(JDK, u), ['jdk21']);
	assert.deepEqual(scarceLabelsOf(PLAIN, u), []);
	assert.deepEqual(
		scarceLabelsOf(JDK, universalLabels([ns('claw-9', JDK)])),
		[],
		'every claw has it'
	);
});

test('reservation (reserve=0): narrow jobs are planned first, so plain jobs listed ahead do not fill both jdk21 claws', () => {
	// One jdk21 home would already go first today (#131's single-node rule);
	// with TWO, plain jobs walked first fill both and the jdk21 job waits.
	const nodes = [
		ns('claw-9', JDK, { maxConcurrent: 1 }),
		ns('claw-8', JDK, { maxConcurrent: 1 }),
		ns('claw-1', PLAIN, { liveUnits: 1, maxConcurrent: 3 }),
	];
	const tick = {
		nowMs: T0 + 30_000,
		nodes,
		order: ['claw-9', 'claw-8', 'claw-1'],
		pending: [pr(1, PLAIN), pr(2, PLAIN), pr(3, JDK)],
		estimate: () => null,
	};
	assert.deepEqual(placed(reservationPolicy({ reserve: 0 }).plan(tick)), {
		1: 'claw-8',
		2: 'claw-1',
		3: 'claw-9',
	});
	assert.deepEqual(placed(baselinePolicy().plan(tick)), { 1: 'claw-9', 2: 'claw-8' }, 'today');
});

/** claw-9 runs two general jobs and has 5,000 MB: the 4,000 MB jdk21 job is refused on memory; draining frees 1,800. */
const memoryTick = (nowSec: number, pending: PendingRun[]) => ({
	nowMs: T0 + nowSec * 1000,
	nodes: [
		ns('claw-9', JDK, { liveUnits: 2, freeMb: 5000, requiredMbByRepo: BIG }),
		ns('claw-1', PLAIN, { liveUnits: 3 }),
	],
	order: ['claw-9', 'claw-1'],
	pending,
	estimate: () => null,
});
const jdkJob = pr(2, JDK, {
	repo: CT,
	repository: { full_name: CT },
	head_repository: { full_name: CT, fork: false },
});

test('reservation (memoryCredit=1): a claw blocked on memory for a queued jdk21 job stops taking general CI', () => {
	const policy = reservationPolicy({ memoryCredit: 1 });
	const plan = policy.plan(memoryTick(30, [pr(1, PLAIN), jdkJob]));
	assert.deepEqual(placed(plan), { 1: 'claw-1' }, 'the plain job goes elsewhere; claw-9 drains');
	assert.equal(policy.stats!().reservationStarts, 1);
	assert.equal(policy.stats!().drains, 1, 'it was running general work when reserved');
	assert.equal(policy.warmAllowed!('claw-9'), false, 'and its warm slot takes no general job');
	// REVERTED (memoryCredit 0): the drained claw still reads as refusing, so
	// nothing is reserved and the plain job takes claw-9.
	assert.deepEqual(placed(reservationPolicy().plan(memoryTick(30, [pr(1, PLAIN), jdkJob]))), {
		1: 'claw-9',
	});
});

test('reservation: a claw that refuses the job even drained is never reserved (no idle deadlock)', () => {
	const policy = reservationPolicy({ memoryCredit: 1 });
	const tight = memoryTick(30, [pr(1, PLAIN), jdkJob]);
	// The plain job fits in 3,200 MB; the jdk21 job does not even drained
	// (3,200 + 1,800 - 4,000 is under the 1,536 floor).
	tight.nodes[0] = { ...tight.nodes[0], freeMb: 3200 };
	assert.deepEqual(placed(policy.plan(tight)), { 1: 'claw-9' });
	assert.equal(policy.stats!().reservationStarts, 0);
});

test('reservation: general CI first — a plain job stuck past generalFirstSec releases the reserved claw', () => {
	const policy = reservationPolicy({ memoryCredit: 1, generalFirstSec: 100 });
	policy.plan(memoryTick(30, [jdkJob]));
	const full = memoryTick(130, [pr(1, PLAIN, { queuedSinceMs: T0 }), jdkJob]);
	full.nodes[1] = { ...full.nodes[1], liveUnits: 4 }; // claw-1 full: claw-9 is the plain job's only home
	assert.deepEqual(placed(policy.plan(full)), { 1: 'claw-9' });
	assert.equal(policy.stats!().generalFirstReleases, 1);
	// Released for the cooldown: the next tick does not take it straight back.
	policy.plan(memoryTick(145, [jdkJob]));
	assert.equal(policy.warmAllowed!('claw-9'), true);
});

test('reservation: a claw stays reserved lingerSec after its demand leaves the queue, then rejoins', () => {
	const policy = reservationPolicy({ memoryCredit: 1, lingerSec: 120 });
	policy.plan(memoryTick(30, [jdkJob]));
	policy.plan(memoryTick(90, [])); // demand gone 60 s after it was last needed
	assert.equal(policy.warmAllowed!('claw-9'), false, 'still lingering');
	policy.plan(memoryTick(150, []));
	assert.equal(policy.warmAllowed!('claw-9'), true);
	assert.deepEqual([policy.stats!().reservationStarts, policy.stats!().reservationEnds], [1, 1]);
});
