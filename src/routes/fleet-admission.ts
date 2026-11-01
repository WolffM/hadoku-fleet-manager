/**
 * Admission math for `routes/fleet.ts` — a pure move out of that file (wave
 * 5r lane A), split off because the module crossed the 800-line source
 * ceiling: free capacity against the budget that actually gates a node
 * (`admission`), and the operator's `fleet backstop --force` switch, read
 * for the wire (`forcedForReport`).
 */
import type { NodeProbe } from '../lib/node-probe.js';
import { mintBudget } from '../runners/ephemeral.js';
import { activeForces, readForce } from '../runners/backstop-force.js';
import type { AdmissionBasis, AdmissionCaveat, FleetReport } from '../fleet-report-types.js';
import type { ManifestNode } from './fleet-manifest.js';

/**
 * The green light, for the panel. `null` is "could not read the switch file",
 * never "off" — a corrupt switch rendered as nothing forced is the same
 * collapse this report refuses everywhere else.
 */
export function forcedForReport(): FleetReport['fleet']['backstopForced'] {
	try {
		return activeForces(readForce()).map((f) => ({
			node: f.node,
			since: f.record.since,
			until: f.record.until,
			remainingMin: f.remainingMin,
			reason: f.record.reason,
			by: f.record.by,
		}));
	} catch {
		return null;
	}
}

/**
 * Free capacity against the budget that really gates this node.
 *
 * Two different questions wear the word "capacity" in this payload, and the
 * panel has now printed the wrong one twice. See `FleetMachine.admissionFree`
 * for which is which and why the ladder's own numbers are left alone.
 */
export function admission(
	m: ManifestNode,
	p: NodeProbe | undefined
): {
	admissionCapacity: number | null;
	admissionFree: number | null;
	admissionBasis: AdmissionBasis | null;
	admissionCaveat: AdmissionCaveat | null;
} {
	if (!p?.reachable) {
		// UNKNOWN, and it has to survive as unknown all the way to the rollup.
		// `admissionCaveat` is what carries it: the two nulls below are
		// indistinguishable from a node with no room once anything sums them.
		return {
			admissionCapacity: null,
			admissionFree: null,
			admissionBasis: null,
			admissionCaveat: 'unreachable',
		};
	}
	if (m.ephemeral) {
		// The DISPATCHER's budget, from the dispatcher's own function — see
		// `mintBudget`. Reading `m.maxConcurrent` directly here is what let this
		// report `null` for a node `ephemeral-tick` was actively minting on,
		// because the tick falls back and this did not.
		const budget = mintBudget(m);
		return {
			admissionCapacity: budget.slots,
			admissionFree: Math.max(0, budget.slots - p.workers),
			admissionBasis: 'dispatcher',
			admissionCaveat: budget.basis === 'declared' ? null : 'undeclared',
		};
	}
	return {
		admissionCapacity: p.capacity,
		admissionFree: p.free,
		admissionBasis: 'standing',
		admissionCaveat: null,
	};
}
