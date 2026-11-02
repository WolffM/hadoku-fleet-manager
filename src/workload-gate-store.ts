/**
 * This tick's `WorkloadGateContext` — moved out of `runners/ephemeral-shared.ts`
 * (wave clean-2 lane A, cut (iii)).
 *
 * One state-dir read (`$proof`, `$revoked`), reused for every `offerFor` call
 * a dispatch pass makes AND, independently, by `runner-health-mint.ts`'s own
 * label-floor judgement — both domains ask the SAME question ("which
 * workload-gated labels does this reading of the proof/revocation files
 * grant"), and neither may host the other's import (rule 5, §3.2). This is
 * the shared record both read, same shape as `fleet-probe-store.ts` and
 * `pm2-host-busy-store.ts` beside it. `ephemeral-shared.ts` re-exports every
 * name here under its original path, so no existing importer changes.
 */
import { logger, stateDir } from './host.js';
import {
	workloadGateContext,
	workloadGatedCapabilities,
	type WorkloadGateContext,
	type ProofRecord,
} from './lib/workload-gate.js';
import { readRevocations, REVOCATIONS_FILE, revokedSets } from './capability-revocations.js';
import { proofFileStatus, readProofsForCapability } from './lib/measured-proof.js';

/**
 * The last `(reason, why)` this function logged about a corrupt `$proof`
 * file, or `null` when the file was readable last time this ran. This tick
 * runs every ~15s, so logging unconditionally would write the same line to
 * the log once per tick for as long as the file stays broken — true but
 * useless, and loud enough to bury whatever else is happening. `null` on a
 * HEALTHY read (not merely "same reason as before") is deliberate: a file
 * that recovers and later breaks again, even with byte-identical text, is a
 * NEW transition worth saying out loud again, not a repeat of the old one.
 */
let lastLoggedProofCorruption: string | null = null;

/**
 * Build this TICK's `WorkloadGateContext` — one state-dir read, reused for
 * every `offerFor` call the tick makes, never one read per node (this runs on
 * the 15s dispatch loop).
 *
 * `proofFileStatus` is checked FIRST, separately from the per-capability
 * reads, for the same reason `src/routes/fleet.ts`'s own loader does it: an
 * UNREADABLE or MALFORMED `$proof` file must never be read as "no records at
 * all" (which `readProofsForCapability` alone would do, silently RE-GRANTING
 * a label a FAIL/STALE mark had just withdrawn). `workloadGateContext`'s
 * `opts.corrupt` is what turns that into "withhold every workload-gated label
 * fleet-wide until the file is fixed" instead — the safe failure direction.
 */
export function loadWorkloadGateContext(nodeNames: readonly string[]): WorkloadGateContext {
	if (workloadGateContextOverride) return workloadGateContextOverride;
	const revoked = loadRevoked();
	const status = proofFileStatus({ dir: stateDir() });
	if (status.corrupt) {
		const key = `${status.reason}:${status.why}`;
		if (key !== lastLoggedProofCorruption) {
			lastLoggedProofCorruption = key;
			logger.error(
				`[ephemeral-tick] $proof is ${status.reason} (${status.why}) — withholding every ` +
					`workload-gated label fleet-wide until it is readable again: "I could not look" must ` +
					`never silently re-grant a label a bad reading withdrew.`
			);
		}
		return workloadGateContext(nodeNames, {}, { corrupt: true, revoked });
	}
	lastLoggedProofCorruption = null;
	const proofsByCapability: Record<string, ProofRecord[]> = {};
	for (const id of workloadGatedCapabilities())
		proofsByCapability[id] = readProofsForCapability(id, { dir: stateDir() });
	return workloadGateContext(nodeNames, proofsByCapability, { revoked });
}

let lastLoggedRevocationCorruption: string | null = null;

/**
 * This tick's revoked labels — one state-dir read, alongside `$proof`'s. A
 * corrupt record withholds every probe-verified routing label (`'all'`) and
 * says so once per distinct reason: "I could not look" must never re-grant a
 * label a failed execution withdrew. See src/capability-revocations.ts.
 */
function loadRevoked(): Record<string, ReadonlySet<string>> | 'all' {
	const read = readRevocations(stateDir());
	if (read.corrupt) {
		if (read.why !== lastLoggedRevocationCorruption) {
			lastLoggedRevocationCorruption = read.why;
			logger.error(
				`[ephemeral-tick] ${REVOCATIONS_FILE} is unreadable (${read.why}) — withholding every ` +
					'probe-verified label fleet-wide until it is readable again.'
			);
		}
	} else lastLoggedRevocationCorruption = null;
	return revokedSets(read);
}

/** Test seam: the corruption-logging dedup is module-level, same leak class as every other reset in this file. */
export function __resetWorkloadGateCorruptionLogForTesting(): void {
	lastLoggedProofCorruption = null;
}

/**
 * Test seam, same shape as `__setAdmissionVerdictsForTesting` and the rest of
 * this file's module-level overrides. Real production code never calls this:
 * a test that wrote a REAL `$proof` fixture into the test host's shared state
 * dir would leak into every other test in the same process, since that
 * directory is not reset between tests the way each test's own `tmp` is.
 * `null` restores the real read.
 */
let workloadGateContextOverride: WorkloadGateContext | null = null;
export function __setWorkloadGateContextForTesting(ctx: WorkloadGateContext | null): void {
	workloadGateContextOverride = ctx;
}
