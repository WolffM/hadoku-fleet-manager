import { ghGet, readRunnerListingShared, SELF_REPO, type GhRunner } from './lib/github-client.js';
import {
	classifyQueuedRun,
	type RepoRunnerState,
	type GhJob,
} from './runner-health-queue-classify.js';
import { loadMintView, countLabels } from './runner-health-mint.js';
import { quietRecorder } from './runner-health-label-floor-nodes.js';
import { attemptFailoverRerun } from './runners/failover.js';
import { ingestRuns, FetchBudget, MAX_FETCH_PER_TICK } from './job-history-ingest.js';
import { closeListingGap, LISTING_PAGE } from './run-listing-gap.js';
import { SWEEP_CONCURRENCY, mapConcurrent } from './lib/concurrency.js';
import { fleetOwner } from './lib/fleet-config.js';
import { ADVISORY_REPAGE_MS, alertOnce } from './lib/alert-ledger.js';
import { selfHostname } from './lib/runner-health-shared.js';
import { getFleetProbeSnapshot } from './fleet-probe-store.js';
import type { TickReport } from './runner-health-snapshot.js';

/**
 * Minutes a job may sit queued before it counts toward `queuedStale`.
 *
 * EXPORTED because it also has to be SAID. The command station's "Queued past
 * 10m" card wrote the number into its own label, so the two agreed only by
 * coincidence — change it here and the card keeps claiming 10 while counting
 * something else. It reaches the panel through `FleetVocabulary`.
 */
export const QUEUED_WARN_MINUTES = 10;
const INPROGRESS_WARN_MINUTES = 30;

export interface GhRun {
	id: number;
	name?: string;
	display_title?: string;
	created_at: string;
	/**
	 * When THIS ATTEMPT began. `created_at` pins to the ORIGINAL run and GitHub
	 * never moves it, so on a re-run the two diverge by the whole gap between
	 * attempts — which is exactly the age this monitor used to report. On
	 * 2026-09-10 a re-run of a 2h-old hadoku-tenhands run alerted as "QUEUED
	 * 122m" while its jobs started four seconds later and every one went green.
	 * Absent on runs old enough to predate the field, hence the fallback.
	 */
	run_started_at?: string;
	updated_at?: string;
	status: string; // 'queued' | 'in_progress' | 'completed' | ...
	conclusion?: string | null; // 'success' | 'failure' | 'cancelled' | ... (when completed)
	run_attempt?: number;
	html_url: string;
}

/**
 * Per-job progress, carried BETWEEN ticks: jobId -> {done, since}.
 *
 * `done` is how many of the job's steps had finished when we last looked, and
 * `since` is when that count last CHANGED. A job whose count is still moving is
 * working, not hung — which is the distinction a wall-clock threshold cannot
 * make and the reason this map exists.
 *
 * Cross-tick memory, so it is reset by `__resetRunnerHealthAlertsForTesting`
 * along with everything else of its kind. A leaked entry would let one test's
 * job answer the next test's staleness question.
 */
const jobProgress = new Map<number, { done: number; since: number }>();

/**
 * How long a job may sit on the SAME step before it is called hung.
 *
 * Separate from `INPROGRESS_WARN_MINUTES`, which bounds total runtime. The two
 * measure different things and conflating them is what paged on 2026-09-10:
 * brave-quartet's Bevy compile takes 8-9 minutes on a hosted runner and 40+ on
 * a claw, so moving it onto the fleet put a perfectly healthy job past a
 * 30-minute ceiling that predated any fleet job running that long. It was
 * advancing through its steps the whole time.
 *
 * A threshold on TOTAL runtime has to be re-tuned every time the workload mix
 * changes, and is wrong for the fleet's slowest node by construction. Progress
 * does not: a job that has not finished a step in this long is stuck no matter
 * how fast or slow the box is.
 */
const STUCK_MINUTES = 25;

/**
 * Checks 2 & 3 — queued/hung runs, and failover for jobs whose runner vanished.
 *
 * Returns whether ANY repo's runs were readable. A partial read still counts:
 * tick() hard-fails only when neither this nor the label floor could read
 * anything, so a token that has lost runner-listing privilege still keeps the
 * queued-job safety net.
 */
export async function checkRunsAndFailover(
	token: string,
	fleetRepos: string[],
	data: TickReport,
	runnersChecked: boolean,
	onlineRunnerNames: Set<string> | null,
	selfHostedRunnerNames: Set<string> | null,
	onlineLabels: Record<string, number> | null,
	selfRunners: GhRunner[] | null
): Promise<boolean> {
	// --- Checks 2 & 3: queued / hung / dropped-job failover — FLEET-WIDE ---
	//
	// These read RUNS, and runs are per-repo. Until 2026-08-17 every call was
	// hardcoded to hadoku_site, so all three covered 1 repo out of 20 while
	// reporting fleet-wide numbers. See SELF_REPO for what that cost.
	//
	// Cost: one runs listing per repo per tick (~27 calls / 10 min). Runner
	// listings are fetched LAZILY and only for a repo that actually has a
	// failover candidate, so a quiet tick adds nothing beyond the listings.
	// (hoisted to the top of tick() — the saturation gate above needs it too)
	//
	// Time: the listings used to go out one after another, ~35s of every tick,
	// which is most of why the Fleet tab sat blank after each mgmt-api restart.
	// They now go out `SWEEP_CONCURRENCY` at a time — see `sweepRepo` below for
	// what that required of the state they share.

	// Per-tick runner state, keyed by repo. hadoku_site is seeded from Check 1.
	// A child repo may carry runners hadoku_site does not (hokon-tenhands), so
	// its own listing is the only correct source for "was this runner ours, and
	// is it offline now".
	//
	// It carries the repo's LABEL CENSUS as well, for the same reason it carries
	// its names: hadoku_site's registrations do not describe hadoku-tenhands,
	// which registers two boxes to hadoku_site's dozen. Classifying a tenhands
	// queue against hadoku_site's labels answers a question about the wrong repo.
	//
	// And the registrations themselves, offline ones included: a JIT runner
	// minted for a queued job and never come online is only visible there.
	const runnerStateCache = new Map<
		string,
		({ online: Set<string>; known: Set<string> } & RepoRunnerState) | null
	>();
	if (onlineRunnerNames && selfHostedRunnerNames && onlineLabels && selfRunners) {
		runnerStateCache.set(SELF_REPO, {
			online: onlineRunnerNames,
			known: selfHostedRunnerNames,
			labels: onlineLabels,
			runners: selfRunners,
		});
	}
	// The minting arm for the queued-run classifier, read at most once per tick
	// and only when a run is actually past the threshold. Same loader, same
	// probe, as the label floor above it.
	let queuedMint: ReturnType<typeof loadMintView> | undefined;
	const queuedMintView = () => {
		if (queuedMint === undefined) queuedMint = loadMintView(getFleetProbeSnapshot());
		return queuedMint;
	};
	const runnerStateFor = async (repo: string) => {
		if (runnerStateCache.has(repo)) return runnerStateCache.get(repo) ?? null;
		// Shared (#118) — see readRunnerListingShared for who may read it.
		const resp = await readRunnerListingShared(repo, token);
		const state =
			resp && Array.isArray(resp.runners)
				? {
						online: new Set(resp.runners.filter((r) => r.status === 'online').map((r) => r.name)),
						known: new Set(resp.runners.map((r) => r.name)),
						labels: countLabels(resp.runners.filter((r) => r.status === 'online')),
						runners: resp.runners,
					}
				: null;
		runnerStateCache.set(repo, state);
		return state;
	};

	const now = Date.now();
	// Ages, not just counts. A count answers "is anything stuck" but not "how
	// bad" — and the stale counters only tick ABOVE the warn thresholds, so a
	// fleet with nine jobs queued for nine minutes reports queued_stale=0 and
	// looks idle. These track every queued/running job regardless of threshold,
	// which is what makes a queue visible before it is an incident.
	let oldestQueuedMin = 0;
	let longestRunningMin = 0;
	let queuedNow = 0;
	let runningNow = 0;
	// Shared across the whole fleet sweep, not per repo: the cap exists to bound
	// this TICK's API cost, and a per-repo budget would multiply it by 26. One
	// object rather than a number because the repos below run concurrently.
	const jobFetchBudget = new FetchBudget(MAX_FETCH_PER_TICK);
	let queuedStale = 0;
	let inProgressStale = 0;
	let failoverReruns = 0;
	// Rerun slots CLAIMED this tick, as distinct from reruns that succeeded. With
	// several repos in flight, checking `failoverReruns` alone would let every
	// repo that passed the check before the first POST resolved fire its own,
	// and the cap would hold only in the sequential case. A slot is claimed right
	// before the POST and handed back if GitHub refuses it, so a refused rerun
	// still does not count against the cap — the same rule as before. A MUTABLE
	// object, not a plain number: `attemptFailoverRerun` claims and releases it
	// directly, so every concurrent repo's sweep sees the SAME live count.
	const rerunSlots = { taken: 0 };
	// Subset of failoverReruns that were OOM kills rather than a runner going away.
	// Tracked separately because a rising count here is a CAPACITY signal — the
	// fleet is being asked to run more concurrent jobs than a box can hold — where
	// a rising failover count is an AVAILABILITY one.
	let oomReruns = 0;
	let reposRead = 0;

	// One repo's sweep. The repos run `SWEEP_CONCURRENCY` at a time (below), so
	// everything this closure shares with its siblings has to be safe under
	// interleaving. Audited when the fan-out went in:
	//   - counters and maxima above: order-independent.
	//   - `runnerStateCache`: keyed by repo, and each repo is swept once.
	//   - `failoverReran`, alert keys: carry the repo or the run URL.
	//   - `jobFetchBudget`, `rerunSlots`: claimed with no await in between.
	//   - `ingestRuns`: dedupes on run id before its await, appends synchronously.
	// Within a repo the runs are still visited in listing order, one at a time,
	// so the per-repo rerun and alert ordering is exactly what it was.
	const sweepRepo = async (repo: string): Promise<void> => {
		const runsResp = await ghGet<{ workflow_runs?: GhRun[] }>(
			`/actions/runs?per_page=${LISTING_PAGE}`,
			token,
			repo
		);
		if (!runsResp || !Array.isArray(runsResp.workflow_runs)) return;
		reposRead++;
		const ownerPrefix = `${fleetOwner()}/`;
		const short = repo.startsWith(ownerPrefix) ? repo.slice(ownerPrefix.length) : repo;

		// Feed the job-history window off the listing we just paid for. Only
		// newly-COMPLETED runs cost anything (one jobs call each, capped per tick),
		// so a quiet fleet adds nothing and a burst simply catches up next tick.
		const fetchJobs = (r: string, runId: number) =>
			ghGet<{ jobs?: unknown[] }>(`/actions/runs/${runId}/jobs`, token, r) as never;
		await ingestRuns(repo, runsResp.workflow_runs, fetchJobs, jobFetchBudget);
		// Runs that scrolled past the end of this listing while it could not be
		// read (a budget blackout), found by paging back. See run-listing-gap.ts.
		const backlog = await closeListingGap(repo, runsResp.workflow_runs, async (page) => {
			const r = await ghGet<{ workflow_runs?: GhRun[] }>(
				`/actions/runs?per_page=${LISTING_PAGE}&page=${page}`,
				token,
				repo
			);
			return Array.isArray(r?.workflow_runs) ? r.workflow_runs : null;
		});
		if (backlog.length) {
			await ingestRuns(repo, backlog, fetchJobs, jobFetchBudget, { atRisk: false });
		}

		for (const run of runsResp.workflow_runs) {
			// THIS attempt's clock, not the original run's — see `run_started_at`.
			const startedMs = Date.parse(run.run_started_at ?? run.created_at);
			if (isNaN(startedMs)) continue;
			const ageMin = (now - startedMs) / 60000;
			if (run.status === 'queued') {
				queuedNow++;
				if (ageMin > oldestQueuedMin) oldestQueuedMin = ageMin;
			} else if (run.status === 'in_progress') {
				runningNow++;
				if (ageMin > longestRunningMin) longestRunningMin = ageMin;
			}
			const title = run.display_title || run.name || '(unnamed run)';

			if (run.status === 'queued' && ageMin > QUEUED_WARN_MINUTES) {
				queuedStale++;
				// "likely no online runner matches its labels" was a GUESS, and it was
				// usually wrong: with 27 registered instances a ten-minute queue is
				// far more often a busy pool than an uncovered one. It fired 36 times
				// in the fifteen days to 2026-08-28, the largest single category of
				// runner-health traffic, mostly during the nightly package storm when
				// every claw was legitimately saturated.
				//
				// So ASK, the same way the in_progress branch below does and for the
				// same reason: classify from the jobs. If an online runner carries
				// every label the job wants, the job is queuing behind work, which is
				// a wait, not a fault. Only a label nothing online can serve is a
				// coverage gap worth a ping.
				// Judged against THIS repo's registrations, not hadoku_site's.
				const verdict = await classifyQueuedRun(
					run.id,
					token,
					repo,
					await runnerStateFor(repo),
					queuedMintView(),
					ageMin,
					now
				);
				// The workflow NAME, not just the commit subject. `display_title` is
				// the commit message, so two different workflows on one push render as
				// byte-identical alerts — on 2026-09-10 a Tests run and a Pages run
				// arrived looking like the same finding posted twice.
				const wf = run.name ? `\`${run.name}\` / ` : '';
				const line =
					`⏱ **runners** on \`${selfHostname()}\`: \`${short}\` — ${wf}\`${title}\` has been ` +
					`QUEUED ${Math.round(ageMin)}m (>${QUEUED_WARN_MINUTES}m) — ${verdict.reason}` +
					`\n${run.html_url}`;
				if (verdict.covered) quietRecorder(line, 'runner-health');
				else await alertOnce(`queued:${run.html_url}`, line, ADVISORY_REPAGE_MS);
				continue;
			}
			if (run.status === 'in_progress' && ageMin > INPROGRESS_WARN_MINUTES) {
				// A run's status CANNOT distinguish a running job from one still
				// waiting for a runner: GitHub marks the run `in_progress` as soon
				// as it picks it up, whether or not anything is executing. Reading
				// it as "hung" therefore reports the exact OPPOSITE of a coverage
				// gap — on 2026-08-23 hadoku-games-host, which had no runners at
				// all, sat 854 minutes and alerted as "possible hung job pinning a
				// runner". Nothing was pinning anything; nothing could run. The
				// moment a runner existed the job finished in 32 seconds.
				//
				// So classify from the JOBS, which is the rule this repo already
				// states for CI timing and this check was not following. Costs one
				// extra listing, and only for a run already past the threshold.
				const detail = await ghGet<{ jobs?: GhJob[] }>(`/actions/runs/${run.id}/jobs`, token, repo);
				const jobs = Array.isArray(detail?.jobs) ? detail.jobs : [];
				const running = jobs.filter((j) => j.status === 'in_progress' && j.started_at);
				const waiting = jobs.filter((j) => j.status === 'queued' || !j.started_at);

				if (running.length) {
					// Measure from when the job STARTED, not when the run was created:
					// a job that queued 9h and has been executing 2min is not hung.
					//
					// LONG IS NOT HUNG, and that is the whole difference. Runtime alone
					// says a job is slow; only a job that has stopped FINISHING STEPS is
					// stuck. brave-quartet's Bevy compile runs 8-9 minutes hosted and
					// 40+ on a claw, so moving it onto the fleet on 2026-09-10 put a
					// healthy job past this ceiling within the hour — it was advancing
					// through its steps the entire time it was being called hung.
					//
					// So the ceiling is now a TRIGGER TO LOOK, and the step count is
					// what answers. Re-tuning a runtime threshold every time the
					// workload mix changes is a treadmill, and it is wrong for the
					// fleet's slowest node by construction.
					// PROGRESS IS ONLY READABLE WHEN GITHUB REPORTS STEPS. When it does
					// not — an older payload, a job it has not expanded — this falls
					// back to the runtime ceiling and stays LOUD. "I could not tell
					// whether it was progressing" must never render as "it is fine";
					// that is the same silence the 854-minute games-host outage taught
					// this check to refuse, one question deeper.
					let worst: { min: number; stuckMin: number; step: string; readable: boolean } | null =
						null;
					// The LONGEST-RUNNING readable job, for the slow-not-hung ledger
					// row below. Not `worst`: that is picked by time without progress,
					// so it can be a job that started a minute ago (#131).
					let slowest: { min: number; step: string } | null = null;
					for (const j of running) {
						const min = (now - Date.parse(j.started_at!)) / 60000;
						const steps = Array.isArray(j.steps) ? j.steps : [];
						const id = typeof j.id === 'number' ? j.id : -1;
						const readable = steps.length > 0 && id >= 0;
						if (!readable) {
							// An unreadable job outranks a readable one — it is the case
							// that can hide a real stall — and among unreadable ones, the
							// longest-running is the one worth naming.
							if (!worst || worst.readable || min > worst.min) {
								worst = { min, stuckMin: min, step: '(steps unreadable)', readable: false };
							}
							continue;
						}
						const done = steps.filter((st) => st.conclusion).length;
						const prev = jobProgress.get(id);
						// First sighting, or the count moved: it is working. Reset the clock.
						if (!prev || prev.done !== done) jobProgress.set(id, { done, since: now });
						const stuckMin = (now - jobProgress.get(id)!.since) / 60000;
						// Name the step it is sitting on — a finding that says only
						// "hung" sends the operator to open the run every time.
						const cur = steps.find((st) => !st.conclusion)?.name ?? '(no step reported)';
						if (!slowest || min > slowest.min) slowest = { min, step: cur };
						if (!worst || stuckMin > worst.stuckMin) {
							worst = { min, stuckMin, step: cur, readable: true };
						}
					}

					if (worst && !worst.readable && worst.min > INPROGRESS_WARN_MINUTES) {
						// Fail loud, and SAY the reason is missing evidence rather than
						// asserting a stall we could not observe.
						inProgressStale++;
						await alertOnce(
							`hung:${run.html_url}`,
							`🚨 **runners** on \`${selfHostname()}\`: \`${short}\` — \`${title}\` has been ` +
								`EXECUTING ${Math.round(worst.min)}m (>${INPROGRESS_WARN_MINUTES}m) — possible hung ` +
								`job pinning a runner. (GitHub reported no steps, so progress could not be ` +
								`checked and this is unconfirmed.)\n${run.html_url}`
						);
					} else if (worst && worst.readable && worst.stuckMin > STUCK_MINUTES) {
						inProgressStale++;
						await alertOnce(
							`hung:${run.html_url}`,
							`🚨 **runners** on \`${selfHostname()}\`: \`${short}\` — \`${title}\` has been ` +
								`EXECUTING ${Math.round(worst.min)}m and has not finished a step in ` +
								`${Math.round(worst.stuckMin)}m (>${STUCK_MINUTES}m) — stuck on ` +
								`\`${worst.step}\`, likely pinning a runner.\n${run.html_url}`
						);
					} else if (slowest && slowest.min > INPROGRESS_WARN_MINUTES) {
						// Past the runtime ceiling but still finishing steps. Worth a
						// ledger row — a job that has doubled its usual runtime is a
						// capacity signal — but not a page: nothing is wrong.
						//
						// Gated on the JOB's own runtime (#131). This block is entered on
						// the RUN's age, which counts every minute its later jobs spent
						// queued, so a job one minute in printed "EXECUTING 1m (>30m)".
						quietRecorder(
							`⏳ **runners** on \`${selfHostname()}\`: \`${short}\` — \`${title}\` has been ` +
								`EXECUTING ${Math.round(slowest.min)}m (>${INPROGRESS_WARN_MINUTES}m) but is still ` +
								`finishing steps — currently \`${slowest.step}\`. Slow, not hung.\n${run.html_url}`,
							'runner-health'
						);
					}
					continue;
				}

				if (waiting.length) {
					// Same condition the queued branch above reports, reached by a
					// different route — the run says in_progress while its work has
					// never been placed. Keyed as `queued:` so it dedupes with that
					// branch rather than paging twice for one starvation.
					queuedStale++;
					// Name the CAUSE, not just the symptom. The label-floor check
					// reads hadoku_site's listing as the fleet-wide view, which is
					// right for the claws but structurally blind to a repo with no
					// runners of its own — hadoku_site had six `hadoku-builder`
					// runners online while hadoku-games-host had ZERO, so the floor
					// looked healthy for the entire 854 minutes. This repo's own
					// listing is the only thing that can say so.
					const state = await runnerStateFor(repo);
					const onlineHere = state?.online.size ?? null;
					const cause =
						onlineHere === 0
							? `**this repo has NO online runners registered** — a job requesting ` +
								`self-hosted here can never be placed`
							: onlineHere === null
								? `its runner listing was unreadable`
								: `${onlineHere} runner(s) online here, none matching this job's labels`;
					await alertOnce(
						`queued:${run.html_url}`,
						`⏱ **runners** on \`${selfHostname()}\`: \`${short}\` — \`${title}\` has been WAITING FOR A ` +
							`RUNNER ${Math.round(ageMin)}m (>${QUEUED_WARN_MINUTES}m): ${cause}. ` +
							`A COVERAGE gap, not a hung job — check \`pnpm run fleet:reconcile\`.` +
							`\n${run.html_url}`,
						ADVISORY_REPAGE_MS
					);
				}
				// Could not identify a single job — either the listing was
				// unreadable or it came back empty. Fall back to the old run-level
				// alert rather than going quiet: "we could not classify it" must
				// never silently retire the hung-job signal, which is the same
				// fail-toward-reporting rule the rest of this file follows. Only a
				// run whose jobs were READ and are all finished stays silent, which
				// is the genuinely uninteresting case (a workflow finalising).
				if (!detail || jobs.length === 0) {
					inProgressStale++;
					await alertOnce(
						`hung:${run.html_url}`,
						`🚨 **runners** on \`${selfHostname()}\`: \`${short}\` — \`${title}\` has been IN-PROGRESS ` +
							`${Math.round(ageMin)}m (>${INPROGRESS_WARN_MINUTES}m) — possible hung job pinning ` +
							`a runner. (Job detail unavailable, so this is unconfirmed: it may instead be ` +
							`waiting for a runner.)\n${run.html_url}`
					);
				}
				continue;
			}

			// --- dropped-job failover (needs Actions:write) ---
			const failoverOutcome = await attemptFailoverRerun({
				token,
				repo,
				short,
				title,
				run,
				now,
				runnersChecked,
				slots: rerunSlots,
				runnerStateFor,
			});
			if (failoverOutcome.oomRerun) oomReruns++;
			if (failoverOutcome.reran) failoverReruns++;
		}
	};

	await mapConcurrent(fleetRepos, SWEEP_CONCURRENCY, sweepRepo);

	const runsChecked = reposRead > 0;
	data.queued_stale = queuedStale;
	data.inprogress_stale = inProgressStale;
	data.queued_now = queuedNow;
	data.running_now = runningNow;
	data.oldest_queued_min = Math.round(oldestQueuedMin);
	data.longest_running_min = Math.round(longestRunningMin);
	data.failover_reruns = failoverReruns;
	data.oom_reruns = oomReruns;
	data.repos_scanned = reposRead;
	return runsChecked;
}

/** Test seam: cross-tick memory this module owns. */
export function __resetRunsForTesting(): void {
	jobProgress.clear();
}
