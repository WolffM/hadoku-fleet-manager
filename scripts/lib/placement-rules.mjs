/**
 * Which nodes a repo's work may land on.
 *
 * Lives here rather than in reconcile-fleet-runners.mjs because that file runs
 * `main()` at import: anything that needs this rule from outside the reconciler
 * would otherwise have to execute a fleet reconcile to ask a question.
 */

/**
 * Nodes ALLOWED to run this repo's work, standing registration or not.
 *
 * Separate from the reconciler's `placementFor`, which layers the standing-
 * registration rule on top of this. Two questions, one set of exclusion rules:
 *
 *   placementFor  -> "who holds a standing registration for this repo"
 *   mayRunRepo    -> "whose box may this repo's work land on at all"
 *
 * They diverge exactly on ephemeral nodes, and the divergence is the reason this
 * split exists. claw-3 holds no standing registration for anything
 * (`residentRepos: []`) and still mints for hadoku_site many times a day. Asking
 * `placementFor` whether claw-3 serves hadoku_site returns NO — correct for
 * placement, and catastrophic for anything reasoning about that node's
 * footprint: the tool-cache reclaim would read every declared cache on every
 * ephemeral node as abandoned and delete all of them.
 */
export function mayRunRepo(repo, manifest) {
	const needs = manifest?.repos?.[repo]?.needs ?? [];
	return Object.entries(manifest?.machines ?? {})
		.filter(([, m]) => m.placement !== 'excluded')
		.filter(([, m]) => !(repo in (m.excludeRepos ?? {})))
		.filter(([, m]) => needs.every((n) => (m.labels ?? []).includes(n)))
		.map(([name]) => name);
}

/**
 * Repos this node may run, out of the covered set. The inverse view, which is
 * what a per-NODE question (a cache, a disk budget) actually needs.
 */
export function reposOnNode(node, repos, manifest) {
	return (repos ?? []).filter((r) => mayRunRepo(r, manifest).includes(node));
}
