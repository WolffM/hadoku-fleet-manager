/**
 * THE DECISION LOG'S FLAT INPUT (wave clean2 lane B,
 * `docs/planning/wave-clean2-2026-11-01.md`): `decision-log.ts` is `state`
 * and may not import `placement.ts`/`dispatcher.ts` (`domain`), so this
 * file — itself `domain`/ci-scheduling, same as those two — converts at the
 * boundary instead. `dispatch-pass.ts` is the only caller.
 */
import type { PlanObservation } from './dispatcher.js';
import { busyOf } from './placement.js';
import { type NodeState } from './placement-node-state.js';
import type { NodeFigures } from './decision-log-types.js';
import type { JitPlacementObservation } from './decision-log-record.js';

/** A node-name -> figures lookup over `nodes` — `nodeOf` (census.ts) may fall back to a name not in it. */
export function makeCapacityOf(
	nodes: readonly NodeState[]
): (name: string) => NodeFigures | undefined {
	return (name) => {
		const m = nodes.find((x) => x.name === name);
		return m && nodeFigures(m);
	};
}

/** `NodeState` -> the decision log's own flat `NodeFigures` row. */
export function nodeFigures(m: NodeState): NodeFigures {
	return {
		node: m.name,
		busy: busyOf(m),
		max: m.maxConcurrent,
		units: m.liveUnits,
		standing: m.standingBusy,
		warmBusy: m.warmBusy ?? 0,
		warmHeld: m.warmHeld ?? 0,
		freeMb: m.freeMb,
		requiredMb: m.requiredMb,
		minFreeMb: m.minFreeMb,
		heavyJobs: m.heavyJobs ?? 0,
		runningHeavy: m.runningHeavy ?? false,
		warmRepo: m.warmRepo ?? null,
		healthy: m.healthy,
		drained: m.drained ?? false,
		schedulable: m.schedulable ?? null,
	};
}

/** `planTick`'s own `PlanObservation` -> decision-log's flat `JitPlacementObservation`. */
export function toJitObservation(o: PlanObservation): JitPlacementObservation {
	return {
		run: {
			id: o.run.id,
			jobId: o.run.jobId,
			jobName: o.run.jobName,
			labels: o.run.labels,
			event: o.run.event,
			repo: o.run.repo,
		},
		passIndex: o.passIndex,
		outcome: o.outcome,
		candidates: o.candidates.map(nodeFigures),
		placed: o.placed && {
			heavy: o.placed.heavy,
			walk: o.placed.walk,
			passed: o.placed.passed,
			node: o.placed.node,
			rankedOver: o.placed.rankedOver,
			viaAffinity: o.placed.viaAffinity,
		},
		affinityMoved: o.affinityMoved,
		busyAtChoice: o.busyAtChoice,
		queuedSec: o.queuedSec,
		reason: o.reason,
	};
}
