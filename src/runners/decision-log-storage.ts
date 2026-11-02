/**
 * THE DECISION LOG'S STORAGE — day files, appended, pruned by whole day,
 * and read back by window. Split out of `decision-log.ts` (wave shrink-1
 * lane B, 800-line ceiling): this is the one piece that knows the log is a
 * directory of `<day>.jsonl` files on disk; `decision-log.ts` itself only
 * knows there is a sink that takes rows. `decision-log.ts` re-exports every
 * name here under its original path.
 *
 * STORAGE IS THIS FILE'S BUSINESS ALONE, so a move to SQLite touches only
 * it. Today: one JSONL file per UTC day under `<stateDir>/dispatch-decisions/`,
 * appended (one `appendFileSync` per pass, so a crash costs at most a torn
 * last line, which the reader counts and skips). Retention is by whole day
 * file — {@link DECISION_RETENTION_DAYS}, one past job-history's window so
 * every job-history row can still join — with a byte cap,
 * {@link DECISION_LOG_MAX_BYTES}, that drops the oldest days first and WARNS
 * when that cuts inside the retention window.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { logger, stateDir } from '../host.js';
import { RETENTION_DAYS } from '../job-history-store.js';
import { listDayFilesSince, readDayFiles } from '../day-file-list.js';
import type { DecisionRecord } from './decision-log-types.js';

export const DECISION_LOG_DIR = 'dispatch-decisions';
/** One day past job-history's window, so every job it holds still joins here. */
export const DECISION_RETENTION_DAYS = RETENTION_DAYS + 1;
/**
 * The byte cap across every day file. The original estimate (~13 MB/day from
 * a placed-job row size times an assumed job count) missed the dominant cost:
 * `unplaceable`/`held` rows, which carry every candidate's refusal plus the
 * full capacity table and get rewritten on every wording flap (see
 * `refusalCategory`). Measured live, 2026-10-29 00:00-00:35Z, BEFORE that fix:
 * 768 rows / 2.68 MB in 35 min, ~108 MB/day — the 320 MiB cap held ~3 days,
 * not the 15-day window.
 *
 * Replaying a copy of that window plus the preceding day (874 rows / 3.05 MB
 * total) through the new, category-based signature: 661 rows / 2.23 MB, a
 * 24% row / 27% byte cut. Replay script committed as
 * `docs/planning/wave5a-decision-replay.mjs` (private) —
 * `node wave5a-decision-replay.mjs 2026-10-28.jsonl 2026-10-29.jsonl` against
 * local copies of the two files. The same replay, re-run after fixing a
 * send-back regression (the unmatched-reason fallback hashed the RAW
 * sentence, including its own moving digits, instead of a blanked one; two
 * refusal shapes with no category — `slow tier`/`slow kind`'s spill hold,
 * `placement`'s OOM-derived memory floor — would therefore have flapped on
 * their own numbers) produced the SAME counts: neither shape collided with
 * another in this snapshot, so the regression changed correctness, not the
 * measured rate. Coverage check on both files: every refusal reason observed
 * (5,737 of them) now maps to a NAMED category — zero fall to `other:`.
 *
 * Projected from the two measured windows, the fix leaves ~61-79 MB/day; at
 * the higher figure {@link DECISION_RETENTION_DAYS} (15) days needs ~1.1 GB.
 * This cap is ~1.5x that floor; hitting it means the row rate changed again,
 * and the warning says so.
 */
export const DECISION_LOG_MAX_BYTES = 1536 * 1024 * 1024;

const DAY_MS = 86_400_000;
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** `<day>.jsonl` — deliberately its own regex SOURCE text; see `day-file-list.ts`. */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function decisionLogDir(root: string = stateDir()): string {
	return join(root, DECISION_LOG_DIR);
}

let prunedDay: string | null = null;
let bytesAtPrune = 0;
let bytesSincePrune = 0;

/** Test seam: this file's own cross-tick memory about the last prune. */
export function __resetDecisionStorageForTesting(): void {
	prunedDay = null;
	bytesSincePrune = 0;
	bytesAtPrune = 0;
}

export function appendToDayFile(records: readonly DecisionRecord[], nowMs: number): void {
	const dir = decisionLogDir();
	const day = utcDay(nowMs);
	if (prunedDay !== day || bytesAtPrune + bytesSincePrune > DECISION_LOG_MAX_BYTES) {
		const pruned = pruneDecisionLog(dir, nowMs);
		prunedDay = day;
		bytesAtPrune = pruned.bytes;
		bytesSincePrune = 0;
		if (pruned.overCap) {
			throw new Error(
				`today's file alone is over the ${DECISION_LOG_MAX_BYTES}-byte cap; not recording until the next day`
			);
		}
	}
	mkdirSync(dir, { recursive: true });
	const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
	// ONE append per pass: O_APPEND keeps a concurrent reader from seeing a
	// half-written batch interleaved with another, and a crash mid-write costs
	// at most the torn tail the reader counts and skips.
	appendFileSync(join(dir, `${day}.jsonl`), text);
	bytesSincePrune += Buffer.byteLength(text);
}

export interface PruneResult {
	/** Bytes kept. */
	bytes: number;
	removed: string[];
	/** Day files the CAP removed although they were inside the retention window. */
	trimmedInWindow: string[];
	/** Today's file alone exceeds the cap. */
	overCap: boolean;
}

/** Drop day files past retention, then the oldest until under the byte cap. */
export function pruneDecisionLog(
	dir: string,
	nowMs: number,
	maxBytes: number = DECISION_LOG_MAX_BYTES
): PruneResult {
	const res: PruneResult = { bytes: 0, removed: [], trimmedInWindow: [], overCap: false };
	if (!existsSync(dir)) return res;
	const oldest = utcDay(nowMs - DECISION_RETENTION_DAYS * DAY_MS);
	const today = utcDay(nowMs);
	const files = readdirSync(dir)
		.flatMap((f) => {
			const m = DAY_FILE.exec(f);
			return m ? [{ f, day: m[1], bytes: statSync(join(dir, f)).size }] : [];
		})
		.sort((a, b) => a.day.localeCompare(b.day));
	const kept: typeof files = [];
	for (const x of files) {
		if (x.day < oldest) {
			unlinkSync(join(dir, x.f));
			res.removed.push(x.f);
		} else kept.push(x);
	}
	let total = kept.reduce((s, x) => s + x.bytes, 0);
	while (total > maxBytes && kept.length && kept[0].day !== today) {
		const x = kept.shift()!;
		unlinkSync(join(dir, x.f));
		res.removed.push(x.f);
		res.trimmedInWindow.push(x.f);
		total -= x.bytes;
	}
	res.bytes = total;
	res.overCap = total > maxBytes;
	if (res.trimmedInWindow.length) {
		logger.warn(
			`[decision-log] over the ${maxBytes}-byte cap: removed ${res.trimmedInWindow.join(', ')}, ` +
				`inside the ${DECISION_RETENTION_DAYS}-day window — those days no longer join to job-history`
		);
	}
	return res;
}

export interface DecisionRead {
	records: DecisionRecord[];
	/** Day files read. */
	files: number;
	/** Lines that did not parse — a torn tail is one; many is a different fact. */
	badLines: number;
	/** Day files that exist and could not be read, with why. */
	unreadable: { file: string; why: string }[];
}

/**
 * Every row with `sinceMs <= at < untilMs`, oldest first. Reads only the day
 * files that can hold such a row. A missing directory throws: "no log" is a
 * different answer from "no decisions".
 */
export function readDecisions(
	dir: string,
	opts: { sinceMs?: number; untilMs?: number } = {}
): DecisionRead {
	const sinceMs = opts.sinceMs ?? 0;
	const untilMs = opts.untilMs ?? Infinity;
	const firstDay = utcDay(sinceMs);
	const out: DecisionRead = { records: [], files: 0, badLines: 0, unreadable: [] };
	const files = listDayFilesSince(dir, DAY_FILE, firstDay);
	const { filesRead, unreadable } = readDayFiles(dir, files, (line) => {
		let r: DecisionRecord;
		try {
			r = JSON.parse(line) as DecisionRecord;
		} catch {
			out.badLines++;
			return;
		}
		const t = Date.parse(r.at);
		if (!Number.isFinite(t)) {
			out.badLines++;
			return;
		}
		if (t >= sinceMs && t < untilMs) out.records.push(r);
	});
	out.files = filesRead;
	out.unreadable = unreadable;
	out.records.sort((a, b) => a.at.localeCompare(b.at));
	return out;
}

export interface DecisionFilter {
	jobId?: number;
	runId?: number;
	node?: string;
	repo?: string;
}

/** Rows about a job, a run, a repo, or a node (won it, or refused it). */
export function filterDecisions(
	records: readonly DecisionRecord[],
	f: DecisionFilter
): DecisionRecord[] {
	return records.filter(
		(r) =>
			(f.jobId === undefined || r.jobId === f.jobId) &&
			(f.runId === undefined || r.runId === f.runId) &&
			(f.repo === undefined || r.repo === f.repo) &&
			(f.node === undefined || r.winner === f.node || r.refused.some((x) => x.node === f.node))
	);
}
