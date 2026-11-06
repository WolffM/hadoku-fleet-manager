/**
 * Tests for the backstop/hosted-fallback escalation as `runner-health.ts`'s
 * tick drives it: ci-throttle's refused-at-admission signal, the on-demand
 * (#120) promotion/hold/demote cycle, the dispatcher's capacity invariant,
 * the operator's force (`fleet backstop --force`), the #63/#56 saturation and
 * queue-pressure caller-side rules, and the claws→hokon→hosted tier ladder.
 * Split out of runner-health.test.ts (wave 5p lane B) — see
 * `src/tests/helpers/runner-health-rig.ts` for the shared fetch-stub fixture
 * every file that ticks the monitor installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tick, __setFleetReposForTesting } from '../runner-health.js';
import { TICK_INTERVAL_MS } from '../lib/runner-health-shared.js';
import { getRunnerHealthSnapshot } from '../runner-health-snapshot.js';
import { __setBackstopMachinesForTesting } from '../runners/backstop-machines.js';
import { __setHostLoadReaderForTesting } from '../runners/backstop-host-load.js';
import { QUEUE_ZOMBIE_SECONDS } from '../runners/backstop-queue-probe.js';
import { refusedAtAdmission } from '../runners/failover.js';
import { __setFleetProbeForTesting } from '../fleet-probe-store.js';
import { writeDrain } from '../runners/drain.js';
import { writeForce } from '../runners/backstop-force.js';
import {
	__resetCapacityLedgerForTesting,
	recordCapacityLedger,
} from '../runners/capacity-ledger.js';
import { backstopHold } from '../runners/backstop-hold.js';
import {
	installRunnerHealthRig,
	installFetch,
	discordPosts,
	labelOps,
	labelPostBodies,
	queuedListings,
	variableOps,
} from './helpers/runner-health-rig.js';
import {
	clawLabels,
	hokonLabels,
	hokonPromotedLabels,
	minutesAgo,
	daysAgo,
} from './helpers/runner-health-fixtures.js';

installRunnerHealthRig();

// --- Failover: refused at admission by ci-throttle (2026-10-11) ---
//
// A backstop promotion labels hokon on every repo, GitHub seats far more builder
// jobs there than its cap of 4, and ci-throttle refuses the losers after 90s in
// `Set up runner`. Three went red at 01:38Z and needed a hand rerun. The steps
// below are pygmalion run 38102526617's `test` job as the API returned it.

const REFUSED_STEPS = [
	{ number: 1, name: 'Set up job', conclusion: 'success' },
	{ number: 2, name: 'Set up runner', conclusion: 'failure' },
	{ number: 3, name: 'Run actions/checkout@v6', conclusion: 'skipped' },
	{ number: 4, name: 'Run WolffM/hadoku-actions/setup-python-venv@v1', conclusion: 'skipped' },
	{ number: 5, name: 'Ruff', conclusion: 'skipped' },
	{ number: 6, name: 'Tests', conclusion: 'skipped' },
	{ number: 12, name: 'Complete runner', conclusion: 'success' },
	{ number: 13, name: 'Complete job', conclusion: 'success' },
];

test('refusedAtAdmission: only a failed `Set up runner` with no workflow step run', () => {
	assert.equal(refusedAtAdmission({ conclusion: 'failure', steps: REFUSED_STEPS }), true);
	const ranCheckout = REFUSED_STEPS.map((st) =>
		st.number === 3 ? { ...st, conclusion: 'success' } : st
	);
	assert.equal(
		refusedAtAdmission({ conclusion: 'failure', steps: ranCheckout }),
		false,
		'once a workflow step ran, a rerun could repeat its side effects'
	);
	const redTests = REFUSED_STEPS.map((st) =>
		st.number === 2
			? { ...st, conclusion: 'success' }
			: st.number === 6
				? { ...st, conclusion: 'failure' }
				: st.number > 2 && st.number < 6
					? { ...st, conclusion: 'success' }
					: st
	);
	assert.equal(
		refusedAtAdmission({ conclusion: 'failure', steps: redTests }),
		false,
		'a red build'
	);
	assert.equal(refusedAtAdmission({ conclusion: 'failure' }), false, 'no steps is not evidence');
	assert.equal(refusedAtAdmission({ conclusion: 'cancelled', steps: REFUSED_STEPS }), false);
});

// --- Dynamic hokon backstop label (promote during a full claw outage) ---

// ── saturation: every claw online but BUSY ──────────────────────────────────
// "A job needs a runner but would hit a queue" is the rule the backstop exists
// to serve, and availability alone cannot see it: from a queued job's point of
// view, three claws all mid-build are indistinguishable from three dead ones.

// ── on-demand backstop (#120): promotion is a MINT, not a label ────────────────
// Operator, 2026-10-19: "the runners get brought online the same way the JIT
// process does. not having standing runners squatting on ram." hokon keeps one
// standing registration — hadoku_site's deploy runner, `pm2-host` — and the
// backstop must never write `hadoku-builder` onto it. Its decision reaches the
// dispatcher through the HOLD, which offers the label on hokon's mints.

const ON_DEMAND = {
	hokon: { role: 'backstop', mint: 'on-demand', standingRepos: ['WolffM/hadoku_site'] },
};

test('#120: saturation promotes an on-demand backstop through the HOLD and writes no label', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
		});
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'saturation');
		assert.deepEqual(
			backstopHold(),
			['hokon'],
			'the dispatcher is told hokon may take builder work'
		);
		assert.equal(labelOps.length, 0, 'the deploy runner must never be labelled hadoku-builder');
		assert.equal(discordPosts.length, 0, 'saturation stays silent, minted or not');
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('#120: an on-demand backstop is held with NO registration at all — retiring them must not retire the backstop', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				],
			},
		});
		await tick('tok');
		assert.deepEqual(backstopHold(), ['hokon'], 'the manifest names the backstop, not the pool');
		assert.ok(
			discordPosts.some((p) => p.includes('🔻') && p.includes('hokon (mint)')),
			`an OUTAGE promotion still pages, by the hold's edge: ${discordPosts.join(' | ')}`
		);
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test("#120: a leftover hadoku-builder on an on-demand backstop's registration is STRIPPED, even while promoted", async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	try {
		installFetch({
			runners: {
				runners: [
					{
						id: 1,
						name: 'hokon',
						status: 'online',
						busy: false,
						labels: [...hokonLabels(), { name: 'hadoku-builder' }],
					},
					{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				],
			},
		});
		await tick('tok');
		assert.deepEqual(backstopHold(), ['hokon'], 'promoted');
		const ops = labelOps.filter((o) => o.includes('/actions/runners/1/'));
		assert.ok(ops.length > 0, 'the leftover label is acted on');
		assert.ok(
			ops.every((o) => o.startsWith('DELETE ') && o.endsWith('/labels/hadoku-builder')),
			`demote-only — the label is the standing registrations' path, and hokon has left it:\n${ops.join('\n')}`
		);
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

// ── the capacity invariant (2026-10-21): the dispatcher's ledger, paged ─────

const brokenLedger = () =>
	recordCapacityLedger([
		// claw-1 as the 2026-10-07 formula read it: one JIT job charged twice.
		{
			node: 'claw-1',
			liveUnits: 1,
			probeWorkers: 1,
			standingBusy: 1,
			warmHeld: 1,
			budget: 2,
			inFlight: 2,
		},
	]);
const soundLedger = () =>
	recordCapacityLedger([
		{
			node: 'claw-1',
			liveUnits: 1,
			probeWorkers: 1,
			standingBusy: 0,
			warmHeld: 1,
			budget: 2,
			inFlight: 1,
		},
	]);
const quietFleet = () =>
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [] },
	});

test('capacity invariant: three consecutive broken ticks page ONCE, naming the node and the clause', async () => {
	__resetCapacityLedgerForTesting();
	try {
		for (let i = 0; i < 3; i++) {
			brokenLedger();
			quietFleet();
			await tick('tok');
			if (i < 2) assert.equal(discordPosts.length, 0, `tick ${i + 1}: a race is not a bug yet`);
		}
		const page = discordPosts.find((p) => p.includes('dispatcher accounting'));
		assert.ok(page, `paged on the third tick: ${discordPosts.join(' | ')}`);
		assert.match(page!, /claw-1: charged 2 in flight/);
		brokenLedger();
		quietFleet();
		await tick('tok');
		assert.equal(
			discordPosts.filter((p) => p.includes('dispatcher accounting')).length,
			1,
			'still broken, still one page — alertOnce rate-limits it'
		);
	} finally {
		__resetCapacityLedgerForTesting();
	}
});

test('capacity invariant: a single broken pass is a race, not a page; a sound ledger re-arms', async () => {
	__resetCapacityLedgerForTesting();
	try {
		brokenLedger();
		quietFleet();
		await tick('tok');
		brokenLedger();
		quietFleet();
		await tick('tok');
		soundLedger(); // the third tick reads a sound ledger: the streak resets
		quietFleet();
		await tick('tok');
		brokenLedger();
		quietFleet();
		await tick('tok');
		assert.equal(
			discordPosts.filter((p) => p.includes('dispatcher accounting')).length,
			0,
			'two broken, one sound, one broken: never three in a row'
		);
	} finally {
		__resetCapacityLedgerForTesting();
	}
});

test('capacity invariant: a stale ledger (dispatcher not running) is not a broken one', async () => {
	__resetCapacityLedgerForTesting();
	try {
		for (let i = 0; i < 3; i++) {
			recordCapacityLedger(
				[
					{
						node: 'claw-1',
						liveUnits: 1,
						probeWorkers: 1,
						standingBusy: 1,
						warmHeld: 1,
						budget: 2,
						inFlight: 2,
					},
				],
				Date.now() - 60 * 60_000
			);
			quietFleet();
			await tick('tok');
		}
		assert.equal(
			discordPosts.filter((p) => p.includes('dispatcher accounting')).length,
			0,
			'an hour-old ledger says nothing about now; that is dispatch.failingSince’s page'
		);
	} finally {
		__resetCapacityLedgerForTesting();
	}
});

// ── the green light (2026-10-21): `fleet backstop --force` ──────────────────
// The retro's §4.1: on 2026-10-20/21 the backstop wanted hokon every tick and
// the idle gate refused it, and every way to bring it in was a code change. A
// force is a time-boxed operator record the tick reads like the drain.

const forceUntil = (minutesFromNow: number) => ({
	since: new Date(Date.now() - 60_000).toISOString(),
	until: new Date(Date.now() + minutesFromNow * 60_000).toISOString(),
	reason: 'queue backed up',
	by: 'hadoku',
});

test('green light: a forced on-demand backstop is HELD on a quiet, measured tick, pegged or not', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	// A pegged box — the idle gate would refuse this — and NO saturation.
	__setHostLoadReaderForTesting(() => ({ load1: 60, cores: 12, memAvailableMb: 32_768 }));
	writeForce({ hokon: forceUntil(30) });
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'online', busy: false, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [] },
		});
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none', 'nothing WANTS it');
		assert.deepEqual(backstopHold(), ['hokon'], 'the operator does, so it is held');
		assert.equal(labelOps.length, 0, 'held through the mint path; no label on the deploy runner');
	} finally {
		writeForce({});
		__setHostLoadReaderForTesting(() => ({ load1: 0, cores: 12, memAvailableMb: 32_768 }));
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('green light: a force does NOT beat the drain — red wins', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	writeForce({ hokon: forceUntil(30) });
	writeDrain({ hokon: { since: 's', reason: 'lid off', by: 'hadoku' } });
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [] },
		});
		await tick('tok');
		assert.deepEqual(backstopHold(), [], 'drained: not held, forced or not');
	} finally {
		writeDrain({});
		writeForce({});
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('green light: an expired force lapses on its own — nobody has to remember to turn it off', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	writeForce({ hokon: forceUntil(-1) });
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [] },
		});
		await tick('tok');
		assert.deepEqual(backstopHold(), [], 'a minute past its until, the force is as good as absent');
	} finally {
		writeForce({});
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('#120: the drain is the red light — a drained on-demand backstop is not held, outage included', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	writeDrain({ hokon: { since: 's', reason: 'operator', by: 'hadoku' } });
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				],
			},
		});
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'outage', 'the WANT is unchanged');
		assert.deepEqual(backstopHold(), [], 'blocked means no jobs, an emergency included');
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('#120: releasing an on-demand promotion clears the hold and closes the 🔻 it opened', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				],
			},
		});
		await tick('tok');
		assert.deepEqual(backstopHold(), ['hokon']);
		installFetch({
			runners: {
				runners: [
					{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'online', busy: false, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [] },
		});
		await tick('tok');
		assert.deepEqual(backstopHold(), [], 'demotion leaves nothing listening and nothing offered');
		assert.ok(
			discordPosts.some((p) => p.includes('🔺') && p.includes('hokon (mint)')),
			discordPosts.join(' | ')
		);
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

// ── the saturation gate: at capacity is not the same as backed up ───────────
// `clawsFree === 0` says every claw is busy. It does NOT say anything is
// waiting. A fleet running flat out with an empty queue is a fleet working, and
// pulling the PRODUCTION host into that buys nothing — which is what the trigger
// did on ordinary load until 2026-08-25.

// ── the pm2-host rung is PER NODE (3e §H) ──────────────────────────────────
// `pm2-host` became a PROBED capability on 2026-09-15 (#6), so a claw can EARN
// it and migration one's box will. Until 2026-09-16 the rung was ONE
// module-level boolean for the whole fleet, and with two holders it answered
// about the FLEET while the backstop was asking about a BOX — wrong in both
// directions, and both directions cost the fleet its backstop during a backlog.

/** A claw that has EARNED pm2-host: it offers the rung and no builder label. */

/**
 * The REAL rung, answered per node.
 *
 * `nodeReservation` itself is not called: it reads module-level live state
 * (the cron counter, the host-lease ledger), so a test that left either set
 * would reserve everything and read as a pass for the wrong reason. This
 * stands in for it with the one rung under test, and it is handed whatever busy
 * flag the tick computed — so a tick that collapses two holders into one answer
 * gets a reservation for a box that is not busy.
 */

// ── #63: the caller must not answer the function's question for it ────────
// Every test in this block is at the CALLER. `decideBackstop` has been right
// since 2026-09-01 and its own unit tests pass today with the fleet inert in
// production, because the caller handed it a queue of 0 whenever `atCapacity`
// was false. A test against the function alone cannot fail here — that is the
// whole of #63 — so these drive a real tick through `tick()` and assert on the
// fetches it makes and the label it writes.

test('#63 THE 2026-09-01 SHAPE: a long queue promotes while claws are FREE', async () => {
	// The outage this lane exists for. Three of four nodes ephemeral, so
	// census.ts folded their mintable slots into `clawsFree` and it never hit
	// zero; 13 jobs sat 11-19 minutes across nine repos and the backstop stayed
	// down, because the caller asked "is the fleet full?" before "is anything
	// stuck?" and the first question could no longer be true.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				// FREE, not busy. `isAtCapacity` is false for this fleet, and that
				// is exactly the state the old gate refused to probe in.
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
				{ id: 3, name: 'claw-2', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(13) }] },
	});
	await tick('tok');
	assert.ok(queuedListings.length > 0, 'the queue must be PROBED off-capacity, not assumed empty');
	assert.equal(
		getRunnerHealthSnapshot()?.at_capacity,
		false,
		'the fixture is genuinely off-capacity — a free claw, which is the point'
	);
	assert.ok(
		(getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0) >= 100,
		'and the backlog was MEASURED, not passed in as the literal 0'
	);
	assert.equal(
		getRunnerHealthSnapshot()?.backstop_reason,
		'saturation',
		'a backed-up queue is sufficient on its own — `atCapacity` is not a precondition'
	);
	assert.equal(labelOps.length, 1, 'and the promotion actually reaches GitHub');
	assert.match(labelOps[0]!, /^POST .*\/actions\/runners\/1\/labels$/);
	assert.deepEqual(labelPostBodies[0], ['hadoku-builder']);
	assert.equal(
		discordPosts.length,
		0,
		'saturation is ordinary load and pages nobody — only an outage is an incident'
	);
});

test('#63: an EMPTY queue off-capacity still does not promote', async () => {
	// The other half, and the one that keeps the fix from being a loosening.
	// Probing more often must not mean promoting more often: 2026-08-24 fired on
	// ordinary load with nothing waiting, and `queuePressureSec` is what fixed
	// it. An idle fleet is now probed and must come back quiet.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [] },
	});
	await tick('tok');
	assert.ok(queuedListings.length > 0, 'it LOOKED');
	assert.equal(labelOps.length, 0, 'and found nothing, so the prod host stays out of CI');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none');
	assert.equal(getRunnerHealthSnapshot()?.queue_pressure_sec, 0);
});

test('#63: a YOUNG queue off-capacity does not promote either', async () => {
	// The threshold is what makes the run-level measure safe once a free claw no
	// longer gates the probe: a run is briefly `queued` while GitHub places it,
	// and 30s is well inside what the fleet absorbs unaided (p50 3s, p90 100s).
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: new Date(Date.now() - 30_000).toISOString() }] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 0, 'a 30s placement wait is not an escalation');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none');
	const pressure = getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0;
	assert.ok(
		pressure >= 25 && pressure < 100,
		`measured it and stayed under the bar (${pressure}s)`
	);
});

test('#63: an OUTAGE still skips the probe — that half of 2029454 is CORRECT', async () => {
	// Wave 3m's reasoning stands and must not be collateral damage here: nothing
	// can queue behind a fleet with nowhere to run, `decideBackstop` promotes on
	// the outage alone, and waiting to observe a queue would add the threshold to
	// every job's latency during the incident.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
	});
	await tick('tok');
	assert.equal(queuedListings.length, 0, 'a dark fleet must not pay the threshold in latency');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'outage', 'and it promotes anyway');
	assert.deepEqual(labelPostBodies[0], ['hadoku-builder']);
});

test('#63: UNMEASURED counts skip the probe — nothing downstream reads it', async () => {
	// `decideBackstop` returns on `ephemeralUnknown` before it ever looks at
	// `queuePressureSec`, holding the previous answer. runner-health's first tick
	// after every mgmt-api restart lands in that window (observed over three
	// deploys on 2026-09-07), and mgmt-api restarts often enough that a listing
	// per repo there is a standing cost bought for an input nothing consumes.
	__setFleetProbeForTesting(null);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(13) }] },
	});
	await tick('tok');
	assert.equal(
		getRunnerHealthSnapshot()?.ephemeral_unknown,
		true,
		'the fixture really is unmeasured'
	);
	assert.equal(queuedListings.length, 0, 'no probe for a decision that holds regardless');
	assert.equal(labelOps.length, 0, 'and an unmeasured fleet is neither promoted nor demoted');
});

test('2026-10-09: the FIRST tick after a restart never demotes an already-promoted hokon', async () => {
	// Memory is empty after a restart, so the remembered state reads "not
	// promoted"; the unmeasured tick used to converge every hokon registration
	// to that and strip hadoku-builder (20:36, 20:52), re-promoting ten minutes
	// later. An unmeasured tick writes nothing.
	__setFleetProbeForTesting(null);
	installFetch({
		runners: {
			runners: [
				{
					id: 1,
					name: 'hokon',
					status: 'online',
					busy: false,
					labels: [...hokonLabels(), { name: 'hadoku-builder' }],
				},
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
	});
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.ephemeral_unknown, true);
	assert.deepEqual(labelOps, [], 'nothing demoted on evidence nobody gathered');
});

test('#120: the FIRST tick after a restart neither holds nor strips an on-demand backstop', async () => {
	// The claws read dark here only because nothing has been measured yet — the
	// 2026-09-02 shape. An on-demand backstop is promoted by the HOLD, so "could not
	// look" must leave the hold empty: no builder work minted on the production
	// host on evidence nobody gathered. Nothing is stripped either — the units it
	// may already be running are one-job units the hold never touches.
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	__setFleetProbeForTesting(null);
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
				],
			},
		});
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.ephemeral_unknown, true, 'the fixture is unmeasured');
		assert.deepEqual(backstopHold(), [], 'no mint for builder work on an unmeasured tick');
		assert.deepEqual(labelOps, [], 'and no label written either way');
		assert.equal(
			discordPosts.some((p) => p.includes('🔻')),
			false,
			'a restart is not an outage'
		);
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('#63: the queue probe stays inside the hourly API budget at fleet size', async () => {
	// BUDGET ARITHMETIC IS PART OF THE FIX (AGENTS.md). `probeQueuePressure`
	// goes through `ghGet`, which revalidates with an ETag, but a queue that
	// moved between ticks is charged, so the CEILING — every listing changed —
	// is what is asserted here, and widening WHEN it runs raises it. The
	// cadence itself is unchanged: still at most one probe per runner-health
	// tick. What changed is how often that one probe is taken, from "only at
	// capacity" (which under all-JIT is approximately never) to "whenever the
	// fleet is up", so the honest ceiling is every tick.
	//
	// The listing count comes from a real tick at fleet size rather than a
	// literal, because the loop breaks early at the first run over the threshold
	// and the QUIET answer — the common one — is the expensive one.
	const REPOS = Array.from({ length: 26 }, (_, i) => `WolffM/repo-${i}`); // coveredRepos(), 2026-09-24
	const BUDGET_PER_HOUR = 5000; // GitHub primary limit, per token
	__setFleetReposForTesting(REPOS);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [] }, // the worst case: nothing to break early on
	});
	await tick('tok');
	assert.equal(queuedListings.length, REPOS.length, 'one listing per repo, once per tick');

	const ticksPerHour = 3_600_000 / TICK_INTERVAL_MS;
	const cost = ticksPerHour * queuedListings.length;
	assert.equal(cost, 156, '26 repos x 6 ticks/hr — the number stated at the call site');
	assert.ok(
		cost < BUDGET_PER_HOUR / 10,
		`the queue probe would spend ${cost}/hr of a ${BUDGET_PER_HOUR}/hr budget — it must ` +
			'leave room for polling, minting, the JIT reap, job-history and the crons on this token'
	);
});

// ── #56: a days-old queued run is not queue pressure ──────────────────────
// THE REGRESSION #63 SHIPPED. `2383b18` made the queue probe unconditional,
// which is the right fix for the 2026-09-01 shape above — and on the first tick
// after that deploy the probe returned ~3.5 MILLION seconds, 35,000x the 100s
// threshold, off two runs that have been `queued` and uncancellable since
// 2026-08-17 and 2026-08-19 (`dispatch-tick.ts` records the three API refusals).
// `saturated` was therefore permanently true and hokon carried
// `hadoku-builder` continuously.
//
// Measured in the DEPLOYED tree, not this checkout: zero `BACKSTOP` lines in
// mgmt-api's log for 2026-09-22..24, then 37 / 111 / 149 / 116 on 09-25..28,
// every one of them `reason=saturation queue=~3,510,000s` against a fleet
// reporting `claws=12/12 online free=27`. hokon's share of `hadoku-builder`
// work went 0.0% on 09-22..24 to 2.8 / 11.9 / 12.6 / 19.7% on 09-25..28.
//
// These are at the CALLER for the same reason the #63 block above is: the
// decision function was always right, and it is what the caller measures and
// hands it that was wrong.
test('#56 THE REGRESSION: a run queued for weeks does NOT promote the production host', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		// The two real ones, by age. Nothing will ever pick these up.
		queuedRuns: { workflow_runs: [{ created_at: daysAgo(42) }, { created_at: daysAgo(40) }] },
	});
	await tick('tok');
	assert.ok(queuedListings.length > 0, 'it still LOOKS — the probe stays unconditional');
	assert.equal(
		getRunnerHealthSnapshot()?.queue_pressure_sec,
		0,
		'a stuck run is not work waiting for capacity'
	);
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none');
	assert.equal(labelOps.length, 0, 'and the production host is not pulled into CI');
});

test('#56: the refusal is SAID, not silently dropped', async () => {
	// "I deliberately did not act on this" must never render as "there was
	// nothing there". A zombie count of 2 beside a pressure of 0 is two separate
	// facts — stuck work, and no live backlog — and they are two different jobs
	// for the operator. The log line says it too, on CHANGE rather than every
	// tick; the snapshot is what a test can observe, since the test host's logger
	// is deliberately a no-op.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: daysAgo(42) }, { created_at: daysAgo(40) }] },
	});
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.queue_zombies_ignored, 2);
	assert.equal(getRunnerHealthSnapshot()?.queue_pressure_sec, 0);
});

test('#56: a FRESH backlog behind a zombie still promotes — the fix is not undone', async () => {
	// The direction that matters. #63 is correct and must not be reverted: the
	// 2026-09-01 incident recurs without it. So the band has to remove the stuck
	// run WITHOUT removing the live one sitting behind it in the same listing.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: {
			workflow_runs: [{ created_at: daysAgo(42) }, { created_at: minutesAgo(13) }],
		},
	});
	await tick('tok');
	const pressure = getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0;
	assert.ok(pressure >= 100 && pressure < 1000, `the LIVE run is what was measured: ${pressure}s`);
	assert.equal(getRunnerHealthSnapshot()?.queue_zombies_ignored, 1);
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'saturation');
	assert.equal(labelOps.length, 1, 'and it reaches GitHub');
});

test('#56: a stall LONGER than the band still promotes — the exclusion cannot be manufactured', async () => {
	// CLAUDE.md's rule, checked: if you exclude a category, check what happens
	// when a real failure MAKES that category. `queue-health`'s p95 broke exactly
	// this way — every casualty of a long stall eventually crossed the one-hour
	// ceiling and LEFT the percentile, so a two-hour outage read greener than a
	// twenty-minute one.
	//
	// A MAXIMUM over a sliding band does not have that shape. A stall lasting
	// longer than a day means runs are still arriving and still not being served,
	// so the band is full of recent ones. Here: the oldest casualty has aged out
	// entirely, and the run just inside the boundary is still over the threshold
	// by four orders of magnitude.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: {
			workflow_runs: [
				{ created_at: daysAgo(3) }, // aged out of the band by the stall's own length
				{ created_at: new Date(Date.now() - (QUEUE_ZOMBIE_SECONDS - 60) * 1000).toISOString() },
			],
		},
	});
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.queue_zombies_ignored, 1, 'the 3-day-old one is refused');
	assert.ok(
		(getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0) >= QUEUE_ZOMBIE_SECONDS - 120,
		'and the one inside the band carries the stall'
	);
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'saturation');
	assert.equal(labelOps.length, 1);
});

test("#56: the probe reads THIS attempt's clock, not the original run's", async () => {
	// `created_at` pins to the ORIGINAL run and GitHub never moves it, so on a
	// re-run the two diverge by the whole gap between attempts. That is the bug
	// `GhRun.run_started_at` was added for on 2026-09-10, when a re-run of a
	// 2h-old hadoku-tenhands run alerted as "QUEUED 122m" while its jobs started
	// four seconds later — and the saturation probe was still reading the field
	// that mistake was about, so requeueing anything old promoted the production
	// host on the next tick.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: {
			workflow_runs: [{ created_at: minutesAgo(122), run_started_at: minutesAgo(0) }],
		},
	});
	await tick('tok');
	const pressure = getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0;
	assert.ok(pressure < 100, `this attempt has barely waited: ${pressure}s`);
	assert.equal(getRunnerHealthSnapshot()?.queue_zombies_ignored, 0, 'not a zombie either');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none');
	assert.equal(labelOps.length, 0);
});

test('#56: a queue measured EMPTY demotes on the FIRST calm tick, not the third', async () => {
	// The other half of #63, at the caller. The hold used to run a fixed thirty
	// minutes whether or not anything was still queued, and it could not have done
	// better: until `2383b18` the caller handed `decideBackstop` a literal 0 on
	// every off-capacity tick, so the queue reading carried no information. Now it
	// is probed every tick and 0 means PROBED AND EMPTY — and a standing hokon
	// registration wins GitHub's assignment race outright, so thirty minutes of
	// eligibility over an empty queue is thirty minutes of hokon taking builder
	// work no claw was slow to take.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 1, 'promoted while saturated');
	labelOps.length = 0;

	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonPromotedLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [] },
	});
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.queue_pressure_sec, 0, 'probed, and empty');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none', 'not "holding"');
	assert.equal(labelOps.length, 1, 'the reserve stands down now');
	assert.match(labelOps[0]!, /^DELETE .*\/labels\/hadoku-builder$/);
});

/**
 * Escalation order is claws → hokon → GitHub-hosted, and hosted is genuinely
 * LAST. It costs billed minutes on 12 private repos, and a hosted runner cannot
 * reach the vault — the fetch returns a CF challenge, which is what broke
 * auto-format on 2026-08-17. So an all-claws-down outage must land on the hokon
 * pool and stay off hosted for as long as that pool can serve.
 */
test('tiers: all claws down but hokon pool online → promotes hokon, does NOT go hosted', async () => {
	installFetch({
		runners: {
			runners: [
				// Every claw dark.
				{ id: 1, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
				{ id: 2, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				// hokon + its idle backstop instances.
				{ id: 10, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{
					id: 11,
					name: 'hokon-b',
					status: 'online',
					busy: false,
					labels: [{ name: 'hokon-backstop' }],
				},
			],
		},
	});

	await tick('tok');

	// The whole pool is promoted, not just hokon — one slot would serialise the
	// entire fleet's CI behind a single job.
	assert.equal(labelPostBodies.length, 2, 'hokon AND hokon-b are promoted');
	for (const body of labelPostBodies) {
		assert.deepEqual(body, ['hadoku-builder']);
	}
	// Tier 3 must NOT engage while tier 2 is serving.
	//
	// The assertion is on the VALUE, not on whether a write happened. Since
	// 2026-08-30 the fleet branch WRITES the fleet target rather than deleting
	// the variable — that is what lets 107 workflows drop their own
	// `|| '["self-hosted","hadoku-builder"]'` fallback. So "no PATCH at all"
	// would now fail for the right behaviour; only a write carrying
	// ubuntu-latest is the flip this test exists to forbid.
	const flips = variableOps.filter(
		(o) => (o.startsWith('PATCH') || o.startsWith('POST')) && o.includes('ubuntu-latest')
	);
	assert.deepEqual(flips, [], 'hokon can serve, so the fleet must stay off hosted runners');
});
