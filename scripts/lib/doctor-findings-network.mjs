/**
 * doctor-findings-network — judges one node's `$health.network` facet: which
 * stack owns the radio, and whether the two writers (NetworkManager, the
 * kernel) agree about its link state.
 *
 * Moved out of `doctor-findings.mjs` (wave shrink-1 lane D), body unchanged.
 */

import { ADVISORY, BLOCKING } from './preflight.mjs';
import { f } from './doctor-findings-record.mjs';

/**
 * @param {ReturnType<import('./doctor-facet.mjs').healthFacet>} health
 * @returns {object[]}
 */
export function networkFindings(health) {
	const out = [];
	// `none` is a FACT about a wired-only box (claw-4/5/6) and not a finding, and
	// `node-interfaces.mjs` says so in its own six-answer list. `unknown` is the
	// "I could not look" answer and never collapses into `none`.
	const n = health.network ?? {};
	if (n.wifiManager === 'unknown') {
		out.push(
			f(
				health,
				'wifi-manager',
				BLOCKING,
				'unknown',
				`which stack owns this node's radio could not be determined: ${n.wifiReason}.`
			)
		);
	} else if (n.wifiManager === 'split') {
		out.push(
			f(
				health,
				'wifi-manager',
				BLOCKING,
				'split',
				`two managers on one box: ${n.wifiReason}. A stale ifupdown default route outlives ` +
					'the carrier it was learned on, which is the exact way a pulled cable blackholes a node.'
			)
		);
	} else if (n.wifiManager === 'unmanaged') {
		out.push(
			f(
				health,
				'wifi-manager',
				ADVISORY,
				'unmanaged',
				`${n.wifiReason}. The node is reachable on its other link today; the radio is the one ` +
					'that survives a cable pull, so leaving it unconfigured means a wired-only failure mode.'
			)
		);
	}
	// TWO DIFFERENT FAULTS, AND ONLY ONE OF THEM IS AN OUTAGE.
	//
	// `connected` from NetworkManager with a kernel operstate that is not `up` is
	// the two writers CONTRADICTING each other, and one of them is lying about
	// the link the fleet falls back on when a cable comes out — blocking.
	// `disconnected`/`unavailable` with a down link is the two writers AGREEING
	// that nothing has configured this radio, which is a real gap (hokon's
	// wlp13s0 is exactly this: NM holds it, nothing connects it, and the box is
	// wired-only in practice) but not a contradiction and not an outage today.
	if (n.radio && n.operstate && n.operstate !== 'up' && n.wifiManager === 'networkmanager') {
		const contradicts = n.nmState === 'connected' || n.nmState === 'connecting';
		out.push(
			f(
				health,
				'wifi-link',
				contradicts ? BLOCKING : ADVISORY,
				contradicts ? 'contradicts' : 'not-connected',
				contradicts
					? `NetworkManager reports ${n.radio} "${n.nmState}" while the kernel reports ` +
							`operstate "${n.operstate}" (carrier ${n.carrier}). The two writers disagree about ` +
							'the link the fleet falls back on when a cable comes out, so one of them is wrong.'
					: `${n.radio} is held by NetworkManager as "${n.nmState}" and its kernel operstate is ` +
							`"${n.operstate}" — both agree nothing has connected it. The radio is the link that ` +
							'survives a cable pull; until it is configured this box is wired-only in practice.',
				{ radio: n.radio, operstate: n.operstate, nmState: n.nmState }
			)
		);
	}
	return out;
}
