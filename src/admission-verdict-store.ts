/**
 * The dispatcher's generic admission-verdict snapshot — moved out of
 * `runners/ephemeral-tick.ts` (wave clean-2 lane A, cut (iii)).
 *
 * `ephemeral-tick.ts` (ci-scheduling) is the one writer, every
 * `dispatchEphemeral` pass; `runner-health-mint.ts` (observation) and
 * `routes/fleet-report.ts` (surfaces) are readers. A domain reading another
 * domain's fact through a STATE RECORD, never the writer's own module
 * directly, is rule 5 of the refactor plan's placement rule (§3.2) — this is
 * that record, same shape as `fleet-probe-store.ts` and
 * `pm2-host-busy-store.ts` beside it. `ephemeral-tick.ts` re-exports every
 * name here under its original path, so no existing importer changes.
 */
import type { AdmissionVerdict } from './lib/fleet-vocabulary.js';

/**
 * THE VERDICT SNAPSHOT — module-level, replaced WHOLESALE once per
 * `dispatchEphemeral` pass, never mutated in place, and only ever handed out
 * as a copy (`admissionVerdictsForReport`).
 *
 * WHOLESALE for the same reason `setWarmRepos` is: a node that stops being
 * reachable, or drops out of `input.ephemeral`, must stop being reported on
 * the very next pass rather than carrying a frozen verdict forever.
 *
 * EMPTY AFTER A RESTART, and that is the honest answer, not a bug — mgmt-api
 * restarts ~5x/day and this is in-memory. An ABSENT entry must NEVER be read
 * as "admitted": it means "this pass could not look", and `runner-health.ts`'s
 * starvation check treats it that way — carrying its last known finding
 * forward rather than clearing an alert on a tick that learned nothing.
 */
let admissionVerdictByNode: ReadonlyMap<string, AdmissionVerdict> = new Map();

/**
 * What the last `dispatchEphemeral` pass's generic admission check found, for
 * `runner-health.ts`'s starvation finding and `routes/fleet.ts`'s panel field.
 *
 * Copied, same rule as `warmReposForPlacement` — a caller must not be able to
 * mutate the fleet's belief about its own admission state.
 */
export function admissionVerdictsForReport(): ReadonlyMap<string, AdmissionVerdict> {
	return new Map(admissionVerdictByNode);
}

/**
 * `ephemeral-tick.ts`'s own production writer: `dispatchEphemeral` calls this
 * once per pass, wholesale, in place of what used to be a direct module-level
 * assignment. Same convention as `fleet-probe-store.ts`'s
 * `__setFleetProbeForTesting`, which is both the production setter and the
 * test seam for the same reason: one write path cannot drift from the other.
 */
export function setAdmissionVerdicts(verdicts: ReadonlyMap<string, AdmissionVerdict>): void {
	admissionVerdictByNode = verdicts;
}

/**
 * Test seam: inject the verdict snapshot directly, bypassing a real
 * `dispatchEphemeral` pass. Not part of the supported API.
 *
 * `runner-health.ts`'s starvation check is this file's READER, not its
 * producer — a test of the reader should not have to drive the dispatcher's
 * whole I/O-heavy pass (GitHub `gh`, `sh`, the warm cache, the speed model)
 * just to get one node refused on memory. `dispatchEphemeral` itself is
 * exercised end to end in `warm-cache.test.ts`.
 */
export function __setAdmissionVerdictsForTesting(
	verdicts: ReadonlyMap<string, AdmissionVerdict>
): void {
	admissionVerdictByNode = new Map(verdicts);
}

/** Test seam. Not part of the supported API. */
export function __resetAdmissionVerdictsForTesting(): void {
	admissionVerdictByNode = new Map();
}
