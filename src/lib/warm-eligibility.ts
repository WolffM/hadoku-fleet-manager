/**
 * Warm-cache eligibility — whether a node has room for a warm listener at
 * all, by the MEMORY half of the rule alone. Moved out of
 * `src/runners/ephemeral.ts` (wave clean-2 lane C, cut (iii) layer debt):
 * both ci-scheduling (`dispatchWarmCache`/`dispatchEphemeral`, through
 * `ephemeral.ts`'s re-export) and observation (`scripts/check-warm-canary.mjs`,
 * which measures the identical "does this node have room for the listener
 * it is missing" question over ssh) need the same pure answer, and config is
 * the one layer both can legally reach. `ephemeral.ts` re-exports every
 * name here under its original path, so no existing importer changes.
 */
import { isBackstopNode } from './node-role.js';

/** What {@link warmEligibleSlots} needs to know about one node. */
export interface WarmEligibilityInput {
	/**
	 * `free -m`'s total column, MEASURED live — never the manifest's `ramGb`,
	 * which fleet-runner-manifest.json's own `$why-display-only` note says
	 * "DECIDES NOTHING" and is rounded (claw-1 measures 11885 MiB, not 11*1024).
	 */
	installedMb: number;
	/** The floor that keeps the box alive; `usable` is what is left above it. */
	minFreeMb: number;
	/**
	 * ONE JOB'S WORTH, in the unit a MINT uses: exactly what admission reserves
	 * for a job on this node whose repo it cannot name — `jobReserve`'s
	 * node/default answer, clamped to the unit's cap. The warm listener's repo
	 * is chosen AFTER eligibility (by the fleet allocator), so the node's figure
	 * is the only honest one here.
	 */
	jobMb: number;
	/** `"claw"` | `"backstop"`. Read through `isBackstopNode`, never directly. */
	role?: unknown;
}

/**
 * How many warm listeners a node may hold without touching the JIT reserve.
 *
 * TWO OBJECTS, TWO UNITS. This used to be `floor(usable / 4096) >= 2` — one
 * number standing in for both the thing reserved and the thing reserving. Now:
 *
 *   - THE MINT RESERVE is half of usable (`installedMb − minFreeMb`), the
 *     operator's settled "50% of usable reserved for JIT whatever the warm
 *     cache holds" (work arrives in bursts; what matters is several COLD repos
 *     wanting a mint at once). It is measured in MB and spent in `jobMb`
 *     units — one mint needs one job's worth.
 *   - THE LISTENER is sized at what it occupies BUSY, which is also `jobMb`:
 *     a warm listener serves the same jobs a JIT unit does and is capped the
 *     same (#26, settled). Its 44 MB (29 listeners, 1,304 MB RSS on hokon —
 *     `warm-listener-cache-2026-09-05.md` §1) is its IDLE rent, and it is NOT
 *     the figure the reservation is computed against.
 *
 * WHY BUSY AND NOT IDLE. A listener is idle only until it does the one thing
 * it exists for, and it does that WITHOUT PASSING ADMISSION — GitHub hands it
 * a job whatever the node's free memory says, whereas every mint is admitted
 * against live free memory first. The reserve exists for the burst, and in a
 * burst the listener is busy. Sized at 44 MB, claw-2 (usable 6336 MB) would
 * pass with 72 listeners to spare, and its one busy listener (p95 3337 MB,
 * 390 jobs) plus one cold mint (3400 MB reserved) is 6737 MB against 6336 —
 * the listener eligible by spending the mint reserve, which is the one thing
 * this rule may not do. Sizing the listener busy makes that impossible by
 * construction: the warm half and the JIT half are the same size, so a node
 * holds a listener only when its JIT half ALSO holds a full mint.
 *
 * A BACKSTOP HOLDS NONE, BY ROLE. hokon's 63402 MB passes any memory test that
 * can be written (it would read 6 here), so memory shape must not be what
 * excludes it: the backstop lends the fleet a reserve registration and is
 * otherwise none of the fleet's business (operator, 2026-09-14). The warm tick
 * also drops backstops before any ssh (`withoutBackstops`); this is the second
 * answer, so a caller that forgets the first still gets zero.
 *
 * TOTAL over its inputs: a non-positive or non-finite figure anywhere reads
 * as zero listeners — "I could not measure it" must never read as room.
 */
export function warmEligibleSlots(i: WarmEligibilityInput): number {
	if (isBackstopNode(i)) return 0;
	return warmMemorySlots(i.installedMb - i.minFreeMb, i.jobMb);
}

/** The memory half of {@link warmEligibleSlots}, over the node's USABLE figure
 * — the one both readers already have in hand (`installedMb − minFreeMb` in the
 * warm tick, `sliceCeilingMbByNode` in the dispatch tick). */
export function warmMemorySlots(usableMb: number, jobMb: number): number {
	if (!Number.isFinite(usableMb) || usableMb <= 0) return 0;
	if (!Number.isFinite(jobMb) || jobMb <= 0) return 0;
	const mintReserveMb = Math.ceil(usableMb / 2);
	return Math.max(0, Math.floor((usableMb - mintReserveMb) / jobMb));
}

/**
 * May a node hold a warm listener at all? At least one listener's busy
 * footprint must fit beside the untouched mint reserve — see
 * {@link warmEligibleSlots}, whose count this reads. DERIVED, not a name
 * check: on today's fleet it reads true for claw-1/3/4/5/8/9 and false for
 * claw-2/6 (their JIT half, ~3160 MB, holds less than one mint) and hokon
 * (backstop).
 *
 * The COUNT it is given decides everything, so which count matters: the warm
 * tick and the dispatch tick both pass `warmListenerSlots` (memory AND
 * the concurrency cap, in `ephemeral.ts`). The memory-only
 * {@link warmEligibleSlots} remains what `scripts/lib/warm-canary.mjs`
 * measures against, because the canary's question is "does this node have
 * ROOM for the listener it is missing", and a cap is not room.
 */
export function warmCacheEligible(listenerSlots: number): boolean {
	return listenerSlots >= 1;
}

// --- the concurrency half, and both halves together -------------------------
//
// Moved from src/runners/ephemeral.ts on 2026-11-09 (fleet-manager#79) so the
// canary judges eligibility by the rule the warm tick places by.

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
 * `scripts/ci-throttle.sh`, whose own manifest note records that it
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
