/**
 * Picking and resolving the `(repo, job)` unit a `table`/`candidates` call is
 * about — split out of `scripts/floor-probe.mjs` (wave 5q lane A, ctx
 * restructure) so that file reaches the 800-line ceiling. Pure over
 * `job-history` rows that already carry a resolved `node` (the caller's
 * `nodeOf`, from `census.ts`) and the roster; never imports the CLI.
 */
import { nodeOf } from '../../dist/runners/census.js';
import { parseUnit } from './floor-probe.mjs';

export function samplesFor(rows, key, NODES) {
	return rows
		.filter((r) => r.repo === key.repo && r.name === key.job)
		.map((r) => ({ ...r, node: nodeOf(r.runner, NODES) }));
}

export function pickBusiestUnit(rows, NODES, CLAWS) {
	const by = new Map();
	for (const r of rows) {
		const k = `${r.repo}#${r.name}`;
		if (!by.has(k)) by.set(k, new Set());
		by.get(k).add(nodeOf(r.runner, NODES));
	}
	let best = null;
	for (const [k, nodes] of by) {
		const claws = [...nodes].filter((n) => CLAWS.includes(n)).length;
		if (!best || claws > best.claws) best = { k, claws };
	}
	return best ? parseUnit(best.k) : null;
}
