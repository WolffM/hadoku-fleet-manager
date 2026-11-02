/**
 * reconcile-claw-owner — which managed node owns a GitHub runner name.
 *
 * Moved out of `reconcile-fleet-runners.mjs` (wave shrink-1 lane D), body
 * unchanged.
 *
 * Declared nodes are read once so `clawOfRunner` can derive ownership
 * instead of matching hand-written name patterns.
 *
 * What matters to a queued job is that SOME labelled runner on that node
 * can take it, not which unix user supervises it, so every instance on a
 * box satisfies coverage for that box.
 *
 * Returns null for a name it does not recognise, and BOTH call sites in the
 * CLI fail safe on that: the present-registration scan reports it as
 * `unmanaged` and leaves it alone, and the orphan sweep skips it entirely.
 * That is what keeps a live JIT runner — named `jit-<node>-…`, which this
 * deliberately does not fold — from being deregistered mid-job by a sweep
 * that did not recognise it.
 */

import { loadManifest as readManifest } from './fleet-exec.mjs';

const NODE_NAMES = (() => {
	try {
		return readManifest().machines ?? {};
	} catch {
		return {};
	}
})();

/**
 * DERIVED from the declared nodes, never an enumerated suffix list. The
 * previous version hardcoded two incompatible patterns —
 * /^(claw-[123])(-b)?$/ and /^hokon(-b|-c|-d|-tenhands)?$/ — so every new
 * instance or hand-made runner name needed a code change, and the two forms
 * had already drifted apart.
 *
 * A runner belongs to the node whose name it exactly matches, or to the
 * LONGEST declared node name it is prefixed by. Longest wins so that a
 * future `claw-1x` cannot be captured by `claw-1`.
 *
 * @param {string} name
 */
export const clawOfRunner = (name) => {
	const names = Object.keys(NODE_NAMES);
	if (names.includes(name)) return name;
	const owner = names
		.filter((m) => name.startsWith(`${m}-`))
		.sort((a, b) => b.length - a.length)[0];
	return owner ?? null;
};
