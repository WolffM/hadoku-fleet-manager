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
 * REPEATS ARE TALLIED, NOT LOGGED (`appendCliCall`). The first call in an
 * hour with a given shape — every field but its time and duration — is a full
 * row. Each further one appends `<epoch ms> <duration ms>` to that shape's
 * tally file under `tally/<hour>/`; an append of one short line under
 * O_APPEND lands whole, so concurrent callers need no lock and the count is
 * the line count. The first write after the hour ends rolls each file into one
 * `cli-tally` row (claimed by an atomic `rename`, so two processes rolling up
 * at once write it once), and `readUsage` folds tallies not rolled yet, so a
 * reader is never short by the current hour.
 *
 * Measured volume, 2026-11-08 (fleet-manager#74): 33.8k rows in 7.6 days,
 * ~1.7 MB a day at ~380 bytes, 68% of it cardtable's per-minute
 * `node-status` + `hosting-demand`. That shape would have reached the cap on
 * the 19th. The same month had ~19 distinct shapes an hour, so tallied it is
 * at most ~38 rows an hour (~0.35 MB a day, ~11 MB a month). The 32 MiB cap is
 * ~3x that: it stops recording on a runaway that INVENTS shapes, not on one
 * caller polling.
 *
 * Pruning runs only when a write OPENS a new month.
 */
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/** At least this many days of records survive age pruning. */
export const RETAIN_DAYS = 180;
/** One month file stops taking appends past this. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** All month files together; the oldest are deleted to get back under it. */
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

const FILE_RE = /^usage-(\d{4})-(\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Tally files live in `tally/<hour>/`, the hour as `YYYY-MM-DDTHH`. */
const TALLY_DIR = 'tally';
const HOUR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
/** A claimed tally whose claimer died before writing it is re-claimed after this. */
export const STALE_CLAIM_MS = 10 * 60_000;

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

const hourOf = (at: Date): string => at.toISOString().slice(0, 13);
const hourStartMs = (hour: string): number => Date.parse(`${hour}:00:00.000Z`);

function errCode(err: unknown): string | undefined {
	return err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined;
}

interface Tally {
	/** The shape's full record, minus `at`/`ms`: the header line of its file. */
	head: Record<string, unknown>;
	count: number;
	firstMs: number;
	lastMs: number;
	msTotal: number;
	msMax: number;
}

function parseHead(line: string): Record<string, unknown> | null {
	try {
		const h: unknown = JSON.parse(line);
		return h && typeof h === 'object' && !Array.isArray(h) ? (h as Record<string, unknown>) : null;
	} catch {
		// A torn header: the shape's full row is already in the month file, so
		// what is lost is this hour's repeat count, and the file is dropped.
		return null;
	}
}

/**
 * One tally file's lines. The header is the line that parses as an object,
 * wherever it landed: the creator writes it with an exclusive create, and a
 * racing caller's append can reach the file between that open and its write.
 */
function parseTally(text: string): Tally | null {
	let head: Record<string, unknown> | null = null;
	const t = { count: 0, firstMs: Infinity, lastMs: 0, msTotal: 0, msMax: 0 };
	for (const line of text.split('\n')) {
		if (!line) continue;
		if (line.startsWith('{')) {
			head = parseHead(line);
			continue;
		}
		const [atMs, ms] = line.split(' ').map(Number);
		if (!Number.isFinite(atMs) || !Number.isFinite(ms)) continue;
		t.count++;
		t.firstMs = Math.min(t.firstMs, atMs);
		t.lastMs = Math.max(t.lastMs, atMs);
		t.msTotal += ms;
		t.msMax = Math.max(t.msMax, ms);
	}
	return head && t.count ? { head, ...t } : null;
}

function tallyRecord(t: Tally): Record<string, unknown> {
	return {
		...t.head,
		kind: 'cli-tally',
		at: new Date(t.lastMs).toISOString(),
		from: new Date(t.firstMs).toISOString(),
		count: t.count,
		msTotal: Math.round(t.msTotal),
		msMax: Math.round(t.msMax),
	};
}

/**
 * Roll every tally of an hour before `currentHour` into its month's file. A
 * file is CLAIMED by renaming it, so of two processes rolling up at once
 * exactly one reads and writes it; the other's rename fails ENOENT and skips.
 */
function rollUp(dir: string, currentHour: string, nowMs: number): void {
	const root = join(dir, TALLY_DIR);
	if (!existsSync(root)) return;
	for (const hour of readdirSync(root)) {
		if (!HOUR_RE.test(hour) || hour >= currentHour) continue;
		const hourDir = join(root, hour);
		for (const f of readdirSync(hourDir)) {
			const from = join(hourDir, f);
			if (!f.endsWith('.tally') && !f.endsWith('.claimed')) continue;
			const claimed = join(hourDir, `${f.split('.')[0]}.${process.pid}.claimed`);
			try {
				// A claimed file is taken over only once its claimer has plainly died
				// between rename and write.
				if (f.endsWith('.claimed') && nowMs - statSync(from).mtimeMs < STALE_CLAIM_MS) continue;
				renameSync(from, claimed);
			} catch (err) {
				if (errCode(err) === 'ENOENT') continue;
				throw err;
			}
			const t = parseTally(readFileSync(claimed, 'utf8'));
			if (t) appendUsage(dir, tallyRecord(t), new Date(hourStartMs(hour)));
			unlinkSync(claimed);
		}
		try {
			rmdirSync(hourDir);
		} catch (err) {
			// A caller that read the clock just before the hour turned can still be
			// creating a file in it; the next roll-up takes that one.
			if (errCode(err) !== 'ENOTEMPTY') throw err;
		}
	}
}

/**
 * Record one CLI call: a full row the first time this shape is seen in the
 * hour, a tally line after that. `record` must carry `at` and `ms`; its other
 * fields are the shape. THROWS like `appendUsage`.
 */
export function appendCliCall(
	dir: string,
	record: { at: string; ms: number } & Record<string, unknown>,
	now: Date = new Date()
): void {
	const hour = hourOf(now);
	rollUp(dir, hour, now.getTime());
	const { at: _, ms, ...head } = record;
	const headLine = JSON.stringify(head);
	const key = createHash('sha256').update(headLine).digest('hex').slice(0, 24);
	const hourDir = join(dir, TALLY_DIR, hour);
	const file = join(hourDir, `${key}.tally`);
	if (!existsSync(file)) {
		mkdirSync(hourDir, { recursive: true });
		try {
			writeFileSync(file, `${headLine}\n`, { flag: 'wx' });
			appendUsage(dir, record, now);
			return;
		} catch (err) {
			// Another caller of the same shape created it first: tally instead.
			if (errCode(err) !== 'EEXIST') throw err;
		}
	}
	appendFileSync(file, `${now.getTime()} ${ms}\n`);
}

/** Tallies not rolled up yet, as `cli-tally` records, so a reader is never an hour short. */
function pendingTallies(dir: string, sinceMs: number): Record<string, unknown>[] {
	const root = join(dir, TALLY_DIR);
	if (!existsSync(root)) return [];
	const out: Record<string, unknown>[] = [];
	for (const hour of readdirSync(root).sort()) {
		if (!HOUR_RE.test(hour) || hourStartMs(hour) + HOUR_MS <= sinceMs) continue;
		const hourDir = join(root, hour);
		for (const f of readdirSync(hourDir)) {
			if (!f.endsWith('.tally') && !f.endsWith('.claimed')) continue;
			let text: string;
			try {
				text = readFileSync(join(hourDir, f), 'utf8');
			} catch (err) {
				// Rolled up between the listing and the read: it is in a month file now.
				if (errCode(err) === 'ENOENT') continue;
				throw err;
			}
			const t = parseTally(text);
			if (t) out.push(tallyRecord(t));
		}
	}
	return out;
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
	records.push(...pendingTallies(dir, sinceMs));
	const oldest = all[0] ? FILE_RE.exec(all[0]) : null;
	return {
		records,
		malformed,
		files: files.map((f) => join(dir, f)),
		oldestMonth: oldest ? `${oldest[1]}-${oldest[2]}` : null,
	};
}
