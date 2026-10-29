import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { JobRecord } from '../job-history.js';
import { jobKind } from '../lib/job-kind.js';
import {
	buildHeavyModel,
	HEAVY_P75_SEC,
	HEAVY_REPO_MIN_SHARE,
	MIN_HEAVY_SAMPLES,
} from '../runners/traffic.js';

const CARDTABLE = 'WolffM/hadoku-cardtable';

test('jobKind: a numeric matrix suffix is a shard of the same job', () => {
	assert.equal(jobKind('forge-e2e (1)'), 'forge-e2e');
	assert.equal(jobKind('forge-e2e (12)'), 'forge-e2e');
	assert.equal(jobKind('forge-e2e'), 'forge-e2e');
});

test('jobKind: an INDEX/TOTAL suffix is a shard of the same job', () => {
	assert.equal(jobKind('unit (1/2)'), 'unit');
	assert.equal(jobKind('unit (2/2)'), 'unit');
	assert.equal(jobKind('unit (10/12)'), 'unit');
});

test('jobKind: a non-numeric matrix value is a different job and is kept', () => {
	assert.equal(jobKind('test (ubuntu, 20)'), 'test (ubuntu, 20)');
	assert.equal(jobKind('build (linux)'), 'build (linux)');
	assert.equal(jobKind('a (1) b'), 'a (1) b');
	assert.equal(jobKind('unit (1/2) b'), 'unit (1/2) b');
	assert.equal(jobKind('test (1/)'), 'test (1/)');
	assert.equal(jobKind('test (ubuntu/20)'), 'test (ubuntu/20)');
});

function rec(name: string, runSec: number, i: number): JobRecord {
	return {
		repo: CARDTABLE,
		runId: i,
		jobId: i,
		name,
		runner: 'claw-9',
		labels: ['self-hosted', 'hadoku-builder', 'jdk21'],
		startedAt: new Date(Date.UTC(2026, 9, 7, 0, i)).toISOString(),
		durationSec: runSec,
		runSec,
		conclusion: 'success',
	} as JobRecord;
}

// The day cardtable sharded: every forge-e2e sample in history is under the
// unsharded name, and the first shards to queue carry names with no history.
// A shard must still read as heavy, or the 4c rule that sends heavy jobs to
// idle nodes first does not apply to the very jobs it was written for.
test('heavy model: a shard of a heavy job is heavy from the unsharded history', () => {
	const history = Array.from({ length: MIN_HEAVY_SAMPLES }, (_, i) =>
		rec('forge-e2e', HEAVY_P75_SEC * 3, i)
	);
	const model = buildHeavyModel(history);
	assert.equal(model.isHeavy(CARDTABLE, 'forge-e2e (2)'), true);
	assert.equal(model.isHeavy(CARDTABLE, 'forge-e2e'), true);
});

test('heavy model: shard samples pool into one kind', () => {
	const history = Array.from({ length: MIN_HEAVY_SAMPLES }, (_, i) =>
		rec(`forge-e2e (${(i % 3) + 1})`, HEAVY_P75_SEC * 2, i)
	);
	assert.equal(buildHeavyModel(history).isHeavy(CARDTABLE, 'forge-e2e (1)'), true);
});

test('heavy model: a repo whose heavy kind is a RARE share of its jobs is not a heavy repo — hadoku_site, 2026-10-09', () => {
	// One nightly Static Analysis among thousands of light builds made every
	// hadoku_site build "running heavy" and evicted warm listeners on claws that
	// never run a heavy job.
	const site = 'WolffM/hadoku_site';
	const history = [
		...Array.from({ length: 6 }, (_, i) => ({
			...rec('Static Analysis', HEAVY_P75_SEC * 4, i),
			repo: site,
		})),
		...Array.from({ length: 200 }, (_, i) => ({ ...rec('build', 60, 100 + i), repo: site })),
	];
	const model = buildHeavyModel(history);
	assert.equal(model.isHeavy(site, 'Static Analysis'), true, 'the exact kind is still heavy');
	assert.equal(model.isHeavyRepo(site), false, `6/206 is under ${HEAVY_REPO_MIN_SHARE}`);
});

test('heavy model: a repo whose heavy kinds are a real share stays a heavy repo — cardtable', () => {
	const history = [
		...Array.from({ length: 30 }, (_, i) => rec('forge-e2e', HEAVY_P75_SEC * 2, i)),
		...Array.from({ length: 70 }, (_, i) => rec('check', 200, 100 + i)),
	];
	assert.equal(buildHeavyModel(history).isHeavyRepo(CARDTABLE), true);
});
