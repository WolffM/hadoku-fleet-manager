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
 * Exists because mint failures reached NOTHING (handoff §5 item 1): they were a
 * `logger.warn` in dispatch-pass.ts with no report field, no panel and no alert,
 * so a node dead for JIT looked identical to a node with nothing to mint. The
 * 409 name collision ran at ~7% of mints for the pilot's entire life and was
 * found by grepping a pm2 buffer that rolls, not by anything the fleet said.
 *
 * EVERY COUNT IS NULLABLE ON PURPOSE. The fast loop wraps the dispatcher in a
 * `.catch` so a JIT bug cannot stop label toggling — which means a pass that
 * THREW previously rendered the same as a pass that minted nothing. `null` with
 * `error` set is "I could not look"; `0` is "I looked, there was nothing".
 */
export interface FleetDispatch {
	/** When the last pass finished. `null` = it has not run since restart. */
	at: string | null;
	/** `null` when the pass threw — see `error`. Never conflate with 0. */
	minted: number | null;
	failed: number | null;
	skipped: number | null;
	inFlight: number | null;
	reaped: number | null;
	/** The throw from the last pass, if it threw. */
	error: string | null;
	/**
	 * Start of the current unbroken run of passes that failed every mint they
	 * attempted. `null` = not currently failing. This is the field that answers
	 * "is this machine dead for JIT", which a single-pass count cannot.
	 */
	failingSince: string | null;
	/** Since process start, so a panel can show a RATE rather than one tick. */
	totals: { minted: number; failed: number };
	/**
	 * The last pass that minted anything. A pass runs every 15s and most mint
	 * nothing even while the fleet is busy, so `minted` read `0` beside eight
	 * jobs in flight (2026-10-25). `null` = nothing minted since restart.
	 */
	lastMintAt: string | null;
	/**
	 * Mints and failures over the trailing hour, cut at `recent.since` — which is
	 * the process start when that is later, so a fresh restart never reads as a
	 * quiet hour.
	 */
	recent: { since: string; minted: number; failed: number };
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

export interface FleetReservation {
	reserved: boolean;
	reason: string | null;
	detail: string | null;
}
