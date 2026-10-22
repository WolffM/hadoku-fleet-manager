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
 * Module state, lost on restart like every other piece of in-process memory in
 * this package. The window it describes is GitHub's, so a restart costs the
 * per-caller split for the rest of the hour, never the reading itself — the
 * next response refills that.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { logger, postDiscord } from './host.js';
import type { FleetGithubBudget, GhCaller } from './fleet-report-types.js';

export type { GhCaller } from './fleet-report-types.js';

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

interface CallerCount {
	calls: number;
	/** 304s — answered, and free against the primary limit. */
	notModified: number;
}

interface BudgetWindow {
	fingerprint: string;
	resource: string;
	limit: number;
	remaining: number;
	used: number;
	resetAtMs: number;
	observedAtMs: number;
	/** When this process first saw this window. */
	firstAtMs: number;
	usedAtFirst: number;
	/** Charged calls AFTER the first observation — the first is inside `usedAtFirst`. */
	chargedAfterFirst: number;
	byCaller: Map<GhCaller, CallerCount>;
	alerted: boolean;
}

const windows = new Map<string, BudgetWindow>();
const tokenLabels = new Map<string, string>();

/** A token's identity in a report. Never the token: a prefix of its hash. */
export function ghTokenFingerprint(token: string): string {
	return `sha256:${createHash('sha256').update(token).digest('hex').slice(0, 8)}`;
}

/** Name a token, so a page says which credential it is about. */
export function labelGhToken(token: string, label: string): void {
	if (token) tokenLabels.set(ghTokenFingerprint(token), label);
}

function nameOf(fingerprint: string): string {
	const label = tokenLabels.get(fingerprint);
	return label ? `${label} (${fingerprint})` : fingerprint;
}

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
	const key = `${fingerprint}:${resource}`;
	const caller = currentGhCaller();

	let w = windows.get(key);
	const readable = [limit, remaining, reset].every(Number.isFinite) && limit > 0;
	if (readable) {
		const resetAtMs = reset * 1000;
		// GitHub's reset is FIXED for a window, so a later one is a new window.
		// An EARLIER one is a response from the old window landing late under
		// concurrency: it is counted, but must not roll the window back.
		if (!w || resetAtMs > w.resetAtMs + 1000) {
			if (w) closeWindow(w);
			w = {
				fingerprint,
				resource,
				limit,
				remaining,
				used: Number.isFinite(used) ? used : limit - remaining,
				resetAtMs,
				observedAtMs: nowMs,
				firstAtMs: nowMs,
				usedAtFirst: Number.isFinite(used) ? used : limit - remaining,
				chargedAfterFirst: 0,
				byCaller: new Map(),
				alerted: false,
			};
			windows.set(key, w);
			count(w, caller, status, false);
		} else {
			count(w, caller, status, true);
			if (resetAtMs >= w.resetAtMs - 1000) {
				// Concurrent responses arrive out of order; the budget only falls
				// inside a window, so the lowest remaining is the current one.
				w.limit = limit;
				w.remaining = Math.min(w.remaining, remaining);
				if (Number.isFinite(used)) w.used = Math.max(w.used, used);
				w.observedAtMs = nowMs;
			}
		}
	} else if (w) {
		count(w, caller, status, true);
	} else {
		return;
	}
	maybeAlert(w, nowMs);
}

function count(w: BudgetWindow, caller: GhCaller, status: number, afterFirst: boolean): void {
	const c = w.byCaller.get(caller) ?? { calls: 0, notModified: 0 };
	c.calls++;
	if (status === 304) c.notModified++;
	else if (afterFirst) w.chargedAfterFirst++;
	w.byCaller.set(caller, c);
}

/** Charged calls by caller, most first. A 304 is not a charge. */
function spenders(w: BudgetWindow): { caller: GhCaller; charged: number; notModified: number }[] {
	return [...w.byCaller.entries()]
		.map(([caller, c]) => ({
			caller,
			charged: c.calls - c.notModified,
			notModified: c.notModified,
		}))
		.sort((a, b) => b.charged - a.charged || a.caller.localeCompare(b.caller));
}

function otherSinceFirst(w: BudgetWindow): number {
	return Math.max(0, w.used - w.usedAtFirst - w.chargedAfterFirst);
}

function spenderLine(w: BudgetWindow, top = 5): string {
	const all = spenders(w);
	const s = all.filter((x) => x.charged > 0);
	const shown = s
		.slice(0, top)
		.map((x) => `${x.caller} ${x.charged}`)
		.join(', ');
	const free = all.reduce((n, x) => n + x.notModified, 0);
	return (
		`${shown || 'none'}${s.length > top ? ` (+${s.length - top} more)` : ''}; ` +
		`${free} free 304s; not this process: ~${otherSinceFirst(w)} ` +
		`(since ${new Date(w.firstAtMs).toISOString().slice(11, 16)}Z)`
	);
}

/**
 * The window's last word, in the log. This line is the forensics the 10-16
 * investigation did not have: one per token per hour, naming every spender.
 */
function closeWindow(w: BudgetWindow): void {
	logger.info(
		`[gh-budget] window ended for ${nameOf(w.fingerprint)} ${w.resource}: ` +
			`used ${w.used}/${w.limit}, lowest remaining ${w.remaining} — ${spenderLine(w, 12)}`
	);
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
}

export function getGhBudgetSnapshot(nowMs = Date.now()): FleetGithubBudget[] {
	return [...windows.values()].map((w) => ({
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
		alerted: w.alerted,
	}));
}

/** The top spenders across every open window, for a line that has no room for more. */
export function ghBudgetSummary(): string {
	const open = [...windows.values()];
	if (!open.length) return 'no GitHub response recorded yet';
	return open
		.map(
			(w) =>
				`${nameOf(w.fingerprint)} ${w.resource} ${w.remaining}/${w.limit} left — ${spenderLine(w)}`
		)
		.join(' | ');
}

/** Test seam. Not part of the supported API. */
export function __resetGhBudgetForTesting(): void {
	windows.clear();
	tokenLabels.clear();
}
