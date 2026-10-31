/**
 * Characterization tests for `runners/speed-heavy-cache.ts`'s two model-rebuild
 * gates (wave5m lane C, migrating onto `lib/every.ts`'s `subCadence`). Neither
 * gate had a cadence test before this wave — `placement.test.ts` and
 * `warm-cache.test.ts` only ever reset the caches between their OWN unrelated
 * tests, never asserted on the cadence itself.
 *
 * Both `getSpeedModel` and `getHeavyModel` rebuild from an EMPTY job history
 * here (a history path pointed at a file that is never written), so
 * `buildSpeedModel`/`buildHeavyModel` are cheap, deterministic, and — the
 * property these tests lean on — return a NEW model object every call. A
 * cache hit is "same object back"; a rebuild is "a different one" (identity,
 * not deep-equality, matches how the production call sites use the result).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __setHistoryPathForTesting, __resetJobHistoryForTesting } from '../job-history-store.js';
import {
	getSpeedModel,
	getHeavyModel,
	SPEED_MODEL_REBUILD_INTERVAL_MS,
	__resetSpeedModelForTesting,
	__resetHeavyModelForTesting,
} from '../runners/speed-heavy-cache.js';

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), 'speed-heavy-cache-'));
	__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
	__resetJobHistoryForTesting();
	__resetSpeedModelForTesting();
	__resetHeavyModelForTesting();
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	__setHistoryPathForTesting(null);
});

const NOW = 1_787_797_008_000;

// ── getSpeedModel ────────────────────────────────────────────────────────────

void test('getSpeedModel: never built before — rebuilds on the first call', () => {
	// No assertion needed beyond "it returns something usable" — the real
	// claim this pins is the NEXT test's "does not rebuild a moment later".
	const m = getSpeedModel(NOW, ['claw-1']);
	assert.ok(m);
});

void test('getSpeedModel: does not rebuild again inside SPEED_MODEL_REBUILD_INTERVAL_MS', () => {
	const first = getSpeedModel(NOW, ['claw-1']);
	const second = getSpeedModel(NOW + 1, ['claw-1']);
	assert.equal(second, first, 'a tick a millisecond later must reuse the cached model');
	const third = getSpeedModel(NOW + SPEED_MODEL_REBUILD_INTERVAL_MS - 1, ['claw-1']);
	assert.equal(third, first, 'still inside the window, one ms before it elapses');
});

void test('getSpeedModel: rebuilds once SPEED_MODEL_REBUILD_INTERVAL_MS has passed, not a moment before', () => {
	const first = getSpeedModel(NOW, ['claw-1']);
	const stillCached = getSpeedModel(NOW + SPEED_MODEL_REBUILD_INTERVAL_MS - 1, ['claw-1']);
	assert.equal(stillCached, first);
	const rebuilt = getSpeedModel(NOW + SPEED_MODEL_REBUILD_INTERVAL_MS, ['claw-1']);
	assert.notEqual(rebuilt, first, 'the interval elapsed — a fresh model, not the cached one');
});

void test('getSpeedModel: the clock measures from the LAST rebuild, not the first call', () => {
	const first = getSpeedModel(NOW, ['claw-1']);
	const second = getSpeedModel(NOW + SPEED_MODEL_REBUILD_INTERVAL_MS, ['claw-1']);
	assert.notEqual(second, first);
	// Measured from `second`'s rebuild, not `first`'s — due again only once a
	// FULL interval has passed since the SECOND rebuild.
	const stillCached = getSpeedModel(NOW + 2 * SPEED_MODEL_REBUILD_INTERVAL_MS - 1, ['claw-1']);
	assert.equal(stillCached, second);
});

// ── getHeavyModel ────────────────────────────────────────────────────────────

void test('getHeavyModel: never built before — rebuilds on the first call', () => {
	const m = getHeavyModel(NOW);
	assert.ok(m);
});

void test('getHeavyModel: does not rebuild again inside the interval, rebuilds once it elapses', () => {
	const first = getHeavyModel(NOW);
	const cached = getHeavyModel(NOW + SPEED_MODEL_REBUILD_INTERVAL_MS - 1);
	assert.equal(cached, first);
	const rebuilt = getHeavyModel(NOW + SPEED_MODEL_REBUILD_INTERVAL_MS);
	assert.notEqual(rebuilt, first);
});

// ── the two caches are independent ──────────────────────────────────────────

void test('getSpeedModel and getHeavyModel ride INDEPENDENT clocks', () => {
	// Priming the heavy model's clock must not feed the speed model's, and
	// resetting one must not touch the other — the two `subCadence` names
	// (`speed-heavy-cache:speed-model` / `speed-heavy-cache:heavy-model`) share
	// one process-global map, so this is the test that would catch them
	// colliding onto the same key.
	const speedFirst = getSpeedModel(NOW, ['claw-1']);
	getHeavyModel(NOW + SPEED_MODEL_REBUILD_INTERVAL_MS - 1);
	const speedStillCached = getSpeedModel(NOW + SPEED_MODEL_REBUILD_INTERVAL_MS - 1, ['claw-1']);
	assert.equal(speedStillCached, speedFirst, 'the heavy model call must not have reset this clock');

	__resetHeavyModelForTesting();
	const speedAfterHeavyReset = getSpeedModel(NOW + SPEED_MODEL_REBUILD_INTERVAL_MS - 1, ['claw-1']);
	assert.equal(
		speedAfterHeavyReset,
		speedFirst,
		'resetting the heavy model must not reset the speed model too'
	);
});
