import { mayRunRepo } from './placement-rules.mjs';
import { mintsOnDemand, standingRepos } from '../../dist/lib/node-role.js';

/**
 * Turn two coverage snapshots into the specific lines that differ.
 *
 * Ordering is reported separately from membership: a list with the same members
 * in a different order is a formatting fix, while a gained or lost repo is a
 * scope change, and collapsing both into "DIFFERS" hides which one happened.
 */
export function describeCoverageDrift(disk, live) {
	const out = [];
	const dRepos = disk?.repos ?? [];
	const lRepos = live.repos ?? [];
	const only = (a, b) => a.filter((x) => !b.includes(x));
	for (const r of only(lRepos, dRepos)) out.push(`  + repo ${r} (live, not on disk)`);
	for (const r of only(dRepos, lRepos)) out.push(`  - repo ${r} (on disk, not live)`);
	if (!out.length && JSON.stringify(dRepos) !== JSON.stringify(lRepos)) {
		out.push(`  ~ repo list has the same ${lRepos.length} members in a different order`);
	}

	const dF = disk?.facets ?? {};
	const lF = live.facets ?? {};
	for (const k of only(Object.keys(lF), Object.keys(dF))) out.push(`  + facets for ${k}`);
	for (const k of only(Object.keys(dF), Object.keys(lF))) out.push(`  - facets for ${k}`);
	for (const k of Object.keys(lF)) {
		if (!(k in dF)) continue;
		const a = dF[k];
		const b = lF[k];
		if (JSON.stringify(a) === JSON.stringify(b)) continue;
		const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
		for (const f of keys) {
			if (JSON.stringify(a[f]) === JSON.stringify(b[f])) continue;
			out.push(`  ~ ${k}.${f}: ${JSON.stringify(a[f])} -> ${JSON.stringify(b[f])}`);
		}
	}
	return out.join('\n');
}

/** `facets` with the one CALENDAR-driven key taken out; see `RESERVE_DRIFT_PCT`. */
export function withoutReserves(facets) {
	const out = {};
	for (const [repo, f] of Object.entries(facets ?? {})) {
		const rest = Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'jobP95Mb'));
		if (Object.keys(rest).length) out[repo] = rest;
	}
	return out;
}

/** The `jobP95Mb` half of `facets`, as `{ [repo]: {mb, basis, runs} }`. */
export function reservesOf(facets) {
	const out = {};
	for (const [repo, f] of Object.entries(facets ?? {})) if (f?.jobP95Mb) out[repo] = f.jobP95Mb;
	return out;
}

/**
 * The nodes a repo should be placed on — DERIVED, never listed per repo.
 *
 * Three rules, in order. Each is a property of the NODE, which is the whole
 * point of the 2026-08-23 restructure: a node's constraints used to be
 * copied into every repo entry it applied to, so nothing could enforce them.
 *
 *   placement:excluded  the reconciler must not register here at all (hokon)
 *   excludeRepos        this node declines this repo, with a stated reason
 *   needs / labels      the repo requires a capability the node must carry
 */
export function placementFor(repo, manifest) {
	const allowed = new Set(mayRunRepo(repo, manifest));
	return (
		Object.entries(manifest.machines)
			.filter(([name]) => allowed.has(name))
			// An EPHEMERAL node mints a runner per job, so the only standing
			// registrations it keeps are its resident set — usually empty. This is the
			// single place placement is decided, which is why the rule belongs here
			// rather than as a special case in the apply step: everything downstream,
			// including the orphan sweep that will REMOVE the pairs this drops, reads
			// its answer from this function.
			//
			// The consequence is deliberate and is the whole point of workstream B: a
			// standing registration is a job GitHub can assign WITHOUT ASKING THE
			// DISPATCHER, so leaving them in place while also minting would double the
			// node's real concurrency rather than bound it.
			.filter(([, m]) => m.ephemeral !== true || (m.residentRepos ?? []).includes(repo))
			// An ON-DEMAND GUEST is the same rule for the same reason (#120): it is
			// minted for per job, so a standing registration there is a listener
			// squatting on the production host's memory — the thing the operator
			// retired on 2026-10-19. It keeps only its `standingRepos`, which is
			// hadoku_site's deploy runner. The rest become `excluded` pairs and go
			// under `--confirm --remove-excluded`, idle ones only.
			.filter(([, m]) => !mintsOnDemand(m) || standingRepos(m).includes(repo))
			.map(([name]) => name)
	);
}
