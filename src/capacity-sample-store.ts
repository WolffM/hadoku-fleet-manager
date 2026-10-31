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
 * EVERY WRITE REPLACES THE FILE ATOMICALLY (temp file, fsync, rename, fsync
 * the directory), via the shared `writeFileAtomic` (F3, `lib/atomic-json.ts`)
 * — the same choice `job-rollup-store.ts` made, and for the same reason: a
 * node's own row count is tiny (one fleet's worth every 5 minutes) and a full
 * rewrite is cheap even kept for a retention window measured in weeks, which
 * buys a format a crash mid-write cannot tear in half. At ~9 nodes, a 5-minute
 * tick and {@link CAPACITY_SAMPLE_RETENTION_DAYS} = 14 days, that is on the
 * order of 9 * 12 * 24 * 14 ≈ 36,000 rows — a few MB — rewritten once per
 * tick. If the fleet grows by an order of magnitude this should move to a
 * true append (decision-log.ts's day-file pattern), but today's volume does
 * not justify that complexity.
 *
 * RETENTION IS BY TIME, trimmed on every `append` call: a row older than
 * {@link CAPACITY_SAMPLE_RETENTION_DAYS} is dropped the next time anything is
 * written, never read back. 14 days matches job-history's own window (T0) —
 * this store answers "what did admission look like at time T", which is only
 * useful for as long as the ledger it would be joined against still holds
 * that day.
 *
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
import { readFileSync } from 'node:fs';

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
	 * Add these rows and drop every row older than `nowMs - retention`, in one
	 * atomic write. Throws on a failed write, leaving the previous file intact
	 * — the caller (`capacity-sample.ts`) is the one that must not let that
	 * throw escape to its own caller.
	 */
	append(rows: readonly CapacitySampleRow[], nowMs: number): void;
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

/** The JSONL store at `path`. */
export function capacitySampleStore(path: string): CapacitySampleStore {
	const read = (): CapacitySampleRead => {
		let raw: string;
		try {
			raw = readFileSync(path, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
				return { rows: [], unreadableLines: 0, exists: false };
			}
			throw err;
		}
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
		rows.sort((a, b) => a.at.localeCompare(b.at) || a.node.localeCompare(b.node));
		return { rows, unreadableLines, exists: true };
	};

	return {
		read,
		append(rows, nowMs) {
			const cutoff = new Date(nowMs - CAPACITY_SAMPLE_RETENTION_DAYS * DAY_MS).toISOString();
			const kept = read()
				.rows.filter((r) => r.at >= cutoff)
				.concat(rows)
				.sort((a, b) => a.at.localeCompare(b.at) || a.node.localeCompare(b.node));
			writeFileAtomic(
				path,
				kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : '')
			);
		},
	};
}
