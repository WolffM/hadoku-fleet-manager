/**
 * `doctorFindings`'s numeric thresholds — the die-temperature bands, the
 * sensor-tracking rule, disk-free bands (root and `_work`), SMART hours, a
 * watchdog aimed at the wrong sensor, and a thermal zone that disagrees with
 * the die.
 *
 * THE THRESHOLD TESTS ARE MUTATION TESTS BY CONSTRUCTION. Each asserts
 * against the EXPORTED constant and against a measured value on either side
 * of it, so moving the constant moves the expected class and the test fails.
 * They are safety controls — a node at 100 °C under load and a node with 9 %
 * free on / are demotion inputs — so `pnpm run check` passing is not
 * evidence on its own; the lane's report records the reverted-and-restored
 * exit codes.
 *
 * Split out of `doctor-findings.test.mjs` (wave 5s lane B) to bring that file
 * under the 1,000-line test ceiling — a whole-block move, every test body
 * below unchanged from where it lived there. The non-threshold classification
 * tests live in `doctor-findings-classification.test.mjs`; the
 * recorded-fleet regression pin lives in `doctor-findings-regression.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { doctorFindings } from './doctor-findings.mjs';
import { ADVISORY, BLOCKING, blockingFindings } from './preflight.mjs';
import {
	DISK_ADVISORY_FREE_PCT,
	DISK_BLOCKING_FREE_PCT,
	SENSOR_DISAGREE_C,
	SENSOR_MOVED_C,
	SENSOR_TRACKS_DIVISOR,
	IMPLAUSIBLE_RISE_C,
	SMART_HOURS_ADVISORY,
	SMART_HOURS_BLOCKING,
	THERMAL_ADVISORY_C,
	THERMAL_BLOCKING_C,
} from './doctor-findings-thresholds.mjs';
import { CLAW1, CLAW5, CLAW9, HOKON, facetOf, NOW, find } from './doctor-fixtures.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// THE THRESHOLDS — MUTATION TESTS, WITH ABSOLUTE NUMBERS
// ═══════════════════════════════════════════════════════════════════════════
//
// THE FIRST VERSION OF THIS BLOCK WAS WORTHLESS AND THE MUTATION RUN PROVED IT.
// It built its inputs out of the exported constants (`loadC: THERMAL_BLOCKING_C`,
// `freePct: DISK_BLOCKING_FREE_PCT - 0.1`), so moving a constant moved the test's
// own expectation with it: five of eight deliberate mutations — 100→105 °C,
// 90→95 °C, 10→5 % free, 20→15 % free, 43 800→87 000 h — all passed green.
// That is `CLAUDE.md`'s "the reader for a facet may not read what the writer
// wrote", committed inside a test file: a verifier that derives its fixture from
// the thing under test cannot fail.
//
// So every case below is an ABSOLUTE number, chosen from the fleet as measured,
// and each threshold is ALSO pinned to its documented value directly. Moving a
// constant now fails twice: once on the value and once on the class a real
// reading resolves to.

/**
 * A real claw-1 facet with one subsystem overridden, so one threshold can be
 * exercised at a time without inventing a whole node.
 */
function facetWith(overrides) {
	const h = facetOf(CLAW1);
	return {
		...h,
		...overrides,
		thermal: { ...h.thermal, ...(overrides.thermal ?? {}) },
		smart: { ...h.smart, ...(overrides.smart ?? {}) },
		disk: { ...h.disk, ...(overrides.disk ?? {}) },
	};
}

void test('each threshold is pinned to its documented value', () => {
	assert.equal(THERMAL_BLOCKING_C, 100, 'the watchdog trip point and PROCHOT');
	assert.equal(THERMAL_ADVISORY_C, 90);
	assert.equal(DISK_BLOCKING_FREE_PCT, 10, '§H names this one');
	assert.equal(DISK_ADVISORY_FREE_PCT, 20);
	assert.equal(SMART_HOURS_ADVISORY, 43_800, 'five years of continuous power-on');
	assert.equal(SMART_HOURS_BLOCKING, 87_600, 'ten years of continuous power-on');
	assert.equal(
		IMPLAUSIBLE_RISE_C,
		8,
		'the rise that TRIGGERS the tracking question, not the verdict'
	);
	assert.equal(SENSOR_MOVED_C, 3, 'above ±1–2 °C of rounding and drift, below claw-9’s real +7');
	assert.equal(
		SENSOR_TRACKS_DIVISOR,
		3,
		'a package may trail its cores (measured 0.58–1.03), not a third'
	);
	assert.equal(SENSOR_DISAGREE_C, 20);
});

void test('a die at 100 °C under load is BLOCKING; 99 °C is ADVISORY', () => {
	// claw-8's cooler does not transfer heat: 58 °C idle to 100 °C in under five
	// seconds. claw-3 measured 99 °C on this fleet on 2026-09-10 — one degree
	// below the line — so the gap between these two cases is not hypothetical.
	const pinned = find(
		doctorFindings(facetWith({ thermal: { idleC: 58, loadC: 100, riseC: 42 } }), { nowMs: NOW }),
		'cpu-thermal'
	);
	assert.equal(pinned[0].class, BLOCKING);
	assert.equal(pinned[0].status, 'pinned');

	const justBelow = find(
		doctorFindings(facetWith({ thermal: { idleC: 47, loadC: 99, riseC: 52 } }), { nowMs: NOW }),
		'cpu-thermal'
	);
	assert.equal(justBelow[0].class, ADVISORY, 'claw-3 as measured — hot, not pinned');
	assert.equal(justBelow[0].status, 'hot');
});

void test('90 °C is the advisory floor; 89 °C reports nothing at all', () => {
	// Measured on the same 60s load, 2026-09-10: claw-1 97, claw-3 99, hokon 97
	// above the line; claw-2 66, claw-4 71, claw-6 61, claw-7 73 below it.
	const hot = find(
		doctorFindings(facetWith({ thermal: { idleC: 50, loadC: 90, riseC: 40 } }), { nowMs: NOW }),
		'cpu-thermal'
	);
	assert.equal(hot[0].class, ADVISORY);

	const cool = find(
		doctorFindings(facetWith({ thermal: { idleC: 50, loadC: 89, riseC: 39 } }), { nowMs: NOW }),
		'cpu-thermal'
	);
	assert.equal(cool.length, 0);
	// claw-7 as measured: 41 → 73 °C. Nothing to report.
	assert.equal(
		find(
			doctorFindings(facetWith({ thermal: { idleC: 41, loadC: 73, riseC: 32 } }), { nowMs: NOW }),
			'cpu-thermal'
		).length,
		0
	);
});

void test('a cool node whose sensor TRACKS is not a broken sensor — claw-9, 2026-09-21', () => {
	// THE FALSE BLOCKING THIS RULE WAS REWRITTEN FOR (lane T, 2026-09-22).
	// claw-9's i7-5930K is locked at 3.0 GHz with turbo off under a desktop
	// tower cooler; on 2026-09-21 `fleet doctor --write` recorded BLOCKING
	// `cpu-thermal/sensor-did-not-move` because its package rose 42 → 49 °C,
	// under the 8 °C line — while its six per-core sensors independently rose
	// +6…+14 °C. Every sensor on that die moved, together: the package was
	// tracking a die that stays cool, and the rule called the sensor broken for
	// measuring it. The package pair below is the 09-21 measurement verbatim;
	// the sensor map around it is the 09-22 capture of the same box, because
	// the 09-21 run's own transcript was not kept.
	const coolDie = CLAW9.replace(
		'D idle.hwmon.1.coretemp.Package_id_0 39000',
		'D idle.hwmon.1.coretemp.Package_id_0 42000'
	).replace(
		'D peak.hwmon.1.coretemp.Package_id_0 47000',
		'D peak.hwmon.1.coretemp.Package_id_0 49000'
	);
	const fs = find(doctorFindings(facetOf(coolDie), { nowMs: NOW }), 'cpu-thermal');
	assert.equal(
		fs.length,
		0,
		'rose +7 with its cores at +8…+13: tracking, and a cool die is not a finding'
	);

	// A rise of exactly 8 °C never asks the tracking question at all — the
	// entry gate is unchanged, so this boundary behaves exactly as before.
	const boundary = find(
		doctorFindings(facetWith({ thermal: { idleC: 30, loadC: 38, riseC: 8 } }), { nowMs: NOW }),
		'cpu-thermal'
	);
	assert.equal(boundary.length, 0, 'exactly the threshold is not a small rise');

	// AND THE SECOND CLAUSE: hokon rose 9 °C because it started at 88 and
	// finished at 97. A part already at its ceiling cannot rise, and must not be
	// accused of a dead sensor — so `loadC` past the advisory floor wins, then
	// as now.
	const ceiling = find(doctorFindings(facetOf(HOKON), { nowMs: NOW }), 'cpu-thermal');
	assert.equal(ceiling[0].status, 'hot');
	assert.equal(ceiling[0].class, ADVISORY);
	assert.equal(
		find(
			doctorFindings(facetWith({ thermal: { idleC: 96, loadC: 97, riseC: 1 } }), { nowMs: NOW }),
			'cpu-thermal'
		)[0].status,
		'hot'
	);
});

/**
 * A real claw-9 facet with the package's OWN rise set to a number, its map kept
 * consistent with it — so the tracking arithmetic runs on a cool node's real
 * per-core sensors (median +11.5 °C) rather than on invented maps.
 */
function claw9With(riseC) {
	const h = facetOf(CLAW9);
	const loadC = h.thermal.idleC + riseC;
	return {
		...h,
		thermal: {
			...h.thermal,
			loadC,
			riseC,
			loadSensors: { ...h.thermal.loadSensors, 'hwmon.1.coretemp.Package_id_0': loadC },
		},
	};
}

void test('a stuck package with moving cores stays BLOCKING', () => {
	// The rewrite may not get easier as the failure gets worse. The package
	// peak pinned at its idle reading — what a frozen Package_id_0 looks like —
	// while all six per-core sensors rose +8…+13 °C.
	const fs = find(doctorFindings(claw9With(0), { nowMs: NOW }), 'cpu-thermal');
	assert.equal(fs.length, 1);
	assert.equal(fs[0].class, BLOCKING);
	assert.equal(fs[0].status, 'sensor-did-not-move');
	assert.equal(fs[0].besideRiseC, 11.5, 'median of +8, +10, +11, +12, +13, +13');
	assert.equal(fs[0].besideSensors, 6);
	assert.match(fs[0].why, /did not move with/);
});

void test('a die that rose but not WITH its cores is not tracking either', () => {
	// +3 °C is movement (above the noise floor) but less than a third of the
	// +11.5 °C the package's own cores rose — a reading responding to something
	// other than the die. +4 °C, exactly a third, is a package honestly lagging
	// its hotspots.
	assert.equal(
		find(doctorFindings(claw9With(3), { nowMs: NOW }), 'cpu-thermal')[0].status,
		'sensor-did-not-move'
	);
	assert.equal(find(doctorFindings(claw9With(4), { nowMs: NOW }), 'cpu-thermal').length, 0);
});

void test('everything stuck stays BLOCKING — the shared blind spot of same-chip readings', () => {
	// Neither the die nor any sensor beside it moved: the whole suite is frozen
	// (or the load never loaded). This is exactly the case a same-driver
	// cross-check could otherwise wave through, so it blocks on its own.
	const frozen = claw9With(0);
	frozen.thermal.loadSensors = frozen.thermal.idleSensors;
	const fs = find(doctorFindings(frozen, { nowMs: NOW }), 'cpu-thermal');
	assert.equal(fs.length, 1);
	assert.equal(fs[0].class, BLOCKING);
	assert.equal(fs[0].status, 'nothing-moved-under-load');
});

void test('a node with only ONE sensor says tracking cannot be judged — and is not called healthy', () => {
	// claw-5's FX-8350 exposes exactly one k10temp channel with nothing CPU
	// beside it (the nouveau is a GPU). Its +5 °C under a minute of all-core
	// load, against a fleet that moved 29–47 °C, stays a BLOCKING — but the
	// honest finding is that tracking CANNOT be judged on one reading, not that
	// the number alone proves the sensor dead.
	const fs = find(doctorFindings(facetOf(CLAW5), { nowMs: NOW }), 'cpu-thermal');
	assert.equal(fs.length, 1);
	assert.equal(fs[0].class, BLOCKING);
	assert.equal(fs[0].status, 'tracking-unjudgeable');
	assert.equal(fs[0].riseC, 5);
	assert.match(fs[0].why, /only CPU sensor/);
	// "Not called healthy" is a claim about the run, not the prose: the finding
	// must survive the classifier `fleet doctor` exits on.
	assert.ok(
		blockingFindings(doctorFindings(facetOf(CLAW5), { nowMs: NOW })).some(
			(fd) => fd.category === 'cpu-thermal'
		),
		'the single-sensor finding is in the blocking set'
	);
});

void test('/ at 9.9% free is BLOCKING, 10% advisory, 19.9% advisory, 20% clean', () => {
	const band = (freePct) =>
		find(
			doctorFindings(facetWith({ disk: { freePct, availKb: 1, totalKb: 100 } }), { nowMs: NOW }),
			'disk-free'
		);

	assert.equal(band(9.9)[0].class, BLOCKING);
	assert.equal(band(9.9)[0].status, 'full');
	assert.equal(band(10)[0].class, ADVISORY, 'exactly the threshold is not full');
	assert.equal(band(10)[0].status, 'tight');
	assert.equal(band(19.9)[0].class, ADVISORY);
	assert.equal(band(20).length, 0);
	// The fleet as measured, 2026-09-10: the tightest root filesystem is hokon at
	// 43.6% and claw-2 at 59.7%. Nothing on this fleet is near either band today,
	// which is why the numbers above are written out rather than sampled.
	assert.equal(band(43.6).length, 0);

	// A disk that could not be READ is blocking too, with its reason.
	const blind = find(
		doctorFindings(facetWith({ disk: { freePct: null, why: 'df said nothing' } }), { nowMs: NOW }),
		'disk-free'
	);
	assert.equal(blind[0].class, BLOCKING);
	assert.match(blind[0].why, /df said nothing/);
});

// ═══════════════════════════════════════════════════════════════════════════
// `_work` — wave 4c §F, "doctor reports where the space went"
// ═══════════════════════════════════════════════════════════════════════════

void test('_work absent (same disk as /, or could not tell) draws no second finding', () => {
	// `facetOf(CLAW1)` never set `disk.work` at all — the real 2026-09-10
	// capture predates this field, which is also the honest "old doctorProbe,
	// nothing to report" case.
	assert.equal(facetOf(CLAW1).disk.work, null);
	assert.equal(find(doctorFindings(facetOf(CLAW1), { nowMs: NOW }), 'disk-work-free').length, 0);
});

void test('_work at 9.9% free is BLOCKING, 10% advisory, 19.9% advisory, 20% clean — same bands as /', () => {
	const band = (freePct) =>
		find(
			doctorFindings(
				facetWith({ disk: { work: { fs: 'ext4', freePct, totalKb: 100, availKb: 1 } } }),
				{ nowMs: NOW }
			),
			'disk-work-free'
		);

	assert.equal(band(9.9)[0].class, BLOCKING);
	assert.equal(band(9.9)[0].status, 'full');
	assert.equal(band(10)[0].class, ADVISORY, 'exactly the threshold is not full');
	assert.equal(band(19.9)[0].class, ADVISORY);
	assert.equal(band(20).length, 0, 'clean — and the root disk-free finding is a SEPARATE category');
});

void test('_work unreadable is its own finding, distinct from an unreadable root', () => {
	const fs = find(
		doctorFindings(
			facetWith({ disk: { work: { fs: 'ext4', freePct: null, why: 'df said nothing on _work' } } }),
			{ nowMs: NOW }
		),
		'disk-work-free'
	);
	assert.equal(fs[0].class, BLOCKING);
	assert.match(fs[0].why, /df said nothing on _work/);
});

void test('91,529h is BLOCKING, 87,600h is BLOCKING, 43,800h advisory, 43,799h clean', () => {
	// claw-7's root SSD measured 91,529 power-on hours on 2026-09-10, still
	// reporting PASSED with 67% lifetime remaining. It is BLOCKING from the day
	// this lands; see the constant's own note for why that is the design.
	const hours = (powerOnHours, lifetimeRemainingPct = null) =>
		find(
			doctorFindings(
				facetWith({
					smart: { device: 'sda', health: 'PASSED', powerOnHours, lifetimeRemainingPct },
				}),
				{ nowMs: NOW }
			),
			'smart-hours'
		);

	const claw7 = hours(91_529, 67);
	assert.equal(claw7[0].class, BLOCKING);
	assert.equal(claw7[0].status, 'beyond-service-life');
	assert.equal(claw7[0].powerOnHours, 91_529);

	assert.equal(hours(87_600)[0].class, BLOCKING, 'exactly ten years is past it');
	assert.equal(hours(87_599)[0].class, ADVISORY);
	assert.equal(hours(43_800)[0].class, ADVISORY, 'exactly five years is aging');
	assert.equal(hours(43_800)[0].status, 'aging');
	assert.equal(hours(43_799).length, 0);
	// The rest of the fleet as measured: claw-3 31,388h, claw-6 23,335h,
	// claw-1 19,727h, claw-4 14,561h, claw-5 3,583h, claw-2 352h — all clean.
	for (const h of [31_388, 23_335, 19_727, 14_561, 3_583, 352]) {
		assert.equal(hours(h).length, 0, `${h}h must report nothing`);
	}
});

void test('a drive whose firmware says it is failing is BLOCKING at any age', () => {
	const fs = doctorFindings(
		facetWith({ smart: { device: 'sda', health: 'FAILED!', powerOnHours: 100 } }),
		{ nowMs: NOW }
	);
	assert.equal(find(fs, 'smart-health')[0].class, BLOCKING);
	assert.equal(find(fs, 'smart-health')[0].status, 'failing');
});

void test('a drive that answered but reported no age is BLOCKING, not assumed young', () => {
	const fs = doctorFindings(
		facetWith({ smart: { device: 'sda', health: 'PASSED', powerOnHours: null } }),
		{ nowMs: NOW }
	);
	assert.equal(find(fs, 'smart-hours')[0].class, BLOCKING);
	assert.equal(find(fs, 'smart-hours')[0].status, 'unreadable');
});

void test('a watchdog aimed at a sensor that disagrees with the die cannot protect the box', () => {
	// The 2026-08-17 failure mode, stated as a test: the guard was watching an
	// ambient sensor and could not see the fault that was rebooting the machine.
	const aimed = CLAW1.replace('D watchdog.sensorMilliC 62000', 'D watchdog.sensorMilliC 29800');
	const fs = find(doctorFindings(facetOf(aimed), { nowMs: NOW }), 'watchdog');
	assert.equal(fs[0].class, BLOCKING);
	assert.equal(fs[0].status, 'wrong-sensor');
});

void test('a zone reading far above the die is its OWN advisory, not a hot CPU', () => {
	const noisy = CLAW1.replace('D idle.zone.2.acpitz 61000', 'D idle.zone.2.acpitz 96000');
	const fs = find(doctorFindings(facetOf(noisy), { nowMs: NOW }), 'thermal-sensor');
	assert.equal(fs.length, 1);
	assert.equal(fs[0].class, ADVISORY);
	assert.equal(fs[0].sensor, 'zone.2.acpitz');
	// And a GPU or NVMe sensor on another device is NOT a suspect CPU sensor:
	// claw-5's nouveau idles 20 °C above its FX-8350's k10temp reading.
	assert.equal(find(doctorFindings(facetOf(CLAW5), { nowMs: NOW }), 'thermal-sensor').length, 0);
});
