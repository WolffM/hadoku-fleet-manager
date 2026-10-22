/**
 * Nodes GitHub cannot currently place a job on.
 *
 * The second fact the two monitors have to share, and it exists for the same
 * reason as `backstop-hold`: runner-health knows something the fast loop and
 * the dispatcher act on, and neither may import the other.
 *
 * WHAT THE LADDER WAS COUNTING
 * ----------------------------
 * A tier's free slots come from the ssh probe: `capacity - Runner.Worker count`.
 * That measures whether the BOX has room. It says nothing about whether GitHub
 * can put a job there, and those come apart exactly when a node is broken in the
 * way that matters most.
 *
 * Measured 2026-09-02. claw-4 answered ssh, ran zero workers, and reported two
 * free slots into tier1 — while all 26 of its registrations were offline and its
 * units were crash-looping every six seconds on `the runner registration has
 * been deleted from the server`. `decideTiers` saw headroom above tier2, so
 * claw-5 and claw-6 stayed demoted and unlabelled, and five jobs queued behind a
 * single working claw. The healthiest-looking number in the fleet was the one
 * keeping capacity switched off.
 *
 * This is the same shape as the slice check reading `Slice=` instead of
 * `ControlGroup`, and the JIT panel reading a result it never received: a
 * DECLARED or LOCAL fact standing in for the EFFECTIVE one. Reachability is what
 * the node says about itself; schedulability is what GitHub will actually do.
 *
 * Deliberately NOT persisted, like the backstop hold. It is a statement about
 * what runner-health saw on its last pass, and a restarted process has seen
 * nothing — so an empty set is the correct answer. Empty means "no node is known
 * to be unschedulable", which fails toward the ladder's existing behaviour rather
 * than toward switching tiers on.
 */

/** Nodes with registrations that exist but are ALL offline. */
let unschedulable: ReadonlySet<string> = new Set();

/**
 * Replace the set wholesale. runner-health's view is the whole truth, and a
 * node that recovered must stop being penalised on the very next pass.
 */
export function setUnschedulableNodes(nodes: Iterable<string>): void {
	unschedulable = new Set(nodes);
}

/**
 * Can GitHub place a job on this node right now?
 *
 * A node this monitor has never heard of is schedulable — silence is not
 * evidence against a node, and treating it as such would zero the whole fleet's
 * capacity on the first tick after a restart.
 */
export function isSchedulable(node: string): boolean {
	return !unschedulable.has(node);
}

/** Test seam and diagnostics; copied so a caller cannot mutate the set. */
export function unschedulableNodes(): string[] {
	return [...unschedulable].sort();
}
