/**
 * Shared fixture for placement.test.ts's split: the base node builder, the
 * fleet-half `NodeState.warmRepo` fake (the stateful shell fixture and the
 * fixed-shape `EphemeralTickInput` node it probes), the speed-history clock
 * anchor, and the per-test temp dir + cache resets every file that exercises
 * the real `dispatchWarmCache`/`dispatchEphemeral` pipeline needs.
 *
 * node:test scopes beforeEach/afterEach PER FILE (confirmed empirically: a
 * hook registered anywhere at a file's top level applies to every test in
 * that file, including ones declared textually ABOVE it), so a test that
 * moved away from placement.test.ts without this rig would run against
 * whatever the PREVIOUS test in its new file left behind, or nothing at all.
 * Every file split out of placement.test.ts calls `installPlacementRig()`
 * once at its own top level, before any `test()` calls, exactly where the
 * old file's single inline `beforeEach`/`afterEach` used to sit — the same
 * shape as `src/tests/helpers/runner-health-rig.ts`.
 *
 * `mintedOn` and `wireTmp` are exported as live ESM bindings (`export let`):
 * an import of either always reads the CURRENT value, because ES module
 * imports are references into the exporting module's own scope rather than a
 * value copied out of it at import time.
 */
import { beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NodeState } from '../../runners/placement-node-state.js';
import { TMP_FREE_FLOOR_MB } from '../../lib/jit-naming.js';
import { WORK_FREE_FLOOR_MB } from '../../runners/ephemeral-admission.js';
import {
	__resetJobHistoryForTesting,
	__setHistoryPathForTesting,
} from '../../job-history-store.js';
import { __resetWarmCacheClockForTesting } from '../../runners/dispatch-warm-cache.js';
import { __resetWarmReposForTesting } from '../../runners/dispatch-warm-cache-state.js';
import {
	__resetSpeedModelForTesting,
	__resetHeavyModelForTesting,
} from '../../runners/speed-heavy-cache.js';
import { __resetWarmBackoffForTesting } from '../../runners/warm-backoff.js';
import { __resetReapClockForTesting } from '../../runners/dispatch-pass.js';
import { __resetTarballCacheForTesting } from '../../runners/ephemeral-exec-jit.js';
import { fakeShell } from './fleet-fakes.js';

// --- B8/B10/#76/#77/P5.1/#102/#82/#83/#8/#15: the base NodeState builder ----

export const m = (name: string, over: Partial<NodeState> = {}): NodeState => ({
	name,
	healthy: true,
	eligible: true,
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 3,
	freeMb: 8000,
	requiredMb: 900,
	minFreeMb: 1536,
	...over,
});
export const ORDER = ['claw-2', 'claw-1', 'claw-3', 'hokon'];

// --- the fleet half: NodeState.warmRepo, sourced from GitHub's listing -------

export const WIRE_NODE = {
	labels: ['hadoku-builder'],
	maxConcurrent: 3,
	minFreeMb: 2048,
	slice: { unitMaxMb: 4096 },
	jobP95Mb: 900,
};

export interface NodeSim {
	/** `"<repo> <epochSec>"`, as `$HOME/.hadoku/warm/repo` holds it. */
	marker: string | null;
	/** Units `systemctl --user is-active` answers `active` for. */
	active: Set<string>;
}

/** #101: free MB this fixture answers for the `df -Pm` tail of the space
 * probe — comfortably clear of `TMP_FREE_FLOOR_MB`/`WORK_FREE_FLOOR_MB` so
 * none of this file's placement assertions have to think about space. */
const SPACE_FREE_MB = Math.max(TMP_FREE_FLOOR_MB, WORK_FREE_FLOOR_MB) * 4;

/** Nodes that received a JIT provisioning step this pass — i.e. were minted on. */
export let mintedOn: string[] = [];

/**
 * The fleet's shell, as a stateful fake.
 *
 * Only the two commands `currentWarmSlot` issues are modelled here; everything
 * else defers to the shared `fakeShell`, so this cannot drift from the fixture
 * the rest of the workstream asserts against.
 */
export function simShell(sims: Record<string, NodeSim>) {
	const base = fakeShell();
	return async (node: string, cmd: string): Promise<string | null> => {
		const s = (sims[node] ??= { marker: null, active: new Set() });
		if (/SLOT=\d+/.test(cmd)) mintedOn.push(node);
		// A 16 GB-class claw. The shared `fakeShell` answers 9000 MB installed,
		// which is one 4GB-class slot once `minFreeMb` is set aside — i.e. NOT
		// warm-cache eligible (`warmEligibleSlots`), so every warm assertion below
		// would pass vacuously against a node the tick never reaches. Two columns
		// for the dispatch tick (`$7, $2` — available AND installed), one for the
		// warm tick (`$2` alone).
		if (cmd.includes('free -m')) {
			const freeLine = cmd.includes('$7, $2') ? '9000 16000' : '16000';
			// #101: BOTH shapes piggyback the same `df -Pm` tail (shared
			// `SPACE_PROBE_DF_CMD`), so this fixture must answer it too.
			// #101: trailing newline, the way `execFile`'s real stdout always has
			// one.
			return cmd.includes('df -Pm')
				? `${freeLine}\n${SPACE_FREE_MB}\n${SPACE_FREE_MB}\n`
				: freeLine;
		}
		if (cmd.includes('warm/repo'))
			return s.marker ?? (cmd.includes('NO-WARM-MARKER') ? 'NO-WARM-MARKER' : '');
		if (cmd.includes('is-active')) {
			const unit = /is-active\s+(\S+)/.exec(cmd)?.[1];
			return unit && s.active.has(unit) ? 'active' : 'inactive';
		}
		// The warm MINT's own two steps (`mintWarmListener`) — added for the
		// warm-path #82/#83 tests (which are the first to exercise a listener
		// actually being minted rather than only observed).
		// Mirrors warm-cache.test.ts's own fake for the same two commands.
		if (cmd.includes('warm-provision.sh')) {
			const repo = /REPO='([^']*)'/.exec(cmd)?.[1] ?? '';
			s.marker = `${repo} 1000`;
			return 'WARM-READY /home/hadoku/.hadoku/warm/listener 2.336.0';
		}
		if (cmd.includes('systemd-run')) {
			const unit = /--unit=(\S+)/.exec(cmd)?.[1];
			if (unit) s.active.add(unit);
			return 'Running as unit: x.service';
		}
		return base(node, cmd);
	};
}

// --- the speed-history clock anchor, shared by the warm-path and #8 files ---

// All within WARM_HISTORY_WINDOW_MS (6h) of each other and of SPEED_NOW, and
// within WINDOW_DAYS (14d) of SPEED_NOW for the speed model — both windows
// are real-calendar, ISO-string based, so an opaque small `nowMs` (the shape
// every other WIRING test across these files uses) would silently fall
// outside both. ANCHORED TO Date.now(), not a literal calendar date — a
// fixed date ages out of both windows on its own as real time passes (the
// fixture-clock guard fails this suite 400 days ahead otherwise), the same
// fix `warm-cache.test.ts`'s own `HIST_T0` already uses.
export const SPEED_BASE_MS = Date.now() - 2 * 24 * 3600_000;
export const SPEED_DEMAND_AT = new Date(SPEED_BASE_MS + 60_000).toISOString();
export const SPEED_NOW = SPEED_BASE_MS + 3_600_000; // 1h after the fixture, well clear of WARM_ASSIGN_WINDOW_MS too

// --- per-test temp dir + cache resets ---------------------------------------

export let wireTmp: string;

export function installPlacementRig(): void {
	beforeEach(() => {
		wireTmp = mkdtempSync(join(tmpdir(), 'placement-wire-'));
		__setHistoryPathForTesting(join(wireTmp, 'job-history.jsonl'));
		__resetJobHistoryForTesting();
		__setHistoryPathForTesting(join(wireTmp, 'job-history.jsonl'));
		__resetWarmCacheClockForTesting();
		__resetWarmReposForTesting();
		__resetWarmBackoffForTesting();
		__resetTarballCacheForTesting();
		__resetReapClockForTesting();
		// #83: the speed model is cached across calls on its own 10-minute clock
		// (SPEED_MODEL_REBUILD_INTERVAL_MS) — correct for production, but these
		// files' WIRING tests call `dispatchWarmCache`/`dispatchEphemeral` many
		// times each with its own job-history fixture, so each test must see its
		// OWN history, not whichever one built the model first.
		__resetSpeedModelForTesting();
		// #102: same reason as the speed model just above — one real job-history
		// fixture per test.
		__resetHeavyModelForTesting();
		mintedOn = [];
	});
	afterEach(() => {
		rmSync(wireTmp, { recursive: true, force: true });
		__setHistoryPathForTesting(null);
		__resetWarmReposForTesting();
	});
}
