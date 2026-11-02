/**
 * Shared fixture for dispatch-pass.test.ts's split (wave 5r lane B, 1,255
 * lines moved into three files under the 1,000-line test ceiling plus this
 * rig): the base node/run/input builders (`node`/`run`/`base`), the mint
 * harness (`harness`), the recording-logger helper (`recordInfos`), and the
 * one file-wide `beforeEach`/`afterEach` every split file installs at its
 * top (`installDispatchPassRig`) — exactly where the original single file's
 * inline hooks used to sit. node:test scopes hooks PER FILE, and applies one
 * wherever it is declared even inside an imported module's exported
 * function, the same way `installWarmCacheRig()` relies on for the
 * warm-cache split (wave 5p lane C).
 *
 * `RECUT_LINE`/`warmSecond` (the viaAffinity counter + #102 heavy accounting)
 * and every local fixture confined to the reap-sweep section (`RUNNER_LIST`,
 * `REPOS`, `rosterGh`, `ROSTER`, `HOUR_MS`, `DISPATCH_TICK_MS`) or the warm
 * heavy hold / runner identity / push order section (`CT`, `FORGE`,
 * `forgeJob`, `recordingShell`, `MINTED_FOR_100`, `strandedShell`,
 * `BUILDER_JOB`, `builderNode`) are NOT here: each is read by exactly one
 * split file, so it stays beside the tests that use it rather than crossing
 * into a shared module nothing else reads.
 */
import { beforeEach, afterEach } from 'node:test';

import { __resetReapClockForTesting } from '../../runners/dispatch-pass.js';
import {
	__resetHeavyMarksForTesting,
	__resetAffinityCountersForTesting,
} from '../../runners/dispatch-pass-state.js';
import { type DispatchPassInput } from '../../runners/dispatch-pass-types.js';
import { __setHostForTesting } from '../../host.js';
import { testHost } from '../install-test-host.js';
import type { NodeState } from '../../runners/placement-node-state.js';
import { fakeGh, fakeShell } from './fleet-fakes.js';

export const node = (name: string, over: Partial<NodeState> = {}): NodeState => ({
	name,
	healthy: true,
	eligible: true,
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 2,
	freeMb: 9000,
	requiredMb: 900,
	minFreeMb: 1536,
	...over,
});

export const run = (id: number) => ({
	id,
	repo: 'WolffM/hadoku-rally',
	repository: { full_name: 'WolffM/hadoku-rally' },
	head_repository: { full_name: 'WolffM/hadoku-rally', fork: false },
	event: 'push',
	jobId: id * 100,
});

export const base = (over: Partial<DispatchPassInput> = {}): DispatchPassInput => ({
	order: ['claw-2'],
	nodes: [node('claw-2')],
	pending: [run(1)],
	labelsFor: () => ['hadoku-builder'],
	homeDirFor: () => '/home/fixture-ci',
	memoryMaxMbFor: () => 3000,
	ttlSeconds: 900,
	...over,
});

export function harness(existingUnits: string[] = []) {
	const gh = fakeGh();
	const sh = fakeShell({ units: existingUnits });
	// `minted` was a second list of the same writes the fake already records.
	return {
		get minted() {
			return gh.writes.filter((w) => w.includes('generate-jitconfig'));
		},
		sh,
		gh,
	};
}

export function recordInfos(): string[] {
	const infos: string[] = [];
	__setHostForTesting({
		...testHost,
		logger: {
			info: (m: string) => void infos.push(m),
			warn: () => undefined,
			error: () => undefined,
		},
	});
	return infos;
}

/**
 * Every split file calls this once, at its own top, exactly where the
 * original single file's inline `beforeEach`/`afterEach` used to sit.
 */
export function installDispatchPassRig(): void {
	// The reap clock is module state shared by every pass in this process. Without
	// this, the first test's sweep gates the rest and they assert against a sweep
	// that never ran.
	beforeEach(() => {
		__resetReapClockForTesting();
		__resetHeavyMarksForTesting();
		__resetAffinityCountersForTesting();
	});
	// A test below swaps in a recording logger; put the silent one back.
	afterEach(() => __setHostForTesting(testHost));
}
