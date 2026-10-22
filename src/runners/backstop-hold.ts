/**
 * Which nodes the BACKSTOP currently holds eligible — its own record of what it
 * promoted, published for the fast loop.
 *
 * The backstop (runner-health) is the ONLY writer of `hadoku-builder` on a
 * guest. The fast loop reads this to know whether a guest is a standing runner
 * that can take a queued job right now (`standingEligible`), which decides the
 * dispatcher's age gate. Reading the backstop's record, rather than inferring
 * it, is the point: the retired tier ladder kept its own belief about the same
 * label, and the two were measured undoing each other ~8s apart every ten
 * minutes on 2026-08-29.
 *
 * Deliberately NOT persisted. It is a statement about what this process did a
 * few seconds ago, and a restarted process has not promoted anything.
 */

let held: ReadonlySet<string> = new Set();

/** Replace the hold wholesale. The backstop's decision is the whole truth. */
export function setBackstopHold(nodes: Iterable<string>): void {
	held = new Set(nodes);
}

export function isBackstopHeld(node: string): boolean {
	return held.has(node);
}

/** Test seam and diagnostics; the set is copied so a caller cannot mutate it. */
export function backstopHold(): string[] {
	return [...held].sort();
}
