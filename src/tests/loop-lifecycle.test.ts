/**
 * `FleetManager.stop()`'s machinery (lib/loop-lifecycle.ts): a process about
 * to exit clears every loop's timers, starts no new pass, and waits, bounded,
 * for the passes already running. Asked for by the mgmt-api pair (hadoku_site
 * HA phase 1): its leader exited mid-pass at the 2026-11-05 18:53Z handover.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createOverlapGuard, scheduleRepeating } from '../lib/job-runner.js';
import { every } from '../lib/every.js';
import {
	isStopping,
	stopLoops,
	trackPass,
	__resetLoopLifecycleForTesting,
} from '../lib/loop-lifecycle.js';

afterEach(() => __resetLoopLifecycleForTesting());

const later = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

void test('stop waits for the pass in flight, and no pass starts after it', async () => {
	const guard = createOverlapGuard();
	const log: string[] = [];
	guard.run(async () => {
		log.push('start');
		await later(40);
		log.push('end');
	});
	const r = await stopLoops(5_000);
	assert.deepEqual(log, ['start', 'end'], 'the running pass finished before stop resolved');
	assert.equal(r.drained, true);
	assert.equal(r.pending, 0);
	assert.ok(isStopping());
	guard.run(async () => {
		log.push('after');
		await Promise.resolve();
	});
	assert.deepEqual(log, ['start', 'end'], 'a pass due after the stop never starts');
});

void test('stop is bounded: a pass that never ends is reported, not waited on forever', async () => {
	void trackPass(new Promise(() => undefined));
	const r = await stopLoops(30);
	assert.equal(r.drained, false);
	assert.equal(r.pending, 1);
	assert.ok(r.waitedMs >= 25);
});

void test("stop clears scheduleRepeating's and every()'s timers", async () => {
	let repeating = 0;
	let everyTicks = 0;
	scheduleRepeating(5, 5, () => {
		repeating++;
	});
	every(
		'loop-lifecycle-test',
		5,
		() => {
			everyTicks++;
		},
		{ firstRunMs: 0, registerLiveness: false, noteTick: false }
	);
	await later(30);
	assert.ok(repeating > 0 && everyTicks > 0, 'both loops ran before the stop');
	await stopLoops(1_000);
	const [r, e] = [repeating, everyTicks];
	await later(30);
	assert.deepEqual([repeating, everyTicks], [r, e], 'neither fired after the stop');
});

void test('nothing running: stop resolves at once', async () => {
	assert.deepEqual(await stopLoops(1_000), { drained: true, pending: 0, waitedMs: 0 });
});
