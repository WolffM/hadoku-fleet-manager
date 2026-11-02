/**
 * The label set a shadow probe or forced re-run mints with — split out of
 * `scripts/floor-probe.mjs` (wave 5q lane A, ctx restructure) so that file
 * reaches the 800-line ceiling. Takes the CLI's `NODES`/`machines` rather
 * than importing the CLI: no lib imports it, per
 * `docs/planning/wave5q-2026-10-31.md`.
 */
import { stateDir } from '../../dist/lib/fleet-paths.js';
import { nodeOffer } from '../../dist/lib/capability-offer.js';
import { workloadGateContext, workloadGatedCapabilities } from '../../dist/lib/workload-gate.js';
import { proofFileStatus, readProofsForCapability } from '../../dist/lib/measured-proof.js';

/**
 * This RUN's `WorkloadGateContext` (wave 4e follow-up, #102) — one state-dir
 * read, built once and reused for both `nodeOffer` call sites below (the
 * shadow probe mint and the forced-rerun mint), the same pattern
 * `src/runners/ephemeral-tick.ts`'s `loadWorkloadGateContext` uses. A probe
 * mint is a one-shot CLI invocation, so "once per run" is already "once",
 * unlike the 15s dispatch loop that pattern was written against.
 *
 * `proofFileStatus` is checked FIRST, same reason as every other caller of
 * `workloadGateContext`: an UNREADABLE or MALFORMED `$proof` file must never
 * be read as "no records at all", which would silently RE-GRANT a label a
 * FAIL/STALE mark had just withdrawn. `corrupt: true` forces every workload-
 * gated label withheld fleet-wide instead — the safe failure direction.
 */
export function buildWorkloadGate(NODES) {
	const status = proofFileStatus({ dir: stateDir() });
	if (status.corrupt) {
		console.error(
			`! $proof is ${status.reason} (${status.why}) — withholding every workload-gated label ` +
				`from this probe's mint until it is readable again.`
		);
		return workloadGateContext(NODES, {}, { corrupt: true });
	}
	const proofsByCapability = {};
	for (const id of workloadGatedCapabilities())
		proofsByCapability[id] = readProofsForCapability(id, { dir: stateDir() });
	return workloadGateContext(NODES, proofsByCapability);
}

/** The mint's labels for one node — `nodeOffer` plus this run's workload gate. */
export function mintLabelsFor(node, machines, workloadGate) {
	return nodeOffer(machines[node] ?? {}, {
		eligible: true,
		workloadProofs: workloadGate.byNode[node] ?? {},
		provenCounts: workloadGate.provenCounts,
	});
}
