/**
 * `ci-alerts.ts`'s three persisted files — the per-target state
 * (`ci-alert-state.json`), the per-repo listing floor (`ci-alert-repos.json`)
 * and the boot-pass gate (`ci-alerts-last-pass.json`) — split out (wave 5r
 * lane C, pure move) to bring that file under the 800-line ceiling. Every
 * name here stays re-exported from `ci-alerts.ts`, so no importer elsewhere
 * needed to change, and the boot-pass gate's own contract — read by the NEXT
 * process — is unchanged: same file, same shape, same caller.
 */
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

import { stateDir, logger } from './host.js';
import { writeJsonAtomic } from './lib/atomic-json.js';
import type { CiState } from './ci-alerts-decide.js';
import type { CiTickSummary } from './ci-alerts-summary.js';

const STATE_FILE = 'ci-alert-state.json';

function statePath(): string {
	return join(stateDir(), STATE_FILE);
}

/**
 * Persisted to disk, not memory. mgmt-api redeploys on every push to its own
 * tree and so restarts many times a day; in-memory state would make every
 * restart look like a fresh transition and re-announce breakage that was
 * already announced. Same lesson job-history.ts learned the hard way.
 */
export function readStates(): Record<string, CiState> {
	const p = statePath();
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, 'utf8')) as Record<string, CiState>;
	} catch (err) {
		logger.warn(`[ci-alerts] unreadable state (${String(err)}) — resyncing from scratch`);
		return {};
	}
}

export function writeStates(states: Record<string, CiState>): void {
	try {
		// Write-then-rename, fsync'd (F3, `lib/atomic-json.ts`): a crash mid-write
		// must not leave truncated JSON that the next tick reads as "no state"
		// and re-announces every live break from.
		writeJsonAtomic(statePath(), states, { space: '\t' });
	} catch (err) {
		logger.warn(`[ci-alerts] could not persist state: ${String(err)}`);
	}
}

/**
 * When the last CLEAN pass finished — every target read, nothing errored. On
 * disk because the question is asked by the NEXT process (2026-10-25).
 *
 * Each mgmt-api boot ran a full pass at once: 75 targets, 75-104 charged calls
 * in the window holding the boot, and the restart-storm morning of 2026-10-25
 * had 12 boots in two hours, each a few minutes after the last process's own
 * pass. A boot within `CI_ALERTS_BOOT_SKIP_MS` of a clean pass now leaves the
 * work to its first interval tick, so the gap between passes is under two
 * intervals (20 minutes) however often the process restarts: a boot past the
 * window runs one, and a process that lives ten minutes runs one on its tick.
 *
 * Only a CLEAN pass counts. A pass that could not read a target is not
 * evidence that nothing broke, and a boot after one runs its own.
 */
export const CI_ALERTS_PASS_FILE = 'ci-alerts-last-pass.json';
export const CI_ALERTS_BOOT_SKIP_MS = 10 * 60_000;

function passPath(): string {
	return join(stateDir(), CI_ALERTS_PASS_FILE);
}

/** The last clean pass's end, or null when there is none on record or it cannot be read. */
export function lastCleanCiAlertsPassMs(): number | null {
	let raw: string;
	try {
		raw = readFileSync(passPath(), 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			logger.warn(`[ci-alerts] could not read ${passPath()}: ${String(err)} — the boot pass runs`);
		}
		return null;
	}
	try {
		const at = Date.parse((JSON.parse(raw) as { completedAt?: string }).completedAt ?? '');
		return Number.isNaN(at) ? null : at;
	} catch (err) {
		logger.warn(`[ci-alerts] ${passPath()} is not parseable (${String(err)}) — the boot pass runs`);
		return null;
	}
}

/** Should a fresh process run its own pass now? */
export function ciAlertsBootPassDue(nowMs = Date.now()): boolean {
	const last = lastCleanCiAlertsPassMs();
	return last === null || nowMs - last >= CI_ALERTS_BOOT_SKIP_MS || last > nowMs;
}

export function recordCleanPass(s: CiTickSummary): void {
	if (!s.targets || s.unreadable || s.errors) return;
	try {
		writeJsonAtomic(passPath(), { completedAt: new Date().toISOString(), targets: s.targets });
	} catch (err) {
		logger.warn(
			`[ci-alerts] could not record the pass: ${String(err)} — the next boot runs its own`
		);
	}
}

/** Per-repo listing floor — see REPO_PAGE_SIZE. On disk for the same reason as the state. */
const REPO_STATE_FILE = 'ci-alert-repos.json';

export interface CiRepoState {
	/** ISO `created_at` the next poll must page below. */
	floor: string;
}

export function readRepoStates(): Record<string, CiRepoState> {
	const p = join(stateDir(), REPO_STATE_FILE);
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, 'utf8')) as Record<string, CiRepoState>;
	} catch (err) {
		// A lost floor is a cold start for every repo: one page each, and the
		// floor rebuilt at MAX_LOOKBACK_MS where the page was full.
		logger.warn(`[ci-alerts] unreadable repo floors (${String(err)}) — cold-starting each repo`);
		return {};
	}
}

export function writeRepoStates(states: Record<string, CiRepoState>): void {
	try {
		writeJsonAtomic(join(stateDir(), REPO_STATE_FILE), states, { space: '\t' });
	} catch (err) {
		logger.warn(`[ci-alerts] could not persist repo floors: ${String(err)}`);
	}
}
