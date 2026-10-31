import { logger } from '../host.js';
import { ghGet, ghWrite } from '../lib/github-client.js';
import type { GhRun, GhJob, RepoRunnerState } from '../runner-health.js';

const MAX_RERUN_ATTEMPTS = 2; // failover: auto-rerun once — only when run_attempt < this
const FAILOVER_RECENT_MINUTES = 30; // ignore stale failures (e.g. on monitor restart)

/** Cap on auto-reruns in a single tick, so one bad claw cannot storm the API. */
export const MAX_RERUNS_PER_TICK = 10;

// Failover dedupe: runs we've already auto-rerun, keyed `${runId}@${attempt}`.
// Persists across ticks so we never double-fire before GitHub bumps the attempt.
const failoverReran = new Set<string>();

/** Steps the RUNNER adds to every job. Everything else is the workflow's own. */
const RUNNER_BOOKKEEPING_STEPS = new Set([
	'Set up job',
	'Set up runner',
	'Complete runner',
	'Complete job',
]);

/**
 * True when the job-started hook refused the job: `Set up runner` failed and
 * not one of the workflow's own steps ran.
 *
 * `Set up runner` is where the runner executes `ACTIONS_RUNNER_HOOK_JOB_STARTED`,
 * which on every node is `ci-throttle.sh`, and a non-zero exit there fails the
 * job before checkout. ci-throttle only exits non-zero to REFUSE admission — its
 * /tmp prune and every other side task are bounded and never fail the job — so
 * this is an infrastructure failure in the same class as a runner going offline
 * or an OOM kill. No user code ran, so a rerun cannot repeat a side effect. Both
 * refusal kinds qualify: CONTENTION clears when a slot frees, and a PLACEMENT
 * refusal ("this node cannot host it") may land elsewhere on the rerun. The
 * attempt cap (`MAX_RERUN_ATTEMPTS`) makes it one rerun, so a refusal that
 * repeats stays red and still reaches a human.
 *
 * The case it exists for: on 2026-10-11 at 01:38Z the backstop promoted 29
 * hokon runners for saturation, GitHub seated ~20 builder jobs there inside a
 * minute, and ci-throttle (cap 4, which is right for hokon's 16 GiB CI slice)
 * refused three of them after its 90s wait. hadoku-study's publish,
 * hadoku-pygmalion's redeploy and hadoku-resume-bot's auto-update each failed
 * red and needed a hand rerun. hokon must stay labelled on EVERY repo while
 * promoted (see `syncBackstopAcrossFleet`), so over-seating is the cost of the
 * backstop, and the refusal is where it has to be absorbed.
 *
 * Read from the jobs listing the failover already fetched — zero extra calls.
 */
export function refusedAtAdmission(job: Pick<GhJob, 'conclusion' | 'steps'>): boolean {
	if (job.conclusion !== 'failure') return false;
	const steps = job.steps ?? [];
	const setup = steps.find((st) => st.name === 'Set up runner');
	if (setup?.conclusion !== 'failure') return false;
	return steps
		.filter((st) => !RUNNER_BOOKKEEPING_STEPS.has(st.name ?? ''))
		.every((st) => st.conclusion === 'skipped');
}

/**
 * Exit 137 is 128+9 — the job's process tree took a SIGKILL. Nothing in a build
 * sends itself SIGKILL, so in CI this is the kernel OOM killer essentially every
 * time, and it is the one failure class the offline-runner failover below is
 * structurally blind to: the OOM killer reaps the JOB, not the listener, so the
 * runner is still online at the next tick and the rerun never fires.
 *
 * That is not theoretical. On 2026-08-24 the 13:00 UTC @wolffm fan-out dispatched
 * 14 repos inside 4 seconds; 11 landed on claw-2 (7.8GB, the smallest box in the
 * fleet, and tier1 so it is never demoted) and the kernel killed two of them
 * 82 seconds apart. Both stayed red and paged @here as breakage.
 */
const SIGKILL_ANNOTATION = /\bexit code 137\b/;

interface GhAnnotation {
	message?: string;
}

/**
 * True when a job died to SIGKILL. Costs ONE extra API call, and only for a run
 * that is already a failover candidate (recent, failed, on one of our runners,
 * under the attempt cap) — a quiet tick never reaches it.
 *
 * Reads the check-run annotations rather than the logs: the exit code is in the
 * `##[error]` annotation, which is a small JSON document, where the log is a
 * multi-megabyte zip.
 */
async function jobWasKilled(repo: string, jobId: number, token: string): Promise<boolean> {
	const anns = await ghGet<GhAnnotation[]>(`/check-runs/${jobId}/annotations`, token, repo);
	if (!Array.isArray(anns)) return false;
	return anns.some((a) => typeof a?.message === 'string' && SIGKILL_ANNOTATION.test(a.message));
}

/**
 * The dropped-job failover for ONE completed, failed run — extracted from
 * checkRunsAndFailover's per-run sweep (wave 5h §A step 2). Every `continue`
 * in the original per-run loop body becomes an early `return` here: this was
 * always the LAST thing done with a run in that loop, so the caller does
 * nothing with a `false` result.
 *
 * `slots` is a MUTABLE object, not a copied number, for the same reason
 * `jobFetchBudget` (a `FetchBudget` instance) is one: several repos run this
 * concurrently (`mapConcurrent`), and the cap is only safe because the check
 * and the claim happen with no `await` between them — see the comment on
 * `sweepRepo` below. Threading the count through this function's return
 * value instead would let every repo that passed the check before the first
 * POST resolved claim its OWN slot on the same stale count, overshooting the
 * cap exactly the way the comment there warns about (caught by
 * `failover: the per-tick rerun cap holds across a concurrent sweep`, which
 * failed 12-for-10 against a value-threaded first draft of this extraction).
 *
 * Returns whether this run's failure was an OOM kill and whether a rerun was
 * actually accepted, so the caller can fold both into its own
 * `oomReruns`/`failoverReruns` counters (unaffected by the race above: both
 * are per-run facts, read back only after this call's own awaits are done).
 */
export async function attemptFailoverRerun(args: {
	token: string;
	repo: string;
	short: string;
	title: string;
	run: GhRun;
	now: number;
	runnersChecked: boolean;
	slots: { taken: number };
	runnerStateFor: (
		repo: string
	) => Promise<({ online: Set<string>; known: Set<string> } & RepoRunnerState) | null>;
}): Promise<{ oomRerun: boolean; reran: boolean }> {
	const { token, repo, short, title, run, now, runnersChecked, slots, runnerStateFor } = args;
	const noRerun = (oomRerun = false) => ({ oomRerun, reran: false });

	if (!runnersChecked) return noRerun();
	if (slots.taken >= MAX_RERUNS_PER_TICK) return noRerun();
	if (run.status !== 'completed' || run.conclusion !== 'failure') return noRerun();
	const attempt = run.run_attempt ?? 1;
	if (attempt >= MAX_RERUN_ATTEMPTS) return noRerun();
	const updatedMs = Date.parse(run.updated_at ?? run.created_at);
	if (!isNaN(updatedMs) && (now - updatedMs) / 60000 > FAILOVER_RECENT_MINUTES) return noRerun();
	const dedupeKey = `${repo}#${run.id}@${attempt}`;
	if (failoverReran.has(dedupeKey)) return noRerun();

	const state = await runnerStateFor(repo);
	if (!state) return noRerun();

	const jobsResp = await ghGet<{ jobs?: GhJob[] }>(`/actions/runs/${run.id}/jobs`, token, repo);
	if (!jobsResp || !Array.isArray(jobsResp.jobs)) return noRerun();

	// Only jobs that failed on a runner WE own are ever rerun. A failure on
	// a hosted runner, or on someone else's, is not ours to second-guess.
	const failedOnOurs = jobsResp.jobs.filter(
		(j): j is GhJob & { runner_name: string } =>
			j.conclusion === 'failure' && !!j.runner_name && state.known.has(j.runner_name)
	);
	if (failedOnOurs.length === 0) return noRerun();

	// Two INFRASTRUCTURE failure modes, both retryable, and they are
	// distinguished by opposite evidence — so they need separate probes:
	//
	//   runner offline   the box went away UNDER the job. GitHub reports it,
	//                    so the runner listing is the evidence.
	//   SIGKILL          the box is fine and the JOB was killed (OOM). The
	//                    runner is still online, so the listing says nothing
	//                    and only the job's own exit code shows it.
	//
	// Checking the listing first keeps the common case at zero extra calls.
	let reason = failedOnOurs.find((j) => !state.online.has(j.runner_name))
		? `'${failedOnOurs.find((j) => !state.online.has(j.runner_name))!.runner_name}' went offline`
		: '';

	if (!reason) {
		const refused = failedOnOurs.find((j) => refusedAtAdmission(j));
		if (refused) reason = `refused at admission by ci-throttle on '${refused.runner_name}'`;
	}

	let oomRerun = false;
	if (!reason) {
		for (const j of failedOnOurs) {
			if (typeof j.id !== 'number') continue;
			if (await jobWasKilled(repo, j.id, token)) {
				reason = `SIGKILL (exit 137, OOM) on '${j.runner_name}'`;
				oomRerun = true;
				break;
			}
		}
	}
	if (!reason) return noRerun(oomRerun);

	// Re-checked here, not only at the top: the probes above awaited, and a
	// sibling repo may have taken the last slot meanwhile.
	if (slots.taken >= MAX_RERUNS_PER_TICK) return noRerun(oomRerun);
	slots.taken++;
	logger.info(
		`[runner-health] FAILOVER rerun: ${short} run ${run.id} '${title}' — ${reason} ` +
			`→ POST rerun-failed-jobs ` +
			`(attempt ${attempt + 1}/${MAX_RERUN_ATTEMPTS}) ${run.html_url}`
	);
	const res = await ghWrite(
		'POST',
		`/actions/runs/${run.id}/rerun-failed-jobs`,
		token,
		undefined,
		repo
	);
	if (res.ok) {
		failoverReran.add(dedupeKey);
		// A self-healed claw drop is NOT outage-worthy — GitHub reruns the
		// failed jobs onto the next ready claw and CI stays green. So this
		// records but does NOT ping Discord live; the daily ci-digest rolls
		// up "N auto-reruns today" instead (workers/monitoring-api/ci-digest).
		logger.info(
			`[runner-health] FAILOVER rerun: ${short} run ${run.id} accepted (HTTP ${res.status})`
		);
		return { oomRerun, reran: true };
	}
	slots.taken--;
	logger.warn(
		`[runner-health] failover rerun for ${short} run ${run.id} → HTTP ${res.status} ` +
			'(token may lack actions:write) — job left failed for the operator'
	);
	return { oomRerun, reran: false };
}

/** Test seam: cross-tick memory this module owns. */
export function __resetFailoverForTesting(): void {
	failoverReran.clear();
}
