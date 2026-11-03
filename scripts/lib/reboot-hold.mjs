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

/** From the reboot command to a reachable node on a new boot id. */
export const BOOT_TIMEOUT_MS = 12 * 60_000;
/** From a new boot to every runner unit and pm2 app back. */
export const SERVICES_TIMEOUT_MS = 6 * 60_000;

/**
 * Is the node's CURRENT drain record this cycle's own?
 *
 * By kind first. The reason prefix still counts, so a record a pass wrote as a
 * `lease` before the `reboot` kind existed is still finished and undone by the
 * next pass rather than stranded.
 */
export function oursOn(doc, node) {
	const rec = doc?.nodes?.[node];
	if (rebootNotice(doc, node)) return true;
	if (heldByCycle(rec)) return false;
	return rec?.kind === 'reboot' || String(rec?.reason ?? '').startsWith(REASON_PREFIX);
}

/**
 * The nodes this cycle has rebooted and is still entitled to wait on: the
 * in-flight record is `rebooting`, the node's drain is still the cycle's own
 * (not lifted, not held), and the cycle's own boot and services timeouts have
 * not run out since `rebootAt`. Past that moment the cycle holds the node, and
 * a cycle that died mid-reboot never will, so the clock answers for both. The
 * hosting converger reads this so a tenant's slice is not replaced during a
 * reboot that has not failed.
 */
export function cycleRebooting(state, doc, nowMs) {
	const f = state?.inFlight;
	if (f?.phase !== 'rebooting' || !Number.isFinite(f.rebootAt)) return new Set();
	if (nowMs - f.rebootAt >= BOOT_TIMEOUT_MS + SERVICES_TIMEOUT_MS) return new Set();
	return oursOn(doc, f.node) ? new Set([f.node]) : new Set();
}

/**
 * The cycle's PLANNED reboot drain on a node, or undefined: the notice a
 * hosting node's tenant is owed. On a whole-box host it sits in `planned`
 * over the hosting record, so `fleet drain --undo` cancels it and leaves the
 * tenant's record alone.
 */
export function rebootNotice(doc, node) {
	return (doc?.planned ?? []).find(
		(p) => p.node === node && p.kind === 'reboot' && !heldByCycle(p)
	);
}
