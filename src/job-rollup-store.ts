/**
 * job-rollup-store — where the daily job rollups live. ONE FILE ON PURPOSE.
 *
 * Storage for fleet telemetry is still an open question (refactor plan §7.3,
 * §12 Q4): JSONL in the state dir, host SQLite, or D1 via monitoring-api. This
 * module is the whole of the answer today, behind an interface narrow enough
 * that changing the answer touches this file and nothing else: the writer
 * (`job-rollups.ts`) and the reader (`fleet job-rollups`) see three calls and
 * never a path, a line format or a parse.
 *
 * THE FORMAT. One JSON line per UTC day — a whole {@link DayRollup}. A day is
 * therefore written whole or not at all: a line that does not parse is a day
 * that is MISSING, which the writer re-derives while job-history still holds it,
 * never a day that is half there.
 *
 * EVERY WRITE REPLACES THE FILE ATOMICALLY (temp file, fsync, rename, fsync the
 * directory). Writes are rare — once per closed day, plus one backfill — and a
 * year of days is a few tens of MB, so a full rewrite costs nothing that
 * matters and makes a crash mid-write harmless. The atomic writer is a local
 * copy, like job-history's: the shared one is refactor item F3.
 *
 * No logging, no host: the CLI reads this file in a process that never
 * installed one. Problems come back as data (`unreadableLines`), and the
 * caller decides who to tell.
 */
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { DayRollup } from './job-rollups.js';

/** The file's name inside the state dir. Declared once, read by the CLI too. */
export const ROLLUP_FILE = 'job-rollups.jsonl';

/** What a read found. */
export interface RollupRead {
	/** Oldest first, one per day. */
	days: DayRollup[];
	/**
	 * Lines that did not parse as a day. Not fatal and not silent: a reader
	 * reports the count, and the writer treats those days as unwritten.
	 */
	unreadableLines: number;
	/** False when there is no file at all: nothing has ever been written. */
	exists: boolean;
}

export interface RollupStore {
	/** Every day held, oldest first. Throws only on an unreadable FILE (not ENOENT). */
	read(): RollupRead;
	/** The set of days already written. Cached for the life of the store. */
	writtenDays(): ReadonlySet<string>;
	/**
	 * Add these days (replacing any held for the same day) and drop every day
	 * older than `keepFromDay`, in one atomic write. Throws on a failed write,
	 * leaving the previous file intact.
	 */
	put(days: readonly DayRollup[], keepFromDay: string): void;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDayRollup(v: unknown): v is DayRollup {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o.day === 'string' && DAY_RE.test(o.day) && Array.isArray(o.rows);
}

function writeFileAtomic(path: string, data: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	const fd = openSync(tmp, 'w');
	try {
		let buf = Buffer.from(data, 'utf8');
		while (buf.length) buf = buf.subarray(writeSync(fd, buf));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
	const dirFd = openSync(dirname(path), 'r');
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}

/** The JSONL store at `path`. */
export function jsonlRollupStore(path: string): RollupStore {
	let cachedDays: Set<string> | null = null;

	const read = (): RollupRead => {
		let raw: string;
		try {
			raw = readFileSync(path, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
				return { days: [], unreadableLines: 0, exists: false };
			}
			throw err;
		}
		const byDay = new Map<string, DayRollup>();
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
			if (!isDayRollup(parsed)) {
				unreadableLines++;
				continue;
			}
			byDay.set(parsed.day, parsed);
		}
		const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
		return { days, unreadableLines, exists: true };
	};

	return {
		read,
		writtenDays() {
			if (!cachedDays) cachedDays = new Set(read().days.map((d) => d.day));
			return cachedDays;
		},
		put(days, keepFromDay) {
			const held = new Map(read().days.map((d) => [d.day, d]));
			for (const d of days) held.set(d.day, d);
			const kept = [...held.values()]
				.filter((d) => d.day >= keepFromDay)
				.sort((a, b) => a.day.localeCompare(b.day));
			mkdirSync(dirname(path), { recursive: true });
			writeFileAtomic(
				path,
				kept.map((d) => JSON.stringify(d)).join('\n') + (kept.length ? '\n' : '')
			);
			cachedDays = new Set(kept.map((d) => d.day));
		},
	};
}
