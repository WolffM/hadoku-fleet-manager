/**
 * WARM YIELD (operator, 2026-11-09): a warm listener gives its slot to a
 * long-waiting job when spare claws can cover normal CI. The measured shape is
 * claw-10: full at 1/1 behind an idle hadoku_site listener on maxConcurrent 2,
 * while a jdk21 job only it (of the nodes here) can run waits.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runDispatchPass } from '../runners/dispatch-pass.js';
import {
	dispatchWarmCache,
	__resetWarmCacheClockForTesting,
} from '../runners/dispatch-warm-cache.js';
import { dispatchEphemeral } from '../runners/ephemeral-tick.js';
import { warmRunnerName } from '../lib/jit-naming.js';
import {
	__resetWarmYieldsForTesting,
	readWarmYields,
	warmSlotYielded,
	warmYieldRequestFor,
	WARM_YIELD_COOLDOWN_MS,
} from '../runners/warm-yields.js';
import { __resetWarmYieldLogForTesting } from '../runners/warm-yield.js';
import {
	__markHeavyForTesting,
	__resetHeavyMarksForTesting,
} from '../runners/dispatch-pass-state.js';
import {
	__resetDecisionLogForTesting,
	__restoreDecisionSinkForTesting,
	__setDecisionSinkForTesting,
} from '../runners/decision-log.js';
import type { DecisionRecord } from '../runners/decision-log-types.js';
import type { NodeState } from '../runners/placement-node-state.js';
import type { PendingRun } from '../runners/dispatcher.js';
import type { EphemeralTickInput } from '../runners/ephemeral-shared.js';
import { fakeGh, fakeShell } from './helpers/fleet-fakes.js';
import { node, base } from './helpers/dispatch-pass-rig.js';
import {
	type NodeSim,
	NODE_ELIGIBLE,
	installWarmCacheRig,
	simShell,
	writeRecord,
	histAt,
	tmp,
} from './helpers/warm-cache-rig.js';

installWarmCacheRig();

const SITE = 'WolffM/hadoku_site';
const CARD = 'WolffM/hadoku-cardtable';
const UNIT = warmRunnerName('claw-10', SITE);
const JDK = ['self-hosted', 'hadoku-builder', 'jdk21'];

let rows: DecisionRecord[] = [];
beforeEach(() => {
	__resetWarmYieldsForTesting(tmp);
	__resetWarmYieldLogForTesting();
	__resetDecisionLogForTesting();
	rows = [];
	__setDecisionSinkForTesting((r) => void rows.push(...r));
});
afterEach(() => {
	__resetHeavyMarksForTesting();
	__restoreDecisionSinkForTesting();
	__resetDecisionLogForTesting();
	__resetWarmYieldsForTesting(null);
});

const YIELD_KINDS = new Set(['warm-yield', 'warm-yield-refused', 'warm-refill']);
const yieldRows = (action?: string) =>
	rows.filter((r) => YIELD_KINDS.has(r.kind) && (action === undefined || r.action === action));

/** The jdk21 job, queued `sec` seconds before `nowMs`. */
const jdkJob = (nowMs: number, sec: number): PendingRun => ({
	id: 7,
	repo: CARD,
	repository: { full_name: CARD },
	head_repository: { full_name: CARD, fork: false },
	event: 'push',
	jobId: 700,
	jobName: 'forge-jvm',
	labels: JDK,
	queuedSinceMs: nowMs - sec * 1000,
});

/**
 * claw-10 as the dispatch pass sees it: its 2 slots less the one held for its
 * idle hadoku_site listener, and that one in use by a JIT job.
 */
const claw10 = (over: Partial<NodeState> = {}): NodeState =>
	node('claw-10', {
		labels: ['hadoku-builder', 'jdk21'],
		maxConcurrent: 1,
		liveUnits: 1,
		warmHeld: 1,
		warmRepo: SITE,
		...over,
	});
/** A claw with room for an ordinary hadoku_site job, and no jdk21. */
const free = (name: string, over: Partial<NodeState> = {}): NodeState =>
	node(name, { labels: ['hadoku-builder'], ...over });

async function pass(nodes: NodeState[], pending: PendingRun[], nowMs: number) {
	const gh = fakeGh();
	const r = await runDispatchPass(
		base({ order: nodes.map((n) => n.name), nodes, pending, nowMs }),
		'tok',
		gh,
		fakeShell({ units: [] })
	);
	return { r, minted: gh.writes.filter((w) => w.includes('generate-jitconfig')) };
}

/** The warm tick on claw-10 alone, holding `SITE` unless the sim says otherwise. */
async function warmTick(
	nowMs: number,
	o: {
		busy?: boolean;
		listed?: boolean;
		workers?: number;
		sim?: Partial<NodeSim>;
		/** The marker read prints nothing: the node could not be read. */
		markerUnreadable?: boolean;
	} = {}
) {
	__resetWarmCacheClockForTesting();
	const sims: Record<string, NodeSim> = {
		'claw-10': { marker: `${SITE} 1000`, activeUnits: new Set([UNIT]), ...o.sim },
	};
	const listed = fakeGh({ runners: [{ id: 1, name: UNIT, busy: o.busy ?? false }] });
	// `listed: false`: the warm tick's own read of the registration comes back
	// without it (could not confirm), while any later read would find it — so
	// only the idle check, not a failed delete, can keep the listener.
	let firstRead = true;
	const gh =
		o.listed === false
			? {
					...listed,
					get: async (path: string, token: string) => {
						if (firstRead) {
							firstRead = false;
							return { runners: [] };
						}
						return listed.get(path, token);
					},
				}
			: listed;
	const input: EphemeralTickInput = {
		fleetProbe: new Map([
			['claw-10', { reachable: true, busyRepos: null, workers: o.workers ?? 1 }],
		]),
		ephemeral: new Set(['claw-10']),
		nodes: { 'claw-10': { ...NODE_ELIGIBLE, maxConcurrent: 2 } },
		isSick: () => false,
		repos: [SITE],
	};
	const inner = simShell(sims);
	const sh = async (n: string, cmd: string) =>
		o.markerUnreadable && cmd.includes('warm/repo') ? '' : inner(n, cmd);
	const res = await dispatchWarmCache(input, 'tok', gh, sh, nowMs);
	return { res, sim: sims['claw-10'], gh, input, sims };
}

test('yields: a jdk21 job 90 s queued behind an idle listener, two spare claws -> evicted, then minted there', async () => {
	writeRecord({ runner: 'claw-10', repo: SITE, startedAt: histAt(0) });
	const now = Date.now();
	const nodes = [claw10(), free('claw-1'), free('claw-3')];
	const first = await pass(nodes, [jdkJob(now, 90)], now);
	assert.equal(first.minted.length, 0, 'claw-10 is full at 1/1 this pass');
	const req = warmYieldRequestFor('claw-10', now);
	assert.ok(req, 'the pass asks claw-10 to yield');
	assert.equal(req.warmRepo, SITE);
	assert.equal(req.job.jobId, 700);
	assert.equal(req.spare, 2);

	const { res, sim, gh } = await warmTick(now + 5_000);
	assert.equal(res.evicted, 1, 'the idle listener is evicted');
	assert.equal(res.filled, 0, 'and its slot is not refilled');
	assert.ok(!sim.activeUnits.has(UNIT), 'its unit is stopped');
	assert.ok(
		gh.writes.some((w) => w.endsWith('/actions/runners/1')),
		'its registration is deleted'
	);
	assert.equal(warmSlotYielded('claw-10'), true);
	assert.equal(
		readWarmYields(tmp)?.['claw-10']?.job.jobId,
		700,
		'the yield is on disk for the canary'
	);
	const y = yieldRows('yield');
	assert.equal(y.length, 1);
	assert.equal(y[0].winner, 'claw-10');
	assert.equal(y[0].repo, SITE);
	assert.equal(y[0].jobId, 700);
	assert.match(y[0].reason ?? '', /spare=2/);

	// The reservation is released where the budget is built: the dispatch pass
	// is handed claw-10's whole maxConcurrent.
	const seen = new Map<string, number>();
	const stub = (async (p: { nodes: { name: string; maxConcurrent: number }[] }) => {
		for (const n of p.nodes) seen.set(n.name, n.maxConcurrent);
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: null };
	}) as unknown as Parameters<typeof dispatchEphemeral>[4];
	await dispatchEphemeral(
		{
			fleetProbe: new Map([['claw-10', { reachable: true, busyRepos: null, workers: 1 }]]),
			ephemeral: new Set(['claw-10']),
			nodes: { 'claw-10': { ...NODE_ELIGIBLE, maxConcurrent: 2 } },
			isSick: () => false,
			repos: [SITE],
		},
		'tok',
		fakeGh({}) as unknown as Parameters<typeof dispatchEphemeral>[2],
		simShell({ 'claw-10': { marker: null, activeUnits: new Set() } }),
		stub
	);
	assert.equal(seen.get('claw-10'), 2, 'no slot is held back for a listener that yielded');

	// The next pass, at that budget, mints J on claw-10.
	const next = await pass(
		[
			claw10({ maxConcurrent: 2, warmHeld: 0, warmRepo: undefined }),
			free('claw-1'),
			free('claw-3'),
		],
		[jdkJob(now + 15_000, 105)],
		now + 15_000
	);
	assert.equal(next.minted.length, 1, 'J is minted');
	assert.equal(next.r.minted, 1);
});

test('keeps when CI is not easy: no spare claw for hadoku_site and no other listener', async () => {
	const now = Date.now();
	// claw-1 is full; claw-3 is absent from the pass entirely (unmeasured).
	const nodes = [claw10(), free('claw-1', { liveUnits: 2 })];
	await pass(nodes, [jdkJob(now, 90)], now);
	assert.equal(warmYieldRequestFor('claw-10', now), undefined, 'one spare is not enough');
	const { res, sim } = await warmTick(now + 5_000);
	assert.equal(res.evicted, 0);
	assert.ok(sim.activeUnits.has(UNIT), 'the listener stays');
	assert.equal(warmSlotYielded('claw-10'), false);
	assert.equal(yieldRows().length, 0);
});

test('one spare is not two: claw-3 refusing on memory is not spare', async () => {
	const now = Date.now();
	await pass([claw10(), free('claw-1'), free('claw-3', { freeMb: 1000 })], [jdkJob(now, 90)], now);
	assert.equal(warmYieldRequestFor('claw-10', now), undefined);
});

test('another live listener for the same repo covers it, with no spare claw at all', async () => {
	const now = Date.now();
	await pass(
		[claw10(), free('claw-1', { liveUnits: 1, maxConcurrent: 1, warmHeld: 1, warmRepo: SITE })],
		[jdkJob(now, 90)],
		now
	);
	const req = warmYieldRequestFor('claw-10', now);
	assert.ok(req);
	assert.deepEqual(req.otherWarm, ['claw-1']);
	assert.equal(req.spare, 0);
});

test('never evicts a busy listener', async () => {
	const now = Date.now();
	await pass([claw10(), free('claw-1'), free('claw-3')], [jdkJob(now, 90)], now);
	assert.ok(warmYieldRequestFor('claw-10', now));
	const { res, sim } = await warmTick(now + 5_000, { busy: true });
	assert.equal(res.evicted, 0);
	assert.ok(sim.activeUnits.has(UNIT));
	assert.equal(warmSlotYielded('claw-10'), false);
	assert.equal(yieldRows('yield-refused').length, 1);
});

test('never evicts a listener it could not confirm idle', async () => {
	const now = Date.now();
	await pass([claw10(), free('claw-1'), free('claw-3')], [jdkJob(now, 90)], now);
	// Not in GitHub's listing: busy reads `null`, which the warm cache takes as busy.
	const unlisted = await warmTick(now + 5_000, { listed: false });
	assert.equal(unlisted.res.evicted, 0);
	assert.ok(unlisted.sim.activeUnits.has(UNIT));
	// GitHub says idle but a Runner.Worker is live under the slot.
	await pass([claw10(), free('claw-1'), free('claw-3')], [jdkJob(now + 15_000, 105)], now + 15_000);
	const live = await warmTick(now + 20_000, { sim: { warmWorkerLive: true } });
	assert.equal(live.res.evicted, 0);
	assert.ok(live.sim.activeUnits.has(UNIT));
	assert.equal(warmSlotYielded('claw-10'), false);
});

test("doesn't yield when J still wouldn't fit: the memory clause", async () => {
	const now = Date.now();
	// One more 900 MB job would leave 1100 MB against a 1536 MB floor.
	await pass([claw10({ freeMb: 2000 }), free('claw-1'), free('claw-3')], [jdkJob(now, 90)], now);
	assert.equal(warmYieldRequestFor('claw-10', now), undefined);
});

test('a job queued under a minute asks nothing', async () => {
	const now = Date.now();
	await pass([claw10(), free('claw-1'), free('claw-3')], [jdkJob(now, 30)], now);
	assert.equal(warmYieldRequestFor('claw-10', now), undefined);
});

test('refill is suppressed while a job waits for the node and during the cooldown, then allowed', async () => {
	// Recent, so the planner still wants a hadoku_site listener 20 minutes on.
	writeRecord({ runner: 'claw-10', repo: SITE, startedAt: new Date().toISOString() });
	const now = Date.now();
	await pass([claw10(), free('claw-1'), free('claw-3')], [jdkJob(now, 90)], now);
	const y = await warmTick(now + 5_000);
	assert.equal(y.res.evicted, 1);
	const empty = { marker: null, activeUnits: new Set<string>() };

	// 1. Still queued for claw-10: another jdk21 job refused there on capacity.
	const t1 = now + 8 * 60_000;
	await pass(
		[claw10({ maxConcurrent: 2, liveUnits: 2, warmHeld: 0, warmRepo: undefined }), free('claw-1')],
		[{ ...jdkJob(t1, 20), id: 8, jobId: 800 }],
		t1
	);
	const during = await warmTick(t1 + 1_000, { sim: empty });
	assert.equal(during.res.filled, 0, 'no refill while a job waits for claw-10');
	assert.equal(warmSlotYielded('claw-10'), true);

	// 2. Queue drained at t1; inside the cooldown after it.
	const t2 = t1 + WARM_YIELD_COOLDOWN_MS - 60_000;
	const cool = await warmTick(t2, { sim: empty });
	assert.equal(cool.res.filled, 0, 'no refill inside the cooldown');
	assert.ok(yieldRows('refill-suppressed').length >= 1);

	// 3. Cooldown passed, but the node is still full of JIT work: no room.
	const t3 = t1 + WARM_YIELD_COOLDOWN_MS + 60_000;
	const full = await warmTick(t3, { sim: empty, workers: 2 });
	assert.equal(full.res.filled, 0, 'no listener on top of a full node');
	assert.equal(warmSlotYielded('claw-10'), true);

	// 4. Room again: the planner refills it.
	const after = await warmTick(t3 + 60_000, { sim: empty, workers: 1 });
	assert.equal(after.res.filled, 1, 'refilled once the queue drained and the cooldown passed');
	assert.equal(warmSlotYielded('claw-10'), false);
	assert.equal(yieldRows('refill').length, 1);
});

test('no churn: a pass with no waiting job, then a warm tick, changes nothing', async () => {
	writeRecord({ runner: 'claw-10', repo: SITE, startedAt: histAt(0) });
	const now = Date.now();
	await pass([claw10(), free('claw-1'), free('claw-3')], [], now);
	assert.equal(warmYieldRequestFor('claw-10', now), undefined);
	const { res, sim } = await warmTick(now + 5_000);
	assert.equal(res.evicted, 0);
	assert.equal(res.kept, 1, 'the listener is kept, exactly as before');
	assert.ok(sim.activeUnits.has(UNIT));
	assert.equal(yieldRows().length, 0);
});

test('an EMPTY reserved slot (no live listener) yields with nothing evicted, spare or not', async () => {
	// The live shape on 2026-11-09 07:46Z: claw-4, -9 and -10 each held a slot
	// for a listener the warm cache keeps away while they run a heavy job.
	const now = Date.now();
	await pass([claw10({ warmRepo: undefined })], [jdkJob(now, 90)], now);
	const req = warmYieldRequestFor('claw-10', now);
	assert.ok(req, 'an empty slot gives nothing up, so no spare is needed');
	assert.equal(req.warmRepo, null);
	__markHeavyForTesting('claw-10', now);
	const { res, gh } = await warmTick(now + 5_000, {
		sim: { marker: null, activeUnits: new Set() },
	});
	assert.equal(res.evicted, 0, 'nothing to evict');
	assert.equal(res.filled, 0);
	assert.equal(gh.writes.length, 0, 'no GitHub write');
	assert.equal(warmSlotYielded('claw-10'), true, 'the reservation is released');
	assert.equal(yieldRows('yield').length, 1);
});

test('an empty slot is NOT released when the node could not be read', async () => {
	const now = Date.now();
	await pass([claw10({ warmRepo: undefined })], [jdkJob(now, 90)], now);
	assert.ok(warmYieldRequestFor('claw-10', now));
	await warmTick(now + 5_000, { markerUnreadable: true });
	assert.equal(warmSlotYielded('claw-10'), false);
	assert.equal(yieldRows().length, 0);
});

test('a pass that saw no listener does not release a slot the node shows a listener in', async () => {
	// Right after a restart the affinity map is empty for a minute while the
	// listener is alive: the node's own marker wins.
	const now = Date.now();
	await pass([claw10({ warmRepo: undefined })], [jdkJob(now, 90)], now);
	const { res, sim } = await warmTick(now + 5_000);
	assert.equal(res.evicted, 0);
	assert.ok(sim.activeUnits.has(UNIT));
	assert.equal(warmSlotYielded('claw-10'), false);
});

test('a node running a heavy job yields its idle listener before the heavy branch sees it', async () => {
	const now = Date.now();
	await pass([claw10(), free('claw-1'), free('claw-3')], [jdkJob(now, 90)], now);
	__markHeavyForTesting('claw-10', now);
	const { res, sim } = await warmTick(now + 5_000);
	assert.equal(res.evicted, 1);
	assert.ok(!sim.activeUnits.has(UNIT));
	assert.equal(warmSlotYielded('claw-10'), true);
	assert.equal(yieldRows('yield').length, 1);
});

test('a listener found on a yielded slot ends the yield at once', async () => {
	const now = Date.now();
	await pass([claw10({ warmRepo: undefined })], [jdkJob(now, 90)], now);
	await warmTick(now + 5_000, { sim: { marker: null, activeUnits: new Set() } });
	assert.equal(warmSlotYielded('claw-10'), true);
	await warmTick(now + 65_000);
	assert.equal(warmSlotYielded('claw-10'), false, 'its slot is counted again');
});

test('one yield is ONE warm-yield row; the suppressed refill after it is its own kind, with no job id', async () => {
	// 2026-11-09 08:26:59/08:27:59Z: claw-1's yield and the next tick's
	// suppressed refill both read kind warm-yield with job 129054789513.
	const now = Date.now();
	await pass([claw10(), free('claw-1'), free('claw-3')], [jdkJob(now, 90)], now);
	await warmTick(now + 5_000);
	await pass(
		[claw10({ maxConcurrent: 2, liveUnits: 2, warmHeld: 0, warmRepo: undefined }), free('claw-1')],
		[{ ...jdkJob(now + 60_000, 20), id: 8, jobId: 800 }],
		now + 60_000
	);
	const empty = { marker: null, activeUnits: new Set<string>() };
	await warmTick(now + 65_000, { sim: empty });
	await warmTick(now + 125_000, { sim: empty });
	const yields = rows.filter((r) => r.kind === 'warm-yield');
	assert.equal(yields.length, 1, 'exactly one yield row');
	assert.equal(yields[0].jobId, 700);
	const refills = rows.filter((r) => r.kind === 'warm-refill');
	assert.equal(refills.length, 1, 'the suppressed refill is written once, on change');
	assert.equal(refills[0].action, 'refill-suppressed');
	assert.equal(refills[0].jobId, null);
	assert.equal(refills[0].queuedSec, null);
	assert.match(refills[0].reason ?? '', /job 700/);
});
