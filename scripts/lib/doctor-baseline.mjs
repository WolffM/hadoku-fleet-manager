/**
 * doctor-baseline — `fleet doctor`'s two CPU bars judged against the node's
 * OWN learned range (hadoku-fleet-manager#129, operator 2026-11-21: the
 * fleet's hardware is fixed as it stands).
 *
 * The bars were fixed numbers for every box: a package past THERMAL_ADVISORY_C
 * (90 °C) under a minute of all-core load, and a clock under
 * CLOCK_STUCK_FRACTION of its ceiling. claw-1, claw-3 and claw-5 miss them every
 * night and always will. A finding that can never clear teaches every reader to
 * ignore the facet. So, as `fleet qualify` does (lib/qualify-baseline.mjs):
 *
 *   - a bar the node misses while it reads inside its own range is a WEAK
 *     POINT in node-baselines.json, shown on its status, never a finding;
 *   - a reading OUTSIDE the node's range, either way, is an advisory DRIFT
 *     finding, and the range re-learns at the reading;
 *   - the blocking bars stay absolute: THERMAL_BLOCKING_C is the watchdog trip
 *     and PROCHOT, where the next sustained job throttles or reboots the box,
 *     and a sensor that does not track the die is a fault on any hardware.
 *
 * WHERE IT HAPPENS. The judging is done ONCE, by the run that probed: doctor-run
 * stamps `health.baseline` before it learns, and `--write` keeps the stamp in
 * health.json. The findings (doctor-findings-thermal/clock.mjs) read the stamp,
 * so every later reader of the record (node-status, --from-record) sees the
 * verdict the probe got, not one re-judged against a range that has since
 * learned the very reading. A record with no stamp, or a stamp that could not
 * read the store, keeps the fixed bars: a gate never gets easier because the
 * baseline could not be read.
 */
import { judgeReading } from './node-baselines.mjs';
import {
	CLOCK_STUCK_FRACTION,
	THERMAL_ADVISORY_C,
	THERMAL_BLOCKING_C,
} from './doctor-findings-thresholds.mjs';

/** The weak-point ids doctor writes, beside qualify's test ids. */
export const DOCTOR_THERMAL_WEAK = 'doctor:cpu-thermal';
export const DOCTOR_CLOCK_WEAK = 'doctor:cpu-clock';

/**
 * Night-to-night noise of each reading: the band before a history shows spread.
 * 6 °C is what one sensor moves between two loads of the same box (claw-1 read
 * 97 and 98 on 11-21/22); 0.1 of the ceiling is one P-state step on these parts.
 */
export const DOCTOR_QUANTITIES = Object.freeze({
	loadTempC: {
		quantity: 'doctor.loadTempC',
		spec: { unit: '°C', worse: 'higher', rel: 0, abs: 6 },
	},
	clockShare: {
		quantity: 'doctor.clockShare',
		spec: { unit: '', worse: 'lower', rel: 0, abs: 0.1 },
	},
});

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * The thermal statuses that say the die reading is NOT a temperature (a
 * missing or frozen sensor, one nothing vouches for, or a node declared to
 * carry none, like claw-5's relative k10temp). Such a reading never teaches
 * the node's range: a range learned from a number that is not a temperature
 * would make every later real reading look like drift.
 */
export const DIE_UNTRUSTED = new Set([
	'no-die-sensor',
	'no-load-reading',
	'tracking-unjudgeable',
	'sensor-did-not-move',
	'nothing-moved-under-load',
	'declared-no-die-temperature',
]);

/**
 * PURE. The readings this health record carries, by key, or none.
 *
 * @param {{ thermal?: object, clock?: object }} health
 * @param {{ dieUntrusted?: boolean }} [opts]
 * @returns {{ key: 'loadTempC'|'clockShare', value: number }[]}
 */
export function doctorReadings(health, { dieUntrusted = false } = {}) {
	const out = [];
	const t = health?.thermal ?? {};
	if (!dieUntrusted && t.sensor && Number.isFinite(t.loadC))
		out.push({ key: 'loadTempC', value: t.loadC });
	const c = health?.clock;
	if (c && Number.isFinite(c.loadBestMhz) && Number.isFinite(c.ceilingMhz) && c.ceilingMhz > 0)
		out.push({ key: 'clockShare', value: round2(c.loadBestMhz / c.ceilingMhz) });
	return out;
}

/**
 * PURE. Judge one node's readings against its stored range.
 *
 * @param {object} health the probed record
 * @param {Record<string, object>} quantities this node's estimates (nodeQuantities)
 * @param {string} at ISO time of the probe
 * @param {{ dieUntrusted?: boolean }} [opts] the thermal judge found the die
 *   reading is not a temperature (a DIE_UNTRUSTED status): it is not judged
 * @returns {{ stamp: object, window: { readings: object[], weak: object[], cleared: string[] } }}
 */
export function judgeDoctor(health, quantities, at, opts = {}) {
	const stamp = { at };
	const readings = [];
	const weak = [];
	const cleared = [];
	for (const { key, value } of doctorReadings(health, opts)) {
		const { quantity, spec } = DOCTOR_QUANTITIES[key];
		const v = judgeReading(quantities[quantity], value, spec);
		stamp[key] = { value, ...v };
		readings.push({ quantity, value, spec, drifted: v.verdict === 'drift' });
	}
	const t = stamp.loadTempC;
	if (t) {
		if (t.value >= THERMAL_ADVISORY_C && t.value < THERMAL_BLOCKING_C)
			weak.push({
				test: DOCTOR_THERMAL_WEAK,
				reason: `${health.thermal.sensor} reaches ${t.value} °C under ${health.thermal.loadSeconds}s of all-core load (the fleet line is ${THERMAL_ADVISORY_C} °C)`,
			});
		else if (t.value < THERMAL_ADVISORY_C) cleared.push(DOCTOR_THERMAL_WEAK);
	}
	const c = stamp.clockShare;
	if (c) {
		if (c.value < CLOCK_STUCK_FRACTION)
			weak.push({
				test: DOCTOR_CLOCK_WEAK,
				reason: `its clock reaches ${health.clock.loadBestMhz} of ${health.clock.ceilingMhz} MHz under all-core load (${Math.round(c.value * 100)} %, the fleet line is ${Math.round(CLOCK_STUCK_FRACTION * 100)} %)`,
			});
		else cleared.push(DOCTOR_CLOCK_WEAK);
	}
	return { stamp, window: { readings, weak, cleared } };
}

/**
 * PURE. The stamp's verdict on one reading, for the findings: `null` when the
 * record carries no usable stamp (an old record, or a store that could not be
 * read), and the caller then keeps the fixed bar.
 *
 * @param {object} health
 * @param {'loadTempC'|'clockShare'} key
 */
export function stampedVerdict(health, key) {
	const s = health?.baseline;
	if (!s || typeof s !== 'object' || s.unreadable) return null;
	const v = s[key];
	return v && typeof v.verdict === 'string' ? v : null;
}

/** For a finding: one drift verdict, in words. */
export function describeDrift(v, unit, node) {
	const u = unit ? ` ${unit}` : '';
	return `${v.value}${u} is ${v.direction} than ${node ?? 'this node'}'s own range ${v.mean}${u} ± ${v.band}${u} (n=${v.n}); the range re-learns at the new reading`;
}
