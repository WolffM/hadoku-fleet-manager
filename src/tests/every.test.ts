/**
 * `src/lib/every.ts` — the one timer primitive for the fleet's control loops
 * (wave5j-2026-10-31 lane D, plan §6.2 tier 1). These are the primitive's own
 * unit tests, with a mutation count per behaviour in each describing comment:
 * remove the guard the test names and that specific test — not a neighbour —
 * must fail.
 *
 * Mocked clock throughout (`mock.timers`), per AGENTS.md's "prefer mocked
 * timers / a frozen clock" — nothing here depends on wall time.
 */
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';
import {
	every,
	subCadence,
	subCadenceDue,
	markSubCadence,
	__resetSubCadenceForTesting,
	__resetSubCadenceKeyForTesting,
} from '../lib/every.js';
import { getFleetLiveness, __resetLivenessForTesting } from '../lib/liveness.js';

/**
 * A `.then().catch().finally()` chain needs one real microtask turn PER link
 * to fully settle once its source promise resolves — `await Promise.resolve()`
 * once or twice is not reliably enough. `setImmediate` is not among the mocked
 * APIs below, so awaiting one is a real macrotask: by the time it fires, every
 * microtask queued before it (the whole chain) has drained.
 */
function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

let warns: string[] = [];

beforeEach(() => {
	warns = [];
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn: (m) => warns.push(m), error() {} },
	});
	__resetLivenessForTesting();
	__resetSubCadenceForTesting();
	mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
});
afterEach(() => {
	mock.timers.reset();
	__setHostForTesting(testHost);
});

// ── schedule: firstRunMs / intervalMs ───────────────────────────────────────

void test('every: no firstRunMs — plain setInterval semantics, no immediate tick', () => {
	let calls = 0;
	const h = every('t', 1000, () => {
		calls++;
	});
	assert.equal(calls, 0, 'nothing fires on the call that starts the loop');
	mock.timers.tick(999);
	assert.equal(calls, 0);
	mock.timers.tick(1);
	assert.equal(calls, 1, 'the first tick lands exactly at one interval');
	mock.timers.tick(1000);
	assert.equal(calls, 2);
	h.stop();
});

void test('every: firstRunMs 0 ticks SYNCHRONOUSLY, before every() returns — no microtask, no timer', () => {
	let calls = 0;
	const h = every(
		't',
		1000,
		() => {
			calls++;
		},
		{ firstRunMs: 0 }
	);
	// Asserted with NO tick()/await between the call and here — this is the
	// exact shape `fleet-loop.test.ts`'s "a token present at boot ticks
	// immediately" pins against the real loop.
	assert.equal(calls, 1, 'the first tick already ran');
	mock.timers.tick(999);
	assert.equal(calls, 1, 'nothing re-runs before the interval');
	mock.timers.tick(1);
	assert.equal(calls, 2);
	h.stop();
});

void test('every: firstRunMs > 0 waits that long, then the regular interval takes over', () => {
	let calls = 0;
	const h = every(
		't',
		1000,
		() => {
			calls++;
		},
		{ firstRunMs: 250 }
	);
	assert.equal(calls, 0);
	mock.timers.tick(249);
	assert.equal(calls, 0);
	mock.timers.tick(1);
	assert.equal(calls, 1, 'the delayed first tick fires');
	mock.timers.tick(1000);
	assert.equal(calls, 2, 'the ordinary interval starts counting from the first tick');
	h.stop();
});

void test('every: stop() cancels every pending timer — no tick fires after it', () => {
	let calls = 0;
	const h = every('t', 1000, () => {
		calls++;
	});
	h.stop();
	mock.timers.tick(10_000);
	assert.equal(calls, 0);
});

void test('every: stop() during the firstRunMs wait cancels that pending tick too', () => {
	let calls = 0;
	const h = every(
		't',
		1000,
		() => {
			calls++;
		},
		{ firstRunMs: 500 }
	);
	mock.timers.tick(100);
	h.stop();
	mock.timers.tick(10_000);
	assert.equal(calls, 0);
});

// ── overlap guard — MUTATION: delete the `inFlight` check in every.ts's
// `runOnce` and this test fails (two calls instead of one). ─────────────────

void test('every: a tick still in flight when the next is due is SKIPPED, never stacked', async () => {
	let starts = 0;
	let resolveFirst: (() => void) | undefined;
	const h = every(
		't',
		100,
		() =>
			new Promise<void>((res) => {
				starts++;
				resolveFirst = res;
			}),
		{ firstRunMs: 0 }
	);
	assert.equal(starts, 1, 'the immediate first tick started');
	mock.timers.tick(300); // three more intervals could have fired
	assert.equal(starts, 1, 'none did — the first tick never resolved');
	resolveFirst?.();
	await flushMicrotasks();
	mock.timers.tick(100);
	assert.equal(starts, 2, 'once free, the very next due tick is allowed to start');
	h.stop();
});

// ── liveness: registerLoop at call time, noteTick only on a completed tick —
// MUTATION: call noteTick before `tick()` resolves (e.g. from inside the
// `.catch`) and the "never on a throw" test below fails. ───────────────────

void test('every: registers liveness immediately, as `pending`, before any tick has run', () => {
	const h = every('live-a', 60_000, () => {});
	const loop = getFleetLiveness().loops.find((l) => l.name === 'live-a');
	assert.equal(loop?.status, 'pending');
	assert.equal(loop?.lastTickAt, null);
	h.stop();
});

void test('every: a completed tick notes liveness — status flips to ok (noteTick default true)', async () => {
	const h = every('live-b', 60_000, () => Promise.resolve(), { firstRunMs: 0 });
	await flushMicrotasks();
	const loop = getFleetLiveness().loops.find((l) => l.name === 'live-b');
	assert.equal(loop?.status, 'ok');
	assert.notEqual(loop?.lastTickAt, null);
	h.stop();
});

void test('every: { noteTick: false } never notes — status stays pending forever, even after a clean tick', async () => {
	const h = every('live-c', 60_000, () => Promise.resolve(), {
		firstRunMs: 0,
		noteTick: false,
	});
	await flushMicrotasks();
	const loop = getFleetLiveness().loops.find((l) => l.name === 'live-c');
	assert.equal(loop?.status, 'pending', 'the caller owns noting this tick, and nothing has yet');
	assert.equal(loop?.lastTickAt, null);
	h.stop();
});

void test('every: a tick that THROWS synchronously is never noted — liveness stays pending, not ok', async () => {
	const h = every(
		'live-d',
		60_000,
		() => {
			throw new Error('boom');
		},
		{ firstRunMs: 0 }
	);
	await flushMicrotasks();
	const loop = getFleetLiveness().loops.find((l) => l.name === 'live-d');
	assert.equal(loop?.status, 'pending', 'a throw must never read as alive');
	assert.ok(
		warns.some((w) => w.includes('boom')),
		'and the throw is logged, not swallowed silently'
	);
	h.stop();
});

void test('every: a tick that REJECTS asynchronously is never noted either', async () => {
	const h = every('live-e', 60_000, () => Promise.reject(new Error('async boom')), {
		firstRunMs: 0,
	});
	await flushMicrotasks();
	const loop = getFleetLiveness().loops.find((l) => l.name === 'live-e');
	assert.equal(loop?.status, 'pending');
	assert.ok(warns.some((w) => w.includes('async boom')));
	h.stop();
});

void test('every: a throw does not kill the loop — the next scheduled tick still runs', async () => {
	let calls = 0;
	const h = every(
		't',
		100,
		() => {
			calls++;
			if (calls === 1) throw new Error('first one is bad');
		},
		{ firstRunMs: 0 }
	);
	await flushMicrotasks();
	assert.equal(calls, 1);
	mock.timers.tick(100);
	await flushMicrotasks();
	assert.equal(calls, 2, 'the loop kept going after the throw');
	h.stop();
});

// ── tokenWait ────────────────────────────────────────────────────────────────

void test('every: tokenWait — no schedule starts at all while the token is missing', () => {
	let calls = 0;
	let token: string | undefined;
	const h = every(
		't',
		1000,
		() => {
			calls++;
		},
		{ firstRunMs: 0, tokenWait: { getToken: () => token, retryMs: 10 } }
	);
	try {
		mock.timers.tick(1000);
		assert.equal(calls, 0, 'no tick without a token, no matter how long we wait');
		token = 'tok';
		mock.timers.tick(10); // the next retry
		assert.equal(calls, 1, 'the schedule starts the instant the token is seen');
	} finally {
		h.stop();
	}
});

void test('every: tokenWait — onWaiting fires once, onReady fires once with the wait duration', () => {
	let waitingCalls = 0;
	let readyMs: number | undefined;
	let token: string | undefined;
	const h = every('t', 1000, () => {}, {
		firstRunMs: 0,
		tokenWait: {
			getToken: () => token,
			retryMs: 10,
			onWaiting: () => waitingCalls++,
			onReady: (ms) => {
				readyMs = ms;
			},
		},
	});
	try {
		mock.timers.tick(10);
		mock.timers.tick(10);
		assert.equal(waitingCalls, 1, 'onWaiting is a one-shot, not re-logged on every retry');
		token = 'tok';
		mock.timers.tick(10);
		assert.equal(readyMs, 30, 'onReady reports the full wait, in ms');
	} finally {
		h.stop();
	}
});

void test('every: tokenWait — a token present on the FIRST check never calls onWaiting or onReady', () => {
	let waitingCalls = 0;
	let readyCalls = 0;
	const h = every('t', 1000, () => {}, {
		firstRunMs: 0,
		tokenWait: {
			getToken: () => 'tok',
			retryMs: 10,
			onWaiting: () => waitingCalls++,
			onReady: () => readyCalls++,
		},
	});
	assert.equal(waitingCalls, 0);
	assert.equal(readyCalls, 0);
	h.stop();
});

void test('every: tokenWait registers liveness before the wait, not after it resolves', () => {
	const h = every('live-f', 60_000, () => {}, {
		tokenWait: { getToken: () => undefined, retryMs: 10 },
	});
	const loop = getFleetLiveness().loops.find((l) => l.name === 'live-f');
	assert.equal(
		loop?.status,
		'pending',
		'registered even though the token never arrives in this test'
	);
	h.stop();
});

void test('every: { registerLiveness: false } — every() does not call registerLoop at all; an EARLIER manual call still stands', async () => {
	const { registerLoop } = await import('../lib/liveness.js');
	// A manual registration, as if the caller did this itself at an earlier
	// moment (runner-health.ts's own token wait, which every() does not own).
	registerLoop('live-g', 999, { firstTickGraceMs: 12_345 });
	mock.timers.tick(5_000); // time passes BETWEEN the manual registration and every()
	const h = every('live-g', 60_000, () => {}, { registerLiveness: false });
	const after = getFleetLiveness().loops.find((l) => l.name === 'live-g');

	assert.equal(after?.expectedMs, 999, "every()'s OWN intervalMs (60,000) never overwrote it");
	assert.equal(
		after?.ageMs,
		5_000,
		'registeredAtMs is still the manual call: if every() had re-registered just now, ageMs would be 0'
	);
	h.stop();
});

// ── seedInFlight ─────────────────────────────────────────────────────────────
//
// `runner-health.ts`'s manual first tick runs BEFORE `every()` is ever
// called (its own boot args don't fit a generic per-call `tick`), which made
// it invisible to the overlap guard: the first REGULAR interval could start
// a SECOND `runTick` while that manual one was still running — a real
// overlap `every()` otherwise prevents (caught by the "ONGOING interval"
// integration test in `runner-health-every.test.ts`, which failed without
// this before the fix). MUTATION: delete the `opts.seedInFlight` block in
// every.ts and the first test below fails (two starts, not one).

void test('every: seedInFlight occupies the guard until it settles — the schedule`s first tick waits for it', async () => {
	let starts = 0;
	const seed = new Promise<void>(() => {}); // never settles, for this half of the test
	const h = every(
		't',
		100,
		() => {
			starts++;
		},
		{ seedInFlight: seed }
	);
	mock.timers.tick(1000); // ten intervals could have fired
	await flushMicrotasks();
	assert.equal(starts, 0, 'the schedule never ran — the seed is still occupying the guard');
	h.stop();
});

void test('every: once the seed settles, the schedule runs normally — on the NEXT due interval, not immediately', async () => {
	let starts = 0;
	let resolveSeed: (() => void) | undefined;
	const seed = new Promise<void>((res) => {
		resolveSeed = res;
	});
	const h = every(
		't',
		100,
		() => {
			starts++;
		},
		{ seedInFlight: seed }
	);
	mock.timers.tick(50);
	resolveSeed?.();
	await flushMicrotasks();
	assert.equal(starts, 0, 'the seed settling does not itself trigger a tick');
	mock.timers.tick(50); // the interval's first due firing, now that the seed is clear
	await flushMicrotasks();
	assert.equal(starts, 1);
	h.stop();
});

void test('every: a REJECTED seed still clears the guard, and never surfaces as an unhandled rejection', async () => {
	let starts = 0;
	const seed = Promise.reject(new Error('seed failed elsewhere'));
	const h = every(
		't',
		100,
		() => {
			starts++;
		},
		{ seedInFlight: seed }
	);
	await flushMicrotasks();
	mock.timers.tick(100);
	await flushMicrotasks();
	assert.equal(starts, 1, 'the guard cleared even though the seed rejected');
	h.stop();
});

// ── subCadence ───────────────────────────────────────────────────────────────

void test('subCadence: never asked before — due, and marks itself run', () => {
	assert.equal(subCadence('gate-a', 1000, 0), true);
	assert.equal(subCadence('gate-a', 1000, 1), false, 'asked again a ms later: not due yet');
});

void test('subCadence: due again once the window elapses, not a moment before it', () => {
	subCadence('gate-b', 1000, 0);
	assert.equal(subCadence('gate-b', 1000, 999), false);
	assert.equal(subCadence('gate-b', 1000, 1000), true);
});

void test('subCadence: a due answer marks `now` as the new last-run, not the old one', () => {
	subCadence('gate-c', 1000, 0);
	assert.equal(subCadence('gate-c', 1000, 1000), true); // marks 1000 as last-run
	assert.equal(
		subCadence('gate-c', 1000, 1999),
		false,
		'measured from the SECOND run, not the first'
	);
});

void test('subCadence: independent gates by name do not interfere', () => {
	assert.equal(subCadence('x', 1000, 0), true);
	assert.equal(subCadence('y', 1000, 0), true, 'a different name starts cold too');
	assert.equal(subCadence('x', 1000, 1), false);
	assert.equal(subCadence('y', 1000, 1), false);
});

// ── subCadenceDue / markSubCadence (the check and the mark, split) ──────────

void test('subCadenceDue: never marks, however many times it is asked', () => {
	assert.equal(subCadenceDue('gate-d', 1000, 0), true);
	assert.equal(subCadenceDue('gate-d', 1000, 1), true, 'still due — the check alone never marks');
	assert.equal(subCadenceDue('gate-d', 1000, 999), true);
});

void test('markSubCadence: marks without asking whether it was due', () => {
	markSubCadence('gate-e', 500);
	assert.equal(subCadenceDue('gate-e', 1000, 500), false, 'marked, so not due a moment later');
	assert.equal(subCadenceDue('gate-e', 1000, 1499), false);
	assert.equal(subCadenceDue('gate-e', 1000, 1500), true);
});

void test('subCadenceDue + markSubCadence composes to subCadence’s own answer', () => {
	// The split primitives, driven by hand, must retrace subCadence's shape:
	// due, mark, not due until the window elapses, due again once it has.
	const name = 'gate-f';
	assert.equal(subCadenceDue(name, 1000, 0), true);
	markSubCadence(name, 0);
	assert.equal(subCadenceDue(name, 1000, 1), false);
	assert.equal(subCadenceDue(name, 1000, 999), false);
	assert.equal(subCadenceDue(name, 1000, 1000), true);
});

void test('subCadenceDue: a gate the caller never marks stays due forever — the failed-sweep case', () => {
	// backstop-decision.ts's convergeDue: a check that is never followed by a
	// mark (because the work it gated failed) must answer due again on the
	// very next ask, not wait out the window.
	const name = 'gate-g';
	assert.equal(subCadenceDue(name, 1000, 0), true);
	assert.equal(subCadenceDue(name, 1000, 1), true, 'nothing marked it — still due');
	assert.equal(subCadenceDue(name, 1000, 500), true);
});

void test('__resetSubCadenceKeyForTesting: clears only the named gate', () => {
	markSubCadence('gate-h1', 0);
	markSubCadence('gate-h2', 0);
	__resetSubCadenceKeyForTesting('gate-h1');
	assert.equal(subCadenceDue('gate-h1', 1000, 1), true, 'cleared');
	assert.equal(subCadenceDue('gate-h2', 1000, 1), false, 'its sibling must be untouched');
});
