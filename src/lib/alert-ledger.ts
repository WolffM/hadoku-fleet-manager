import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger, stateDir, postDiscord as postDiscordSink } from '../host.js';
import { writeJsonAtomic } from './atomic-json.js';
import { createPager, HOUR_MS as RE_ALERT_MS } from './job-runner.js';

// key → last alert time, ISO. A key absent (or older than RE_ALERT_MS) re-fires.
// createPager's own shape (F12, plan §4.1) — see `alertOnce`/`clearAlert` below.
export let pagedAlerts: Record<string, string> = {};

/**
 * Alert suppression SURVIVES A RESTART.
 *
 * `pagedAlerts` was in-memory only, so every mgmt-api restart re-armed every
 * condition and the next tick re-paged all of them. A sustained problem is
 * supposed to ping hourly; on 2026-08-29 a deploy-heavy session restarted this
 * process six times and the same two conditions — one failed unit, one queued
 * run — paged 10 minutes apart repeatedly. The alert was correct every time and
 * the channel still became unreadable, which is how an alert gets trained away.
 *
 * Persisted as a plain map of key -> ISO time next to the other operator
 * state — `createPager`'s own `paged` shape, so `alertOnce` below is a thin
 * wrapper rather than a hand-rolled debounce (F12's `page-ledger` debt). A
 * ledger written by the PRE-F12 code is still read: a bare epoch-ms number is
 * accepted on load exactly as an ISO string is, so the one file this writes
 * is read across the deploy that changed its format, not lost by it. Entries
 * older than the window are dropped on load, so the file cannot grow without
 * bound and a long-cleared condition still alerts immediately when it returns.
 *
 * Fail-soft in BOTH directions: an unreadable or corrupt ledger means "nothing
 * suppressed" (alert, do not go quiet), and a failed write is logged and
 * ignored (a noisy channel beats a crashed monitor).
 */
const ALERT_LEDGER = () => join(stateDir(), 'runner-health-alerts.json');
let ledgerLoaded = false;

function loadAlertLedger(): void {
	if (ledgerLoaded) return;
	ledgerLoaded = true;
	try {
		const raw = JSON.parse(readFileSync(ALERT_LEDGER(), 'utf8')) as Record<string, unknown>;
		const cutoff = Date.now() - RE_ALERT_MS;
		for (const [k, v] of Object.entries(raw)) {
			// Accepts both shapes: a number is the ledger's pre-F12 format (epoch
			// ms), a string is an ISO stamp written by this code or by claw-reboot/
			// provisioning-converge's own createPager-backed ledgers.
			const atMs = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
			if (!Number.isNaN(atMs) && atMs > cutoff) pagedAlerts[k] = new Date(atMs).toISOString();
		}
	} catch {
		// No file yet, or unreadable. Suppress nothing — alerting twice is a
		// nuisance, staying silent about a live problem is not.
	}
}

function saveAlertLedger(): void {
	try {
		const cutoff = Date.now() - RE_ALERT_MS;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(pagedAlerts)) if (Date.parse(v) > cutoff) out[k] = v;
		writeJsonAtomic(ALERT_LEDGER(), out);
	} catch (err) {
		logger.warn(
			`[runner-health] could not persist the alert ledger: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

/**
 * Fire at most once per RE_ALERT_MS per condition key — a thin wrapper over
 * `createPager` (F12, plan §4.1): the debounce and the post are
 * `job-runner.ts`'s, this file owns only the ledger's persistence, exactly as
 * before. A fresh pager per call, matching the old `const now = Date.now()`
 * read at call time rather than once per tick.
 *
 * The pager saves the ledger after the post (`persist`), whether or not the
 * post resolved. Only a process kill mid-`post` (not a rejection) could lose
 * that write; the host's `postDiscord` does not reject. A SUPPRESSED call
 * (within the window) never saves, same as before.
 */
export async function alertOnce(key: string, content: string): Promise<void> {
	loadAlertLedger();
	const pager = createPager({
		paged: pagedAlerts,
		now: Date.now(),
		repageMs: RE_ALERT_MS,
		post: postDiscordSink,
		source: 'runner-health',
		persist: saveAlertLedger,
	});
	await pager.page(key, content);
}

/**
 * Condition cleared — re-arm so the next occurrence alerts immediately.
 *
 * Deliberately NOT `pager.recover()`: that always posts, and this ledger has
 * no recovery announcement today — every call site clears silently, by
 * design (see the header's `clearAlert` note). Reusing `createPager` here
 * would add a message that does not exist, so this stays a direct delete on
 * the same `paged`-shaped map `alertOnce` above uses.
 */
export function clearAlert(key: string): void {
	loadAlertLedger();
	if (pagedAlerts[key] !== undefined) {
		delete pagedAlerts[key];
		saveAlertLedger();
	}
}

/** Reset per-condition alert suppression. Test-only seam. */
/** Re-read the persisted ledger, as a fresh process would. Test-only seam. */
export function __reloadAlertLedgerForTesting(): void {
	ledgerLoaded = false;
	loadAlertLedger();
}

/** Test seam: cross-tick memory this module owns. */
export function __resetAlertLedgerForTesting(): void {
	ledgerLoaded = true; // never read the operator's ledger from a test
	pagedAlerts = {};
}
