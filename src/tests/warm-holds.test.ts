/**
 * WARM HOLDS (fleet-manager#79): the warm tick records when it held a node's
 * slot empty for a heavy job or a drain, so the canary — a separate process on
 * its own clock — does not score a node the tick has not yet come round to
 * refill.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	dispatchWarmCache,
	__resetWarmCacheClockForTesting,
} from '../runners/dispatch-warm-cache.js';
import {
	__markHeavyForTesting,
	__resetHeavyMarksForTesting,
} from '../runners/dispatch-pass-state.js';
import {
	WARM_HOLD_REFILL_MS,
	WARM_HOLDS_FILE,
	__resetWarmHoldsForTesting,
	flushWarmHolds,
	noteWarmHold,
	readWarmHolds,
	warmHoldWithholds,
} from '../runners/warm-holds.js';
import { warmRunnerName } from '../lib/jit-naming.js';
import type { EphemeralTickInput } from '../runners/ephemeral-shared.js';
import { fakeGh } from './helpers/fleet-fakes.js';
import { NODE_ELIGIBLE, installWarmCacheRig, simShell } from './helpers/warm-cache-rig.js';

installWarmCacheRig();

const SITE = 'WolffM/hadoku_site';

beforeEach(() => __resetWarmHoldsForTesting());
afterEach(() => {
	__resetWarmHoldsForTesting();
	__resetHeavyMarksForTesting();
});

test('a hold is honoured for the refill window after the last tick that held, then not', () => {
	const dir = mkdtempSync(join(tmpdir(), 'warm-holds-'));
	try {
		noteWarmHold('claw-6', 'heavy', 1_000_000);
		flushWarmHolds(1_000_000, dir);
		const doc = readWarmHolds(dir);
		assert.ok(doc);
		assert.equal(doc['claw-6'].reason, 'heavy');
		assert.equal(warmHoldWithholds(doc, 'claw-6', 1_000_000 + 90_000), 90_000);
		assert.equal(warmHoldWithholds(doc, 'claw-6', 1_000_000 + WARM_HOLD_REFILL_MS), null);
		assert.equal(warmHoldWithholds(doc, 'claw-8', 1_000_000), null, 'never held');

		// Past the window the tick drops it from the file too.
		flushWarmHolds(1_000_000 + WARM_HOLD_REFILL_MS, dir);
		assert.deepEqual(readWarmHolds(dir), {});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('an unreadable record is null — the canary says so and scores every node', () => {
	const dir = mkdtempSync(join(tmpdir(), 'warm-holds-'));
	try {
		assert.deepEqual(readWarmHolds(dir), {}, 'no file yet is no holds');
		writeFileSync(join(dir, WARM_HOLDS_FILE), '{"claw-6": ');
		assert.equal(readWarmHolds(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the warm tick writes a heavy hold when it keeps a node empty for a heavy job', async () => {
	__resetWarmCacheClockForTesting();
	const now = Date.now();
	__markHeavyForTesting('claw-6', now - 10_000);
	const input: EphemeralTickInput = {
		fleetProbe: new Map([['claw-6', { reachable: true, busyRepos: null, workers: 1 }]]),
		ephemeral: new Set(['claw-6']),
		nodes: { 'claw-6': { ...NODE_ELIGIBLE, maxConcurrent: 3 } },
		isSick: () => false,
		repos: [SITE],
	};
	const sims = { 'claw-6': { marker: null, activeUnits: new Set<string>() } };
	const res = await dispatchWarmCache(input, 'tok', fakeGh({ runners: [] }), simShell(sims), now);
	assert.equal(res.filled, 0, 'not filled while heavy');
	const doc = readWarmHolds(); // the host's state dir, where the tick writes
	assert.equal(doc?.['claw-6']?.reason, 'heavy', JSON.stringify(doc));
	assert.equal(doc?.['claw-6']?.atMs, now);
	assert.ok(!sims['claw-6'].activeUnits.has(warmRunnerName('claw-6', SITE)));
});
