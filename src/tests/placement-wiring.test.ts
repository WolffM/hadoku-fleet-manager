/**
 * Tests for the warm-affinity term actually being WIRED into the real
 * dispatch pipeline (`dispatchEphemeral -> runDispatchPass -> planTick ->
 * choosePlacement`), plus the fleet half that sources `NodeState.warmRepo`
 * from GitHub's own listing via `dispatchWarmCache`: a unit test of a pure
 * function cannot catch either kind of wiring bug, by construction — the
 * thing that was missing was the CALL, not the callee. Split out of
 * placement.test.ts (wave 5o lane B) — see `src/tests/helpers/placement-rig.ts`
 * for the shared `m()`/`ORDER`/`WIRE_NODE`/`NodeSim`/`simShell`/`mintedOn`
 * fixture and the per-test temp dir + cache resets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planTick } from '../runners/dispatcher.js';
import type { PendingRun } from '../runners/dispatcher.js';
import { dispatchEphemeral } from '../runners/ephemeral-tick.js';
import type { EphemeralTickInput } from '../runners/ephemeral-shared.js';
import {
	__resetWarmCacheClockForTesting,
	dispatchWarmCache,
} from '../runners/dispatch-warm-cache.js';
import { warmReposForPlacement } from '../runners/dispatch-warm-cache-state.js';
import { runDispatchPass } from '../runners/dispatch-pass.js';
import { warmRunnerName } from '../lib/jit-naming.js';
import { fakeGh } from './helpers/fleet-fakes.js';
import {
	m,
	ORDER,
	WIRE_NODE,
	type NodeSim,
	simShell,
	mintedOn,
	installPlacementRig,
} from './helpers/placement-rig.js';

installPlacementRig();

// ---------------------------------------------------------------------------
// WS-W: the affinity term is WIRED — the two arguments nothing supplied
// ---------------------------------------------------------------------------
//
// Every test above this line calls `choosePlacement` directly and passes `repo`
// itself, so all twelve of them passed for five days and ~2,000 jobs while the
// feature was dead in production: `a6a19a4` shipped the term as an optional
// parameter, `dispatcher.ts` never passed it, and nothing anywhere assigned
// `NodeState.warmRepo` (`warm-affinity-measured-2026-09-14.md` §3, falsified in
// source AND in the deployed 0.22.108, five exit-1 greps).
//
// A unit test of a pure function cannot catch that, by construction — the thing
// that was missing was the CALL, not the callee. So these tests run the real
// call chain and assert on where a job actually lands:
//
//   dispatchEphemeral -> runDispatchPass -> planTick -> choosePlacement
//
// with only GitHub and the shell faked, at the seams the rest of this
// workstream fakes. Remove either half of the wiring and they go red; that is
// the whole reason they exist, and the mutation counts are recorded in
// `docs/planning/warm-affinity-measured-2-2026-09-15.md` §4.

const WIRE_REPO = 'WolffM/hadoku_site';
const OTHER_REPO = 'WolffM/hadoku-pygmalion';
const FLEET_LABELS = ['self-hosted', 'hadoku-builder'];

/**
 * A first-party queued job, the shape `planTick` admits past `isForkSafe`.
 *
 * `labels: []` by default so the label filter is out of the way: these tests
 * are about the affinity ORDER, and the bare `m()` node above carries no
 * declared labels. The end-to-end tests pass `FLEET_LABELS` explicitly, where
 * the node offer is derived from a manifest that does carry them.
 */
const pending = (over: Partial<PendingRun> & { repo: string }): PendingRun => ({
	id: 9001,
	jobId: 77,
	labels: [],
	repository: { full_name: over.repo },
	head_repository: { full_name: over.repo, fork: false },
	event: 'push',
	...over,
});

const NO_INFLIGHT = { jobIds: new Set<number>(), runIds: new Set<number>() };

test('WIRING: the live mint path supplies the queued run’s repo to the affinity term', () => {
	// THE MUTATION TARGET FOR `dispatcher.ts`. claw-3 is LAST in the walk and
	// holds the warm listener this job wants; claw-2 is first and has room, so
	// it is what an unwired `choosePlacement(order, eligible, labels)` picks —
	// which is exactly what the fleet did on every dispatch until 2026-09-15.
	const nodes = [m('claw-2'), m('claw-1'), m('claw-3', { warmRepo: WIRE_REPO }), m('hokon')];
	const plan = planTick([pending({ repo: WIRE_REPO })], nodes, ORDER, NO_INFLIGHT, 1_700_000_000);
	assert.equal(plan.mint.length, 1);
	assert.equal(
		plan.mint[0].node,
		'claw-3',
		'drop the 4th argument in dispatcher.ts and this is claw-2 — the inert behaviour'
	);
	assert.deepEqual(plan.skipped, []);
});

test('WIRING: affinity is resolved PER RUN, not once per tick', () => {
	// One tick, two repos, two different warm nodes. A wiring that hoisted the
	// repo out of the loop (or took it from the first run) would land both on
	// the same node and still pass the single-run test above.
	const nodes = [
		m('claw-2'),
		m('claw-1', { warmRepo: OTHER_REPO }),
		m('claw-3', { warmRepo: WIRE_REPO }),
	];
	const plan = planTick(
		[pending({ id: 1, jobId: 1, repo: WIRE_REPO }), pending({ id: 2, jobId: 2, repo: OTHER_REPO })],
		nodes,
		ORDER,
		NO_INFLIGHT,
		1_700_000_000
	);
	assert.deepEqual(
		plan.mint.map((x) => `${x.repo}->${x.node}`),
		[`${WIRE_REPO}->claw-3`, `${OTHER_REPO}->claw-1`]
	);
});

test('WIRING: a repo no node is warm for is placed exactly as it was before P5.1', () => {
	// The other half of "purely additive". Supplying `repo` must not perturb a
	// fleet where nothing is warm — the burst that regressed here would be
	// invisible in the affinity tests, which all have a warm node by design.
	const nodes = ORDER.map((n) => m(n));
	const plan = planTick([pending({ repo: WIRE_REPO })], nodes, ORDER, NO_INFLIGHT, 1_700_000_000);
	assert.equal(plan.mint[0].node, 'claw-2');
});

// --- the fleet half: NodeState.warmRepo, sourced from GitHub's listing -------

/** claw-3 holds a warm listener for `repo`; claw-2 holds nothing. */
function fleetWithWarmClaw3(repo: string): Record<string, NodeSim> {
	return {
		'claw-2': { marker: null, active: new Set() },
		'claw-3': { marker: `${repo} 1000`, active: new Set([warmRunnerName('claw-3', repo)]) },
	};
}

function wireInput(): EphemeralTickInput {
	return {
		fleetProbe: new Map([
			['claw-2', { reachable: true, busyRepos: null }],
			['claw-3', { reachable: true, busyRepos: null }],
		]),
		// Equal load and no job history, so the order falls back to the node
		// NAME: claw-2 is tried first and claw-3 only by affinity.
		ephemeral: new Set(['claw-2', 'claw-3']),
		nodes: { 'claw-2': WIRE_NODE, 'claw-3': WIRE_NODE },
		isSick: () => false,
		repos: [WIRE_REPO],
		// Nothing standing can take the job — the all-JIT fleet's normal state,
		// and it removes the age gate so the pass does not depend on wall-clock.
		standingEligible: new Set(),
	};
}

test('WIRING: the warm tick publishes a slot GitHub reports ONLINE', async () => {
	const sims = fleetWithWarmClaw3(WIRE_REPO);
	const gh = fakeGh({
		runners: [{ id: 1, name: warmRunnerName('claw-3', WIRE_REPO), status: 'online', busy: false }],
	});
	await dispatchWarmCache(wireInput(), 'tok', gh, simShell(sims));
	assert.deepEqual([...warmReposForPlacement()], [['claw-3', WIRE_REPO]]);
});

test('WIRING: an OFFLINE registration publishes nothing — issue #17, from the listing', async () => {
	// The marker names the repo and systemd says the unit is active, so BOTH of
	// the node-local facts agree. GitHub says the registration is offline, and
	// that is the one that decides: a listener GitHub will not assign to is not
	// warm, whatever the box believes about itself.
	const sims = fleetWithWarmClaw3(WIRE_REPO);
	const gh = fakeGh({
		runners: [{ id: 1, name: warmRunnerName('claw-3', WIRE_REPO), status: 'offline', busy: false }],
	});
	await dispatchWarmCache(wireInput(), 'tok', gh, simShell(sims));
	assert.equal(warmReposForPlacement().size, 0);
});

test('WIRING: a registration absent from the listing publishes nothing', async () => {
	// "I could not look" and "it is gone" are the same answer here, and it is
	// the fall-through one: no affinity, never a refusal.
	const sims = fleetWithWarmClaw3(WIRE_REPO);
	await dispatchWarmCache(wireInput(), 'tok', fakeGh({}), simShell(sims));
	assert.equal(warmReposForPlacement().size, 0);
});

test('WIRING: the observation is replaced WHOLESALE — a node that loses its listener stops winning', async () => {
	const sims = fleetWithWarmClaw3(WIRE_REPO);
	const unit = warmRunnerName('claw-3', WIRE_REPO);
	const sh = simShell(sims);
	await dispatchWarmCache(wireInput(), 'tok', fakeGh({ runners: [{ id: 1, name: unit }] }), sh);
	assert.equal(warmReposForPlacement().get('claw-3'), WIRE_REPO);

	// The listener dies. Same marker, same everything the node writes down.
	sims['claw-3'].active.delete(unit);
	__resetWarmCacheClockForTesting();
	await dispatchWarmCache(wireInput(), 'tok', fakeGh({ runners: [{ id: 1, name: unit }] }), sh);
	assert.equal(warmReposForPlacement().size, 0, 'the previous pass must not survive this one');
});

test('WIRING: end to end — a job lands on the warm claw, through production’s own glue', async () => {
	// THE PROOF, AND THE MUTATION TARGET FOR BOTH HALVES. Nothing between
	// `dispatchEphemeral` and the mint is substituted except GitHub and the
	// shell: the real warm tick sources `warmRepo` off the real listing, the
	// real `runDispatchPass` calls the real `planTick`, and the real
	// `choosePlacement` decides. claw-2 is first in the walk and has room —
	// which is where this job went on every dispatch the fleet made between
	// 2026-09-09 and this change.
	const sims = fleetWithWarmClaw3(WIRE_REPO);
	const gh = fakeGh({
		runners: [{ id: 1, name: warmRunnerName('claw-3', WIRE_REPO), status: 'online', busy: false }],
	});
	const res = await dispatchEphemeral(
		wireInput(),
		'tok',
		gh,
		simShell(sims),
		async (inp, token, g, s) =>
			runDispatchPass(
				{ ...inp, pending: [pending({ repo: WIRE_REPO, labels: FLEET_LABELS })], tarballUrl: null },
				token,
				g,
				s
			)
	);
	assert.equal(res?.minted, 1, 'one queued job, one mint');
	assert.equal(res?.skipped, 0);
	assert.deepEqual(mintedOn, ['claw-3'], 'the warm claw, not the first node in the walk');
});

test('WIRING: end to end — the SAME fleet with no warm listener mints on the first node', async () => {
	// The control arm. Identical input but for the marker, so a failure of the
	// test above cannot be waved off as "the fixture only ever picks claw-3".
	const sims: Record<string, NodeSim> = {
		'claw-2': { marker: null, active: new Set() },
		'claw-3': { marker: null, active: new Set() },
	};
	const res = await dispatchEphemeral(
		wireInput(),
		'tok',
		fakeGh({}),
		simShell(sims),
		async (inp, token, g, s) =>
			runDispatchPass(
				{ ...inp, pending: [pending({ repo: WIRE_REPO, labels: FLEET_LABELS })], tarballUrl: null },
				token,
				g,
				s
			)
	);
	assert.equal(res?.minted, 1);
	assert.deepEqual(mintedOn, ['claw-2']);
});

test('WIRING: the manifest’s excludeRepos refuses the JIT mint path too, not just the reconciler (#82)', async () => {
	// claw-3 is warm for WIRE_REPO — the exact fixture the test above proves
	// mints there WITHOUT an exclusion. Adding `excludeRepos` for the SAME repo
	// on the SAME node is the only difference; if the mint path ignored it (as
	// it did before this wave — `ephemeral-tick.ts` hardcoded `eligible: true`),
	// this would still land on claw-3.
	const sims = fleetWithWarmClaw3(WIRE_REPO);
	const gh = fakeGh({
		runners: [{ id: 1, name: warmRunnerName('claw-3', WIRE_REPO), status: 'online', busy: false }],
	});
	const input: EphemeralTickInput = {
		...wireInput(),
		nodes: {
			'claw-2': WIRE_NODE,
			'claw-3': { ...WIRE_NODE, excludeRepos: { [WIRE_REPO]: 'wave 3w test: excluded on claw-3' } },
		},
	};
	const res = await dispatchEphemeral(input, 'tok', gh, simShell(sims), async (inp, token, g, s) =>
		runDispatchPass(
			{ ...inp, pending: [pending({ repo: WIRE_REPO, labels: FLEET_LABELS })], tarballUrl: null },
			token,
			g,
			s
		)
	);
	assert.equal(
		res?.minted,
		1,
		'the job still places somewhere — an exclusion is not a universal refusal'
	);
	assert.deepEqual(
		mintedOn,
		['claw-2'],
		'claw-3 is warm for this repo and would otherwise win the walk — the manifest exclusion is what pushes it to claw-2'
	);
});

test('WIRING: the SAME exclusion leaves a DIFFERENT repo on that node unaffected', async () => {
	// The inverse fixture: claw-3 is warm for OTHER_REPO this time, and its
	// manifest entry excludes WIRE_REPO only. OTHER_REPO must still land on
	// claw-3 via its own warm listener — the exclusion naming WIRE_REPO must
	// not leak onto a repo it never mentioned.
	const sims = fleetWithWarmClaw3(OTHER_REPO);
	const gh = fakeGh({
		runners: [{ id: 1, name: warmRunnerName('claw-3', OTHER_REPO), status: 'online', busy: false }],
	});
	const input: EphemeralTickInput = {
		...wireInput(),
		repos: [OTHER_REPO],
		nodes: {
			'claw-2': WIRE_NODE,
			'claw-3': { ...WIRE_NODE, excludeRepos: { [WIRE_REPO]: 'excluded here only' } },
		},
	};
	const res = await dispatchEphemeral(input, 'tok', gh, simShell(sims), async (inp, token, g, s) =>
		runDispatchPass(
			{ ...inp, pending: [pending({ repo: OTHER_REPO, labels: FLEET_LABELS })], tarballUrl: null },
			token,
			g,
			s
		)
	);
	assert.equal(res?.minted, 1);
	assert.deepEqual(
		mintedOn,
		['claw-3'],
		'claw-3 excludes WIRE_REPO only — OTHER_REPO still lands here through its own warm listener'
	);
});
