/**
 * Mints per UTC day, persisted — the dispatcher's history across restarts.
 *
 * `getDispatchSnapshot` holds the last pass and totals since process start,
 * and mgmt-api restarts several times a day (28 in one morning, measured), so
 * neither can answer "how many runners did the fleet mint on Tuesday". This
 * file can. One small JSON object in the state dir, read-modify-written only
 * on a pass that minted or failed, pruned to {@link RETENTION_DAYS}.
 *
 * `since` is when this file started counting. A day before it is UNMEASURED
 * and {@link dispatchForDay} answers `null` for it, never zero — the history
 * starting is not the fleet having minted nothing.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger, stateDir } from '../host.js';
import { RETENTION_DAYS } from '../job-history.js';

export const DISPATCH_DAILY_FILE = 'dispatch-daily.json';

export interface DispatchDay {
	minted: number;
	failed: number;
	mintedViaAffinity: number;
}

interface DispatchDailyDoc {
	/** UTC day this file began counting, `YYYY-MM-DD`. */
	since: string;
	days: Record<string, DispatchDay>;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const path = (): string => join(stateDir(), DISPATCH_DAILY_FILE);

/** The file, or `null` when it does not exist or cannot be parsed — never `{}`. */
export function readDispatchDaily(): DispatchDailyDoc | null {
	let raw: string;
	try {
		raw = readFileSync(path(), 'utf8');
	} catch {
		return null;
	}
	try {
		const doc = JSON.parse(raw) as DispatchDailyDoc;
		return typeof doc?.since === 'string' && doc.days && typeof doc.days === 'object' ? doc : null;
	} catch (err) {
		logger.warn(
			`[dispatch-daily] ${path()} is not valid JSON (${(err as Error).message}); not counted`
		);
		return null;
	}
}

/** Add one pass's counts to its UTC day. A failed write is logged, never thrown. */
export function recordDispatchDay(nowMs: number, pass: DispatchDay): void {
	if (!pass.minted && !pass.failed) return;
	const day = utcDay(nowMs);
	const doc = readDispatchDaily() ?? { since: day, days: {} };
	const cur = doc.days[day] ?? { minted: 0, failed: 0, mintedViaAffinity: 0 };
	doc.days[day] = {
		minted: cur.minted + pass.minted,
		failed: cur.failed + pass.failed,
		mintedViaAffinity: cur.mintedViaAffinity + pass.mintedViaAffinity,
	};
	const oldest = utcDay(nowMs - RETENTION_DAYS * 86_400_000);
	for (const d of Object.keys(doc.days)) if (d < oldest) delete doc.days[d];
	try {
		mkdirSync(stateDir(), { recursive: true });
		const tmp = `${path()}.tmp`;
		writeFileSync(tmp, JSON.stringify(doc));
		renameSync(tmp, path());
	} catch (err) {
		logger.warn(`[dispatch-daily] could not write ${path()}: ${(err as Error).message}`);
	}
}

/**
 * One day's counts: the recorded ones, zeros for a day since counting began
 * with no mint, and `null` for a day before the file existed (or no file).
 */
export function dispatchForDay(doc: DispatchDailyDoc | null, day: string): DispatchDay | null {
	if (!doc || day < doc.since) return null;
	return doc.days[day] ?? { minted: 0, failed: 0, mintedViaAffinity: 0 };
}
