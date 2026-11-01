/**
 * The JIT reaper's own cadence constants — moved out of
 * `src/runners/ephemeral-exec-reap.ts` (wave clean-1 lane C/D, cut (iii)).
 * `scripts/reconcile-runner-identity.mjs` (observation, `fleet identity`)
 * tells an orphan the sweep has not REACHED yet from one it has FAILED to
 * clear using these same two numbers, and config is the one layer both that
 * script and the reaper (ci-scheduling) can legally reach.
 * `ephemeral-exec-reap.ts` re-exports both names here under their original
 * path.
 */

/**
 * How often the reap sweep may run, INDEPENDENT of the dispatch tick.
 *
 * The sweep costs one runner listing per repo. Since 2026-10-16 that listing
 * is CONDITIONAL — `ghGet` sends the last ETag, and GitHub's 304 is a statement
 * about the CURRENT registration list, so it is exactly as safe to delete on as
 * a full body, and free. That lowers the typical spend, not the ceiling: a repo
 * with jobs running changes its listing between sweeps (runners flip `busy`)
 * and is charged every time, so the arithmetic below is still the bound. When
 * it was written every call here was unconditional, and the ceiling was the
 * spend; that is what made this affordable at the ladder's 60s tick and fatal
 * at the dispatcher's 15s one:
 *
 *   27 repos x  60 ticks/hr =  1,620 calls/hr   (ladder cadence, fine)
 *   27 repos x 240 ticks/hr =  6,480 calls/hr   (15s cadence, over a 5,000 cap)
 *
 * Measured 2026-09-06, before this constant existed: the token hit
 * `remaining: 0` at ~:13 past EVERY hour and stayed there until the reset at
 * ~:33 — 19 minutes an hour with the fleet unable to poll or mint. All 6,903
 * rate-limited calls in the log were this one path. Jobs queued during the
 * blackout started at ~:32 regardless of when they arrived, which is what
 * `ci:queue-health` had been flapping on.
 *
 * 60s costs 1,620/hr and buys back the budget. Reaping faster cannot reap
 * anything sooner anyway: `graceMs` is 10 minutes, so an orphan is not eligible
 * until long after even the slowest cadence here would have seen it. The only
 * thing a faster sweep changes is how quickly an ALREADY-eligible orphan goes,
 * and that moves from ~10m15s to ~11m.
 */
export const REAP_INTERVAL_MS = 60_000;

/**
 * How old a JIT registration must be before the sweep may delete it. Exported
 * so `fleet identity` can tell an orphan the sweep has not REACHED yet from one
 * it has FAILED to clear, from this number rather than a second copy of it.
 */
export const JIT_REAP_GRACE_MS = 10 * 60_000;
