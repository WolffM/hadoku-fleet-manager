/**
 * job-metrics-variance — does the NODE or the REPO explain peak-memory
 * variance, and is a node's hardware visible in wall-clock duration.
 *
 * Moved out of job-metrics.mjs (wave shrink-1 lane D), body unchanged.
 */

import { percentile } from './job-metrics-primitives.mjs';
import { group } from './job-metrics-groups.mjs';

/** Spread of a set of values as a percentage of the smallest, or null. */
function spreadPct(values) {
	const v = values.filter((n) => typeof n === 'number' && Number.isFinite(n));
	if (v.length < 2) return null;
	const lo = Math.min(...v);
	const hi = Math.max(...v);
	return lo > 0 ? Math.round(((hi - lo) / lo) * 100) : null;
}

/**
 * ANSWER (a): does the NODE or the REPO explain peak-memory variance?
 *
 * Two spreads over the SAME cells, so the comparison is like for like:
 *
 *   across NODES — hold the repo fixed, vary the node. This is the spread
 *     `jobP95Mb` would have to become per-node to capture.
 *   across REPOS — hold the node fixed, vary the repo. This is the spread it
 *     would have to become per-repo to capture.
 *
 * Whichever median is larger is the axis a single fleet-wide scalar is losing
 * the most information to. A group with fewer than `minGroups` members is
 * excluded from ITS side only — a repo seen on two nodes says nothing about a
 * node effect, and dropping it is not the same as dropping the node's row.
 *
 * The verdict is computed, not eyeballed, and it is `inconclusive` whenever
 * either side has no comparable group at all. An axis that could not be
 * measured is not an axis that came out flat.
 */
export function varianceAxis(cells, { minGroups = 3 } = {}) {
	const perRepo = [...group(cells, (c) => c.repo).entries()]
		.map(([repo, cs]) => ({
			repo,
			nodes: cs.length,
			loMb: Math.min(...cs.map((c) => c.p95Mb ?? Infinity)),
			hiMb: Math.max(...cs.map((c) => c.p95Mb ?? -Infinity)),
			spreadPct: spreadPct(cs.map((c) => c.p95Mb)),
		}))
		.filter((r) => r.nodes >= minGroups && r.spreadPct != null)
		.sort((a, b) => b.spreadPct - a.spreadPct);
	const perNode = [...group(cells, (c) => c.node).entries()]
		.map(([node, cs]) => ({
			node,
			repos: cs.length,
			loMb: Math.min(...cs.map((c) => c.p95Mb ?? Infinity)),
			hiMb: Math.max(...cs.map((c) => c.p95Mb ?? -Infinity)),
			spreadPct: spreadPct(cs.map((c) => c.p95Mb)),
		}))
		.filter((r) => r.repos >= minGroups && r.spreadPct != null)
		.sort((a, b) => b.spreadPct - a.spreadPct);

	const medianAcrossNodesPct = percentile(
		perRepo.map((r) => r.spreadPct),
		0.5
	);
	const medianAcrossReposPct = percentile(
		perNode.map((r) => r.spreadPct),
		0.5
	);
	let verdict = 'inconclusive';
	if (medianAcrossNodesPct != null && medianAcrossReposPct != null) {
		verdict = medianAcrossReposPct > medianAcrossNodesPct ? 'repo' : 'node';
	}
	return {
		minGroups,
		acrossNodes: perRepo,
		acrossRepos: perNode,
		medianAcrossNodesPct,
		medianAcrossReposPct,
		verdict,
	};
}

/**
 * ANSWER (b): is a node's hardware visible in wall-clock?
 *
 * For each repo, the fleet-median node's p95 duration is the yardstick; each
 * node's ratio against it is how much slower (>1) or faster (<1) that node is
 * on the SAME repo. Taking the median of a node's ratios across repos is what
 * separates "this node is slow" from "this node happens to draw the slow repo".
 *
 * This inherits the 2026-09-07 caveat wholesale and does not repeat it in the
 * numbers: claw-5 differs from the fleet on CPU, memory AND disk at once, so a
 * ratio here is the wall-clock FACT, never its attribution. `proxies` is
 * carried alongside precisely so a reader sees all three axes moving together
 * rather than one of them captioned as the cause.
 */
export function durationRatios(cells, { proxies = {} } = {}) {
	const timed = cells.filter((c) => typeof c.durationP95Sec === 'number' && c.durationP95Sec > 0);
	const repoMedian = new Map();
	for (const [repo, cs] of group(timed, (c) => c.repo)) {
		const med = percentile(
			cs.map((c) => c.durationP95Sec),
			0.5
		);
		if (med != null && med > 0 && cs.length >= 2) repoMedian.set(repo, med);
	}
	const out = [];
	for (const [node, cs] of group(timed, (c) => c.node)) {
		const rows = cs
			.filter((c) => repoMedian.has(c.repo))
			.map((c) => ({
				repo: c.repo,
				runs: c.runs,
				p95Sec: c.durationP95Sec,
				fleetMedianSec: Math.round(repoMedian.get(c.repo) * 10) / 10,
				ratio: Math.round((c.durationP95Sec / repoMedian.get(c.repo)) * 100) / 100,
			}))
			.sort((a, b) => b.ratio - a.ratio);
		if (!rows.length) continue;
		const med = percentile(
			rows.map((r) => r.ratio),
			0.5
		);
		out.push({
			node,
			repos: rows.length,
			medianRatio: med == null ? null : Math.round(med * 100) / 100,
			proxy: proxies[node] ?? null,
			perRepo: rows,
		});
	}
	return out.sort((a, b) => (b.medianRatio ?? 0) - (a.medianRatio ?? 0));
}
