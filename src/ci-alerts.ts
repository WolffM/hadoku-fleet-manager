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
 *
 * THIS FILE, AFTER THE SPLIT (wave 5r lane C, pure move, to reach the
 * 800-line ceiling): `ci-alerts-decide.ts` holds the run/state shapes and the
 * pure decision machine, `ci-alerts-summary.ts` the per-tick tally, and
 * `ci-alerts-state.ts` the three persisted files. This file keeps the watch
 * list, the repo-listing poll and the tick orchestration — and re-exports
 * every name the split moved, so no importer elsewhere needed to change.
 */

import { readFileSync, existsSync } from 'node:fs';

import { manifest, logger, postDiscord } from './host.js';
import { fleetOwner } from './lib/fleet-config.js';
import { TICK_INTERVAL_MS } from './lib/runner-health-shared.js';

import {
	decideCiAlert,
	runEndedAt,
	runsEndedSince,
	isForeignRun,
	cancelledByTimeout,
	STALE_RUN_MS,
	type CiRun,
	type CiState,
	type GhGet,
} from './ci-alerts-decide.js';

import { emptySummary, logCiTickSummary, type CiTickSummary } from './ci-alerts-summary.js';

import {
	readStates,
	writeStates,
	readRepoStates,
	writeRepoStates,
	recordCleanPass,
	type CiRepoState,
} from './ci-alerts-state.js';

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
		// A PAGE THAT WENT OUT IS RECORDED NOW, not at the end of the pass. The
		// pass writes `states` once, after every repo's poll, so a process that
		// exits mid-pass (a restart, SIGKILL, the mgmt-api pair's handover) lost
		// the record of a page it had already sent, and the next process sent it
		// again: "CI broken — hadoku-cardtable / forge" twice, 21 s apart, at the
		// 2026-11-05 18:53Z handover. Written through here, an exit can lose at
		// most a page not yet sent.
		if ((decision.action === 'broken' || decision.action === 'recovered') && row) {
			states[key] = { ...row, lastEndedAt: new Date(watermark).toISOString() };
			writeStates(states);
		}
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
