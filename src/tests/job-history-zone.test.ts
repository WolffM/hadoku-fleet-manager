/**
 * `isFleetKill` — the TTL kill that lands in a job's OWN step
 * (fleet-manager#121).
 *
 * The cleanup-step half of the rule is covered where it is consumed
 * (job-history-summarise.test.ts, scripts/lib/floor-probe-rows.test.mjs).
 * These are the dated half: a non-success at a TTL, in any step, on a day the
 * fleet was minting units with that TTL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KNOWN_TTL_SEC, TTL_LIVE_GRACE_DAYS, isFleetKill, zoneOf } from '../job-history-zone.js';

/** hadoku-watchparty run 44491381285, as job history stored it. */
const WATCHPARTY_INGEST = {
	startedAt: '2026-11-19T08:53:05Z',
	durationSec: 23401,
	failedStep: 'Ingest',
	failedPhase: 'run',
	conclusion: 'failure',
};

/** hadoku-cardtable run 42160299536: exit 1 at 3,600 s, seven weeks after that TTL retired. */
const CARDTABLE_E2E = {
	startedAt: '2026-11-06T04:05:30Z',
	durationSec: 3600,
	failedStep: 'E2E — two friends play a real Forge match, and the table fits',
	failedPhase: 'run',
	conclusion: 'failure',
};

test('a TTL kill in the job’s own step is a fleet kill when that TTL was live', () => {
	assert.equal(isFleetKill(WATCHPARTY_INGEST), true);
	assert.equal(zoneOf(WATCHPARTY_INGEST), 'fleet', 'and it is not counted against the consumer');
});

test('a TTL-length failure in a main step is NOT a kill once that TTL is retired', () => {
	assert.equal(isFleetKill(CARDTABLE_E2E), false);
	assert.equal(zoneOf(CARDTABLE_E2E), 'content');
});

test('the same record inside the TTL’s life is a kill: the date is the whole difference', () => {
	assert.equal(isFleetKill({ ...CARDTABLE_E2E, startedAt: '2026-09-01T04:05:30Z' }), true);
});

test('a record with no start date is a kill only through the cleanup step', () => {
	const undated = { durationSec: 23401, conclusion: 'failure' };
	assert.equal(isFleetKill({ ...undated, failedStep: 'Ingest', failedPhase: 'run' }), false);
	assert.equal(isFleetKill({ ...undated, failedStep: 'Ingest', startedAt: 'not a date' }), false);
	assert.equal(isFleetKill({ ...undated, failedStep: 'Post Run actions/checkout@v4' }), true);
});

test('a cleanup-step failure at a TTL is a kill whatever the date', () => {
	assert.equal(
		isFleetKill({ ...CARDTABLE_E2E, failedStep: 'Complete job', failedPhase: 'cleanup' }),
		true
	);
});

test('a retired TTL stays live through its last day plus the deploy grace, and no longer', () => {
	const ttl = KNOWN_TTL_SEC.find((t) => t.sec === 23_400)!;
	assert.equal(ttl.until, '2026-11-19');
	const lastMs = Date.parse(`${ttl.until}T00:00:00Z`) + (1 + TTL_LIVE_GRACE_DAYS) * 86_400_000;
	const at = (ms: number) => ({ ...WATCHPARTY_INGEST, startedAt: new Date(ms).toISOString() });
	assert.equal(isFleetKill(at(lastMs - 1000)), true);
	assert.equal(isFleetKill(at(lastMs)), false);
	assert.equal(isFleetKill(at(Date.parse(`${ttl.from}T00:00:00Z`))), true);
	assert.equal(isFleetKill(at(Date.parse(`${ttl.from}T00:00:00Z`) - 1000)), false);
});

test('the TTL the fleet mints today has no end date, so a main-step kill at it counts', () => {
	const live = KNOWN_TTL_SEC.filter((t) => t.until === null);
	assert.equal(live.length, 1, 'exactly one TTL is the live one');
	assert.equal(
		isFleetKill({
			startedAt: '2027-03-01T00:00:00Z',
			durationSec: live[0].sec + 1,
			failedStep: 'Build',
			failedPhase: 'run',
			conclusion: 'failure',
		}),
		true
	);
});

test('success at a TTL, or a failure nowhere near one, is never a kill', () => {
	assert.equal(isFleetKill({ ...WATCHPARTY_INGEST, conclusion: 'success' }), false);
	assert.equal(isFleetKill({ ...WATCHPARTY_INGEST, durationSec: 23_300 }), false);
});
