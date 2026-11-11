/**
 * BUILDING DECISION ROWS — turns what the JIT pass and the warm cache each
 * decided into {@link DecisionRecord} rows and hands them to the sink
 * (`emitDecisions`, in `decision-log.ts`, which decides whether anything
 * changed). Split out of `decision-log.ts` (wave shrink-1 lane B, 800-line
 * ceiling): this file knows the THREE WRITERS (see that file's own header);
 * `decision-log.ts` itself knows only that rows arrive. It re-exports every
 * name here under its original path.
 *
 * `nodeFigures` (NodeState -> NodeFigures) moved to
 * `dispatch-decision-flatten.ts` (wave clean2 lane B): this file is `state`
 * and may not import the `domain` layer its writer lives in.
 */
import { createHash } from 'node:crypto';

import { decisionLogEnabled, emitDecisions, warn } from './decision-log.js';
import {
	DECISION_SCHEMA,
	type DecisionKind,
	type DecisionPath,
	type DecisionRecord,
	type NodeFigures,
} from './decision-log-types.js';

/** A short, stable hash of a fingerprint string. */
export function fingerprintHash(fp: string): string {
	return createHash('sha1').update(fp).digest('hex').slice(0, 12);
}

const roundSec = (s: number | undefined): number | null =>
	s === undefined ? null : Math.round(s * 10) / 10;

function blank(at: string, path: DecisionPath, kind: DecisionKind, repo: string): DecisionRecord {
	return {
		v: DECISION_SCHEMA,
		at,
		path,
		kind,
		repo,
		runId: null,
		jobId: null,
		jobName: null,
		labels: [],
		event: null,
		queuedSec: null,
		heavy: null,
		order: [],
		candidates: [],
		refused: [],
		winner: null,
		rule: null,
		outcome: null,
		runner: null,
		error: null,
		reason: null,
		action: null,
		capacity: [],
		fingerprint: null,
	};
}

/**
 * `dispatcher.ts`'s `PlanObservation`, flattened at `dispatch-pass.ts`'s own
 * boundary (wave clean2 lane B): this file is `state` and may not import
 * `NodeState`/`WalkKey` (`domain`). `candidates` is pre-converted to
 * {@link NodeFigures}; `rankedOver.key` is a plain string, erased either way.
 */
export interface JitPlacementObservation {
	run: {
		id: number;
		jobId: number;
		jobName?: string;
		labels?: string[];
		event?: string;
		repo: string;
	};
	/** Where this job stood in the pass's placement order (narrowestFirst). */
	passIndex: number;
	outcome: 'in-flight' | 'fork' | 'unplaceable' | 'held' | 'placed' | 'reserved';
	/** The eligible nodes the walk was offered, already as this file's own flat shape. */
	candidates: readonly NodeFigures[];
	placed?: {
		heavy: boolean;
		walk?: readonly string[];
		passed: readonly { node: string; reason: string; holdSec?: number }[];
		node?: string;
		rankedOver?: { node: string; key: string };
		viaAffinity: boolean;
	};
	affinityMoved?: boolean;
	busyAtChoice?: number;
	queuedSec?: number;
	reason?: string;
}

/**
 * The JIT half: collects {@link JitPlacementObservation}s during `planTick`
 * (via `dispatch-pass.ts`'s flattening adapter), learns each mint's result,
 * and writes the changed decisions at the end of the pass. Every method
 * catches: an observer that throws would throw out of planTick.
 */
export class JitDecisionBook {
	private readonly rows = new Map<number, DecisionRecord>();
	private readonly at: string;
	private broken = false;

	constructor(
		private readonly nowMs: number,
		private readonly order: readonly string[],
		/** `placementFingerprint` for one job, from the tick that owns it. */
		private readonly fingerprintFor?: (repo: string, labels: readonly string[]) => string
	) {
		this.at = new Date(nowMs).toISOString();
	}

	/** planTick's observer, via dispatch-pass.ts's flattening adapter. Copies what it needs inside the call. */
	readonly observe = (o: JitPlacementObservation): void => {
		if (this.broken) return;
		try {
			const r = blank(this.at, 'jit', o.outcome, o.run.repo);
			r.runId = o.run.id;
			r.jobId = o.run.jobId;
			r.jobName = o.run.jobName ?? null;
			r.labels = [...(o.run.labels ?? [])];
			r.event = o.run.event ?? null;
			r.queuedSec = roundSec(o.queuedSec);
			r.order = [...this.order];
			r.reason = o.reason ?? null;
			r.capacity = [...o.candidates];
			const p = o.placed;
			if (p) {
				r.heavy = p.heavy;
				r.candidates = [...(p.walk ?? [])];
				r.refused = p.passed.map((x) => ({ ...x }));
				r.winner = p.node ?? null;
				if (p.node) {
					r.rule = {
						position: r.candidates.indexOf(p.node),
						rankedOver: p.rankedOver ? { ...p.rankedOver } : null,
						viaAffinity: p.viaAffinity,
						affinityMoved: o.affinityMoved ?? false,
						busyAtChoice: o.busyAtChoice ?? null,
						passIndex: o.passIndex,
					};
				}
			}
			this.rows.set(o.run.jobId, r);
		} catch (err) {
			this.broken = true;
			warn('could not observe a placement', err, this.nowMs);
		}
	};

	/** What the mint for a placed job did. */
	minted(jobId: number, runnerName: string, res: { ok: boolean; reason?: string }): void {
		const r = this.rows.get(jobId);
		if (!r) return;
		r.outcome = res.ok ? 'minted' : 'mint-failed';
		r.runner = runnerName;
		r.error = res.ok ? null : (res.reason ?? 'unknown');
	}

	/** Write the pass's changed decisions. Returns how many rows were written. */
	flush(): number {
		if (this.broken) return 0;
		try {
			const fp = this.fingerprintFor;
			// Hashed only for the rows that changed: most passes write nothing.
			return emitDecisions([...this.rows.values()], this.nowMs, (r) => {
				if (fp && r.kind !== 'in-flight' && r.kind !== 'fork') {
					r.fingerprint = fingerprintHash(fp(r.repo, r.labels));
				}
			});
		} catch (err) {
			warn('could not record dispatch decisions', err, this.nowMs);
			return 0;
		}
	}
}

/** A job GitHub gave a `warm-*` listener directly, seen in the pass's listings. */
export interface WarmAssignment {
	repo: string;
	runner: string;
	jobName: string;
	jobId?: number;
	runId?: number;
}

/**
 * The warm path's per-job rows. Jobs with no id in the listing are skipped.
 *
 * `capacityOf` replaces a `NodeState[]` param (lane B): this file may not
 * import `placement.ts`, so the caller looks up the flattened figures itself.
 */
export function recordWarmAssignments(
	jobs: readonly WarmAssignment[],
	nodeOfRunner: (runner: string) => string,
	capacityOf: (node: string) => NodeFigures | undefined,
	nowMs: number
): number {
	if (!decisionLogEnabled() || !jobs.length) return 0;
	try {
		const at = new Date(nowMs).toISOString();
		const rows: DecisionRecord[] = [];
		for (const j of jobs) {
			if (j.jobId === undefined) continue;
			const node = nodeOfRunner(j.runner);
			const r = blank(at, 'warm', 'warm-assigned', j.repo);
			r.runId = j.runId ?? null;
			r.jobId = j.jobId;
			r.jobName = j.jobName;
			r.winner = node;
			r.candidates = [node];
			r.runner = j.runner;
			r.reason = `GitHub assigned it to ${node}'s warm listener for ${j.repo}`;
			const m = capacityOf(node);
			r.capacity = m ? [m] : [];
			rows.push(r);
		}
		return emitDecisions(rows, nowMs);
	} catch (err) {
		warn('could not record warm assignments', err, nowMs);
		return 0;
	}
}

/** One node's warm-cache slot decision this tick. */
export interface WarmListenerDecision {
	node: string;
	action: 'fill' | 'keep' | 'rotate' | 'idle' | 'locked' | 'withheld' | 'never-warm';
	/** The repo the slot holds or is being given. */
	repo: string | null;
	/** The repo a rotate takes the slot from. */
	from?: string | null;
	reason: string | null;
}

/** The warm cache's per-node rows. */
export function recordWarmListenerDecisions(
	/** Built only when the log is on, and inside the catch: a throw here is a warning. */
	build: () => readonly WarmListenerDecision[],
	nowMs: number
): number {
	if (!decisionLogEnabled()) return 0;
	try {
		const decisions = build();
		if (!decisions.length) return 0;
		const at = new Date(nowMs).toISOString();
		const rows = decisions.map((d) => {
			const r = blank(at, 'warm', 'warm-listener', d.repo ?? d.from ?? '');
			r.winner = d.node;
			r.candidates = [d.node];
			r.action = d.action;
			r.reason = d.from ? `${d.from} -> ${d.repo}${d.reason ? `: ${d.reason}` : ''}` : d.reason;
			return r;
		});
		return emitDecisions(rows, nowMs);
	} catch (err) {
		warn('could not record warm listener decisions', err, nowMs);
		return 0;
	}
}

/** One warm-yield decision on one node (warm-yield.ts). */
export interface WarmYieldDecision {
	node: string;
	action:
		| 'yield'
		| 'yield-refused'
		| 'refill-suppressed'
		| 'refill'
		| 'fill-suppressed'
		| 'rotate-suppressed';
	/** The repo the yielded (or kept) listener holds; `null` for an empty slot. */
	warmRepo: string | null;
	/** The waiting job the slot is for. */
	job: { repo: string; runId: number; jobId: number; jobName?: string; queuedSec: number };
	/**
	 * Other claws that could mint `warmRepo`'s job when the pass asked; `null`
	 * where no slot is given up, so there is nothing to cover.
	 */
	spare: number | null;
	reason: string;
}

/**
 * A warm-yield row, written when the node's yield decision changes. Returns
 * how many rows were written (0 or 1), so the caller logs on the same change.
 */
export function recordWarmYieldDecision(d: WarmYieldDecision, nowMs: number): number {
	if (!decisionLogEnabled()) return 0;
	try {
		// ONE `warm-yield` row per yield, so counting that kind counts yields. The
		// rows that follow a yield (its slot kept empty, then handed back) and a
		// refused yield are other kinds, and carry the job only in `reason`: its
		// id is job-history's join key, and on those rows it would read as the
		// job being decided again.
		const kind =
			d.action === 'yield'
				? 'warm-yield'
				: d.action === 'yield-refused'
					? 'warm-yield-refused'
					: 'warm-refill';
		const r = blank(new Date(nowMs).toISOString(), 'warm', kind, d.warmRepo ?? '');
		r.winner = d.node;
		r.candidates = [d.node];
		r.action = d.action;
		if (kind === 'warm-yield') {
			r.runId = d.job.runId;
			r.jobId = d.job.jobId;
			r.jobName = d.job.jobName ?? null;
			r.queuedSec = d.job.queuedSec;
		}
		r.reason =
			`${d.reason} [for ${d.job.repo} job ${d.job.jobId}` +
			(d.spare === null ? ']' : `; spare=${d.spare}]`);
		return emitDecisions([r], nowMs);
	} catch (err) {
		warn('could not record a warm-yield decision', err, nowMs);
		return 0;
	}
}
