/**
 * The JIT-dispatch SECTION of the `GET /fleet` contract (wave 5r lane A pure
 * move out of `fleet-report-types.ts`): what the dispatcher did on its last
 * pass, whether warm affinity decided where mints landed, and the priority
 * ladder's own reservation state. See that file's own header for why this
 * is a type-only barrel's section rather than a runtime module —
 * `fleet-report-types.ts` re-exports every name below for every existing
 * importer.
 */

/**
 * What the JIT dispatcher did on its last pass.
 *
 * Moved to `fleet-loop.ts` (wave clean-1 lane C, cut (iii)): the fast loop's
 * own `lastDispatch` is the one mutable copy and `getDispatchSnapshot` its
 * one reader, so that domain module is the real owner — this file imports
 * and re-exports it from there under its original path, which is the
 * downward direction for a surfaces-layer barrel.
 */
export type { FleetDispatch } from './fleet-loop.js';

/**
 * Did warm affinity DECIDE where the dispatcher's mints went, or were they warm
 * by chance? (`warm-affinity-measured-2-2026-09-15.md` §5e.)
 *
 * Moved to `src/runners/dispatch-pass-state.ts` (wave clean-1 lane C, cut
 * (iii)): its own `affinity` is the one mutable copy and
 * `getDispatchAffinitySnapshot` its one reader, so that domain module is the
 * real owner — this file imports and re-exports it from there under its
 * original path. `dispatch-pass.ts` only ever imported this type for its own
 * use and never re-exported it (wave cruft-1 lane A dropped that unused
 * middle hop).
 */
export type { FleetDispatchAffinity } from './runners/dispatch-pass-state.js';

export interface FleetReservation {
	reserved: boolean;
	reason: string | null;
	detail: string | null;
}
