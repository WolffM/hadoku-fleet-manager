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
