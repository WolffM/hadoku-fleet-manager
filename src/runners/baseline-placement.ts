/**
 * baseline-placement — what placement WOULD do with each node's learned
 * baselines and weak points (hadoku-fleet-manager#129). SHADOW: logged on the
 * speed-model rebuild, acted on by nothing, until the shadow week's counts
 * are read (from 2026-11-29; AGENTS.md "A new gate starts quiet").
 *
 * THE ONE RULE, and why it is this one. `fleet qualify`'s concurrency ramp
 * runs emulated p75 jobs side by side, and a node whose ramp held NONE (a
 * `concurrency-ramp` weak point with a learned `ramp.ceiling` under 1) crossed a
 * bar with a single job: on 11-21 claw-1 reached 98 °C with 109,832 throttle
 * events, and on 11-15 claw-3 reached 100 °C. A heavy job is what such a node
 * would be held off. Each verdict carries how many heavy jobs that node ran in
 * the history window, and how many failed against heavy jobs on every other
 * node, so the commit that acts on it can state what holding would have cost
 * and saved.
 */
import type { JobRecord } from '../job-history-store.js';
import type { NodeBaselineStore } from '../node-baselines-read.js';
import { KIND_FAILURE_WINDOW_DAYS } from './kind-failures.js';

export interface HeavyHoldShadow {
	node: string;
	/** The weak point behind it, in the store's own words. */
	why: string;
	ceiling: number;
	heavyRuns: number;
	heavyFailures: number;
	otherHeavyRuns: number;
	otherHeavyFailures: number;
}

const FAILED = new Set(['failure', 'timed_out']);
const JUDGED = new Set(['success', 'failure', 'timed_out']);

/** PURE. Every node placement would hold heavy jobs off, with the history behind it. */
export function heavyHoldShadow(
	store: NodeBaselineStore,
	records: readonly JobRecord[],
	opts: {
		nowMs: number;
		nodes: readonly string[];
		isHeavy: (repo: string, job: string) => boolean;
		nodeOf: (r: JobRecord) => string | null;
	}
): HeavyHoldShadow[] {
	const held = opts.nodes.flatMap((node) => {
		const weak = store.weakPoints?.[node]?.['concurrency-ramp'];
		const ceiling = store.quantities?.[`${node}::ramp.ceiling`]?.mean;
		if (!weak || !Number.isFinite(ceiling) || ceiling >= 1) return [];
		return [{ node, why: weak.reason, ceiling }];
	});
	if (!held.length) return [];
	const since = opts.nowMs - KIND_FAILURE_WINDOW_DAYS * 86_400_000;
	const tally = new Map<string, { runs: number; failures: number }>();
	let allRuns = 0;
	let allFailures = 0;
	for (const r of records) {
		if (!JUDGED.has(r.conclusion ?? '')) continue;
		const at = Date.parse(r.startedAt);
		if (!Number.isFinite(at) || at < since || !opts.isHeavy(r.repo, r.name)) continue;
		const node = opts.nodeOf(r);
		if (!node) continue;
		const failed = FAILED.has(r.conclusion ?? '') ? 1 : 0;
		const t = tally.get(node) ?? { runs: 0, failures: 0 };
		t.runs++;
		t.failures += failed;
		tally.set(node, t);
		allRuns++;
		allFailures += failed;
	}
	return held.map((h) => {
		const t = tally.get(h.node) ?? { runs: 0, failures: 0 };
		return {
			...h,
			heavyRuns: t.runs,
			heavyFailures: t.failures,
			otherHeavyRuns: allRuns - t.runs,
			otherHeavyFailures: allFailures - t.failures,
		};
	});
}

/** For logs: one shadow verdict, short. */
export function describeHeavyHold(h: HeavyHoldShadow): string {
	const pct = (f: number, n: number) => (n ? `${((100 * f) / n).toFixed(1)}%` : 'n/a');
	return (
		`${h.node} (qualify ramp ceiling ${h.ceiling}): ${h.heavyRuns} heavy job(s) ran there in ` +
		`${KIND_FAILURE_WINDOW_DAYS} d, ${pct(h.heavyFailures, h.heavyRuns)} failed vs ` +
		`${pct(h.otherHeavyFailures, h.otherHeavyRuns)} elsewhere`
	);
}
