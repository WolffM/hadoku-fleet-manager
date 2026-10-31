/**
 * Tests for `runners/placement.ts`'s #102 heavy-kind handling: a light job
 * ranks a node already running a heavy job last, a heavy job itself competes
 * on busy alone (it is never protected from its own kind), and the heavy
 * hold that makes a heavy job wait for an empty claw rather than double up —
 * up to `HEAVY_HOLD_SEC`, past which it places rather than queuing forever.
 * The last test goes through the real `dispatchEphemeral` -> `runDispatchPass`
 * seam rather than a hand-built `NodeState`, so a regression in how
 * `standingBusy` is actually computed from the fleet probe fails it even
 * though every `choosePlacement`-level test above still passes. Split out of
 * placement.test.ts (wave 5o lane B) — see `src/tests/helpers/placement-rig.ts`
 * for the shared `m()`/`ORDER`/`WIRE_NODE`/`simShell`/`mintedOn` fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { choosePlacement, HEAVY_HOLD_SEC } from '../runners/placement.js';
import type { HeavyModel } from '../runners/traffic.js';
import type { PendingRun } from '../runners/dispatcher.js';
import { dispatchEphemeral } from '../runners/ephemeral-tick.js';
import type { EphemeralTickInput } from '../runners/ephemeral-shared.js';
import { runDispatchPass } from '../runners/dispatch-pass.js';
import { fakeGh } from './helpers/fleet-fakes.js';
import {
	m,
	ORDER,
	WIRE_NODE,
	simShell,
	mintedOn,
	installPlacementRig,
} from './helpers/placement-rig.js';

installPlacementRig();

// ---------------------------------------------------------------------------
// #102: heavy kinds want an empty claw
// ---------------------------------------------------------------------------

const HEAVY_REPO = 'WolffM/hadoku-cardtable';

/** A minimal `HeavyModel` fixture — `isHeavy` by exact (repo, job) kind when
 *  named, `isHeavyRepo` as the repo-level fallback `choosePlacement` itself
 *  never calls directly (that fallback is only ever exercised through
 *  `ephemeral-tick.ts`'s `NodeState.runningHeavy`, set from THIS repo-level
 *  method against a RUNNING worker whose job name the probe cannot see). */
function fakeHeavyModel(heavyKinds: Set<string>, heavyRepos: Set<string>): HeavyModel {
	return {
		isHeavy: (repo, jobName) =>
			jobName !== undefined ? heavyKinds.has(`${repo}\u0000${jobName}`) : heavyRepos.has(repo),
		isHeavyRepo: (repo) => heavyRepos.has(repo),
	};
}

test('#102.4: a LIGHT job ranks a node running a heavy job last, among equally busy nodes', () => {
	const heavyModel = fakeHeavyModel(
		new Set([`${HEAVY_REPO}\u0000forge-e2e`]),
		new Set([HEAVY_REPO])
	);
	// Both idle (busy 0) — the ONLY thing distinguishing them is that claw-2 is
	// ALREADY running a heavy-kind job. The order lists the heavy-busy node
	// FIRST, so this fails under plain position/name tie-break too.
	const runningHeavy = m('claw-2', { runningHeavy: true, heavyModel });
	const quiet = m('claw-1', { heavyModel });
	const p = choosePlacement(['claw-2', 'claw-1'], [runningHeavy, quiet], [], 'WolffM/hadoku_site', {
		jobName: 'build',
	});
	assert.equal(p.node, 'claw-1');
	assert.equal(p.heavy, false, 'the QUEUED job itself — a plain hadoku_site build — is not heavy');
});

test('#102.4: a HEAVY job is unaffected by the heavy-avoidance term — it still competes on busy alone', () => {
	// The avoidance term exists so a LIGHT job does not land beside a heavy
	// one; a heavy job does not need protecting from itself, and must still
	// place on the node already running one when nothing else exists.
	const heavyModel = fakeHeavyModel(
		new Set([`${HEAVY_REPO}\u0000forge-e2e`]),
		new Set([HEAVY_REPO])
	);
	const node = m('claw-9', { runningHeavy: true, heavyModel });
	const p = choosePlacement(['claw-9'], [node], [], HEAVY_REPO, { jobName: 'forge-e2e' });
	assert.equal(p.node, 'claw-9', 'a heavy job still places — never queues forever (#102.4)');
	assert.equal(p.heavy, true);
});

test('#102.4: a heavy job skips a busy node when an idle one exists, and the busy node is never even tried', () => {
	const heavyModel = fakeHeavyModel(
		new Set([`${HEAVY_REPO}\u0000forge-e2e`]),
		new Set([HEAVY_REPO])
	);
	const busy = m('claw-2', { liveUnits: 1, maxConcurrent: 4, heavyModel });
	const idle = m('claw-1', { heavyModel });
	const p = choosePlacement(ORDER, [busy, idle], [], HEAVY_REPO, { jobName: 'forge-e2e' });
	assert.equal(p.node, 'claw-1');
	assert.deepEqual(
		p.passed,
		[],
		'the busier node is ranked after the idle one, not tried and refused'
	);
});

test('#102: `Placement.heavy` is `false` whenever no node carries a `heavyModel` — every caller before this wave', () => {
	const p = choosePlacement(ORDER, [m('claw-2'), m('claw-1')], [], HEAVY_REPO, {
		jobName: 'forge-e2e',
	});
	assert.equal(p.heavy, false);
});

// --- #102: a heavy job holds out for a node with no heavy job --------------

const FORGE = fakeHeavyModel(
	new Set([`${HEAVY_REPO}\u0000forge-e2e`, `${HEAVY_REPO}\u0000forge-jvm`]),
	new Set([HEAVY_REPO])
);

test('#102 heavy hold: a heavy job refuses a node running a heavy job inside the hold, and says why', () => {
	const p = choosePlacement(
		['claw-4'],
		[m('claw-4', { heavyJobs: 1, heavyModel: FORGE })],
		[],
		HEAVY_REPO,
		{
			jobName: 'forge-e2e',
			queuedSec: 30,
		}
	);
	assert.equal(p.node, undefined, 'held, not doubled');
	assert.deepEqual(p.passed, [
		{
			node: 'claw-4',
			reason: `heavy hold: already running 1 heavy job(s) (queued 30s < ${HEAVY_HOLD_SEC}s)`,
			// A clock lifts this one, so it says when (#117's probe backoff reads it).
			holdSec: HEAVY_HOLD_SEC,
		},
	]);
});

test('#102 heavy hold: an unknown queue age holds — it is never "waited long enough"', () => {
	const p = choosePlacement(
		['claw-4'],
		[m('claw-4', { heavyJobs: 1, heavyModel: FORGE })],
		[],
		HEAVY_REPO,
		{
			jobName: 'forge-e2e',
		}
	);
	assert.equal(p.node, undefined);
	assert.match(p.passed[0].reason, /queued unknown/);
});

test('#102 heavy hold: past HEAVY_HOLD_SEC the job places doubled rather than queue forever', () => {
	const p = choosePlacement(
		['claw-4'],
		[m('claw-4', { heavyJobs: 1, heavyModel: FORGE })],
		[],
		HEAVY_REPO,
		{
			jobName: 'forge-e2e',
			queuedSec: HEAVY_HOLD_SEC,
		}
	);
	assert.equal(p.node, 'claw-4');
});

test('#102 heavy hold: a LIGHT job is never held by heavyJobs — only ranked by runningHeavy', () => {
	const p = choosePlacement(
		['claw-4'],
		[m('claw-4', { heavyJobs: 2, runningHeavy: true, heavyModel: FORGE })],
		[],
		HEAVY_REPO,
		{
			jobName: 'check',
			queuedSec: 0,
		}
	);
	assert.equal(p.node, 'claw-4');
});

test('#102 heavy hold: repo-level runningHeavy alone does not hold — a light cardtable check is not a Forge shard', () => {
	// claw-8 at 22:08Z: running cardtable `check`, which reads runningHeavy
	// (repo-level) but is not a heavy KIND. Holding on that would have kept a
	// shard off the one jdk21 node doing nothing heavy.
	const p = choosePlacement(
		['claw-8'],
		[m('claw-8', { standingBusy: 1, runningHeavy: true, heavyModel: FORGE })],
		[],
		HEAVY_REPO,
		{
			jobName: 'forge-e2e',
			queuedSec: 0,
		}
	);
	assert.equal(p.node, 'claw-8');
});

test('#102 heavy hold: a heavy job ranks fewest heavy jobs ahead of fewest busy, once the hold has expired', () => {
	// claw-4: one Forge shard. claw-8: two light jobs. Busy alone picks claw-4.
	const p = choosePlacement(
		['claw-4', 'claw-8'],
		[
			m('claw-4', { standingBusy: 1, heavyJobs: 1, heavyModel: FORGE }),
			m('claw-8', { standingBusy: 2, maxConcurrent: 4, heavyModel: FORGE }),
		],
		[],
		HEAVY_REPO,
		{ jobName: 'forge-jvm', queuedSec: HEAVY_HOLD_SEC + 1 }
	);
	assert.equal(p.node, 'claw-8');
	assert.deepEqual(p.passed, [], 'ranked past, not tried and refused');
});

test('#102.1 PRODUCTION SHAPE: `dispatchEphemeral`’s OWN probe-to-NodeState seam reads busy as jobs, not distinct repos', async () => {
	// Every other #102 test here hand-builds a `NodeState` with `standingBusy`
	// already set — none of them exercise the ACTUAL seam that computes it
	// from the fleet probe (`ephemeral-tick.ts`'s `standingBusy: p.workers ?? …`).
	// This one goes through the real `dispatchEphemeral`, so a regression there
	// — e.g. reverting to the pre-#102 `[...busyRepos.values()].filter(n>0).length`
	// — fails THIS test even though every `choosePlacement`-level test above
	// still passes (they all construct `NodeState.standingBusy` directly).
	//
	// claw-1: THREE running cardtable workers, in ONE repo — the exact #102
	// incident ("three Forge jobs stacked on one claw"). Pre-fix: one busy
	// repo with n>0 reads `standingBusy: 1`. Fixed: `p.workers` reads 3.
	//
	// claw-9: ONE running worker, attributed across TWO repo keys in
	// `busyRepos` (one of them idle) — proves the fix is not ALSO still
	// secretly keyed on the repo map's shape: whatever `busyRepos` looks like,
	// `workers` is the number that counts.
	//
	// NAMED SO THE PRE-FIX TIE PICKS THE WRONG ONE: both nodes read
	// `standingBusy: 1` under the REVERTED formula (one non-idle repo each),
	// and `orderCandidates`'s own tie-break is the node NAME — 'claw-1' sorts
	// before 'claw-9', so a reverted fix would (wrongly) prefer the node
	// actually running THREE jobs. The fix tells them apart on the real count
	// (3 vs 1) before name ever matters, and picks claw-9.
	const input: EphemeralTickInput = {
		fleetProbe: new Map([
			['claw-1', { reachable: true, workers: 3, busyRepos: new Map([[HEAVY_REPO, 3]]) }],
			[
				'claw-9',
				{
					reachable: true,
					workers: 1,
					busyRepos: new Map([
						['WolffM/some-other-repo', 1],
						['WolffM/yet-another-repo', 0],
					]),
				},
			],
		]),
		ephemeral: new Set(['claw-1', 'claw-9']),
		nodes: { 'claw-1': WIRE_NODE, 'claw-9': WIRE_NODE },
		isSick: () => false,
		repos: ['WolffM/hadoku_site'],
		standingEligible: new Set(),
	};
	const sh = simShell({});
	const gh = fakeGh({});
	const queuedRun: PendingRun = {
		id: 1,
		jobId: 1,
		repo: 'WolffM/hadoku_site',
		labels: [],
		repository: { full_name: 'WolffM/hadoku_site' },
		head_repository: { full_name: 'WolffM/hadoku_site', fork: false },
		event: 'push',
	};
	const res = await dispatchEphemeral(input, 'tok', gh, sh, async (inp, token, g, s) =>
		runDispatchPass({ ...inp, pending: [queuedRun], tarballUrl: null }, token, g, s)
	);
	assert.equal(res?.minted, 1, 'the one queued job places somewhere');
	assert.deepEqual(
		mintedOn,
		['claw-9'],
		'claw-9 (really 1 worker) is chosen over claw-1 (really 3) — busy is jobs, not repos'
	);
});
