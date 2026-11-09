/**
 * Ephemeral (JIT) runner minting — the decision half of workstream B.
 *
 * Everything here is PURE. Minting talks to GitHub and spawning talks to
 * systemd, but the rules that decide *whether* and *how* are functions over
 * plain data, because the interesting failures are all decisions:
 *
 *   - minting past a node's concurrency cap is the OOM mechanism (B2)
 *   - a name without a mint timestamp cannot be aged, so the sweep must treat it
 *     as immediately reapable (§12.8)
 *   - a jitconfig without DisableUpdate would let a runner rewrite a payload
 *     that is HARDLINKED into every other slot on the box (§12.16)
 *
 * A test can assert all of that without registering a runner. That matters:
 * every probe in this workstream that touched real infrastructure to learn
 * something cost an outage or a leak.
 *
 * NOTHING here is wired into the fast loop. It activates only for a node
 * carrying `ephemeral: true` in fleet-runner-manifest.json, and no node does.
 */

export { TMP_FREE_FLOOR_MB, admitMint } from './ephemeral-admission.js';
export { JIT_UNIT_MAX_SEC, unitMemoryMaxMb, backstopUnitMemoryMaxMb } from './ephemeral-slice.js';
// Warm-cache eligibility moved to src/lib/warm-eligibility.ts (wave clean-2
// lane C, cut (iii) layer debt): config, the stratum both this (ci-scheduling)
// file and scripts/check-warm-canary.mjs (observation) may import.
// The concurrency half (mintBudget, warmConcurrencySlots, warmListenerSlots,
// warmListenersHeld) followed on 2026-11-09 for the same reason: the canary
// scored a node capped at 1 as missing a listener the tick may never place
// there (fleet-manager#79). Re-exported here unchanged.
export {
	WARM_CACHE_SIZE,
	mintBudget,
	warmConcurrencySlots,
	warmListenerSlots,
	warmListenersHeld,
	type MintBudget,
	type MintBudgetBasis,
	type WarmPlacementInput,
} from '../lib/warm-eligibility.js';

/** The JIT root under a node's home directory — the one place this path is
 * spelled; `slotDir` and the space probe both derive from it. */
export function jitRoot(home: string): string {
	return `${home}/.hadoku/jit`;
}

/** Where a mint's hardlinked payload slot lives. Same filesystem as the shared
 * payload, or `cp -al` silently becomes a 674 MB real copy (§12.16). */
export function slotDir(home: string, index: number): string {
	return `${jitRoot(home)}/slot${index}`;
}

// --- warm cache of one -------------------------------------------------------
//
// P4.1 (docs/planning/warm-listener-cache-2026-09-05.md). Everything above this
// point decides an EPHEMERAL mint: a registration that lasts one job. A warm
// listener is the opposite kind of object — a STANDING registration, built and
// torn down on a separate path, precisely because `assertSafeJitConfig` above
// REQUIRES `Ephemeral: 'True'` and must keep requiring it (§12.16 still applies
// to the payload a warm listener runs from). Nothing here changes admission or
// the ephemeral mint path; the warm cache is additive capacity those functions
// already know how to count once it exists (a warm listener serving a job is a
// standing registration like any other, and `admitMint`'s `standingBusy` was
// written for exactly that shape).

/** Where a warm listener's slot lives. Cache of ONE, so there is no index —
 * unlike {@link slotDir}, which is per-mint and numbered. A fixed path is also
 * how discovery works: the marker file beside it records which repo is
 * currently registered there, because that fact must survive an mgmt-api
 * restart the same way every other fact in this workstream does (§12.8, B9) —
 * on the NODE, not in memory. */
export function warmSlotDir(home: string): string {
	return `${home}/.hadoku/warm/listener`;
}
