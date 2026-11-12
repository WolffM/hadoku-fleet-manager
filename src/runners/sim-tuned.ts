/**
 * The TUNED policy: today's placement, with each of the techniques the
 * simulator compares switched on or off by name (`--set key=value`), so one
 * corpus run isolates one technique (operator, 2026-11-11: "try some more
 * techniques in the modeling").
 *
 * Jobs are planned ONE AT A TIME through the real `planTick`, capacity
 * consumed between them (`consume`), so the order is this policy's own and not
 * `planTick`'s. With every switch at its default the result tracks
 * `baseline`; the corpus run says how closely, and that is this policy's own
 * validation.
 *
 * - `order`: 0 the dispatcher's `byPriority` (age, push ahead by a head
 *   start); 1 strict oldest-first; 2 shortest expected slot time first.
 * - `narrowFirst` 1: the dispatcher's `placementOrder` (scarce-label jobs
 *   first, live since 2026-11-11); 0 only its single-node step.
 * - `kindPlacement` 1: each job tries claws fastest-first FOR ITS KIND (the
 *   engine's estimate), taking the first the real admission accepts, instead
 *   of the least busy.
 * - `warm` 0: replayed warm slots take nothing; every job is minted.
 */
import {
	planTick,
	placementOrder,
	singleNodeFirst,
	type PendingRun,
	type TickPlan,
} from './dispatcher.js';
import type { NodeState } from './placement-node-state.js';
import type { SimPolicy, SimTick } from './sim-engine.js';
import { consume } from './sim-policies.js';

export interface TunedParams {
	order: number;
	narrowFirst: number;
	kindPlacement: number;
	warm: number;
}

export const TUNED_DEFAULTS: TunedParams = { order: 0, narrowFirst: 0, kindPlacement: 0, warm: 1 };

const NONE = { jobIds: new Set<number>(), runIds: new Set<number>() };

export function tunedPolicy(over: Partial<TunedParams> = {}): SimPolicy {
	const p = { ...TUNED_DEFAULTS, ...over };
	for (const [k, v] of Object.entries(over)) {
		if (!(k in TUNED_DEFAULTS)) throw new Error(`tuned: unknown parameter ${k}`);
		if (!Number.isFinite(v)) throw new Error(`tuned: ${k} must be a number`);
	}
	return {
		name: 'tuned',
		warmAllowed: () => p.warm !== 0,
		plan(t: SimTick): TickPlan {
			const heavyModel = t.nodes.find((n) => n.heavyModel)?.heavyModel;
			let jobs = [...t.pending];
			if (p.order === 1) {
				jobs.sort((a, b) => (a.queuedSinceMs ?? 0) - (b.queuedSinceMs ?? 0));
			} else if (p.order === 2) {
				const est = (r: PendingRun): number => t.estimate(r.jobId) ?? Infinity;
				jobs.sort((a, b) => est(a) - est(b));
			}
			// planTick's own ordering. Planning one job at a time skips it unless
			// it is applied here; `narrowFirst` 0 keeps only #131's step.
			jobs = p.narrowFirst ? placementOrder(jobs, t.nodes) : singleNodeFirst(jobs, t.nodes);

			let nodes: NodeState[] = t.nodes;
			const out: TickPlan = { mint: [], skipped: [], reserved: [] };
			for (const run of jobs) {
				const plan = p.kindPlacement
					? fastestFirst(run, nodes, t)
					: planTick([run], nodes, t.order, NONE, t.nowMs);
				out.mint.push(...plan.mint);
				out.skipped.push(...plan.skipped);
				out.reserved.push(...plan.reserved);
				if (plan.mint.length) nodes = consume(nodes, plan, heavyModel, [run]);
			}
			return out;
		},
	};
}

/**
 * Place `run` on the claw where its kind is expected fastest, among those the
 * real admission accepts now: each claw is offered alone, in expected-time
 * order. Skipped, the job reports the full walk's refusals.
 */
function fastestFirst(run: PendingRun, nodes: readonly NodeState[], t: SimTick): TickPlan {
	const pos = new Map(t.order.map((n, i) => [n, i]));
	const est = (n: string): number => t.estimate(run.jobId, n) ?? Infinity;
	const byPace = [...nodes].sort(
		(a, b) => est(a.name) - est(b.name) || (pos.get(a.name) ?? 0) - (pos.get(b.name) ?? 0)
	);
	for (const n of byPace) {
		const plan = planTick([run], [n], [n.name], NONE, t.nowMs);
		if (plan.mint.length) return plan;
	}
	return planTick([run], nodes, t.order, NONE, t.nowMs);
}
