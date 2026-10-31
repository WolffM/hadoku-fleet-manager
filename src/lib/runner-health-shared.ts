import os from 'node:os';

/**
 * EXPORTED so the queue-probe budget test multiplies by the REAL cadence.
 *
 * Not part of the package's client contract — `src/index.ts` does not re-export
 * it, and the test imports this module directly. A test that hard-codes "6 ticks
 * an hour" asserts its own arithmetic, not the code's, and would stay green
 * through exactly the change the assertion exists to catch: 2026-09-05 moved a
 * timer and quadrupled an unconditional sweep nobody had re-counted.
 */
export const TICK_INTERVAL_MS = 10 * 60 * 1000; // 10 min

/**
 * Ticks a runner must be offline before it is worth saying anything (~20 min at
 * TICK_INTERVAL_MS). A reboot or a Tailscale blip clears well inside that; a
 * node that is actually gone does not. Same debounce shape as
 * worker-health-alerts.
 */
export const OFFLINE_TICKS_BEFORE_ALERT = 2;

/**
 * The string `os.hostname()` returns for THIS box.
 *
 * Named for the meaning, not the word: `host` in this package is the injected
 * dependency container (`FleetHost`), and this used to be a private
 * `function host()` returning a hostname — the third meaning of the word spelled
 * as the first. See docs/VOCABULARY.md §"`host` is three different things".
 */
export function selfHostname(): string {
	return os.hostname();
}
