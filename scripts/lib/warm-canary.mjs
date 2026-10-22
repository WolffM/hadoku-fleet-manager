/**
 * warm-canary — the decision half of `fleet warm-canary` (P4.5, issue #7).
 *
 * WHY THIS EXISTS
 * ---------------
 * `jit-canary.yml` proves the ephemeral dispatcher can actually SERVE A JOB,
 * because "idle" and "broken" render identically from outside for a JIT mint.
 * The warm cache has the exact same blind spot and, until issue #7, nothing
 * was watching it: every fill failed for as long as the cache existed and the
 * first anyone noticed was a tracker session reading `pm2 logs` by hand.
 *
 * UNLIKE jit-canary, THIS DOES NOT NEED A JOB
 * --------------------------------------------
 * A warm listener is a STANDING registration, so its existence is itself
 * observable without waiting for GitHub to schedule anything onto it —
 * `check-warm-canary.mjs` ssh's the eligible nodes directly and asks systemd,
 * the same question `currentWarmSlot()` (src/runners/ephemeral-exec.ts) asks
 * in-process. Reading the NODE, never mgmt-api's memory, is this repo's rule
 * for every fact in this workstream (§12.8, B9) — a canary that trusted its
 * own writer's bookkeeping could not fail.
 *
 * ELIGIBLE is the same rule the dispatcher enforces: ephemeral, not drained,
 * not a guest, and MEASURED usable memory (`installed − minFreeMb`) whose warm
 * half holds one busy listener — a job's worth — while the other half stays
 * reserved for cold mints — see `warmEligibleSlots`/`warmCacheEligible` in
 * src/runners/ephemeral.ts, imported here rather than re-typed so there is
 * exactly one implementation of the threshold to drift from.
 *
 * THE DENOMINATOR IS EVERY ELIGIBLE NODE, whatever that rule admits. If it
 * ever admits more nodes, each one is another node that must be HOLDING a
 * listener for this to pass — a newly eligible node that cannot hold one is a
 * failure, never a wider denominator for the warm ones to average into.
 *
 * This module is PURE: it takes per-node measurements already collected by
 * `check-warm-canary.mjs` (ssh + gh live) and turns them into one verdict, the
 * same split every I/O-vs-decision pair in this workstream keeps.
 */

/**
 * @typedef {object} WarmCanaryMeasurement
 * @property {string} node
 * @property {boolean} reachable
 * @property {number|null} totalMb - `free -m`'s total column, or null if unreachable.
 * @property {number} minFreeMb
 * @property {number} jobMb - one job's worth on this node, the unit a mint and
 *   a busy listener both occupy — see `WarmEligibilityInput.jobMb`.
 * @property {string} [role] - the manifest's role; a guest is never eligible.
 * @property {string|null} activeRepo - the repo an ACTIVE warm-* unit is
 *   currently registered for on this node, or null if none.
 */

/**
 * @typedef {object} WarmCanaryVerdict
 * @property {boolean} ok
 * @property {string|null} reason - why it failed; null when ok.
 * @property {string[]} eligible - candidate nodes with enough measured capacity.
 * @property {{node: string, repo: string}[]} warm - eligible nodes actually
 *   holding an active warm listener.
 * @property {string[]} unreachable - candidate nodes that could not be measured.
 */

/**
 * @param {WarmCanaryMeasurement[]} measurements - one entry per candidate node
 *   (ephemeral, not drained) — see check-warm-canary.mjs for how the
 *   candidate set itself is derived.
 * @param {{ warmEligibleSlots: (i: { installedMb: number, minFreeMb: number, jobMb: number, role?: unknown }) => number,
 *           warmCacheEligible: (slots: number) => boolean }} fns
 *   the library functions this reuses — injected so this module never
 *   imports `dist/` directly, which would make it untestable against a
 *   checkout that has not been built.
 * @returns {WarmCanaryVerdict}
 */
export function warmCanaryVerdict(measurements, fns) {
	const { warmEligibleSlots, warmCacheEligible } = fns;

	if (!measurements.length) {
		return {
			ok: false,
			reason:
				'no candidate node exists to check — every ephemeral node is either ' +
				'undeclared or drained, so the warm cache has nothing to prove itself against',
			eligible: [],
			warm: [],
			unreachable: [],
		};
	}

	const unreachable = measurements.filter((m) => !m.reachable).map((m) => m.node);
	const measured = measurements.filter((m) => m.reachable);

	// "I COULD NOT LOOK" MUST NEVER RENDER AS "NOTHING IS WRONG" — CLAUDE.md.
	// Every candidate refused to answer, so this run cannot vouch for anything,
	// including whether the cache is broken.
	if (!measured.length) {
		return {
			ok: false,
			reason: `could not reach any candidate node to measure its capacity: ${unreachable.join(', ')}`,
			eligible: [],
			warm: [],
			unreachable,
		};
	}

	const eligible = measured.filter(
		(m) =>
			m.totalMb !== null &&
			warmCacheEligible(
				warmEligibleSlots({
					installedMb: m.totalMb,
					minFreeMb: m.minFreeMb,
					jobMb: m.jobMb,
					role: m.role,
				})
			)
	);

	const warm = eligible
		.filter((m) => m.activeRepo)
		.map((m) => ({ node: m.node, repo: m.activeRepo }));
	const warmNodeNames = new Set(warm.map((w) => w.node));
	const eligibleNodeNames = eligible.map((m) => m.node);

	// "I COULD NOT LOOK" MUST NEVER RENDER AS "NOTHING IS WRONG", part two — a
	// candidate that did not answer might have been eligible and warm, or
	// eligible and broken; this run cannot tell which, so it must not pass on
	// the strength of the nodes it COULD reach. Checked before the capacity and
	// per-node checks below on purpose: NO GATE MAY GET EASIER TO PASS THE
	// WORSE THE FAILURE GETS, and a node going unreachable is a strictly worse
	// failure than one that answered and was simply cold — collapsing it into
	// "one fewer candidate to satisfy" is exactly that bug in a new place.
	if (unreachable.length) {
		return {
			ok: false,
			reason:
				`${unreachable.length} candidate node(s) unreachable (${unreachable.join(', ')}) — ` +
				`cannot vouch for the cache while any candidate could not be measured`,
			eligible: eligibleNodeNames,
			warm,
			unreachable,
		};
	}

	if (!eligible.length) {
		return {
			ok: false,
			reason:
				`${measured.length} candidate node(s) measured, none has room for a busy warm ` +
				`listener beside the 50% mint reserve — the cache has nothing to prove itself against`,
			eligible: [],
			warm: [],
			unreachable,
		};
	}

	// PER ELIGIBLE NODE, not "at least one" — a fleet with five eligible nodes
	// and one warm listener is 80% broken, and until this changed that read as
	// `ok: true` for six hours straight (issue #17). Every node this canary can
	// vouch for as eligible must be holding a listener, or the gate says so.
	const notWarm = eligibleNodeNames.filter((n) => !warmNodeNames.has(n));
	if (notWarm.length) {
		return {
			ok: false,
			reason:
				`${notWarm.length} of ${eligible.length} eligible node(s) not holding a warm ` +
				`listener: ${notWarm.join(', ')}`,
			eligible: eligibleNodeNames,
			warm,
			unreachable,
		};
	}

	return {
		ok: true,
		reason: null,
		eligible: eligibleNodeNames,
		warm,
		unreachable,
	};
}

/**
 * Candidates the warm path will NEVER give a listener, because the speed model
 * puts them in the slow tier (wave 3w, #83: a warm listener takes work with zero
 * queue, which would bypass the spill gate, so `ephemeral-tick.ts` evicts a
 * slow node's listener and never re-fills it).
 *
 * The canary used to count such a node as eligible and then fail because it was
 * not warm: `ci:audit-gates` reported "claw-5 not holding a warm listener", which
 * is the warm path doing exactly what it was told. Like a drained node, a
 * slow-tier node is taken out of the candidate set BEFORE measuring and reported
 * beside the verdict, never silently dropped.
 *
 * `buildSpeedModel` is injected (the shipped one from `dist/`, in the script) so
 * this module never imports `dist/` and stays testable unbuilt. An empty or
 * unreadable history yields no slow node: every node then reads `unknown`, the
 * canary keeps demanding a listener on all of them, and that is the strict
 * direction, never an easier pass.
 *
 * @param {readonly object[]} records - job-history records
 * @param {readonly string[]} nodeNames - the declared node roster
 * @param {(records: readonly object[], opts: {nowMs: number, nodes: readonly string[]}) => {tierOf: (n: string) => string, describe: (n: string) => {p25: number|null}}} buildSpeedModel
 * @param {number} nowMs
 * @returns {{node: string, p25: number|null}[]}
 */
export function slowTierCandidates(records, nodeNames, buildSpeedModel, nowMs) {
	const model = buildSpeedModel(records, { nowMs, nodes: nodeNames });
	return nodeNames
		.filter((n) => model.tierOf(n) === 'slow')
		.map((n) => ({ node: n, p25: model.describe(n).p25 }));
}
