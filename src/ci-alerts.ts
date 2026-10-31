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
 * COST: ONE LISTING PER REPO, NOT PER WORKFLOW (fleet-manager#37). It used to
 * be one query per watched workflow per tick, and the watch list grew from 67
 * to 122 targets when every workflow had to be classified: 732 calls/hr at the
 * ceiling on a shared 5,000/hr pool that ran dry the same day. The targets live
 * in 34 repos, so the poll now reads each repo's run listing and splits it by
 * workflow — see `pollRepo` for how it pages far enough that a busy repo's
 * runs cannot fall off the window (the reason this was per-workflow before),
 * and `ciAlertsCallCeilingPerHour` for the arithmetic.
 *
 * WHY "THE LATEST RUN" WAS NOT ENOUGH (#32). Until 2026-09-19 the query was
 * `per_page=1`, and the tick reasoned about the single newest run. That reads
 * "is it red NOW", not "did anything break since I last looked", and the two
 * differ every time a push lands on top of a failure — see REPO_PAGE_SIZE and
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
import { TICK_INTERVAL_MS } from './lib/runner-health-shared.js';

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
 * How a repo's run listing is read (fleet-manager#37).
 *
 * WHY NOT ONE PAGE. Until #37 this was one `per_page=10` query per watched
 * WORKFLOW, and #32 measured why 10: one in four failing runs was superseded
 * before the next tick at `per_page=1`. A repo-wide listing re-opens that,
 * worse — on hadoku_site, measured 2026-10-31 over its newest 1,000 completed
 * runs (16 h): up to 48 runs conclude inside one 10-minute tick, and a run that
 * concludes during a tick sits as deep as position 79 in `created_at` order by
 * the next poll (p99 61). One page of 100 covers that day; a quieter heuristic
 * would not, and a burst is precisely when a failure matters.
 *
 * SO IT PAGES TO A FLOOR, which is exact rather than tuned. A run that
 * concludes between two polls was either created after the previous poll, or
 * was already open at it. The listing is read WITHOUT a status filter, so each
 * poll sees the runs still open and records the oldest one's `created_at` as
 * the repo's FLOOR (or the poll time, less `FLOOR_MARGIN_MS` for GitHub's
 * indexing lag, when nothing is open). The next poll pages until it is below
 * that floor: everything that can have concluded since is then on the pages it
 * read.
 *
 * TWO BOUNDS, and what each gives up:
 *
 *   - the floor never reaches back past `MAX_LOOKBACK_MS` (the freshness gate,
 *     six hours). A run stuck open for days — the uncancellable 2026-08-17/19
 *     zombies — would otherwise drag every poll of its repo back to it. A run
 *     created more than six hours before it concludes can fall under the clamp;
 *     the per-workflow poll lost that class too (the 2026-08-18 queue stall,
 *     #32's residual 5.8%), and queue-health is the gate that owns it.
 *   - pages past each repo's first come from one pool of
 *     `EXTRA_PAGES_PER_TICK` for the whole tick, which is what makes the
 *     ceiling a number (`ciAlertsCallCeilingPerHour`). A repo that needs more
 *     than the pool can give is NOT evaluated on a partial window — a watermark
 *     moved past a run it never read would skip that run forever — it counts
 *     every target as unreadable and keeps its floor, so the next tick tries
 *     again from the same place and the tick is logged at WARN.
 */
export const REPO_PAGE_SIZE = 100;
export const EXTRA_PAGES_PER_TICK = 12;
export const FLOOR_MARGIN_MS = 5 * 60 * 1000;
export const MAX_LOOKBACK_MS = STALE_RUN_MS;
const GITHUB_LISTING_CAP = 1000;

/**
 * The most charged GitHub calls the listing side of ci-alerts can make in an
 * hour: one first page per repo per tick, plus the shared pool of extra pages.
 * Sized as if every call were charged — a 304 on an idle repo's first page is
 * free, but a busy repo's listing changes every tick, and the budget rule is
 * never to size a cadence by its typical bill. The per-run `cancelledByTimeout`
 * lookups are on top, as they were before: two per CANCELLED run, each asked
 * once, in both designs.
 */
export function ciAlertsCallCeilingPerHour(repoCount: number, tickMs = TICK_INTERVAL_MS): number {
	return Math.ceil(3_600_000 / tickMs) * (repoCount + EXTRA_PAGES_PER_TICK);
}

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
	/**
	 * Polled fine, but no completed run of the workflow is in the window and
	 * there is no record of one — a workflow that has never run, as far as this
	 * alerter knows.
	 */
	noRuns: number;
	/**
	 * Completed runs of a watched workflow skipped because they came from a fork
	 * (`isForeignRun`). Counted so a public repo's quiet is legible.
	 */
	foreign: number;
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
		foreign: 0,
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
		`nothing-new ${s.nothingNew}, no-runs ${s.noRuns}, fork-runs ${s.foreign}, ` +
		`unreadable ${s.unreadable}, ` +
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

/** Per-repo listing floor — see REPO_PAGE_SIZE. On disk for the same reason as the state. */
const REPO_STATE_FILE = 'ci-alert-repos.json';

export interface CiRepoState {
	/** ISO `created_at` the next poll must page below. */
	floor: string;
}

export function readRepoStates(): Record<string, CiRepoState> {
	const p = join(stateDir(), REPO_STATE_FILE);
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, 'utf8')) as Record<string, CiRepoState>;
	} catch (err) {
		// A lost floor is a cold start for every repo: one page each, and the
		// floor rebuilt at MAX_LOOKBACK_MS where the page was full.
		logger.warn(`[ci-alerts] unreadable repo floors (${String(err)}) — cold-starting each repo`);
		return {};
	}
}

function writeRepoStates(states: Record<string, CiRepoState>): void {
	try {
		writeJsonAtomic(join(stateDir(), REPO_STATE_FILE), states, { space: '\t' });
	} catch (err) {
		logger.warn(`[ci-alerts] could not persist repo floors: ${String(err)}`);
	}
}

export type RepoPoll =
	{ kind: 'unreadable'; why: string } | { kind: 'ok'; runs: CiRun[]; floor: string; pages: number };

/**
 * Read one repo's runs down to its floor — see REPO_PAGE_SIZE for why that
 * bound is exact. `pool.extra` is the tick's shared allowance of pages past the
 * first, decremented here. Pure apart from `ghGet`.
 */
export async function pollRepo(
	repo: string,
	prev: CiRepoState | undefined,
	token: string,
	ghGet: GhGet,
	pool: { extra: number },
	nowMs = Date.now()
): Promise<RepoPoll> {
	const prevFloor = prev ? Date.parse(prev.floor) : NaN;
	const stopBelow = Number.isNaN(prevFloor) ? null : Math.max(prevFloor, nowMs - MAX_LOOKBACK_MS);
	const runs: CiRun[] = [];
	let pages = 0;
	let complete = false;
	for (let page = 1; ; page++) {
		// GitHub lists at most 1,000 runs however it is paged; a window deeper
		// than that is not "complete" because the next page came back empty.
		if ((page - 1) * REPO_PAGE_SIZE >= GITHUB_LISTING_CAP)
			return {
				kind: 'unreadable',
				why: `the window is deeper than GitHub's ${GITHUB_LISTING_CAP}-run listing cap`,
			};
		if (page > 1) {
			if (pool.extra <= 0)
				return {
					kind: 'unreadable',
					why: `needed more than ${pages} page(s) and the tick's ${EXTRA_PAGES_PER_TICK}-page pool is spent`,
				};
			pool.extra--;
		}
		const resp = await ghGet<{ workflow_runs?: CiRun[] }>(
			`/actions/runs?per_page=${REPO_PAGE_SIZE}&page=${page}&exclude_pull_requests=true`,
			token,
			repo
		);
		pages++;
		if (!resp) return { kind: 'unreadable', why: `page ${page} could not be read` };
		const got = resp.workflow_runs ?? [];
		runs.push(...got);
		if (got.length < REPO_PAGE_SIZE) {
			complete = true;
			break;
		}
		// Cold start: one page, and the floor below says how far back it is sure.
		if (stopBelow === null) break;
		const oldest = Math.min(...got.map((r) => Date.parse(r.created_at)));
		if (oldest < stopBelow) {
			complete = true;
			break;
		}
	}
	const open = runs
		.filter((r) => r.status !== 'completed' && !isForeignRun(r, repo))
		.map((r) => Date.parse(r.created_at))
		.filter((t) => !Number.isNaN(t));
	let floor = Math.min(nowMs - FLOOR_MARGIN_MS, ...open);
	// A full first page on a cold start may have open runs below it that it
	// never saw, so the floor it can vouch for is the lookback, not the page.
	if (!complete) floor = Math.min(floor, nowMs - MAX_LOOKBACK_MS);
	floor = Math.max(floor, nowMs - MAX_LOOKBACK_MS);
	return { kind: 'ok', runs, floor: new Date(floor).toISOString(), pages };
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
	const repoStates = readRepoStates();
	let changed = false;
	let reposChanged = false;
	const pool = { extra: EXTRA_PAGES_PER_TICK };

	const byRepo = new Map<string, CiTarget[]>();
	for (const target of targets) {
		const repo = `${targetOwner(target)}/${target.repo}`;
		if (!byRepo.has(repo)) byRepo.set(repo, []);
		byRepo.get(repo)?.push(target);
	}

	for (const [repo, repoTargets] of byRepo) {
		let poll: RepoPoll;
		try {
			poll = await pollRepo(repo, repoStates[repo], token, ghGet, pool);
		} catch (err) {
			summary.errors += repoTargets.length;
			logger.warn(
				`[ci-alerts] ${repo} failed: ${err instanceof Error ? err.message : String(err)}`
			);
			continue;
		}
		// "I could not look" — a timeout, a non-2xx, the GitHub blackout, or a
		// window the page pool could not reach the bottom of. It is NOT an empty
		// run list and must never be read as health: every target of the repo is
		// unreadable, and neither the floor nor any watermark moves.
		if (poll.kind === 'unreadable') {
			summary.unreadable += repoTargets.length;
			logger.warn(`[ci-alerts] ${repo}: could not read its runs — ${poll.why}`);
			continue;
		}
		repoStates[repo] = { floor: poll.floor };
		reposChanged = true;

		for (const target of repoTargets) {
			try {
				changed =
					(await evaluateTarget(target, repo, poll.runs, states, summary, token, ghGet)) || changed;
			} catch (err) {
				summary.errors++;
				logger.warn(
					`[ci-alerts] ${target.label} failed: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}
	}

	if (changed) writeStates(states);
	if (reposChanged) writeRepoStates(repoStates);
	recordCleanPass(summary);
	logCiTickSummary(summary);
	return summary;
}

/** One target against its repo's listing. Returns whether `states` changed. */
async function evaluateTarget(
	target: CiTarget,
	repo: string,
	listing: CiRun[],
	states: Record<string, CiState>,
	summary: CiTickSummary,
	token: string,
	ghGet: GhGet
): Promise<boolean> {
	const path = `.github/workflows/${target.workflow}`;
	const mine = listing.filter((r) => r.path === path && r.status === 'completed');
	const runs = mine.filter((r) => !isForeignRun(r, repo));
	summary.foreign += mine.length - runs.length;

	const key = stateKey(target);
	const fresh = runs.length ? runsEndedSince(runs, states[key] ?? null) : [];
	if (!fresh.length) {
		const row = states[key];
		if (!row) {
			summary.noRuns++;
			return false;
		}
		summary.nothingNew++;
		// We DID look, and the recovery gate reads `lastSeen` to decide whether the
		// last break was witnessed. Not stamping it here would make an idle target
		// look blind after 35 minutes of good health.
		states[key] = { ...row, lastSeen: new Date().toISOString() };
		return true;
	}

	let row = states[key] ?? null;
	let watermark = row?.lastEndedAt ? Date.parse(row.lastEndedAt) : 0;
	for (const fetched of fresh) {
		let run = fetched;
		if (run.conclusion === 'cancelled') {
			const timedOut = await cancelledByTimeout(run, repo, token, ghGet);
			// Could not look: stop HERE, before the watermark passes this run, so
			// the next tick asks again. Reading it as a supersede would be the
			// silence #124 is about; reading it as a timeout would page on a guess.
			if (timedOut === null) {
				summary.unreadable++;
				break;
			}
			// `timed_out` is GitHub's own conclusion word for this, and it is what
			// the page and the stored row then say.
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
			await postDiscord(`✅ **CI recovered** — ${target.label}\nRun: ${run.html_url}`, 'ci-alerts');
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

	// The watermark advances over every run this tick CONSIDERED, including the
	// cancelled ones the machine refuses to store anything for — otherwise an
	// inert run at the top of the page is re-read forever. It rides on the row,
	// so a target whose only run is cancelled still persists nothing at all:
	// that first-sighting case is a regression production found once already.
	if (!row) return false;
	states[key] = { ...row, lastEndedAt: new Date(watermark).toISOString() };
	return true;
}
