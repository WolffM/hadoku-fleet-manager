/**
 * Shared fixture for dispatch-tick.test.ts's split (wave 5r lane B, 1,168
 * lines moved into three files under the 1,000-line test ceiling plus this
 * rig): the base node/input builders (`node`/`base`), the queued-run harness
 * (`harness`/`queued`/`NOW`), the recording-logger helper (`recordingHost`),
 * and the one file-wide `beforeEach`/`afterEach` every split file installs at
 * its top (`installDispatchTickRig`) — exactly where the original single
 * file's inline hooks used to sit. node:test scopes hooks PER FILE, and
 * applies one wherever it is declared even inside an imported module's
 * exported function, the same way `installWarmCacheRig()` relies on for the
 * warm-cache split (wave 5p lane C).
 *
 * `unclearable`/`TICK_MS`/`bookPath` (issue #25), `jitRunnerName`/
 * `PROBE_BACKOFF_MS`/`iso`/`stuckRunHarness`/`hot`/`builder` (probe backoff),
 * and `pendingRun`/`job`/`pendingHarness`/`listings`/`probes` (#11 pending)
 * are NOT here: each is read by exactly one split file, so it stays beside
 * the tests that use it rather than crossing into a shared module nothing
 * else reads.
 */
import { beforeEach, afterEach } from 'node:test';

import { resetRecoveryClock } from '../../runners/dispatch-tick-config.js';
import { __resetPollStateForTesting } from '../../runners/dispatch-tick-reset.js';
import type { DispatchTickInput } from '../../runners/dispatch-tick-config.js';
import type { NodeState } from '../../runners/placement-node-state.js';
import { fakeGh, fakeShell } from './fleet-fakes.js';
import { __setHostForTesting } from '../../host.js';
import { testHost } from '../install-test-host.js';

export const node = (name: string, over: Partial<NodeState> = {}): NodeState => ({
	name,
	healthy: true,
	eligible: true,
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 3,
	freeMb: 9000,
	requiredMb: 900,
	minFreeMb: 1536,
	...over,
});

export const base = (over: Partial<DispatchTickInput> = {}): DispatchTickInput => ({
	order: ['claw-3'],
	nodes: [node('claw-3', { labels: ['hadoku-builder'] })],
	repos: ['WolffM/hadoku-rally'],
	recentJobCounts: new Map(),
	labelsFor: () => [],
	memoryMaxMbFor: () => 3000,
	homeDirFor: () => '/home/fixture-ci',
	ttlSeconds: 3600,
	...over,
});

export function harness(
	runs: unknown[],
	jobs: unknown[] = [{ id: 1, status: 'queued', labels: ['self-hosted', 'hadoku-builder'] }]
) {
	const gh = fakeGh({ workflowRuns: runs, jobs });
	return {
		get calls() {
			return gh.calls;
		},
		sh: fakeShell(),
		gh,
	};
}

export const NOW = 1_787_797_008_000;
/** Queued long enough to count as starved — the standing fleet did not take it. */
export const queued = (id: number, agoMs = 120_000) => ({
	id,
	status: 'queued',
	created_at: new Date(NOW - agoMs).toISOString(),
	repository: { full_name: 'WolffM/hadoku-rally' },
	head_repository: { full_name: 'WolffM/hadoku-rally', fork: false },
	event: 'push',
});

/**
 * A host whose logger RECORDS, because the no-op one cannot fail a log assertion.
 *
 * The test this replaces built a `warned` array and an `origWarn`, `void`ed them
 * both and asserted nothing about either. It passed for the entire life of the
 * bug it claimed to cover.
 */
export function recordingHost() {
	const warns: string[] = [];
	const infos: string[] = [];
	__setHostForTesting({
		...testHost,
		logger: {
			info: (m: string) => {
				infos.push(m);
			},
			warn: (m: string) => {
				warns.push(m);
			},
			error: () => undefined,
		},
	});
	return {
		warns,
		infos,
		/** Only the stuck-ceiling warning; the tick emits others. */
		stuck: () => warns.filter((w) => w.includes('queued past the stuck ceiling')),
		cleared: () => infos.filter((i) => i.includes('are gone from the queue')),
	};
}

/**
 * Every split file calls this once, at its own top, exactly where the
 * original single file's inline `beforeEach`/`afterEach` used to sit.
 */
export function installDispatchTickRig(): void {
	beforeEach(() => {
		__resetPollStateForTesting();
		resetRecoveryClock();
	});
	afterEach(() => {
		// The recording host below replaces the preloaded one. Put it back, or one
		// test's log capture silently swallows the next test's output.
		__setHostForTesting(testHost);
	});
}
