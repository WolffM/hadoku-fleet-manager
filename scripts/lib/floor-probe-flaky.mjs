/**
 * floor-probe's §5 flaky rule — split out of `floor-probe.mjs` (wave 5q lane A,
 * pure move) so that file reaches the 800-line ceiling. No IO here either; see
 * that file's own header for why the split exists at all.
 *
 * `tripleKey`/`TRIPLE_SEP` are exported because `floor-probe-ranking.mjs`'s
 * `buildCandidateList` builds the same composite key to test a candidate
 * against the `flaky` list this file produces — ONE key function, not two that
 * agree until one moves.
 */

// ---------------------------------------------------------------------------
// §5 — the flaky rule
// ---------------------------------------------------------------------------

/** §5.3 — points against one triple before the verdict lands. */
export const FLAKY_POINTS = 2;
/** §5.5 — consecutive clean probes on the triple that clear it. */
export const RECOVERY_PROBES = 5;

/**
 * The separator inside a composite `(node, repo, job)` key.
 *
 * NOT A SPACE, and the escape is written out rather than typed as a literal.
 *
 * A space looks obvious and is wrong on this fleet's own data: `hadoku_site`
 * has a job called `Build variants`, so `'claw-2 WolffM/hadoku_site Build
 * variants'.split(' ')` destructures to job `'Build'` — a flaky verdict silently
 * scoped to a unit that does not exist, which is the mis-attribution §5.4 exists
 * to prevent. `\u0000` cannot occur in a repo or job name.
 *
 * SPELLED AS AN ESCAPE because the first version of this file carried the byte
 * itself. Seven of them. Everything worked — join and split agreed — but git
 * classifies a file containing a NUL as BINARY: no diff, no `git grep`, no code
 * review. A correct value that makes the file unreviewable is not an acceptable
 * trade for two characters.
 */
export const TRIPLE_SEP = '\u0000';

export const tripleKey = (e) => `${e.node}${TRIPLE_SEP}${e.repo}${TRIPLE_SEP}${e.job}`;

/**
 * §5 — decide `flaky-for-(node, repo, job)` from settled probe outcomes.
 *
 * `outcomes` are the harness's own settled ledger entries, oldest first. Two
 * shapes matter:
 *
 *   - `{ node, repo, job, conclusion }` — a probe that RAN on `node`. A success
 *     is the intervening pass §5.3 requires and a step toward §5.5's recovery.
 *   - `{ node, repo, job, conclusion: 'success', against: '<node>' }` — a
 *     re-dispatch that passed on a DIFFERENT node after `against` failed. That
 *     is the one point of evidence §5.2 describes.
 *
 * FOUR THINGS THIS DELIBERATELY DOES NOT DO, each named in §5:
 *
 *   - It never acts on one point. A content-zone failure that happens to
 *     coincide with a bad node is not evidence.
 *   - Scope is `(node, repo, job)`, NEVER the node alone. claw-2's OOM history
 *     is fleet overcommitment, not claw-2 incapability, and a verdict that
 *     generalised would demote a healthy claw for a scheduling mistake.
 *   - A pass on that node for that unit resets the points to zero. Two points
 *     count only "with no intervening pass".
 *   - It never EXCLUDES. A flaky verdict moves a candidate to the back of the
 *     order; `excluded` is for certainties.
 */
export function flakyVerdicts(outcomes = []) {
	const state = new Map();
	const get = (k) => {
		if (!state.has(k)) state.set(k, { points: 0, clean: 0, flaky: false });
		return state.get(k);
	};
	for (const o of outcomes) {
		if (!o || !o.node || !o.repo || !o.job) continue;
		if (o.against && o.conclusion === 'success' && o.against !== o.node) {
			// Evidence against the node that failed, not against the one that passed.
			const s = get(tripleKey({ node: o.against, repo: o.repo, job: o.job }));
			s.points += 1;
			s.clean = 0;
			if (s.points >= FLAKY_POINTS) s.flaky = true;
			continue;
		}
		const s = get(tripleKey(o));
		if (o.conclusion === 'success') {
			s.points = 0;
			s.clean += 1;
			if (s.clean >= RECOVERY_PROBES) s.flaky = false;
		} else {
			// A failure ON the node is not itself a point — §5.2 requires the
			// re-dispatch to have PASSED elsewhere. It does break a recovery run,
			// because recovery is "5 CONSECUTIVE clean probes".
			s.clean = 0;
		}
	}
	const out = [];
	for (const [k, s] of state) {
		const [node, repo, job] = k.split(TRIPLE_SEP);
		if (s.flaky) out.push({ node, repo, job, points: s.points, cleanProbes: s.clean });
	}
	return out.sort((a, b) => a.node.localeCompare(b.node) || a.repo.localeCompare(b.repo));
}
