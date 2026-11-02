import {
	appendToDisk,
	compactHistory,
	forcedLifted,
	loadHistory,
	loadProbeLedger,
	probeRuns,
	records,
	remember,
	seenRuns,
	trimToBudget,
	type JobRecord,
} from './job-history-store.js';
import { WARM_PREFIX, parseJitName } from './lib/jit-naming.js';
import { jobPhases, stepFailure, type GhJob } from './job-history-phases.js';

/**
 * The job-phase/step-failure derivation (`jobPhases`/`stepFailure`/`GhJob`)
 * and the failed-step backfill (`backfillFailedSteps`/`BackfillReport`) moved
 * to their own files (wave shrink-1 lane C, pure move) to bring this file
 * under the 600-line target. Re-exported here so every existing importer of
 * `job-history-ingest.js` compiles unchanged.
 */
export { jobPhases, stepFailure, type GhJob };
export { backfillFailedSteps, type BackfillReport } from './job-history-backfill.js';

/**
 * Runs whose jobs we may fetch per tick, SHARED across every repo in the sweep.
 *
 * 12 until 2026-09-05, which was below the fleet's own burst rate and therefore
 * lost data rather than merely delaying it. Measured that evening: hadoku_site
 * alone completed 28 runs in 20 minutes (~84/h) while 12 per 10-minute tick caps
 * the WHOLE fleet at 72/h. The queue could not drain, and runs fell out of the
 * 30-run listing before the budget reached them — 2 confirmed permanently lost
 * inside a single 10-minute window, with 21 still queued behind them.
 *
 * 30/tick = 180/h, comfortably above the observed burst. The cost is bounded and
 * small: at most 30 extra jobs-calls per tick against a 5000/h limit that was
 * sitting at 954 when this was measured. It does not touch SWEEP_CONCURRENCY, so
 * the secondary-rate-limit exposure the sweep guards is unchanged.
 *
 * The alternative — widening the runs listing from `per_page=30` — was REJECTED.
 * That listing is not ours alone: the loop after `ingestRuns` alerts on queued
 * and in-progress runs by age, and the fleet carries two runs queued since
 * 2026-08-17 that cannot be cancelled. A wider page would pull those back into
 * view and re-alert on them, and cost an extra `queuedLabelsAreCovered` call
 * each. Raising throughput has no such coupling.
 *
 * The number is still a proxy, and it stays where it is. The property that
 * actually governs loss is nearness to the END of a repo's listing, which
 * differs per repo by turnover rate; a fleet-wide COUNT cannot express that, so
 * as of 2026-09-14 the budget is RANKED by listing position instead — see
 * {@link FetchBudget}'s reserve. Raising this number is not the next move if
 * loss recurs; look at the reserve.
 */
export const MAX_FETCH_PER_TICK = 30;
/**
 * Only runs this fresh are worth spending the budget on.
 *
 * Oldest-first fixed the starvation that lost 40% of runs, and immediately
 * introduced the opposite failure: observed within half an hour of deploying it,
 * the newest APPENDS were runs from NINE DAYS earlier. A quiet repo's 30-run
 * listing spans weeks, so "oldest unseen" reached back into ancient history and
 * spent the shared budget there while today's runs waited.
 *
 * Both failures are the same mistake — ranking by the wrong thing. The property
 * that matters is RISK OF LOSS, and a run is at risk when it is close to falling
 * out of its repo's listing, which for a busy repo is a matter of hours. A
 * nine-day-old run in a quiet repo is in no danger at all and contributes
 * nothing anyone reads; every panel figure is about recent behaviour.
 *
 * So: among unseen runs, oldest first — but only within this horizon. Comfortably
 * wider than any busy repo's listing turnover, far short of RETENTION_DAYS.
 */
export const FRESH_HORIZON_H = 48;

/**
 * The share of a listing that counts as AT RISK of scrolling out before the
 * next tick reaches it — the oldest third of the page GitHub returned.
 *
 * Risk is a POSITION IN THE PAGE, not an age. The oldest run of a `per_page=30`
 * listing is one push away from being unreachable; the newest has a whole page
 * of slack no matter how old it is — which is why FRESH_HORIZON_H is a separate
 * question and answers a different one. Measured 2026-09-14 across the
 * 14-day window, the busiest repo in its busiest hour (hadoku_site, 20 runs/h)
 * turns its 30-run listing over in 1.5 hours — nine ticks. A third of the page
 * is therefore ~3 ticks of warning at the worst rate the fleet has ever run,
 * which is the margin the reserve below is sized to protect.
 *
 * Both fractions are of the listing/budget actually in hand, never absolute: a
 * test that hands `ingestRuns` a budget of 2 and a listing of 5 must behave
 * exactly as it did before this existed, and with a floor()ed reserve of 0 it
 * does.
 */
export const AT_RISK_TAIL_FRACTION = 1 / 3;
/** The share of the shared budget held back for at-risk runs. See below. */
export const RISK_RESERVE_FRACTION = 1 / 3;

/**
 * A per-tick allowance of jobs fetches, SHARED across every repo in the sweep.
 *
 * The sweep fans out across repos, so the budget cannot be a number handed to
 * each `ingestRuns` call: six repos in flight would each see the full allowance
 * and spend it six times over. One object, decremented at the moment a fetch is
 * decided on (there is no await between `take()` and the call), keeps the cap
 * exact however the repos interleave.
 *
 * THE RESERVE, AND WHY IT IS NOT A PER-REPO BUDGET
 * -----------------------------------------------
 * Oldest-first (2026-09-04) fixed starvation WITHIN a repo. Across repos the
 * budget was still first-come: `runner-health` runs
 * `mapConcurrent(fleetRepos, SWEEP_CONCURRENCY, sweepRepo)`, which walks the
 * roster in order, and hadoku_site — the busiest repo on the fleet — is #26 of
 * 27. A repo swept early could spend all 30 slots on runs in no danger at all
 * and leave nothing for a repo swept later whose oldest runs were one tick from
 * scrolling out. Same mistake as newest-first, one level up: ranking by arrival
 * instead of by risk of loss.
 *
 * So a third of the allowance is reserved for runs that are near the END of
 * their repo's listing. `take(atRisk)` refuses a SAFE run once the budget is
 * down to the reserve; an at-risk run is served while anything is left at all.
 * The risk signal costs nothing — it is the position in the listing
 * runner-health already paid for.
 *
 * A PER-REPO BUDGET WAS REJECTED, and the arithmetic is the reason. Ingest
 * asks for each completed run's jobs ONCE, so there is never an ETag to send
 * and for this path the ceiling IS the spend — the distinction AGENTS.md draws
 * between a conditional and an unconditional call. 27 repos x 30 = 810 calls/tick =
 * 4,860/h against a 5,000/h budget, from a path that spends 180/h today. That
 * is the 2026-09-05 dispatch-cadence error over again (1,620 -> 6,480/h, and 19
 * minutes of every hour at `remaining: 0`). The reserve REDISTRIBUTES the same
 * 30 slots and adds none: per-tick spend is unchanged at MAX_FETCH_PER_TICK,
 * 180/h.
 */
export class FetchBudget {
	/**
	 * Slots that only an at-risk run may claim. Floor()ed, so a small budget —
	 * every test fixture, and `ingestRuns`' own numeric default path — reserves
	 * nothing and behaves exactly as it did before.
	 */
	readonly reserve: number;
	constructor(public remaining: number) {
		this.reserve = Math.floor(Math.max(0, remaining) * RISK_RESERVE_FRACTION);
	}
	/**
	 * Claim one fetch. False once the allowance is spent — or, for a run that is
	 * NOT at risk of scrolling out, once the allowance is down to the reserve.
	 *
	 * Defaults to at-risk: an unknown risk must never be a reason to skip a run,
	 * the same rule the undated-run filter in `ingestRuns` follows.
	 */
	take(atRisk = true): boolean {
		if (this.remaining <= 0) return false;
		if (!atRisk && this.remaining <= this.reserve) return false;
		this.remaining--;
		return true;
	}
}

/**
 * Ingest one repo's recent runs. `runs` is the listing runner-health already
 * holds; only COMPLETED, unseen runs cost a call.
 *
 * `budget` is either this call's own allowance or a {@link FetchBudget} shared
 * with the other repos of the same tick. Returns how many fetches this call made.
 *
 * `atRisk: false` is for runs that are NOT a listing: the backfill backlog
 * (`run-listing-gap.ts`), which is held until the horizon and so can wait for
 * the slots the listings' at-risk tails do not need.
 */
export async function ingestRuns(
	repo: string,
	runs: { id?: number; status?: string; created_at?: string; updated_at?: string }[],
	fetchJobs: (repo: string, runId: number) => Promise<{ jobs?: GhJob[] } | null>,
	budget: number | FetchBudget = MAX_FETCH_PER_TICK,
	opts: { atRisk?: false } = {}
): Promise<number> {
	// Read the window back BEFORE deciding what is new. Without this a restart
	// would re-fetch every run it had already recorded, and the dedupe that keeps
	// this cheap would be defeated on exactly the tick after every deploy.
	loadHistory();
	// The harness declares its probes seconds before they finish, so this is read
	// per call rather than per process. See loadProbeLedger.
	loadProbeLedger();
	const allowance = typeof budget === 'number' ? new FetchBudget(budget) : budget;
	const fresh: JobRecord[] = [];
	let fetched = 0;
	/**
	 * Job ids already in the window, built ONLY when a forced re-fetch is
	 * possible.
	 *
	 * A forced re-fetch asks GitHub for a run this module has already recorded.
	 * GitHub's jobs endpoint answers with the LATEST attempt, so the new attempt
	 * carries new job ids and appends cleanly — but a forced entry for a run
	 * whose attempt has not been re-queued yet answers with the SAME jobs, and
	 * pushing those again would double every duration that run contributes to a
	 * median. O(window) once, on the rare tick that has a forced entry to spend;
	 * never on an ordinary poll.
	 */
	let knownJobIds: Set<number> | null = null;
	// OLDEST FIRST, and this is the difference between deferral and STARVATION.
	//
	// The listing arrives newest-first. Spending the budget in that order serves
	// the newest runs and defers the oldest — which are precisely the ones about
	// to fall off the end of the `per_page=30` window. On the next tick there are
	// newer runs again, so the deferred ones are outranked again, and again, until
	// they scroll out unfetched. They are never "caught next tick": under any
	// continuous load they are never caught at all.
	//
	// That is not a theoretical ordering nit. Measured 2026-09-04 against the
	// Actions API: 38 of 95 completed hadoku_site runs — 40% — had no record at
	// all, clustered exactly in the bursts. Every number derived from this file
	// (per-node medians, idle times, how often hokon steps in, the queueSec the
	// backstop is tuned against) was therefore computed on a 60% sample biased
	// AGAINST busy periods, which is when the fleet's behaviour actually matters.
	//
	// Ascending run id is ascending age: GitHub run ids are monotonic per repo,
	// so this needs no extra field from the listing.
	//
	// Bounded by FRESH_HORIZON_H, or oldest-first walks a quiet repo's listing
	// back into runs that no statistic will ever read. See that constant.
	const freshFrom = Date.now() - FRESH_HORIZON_H * 3600_000;
	// HOW FAR DOWN THE LISTING a run sits is the per-repo risk the shared budget
	// cannot otherwise see — see AT_RISK_TAIL_FRACTION and FetchBudget's reserve.
	//
	// By RANK AMONG THE IDS, not by array index. Run ids are monotonic per repo,
	// which is the property oldest-first already rests on, so the oldest third by
	// id IS the last third of the page however the array arrived. Indexing the
	// array instead would invert the whole signal the one time a caller handed the
	// listing in a different order — and the existing budget fixtures do exactly
	// that, which is how this was caught rather than shipped.
	const idsAsc = runs
		.map((r) => r.id)
		.filter((id): id is number => typeof id === 'number')
		.sort((a, b) => a - b);
	// The id of the newest run still counted as at risk. -Infinity for an empty
	// listing, which makes nothing at-risk and costs nothing: there is no run.
	const atRiskThrough = idsAsc[Math.ceil(idsAsc.length * AT_RISK_TAIL_FRACTION) - 1] ?? -Infinity;
	const ordered = [...runs]
		.filter((r) => {
			const at = Date.parse(r.updated_at ?? r.created_at ?? '');
			// An undated run is NOT skipped: unknown age must not silently drop a
			// run, and the seenRuns dedupe keeps it from being re-fetched forever.
			return !Number.isFinite(at) || at >= freshFrom;
		})
		.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
	for (const run of ordered) {
		if (allowance.remaining <= 0) break;
		const id = run.id;
		if (typeof id !== 'number') continue;
		// Only completed runs: an in-progress run's jobs have no duration yet, and
		// recording them would freeze a partial time that never gets corrected.
		if (run.status !== 'completed') continue;
		// THE DEDUPE, AND THE ONE HOLE DELIBERATELY PUNCHED IN IT.
		//
		// `seenRuns` stops the poller re-fetching a run forever, and that must keep
		// holding: it is what makes a quiet fleet cost nothing. But it also means a
		// SECOND ATTEMPT of an already-seen run is never fetched, and that second
		// attempt is precisely the record Control A needs
		// (`tier-assignment-2026-09-03.md` §5.5, `claw-floor-design-2026-09-07.md`
		// §1.3): the fleet has served `(repo, runId, jobName)` on two distinct
		// nodes 0 times in 7,033 jobs, so "did it fail elsewhere" cannot be
		// answered from history — it has to be manufactured, and then READ BACK.
		//
		// So the skip is lifted for a FORCED RE-DISPATCH ONLY, exactly once per run
		// id per process (`forcedLifted`), and only for a run the harness has
		// declared in the ledger. A shadow run needs nothing here: it is a new run
		// id and was never seen.
		const forced = probeRuns.get(id) === 'forced-rerun' && !forcedLifted.has(id);
		if (seenRuns.has(id) && !forced) continue;
		// Claim the fetch BEFORE remembering the run: a run remembered without its
		// jobs fetched would never be fetched, and the shared budget may have been
		// spent by another repo since the check at the top of the loop.
		//
		// `break` rather than `continue` stays correct with the reserve in play.
		// `ordered` is ascending id and at-risk is the oldest third by id, so every
		// at-risk run comes first. Once one SAFE run is refused, every run left in
		// this repo is safe and would be refused for the same reason.
		if (!allowance.take(opts.atRisk !== false && id <= atRiskThrough)) break;
		remember(id);
		// Spent at the moment the fetch is claimed, NOT when it succeeds. A forced
		// entry whose fetch comes back null has still had its one lift: the run is
		// forgotten below and the ordinary unseen path retries it next tick, which
		// is the same recovery every other run gets. Spending it on success only
		// would let a repeatedly-failing fetch re-lift forever.
		if (forced) forcedLifted.add(id);
		fetched++;
		const body = await fetchJobs(repo, id);
		// A FAILED FETCH MUST NOT COUNT AS SEEN. `remember` has to happen before
		// the await — the budget is shared and there is no other safe point — but
		// a null body means the API did not answer, not that the run had no jobs.
		// Leaving it remembered retires the run permanently on one transient 5xx,
		// silently and with no way to notice. Forgetting it costs one retried
		// fetch on a later tick.
		if (!body) {
			seenRuns.delete(id);
			continue;
		}
		const origin = probeRuns.get(id);
		for (const j of body?.jobs ?? []) {
			if (!j.runner_name || !j.started_at || !j.completed_at || typeof j.id !== 'number') continue;
			if (forced) {
				knownJobIds ??= new Set(records.map((r) => r.jobId));
				if (knownJobIds.has(j.id)) continue;
				knownJobIds.add(j.id);
			}
			const start = Date.parse(j.started_at);
			const end = Date.parse(j.completed_at);
			if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
			const created = j.created_at ? Date.parse(j.created_at) : NaN;
			// A dependent job (`needs:`) is CREATED only once it is eligible, so this
			// is genuine runner-wait rather than time spent waiting on an upstream
			// job — verified against 270 jobs on 2026-08-25, where `deploy` sat at a
			// 4s median while the first job of each run carried the whole tail.
			const queueSec =
				Number.isFinite(created) && start >= created
					? Math.round((start - created) / 1000)
					: undefined;
			// The mint epoch is already in the runner's NAME — parseJitName reads the
			// same trailing `-<epoch>` the reaper ages on. A standing runner has no
			// mint, so both halves stay undefined rather than being guessed as 0.
			const minted = parseJitName(j.runner_name ?? '')?.mintedAtMs;
			// The halves must SUM to queueSec, so assign is the remainder rather than
			// its own subtraction. A JIT runner minted for one run can be handed a
			// different run's job, which makes `minted` predate `created`; clamping
			// each half independently then produced an assignSec LARGER than the
			// whole queue — measured across 636 real jobs, max assign 3553s against
			// a max queue of 2455s. A split that does not add up is worse than no
			// split, because it looks authoritative.
			//
			// dispatchSec 0 with a positive assignSec is meaningful, not a gap: a
			// runner was ALREADY waiting when the job was created, so none of the
			// wait is ours.
			//
			// A WARM listener has no mint to age, so the branch above leaves both
			// halves undefined — which is how issue #15 happened: `assignSec` was
			// structurally absent from every warm-served job, on exactly the path
			// P4.1 exists to measure (298 warm records to 2026-09-09, zero with an
			// assignSec). It is not missing data, it is a missing case. A warm
			// listener is a STANDING registration that predates the job and is
			// already long-polling, so there is no dispatch step to charge: the
			// whole wait belongs to GitHub deciding where to send the job, and
			// `dispatchSec` is 0 by construction rather than by measurement.
			//
			// The one case this over-attributes is a job created BEFORE the listener
			// that served it existed — the six 2026-09-08 06:14Z records in
			// `warm-latency-2026-09-08.md` §4(a), created seconds before the first
			// fill of the day. Those read as a large `assignSec` when part of the
			// wait was really the cache warming up. Correcting it would need a
			// per-job mint epoch, and a warm name deliberately carries none (there
			// is only ever one warm listener per node, so nothing needs
			// disambiguating). Over-attributing to the half that is already the
			// larger one beats leaving the number absent, which is what P4 got.
			const split =
				queueSec !== undefined && (j.runner_name ?? '').startsWith(WARM_PREFIX)
					? { dispatchSec: 0, assignSec: queueSec }
					: minted !== undefined && queueSec !== undefined && Number.isFinite(created)
						? (() => {
								const dispatchSec = Math.min(
									queueSec,
									Math.max(0, Math.round((minted - created) / 1000))
								);
								return { dispatchSec, assignSec: queueSec - dispatchSec };
							})()
						: {};
			fresh.push({
				repo,
				runId: id,
				jobId: j.id,
				name: j.name ?? 'job',
				runner: j.runner_name,
				...split,
				labels: j.labels ?? [],
				startedAt: j.started_at,
				durationSec: Math.round((end - start) / 1000),
				queueSec,
				...jobPhases(j, start, end),
				...stepFailure(j, start, end),
				conclusion: j.conclusion ?? 'unknown',
				// Spread like `probe` below: an organic-old record on disk never
				// carried this key, so a record with no head_sha in the API response
				// (should not happen, but GhJob declares it optional) gets no key at
				// all rather than an explicit `undefined`.
				...(j.head_sha ? { headSha: j.head_sha } : {}),
				// Spread, so an organic record carries no key at all rather than an
				// explicit `undefined` that JSON.stringify would drop anyway — the
				// shape on disk and the shape in memory stay the same object.
				...(origin ? { probe: origin } : {}),
			});
		}
	}
	records.push(...fresh);
	// Append the new records only — the whole point of JSONL here. Rewriting the
	// file every tick would turn a cheap append into O(window) IO on the same
	// loop that talks to GitHub.
	appendToDisk(fresh);
	trimToBudget();
	compactHistory();
	return fetched;
}
