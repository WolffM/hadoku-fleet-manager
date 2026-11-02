/**
 * doctor-findings-thermal — judges one node's `$health.thermal` facet: the
 * CPU die reading itself, and whether every sensor beside it agrees with it.
 *
 * Moved out of `doctor-findings.mjs` (wave shrink-1 lane D), body unchanged.
 * See that file's header for "why the maximum across every thermal zone is
 * not the CPU temperature" and the tracking-vs-rising rule this encodes.
 */

import { ADVISORY, BLOCKING } from './preflight.mjs';
import { independentCpuSensors } from './doctor-parse.mjs';
import { f } from './doctor-findings-record.mjs';
import {
	THERMAL_BLOCKING_C,
	THERMAL_ADVISORY_C,
	SENSOR_DISAGREE_C,
	IMPLAUSIBLE_RISE_C,
	SENSOR_MOVED_C,
	SENSOR_TRACKS_DIVISOR,
} from './doctor-findings-thresholds.mjs';

/**
 * @param {ReturnType<import('./doctor-facet.mjs').healthFacet>} health
 * @returns {object[]}
 */
export function thermalFindings(health) {
	const out = [];
	const t = health.thermal ?? {};
	if (t.sensor === null) {
		out.push(
			f(
				health,
				'thermal-sensor',
				BLOCKING,
				'no-die-sensor',
				`no CPU die sensor could be identified on this node: ${t.why}. Nothing here can say ` +
					'whether it runs hot, and a node whose temperature cannot be read is not a node ' +
					'known to be cool.'
			)
		);
	} else if (t.loadC === null) {
		out.push(
			f(
				health,
				'cpu-thermal',
				BLOCKING,
				'no-load-reading',
				`${t.sensor} read ${t.idleC} °C before the load phase and no under-load reading was ` +
					`taken: ${(t.loadWhy ?? 'the load phase produced no peak for this sensor').replace(/\.\s*$/, '')}. A baseline temperature says nothing ` +
					'says nothing about a cooler that cannot shed heat — claw-8 idled at 58 °C and hit ' +
					'100 °C in under five seconds of load.',
				{ sensor: t.sensor, idleC: t.idleC }
			)
		);
	} else if (t.loadC >= THERMAL_BLOCKING_C) {
		out.push(
			f(
				health,
				'cpu-thermal',
				BLOCKING,
				'pinned',
				`${t.sensor} reached ${t.loadC} °C under ${t.loadSeconds}s of all-core load (idle ` +
					`${t.idleC} °C, rise ${t.riseC} °C). At or above ${THERMAL_BLOCKING_C} °C there is no ` +
					"thermal headroom left: the watchdog trip point and the CPU's own PROCHOT are both " +
					'here, so the next sustained job throttles or reboots the box.',
				{ sensor: t.sensor, idleC: t.idleC, loadC: t.loadC, riseC: t.riseC }
			)
		);
	} else if (t.riseC !== null && t.riseC < IMPLAUSIBLE_RISE_C && t.loadC < THERMAL_ADVISORY_C) {
		// BOTH CLAUSES, not just the rise — hokon rose 9 °C because it started at
		// 88 and finished at 97, and a part already at its ceiling cannot rise. The
		// `loadC` clause is written out rather than left to the else-if order below
		// it, because the order is a property of this chain and the rule is a
		// property of the finding.
		//
		// THE SENSOR IS ASKED TO TRACK, NOT TO RISE (2026-09-22, lane T). This
		// branch used to block on the rise number alone, calibrated on small boxes
		// that move 29–47 °C — until claw-9 (an i7-5930K locked at 3.0 GHz, turbo
		// off, under a tower cooler) rose +7 °C while its six per-core sensors
		// independently rose +6…+14 °C, and the rule called the sensor broken for
		// measuring a cool die. The question is now RELATIONAL: did the die reading
		// move WITH the independent readings beside it? A cool die is not a broken
		// sensor; a die reading that does not follow the package's own heat is not
		// a temperature. And the rule does not get easier as the failure gets
		// worse: a stuck die beside moving cores blocks (it ignored real heat),
		// and a die where NOTHING moved blocks (the whole suite is frozen or the
		// load never loaded — either way there is no reading here at all).
		const beside = independentCpuSensors(t.sensor, Object.keys(t.idleSensors ?? {})).filter(
			(k) => (t.loadSensors ?? {})[k] !== undefined
		);
		const besideRises = beside
			.map((k) => t.loadSensors[k] - t.idleSensors[k])
			.filter((r) => Number.isFinite(r))
			.sort((a, b) => a - b);
		// The MEDIAN, not the mean or the max: one stuck core sensor must neither
		// halve the reference (mean) nor cap it (max would ignore it, but one very
		// hot core would raise the bar a working package sensor cannot meet).
		const besideRiseC = besideRises.length
			? besideRises.length % 2
				? besideRises[(besideRises.length - 1) / 2]
				: (besideRises[besideRises.length / 2 - 1] + besideRises[besideRises.length / 2]) / 2
			: null;
		const neededC =
			besideRiseC === null
				? null
				: Math.max(SENSOR_MOVED_C, Math.ceil(besideRiseC / SENSOR_TRACKS_DIVISOR));
		if (besideRiseC === null) {
			// ONE SENSOR, NO WITNESS. Tracking cannot be judged on a single
			// reading — claw-5's FX-8350 exposes exactly one k10temp channel — so
			// this node is NOT called healthy on the strength of it. The rise is
			// still quoted: +5 °C against a fleet that moved 29–47 °C on the same
			// load is its own evidence that the number is not a die temperature.
			out.push(
				f(
					health,
					'cpu-thermal',
					BLOCKING,
					'tracking-unjudgeable',
					`${t.sensor} is the only CPU sensor this node emitted — no per-core or sibling ` +
						`reading exists to say whether it tracks the die — and it rose ${t.riseC} °C ` +
						`(${t.idleC} → ${t.loadC} °C) under ${t.loadSeconds}s of load on ${t.loadWorkers} ` +
						`cores, under the ${IMPLAUSIBLE_RISE_C} °C line and against a fleet that moved ` +
						'29–47 °C on the same load. Tracking cannot be judged on one reading, and a node ' +
						'whose temperature nothing vouches for is not a node known to be cool — this ' +
						'finding says JUDGE ME, not "the sensor is fine".',
					{ sensor: t.sensor, idleC: t.idleC, loadC: t.loadC, riseC: t.riseC }
				)
			);
		} else if (t.riseC < neededC && besideRiseC >= SENSOR_MOVED_C) {
			out.push(
				f(
					health,
					'cpu-thermal',
					BLOCKING,
					'sensor-did-not-move',
					`${t.sensor} rose ${t.riseC} °C (${t.idleC} → ${t.loadC} °C) under ${t.loadSeconds}s ` +
						`of load on ${t.loadWorkers} cores, while the ${beside.length} CPU sensor(s) ` +
						`beside it on the same package rose a median of ${besideRiseC} °C. The die ` +
						'demonstrably warmed and this reading did not move with it, so it is not ' +
						"tracking the die — whatever it is reporting, the package's own sensors say " +
						'it is not the temperature of anything a thermal guard could rely on.',
					{
						sensor: t.sensor,
						idleC: t.idleC,
						loadC: t.loadC,
						riseC: t.riseC,
						besideRiseC,
						besideSensors: beside.length,
					}
				)
			);
		} else if (t.riseC < neededC) {
			out.push(
				f(
					health,
					'cpu-thermal',
					BLOCKING,
					'nothing-moved-under-load',
					`neither ${t.sensor} nor any of the ${beside.length} CPU sensor(s) beside it rose ` +
						`as much as ${SENSOR_MOVED_C} °C under ${t.loadSeconds}s of load on ` +
						`${t.loadWorkers} cores (die ${t.idleC} → ${t.loadC} °C, median beside it ` +
						`${besideRiseC} °C). A die holding every core busy for a minute warms more than ` +
						'that on every box this fleet has measured — so either the whole sensor suite ' +
						'is frozen or the load never loaded, and either way this record carries no ' +
						'temperature. That is "I could not look", and it is not "nothing is wrong".',
					{
						sensor: t.sensor,
						idleC: t.idleC,
						loadC: t.loadC,
						riseC: t.riseC,
						besideRiseC,
						besideSensors: beside.length,
					}
				)
			);
		}
		// else: the die reading rose with the sensors beside it. It is tracking
		// the die, and a die that stays cool under load is a fact about the
		// cooler, not a finding about the sensor — nothing is pushed.
	} else if (t.loadC >= THERMAL_ADVISORY_C) {
		out.push(
			f(
				health,
				'cpu-thermal',
				ADVISORY,
				'hot',
				`${t.sensor} reached ${t.loadC} °C under ${t.loadSeconds}s of all-core load (idle ` +
					`${t.idleC} °C). Above ${THERMAL_ADVISORY_C} °C and below ${THERMAL_BLOCKING_C} °C is ` +
					'the band where a modern part boosts to its own limit by design — real, worth ' +
					'ranking on, and not an outage.',
				{ sensor: t.sensor, idleC: t.idleC, loadC: t.loadC, riseC: t.riseC }
			)
		);
	}

	// A SENSOR THAT DISAGREES WITH THE DIE IS ITS OWN FINDING. Not folded into
	// the temperature above, because the hazard is different: this is the sensor
	// `/etc/watchdog.conf` may be aimed at, and a guard reading a lying sensor
	// cannot protect the box it is guarding.
	//
	// SCOPED TO `thermal_zone` SENSORS, for a reason measured rather than
	// assumed: `/etc/watchdog.conf`'s `temperature-sensor=` on this fleet points
	// at a thermal-zone path (claw-1: `/sys/class/thermal/thermal_zone3/temp`),
	// so a zone is the only sensor that can actually BE the guard's input. A
	// hwmon sensor on another device is a different die with its own legitimate
	// temperature — claw-5's `nouveau` GPU idles 20 °C above its FX-8350's
	// k10temp reading, and flagging that said nothing true about either part.
	if (t.sensor && t.idleC !== null) {
		for (const [k, c] of Object.entries(t.idleSensors ?? {})) {
			if (k === t.sensor) continue;
			if (!k.startsWith('zone.')) continue;
			if (c - t.idleC < SENSOR_DISAGREE_C) continue;
			out.push(
				f(
					health,
					'thermal-sensor',
					ADVISORY,
					'disagrees',
					`sensor ${k} read ${c} °C while the die sensor ${t.sensor} read ${t.idleC} °C — ` +
						`${c - t.idleC} °C apart at idle. It is measuring something else or it is wrong, ` +
						'and either way it must not be what a thermal guard watches: aiming ' +
						'watchdog.conf at an ambient sensor is what cost a day on 2026-08-17.',
					{ sensor: k, sensorC: c, dieC: t.idleC }
				)
			);
		}
	}

	return out;
}
