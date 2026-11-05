/**
 * perf-sample-store — where every node's measured performance lives: network
 * latency, jitter and loss, link health, disk activity, pressure stalls, load,
 * memory and temperature, one row per node every 5 minutes (`perf-sample.ts`).
 *
 * Operator, 2026-11-04: "I want extensive data on the performance of each and
 * every claw", so hosting bars can be set from measurements (wired-ness first,
 * then disk for services that move a lot of data) instead of declared facts.
 * This is the ONE record of those measurements; a reader of performance
 * (`fleet perf`, a future placement bar) reads it here, never re-probes.
 *
 * STORAGE: one JSONL file per UTC day, `perf/perf-<day>.jsonl`, appended with
 * ONE `appendFileSync` per tick (every node's rows joined): a crash can only
 * tear the tail, which the reader counts and skips. One writer, the in-process
 * sampler, so no interleaving to reason about. ~10 nodes x 288 ticks x ~1 KB is
 * ~3 MB a day, which is why this is a day-file append and not
 * capacity-sample-store's whole-file rewrite.
 *
 * COUNTERS ARE STORED RAW (bytes, sectors, I/O ms since boot) with the node's
 * `bootId`; a reader takes deltas between consecutive rows of one boot. A
 * writer that kept its own previous row would lose it on every mgmt-api
 * restart, and a delta across a reboot is meaningless.
 *
 * RETENTION: {@link PERF_RETENTION_DAYS}, by whole day file, pruned on append.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { listDayFilesSince, readDayFiles } from './day-file-list.js';
import { PERF_SCHEMA, type ActivePerfRow, type PerfSampleRow } from './lib/perf-row.js';

export {
	PERF_SCHEMA,
	type ActiveOutcome,
	type ActivePerfRow,
	type PerfSampleRow,
	type PingStats,
} from './lib/perf-row.js';

export const PERF_DIR = 'perf';
export const PERF_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;
/** `perf-<day>.jsonl`; its own source text, so the F3 one-writer guard keys it apart from the other day-file stores. */
const DAY_FILE = /^perf-(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** `perf-active-<day>.jsonl`: the active tests (perf-active.ts), the same directory and retention. */
const ACTIVE_DAY_FILE = /^perf-active-(\d{4}-\d{2}-\d{2})\.jsonl$/;

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function perfDir(root: string): string {
	return join(root, PERF_DIR);
}

/** Drops day files past retention. ENOENT from a racing prune is success. */
export function prunePerfDir(
	dir: string,
	nowMs: number,
	retentionDays = PERF_RETENTION_DAYS
): string[] {
	if (!existsSync(dir)) return [];
	const oldest = utcDay(nowMs - retentionDays * DAY_MS);
	const removed: string[] = [];
	for (const f of readdirSync(dir)) {
		const m = DAY_FILE.exec(f) ?? ACTIVE_DAY_FILE.exec(f);
		if (!m || m[1] >= oldest) continue;
		try {
			unlinkSync(join(dir, f));
			removed.push(f);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
		}
	}
	return removed;
}

/** Appends one tick's rows in one write. THROWS: the sampler turns it into the tick's verdict. */
export function appendPerfRows(dir: string, rows: readonly PerfSampleRow[], nowMs: number): void {
	if (!rows.length) return;
	mkdirSync(dir, { recursive: true });
	prunePerfDir(dir, nowMs);
	const day = utcDay(Date.parse(rows[0].at));
	appendFileSync(
		join(dir, `perf-${day}.jsonl`),
		rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
	);
}

function isRow(v: unknown): v is PerfSampleRow {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		o.v === PERF_SCHEMA &&
		typeof o.at === 'string' &&
		Number.isFinite(Date.parse(o.at)) &&
		typeof o.node === 'string' &&
		typeof o.ok === 'boolean'
	);
}

export interface PerfRead {
	/** Oldest first. */
	rows: PerfSampleRow[];
	badLines: number;
	files: number;
	unreadable: { file: string; why: string }[];
}

/** Every row at or after `sinceMs`, oldest first, optionally one node's. A missing directory is no rows yet. */
export function readPerfRows(
	dir: string,
	opts: { sinceMs?: number; node?: string } = {}
): PerfRead {
	const out: PerfRead = { rows: [], badLines: 0, files: 0, unreadable: [] };
	if (!existsSync(dir)) return out;
	const sinceMs = opts.sinceMs ?? 0;
	const files = listDayFilesSince(dir, DAY_FILE, utcDay(sinceMs));
	const { filesRead, unreadable } = readDayFiles(dir, files, (line) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			out.badLines++;
			return;
		}
		if (!isRow(parsed)) {
			out.badLines++;
			return;
		}
		if (Date.parse(parsed.at) < sinceMs) return;
		if (opts.node !== undefined && parsed.node !== opts.node) return;
		out.rows.push(parsed);
	});
	out.files = filesRead;
	out.unreadable = unreadable;
	out.rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	return out;
}

/** Appends one active test's row. THROWS: the caller turns it into its verdict. */
export function appendActiveRow(dir: string, row: ActivePerfRow, nowMs: number): void {
	mkdirSync(dir, { recursive: true });
	prunePerfDir(dir, nowMs);
	const day = utcDay(Date.parse(row.at));
	appendFileSync(join(dir, `perf-active-${day}.jsonl`), `${JSON.stringify(row)}\n`);
}

function isActiveRow(v: unknown): v is ActivePerfRow {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		o.v === PERF_SCHEMA &&
		typeof o.at === 'string' &&
		Number.isFinite(Date.parse(o.at)) &&
		typeof o.node === 'string' &&
		typeof o.outcome === 'string'
	);
}

/** Every active row at or after `sinceMs`, oldest first. A missing directory is no rows yet. */
export function readActiveRows(
	dir: string,
	opts: { sinceMs?: number; node?: string } = {}
): { rows: ActivePerfRow[]; badLines: number; unreadable: { file: string; why: string }[] } {
	const out = {
		rows: [] as ActivePerfRow[],
		badLines: 0,
		unreadable: [] as { file: string; why: string }[],
	};
	if (!existsSync(dir)) return out;
	const sinceMs = opts.sinceMs ?? 0;
	const files = listDayFilesSince(dir, ACTIVE_DAY_FILE, utcDay(sinceMs));
	out.unreadable = readDayFiles(dir, files, (line) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			out.badLines++;
			return;
		}
		if (!isActiveRow(parsed)) {
			out.badLines++;
			return;
		}
		if (Date.parse(parsed.at) < sinceMs) return;
		if (opts.node !== undefined && parsed.node !== opts.node) return;
		out.rows.push(parsed);
	}).unreadable;
	out.rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	return out;
}
