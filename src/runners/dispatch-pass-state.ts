/**
 * THE DISPATCH PASS'S CROSS-TICK MEMORY — three independent trackers a pass
 * reads and updates on every call, none of it read back from disk (lost on an
 * mgmt-api restart, which is the SAFE direction for all three — see each
 * one's own doc below). Split out of `dispatch-pass.ts` (wave shrink-1 lane
 * B, 800-line ceiling) so the bookkeeping sits apart from the pass that
 * reads and updates it; `dispatch-pass.ts` re-exports every name here under
 * its original path.
 */
import { REAP_IDLE_INTERVAL_MS } from './ephemeral-exec-reap.js';
import { HEAVY_MARK_MS } from './heavy-marks.js';

export { HEAVY_MARK_MS };

/** node -> when this pass last placed or saw a heavy job there. Module state:
 *  lost on restart, which only reopens the ≤60 s window the probe leaves.
 *  Copied to disk for `fleet warm-canary` (`heavy-marks.ts`); never read back.
 *  A `Map`, so `dispatch-pass-warm-heavy.ts`'s own write (`.set`) needs no
 *  wrapper — only a REASSIGNED primitive (see `affinity` below) does. */
export const heavyMarkedAtMs = new Map<string, number>();

/** Did a dispatch pass place or see a heavy job on `node` within HEAVY_MARK_MS? */
export function heavyMarkedRecently(node: string, nowMs: number): boolean {
	const at = heavyMarkedAtMs.get(node);
	return at !== undefined && nowMs - at < HEAVY_MARK_MS;
}

/** Test seams. */
export function __resetHeavyMarksForTesting(): void {
	heavyMarkedAtMs.clear();
}
export function __markHeavyForTesting(node: string, atMs: number): void {
	heavyMarkedAtMs.set(node, atMs);
}

/**
 * Per repo: when the sweep last READ its listing, and whether that listing still
 * held a `jit-*` registration afterwards. See REAP_IDLE_INTERVAL_MS (#116).
 *
 * The same kind of state as a cadence clock — a rate limiter, not a fact any
 * decision reads. Lost on restart, the next sweep walks every repo: the safe
 * direction, once.
 *
 * `heldJit` is GitHub's answer, off the reap's own listing — not a record of
 * what this process minted. The mint record below only ever ADDS a repo to a
 * sweep; nothing in this process's memory can take one out of it.
 */
export const reapBook = new Map<string, { listedAtMs: number; heldJit: boolean }>();
/** repo -> when this process last minted there. Adds work; never removes it. */
export const mintedAtMs = new Map<string, number>();

/**
 * The repos this sweep must list: any never listed, any that last held a JIT
 * registration, any minted to since its listing, and every other one once
 * REAP_IDLE_INTERVAL_MS has passed.
 */
export function reapTargets(repos: readonly string[], nowMs: number): string[] {
	return repos.filter((repo) => {
		const seen = reapBook.get(repo);
		if (!seen || seen.heldJit) return true;
		if ((mintedAtMs.get(repo) ?? -Infinity) >= seen.listedAtMs) return true;
		return nowMs - seen.listedAtMs >= REAP_IDLE_INTERVAL_MS;
	});
}

/** Test seam. Not part of the supported API. */
export function __resetReapBookForTesting(): void {
	reapBook.clear();
	mintedAtMs.clear();
}

/**
 * Did warm affinity DECIDE where the dispatcher's mints went, or were they warm
 * by chance? (`warm-affinity-measured-2-2026-09-15.md` §5e.)
 *
 * Three counts per mint that SUCCEEDED, each a subset of the one before:
 *   minted              every successful JIT mint
 *   mintedViaAffinity   ...landing on a node warm for that repo (the
 *                       concentration metric: 74 % with the term OFF)
 *   mintedAffinityMoved ...that plain ordering would have sent ELSEWHERE —
 *                       the term's own effect
 *
 * `lastPass` is the last pass that minted anything (`null` = none since
 * restart); `totals` are since process start. Neither is persisted: mgmt-api
 * restarts several times a day, so the RECORD is the per-pass `[dispatch]` log
 * line, summed across restarts. These are for a glance, not a re-cut.
 *
 * Defined here, not in `fleet-report-types-dispatch.ts` (wave clean-1 lane C,
 * cut (iii)): this is this module's own in-memory state — `affinity` below is
 * the one mutable copy, `getDispatchAffinitySnapshot` its one reader — so
 * `dispatch-pass.ts` (through this file) is the real owner.
 * `fleet-report-types-dispatch.ts` imports and re-exports it from
 * `dispatch-pass.ts` under its original path.
 */
export interface FleetDispatchAffinity {
	lastPass: {
		at: string;
		minted: number;
		mintedViaAffinity: number;
		mintedAffinityMoved: number;
	} | null;
	totals: { minted: number; mintedViaAffinity: number; mintedAffinityMoved: number };
}

/** Module state for {@link FleetDispatchAffinity}; resets on restart and is
 *  never read for a decision (see that type's own doc). A REASSIGNED
 *  binding, unlike the Maps above — mutated only through the functions
 *  below, so a module across a file boundary can update it without an
 *  illegal import reassignment. */
let affinity: FleetDispatchAffinity = {
	lastPass: null,
	totals: { minted: 0, mintedViaAffinity: 0, mintedAffinityMoved: 0 },
};

/** The affinity counters, for `GET /fleet`'s `dispatch.affinity`. */
export function getDispatchAffinitySnapshot(): FleetDispatchAffinity {
	return affinity;
}

/** Records one pass's successful mints into the running totals. No-op if
 *  `minted` is zero — a pass with nothing to report leaves `lastPass` as
 *  whatever the last REPORTING pass left it, exactly as the inline
 *  assignment this replaces did. */
export function recordAffinityPass(
	nowMs: number,
	minted: number,
	mintedViaAffinity: number,
	mintedAffinityMoved: number
): void {
	if (!minted) return;
	const t = affinity.totals;
	affinity = {
		lastPass: {
			at: new Date(nowMs).toISOString(),
			minted,
			mintedViaAffinity,
			mintedAffinityMoved,
		},
		totals: {
			minted: t.minted + minted,
			mintedViaAffinity: t.mintedViaAffinity + mintedViaAffinity,
			mintedAffinityMoved: t.mintedAffinityMoved + mintedAffinityMoved,
		},
	};
}

/** Test seam. Not part of the supported API. */
export function __resetAffinityCountersForTesting(): void {
	affinity = {
		lastPass: null,
		totals: { minted: 0, mintedViaAffinity: 0, mintedAffinityMoved: 0 },
	};
}
