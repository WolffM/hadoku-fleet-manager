/**
 * Fleet panel capacity arithmetic: the mintable half is re-based onto the
 * FRESH probe (every claw-capacity figure runner-health publishes is
 * `standing + mintable`, and the mintable addend is a pure function of the
 * ssh probe, so serving the tick-time copy rendered a healthy garage as a
 * dark one for ten minutes after every deploy), `clawsReady` counts
 * MACHINES rather than slots, and the admission budget — `admissionFree`/
 * `admissionCapacity`/`admissionBasis` — measures an ephemeral node against
 * the dispatcher's own `maxConcurrent` rather than the tier ladder's number,
 * because the ladder gates nothing on an ephemeral node. Split out of
 * fleet-report.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/fleet-report-rig.ts` for the shared `NO_JOBS`/`health`/
 * `upProbe`/`slot`/`MANIFEST` fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFleetReport } from '../routes/fleet.js';
import {
	NO_JOBS,
	health,
	upProbe,
	slot,
	MANIFEST,
	installFleetReportRig,
} from './helpers/fleet-report-rig.js';

installFleetReportRig();

// ── the mintable half is re-based onto the FRESH probe ──────────────────────
//
// Every claw-capacity figure runner-health publishes is `standing + mintable`,
// and the mintable addend is a pure function of the ssh probe: the health tick
// reads it every 10 minutes, this route holds it at 60 seconds. Under all-JIT
// that addend is the WHOLE fleet, so serving the tick-time copy rendered a
// healthy garage as a dark one for ten minutes after every deploy.

const ALL_JIT = {
	'claw-1': { cores: 8, maxConcurrent: 3, labels: ['hadoku-builder'], ephemeral: true },
	'claw-2': { cores: 8, maxConcurrent: 2, labels: ['hadoku-builder'], ephemeral: true },
	hokon: { cores: 12, maxConcurrent: 4, labels: ['pm2-host'] },
};

test('a blind-window health tick does NOT render as a dark fleet', () => {
	// The exact shape measured on 2026-09-02: mgmt-api restarted at 15:34:00,
	// the health tick ran at 15:34:19 with no probe yet and published zeroes,
	// and the probe at 15:36:09 showed both claws up with three free mint slots.
	const r = buildFleetReport(
		health({
			clawsOnline: 0,
			claws_free: 0,
			claws_free_standing: 0,
			claws_free_mintable: 0,
			claws_mintable_online: 0,
			ephemeral_unknown: true,
		}),
		{
			at: 'fresh',
			nodes: {
				'claw-1': upProbe({ workers: 0, capacity: 2, free: 2 }),
				'claw-2': upProbe({ workers: 0, capacity: 1, free: 1 }),
			},
		},
		ALL_JIT,
		NO_JOBS
	);
	// 5, not the probes' `free` of 2+1: these are ephemeral nodes, so the figure
	// counts what the DISPATCHER will admit (maxConcurrent 3 and 2, no workers)
	// rather than what the tier ladder budgets. The assertion this test exists
	// for is that it is non-zero and came from the FRESH probe — the blind-window
	// tick published zeroes.
	assert.equal(slot(r, 'mintable'), 5, 'the fresh probe is what the panel shows');
	assert.ok(slot(r, 'mintable')! > 0, 'a measured fleet is not a dark one');
	assert.equal(r.fleet.clawsOnline, 2, 'two reachable JIT claws, not zero');
	assert.equal(r.fleet.capacity.free, 5, 'standing 0 + mintable 5');
	assert.equal(r.fleet.capacity.unmeasured, false, 'we DID look — this route had the probe');
});

test('the STANDING half is left to the census, not re-derived', () => {
	// It depends on the runner listing, which only the 10-minute loop holds.
	// A panel showing a fresh probe beside a stale listing is what the two
	// timestamps in the header are for.
	const r = buildFleetReport(
		health({
			clawsOnline: 5,
			claws_free: 4,
			claws_free_standing: 4,
			claws_free_mintable: 0,
			claws_mintable_online: 0,
		}),
		{ at: 'fresh', nodes: { 'claw-1': upProbe({ free: 2 }) } },
		ALL_JIT,
		NO_JOBS
	);
	assert.equal(slot(r, 'immediate'), 4, 'untouched');
	// claw-2 is declared ephemeral and absent from a snapshot that EXISTS, so it
	// counts down — guessing upward is how a real outage stays invisible.
	assert.equal(slot(r, 'mintable'), 2);
	assert.equal(r.fleet.clawsOnline, 5 - 0 + 1, 'standing 5 re-based with one live claw');
});

test('NO probe at all on an ephemeral fleet is UNMEASURED, not zero', () => {
	const r = buildFleetReport(
		health({ clawsOnline: 0, claws_free: 0, claws_free_standing: 0, claws_mintable_online: 0 }),
		null,
		ALL_JIT,
		NO_JOBS
	);
	assert.equal(r.fleet.capacity.unmeasured, true);
	assert.equal(slot(r, 'mintable'), null, 'null, never 0 — the panel must say so');
});

test('a fleet with no ephemeral nodes is always MEASURED, probe or not', () => {
	// `ephemeralUnknown` must not fire on a purely standing fleet, or the panel
	// would caveat every number forever on a fleet that has nothing to mint.
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	assert.equal(r.fleet.capacity.unmeasured, false);
});

// ── clawsReady: MACHINES, not slots ─────────────────────────────────────────
//
// The panel led with `clawsFree`, which counts SLOTS. On an all-JIT fleet that
// is routinely larger than the fleet itself — "0 standing · 10 mintable" over
// six machines — and reads as a bug rather than as capacity.

test('clawsReady counts MACHINES that can take a job, not their slots', () => {
	const r = buildFleetReport(
		health({
			claws_ready: 0,
			claws_ready_standing: 0,
			claws_free_standing: 0,
			claws_mintable_online: 0,
			clawsOnline: 0,
		}),
		{
			at: 'fresh',
			nodes: {
				// Three machines, six slots between them.
				'claw-1': upProbe({ workers: 0, capacity: 3, free: 3 }),
				'claw-2': upProbe({ workers: 0, capacity: 2, free: 2 }),
				'claw-3': upProbe({ workers: 0, capacity: 1, free: 1 }),
			},
		},
		{
			'claw-1': { maxConcurrent: 3, labels: [], ephemeral: true },
			'claw-2': { maxConcurrent: 2, labels: [], ephemeral: true },
			'claw-3': { maxConcurrent: 1, labels: [], ephemeral: true },
		},
		NO_JOBS
	);
	assert.equal(r.fleet.capacity.ready, 3, 'three machines');
	assert.equal(slot(r, 'mintable'), 6, 'six slots — a different question');
});

test('a machine with no free slot is ONLINE but not READY', () => {
	// The distinction the headline needs: a saturated fleet is fully online.
	const r = buildFleetReport(
		health({ claws_ready_standing: 0, claws_mintable_online: 0, clawsOnline: 0 }),
		{
			at: 'fresh',
			nodes: {
				'claw-1': upProbe({ workers: 2, capacity: 2, free: 0 }),
				'claw-2': upProbe({ workers: 0, capacity: 2, free: 2 }),
			},
		},
		{
			'claw-1': { maxConcurrent: 2, labels: [], ephemeral: true },
			'claw-2': { maxConcurrent: 2, labels: [], ephemeral: true },
		},
		NO_JOBS
	);
	assert.equal(r.fleet.clawsOnline, 2, 'both boxes are up');
	assert.equal(r.fleet.capacity.ready, 1, 'only one can take the next job');
});

test('clawsReady re-bases onto the fresh probe like every other mintable figure', () => {
	// The blind-window rule, applied to the headline number. A health tick taken
	// 20s after a restart publishes zeroes; the route holds a 60s-old probe.
	const r = buildFleetReport(
		health({ claws_ready: 0, claws_ready_standing: 0, claws_mintable_online: 0, clawsOnline: 0 }),
		{ at: 'fresh', nodes: { 'claw-1': upProbe({ workers: 0, capacity: 2, free: 2 }) } },
		{ 'claw-1': { maxConcurrent: 2, labels: [], ephemeral: true } },
		NO_JOBS
	);
	assert.equal(r.fleet.capacity.ready, 1, 'the fresh probe wins, as it does for state');
});

test('with NO probe, clawsReady falls back to the tick rather than inventing one', () => {
	const r = buildFleetReport(
		health({ claws_ready: 4, claws_ready_standing: 4, claws_mintable_online: 0 }),
		null,
		MANIFEST,
		NO_JOBS
	);
	assert.equal(r.fleet.capacity.ready, 4);
});

test('floorBreach is GONE from the wire', () => {
	// It was computed from ONLINE STANDING runners carrying each required label,
	// so on an all-JIT fleet — where nothing standing carries any label — it read
	// true permanently while work was being placed and completed normally. Its
	// only consumer was a red banner saying every job would queue, which was
	// false every time it rendered. `checkLabelFloor` is the real alert and is
	// untouched.
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	assert.equal('floorBreach' in r.fleet, false, 'a field both wrong and unread is not a contract');
});

// ── the budget that actually admits work ────────────────────────────────────
//
// `capacity`/`free` are the TIER LADDER's numbers. On an ephemeral node the
// ladder gates nothing — `ephemeral-tick` builds its candidate list from every
// ephemeral node and uses the ladder only as a preference order, and
// `admitMint` tests `maxConcurrent`. Showing the ladder's number as
// "schedulable" printed "full" on nodes with room to mint twice more.

const ADMISSION_MANIFEST = {
	// tierCapacity 1, but the dispatcher will run 3 at once.
	'claw-3': { cores: 4, maxConcurrent: 3, labels: [], ephemeral: true },
	// A standing node: the ladder's budget is the real one.
	hokon: { cores: 12, maxConcurrent: 4, labels: ['pm2-host'] },
};

test('an EPHEMERAL node is measured against the dispatcher budget', () => {
	const r = buildFleetReport(
		null,
		{
			at: 'now',
			nodes: { 'claw-3': upProbe({ workers: 1, capacity: 1, free: 0 }) },
		},
		ADMISSION_MANIFEST,
		NO_JOBS
	);
	const c = r.machines.find((m) => m.name === 'claw-3')!;
	assert.equal(c.free, 0, "the ladder's number is untouched");
	assert.equal(c.capacity, 1, 'and so is its denominator');
	assert.equal(c.admissionFree, 2, 'maxConcurrent 3 - 1 worker: two more mints fit');
	assert.equal(c.admissionCapacity, 3);
	assert.equal(c.admissionBasis, 'dispatcher');
});

test('a STANDING node is admitted against its probed budget, and says so', () => {
	const r = buildFleetReport(
		null,
		{ at: 'now', nodes: { hokon: upProbe({ workers: 1, capacity: 4, free: 3 }) } },
		ADMISSION_MANIFEST,
		NO_JOBS
	);
	const h = r.machines.find((m) => m.name === 'hokon')!;
	assert.equal(h.admissionFree, 3);
	assert.equal(h.admissionCapacity, 4);
	assert.equal(h.admissionBasis, 'standing');
});

test('admission is null when the node was not reached — never a guess', () => {
	const r = buildFleetReport(
		null,
		{ at: 'now', nodes: { 'claw-3': upProbe({ reachable: false }) } },
		ADMISSION_MANIFEST,
		NO_JOBS
	);
	const c = r.machines.find((m) => m.name === 'claw-3')!;
	assert.equal(c.admissionFree, null);
	assert.equal(c.admissionBasis, null);
});

test('more workers than the budget clamps to 0, never negative', () => {
	// A budget lowered while jobs were running. A negative free renders as a bar
	// running backwards over its neighbours.
	const r = buildFleetReport(
		null,
		{ at: 'now', nodes: { 'claw-3': upProbe({ workers: 9, capacity: 1, free: 0 }) } },
		ADMISSION_MANIFEST,
		NO_JOBS
	);
	assert.equal(r.machines.find((m) => m.name === 'claw-3')!.admissionFree, 0);
});

test('clawsFreeMintable counts what can actually START', () => {
	// The headline card's slot figure. Summing the ladder's numbers reported 7
	// where the dispatcher would take 12 (measured 2026-09-02, six JIT claws).
	const r = buildFleetReport(
		health({ claws_ready_standing: 0, claws_mintable_online: 0, clawsOnline: 0 }),
		{
			at: 'now',
			nodes: {
				'claw-3': upProbe({ workers: 1, capacity: 1, free: 0 }),
				'claw-9': upProbe({ workers: 0, capacity: 1, free: 1 }),
			},
		},
		{
			...ADMISSION_MANIFEST,
			'claw-9': { cores: 8, maxConcurrent: 2, labels: [], ephemeral: true },
		},
		NO_JOBS
	);
	// ladder would say 0 + 1 = 1; the dispatcher will take (3-1) + (2-0) = 4.
	assert.equal(slot(r, 'mintable'), 4);
});

test('the ladder inputs are NOT re-based — that would move the backstop', () => {
	// `capacity`/`free` feed worstRepoFreeSlots -> decideTiers, and the census's
	// own clawsFree gates isAtCapacity -> a saturation promote of the production
	// host. Re-basing them here would be a scheduling change dressed as a display
	// fix, so the probe's numbers must survive untouched.
	const probe = { at: 'now', nodes: { 'claw-3': upProbe({ workers: 1, capacity: 1, free: 0 }) } };
	const r = buildFleetReport(null, probe, ADMISSION_MANIFEST, NO_JOBS);
	assert.equal(probe.nodes['claw-3'].free, 0, 'the probe object itself is not mutated');
	assert.equal(r.machines.find((m) => m.name === 'claw-3')!.free, 0);
});
