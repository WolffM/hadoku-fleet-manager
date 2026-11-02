/**
 * Tests for `runner-health-label-floor.ts`'s individual-runner-offline
 * detection: the per-node outage ledger (not the label floor itself), its
 * consecutive-ticks debounce, its hourly backoff, and the standing-node
 * (two-instance) grouping. Split out of runner-health.test.ts (wave 5p lane
 * B) — see `src/tests/helpers/runner-health-rig.ts` for the shared
 * fetch-stub fixture every file that ticks the monitor installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tick } from '../runner-health.js';
import { __setFleetProbeForTesting } from '../fleet-probe-store.js';
import {
	installRunnerHealthRig,
	installFetch,
	discordPosts,
	offlineAlerts,
} from './helpers/runner-health-rig.js';
import { clawLabels, hokonLabels } from './helpers/runner-health-fixtures.js';

installRunnerHealthRig();

// ── the fan-out: hokon is relabelled on EVERY fleet repo ────────────────────
// A runner ID is repo-scoped, so promoting by ID reaches exactly one repo.
// hokon has carried a runner on all 26 repos since 2026-08-23, so an outage
// used to promote it for hadoku_site and strand the other 25 — and the hosted
// fallback could not rescue them either, because it counts hokon as capacity.

// ── a reserve must be SOUND when it is brought in ───────────────────────────
// The backstop is the only writer of hadoku-builder on a backstop, so the fleet
// loop's quarantine meant nothing here until 2026-09-21 — a hokon whose store
// the guard had flagged would still be promoted the moment the claws saturated.

// ── degraded fleet: one claw down while the floor is still met ───────────────
// The label-floor alert only fires at ZERO online, so claw-3 sat offline for a
// full day and nothing ever said so. These pin the first-node-down signal —
// and, just as importantly, that it stays QUIET afterwards.

// Every claw in the fixture manifest is EPHEMERAL, as in production, so a
// claw's liveness here is the fast loop's probe — its listing entries are JIT
// registrations that read `offline` around every job (2026-10-22, claw-8).
// The listing still decides for a STANDING node, and hokon is the one there is.

/** The fast loop's view: every fixture claw reachable except `down`. */
function probeClaws(down: string[] = []): void {
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: Object.fromEntries(
			['claw-1', 'claw-3'].map((n) => [n, { reachable: !down.includes(n), free: 1, sick: false }])
		),
	} as never);
}

/** claw-1 online and carrying every floor label, so the floor holds and only
 *  the node-offline check speaks; claw-3 a JIT registration in `jit` state. */
const jitListing = (jit: string) => ({
	runners: [
		{
			name: 'claw-1',
			status: 'online',
			busy: false,
			labels: [...clawLabels(), ...hokonLabels().slice(1)],
		},
		{
			name: 'jit-claw-3-hadoku_site-j2-r1-1792638584',
			status: jit,
			busy: false,
			labels: clawLabels(),
		},
		{ name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
	],
});

test('runner-health: an unreachable claw is SILENT on the first tick (reboot/blip)', async () => {
	probeClaws(['claw-3']);
	installFetch({ runners: jitListing('online') });
	await tick('tok');
	assert.deepEqual(offlineAlerts(), [], 'one tick offline is a blip, not an incident');
});

test('runner-health 2026-10-22: an OFFLINE JIT registration on a reachable claw is not a dead node', async () => {
	// claw-8 was written up "OFFLINE for 20 min" at 03:16Z while it minted
	// and ran a job every few minutes: two ticks each caught a JIT runner
	// between its mint and its listener connecting, or after its job.
	probeClaws();
	for (let i = 0; i < 4; i++) {
		installFetch({ runners: jitListing('offline') });
		await tick('tok');
	}
	assert.deepEqual(offlineAlerts(), [], 'a JIT registration is not the box');
});

test('runner-health: a dead claw is ONE ledger line, and does not ring the channel', async () => {
	probeClaws(['claw-3']);
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	installFetch({ runners: jitListing('offline') });
	await tick('tok');

	const alerts = offlineAlerts();
	assert.equal(alerts.length, 1, alerts.join(' | '));
	assert.match(alerts[0]!, /`claw-3` OFFLINE for 20 min/);
	assert.match(alerts[0]!, /nothing is queuing/);
	// 24 of the 114 runner-health pings in the fifteen days to 2026-08-28 were
	// this condition announcing that redundancy had done its job.
	assert.equal(
		discordPosts.filter((m) => m.includes('OFFLINE for')).length,
		0,
		'a covered box going down is a morning-read item, not a ping'
	);
});

test('runner-health: ticks down must be CONSECUTIVE — one between them that saw the node up resets it', async () => {
	probeClaws(['claw-3']);
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	probeClaws();
	installFetch({
		runners: { runners: jitListing('online').runners.filter((r) => !r.name.startsWith('jit-')) },
	});
	await tick('tok');
	probeClaws(['claw-3']);
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	assert.deepEqual(offlineAlerts(), [], 'two blips an hour apart are not 20 minutes down');
});

test('runner-health: a sustained outage backs off instead of pinging hourly forever', async () => {
	probeClaws(['claw-3']);
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	assert.equal(offlineAlerts().length, 1);

	// Six more ticks (~1h of real time) with no clock advance: the ladder must
	// hold it at one message. Before the backoff this produced a message an hour
	// forever, which is what actually spammed the channel on 2026-08-15.
	for (let i = 0; i < 6; i++) {
		installFetch({ runners: jitListing('offline') });
		await tick('tok');
	}
	assert.equal(offlineAlerts().length, 1, 'still one — the re-alert is not due yet');
});

test('runner-health: a returning claw clears, so the next outage alerts immediately', async () => {
	probeClaws(['claw-3']);
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	assert.equal(offlineAlerts().length, 1);

	probeClaws();
	installFetch({ runners: jitListing('online') });
	await tick('tok');
	assert.equal(offlineAlerts().length, 1, 'recovery is silent');

	probeClaws(['claw-3']);
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	assert.equal(offlineAlerts().length, 2, 'a fresh outage is not swallowed by the backoff');
});

/** A STANDING node's two instances — hokon and its twin — with claw-1 online
 *  carrying every floor label, so the floor holds while hokon is down. */
const hokonTwins = (a: string, b: string) => ({
	runners: [
		{
			name: 'claw-1',
			status: 'online',
			busy: false,
			labels: [...clawLabels(), ...hokonLabels().slice(1)],
		},
		{ name: 'hokon', status: a, busy: false, labels: hokonLabels() },
		{ name: 'hokon-tenhands', status: b, busy: false, labels: hokonLabels() },
	],
});

test('runner-health: a dead STANDING node is ONE message naming every instance', async () => {
	probeClaws();
	installFetch({ runners: hokonTwins('offline', 'offline') });
	await tick('tok');
	installFetch({ runners: hokonTwins('offline', 'offline') });
	await tick('tok');
	const alerts = offlineAlerts();
	assert.equal(alerts.length, 1, alerts.join(' | '));
	assert.match(alerts[0]!, /`hokon` \(hokon, hokon-tenhands\) OFFLINE/);
});

test('runner-health: one instance down while its twin serves is NOT a dead node', async () => {
	// That is a runner fault, not a box needing hands, and the label floor
	// already answers the capacity question.
	probeClaws();
	installFetch({ runners: hokonTwins('offline', 'online') });
	await tick('tok');
	installFetch({ runners: hokonTwins('offline', 'online') });
	await tick('tok');
	assert.deepEqual(offlineAlerts(), [], 'half a node is not a node outage');
});

test('runner-health: a full claw outage does NOT double-page per node', async () => {
	// Every claw down trips the backstop (which pages on its own) and sets
	// `floorAlreadyBreached` via `clawsOnline === 0`. A second message per dead
	// box for one root cause is the noise this guard exists to prevent.
	const allDown = () => ({
		runners: [
			{ name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			{ name: 'claw-3', status: 'offline', busy: false, labels: clawLabels() },
			{ name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
		],
	});
	installFetch({ runners: allDown() });
	await tick('tok');
	installFetch({ runners: allDown() });
	await tick('tok');
	// Asserted against the LEDGER, not against Discord. The per-node notice is
	// a quiet record — its only producer is `quietRecorder`, which this harness
	// routes to `quietRecords` — so checking `discordPosts` for it was vacuously
	// true and had been since the ledger conversion. Deleting the suppression
	// entirely would not have failed it.
	assert.deepEqual(
		offlineAlerts(),
		[],
		`no per-node degraded alert during a floor breach; got: ${offlineAlerts().join(' | ')}`
	);
});
