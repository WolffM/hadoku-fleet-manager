/**
 * #129: doctor's cpu-thermal and cpu-clock bars against the node's own range.
 * Shapes are the live health.json records of 2026-11-22: claw-1 reached 97 °C
 * under 60 s of all-core load, claw-5's clock reached 1400 of 4300 MHz.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	DOCTOR_CLOCK_WEAK,
	DOCTOR_THERMAL_WEAK,
	DOCTOR_QUANTITIES,
	doctorReadings,
	judgeDoctor,
} from './doctor-baseline.mjs';
import { clockFindings } from './doctor-findings-clock.mjs';
import { thermalFindings } from './doctor-findings-thermal.mjs';
import { learnReading } from './node-baselines.mjs';

const AT = new Date().toISOString();
const SENSOR = 'hwmon.3.coretemp.Package_id_0';

const claw1 = (loadC) => ({
	node: 'claw-1',
	thermal: {
		sensor: SENSOR,
		idleC: 62,
		loadC,
		riseC: loadC - 62,
		loadSeconds: 60,
		loadWorkers: 8,
		idleSensors: { [SENSOR]: 62, 'hwmon.3.coretemp.Core_0': 60 },
		loadSensors: { [SENSOR]: loadC, 'hwmon.3.coretemp.Core_0': loadC - 2 },
	},
});
const claw5 = (loadBestMhz) => ({
	node: 'claw-5',
	clock: { ceilingMhz: 4300, ceilingSource: 'msr-pstate', loadBestMhz, loadSamples: 20 },
});
const seeded = (key, value) => ({
	[DOCTOR_QUANTITIES[key].quantity]: learnReading(
		undefined,
		value,
		DOCTOR_QUANTITIES[key].spec,
		AT,
		false
	),
});
const stamped = (h, quantities) => ({ ...h, baseline: judgeDoctor(h, quantities, AT).stamp });
const cats = (fs) => fs.map((x) => `${x.category}/${x.status}/${x.class}`);

void test('the readings: the die under load, and the clock as a share of its ceiling', () => {
	assert.deepEqual(doctorReadings(claw1(97)), [{ key: 'loadTempC', value: 97 }]);
	assert.deepEqual(doctorReadings(claw5(1400)), [{ key: 'clockShare', value: 0.33 }]);
	assert.deepEqual(doctorReadings({ thermal: { sensor: SENSOR, loadC: null } }), []);
});

void test('an unstamped record keeps the fixed lines: hot at 97 °C, stuck at 33 %', () => {
	assert.deepEqual(cats(thermalFindings(claw1(97))), ['cpu-thermal/hot/advisory']);
	assert.deepEqual(cats(clockFindings(claw5(1400))), ['cpu-clock/stuck/advisory']);
});

void test('a store that could not be read keeps the fixed lines too', () => {
	const h = { ...claw1(97), baseline: { at: AT, unreadable: 'bad json' } };
	assert.deepEqual(cats(thermalFindings(h)), ['cpu-thermal/hot/advisory']);
});

void test('claw-1 at 97 °C inside its own range: no finding, a weak point', () => {
	const h = claw1(97);
	const j = judgeDoctor(h, seeded('loadTempC', 98), AT);
	assert.equal(j.stamp.loadTempC.verdict, 'within');
	assert.deepEqual(
		j.window.weak.map((w) => w.test),
		[DOCTOR_THERMAL_WEAK]
	);
	assert.deepEqual(thermalFindings({ ...h, baseline: j.stamp }), []);
});

void test('the first reading is learning: the weak point is recorded and nothing is a finding', () => {
	const h = stamped(claw1(97), {});
	assert.equal(h.baseline.loadTempC.verdict, 'learning');
	assert.deepEqual(thermalFindings(h), []);
});

void test('a die 10 °C hotter than its range is advisory drift, whatever the fleet line', () => {
	const hot = stamped(claw1(85), seeded('loadTempC', 75));
	assert.deepEqual(cats(thermalFindings(hot)), ['cpu-thermal/drift/advisory']);
	assert.match(
		thermalFindings(hot)[0].why,
		/85 °C is worse than claw-1's own range 75 °C ± 6 °C \(n=1\)/
	);
});

void test('the blocking line stays absolute: 100 °C is pinned on any node', () => {
	const h = stamped(claw1(100), seeded('loadTempC', 99));
	assert.deepEqual(cats(thermalFindings(h)), ['cpu-thermal/pinned/blocking']);
	assert.deepEqual(judgeDoctor(claw1(100), {}, AT).window.weak, []);
});

void test('claw-5 at 1400 of 4300 MHz inside its range: a weak point; a newly stuck clock is drift', () => {
	const steady = stamped(claw5(1400), seeded('clockShare', 0.33));
	assert.deepEqual(clockFindings(steady), []);
	assert.deepEqual(
		judgeDoctor(claw5(1400), {}, AT).window.weak.map((w) => w.test),
		[DOCTOR_CLOCK_WEAK]
	);
	const dropped = stamped(claw5(1400), seeded('clockShare', 0.95));
	assert.deepEqual(cats(clockFindings(dropped)), ['cpu-clock/drift/advisory']);
});

void test('a node back over the line clears its weak point', () => {
	const j = judgeDoctor({ ...claw1(80), ...claw5(4200) }, {}, AT);
	assert.deepEqual(j.window.weak, []);
	assert.deepEqual(j.window.cleared.sort(), [DOCTOR_CLOCK_WEAK, DOCTOR_THERMAL_WEAK].sort());
});

void test("a die reading the thermal judge distrusts is not learned (claw-5's relative k10temp)", () => {
	const h = {
		node: 'claw-5',
		thermal: { sensor: 'hwmon.1.k10temp.temp1', loadC: 22 },
		...claw5(1400),
	};
	assert.deepEqual(
		judgeDoctor(h, {}, AT, { dieUntrusted: true }).window.readings.map((r) => r.quantity),
		['doctor.clockShare']
	);
});
