/**
 * THE WINDOW LEDGER: the open-window map keyed by (token, resource, reset),
 * its disk persistence, and the primitives both `gh-budget.ts`'s
 * `recordGhResponse` and `gh-budget-pool.ts`'s `bookMetered` use to open,
 * absorb into, and close a window.
 *
 * Split out of `gh-budget.ts` (wave shrink-1 lane C) to bring that file under
 * the 600-line target AND to narrow the surface `gh-budget.ts` had to export
 * just so `gh-budget-pool.ts` could reach in: before this split, `openWindow`,
 * `absorbReading`, `windowFor`, `closeSuperseded`, `chargedCallsSoFar`,
 * `ghTokenFingerprint`, `lastWindowByToken`, `loadBooks`, `saveBooks` and
 * `RESET_TOLERANCE_MS` were all exported from `gh-budget.ts` for no consumer
 * OTHER than the pool. Now both `gh-budget.ts` and `gh-budget-pool.ts` import
 * this module directly, and `gh-budget.ts` re-exports only the handful of
 * names something outside the pool actually uses (`ghTokenFingerprint`,
 * `labelGhToken`, the two test-reset seams, `GH_BUDGET_SAVE_MS`).
 */
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { logger, stateDir } from './host.js';
import { writeJsonAtomic } from './lib/atomic-json.js';
import {
	ghBudgetHistoryStore,
	GH_BUDGET_HISTORY_FILE,
	type GhBudgetHistoryRow,
} from './gh-budget-history-store.js';
import type { GhCaller } from './gh-budget.js';

export interface CallerCount {
	calls: number;
	/** 304s — answered, and free against the primary limit. */
	notModified: number;
}

/** What one metered caller (a cron) moved the pool by, net of this process. */
export interface MeteredSpend {
	runs: number;
	spent: number;
	/** Runs whose before or after reading could not be taken — counted, never guessed. */
	unread: number;
}

/** One {@link TIMELINE_BUCKET_MS} slice: the highest `used` seen in it, and our own charges. */
export interface TimelineBucket {
	used: number;
	own: number;
}

/** The timeline's resolution. Twelve per window. */
export const TIMELINE_BUCKET_MS = 5 * 60_000;
/** A slice of outside spend under this is not worth a word in the `window ended` line. */
const BUSIEST_MIN = 50;

/** Exported for `gh-budget-pool.ts`'s `bookMetered` — see {@link lastWindowByToken}. */
export interface BudgetWindow {
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
	/** Keyed by the name handed to `meterGhPool`, e.g. `cron:ci:audit-gates`. */
	metered: Map<string, MeteredSpend>;
	/** Keyed by bucket start, epoch ms. */
	timeline: Map<number, TimelineBucket>;
	alerted: boolean;
	/** Processes that took this window over from a predecessor. */
	restarts: number;
}

/** Keyed `${fingerprint}:${resource}:${resetAtMs}` — see "more than one window" above. */
const windows = new Map<string, BudgetWindow>();
const tokenLabels = new Map<string, string>();
/**
 * The window each token was last charged in, for a response with no rate-limit
 * headers. Exported for `gh-budget-pool.ts`'s `bookMetered`, which books a
 * `meterGhPool` reading into the same window bookkeeping this file owns —
 * one map, read and written from both files, never duplicated.
 */
export const lastWindowByToken = new Map<string, string>();

/** A window's reset is fixed; this much drift is the same window. */
export const RESET_TOLERANCE_MS = 1000;

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

export function nameOf(fingerprint: string): string {
	const label = tokenLabels.get(fingerprint);
	return label ? `${label} (${fingerprint})` : fingerprint;
}

/** Exported for `gh-budget-pool.ts`'s `bookMetered` — see {@link lastWindowByToken}. */
export function openWindow(
	fingerprint: string,
	resource: string,
	limit: number,
	remaining: number,
	used: number,
	resetAtMs: number,
	nowMs: number
): BudgetWindow {
	const w: BudgetWindow = {
		fingerprint,
		resource,
		limit,
		remaining,
		used,
		resetAtMs,
		observedAtMs: nowMs,
		firstAtMs: nowMs,
		usedAtFirst: used,
		chargedAfterFirst: 0,
		byCaller: new Map(),
		metered: new Map(),
		timeline: new Map(),
		alerted: false,
		restarts: 0,
	};
	windows.set(`${fingerprint}:${resource}:${resetAtMs}`, w);
	lastSaveMs = 0; // an opened window is saved at once
	return w;
}

/**
 * Fold one reading into an open window. `own` is how many of this process's
 * charged calls the reading includes (the call that carried it, or none).
 */
/** Exported for `gh-budget-pool.ts`'s `bookMetered` — see {@link lastWindowByToken}. */
export function absorbReading(
	w: BudgetWindow,
	limit: number,
	remaining: number,
	used: number,
	nowMs: number,
	own: number
): void {
	// Concurrent responses arrive out of order; the budget only falls inside a
	// window, so the lowest remaining is the current one.
	w.limit = limit;
	w.remaining = Math.min(w.remaining, remaining);
	w.used = Math.max(w.used, used);
	w.observedAtMs = nowMs;
	const at = nowMs - (nowMs % TIMELINE_BUCKET_MS);
	const b = w.timeline.get(at) ?? { used: 0, own: 0 };
	b.used = Math.max(b.used, used);
	b.own += own;
	w.timeline.set(at, b);
}

/** Exported for `gh-budget-pool.ts`'s `bookMetered` — see {@link lastWindowByToken}. */
export function windowFor(fingerprint: string, resource: string, resetAtMs: number) {
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

/** Exported for `gh-budget.ts`'s `recordGhResponse`. */
export function lastWindowOf(fingerprint: string): BudgetWindow | undefined {
	const k = lastWindowByToken.get(fingerprint);
	return k ? windows.get(k) : undefined;
}

/**
 * A window has had its last word once its reset has PASSED and a later window
 * has answered. Both, because an earlier reset alone is just the other bucket,
 * still counting; and a passed reset alone may be our clock running ahead of
 * GitHub's, with the next response still from that window.
 */
/** Exported for `gh-budget-pool.ts`'s `bookMetered` — see {@link lastWindowByToken}. */
export function closeSuperseded(
	fingerprint: string,
	resource: string,
	resetAtMs: number,
	nowMs: number
): void {
	for (const [k, w] of windows) {
		if (w.fingerprint !== fingerprint || w.resource !== resource) continue;
		if (w.resetAtMs + RESET_TOLERANCE_MS >= resetAtMs) continue;
		if (nowMs < w.resetAtMs + RESET_TOLERANCE_MS) continue;
		closeWindow(w, nowMs);
		windows.delete(k);
		lastSaveMs = 0;
	}
}

/** A reading from a window that has reset while a later one is already open: a late response. */
export function isLate(
	fingerprint: string,
	resource: string,
	resetAtMs: number,
	nowMs: number
): boolean {
	if (nowMs < resetAtMs + RESET_TOLERANCE_MS) return false;
	for (const w of windows.values()) {
		if (w.fingerprint === fingerprint && w.resource === resource && w.resetAtMs > resetAtMs) {
			return true;
		}
	}
	return false;
}

/** This process's charged calls, ever. `meterGhPool` subtracts its own share with it. */
let chargedByThisProcess = 0;

/** Read access to {@link chargedByThisProcess} for `gh-budget-pool.ts`'s `meterGhPool`. */
export function chargedCallsSoFar(): number {
	return chargedByThisProcess;
}

/** Count one call; true when it was charged. Exported for `recordGhResponse`. */
export function count(
	w: BudgetWindow,
	caller: GhCaller,
	status: number,
	afterFirst: boolean
): boolean {
	const c = w.byCaller.get(caller) ?? { calls: 0, notModified: 0 };
	c.calls++;
	const charged = status !== 304;
	if (charged) chargedByThisProcess++;
	if (status === 304) c.notModified++;
	else if (afterFirst) w.chargedAfterFirst++;
	w.byCaller.set(caller, c);
	return charged;
}

/** Charged calls by caller, most first. A 304 is not a charge. */
export function spenders(
	w: BudgetWindow
): { caller: GhCaller; charged: number; notModified: number }[] {
	return [...w.byCaller.entries()]
		.map(([caller, c]) => ({
			caller,
			charged: c.calls - c.notModified,
			notModified: c.notModified,
		}))
		.sort((a, b) => b.charged - a.charged || a.caller.localeCompare(b.caller));
}

export function otherSinceFirst(w: BudgetWindow): number {
	return Math.max(0, w.used - w.usedAtFirst - w.chargedAfterFirst);
}

/** Metered callers, most spent first. */
export function meteredSpenders(
	w: BudgetWindow
): { caller: string; runs: number; spent: number; unread: number }[] {
	return [...w.metered.entries()]
		.map(([caller, m]) => ({ caller, ...m }))
		.sort((a, b) => b.spent - a.spent || a.caller.localeCompare(b.caller));
}

/**
 * Spend that was not this process's, per timeline slice, in time order. A
 * slice is measured against the highest `used` before it, so a slice with no
 * reading costs nothing and the next one carries the gap.
 */
export function outsideTimeline(w: BudgetWindow): { at: number; outside: number }[] {
	let prev = w.usedAtFirst;
	const out: { at: number; outside: number }[] = [];
	for (const [at, b] of [...w.timeline.entries()].sort((x, y) => x[0] - y[0])) {
		out.push({ at, outside: Math.max(0, b.used - prev - b.own) });
		prev = Math.max(prev, b.used);
	}
	return out;
}

const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

export function spenderLine(w: BudgetWindow, top = 5): string {
	const all = spenders(w);
	const s = all.filter((x) => x.charged > 0);
	const shown = s
		.slice(0, top)
		.map((x) => `${x.caller} ${x.charged}`)
		.join(', ');
	const free = all.reduce((n, x) => n + x.notModified, 0);
	const metered = meteredSpenders(w).filter((m) => m.spent > 0);
	const crons = metered.length
		? `; crons while running (overlapping): ${metered
				.slice(0, top)
				.map((m) => `${m.caller} ${m.spent}${m.runs > 1 ? ` (${m.runs} runs)` : ''}`)
				.join(', ')}${metered.length > top ? ` (+${metered.length - top} more)` : ''}`
		: '';
	const busiest = outsideTimeline(w)
		.filter((b) => b.outside >= BUSIEST_MIN)
		.sort((a, b) => b.outside - a.outside)
		.slice(0, 3)
		.map((b) => `${hhmm(b.at)}Z +${b.outside}`);
	return (
		`${shown || 'none'}${s.length > top ? ` (+${s.length - top} more)` : ''}; ` +
		`${free} free 304s; not this process: ~${otherSinceFirst(w)} ` +
		`(since ${hhmm(w.firstAtMs)}Z)${crons}` +
		(busiest.length ? `; busiest outside, per 5 min: ${busiest.join(', ')}` : '')
	);
}

/**
 * The window's last word, in the log. This line is the forensics the 10-16
 * investigation did not have: one per token per hour, naming every spender.
 *
 * `nowMs` is the caller's own clock (`closeSuperseded`'s/`loadBooks`'s
 * `nowMs` parameter), NEVER a fresh `Date.now()` read here — every other
 * time-sensitive decision in this module threads `nowMs` through for
 * exactly this reason: a fresh read would silently decouple this function's
 * notion of "now" from the one the rest of a test (or a mocked clock) is
 * using, which is also what `recordHistoryRow`'s retention math needs to
 * agree with.
 */
function closeWindow(w: BudgetWindow, nowMs: number): void {
	const restarts = w.restarts
		? `; books carried across ${w.restarts} restart${w.restarts === 1 ? '' : 's'}`
		: '';
	logger.info(
		`[gh-budget] window ended for ${nameOf(w.fingerprint)} ${w.resource} ` +
			`(reset ${new Date(w.resetAtMs).toISOString().slice(11, 16)}Z): ` +
			`used ${w.used}/${w.limit}, lowest remaining ${w.remaining} — ${spenderLine(w, 12)}${restarts}`
	);
	recordHistoryRow(w, nowMs);
}

/**
 * T5 (refactor plan §7.3): one history row, exactly what the log line above
 * just said, structured. Called from the ONE place that line is written, so
 * a row and a log line are always the same event. NEVER throws into
 * `closeWindow` — a failure here must cost this hour's history row, never
 * the budget accounting `closeWindow` is itself part of.
 */
function recordHistoryRow(w: BudgetWindow, nowMs: number): void {
	try {
		const row: GhBudgetHistoryRow = {
			windowEnd: new Date(w.resetAtMs).toISOString(),
			token: nameOf(w.fingerprint),
			resource: w.resource,
			limit: w.limit,
			usedAtEnd: w.used,
			remainingAtEnd: w.remaining,
			byCaller: spenders(w).map((s) => ({
				caller: s.caller,
				charged: s.charged,
				notModified: s.notModified,
			})),
			restarts: w.restarts,
		};
		ghBudgetHistoryStore(join(stateDir(), GH_BUDGET_HISTORY_FILE)).append([row], nowMs);
	} catch (err) {
		logger.warn(
			`[gh-budget] could not record the window-ended history row: ` +
				`${err instanceof Error ? err.message : String(err)} — budget accounting is unaffected`
		);
	}
}

interface SavedWindow extends Omit<BudgetWindow, 'byCaller' | 'metered' | 'timeline'> {
	byCaller: Record<string, CallerCount>;
	/** Absent in books written before the meter existed. */
	metered?: Record<string, MeteredSpend>;
	timeline?: Record<string, TimelineBucket>;
}

const booksPath = (): string => join(stateDir(), GH_BUDGET_FILE);

/**
 * The previous process's books, once. A window it left open that has since
 * reset gets its `window ended` line now, from here — that line is the reason
 * the books are kept at all. Unreadable books start fresh and SAY so; the cost
 * is the per-caller split for the rest of the hour, never a reading.
 */
/** Exported for `gh-budget-pool.ts`'s `bookMetered` — see {@link lastWindowByToken}. */
export function loadBooks(nowMs: number): void {
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
			metered: new Map(Object.entries(saved.metered ?? {})),
			timeline: new Map(
				Object.entries(saved.timeline ?? {}).map(([at, b]) => [Number(at), b] as const)
			),
			alerted: saved.alerted === true,
			restarts: (Number.isFinite(saved.restarts) ? saved.restarts : 0) + 1,
		};
		if (nowMs >= w.resetAtMs + RESET_TOLERANCE_MS) {
			closeWindow(w, nowMs);
			continue;
		}
		const key = `${w.fingerprint}:${w.resource}:${w.resetAtMs}`;
		windows.set(key, w);
		lastWindowByToken.set(w.fingerprint, key);
	}
	lastSaveMs = 0;
}

/**
 * Throttled to one write per GH_BUDGET_SAVE_MS, except that an open or close resets the clock.
 * Exported for `gh-budget-pool.ts`'s `bookMetered` — see {@link lastWindowByToken}.
 */
export function saveBooks(nowMs: number): void {
	if (lastSaveMs && nowMs - lastSaveMs < GH_BUDGET_SAVE_MS) return;
	lastSaveMs = nowMs;
	const path = booksPath();
	const saved: SavedWindow[] = [...windows.values()].map((w) => ({
		...w,
		byCaller: Object.fromEntries(w.byCaller),
		metered: Object.fromEntries(w.metered),
		timeline: Object.fromEntries(w.timeline),
	}));
	try {
		// Write-then-rename (F3, `lib/atomic-json.ts`), fsync SKIPPED — a RECORDED
		// divergence (plan §4.1 step 2): this runs on the hot path of every
		// charged GitHub call (throttled to one disk write per GH_BUDGET_SAVE_MS
		// = 10 s, but that is still hotter than dispatch-tick's 15 s and sits
		// inline with the call that is charging the budget it is persisting).
		// Losing the last few seconds of this file to an unclean restart costs
		// one hour's per-caller split, never a correctness guarantee runner-health
		// depends on, so the extra two fsyncs are not worth paying here.
		writeJsonAtomic(
			path,
			{ labels: Object.fromEntries(tokenLabels), windows: saved },
			{ fsync: false }
		);
	} catch (e) {
		if (saveComplained) return;
		saveComplained = true;
		logger.warn(
			`[gh-budget] could not persist ${path}: ${e instanceof Error ? e.message : String(e)} — ` +
				'a restart will lose this hour’s split by caller'
		);
	}
}

/** Every currently-open window — for `gh-budget.ts`'s snapshot/summary builders. */
export function allBudgetWindows(): BudgetWindow[] {
	return [...windows.values()];
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
	chargedByThisProcess = 0;
}

/** Drop the process's books and keep the file, which is what a deploy does. Test seam. */
export function __restartGhBudgetForTesting(): void {
	windows.clear();
	tokenLabels.clear();
	lastWindowByToken.clear();
	loaded = false;
	lastSaveMs = 0;
}
