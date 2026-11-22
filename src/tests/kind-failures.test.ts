import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { JobRecord } from '../job-history-store.js';
import {
	KIND_FAILURE_WINDOW_DAYS,
	binomialTail,
	describeKindFailure,
	failingKinds,
} from '../runners/kind-failures.js';

const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function rec(
	node: string,
	name: string,
	conclusion: string,
	repo = 'WolffM/hadoku-watchparty',
	h = 1
): JobRecord {
	return {
		repo,
		runId: 1,
		jobId: 1,
		name,
		runner: `jit-${node}-x`,
		labels: ['self-hosted', 'hadoku-builder'],
		startedAt: ago(h),
		durationSec: 60,
		conclusion,
	} as JobRecord;
}
const nodeOf = (r: JobRecord) => /^jit-([a-z0-9-]+?)-x$/.exec(r.runner)?.[1] ?? null;
const many = (n: number, f: (i: number) => JobRecord) => Array.from({ length: n }, (_, i) => f(i));

void test('binomialTail matches the closed form on small cases', () => {
	assert.equal(binomialTail(5, 0, 0.3), 1);
	assert.ok(Math.abs(binomialTail(2, 2, 0.5) - 0.25) < 1e-12);
	assert.ok(Math.abs(binomialTail(3, 1, 0.5) - 0.875) < 1e-12);
	assert.equal(binomialTail(10, 3, 0), 0);
});

void test("claw-5's shape on 11-22: 4 of 8 against ~1% elsewhere is a verdict", () => {
	const records = [
		...many(8, (i) => rec('claw-5', 'unit-tests', i < 4 ? 'failure' : 'success')),
		...many(90, (i) => rec(`claw-${(i % 3) + 1}`, 'unit-tests', i === 0 ? 'failure' : 'success')),
	];
	const out = failingKinds(records, { nowMs: NOW, nodeOf });
	assert.equal(out.length, 1);
	assert.deepEqual(
		{ node: out[0].node, job: out[0].job, runs: out[0].runs, failures: out[0].failures },
		{ node: 'claw-5', job: 'unit-tests', runs: 8, failures: 4 }
	);
	assert.match(
		describeKindFailure(out[0]),
		/claw-5 hadoku-watchparty\/unit-tests failed 4\/8 vs 1\.1% on 90 run\(s\) elsewhere/
	);
});

void test('a flaky kind that fails on every node is no node verdict (the Forge shards)', () => {
	const records = ['claw-4', 'claw-8', 'claw-9', 'claw-10', 'hokon'].flatMap((n) =>
		many(40, (i) =>
			rec(
				n,
				`forge-jvm (${(i % 3) + 1})`,
				i % 7 === 0 ? 'failure' : 'success',
				'WolffM/hadoku-cardtable'
			)
		)
	);
	assert.deepEqual(failingKinds(records, { nowMs: NOW, nodeOf }), []);
});

void test('too few failures, too little elsewhere, cancelled or old runs: no verdict', () => {
	const two = [
		...many(4, (i) => rec('claw-5', 'lint', i < 2 ? 'failure' : 'success')),
		...many(100, () => rec('claw-1', 'lint', 'success')),
	];
	assert.deepEqual(failingKinds(two, { nowMs: NOW, nodeOf }), []);
	const thin = [
		...many(5, () => rec('claw-5', 'lint', 'failure')),
		...many(5, () => rec('claw-1', 'lint', 'success')),
	];
	assert.deepEqual(failingKinds(thin, { nowMs: NOW, nodeOf }), []);
	const cancelled = [
		...many(6, () => rec('claw-5', 'lint', 'cancelled')),
		...many(100, () => rec('claw-1', 'lint', 'success')),
	];
	assert.deepEqual(failingKinds(cancelled, { nowMs: NOW, nodeOf }), []);
	const old = [
		...many(6, () =>
			rec('claw-5', 'lint', 'failure', undefined, (KIND_FAILURE_WINDOW_DAYS + 1) * 24)
		),
		...many(100, () => rec('claw-1', 'lint', 'success')),
	];
	assert.deepEqual(failingKinds(old, { nowMs: NOW, nodeOf }), []);
});

void test('a kind that never fails elsewhere is judged against 1/(n+1), not zero', () => {
	const records = [
		...many(40, (i) => rec('claw-5', 'lint', i < 3 ? 'failure' : 'success', 'WolffM/hadoku_site')),
		...many(400, () => rec('claw-1', 'lint', 'success', 'WolffM/hadoku_site')),
	];
	const out = failingKinds(records, { nowMs: NOW, nodeOf });
	assert.equal(out.length, 1);
	assert.ok(out[0].p > 0 && out[0].p < 1e-3, `p=${out[0].p}`);
});
