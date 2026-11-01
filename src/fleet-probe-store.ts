/**
 * The fast loop's own per-node probe snapshot — moved out of `fleet-loop.ts`
 * (wave clean-1 lane C, cut (iii)).
 *
 * `fleet-loop.ts` (ci-scheduling) is the one writer, every tick
 * (`startFastLoop`'s call into `tick`); `runner-health-label-floor.ts`
 * (observation) is a reader — "the label floor now asks the census whether
 * any ephemeral node can MINT before it pages, and that answer comes from
 * this probe" — and `routes/fleet-report.ts` (surfaces) is another. A domain
 * reading another domain's fact through a STATE RECORD, never the writer's
 * own module directly, is rule 5 of the refactor plan's placement rule
 * (§3.2) — this is that record. `fleet-loop.ts` re-exports both names here
 * under their original path, so no existing importer changes.
 */
import type { NodeProbe } from './lib/node-probe.js';

let lastFleetProbe: { at: string; nodes: Record<string, NodeProbe> } | null = null;

export function getFleetProbeSnapshot(): {
	at: string;
	nodes: Record<string, NodeProbe>;
} | null {
	return lastFleetProbe;
}

/**
 * Test seam. Not part of the supported API.
 *
 * The label floor now asks the census whether any ephemeral node can MINT before
 * it pages, and that answer comes from this probe. Without a seam the only way to
 * reach the suppressing branch from a test is to run a whole fast-loop tick, so the
 * branch that decides whether the fleet pages would go untested — which is the
 * one direction that must not regress silently.
 *
 * Also `fleet-loop.ts`'s own production setter: the fast loop's tick and its
 * reset both call this directly rather than duplicating the assignment.
 */
export function __setFleetProbeForTesting(
	probe: { at: string; nodes: Record<string, NodeProbe> } | null
): void {
	lastFleetProbe = probe;
}
