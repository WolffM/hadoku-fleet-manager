/**
 * The GitHub budget as GitHub reports it, per token — and who in THIS process
 * spent it (#119).
 *
 * WHY THIS EXISTS
 * ---------------
 * Until 2026-10-16 nothing recorded how much of the hourly budget was left. The
 * blackout throttle (`noteGhRateLimit` in runner-health) learns about the limit
 * only from the 403 that says it is already spent, so the first signal of the
 * 10-16 19:15:42Z blackout was the refusal itself — after dispatch had stopped
 * minting and two jobs had paged. Working out who spent the budget then meant
 * estimating from code cadences, because no line recorded a single call or a
 * single `x-ratelimit-remaining`. That was the fourth blackout in six days, and
 * every one of the four was diagnosed by arithmetic rather than measurement.
 *
 * WHAT IT RECORDS
 * ---------------
 * Every response carries `x-ratelimit-{limit,remaining,used,reset,resource}`,
 * 304s included (measured 2026-10-16: three conditional `/runs/{id}/jobs`
 * requests answered 304 and `used` stayed at 1370 throughout). So the reading is
 * refreshed on the free calls too, which is what lets it watch a budget fall
 * without spending any of it to look.
 *
 * The CALLER comes from `withGhCaller`, an AsyncLocalStorage scope each loop
 * wraps around its own entry point. Nested scopes win, so `dispatch-probe`
 * inside the dispatcher's tick is told apart from the poll beside it. A call
 * made outside every scope is `unattributed` — never silently folded into
 * whichever loop happens to be largest.
 *
 * `used` is the TOKEN's count, not this process's: HADOKU_SITE_TOKEN is shared
 * with the workflows that use it. `otherSinceFirst` is the part of `used` that
 * this process's own charged calls do not account for, which is the only honest
 * way to name a spender this code cannot see.
 *
 * ONE TOKEN, MORE THAN ONE WINDOW (measured 2026-10-25). Every response says
 * `x-ratelimit-resource: core`, but some endpoints are counted in a second
 * bucket with its own `used` and its own reset: at 06:53Z a `/user` call read
 * used 4699, reset 06:59:02, and the next call, a runner listing, read used
 * 1771, reset 07:02:35. Seen in the second bucket so far: `/actions/runners`
 * and `/actions/workflows/{id}/runs` (ci-alerts); in the first, `/user`,
 * `/repos/{repo}` and `/actions/runs?status=queued` (the dispatcher's poll).
 * Which endpoint lands where is GitHub's, not a rule this code relies on —
 * the reset in each response is what tells the windows apart. Until then this module kept ONE window per
 * (token, resource) and treated a later reset as a new window. So every time
 * the two buckets' resets crossed, the window holding the real spend was
 * closed with a fraction of its count, and the general bucket's readings were
 * then filed as "late" and dropped. `GET /fleet` showed the runner bucket at
 * 65% left while the bucket that refuses dispatch was at 6%. A window is now
 * keyed by its reset as well, so each bucket is read and paged on its own.
 *
 * PERSISTED (2026-10-25), because the process is not durable: mgmt-api
 * restarted 12 times in two hours that morning, and each restart lost the
 * per-caller split, so no `window ended` line named the spenders of the hour
 * that ran out. The books are written to `stateDir()` at most every
 * `GH_BUDGET_SAVE_MS` and on every open or close, and restored by the next
 * process, which counts itself in `restarts`. What a restart still loses is
 * the calls made after the last save, which then read as `not this process`.
 *
 * NAMING WHAT IS NOT THIS PROCESS (fleet-manager#9, 2026-10-27). Over 10-25..27
 * `not this process` was most of nearly every general-bucket window: ~450/h
 * overnight, 1,100-1,900/h by day, and the whole of the 10-25 blackout. Two
 * things now narrow it, and neither guesses:
 *
 *   - `meterGhPool(caller, fn)`. mgmt-api wraps each cron dispatch in it. It
 *     reads `GET /rate_limit` (which GitHub does not charge) before and after,
 *     and books the rise minus this process's own charged calls in between.
 *     Crons overlap, and a cron is charged with whatever else ran beside it, so
 *     the figures are upper bounds per cron and do not sum to anything.
 *   - A five-minute timeline of the pool against this process's own spend. When
 *     nothing can say WHO, the `window ended` line still says WHEN, and that is
 *     what an execution log or a workflow-run listing can be read against.
 *     The 10-25 question ("~1,220 at 05:26-05:30 with no audit running") was
 *     answered by hand from `rate=` log lines; this records it.
 *
 * THE WINDOW LEDGER — the window map, its persistence, and the mutation
 * primitives both this file's `recordGhResponse` and `gh-budget-pool.ts`'s
 * `bookMetered` share — lives in `gh-budget-windows.ts` (wave shrink-1 lane
 * C). This file is the front door: caller attribution, turning a GitHub
 * response into a ledger update, the low-budget alert, and the public
 * snapshot/summary readers.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { logger, postDiscord } from './host.js';
import {
	absorbReading,
	closeSuperseded,
	count,
	ghTokenFingerprint,
	isLate,
	lastWindowOf,
	lastWindowByToken,
	loadBooks,
	openWindow,
	outsideTimeline,
	meteredSpenders,
	otherSinceFirst,
	saveBooks,
	spenders,
	spenderLine,
	windowFor,
	allBudgetWindows,
	nameOf,
	type BudgetWindow,
} from './gh-budget-windows.js';

/**
 * Who made a GitHub call. One word per loop, so a page can name the spender
 * (#119).
 *
 * Defined here, not in `fleet-report-types-budget.ts` (wave clean-1 lane C,
 * cut (iii)): `withGhCaller`'s `AsyncLocalStorage` scope below is what sets
 * one of these, so this module is the real owner. `fleet-report-types-budget.ts`
 * imports and re-exports it from here under its original path.
 */
export type GhCaller =
	| 'reap'
	| 'dispatch-poll'
	| 'dispatch-probe'
	| 'mint'
	| 'warm-cache'
	| 'fleet-loop'
	| 'runner-health'
	| 'backstop'
	| 'ci-alerts'
	| 'ci-runner-var'
	| 'ppe-sweep'
	| 'route'
	| 'unattributed';

const callerScope = new AsyncLocalStorage<GhCaller>();

/** Run `fn` with every GitHub call inside it attributed to `caller`. */
export function withGhCaller<T>(caller: GhCaller, fn: () => Promise<T>): Promise<T> {
	return callerScope.run(caller, fn);
}

export function currentGhCaller(): GhCaller {
	return callerScope.getStore() ?? 'unattributed';
}

/**
 * Alert once remaining falls under this fraction of the limit. 20% of 5,000 is
 * 1,000 calls — at the 10-16 burn of ~3,000/hr that is ~20 minutes of runway,
 * enough to act before the first refusal.
 */
export const BUDGET_ALERT_FRACTION = 0.2;

/**
 * …but only while more than this much of the window is left. A budget at 15%
 * with three minutes to the reset will refill before anyone could act on a page,
 * and paging for it would teach the operator to ignore the one that matters.
 */
export const BUDGET_ALERT_MIN_LEFT_MS = 10 * 60_000;

/** Re-exported: both the ledger (saveBooks on an alert) and tests need the name. */

/** A token's identity in a report. Never the token: a prefix of its hash. */

/** The headers a response carries — `Headers` satisfies this, and so does a test double. */
export interface HeaderBag {
	get(name: string): string | null;
}

/**
 * Record one GitHub response. Called by every transport in this package, on
 * EVERY response it receives — ok, 304 or refused — because a refused call is
 * still a reading, and the reading nearest the 403 is the one that matters.
 *
 * A response with no rate-limit headers (a proxy error, a body-less 5xx) is
 * counted against the window already open for its token, if any: the call
 * happened, and dropping it would understate the spender that made it.
 */
export function recordGhResponse(
	token: string,
	status: number,
	// Optional because this is an OBSERVER on every transport's success path: a
	// response without headers must not be able to turn a good call into a
	// failed one. A real `Response` always has them; some test doubles do not.
	headers: HeaderBag | null | undefined,
	nowMs = Date.now()
): void {
	if (!token || !headers) return;
	const fingerprint = ghTokenFingerprint(token);
	const num = (n: string) => {
		const v = headers.get(n);
		return v === null || v === '' ? NaN : Number(v);
	};
	const limit = num('x-ratelimit-limit');
	const remaining = num('x-ratelimit-remaining');
	const used = num('x-ratelimit-used');
	const reset = num('x-ratelimit-reset');
	const resource = headers.get('x-ratelimit-resource') || 'core';
	const caller = currentGhCaller();
	loadBooks(nowMs);

	const readable = [limit, remaining, reset].every(Number.isFinite) && limit > 0;
	let w: BudgetWindow | undefined;
	if (readable) {
		const resetAtMs = reset * 1000;
		closeSuperseded(fingerprint, resource, resetAtMs, nowMs);
		w = windowFor(fingerprint, resource, resetAtMs);
		const usedNow = Number.isFinite(used) ? used : limit - remaining;
		if (w) {
			const charged = count(w, caller, status, true);
			absorbReading(w, limit, remaining, usedNow, nowMs, charged ? 1 : 0);
		} else if (!isLate(fingerprint, resource, resetAtMs, nowMs)) {
			w = openWindow(fingerprint, resource, limit, remaining, usedNow, resetAtMs, nowMs);
			count(w, caller, status, false);
		} else {
			// A response from a window that has already reset, landing late. The
			// call happened, so it is counted where this token was last charged;
			// its reading describes nothing current and is not kept.
			w = lastWindowOf(fingerprint);
			if (!w) return;
			count(w, caller, status, true);
		}
	} else {
		w = lastWindowOf(fingerprint);
		if (!w) return;
		count(w, caller, status, true);
	}
	lastWindowByToken.set(fingerprint, `${w.fingerprint}:${w.resource}:${w.resetAtMs}`);
	maybeAlert(w, nowMs);
	saveBooks(nowMs);
}

function maybeAlert(w: BudgetWindow, nowMs: number): void {
	if (w.alerted) return;
	if (w.remaining >= w.limit * BUDGET_ALERT_FRACTION) return;
	const leftMs = w.resetAtMs - nowMs;
	if (leftMs <= BUDGET_ALERT_MIN_LEFT_MS) return;
	// Set BEFORE the post, so the dozens of responses landing while it is in
	// flight cannot each send one.
	w.alerted = true;
	// Floored: 999/5000 must not read as "20%" in a page that fired for being under it.
	const pct = Math.floor((w.remaining / w.limit) * 100);
	const content =
		`⚠️ GitHub API budget low: ${nameOf(w.fingerprint)} has ${w.remaining}/${w.limit} ` +
		`${w.resource} calls left (${pct}%), resets in ${Math.ceil(leftMs / 60_000)}m. ` +
		`Calls will be refused before then at this rate. Top spenders: ${spenderLine(w)}.`;
	logger.warn(`[gh-budget] ${content}`);
	postDiscord(content, 'gh-budget').catch((err: unknown) =>
		logger.warn(
			`[gh-budget] could not post the low-budget alert: ${err instanceof Error ? err.message : String(err)}`
		)
	);
	// Saved with this response (saveBooks runs right after, in recordGhResponse),
	// so a restart cannot page twice — see `gh-budget-windows.ts`'s own save
	// throttle, which an `alerted` flip must not wait behind.
}

/**
 * One token's hourly GitHub budget, as GitHub last reported it, with who in
 * this process spent it (#119).
 *
 * `used`/`remaining` are the TOKEN's — HADOKU_SITE_TOKEN is shared with the
 * workflows that use it — while `byCaller` is only this process's calls since
 * `countedSince` (a restart resets it). `otherSinceFirst` is the difference:
 * what the token was charged in that time that no caller here accounts for.
 *
 * Defined here, not in `fleet-report-types-budget.ts` (wave clean-1 lane C,
 * cut (iii)): `getGhBudgetSnapshot` below is what builds one, from the
 * window ledger's own state, so this module is the real owner.
 * `fleet-report-types-budget.ts` imports and re-exports it from here under
 * its original path.
 */
export interface FleetGithubBudget {
	/** A label and a hash prefix, never the token. */
	token: string;
	resource: string;
	limit: number;
	remaining: number;
	used: number;
	/** remaining / limit, 0..1. */
	fractionLeft: number;
	resetAt: string;
	observedAt: string;
	/** True once the clock has passed `resetAt` — a past window's reading. */
	expired: boolean;
	countedSince: string;
	/** Charged calls (non-304) and free 304s per caller, most charged first. */
	byCaller: { caller: GhCaller; charged: number; notModified: number }[];
	otherSinceFirst: number;
	/**
	 * What each metered caller (`meterGhPool`; mgmt-api's crons) moved the pool
	 * by while it ran, net of this process, most first. Upper bounds that
	 * overlap: a cron is charged with whatever else ran beside it. Optional only
	 * for readers built against an older report.
	 */
	metered?: { caller: string; runs: number; spent: number; unread: number }[];
	/** Spend that was not this process's, per five minutes, oldest first. */
	outsideTimeline?: { at: string; outside: number }[];
	/** The low-budget alert has fired for this window. */
	alerted: boolean;
	/**
	 * How many processes have carried these books over from a predecessor —
	 * mgmt-api restarts on every deploy, and the books are persisted. Optional
	 * only for readers built against an older report.
	 */
	restarts?: number;
}

export function getGhBudgetSnapshot(nowMs = Date.now()): FleetGithubBudget[] {
	loadBooks(nowMs);
	return allBudgetWindows().map((w) => ({
		token: nameOf(w.fingerprint),
		resource: w.resource,
		limit: w.limit,
		remaining: w.remaining,
		used: w.used,
		fractionLeft: w.limit ? w.remaining / w.limit : 0,
		resetAt: new Date(w.resetAtMs).toISOString(),
		observedAt: new Date(w.observedAtMs).toISOString(),
		expired: nowMs >= w.resetAtMs,
		countedSince: new Date(w.firstAtMs).toISOString(),
		byCaller: spenders(w),
		otherSinceFirst: otherSinceFirst(w),
		metered: meteredSpenders(w),
		outsideTimeline: outsideTimeline(w).map((b) => ({
			at: new Date(b.at).toISOString(),
			outside: b.outside,
		})),
		alerted: w.alerted,
		restarts: w.restarts,
	}));
}

/**
 * The shared-pool metering (`readGhPool`/`meterGhPool`), moved to
 * `gh-budget-pool.ts` (wave 5r lane C, pure move) to bring this file under
 * the 800-line ceiling. Re-exported so every existing importer — `index.ts`
 * among them — compiles unchanged.
 */
export { meterGhPool, type GhPoolReading } from './gh-budget-pool.js';

/** The top spenders across every open window, for a line that has no room for more. */
export function ghBudgetSummary(): string {
	loadBooks(Date.now());
	const open = allBudgetWindows();
	if (!open.length) return 'no GitHub response recorded yet';
	return open
		.map(
			(w) =>
				`${nameOf(w.fingerprint)} ${w.resource} ${w.remaining}/${w.limit} left — ${spenderLine(w)}`
		)
		.join(' | ');
}
