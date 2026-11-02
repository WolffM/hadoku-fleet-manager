/**
 * DAY-FILE LISTING — the one piece `job-run-store.ts` and `decision-log.ts`
 * read the SAME way: every file matching a `*<day>*.jsonl` pattern whose
 * embedded day is at or after a cutoff, sorted so the oldest day comes
 * first (both callers' day strings are `YYYY-MM-DD`, which sorts
 * lexicographically the same as chronologically).
 *
 * THE REGEX ITSELF IS NOT SHARED, and must stay that way. Each caller keeps
 * its own `DAY_FILE` pattern as its own source text — job-run-store.ts's own
 * comment explains why: the F3 one-writer guard (`f3-one-writer.test.mjs`)
 * keys a per-period pattern by its exact regex SOURCE, scanned across every
 * file, so two readers sharing one literal would register as a second
 * writer of the first's pattern rather than as two independent ones. What
 * is identical between the two readers is only the WALK — list the
 * directory, keep what matches and clears the cutoff, sort — which is what
 * this function is.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every file in `dir` whose `dayFile` capture group 1 is `>= sinceDay`,
 * ascending. `dir` must already exist; every caller checks that first and
 * treats a missing directory as its own fact (no rows yet, or a throw).
 */
export function listDayFilesSince(dir: string, dayFile: RegExp, sinceDay: string): string[] {
	return readdirSync(dir)
		.filter((f) => {
			const m = dayFile.exec(f);
			return m !== null && m[1] >= sinceDay;
		})
		.sort();
}

/**
 * Reads each of `files` (already resolved under `dir`, in the order given)
 * and hands every non-blank line to `onLine`. An unreadable file is reported
 * rather than thrown — a torn tail or a permissions blip on one day must not
 * stop the others from being read — and does not count toward `filesRead`.
 * What a line PARSES to is each caller's own business; this only walks.
 */
export function readDayFiles(
	dir: string,
	files: readonly string[],
	onLine: (line: string, file: string) => void
): { filesRead: number; unreadable: { file: string; why: string }[] } {
	let filesRead = 0;
	const unreadable: { file: string; why: string }[] = [];
	for (const f of files) {
		let raw: string;
		try {
			raw = readFileSync(join(dir, f), 'utf8');
		} catch (err) {
			unreadable.push({ file: f, why: err instanceof Error ? err.message : String(err) });
			continue;
		}
		filesRead++;
		for (const line of raw.split('\n')) {
			if (!line.trim()) continue;
			onLine(line, f);
		}
	}
	return { filesRead, unreadable };
}
