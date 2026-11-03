/**
 * TRAFFIC — who gets the next job, among the nodes that could take it.
 *
 * THE TWO QUESTIONS ARE SEPARATE:
 *
 *   CAN this node run this job?   Capability, drain, health, admission —
 *                                 `choosePlacement` in placement.ts.
 *   SHOULD it get THIS one?       Ordering. This file.
 *
 * `choosePlacement` walks this order and refuses any node that cannot take the
 * job, so an ordering here can never hand a job to a node that cannot run it.
 *
 * `choosePlacement` ALSO RE-RANKS what this function produced, for the ONE job
 * it is placing (#102, wave 4c): busy counted here is a per-TICK snapshot,
 * while a burst within one tick needs each placement to see the ones before
 * it. Warm affinity (P5.1) and heavy-kind avoidance (#102.4) live there too,
 * as TIE-BREAKS layered on top of THIS function's own busy/speed/idle/name
 * ranking — never a second ranking that can disagree with it. See
 * `choosePlacement`'s own doc for the full comparator and why it was pulled
 * out of an unconditional stable-sort that used to override busy entirely.
 *
 * ONE ORDERING, DERIVED FROM OBSERVED LOAD: fewest busy runners first, then the
 * fastest MEASURED node, then the node idle longest. Not a round-robin counter
 * — a counter is a DECLARATION of what should have happened, and it drifts from
 * what did (a restart resets it, a job that failed to start still advanced it,
 * work GitHub assigned directly is invisible to it). Observed load is
 * self-correcting and needs no state.
 *
 * THE SPEED STEP IS A TIE-BREAK, NEVER A PRIORITY (wave 3z, #83's continuous
 * sibling — operator, 2026-10-05: "if the best claws are already working, i
 * dont necessarily want to stress them further"). It sits strictly AFTER
 * `busy`: a busy fast node never beats an idle slow one. Among nodes tied on
 * `busy` it breaks the tie `longest idle` used to own alone — a free claw-3
 * (measured factor ~1.4) and a free claw-8 (~0.6) used to take work in
 * rotation; now the faster one wins the tie and idle time only decides a
 * further tie between two nodes of equal (or unmeasured) speed.
 *
 * WHY ONLY ONE. There used to be a `tiered` policy walking a hand-maintained
 * ladder in `runner-tiers.json`, selected by that file's `trafficPolicy` key.
 * The key never reached the dispatcher — the tick built the dispatch input
 * without it — so JIT placement ran `tiered` over the fleet manifest's JSON KEY
 * order while the operator had configured `carousel`. That is why claw-1, the
 * first key, took 47% of dispatcher-placed jobs over the 24h to 2026-09-09. The
 * ladder and the key were retired on 2026-09-21; per-node limits (thermal or
 * otherwise) are `maxConcurrent` in the fleet manifest, which admission enforces.
 */

/** What the ordering needs to know about a candidate. Deliberately minimal. */
export interface TrafficNode {
	name: string;
	/** Runners on this node GitHub currently reports as running a job. */
	busy: number;
	/**
	 * Can GitHub actually place a job here?
	 *
	 * From runners/schedulable.ts, which exists because "the box has room" and
	 * "GitHub can reach it" come apart exactly when a node is broken in the way
	 * that matters most: on 2026-09-02 claw-4 answered ssh, ran zero workers and
	 * reported two free slots, while all 26 of its registrations were offline
	 * and crash-looping.
	 *
	 * CAROUSEL MAKES THAT FAILURE WORSE IF IT IGNORES THIS. Ordering by "fewest
	 * busy" ranks a node with zero working registrations FIRST — it looks
	 * perfectly idle — so an unschedulable node would win every placement and
	 * the whole queue would pile onto the one box that cannot take it.
	 *
	 * `undefined` means nobody looked, and is treated as schedulable: absent
	 * evidence must not silently remove a working node from the fleet.
	 */
	schedulable?: boolean;
	/**
	 * Seconds since this node last finished or started work, if known.
	 *
	 * `null` means nobody looked — which is NOT "idle forever". It sorts LAST
	 * among equals rather than first, so an unmeasured node never wins a
	 * tie-break it did not earn.
	 */
	idleSeconds: number | null;
	/**
	 * This node's measured speed factor from `SpeedModel.factorOf` (#83's
	 * continuous sibling, wave 3z): 1.0 is typical, lower is faster, higher is
	 * slower. `null` means the node's history is too thin to judge (`'unknown'`
	 * tier) — treated as exactly 1.0 (NEUTRAL), never as fast or slow, so a
	 * brand-new or thin-history node competes on `busy`/idle alone rather than
	 * being favored OR penalized for a measurement nobody has yet.
	 */
	speedFactor: number | null;
}

/**
 * Order the candidates a job may be placed on.
 *
 * `candidates` is every node the caller vetted, in any order; the result is a
 * permutation of it. Ties that survive load, measured speed and idle time fall
 * back to the node NAME, so the order is a pure function of what was observed
 * — never of which node a file happens to list first.
 */
export function orderCandidates(
	candidates: readonly string[],
	nodes: readonly TrafficNode[]
): string[] {
	const byName = new Map(nodes.map((n) => [n.name, n]));
	const known = candidates.filter((n) => byName.has(n));
	const unknown = candidates.filter((n) => !byName.has(n)).sort();

	// UNSCHEDULABLE NODES GO LAST, never out. Dropping them would silently shrink
	// the fleet on a transient GitHub read; ranking them last means a job reaches
	// them only when nothing else can take it, which is the correct weight for
	// "we believe GitHub cannot place here". Ordering by "fewest busy" alone would
	// rank a node with zero working registrations FIRST — it looks idle.
	const placeable = known.filter((n) => byName.get(n)?.schedulable !== false);
	const unplaceable = known.filter((n) => byName.get(n)?.schedulable === false).sort();

	const sorted = [...placeable].sort((a, b) => {
		const x = byName.get(a)!;
		const y = byName.get(b)!;
		// 1. Fewest jobs in flight. This is the whole point: spread the work.
		if (x.busy !== y.busy) return x.busy - y.busy;
		// 2. Fastest MEASURED node (#83's continuous sibling). `null` (thin
		//    history, `'unknown'` tier) reads as exactly 1.0 — NEUTRAL, so an
		//    unmeasured node competes on this step like a typical one rather than
		//    winning or losing a tie-break nobody earned. This is a TIE-BREAK
		//    after `busy`, never ahead of it — see this file's header comment.
		const xf = x.speedFactor ?? 1.0;
		const yf = y.speedFactor ?? 1.0;
		if (xf !== yf) return xf - yf;
		// 3. Idle longest first, so equals rotate. An unmeasured node (`null`)
		//    sorts last among equals: it must not win a tie-break it did not earn.
		const xi = x.idleSeconds ?? -1;
		const yi = y.idleSeconds ?? -1;
		if (xi !== yi) return yi - xi;
		// 4. Name, so a genuine tie is still deterministic.
		return a < b ? -1 : a > b ? 1 : 0;
	});

	// Nodes with no observation go last, never first. An unmeasured node looks
	// idle to every heuristic here, and promoting it on that basis is how a box
	// nobody has looked at attracts the whole queue.
	return [...sorted, ...unplaceable, ...unknown];
}
