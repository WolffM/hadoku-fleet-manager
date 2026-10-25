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
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger, postDiscord, stateDir } from './host.js';
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
	/** Processes that took this window over from a predecessor. */
	restarts: number;
}

/** Keyed `${fingerprint}:${resource}:${resetAtMs}` — see "more than one window" above. */
const windows = new Map<string, BudgetWindow>();
const tokenLabels = new Map<string, string>();
/** The window each token was last charged in, for a response with no rate-limit headers. */
const lastWindowByToken = new Map<string, string>();

/** A window's reset is fixed; this much drift is the same window. */
const RESET_TOLERANCE_MS = 1000;

/** Under `stateDir()`. */
export const GH_BUDGET_FILE = 'gh-budget.json';
/** The books are written at most this often between opens and closes. */
export const GH_BUDGET_SAVE_MS = 10_000;
let loaded = false;
let lastSaveMs = 0;
let saveComplained = false;

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
	const caller = currentGhCaller();
	loadBooks(nowMs);

	const readable = [limit, remaining, reset].every(Number.isFinite) && limit > 0;
	let w: BudgetWindow | undefined;
	if (readable) {
		const resetAtMs = reset * 1000;
		closeSuperseded(fingerprint, resource, resetAtMs, nowMs);
		w = windowFor(fingerprint, resource, resetAtMs);
		if (w) {
			count(w, caller, status, true);
			// Concurrent responses arrive out of order; the budget only falls
			// inside a window, so the lowest remaining is the current one.
			w.limit = limit;
			w.remaining = Math.min(w.remaining, remaining);
			if (Number.isFinite(used)) w.used = Math.max(w.used, used);
			w.observedAtMs = nowMs;
		} else if (!isLate(fingerprint, resource, resetAtMs, nowMs)) {
			const usedNow = Number.isFinite(used) ? used : limit - remaining;
			w = {
				fingerprint,
				resource,
				limit,
				remaining,
				used: usedNow,
				resetAtMs,
				observedAtMs: nowMs,
				firstAtMs: nowMs,
				usedAtFirst: usedNow,
				chargedAfterFirst: 0,
				byCaller: new Map(),
				alerted: false,
				restarts: 0,
			};
			windows.set(`${fingerprint}:${resource}:${resetAtMs}`, w);
			count(w, caller, status, false);
			lastSaveMs = 0; // an opened window is saved at once
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

function windowFor(fingerprint: string, resource: string, resetAtMs: number) {
	for (const w of windows.values()) {
		if (
			w.fingerprint === fingerprint &&
			w.resource === resource &&
			Math.abs(w.resetAtMs - resetAtMs) <= RESET_TOLERANCE_MS
		) {
			return w;
		}
	}
	return undefined;
}

function lastWindowOf(fingerprint: string): BudgetWindow | undefined {
	const k = lastWindowByToken.get(fingerprint);
	return k ? windows.get(k) : undefined;
}

/**
 * A window has had its last word once its reset has PASSED and a later window
 * has answered. Both, because an earlier reset alone is just the other bucket,
 * still counting; and a passed reset alone may be our clock running ahead of
 * GitHub's, with the next response still from that window.
 */
function closeSuperseded(
	fingerprint: string,
	resource: string,
	resetAtMs: number,
	nowMs: number
): void {
	for (const [k, w] of windows) {
		if (w.fingerprint !== fingerprint || w.resource !== resource) continue;
		if (w.resetAtMs + RESET_TOLERANCE_MS >= resetAtMs) continue;
		if (nowMs < w.resetAtMs + RESET_TOLERANCE_MS) continue;
		closeWindow(w);
		windows.delete(k);
		lastSaveMs = 0;
	}
}

/** A reading from a window that has reset while a later one is already open: a late response. */
function isLate(fingerprint: string, resource: string, resetAtMs: number, nowMs: number): boolean {
	if (nowMs < resetAtMs + RESET_TOLERANCE_MS) return false;
	for (const w of windows.values()) {
		if (w.fingerprint === fingerprint && w.resource === resource && w.resetAtMs > resetAtMs) {
			return true;
		}
	}
	return false;
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
	const restarts = w.restarts
		? `; books carried across ${w.restarts} restart${w.restarts === 1 ? '' : 's'}`
		: '';
	logger.info(
		`[gh-budget] window ended for ${nameOf(w.fingerprint)} ${w.resource} ` +
			`(reset ${new Date(w.resetAtMs).toISOString().slice(11, 16)}Z): ` +
			`used ${w.used}/${w.limit}, lowest remaining ${w.remaining} — ${spenderLine(w, 12)}${restarts}`
	);
}

interface SavedWindow extends Omit<BudgetWindow, 'byCaller'> {
	byCaller: Record<string, CallerCount>;
}

const booksPath = (): string => join(stateDir(), GH_BUDGET_FILE);

/**
 * The previous process's books, once. A window it left open that has since
 * reset gets its `window ended` line now, from here — that line is the reason
 * the books are kept at all. Unreadable books start fresh and SAY so; the cost
 * is the per-caller split for the rest of the hour, never a reading.
 */
function loadBooks(nowMs: number): void {
	if (loaded) return;
	loaded = true;
	let parsed: { labels?: Record<string, string>; windows?: SavedWindow[] };
	try {
		parsed = JSON.parse(readFileSync(booksPath(), 'utf8')) as typeof parsed;
	} catch (e) {
		if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			logger.warn(
				`[gh-budget] could not restore ${booksPath()}: ${e instanceof Error ? e.message : String(e)} — ` +
					'counting from this process only until the windows reset'
			);
		}
		return;
	}
	for (const [fp, label] of Object.entries(parsed.labels ?? {})) {
		if (!tokenLabels.has(fp)) tokenLabels.set(fp, label);
	}
	for (const saved of parsed.windows ?? []) {
		const nums = [
			saved.limit,
			saved.remaining,
			saved.used,
			saved.resetAtMs,
			saved.observedAtMs,
			saved.firstAtMs,
			saved.usedAtFirst,
			saved.chargedAfterFirst,
		];
		if (!nums.every(Number.isFinite) || typeof saved.fingerprint !== 'string') continue;
		const w: BudgetWindow = {
			...saved,
			byCaller: new Map(Object.entries(saved.byCaller ?? {}) as [GhCaller, CallerCount][]),
			alerted: saved.alerted === true,
			restarts: (Number.isFinite(saved.restarts) ? saved.restarts : 0) + 1,
		};
		if (nowMs >= w.resetAtMs + RESET_TOLERANCE_MS) {
			closeWindow(w);
			continue;
		}
		const key = `${w.fingerprint}:${w.resource}:${w.resetAtMs}`;
		windows.set(key, w);
		lastWindowByToken.set(w.fingerprint, key);
	}
	lastSaveMs = 0;
}

/** Throttled to one write per GH_BUDGET_SAVE_MS, except that an open or close resets the clock. */
function saveBooks(nowMs: number): void {
	if (lastSaveMs && nowMs - lastSaveMs < GH_BUDGET_SAVE_MS) return;
	lastSaveMs = nowMs;
	const path = booksPath();
	const tmp = `${path}.tmp`;
	const saved: SavedWindow[] = [...windows.values()].map((w) => ({
		...w,
		byCaller: Object.fromEntries(w.byCaller),
	}));
	try {
		mkdirSync(stateDir(), { recursive: true });
		writeFileSync(tmp, JSON.stringify({ labels: Object.fromEntries(tokenLabels), windows: saved }));
		renameSync(tmp, path);
	} catch (e) {
		if (saveComplained) return;
		saveComplained = true;
		logger.warn(
			`[gh-budget] could not persist ${path}: ${e instanceof Error ? e.message : String(e)} — ` +
				'a restart will lose this hour’s split by caller'
		);
	}
}

function maybeAlert(w: BudgetWindow, nowMs: number): void {
	if (w.alerted) return;
	if (w.remaining >= w.limit * BUDGET_ALERT_FRACTION) return;
	const leftMs = w.resetAtMs - nowMs;
	if (leftMs <= BUDGET_ALERT_MIN_LEFT_MS) return;
	// Set BEFORE the post, so the dozens of responses landing while it is in
	// flight cannot each send one.
	w.alerted = true;
	lastSaveMs = 0; // saved with this response, so a restart cannot page twice
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
	loadBooks(nowMs);
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
		restarts: w.restarts,
	}));
}

/** The top spenders across every open window, for a line that has no room for more. */
export function ghBudgetSummary(): string {
	loadBooks(Date.now());
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
	lastWindowByToken.clear();
	rmSync(booksPath(), { force: true });
	// Never read a predecessor's books in a test unless it restarts on purpose.
	loaded = true;
	lastSaveMs = 0;
	saveComplained = false;
}

/** Drop the process's books and keep the file, which is what a deploy does. Test seam. */
export function __restartGhBudgetForTesting(): void {
	windows.clear();
	tokenLabels.clear();
	lastWindowByToken.clear();
	loaded = false;
	lastSaveMs = 0;
}
