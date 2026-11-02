/**
 * Shared fixture for warm-cache.test.ts's split (wave 5p lane C, 3,252 lines
 * moved into nine files of under 1,000 lines plus this rig): the
 * measured-fleet constants (`MEASURED`/`HOKON`), the joint-allocation
 * repo/job fixtures (`SITE` through `overlappingPairs`), the stateful node
 * simulator (`NodeSim`/`simShell`), the `EphemeralTickInput` builder
 * (`baseInput`/`NODE_ELIGIBLE` family), the job-history fixture
 * (`HIST_T0`/`histAt`/`writeRecord`), the workload-gate proof fixture
 * (`NODE_ELIGIBLE_JDK21`/`proofRec`), and the one file-wide
 * `beforeEach`/`afterEach` every split file installs at its top
 * (`installWarmCacheRig`) — exactly where the original single file's inline
 * hooks used to sit. node:test scopes hooks PER FILE, and applies one
 * wherever it is declared even inside an imported module's exported
 * function, the same way `installPlacementRig()` relies on for the
 * placement/fleet-report/job-history split (wave 5o lane B).
 *
 * `warmHarness`/`WARM_REQ` (mint-exec), `writeQuietRepoAfterBusyOne`/
 * `twoNodeInput`/`writeSkewedOnBothNodes` (value-call-site),
 * `ghWithDownloads`/`CLAW3`/`CAPS` (payload-burst-cap), and
 * `budgetsFrom`/`verdictsFrom`/`orderFrom`/`labelsFromDispatchEphemeral`
 * (wiring-placement) are NOT here: each is read by exactly one split file,
 * so it stays beside the tests that use it rather than crossing into a
 * shared module nothing else reads.
 */
import { afterEach, beforeEach } from 'node:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __setHostForTesting } from '../../host.js';
import { testHost } from '../install-test-host.js';
import {
	__resetJobHistoryForTesting,
	__setHistoryPathForTesting,
	historyFile,
} from '../../job-history-store.js';
import { __resetTarballCacheForTesting } from '../../runners/ephemeral-exec-jit.js';
import { __resetAdmissionVerdictsForTesting } from '../../runners/ephemeral-tick.js';
import {
	__resetWorkloadGateCorruptionLogForTesting,
	__setWorkloadGateContextForTesting,
} from '../../workload-gate-store.js';
import type { EphemeralTickInput } from '../../runners/ephemeral-shared.js';
import { __resetWarmCacheClockForTesting } from '../../runners/dispatch-warm-cache.js';
import { __resetSpeedModelForTesting } from '../../runners/speed-heavy-cache.js';
import { __resetWarmBackoffForTesting } from '../../runners/warm-backoff.js';
import type { ProofRecord } from '../../lib/workload-gate.js';

// --- the measured fleet (eligibility) ---------------------------------------

/** `free -m` totals measured on every manifest node, 2026-09-20. */
export const MEASURED = {
	'claw-1': { installedMb: 11_885, minFreeMb: 2048, jobMb: 3400 },
	'claw-2': { installedMb: 7872, minFreeMb: 1536, jobMb: 3400 },
	'claw-3': { installedMb: 15_918, minFreeMb: 2048, jobMb: 3400 },
	'claw-4': { installedMb: 15_936, minFreeMb: 2048, jobMb: 4096 },
	'claw-5': { installedMb: 15_877, minFreeMb: 2048, jobMb: 4096 },
	'claw-6': { installedMb: 7849, minFreeMb: 1536, jobMb: 4096 },
	'claw-8': { installedMb: 15_915, minFreeMb: 2048, jobMb: 4096 },
	'claw-9': { installedMb: 32_003, minFreeMb: 4096, jobMb: 4096 },
} as const;
export const HOKON = { installedMb: 63_402, minFreeMb: 8192, jobMb: 4096, role: 'backstop' };

// --- planWarmFleet repo/job fixtures (wave 3k §B) -------------------------

export const SITE = 'WolffM/hadoku_site';
export const MEET = 'WolffM/hadoku-rally';
export const CARD = 'WolffM/hadoku-cardtable';
export const TEN = 'WolffM/hadoku-tenhands';
export const FLEET_NOW = 50_000_000;

/** `n` jobs of `repo`, all a minute before FLEET_NOW. */
export function jobsOf(repo: string, n: number) {
	return Array.from({ length: n }, () => ({ repo, startedAtMs: FLEET_NOW - 60_000 }));
}
/** A slot that is unlocked on both counts: not busy, and long past the window. */
export const idleSlot = (repo: string) => ({ repo, busy: false, mintedOrRefreshedAtMs: 0 });
export const busySlot = (repo: string) => ({ repo, busy: true, mintedOrRefreshedAtMs: 0 });

/** `pairs` pairs of `repo` jobs, each pair started together and running a
 *  minute — so the second of each pair finds the first still running. */
export function overlappingPairs(repo: string, pairs: number) {
	return Array.from({ length: pairs * 2 }, (_, k) => ({
		repo,
		startedAtMs: FLEET_NOW - 3600_000 + Math.floor(k / 2) * 120_000,
		durationMs: 60_000,
	}));
}

// --- the job-history fixture ------------------------------------------------

/**
 * History fixture timestamps are RELATIVE, and that is not a style preference.
 *
 * `servedJobsByNode` reads through `jobRecords()`, which drops every record
 * older than the ROLLING `RETENTION_DAYS = 14` window. A fixture pinned to an
 * absolute date therefore carries an expiry date: these were written at
 * `2026-09-01T00:00:00Z`, the cutoff reached them on 2026-09-15, and thirteen
 * tests went red on a file nobody had touched — issue #27, the same class
 * 473dfdb fixed for `job-history.test.ts` a week earlier. CI was green only
 * because it had last run the day before.
 *
 * Two days back, for the same reasons 473dfdb chose it: far enough inside the
 * window that a slow suite cannot drift out of it, recent enough to be
 * obviously live.
 *
 * `HIST_T0` is deliberately NOT `T0` below. `T0` is the fake dispatch tick
 * clock handed to `dispatchWarmCache` as its `now`, an arbitrary monotonic
 * millisecond count that must stay far from the module's `0` sentinel; this one
 * is wall-clock time that the retention cutoff compares against. Collapsing the
 * two would tie the tick clock to the calendar and put the sentinel collision
 * back in play.
 */
export const HIST_T0 = Date.now() - 2 * 24 * 3600_000;
/** `HIST_T0` plus `sec`, as the ISO string the Actions API would return. */
export const histAt = (sec: number) => new Date(HIST_T0 + sec * 1000).toISOString();

export function writeRecord(r: Partial<Record<string, unknown>>) {
	appendFileSync(
		historyFile(),
		JSON.stringify({
			repo: 'WolffM/hadoku_site',
			runId: 1,
			jobId: Math.floor(Math.random() * 1e9),
			name: 'typecheck',
			runner: 'claw-1',
			labels: ['self-hosted'],
			startedAt: histAt(0),
			durationSec: 60,
			conclusion: 'success',
			...r,
		}) + '\n'
	);
}

// --- the stateful node simulator, and the EphemeralTickInput builder -------

export interface NodeSim {
	marker: string | null; // "repo epochSec"
	activeUnits: Set<string>;
	/** Installed MB `free -m` reports for this node. Default is comfortably
	 * eligible (16 GB-class) so tests that are not exercising eligibility
	 * itself do not have to think about it. */
	installedMb?: number;
	/** When set, every `warm-provision.sh` fill on this node fails with this
	 * reason instead of succeeding — for the backoff tests. */
	provisionFails?: string;
	/** #101: free MB this sim reports for `/tmp` and for `~/.hadoku/jit`, off
	 * the SAME combined `sh` call the dispatch tick's `free -m` probe now
	 * carries `df -Pm` on. Default is comfortably clear of
	 * `TMP_FREE_FLOOR_MB`/`WORK_FREE_FLOOR_MB` so a test not exercising the
	 * space clause itself does not have to think about it. */
	tmpFreeMb?: number;
	workFreeMb?: number;
	/** #101: when set, the `df` line(s) named come back unreadable (garbage,
	 *  not a bare integer) instead of a number — same effect as a `df` that
	 *  fails or prints an error on a live node. */
	dfUnreadable?: 'tmp' | 'work' | 'both';
}

export const DEFAULT_INSTALLED_MB = 16_000;
export const DEFAULT_SPACE_FREE_MB = 8_000;

export function simShell(sims: Record<string, NodeSim>) {
	return async (node: string, cmd: string): Promise<string | null> => {
		const s = (sims[node] ??= { marker: null, activeUnits: new Set() });
		// TWO COLUMNS for the dispatch tick (`$7, $2` — available AND installed),
		// one for the warm tick (`$2` alone). Both halves of the warm placement
		// decision are measured off this same line, which is the point: the tick
		// that PLACES a listener and the tick that holds a slot back for it must
		// not be reading two different numbers.
		if (cmd.includes('free -m')) {
			const total = String(s.installedMb ?? DEFAULT_INSTALLED_MB);
			// #101: BOTH shapes — the dispatch tick's `$7, $2` and the warm
			// tick's `$2` alone — piggyback the SAME `df -Pm` tail (shared
			// `SPACE_PROBE_DF_CMD`), so this mock must answer it for either,
			// never just the shape it happened to be written against first.
			const freeLine = cmd.includes('$7, $2')
				? `${Math.floor(Number(total) * 0.8)} ${total}`
				: total;
			if (!cmd.includes('df -Pm')) return freeLine;
			const tmp =
				s.dfUnreadable === 'tmp' || s.dfUnreadable === 'both'
					? 'df: /tmp: No such file or directory'
					: String(s.tmpFreeMb ?? DEFAULT_SPACE_FREE_MB);
			const work =
				s.dfUnreadable === 'work' || s.dfUnreadable === 'both'
					? 'df: /home: No such file or directory'
					: String(s.workFreeMb ?? DEFAULT_SPACE_FREE_MB);
			// #101: a trailing newline, the way `execFile`'s real stdout always
			// has one — the bug this models split on `\n` and read the LAST two
			// elements, which with this newline present is `[tmp, work, '']`.
			return `${freeLine}\n${tmp}\n${work}\n`;
		}
		if (cmd.includes('warm-provision.sh')) {
			if (s.provisionFails) return `WARM-FAIL ${s.provisionFails}`;
			const repo = /REPO='([^']*)'/.exec(cmd)?.[1] ?? '';
			s.marker = `${repo} 1000`;
			return 'WARM-READY /home/hadoku/.hadoku/warm/listener 2.336.0';
		}
		if (cmd.includes('systemd-run')) {
			const unit = /--unit=(\S+)/.exec(cmd)?.[1];
			if (unit) s.activeUnits.add(unit);
			return 'Running as unit: x.service';
		}
		if (cmd.startsWith('rm -f')) {
			s.marker = null;
			return '';
		}
		if (cmd.startsWith('touch')) {
			if (s.marker) s.marker = `${s.marker.split(' ')[0]} 999999`;
			return '';
		}
		if (cmd.includes('systemctl --user stop')) {
			const unit = /stop\s+(\S+)/.exec(cmd)?.[1];
			if (unit) s.activeUnits.delete(unit);
			return '';
		}
		if (cmd.includes('is-active')) {
			const unit = /is-active\s+(\S+)/.exec(cmd)?.[1];
			return unit && s.activeUnits.has(unit) ? 'active' : 'inactive';
		}
		if (cmd.includes('warm/repo')) return s.marker ?? '';
		return '';
	};
}

export const NODE_ELIGIBLE = {
	labels: ['hadoku-builder'],
	maxConcurrent: 3,
	minFreeMb: 2048,
	slice: { unitMaxMb: 4096 },
};
// issue #7's exact shape: claw-2 DECLARES `maxConcurrent: 2` for job-scheduling
// purposes — which the old code fed straight to warmCacheEligible and got a
// false "yes" — while its measured installed RAM (set on the sim below) leaves
// a JIT half too small for even one mint. Eligibility must be measured, not
// read off maxConcurrent, or this fixture would wrongly pass.
export const NODE_INELIGIBLE = { labels: ['hadoku-builder'], maxConcurrent: 2, minFreeMb: 1536 };
/** usable 4464: a 2232 MB JIT half against a 4096 MB mint -> no listener. */
export const INELIGIBLE_INSTALLED_MB = 6000;

export function baseInput(over: Partial<EphemeralTickInput> = {}): EphemeralTickInput {
	return {
		fleetProbe: new Map([['claw-1', { reachable: true, busyRepos: null }]]),
		ephemeral: new Set(['claw-1']),
		nodes: { 'claw-1': NODE_ELIGIBLE },
		isSick: () => false,
		repos: ['WolffM/hadoku_site'],
		...over,
	};
}

// A clock nowhere near the module's `lastWarmCacheMs` reset value (0) — using
// a literal 0 for "the first tick" would collide with that sentinel and the
// gate would (correctly, for real traffic where Date.now() is never 0) treat
// it as "already ran this interval".
export const T0 = 10_000_000;

// --- the workload-gate proof fixture ----------------------------------------

/** `NODE_ELIGIBLE`, but it also EARNED jdk21's tool proof. */
export const NODE_ELIGIBLE_JDK21 = {
	...NODE_ELIGIBLE,
	$capabilities: { earned: ['jdk21'], prereqs: [] },
};

export const proofRec = (over: Partial<ProofRecord> = {}): ProofRecord => ({
	node: 'claw-1',
	capability: 'jdk21',
	runId: 1,
	runner: 'jit-claw-1-proof-hadoku-cardtable-j0-r0-1',
	conclusion: 'success',
	durationSec: 300,
	evidenceMatched: true,
	budgetSec: null,
	verdict: 'pass',
	why: 'pass (budget unbootstrapped: 0/2 proven node(s))',
	at: new Date().toISOString(),
	...over,
});

// --- the one file-wide beforeEach/afterEach --------------------------------

export let tmp: string;

/**
 * Every split file calls this once, at its own top, exactly where the
 * original single file's inline `beforeEach`/`afterEach` used to sit.
 */
export function installWarmCacheRig(): void {
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'warmcache-'));
		__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
		__resetJobHistoryForTesting();
		__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
		__resetWarmCacheClockForTesting();
		__resetWarmBackoffForTesting();
		// Module-global and memoised for a DAY, so one test resolving it would
		// otherwise decide what every later test in this file sees.
		__resetTarballCacheForTesting();
		// The speed model (#83/wave 3z) rebuilds only every 10 minutes
		// (`SPEED_MODEL_REBUILD_INTERVAL_MS`) off a module-global cache keyed by
		// wall-clock `Date.now()` — not this file's fake tick clocks — so without
		// this reset, whichever test runs first in the process decides what every
		// later test's placement order sees.
		__resetSpeedModelForTesting();
		// Wave 4a (#100): the generic admission verdict snapshot is module-level,
		// same leak class as every other reset in this block.
		__resetAdmissionVerdictsForTesting();
		// Wave 4e follow-up (#102): module-level, same leak class as every other
		// reset in this block — a test that forgot to clear it would leak its
		// fixture `$proof` context into every test that runs after it.
		__setWorkloadGateContextForTesting(null);
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		__setHistoryPathForTesting(null);
		__setWorkloadGateContextForTesting(null);
		__resetWorkloadGateCorruptionLogForTesting();
		__setHostForTesting(testHost);
	});
}
