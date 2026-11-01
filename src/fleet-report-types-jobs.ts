/**
 * The job-history SECTION of the `GET /fleet` contract (wave 5r lane A pure
 * move out of `fleet-report-types.ts`): per-node and per-repo job stats, one
 * job record, and the phases its wall time splits into. See that file's own
 * header for why this is a type-only barrel's section rather than a runtime
 * module — `fleet-report-types.ts` re-exports every name below for every
 * existing importer.
 */

/**
 * A node's non-success records split by whose half of the fence they fell on —
 * `claw-floor-design-2026-09-07.md` §5.5's zone table, plus the fleet's own
 * kills, on the wire.
 *
 * THE FIVE SUM TO `FleetMachineJobStats.failures`. Every bucket is always
 * present with an explicit zero: a sparse object would render a node with no
 * runner-zone failures and a node nobody could look at identically.
 *
 * `runner`   GitHub's own synthetic steps (`Set up job`, `Complete job`, `Post
 *            *`), or no step record at all. The fleet's half by elimination.
 * `seam`     steps the workflow NAMED but did not write — `setup-python`,
 *            `checkout`, `install`. The seam between the consumer's yaml and
 *            the fleet's boxes; both known real fleet bugs landed here.
 * `content`  the consumer's own step.
 * `fleet`    the fleet's unit TTL stopped the job out from under it (issue
 *            #22) — a kill the fleet CAUSED, never the consumer's failure.
 * `cancelled` cancelled, deliberately unclassified: 420 of 639 non-success
 *            records in the 2026-09-08 window were `cancel-in-progress`
 *            supersedes, and the step one lands on is arbitrary.
 *
 * A ZONE IS A PRIOR, NOT A VERDICT. A content-zone step can still be the
 * fleet's (an OOM-killed test reports as `Tests` failing) and a seam step can
 * still be the consumer's (pinning `python-version: '3.13'` fails `Set up
 * Python` everywhere).
 *
 * RENDER `jobs` BESIDE ANY RATE COMPUTED FROM THESE. The fleet's measured
 * runner+seam rate is ~0.15 %, so at one node's volume a single event moves a
 * percentage by more than any real difference between boxes —
 * `docs/planning/failures-by-node-2026-09-15.md` has the arithmetic.
 */
export interface FleetFailuresByZone {
	runner: number;
	seam: number;
	content: number;
	fleet: number;
	cancelled: number;
}

export interface FleetMachineJobStats {
	machine: string;
	jobs: number;
	failures: number;
	/**
	 * `failures` SPLIT BY ZONE — see {@link FleetFailuresByZone}.
	 *
	 * ADDITIVE, and the reason it had to go on the wire rather than be derived:
	 * folding a failure into a zone needs `failedStep` and `failedPhase` AND
	 * §5.5's pattern table, none of which this package publishes to a browser
	 * bundle. The command station could show "claw-2: 11 failures" and could not
	 * show that ten of them were the consumer's own test — which is the whole
	 * question issue #3 asks.
	 */
	failuresByZone: FleetFailuresByZone;
	/**
	 * THE BASELINE — cut over the whole retained window (14 days, thousands of
	 * records), which is the only reason a percentile here is worth anything.
	 */
	medianSec: number | null;
	p95Sec: number | null;
	repos: number;
	/**
	 * THE SAME TWO FIGURES OVER THE TRAILING HOUR, beside the baseline and never
	 * instead of it.
	 *
	 * The panel could show a 14-day p50 and it could show the last 40 jobs, and
	 * it could not put the two together — "is the fleet slower than usual right
	 * now" was the one thing the operator asked for that this payload could not
	 * answer (issue #18, WolffM/hadoku_site#385). A consumer cutting its own
	 * window over `jobs.recent` cannot fix that: 40 records across 8 machines is
	 * n = 1..6 per node, and it is a RECORD count, so it spans minutes on a busy
	 * fleet and days on a quiet one and silently means something different each
	 * time. This window is a TIME window, cut server-side over the full history.
	 *
	 *   `recentJobs`       jobs this node FINISHED in the window. A count, so 0
	 *                      is a genuine reading.
	 *   `recentMedianSec`  `null` whenever `recentJobs` is 0, NEVER 0. A
	 *   `recentP95Sec`     percentile over no samples is no data, not a fast
	 *                      node — render it as "no data", the same way an
	 *                      unprobed machine's `free` is rendered.
	 *
	 * The window's own bounds travel too, so no reader has to assume them:
	 * `jobs.recentSince` and `jobs.recentWindowSec`.
	 *
	 * WHAT THEY CANNOT SEE. Job history holds COMPLETED jobs only, so a fleet
	 * that is stalled — everything queued or hung — empties this window rather
	 * than reddening it. An empty window is NOT a healthy one; `fleet.queuedNow`,
	 * `oldestQueuedMin` and `longestRunningMin` are what catch that. The window
	 * does guarantee the converse: because it is cut on COMPLETION rather than
	 * start, a three-hour job enters it in full the moment it lands, so it
	 * cannot get quieter the slower the fleet gets.
	 */
	recentJobs: number;
	recentMedianSec: number | null;
	recentP95Sec: number | null;
}

/** Mirrors `job-history.RepoJobStats`. */
export interface FleetRepoJobStats {
	repo: string;
	jobs: number;
	failures: number;
	failuresByZone: FleetFailuresByZone;
	/** Whole-job `durationSec`. */
	medianSec: number | null;
	p95Sec: number | null;
	queueP50Sec: number | null;
	queueP95Sec: number | null;
	dispatchP50Sec: number | null;
	assignP50Sec: number | null;
	recentJobs: number;
	recentMedianSec: number | null;
	recentP95Sec: number | null;
	machines: { machine: string; jobs: number }[];
	/** Slowest job kinds by p95, at most three, each with enough runs to mean something. */
	slowest: { name: string; p95Sec: number; jobs: number }[];
}

/**
 * Mirrors `job-history.DailyJobStats`, plus the day's dispatch counts. `null`
 * means nothing was looking that day; `0` means it looked and it was empty.
 */
export interface FleetDailyJobStats {
	day: string;
	jobs: number | null;
	failuresByZone: FleetFailuresByZone | null;
	runMedianSec: number | null;
	runP95Sec: number | null;
	queueMedianSec: number | null;
	queueP95Sec: number | null;
	backstopJobs: number | null;
	byMachine: { machine: string; jobs: number; busySec: number }[];
	/** Runners the dispatcher minted that day; `null` before its persisted history began. */
	dispatch: { minted: number; failed: number; mintedViaAffinity: number } | null;
}

export interface FleetJobRecord {
	repo: string;
	/**
	 * The forge's own ids for this job, so a reader can link to it.
	 *
	 * Already on the wire — `jobs.recent` passes whole JobRecords through — and
	 * declared nowhere until now, which is the third time that combination has
	 * cost something on this payload (`dispatchSec`/`assignSec` were the second).
	 * Values a consumer cannot see the type of are values a consumer does not
	 * use, and the guard below cannot pin.
	 */
	runId: number;
	jobId: number;
	name: string;
	runner: string;
	/**
	 * The NODE that served this job — `runner` folded by `nodeOf`, the fleet's
	 * one implementation of that question.
	 *
	 * `runner` cannot be folded by a consumer and must not be tried. It is
	 * `jit-claw-1-hadoku-conjure-j102671642063-r34413053817-1788993392` on a JIT
	 * node, `warm-claw-3-hadoku_site` on a warm listener, `hokon-tenhands` on an
	 * instance and `GitHub Actions 1000024103` when the job went hosted. Folding
	 * those needs `JIT_PREFIX`, `WARM_PREFIX`, `HOSTED_NAME` and a longest-prefix
	 * rule against the live node list, none of which this package publishes into
	 * a browser bundle — and `runners/census.ts` records that this question had
	 * FIVE implementations, two of which disagreed. A sixth in the command
	 * station, on its own deploy cadence, is exactly the drift `vocabulary` was
	 * added to this payload to stop.
	 *
	 * So the answer travels instead. It is the same value `jobs.byMachine[].machine`
	 * is keyed by, from the same call on the same node list, which is what makes
	 * "this job took 3m03s against claw-1's p50 of 38s" a join rather than a
	 * guess. Issue #18 / WolffM/hadoku_site#385.
	 *
	 * ATTACHED AT SERIALISE TIME, not stored: it is a pure function of the runner
	 * name and the CURRENT manifest, so a stored copy would outlive a retired
	 * node, and the fourteen days of records already on disk carry no such field.
	 */
	machine: string;
	labels: string[];
	startedAt: string;
	durationSec: number;
	conclusion: string;
	/**
	 * WHERE THE TIME WENT, in seconds. All four are optional and absent
	 * TOGETHER when GitHub's step timings were unusable — never a guessed 0,
	 * which would render as a phase that took no time rather than one we could
	 * not measure.
	 *
	 *   queueSec    waiting for a runner (`created_at` -> `started_at`)
	 *   setupSec    runner coming up + "Set up job". On a JIT node this contains
	 *               the MINT, which no other figure in this payload exposes.
	 *   runSec      the job's own steps
	 *   cleanupSec  `Post *` teardown + "Complete job"
	 *
	 * Derived from steps `/actions/runs/{id}/jobs` already returns, so this cost
	 * no new request. There is no "waiting" or "finalizing" bucket because the
	 * API exposes nothing that separates either from `run` and `cleanup`, and a
	 * segment invented to fill out a legend means nothing.
	 */
	queueSec?: number;
	/**
	 * `queueSec` split by WHO WAS SLOW. Present together or not at all, and they
	 * sum to `queueSec` exactly — `assignSec` is computed as the remainder, so a
	 * renderer can draw them in place of the total without the bar disagreeing
	 * with itself.
	 *
	 *   dispatchSec  job created -> runner minted.   OURS.
	 *   assignSec    runner minted -> job started.   GITHUB'S.
	 *
	 * They were derived and stored on 2026-09-03 and reached this contract on
	 * 2026-09-04, which is a gap worth naming: `jobs.recent` passes whole
	 * JobRecords through, so the VALUES were on the wire the whole time while the
	 * type declared nothing. A consumer could not read them without a type error
	 * and the wire-contract test could not pin them — the split existed and the
	 * operator could not see it.
	 *
	 * Backfilled over 636 real jobs when it landed: queue p50 89s, of which
	 * dispatch p50 80s and assign p50 8s. The median wait is ours and worth
	 * tuning; the 610s assign outlier that triggered the work was not.
	 */
	dispatchSec?: number;
	assignSec?: number;
	setupSec?: number;
	runSec?: number;
	cleanupSec?: number;
}

/**
 * One segment of a job's wall time, in the order it happens.
 *
 * SHIPPED FOR THE SAME REASON `capacityKinds` IS. The panel carried its own
 * table of four phases — id, label and meaning — which is the last copy of
 * fleet-manager's semantics living in another repo on another deploy cadence.
 * When `queueSec` gained a dispatch/assign split, that table did not fail to
 * compile: it kept drawing one confident `queued` block over two numbers that
 * say different things about who to go and fix.
 *
 * `detail` is how a phase subdivides. A renderer draws the detail segments
 * INSTEAD of the parent when the record carries all of them, and the parent
 * when it does not — which is exactly the mixed history a rolling window holds
 * for the hours after a split ships. They sum to the parent, so either choice
 * totals the same.
 *
 * A fifth phase, or a second split, is a new entry here and no consumer change.
 */
export interface JobPhase {
	id: string;
	/** The `FleetJobRecord` field carrying this phase's seconds. */
	field: 'queueSec' | 'dispatchSec' | 'assignSec' | 'setupSec' | 'runSec' | 'cleanupSec';
	/** One line, operator-facing, rendered verbatim. The only description there is. */
	description: string;
	/** Finer segments that SUM to this one. @see JobPhase */
	detail?: JobPhase[];
}
