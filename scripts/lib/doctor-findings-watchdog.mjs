/**
 * doctor-findings-watchdog — judges one node's `$health.watchdog` facet:
 * whether the daemon is running, what wakes it, and whether it watches the
 * right sensor.
 *
 * Moved out of `doctor-findings.mjs` (wave shrink-1 lane D), body unchanged.
 * `t` is read straight off `health.thermal`, the same snapshot
 * `doctor-findings-thermal.mjs` reads — not a value computed by that module
 * and handed in, so reading it again here costs nothing and keeps this a
 * pure move rather than a restructure.
 */

import { ADVISORY, BLOCKING } from './preflight.mjs';
import { f } from './doctor-findings-record.mjs';
import { SENSOR_DISAGREE_C } from './doctor-findings-thresholds.mjs';

/**
 * @param {ReturnType<import('./doctor-facet.mjs').healthFacet>} health
 * @returns {object[]}
 */
export function watchdogFindings(health) {
	const out = [];
	const t = health.thermal ?? {};
	const w = health.watchdog ?? {};
	// `enabled: not-found` MEANS THE UNIT DOES NOT EXIST, which is a different
	// fact from a unit that exists and is stopped. hokon has no `watchdog`
	// package at all — it is a claw safety control, configured by the node
	// profile — so judging it by the claws' rule reported the production host as
	// BLOCKING for not running software nobody ever installed there. The fact is
	// still recorded in `$health.watchdog`; it is just not a finding.
	const watchdogInstalled = w.enabled !== null && w.enabled !== 'not-found';
	if (watchdogInstalled && w.active && w.active !== 'active') {
		out.push(
			f(
				health,
				'watchdog',
				BLOCKING,
				'not-running',
				`the watchdog daemon is "${w.active}" (enabled: ${w.enabled}), wd_keepalive is ` +
					`"${w.keepalive}". Recover with: systemctl stop wd_keepalive && systemctl start watchdog`
			)
		);
	}
	// A LOAD TRIGGER REBOOTS A BUSY NODE, NOT A WEDGED ONE. The profile writes
	// none; a line here is a hand edit or a node bootstrapped before 2026-10-30.
	// Even `max-load-1` alone is a 15-minute ceiling of half its value, because
	// the daemon derives max-load-5/15 when they are unset: that is how claw-8
	// was rebooted at 52/48/34 with two heavy jobs beside its hosting slice.
	if (watchdogInstalled && w.loadTrigger && w.loadTrigger !== 'none') {
		out.push(
			f(
				health,
				'watchdog',
				ADVISORY,
				'load-trigger',
				`watchdog.conf reboots this node on load (${w.loadTrigger}). Load is not a wedge ` +
					'signal on a CI node, and an unset max-load-15 is half of max-load-1. Remove ' +
					'every max-load-* line from /etc/watchdog.conf and restart watchdog.',
				{ loadTrigger: w.loadTrigger }
			)
		);
	}
	if (w.sensorPath && t.sensor && w.sensorC !== null && t.idleC !== null) {
		const mismatch = Math.abs(w.sensorC - t.idleC) >= SENSOR_DISAGREE_C;
		if (mismatch) {
			out.push(
				f(
					health,
					'watchdog',
					BLOCKING,
					'wrong-sensor',
					`watchdog.conf watches ${w.sensorPath}, which reads ${w.sensorC} °C while the die ` +
						`reads ${t.idleC} °C. It cannot protect this box from a thermal fault it is not ` +
						'looking at.',
					{ sensorPath: w.sensorPath, sensorC: w.sensorC, dieC: t.idleC }
				)
			);
		}
	}
	return out;
}
