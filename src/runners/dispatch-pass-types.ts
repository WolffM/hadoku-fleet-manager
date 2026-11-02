/**
 * THE DISPATCH PASS'S CONTRACT — the input `runDispatchPass` is handed and
 * the result it hands back. Pure data, no logic. Split out of
 * `dispatch-pass.ts` (wave shrink-1 lane B, 800-line ceiling) so the shape
 * every caller and test agrees on sits apart from the pass itself;
 * `dispatch-pass.ts` re-exports both types under their original path.
 */
import type { PendingRun, SkipReason } from './dispatcher.js';
import type { NodeState } from './placement-node-state.js';

export interface DispatchPassInput {
	/** Nodes allowed to mint, in placement order (see runners/traffic.ts). */
	order: string[];
	nodes: NodeState[];
	/** Queued runs the poll found, already filtered to `queued`. */
	pending: PendingRun[];
	/** Labels each node must project onto anything it mints. */
	labelsFor: (node: string) => string[];
	/** The node's ci user's home (`nodeHome(machine, 'ci')`): where its slots live. */
	homeDirFor: (node: string) => string;
	/**
	 * Where a node with no standing install may fetch a runner release.
	 * Resolved once per tick by the caller — see runnerTarballUrl.
	 */
	tarballUrl?: string | null;
	/**
	 * The unit's `MemoryMax` for a mint of `repo` on `node`. Asked per mint,
	 * once placement has chosen the node, because a backstop's cap is its own
	 * declared one and a claw's is not (see `backstopUnitMemoryMaxMb`).
	 */
	memoryMaxMbFor: (repo: string, node: string) => number;
	/**
	 * The slice a unit on `node` is placed in, from the manifest. Absent means
	 * every unit goes to the default slice.
	 */
	sliceNameFor?: (node: string) => string | null | undefined;
	ttlSeconds: number;
	/** Repos to sweep for orphaned JIT registrations. */
	repos?: string[];
	/** Injectable clock. Absent means `Date.now()`; tests drive the reap gate. */
	nowMs?: number;
	/**
	 * The in-progress SIBLINGS of every run `pending` came from, off the job
	 * listings the producer already read to find the waiting jobs.
	 *
	 * Two things only this knows. Its freshness: `NodeState.standingBusy` is
	 * the fleet probe's worker count, up to a fast-loop tick old, and a WARM
	 * listener's job is not a live JIT unit either — so on 2026-10-08 22:08:09Z
	 * claw-4 read `busy 0` with forge-e2e (3) eleven seconds into its warm
	 * listener, and took forge-e2e (2) and forge-jvm on top of it. And the
	 * running job's exact NAME, which the probe cannot see, so it is the one
	 * source of `NodeState.heavyJobs`. Absent is "none known", today's walk.
	 */
	runningJobs?: readonly RunningJob[];
	/**
	 * `placementFingerprint` for one job's labels, from the tick that owns the
	 * probe backoff — stamped on the decision log's rows (`decision-log.ts`)
	 * so a row says whether the nodes that could take the job had changed.
	 * Absent: the rows carry no fingerprint. Placement never reads it.
	 */
	fingerprintFor?: (repo: string, labels: readonly string[]) => string;
}

/** One in-progress job, by the runner GitHub assigned it to. */
export interface RunningJob {
	repo: string;
	runner: string;
	jobName: string;
	/** The job's and its run's ids, for the decision log's warm rows only. */
	jobId?: number;
	runId?: number;
}

export interface DispatchPassResult {
	minted: number;
	failed: number;
	skipped: number;
	inFlight: number;
	/**
	 * Orphans deleted, or `null` for a pass that did not sweep — the reap runs
	 * on its own clock (REAP_INTERVAL_MS), so most passes do not. Not `0`: this
	 * is the "I could not look" distinction, and `fleet-report-types` already
	 * types the field `number | null` for exactly that reason.
	 */
	reaped: number | null;
	/**
	 * The pass's `unplaceable` skips, for the dispatcher's probe backoff (#117).
	 * Optional so every existing result literal stands; absent is "none".
	 */
	unplaceable?: SkipReason[];
	/**
	 * `repo#runId` of every held (backed-off) run this pass reserved a slot for.
	 * The dispatcher lifts their backoff so the next tick re-reads and mints.
	 */
	reserved?: string[];
}
