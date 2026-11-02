/**
 * Splitting a job's wall time into phases, and finding which step failed —
 * both derived from the step timings `/actions/runs/{id}/jobs` already
 * returns. Split out of `job-history-ingest.ts` (wave shrink-1 lane C, pure
 * move) to bring that file under the 600-line target.
 */

// Exported since 2026-09-07: `backfillFailedSteps` (job-history-backfill.ts)
// takes a fetcher that returns one of these, so the shape is part of this
// module's public surface whether or not the name is — and an un-exported
// name in an exported signature is a .d.ts that consumers cannot implement
// against.
export interface GhJob {
	id?: number;
	name?: string;
	runner_name?: string | null;
	labels?: string[];
	created_at?: string | null;
	started_at?: string | null;
	completed_at?: string | null;
	conclusion?: string | null;
	status?: string;
	/** The commit this job ran at. See {@link JobRecord.headSha}. */
	head_sha?: string | null;
	/**
	 * Per-step timings. ALREADY IN THE RESPONSE — `/actions/runs/{id}/jobs`
	 * returns them and this module discarded them, so the phase breakdown below
	 * costs no extra request against a budget that is deliberately small.
	 */
	steps?: {
		name?: string;
		number?: number;
		started_at?: string | null;
		completed_at?: string | null;
		conclusion?: string | null;
	}[];
}

/** GitHub's own synthetic first step. Everything before it ends is setup. */
const SETUP_STEP = 'Set up job';
/** GitHub's own synthetic last step, and the `Post <name>` teardown before it. */
const CLEANUP_STEP = 'Complete job';

/**
 * Split a job's wall time into the phases an operator can act on.
 *
 * DERIVED FROM STEPS WE ALREADY FETCH, not from new telemetry. The four phases
 * are the ones GitHub actually distinguishes:
 *
 *   setup    `started_at` -> end of "Set up job". Includes the gap BEFORE the
 *            first step, which is the runner coming up — on a JIT node that is
 *            the mint itself, and it is invisible in every other number here.
 *   run      the job's own steps.
 *   cleanup  the first `Post *` / "Complete job" step -> `completed_at`.
 *
 * Queue time is not in here: it precedes `started_at` and is `queueSec`.
 *
 * There is deliberately no "waiting" or "finalizing" bucket. The API exposes no
 * signal that separates either from `run` and `cleanup`, and a phase invented to
 * fill out a legend is a bar segment that means nothing.
 *
 * Returns undefined when the steps are absent or unusable — never a guessed
 * zero, for the same reason `queueSec` is optional: a fabricated 0 drags every
 * percentile down silently.
 */
export function jobPhases(
	j: GhJob,
	start: number,
	end: number
): { setupSec: number; runSec: number; cleanupSec: number } | undefined {
	const steps = (j.steps ?? []).filter((st) => st.started_at && st.completed_at);
	if (!steps.length) return undefined;
	const setup = steps.find((st) => st.name === SETUP_STEP);
	// `Post *` are the teardown halves of composite actions and always trail the
	// job's own work; "Complete job" is GitHub's own last step. The earliest of
	// them opens cleanup.
	const teardown = steps.filter(
		(st) => st.name === CLEANUP_STEP || (st.name ?? '').startsWith('Post ')
	);
	const setupEnd = setup?.completed_at ? Date.parse(setup.completed_at) : start;
	const cleanupStart = teardown.length
		? Math.min(...teardown.map((st) => Date.parse(st.started_at as string)))
		: end;
	if (![setupEnd, cleanupStart].every(Number.isFinite)) return undefined;
	// Clamp rather than trust: a step clock that disagrees with the job clock
	// must not produce a negative segment that renders as a bar running backwards.
	const a = Math.min(Math.max(setupEnd, start), end);
	const b = Math.min(Math.max(cleanupStart, a), end);
	return {
		setupSec: Math.round((a - start) / 1000),
		runSec: Math.round((b - a) / 1000),
		cleanupSec: Math.round((end - b) / 1000),
	};
}

/** GitHub step conclusions that mean the step is why the job did not pass. */
const FAILURE_STEP_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);

/**
 * Which step failed, and which phase it falls in — see `jobPhases`, and
 * `JobRecord.failedStep`/`failedPhase` for what each field means.
 *
 * DERIVED FROM STEPS WE ALREADY FETCH, same as `jobPhases`: zero extra API
 * calls. Boundaries come from `jobPhases` itself so the two never disagree
 * about where setup ends and cleanup begins.
 *
 * undefined when the job succeeded, when no step record names a failure, or
 * when the failing step has no usable timestamp — never guessed, for the same
 * reason `queueSec` and the phase fields are optional rather than zeroed.
 */
export function stepFailure(
	j: GhJob,
	start: number,
	end: number
): { failedStep: string; failedPhase?: 'setup' | 'run' | 'cleanup' } | undefined {
	if (!j.conclusion || j.conclusion === 'success') return undefined;
	const failed = (j.steps ?? []).find(
		(st) => st.conclusion && FAILURE_STEP_CONCLUSIONS.has(st.conclusion)
	);
	if (!failed?.name) return undefined;
	const phases = jobPhases(j, start, end);
	const startedAt = failed.started_at ? Date.parse(failed.started_at) : NaN;
	if (!phases || !Number.isFinite(startedAt)) return { failedStep: failed.name };
	return { failedStep: failed.name, failedPhase: phaseByOrder(j.steps ?? [], failed) };
}

/**
 * Which phase a step is in, by its POSITION among the job's steps — never by
 * its clock.
 *
 * It was by clock (`started_at` against `jobPhases`' boundaries) until
 * 2026-11-02, and the clock is wrong for this in two measured ways:
 *
 *   - GitHub stamps steps to the SECOND. A step that fails at once (a `check`
 *     aggregator reading a verdict and exiting) starts in the same second as
 *     the `Post *` / "Complete job" teardown, the tie went to `cleanup`, and
 *     `classifyZone` read cleanup as the runner's. 142 of the 177 "box"
 *     failures in the 14 days to 2026-11-02 were hadoku-cardtable's `check`
 *     and `judge` aggregators, red because a test shard was.
 *   - On 2026-11-01 between 09:00 and 10:00Z (the US fall-back hour) step
 *     stamps ran ONE HOUR behind the job's own `started_at`, so every failed
 *     step fell before "setup ended": nine `Identity-model gate` failures read
 *     as the box's.
 *
 * Order has neither problem. Setup is "Set up job" and anything before it;
 * cleanup opens at the first teardown step; everything between is `run`.
 */
function phaseByOrder(
	steps: NonNullable<GhJob['steps']>,
	failed: NonNullable<GhJob['steps']>[number]
): 'setup' | 'run' | 'cleanup' {
	const ordered = [...steps].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
	const at = ordered.indexOf(failed);
	const setupAt = ordered.findIndex((st) => st.name === SETUP_STEP);
	const cleanupAt = ordered.findIndex(
		(st) => st.name === CLEANUP_STEP || (st.name ?? '').startsWith('Post ')
	);
	if (at <= setupAt) return 'setup';
	if (cleanupAt !== -1 && at >= cleanupAt) return 'cleanup';
	return 'run';
}
