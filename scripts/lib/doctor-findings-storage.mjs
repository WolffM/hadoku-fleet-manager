/**
 * doctor-findings-storage — judges one node's `$health.disk`
 * (root and `_work`) and `$health.smart` facets: free space and drive
 * health.
 *
 * Moved out of `doctor-findings.mjs` (wave shrink-1 lane D), body unchanged.
 */

import { ADVISORY, BLOCKING } from './preflight.mjs';
import { f } from './doctor-findings-record.mjs';
import { DISK_BLOCKING_FREE_PCT, DISK_ADVISORY_FREE_PCT } from './doctor-findings-thresholds.mjs';

/**
 * @param {ReturnType<import('./doctor-facet.mjs').healthFacet>} health
 * @returns {object[]}
 */
export function storageFindings(health) {
	const out = [];

	// ── root disk ─────────────────────────────────────────────────────────────
	const d = health.disk ?? {};
	if (d.freePct === null) {
		out.push(
			f(
				health,
				'disk-free',
				BLOCKING,
				'unreadable',
				`free space on / could not be computed: ${d.why ?? 'df produced no usable total or available figure'}.`
			)
		);
	} else if (d.freePct < DISK_BLOCKING_FREE_PCT) {
		out.push(
			f(
				health,
				'disk-free',
				BLOCKING,
				'full',
				`/ is ${d.freePct}% free (${d.availKb} of ${d.totalKb} KiB) — under ` +
					`${DISK_BLOCKING_FREE_PCT}%. A runner that cannot write its workspace fails every ` +
					'job assigned to it, and a full root takes the node out without any gate going red.',
				{ freePct: d.freePct }
			)
		);
	} else if (d.freePct < DISK_ADVISORY_FREE_PCT) {
		out.push(
			f(
				health,
				'disk-free',
				ADVISORY,
				'tight',
				`/ is ${d.freePct}% free — under ${DISK_ADVISORY_FREE_PCT}%. Not an outage; a node ` +
					'that wants `fleet clean` before it is given anything resident.',
				{ freePct: d.freePct }
			)
		);
	}

	// ── `_work`, when it is a genuinely different filesystem from `/` ─────────
	//
	// Wave 4c §F. Reuses the SAME percentage lines as root (`DISK_BLOCKING_FREE_PCT`
	// / `DISK_ADVISORY_FREE_PCT`) rather than inventing a second rule: this is an
	// extension of the existing root-disk judgement onto a second disk, not a new
	// kind of finding. `disk-watch.ts`'s absolute-GB lines are the SEPARATE,
	// earlier-warning mechanism this wave adds elsewhere (`runner-health.ts`); the
	// two are not meant to agree, because one answers "is this disk nearly full"
	// and the other answers "is there still runway before admission refuses a
	// mint" — different questions, deliberately different units.
	const w2 = health.disk?.work;
	if (w2) {
		if (w2.freePct === null) {
			out.push(
				f(
					health,
					'disk-work-free',
					BLOCKING,
					'unreadable',
					`free space on _work could not be computed: ${w2.why ?? 'df produced no usable total or available figure'}.`
				)
			);
		} else if (w2.freePct < DISK_BLOCKING_FREE_PCT) {
			out.push(
				f(
					health,
					'disk-work-free',
					BLOCKING,
					'full',
					`_work (${w2.fs ?? 'unknown fs'}) is ${w2.freePct}% free — under ${DISK_BLOCKING_FREE_PCT}%. ` +
						'This is the filesystem holding the JIT payload cache and every job workspace.',
					{ freePct: w2.freePct }
				)
			);
		} else if (w2.freePct < DISK_ADVISORY_FREE_PCT) {
			out.push(
				f(
					health,
					'disk-work-free',
					ADVISORY,
					'tight',
					`_work (${w2.fs ?? 'unknown fs'}) is ${w2.freePct}% free — under ${DISK_ADVISORY_FREE_PCT}%.`,
					{ freePct: w2.freePct }
				)
			);
		}
	}

	// ── the drive ─────────────────────────────────────────────────────────────
	const s = health.smart ?? {};
	if (s.health === null) {
		out.push(
			f(
				health,
				'smart-health',
				BLOCKING,
				'unreadable',
				`SMART could not be read on ${health.node}: ${s.why ?? 'no reason was recorded'}. ` +
					'A drive whose health was not read is not a drive known to be healthy.'
			)
		);
	} else if (s.health !== 'PASSED' && s.health !== 'OK') {
		out.push(
			f(
				health,
				'smart-health',
				BLOCKING,
				'failing',
				`${s.device} reports SMART overall-health "${s.health}" — the drive's own firmware ` +
					'says it is failing.',
				{ device: s.device, health: s.health }
			)
		);
	}
	if (s.powerOnHours === null && s.health !== null) {
		out.push(
			f(
				health,
				'smart-hours',
				BLOCKING,
				'unreadable',
				`${s.device} answered SMART but reported no power-on hours, so its age is unknown. ` +
					'A drive that cannot say its age may not be saying the rest.',
				{ device: s.device }
			)
		);
	}
	// Age alone is context, never a finding (#169, the 11-21 decision in #129):
	// the hours only climb, and a gate never asks for a part. A drive that is
	// CHANGING warns instead: smart-health above, and its wear counts judged
	// for growth per serial (doctor-disk-wear.mjs).

	return out;
}
