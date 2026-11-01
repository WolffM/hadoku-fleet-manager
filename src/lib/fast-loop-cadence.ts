/**
 * The fast loop's own cadence constants — moved out of `fleet-loop.ts` (wave
 * clean-1 lane C/D, cut (iii)). `scripts/reconcile-fleet-runners.mjs`
 * (lifecycle) derives a minutes-between-reconciles figure from both, and
 * config is the one layer both `fleet-loop.ts` (ci-scheduling) and that
 * script can legally reach. `fleet-loop.ts` re-exports both names here under
 * their original path.
 */

/** Seconds between fast-loop passes: probe, repair, labels. */
export const FAST_LOOP_SECONDS = 60;

/**
 * How often to re-assert every node's labels against GitHub even when nothing
 * this loop can see has changed. At 60s polling this is roughly every 10
 * minutes — frequent enough that external drift is a blip, cheap enough that
 * the common case (already in the desired state) writes nothing at all.
 */
export const RECONCILE_EVERY_TICKS = 10;
