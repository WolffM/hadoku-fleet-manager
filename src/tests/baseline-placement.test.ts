import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { JobRecord } from '../job-history-store.js';
import type { NodeBaselineStore } from '../node-baselines-read.js';
import { describeHeavyHold, heavyHoldShadow } from '../runners/baseline-placement.js';

const NOW = Date.now();
const rec = (node: string, name: string, conclusion: string): JobRecord =>
	({
		repo: 'WolffM/hadoku-cardtable',
		runId: 1,
		jobId: 1,
		name,
		runner: `jit-${node}-x`,
		labels: [],
		startedAt: new Date(NOW - 3_600_000).toISOString(),
		durationSec: 600,
		conclusion,
	}) as JobRecord;
const nodeOf = (r: JobRecord) => /^jit-([a-z0-9-]+?)-x$/.exec(r.runner)?.[1] ?? null;
const isHeavy = (_repo: string, job: string) => job.startsWith('forge');
const entry = (mean: number) => ({ mean, sd: 0, n: 1 });

// The live store of 2026-11-22: claw-1's ramp held no p75 job, claw-4's held two.
const STORE: NodeBaselineStore = {
	quantities: { 'claw-1::ramp.ceiling': entry(0), 'claw-4::ramp.ceiling': entry(2) },
	weakPoints: {
		'claw-1': {
			'concurrency-ramp': {
				reason: 'does not hold even one p75 job: package reached 98 °C ≥ 90 °C',
				since: new Date(NOW).toISOString(),
				lastSeen: new Date(NOW).toISOString(),
			},
		},
	},
};

void test('a node whose ramp held no job would hold heavy jobs off, with the history behind it', () => {
	const records = [
		rec('claw-1', 'forge-jvm (1)', 'failure'),
		rec('claw-1', 'forge-jvm (2)', 'success'),
		rec('claw-1', 'lint', 'failure'),
		rec('claw-4', 'forge-jvm (1)', 'success'),
		rec('claw-4', 'forge-jvm (2)', 'success'),
		rec('claw-4', 'forge-e2e', 'cancelled'),
	];
	const out = heavyHoldShadow(STORE, records, {
		nowMs: NOW,
		nodes: ['claw-1', 'claw-4'],
		isHeavy,
		nodeOf,
	});
	assert.equal(out.length, 1);
	assert.deepEqual(
		{
			node: out[0].node,
			heavyRuns: out[0].heavyRuns,
			heavyFailures: out[0].heavyFailures,
			otherHeavyRuns: out[0].otherHeavyRuns,
		},
		{ node: 'claw-1', heavyRuns: 2, heavyFailures: 1, otherHeavyRuns: 2 }
	);
	assert.match(
		describeHeavyHold(out[0]),
		/claw-1 \(qualify ramp ceiling 0\): 2 heavy job\(s\) ran there in 14 d, 50\.0% failed vs 0\.0% elsewhere/
	);
});

void test('a weak point without a learned ceiling under 1, or none at all, holds nothing', () => {
	const noCeiling: NodeBaselineStore = { quantities: {}, weakPoints: STORE.weakPoints };
	assert.deepEqual(
		heavyHoldShadow(noCeiling, [], { nowMs: NOW, nodes: ['claw-1'], isHeavy, nodeOf }),
		[]
	);
	const empty: NodeBaselineStore = { quantities: {}, weakPoints: {} };
	assert.deepEqual(
		heavyHoldShadow(empty, [], { nowMs: NOW, nodes: ['claw-1', 'claw-4'], isHeavy, nodeOf }),
		[]
	);
});
