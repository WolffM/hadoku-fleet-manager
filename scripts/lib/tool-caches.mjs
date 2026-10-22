/**
 * Which tool caches a node keeps for work it no longer does.
 *
 * THE GAP THIS CLOSES. `excludeRepos` is a scheduling directive with no cleanup
 * half: it moves the WORK and leaves the FOOTPRINT. The runner install half was
 * always covered (`reconcile --remove-excluded` calls removeScript), but nothing
 * has ever touched what the work left in `~/.cache`.
 *
 * Measured 2026-09-01: claw-3 held 5.5 GB under `~/.cache/trunk` while having
 * run ZERO vibecheck and ZERO watchparty jobs in the entire 14-day history —
 * both are in its `excludeRepos` from the 2026-08-19 rebalance. The node
 * deliberately lightened in August was carrying the fleet's second-largest cache
 * for work it is forbidden to run.
 *
 * WHY NOT AGE, WHICH IS THE OBVIOUS ANSWER AND THE WRONG ONE
 * ----------------------------------------------------------
 * A cache for work a node no longer does does go stale — but staleness cannot be
 * MEASURED here, and every available proxy is broken in a way that deletes
 * something expensive:
 *
 *   - directory mtime does not move when files inside are read;
 *   - newest-file-inside does not either. A pnpm store is written once and read
 *     forever, so a store in daily use looks identical to an abandoned one;
 *   - atime would be right and is not trustworthy — the fleet mounts relatime,
 *     and a node can be mounted noatime without anything noticing.
 *
 * So an age rule would eventually delete `~/.cache/pnpm` on the busiest node in
 * the fleet and report a successful reclaim doing it.
 *
 * WHAT IS ACTUALLY KNOWABLE
 * -------------------------
 * Not "has this cache been used recently" but "is this cache's REASON still
 * here". A cache exists to serve repos; the fleet already knows exactly which
 * repos a node serves. Declare the mapping once, as data, and the question
 * becomes exact rather than heuristic — the same move `fleet-runner-manifest`
 * made when it stopped storing a machine property inside ten repositories.
 *
 * A cache with no declared owners is never reclaimed. Silence means "nobody has
 * said what this is for", which is not the same as "nothing needs it", and the
 * fail-safe direction here is to keep bytes rather than delete a store.
 */

/**
 * @param {object} i
 * @param {string} i.node
 * @param {Record<string,{path:string, repos?: string[]}>} i.caches
 *   Declared tool caches: name -> where it lives and which repos put it there.
 * @param {(node: string) => string[]} i.reposOn
 *   Repos this node currently serves. The SAME source the reconciler places
 *   runners from, so a cache and an install can never disagree about coverage.
 * @returns {{name:string, path:string, reason:string}[]}
 */
export function reclaimableCaches({ node, caches, reposOn }) {
	const served = new Set(reposOn(node) ?? []);
	const out = [];
	for (const [name, spec] of Object.entries(caches ?? {})) {
		const owners = spec?.repos ?? [];
		// UNDECLARED IS NOT UNUSED. A cache nobody has claimed is left alone —
		// see the header. This is the branch that keeps `~/.cache/pnpm` alive
		// while it has no `repos` entry.
		if (!owners.length) continue;
		const stillServed = owners.filter((r) => served.has(r));
		if (stillServed.length) continue;
		out.push({
			name,
			path: spec.path,
			reason:
				`${node} serves none of its ${owners.length} declared repo(s) ` +
				`(${owners.join(', ')}) — the work moved, the cache did not`,
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}
