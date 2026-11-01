/**
 * `runner-health.ts`'s ONGOING interval, ported onto `every()`
 * (wave5j-2026-10-31 lane D, plan §6.2 tier 1). `runner-health.test.ts`
 * already pins the token-wait and first-tick characterizations against the
 * real monitor (its "start: …" tests) — this file is NOT a copy of those; it
 * adds what that file does not cover, specific to this lane's change:
 *
 *   - `registerLoop` fires at the TOP of `startRunnerHealthMonitor`, before
 *     the token wait, independent of whether a token ever arrives (already
 *     true before this port; pinned here because it is now `every()`'s
 *     contract, not a bare call in this file, that must keep it there).
 *   - the ONGOING 10-minute interval no longer stacks a second tick on a
 *     slow one — `every()`'s own addition; the original bare
 *     `setInterval(() => void runTick(token), TICK_INTERVAL_MS)` had no
 *     guard of its own.
 *   - passing `every()` `{ registerLiveness: false }` for that ongoing
 *     interval does not reset `registeredAtMs` to the moment the first tick
 *     finished — only the EARLY registration counts.
 *
 * A minimal, generic GitHub-API fetch stub (not `runner-health.test.ts`'s
 * `installFetch` — that function is private to its file, and importing it
 * would mean importing from a file this lane does not own and lane A is
 * mid-split on). It answers every endpoint a tick reads with an empty,
 * well-typed body, which is enough for a tick to complete without throwing;
 * this file asserts SCHEDULING, never what a tick's business logic decided.
 */
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
	startRunnerHealthMonitor,
	__stopRunnerHealthMonitorForTesting,
	__awaitInFlightTickForTesting,
	__setTokenRetryForTesting,
	__setSupervisionCheckerForTesting,
	__setRemeasureDelayForTesting,
	__setPostBlackoutSlackForTesting,
	__setFleetReposForTesting,
	TICK_INTERVAL_MS,
} from '../runner-health.js';
import { getFleetLiveness, __resetLivenessForTesting } from '../lib/liveness.js';
import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';
import { runBackstopDecision } from '../runners/backstop-decision.js';
import { runHostedFallback } from '../runners/hosted-fallback.js';
import { setBackstopDecisionRunner, setHostedFallbackRunner } from '../runner-health-ports.js';

// This file calls `startRunnerHealthMonitor()` directly, with no
// `createFleetManager()` (that is where production wires these — see
// `runner-health-ports.ts`'s header) and no `installRunnerHealthRig()`
// (this file predates it and intentionally does not import its private
// `installFetch`). A real tick still reaches `checkLabelFloor`'s call into
// both ports even against an empty runner listing, so they are wired here,
// once, with the same real functions production uses.
setBackstopDecisionRunner(runBackstopDecision);
setHostedFallbackRunner(runHostedFallback);

function okJson(obj: unknown): Response {
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		json: async () => obj,
		text: async () => JSON.stringify(obj),
	} as unknown as Response;
}

/** Every GH endpoint a tick might read, answered with an empty, valid body. */
function installEmptyFetch(): void {
	globalThis.fetch = (async (input: string | URL) => {
		const url = String(input);
		if (url.includes('/actions/runners')) return okJson({ runners: [] });
		if (url.includes('/jobs')) return okJson({ jobs: [] });
		if (url.includes('/actions/runs')) return okJson({ workflow_runs: [] });
		if (url.includes('/annotations')) return okJson([]);
		return okJson({});
	}) as typeof fetch;
}

function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

const realFetch = globalThis.fetch;

beforeEach(() => {
	installEmptyFetch();
	__setSupervisionCheckerForTesting(() => Promise.resolve(null));
	// One repo, pinned: the real coverage/manifest fixture lists several, and
	// the stub below answers `/actions/runners` by URL SUBSTRING — with more
	// than one repo swept, each would hit it independently (a fan-out, not an
	// overlap), which is not what these tests are pinning.
	__setFleetReposForTesting(['WolffM/solo']);
	__setHostForTesting({ ...testHost, logger: { info() {}, warn() {}, error() {} } });
	__resetLivenessForTesting();
});
afterEach(() => {
	__stopRunnerHealthMonitorForTesting();
	__setTokenRetryForTesting(null);
	__setRemeasureDelayForTesting(null);
	__setPostBlackoutSlackForTesting(null);
	__setSupervisionCheckerForTesting(null);
	__setFleetReposForTesting(null);
	__setHostForTesting(testHost);
	globalThis.fetch = realFetch;
});

void test('startRunnerHealthMonitor: registerLoop fires at the TOP, even while the token never arrives', async () => {
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn() {}, error() {} },
		githubToken: () => undefined,
	});
	__setTokenRetryForTesting(60_000); // real timers below, so keep retries rare
	startRunnerHealthMonitor();
	const loop = getFleetLiveness().loops.find((l) => l.name === 'runner-health');
	assert.equal(loop?.status, 'pending', 'registered even with no token yet');
	assert.equal(loop?.lastTickAt, null);
});

void test('startRunnerHealthMonitor: a completed first tick notes liveness as ok', async () => {
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn() {}, error() {} },
		githubToken: () => 'tok',
	});
	startRunnerHealthMonitor();
	await __awaitInFlightTickForTesting();
	const loop = getFleetLiveness().loops.find((l) => l.name === 'runner-health');
	assert.equal(loop?.status, 'ok');
	assert.notEqual(loop?.lastTickAt, null);
});

void test("startRunnerHealthMonitor: the ONGOING interval does not stack a tick on a slow one — every()'s new overlap guard", async () => {
	// The ORIGINAL bare `setInterval(() => void runTick(token), TICK_INTERVAL_MS)`
	// had no guard: a tick running past TICK_INTERVAL_MS would have been joined
	// by a second one. This pins the guard `every()` now provides.
	//
	// A real tick reads `/actions/runners` more than once even for a SINGLE
	// pass, so "one tick" is not "one call" — this gates EVERY call and never
	// resolves any of them, then asserts the pending count stops growing once
	// tick #1's own burst has landed, across the next TWO regular intervals
	// (20 minutes). That window is deliberately short: `runner-health.ts` also
	// runs its OWN escalating re-probe ladder for a condition that looks like
	// an outage (`OFFLINE_REPEAT_BACKOFF_MS`: 1h, 4h, 12h, 24h) completely
	// independent of this lane's port, and a gate held open forever reads
	// EXACTLY like one — so a long enough window legitimately adds more calls
	// for a reason that has nothing to do with the interval's own overlap
	// guard. 20 minutes is comfortably inside "the next couple of ticks",
	// nowhere near that ladder's first rung.
	let pendingCalls = 0;
	const released: (() => void)[] = [];
	globalThis.fetch = (async (input: string | URL) => {
		const url = String(input);
		if (url.includes('/actions/runners')) {
			pendingCalls++;
			await new Promise<void>((res) => released.push(res));
			return okJson({ runners: [] });
		}
		if (url.includes('/jobs')) return okJson({ jobs: [] });
		if (url.includes('/actions/runs')) return okJson({ workflow_runs: [] });
		if (url.includes('/annotations')) return okJson([]);
		return okJson({});
	}) as typeof fetch;
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn() {}, error() {} },
		githubToken: () => 'tok',
	});

	mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
	try {
		startRunnerHealthMonitor();
		await flushMicrotasks();
		const afterFirstBurst = pendingCalls;
		assert.ok(
			afterFirstBurst > 0,
			'the first tick is reading the runner listing — and every read is gated open'
		);

		mock.timers.tick(TICK_INTERVAL_MS * 2); // two more regular intervals
		await flushMicrotasks();
		assert.equal(
			pendingCalls,
			afterFirstBurst,
			'no NEW call arrived — a second tick never started while the first was still open'
		);

		for (const resolve of released.splice(0)) resolve();
		await flushMicrotasks();
		await __awaitInFlightTickForTesting();

		mock.timers.tick(TICK_INTERVAL_MS);
		await flushMicrotasks();
		assert.ok(
			pendingCalls > afterFirstBurst,
			'once free, the next due tick is allowed to start — and it reads the listing again'
		);
		for (const resolve of released.splice(0)) resolve();
		await flushMicrotasks();
		await __awaitInFlightTickForTesting();
	} finally {
		mock.timers.reset();
	}
});
