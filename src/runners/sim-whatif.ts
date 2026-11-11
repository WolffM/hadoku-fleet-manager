/**
 * What-ifs for `fleet simulate`: a different fleet or workload for the
 * SIMULATED run only. The history column always stays what really happened.
 *
 * - `without`: node names to remove (decommissioning).
 * - `clone`: `existing=new`, a copy of a node under a new name (one more box
 *   like it).
 * - `drop`: `key=value[,key=value]`, every term must match: `event`, `label`,
 *   `repo`, or `name` (a prefix). Jobs that depended on a dropped job arrive
 *   as recorded.
 *
 * PURE. Throws on a spec that names nothing, so a typo never reads as "no
 * change".
 */
import type { Corpus, SimJob } from './sim-corpus.js';
import type { SimNodeSpec } from './sim-fleet.js';

export interface WhatIfs {
	without?: readonly string[];
	clone?: readonly string[];
	drop?: readonly string[];
}

const DROP_KEYS = ['event', 'label', 'repo', 'name'] as const;

export function applyWhatIfs(
	corpus: Corpus,
	fleet: readonly SimNodeSpec[],
	w: WhatIfs
): { corpus: Corpus; fleet: SimNodeSpec[]; notes: string[] } {
	const notes: string[] = [];
	let nodes = [...fleet];
	for (const name of (w.without ?? []).flatMap((s) => s.split(','))) {
		if (!nodes.some((s) => s.name === name))
			throw new Error(`--without ${name}: no such node in the fleet`);
		nodes = nodes.filter((s) => s.name !== name);
		notes.push(`without ${name}`);
	}
	for (const spec of w.clone ?? []) {
		const [from, to] = spec.split('=');
		const src = nodes.find((s) => s.name === from);
		if (!src || !to || nodes.some((s) => s.name === to)) {
			throw new Error(`--clone takes existing=new, got ${spec}`);
		}
		nodes.push({ ...src, name: to });
		notes.push(`${to} cloned from ${from}`);
	}
	let jobs = corpus.jobs;
	for (const spec of w.drop ?? []) {
		const terms = spec.split(',').map((t) => t.split('=') as [string, string | undefined]);
		const bad = terms.find(([k, v]) => !DROP_KEYS.includes(k as (typeof DROP_KEYS)[number]) || !v);
		if (bad)
			throw new Error(
				`--drop takes key=value[,key=value] with keys ${DROP_KEYS.join(', ')}; got ${spec}`
			);
		const matches = (j: SimJob): boolean =>
			terms.every(([k, v]) =>
				k === 'event'
					? j.event === v
					: k === 'label'
						? j.labels.includes(v!)
						: k === 'repo'
							? j.repo === v
							: j.name.startsWith(v!)
			);
		const kept = jobs.filter((j) => !matches(j));
		if (kept.length === jobs.length) throw new Error(`--drop ${spec} matched no job`);
		notes.push(`dropped ${jobs.length - kept.length} jobs matching ${spec}`);
		jobs = kept;
	}
	return { corpus: jobs === corpus.jobs ? corpus : { ...corpus, jobs }, fleet: nodes, notes };
}
