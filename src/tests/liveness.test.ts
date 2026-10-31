import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';

import {
	getFleetLiveness,
	noteTick,
	registerLoop,
	STALE_FLOOR_MS,
	STALE_MULTIPLIER,
	TOKEN_WAIT_GRACE_MS,
	__resetLivenessForTesting,
} from '../lib/liveness.js';

/**
 * The ledger stamps ticks and registrations with Date.now(). A test that read
 * its own `atMs` a millisecond earlier made every exact-boundary check off by
 * one under load (the 400-days-ahead clock rerun failed on 10-31), so each
 * boundary test FREEZES the clock at its `atMs`; this puts it back.
 */
const REAL_NOW = Date.now;
afterEach(() => {
	Date.now = REAL_NOW;
});
function freezeNow(): number {
	const at = REAL_NOW();
	Date.now = () => at;
	return at;
}

// Every test resets the module's shared state first: it is a singleton by
// design (one ledger per process, matching the thing it describes — see the
// file's own header), so a prior test's loop would otherwise leak into the
// next one's assertion, exactly the `sickNodes`/`believedLabel` hazard
// `fleet-loop.ts` already documents for its own cross-tick state.
function reset(): void {
	__resetLivenessForTesting();
}

test('a loop that was NEVER registered and never ticked is absent from `loops` entirely', () => {
	reset();
	noteTick('fast-loop-stub', 60_000);
	const liveness = getFleetLiveness();
	// Only the loop that actually ticked appears. A name this test never
	// called `noteTick` OR `registerLoop` for must not show up at all.
	assert.deepEqual(
		liveness.loops.map((l) => l.name),
		['fast-loop-stub']
	);
	assert.equal(
		liveness.loops.find((l) => l.name === 'dispatch-stub'),
		undefined
	);
});

test('a REGISTERED loop that has not ticked yet is PENDING, with lastTickAt null — never reported as stale inside its grace', () => {
	reset();
	registerLoop('runner-health-stub', 600_000, { firstTickGraceMs: TOKEN_WAIT_GRACE_MS });
	const liveness = getFleetLiveness(); // immediately — this IS the boot case
	const loop = liveness.loops.find((l) => l.name === 'runner-health-stub');
	assert.ok(loop);
	assert.equal(loop.status, 'pending');
	assert.equal(loop.stale, false);
	assert.equal(loop.lastTickAt, null);
});

test('a registered-never-ticked loop goes STALE once past its threshold + first-tick grace — with lastTickAt still null', () => {
	reset();
	const atMs = freezeNow();
	// expectedMs=15_000 (dispatch-shaped) -> threshold = STALE_FLOOR_MS (60s;
	// the floor binds, 3*15_000=45_000 < 60_000). Grace adds TOKEN_WAIT_GRACE_MS.
	registerLoop('dispatch-stub', 15_000, { firstTickGraceMs: TOKEN_WAIT_GRACE_MS });
	const grace = STALE_FLOOR_MS + TOKEN_WAIT_GRACE_MS;
	const stillPending = getFleetLiveness(atMs + grace);
	assert.equal(
		stillPending.loops.find((l) => l.name === 'dispatch-stub')?.status,
		'pending',
		'exactly at the line is not yet stale — strict `>`, same rule as an ordinary tick'
	);
	const nowStale = getFleetLiveness(atMs + grace + 1);
	const loop = nowStale.loops.find((l) => l.name === 'dispatch-stub');
	assert.ok(loop);
	assert.equal(loop.status, 'stale');
	assert.equal(loop.stale, true);
	assert.equal(loop.lastTickAt, null, 'stale from never ticking, not from a stale TICK');
	assert.equal(
		loop.ageMs,
		grace + 1,
		'ageMs falls back to time since REGISTRATION when there is no tick'
	);
});

test('a restart (fresh registeredAt) is PENDING again, never stale, even if the prior process had been stuck for a long time', () => {
	reset();
	const atMs = freezeNow();
	registerLoop('runner-health-stub', 600_000, { firstTickGraceMs: TOKEN_WAIT_GRACE_MS });
	// Simulate a long stuck boot: well past where THIS registration would be stale.
	const grace = Math.max(600_000 * STALE_MULTIPLIER, STALE_FLOOR_MS) + TOKEN_WAIT_GRACE_MS;
	assert.equal(
		getFleetLiveness(atMs + grace + 1).loops.find((l) => l.name === 'runner-health-stub')?.status,
		'stale'
	);
	// The restart: registerLoop runs again, at the top of the NEW process's
	// start*() — resetting registeredAt to "now" exactly the way a real
	// restart would (the old TickRecord/registration cannot survive a
	// process exit; this call is the equivalent of that fresh start). Checked
	// against the REAL current time (registerLoop's own clock), not the old
	// `atMs` — the whole point is that the new registration's clock is fresh.
	registerLoop('runner-health-stub', 600_000, { firstTickGraceMs: TOKEN_WAIT_GRACE_MS });
	const afterRestart = getFleetLiveness();
	const loop = afterRestart.loops.find((l) => l.name === 'runner-health-stub');
	assert.ok(loop);
	assert.equal(loop.status, 'pending', 'a restart must not page');
	assert.equal(loop.stale, false);
});

test('registerLoop then a real tick: the tick wins — status reflects the tick, not the registration', () => {
	reset();
	registerLoop('fleet-loop-stub', 60_000, { firstTickGraceMs: TOKEN_WAIT_GRACE_MS });
	noteTick('fleet-loop-stub', 60_000);
	const loop = getFleetLiveness().loops.find((l) => l.name === 'fleet-loop-stub');
	assert.ok(loop);
	assert.notEqual(loop.lastTickAt, null);
	assert.equal(loop.status, 'ok');
});

test('a tick well inside its own cadence is not stale', () => {
	reset();
	noteTick('dispatch-stub', 15_000);
	const liveness = getFleetLiveness(Date.now() + 1_000); // 1s later
	const loop = liveness.loops.find((l) => l.name === 'dispatch-stub');
	assert.ok(loop);
	assert.equal(loop.stale, false);
	assert.equal(loop.status, 'ok');
	assert.equal(loop.expectedMs, 15_000);
});

test('age past STALE_MULTIPLIER x expectedMs (above the floor) is stale; at or under the line is not', () => {
	reset();
	// expectedMs=600_000 (runner-health's real cadence) -> threshold =
	// max(STALE_MULTIPLIER*600_000, STALE_FLOOR_MS), well above the floor.
	const atMs = freezeNow();
	noteTick('runner-health-stub', 600_000);
	const threshold = STALE_MULTIPLIER * 600_000;
	assert.ok(
		threshold > STALE_FLOOR_MS,
		'this test only proves the multiplier when it, not the floor, binds'
	);
	const notYetStale = getFleetLiveness(atMs + threshold); // exactly the line
	assert.equal(
		notYetStale.loops.find((l) => l.name === 'runner-health-stub')?.stale,
		false,
		'exactly at the threshold must not yet be stale — the comparison is strict `>`'
	);
	const stale = getFleetLiveness(atMs + threshold + 1);
	assert.equal(
		stale.loops.find((l) => l.name === 'runner-health-stub')?.stale,
		true,
		'one ms past the threshold must be stale'
	);
});

test('the floor protects a short-cadence loop from ordinary jitter past its raw 3x', () => {
	reset();
	// expectedMs=100ms -> 3x is only 300ms, far under STALE_FLOOR_MS (60s).
	// Without the floor, a loop ticking every 100ms would read stale after
	// one slow pass; the floor is what stops that.
	const atMs = freezeNow();
	noteTick('fast-stub', 100);
	const underFloor = getFleetLiveness(atMs + (STALE_FLOOR_MS - 1));
	assert.equal(
		underFloor.loops.find((l) => l.name === 'fast-stub')?.stale,
		false,
		'still under the floor, even though far past 3x the tiny expectedMs'
	);
	const overFloor = getFleetLiveness(atMs + STALE_FLOOR_MS + 1);
	assert.equal(
		overFloor.loops.find((l) => l.name === 'fast-stub')?.stale,
		true,
		'past the floor, it is stale'
	);
});

test('two loops are tracked independently — each judged by its OWN cadence, not a shared one', () => {
	reset();
	const atMs = freezeNow();
	// Both last ticked at the same instant; only their declared cadence
	// differs — exactly the real shape (dispatch's 15s vs runner-health's
	// 10min), so one loop's threshold must not leak into the other's.
	noteTick('fast-cadence-stub', 60_000); // fast-loop-shaped: threshold 3min
	noteTick('slow-cadence-stub', 600_000); // runner-health-shaped: threshold 30min
	const liveness = getFleetLiveness(atMs + 10 * 60_000); // 10 minutes later, for both
	const fast = liveness.loops.find((l) => l.name === 'fast-cadence-stub');
	const slow = liveness.loops.find((l) => l.name === 'slow-cadence-stub');
	assert.equal(fast?.stale, true, '10min silence on a 60s-cadence loop (3min threshold) IS stale');
	assert.equal(
		slow?.stale,
		false,
		'10min silence on a 10min-cadence loop (30min threshold) is NOT yet stale'
	);
});

test('lastTickAt is an ISO timestamp matching the recorded instant, and ageMs tracks `now`', () => {
	reset();
	const before = Date.now();
	noteTick('iso-stub', 1_000);
	const liveness = getFleetLiveness(before + 5_000);
	const loop = liveness.loops.find((l) => l.name === 'iso-stub');
	assert.ok(loop);
	assert.ok(loop.lastTickAt !== null);
	const recordedMs = Date.parse(loop.lastTickAt);
	assert.ok(recordedMs >= before && recordedMs <= Date.now());
	assert.ok(loop.ageMs >= 5_000 && loop.ageMs < 5_000 + 1_000); // generous slack for test runtime
});

test('startedAt is a stable ISO timestamp (module load time), unaffected by resets', () => {
	reset();
	const a = getFleetLiveness().startedAt;
	noteTick('whatever', 1_000);
	const b = getFleetLiveness().startedAt;
	assert.equal(a, b);
	assert.ok(!Number.isNaN(Date.parse(a)));
});

test('loops are reported in a stable, sorted order, mixing ticked and pending-registered loops', () => {
	reset();
	noteTick('zeta', 1_000);
	registerLoop('beta', 1_000);
	noteTick('mu', 1_000);
	registerLoop('alpha', 1_000);
	const names = getFleetLiveness().loops.map((l) => l.name);
	assert.deepEqual(names, ['alpha', 'beta', 'mu', 'zeta']);
});
