/**
 * capacity-sample-store — where the T4 capacity samples live (refactor plan
 * §7.3: "capacity/admission state at time T" is not answerable today; §12 Q4:
 * "P0 writes JSONL behind a one-file store module per stream, so the SQLite
 * move is one file each"). ONE FILE ON PURPOSE, same reasoning as
 * `job-rollup-store.ts`: the writer (`capacity-sample.ts`) and a future
 * reader see `read`/`append` and never a path, a line format or a parse.
 *
 * THE FORMAT. One JSON line per (node, 5-minute tick) — a whole
 * {@link CapacitySampleRow}. A row is written whole or not at all: a line
 * that does not parse is simply dropped on read (`unreadableLines` counts it)
 * and never crashes a reader.
 *
 * APPEND, AND COMPACT ON A COUNTED STALE SHARE (fleet-manager#86). This file
 * used to be rewritten whole, fsync'd, on every 5-minute tick: read, parse
 * and sort ~38,000 rows (8.4 MB) to add ~9. That was a 205 ms synchronous
 * stretch on mgmt-api's leader on 2026-11-14, the longest in a 300 s profile,
 * the same shape job-history had before 0.34.415. A tick now appends its rows.
 * The full atomic rewrite (temp file, fsync, rename) runs only once rows past
 * retention, plus unreadable lines, reach {@link COMPACT_STALE_FRACTION} of
 * the rows that would be kept.
 *
 * What that costs a reader: a row past {@link CAPACITY_SAMPLE_RETENTION_DAYS}
 * can stay on disk up to ~10% of the window longer (~1.4 days). Both readers
 * window by their own clock (`fleet stats --days`, host-reliability's
 * `RELIABILITY_WINDOW_MS`), and `read` sorts, so neither sees a difference.
 * An append is not fsync'd: a crash can lose the last tick's rows or leave
 * a torn last line, which `read` counts as unreadable, and the next append
 * starts on a fresh line.
 *
 * The tally behind that decision is per process and per path, because the
 * sampler builds a fresh store every tick. It is checked against the file's
 * size before each append, so a file another process wrote (a standby that
 * took leadership, a hand edit) is re-read once rather than miscounted.
 *
 * RETENTION IS BY TIME, and the cutoff moves with every `append`.

 * No logging, no host: a reader (a future `fleet capacity-samples`, or a
 * test) runs in a process that never installed one. Problems come back as
 * data (`unreadableLines`), and the caller decides who to tell.
 *
 * NOT IN `scripts/lib/f-guards/f3-one-writer.json`, on purpose — the same
 * accepted gap documented there for `job-rollup-store.ts`: `path` is a
 * parameter from the one caller (`capacity-sample.ts`), not a literal this
 * file's own write call can trace, so the detector finds nothing to declare.
 * Hand-adding an entry here would fail that file's own stale check.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { writeFileAtomic } from './lib/atomic-json.js';
import type { ClawState } from './lib/fleet-vocabulary.js';

/**
 * Mirrors `fleet-report-types.ts`'s own `AdmissionBasis` — not imported from
 * there: this is a `state`-layer file (plan §3.2 rule 3) and
 * `fleet-report-types.ts` is `surfaces` (layer-map.mjs), so importing it
 * would be the upward edge `src/lib/fleet-vocabulary.ts`'s own header
 * describes fixing for `ClawState` ("neither domain can host the other's
 * import legally"). Two string literals is a smaller cost than a layer
 * violation; `ClawState` above is small enough to import from its own
 * `config`-layer home instead, which is why only this one is inlined.
 */
export type AdmissionBasis = 'dispatcher' | 'standing';

/** The file's name inside the state dir. Declared once; the sampler resolves the path. */
export const CAPACITY_SAMPLE_FILE = 'capacity-samples.jsonl';

/** Kept this long; see the module header for why 14 days. */
export const CAPACITY_SAMPLE_RETENTION_DAYS = 14;

/** Rewrite once rows past retention (and unreadable lines) are this share of the rows kept. */
export const COMPACT_STALE_FRACTION = 0.1;

const DAY_MS = 86_400_000;

/**
 * One node's admission state at one 5-minute tick. Every field is read
 * straight off the fleet's own in-memory state (`buildFleetReport` and
 * `isDraining`) — see `capacity-sample.ts`'s own header for the full list of
 * what is NOT read: no ssh, no GitHub call, nothing this sampler itself
 * triggers.
 */
export interface CapacitySampleRow {
	/** ISO, the tick this row belongs to — the same instant for every node sampled together. */
	at: string;
	node: string;
	/** The BOX's declared ceiling (`FleetMachine.maxConcurrent`). `null`: no operator declaration on record, never 0. */
	maxConcurrent: number | null;
	/**
	 * The budget that actually admits work on this node right now, and what is
	 * left of it (`FleetMachine.admissionCapacity`/`admissionFree`). Both `null`
	 * together means UNMEASURED — the probe could not reach the box, which is
	 * not the same as a measured zero. See `unmeasured` below, which names this
	 * case explicitly rather than leaving a reader to re-derive it from two nulls.
	 */
	admissionCapacity: number | null;
	admissionFree: number | null;
	/** Which budget `admissionCapacity` is — `dispatcher` (ephemeral) or `standing`. `null` when unmeasured. */
	admissionBasis: AdmissionBasis | null;
	/** free | busy | demoted | offline | absent | mintable | unreachable | sick. `null`: no verdict yet this process. */
	state: ClawState | null;
	/** An operator's drain (maintenance, training, lease, hosting, reboot) — read from `fleet-drain.json`, not derived from `state`. */
	drained: boolean;
	/** `admitMint`'s own refusal reason, verbatim, when a verdict currently refuses this node. `null`: admitted, or no verdict (standing nodes carry no per-tick admission verdict at all). */
	refusalReason: string | null;
	/**
	 * This tick could not measure this node's capacity at all (the probe never
	 * reached it) — `true` iff `admissionCapacity`/`admissionFree` are the
	 * "could not look" `null`, never the "measured zero" case. See
	 * `AGENTS.md`'s "Capacity may be UNMEASURED, and that is not zero."
	 */
	unmeasured: boolean;
}

/** What a read found. */
export interface CapacitySampleRead {
	/** Oldest first. */
	rows: CapacitySampleRow[];
	/** Lines that did not parse as a row. Not fatal and not silent: a reader reports the count. */
	unreadableLines: number;
	/** `false` when there is no file at all: nothing has ever been written. */
	exists: boolean;
}

export interface CapacitySampleStore {
	/** Every row held, oldest first. Throws only on an unreadable FILE (not ENOENT). */
	read(): CapacitySampleRead;
	/**
	 * Add these rows. Rows older than `nowMs - retention` are dropped by an
	 * atomic rewrite once they make up {@link COMPACT_STALE_FRACTION} of the
	 * file; otherwise the rows are appended. Throws on a failed write — the
	 * caller (`capacity-sample.ts`) is the one that must not let that throw
	 * escape to its own caller.
	 */
	append(rows: readonly CapacitySampleRow[], nowMs: number): Promise<void>;
}

function isCapacitySampleRow(v: unknown): v is CapacitySampleRow {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.at === 'string' &&
		!Number.isNaN(Date.parse(o.at)) &&
		typeof o.node === 'string' &&
		typeof o.drained === 'boolean' &&
		typeof o.unmeasured === 'boolean'
	);
}

/** What this process knows is on disk at one path, without reading it again. */
interface Tally {
	/** Rows per `at`: a tick's rows share one, so this stays a few thousand entries. */
	atCounts: Map<string, number>;
	rows: number;
	unreadable: number;
	/** The file's size after our last write; anything else means someone else wrote. */
	size: number;
	/** The file ends mid-line (a torn write): the next append starts a new one. */
	torn: boolean;
}

const tallies = new Map<string, Tally>();

/** Tests that rewrite a store's file behind its back. */
export function __resetCapacitySampleTalliesForTesting(): void {
	tallies.clear();
}

function parse(raw: string): { rows: CapacitySampleRow[]; unreadableLines: number } {
	const rows: CapacitySampleRow[] = [];
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
		if (!isCapacitySampleRow(parsed)) {
			unreadableLines++;
			continue;
		}
		rows.push(parsed);
	}
	return { rows, unreadableLines };
}

const byTime = (a: CapacitySampleRow, b: CapacitySampleRow): number =>
	a.at.localeCompare(b.at) || a.node.localeCompare(b.node);

const lines = (rows: readonly CapacitySampleRow[]): string =>
	rows.map((r) => JSON.stringify(r) + '\n').join('');

function count(t: Tally, rows: readonly CapacitySampleRow[]): void {
	for (const r of rows) t.atCounts.set(r.at, (t.atCounts.get(r.at) ?? 0) + 1);
	t.rows += rows.length;
}

function sizeOf(path: string): number | null {
	try {
		return statSync(path).size;
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
		throw err;
	}
}

/** The JSONL store at `path`. */
export function capacitySampleStore(path: string): CapacitySampleStore {
	const readRaw = (): string | null => {
		try {
			return readFileSync(path, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
			throw err;
		}
	};

	const read = (): CapacitySampleRead => {
		const raw = readRaw();
		if (raw === null) return { rows: [], unreadableLines: 0, exists: false };
		const { rows, unreadableLines } = parse(raw);
		rows.sort(byTime);
		return { rows, unreadableLines, exists: true };
	};

	/** The tally for this file, re-read when the file is not the one we last wrote. */
	const tally = (): Tally => {
		const size = sizeOf(path) ?? 0;
		const held = tallies.get(path);
		if (held && held.size === size) return held;
		const raw = readRaw() ?? '';
		const { rows, unreadableLines } = parse(raw);
		const t: Tally = {
			atCounts: new Map(),
			rows: 0,
			unreadable: unreadableLines,
			size: Buffer.byteLength(raw),
			torn: raw.length > 0 && !raw.endsWith('\n'),
		};
		count(t, rows);
		tallies.set(path, t);
		return t;
	};

	const compact = async (rows: readonly CapacitySampleRow[], cutoff: string): Promise<void> => {
		let kept: CapacitySampleRow[] = [];
		let text = '';
		await writeFileAtomic(path, () => {
			kept = read()
				.rows.filter((r) => r.at >= cutoff)
				.concat(rows)
				.sort(byTime);
			text = lines(kept);
			return text;
		});
		const t: Tally = {
			atCounts: new Map(),
			rows: 0,
			unreadable: 0,
			size: Buffer.byteLength(text),
			torn: false,
		};
		count(t, kept);
		tallies.set(path, t);
	};

	return {
		read,
		async append(rows, nowMs) {
			const cutoff = new Date(nowMs - CAPACITY_SAMPLE_RETENTION_DAYS * DAY_MS).toISOString();
			let t: Tally;
			try {
				t = tally();
			} catch (err) {
				tallies.delete(path);
				throw err;
			}
			let stale = t.unreadable;
			for (const [at, n] of t.atCounts) if (at < cutoff) stale += n;
			const kept = t.rows - (stale - t.unreadable) + rows.length;
			if (stale > 0 && stale >= kept * COMPACT_STALE_FRACTION) {
				try {
					await compact(rows, cutoff);
				} catch (err) {
					tallies.delete(path);
					throw err;
				}
				return;
			}
			const text = (t.torn ? '\n' : '') + lines(rows);
			try {
				mkdirSync(dirname(path), { recursive: true });
				appendFileSync(path, text);
			} catch (err) {
				// A partial append leaves the file unknown: re-read it next time.
				tallies.delete(path);
				throw err;
			}
			t.size += Buffer.byteLength(text);
			t.torn = false;
			count(t, rows);
		},
	};
}
