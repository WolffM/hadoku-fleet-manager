/**
 * The generic automation runner (wave 5e lane B): the spawn-classify, pager
 * ledger, schedule and job-sink primitives shared by `createConverger`
 * (scheduled-converger.ts) and the ported `claw-reboot.ts`. Their own
 * behaviour is pinned by scheduled-converger.test.ts, provisioning-converge.
 * test.ts, hosting-converge.test.ts and claw-reboot.test.ts; this file pins
 * the primitives those tests build on, in isolation.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';
import {
	classifyMissingDoc,
	computeFirstDelayMs,
	createOverlapGuard,
	createPager,
	finishTick,
	hours,
	reportJobResult,
	scheduleRepeating,
} from '../lib/job-runner.js';

let jobResults: {
	jobName: string;
	jobState: string;
	durationMs: number;
	opts?: Record<string, unknown>;
}[] = [];
let warns: string[] = [];

beforeEach(() => {
	jobResults = [];
	warns = [];
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn: (m) => warns.push(m), error() {} },
		jobs: {
			async recordJobResult(jobName, jobState, durationMs, opts) {
				jobResults.push({ jobName, jobState, durationMs, opts });
			},
		},
	});
});
afterEach(() => __setHostForTesting(testHost));

void test('classifyMissingDoc: a numeric exit with no signal ran to completion and produced nothing — broke', () => {
	assert.equal(classifyMissingDoc('exit 0, no report'), 'broke');
	assert.equal(classifyMissingDoc('exit 1, no report'), 'broke');
	assert.equal(classifyMissingDoc('exit 1, unparseable (Unexpected token)'), 'broke');
});

void test('classifyMissingDoc: never started, or killed before it reported — unavailable', () => {
	assert.equal(classifyMissingDoc('could not start: ENOENT, no report'), 'unavailable');
	assert.equal(classifyMissingDoc('exit null (SIGTERM), no report'), 'unavailable');
	assert.equal(classifyMissingDoc('refused under node --test (inject a runner)'), 'unavailable');
});

void test('classifyMissingDoc: "could not look" is never read as ok or findings — it is one of exactly two verdicts', () => {
	for (const why of [
		'exit 0, no report',
		'could not start: boom, no report',
		'exit null (SIGTERM), no report',
	]) {
		assert.ok(['unavailable', 'broke'].includes(classifyMissingDoc(why)));
	}
});

void test('hours: rounds ms to the nearest hour, as every page/recovery message quotes it', () => {
	assert.equal(hours(3_600_000), '1h');
	assert.equal(hours(21_600_000), '6h');
	assert.equal(hours(1_800_000), '1h'); // Math.round(0.5) rounds up
});

void test('createPager: a key pages once, is silent inside repageMs, and pages again past it', async () => {
	const posts: { content: string; source: string }[] = [];
	const paged: Record<string, string> = {};
	const post = async (content: string, source: string) => {
		posts.push({ content, source });
	};

	const p1 = createPager({ paged, now: 0, repageMs: 1000, post, source: 'x' });
	await p1.page('k', 'first');
	assert.equal(posts.length, 1);
	assert.equal(p1.counts.pages, 1);

	const p2 = createPager({ paged, now: 500, repageMs: 1000, post, source: 'x' });
	await p2.page('k', 'second — too soon');
	assert.equal(posts.length, 1, 'inside repageMs: silent');

	const p3 = createPager({ paged, now: 1000, repageMs: 1000, post, source: 'x' });
	await p3.page('k', 'third — repageMs elapsed');
	assert.equal(posts.length, 2);
	assert.deepEqual(
		posts.map((p) => p.content),
		['first', 'third — repageMs elapsed']
	);
});

void test('createPager: recover is a no-op without an open page, and clears one that is open', async () => {
	const posts: string[] = [];
	const paged: Record<string, string> = {};
	const post = async (content: string) => {
		posts.push(content);
	};

	const p1 = createPager({ paged, now: 0, repageMs: 1000, post, source: 'x' });
	await p1.recover('k', 'no-op');
	assert.deepEqual(posts, []);
	assert.equal(p1.counts.recoveries, 0);

	await p1.page('k', 'paged');
	const p2 = createPager({ paged, now: 100, repageMs: 1000, post, source: 'x' });
	await p2.recover('k', 'cleared');
	assert.deepEqual(posts, ['paged', 'cleared']);
	assert.equal(p2.counts.recoveries, 1);
	assert.equal(paged.k, undefined, 'the ledger entry is gone once recovered');
});

void test('computeFirstDelayMs: never sooner than firstPassMinMs, even with no prior run', () => {
	const cfg = { intervalMs: 60_000, firstPassMinMs: 5_000 };
	assert.equal(computeFirstDelayMs(cfg, null, 0), 5_000);
});

void test('computeFirstDelayMs: due one interval after the last run on disk', () => {
	const cfg = { intervalMs: 60_000, firstPassMinMs: 5_000 };
	const now = 1_000_000;
	const last = new Date(now - 20_000).toISOString();
	assert.equal(computeFirstDelayMs(cfg, last, now), 40_000);
});

void test('computeFirstDelayMs: an overdue last run still waits at least firstPassMinMs', () => {
	const cfg = { intervalMs: 60_000, firstPassMinMs: 5_000 };
	const now = 1_000_000;
	const last = new Date(now - 120_000).toISOString(); // two intervals overdue
	assert.equal(computeFirstDelayMs(cfg, last, now), 5_000);
});

void test('scheduleRepeating: fires at firstInMs, then on every intervalMs, until stopped', async () => {
	let calls = 0;
	const job = scheduleRepeating(5, 10, () => {
		calls++;
	});
	await delay(8);
	assert.equal(calls, 1, 'the first pass fired');
	await delay(10);
	assert.equal(calls, 2, 'one interval later, a second pass fired');
	job.stop();
	await delay(15);
	assert.equal(calls, 2, 'stopped: no further pass fires');
});

void test('createOverlapGuard: a second run() while the first is in flight is a no-op', async () => {
	let starts = 0;
	let resolveFirst: (() => void) | undefined;
	const guard = createOverlapGuard();

	guard.run(
		() =>
			new Promise<void>((res) => {
				starts++;
				resolveFirst = res;
			})
	);
	guard.run(async () => {
		starts++;
	});
	assert.equal(starts, 1, 'the in-flight pass blocked the second call');

	resolveFirst?.();
	await delay(5);
	guard.run(async () => {
		starts++;
	});
	await delay(5);
	assert.equal(starts, 2, 'once the first pass finished, a new one is allowed');
});

void test('finishTick/reportJobResult: ok and findings report succeeded; unavailable and broke report failed', async () => {
	await finishTick({ jobName: 'x', intervalMs: 60_000, now: 0, verdict: 'ok', durationMs: 5 });
	await finishTick({
		jobName: 'x',
		intervalMs: 60_000,
		now: 0,
		verdict: 'findings',
		durationMs: 5,
	});
	await finishTick({
		jobName: 'x',
		intervalMs: 60_000,
		now: 0,
		verdict: 'unavailable',
		durationMs: 5,
		why: 'ssh timeout',
	});
	await finishTick({
		jobName: 'x',
		intervalMs: 60_000,
		now: 0,
		verdict: 'broke',
		durationMs: 5,
		why: 'exit 1, no report',
	});

	assert.deepEqual(
		jobResults.map((r) => r.jobState),
		['succeeded', 'succeeded', 'failed', 'failed']
	);
	assert.equal(jobResults[2].opts?.error, 'ssh timeout');
	assert.equal(jobResults[3].opts?.error, 'exit 1, no report');
	// A succeeded tick carries no `error`, even though the verdict still
	// travels in `data` so a reader can tell `ok` apart from `findings`.
	assert.equal(jobResults[0].opts?.error, undefined);
	assert.deepEqual((jobResults[0].opts?.data as Record<string, unknown>).verdict, 'ok');
	assert.deepEqual((jobResults[1].opts?.data as Record<string, unknown>).verdict, 'findings');
});

void test('reportJobResult: a sink failure is logged and never thrown', async () => {
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn: (m) => warns.push(m), error() {} },
		jobs: {
			recordJobResult: () => Promise.reject(new Error('sink is down')),
		},
	});
	await assert.doesNotReject(() => reportJobResult('x', 'ok', 0));
	assert.ok(warns.some((w) => w.includes('sink is down')));
});

void test('liveness: a scheduled job is registered at once, and a finished tick marks it ok', async () => {
	const { getFleetLiveness, __resetLivenessForTesting } = await import('../lib/liveness.js');
	const { scheduleRepeating, finishTick } = await import('../lib/job-runner.js');
	__resetLivenessForTesting();
	const job = scheduleRepeating(60 * 60_000, 30 * 60_000, () => {}, 'test-job');
	try {
		const pending = getFleetLiveness().loops.find((l) => l.name === 'test-job');
		assert.equal(
			pending?.status,
			'pending',
			'registered before its first pass, so it is pending, never absent'
		);
		assert.equal(pending?.lastTickAt, null);
		await finishTick({
			jobName: 'test-job',
			intervalMs: 30 * 60_000,
			now: Date.now(),
			verdict: 'ok',
			durationMs: 1,
		});
		const ok = getFleetLiveness().loops.find((l) => l.name === 'test-job');
		assert.equal(ok?.status, 'ok');
		assert.notEqual(ok?.lastTickAt, null);
	} finally {
		job.stop();
		__resetLivenessForTesting();
	}
});
