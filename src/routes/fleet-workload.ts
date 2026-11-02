/**
 * Workload-gate proof reads for `routes/fleet.ts` — a pure move out of that
 * file (wave 5r lane A), split off because the module crossed the 800-line
 * source ceiling. `loadWorkloadGateInputs` is the one state-dir read
 * `buildFleetReport` needs to render each node's `workloadGates` reason.
 */
import { proofFileStatus, readProofsForCapability, type ProofRecord } from '../lib/measured.js';
import { workloadGatedCapabilities } from '../lib/workload-gate.js';
import { logger, stateDir } from '../host.js';

/**
 * Every workload-gated capability's CURRENT `$proof` records, by capability
 * id, PLUS whether the facet file itself is corrupt (wave 4e, #102) — the one
 * state-dir read `buildFleetReport` needs to render each node's
 * `workloadGates` reason via the shared `workloadGateContext`
 * (`src/lib/workload-gate.ts`). A real read on every call, like
 * `loadManifestNodes()` in `fleet-manifest.ts`; `buildFleetReport`'s own
 * parameter is where a test replaces it. See `measured.ts#proofFileStatus`
 * for why `corrupt` is checked FIRST and the per-capability reads are
 * skipped entirely when it is
 * true: an unreadable/malformed file must never be read as "no records",
 * which `readProofsForCapability` alone would do.
 */
export function loadWorkloadGateInputs(): {
	proofsByCapability: Record<string, ProofRecord[]>;
	corrupt: boolean;
} {
	const status = proofFileStatus({ dir: stateDir() });
	if (status.corrupt) {
		logger.error(
			`[fleet] $proof is ${status.reason} (${status.why}) — every workload-gated label's ` +
				`reason will read as withheld fleet-wide until this is fixed; see workloadGateContext.`
		);
		return { proofsByCapability: {}, corrupt: true };
	}
	const proofsByCapability: Record<string, ProofRecord[]> = {};
	for (const id of workloadGatedCapabilities())
		proofsByCapability[id] = readProofsForCapability(id, { dir: stateDir() });
	return { proofsByCapability, corrupt: false };
}
