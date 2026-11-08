/**
 * "The job could not look" is not "the job found a problem", and ONE could-not-look
 * is not an outage (fleet-manager#71). `fleet:ppe-sweep` paged `@here` on
 * 2026-11-08 04:06Z for one GraphQL read that failed; the pass 5 minutes later
 * was green. hadoku_site holds its checker jobs the same way
 * (hadoku_site#449, `services/mgmt-api/src/lib/unavailable-streak.ts`); this
 * is the in-process jobs' copy of that policy:
 *
 *   - the first {@link UNAVAILABLE_THRESHOLD}−1 consecutive `unavailable`
 *     passes report `skipped`, which monitoring-api's job-alerts ignores and
 *     which does not clear a failure streak there;
 *   - the Nth consecutive one reports `failed`, so a read that is persistently
 *     broken still pages. A hold must never become a way for a job to stop
 *     paging;
 *   - any other verdict resets the streak, because the job demonstrably ran.
 *     `broke` resets it too, and is never held: it is the SCRIPT's fault, and
 *     the next pass will not fix it.
 *
 * Persisted under `stateDir()`: mgmt-api restarts several times a day, and a
 * counter that lived only in memory would turn "N in a row" into "never". A
 * store that cannot be read or written falls back to memory and says so,
 * because losing a counter must not fail the job it counts.
 */
import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../host.js';
import { writeJsonAtomic } from './atomic-json.js';

/** Consecutive unavailable passes before a job pages: a 5-minute job pages 5 minutes later than it used to. */
export const UNAVAILABLE_THRESHOLD = 2;

export const STREAK_FILE = 'unavailable-streaks.json';

export type UnavailableHold =
	| { state: 'skipped'; count: number; why: string }
	| { state: 'failed'; count: number; why: string };

/** Memory copy per file, used only when the file cannot be read or written. */
const fallback = new Map<string, Record<string, number>>();

function load(file: string): Record<string, number> {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, number>;
		}
		logger.warn(`[unavailable-streak] ${file} is not an object; starting the streaks again`);
		return {};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback.get(file) ?? {};
		logger.warn(
			`[unavailable-streak] could not read ${file}: ${err instanceof Error ? err.message : String(err)} — counting in memory only`
		);
		return fallback.get(file) ?? {};
	}
}

function save(file: string, streaks: Record<string, number>): void {
	fallback.set(file, streaks);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		writeJsonAtomic(file, streaks, { space: '\t' });
	} catch (err) {
		logger.warn(
			`[unavailable-streak] could not persist ${file}: ${err instanceof Error ? err.message : String(err)} — counting in memory only`
		);
	}
}

export function streakFile(dir: string): string {
	return path.join(dir, STREAK_FILE);
}

/** One more consecutive unavailable pass for `job`: what to report, and why. */
export function holdUnavailable(
	job: string,
	why: string,
	dir: string,
	threshold: number = UNAVAILABLE_THRESHOLD
): UnavailableHold {
	const file = streakFile(dir);
	const streaks = load(file);
	const count = (streaks[job] ?? 0) + 1;
	save(file, { ...streaks, [job]: count });
	if (count >= threshold) {
		return { state: 'failed', count, why: `${why} — could not look ${count} passes in a row` };
	}
	return {
		state: 'skipped',
		count,
		why: `${why} — held (${count}/${threshold} in a row before this pages)`,
	};
}

/** The job ran (or broke): its unavailable streak starts again. */
export function clearUnavailable(job: string, dir: string): void {
	const file = streakFile(dir);
	const streaks = load(file);
	if (streaks[job] === undefined) return;
	const rest = { ...streaks };
	delete rest[job];
	save(file, rest);
}

/** Test seam: forget the in-memory fallback copies. */
export function __resetUnavailableStreaksForTesting(): void {
	fallback.clear();
}
