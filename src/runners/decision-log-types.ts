/**
 * THE DECISION RECORD'S SHAPE — one row of {@link DecisionRecord} and the
 * pieces it is built from. Pure data: no sink, no dedup, no I/O. Split out
 * of `decision-log.ts` (wave shrink-1 lane B, 800-line ceiling) so the types
 * every writer and reader agrees on sit apart from the logic that decides
 * when to write and where. `decision-log.ts` re-exports every name here
 * under its original path.
 */

export const DECISION_SCHEMA = 1;

export type DecisionPath = 'jit' | 'warm';

export type DecisionKind =
	| 'placed'
	| 'reserved'
	| 'unplaceable'
	| 'held'
	| 'in-flight'
	| 'fork'
	| 'warm-assigned'
	| 'warm-listener';

/** What one node looked like to the walk at the moment of the decision. */
export interface NodeFigures {
	node: string;
	/** `busyOf` — the walk's own ranking number. */
	busy: number;
	max: number;
	/** Live JIT units charged here, this pass's earlier placements included. */
	units: number;
	standing: number;
	warmBusy: number;
	warmHeld: number;
	freeMb: number;
	requiredMb: number;
	minFreeMb: number;
	heavyJobs: number;
	runningHeavy: boolean;
	warmRepo: string | null;
	healthy: boolean;
	drained: boolean;
	/** `null` when the node carries no schedulability verdict. */
	schedulable: boolean | null;
}

export interface DecisionRule {
	/** The winner's index in `candidates`: how many nodes were asked first. */
	position: number;
	/**
	 * The node right behind the winner, and the walk term that put it behind.
	 * `key` is `placement.ts`'s `WalkKey` widened to `string` (erased either way).
	 */
	rankedOver: { node: string; key: string } | null;
	viaAffinity: boolean;
	/** The affinity term changed the node (the counterfactual walk differed). */
	affinityMoved: boolean;
	busyAtChoice: number | null;
	/** This job's place in the pass's own order (age, band, single-node first). */
	passIndex: number | null;
}

export interface DecisionRecord {
	v: typeof DECISION_SCHEMA;
	at: string;
	path: DecisionPath;
	kind: DecisionKind;
	repo: string;
	runId: number | null;
	/** job-history's `jobId`: the join key. Null only on `warm-listener` rows. */
	jobId: number | null;
	jobName: string | null;
	labels: string[];
	event: string | null;
	/** The queue age the hold gates read; null when it could not be established. */
	queuedSec: number | null;
	heavy: boolean | null;
	/** The tick's baseline order (`orderCandidates`) — what `baseline-order` means. */
	order: string[];
	/** Every node the walk asked, in the order it asked. */
	candidates: string[];
	refused: { node: string; reason: string; holdSec?: number }[];
	winner: string | null;
	rule: DecisionRule | null;
	/** `placed` only: whether the mint that followed worked. */
	outcome: 'minted' | 'mint-failed' | null;
	/** The runner name minted, or the warm listener that took the job. */
	runner: string | null;
	error: string | null;
	/** A skip's reason, or a warm-listener decision's. */
	reason: string | null;
	/** `warm-listener` only: fill, keep, rotate, idle, locked, withheld, never-warm. */
	action: string | null;
	capacity: NodeFigures[];
	/**
	 * A short hash of `placementFingerprint` for this job's labels — what the
	 * probe backoff compares. Equal hashes across rows mean the nodes that could
	 * take the job had not changed.
	 */
	fingerprint: string | null;
}
