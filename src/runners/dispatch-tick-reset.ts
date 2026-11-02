/**
 * THE DISPATCH TICK'S TEST SEAMS — aggregates a reset across every piece of
 * poll state `runDispatchTick` reads, most of it actually owned by the
 * sub-modules it imports (`dispatch-tick-poll.ts`, `dispatch-tick-stuck-
 * load.ts`, `stuck-runs.ts`, `dispatch-poll-cache.ts`, `probe-backoff.ts`,
 * `dispatch-tick-probe-intents.ts`, `dispatch-pass.ts`'s own reap clock).
 * Split out of `dispatch-tick.ts` (wave shrink-1 lane B, 800-line ceiling)
 * so the tick's own logic sits apart from the housekeeping a test needs
 * between runs; `dispatch-tick.ts` re-exports every name here under its
 * original path.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir } from '../host.js';
import { __resetSubCadenceKeyForTesting } from '../lib/every.js';
import { __resetReapClockForTesting } from './dispatch-pass.js';
import {
	etagByRepo,
	runsDisk,
	jobsDisk,
	pendingEtagByRepo,
	pendingDisk,
	lastPolledMs,
	pendingKeysByRepo,
} from '../lib/dispatch-poll-cache.js';
import { probeBackoff } from './probe-backoff.js';
import { STUCK_ANNOUNCED_FILE, warnedStuck, stuckStoreComplaints } from './stuck-runs.js';
import {
	cachedRunsByRepo,
	cachedPendingByRepo,
	lastReadByRepo,
	jobsCacheByRun,
	__setPollCacheHydratedForTesting,
} from './dispatch-tick-poll.js';
import { __resetWarnedStuckLoadedForTesting } from './dispatch-tick-stuck-load.js';
import {
	announcedIntents,
	__resetProbeIntentStateForTesting,
} from './dispatch-tick-probe-intents.js';
import { PENDING_CADENCE_NAME } from './dispatch-tick-config.js';

export { __resetProbeIntentStateForTesting };

/** Test seam: the poll cadence is module state and a test must be able to reset it. */
export function __resetPollStateForTesting(): void {
	lastPolledMs.clear();
	// The announced-stuck book is a FILE now, so clearing the Map is only half a
	// reset. Left on disk, the first test's zombie silences the next test's and
	// the suppression passes a test it never earned.
	warnedStuck.clear();
	__resetWarnedStuckLoadedForTesting();
	stuckStoreComplaints.clear();
	rmSync(join(stateDir(), STUCK_ANNOUNCED_FILE), { force: true });
	// The conditional-poll cache is poll state too. Left behind, one test's ETag
	// makes the next test's first poll answer 304 against a body it never set.
	etagByRepo.clear();
	cachedRunsByRepo.clear();
	lastReadByRepo.clear();
	jobsCacheByRun.clear();
	probeBackoff.clear();
	pendingEtagByRepo.clear();
	cachedPendingByRepo.clear();
	pendingKeysByRepo.clear();
	__resetSubCadenceKeyForTesting(PENDING_CADENCE_NAME);
	// And its disk half, for the same reason. Marked hydrated so a test reads
	// disk only through `__restartPollCacheForTesting`, which means to.
	runsDisk.clear();
	jobsDisk.clear();
	pendingDisk.clear();
	__setPollCacheHydratedForTesting(true);
	// The reap clock is the OTHER cadence a tick carries. Left behind, the first
	// test's sweep gates every later test's, and they assert `reaped: skipped`
	// while believing they proved something about dispatch.
	__resetReapClockForTesting();
	// The announce-once set for probe intents is poll state too: left behind, a
	// second test's suppression is silent and a test asserting the log line reads
	// the first test's.
	announcedIntents.clear();
}

/** Tests only: drop the process's poll state and keep the disk, as a deploy does. */
export function __restartPollCacheForTesting(): void {
	lastPolledMs.clear();
	lastReadByRepo.clear();
	probeBackoff.clear();
	etagByRepo.clear();
	cachedRunsByRepo.clear();
	jobsCacheByRun.clear();
	pendingEtagByRepo.clear();
	cachedPendingByRepo.clear();
	pendingKeysByRepo.clear();
	__resetSubCadenceKeyForTesting(PENDING_CADENCE_NAME);
	__setPollCacheHydratedForTesting(false);
}

/**
 * Tests only: drop the PROCESS's half of the announced-stuck book and leave the
 * file, which is exactly what an mgmt-api deploy does.
 *
 * Without this seam a ten-tick test proves only what the old code already did —
 * dedup inside one process — and issue #25 was never about one process.
 */
export function __restartAnnouncedStuckForTesting(): void {
	warnedStuck.clear();
	__resetWarnedStuckLoadedForTesting();
	stuckStoreComplaints.clear();
}
