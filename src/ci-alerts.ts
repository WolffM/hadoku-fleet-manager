/**
 * CI-red alerting — "did a GitHub Action work" is fleet-manager's question.
 *
 * WHY IT LIVES HERE. This ran in monitoring-api (`ci-check.ts`) until
 * 2026-09-08, next to alerting about crons, scrapes, worker health and
 * heartbeats. Those are different questions with a different owner: this repo
 * already holds the fleet roster, the runner placement, `vars.CI_RUNNER`, the
 * repo policy, and — decisively — the `fleet ci-watch` generator that COMPUTES
 * the watch list this alerter acts on. The list was derived here and shipped
 * there to be acted on, which is the ownership line inverted.
 *
 * WHAT STAYED BEHIND. monitoring-api keeps every alert that is NOT a GitHub
 * Actions outcome: Temporal crons, systemd one-shots, scrape execution
 * failures, worker health, heartbeats. Its `job-alerts.ts` keeps its whole
 * policy engine (streak thresholds, the 24h reminder, recovery) for those; it
 * simply stops matching the `gha_*` rows that mean "a GitHub Action".
 *
 * CADENCE, AND THE TRADE THAT WAS ACCEPTED. This rides runner-health's 10-min
 * tick rather than ci-check's 5-min one, so worst-case detection of a red
 * workflow doubles from 5 to 10 minutes. That was the operator's call, taken
 * deliberately over the alternative (monitoring-api forwarding each pushed
 * `report-job` outcome to a host endpoint, which keeps paging instant at the
 * cost of a new cross-service call). Ten minutes is still a different world
 * from the daily digest that used to be the only notice.
 *
 * COST IS LOWER THAN WHAT IT REPLACES. One query per watched workflow per tick:
 * 67 calls / 10 min, against ci-check's 62 / 5 min. Halved. It deliberately does
 * NOT derive state from the 30-run repo listing runner-health already pays for,
 * tempting as that is — that listing is the newest 30 runs REPO-WIDE, so on a
 * busy repo (hadoku_site has 27 workflows) a watched workflow's failure can be
 * pushed out of the window by newer runs before the next tick and never be seen
 * at all. Per-workflow queries are what make "every run of every watched
 * workflow" true rather than likely.
 *
 * WHY "THE LATEST RUN" WAS NOT ENOUGH (#32). Until 2026-09-19 the query was
 * `per_page=1`, and the tick reasoned about the single newest run. That reads
 * "is it red NOW", not "did anything break since I last looked", and the two
 * differ every time a push lands on top of a failure — see RUN_PAGE_SIZE and
 * `runsEndedSince`, and `docs/planning/ci-alerts-silence-2026-09-19.md` for the
 * incident.
 *
 * The state machine and its two staleness guards are ported from ci-check
 * intact, because both were written against real incidents — see STALE_*.
 *
 * WHAT WAS ADDED AFTER. The ported machine treated red -> red as "no
 * transition", so a target that had paged once could not page again until it
 * went green — #20, where a new commit's failure was swallowed for 23 hours.
 * `REPAGE_INTERVAL_MS` re-opens that case at one page per day; it sits BEHIND
 * both staleness guards, because the case it must not become is the
 * double-paging the handoff boundary was built to end.
 */

import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

import { manifest, stateDir, logger, postDiscord } from './host.js';
import { writeJsonAtomic } from './lib/atomic-json.js';
import { fleetOwner } from './lib/fleet-config.js';
import { DAY_MS as REPAGE_INTERVAL_MS, repageDue } from './lib/job-runner.js';

/** One watched workflow. Shape matches `fleet ci-watch --write` output. */
export interface CiTarget {
	/**
	 * Optional, defaulting to the fleet owner — see `targetOwner`.
	 *
	 * `fleet ci-watch --write` fills it from the roster entry's `owner/repo`, so
	 * in practice it is always there. It is optional because the DEFAULT is the
	 * honest one: a generated list that lost the field, or a hand-written target
	 * for this fleet's own repos, means this fleet's owner and nobody else's.
	 */
	owner?: string;
	repo: string;
	workflow: string;
	label: string;
}

export type CiConclusion = string | null;

export interface CiRun {
	id: number;
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

/** Injected so this module never imports runner-health (which would cycle). */
export type GhGet = <T>(path: string, token: string, repo?: string) => Promise<T | null>;

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
export { REPAGE_INTERVAL_MS };

/**
 * How many completed runs one poll asks for (#32).
 *
 * A page size is not an API call: `per_page` does not move the hourly budget, so
 * this is the one dimension of this poller that can be widened for free. The
 * spend stays 67 calls per 10-minute tick. What it does cost is body bytes —
 * measured 2026-09-19 on hadoku_site/test.yml, 12.0 KB at `per_page=1` and
 * 125.8 KB at 10, so ~8.4 MB per tick across the watch list. That is the whole
 * price.
 *
 * WHY 10, from the 90-day history of the real watch list (67 workflows, 4,702
 * completed runs, 248 of them failing; every run replayed through this poller at
 * six tick phases, so 1,164 target-observations). The measurement is "a failing
 * run the poller NEVER evaluates" — not "alerted late", never seen:
 *
 *     page size   1     2     3     5    10    20    30
 *     missed    28.7% 11.9%  7.7%  6.6%  5.8%  5.8%  5.2%
 *
 * One is a cliff, not a choice: better than one in four failing runs on this
 * fleet is superseded by a newer run before the next tick. The curve is flat
 * from 5 on, and 10 is the round number past the knee.
 *
 * It does NOT cover the deepest burst on record — hadoku_site/redeploy-service
 * once concluded 11 runs inside one 10-minute tick, one past this page — and
 * that is measured, not overlooked: 20 recovers nothing at all and 30 recovers
 * ONE run in 90 days, for three times the bytes. What falls off a burst that
 * deep is its oldest run, and the first failure in it has already paged.
 *
 * The 5.8% that remains is NOT a page-size problem and a bigger number does not
 * touch it — see `docs/planning/ci-alerts-silence-2026-09-19.md`. It is runs
 * that conclude so long after they were queued that they are off the page in
 * `created_at` order by the time they finish (the 2026-08-18 queue stall: four
 * repos, 8.7-8.9 h from queue to failure).
 */
export const RUN_PAGE_SIZE = 10;

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

const STATE_FILE = 'ci-alert-state.json';

/**
 * Targets come from the artifact `fleet ci-watch --write` generates, read at
 * run time rather than baked: this process is long-lived and a roster change
 * must not need a republish to be watched.
 */
export function loadTargets(): CiTarget[] {
	const path = manifest('ci-watch.generated.json');
	if (!existsSync(path)) {
		// NOT "nothing to watch". An absent list is a question we could not ask,
		// and reading it as a healthy fleet is the exact failure this alerter
		// exists to prevent — so it is loud and it watches nothing, rather than
		// quiet and watching nothing.
		logger.warn(`[ci-alerts] no ci-watch.generated.json at ${path} — watching NOTHING this tick`);
		return [];
	}
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as { targets?: CiTarget[] };
		return Array.isArray(parsed.targets) ? parsed.targets : [];
	} catch (err) {
		logger.warn(`[ci-alerts] unreadable ci-watch.generated.json: ${String(err)}`);
		return [];
	}
}

/**
 * The GitHub account a target belongs to.
 *
 * A target with no `owner` used to interpolate to the literal string
 * `undefined`: `undefined/hadoku_site/ci.yml` as a state key, and
 * `undefined/hadoku_site` as the repo every API call for it was made against.
 * Both are wrong SILENTLY — the API call 404s, `ghGet` returns null, and the
 * tick reads that as "could not look" and moves on forever.
 *
 * Resolved from `fleet-config`, so a fleet under a different owner needs no
 * change here.
 */
export function targetOwner(t: CiTarget): string {
	return t.owner?.trim() || fleetOwner();
}

export function stateKey(t: CiTarget): string {
	return `${targetOwner(t)}/${t.repo}/${t.workflow}`;
}

function statePath(): string {
	return join(stateDir(), STATE_FILE);
}

/**
 * Persisted to disk, not memory. mgmt-api redeploys on every push to its own
 * tree and so restarts many times a day; in-memory state would make every
 * restart look like a fresh transition and re-announce breakage that was
 * already announced. Same lesson job-history.ts learned the hard way.
 */
export function readStates(): Record<string, CiState> {
	const p = statePath();
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, 'utf8')) as Record<string, CiState>;
	} catch (err) {
		logger.warn(`[ci-alerts] unreadable state (${String(err)}) — resyncing from scratch`);
		return {};
	}
}

export function writeStates(states: Record<string, CiState>): void {
	try {
		// Write-then-rename, fsync'd (F3, `lib/atomic-json.ts`): a crash mid-write
		// must not leave truncated JSON that the next tick reads as "no state"
		// and re-announces every live break from.
		writeJsonAtomic(statePath(), states, { space: '\t' });
	} catch (err) {
		logger.warn(`[ci-alerts] could not persist state: ${String(err)}`);
	}
}

/**
 * When the last CLEAN pass finished — every target read, nothing errored. On
 * disk because the question is asked by the NEXT process (2026-10-25).
 *
 * Each mgmt-api boot ran a full pass at once: 75 targets, 75-104 charged calls
 * in the window holding the boot, and the restart-storm morning of 2026-10-25
 * had 12 boots in two hours, each a few minutes after the last process's own
 * pass. A boot within `CI_ALERTS_BOOT_SKIP_MS` of a clean pass now leaves the
 * work to its first interval tick, so the gap between passes is under two
 * intervals (20 minutes) however often the process restarts: a boot past the
 * window runs one, and a process that lives ten minutes runs one on its tick.
 *
 * Only a CLEAN pass counts. A pass that could not read a target is not
 * evidence that nothing broke, and a boot after one runs its own.
 */
export const CI_ALERTS_PASS_FILE = 'ci-alerts-last-pass.json';
export const CI_ALERTS_BOOT_SKIP_MS = 10 * 60_000;

function passPath(): string {
	return join(stateDir(), CI_ALERTS_PASS_FILE);
}

/** The last clean pass's end, or null when there is none on record or it cannot be read. */
export function lastCleanCiAlertsPassMs(): number | null {
	let raw: string;
	try {
		raw = readFileSync(passPath(), 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			logger.warn(`[ci-alerts] could not read ${passPath()}: ${String(err)} — the boot pass runs`);
		}
		return null;
	}
	try {
		const at = Date.parse((JSON.parse(raw) as { completedAt?: string }).completedAt ?? '');
		return Number.isNaN(at) ? null : at;
	} catch (err) {
		logger.warn(`[ci-alerts] ${passPath()} is not parseable (${String(err)}) — the boot pass runs`);
		return null;
	}
}

/** Should a fresh process run its own pass now? */
export function ciAlertsBootPassDue(nowMs = Date.now()): boolean {
	const last = lastCleanCiAlertsPassMs();
	return last === null || nowMs - last >= CI_ALERTS_BOOT_SKIP_MS || last > nowMs;
}

function recordCleanPass(s: CiTickSummary): void {
	if (!s.targets || s.unreadable || s.errors) return;
	try {
		writeJsonAtomic(passPath(), { completedAt: new Date().toISOString(), targets: s.targets });
	} catch (err) {
		logger.warn(
			`[ci-alerts] could not record the pass: ${String(err)} — the next boot runs its own`
		);
	}
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

/**
 * What one tick did, counted rather than inferred.
 *
 * The tally exists because #32 was invisible: a target that is polled and says
 * nothing and a target that is never polled at all produced byte-identical
 * output — none. Every way of looking away has its own counter here, and the
 * summary prints all of them, so "quiet" can be told apart from "blind" from
 * the log alone.
 */
export interface CiTickSummary {
	/** Watch-list size. Zero is a FINDING, not a quiet fleet. */
	targets: number;
	/** ghGet returned null: a timeout, a non-2xx, or the rate-limit blackout. */
	unreadable: number;
	/** Polled fine, but the workflow has no completed run at all. */
	noRuns: number;
	/** Polled fine, and nothing has concluded since the last tick. */
	nothingNew: number;
	/** Runs actually put through the state machine. */
	evaluated: number;
	broken: number;
	recovered: number;
	/** A real transition that a guard held back. Counted by reason below. */
	suppressed: number;
	/** cancelled / skipped — no signal either way. */
	ignored: number;
	/** The target threw. */
	errors: number;
	/** `CiDecision.reason` -> how many times, so a silence is diagnosable. */
	reasons: Record<string, number>;
}

function emptySummary(targets: number): CiTickSummary {
	return {
		targets,
		unreadable: 0,
		noRuns: 0,
		nothingNew: 0,
		evaluated: 0,
		broken: 0,
		recovered: 0,
		suppressed: 0,
		ignored: 0,
		errors: 0,
		reasons: {},
	};
}

/**
 * The one line per tick that makes silence legible.
 *
 * It prints the zeroes. A summary that omitted `unreadable 0` would make a tick
 * that could not look indistinguishable from one that looked and found nothing
 * — which is the whole bug, restated one level up.
 */
export function formatCiTickSummary(s: CiTickSummary): string {
	const reasons = Object.entries(s.reasons)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([reason, n]) => `${reason} x${n}`)
		.join('; ');
	return (
		`[ci-alerts] polled ${s.targets} targets, evaluated ${s.evaluated} runs, ` +
		`announced ${s.broken + s.recovered} (broken ${s.broken}, recovered ${s.recovered}), ` +
		`suppressed ${s.suppressed}${reasons ? ` (${reasons})` : ''}, ignored ${s.ignored}, ` +
		`nothing-new ${s.nothingNew}, no-runs ${s.noRuns}, unreadable ${s.unreadable}, ` +
		`errors ${s.errors}`
	);
}

/** A tick that could not look anywhere is a finding, and says so at WARN. */
function logCiTickSummary(s: CiTickSummary): void {
	const blind = s.targets === 0 || s.unreadable > 0 || s.errors > 0;
	const line = formatCiTickSummary(s);
	if (blind) logger.warn(line);
	else logger.info(line);
}

/**
 * One tick. Never throws: alerting is a side channel and must not be able to
 * take runner-health's tick down with it.
 *
 * Returns the tally it logged. runner-health ignores it; the tests do not, and
 * a counter nothing can read is a counter nothing can prove.
 */
export async function runCiAlerts(token: string, ghGet: GhGet): Promise<CiTickSummary> {
	const targets = loadTargets();
	const summary = emptySummary(targets.length);
	// An empty watch list used to return in silence. Watching nothing is not the
	// same as nothing being wrong, and this is the tick that has to say so.
	if (!targets.length) {
		logCiTickSummary(summary);
		return summary;
	}

	const states = readStates();
	let changed = false;

	for (const target of targets) {
		try {
			const resp = await ghGet<{ workflow_runs?: CiRun[] }>(
				`/actions/workflows/${target.workflow}/runs?per_page=${RUN_PAGE_SIZE}&status=completed`,
				token,
				`${targetOwner(target)}/${target.repo}`
			);
			// `null` is ghGet's "I could not look" — a timeout, a non-2xx, or the
			// GitHub blackout. It is NOT an empty run list, and must never be read
			// as health: leave the state untouched and try again next tick.
			if (!resp) {
				summary.unreadable++;
				continue;
			}
			const runs = resp.workflow_runs ?? [];
			if (!runs.length) {
				summary.noRuns++;
				continue;
			}

			const key = stateKey(target);
			const fresh = runsEndedSince(runs, states[key] ?? null);
			if (!fresh.length) {
				summary.nothingNew++;
				// We DID look, and the recovery gate reads `lastSeen` to decide
				// whether the last break was witnessed. Not stamping it here would
				// make an idle target look blind after 35 minutes of good health.
				const row = states[key];
				if (row) {
					states[key] = { ...row, lastSeen: new Date().toISOString() };
					changed = true;
				}
				continue;
			}

			let row = states[key] ?? null;
			let watermark = row?.lastEndedAt ? Date.parse(row.lastEndedAt) : 0;
			for (const fetched of fresh) {
				let run = fetched;
				if (run.conclusion === 'cancelled') {
					const timedOut = await cancelledByTimeout(
						run,
						`${targetOwner(target)}/${target.repo}`,
						token,
						ghGet
					);
					// Could not look: stop HERE, before the watermark passes this run,
					// so the next tick asks again. Reading it as a supersede would be
					// the silence #124 is about; reading it as a timeout would page
					// on a guess.
					if (timedOut === null) {
						summary.unreadable++;
						break;
					}
					// `timed_out` is GitHub's own conclusion word for this, and it is
					// what the page and the stored row then say.
					if (timedOut) run = { ...run, conclusion: 'timed_out' };
				}
				summary.evaluated++;
				const decision = decideCiAlert(row, run, Date.now());
				if (decision.action === 'broken') {
					summary.broken++;
					// A re-page says so. "CI broken" arriving for the fourth day running
					// reads as four separate breaks, and the operator's next question is
					// always "is this new?" — answer it in the message.
					const headline = decision.repage
						? `🚨 **CI still broken** — ${target.label}\nA new run failed too; still red since the last alert.`
						: `🚨 **CI broken** — ${target.label}`;
					await postDiscord(
						`${headline}\nConclusion: \`${run.conclusion}\`\nRun: ${run.html_url}`,
						'ci-alerts'
					);
				} else if (decision.action === 'recovered') {
					summary.recovered++;
					await postDiscord(
						`✅ **CI recovered** — ${target.label}\nRun: ${run.html_url}`,
						'ci-alerts'
					);
				} else if (decision.action === 'suppressed') {
					summary.suppressed++;
					const reason = decision.reason ?? 'unstated';
					summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
					logger.info(`[ci-alerts] ${target.label}: transition not announced — ${reason}`);
				} else if (decision.action === 'ignored') {
					summary.ignored++;
				}

				// `null` is "leave the row alone" — see the cancelled/skipped branch.
				if (decision.next) row = decision.next;
				const ended = runEndedAt(run);
				if (!Number.isNaN(ended) && ended > watermark) watermark = ended;
			}

			// The watermark advances over every run this tick CONSIDERED, including
			// the cancelled ones the machine refuses to store anything for —
			// otherwise an inert run at the top of the page is re-read forever. It
			// rides on the row, so a target whose only run is cancelled still
			// persists nothing at all: that first-sighting case is a regression
			// production found once already.
			if (row) {
				states[key] = { ...row, lastEndedAt: new Date(watermark).toISOString() };
				changed = true;
			}
		} catch (err) {
			summary.errors++;
			logger.warn(
				`[ci-alerts] ${target.label} failed: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	if (changed) writeStates(states);
	recordCleanPass(summary);
	logCiTickSummary(summary);
	return summary;
}
