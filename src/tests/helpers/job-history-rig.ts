/**
 * Shared fixture for job-history.test.ts's split: the per-test temp history
 * file (and the probe-ledger cleanup that rode along with it), and the
 * `job`/`at`/`T0`/`seed`/`restart` helpers used across the ingest, summarise,
 * persistence and backfill concerns.
 *
 * node:test scopes beforeEach/afterEach PER FILE (confirmed empirically: a
 * hook registered anywhere at a file's top level applies to every test in
 * that file, including ones declared textually ABOVE it). The original file
 * registered ONE beforeEach/afterEach pair near its top (the temp-dir setup)
 * and a SECOND, unrelated afterEach much further down (removing the probe
 * ledger file) — both applied to all 78 of its tests, not only the ones near
 * where they were written. Every file split out of job-history.test.ts calls
 * `installJobHistoryRig()` once at its own top level, before any `test()`
 * calls, exactly where those two hooks used to sit — the same shape as
 * `src/tests/helpers/runner-health-rig.ts`.
 */
import { beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	__resetJobHistoryForTesting,
	__setHistoryPathForTesting,
	historyFile,
	probeLedgerFile,
} from '../../job-history-store.js';
import { ingestRuns } from '../../job-history-ingest.js';

/**
 * Fixture timestamps are RELATIVE, and that is not a style preference.
 *
 * `ingestRuns` ends with `compactHistory()`, and both that and `loadHistory`
 * drop every record older than the ROLLING `RETENTION_DAYS` window. A fixture
 * pinned to an absolute date therefore has an expiry: these were written at
 * `2026-08-25T03:00:00Z`, the cutoff reached them at 03:00 on 2026-09-08, and
 * nineteen tests went red on a file nobody had touched. Some would have failed
 * VACUOUSLY instead of loudly — "a STANDING runner gets neither half" asserts
 * `undefined`, which is exactly what an aged-out record also returns.
 *
 * So every fixture that crosses retention is anchored here. Two days back: far
 * enough inside the window that a slow suite cannot drift out of it, recent
 * enough to be obviously live. The deliberate 2020 record in "records older
 * than retention are dropped on load" stays absolute — being ancient is its
 * whole point — and so do the real-response step timings in the phases file,
 * which are read by the pure `jobPhases`/`stepFailure` helpers and never see a
 * cutoff.
 */
export const T0 = Date.now() - 2 * 24 * 3600_000;
/** T0 plus `sec`, as the ISO string the Actions API would return. */
export const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

export const job = (o: Partial<Record<string, unknown>> = {}) => ({
	id: Math.floor(Math.random() * 1e9),
	name: 'typecheck',
	runner_name: 'claw-2',
	labels: ['self-hosted', 'hadoku-builder'],
	started_at: at(0),
	completed_at: at(100), // 100s
	conclusion: 'success',
	...o,
});

export async function seed(jobs: ReturnType<typeof job>[]) {
	await ingestRuns('WolffM/x', [{ id: 42, status: 'completed' }], () => Promise.resolve({ jobs }));
}

/** Simulate a process restart: drop memory, keep the file. */
export function restart() {
	const path = historyFile();
	__resetJobHistoryForTesting();
	__setHistoryPathForTesting(path);
}

// Every test gets its OWN file. Without this the suite reads and WRITES the
// real host history at ~/.hadoku-mgmt/job-history.jsonl — which it did on the
// first run of this change, putting fixture rows for a repo called 'WolffM/x'
// into production state.
export let tmp: string;

export function installJobHistoryRig(): void {
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'jobhist-'));
		__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
		__resetJobHistoryForTesting();
		__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		__setHistoryPathForTesting(null);
	});
	// Only `job-history-probe-ledger.test.ts`'s own tests write this file, but
	// the original hook ran after EVERY test in the combined file, so every
	// split file installs it too.
	afterEach(() => {
		rmSync(probeLedgerFile(), { force: true });
	});
}
