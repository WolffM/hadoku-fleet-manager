/**
 * Which nodes are serving pm2-host work right now — moved out of
 * `node-reservation.ts` (wave clean-1 lane C, cut (iii)).
 *
 * `node-reservation.ts`'s own header already says it: "runner-health is
 * still the only writer — it holds the runner listing already." The writer
 * (`runner-health-label-floor.ts`, observation) and a reader
 * (`node-reservation.ts`'s `getPm2HostBusy`, re-exported for `fleet-loop.ts`,
 * ci-scheduling) are in different domains, and this is rule 3 of the
 * refactor plan's placement rule (§3.2): fleet-manager's own runtime state,
 * one declared writer, regardless of which domain the record is about.
 * `node-reservation.ts` re-exports both names here under their original
 * path, so no existing importer changes.
 */

/**
 * Which NODES are serving pm2-host work, published by runner-health.
 *
 * A SET, not a flag. `pm2-host` has been PROBED rather than declared since
 * 2026-09-15 (#6), so a claw can EARN it and migration one's box will; one
 * boolean for two holders answers about the fleet when every caller is asking
 * about a box.
 *
 * A push rather than a probe: runner-health already holds the runner listing and
 * the in-progress runs, so it can answer this for free, while the fast loop runs
 * every 60s and must not spend an API call per tick re-asking. Stale by at most
 * one runner-health tick, which is fine — deploys are minutes long and the cron
 * signal, which is the one that matters at night, is exact.
 */
let pm2HostBusyNodes: ReadonlySet<string> = new Set<string>();

/**
 * Publish the whole set, never one node at a time.
 *
 * The writer holds ONE listing, and a node that has dropped off it is no longer
 * busy — an incremental setter would need a matching clear that nobody would
 * remember to call, and a node stuck `true` is a node silently withheld from CI
 * forever.
 */
export function setPm2HostBusy(nodes: Iterable<string>): void {
	pm2HostBusyNodes = new Set(nodes);
}

/**
 * Is `node` serving pm2-host work right now?
 *
 * WITH NO ARGUMENT it answers "is ANY node", which is the fleet-wide collapse
 * this set exists to end. It is kept for the one caller that has no node in
 * hand — `tickFleet`'s `pm2HostBusy` default parameter in `fleet-loop.ts`,
 * which reserves tiers by `RESERVABLE_NODES` membership rather than by asking
 * per machine. That call site is the last fleet-blind reader of this rung: it
 * over-reserves (a busy holder anywhere forces hokon's tier off), which costs
 * capacity rather than correctness, and converting it means restructuring the
 * fast loop's reservation to run per tier machine.
 */
export function getPm2HostBusy(node?: string): boolean {
	return node === undefined ? pm2HostBusyNodes.size > 0 : pm2HostBusyNodes.has(node);
}

/** Test seam. Not part of the supported API. */
export function __resetPm2HostBusyForTesting(): void {
	pm2HostBusyNodes = new Set<string>();
}
