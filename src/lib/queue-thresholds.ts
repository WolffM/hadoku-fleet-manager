/**
 * Queue-staleness boundaries shared between the dispatcher's own discovery
 * (ci-scheduling) and the fleet gates that judge the same queue from outside
 * (observation) — moved out of `src/runners/queue-discovery.ts` (wave
 * clean-1 lane C/D, cut (iii)). `queue-discovery.ts` re-exports every name
 * here under its original path, so no existing importer changes.
 */

/**
 * Past this, a run is STUCK rather than starved and minting cannot help it.
 *
 * The pilot's first two mints went to runs queued since 2026-08-17 and
 * 2026-08-19 — ten and twelve days. Nothing will ever pick those up (a deleted
 * branch, a label no runner carries, a cancelled dependency), so a floor-only
 * gate mints for them every time the previous attempt TTLs out: a treadmill that
 * burns a slot an hour, forever, on work that does not exist.
 *
 * One hour is ~22x the fleet's measured queue p95 of 161 s. A run that has
 * genuinely waited that long in a 12-slot fleet is not waiting for capacity.
 */
export const MAX_QUEUED_MS = 3_600_000;
