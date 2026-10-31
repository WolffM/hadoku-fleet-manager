import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../lib/atomic-json.js';
import { logger, stateDir } from '../host.js';

/**
 * How often the warm-cache tick may run its own probe, INDEPENDENT of the
 * dispatch tick — the same shape of constant as `REAP_INTERVAL_MS`, and for
 * the same reason.
 *
 * `warmRegistration` below costs one runner listing per eligible node. It is
 * conditional (`ghGet` revalidates with an ETag, and a 304 is GitHub saying the
 * CURRENT listing is the one we hold), but a warm slot's listing changes every
 * time its runner flips busy or online, so the ceiling is still the spend (see
 * REAP_INTERVAL_MS's own note), and this must not ride the dispatch
 * tick's 15s cadence: at today's two eligible nodes that would already be
 * 480 calls/hr, and it grows with every node the warm cache becomes eligible
 * for. 60s bounds it at 1 call/node/minute regardless of fleet size, and
 * nothing about warm-cache maintenance is time-critical enough to need
 * faster — a slot sitting warm for an extra 59 seconds after it should have
 * rotated costs nothing a job is waiting on.
 */
export const WARM_CACHE_INTERVAL_MS = 60_000;

/**
 * Per-node exponential backoff on consecutive warm-fill failures, capped at
 * 1 hour — issue #7's "no backoff, no kill switch" clause.
 *
 * Every fill was failing on every eligible node, every 60s tick, forever: a
 * registration-token GitHub call plus a heavy provisioning ssh, for nothing,
 * ~360 calls/hr fleet-wide. This is state, same shape as
 * `dispatch-warm-cache.ts`'s `lastWarmCacheMs`, because the thing it is
 * protecting — a mint attempt — is I/O the pure decision layer in
 * ephemeral.ts cannot gate on its own: `planWarmCache`
 * correctly says 'fill' every tick there is nothing warm yet, and it should —
 * knowing "try again" is the right call is not the same as knowing "try again
 * this SECOND".
 */
const WARM_BACKOFF_BASE_MS = WARM_CACHE_INTERVAL_MS;
const WARM_BACKOFF_CAP_MS = 60 * 60_000;

interface WarmBackoffEntry {
	failures: number;
	retryAtMs: number;
}

/**
 * ...AND IT LIVES ON DISK, BECAUSE mgmt-api's MEMORY IS NOT A PLACE TO KEEP IT.
 *
 * The backoff above shipped as a module-level Map and, measured against the
 * deployed 0.22.49 on 2026-09-08, it never once reached its second doubling.
 * The log read like a backoff that was not wrapping this failure path at all —
 * claw-1/3/5 failing at 05:07:57, 05:09:05, 05:10:28, 05:11:36, 05:13:15,
 * 05:14:22, 05:16:22, 05:17:29, 05:18:36 — but every one of those retries is
 * explained by the code as written: mgmt-api restarted at 05:07:49, 05:10:20,
 * 05:13:06 and 05:17:20 (17 restarts that day, 164 on the process pm2 was
 * holding), and each restart put `failures` back to 0. Between restarts the
 * streak only ever got as far as 1 -> 2, whose 120s delay skips at most one
 * 60s tick. A guard that resets faster than it can escalate is not a guard.
 *
 * This is the same fact this workstream already writes down everywhere else
 * and for the same stated reason: the warm marker lives on the NODE rather
 * than in this process because "mgmt-api's own memory is wrong after every one
 * of its ~5 daily restarts" (currentWarmSlot, §12.8/B9). A failure streak is
 * exactly that shape of fact, so it goes where the drain state, the job
 * history and the runner-health ledger already are — `stateDir()`.
 *
 * Read once per process and written on every change. An unreadable or absent
 * file is an EMPTY backoff, which is the honest direction here and not a
 * "could not look" that must fail: forgetting a streak costs one extra mint
 * attempt and is visible in the log, whereas inventing one would silently
 * suppress a fill nobody asked to suppress.
 */
const WARM_BACKOFF_FILE = 'warm-backoff.json';

let warmBackoff: Map<string, WarmBackoffEntry> | null = null;

const warmBackoffPath = (): string => join(stateDir(), WARM_BACKOFF_FILE);

function loadWarmBackoff(): Map<string, WarmBackoffEntry> {
	if (warmBackoff) return warmBackoff;
	warmBackoff = new Map();
	try {
		const raw = JSON.parse(readFileSync(warmBackoffPath(), 'utf8')) as {
			nodes?: Record<string, WarmBackoffEntry>;
		};
		for (const [node, e] of Object.entries(raw?.nodes ?? {})) {
			if (Number.isFinite(e?.failures) && Number.isFinite(e?.retryAtMs)) {
				warmBackoff.set(node, { failures: e.failures, retryAtMs: e.retryAtMs });
			}
		}
	} catch {
		// Absent on a fresh box, and unparseable only if something truncated it
		// mid-write — the rename below makes that vanishingly unlikely. Either
		// way an empty streak is the safe reading; see the note above.
	}
	return warmBackoff;
}

function saveWarmBackoff(): void {
	const nodes = Object.fromEntries(loadWarmBackoff());
	try {
		// Write-then-rename, fsync'd (F3, `lib/atomic-json.ts`): a torn write here
		// would be read back as an empty streak on the next restart, which is
		// precisely the failure this file exists to stop. `loadWarmBackoff`'s own
		// "unreadable is empty" handling is unchanged (recorded as a divergence
		// for 5c, not widened here).
		writeFileAtomic(warmBackoffPath(), `${JSON.stringify({ nodes }, null, 2)}\n`);
	} catch (err) {
		logger.warn(
			`[warm-cache] could not persist the fill backoff: ${
				err instanceof Error ? err.message : String(err)
			} — a restart will retry a failing node sooner than it should`
		);
	}
}

/** Test seam. Not part of the supported API. */
export function __resetWarmBackoffForTesting(): void {
	warmBackoff = new Map();
	saveWarmBackoff();
	warmBackoff = null;
}

/**
 * Test seam: drop only the IN-MEMORY copy, exactly as a process restart does,
 * leaving what is on disk alone. Not part of the supported API — but the
 * property it exists to assert is the entire reason this state moved to disk.
 */
export function __restartWarmBackoffForTesting(): void {
	warmBackoff = null;
}

export function warmBackoffActive(node: string, nowMs: number): boolean {
	const e = loadWarmBackoff().get(node);
	return e !== undefined && nowMs < e.retryAtMs;
}

export function recordWarmFailure(node: string, nowMs: number): void {
	const map = loadWarmBackoff();
	const failures = (map.get(node)?.failures ?? 0) + 1;
	const delayMs = Math.min(WARM_BACKOFF_BASE_MS * 2 ** (failures - 1), WARM_BACKOFF_CAP_MS);
	map.set(node, { failures, retryAtMs: nowMs + delayMs });
	saveWarmBackoff();
}

export function clearWarmFailures(node: string): void {
	if (loadWarmBackoff().delete(node)) saveWarmBackoff();
}
