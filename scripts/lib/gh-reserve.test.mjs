/**
 * gh-reserve — the floor every bulk gate checks before spending the shared
 * GitHub pool (fleet-manager#9). The read is injected; the end-to-end refusal
 * through a real gate is in check-history-coverage.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGhReserve, GH_RESERVE, reserveFloor } from './gh-reserve.mjs';

const RESET_MS = Date.now() + 20 * 60_000;
const RESET_HHMM = new Date(RESET_MS).toISOString().slice(11, 16);
const pool = (remaining) => () => ({ remaining, resetAtMs: RESET_MS });

test('under the reserve: NOT RUN, and the reason says it is could-not-look, not a pass', () => {
	const r = checkGhReserve('history-coverage', { floor: GH_RESERVE, read: pool(GH_RESERVE - 1) });
	assert.equal(r.ok, false);
	assert.equal(r.remaining, GH_RESERVE - 1);
	assert.match(r.reason, /^history-coverage NOT RUN: 1499 GitHub calls left/);
	assert.match(r.reason, /"could not look", not a pass/);
	assert.ok(r.reason.includes(`resets at ${RESET_HHMM}Z`), r.reason);
	assert.match(r.reason, /FLEET_GH_RESERVE=0/);
});

test('the reserve is a floor: exactly the reserve left still runs', () => {
	const r = checkGhReserve('reconcile', { floor: GH_RESERVE, read: pool(GH_RESERVE) });
	assert.deepEqual(r, { ok: true, remaining: GH_RESERVE, floor: GH_RESERVE });
});

test('an unreadable budget does not refuse — the gate’s own first call names the real fault', () => {
	const r = checkGhReserve('reconcile', { floor: GH_RESERVE, read: () => null });
	assert.equal(r.ok, true);
	assert.equal(r.remaining, null);
});

test('a floor of 0 is off: the pool is not even read', () => {
	let reads = 0;
	const r = checkGhReserve('reconcile', { floor: 0, read: () => (reads++, null) });
	assert.equal(r.ok, true);
	assert.equal(reads, 0);
});

test('FLEET_GH_RESERVE sets the floor; anything but a whole number keeps the default', () => {
	assert.equal(reserveFloor({}), GH_RESERVE);
	assert.equal(reserveFloor({ FLEET_GH_RESERVE: '' }), GH_RESERVE);
	assert.equal(reserveFloor({ FLEET_GH_RESERVE: '0' }), 0);
	assert.equal(reserveFloor({ FLEET_GH_RESERVE: '400' }), 400);
	assert.equal(reserveFloor({ FLEET_GH_RESERVE: '-5' }), GH_RESERVE);
	assert.equal(reserveFloor({ FLEET_GH_RESERVE: 'lots' }), GH_RESERVE);
	assert.equal(reserveFloor({ FLEET_GH_RESERVE: '1.5' }), GH_RESERVE);
});
