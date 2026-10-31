/**
 * gh-budget-history-store — where the T5 GitHub-budget hour history lives
 * (refactor plan §7.3: "GitHub spend by caller yesterday: today, 7 days of
 * log grep; needs: T5"; §12 Q4: "P0 writes JSONL behind a one-file store
 * module per stream"). ONE FILE ON PURPOSE, same shape as
 * `job-rollup-store.ts` and `capacity-sample-store.ts`: the writer
 * (`gh-budget.ts`, at the point it already logs `[gh-budget] window ended`)
 * and any future reader see `read`/`append` and never a path, a line format
 * or a parse.
 *
 * ONE ROW PER (TOKEN, RESOURCE, WINDOW) — exactly what the `window ended` log
 * line already says, structured: the window's reset time, the token's own
 * label (never the token), which bucket (`core` or the second one gh-budget.ts
 * itself discovered, 2026-10-25), the limit, the lowest `remaining` and
 * highest `used` observed before the window closed, and charged calls by
 * caller. `gh-budget.ts` calls `append` from `closeWindow`, the ONE place a
 * window's log line is written, so a row here and a log line are always the
 * same event — never a separate sampling cadence that could drift from it.
 *
 * EVERY WRITE REPLACES THE FILE ATOMICALLY (F3, `lib/atomic-json.ts`), for the
 * same reason `job-rollup-store.ts` and `capacity-sample-store.ts` do: a
 * window closes at most a few times an hour per token, so even a full
 * rewrite over {@link GH_BUDGET_HISTORY_RETENTION_DAYS} is cheap, and a crash
 * mid-write can never leave a half-written row behind.
 *
 * RETENTION IS 90 DAYS — the task's own floor ("≥ 90 days"). At ≤2 tokens and
 * at most a handful of windows per hour (`core` plus the rare second bucket),
 * 90 days is at most a few thousand rows, a trivial size; there is no
 * operational reason here to go past the stated floor, so this store does
 * not. Trimmed on every `append`, like the other two stores in this wave.
 *
 * `gh-budget.ts` never lets a failure here reach a caller: see that module's
 * own `closeWindow` for the try/catch. This module itself only throws on an
 * unreadable (not missing) file, matching `capacity-sample-store.ts`.
 *
 * NOT IN `scripts/lib/f-guards/f3-one-writer.json`, on purpose — the same
 * accepted gap documented there for `job-rollup-store.ts` and
 * `capacity-sample-store.ts`: `path` is a parameter from the one caller
 * (`gh-budget.ts`), not a literal this file's own write call can trace.
 */
import { readFileSync } from 'node:fs';

import { writeFileAtomic } from './lib/atomic-json.js';

/** The file's name inside the state dir. Declared once; `gh-budget.ts` resolves the path. */
export const GH_BUDGET_HISTORY_FILE = 'gh-budget-history.jsonl';

/** Kept this long; see the module header for why 90 — the task's own floor. */
export const GH_BUDGET_HISTORY_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;

/** One caller's charged calls and free 304s inside the window, as the log line's `spenderLine` already counts them. */
export interface GhBudgetHistoryCaller {
	caller: string;
	charged: number;
	notModified: number;
}

/**
 * One token's one ended hour window. Mirrors `closeWindow`'s own log line:
 * `used ${w.used}/${w.limit}, lowest remaining ${w.remaining}` plus the
 * spender list, structured instead of prose.
 */
export interface GhBudgetHistoryRow {
	/** ISO — the window's OWN reset time (`w.resetAtMs`), not wall-clock "now". */
	windowEnd: string;
	/** The token's label if one was given (`labelGhToken`), else its fingerprint — never the token itself. */
	token: string;
	resource: string;
	limit: number;
	/** The highest `used` observed before the window closed. */
	usedAtEnd: number;
	/** The lowest `remaining` observed before the window closed. */
	remainingAtEnd: number;
	byCaller: GhBudgetHistoryCaller[];
	/** Processes that carried this window across a restart — `w.restarts`, carried through. */
	restarts: number;
}

export interface GhBudgetHistoryRead {
	/** Oldest first. */
	rows: GhBudgetHistoryRow[];
	/** Lines that did not parse as a row. Not fatal and not silent. */
	unreadableLines: number;
	/** `false` when there is no file at all: nothing has ever been written. */
	exists: boolean;
}

export interface GhBudgetHistoryStore {
	/** Every row held, oldest first. Throws only on an unreadable FILE (not ENOENT). */
	read(): GhBudgetHistoryRead;
	/**
	 * Add these rows and drop every row older than `nowMs - retention`, in one
	 * atomic write. Throws on a failed write, leaving the previous file intact
	 * — `gh-budget.ts`'s `closeWindow` is the one that must not let that throw
	 * escape into budget accounting.
	 */
	append(rows: readonly GhBudgetHistoryRow[], nowMs: number): void;
}

function isGhBudgetHistoryRow(v: unknown): v is GhBudgetHistoryRow {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.windowEnd === 'string' &&
		!Number.isNaN(Date.parse(o.windowEnd)) &&
		typeof o.token === 'string' &&
		typeof o.resource === 'string' &&
		typeof o.limit === 'number' &&
		typeof o.usedAtEnd === 'number' &&
		typeof o.remainingAtEnd === 'number' &&
		Array.isArray(o.byCaller)
	);
}

/** The JSONL store at `path`. */
export function ghBudgetHistoryStore(path: string): GhBudgetHistoryStore {
	const read = (): GhBudgetHistoryRead => {
		let raw: string;
		try {
			raw = readFileSync(path, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
				return { rows: [], unreadableLines: 0, exists: false };
			}
			throw err;
		}
		const rows: GhBudgetHistoryRow[] = [];
		let unreadableLines = 0;
		for (const line of raw.split('\n')) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				unreadableLines++;
				continue;
			}
			if (!isGhBudgetHistoryRow(parsed)) {
				unreadableLines++;
				continue;
			}
			rows.push(parsed);
		}
		rows.sort((a, b) => a.windowEnd.localeCompare(b.windowEnd));
		return { rows, unreadableLines, exists: true };
	};

	return {
		read,
		append(rows, nowMs) {
			const cutoff = new Date(nowMs - GH_BUDGET_HISTORY_RETENTION_DAYS * DAY_MS).toISOString();
			const kept = read()
				.rows.filter((r) => r.windowEnd >= cutoff)
				.concat(rows)
				.sort((a, b) => a.windowEnd.localeCompare(b.windowEnd));
			writeFileAtomic(
				path,
				kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : '')
			);
		},
	};
}
