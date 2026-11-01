/**
 * Metering the shared GitHub rate-limit POOL against this process's own
 * charged calls — the `meterGhPool(caller, fn)` half of `gh-budget.ts`'s
 * NAMING WHAT IS NOT THIS PROCESS work (fleet-manager#9, 2026-10-27). Split
 * out of `gh-budget.ts` (wave 5r lane C, pure move) to bring that file under
 * the 800-line ceiling; every name here stays re-exported from
 * `gh-budget.ts`, so no importer elsewhere needed to change.
 *
 * The window bookkeeping (`windows`, `lastWindowByToken`, `loadBooks`,
 * `saveBooks`, `openWindow`, `absorbReading`, `windowFor`, `closeSuperseded`,
 * `chargedByThisProcess`) stays OWNED by `gh-budget.ts` — `recordGhResponse`
 * reads and writes the exact same state this file's `bookMetered` does, and
 * duplicating it here would be two copies of one ledger. Each piece that
 * `bookMetered` needs is exported from there instead.
 */
import { githubToken, hostInstalled, logger } from './host.js';
import { ghFetchRaw } from './lib/github-client.js';
import {
	absorbReading,
	chargedCallsSoFar,
	closeSuperseded,
	ghTokenFingerprint,
	lastWindowByToken,
	loadBooks,
	openWindow,
	RESET_TOLERANCE_MS,
	saveBooks,
	windowFor,
} from './gh-budget.js';

/** The shared pool as `GET /rate_limit` reports it. */
export interface GhPoolReading {
	limit: number;
	remaining: number;
	used: number;
	resetAtMs: number;
}

const POOL_READ_TIMEOUT_MS = 10_000;

/**
 * `GET /rate_limit` with the host's token. GitHub does not charge it, and it
 * does not pass through `recordGhResponse`, which would book it as a
 * charged call. It reports the GENERAL bucket (checked 2026-10-27: its reset
 * matched the :02 window, not the runner listings' :27 one), which is the
 * bucket the outside spend lands in. Null when it cannot be read.
 */
export async function readGhPool(): Promise<GhPoolReading | null> {
	const token = githubToken();
	if (!token) return null;
	// Moved onto `ghFetchRaw` (plan §4.1 F2b) — `skipBudgetRecord: true` is
	// load-bearing: GitHub does not charge `/rate_limit`, and a caller that
	// booked it would both fabricate a spender in the `[gh-budget] window
	// ended` line and double-count the very reading `meterGhPool` subtracts it
	// from (see that function's own doc). Same headers, same timeout — a pure
	// relocation of the raw `fetch`, not a change to this endpoint's contract.
	const { resp, error } = await ghFetchRaw('GET', 'https://api.github.com/rate_limit', token, {
		headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
		timeoutMs: POOL_READ_TIMEOUT_MS,
		skipBudgetRecord: true,
	});
	if (!resp) {
		logger.warn(`[gh-budget] could not read GET /rate_limit: ${error}; this run is booked unread`);
		return null;
	}
	if (!resp.ok) {
		logger.warn(`[gh-budget] GET /rate_limit answered ${resp.status}; this run is booked unread`);
		return null;
	}
	try {
		const body = (await resp.json()) as {
			resources?: { core?: { limit?: number; remaining?: number; used?: number; reset?: number } };
		};
		const c = body.resources?.core;
		const nums = [c?.limit, c?.remaining, c?.used, c?.reset];
		if (!c || !nums.every((n) => typeof n === 'number' && Number.isFinite(n))) {
			logger.warn('[gh-budget] GET /rate_limit carried no core reading; this run is booked unread');
			return null;
		}
		return { limit: c.limit!, remaining: c.remaining!, used: c.used!, resetAtMs: c.reset! * 1000 };
	} catch (e) {
		logger.warn(
			`[gh-budget] could not read GET /rate_limit: ${e instanceof Error ? e.message : String(e)}; ` +
				'this run is booked unread'
		);
		return null;
	}
}

/**
 * Run `fn` and book what the shared pool rose by while it ran, net of this
 * process's own charged calls in that time, against `caller` (fleet-manager#9).
 *
 * For a caller whose spend happens OUTSIDE this process: mgmt-api wraps each
 * cron dispatch, because a cron's `fleet` CLI, Python script or worker spends
 * the same user pool and was until now one undifferentiated `not this process`.
 * Anything else running at the same time is charged to the cron too, so a
 * figure is an upper bound for that cron, and two overlapping crons share it.
 *
 * Never changes `fn`'s outcome: its value or its throw passes through, and a
 * reading that cannot be taken books the run as `unread`. In a process with no
 * fleet host installed there are no books, so `fn` simply runs unmetered; and
 * a fault in the metering itself is logged, never thrown, because a throw from
 * the `finally` below would REPLACE the dispatch's own result.
 *
 * A run that straddles a reset books only what it saw of the new window: the
 * `used` it read after, which GitHub counts from that reset.
 */
export async function meterGhPool<T>(
	caller: string,
	fn: () => Promise<T>,
	opts: { read?: () => Promise<GhPoolReading | null>; now?: () => number } = {}
): Promise<T> {
	if (!hostInstalled()) return fn();
	const read = opts.read ?? readGhPool;
	const meterFault = (e: unknown) =>
		logger.warn(
			`[gh-budget] metering ${caller} failed: ${e instanceof Error ? e.message : String(e)}`
		);
	const before = await read().catch((e: unknown) => {
		meterFault(e);
		return null;
	});
	const ownBefore = chargedCallsSoFar();
	try {
		return await fn();
	} finally {
		try {
			const after = await read();
			bookMetered(caller, before, after, chargedCallsSoFar() - ownBefore, (opts.now ?? Date.now)());
		} catch (e) {
			meterFault(e);
		}
	}
}

function bookMetered(
	caller: string,
	before: GhPoolReading | null,
	after: GhPoolReading | null,
	own: number,
	nowMs: number
): void {
	const token = githubToken();
	// Without an after reading there is no window to book into; readGhPool has
	// already said why.
	if (!token || !after) return;
	loadBooks(nowMs);
	const fingerprint = ghTokenFingerprint(token);
	closeSuperseded(fingerprint, 'core', after.resetAtMs, nowMs);
	const w =
		windowFor(fingerprint, 'core', after.resetAtMs) ??
		openWindow(
			fingerprint,
			'core',
			after.limit,
			after.remaining,
			after.used,
			after.resetAtMs,
			nowMs
		);
	absorbReading(w, after.limit, after.remaining, after.used, nowMs, 0);
	const m = w.metered.get(caller) ?? { runs: 0, spent: 0, unread: 0 };
	m.runs++;
	if (!before) m.unread++;
	else {
		const sameWindow = Math.abs(before.resetAtMs - after.resetAtMs) <= RESET_TOLERANCE_MS;
		m.spent += Math.max(0, (sameWindow ? after.used - before.used : after.used) - own);
	}
	w.metered.set(caller, m);
	lastWindowByToken.set(fingerprint, `${w.fingerprint}:${w.resource}:${w.resetAtMs}`);
	saveBooks(nowMs);
}
