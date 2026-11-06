/**
 * The priority ladder: pm2-host > hadoku-builder > taskauto.
 *
 * What these pin is that hokon comes OFF builder duty while it is doing work
 * that outranks CI — above all the nightly cron set, which GitHub cannot see at
 * all (cron-worker never touches the Actions API), so no runner label can ever
 * represent it.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
	nodeReservation,
	noteCronStart,
	noteCronEnd,
	inFlightCronJobs,
	__resetReservationForTesting,
} from '../node-reservation.js';
import { setPm2HostBusy, getPm2HostBusy } from '../pm2-host-busy-store.js';
import { PM2_HOST_LABEL } from '../lib/capability-registry-ids.js';

beforeEach(() => __resetReservationForTesting());

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 25, h, m));

// ── the live counter ────────────────────────────────────────────────────────

test('nodeReservation: an in-flight cron job reserves the node', () => {
	assert.equal(nodeReservation(at(12), false).reserved, false);
	noteCronStart();
	const r = nodeReservation(at(12), false);
	assert.equal(r.reserved, true);
	assert.equal(r.reason, 'cron-running');
	noteCronEnd();
	assert.equal(nodeReservation(at(12), false).reserved, false, 'released immediately');
});

test('nodeReservation: the live counter never goes negative', () => {
	// An unbalanced release would make the counter negative and permanently
	// disable the reservation, silently.
	noteCronEnd();
	noteCronEnd();
	assert.equal(inFlightCronJobs(), 0);
	noteCronStart();
	assert.equal(inFlightCronJobs(), 1);
	assert.equal(nodeReservation(at(12), false).reserved, true);
});

test('nodeReservation: pm2-host work reserves the node', () => {
	const r = nodeReservation(at(12), true);
	assert.equal(r.reserved, true);
	assert.equal(r.reason, 'pm2-host');
});

test('nodeReservation: a schedule reserves nothing — only work that is running', () => {
	// Until 2026-11-06 each daily cron-worker profile opened a 90-minute window
	// here. Three overlapping ones held hokon off CI from 06:00 to 09:30Z against
	// ~27 minutes of real work. 08:05 is inside where local-daily's window was:
	// with nothing in flight, nothing is reserved.
	assert.deepEqual(nodeReservation(at(8, 5), false), {
		reserved: false,
		reason: null,
		detail: null,
	});
	noteCronStart();
	assert.equal(
		nodeReservation(at(8, 5), false).reason,
		'cron-running',
		'running work still reserves'
	);
});

test('nodeReservation: a quiet node is free', () => {
	const r = nodeReservation(at(12), false);
	assert.equal(r.reserved, false);
	assert.equal(r.reason, null);
});

// ── the rung transfers with the label, not with the hostname (#6) ───────────

test('nodeReservation is NODE-BLIND, so the ladder moves with the label', () => {
	// `pm2-host` became a probed capability on 2026-09-15 (#6), so a claw can earn
	// it and migration one's box will. The reservation must transfer with the
	// LABEL rather than stay attached to a hostname, and the way that is achieved
	// here is that this function never learns one: a clock and a rung.
	//
	// `nodeReservation` itself is checked by the compiler — it has no node
	// parameter to pass — so what is asserted here is that the WRITER is the whole
	// node→rung mapping this module has, and that it takes NODES rather than one
	// fleet-wide rung. The day it goes back to a bare boolean, the two-holder case
	// below is unrepresentable again.
	setPm2HostBusy(['claw-2']);
	assert.equal(getPm2HostBusy('claw-2'), true);
	assert.equal(nodeReservation(at(12), getPm2HostBusy('claw-2')).reason, 'pm2-host');
	// Identical answer for hokon if hokon is the holder — the function cannot
	// tell them apart, which is the point.
	setPm2HostBusy(['hokon']);
	assert.equal(nodeReservation(at(12), getPm2HostBusy('hokon')).reason, 'pm2-host');
});

test('the reservation reason IS the registry id, so a rename cannot drift', () => {
	// The command station renders this token beside the ladder it derives from
	// `capabilities.ladder()`. Spelled twice, they drift; compared here, they
	// cannot.
	assert.equal(nodeReservation(at(12), true).reason, PM2_HOST_LABEL);
	assert.equal(PM2_HOST_LABEL, 'pm2-host');
});

test('the pm2-host rung is PER NODE — two holders do not collapse into one answer', () => {
	// THE BUG THIS CLOSES. It was one module-level boolean until 2026-09-16, which
	// was exact only while hokon alone carried `pm2-host`. With two holders the
	// flag answered about the FLEET while every caller was asking about a BOX, and
	// it was wrong in both directions: a busy claw held an idle hokon off builder
	// work, and an idle claw cleared a busy one.
	setPm2HostBusy(['claw-2']);
	assert.equal(getPm2HostBusy('claw-2'), true, 'the holder that is busy');
	assert.equal(getPm2HostBusy('hokon'), false, 'the holder that is not — NOT the fleet answer');

	// A node nobody published is not busy. Absence is the safe direction here:
	// the rung withholds capacity, so a false `true` strands a box out of CI.
	assert.equal(getPm2HostBusy('claw-9'), false, 'unknown node');

	// The writer publishes the WHOLE set, so a node that dropped off the listing
	// stops being busy without anyone remembering to clear it.
	setPm2HostBusy(['hokon']);
	assert.equal(getPm2HostBusy('claw-2'), false, 'no longer in the published set');
	assert.equal(getPm2HostBusy('hokon'), true);

	__resetReservationForTesting();
	assert.equal(getPm2HostBusy('hokon'), false);
});

test('the no-argument reader is the fleet-wide collapse, and it is deliberate', () => {
	// `tickFleet` in fleet-loop.ts still asks without a node — it reserves tiers
	// by `RESERVABLE_NODES` membership rather than per machine, so it has none to
	// give. Pinned rather than left implicit: this over-reserves (a busy holder
	// anywhere forces hokon's tier off), which spends capacity rather than
	// correctness, and it is the last fleet-blind reader of this rung.
	setPm2HostBusy(['claw-2']);
	assert.equal(getPm2HostBusy(), true, 'ANY holder busy');
	assert.equal(getPm2HostBusy('hokon'), false, 'and the per-node answer disagrees with it');
	setPm2HostBusy([]);
	assert.equal(getPm2HostBusy(), false);
});
