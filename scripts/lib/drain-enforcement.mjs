/**
 * drain-enforcement — is a drained node ACTUALLY not receiving work?
 *
 * WHY THIS CANNOT READ THE DRAIN FILE TO ANSWER
 * ---------------------------------------------
 * `fleet drain --status` reads the drain file and reports what it says. That is
 * a statement of INTENT, and it is the only thing anyone has been checking.
 *
 * On 2026-09-06 claw-5 was believed drained by three separate documents, the
 * measurement handoff said "do not undrain it", and it had served 27 mints. The
 * drain file said `"nodes": {}` — the drain had never landed. Nothing detected
 * that for days, because the only check available read the same file that was
 * wrong. A verifier that reads its own writer's artifact cannot fail.
 *
 * So this reads JOB HISTORY: what the fleet actually DID. A drained node that
 * started a job after it was drained is a drain that is not being enforced, and
 * that is true whichever of the two enforcement paths failed — dispatcher
 * placement for an ephemeral node, or the `hadoku-builder` label for a standing
 * one. `src/runners/drain.ts` is explicit that a drain implementing only one of
 * those "is worse than none"; this is what would catch it.
 *
 * THE GRACE WINDOW, AND WHY IT IS ABOUT START TIME
 * -----------------------------------------------
 * A drain never kills running work — `fleet drain` says so on the tin, and the
 * node reaches `drained` only once its current jobs finish. So a job that was
 * ALREADY RUNNING when the drain landed is correct behaviour, not a violation.
 * The discriminator is when the job STARTED, not when it ended.
 *
 * Assignment stops "within one fast-loop tick (~60 s)", so a job starting inside the
 * grace window after `since` was already in flight or in the pipe. Beyond it, a
 * new assignment reached a node that should have been invisible.
 */

import { nodeOf as runnerNodeOf } from '../../dist/runners/census.js';

/** Seconds after `since` in which a start is still attributable to the pipe. */
export const DEFAULT_GRACE_SEC = 180;

/**
 * @param {Record<string, {since: string, kind?: string, reason?: string}>} drained
 * @param {ReadonlyArray<{startedAt: string, repo?: string, name?: string}>} history
 *        records already resolved to a node via `nodeOf`
 * @param {(r: object) => string} nodeOf
 */
export function drainViolations(drained, history, nodeOf, { graceSec = DEFAULT_GRACE_SEC } = {}) {
	const out = [];
	for (const [node, rec] of Object.entries(drained ?? {})) {
		const since = Date.parse(rec?.since ?? '');
		if (!Number.isFinite(since)) {
			// A drain we cannot date cannot be checked, and "cannot check" is not
			// "enforced". Report it rather than skipping it quietly.
			out.push({
				node,
				kind: 'UNDATED',
				why: `drain record has no parseable "since" (${JSON.stringify(rec?.since ?? null)}), so enforcement cannot be judged`,
				jobs: [],
			});
			continue;
		}
		const after = [];
		for (const r of history) {
			if (nodeOf(r) !== node) continue;
			const started = Date.parse(r.startedAt);
			if (!Number.isFinite(started)) continue;
			if (started > since + graceSec * 1000) {
				after.push({ startedAt: r.startedAt, unit: `${r.repo ?? '?'}/${r.name ?? '?'}` });
			}
		}
		if (after.length) {
			after.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
			out.push({
				node,
				kind: 'NOT-ENFORCED',
				why:
					`drained since ${rec.since} but started ${after.length} job(s) after it — ` +
					`most recent ${after[0].startedAt} (${after[0].unit})`,
				jobs: after.slice(0, 5),
			});
		}
	}
	return out;
}

/**
 * Drained nodes that are behaving — reported so a clean run still shows its work.
 *
 * A gate that prints nothing when it passes teaches the reader that silence and
 * "not run" look identical, which is the same failure this whole file is about.
 */
export function drainHonoured(drained, violations) {
	const bad = new Set(violations.map((v) => v.node));
	return Object.entries(drained ?? {})
		.filter(([n]) => !bad.has(n))
		.map(([node, rec]) => ({ node, since: rec.since, kind: rec.kind ?? 'maintenance' }));
}

/**
 * Which node a job-history record ran on, for the drained nodes being checked.
 *
 * A history record names its RUNNER, and three name shapes reach this file:
 * `jit-claw-5-<repo>-j…`, `warm-claw-5-<repo>` (#90), and a standing runner
 * whose name IS the node. This used to be a second, local parser in
 * `check-drain-enforced.mjs` that only understood `jit-`, so a warm listener
 * fell through to its full name, matched no drain key, and the 23 jobs claw-5
 * served through `warm-claw-5-hadoku_site` while drained (#90) could not be
 * reported by the very gate meant to catch them (#91). The fleet's one runner
 * attribution is `census.ts`'s `nodeOf`, the same one `drain-node.mjs --status`
 * uses, so it is reused here rather than parsed a third way.
 *
 * `nodes` is the DRAINED set. That is enough: only a drained node can produce
 * a violation, and `nodeOf` resolves `claw-1` vs `claw-10` by the `<node>-`
 * prefix, so a shorter drained name cannot claim a longer node's runner.
 */
export function recordNodeOf(nodes) {
	const known = [...nodes];
	return (record) => runnerNodeOf(record?.runner ?? '', known);
}
