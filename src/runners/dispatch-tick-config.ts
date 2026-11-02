/**
 * THE DISPATCH TICK'S OWN CADENCE CONSTANTS AND INPUT CONTRACT — every timer
 * `runDispatchTick` runs its sub-passes on, and the shape its single caller
 * hands it. No I/O beyond the one cadence-clock reset below. Split out of
 * `dispatch-tick.ts` (wave shrink-1 lane B, 800-line ceiling);
 * `dispatch-tick.ts` re-exports every name here under its original path.
 */
import { __resetSubCadenceKeyForTesting } from '../lib/every.js';
import type { NodeState } from './placement-node-state.js';
import type { QueuedRun, QueuedJob } from './queue-discovery.js';

/**
 * Liveness expectation for `noteTick('dispatch', …)` — see lib/liveness.ts.
 *
 * MIRRORS `fleet-loop.ts`'s `DISPATCH_SECONDS` (15s), which owns the actual
 * timer: `dispatchBetweenTicks` there calls `dispatchEphemeral` ->
 * `runDispatchTick` (this function) on that cadence, and the fast loop's own
 * 60s tick also calls it once per pass. A literal rather than an import: that
 * constant lives in `fleet-loop.ts`, which reaches this module only through
 * `runners/ephemeral-tick.js` — importing it back here would be a cycle
 * (fleet-loop -> ephemeral-tick -> dispatch-tick -> fleet-loop). Changing
 * DISPATCH_SECONDS without updating this constant makes the staleness
 * threshold wrong, not incorrect behaviour: `noteTick`'s floor
 * (`STALE_FLOOR_MS`, 60s) absorbs a modest drift either way.
 */
export const DISPATCH_TICK_EXPECTED_MS = 15_000;

/**
 * How often the dispatcher re-examines STUCK runs for stranded work.
 *
 * ON ITS OWN CLOCK, for the reason `REAP_INTERVAL_MS` is: this adds a
 * `/actions/runs/<id>/jobs` call per candidate, and while `ghGet` revalidates
 * with an ETag, a stranded run with live siblings changes its body between
 * calls, so the ceiling is sized as if every call were charged. Riding
 * the 15 s dispatch tick, a single outage's worth of debris — say 20 stranded
 * runs — would cost 4,800 calls/hr against a 5,000/hr budget and starve the
 * fleet of the very calls it needs to recover. That is the 2026-09-05 reap
 * regression exactly, and the arithmetic has to be done separately for each
 * thing hanging off a timer.
 *
 * 10 minutes with the cap below is at most 30 calls/hr. Recovery is not urgent:
 * every candidate has by definition already waited an hour.
 */
export const RECOVERY_INTERVAL_MS = 600_000;

/**
 * How often the dispatcher lists `?status=pending` runs (fleet-manager#11).
 *
 * The queued listing cannot see a run GitHub leaves `pending` with jobs
 * `queued` on fleet labels, and nothing minted for one: hadoku-cardtable run
 * 40285146065's `changes` job was created 2026-10-26 08:12:03Z and waited 55
 * minutes until a JIT minted for a DIFFERENT run (r40297104081) happened to be
 * idle and took it. So GitHub does assign these jobs; nothing was asked to
 * serve them. queue-health has called the state `invisible` since #6.
 *
 * ON ITS OWN CLOCK, and sized as if every call were charged. A pending run's
 * listing rarely changes, so most polls should be 304s, but that lowers the
 * typical bill and leaves the ceiling alone. At the 15 s tick, 27 repos is
 * 6,480 calls/hr, which is more than the whole budget. At 4 minutes it is
 * 405/hr plus at most MAX_PENDING_PROBES jobs reads per pass (150/hr).
 *
 * BELOW queue-health's floor, not at it. That gate calls a pending run
 * invisible once its first queued job is FAIL_SECONDS (300 s) old; the worst
 * serve here is one interval, one tick and a ~9 s mint, 264 s. At 300 s it was
 * 324 s and the gate would flag runs the dispatcher was about to serve.
 * `queue-cadence.test.mjs` asserts the relationship.
 */
export const PENDING_INTERVAL_MS = 240_000;

/**
 * Jobs reads per pending pass, fleet-wide. Most pending runs are HELD (zero
 * jobs, waiting on their own concurrency group) and their jobs listing does not
 * move, so the ETag answers 304. The cap bounds the ceiling anyway.
 */
export const MAX_PENDING_PROBES = 10;

/**
 * This gate's `subCadence` name (`lib/every.ts`, wave5m lane C). In-memory,
 * global, mark-when-due regardless of outcome — exactly this gate's own
 * previous shape (a plain module `let`, stamped before the fan-out's awaits)
 * — so the swap changes no observable timing; `#11: the pending listing runs
 * on its OWN clock` (below) pins it unmodified.
 */
export const PENDING_CADENCE_NAME = 'dispatch-tick:pending';

/**
 * Recovery probes per pass. Bounds the cost of a large outage's debris, and the
 * remainder is simply picked up on the following interval — a starved run that
 * gets minted for leaves the queue, so the set drains rather than repeating.
 */
export const MAX_RECOVERY_PROBES = 5;

/**
 * This gate's `subCadence` name (`lib/every.ts`, wave5m lane C). Same shape
 * as `PENDING_CADENCE_NAME` above: in-memory, global, mark-when-due
 * regardless of outcome, stamped before the fan-out's awaits — matching the
 * plain module `let` this replaced exactly. `recovery is gated on its own
 * clock, not the dispatch tick` (below) pins it unmodified.
 */
export const RECOVERY_CADENCE_NAME = 'dispatch-tick:recovery';

/** Tests only: the clock is module state, so it must be resettable between them. */
export function resetRecoveryClock(): void {
	__resetSubCadenceKeyForTesting(RECOVERY_CADENCE_NAME);
}

export interface DispatchTickInput {
	/**
	 * Nodes the dispatcher may mint on, in placement order (see
	 * runners/traffic.ts): the ephemeral claws, then any on-demand backstop.
	 */
	order: string[];
	nodes: NodeState[];
	/** Every fleet repo — the poll universe and the reap universe. */
	repos: string[];
	/** Jobs per day per repo, for the hot/cold poll split. */
	recentJobCounts: ReadonlyMap<string, number>;
	labelsFor: (node: string) => string[];
	memoryMaxMbFor: (repo: string, node: string) => number;
	/** See `DispatchPassInput.sliceNameFor`. */
	sliceNameFor?: (node: string) => string | null | undefined;
	/** See `DispatchPassInput.homeDirFor`. */
	homeDirFor: (node: string) => string;
	ttlSeconds: number;
	/**
	 * Age a run must reach before it is mintable. Omit for `MIN_QUEUED_MS`.
	 *
	 * The caller passes `SATURATED_QUEUED_MS` when it has OBSERVED that the
	 * standing nodes above an ephemeral one have no free slots — see that
	 * constant for why the default gate is a proxy for exactly that, and what
	 * the proxy costs.
	 */
	minQueuedMs?: number;
}

/**
 * One pending entry per waiting JOB. #89: the job's own name, not the run's —
 * `PendingRun.jobName` is what `SpeedModel.expectedExtraSec` keys on. #96: the
 * job's own `created_at`, not the run's, is its wait.
 */
export function entryFor(
	r: QueuedRun & { id: number },
	repo: string,
	j: QueuedJob
): QueuedRun & {
	id: number;
	repo: string;
	jobId: number;
	jobName?: string;
	jobCreatedAt?: string;
} {
	return {
		...r,
		id: r.id,
		repo,
		jobId: j.id,
		labels: j.labels ?? [],
		jobName: j.name,
		jobCreatedAt: j.created_at,
	};
}
