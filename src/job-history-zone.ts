// ---------------------------------------------------------------------------
// The zone classifier — claw-floor-design-2026-09-07.md §5.5
// ---------------------------------------------------------------------------
//
// Whose half of the fence a job-history failure fell on: GitHub's own
// machinery, the seam the workflow named but did not write, the consumer's
// own step, or the fleet's own unit TTL stopping it. Split out of
// `job-history-stats.ts` (wave shrink-1 lane C, pure move).

/**
 * Whose half of the fence a failure fell on. **A ZONE IS A PRIOR, NOT A
 * VERDICT** (master §5.5).
 *
 * WHY THIS LIVES IN `src/` AND NOT IN `scripts/lib/floor-probe.mjs`, WHERE IT
 * WAS WRITTEN. It was the harness's rule for deciding whether one failure was
 * worth a forced re-run. It is now also the rule `summarise` folds
 * {@link NodeJobStats.failuresByZone} with, and therefore the rule `GET /fleet`
 * puts on the wire — so a second copy in the script half would be two answers
 * to one question, drifting the moment either moved. This is `isLocalNode`'s
 * lesson applied before it costs anything: `scripts/lib/floor-probe.mjs`
 * re-exports the BUILT copy of this, exactly as `fleet-exec.mjs` re-exports the
 * built `isLocalNode`, so there is only one implementation to drift from.
 */
export type FailureZone = 'runner' | 'seam' | 'content';

/**
 * A zone AFTER the fleet's own kills have been separated out — see
 * {@link zoneOf}. `fleet` is not one of §5.5's three; it is the fold this
 * package adds on top so a job the fleet STOPPED is never counted against the
 * consumer who wrote it.
 */
export type ObservedZone = FailureZone | 'fleet';

/**
 * GitHub's own synthetic steps, plus the `Post *` teardown it generates for
 * every `uses:` step. A failure in one of these is the fleet's: nothing the
 * consumer wrote has run yet, or everything they wrote has already finished.
 *
 * `Set up runner` is on this list because of the shape it produced on
 * 2026-09-03: claw-2 at 01:49 showing `Set up runner[cancelled]` across three
 * repos inside one minute. That is one node event, and a classifier that read
 * it as three consumer bugs would have hidden the only fleet-origin failure in
 * the window.
 */
const RUNNER_STEPS = [/^set up job$/, /^set up runner$/, /^complete job$/, /^complete runner$/];
const RUNNER_PREFIXES = [/^post /];

/**
 * Steps the WORKFLOW named but did not write — the seam between the consumer's
 * yaml and the fleet's boxes.
 *
 * Both known real fleet bugs landed here and neither is visible from the phase
 * alone: `Set up Python` failing on claw-1 is the `RUNNER_TOOL_CACHE` gap, and
 * `Install` failing on claw-2 at hadoku-pygmalion `ae94757` is the missing-pip
 * gap on one of the two boxes that lacks it. `failedPhase` calls both of them
 * `run`, which is why this matches on the NAME.
 *
 * `Install` is here on the master doc's hand classification of all 17 failures
 * in the all-JIT window and it is the weakest entry on the list — a consumer
 * can perfectly well name a `run:` step `Install`. That is tolerable because a
 * zone is a PRIOR: over-reading a content failure as a seam one costs one
 * forced re-run, which is the cheap direction. Under-reading a seam failure as
 * content costs the evidence Control A exists to manufacture.
 */
const SEAM_STEPS = [
	/^set ?up [\w .+-]+$/, // setup-python / setup-node / setup-pnpm, however named
	/^install$/,
	/^checkout/,
	/^run [\w.-]+\/[\w.-]+@/, // an unnamed `uses:` step renders exactly like this
];

/** The fields a zone can be decided from. Looser than `JobRecord` on purpose:
 * the probe ledger's own settled entries carry the same two fields and are
 * classified by the same rule. */
export interface ZoneInput {
	failedStep?: string | null;
	failedPhase?: string | null;
	conclusion?: string | null;
	durationSec?: number | null;
}

/**
 * Which zone a failure falls in — `runner`, `seam` or `content`.
 *
 * **A ZONE IS A PRIOR, NOT A VERDICT** (master §5.5). A content-zone step can
 * still be ours (an OOM-killed test reports as `Tests` failing) and a seam step
 * can still be theirs (pinning `python-version: '3.13'` fails `Set up Python`
 * everywhere). This decides only whether a failure is worth spending a forced
 * re-run on; §5's two-point rule is what turns evidence into a claim.
 *
 * NO STEP RECORD IS `runner`, NOT `unknown`. A job that failed without GitHub
 * returning a usable step record generally never got far enough to run one —
 * that is the fleet's half by elimination, and the master doc's own table says
 * so ("or no step record"). Calling it unknown and declining to probe would
 * discard exactly the failures most likely to be ours.
 */
export function classifyZone(record: ZoneInput | null | undefined): FailureZone {
	const name = (record?.failedStep ?? '').trim().toLowerCase();
	if (!name) return 'runner';
	if (RUNNER_STEPS.some((re) => re.test(name))) return 'runner';
	if (RUNNER_PREFIXES.some((re) => re.test(name))) return 'runner';
	// The phase is consulted only AFTER the name has had its say: GitHub's
	// synthetic steps are already matched above, and a consumer step that happens
	// to land in the setup phase is still theirs.
	if (record?.failedPhase === 'setup' || record?.failedPhase === 'cleanup') return 'runner';
	if (SEAM_STEPS.some((re) => re.test(name))) return 'seam';
	return 'content';
}

/**
 * Every `RuntimeMaxSec` the fleet has minted a JIT unit with, newest last.
 *
 * `sec` is the value; `from`/`until` are when it was the live value, for a
 * reader trying to work out which deploy a finding belongs to. Nothing here is
 * imported from `runners/ephemeral.ts` on purpose — that file holds what the
 * fleet mints TODAY, and this needs what it minted THEN. History spans deploys:
 * a record written while the fleet minted 3600 s units has to stay detectable
 * after the fleet stops minting them, or this check gets EASIER to pass the
 * moment the bug is fixed and loses the ability to say what the bug cost. A new
 * TTL is APPENDED here, never swapped in.
 *
 * Moved out of `scripts/check-fleet-kills.mjs` when the report path needed the
 * same rule: that script re-exports its view of this list rather than keeping a
 * second one.
 */
export const KNOWN_TTL_SEC: readonly {
	sec: number;
	from: string;
	until: string | null;
	why: string;
}[] = [
	{
		sec: 3600,
		from: '2026-08-24',
		until: '2026-09-14',
		why: 'the #22 orphan TTL, applied to jobs',
	},
	{
		sec: 23_400,
		from: '2026-09-14',
		until: null,
		why: "backstop above GitHub's 360-minute ceiling",
	},
];

/** How close to a TTL counts. The kill lands a beat after the deadline (3,601). */
export const TTL_MATCH_SEC = 5;

/** A step GitHub runs after the job's own work — where a shutdown signal shows up. */
function isCleanupStep(r: ZoneInput): boolean {
	return (
		r.failedPhase === 'cleanup' ||
		(r.failedStep ?? '').startsWith('Post ') ||
		r.failedStep === 'Complete job'
	);
}

/**
 * Did the FLEET stop this job, rather than the job failing? Issue #22.
 *
 * Both halves matter and neither is sufficient. The duration alone catches a
 * job that happened to take an hour; the cleanup step alone catches every
 * ordinary `Post`-step flake. Together they are the signature of `The runner
 * has received a shutdown signal` — the unit went away under a job whose own
 * steps had all passed.
 *
 * A job that ran to the TTL and SUCCEEDED is evidence the TTL did NOT fire —
 * the unit outlived the job — so it is a duration coincidence, not a kill.
 */
export function isFleetKill(r: ZoneInput | null | undefined): boolean {
	if (!r) return false;
	if (typeof r.durationSec !== 'number' || !Number.isFinite(r.durationSec)) return false;
	if (r.conclusion === 'success') return false;
	if (!KNOWN_TTL_SEC.some((t) => Math.abs((r.durationSec as number) - t.sec) <= TTL_MATCH_SEC))
		return false;
	return isCleanupStep(r);
}

/**
 * The zone a failure is COUNTED in — {@link classifyZone}, except that a job the
 * fleet's own unit TTL killed is its own zone.
 *
 * WHY THE FOLD IS HERE AND NOT INSIDE `classifyZone`. `warrantsForcedRerun`
 * asks `classifyZone` whether a failure is worth spending a probe on, and a
 * fleet kill is not a placement question at all — re-running it elsewhere
 * measures nothing, because the next unit would be killed at the same TTL.
 * Folding `fleet` into the three-zone function would have changed that
 * decision as a side effect of adding a counter. So the three zones stay
 * exactly what §5.5 says they are, and this is the strictly-later refinement
 * built on top of them.
 *
 * A KILL THE FLEET CAUSED IS NEVER COUNTED AS THE CONSUMER'S FAILURE, which is
 * the whole reason the bucket exists: without it, a unit stopped at minute 60
 * of a 90-minute build lands in `runner` — true, but indistinguishable from a
 * box that could not start a job, which is a different repair.
 */
export function zoneOf(r: ZoneInput | null | undefined): ObservedZone {
	return isFleetKill(r) ? 'fleet' : classifyZone(r);
}

/**
 * Non-success records on one node, split by whose half of the fence they fell
 * on. See {@link NodeJobStats.failuresByZone} (job-history-stats.ts).
 */
export interface FailuresByZone {
	/** GitHub's own synthetic steps, or no step record at all. */
	runner: number;
	/** Steps the workflow NAMED but did not write — setup-*, checkout, install. */
	seam: number;
	/** The consumer's own step. */
	content: number;
	/** The fleet's unit TTL stopped it. {@link isFleetKill}, issue #22. */
	fleet: number;
	/**
	 * CANCELLED, and deliberately NOT classified into a zone.
	 *
	 * Measured over the live window 2026-09-08: 420 of 639 non-success records
	 * were cancellations, mostly `cancel-in-progress` supersedes whose step is
	 * arbitrary — three sampled ones stood on `Post Run actions/setup-node@v6`,
	 * `Update packages` and `Admin script tests (python)`. Classifying those
	 * would have put supersede noise in the `runner` bucket, which is the one an
	 * operator acts on. It is still COUNTED, because a bucket that vanishes is a
	 * fact nobody notices.
	 */
	cancelled: number;
}

/**
 * Fold a node's records into {@link FailuresByZone}. Every bucket is present
 * with an explicit zero — a sparse map would let a node with no runner-zone
 * failures and a node nobody looked at render identically.
 *
 * THE FIVE BUCKETS SUM TO `NodeJobStats.failures`, which is
 * `conclusion !== 'success'`. That invariant is asserted in the tests rather
 * than merely stated, because the two counts are computed in different places
 * and "the zones do not add up" is exactly the kind of drift nobody reads a
 * dashboard closely enough to catch.
 */
export function failuresByZone(records: readonly ZoneInput[]): FailuresByZone {
	const out: FailuresByZone = { runner: 0, seam: 0, content: 0, fleet: 0, cancelled: 0 };
	for (const r of records) {
		if (r.conclusion === 'success') continue;
		if (r.conclusion === 'cancelled') {
			out.cancelled += 1;
			continue;
		}
		out[zoneOf(r)] += 1;
	}
	return out;
}
