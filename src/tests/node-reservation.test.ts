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
	dailyCronMinutes,
	inDeclaredCronWindow,
	nodeReservation,
	noteCronStart,
	noteCronEnd,
	inFlightCronJobs,
	setPm2HostBusy,
	getPm2HostBusy,
	__resetReservationForTesting,
} from '../node-reservation.js';
import { PM2_HOST_LABEL } from '../capabilities.js';

beforeEach(() => __resetReservationForTesting());

const PROFILES = [
	{ name: 'local-daily', schedule: { cron: '0 8 * * *', timezone: 'Etc/UTC' } },
	{ name: 'mail-sync', schedule: { cron: '*/10 * * * *', timezone: 'Etc/UTC' } },
	{ name: 'scrape-weekly', schedule: { cron: '0 6 * * SUN', timezone: 'Etc/UTC' } },
	{ name: 'late', schedule: { cron: '30 23 * * *', timezone: 'Etc/UTC' } },
];

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 25, h, m));

// ── cron parsing: narrow ON PURPOSE ─────────────────────────────────────────

test('dailyCronMinutes: parses a plain daily expression', () => {
	assert.equal(dailyCronMinutes('0 8 * * *'), 480);
	assert.equal(dailyCronMinutes('30 23 * * *'), 23 * 60 + 30);
});

test('dailyCronMinutes: anything not plainly daily returns null, never a guess', () => {
	// A half-understood cron parser that mis-fires a reservation is worse than
	// none: it would strand the prod host off CI at a time nobody predicted.
	// These contribute no declared window and fall through to the live counter.
	assert.equal(dailyCronMinutes('*/10 * * * *'), null, 'step');
	assert.equal(dailyCronMinutes('0 6 * * SUN'), null, 'day-of-week');
	assert.equal(dailyCronMinutes('0 1,2 * * *'), null, 'list');
	assert.equal(dailyCronMinutes('0 8 1 * *'), null, 'day-of-month');
	assert.equal(dailyCronMinutes('bogus'), null);
	assert.equal(dailyCronMinutes(undefined), null);
	assert.equal(dailyCronMinutes('99 99 * * *'), null, 'out of range');
});

// ── the declared window ─────────────────────────────────────────────────────

test('inDeclaredCronWindow: inside a daily profile window', () => {
	assert.equal(inDeclaredCronWindow(at(8, 5), PROFILES, 90), 'local-daily');
	assert.equal(inDeclaredCronWindow(at(9, 29), PROFILES, 90), 'local-daily');
});

test('inDeclaredCronWindow: outside every window', () => {
	assert.equal(inDeclaredCronWindow(at(12, 0), PROFILES, 90), null);
	assert.equal(inDeclaredCronWindow(at(7, 59), PROFILES, 90), null, 'before the cron fires');
	assert.equal(inDeclaredCronWindow(at(9, 30), PROFILES, 90), null, 'window is half-open');
});

test('inDeclaredCronWindow: a window WRAPS across midnight', () => {
	// 23:30 + 90m covers 00:00-01:00 the next day. Getting this wrong would fail
	// open exactly during the quiet hours the ladder exists to protect.
	assert.equal(inDeclaredCronWindow(at(0, 30), PROFILES, 90), 'late');
	assert.equal(inDeclaredCronWindow(at(1, 30), PROFILES, 90), null);
});

test('inDeclaredCronWindow: a non-UTC profile is ignored rather than guessed', () => {
	const local = [{ name: 'x', schedule: { cron: '0 8 * * *', timezone: 'America/Los_Angeles' } }];
	assert.equal(inDeclaredCronWindow(at(8, 5), local, 90), null);
});

// ── the live counter ────────────────────────────────────────────────────────

test('nodeReservation: an in-flight cron job reserves the node', () => {
	assert.equal(nodeReservation(at(12), false, PROFILES).reserved, false);
	noteCronStart();
	const r = nodeReservation(at(12), false, PROFILES);
	assert.equal(r.reserved, true);
	assert.equal(r.reason, 'cron-running');
	noteCronEnd();
	assert.equal(nodeReservation(at(12), false, PROFILES).reserved, false, 'released immediately');
});

test('nodeReservation: the live counter never goes negative', () => {
	// An unbalanced release would make the counter negative and permanently
	// disable the reservation, silently.
	noteCronEnd();
	noteCronEnd();
	assert.equal(inFlightCronJobs(), 0);
	noteCronStart();
	assert.equal(inFlightCronJobs(), 1);
	assert.equal(nodeReservation(at(12), false, PROFILES).reserved, true);
});

test('nodeReservation: pm2-host work reserves the node', () => {
	const r = nodeReservation(at(12), true, PROFILES);
	assert.equal(r.reserved, true);
	assert.equal(r.reason, 'pm2-host');
});

test('nodeReservation: the LIVE signal outranks the declared window', () => {
	// Both true at once must report the one that is actually observed, so the
	// panel says "cron running" rather than the weaker "inside a window".
	noteCronStart();
	assert.equal(nodeReservation(at(8, 5), false, PROFILES).reason, 'cron-running');
});

test('nodeReservation: quiet node outside any window is free', () => {
	const r = nodeReservation(at(12), false, PROFILES);
	assert.equal(r.reserved, false);
	assert.equal(r.reason, null);
});

// ── the rung transfers with the label, not with the hostname (#6) ───────────

test('nodeReservation is NODE-BLIND, so the ladder moves with the label', () => {
	// `pm2-host` became a probed capability on 2026-09-15 (#6), so a claw can earn
	// it and migration one's box will. The reservation must transfer with the
	// LABEL rather than stay attached to a hostname, and the way that is achieved
	// here is that this function never learns one: a clock, a rung and a schedule.
	//
	// `nodeReservation` itself is checked by the compiler — it has no node
	// parameter to pass — so what is asserted here is that the WRITER is the whole
	// node→rung mapping this module has, and that it takes NODES rather than one
	// fleet-wide rung. The day it goes back to a bare boolean, the two-holder case
	// below is unrepresentable again.
	setPm2HostBusy(['claw-2']);
	assert.equal(getPm2HostBusy('claw-2'), true);
	assert.equal(nodeReservation(at(12), getPm2HostBusy('claw-2'), PROFILES).reason, 'pm2-host');
	// Identical answer for hokon if hokon is the holder — the function cannot
	// tell them apart, which is the point.
	setPm2HostBusy(['hokon']);
	assert.equal(nodeReservation(at(12), getPm2HostBusy('hokon'), PROFILES).reason, 'pm2-host');
});

test('the reservation reason IS the registry id, so a rename cannot drift', () => {
	// The command station renders this token beside the ladder it derives from
	// `capabilities.ladder()`. Spelled twice, they drift; compared here, they
	// cannot.
	assert.equal(nodeReservation(at(12), true, PROFILES).reason, PM2_HOST_LABEL);
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
