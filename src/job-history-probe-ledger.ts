/**
 * The probe ledger — the forced-placement harness's half of the contract.
 * Split out of `job-history-store.ts` (wave shrink-1 lane C, pure move) to
 * bring that file under the 600-line target.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { logger, stateDir } from './host.js';
import { cutoffIso, type ProbeOrigin } from './job-history-store.js';

/**
 * Where the harness declares the runs it manufactured.
 *
 * ONE FILENAME, DECLARED ONCE. `scripts/floor-probe.mjs` writes this file and
 * this module reads it, and the two run in different processes resolving
 * `stateDir()` through different doors (`host.ts` in-process, `lib/paths.mjs`
 * for the CLI). A second literal in the script is the isLocalNode shape — two
 * answers to one question, agreeing until one of them moves — so the script
 * imports this constant from the built copy rather than spelling it again.
 *
 * A SEPARATE FILE FROM `job-history.jsonl`, and that is not tidiness. This
 * process rewrites the history file wholesale from its in-memory window
 * (`persistHistory`) and merges nothing, so an out-of-process writer's lines
 * are deleted without an error — measured 2026-09-07, 502 records. The ledger
 * is append-only and this module never writes it, which is the only arrangement
 * where both writers can be right.
 */
export const PROBE_LEDGER_FILE = 'floor-probe-runs.jsonl';

/** One declared probe. The harness appends; nothing here writes it. */
export interface ProbeLedgerEntry {
	runId: number;
	repo: string;
	origin: ProbeOrigin;
	/** ISO stamp of the declaration, for the operator reading the file by eye. */
	at?: string;
}

export const probeRuns = new Map<number, ProbeOrigin>();
/** mtime of the ledger as last read. -1 means "never looked". */
let probeLedgerMtimeMs = -1;
/** One warning per process for an unreadable ledger. See the catch below. */
let ledgerWarned = false;
/**
 * Forced runs whose `seenRuns` skip has already been spent, this process.
 *
 * THIS IS THE THING THAT KEEPS THE DEDUPE HOLE SHUT. The skip below is lifted
 * for a forced re-dispatch because the second attempt of an already-seen run is
 * exactly the record Control A needs and today it is never fetched. Lifting it
 * on EVERY tick for as long as the ledger entry exists would re-fetch that run
 * forever, which is the unbounded re-poll `seenRuns` was added to stop. One
 * lift per run id per process: enough to pick up the attempt the harness just
 * forced, bounded whether or not the harness ever prunes its ledger.
 */
export const forcedLifted = new Set<number>();

export function probeLedgerFile(): string {
	return join(stateDir(), PROBE_LEDGER_FILE);
}

/**
 * Re-read the ledger when it has changed on disk.
 *
 * mtime-gated rather than once-only: mgmt-api is long-lived and the harness
 * declares a probe SECONDS before the run it names completes, so a load-once
 * reader would never see the entry that matters. One `statSync` per ingest
 * call — 26 repos on a 10-minute tick — against a file with a handful of lines.
 *
 * A missing ledger is an empty ledger and is correct: nothing has been
 * manufactured. An unreadable one is not, but it is also not fatal here — the
 * cost is a probe recorded as organic, which is a mislabelled sample and not a
 * wrong verdict, so it warns and carries on rather than taking the tick down.
 */
export function loadProbeLedger(): void {
	let mtime: number;
	try {
		mtime = statSync(probeLedgerFile()).mtimeMs;
	} catch {
		// ENOENT is the normal state on a fleet that has never probed.
		probeRuns.clear();
		probeLedgerMtimeMs = -1;
		return;
	}
	if (mtime === probeLedgerMtimeMs) return;
	probeLedgerMtimeMs = mtime;
	probeRuns.clear();
	// The same window the records themselves live in. Past it the run has already
	// aged out of `records`, so there is nothing left for the tag to land on and
	// holding the entry in memory would grow this map for the life of the process
	// with no reader. An entry with no `at` is KEPT: unknown age must not silently
	// drop a declaration, which is the same rule `ingestRuns` applies to an
	// undated run.
	const cutoff = cutoffIso();
	try {
		for (const line of readFileSync(probeLedgerFile(), 'utf8').split('\n')) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line) as ProbeLedgerEntry;
				if (typeof e.runId !== 'number') continue;
				if (e.origin !== 'shadow' && e.origin !== 'forced-rerun') continue;
				if (typeof e.at === 'string' && e.at < cutoff) continue;
				probeRuns.set(e.runId, e.origin);
			} catch {
				// one bad line, not a bad file — same rule as loadHistory
			}
		}
	} catch (err) {
		// Its OWN once-flag, not `warnOnce`'s. Sharing that flag would let a
		// mislabelled probe sample silently consume the one warning a genuinely
		// unreadable history file gets — the less important failure muting the
		// more important one.
		if (!ledgerWarned) {
			ledgerWarned = true;
			logger.warn(
				`[job-history] could not read the probe ledger: ` +
					`${err instanceof Error ? err.message : String(err)} — ` +
					'manufactured samples this tick will record as organic'
			);
		}
	}
}

/** Test seam: cross-tick memory this module owns. */
export function __resetProbeLedgerForTesting(): void {
	probeRuns.clear();
	probeLedgerMtimeMs = -1;
	forcedLifted.clear();
	ledgerWarned = false;
}
