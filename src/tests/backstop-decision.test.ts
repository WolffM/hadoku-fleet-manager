/**
 * Tests for `runners/backstop-decision.ts` (plus `backstop-machines.ts`):
 * when the fleet promotes hokon into the standing builder pool, when it
 * demotes it again, and the saturation/outage/reservation/quarantine rules
 * that gate the decision either way. Split out of runner-health.test.ts
 * (wave 5j lane A) — see `src/tests/helpers/runner-health-rig.ts` for the
 * shared fetch-stub fixture every file that ticks the monitor installs.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
	tick,
	SWEEP_CONCURRENCY,
	getRunnerHealthSnapshot,
	__setFleetReposForTesting,
} from '../runner-health.js';
import { __setBackstopMachinesForTesting } from '../runners/backstop-machines.js';
import { BACKSTOP_CONVERGE_INTERVAL_MS } from '../runners/backstop-decision.js';
import {
	__setHostLoadReaderForTesting,
	__setReservationForTesting,
} from '../runners/backstop-decision.js';
import { markNodeSick } from '../lib/sick-node.js';
import { writeDrain } from '../runners/drain.js';
import {
	installRunnerHealthRig,
	installFetch,
	clawLabels,
	hokonLabels,
	hokonPromotedLabels,
	minutesAgo,
	discordPosts,
	labelOps,
	labelPostBodies,
	runnerListings,
	variableOps,
} from './helpers/runner-health-rig.js';

installRunnerHealthRig();

// --- Dynamic hokon backstop label (promote during a full claw outage) ---

/** All claws online — the drop is isolated to whatever the test overrides. */
const FLEET_ALL_UP = {
	runners: [
		{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
		{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
		{ id: 3, name: 'claw-2', status: 'online', busy: false, labels: clawLabels() },
	],
};

/** `WolffM/sweep-0` … `WolffM/sweep-{n-1}`: a fleet with nothing to say. */
const sweepRepos = (n: number) => Array.from({ length: n }, (_, i) => `WolffM/sweep-${i}`);

const clawPm2HostLabels = () => [{ name: 'self-hosted' }, { name: 'pm2-host' }];

/**
 * The REAL rung, answered per node.
 *
 * `nodeReservation` itself is not called: it consults the wall clock and the
 * declared cron window, so a suite run inside the 90 minutes after any daily
 * cron would reserve everything and read as a pass for the wrong reason. This
 * stands in for it with the one rung under test, and it is handed whatever busy
 * flag the tick computed — so a tick that collapses two holders into one answer
 * gets a reservation for a box that is not busy.
 */
const pm2RungOnly = () =>
	__setReservationForTesting((busy) =>
		busy
			? { reserved: true, reason: 'pm2-host', detail: 'serving pm2-host work' }
			: { reserved: false, reason: null, detail: null }
	);

test('backstop: all claws OFFLINE → adds hadoku-builder to hokon (🔻) and no floor page', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{
					id: 2,
					name: 'claw-1',
					status: 'offline',
					busy: false,
					labels: clawLabels(),
				},
				{
					id: 3,
					name: 'claw-2',
					status: 'offline',
					busy: false,
					labels: clawLabels(),
				},
			],
		},
	});
	await tick('tok');
	assert.equal(labelOps.length, 1, 'one label add');
	assert.match(labelOps[0]!, /^POST .*\/actions\/runners\/1\/labels$/);
	// One label now. hadoku-builder-heavy was retired 2026-08-19 — see the note on claw-3, so a
	// backstop that omitted it would leave heavy jobs queueing through the exact
	// outage it exists for.
	assert.deepEqual(
		labelPostBodies[0],
		['hadoku-builder'],
		'promotion adds the builder AND heavy labels'
	);
	assert.equal(
		discordPosts.length,
		1,
		'only the promote note — promotion covers the builder floor'
	);
	assert.match(discordPosts[0]!, /promoted/);
	assert.match(discordPosts[0]!, /hokon/);
});

test('backstop: a claw back online + hokon still labeled → removes the temporary label (🔺)', async () => {
	// A full CYCLE, not a bare demote. The 🔺 exists to close a 🔻 the operator
	// actually saw, so the outage that opened it has to be part of the test —
	// otherwise this asserts a recovery note for an incident that never happened,
	// which is precisely the noise the saturation path must not generate.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
	});
	await tick('tok');
	assert.equal(discordPosts.length, 1, 'the outage pages first');
	assert.match(discordPosts[0]!, /promoted/);
	labelOps.length = 0;
	discordPosts.length = 0;

	installFetch({
		runners: {
			runners: [
				{
					id: 1,
					name: 'hokon',
					status: 'online',
					busy: false,
					labels: hokonPromotedLabels(),
				},
				{
					id: 2,
					name: 'claw-1',
					status: 'online',
					busy: false,
					labels: clawLabels(),
				},
			],
		},
	});
	await tick('tok');
	assert.equal(labelOps.length, 1, 'one label remove');
	assert.match(labelOps[0]!, /^DELETE .*\/actions\/runners\/1\/labels\/hadoku-builder$/);
	assert.equal(discordPosts.length, 1);
	assert.match(discordPosts[0]!, /released the backstop/);
});

test('backstop: all claws AND hokon offline → cannot promote, pages pm2-host at its floor', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'offline', busy: false, labels: hokonLabels() },
				{
					id: 2,
					name: 'claw-1',
					status: 'offline',
					busy: false,
					labels: clawLabels(),
				},
			],
		},
	});
	// Twice: the floor debounces, and a total-fleet outage is exactly the shape a
	// blip on the monitoring host also produces, so it earns no exemption.
	await tick('tok');
	await tick('tok');
	assert.equal(labelOps.length, 0, 'hokon offline → no promotion possible');
	// hadoku-builder is retired from this alert (C0b) — with hokon offline too,
	// pm2-host (an IDENTITY label nothing else can carry) is what proves the
	// floor breach still pages when it genuinely should.
	assert.ok(
		discordPosts.some((p) => /pm2-host/.test(p) && /will queue/.test(p)),
		'pm2-host floor breach pages'
	);
	assert.ok(
		!discordPosts.some((p) => /hadoku-builder/.test(p)),
		'hadoku-builder itself must not page — retired, see C0b'
	);

	// THE LAST RESORT MUST ACTUALLY ENGAGE.
	//
	// With every claw AND the whole hokon pool dark, selfHostedOnline is 0 and
	// the fleet has to flip to GitHub-hosted runners. Nothing asserted that. The
	// only test that inspected `variableOps` asserted it was EMPTY (the hokon-can-
	// serve case), so the rung that spends billed minutes on 12 private repos was
	// verified never to fire and never verified to fire.
	//
	// This is also the only coverage of the sum at the call site —
	// `selfHostedOnline = clawsOnline + backstopOnline` — which is the exact line
	// the 2026-08-23 comment beside it was written about. ci-runner-fallback's own
	// suite tests the module, not this addition.
	const flips = variableOps.filter((o) => o.startsWith('PATCH') || o.startsWith('POST'));
	assert.ok(
		flips.length > 0,
		`a total self-hosted outage must pin CI_RUNNER to hosted, got: ${JSON.stringify(variableOps)}`
	);
	for (const f of flips) {
		assert.match(f, /CI_RUNNER=\["ubuntu-latest"\]|CI_RUNNER=/, 'the pin names CI_RUNNER');
	}
});

test('backstop: all claws BUSY *and* backed up → promotes hokon, and stays SILENT', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
				{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		// Busy alone is no longer enough — something has to be WAITING. See
		// SATURATION_QUEUE_SECONDS.
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 1, 'saturation promotes the hokon pool');
	assert.match(labelOps[0]!, /^POST .*\/actions\/runners\/1\/labels$/);
	assert.deepEqual(labelPostBodies[0], ['hadoku-builder']);
	assert.equal(
		discordPosts.length,
		0,
		'busy claws are a normal weekday — paging for them would train the operator ' +
			'to skim past the 🔻 that means the garage is actually dark'
	);
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'saturation');
});

test('backstop, 2026-10-09: a BUSY hokon is not promoted on mere saturation — "promote if the queue is full and hokon is idle"', async () => {
	// 2026-10-21: the ceiling is 4.0/core now (load 46 on 12 cores, the
	// operator's own sessions, still lets hokon in). 60 on 12 is a pegged box.
	// Two minutes queued is saturation (≥100s) but not a backlog (<300s).
	__setHostLoadReaderForTesting(() => ({ load1: 60, cores: 12, memAvailableMb: 32_768 }));
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [{ created_at: minutesAgo(2) }] },
		});
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'saturation', 'the WANT is there');
		assert.equal(labelOps.length, 0, 'load 60 on 12 cores is a pegged box, not a reserve');
	} finally {
		__setHostLoadReaderForTesting(() => ({ load1: 0, cores: 12, memAvailableMb: 32_768 }));
	}
});

test('backstop, 2026-10-21: a BACKLOG past 300s promotes a pegged hokon anyway — "hokon MUST come in when the queue shows up"', async () => {
	// Same pegged box; the queue has sat six minutes, past ci:queue-health's own
	// "not serving work" floor. The desktop yields.
	__setHostLoadReaderForTesting(() => ({ load1: 60, cores: 12, memAvailableMb: 32_768 }));
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
		assert.equal(labelOps.length, 1, 'a backlog promotes the pool whatever the load');
		assert.match(labelOps[0]!, /^POST .*\/actions\/runners\/1\/labels$/);
		assert.equal(discordPosts.length, 0, 'a backlog promote is still saturation: no page');
	} finally {
		__setHostLoadReaderForTesting(() => ({ load1: 0, cores: 12, memAvailableMb: 32_768 }));
	}
});

test('backstop, 2026-10-21: a backlog does NOT waive memory — a starved hokon stays out', async () => {
	__setHostLoadReaderForTesting(() => ({ load1: 2, cores: 12, memAvailableMb: 4_000 }));
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [{ created_at: minutesAgo(20) }] },
		});
		await tick('tok');
		assert.equal(
			labelOps.length,
			0,
			'a Forge job without memory fails slowly; no backlog changes that'
		);
	} finally {
		__setHostLoadReaderForTesting(() => ({ load1: 0, cores: 12, memAvailableMb: 32_768 }));
	}
});

test('an unreadable manifest writes NO builder label — a deploy runner and a backstop look alike without it', async () => {
	__setBackstopMachinesForTesting(() => null);
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
		assert.equal(labelOps.length, 0, 'not even on an outage');
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('backstop: an OUTAGE promotes hokon even when it is busy — CI with nowhere to run outranks idle', async () => {
	__setHostLoadReaderForTesting(() => ({ load1: 9, cores: 12, memAvailableMb: 2_000 }));
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				],
			},
		});
		await tick('tok');
		assert.ok(
			labelOps.some((o) => /^POST .*\/actions\/runners\/1\/labels$/.test(o)),
			labelOps.join('\n')
		);
	} finally {
		__setHostLoadReaderForTesting(() => ({ load1: 0, cores: 12, memAvailableMb: 32_768 }));
	}
});

test('backstop: busy claws with an EMPTY queue do NOT promote the prod host', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
				{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 0, 'nothing is waiting, so hokon stays out of CI');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none');
	assert.equal(getRunnerHealthSnapshot()?.at_capacity, true, 'still reported as at capacity');
	assert.equal(getRunnerHealthSnapshot()?.queue_pressure_sec, 0);
});

test('backstop: a queue YOUNGER than the p90 threshold does not promote either', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		// 30s: real, but well inside what the fleet absorbs unaided (p50 3s, p90 100s).
		queuedRuns: { workflow_runs: [{ created_at: new Date(Date.now() - 30_000).toISOString() }] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 0, 'a 30s wait is ordinary, not an escalation');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none');
	const pressure = getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0;
	assert.ok(
		pressure >= 25 && pressure < 100,
		`measured the wait but stayed under the bar (${pressure}s)`
	);
});

test('backstop: a real backlog does NOT promote hokon while the nightly crons run', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		// Everything the saturation path wants: every claw busy, 6 minutes queued.
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	__setReservationForTesting(() => ({
		reserved: true,
		reason: 'cron-running',
		detail: 'dp-daily-pipeline',
	}));
	await tick('tok');
	assert.equal(labelOps.length, 0, 'the crons outrank CI being slow');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none');
	assert.equal(getRunnerHealthSnapshot()?.reserved_reason, 'cron-running');
	assert.ok(
		(getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0) >= 100,
		'the backlog was real and measured — it was OVERRULED, not unnoticed'
	);
});

test('backstop: a BUSY claw holder of pm2-host does not hold an idle hokon off builder work', async () => {
	// Everything the saturation path wants — every eligible claw busy, 6 minutes
	// queued — plus claw-2 serving the top rung. hokon is idle and is the box the
	// backstop places on. Fleet-wide, claw-2's rung reserved hokon for work hokon
	// was not doing and the backlog kept waiting.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
				{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawPm2HostLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	pm2RungOnly();
	await tick('tok');
	assert.deepEqual(
		labelOps.map((o) => o.replace(/^(\w+) .*\/actions\/runners\//, '$1 ')),
		['POST 1/labels'],
		`only the idle holder is promoted, and the busy one is left alone: ${labelOps.join(', ')}`
	);
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'saturation');
	assert.equal(
		getRunnerHealthSnapshot()?.reserved_reason,
		null,
		'the POOL is not reserved while one holder is free'
	);
	assert.equal(
		getRunnerHealthSnapshot()?.pm2_host_busy,
		true,
		'the fleet-wide pill still says someone is serving the rung — it just no longer decides'
	);
});

test('backstop: an IDLE claw holder of pm2-host does not clear a BUSY hokon onto builder work', async () => {
	// The other direction of the same collapse, and the dangerous one: one flag
	// read `false` because claw-2 was idle, and the pool promoted the box that was
	// actually serving the rung. Here hokon is busy with pm2-host work and must be
	// left out of CI while claw-2, which is not, takes the backstop.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: true, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
				{ id: 3, name: 'claw-2', status: 'online', busy: false, labels: clawPm2HostLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	pm2RungOnly();
	await tick('tok');
	assert.deepEqual(
		labelOps.map((o) => o.replace(/^(\w+) .*\/actions\/runners\//, '$1 ')),
		['POST 3/labels'],
		`the free holder takes the backstop, never the busy one: ${labelOps.join(', ')}`
	);
});

test('backstop: EVERY holder busy still reserves the whole pool, exactly as one flag did', async () => {
	// The case the fleet-wide flag got right, pinned so the split did not trade one
	// failure for another: with no free holder there is nowhere for the backstop to
	// go, and a backed-up queue does not outrank the top rung.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: true, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
				{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawPm2HostLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	pm2RungOnly();
	await tick('tok');
	assert.equal(labelOps.length, 0, 'the top rung outranks CI being slow');
	assert.equal(getRunnerHealthSnapshot()?.reserved_reason, 'pm2-host');
	assert.ok(
		(getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0) >= 100,
		'the backlog was real and measured — it was OVERRULED, not unnoticed'
	);
});

test('backstop: an already-promoted hokon comes DOWN when cron work starts', async () => {
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
	assert.equal(labelOps.length, 1, 'promoted while the fleet was backed up and nothing reserved');
	labelOps.length = 0;

	// Same backlog, but the crons have now started. Declining to promote is not
	// enough — a promotion from 23:50 would otherwise sit through the whole run.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonPromotedLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	__setReservationForTesting(() => ({ reserved: true, reason: 'cron-window', detail: '00:00' }));
	await tick('tok');
	assert.equal(labelOps.length, 1, 'the label is taken back, not merely withheld');
	assert.match(labelOps[0]!, /^DELETE .*\/labels\/hadoku-builder$/);
});

test('backstop: an OUTAGE overrules the crons — CI being impossible outranks them', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [] },
	});
	__setReservationForTesting(() => ({ reserved: true, reason: 'cron-running', detail: 'nightly' }));
	await tick('tok');
	assert.equal(labelOps.length, 1, 'a fleet with nowhere to run is worth interrupting a cron for');
	assert.deepEqual(labelPostBodies[0], ['hadoku-builder']);
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'outage');
});

test('backstop: an OUTAGE promotes with no queue at all — nothing can queue behind a dark fleet', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 1, 'the outage path must not wait to observe a queue');
	assert.deepEqual(labelPostBodies[0], ['hadoku-builder']);
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'outage');
});

test('backstop: one claw frees up → demotes again, with no 🔺 for a silent promote', async () => {
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
		// STILL QUEUED, just no longer past the threshold — 40s against 100s.
		//
		// This fixture omitted `queuedRuns` entirely and so measured the hold over
		// a queue of ZERO, which since #56 stands the reserve down on the first
		// calm tick: nothing is waiting, so there is no flap left to damp and no
		// reason to keep the production host eligible for another half hour. The
		// flap this test is about is a queue crossing the threshold and coming
		// back, and a queue at 40s is exactly that state. The empty case has its
		// own test below.
		queuedRuns: { workflow_runs: [{ created_at: new Date(Date.now() - 40_000).toISOString() }] },
	});
	// A SATURATION stand-down waits for sustained calm. One free tick is not
	// evidence the pool is calm — it is what the flap looked like: measured
	// 2026-08-25, promote/demote/promote inside twenty minutes, each pass
	// rewriting labels on 13-25 runners fleet-wide. Only the outage and cron
	// reservation paths stand down in the same tick, and both have their own
	// tests above.
	await tick('tok');
	assert.equal(labelOps.length, 0, 'one calm tick is not calm enough');
	await tick('tok');
	assert.equal(labelOps.length, 0, 'nor two');

	await tick('tok');
	assert.equal(labelOps.length, 1, 'sustained calm demotes the pool');
	assert.match(labelOps[0]!, /^DELETE .*\/labels\/hadoku-builder$/);
	assert.equal(discordPosts.length, 0, 'a promote nobody was told about needs no recovery note');
});

test('backstop: a single busy tick inside the calm window restarts the count', async () => {
	// The whole point: saturation that comes back before the window elapses must
	// not get a demote-then-promote pair out of it.
	const saturated = {
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	};
	const calm = {
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonPromotedLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		// Below the threshold but NOT empty — see the fixture note above. An empty
		// queue ends the hold immediately since #56, which would make this whole
		// sequence measure the stand-down rather than the window.
		queuedRuns: { workflow_runs: [{ created_at: new Date(Date.now() - 40_000).toISOString() }] },
	};
	installFetch(saturated);
	await tick('tok');
	labelOps.length = 0;

	installFetch(calm);
	await tick('tok');
	await tick('tok');
	// Saturated AGAIN, but with hokon still promoted — that is the point of the
	// window. Handing back the un-promoted fixture would make the tick re-add a
	// label it never lost, measuring the fixture instead of the hysteresis.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonPromotedLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	await tick('tok'); // busy again — the counter resets
	installFetch(calm);
	await tick('tok');
	await tick('tok');
	assert.equal(labelOps.length, 0, 'no label churn across the whole sequence');
});

test('backstop: an outage promotes hokon on every fleet repo, not just this one', async () => {
	__setFleetReposForTesting(['WolffM/hadoku_site', 'WolffM/hadoku-rally', 'WolffM/hadoku-task']);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
	});
	await tick('tok');
	const repos = labelOps
		.filter((o) => o.startsWith('POST'))
		.map((o) => o.match(/repos\/([^/]+\/[^/]+)\//)?.[1])
		.filter(Boolean);
	assert.deepEqual(
		[...new Set(repos)].sort(),
		['WolffM/hadoku-rally', 'WolffM/hadoku-task', 'WolffM/hadoku_site'],
		'every fleet repo gets its hokon runner promoted'
	);
});

test('backstop: a QUARANTINED hokon is not promoted on saturation', async () => {
	markNodeSick('hokon');
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
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'saturation', 'the WANT is unchanged');
	assert.equal(labelOps.length, 0, 'but a quarantined node gets no builder work');
});

test('backstop: a DRAINED hokon is not promoted either', async () => {
	writeDrain({ hokon: { since: 's', reason: 'operator', by: 'hadoku' } });
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
	assert.equal(labelOps.length, 0, 'an operator took it out of service');
});

test('backstop: a quarantined hokon ALREADY labelled is stripped, not left serving', async () => {
	markNodeSick('hokon');
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
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 1);
	assert.match(labelOps[0]!, /^DELETE .*\/actions\/runners\/1\/labels\/hadoku-builder$/);
});

test('backstop: an outage does not fan a quarantined hokon out to the fleet', async () => {
	markNodeSick('hokon');
	__setFleetReposForTesting(['WolffM/hadoku_site', 'WolffM/hadoku-rally', 'WolffM/hadoku-task']);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
	});
	await tick('tok');
	assert.deepEqual(
		labelOps.filter((o) => o.startsWith('POST')),
		[],
		'no repo may promote a node the local loop refused — the fan-out shares its predicate'
	);
});

test('backstop: the fan-out never touches a claw, only the hokon pool', async () => {
	__setFleetReposForTesting(['WolffM/hadoku_site', 'WolffM/hadoku-rally']);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
				// Demoted by the fast loop — carries neither pm2-host nor
				// hokon-backstop — so the fan-out must leave it exactly as it found it.
				//
				// OFFLINE since 2026-08-27. It used to be `online`, which produced an
				// outage only because liveness was counted by LABEL: a demoted node
				// vanished from the count and the fleet read as dead while it was
				// running. That is the P2 bug, now fixed, and it is pinned as its own
				// test below. The scenario here needs a REAL outage to exercise
				// fan-out targeting, so every claw is down.
				{ id: 9, name: 'claw-2', status: 'offline', busy: false, labels: [] },
			],
		},
	});
	await tick('tok');
	assert.ok(labelOps.length > 0, 'the outage did promote something');
	assert.ok(
		labelOps.every((o) => /\/runners\/1\/labels/.test(o)),
		`only hokon (id 1) may be relabelled, got: ${labelOps.join(', ')}`
	);
});

test('backstop: an ONLINE demoted claw is not an outage and promotes nothing', async () => {
	// The regression guard for P2. claw-1 is down and claw-2 is up but demoted,
	// which is the fleet's ordinary steady state since tier1 became claw-2 alone.
	// Counting liveness by LABEL made this read as a total outage and promoted the
	// PRODUCTION host, while a healthy idle node sat there — the right response
	// being a tier promotion, which costs nothing on the prod box.
	__setFleetReposForTesting(['WolffM/hadoku_site']);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
				{ id: 9, name: 'claw-2', status: 'online', busy: false, labels: [] },
			],
		},
	});
	await tick('tok');
	assert.deepEqual(labelOps, [], 'a live claw means no backstop promotion');
});

// --- failure arms of the write paths (2026-08-30) --------------------------
//
// `labelStatus` and `rerunStatus` were declared in installFetch and used by no
// test, so the arms they exist for had never executed: a promote that GitHub
// refuses, and a rerun POST that fails. Both are the "we tried and could not"
// case, and in both the correct behaviour is to stay quiet and leave the state
// untouched rather than claim success.

test('backstop: a promote GitHub REFUSES is not recorded as promoted', async () => {
	// A token that has lost runner-admin still lists runners fine, so the monitor
	// reaches the write and gets a 403. It must not count that as a promotion —
	// the next tick has to try again, and the 🔻 must not claim hokon is serving.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
				{ id: 2, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				{ id: 10, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
			],
		},
		labelStatus: 403,
	});
	await tick('tok');

	assert.ok(
		labelOps.some((o) => o.startsWith('POST')),
		'the promote must be ATTEMPTED — otherwise this test proves nothing'
	);
	assert.ok(
		!discordPosts.some((p) => /promoted/.test(p) && /so jobs still have somewhere to run/.test(p)),
		`a refused promote must not announce that hokon is serving; got: ${discordPosts.join(' | ')}`
	);
});

test('backstop: a demote that finds the label ALREADY GONE is converged, not failed', async () => {
	// The tier ladder strips hokon's builder label on its own first pass after a
	// restart, at the same moment the first tick here converges the fleet. The
	// DELETE then 404s. That is the desired state, so it must settle
	// backstopFleetState — a "failure" here forced a second full converge on
	// the next tick and logged that the repo would queue, which it would not.
	__setFleetReposForTesting(['WolffM/hadoku_site', 'WolffM/hadoku-rally']);
	installFetch({
		runners: (repo) =>
			repo === 'WolffM/hadoku-rally'
				? {
						runners: [
							{ id: 1, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
							{ id: 2, name: 'claw-2', status: 'online', busy: false, labels: clawLabels() },
							{
								id: 10,
								name: 'hokon',
								status: 'online',
								busy: false,
								labels: hokonPromotedLabels(),
							},
						],
					}
				: FLEET_ALL_UP,
		labelDeleteStatus: 404,
	});
	await tick('tok');
	assert.ok(
		labelOps.some((o) => o.startsWith('DELETE') && o.includes('hadoku-rally')),
		'the demote must be ATTEMPTED on the child repo — otherwise this proves nothing'
	);
	assert.ok(
		!discordPosts.some((p) => /queue until/.test(p)),
		`a label that is already gone is not a repo that will queue; got: ${discordPosts.join(' | ')}`
	);

	// Settled: the next tick must not converge the fleet again.
	runnerListings.length = 0;
	await tick('tok');
	assert.ok(
		!runnerListings.includes('WolffM/hadoku-rally'),
		'a converged fleet is not re-read every tick — the 404 must have counted as done'
	);
});

test('backstop: the restart converge reads the fleet concurrently, bounded by SWEEP_CONCURRENCY', async () => {
	// A new process has backstopFleetState = null, so its first tick converges
	// every child repo — one runner listing each. Read one after another, that
	// was ~12s of the first tick after every restart.
	const repos = ['WolffM/hadoku_site', ...sweepRepos(2 * SWEEP_CONCURRENCY)];
	__setFleetReposForTesting(repos);
	let inFlight = 0;
	let peak = 0;
	installFetch({
		runners: FLEET_ALL_UP,
		runnersGate: async (repo) => {
			if (repo === 'WolffM/hadoku_site') return; // the label floor's own read
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
		},
	});
	await tick('tok');
	const converged = runnerListings.filter((r) => r !== 'WolffM/hadoku_site');
	assert.equal(
		new Set(converged).size,
		2 * SWEEP_CONCURRENCY,
		'every child repo was read by the converge pass — otherwise the peak means nothing'
	);
	assert.equal(peak, SWEEP_CONCURRENCY, 'listings in flight at the peak');
});

// --- convergeDue: the periodic re-verify sweep (wave5m lane C, migrated onto
// `lib/every.ts`'s `subCadenceDue`/`markSubCadence`) ------------------------
//
// No existing test pinned this gate's cadence before this wave. Steady state
// (FLEET_ALL_UP: two healthy claws, hokon up but unpromoted) keeps
// `backstopWanted` and `backstopFleetState` both false throughout, so past
// the first (restart) tick the ONLY thing that can trigger the fan-out is
// `convergeDue` itself.

test('backstop: the verify sweep re-reads a converged fleet once BACKSTOP_CONVERGE_INTERVAL_MS has passed', async () => {
	__setFleetReposForTesting(['WolffM/hadoku_site', 'WolffM/hadoku-rally', 'WolffM/hadoku-task']);
	mock.timers.enable({ apis: ['Date'] });
	try {
		installFetch({ runners: FLEET_ALL_UP });
		await tick('tok'); // restart tick: backstopFleetState was null, always converges
		assert.ok(
			runnerListings.includes('WolffM/hadoku-rally') &&
				runnerListings.includes('WolffM/hadoku-task'),
			'the first tick always converges — settling the state'
		);

		runnerListings.length = 0;
		await tick('tok'); // same instant: settled AND convergeDue is false
		assert.deepEqual(
			runnerListings.filter((r) => r !== 'WolffM/hadoku_site'),
			[],
			'a settled fleet inside the window is not re-read (hadoku_site is the label floor’s own read, every tick)'
		);

		mock.timers.tick(BACKSTOP_CONVERGE_INTERVAL_MS);
		runnerListings.length = 0;
		await tick('tok'); // convergeDue alone must force the re-verify
		assert.ok(
			runnerListings.includes('WolffM/hadoku-rally') &&
				runnerListings.includes('WolffM/hadoku-task'),
			'the verify sweep must re-read every child repo once the interval elapses, ' +
				'with nothing else about the fleet having changed'
		);
	} finally {
		mock.timers.reset();
	}
});

test('backstop: a verify sweep that fails a repo is retried on the very next tick, not held off another hour', async () => {
	__setFleetReposForTesting(['WolffM/hadoku_site', 'WolffM/hadoku-rally', 'WolffM/hadoku-task']);
	mock.timers.enable({ apis: ['Date'] });
	try {
		installFetch({ runners: FLEET_ALL_UP });
		await tick('tok'); // settle
		mock.timers.tick(BACKSTOP_CONVERGE_INTERVAL_MS);

		// The verify sweep is due; hadoku-task's read fails.
		installFetch({
			runners: FLEET_ALL_UP,
			runnersGate: async (repo) => {
				if (repo === 'WolffM/hadoku-task') throw new Error('simulated 502');
			},
		});
		runnerListings.length = 0;
		await tick('tok');
		assert.ok(runnerListings.includes('WolffM/hadoku-task'), 'the failing repo was attempted');

		// NO MORE TIME PASSES. A fan-out that could not read every repo must not
		// claim the hour — the very next tick must retry, not wait.
		installFetch({ runners: FLEET_ALL_UP }); // healthy again
		runnerListings.length = 0;
		await tick('tok');
		assert.ok(
			runnerListings.includes('WolffM/hadoku-task'),
			'a partial fan-out is retried next tick instead of being recorded as done — ' +
				'plain subCadence would have marked it on the failed attempt and waited an hour'
		);

		// It succeeded this time, so NOW the mark holds — one more tick with no
		// time passed must not re-read.
		runnerListings.length = 0;
		await tick('tok');
		assert.deepEqual(
			runnerListings.filter((r) => r !== 'WolffM/hadoku_site'),
			[],
			'the successful retry finally earned the mark — the next tick is quiet again'
		);
	} finally {
		mock.timers.reset();
	}
});
