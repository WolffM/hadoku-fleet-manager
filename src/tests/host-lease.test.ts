import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
	MAX_LEASE_SECONDS,
	__resetLeasesForTesting,
	activeLeases,
	releaseLease,
	takeLease,
} from '../host-lease.js';
import { __resetReservationForTesting, nodeReservation } from '../node-reservation.js';

beforeEach(() => {
	__resetLeasesForTesting();
	__resetReservationForTesting();
});

test('a held lease reserves the host, and names its holder', () => {
	takeLease('local-daily', 600);
	const r = nodeReservation(new Date(), false, []);
	assert.equal(r.reserved, true);
	assert.equal(r.reason, 'host-lease');
	assert.match(r.detail ?? '', /local-daily/);
});

test('a released lease frees the host', () => {
	const l = takeLease('local-daily', 600);
	assert.equal(releaseLease(l.id), true);
	assert.equal(nodeReservation(new Date(), false, []).reserved, false);
	assert.equal(releaseLease(l.id), false, 'a second release is a no-op, not an error');
});

test('EVERY lease expires — a holder that crashed cannot keep the host off CI', () => {
	const now = 1_000_000;
	takeLease('crashed-job', 60, now);
	assert.equal(activeLeases(now + 59_000).length, 1);
	assert.equal(activeLeases(now + 60_000).length, 0, 'expired at its deadline');
	assert.equal(nodeReservation(new Date(now + 61_000), false, []).reserved, false);
});

test('a ttl longer than the cap is clamped to it', () => {
	const now = 0;
	const l = takeLease('greedy', MAX_LEASE_SECONDS * 10, now);
	assert.equal(l.until, MAX_LEASE_SECONDS * 1000);
});
