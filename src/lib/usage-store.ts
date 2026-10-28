/**
 * WHERE THE INVOCATION LOG LIVES — the one file that knows it is JSONL.
 *
 * `usage-log.ts` decides WHAT a record says; this decides how it is kept. A
 * later move to SQLite (`mgmt.db` already sits in the same state dir) replaces
 * this file and nothing else: the two exports below are the whole surface.
 *
 * ONE FILE PER CALENDAR MONTH (UTC), APPEND-ONLY, NEVER REWRITTEN.
 * ---------------------------------------------------------------
 * Every `fleet` process appends; nothing ever compacts a file in place. That is
 * the choice that makes concurrency a non-question: a cron tick runs four
 * subcommands at once, and an append of one short line under O_APPEND lands
 * whole, while a read-modify-write compaction racing an append loses it.
 * Retention is therefore whole-file deletion:
 *
 *   - AGE: a month file is deleted once the LAST day of its month is more than
 *     `RETAIN_DAYS` ago, so at least `RETAIN_DAYS` of history always survives.
 *     180, against a question ("what has nobody run in 120 days?") that needs
 *     120 — the margin is so the answer is not decided by which day of the
 *     month somebody asks.
 *   - SIZE: past `MAX_TOTAL_BYTES` across all months, the OLDEST months go
 *     first, never the current one. A single month past `MAX_FILE_BYTES` stops
 *     taking appends (the caller hears why, once) rather than filling the disk:
 *     a runaway loop calling `fleet` is the one way this file gets big, and the
 *     log of that loop is not worth the box.
 *
 * Measured volume, 2026-10-28: fleet-pulse runs four subcommands every 10
 * minutes and repo-sync ~20 nightly — about 600 records a day at ~400 bytes,
 * so ~7 MB a month and ~45 MB for the retained half-year. The caps sit at
 * roughly 4x that.
 *
 * Pruning runs only when a write OPENS a new month, so the steady-state cost of
 * an append is one `stat` and one `appendFileSync`.
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

/** At least this many days of records survive age pruning. */
export const RETAIN_DAYS = 180;
/** One month file stops taking appends past this. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** All month files together; the oldest are deleted to get back under it. */
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

const FILE_RE = /^usage-(\d{4})-(\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

function monthFile(at: Date): string {
	return `usage-${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
}

/** The first instant AFTER the month a file covers. */
function monthEndMs(name: string): number | null {
	const m = FILE_RE.exec(name);
	if (!m) return null;
	return Date.UTC(Number(m[1]), Number(m[2]), 1);
}

function prune(dir: string, keep: string, nowMs: number): void {
	const files = readdirSync(dir)
		.filter((f) => FILE_RE.test(f))
		.sort();
	const survivors: { name: string; bytes: number }[] = [];
	for (const name of files) {
		const end = monthEndMs(name) ?? nowMs;
		if (name !== keep && nowMs - end > RETAIN_DAYS * DAY_MS) unlinkSync(join(dir, name));
		else survivors.push({ name, bytes: statSync(join(dir, name)).size });
	}
	let total = survivors.reduce((n, f) => n + f.bytes, 0);
	for (const f of survivors) {
		if (total <= MAX_TOTAL_BYTES) break;
		if (f.name === keep) continue;
		unlinkSync(join(dir, f.name));
		total -= f.bytes;
	}
}

/**
 * Append one record. THROWS on any failure — the caller decides how loudly to
 * say so, because only the caller knows whether stderr is safe to write.
 */
export function appendUsage(dir: string, record: object, now: Date = new Date()): void {
	const name = monthFile(now);
	const file = join(dir, name);
	if (!existsSync(file)) {
		mkdirSync(dir, { recursive: true });
		prune(dir, name, now.getTime());
	} else if (statSync(file).size >= MAX_FILE_BYTES) {
		throw new Error(`${file} is past its ${MAX_FILE_BYTES}-byte cap; not appending`);
	}
	appendFileSync(file, `${JSON.stringify(record)}\n`);
}

export interface UsageRead {
	/** Every parseable record whose month overlaps the window, oldest file first. */
	records: Record<string, unknown>[];
	/** Lines that did not parse — a torn write, or a hand edit. Counted, never hidden. */
	malformed: number;
	/** The month files read. Empty means there was nothing to read, not "no usage". */
	files: string[];
	/** The oldest month on disk, `YYYY-MM`, so a window longer than the log can say so. */
	oldestMonth: string | null;
}

/**
 * Read the records from every month that overlaps `[sinceMs, now]`. Filtering
 * by the record's own timestamp is the caller's job; this is storage.
 *
 * A missing directory is NOT an error here — it is `files: []`, which the caller
 * must render as "no log on this host", never as "nobody ran anything".
 */
export function readUsage(dir: string, sinceMs: number): UsageRead {
	if (!existsSync(dir)) return { records: [], malformed: 0, files: [], oldestMonth: null };
	const all = readdirSync(dir)
		.filter((f) => FILE_RE.test(f))
		.sort();
	const files = all.filter((f) => (monthEndMs(f) ?? Infinity) > sinceMs);
	const records: Record<string, unknown>[] = [];
	let malformed = 0;
	for (const f of files) {
		for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
			if (!line.trim()) continue;
			try {
				const r: unknown = JSON.parse(line);
				if (r && typeof r === 'object' && !Array.isArray(r))
					records.push(r as Record<string, unknown>);
				else malformed++;
			} catch {
				malformed++;
			}
		}
	}
	const oldest = all[0] ? FILE_RE.exec(all[0]) : null;
	return {
		records,
		malformed,
		files: files.map((f) => join(dir, f)),
		oldestMonth: oldest ? `${oldest[1]}-${oldest[2]}` : null,
	};
}
