/**
 * label-floor-required — `hadoku-builder`'s required capability set, derived
 * from the demand ledger, and which nodes prove it.
 *
 * Moved out of `check-label-floor.mjs` (wave shrink-1 lane D), body
 * unchanged.
 *
 * P1.2/P1.3 (`bootcamp-earned-labels-2026-09-02.md`). The required set is
 * DERIVED from the demand ledger, never declared; a required capability no
 * managed node proves is a gate failure, the same class as the static/
 * observed-demand `missing` set but for DEMAND rather than for a workflow's
 * literal `runs-on`.
 *
 * A missing ledger is a FAILURE, not a skip — same line unreadable repos
 * hold in `label-floor-demand.mjs`. This gate already assumes an
 * operational environment (it reads the state dir and GitHub), so requiring
 * the ledger `fleet tool-inventory --write` produces is consistent, not a
 * new floor.
 *
 * The per-node CONSUMER CONTRACT report: "a node carries it iff it proves
 * the required set" (operator, 2026-09-07), evaluated through the one
 * predicate `src/fleet-loop.ts` ENFORCES (`provesRequiredSet`) rather than a
 * second copy of the rule. It does NOT fail the gate on its own: an empty or
 * gapped required set already fails on the caller's side, and the per-node
 * view would otherwise redden the fleet for a node that is legitimately
 * unprobed — the fail-open case `nodeFailsBootcamp` keeps deliberately. It
 * is printed so the fast loop's verdict is visible on live data BEFORE the
 * next tick acts on it.
 */

import { join } from 'node:path';
import { stateDir } from '../../dist/lib/fleet-paths.js';
import { requiredIdentitySet, provesRequiredSet } from '../../dist/lib/bootcamp-proof.js';
import { probeableIds } from '../../dist/lib/capability-labels.js';
import {
	ciRecords,
	emptyRequiredSetReason,
	loadDemandLedger,
	unprovenRequired,
} from './bootcamp-required.mjs';

/** @param {object} manifest */
export function requiredSetAndVerdicts(manifest) {
	let ledgerRecords;
	let ledgerError = null;
	try {
		ledgerRecords = loadDemandLedger(join(stateDir(), 'demand-ledger.jsonl'));
	} catch (err) {
		ledgerError = String(err.message ?? err);
		ledgerRecords = null;
	}
	// CI ROWS ONLY, explicitly. The ledger holds resident demand too since
	// 2026-09-10 (`service-ledger-2026-09-10.md` §3) and a PM2 service's resource
	// row must never be able to raise the bar a CI claw has to clear.
	const requiredSet = ledgerRecords ? requiredIdentitySet(ciRecords(ledgerRecords)) : new Set();
	const knownProbeableIds = probeableIds();
	const requiredGaps = ledgerRecords
		? unprovenRequired(requiredSet, manifest.machines, knownProbeableIds)
		: [];

	const contractVerdicts = Object.entries(manifest.machines ?? {})
		.map(([name, m]) => ({ name, ...provesRequiredSet(m, requiredSet) }))
		.sort((a, b) => a.name.localeCompare(b.name));

	// A LEDGER THAT PARSED AND ASKED FOR NOTHING IS THE THIRD CASE, and it used to
	// be the silent one: `unprovenRequired` returns `[]` for an empty set, so the
	// gap check passed having checked nothing. Every node clears a bar of zero.
	// Settled in wave 3a — an empty required set is a failure, not a pass —
	// and it is now the SAME refusal the fast loop makes (`nodeFailsBootcamp`),
	// so the gate and the loop agree about a bar neither can enforce.
	const emptyRequired = emptyRequiredSetReason(requiredSet, {
		path: join(stateDir(), 'demand-ledger.jsonl'),
		records: ledgerRecords,
	});

	return {
		ledgerRecords,
		ledgerError,
		requiredSet,
		knownProbeableIds,
		requiredGaps,
		contractVerdicts,
		emptyRequired,
	};
}
