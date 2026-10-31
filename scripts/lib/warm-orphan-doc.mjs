/**
 * warm-orphan-doc.mjs — which GateDoc half one `warmOrphans` entry belongs in
 * (wave 5j lane B's `reconcile-runner-identity.mjs`).
 *
 * `warmOrphans` already carries three distinct `why` shapes, from the second
 * look's own outcomes (see that file's "warm: a second look" section):
 *
 *   - "second look at <node> failed: ..."                         — the
 *     probe itself never completed a second time: "I could not look".
 *   - "no unit on <node>; re-reading the registration failed: ..." — the
 *     unit was absent and the FOLLOW-UP `gh` read that would confirm the
 *     registration still exists never completed either: also "I could
 *     not look".
 *   - "names no manifest node, so no unit can back it", or
 *     "no active unit on <node> on either look"                   — both
 *     looks actually completed; the registration is backed by nothing.
 *     A conclusion reached from data this run actually read.
 *
 * Extracted as a pure function for the same reason
 * `scripts/lib/throttle-drift-doc.mjs` pulled `classifyDrift` out:
 * `reconcile-runner-identity.mjs` reaches real nodes over ssh and `gh api`,
 * and there is no hermetic CLI-level fixture that makes the SECOND probe of
 * a node fail while the FIRST one (which is what turns the registration into
 * a suspect in the first place) succeeds — the shared ssh shim answers a
 * node the same way on every call it receives. So the one new piece of logic
 * this migration adds — telling "the second look itself failed" apart from
 * "the second look succeeded and found nothing" — is unit-tested here,
 * directly, over the exact strings that script already builds.
 */
const COULD_NOT_LOOK_TWICE = /second look at .* failed:|re-reading the registration failed:/;

/**
 * @param {string} why One `warmOrphans` entry's `why` field, as
 *   `reconcile-runner-identity.mjs` already builds it.
 * @returns {boolean} true when the SECOND LOOK itself never completed —
 *   "I could not look", never a finding.
 */
export function warmOrphanUnreadable(why) {
	return COULD_NOT_LOOK_TWICE.test(why);
}
