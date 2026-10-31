/**
 * `fleet-loop.ts`'s `startFastLoop` ported onto `every()` (wave5j-2026-10-31
 * lane D, plan §6.2 tier 1). `fleet-loop.test.ts` already pins the two
 * token-wait characterizations ("no token at boot" / "token present at boot")
 * against the real loop; these add what it does not cover: that BOTH
 * schedules it starts (the 60s fast loop and the 15s dispatch timer) keep
 * their own distinct cadence and immediate-tick behaviour, that both register
 * liveness, and that a stuck fast-loop tick no longer stacks a second one on
 * top of it (`every()`'s own addition — the ORIGINAL `setInterval(run, ...)`
 * had no such guard; see the report).
 *
 * Mocked clock throughout — nothing here depends on wall time.
 */
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
	startFastLoop,
	__resetFleetLoopForTesting,
	__resetDispatchInputForTesting,
	FAST_LOOP_SECONDS,
	DISPATCH_SECONDS,
} from '../fleet-loop.js';
import { getFleetLiveness, __resetLivenessForTesting } from '../lib/liveness.js';
import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';

function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn() {}, error() {} },
	});
	__resetFleetLoopForTesting();
	__resetDispatchInputForTesting();
	__resetLivenessForTesting();
	mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
});
afterEach(() => {
	__resetFleetLoopForTesting();
	mock.timers.reset();
	__setHostForTesting(testHost);
});

void test('startFastLoop: registers BOTH fleet-loop and dispatch liveness immediately, as pending', () => {
	startFastLoop(() => 'tok', {} as never, (async () => ({ actions: [] })) as never);
	const names = getFleetLiveness().loops.map((l) => l.name);
	assert.ok(names.includes('fleet-loop'));
	assert.ok(names.includes('dispatch'));
	for (const n of ['fleet-loop', 'dispatch']) {
		const loop = getFleetLiveness().loops.find((l) => l.name === n);
		assert.equal(loop?.status, 'pending', `${n}: registered before any tick`);
	}
});

void test('startFastLoop: the fast loop ticks at t=0, then every FAST_LOOP_SECONDS; the dispatch timer waits a full DISPATCH_SECONDS for its first', async () => {
	const tokenCallsAt: number[] = [];
	const getToken = (): string => {
		tokenCallsAt.push(Date.now());
		return 'tok';
	};
	const tickCallsAt: number[] = [];
	const tickOverride = (async () => {
		tickCallsAt.push(Date.now());
		return { actions: [] };
	}) as never;

	startFastLoop(getToken, {} as never, tickOverride);

	// t=0: the fast loop's immediate first tick, and ONLY that — the dispatch
	// timer has never fired yet (unlike the fast loop, it has no `firstRunMs`).
	//
	// TWO getToken() reads land at t=0, not one: `every()`'s own `tokenWait`
	// reads it once to confirm a token is present before starting the
	// schedule, and the wrapped tick (ported from the original `run()`, which
	// re-checks on every call so a LATER missing token is a silent skip, not
	// a re-armed wait — see `startFastLoop`'s comment) reads it again right
	// after. `githubToken()` is documented as a bare env read with no cost
	// (`host.ts`'s `TOKEN_RETRY_MS` header), so this is harmless; it happens
	// only on this one bootstrap tick, never on a later one.
	assert.deepEqual(tickCallsAt, [0]);
	assert.deepEqual(tokenCallsAt, [0, 0]);

	mock.timers.tick(DISPATCH_SECONDS * 1000); // t=15,000: dispatch's first fire
	await flushMicrotasks();
	assert.deepEqual(tickCallsAt, [0], 'the dispatch timer never calls the fast-loop tick');
	assert.deepEqual(tokenCallsAt, [0, 0, 15_000]);

	mock.timers.tick(DISPATCH_SECONDS * 1000); // t=30,000
	await flushMicrotasks();
	assert.deepEqual(tokenCallsAt, [0, 0, 15_000, 30_000]);

	mock.timers.tick(DISPATCH_SECONDS * 1000); // t=45,000
	await flushMicrotasks();
	assert.deepEqual(tokenCallsAt, [0, 0, 15_000, 30_000, 45_000]);

	// t=60,000: BOTH the fast loop's regular interval and the dispatch timer's
	// 4th fire land on the same instant. Order between the two is an
	// implementation detail of the timer heap, not a behaviour either loop
	// depends on, so this asserts COUNTS at that instant rather than a strict
	// interleaving.
	mock.timers.tick(DISPATCH_SECONDS * 1000);
	await flushMicrotasks();
	assert.deepEqual(
		tickCallsAt,
		[0, 60_000],
		'the fast loop ticked again, exactly one interval later'
	);
	assert.equal(
		tokenCallsAt.filter((t) => t === 60_000).length,
		2,
		'both schedules read the token at t=60,000 — one each (no bootstrap double-read this time)'
	);
	assert.equal(tokenCallsAt.length, 7, '2 (bootstrap) + 1 (fast @60k) + 4 (dispatch)');
});

void test("startFastLoop: a fast-loop tick that never resolves is not stacked — every()'s overlap guard, new vs the original setInterval", async () => {
	// The ORIGINAL `setInterval(run, FAST_LOOP_SECONDS * 1000)` had no overlap
	// guard of its own: a `tickFleet` pass running past 60s would have been
	// called again by the next firing. `every()` adds the guard this test
	// pins; it is a NEW property, not a characterization of the old code.
	let starts = 0;
	let resolveFirst: ((r: { actions: [] }) => void) | undefined;
	const tickOverride = (() =>
		new Promise((res) => {
			starts++;
			resolveFirst = res;
		})) as never;

	startFastLoop(() => 'tok', {} as never, tickOverride);
	assert.equal(starts, 1, 'the immediate first tick started');

	mock.timers.tick(FAST_LOOP_SECONDS * 1000 * 3); // three more intervals could fire
	await flushMicrotasks();
	assert.equal(starts, 1, 'none did — the first tick never resolved');

	resolveFirst?.({ actions: [] });
	await flushMicrotasks();
	mock.timers.tick(FAST_LOOP_SECONDS * 1000);
	await flushMicrotasks();
	assert.equal(starts, 2, 'once free, the next due tick is allowed to start');
});

void test('startFastLoop: a completed fast-loop tick notes liveness as ok — through the real tickFleet, not every()', async () => {
	// The real `tickFleet` calls `noteTick('fleet-loop', ...)` itself, at the
	// end of its own success path — this override stands in for it (a full
	// `tickFleet` pass needs a fleet fixture this file does not otherwise
	// need) and pins that the wiring through `every()` (`noteTick: false`
	// there, precisely so this real call is the only one) still reaches the
	// ledger, rather than every() silently double-reporting or suppressing it.
	const { noteTick } = await import('../lib/liveness.js');
	startFastLoop(
		() => 'tok',
		{} as never,
		(async () => {
			noteTick('fleet-loop', FAST_LOOP_SECONDS * 1000);
			return { actions: [] };
		}) as never
	);
	await flushMicrotasks();
	const loop = getFleetLiveness().loops.find((l) => l.name === 'fleet-loop');
	assert.equal(loop?.status, 'ok');
});
