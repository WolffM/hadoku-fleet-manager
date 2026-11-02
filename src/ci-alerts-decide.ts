/**
 * CI-red alerting's classification and decision logic, split out of
 * `ci-alerts.ts` (wave 5r lane C, pure move) to bring that file under the
 * 800-line ceiling.
 *
 * HOLDS: the run/state shapes (`CiRun`, `CiState`, `GhGet`), the two
 * staleness guards (`STALE_STATE_MS`, `STALE_RUN_MS`), the re-page window
 * (`REPAGE_INTERVAL_MS`), the fork/foreign-run and freshness predicates
 * (`isForeignRun`, `runEndedAt`, `runsEndedSince`), the `timeout-minutes`
 * annotation check (`cancelledByTimeout`), and the pure state machine
 * itself (`decideCiAlert`). Every name here stays re-exported from
 * `ci-alerts.ts`, so no importer elsewhere needed to change.
 */
import { DAY_MS as REPAGE_INTERVAL_MS, repageDue } from './lib/job-runner.js';

/** Injected so this module never imports runner-health (which would cycle). */
export type GhGet = <T>(path: string, token: string, repo?: string) => Promise<T | null>;

export type CiConclusion = string | null;

export interface CiRun {
	id: number;
	/** `.github/workflows/<file>` — how a repo-wide listing is split by target. */
	path?: string;
	/**
	 * Where the run's code came from. A fork PR's is the fork, and its outcome
	 * is the contributor's, not this fleet's — see `isForeignRun`.
	 */
	head_repository?: { full_name?: string; fork?: boolean } | null;
	conclusion: CiConclusion;
	status: string;
	html_url: string;
	created_at: string;
	/**
	 * When the run reached its conclusion. Optional only because it is optional
	 * in the fixtures; GitHub sends it on every run. `runEndedAt` explains why
	 * the freshness gate must read THIS and not `created_at`.
	 */
	updated_at?: string;
}

export interface CiState {
	lastConclusion: CiConclusion;
	lastRunId?: number;
	/** ISO time of the last poll that wrote this entry. Absent ⇒ treat as stale. */
	lastSeen?: string;
	/** Run we last posted about — idempotency across duplicate ticks. */
	lastAlertedRunId?: number;
	/**
	 * ISO time of the last announcement for this target. It anchors the re-page
	 * throttle (REPAGE_INTERVAL_MS) and is stamped ONLY when something was
	 * actually said — a suppressed run that advanced it would push the next
	 * re-page out indefinitely, and a repo pushing faster than the window would
	 * then never be re-paged at all. Same reasoning as monitoring-api
	 * job-alerts' `last_alert_at`.
	 */
	lastAlertedAt?: string;
	/**
	 * Watermark on the CONCLUSION axis: the end time of the newest run this
	 * target has already been through the state machine with. `runsEndedSince`
	 * evaluates exactly the runs past it, so every completed run on the page is
	 * seen once and only once.
	 *
	 * It has to be the end time rather than a run id or a poll clock:
	 *
	 *   - a run ID is a position in `created_at` order, and the whole of #32 is
	 *     that a failure can sit BELOW a newer run in that order. A run queued at
	 *     04:35 and failing at 13:30 is ~30 positions down the page it concludes
	 *     on; "everything above the last id I recorded" never reaches it.
	 *   - the poll clock (`lastSeen`) is OUR clock against GitHub's timestamps,
	 *     so a run indexed a few seconds after it ended lands just behind the
	 *     stamp and is skipped forever — the same silent miss in a new costume.
	 *
	 * Absent ⇒ a row written before 2026-09-19, or a first sighting; either way
	 * only the newest run is evaluated, which is exactly the old behaviour. A
	 * page of history replayed into a cold machine is the incident STALE_STATE_MS
	 * exists for, so the cold path stays narrow.
	 */
	lastEndedAt?: string;
}

/**
 * Blind-gap guard. The tick is 10 min, so this is ~3.5 missed ticks: long
 * enough that ordinary tick jitter never trips it, short enough that a real
 * outage is caught. ci-check used 30min against a 5-min tick for the same
 * purpose; the THRESHOLD is in ticks, not minutes, so it scales with cadence.
 *
 * A transition computed across such a gap spans the gap rather than describing
 * a live event — the 2026-06-17 case where a two-week-old deploy failure
 * replayed as a fresh "recovered".
 */
export const STALE_STATE_MS = 35 * 60 * 1000;

/**
 * Durable freshness gate, independent of cached state. A genuine real-time
 * transition points at a run that just completed; a run that FINISHED hours ago
 * is history resurfacing after a blind gap or a lost state file, not an
 * incident. Survives state loss, which STALE_STATE_MS cannot.
 *
 * Measured from the run's END, not its start — `runEndedAt` has the reason.
 */
export const STALE_RUN_MS = 6 * 60 * 60 * 1000;

/**
 * How long a target stays throttled after a page, so that a NEW failing run on
 * an ALREADY-RED target says something instead of nothing (#20).
 *
 * The bug it fixes: red -> red was "no transition", so once a target had paged
 * it could never page again until it went green. brave-quartet/ci paged on run
 * 34391097443 (2026-09-09 19:37Z) and stayed red; run 34543150470 finished at
 * 2026-09-11 00:40Z — a new commit, b2ad33e9, a genuinely new failure — and was
 * swallowed by the equality test. It reached the operator 23 h later, via the
 * daily digest.
 *
 * WHY 24 h, from 90 days of the real watch list (64 targets, 4,362 completed
 * runs; replayed through this function). 69 new failing runs landed on an
 * already-red target. Their age since the previous page is bimodal:
 *
 *     <1h  1-3h  3-6h | 6-12h  12-24h | 24-48h  >48h      (60-day slice, n=33)
 *      23    1     3  |   0       1   |    3      2
 *
 * 27 of 33 are inside six hours — push storms and re-runs during one debugging
 * session, which is the double-page shape the handoff boundary was built to
 * stop (hadoku-dataplatform/ci: 6 failing runs in 1 h 46 m on 2026-08-26;
 * ArchiveBot/deploy: 8 in 50 min on 2026-01-20). Between 6 h and 24 h the data
 * is all but empty — ONE sample — so the number is not sensitive anywhere in
 * that range, and it is bounded on both sides:
 *
 *   - lower: it must sit above the storm mass, or this reintroduces the very
 *     thing it is throttling. 1 h would have added 20 pages in 90 days; 24 h
 *     adds 7, against a baseline of 98 first-break pages (+7 %, one per 13 days).
 *   - upper: the daily digest ALREADY catches a 23-hour red — that is how #20
 *     reached the operator. A window longer than a day would be beaten by the
 *     thing it is supposed to improve on.
 *
 * Within that range it is 24 h because monitoring-api's job-alerts uses exactly
 * 24 h (`REMINDER_INTERVAL_MS`) for the same "failure while already broken"
 * case. The two alerters split GitHub Actions between them along the
 * `coveredJobNames` boundary; one policy across the boundary beats two.
 *
 * VALUE AND NAME ARE UNCHANGED (F12, plan §4.1): this is `job-runner.ts`'s
 * shared `DAY_MS`, imported under this module's own name so every reasoning
 * above and every existing caller (including the test file, which imports it
 * by this name) stays exactly as it reads today. What moved is only that this
 * file no longer DECLARES the value — see the import above.
 */

/**
 * A run whose code is not the repo's own: a pull request from a fork. Its red is
 * the contributor's, and on a public repo (hadoku-actions, hadoku-task) anyone
 * can produce one, so it must never page. Read from the listing payload — no
 * extra call. A run with no `head_repository` at all is kept: GitHub sends one
 * on every run, and dropping a run on a missing field is the quiet direction.
 */
export function isForeignRun(run: CiRun, repo: string): boolean {
	const head = run.head_repository;
	if (!head) return false;
	if (head.fork === true) return true;
	return typeof head.full_name === 'string' && head.full_name.toLowerCase() !== repo.toLowerCase();
}

/**
 * When a run ENDED. The freshness gate asks "did this just happen", and
 * `created_at` answers "when was it queued" — two different numbers whenever a
 * run is slow or was stuck in a queue, and the gap is unbounded.
 *
 * Reading `created_at` made the gate EASIER to pass the worse the failure got,
 * which is the one thing a gate may never do: a run that overran the six-hour
 * window was silently un-alertable, and overrunning is itself a symptom. Ten
 * failing runs in the 90-day history are in that class — the 2026-08-18 queue
 * stall (four repos, 8.7-8.9 h from queue to failure) and vibecheck/ci run
 * 30958168955, which sat 720 h. Every one of them is a fleet incident and every
 * one of them would have gone unannounced. GitHub's own default job timeout is
 * 360 min, so a `timed_out` run was structurally unalertable to the minute.
 *
 * The poller only ever asks for `status=completed`, so `updated_at` is the
 * conclusion time. Falls back to `created_at`, which is never later.
 */
export function runEndedAt(run: CiRun): number {
	const ended = run.updated_at ? Date.parse(run.updated_at) : NaN;
	return Number.isNaN(ended) ? Date.parse(run.created_at) : ended;
}

/**
 * The runs on this page that have concluded since the last one was evaluated,
 * OLDEST CONCLUSION FIRST — the order they actually happened in, which is the
 * order a transition machine has to meet them in.
 *
 * `runs` arrives exactly as GitHub returns it: newest `created_at` first. That
 * ordering is the trap. "The first element" answers "what is the newest run",
 * and this alerter's question is "what has happened since I last looked"; a
 * push that lands on top of a failure makes those two different answers, and
 * from 2026-09-08 to 2026-09-19 the poller only ever asked the first one. See
 * CiState.lastEndedAt for why the watermark is a conclusion time and not an id.
 *
 * Strictly forward: a run at or before the watermark is never handed back. That
 * is a safety property, not an optimisation. Re-feeding an already-evaluated
 * pair re-derives its transition — a failure followed by a green run would
 * announce the SAME recovery on every tick for as long as both stayed on the
 * page, because `lastAlertedRunId` only ever remembers one run.
 */
export function runsEndedSince(runs: CiRun[], prev: CiState | null): CiRun[] {
	if (!runs.length) return [];
	const watermark = prev?.lastEndedAt ? Date.parse(prev.lastEndedAt) : NaN;
	// No watermark ⇒ first sighting, or a row from before this field existed.
	// Evaluate the newest run only, which is precisely the pre-#32 behaviour.
	if (Number.isNaN(watermark)) return [runs[0]];
	return runs
		.filter((r) => runEndedAt(r) > watermark)
		.sort((a, b) => runEndedAt(a) - runEndedAt(b));
}

/**
 * GitHub's annotation on a job killed by `timeout-minutes` (#124).
 *
 * A timeout expiry concludes the RUN as `cancelled` — the same word a
 * `concurrency: cancel-in-progress` supersede gets — so the conclusion alone
 * cannot tell breakage from housekeeping, and reading every `cancelled` as
 * inert left hadoku-promptsmith's main red for 18 h on 2026-10-19 with no page.
 * The job's check-run annotations DO tell them apart, measured on both shapes:
 *
 *   timeout     "The job has exceeded the maximum execution time of 10m0s"
 *   supersede   "Canceling since a higher priority waiting request for
 *               ci-refs/heads/main exists"
 *
 * Matched positively on the timeout text, so an unrecognised cancel stays
 * inert rather than paging.
 */
export const TIMEOUT_ANNOTATION = /exceeded the maximum execution time/i;

/**
 * Whether a `cancelled` run was a timeout: true, false, or `null` when the jobs
 * or an annotation listing could not be read. Only the run's cancelled jobs are
 * asked — a run normally has one, so this is two conditional calls per
 * cancelled run, and the watermark means each run is asked about once.
 */
export async function cancelledByTimeout(
	run: CiRun,
	repo: string,
	token: string,
	ghGet: GhGet
): Promise<boolean | null> {
	const jobs = await ghGet<{ jobs?: { id: number; conclusion: string | null }[] }>(
		`/actions/runs/${run.id}/jobs?per_page=100`,
		token,
		repo
	);
	if (!jobs) return null;
	for (const job of (jobs.jobs ?? []).filter((j) => j.conclusion === 'cancelled')) {
		const notes = await ghGet<{ message?: string }[]>(
			`/check-runs/${job.id}/annotations`,
			token,
			repo
		);
		if (!notes) return null;
		if (notes.some((n) => TIMEOUT_ANNOTATION.test(n.message ?? ''))) return true;
	}
	return false;
}

export type CiAction = 'none' | 'broken' | 'recovered' | 'suppressed' | 'ignored';

export interface CiDecision {
	action: CiAction;
	/** null ⇒ do not touch stored state. Only `ignored` yields null. */
	next: CiState | null;
	/** Why a real transition was not announced. Empty when it was. */
	reason?: string;
	/**
	 * Set when a `broken` action is a re-page of a target that was ALREADY red,
	 * not news of a fresh break. It changes the wording only — deliberately NOT
	 * a separate `CiAction`, so a consumer that has not heard of re-paging still
	 * sees `broken` and still pages. Dropping a page is the expensive direction.
	 */
	repage?: true;
}

/**
 * Pure state machine, so the policy is testable without GitHub, disk or Discord.
 * Ported from monitoring-api ci-check.ts; the guards and their reasons are the
 * incidents recorded on STALE_STATE_MS / STALE_RUN_MS above.
 */
export function decideCiAlert(prev: CiState | null, run: CiRun, now: number): CiDecision {
	const next: CiState = {
		lastConclusion: run.conclusion,
		lastRunId: run.id,
		lastSeen: new Date(now).toISOString(),
		lastAlertedRunId: prev?.lastAlertedRunId,
		lastAlertedAt: prev?.lastAlertedAt,
	};
	/** Stamped only where something is actually said — see CiState.lastAlertedAt. */
	const announce = (action: 'broken' | 'recovered', repage?: true): CiDecision => {
		next.lastAlertedRunId = run.id;
		next.lastAlertedAt = new Date(now).toISOString();
		return repage ? { action, next, repage } : { action, next };
	};

	// A cancelled or skipped run carries no signal about health, so state is left
	// EXACTLY as it was — `null` means "write nothing", not "write this".
	//
	// Returning a state here at all was a bug, and production found it within
	// one tick: on a FIRST sighting there is no prior state to fall back to, so
	// `cancelled` got persisted as the last conclusion. Every later tick then
	// read it back as "not null and not success" — i.e. as a live failure — and
	// the next green run would have announced a RECOVERY from a break that
	// never happened. Two of the 62 targets were already in that state.
	//
	// A `timeout-minutes` expiry is ALSO concluded `cancelled` by GitHub, and is
	// breakage. It never reaches this branch: runCiAlerts asks the annotations
	// first and hands it over as `timed_out` (#124, TIMEOUT_ANNOTATION).
	if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') {
		return { action: 'ignored', next: null, reason: 'cancelled/skipped' };
	}

	const isFailure = run.conclusion !== null && run.conclusion !== 'success';
	const wasFailure =
		prev !== null && prev.lastConclusion !== null && prev.lastConclusion !== 'success';

	// Nothing moved.
	if (prev && prev.lastConclusion === run.conclusion && prev.lastRunId === run.id) {
		return { action: 'none', next };
	}

	const stale = !prev?.lastSeen || now - Date.parse(prev.lastSeen) > STALE_STATE_MS;
	const staleRun = now - runEndedAt(run) > STALE_RUN_MS;
	const alreadyAlerted = prev?.lastAlertedRunId === run.id;

	// RED -> RED on a DIFFERENT run. Not a transition, but not nothing either:
	// it is a new commit that also failed, so the break is still live and the
	// last thing anyone was told about it may be a day old. #20 is this case.
	//
	// Every restraint that guards a first page guards this one too, in the same
	// order — an old run is still history, and a run already announced is still
	// announced — with the re-page window on top. Weakening any of them here
	// would re-open the double-paging the handoff boundary was built to end.
	if (isFailure && wasFailure) {
		if (staleRun)
			return { action: 'suppressed', next, reason: 'run is older than the freshness gate' };
		if (alreadyAlerted)
			return { action: 'suppressed', next, reason: 'already announced for this run' };
		// `repageDue` (job-runner.ts, F12) treats a missing or unparseable stamp
		// as due rather than swallowing the streak forever — the same call
		// job-alerts makes on a missing `last_alert_at`. The freshness gate
		// above still bounds the damage: a cold resync can only reach runs that
		// ended within the last six hours.
		if (!repageDue(prev?.lastAlertedAt, now, REPAGE_INTERVAL_MS)) {
			return { action: 'suppressed', next, reason: 'still red — re-page window has not elapsed' };
		}
		return announce('broken', true);
	}

	if (isFailure === wasFailure) return { action: 'none', next };

	if (isFailure && !staleRun && !alreadyAlerted) return announce('broken');
	// A recovery is only meaningful if the breakage was witnessed in real time;
	// after a blind gap the prior failure is stale history that was likely never
	// announced, so resync silently rather than cry wolf.
	//
	// `alreadyAlerted` does NOT guard this side. A re-run keeps its run id, so a
	// failure that recovers through `gh run rerun --failed` arrives as the SAME
	// id the break was paged on — and that is a real transition, the one the ✅
	// exists for, not a re-evaluation (those stop at the "nothing moved" check
	// above). 2026-10-08: hadoku-cardtable/ci run 37761190995 was paged red at
	// 10:12Z, re-run green at 10:18Z, and the recovery was swallowed as "already
	// announced for this run"; the next fresh green then had nothing to recover
	// from. The ✅ never came.
	if (!isFailure && !stale && !staleRun) return announce('recovered');

	const reason =
		isFailure && alreadyAlerted
			? 'already announced for this run'
			: staleRun
				? 'run is older than the freshness gate'
				: 'state was stale — cold resync';
	return { action: 'suppressed', next, reason };
}
