import test from 'node:test';
import assert from 'node:assert/strict';

import { FAIL_SECONDS } from './queue-health.mjs';
import {
	DEFAULT_POLL_POLICY,
	SATURATED_QUEUED_MS,
	MIN_QUEUED_MS,
} from '../../dist/runners/queue-discovery.js';
import { PENDING_INTERVAL_MS } from '../../dist/runners/dispatch-tick.js';

/**
 * THE TWO NUMBERS THAT CONTRADICTED EACH OTHER.
 *
 * `ci:queue-health` fails a run queued longer than FAIL_SECONDS. The dispatcher
 * cannot serve a run it has not DISCOVERED, and a cold repo is discovered only
 * every `coldIntervalMs`. On 2026-09-02 that was 600 s against a 300 s floor, so
 * a job in any of ~24 cold repos aged past the gate before anything could look
 * at it — while every dispatch tick reported `minted == queued`, because the
 * fleet was serving perfectly everything it could see.
 *
 * Both constants were defensible alone. Nothing compared them, and the gate's
 * own budget comment never mentioned discovery at all. This is that comparison.
 */
const MINT_SECONDS = 9; // measured; the ~9 s check-queue-health.mjs budgets

test('a cold repo is discovered, served and running before queue-health fails it', () => {
	const worstServeSeconds =
		DEFAULT_POLL_POLICY.coldIntervalMs / 1000 + SATURATED_QUEUED_MS / 1000 + MINT_SECONDS;
	assert.ok(
		worstServeSeconds < FAIL_SECONDS,
		`the coldest repo takes ${worstServeSeconds}s to serve but ci:queue-health fails at ` +
			`${FAIL_SECONDS}s — the gate would go red on a healthy fleet. Lower coldIntervalMs ` +
			`(currently ${DEFAULT_POLL_POLICY.coldIntervalMs}ms) or raise FAIL_SECONDS, but do not ` +
			`leave them contradicting each other.`
	);
});

test('even the UNSHORTENED age gate leaves headroom under the floor', () => {
	// `urgent` shortens MIN_QUEUED_MS to SATURATED_QUEUED_MS, and an all-JIT fleet
	// is always urgent because no standing capacity sits above an ephemeral node.
	// If that ever stops being true the long gate applies, so it must fit too.
	const worst = DEFAULT_POLL_POLICY.coldIntervalMs / 1000 + MIN_QUEUED_MS / 1000 + MINT_SECONDS;
	assert.ok(
		worst < FAIL_SECONDS,
		`with the full ${MIN_QUEUED_MS / 1000}s age gate a cold repo takes ${worst}s, over the ` +
			`${FAIL_SECONDS}s floor — the fleet would fail its own gate whenever standing capacity returns.`
	);
});

// The bug that made "uniform 60s" measure as no change: reposDue is consulted
// only when the fast loop ticks, so a repo polled DURING a tick is not yet due
// when the next one asks, and waits for the one after. Interval == tick period
// polls everything every OTHER tick.
// The DISPATCHER's timer, not the ladder's. They were the same thing until
// 2026-09-05; `dispatchSeconds` defaults to 15 and floors at 5 in
// startFastLoop. Pointing this at the ladder's 60s is what let the poll
// interval quietly exceed the tick that actually consults it.
const TICK_SECONDS = 15;

test('the poll interval is strictly below the tick period', () => {
	for (const [name, ms] of [
		['hotIntervalMs', DEFAULT_POLL_POLICY.hotIntervalMs],
		['coldIntervalMs', DEFAULT_POLL_POLICY.coldIntervalMs],
	]) {
		assert.ok(
			ms / 1000 < TICK_SECONDS,
			`${name} is ${ms / 1000}s against a ${TICK_SECONDS}s DISPATCH tick — a repo polled during a tick ` +
				`is not due when the next one asks, so the REAL cadence is ${TICK_SECONDS * 2}s. ` +
				`Measured 2026-09-02: 89s of queue on a fleet whose mint took 3s.`
		);
	}
});

test('hot repos are polled at least as often as cold ones', () => {
	assert.ok(DEFAULT_POLL_POLICY.hotIntervalMs <= DEFAULT_POLL_POLICY.coldIntervalMs);
});

test('a PENDING run with a job waiting is served before queue-health calls it invisible', () => {
	// fleet-manager#11. The pending listing has its own slower clock, so its
	// worst case is that clock plus the tick it fires on, not the poll interval.
	// The job must also clear the full age gate, which the interval already
	// covers as long as it is the longer of the two.
	const worst = Math.max(PENDING_INTERVAL_MS, MIN_QUEUED_MS) / 1000 + TICK_SECONDS + MINT_SECONDS;
	assert.ok(
		worst < FAIL_SECONDS,
		`a pending run's job can wait ${worst}s for the dispatcher but ci:queue-health calls it ` +
			`invisible at ${FAIL_SECONDS}s. Lower PENDING_INTERVAL_MS (${PENDING_INTERVAL_MS}ms).`
	);
});
