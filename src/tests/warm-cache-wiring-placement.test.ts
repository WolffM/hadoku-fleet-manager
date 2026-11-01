/**
 * The warm cache of one — the wiring (does the reservation reach admission
 * at all? #102's dispatchEphemeral own two sites; the generic admission
 * verdict, wave 4a §A.1 #100) and the live placement order (speed breaks
 * ties, #101's space admission from its OWN measurement). Split out of
 * warm-cache.test.ts (wave 5p lane C) — see `helpers/warm-cache-rig.ts` for
 * the shared fixtures and the file-wide `beforeEach`/`afterEach` every
 * split file installs. `budgetsFrom`/`labelsFromDispatchEphemeral`/
 * `verdictsFrom`/`orderFrom` stay local here: each is read only across the
 * two sections this one file now holds together.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	__resetCapacityLedgerForTesting,
	recordCapacityLedger,
} from '../runners/capacity-ledger.js';
import { admissionVerdictsForReport } from '../runners/ephemeral-tick.js';
import { __resetAdmissionVerdictsForTesting } from '../runners/ephemeral-tick.js';
import { __setAdmissionVerdictsForTesting } from '../runners/ephemeral-tick.js';
import { dispatchEphemeral } from '../runners/ephemeral-tick.js';
import { __setWorkloadGateContextForTesting } from '../runners/ephemeral-shared.js';
import type { EphemeralTickInput } from '../runners/ephemeral-shared.js';
import { __resetWarmReposForTesting } from '../runners/dispatch-warm-cache.js';
import { dispatchWarmCache } from '../runners/dispatch-warm-cache.js';
import { warmReposForPlacement } from '../runners/dispatch-warm-cache.js';
import { warmRunnerName } from '../runners/ephemeral.js';
import { WARM_ASSIGN_WINDOW_MS } from '../runners/ephemeral-warm.js';
import { WARM_CACHE_INTERVAL_MS } from '../runners/warm-backoff.js';
import { workloadGateContext } from '../lib/workload-gate.js';
import { fakeGh } from './helpers/fleet-fakes.js';
import {
	INELIGIBLE_INSTALLED_MB,
	MEASURED,
	NODE_ELIGIBLE,
	NODE_ELIGIBLE_JDK21,
	NODE_INELIGIBLE,
	type NodeSim,
	T0,
	baseInput,
	histAt,
	installWarmCacheRig,
	simShell,
	writeRecord,
} from './helpers/warm-cache-rig.js';

installWarmCacheRig();

// --- the wiring: does the reservation reach admission at all? -----------------
//
// THE FAILURE THIS FILE KEEPS PAYING FOR. P5.1's affinity term shipped and was
// inert for five days and ~2,000 jobs because nothing ever assigned
// `NodeState.warmRepo`; both sides typechecked and every unit test on either
// side of the seam stayed green. A reservation computed in `ephemeral.ts` and
// never handed to `admitMint` would fail in exactly the same way and look
// exactly as correct. So this asserts the NUMBER the dispatch pass is actually
// given, through the `run` seam `dispatchEphemeral` exists to expose.

/** `dispatchEphemeral` with the dispatch pass stubbed — returns what admission
 *  would have been handed for each node. */
async function budgetsFrom(
	input: EphemeralTickInput,
	sims: Record<string, NodeSim> = {}
): Promise<Map<string, number>> {
	const seen = new Map<string, number>();
	const run = (async (passInput: { nodes: { name: string; maxConcurrent: number }[] }) => {
		for (const n of passInput.nodes) seen.set(n.name, n.maxConcurrent);
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: null };
	}) as unknown as Parameters<typeof dispatchEphemeral>[4];
	await dispatchEphemeral(
		input,
		'tok',
		fakeGh({}) as unknown as Parameters<typeof dispatchEphemeral>[2],
		simShell(sims),
		run
	);
	return seen;
}

test('WIRING: the dispatch pass is handed the RESERVED budget, not the declared cap', async () => {
	writeRecord({ runner: 'claw-3', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const budgets = await budgetsFrom(
		baseInput({
			fleetProbe: new Map([
				['claw-3', { reachable: true, busyRepos: null }],
				['claw-2', { reachable: true, busyRepos: null }],
			]),
			ephemeral: new Set(['claw-3', 'claw-2']),
			nodes: {
				'claw-3': { ...NODE_ELIGIBLE, minFreeMb: MEASURED['claw-3'].minFreeMb },
				'claw-2': NODE_INELIGIBLE,
			},
		}),
		{
			'claw-3': {
				marker: null,
				activeUnits: new Set(),
				installedMb: MEASURED['claw-3'].installedMb,
			},
			'claw-2': {
				marker: null,
				activeUnits: new Set(),
				installedMb: INELIGIBLE_INSTALLED_MB,
			},
		}
	);
	// claw-3 may hold a listener, so one of its three slots is not the
	// dispatcher's to spend. This is the whole fix, at the only place it can be
	// inert.
	assert.equal(budgets.get('claw-3'), 2);
	// claw-2 may not hold one, so nothing is held back: a node that cannot carry
	// a listener must not pay for one. Its declared cap of 2 arrives untouched.
	assert.equal(budgets.get('claw-2'), 2);
});

// --- wave 4e follow-up (#102): dispatchEphemeral's OWN two sites ------------
//
// `offerFor` feeds THREE places: the warm mint (tested above, through
// `dispatchWarmCache`), placement's `NodeState.labels`, and the JIT mint's own
// `labelsFor` — both built inside `dispatchEphemeral`, captured here the same
// way `budgetsFrom` captures the reserved budget: stub `run` and read back
// what it was handed.

/** `dispatchEphemeral` with the dispatch pass stubbed — returns the per-node
 *  PLACEMENT labels and the JIT mint's `labelsFor`, both as `run` saw them. */
async function labelsFromDispatchEphemeral(
	input: EphemeralTickInput,
	sims: Record<string, NodeSim> = {}
): Promise<{
	placement: Map<string, readonly string[] | undefined>;
	labelsFor: (node: string) => string[];
}> {
	const placement = new Map<string, readonly string[] | undefined>();
	let capturedLabelsFor: ((node: string) => string[]) | null = null;
	const run = (async (passInput: {
		nodes: { name: string; labels?: readonly string[] }[];
		labelsFor: (node: string) => string[];
	}) => {
		for (const n of passInput.nodes) placement.set(n.name, n.labels);
		capturedLabelsFor = passInput.labelsFor;
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: null };
	}) as unknown as Parameters<typeof dispatchEphemeral>[4];
	await dispatchEphemeral(
		input,
		'tok',
		fakeGh({}) as unknown as Parameters<typeof dispatchEphemeral>[2],
		simShell(sims),
		run
	);
	return { placement, labelsFor: (node: string) => capturedLabelsFor!(node) };
}

test('dispatchEphemeral: placement NodeState.labels AND the JIT mint labelsFor both withhold a gated label', async () => {
	const ctx = workloadGateContext(['claw-1'], {});
	ctx.provenCounts.jdk21 = 2; // ACTIVE fleet-wide
	ctx.byNode['claw-1'].jdk21 = null; // this node has no record of its own
	__setWorkloadGateContextForTesting(ctx);
	const { placement, labelsFor } = await labelsFromDispatchEphemeral(
		baseInput({ nodes: { 'claw-1': NODE_ELIGIBLE_JDK21 } })
	);
	assert.ok(
		!(placement.get('claw-1') ?? []).includes('jdk21'),
		`placement labels must withhold jdk21: ${JSON.stringify(placement.get('claw-1'))}`
	);
	assert.ok(
		!labelsFor('claw-1').includes('jdk21'),
		`the JIT mint's labelsFor must withhold jdk21 too: ${labelsFor('claw-1').join(',')}`
	);
	// And the OTHER, non-gated label is unaffected on both paths.
	assert.ok((placement.get('claw-1') ?? []).includes('hadoku-builder'));
	assert.ok(labelsFor('claw-1').includes('hadoku-builder'));
});

test('dispatchEphemeral: with NO $proof at all (dormant), both label sites still offer jdk21 — unchanged from today', async () => {
	__setWorkloadGateContextForTesting(workloadGateContext(['claw-1'], {}));
	const { placement, labelsFor } = await labelsFromDispatchEphemeral(
		baseInput({ nodes: { 'claw-1': NODE_ELIGIBLE_JDK21 } })
	);
	assert.ok((placement.get('claw-1') ?? []).includes('jdk21'));
	assert.ok(labelsFor('claw-1').includes('jdk21'));
});

test('WIRING: the kill switch does not lift the reservation — it stops maintenance, not listeners', async () => {
	// WARM_CACHE_DISABLED stops the cache being MAINTAINED. It evicts nothing:
	// a listener already registered goes on long-polling and goes on being
	// handed jobs, so the slot it occupies is still occupied. Lifting the
	// reservation here would put the node back over its cap for as long as the
	// switch is on — which is the state an operator reaches for when something
	// is already wrong.
	writeRecord({ runner: 'claw-3', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const prev = process.env.WARM_CACHE_DISABLED;
	process.env.WARM_CACHE_DISABLED = '1';
	try {
		const budgets = await budgetsFrom(
			baseInput({
				fleetProbe: new Map([['claw-3', { reachable: true, busyRepos: null }]]),
				ephemeral: new Set(['claw-3']),
				nodes: { 'claw-3': { ...NODE_ELIGIBLE, minFreeMb: MEASURED['claw-3'].minFreeMb } },
			}),
			{
				'claw-3': {
					marker: null,
					activeUnits: new Set(),
					installedMb: MEASURED['claw-3'].installedMb,
				},
			}
		);
		assert.equal(budgets.get('claw-3'), 2);
	} finally {
		if (prev === undefined) delete process.env.WARM_CACHE_DISABLED;
		else process.env.WARM_CACHE_DISABLED = prev;
	}
});

test('WIRING: the reservation survives a restart — it is measured, not remembered', async () => {
	// `warmRepoByNode` (the affinity map) is empty for the first 60 s after each
	// of mgmt-api's ~5 daily restarts, and its own note says staleness there is
	// safe in ONE direction because affinity only ever PREFERS a node. A
	// reservation read from it would be unsafe in the other: a live listener
	// with no slot held for it, five times a day. This is that case — nothing
	// has been observed yet on this process — and the budget is still 2.
	writeRecord({ runner: 'claw-3', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	__resetWarmReposForTesting();
	const budgets = await budgetsFrom(
		baseInput({
			fleetProbe: new Map([['claw-3', { reachable: true, busyRepos: null }]]),
			ephemeral: new Set(['claw-3']),
			nodes: { 'claw-3': { ...NODE_ELIGIBLE, minFreeMb: MEASURED['claw-3'].minFreeMb } },
		}),
		{
			'claw-3': {
				marker: null,
				activeUnits: new Set(),
				installedMb: MEASURED['claw-3'].installedMb,
			},
		}
	);
	assert.equal(warmReposForPlacement().get('claw-3'), undefined);
	assert.equal(budgets.get('claw-3'), 2);
});

// --- the generic admission verdict (wave 4a §A.1, #100) ----------------------
//
// `dispatchEphemeral` builds each node's `admitMint` input to decide WHERE a
// job should mint; this is the SAME input, read back through
// `admissionVerdictsForReport` for a reader that never gets to ask `admitMint`
// itself — `runner-health.ts`'s starvation check and `routes/fleet.ts`'s panel
// field. claw-6 and claw-2 were refused by the memory clause on every tick for
// days and nothing recorded it; this is that record.

/** `dispatchEphemeral` with the dispatch pass stubbed, returning whatever the
 *  verdict snapshot looks like right after. */
async function verdictsFrom(
	input: EphemeralTickInput,
	sims: Record<string, NodeSim> = {}
): Promise<ReturnType<typeof admissionVerdictsForReport>> {
	const run = (async () => ({
		minted: 0,
		failed: 0,
		skipped: 0,
		inFlight: 0,
		reaped: 0,
	})) as unknown as Parameters<typeof dispatchEphemeral>[4];
	await dispatchEphemeral(
		input,
		'tok',
		fakeGh({}) as unknown as Parameters<typeof dispatchEphemeral>[2],
		simShell(sims),
		run
	);
	return admissionVerdictsForReport();
}

test('WIRING: the display verdict is charged like the dispatcher when its ledger is fresh (2026-10-25)', async () => {
	// claw-1/claw-9 read `at capacity` in GET /fleet while the dispatcher's own
	// ledger charged them under their budget. Same probe both times; only the
	// ledger differs, so this proves ephemeral-tick consults it.
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: null, activeUnits: new Set(), installedMb: 32000 },
	};
	const input = () =>
		baseInput({
			fleetProbe: new Map([['claw-1', { reachable: true, busyRepos: null, workers: 3 }]]),
		});
	__resetCapacityLedgerForTesting();
	const raw = (await verdictsFrom(input(), sims)).get('claw-1');
	assert.equal(raw?.ok, false, 'three workers against a cap of three is at capacity, read raw');
	if (raw && !raw.ok) assert.equal(raw.clause, 'concurrency');
	recordCapacityLedger([
		{
			node: 'claw-1',
			liveUnits: 0,
			probeWorkers: 3,
			standingBusy: 1,
			warmHeld: 0,
			budget: 3,
			inFlight: 1,
		},
	]);
	const charged = (await verdictsFrom(input(), sims)).get('claw-1');
	__resetCapacityLedgerForTesting();
	assert.deepEqual(charged, { ok: true }, 'charged 1 of 3 by the dispatcher, the panel must agree');
});

test('WIRING: a node whose free memory cannot clear its reserve records a MEMORY-refused verdict', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	// 5000 MB installed, minFreeMb 2048 (NODE_ELIGIBLE): `free -m`'s $7 column
	// (simShell's 80% rule) reads 4000 MB available. No `jobP95Mb` and no repo
	// reserve, so the generic check reserves JOB_RESERVE_DEFAULT_MB (4096): 4000
	// − 4096 leaves −96, under the 2048 MB floor. Same shape as claw-6/claw-2's
	// own numbers in the wave 4a writeup, not a copy of them.
	const sims: Record<string, NodeSim> = {
		'claw-6': { marker: null, activeUnits: new Set(), installedMb: 5000 },
	};
	const verdicts = await verdictsFrom(
		baseInput({
			fleetProbe: new Map([['claw-6', { reachable: true, busyRepos: null }]]),
			ephemeral: new Set(['claw-6']),
			nodes: { 'claw-6': NODE_ELIGIBLE },
		}),
		sims
	);
	assert.deepEqual(verdicts.get('claw-6'), {
		ok: false,
		clause: 'memory',
		availableMb: 4000,
		needMb: 4096,
		reserveBasis: 'default',
		reason:
			'memory: 4000MB free, this repo peaks at 4096MB, would leave -96MB against a 2048MB floor',
	});
});

test('WIRING: a node with room to spare records ok:true', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: null, activeUnits: new Set() }, // DEFAULT_INSTALLED_MB, 16 GB-class
	};
	const verdicts = await verdictsFrom(
		baseInput({
			fleetProbe: new Map([['claw-1', { reachable: true, busyRepos: null }]]),
			ephemeral: new Set(['claw-1']),
			nodes: { 'claw-1': NODE_ELIGIBLE },
		}),
		sims
	);
	assert.deepEqual(verdicts.get('claw-1'), { ok: true });
});

test('WIRING: the verdict snapshot is published WHOLESALE, even empty — a node unreachable this pass is absent, never stale', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-6': { marker: null, activeUnits: new Set(), installedMb: 5000 },
	};
	const first = await verdictsFrom(
		baseInput({
			fleetProbe: new Map([['claw-6', { reachable: true, busyRepos: null }]]),
			ephemeral: new Set(['claw-6']),
			nodes: { 'claw-6': NODE_ELIGIBLE },
		}),
		sims
	);
	assert.equal(first.get('claw-6')?.ok, false, 'sanity: the first pass did find a refusal');
	// Second pass: claw-6 is UNREACHABLE now. Nothing was learned about it —
	// this must read as absent ("could not look"), never as the stale refusal
	// from the pass before.
	const second = await verdictsFrom(
		baseInput({
			fleetProbe: new Map([['claw-6', { reachable: false, busyRepos: null }]]),
			ephemeral: new Set(['claw-6']),
			nodes: { 'claw-6': NODE_ELIGIBLE },
		}),
		sims
	);
	assert.equal(second.has('claw-6'), false);
});

// --- the live placement order: speed breaks ties, end to end (wave 3z) ------
//
// `budgetsFrom` above proves a NUMBER reaches admission; this proves the
// ORDER reaches it, through the exact seam the live call site
// (`ephemeral-tick.ts`'s `speedFactor: speedModel.factorOf?.(m2.name) ?? null`
// in the `trafficNodes` map) feeds `orderCandidates`. A unit test on
// `orderCandidates` alone cannot see that call site go dark — only a test that
// drives `dispatchEphemeral` end to end, through the real speed model built
// from real job history, can.

/** `dispatchEphemeral` with the dispatch pass stubbed — returns the placement
 *  ORDER the pass was actually handed (`passInput.order`, `orderCandidates`'s
 *  live output), the counterpart to `budgetsFrom`'s per-node numbers above. */
async function orderFrom(
	input: EphemeralTickInput,
	sims: Record<string, NodeSim> = {}
): Promise<string[]> {
	let order: string[] = [];
	const run = (async (passInput: { order: string[] }) => {
		order = passInput.order;
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: null };
	}) as unknown as Parameters<typeof dispatchEphemeral>[4];
	await dispatchEphemeral(
		input,
		'tok',
		fakeGh({}) as unknown as Parameters<typeof dispatchEphemeral>[2],
		simShell(sims),
		run
	);
	return order;
}

test('WIRING: the live placement order prefers the MEASURED faster node — equal busy, equal idle (wave 3z, #83 continuous sibling)', async () => {
	const FAST = 'claw-8';
	const SLOW = 'claw-3';
	const FAST_SEC = 60;
	const SLOW_SEC = 180; // 3x slower: clear of SLOW_P25 and of rounding noise.

	// MIN_KINDS (5) distinct (repo, job) kinds, MIN_SAMPLES (5) each side, so
	// neither node is 'unknown' — factorOf must read a real measured number for
	// both. Each kind's pair of records is timed so BOTH nodes' job in that
	// kind ends at the EXACT SAME instant: equal idleSeconds is the point of
	// this fixture, not an accident of whatever timings were convenient. With
	// busy and idle genuinely tied, only the speed step can decide the order.
	for (let kind = 0; kind < 5; kind++) {
		const baseSec = kind * 1000;
		for (let sample = 0; sample < 5; sample++) {
			writeRecord({
				runner: FAST,
				name: `kind-${kind}`,
				startedAt: histAt(baseSec),
				durationSec: FAST_SEC,
				runSec: FAST_SEC,
			});
			writeRecord({
				runner: SLOW,
				name: `kind-${kind}`,
				// Ends at baseSec + FAST_SEC, same instant as FAST's record above.
				startedAt: histAt(baseSec + FAST_SEC - SLOW_SEC),
				durationSec: SLOW_SEC,
				runSec: SLOW_SEC,
			});
		}
	}

	const sims: Record<string, NodeSim> = {
		[FAST]: { marker: null, activeUnits: new Set(), installedMb: MEASURED[FAST].installedMb },
		[SLOW]: { marker: null, activeUnits: new Set(), installedMb: MEASURED[SLOW].installedMb },
	};
	const order = await orderFrom(
		baseInput({
			fleetProbe: new Map([
				[FAST, { reachable: true, busyRepos: null }],
				[SLOW, { reachable: true, busyRepos: null }],
			]),
			ephemeral: new Set([FAST, SLOW]),
			nodes: {
				[FAST]: { ...NODE_ELIGIBLE, minFreeMb: MEASURED[FAST].minFreeMb },
				[SLOW]: { ...NODE_ELIGIBLE, minFreeMb: MEASURED[SLOW].minFreeMb },
			},
		}),
		sims
	);
	assert.deepEqual(
		order,
		[FAST, SLOW],
		`measured-faster ${FAST} must be placed ahead of measured-slower ${SLOW} when both are equally idle and equally busy`
	);
});

// --- #101: space admission on the warm path, from its OWN measurement ------

test('dispatchWarmCache (c1a): an idle warm listener on a node at 300MB /tmp free is evicted, never re-filled; a listener-less node at 300MB is never filled either', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	writeRecord({ runner: 'claw-2', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const nowMs = 1_000_000 + WARM_ASSIGN_WINDOW_MS + 1;
	const sims: Record<string, NodeSim> = {
		'claw-1': {
			marker: 'WolffM/hadoku_site 1000',
			activeUnits: new Set([unit]),
			tmpFreeMb: 300,
		},
		'claw-2': { marker: null, activeUnits: new Set(), tmpFreeMb: 300 },
	};
	const sh = simShell(sims);
	const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: false }] });
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, nowMs);
	assert.equal(res.evicted, 1, 'the out-of-/tmp node must lose its listener');
	assert.equal(sims['claw-1'].marker, null, 'and never be re-filled onto it the same pass');
	assert.equal(
		sims['claw-2'].marker,
		null,
		'a listener-less node at 300MB /tmp free is never filled'
	);

	// Second pass at the same free-space reading: still not re-filled.
	await dispatchWarmCache(baseInput(), 'tok', gh, sh, nowMs + WARM_CACHE_INTERVAL_MS);
	assert.equal(sims['claw-1'].marker, null, 'still refused a second pass while still at 300MB');
});

test('dispatchWarmCache (c1b): a listener-less node at 3000MB /tmp free does fill', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: null, activeUnits: new Set(), tmpFreeMb: 3000 },
	};
	const res = await dispatchWarmCache(baseInput(), 'tok', fakeGh({}), simShell(sims), T0);
	assert.equal(res.filled, 1);
	assert.equal(sims['claw-1'].marker, 'WolffM/hadoku_site 1000');
});

test("dispatchWarmCache (c2): a STALE non-space (or absent) dispatch-tick verdict must not mask this pass's OWN space measurement", async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const nowMs = 1_000_000 + WARM_ASSIGN_WINDOW_MS + 1;
	const sims: Record<string, NodeSim> = {
		'claw-1': {
			marker: 'WolffM/hadoku_site 1000',
			activeUnits: new Set([unit]),
			tmpFreeMb: 300,
		},
	};
	// Before this lane's fix, the warm path read THIS map instead of its own
	// probe — a `memory`-refused (or simply absent/ok) verdict here would have
	// masked the space refusal and left the listener in place. Injected
	// directly so the test cannot be satisfied by the warm pass happening to
	// agree with a verdict it was never supposed to consult.
	__setAdmissionVerdictsForTesting(
		new Map([
			[
				'claw-1',
				{
					ok: false,
					clause: 'memory',
					availableMb: 100,
					needMb: 4096,
					reserveBasis: 'default',
					reason:
						'memory: 100MB free, this repo peaks at 4096MB, would leave -3996MB against a 2048MB floor',
				},
			],
		])
	);
	try {
		const sh = simShell(sims);
		const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: false }] });
		const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, nowMs);
		assert.equal(
			res.evicted,
			1,
			"the warm pass's own 300MB /tmp measurement must evict regardless of the stale memory verdict"
		);
		assert.equal(sims['claw-1'].marker, null);
	} finally {
		__resetAdmissionVerdictsForTesting();
	}
});

test('dispatchWarmCache (c3): an unreadable /tmp df refuses exactly like below-floor — evicted, never filled', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	writeRecord({ runner: 'claw-2', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const nowMs = 1_000_000 + WARM_ASSIGN_WINDOW_MS + 1;
	const sims: Record<string, NodeSim> = {
		'claw-1': {
			marker: 'WolffM/hadoku_site 1000',
			activeUnits: new Set([unit]),
			dfUnreadable: 'tmp',
		},
		'claw-2': { marker: null, activeUnits: new Set(), dfUnreadable: 'tmp' },
	};
	const sh = simShell(sims);
	const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: false }] });
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, nowMs);
	assert.equal(res.evicted, 1, 'unreadable /tmp must refuse, never admit on a guess');
	assert.equal(sims['claw-1'].marker, null);
	assert.equal(
		sims['claw-2'].marker,
		null,
		'a listener-less node with unreadable /tmp is never filled'
	);
});

test('dispatchWarmCache (c4): an unreadable or below-floor ~/.hadoku/jit (_work) df refuses the same way', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	writeRecord({ runner: 'claw-2', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const nowMs = 1_000_000 + WARM_ASSIGN_WINDOW_MS + 1;
	const sims: Record<string, NodeSim> = {
		'claw-1': {
			marker: 'WolffM/hadoku_site 1000',
			activeUnits: new Set([unit]),
			workFreeMb: 300,
		},
		'claw-2': { marker: null, activeUnits: new Set(), dfUnreadable: 'work' },
	};
	const sh = simShell(sims);
	const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: false }] });
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, nowMs);
	assert.equal(res.evicted, 1, 'below-floor _work must refuse');
	assert.equal(sims['claw-1'].marker, null);
	assert.equal(
		sims['claw-2'].marker,
		null,
		'unreadable _work must also refuse a listener-less node'
	);
});

test('WIRING (b): a node whose /tmp df is unreadable records a SPACE/unreadable verdict and is not minted on while another node is', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-6': { marker: null, activeUnits: new Set(), dfUnreadable: 'tmp' },
	};
	const verdicts = await verdictsFrom(
		baseInput({
			fleetProbe: new Map([['claw-6', { reachable: true, busyRepos: null }]]),
			ephemeral: new Set(['claw-6']),
			nodes: { 'claw-6': NODE_ELIGIBLE },
		}),
		sims
	);
	const v = verdicts.get('claw-6');
	assert.equal(v?.ok, false);
	if (v && !v.ok) {
		assert.equal(v.clause, 'space');
		assert.equal(v.unreadable, true);
		assert.match(v.reason, /could not read \/tmp free space/);
	}
});

test('WIRING pin: a sim returning ONLY the free -m line (no df lines at all) yields a space refusal, never an admit — the live tick must never leave the fields undefined', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = { 'claw-6': { marker: null, activeUnits: new Set() } };
	const inner = simShell(sims);
	// A deliberately broken probe: answers `free -m` but strips every `df` line
	// off the reply, reproducing a node/transport that cannot run the combined
	// command — the exact shape this pin exists to guard against ever reading
	// as "admitted" rather than "could not look".
	const sh = async (n: string, c: string): Promise<string | null> => {
		const out = await inner(n, c);
		if (c.includes('free -m') && c.includes('df -Pm')) {
			return String(out ?? '').split('\n')[0] ?? null;
		}
		return out;
	};
	// `verdictsFrom` uses its own `simShell(sims)` internally and cannot take a
	// custom `sh` — call `dispatchEphemeral` directly so the stripped probe
	// actually reaches it.
	const run = (async () => ({
		minted: 0,
		failed: 0,
		skipped: 0,
		inFlight: 0,
		reaped: 0,
	})) as unknown as Parameters<typeof dispatchEphemeral>[4];
	await dispatchEphemeral(
		baseInput({
			fleetProbe: new Map([['claw-6', { reachable: true, busyRepos: null }]]),
			ephemeral: new Set(['claw-6']),
			nodes: { 'claw-6': NODE_ELIGIBLE },
		}),
		'tok',
		fakeGh({}) as unknown as Parameters<typeof dispatchEphemeral>[2],
		sh,
		run
	);
	const v = admissionVerdictsForReport().get('claw-6');
	assert.equal(v?.ok, false, 'a probe with no df lines must never be read as admitted');
	if (v && !v.ok) {
		assert.equal(v.clause, 'space');
		assert.equal(v.unreadable, true, 'a stripped df line is unreadable, not a measured zero');
	}
});
