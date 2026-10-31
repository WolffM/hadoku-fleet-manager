/**
 * What the controller's provisioning converger logs and pages — fleet-manager#1.
 *
 * The repair itself is exercised end to end in
 * scripts/converge-provisioning.test.mjs. This pins the policy: a change is
 * REPORTED, never paged; a deferral pages only once it has outlasted
 * DEFER_PAGE_MS; an unconverged facet pages once per REPAGE_MS; whatever
 * paged gets a recovery; and none of it is lost across a restart, because the
 * state is on disk.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { __setHostForTesting } from '../host.js';
import { testHost, testStateDir } from './install-test-host.js';
import {
	convergeProvisioningTick,
	convergeScriptPath,
	runConvergeScript,
	DEFER_PAGE_MS,
	REPAGE_MS,
	type ConvergeDoc,
	type ConvergeRunner,
} from '../provisioning-converge.js';

let posts: string[] = [];
let infos: string[] = [];
let warns: string[] = [];

const STATE = join(testStateDir, 'provisioning-converge.json');

beforeEach(() => {
	posts = [];
	infos = [];
	warns = [];
	rmSync(STATE, { force: true });
	__setHostForTesting({
		...testHost,
		logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m), error() {} },
		alerts: {
			post: async (content: string) => {
				posts.push(content);
				return { posted: true, sinkRecorded: true };
			},
			recordQuietly() {},
		},
		// See scheduled-converger.test.ts: every tick now reports to the job sink.
		jobs: { recordJobResult: async () => {} },
	});
});
afterEach(() => __setHostForTesting(testHost));

const T0 = 1_792_900_000_000;
const HOUR = 3_600_000;

const doc = (over: Partial<ConvergeDoc> = {}): ConvergeDoc => ({
	ok: true,
	planned: [],
	converged: [],
	deferred: [],
	unconverged: [],
	unreadable: [],
	changed: [],
	...over,
});
const runner =
	(d: ConvergeDoc | null, why = ''): ConvergeRunner =>
	() =>
		Promise.resolve({ doc: d, why });

const CLAW4_THROTTLE = { node: 'claw-4', facet: 'throttle' as const };

void test('a repaired drift is logged with what changed, and never paged', async () => {
	const s = await convergeProvisioningTick(
		runner(
			doc({
				converged: [{ ...CLAW4_THROTTLE, before: '1 runner(s) with the wrong env' }],
				changed: [
					{ node: 'claw-4', facet: 'throttle', changed: 'env written on 1 runner(s), 1 restarted' },
				],
			})
		),
		T0
	);
	assert.deepEqual(posts, []);
	assert.equal(s.changed, 1);
	assert.ok(
		infos.some(
			(l) => l === '[provisioning] claw-4 throttle: env written on 1 runner(s), 1 restarted'
		)
	);
	assert.ok(existsSync(STATE), 'state is written to disk');
});

void test('a deferral pages only after DEFER_PAGE_MS, once, and recovers when the node is clean', async () => {
	const deferred = doc({
		deferred: [{ node: 'claw-6', facet: 'slice', why: 'busy: actions-runner-x.service' }],
	});
	await convergeProvisioningTick(runner(deferred), T0);
	await convergeProvisioningTick(runner(deferred), T0 + DEFER_PAGE_MS - 1);
	assert.deepEqual(posts, [], 'a job running through two passes is busy, not stuck');

	await convergeProvisioningTick(runner(deferred), T0 + DEFER_PAGE_MS);
	assert.equal(posts.length, 1);
	assert.match(posts[0], /claw-6: slice drift .* deferred behind a live job for 6h/);
	assert.match(posts[0], /fleet slice --machine claw-6 --confirm --restart/);

	await convergeProvisioningTick(runner(deferred), T0 + DEFER_PAGE_MS + HOUR);
	assert.equal(posts.length, 1, 'no second page inside REPAGE_MS');

	await convergeProvisioningTick(runner(doc()), T0 + DEFER_PAGE_MS + 2 * HOUR);
	assert.equal(posts.length, 2);
	assert.match(posts[1], /claw-6: standing-runner slice provisioning converged/);
});

void test('the deferral clock survives a restart: it is read from disk, not module state', async () => {
	const deferred = doc({ deferred: [CLAW4_THROTTLE] });
	await convergeProvisioningTick(runner(deferred), T0);
	// Nothing in memory carries the clock; the next tick reads only the file.
	await convergeProvisioningTick(runner(deferred), T0 + DEFER_PAGE_MS);
	assert.equal(posts.length, 1);
});

void test('a facet that will not converge pages at once, again only after REPAGE_MS', async () => {
	const stuck = doc({
		unconverged: [{ ...CLAW4_THROTTLE, before: '1 wrong', why: 'restart failed: /home/x' }],
	});
	await convergeProvisioningTick(runner(stuck), T0);
	assert.equal(posts.length, 1);
	assert.match(posts[0], /claw-4: fleet converge-provisioning repaired throttle drift/);
	assert.match(posts[0], /restart failed: \/home\/x/);
	await convergeProvisioningTick(runner(stuck), T0 + REPAGE_MS - 1);
	assert.equal(posts.length, 1);
	await convergeProvisioningTick(runner(stuck), T0 + REPAGE_MS);
	assert.equal(posts.length, 2);
});

void test('an unreadable node is logged, never paged, and never closes an open page', async () => {
	await convergeProvisioningTick(runner(doc({ unconverged: [CLAW4_THROTTLE] })), T0);
	assert.equal(posts.length, 1);
	await convergeProvisioningTick(
		runner(doc({ unreadable: [{ node: 'claw-4', facet: 'throttle', why: 'ssh timed out' }] })),
		T0 + HOUR
	);
	assert.equal(posts.length, 1, '"I could not look" is not a recovery');
	assert.ok(warns.some((l) => l.includes('claw-4 throttle could not be read: ssh timed out')));
});

void test('a converger that produces no report pages only after DEFER_PAGE_MS, then recovers', async () => {
	await convergeProvisioningTick(runner(null, 'exit 1, no report'), T0);
	assert.deepEqual(posts, []);
	assert.ok(warns.some((l) => l.includes('no report: exit 1, no report')));
	await convergeProvisioningTick(runner(null, 'exit 1, no report'), T0 + DEFER_PAGE_MS);
	assert.equal(posts.length, 1);
	assert.match(posts[0], /has not produced a report for 6h/);
	await convergeProvisioningTick(runner(doc()), T0 + DEFER_PAGE_MS + HOUR);
	assert.equal(posts.length, 2);
	assert.match(posts[1], /reporting again/);
});

void test('the real runner refuses under node --test, and names the packaged script', async () => {
	const r = await runConvergeScript();
	assert.equal(r.doc, null);
	assert.match(r.why, /refused under node --test/);
	assert.match(convergeScriptPath(), /scripts\/converge-provisioning\.mjs$/);
	assert.ok(existsSync(convergeScriptPath()), 'the path resolves to the shipped script');
});

void test('job-runner.ts classify: ok/findings report succeeded, unavailable/broke report failed', async () => {
	const sink: { jobState: string; verdict: unknown }[] = [];
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn() {}, error() {} },
		alerts: { post: async () => ({ posted: true, sinkRecorded: true }), recordQuietly() {} },
		jobs: {
			async recordJobResult(_jobName, jobState, _durationMs, opts) {
				sink.push({
					jobState,
					verdict: (opts?.data as Record<string, unknown> | undefined)?.verdict,
				});
			},
		},
	});

	await convergeProvisioningTick(runner(doc()), T0); // nothing outstanding
	await convergeProvisioningTick(runner(doc({ deferred: [CLAW4_THROTTLE] })), T0); // a finding, not yet paged
	await convergeProvisioningTick(
		runner(doc({ unreadable: [{ node: 'claw-4', facet: 'throttle', why: 'ssh timed out' }] })),
		T0
	);
	await convergeProvisioningTick(runner(null, 'exit 1, no report'), T0);

	assert.deepEqual(sink, [
		{ jobState: 'succeeded', verdict: 'ok' },
		{ jobState: 'succeeded', verdict: 'findings' },
		{ jobState: 'failed', verdict: 'unavailable' },
		{ jobState: 'failed', verdict: 'broke' },
	]);
});
