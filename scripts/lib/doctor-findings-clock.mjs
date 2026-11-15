/**
 * doctor-findings-clock — judges one node's `$health.clock` facet: did the
 * CPU's clock rise to meet the load phase, measured against the CPU's own
 * ceiling?
 *
 * WHY. claw-5 ran at 1400 MHz under full load against a 4300 MHz P-state
 * table for at least two months (2026-11-14). The dispatcher saw only the
 * result, 2.91x slower than the fleet, and excluded it from cardtable; the
 * hardware baseline blamed the 2012 part. A stuck clock is a fault with a
 * fix (the board was asserting thermal control on a 19 °C die), and a
 * reader that compares the clock with the ceiling sees it on the first load.
 *
 * ADVISORY, INCLUDING "COULD NOT LOOK" (AGENTS.md: a new gate starts quiet).
 * Promote `stuck` to blocking only after a week of nightly records has been
 * read and its false positives counted. Every reading carries its reason
 * when absent; none is skipped.
 *
 * A RECORD THAT PREDATES THE READER (no `clock` key at all, a `health.json`
 * written before this shipped) produces nothing: it was not looked at, and
 * the next doctor run that does look replaces it.
 */

import { ADVISORY } from './preflight.mjs';
import { f } from './doctor-findings-record.mjs';
import { CLOCK_STUCK_FRACTION } from './doctor-findings-thresholds.mjs';

/** @param {{node: string|null, clock?: object}} health */
export function clockFindings(health) {
	const c = health.clock;
	if (!c) return [];
	const unjudged = (why) => [
		f(
			health,
			'cpu-clock',
			ADVISORY,
			'unjudged',
			`could not judge whether this node's CPU clock rises under load: ${why.replace(/\.\s*$/, '')}.`,
			{ ceilingMhz: c.ceilingMhz, loadBestMhz: c.loadBestMhz }
		),
	];
	if (c.ceilingMhz === null) return unjudged(c.ceilingWhy ?? 'the probe reported no clock ceiling');
	if (c.loadBestMhz === null)
		return unjudged(c.loadWhy ?? 'the probe reported no clock under load');
	const share = c.loadBestMhz / c.ceilingMhz;
	if (share >= CLOCK_STUCK_FRACTION) return [];
	return [
		f(
			health,
			'cpu-clock',
			ADVISORY,
			'stuck',
			`under the all-core load its cores' median clock never rose above ${c.loadBestMhz} MHz ` +
				`(best of ${c.loadSamples} samples) against a ceiling of ${c.ceilingMhz} MHz ` +
				`(${c.ceilingSource}): ${Math.round(share * 100)} %, under the ` +
				`${Math.round(CLOCK_STUCK_FRACTION * 100)} % line. Every job here runs at that share ` +
				'of the speed this CPU is rated for. Look for a firmware or board limit (thermal ' +
				'control asserted on a cool die, a power cap, a BIOS frequency setting) before ' +
				'calling the hardware slow.',
			{
				ceilingMhz: c.ceilingMhz,
				ceilingSource: c.ceilingSource,
				loadBestMhz: c.loadBestMhz,
				loadLastMhz: c.loadLastMhz,
			}
		),
	];
}
