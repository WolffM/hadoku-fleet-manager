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

import { isBackstopNode } from '../lib/node-role.js';
export {
	JIT_PREFIX,
	WARM_PREFIX,
	parseJitName,
	MAX_RUNNER_NAME,
	jitRunnerName,
	warmRunnerName,
} from '../lib/jit-naming.js';
export {
	type AdmissionInput,
	type AdmissionResult,
	LOWER_BOUND_HEADROOM,
	TMP_FREE_FLOOR_MB,
	WORK_FREE_FLOOR_MB,
	admitMint,
	spaceRefusal,
	assertSafeJitConfig,
} from './ephemeral-admission.js';
export {
	GITHUB_JOB_CEILING_SEC,
	JIT_UNIT_MAX_SEC,
	DEFAULT_RUNNER_SLICE,
	resolveSliceName,
	JOB_RESERVE_DEFAULT_MB,
	unitMemoryMaxMb,
	ciUnitProperties,
	backstopUnitMemoryMaxMb,
} from './ephemeral-slice.js';
// Warm-cache eligibility moved to src/lib/warm-eligibility.ts (wave clean-2
// lane C, cut (iii) layer debt): config, the stratum both this (ci-scheduling)
// file and scripts/check-warm-canary.mjs (observation) may import.
// `warmListenerSlots` below still needs `warmMemorySlots`, so it is imported
// (not just re-exported) alongside the rest.
import { warmMemorySlots } from '../lib/warm-eligibility.js';
export {
	type WarmEligibilityInput,
	warmEligibleSlots,
	warmMemorySlots,
	warmCacheEligible,
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

/**
 * How many concurrent jobs the dispatcher will run on one node, and WHERE that
 * number came from.
 *
 * ONE ANSWER, TWO READERS. `ephemeral-tick` mints against it and `routes/fleet`
 * reports it, so the panel and the dispatcher cannot disagree about a node's
 * budget.
 *
 * `maxConcurrent` is the only declaration. It is also the per-node ceiling for
 * anything that is not about memory — a thermally marginal node is capped here,
 * because admission enforces it on every mint. The `basis` is returned so a
 * panel can show a node running on the `default` guess rather than on anything
 * its operator chose: `scripts/enroll-node.mjs` omits `maxConcurrent` on
 * purpose, so a freshly enrolled node is exactly that case. (A borrowed
 * `tierCapacity` fallback sat between the two until the tier ladder was retired
 * on 2026-09-21; every node declared `maxConcurrent`, so it never fired.)
 *
 * `warmListeners` IS A SPEND AGAINST THAT CEILING, NOT A SECOND CEILING.
 * `maxConcurrent` bounds CONCURRENT WORK on the box; every warm listener the
 * node holds can be handed a job by GitHub without passing through this
 * function at all, so a listener occupies one of those slots whether or not it
 * is holding a job this instant. What is left is what the dispatcher may MINT.
 * Measured on claw-3 over the 14 days to 2026-09-22 (n=927): max concurrent JIT
 * units 3 — the cap held exactly for mints — and max concurrent including the
 * warm listener 4, at 48 job starts, every one of them the listener taking a
 * hadoku_site job while three JIT jobs ran. `maxConcurrent: 3` went on that node
 * on 2026-08-17 after two thermal-crash reboots and, since the tier ladder was
 * retired on 2026-09-21, it is the ONLY thermal control there. A cap that binds
 * one of a node's two intake paths is not a cap.
 *
 * SIZED HELD, NOT BUSY-RIGHT-NOW, and for the same reason {@link
 * warmEligibleSlots} sizes the listener's MEMORY busy: the listener does not
 * ask. A reservation conditional on an observation of "it is idle" is decided
 * in this process and spent by GitHub 200 ms later — which is exactly the race
 * those 48 starts are. The two units are now consistent: a node holds a
 * listener only when its memory half AND its count half each hold a whole job
 * beside it.
 */
export type MintBudgetBasis = 'declared' | 'default';

export interface MintBudget {
	slots: number;
	basis: MintBudgetBasis;
}

/**
 * @see MintBudget
 *
 * The RETURN SHAPE is unchanged by the reservation on purpose: `slots` is what
 * the dispatcher may mint and has always been, so a caller that knows nothing
 * about warm listeners (the fleet panel's `routes/fleet`) keeps reporting the
 * node's whole ceiling, which is still the true bound on concurrent work there.
 */
export function mintBudget(m: {
	maxConcurrent?: number | null;
	/**
	 * Warm listeners this node HOLDS — standing registrations GitHub can hand
	 * work to without asking us. Each one spends a slot of the cap. Absent means
	 * none, which is every caller that predates the reservation.
	 */
	warmListeners?: number;
}): MintBudget {
	const held = Number.isFinite(m.warmListeners) ? Math.max(0, Math.floor(m.warmListeners!)) : 0;
	// Never below zero: a node whose whole cap is spent on listeners mints
	// nothing, and `warmConcurrencySlots` is what stops a listener landing there
	// in the first place.
	const spend = (slots: number): number => Math.max(0, slots - held);
	if (typeof m.maxConcurrent === 'number')
		return { slots: spend(m.maxConcurrent), basis: 'declared' };
	// The tick has always ended `?? 1` rather than refusing to mint. Kept: a
	// node that mints one job at a time is recoverable, a node the dispatcher
	// silently skips looks identical to a broken one.
	return { slots: spend(1), basis: 'default' };
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

/**
 * How many warm listeners a node's own CONCURRENCY CAP leaves room for — the
 * count half of eligibility, beside {@link warmEligibleSlots}' memory half.
 *
 * The same shape as the memory rule and for the same reason. There, a listener
 * is eligible only when the JIT half still holds a whole mint; here, a listener
 * is eligible only when the cap still holds a whole JIT slot beside it. A node
 * capped at 1 that held a listener would have nothing left to mint with — the
 * dispatcher would skip it forever while every check on it read green — and a
 * node capped at 0 does not arise because {@link mintBudget} floors there.
 *
 * WHY THE CAP HAS TO BE CONSULTED AT ALL. `maxConcurrent` is enforced on the
 * MINT path (`admitMint`) and nowhere else, and on the machine by
 * `scripts/admin/ci-throttle.sh`, whose own manifest note records that it
 * "cannot enforce because MAX_WAIT_S=90 admits rather than fails". A standing
 * listener takes neither path: it is already registered and long-polling, so
 * GitHub hands it work directly. Until 2026-09-24 this function did not exist
 * and warm placement was a MEMORY test alone, which is how claw-3 — capped at 3
 * on thermals, 96-99 °C under load against a 100 °C trip — ran 4 concurrent
 * jobs 48 times in 14 days.
 *
 * UNDECLARED IS ZERO, not a guess: `mintBudget`'s `default` basis is one slot,
 * which the listener would take whole. A freshly enrolled node (enroll-node.mjs
 * omits `maxConcurrent` deliberately) therefore carries no listener until its
 * operator chooses a ceiling. That is the same direction every other "nobody
 * measured this" answer in this module takes.
 */
export function warmConcurrencySlots(m: { maxConcurrent?: number | null }): number {
	const { slots } = mintBudget(m);
	if (!Number.isFinite(slots)) return 0;
	// One slot back for the JIT half — see the memory rule's mint reserve.
	return Math.max(0, slots - 1);
}

/** What {@link warmListenerSlots} needs to know about one node. */
export interface WarmPlacementInput {
	/** `installedMb − minFreeMb`, MEASURED. Never the manifest's `ramGb`. */
	usableMb: number;
	/** One job's worth, in the unit a MINT uses — see {@link
	 * WarmEligibilityInput.jobMb}. */
	jobMb: number;
	/** `"claw"` | `"backstop"`. Read through `isBackstopNode`, never directly. */
	role?: unknown;
	/** The node's declared concurrency ceiling, or absent. */
	maxConcurrent?: number | null;
}

/**
 * How many warm listeners this node may hold: BOTH halves, one answer.
 *
 * ONE RULE, TWO READERS, and that is the whole point of it being here rather
 * than at either call site. `dispatchWarmCache` asks it to decide whether to
 * PLACE a listener; `dispatchEphemeral` asks it to decide how many slots of the
 * cap to hold BACK for one. If those two disagreed, either the node would carry
 * a listener nobody reserved for (the 48 starts) or reserve a slot for a
 * listener it is not allowed to hold (capacity thrown away for nothing). They
 * are handed the same measured `usableMb` and the same `jobMb` on the same
 * tick, so they cannot.
 *
 * The MINIMUM, because each half is a separate necessary condition: memory that
 * fits a listener beside a whole mint, and a cap that fits one beside a whole
 * JIT slot. Either reading zero is zero.
 */
export function warmListenerSlots(i: WarmPlacementInput): number {
	if (isBackstopNode(i)) return 0;
	return Math.min(warmMemorySlots(i.usableMb, i.jobMb), warmConcurrencySlots(i));
}

/**
 * The warm cache is a cache of ONE per node — see {@link warmRunnerName}, which
 * needs no run id or epoch precisely because there is never a second live
 * listener on a node to disambiguate from.
 */
export const WARM_CACHE_SIZE = 1;

/**
 * How many warm listeners this node actually HOLDS: the allowance
 * ({@link warmListenerSlots}) clamped to the cache of one.
 *
 * THE ALLOWANCE IS NOT THE HOLDING, and reserving against the allowance would
 * be a bug of its own — claw-3's memory admits two listeners at its 3400 MB job
 * figure, so a cap of 3 less two reserved leaves ONE JIT slot on the
 * second-busiest node in the fleet, to protect a listener the tick will never
 * mint. This is the number `mintBudget`'s `warmListeners` wants; the allowance
 * is what `warmCacheEligible` reads.
 */
export function warmListenersHeld(i: WarmPlacementInput): number {
	return Math.min(WARM_CACHE_SIZE, warmListenerSlots(i));
}
