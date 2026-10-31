/**
 * The findings `doctorFindings` derives from a `$health` facet, and the
 * thresholds that demote a node.
 *
 * THE THRESHOLD TESTS ARE MUTATION TESTS BY CONSTRUCTION. Each asserts against
 * the EXPORTED constant and against a measured value on either side of it, so
 * moving the constant moves the expected class and the test fails. They are
 * safety controls — a node at 100 °C under load and a node with 9 % free on /
 * are demotion inputs — so `pnpm run check` passing is not evidence on its own;
 * the lane's report records the reverted-and-restored exit codes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { healthRecord } from './doctor-facet.mjs';
import {
	ADVISORY,
	BLOCKING,
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
	advisoryFindings,
	blockingFindings,
	doctorFindings,
	guestAdvisory,
} from './doctor-findings.mjs';
import {
	CLAW1,
	CLAW5,
	CLAW9,
	HOKON,
	facetOf,
	NOW,
	find,
	FAILED_CLAW3,
	FAILED_CLAW4,
	failedFacet,
	PM2_CLAW6,
	pm2Facet,
} from './doctor-fixtures.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// FINDINGS — CLASS
// ═══════════════════════════════════════════════════════════════════════════

void test('BLOCKING is the default: an unrecognised class fails the gate', () => {
	// Same property preflight.mjs holds, inherited by importing its filter rather
	// than by reimplementing it. A classifier that has to opt IN to silence
	// cannot silence anything by accident.
	const made = [{ class: 'whatever' }, { class: undefined }, { class: ADVISORY }];
	assert.equal(blockingFindings(made).length, 2);
	assert.equal(advisoryFindings(made).length, 1);
});

void test('every "I could not look" finding is BLOCKING and carries its reason', () => {
	// hokon: no passwordless sudo, so SMART was refused. A refusal must never
	// render as a pass, and the finding must say WHICH refusal it was — a missing
	// smartctl, a sudo refusal and a USB bridge are three different jobs.
	const fs = doctorFindings(facetOf(HOKON), { nowMs: NOW });
	const smart = find(fs, 'smart-health');
	assert.equal(smart.length, 1);
	assert.equal(smart[0].class, BLOCKING);
	assert.equal(smart[0].status, 'unreadable');
	assert.match(smart[0].why, /sudo -n was refused/);
});

void test('a node with NO die sensor fails rather than passing silently', () => {
	const h = facetOf(
		`DOCTOR-BEGIN v1\nD hostname claw-x\nU idle.sensors no readable sensor under /sys/class/thermal or /sys/class/hwmon\nD disk.root.totalKb 100\nD disk.root.availKb 90\nD smart.device sda\nS SMART overall-health self-assessment test result: PASSED\nS   9 Power_On_Hours          0x0032   100   100   000    Old_age   Always       -       10\nDOCTOR-END claw-x`
	);
	const fs = find(doctorFindings(h, { nowMs: NOW }), 'thermal-sensor');
	assert.equal(fs[0].class, BLOCKING);
	assert.equal(fs[0].status, 'no-die-sensor');
});

void test('a watchdog unit that does not EXIST is a fact, not a finding', () => {
	// hokon has no `watchdog` package — it is a claw safety control. Judging the
	// production host by the claws' rule reported it BLOCKING for not running
	// software nobody installed there.
	const h = facetOf(HOKON);
	assert.equal(h.watchdog.enabled, 'not-found');
	assert.equal(find(doctorFindings(h, { nowMs: NOW }), 'watchdog').length, 0);
	// A unit that exists and is stopped IS a finding: claw-1 rebooted four times
	// on 2026-08-17 with this exact state.
	const stopped = facetOf(CLAW1.replace('D watchdog.active active', 'D watchdog.active inactive'));
	const w = find(doctorFindings(stopped, { nowMs: NOW }), 'watchdog');
	assert.equal(w[0].class, BLOCKING);
	assert.equal(w[0].status, 'not-running');
});

void test('any watchdog load trigger is a finding; none is silent', () => {
	// claw-8, 2026-10-30: only max-load-1 = 64 was written, the daemon derived a
	// 15-minute ceiling of 32, and a responsive node was rebooted at 52/48/34.
	assert.equal(facetOf(CLAW1).watchdog.loadTrigger, 'none');
	const loaded = facetOf(
		CLAW1.replace('D watchdog.loadTrigger none', 'D watchdog.loadTrigger max-load-1=64')
	);
	assert.equal(loaded.watchdog.loadTrigger, 'max-load-1=64');
	const w = find(doctorFindings(loaded, { nowMs: NOW }), 'watchdog');
	assert.equal(w.length, 1);
	assert.equal(w[0].class, ADVISORY);
	assert.equal(w[0].status, 'load-trigger');
});

void test('a radio nothing connected is advisory; the two writers DISAGREEING is not', () => {
	const agreed = doctorFindings(facetOf(HOKON), { nowMs: NOW });
	const a = find(agreed, 'wifi-link');
	assert.equal(a[0].class, ADVISORY);
	assert.equal(a[0].status, 'not-connected');
	// NetworkManager claiming `connected` over a kernel link that is down means
	// one of the two is lying about the link the fleet falls back on.
	const lying = HOKON.replace(
		'WMGR dev wlp13s0:wifi:disconnected:',
		'WMGR dev wlp13s0:wifi:connected:ExampleNet'
	);
	const l = find(doctorFindings(facetOf(lying), { nowMs: NOW }), 'wifi-link');
	assert.equal(l[0].class, BLOCKING);
	assert.equal(l[0].status, 'contradicts');
});

void test('a SPLIT radio is blocking — a stale route outlives its carrier', () => {
	// claw-7, live on 2026-09-10: NM holds wlp9s0 while ifupdown still holds
	// enp8s0 from before the conversion.
	const split = CLAW1.replace(
		'WMGR dev enp4s0:ethernet:unavailable:',
		'WMGR dev enp4s0:ethernet:unavailable:\nWMGR ifupdown enp4s0'
	);
	const h = facetOf(split);
	assert.equal(h.network.wifiManager, 'split');
	const fs = find(doctorFindings(h, { nowMs: NOW }), 'wifi-manager');
	assert.equal(fs[0].class, BLOCKING);
});

void test('a staged reboot is judged by preflight, not by a second copy of the rule', () => {
	const fs = find(doctorFindings(facetOf(HOKON), { nowMs: NOW }), 'pending-reboot');
	assert.equal(fs.length, 1);
	assert.equal(fs[0].class, ADVISORY, 'staged 11d ago, inside the 30d window');
	// TIME MAKES IT STRICTER. Past the escalation window the same record blocks.
	const later = doctorFindings(facetOf(HOKON), { nowMs: NOW + 40 * 86_400_000 });
	assert.equal(find(later, 'pending-reboot')[0].class, BLOCKING);
});

void test("a staged reboot names the reboot cycle's last decision, and a held node blocks", () => {
	const h = facetOf(HOKON);
	h.reboot.cycle = { status: 'deferred', why: 'dkms missing for 6.12.113: wl.ko.xz', at: 'T1' };
	const fs = find(doctorFindings(h, { nowMs: NOW }), 'pending-reboot');
	assert.match(
		fs[0].why,
		/last looked at T1: deferred — dkms missing for 6\.12\.113: wl\.ko\.xz\./
	);
	assert.equal(find(doctorFindings(h, { nowMs: NOW }), 'reboot-held').length, 0);
	h.reboot.cycle = { status: 'held', why: 'booted the old kernel', at: 'T2' };
	const held = find(doctorFindings(h, { nowMs: NOW }), 'reboot-held');
	assert.equal(held[0].class, BLOCKING);
	assert.match(held[0].why, /fleet drain .* --undo/);
});

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

/**
 * The `thermal` blocks of every recorded `$health`, verbatim out of
 * `<stateDir>/health.json` (claw-1/2/3/5/6/hokon recorded 2026-09-10, claw-4
 * 09-19, claw-8 09-21, claw-9 09-22) — the rewrite's "every other node's
 * verdict unchanged" claim, stated as a pin instead of a promise. The expected
 * map below is what the PRE-tracking rule produced on these same records; the
 * tracking rule must reproduce every one of them, with the single documented
 * exception of claw-5's status TEXT (same BLOCKING class, now saying honestly
 * that tracking cannot be judged).
 */
const RECORDED_THERMAL = {
	'claw-1': {
		sensor: 'hwmon.3.coretemp.Package_id_0',
		idleC: 61,
		loadC: 97,
		riseC: 36,
		loadSeconds: 60,
		loadWorkers: 8,
		idleSensors: {
			'hwmon.0.acpitz.temp1': 28,
			'hwmon.0.acpitz.temp2': 30,
			'hwmon.0.acpitz.temp3': 60,
			'hwmon.3.coretemp.Core_0': 56,
			'hwmon.3.coretemp.Core_1': 56,
			'hwmon.3.coretemp.Core_2': 54,
			'hwmon.3.coretemp.Core_3': 50,
			'hwmon.3.coretemp.Package_id_0': 61,
			'zone.0.acpitz': 28,
			'zone.1.acpitz': 30,
			'zone.2.acpitz': 60,
			'zone.3.x86_pkg_temp': 61,
		},
		loadSensors: {
			'hwmon.0.acpitz.temp1': 28,
			'hwmon.0.acpitz.temp2': 30,
			'hwmon.0.acpitz.temp3': 98,
			'hwmon.3.coretemp.Core_0': 98,
			'hwmon.3.coretemp.Core_1': 92,
			'hwmon.3.coretemp.Core_2': 88,
			'hwmon.3.coretemp.Core_3': 80,
			'hwmon.3.coretemp.Package_id_0': 97,
			'zone.0.acpitz': 28,
			'zone.1.acpitz': 30,
			'zone.2.acpitz': 98,
			'zone.3.x86_pkg_temp': 98,
		},
	},
	'claw-2': {
		sensor: 'hwmon.4.coretemp.Package_id_0',
		idleC: 37,
		loadC: 67,
		riseC: 30,
		loadSeconds: 60,
		loadWorkers: 8,
		idleSensors: {
			'hwmon.1.nvme.Composite': 36,
			'hwmon.1.nvme.Sensor_1': 39,
			'hwmon.2.pch_skylake.temp1': 32,
			'hwmon.4.coretemp.Core_0': 37,
			'hwmon.4.coretemp.Core_1': 36,
			'hwmon.4.coretemp.Core_2': 36,
			'hwmon.4.coretemp.Core_3': 37,
			'hwmon.4.coretemp.Package_id_0': 37,
			'zone.0.pch_skylake': 33,
			'zone.1.GEN1': 35,
			'zone.3.GEN2': 35,
			'zone.4.GEN5': 35,
			'zone.5.GEN7': 33,
			'zone.6.B0D4': 37,
			'zone.7.x86_pkg_temp': 37,
		},
		loadSensors: {
			'hwmon.1.nvme.Composite': 41,
			'hwmon.1.nvme.Sensor_1': 41,
			'hwmon.2.pch_skylake.temp1': 49,
			'hwmon.4.coretemp.Core_0': 67,
			'hwmon.4.coretemp.Core_1': 65,
			'hwmon.4.coretemp.Core_2': 67,
			'hwmon.4.coretemp.Core_3': 65,
			'hwmon.4.coretemp.Package_id_0': 67,
			'zone.0.pch_skylake': 49,
			'zone.1.GEN1': 37,
			'zone.3.GEN2': 41,
			'zone.4.GEN5': 42,
			'zone.5.GEN7': 36,
			'zone.6.B0D4': 68,
			'zone.7.x86_pkg_temp': 68,
		},
	},
	'claw-3': {
		sensor: 'hwmon.6.coretemp.Package_id_0',
		idleC: 45,
		loadC: 95,
		riseC: 50,
		loadSeconds: 60,
		loadWorkers: 4,
		idleSensors: {
			'hwmon.1.acpitz.temp1': 40,
			'hwmon.1.acpitz.temp2': 0,
			'hwmon.1.acpitz.temp3': 33,
			'hwmon.1.acpitz.temp4': 37,
			'hwmon.1.acpitz.temp5': 35,
			'hwmon.1.acpitz.temp6': 30,
			'hwmon.1.acpitz.temp7': 33,
			'hwmon.4.nvme.Composite': 38,
			'hwmon.4.nvme.Sensor_1': 38,
			'hwmon.5.pch_skylake.temp1': 38,
			'hwmon.6.coretemp.Core_0': 45,
			'hwmon.6.coretemp.Core_1': 46,
			'hwmon.6.coretemp.Package_id_0': 45,
			'zone.0.acpitz': 40,
			'zone.1.acpitz': 0,
			'zone.2.acpitz': 33,
			'zone.3.acpitz': 37,
			'zone.4.acpitz': 35,
			'zone.5.acpitz': 30,
			'zone.6.acpitz': 33,
			'zone.7.pch_skylake': 38,
			'zone.8.x86_pkg_temp': 44,
		},
		loadSensors: {
			'hwmon.1.acpitz.temp1': 95,
			'hwmon.1.acpitz.temp3': 34,
			'hwmon.1.acpitz.temp4': 43,
			'hwmon.1.acpitz.temp5': 35,
			'hwmon.1.acpitz.temp6': 30,
			'hwmon.1.acpitz.temp7': 33,
			'hwmon.4.nvme.Composite': 40,
			'hwmon.4.nvme.Sensor_1': 40,
			'hwmon.5.pch_skylake.temp1': 60,
			'hwmon.6.coretemp.Core_0': 95,
			'hwmon.6.coretemp.Core_1': 94,
			'hwmon.6.coretemp.Package_id_0': 95,
			'zone.0.acpitz': 95,
			'zone.2.acpitz': 34,
			'zone.3.acpitz': 43,
			'zone.4.acpitz': 35,
			'zone.5.acpitz': 30,
			'zone.6.acpitz': 33,
			'zone.7.pch_skylake': 60,
			'zone.8.x86_pkg_temp': 95,
		},
	},
	'claw-4': {
		sensor: 'hwmon.3.coretemp.Package_id_0',
		idleC: 33,
		loadC: 73,
		riseC: 40,
		loadSeconds: 60,
		loadWorkers: 8,
		idleSensors: {
			'hwmon.0.acpitz.temp1': 28,
			'hwmon.0.acpitz.temp2': 30,
			'hwmon.1.pch_skylake.temp1': 46,
			'hwmon.2.dell_smm.CPU': 32,
			'hwmon.3.coretemp.Core_0': 29,
			'hwmon.3.coretemp.Core_1': 29,
			'hwmon.3.coretemp.Core_2': 28,
			'hwmon.3.coretemp.Core_3': 29,
			'hwmon.3.coretemp.Package_id_0': 33,
			'hwmon.4.nouveau.temp1': 44,
			'zone.0.acpitz': 28,
			'zone.1.acpitz': 30,
			'zone.2.pch_skylake': 46,
			'zone.3.x86_pkg_temp': 33,
		},
		loadSensors: {
			'hwmon.0.acpitz.temp1': 28,
			'hwmon.0.acpitz.temp2': 30,
			'hwmon.1.pch_skylake.temp1': 46,
			'hwmon.2.dell_smm.CPU': 73,
			'hwmon.3.coretemp.Core_0': 73,
			'hwmon.3.coretemp.Core_1': 73,
			'hwmon.3.coretemp.Core_2': 70,
			'hwmon.3.coretemp.Core_3': 71,
			'hwmon.3.coretemp.Package_id_0': 73,
			'hwmon.4.nouveau.temp1': 45,
			'zone.0.acpitz': 28,
			'zone.1.acpitz': 30,
			'zone.2.pch_skylake': 46,
			'zone.3.x86_pkg_temp': 73,
		},
	},
	'claw-5': {
		sensor: 'hwmon.1.k10temp.temp1',
		idleC: 19,
		loadC: 24,
		riseC: 5,
		loadSeconds: 60,
		loadWorkers: 8,
		idleSensors: { 'hwmon.1.k10temp.temp1': 19, 'hwmon.2.nouveau.temp1': 39 },
		loadSensors: { 'hwmon.1.k10temp.temp1': 24, 'hwmon.2.nouveau.temp1': 39 },
	},
	'claw-6': {
		sensor: 'hwmon.2.coretemp.Package_id_0',
		idleC: 32,
		loadC: 60,
		riseC: 28,
		loadSeconds: 60,
		loadWorkers: 4,
		idleSensors: {
			'hwmon.0.acpitz.temp1': 28,
			'hwmon.0.acpitz.temp2': 30,
			'hwmon.2.coretemp.Core_0': 30,
			'hwmon.2.coretemp.Core_1': 30,
			'hwmon.2.coretemp.Core_2': 28,
			'hwmon.2.coretemp.Core_3': 29,
			'hwmon.2.coretemp.Package_id_0': 32,
			'zone.0.acpitz': 28,
			'zone.1.acpitz': 30,
			'zone.2.x86_pkg_temp': 32,
		},
		loadSensors: {
			'hwmon.0.acpitz.temp1': 28,
			'hwmon.0.acpitz.temp2': 30,
			'hwmon.2.coretemp.Core_0': 60,
			'hwmon.2.coretemp.Core_1': 61,
			'hwmon.2.coretemp.Core_2': 55,
			'hwmon.2.coretemp.Core_3': 59,
			'hwmon.2.coretemp.Package_id_0': 60,
			'zone.0.acpitz': 28,
			'zone.1.acpitz': 30,
			'zone.2.x86_pkg_temp': 60,
		},
	},
	'claw-8': {
		sensor: 'hwmon.3.coretemp.Package_id_0',
		idleC: 32,
		loadC: 68,
		riseC: 36,
		loadSeconds: 60,
		loadWorkers: 8,
		idleSensors: {
			'hwmon.0.nvme.Composite': 35,
			'hwmon.0.nvme.Sensor_1': 35,
			'hwmon.0.nvme.Sensor_2': 43,
			'hwmon.1.nct6791.AUXTIN0': 23,
			'hwmon.1.nct6791.AUXTIN1': 103,
			'hwmon.1.nct6791.AUXTIN2': 27,
			'hwmon.1.nct6791.AUXTIN3': 23,
			'hwmon.1.nct6791.CPUTIN': 30,
			'hwmon.1.nct6791.PCH_CHIP_CPU_MAX_TEMP': 0,
			'hwmon.1.nct6791.PCH_CHIP_TEMP': 0,
			'hwmon.1.nct6791.PCH_CPU_TEMP': 0,
			'hwmon.1.nct6791.PCH_DIM0_TEMP': 0,
			'hwmon.1.nct6791.PCH_MCH_TEMP': 0,
			'hwmon.1.nct6791.PECI_Agent_0': 32,
			'hwmon.1.nct6791.SYSTIN': 30,
			'hwmon.2.pch_cannonlake.temp1': 44,
			'hwmon.3.coretemp.Core_0': 31,
			'hwmon.3.coretemp.Core_1': 30,
			'hwmon.3.coretemp.Core_2': 30,
			'hwmon.3.coretemp.Core_3': 32,
			'hwmon.3.coretemp.Core_4': 31,
			'hwmon.3.coretemp.Core_5': 32,
			'hwmon.3.coretemp.Core_6': 31,
			'hwmon.3.coretemp.Core_7': 30,
			'hwmon.3.coretemp.Package_id_0': 32,
			'hwmon.4.iwlwifi_1.temp1': 42,
			'zone.0.pch_cannonlake': 44,
			'zone.1.iwlwifi_1': 42,
			'zone.2.x86_pkg_temp': 40,
		},
		loadSensors: {
			'hwmon.0.nvme.Composite': 35,
			'hwmon.0.nvme.Sensor_1': 35,
			'hwmon.0.nvme.Sensor_2': 43,
			'hwmon.1.nct6791.AUXTIN0': 23,
			'hwmon.1.nct6791.AUXTIN1': 103,
			'hwmon.1.nct6791.AUXTIN2': 27,
			'hwmon.1.nct6791.AUXTIN3': 23,
			'hwmon.1.nct6791.CPUTIN': 38,
			'hwmon.1.nct6791.PECI_Agent_0': 68,
			'hwmon.1.nct6791.SYSTIN': 30,
			'hwmon.2.pch_cannonlake.temp1': 45,
			'hwmon.3.coretemp.Core_0': 66,
			'hwmon.3.coretemp.Core_1': 63,
			'hwmon.3.coretemp.Core_2': 68,
			'hwmon.3.coretemp.Core_3': 67,
			'hwmon.3.coretemp.Core_4': 68,
			'hwmon.3.coretemp.Core_5': 67,
			'hwmon.3.coretemp.Core_6': 65,
			'hwmon.3.coretemp.Core_7': 63,
			'hwmon.3.coretemp.Package_id_0': 68,
			'hwmon.4.iwlwifi_1.temp1': 42,
			'zone.0.pch_cannonlake': 45,
			'zone.1.iwlwifi_1': 42,
			'zone.2.x86_pkg_temp': 68,
		},
	},
	'claw-9': {
		sensor: 'hwmon.1.coretemp.Package_id_0',
		idleC: 40,
		loadC: 48,
		riseC: 8,
		loadSeconds: 60,
		loadWorkers: 12,
		idleSensors: {
			'hwmon.1.coretemp.Core_0': 34,
			'hwmon.1.coretemp.Core_1': 33,
			'hwmon.1.coretemp.Core_2': 34,
			'hwmon.1.coretemp.Core_3': 31,
			'hwmon.1.coretemp.Core_4': 34,
			'hwmon.1.coretemp.Core_5': 36,
			'hwmon.1.coretemp.Package_id_0': 40,
			'zone.0.x86_pkg_temp': 40,
		},
		loadSensors: {
			'hwmon.1.coretemp.Core_0': 45,
			'hwmon.1.coretemp.Core_1': 42,
			'hwmon.1.coretemp.Core_2': 47,
			'hwmon.1.coretemp.Core_3': 40,
			'hwmon.1.coretemp.Core_4': 47,
			'hwmon.1.coretemp.Core_5': 47,
			'hwmon.1.coretemp.Package_id_0': 48,
			'zone.0.x86_pkg_temp': 48,
		},
	},
	hokon: {
		sensor: 'hwmon.5.k10temp.Tccd1',
		idleC: 88,
		loadC: 99,
		riseC: 11,
		loadSeconds: 60,
		loadWorkers: 12,
		idleSensors: {
			'hwmon.0.nvme.Composite': 44,
			'hwmon.0.nvme.Sensor_1': 49,
			'hwmon.0.nvme.Sensor_2': 44,
			'hwmon.1.nvme.Composite': 46,
			'hwmon.2.nvme.Composite': 48,
			'hwmon.3.nvme.Composite': 52,
			'hwmon.3.nvme.Sensor_1': 56,
			'hwmon.3.nvme.Sensor_2': 52,
			'hwmon.4.amdgpu.edge': 45,
			'hwmon.5.k10temp.Tccd1': 88,
			'hwmon.5.k10temp.Tctl': 87,
			'hwmon.6.spd5118.temp1': 38,
			'hwmon.7.spd5118.temp1': 38,
			'hwmon.8.mt7921_phy0.temp1': 38,
		},
		loadSensors: {
			'hwmon.0.nvme.Composite': 44,
			'hwmon.0.nvme.Sensor_1': 50,
			'hwmon.0.nvme.Sensor_2': 44,
			'hwmon.1.nvme.Composite': 46,
			'hwmon.2.nvme.Composite': 48,
			'hwmon.3.nvme.Composite': 52,
			'hwmon.3.nvme.Sensor_1': 58,
			'hwmon.3.nvme.Sensor_2': 52,
			'hwmon.4.amdgpu.edge': 46,
			'hwmon.5.k10temp.Tccd1': 99,
			'hwmon.5.k10temp.Tctl': 97,
			'hwmon.6.spd5118.temp1': 38,
			'hwmon.7.spd5118.temp1': 38,
			'hwmon.8.mt7921_phy0.temp1': 40,
		},
	},
};

void test('the recorded fleet: every node’s thermal verdict is unchanged by the tracking rewrite', () => {
	// status → class, per node, as the PRE-tracking rule read these exact
	// records (verified 2026-09-22 by replaying both rules over health.json).
	// null = no cpu-thermal finding at all. claw-5's entry is the one honest
	// difference: same BLOCKING class, status now says what is actually known.
	// claw-9 here is its 09-22 record (rise +8, above the trigger); the +7
	// shape that the old rule blocked is the claw-9 fixture above.
	const expected = {
		'claw-1': ['hot', ADVISORY],
		'claw-2': null,
		'claw-3': ['hot', ADVISORY],
		'claw-4': null,
		'claw-5': ['tracking-unjudgeable', BLOCKING],
		'claw-6': null,
		'claw-8': null,
		'claw-9': null,
		hokon: ['hot', ADVISORY],
	};
	for (const [node, thermal] of Object.entries(RECORDED_THERMAL)) {
		const fs = find(
			doctorFindings({ node, reachable: true, thermal }, { nowMs: NOW }),
			'cpu-thermal'
		);
		const got = fs.length ? [fs[0].status, fs[0].class] : null;
		assert.deepEqual(
			got,
			expected[node],
			`${node}: the tracking rule changed a verdict that was not claw-9's`
		);
	}
	assert.equal(Object.keys(expected).length, 9, 'every recorded node is pinned');
});

// --- the wiring: the classifier must be what `fleet doctor` actually exits on ---
//
// Same reasoning as `preflight.test.mjs`'s wiring block: a classifier nothing
// calls is worse than none, because the gate then looks role-aware and pages on
// a guest anyway.

test('doctor-run.mjs applies the guest role before deciding its exit code', () => {
	const src = readFileSync(
		resolve(dirname(fileURLToPath(import.meta.url)), 'doctor-run.mjs'),
		'utf8'
	);
	assert.match(
		src,
		/const classified = guestAdvisory\(findings, GUESTS\)/,
		'`fleet doctor` no longer applies the guest role to its findings'
	);
	assert.match(
		src,
		/const GUESTS = guestNodeNames\(manifest\)/,
		'and the guest set must come from the manifest role'
	);
	assert.match(
		src,
		/const blocking = blockingFindings\(classified\)/,
		'and its blocking set no longer comes from the classifier'
	);
	assert.match(
		src,
		/const advisory = advisoryFindings\(classified\)/,
		'a guest finding classified out of `blocking` must still land in `advisory`'
	);
});

test('a guest’s findings come back advisory, except the one it is in scope for', () => {
	// Driven through `doctorFindings`' real output rather than a hand-made
	// finding, so this measures the categories the facet actually produces.
	const fs = guestAdvisory(doctorFindings(facetOf(CLAW1), { nowMs: NOW }), new Set(['claw-1']));
	assert.ok(fs.length > 0, 'the fixture must produce findings, or this asserts nothing');
	assert.equal(blockingFindings(fs).length, 0, 'nothing about a guest blocks');
	assert.equal(advisoryFindings(fs).length, fs.length, 'and nothing is dropped');
	// MUTATION: as a claw the same node keeps whatever it had.
	const asClaw = doctorFindings(facetOf(CLAW1), { nowMs: NOW });
	assert.deepEqual(
		fs.map((f) => f.category),
		asClaw.map((f) => f.category),
		'the same findings, in the same order — only the class moved'
	);
});

test('an UNREACHABLE guest still blocks — the one question it IS in scope for', () => {
	const fs = guestAdvisory(
		doctorFindings({ node: 'hokon', reachable: false, why: 'ssh refused' }),
		['hokon']
	);
	assert.deepEqual(
		fs.map((f) => [f.category, f.class]),
		[['unreachable', BLOCKING]]
	);
});

void test('a failed unit is an ADVISORY finding that names the unit and its age', () => {
	const fs = find(doctorFindings(failedFacet(FAILED_CLAW3), { nowMs: NOW }), 'failed-units');
	assert.equal(fs.length, 1);
	assert.equal(fs[0].class, ADVISORY);
	assert.equal(fs[0].status, 'failed');
	assert.match(fs[0].why, /cktest-runner\.service \(since 2026-10-25T15:23:19\.000Z\)/);
	assert.equal(
		blockingFindings(doctorFindings(failedFacet(FAILED_CLAW3), { nowMs: NOW })).some(
			(f) => f.category === 'failed-units'
		),
		false,
		'a leftover unit must not refuse a node work'
	);
});

void test('no failed unit draws no finding; an unlistable node draws an advisory, never silence', () => {
	assert.equal(
		find(doctorFindings(failedFacet(FAILED_CLAW4), { nowMs: NOW }), 'failed-units').length,
		0
	);
	const blind = find(
		doctorFindings(failedFacet(["U failedUnits systemctl could not list this node's units"]), {
			nowMs: NOW,
		}),
		'failed-units'
	);
	assert.equal(blind.length, 1);
	assert.equal(blind[0].class, ADVISORY);
	assert.equal(blind[0].status, 'unknown');
});

void test('a failed actions.runner unit is left to runner-units, not reported twice', () => {
	const fs = doctorFindings(
		failedFacet([
			'D failedUnits.count 1',
			'D failedUnit.actions.runner.WolffM-hadoku_site.claw-x.service 1792941799',
			'D runners.failed 1',
		]),
		{ nowMs: NOW }
	);
	assert.equal(find(fs, 'failed-units').length, 0);
	assert.equal(find(fs, 'runner-units').length, 1);
});

void test('a STORED record from before this probe draws nothing; a fresh probe that skipped it is unknown', () => {
	// node-status re-judges stored `$health` records, and one written before
	// 2026-10-27 has no `failedUnits` key at all: it never asked.
	const { failedUnits: _, ...stored } = facetOf(CLAW1);
	assert.equal(find(doctorFindings(stored, { nowMs: NOW }), 'failed-units').length, 0);
	// A probe output parsed NOW without the count line did not answer — the
	// 2026-09-10 claw-1 capture is exactly that — and may not read as clean.
	const fresh = find(doctorFindings(facetOf(CLAW1), { nowMs: NOW }), 'failed-units');
	assert.equal(fresh.length, 1);
	assert.equal(fresh[0].status, 'unknown');
});

void test('pm2 claims render by severity, and are never stored in the record', () => {
	const h = {
		...pm2Facet(PM2_CLAW6),
		pm2Claims: [
			{
				unit: 'pm2-hadoku.service',
				claim: 'app-layer-idle',
				severity: 'advisory',
				by: 'app-layer',
				why: 'idle',
			},
			{ unit: 'pm2-x.service', claim: 'unclaimed', severity: 'fail', by: null, why: 'nobody' },
			{ unit: 'pm2-y-svc.service', claim: 'tenant', severity: 'ok', by: 'y', why: 'declared' },
		],
	};
	const fs = find(doctorFindings(h, { nowMs: NOW }), 'pm2-claims');
	assert.deepEqual(
		fs.map((f) => [f.status, f.class]),
		[
			['app-layer-idle', ADVISORY],
			['unclaimed', BLOCKING],
		]
	);
	assert.equal('pm2Claims' in healthRecord(h), false);
	// A stored record re-judged without the join (node-status) draws nothing.
	assert.equal(find(doctorFindings(healthRecord(h), { nowMs: NOW }), 'pm2-claims').length, 0);
});
