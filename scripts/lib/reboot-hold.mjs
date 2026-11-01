/**
 * The reboot cycle's drain-reason naming convention, and the pure predicate
 * over it — split out of `reboot-cycle.mjs` (wave clean-1 lane D, cut (iii)
 * layer debt) so an observation-layer reader (`doctor-run.mjs`) can tell
 * whether a drain record is a reboot-cycle hold without reaching into the
 * cycle's own orchestration (`runRebootCycle`, `judgeReprove`, etc.), which
 * stays in `reboot-cycle.mjs`. That file re-exports all three names unchanged
 * for its own internal use and any other existing importer.
 */

/** Every drain this cycle writes starts with this, and it undoes only those. */
export const REASON_PREFIX = 'automated reboot';

/** A node this cycle rebooted and could not verify is held under this; a human lifts it. */
export const HELD_PREFIX = `${REASON_PREFIX} FAILED verification`;

/**
 * Is this drain record a FAILED verification's hold? It starts with
 * REASON_PREFIX too, so without this the legacy-prefix rule in `oursOn` would
 * read the hold as the cycle's own drain and the next resume would undo it.
 */
export function heldByCycle(rec) {
	return String(rec?.reason ?? '').startsWith(HELD_PREFIX);
}
