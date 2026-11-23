import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { JobRecord } from '../job-history-store.js';
import { jobKind } from '../lib/job-kind.js';
import {
	buildHeavyModel,
	HEAVY_P75_SEC,
	HEAVY_REPO_MIN_SHARE,
	MIN_HEAVY_SAMPLES,
} from '../runners/heavy-model.js';

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

test('jobKind: a `part INDEX/TOTAL` suffix is a shard of the same job — tsunami-surfer, 2026-11-23', () => {
	assert.equal(jobKind('nightly ppe part 3/6'), 'nightly ppe');
	assert.equal(jobKind('nightly ppe part 1/3'), 'nightly ppe');
	assert.equal(jobKind('nightly prod part 2/6'), 'nightly prod');
	assert.equal(jobKind('nightly (ppe)'), 'nightly (ppe)', 'the gate job is not a part');
	assert.equal(jobKind('part 1/2 of it'), 'part 1/2 of it');
	assert.equal(jobKind('spare part 1'), 'spare part 1');
});

test('jobKind: a non-numeric matrix value is a different job and is kept', () => {
	assert.equal(jobKind('test (ubuntu, 20)'), 'test (ubuntu, 20)');
	assert.equal(jobKind('build (linux)'), 'build (linux)');
	assert.equal(jobKind('a (1) b'), 'a (1) b');
	assert.equal(jobKind('unit (1/2) b'), 'unit (1/2) b');
	assert.equal(jobKind('test (1/)'), 'test (1/)');
	assert.equal(jobKind('test (ubuntu/20)'), 'test (ubuntu/20)');
});

function rec(
	name: string,
	runSec: number,
	i: number,
	conclusion: JobRecord['conclusion'] = 'success'
): JobRecord {
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
		conclusion,
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

// tsunami-surfer's ppe nightly, 2026-11-23, as the job history held it: legs
// renamed from `part N/3` to `part N/6` that morning, most of them failed or
// cancelled at the 90-minute timeout, a handful of successes. Four landed on
// claw-9 at once because the model called them light.
test('heavy model: long legs that fail or time out still make their kind heavy — tsunami-surfer, 2026-11-23', () => {
	const ts = 'WolffM/tsunami-surfer';
	const history = [
		rec('nightly ppe part 1/3', 4571, 1, 'failure'),
		rec('nightly ppe part 1/3', 1578, 2),
		rec('nightly ppe part 2/3', 4803, 3, 'failure'),
		rec('nightly ppe part 2/3', 2726, 4),
		rec('nightly ppe part 3/3', 2428, 5),
		rec('nightly ppe part 3/3', 3884, 6),
		rec('nightly ppe part 1/6', 5406, 7, 'cancelled'),
		rec('nightly ppe part 2/6', 5410, 8, 'cancelled'),
		rec('nightly ppe part 3/6', 13, 9, 'failure'),
	].map((r) => ({ ...r, repo: ts }));
	const model = buildHeavyModel(history);
	assert.equal(model.isHeavy(ts, 'nightly ppe part 4/6'), true);
	const successesOnly = buildHeavyModel(history.filter((r) => r.conclusion === 'success'));
	assert.equal(
		successesOnly.isHeavy(ts, 'nightly ppe part 4/6'),
		false,
		'four successes alone are under the sample bar: the failures are what prove it'
	);
});

test('heavy model: a SHORT failure is not runtime evidence, and cannot make a heavy kind light', () => {
	const history = [
		...Array.from({ length: MIN_HEAVY_SAMPLES }, (_, i) => rec('forge-e2e', HEAVY_P75_SEC * 2, i)),
		...Array.from({ length: 20 }, (_, i) => rec('forge-e2e', 20, 10 + i, 'failure')),
	];
	assert.equal(buildHeavyModel(history).isHeavy(CARDTABLE, 'forge-e2e'), true);
});

test('heavy model: a light kind that hangs past the line now and then stays light', () => {
	const history = [
		...Array.from({ length: 12 }, (_, i) => rec('check', 200, i)),
		rec('check', 5400, 20, 'cancelled'),
	];
	assert.equal(buildHeavyModel(history).isHeavy(CARDTABLE, 'check'), false);
});
