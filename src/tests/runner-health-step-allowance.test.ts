/**
 * The hung-job check's per-job allowance: a job that is one long step is judged
 * against its own green runs, not a fixed 25 minutes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matrixBase, stepAllowance, MIN_SAMPLES } from '../runner-health-step-allowance.js';
import type { JobRecord } from '../job-history-store.js';

const rec = (over: Partial<JobRecord>): JobRecord => ({
	repo: 'WolffM/hadoku-cardtable',
	runId: 1,
	jobId: 1,
	name: 'forge-e2e (1)',
	runner: 'claw-1',
	labels: [],
	startedAt: '2026-11-01T00:00:00Z',
	durationSec: 60,
	conclusion: 'success',
	...over,
});

test('matrixBase strips the matrix suffix and nothing else', () => {
	assert.equal(matrixBase('forge-e2e (5)'), 'forge-e2e');
	assert.equal(matrixBase('test (ubuntu, 3)'), 'test');
	assert.equal(matrixBase('judge forge-jvm'), 'judge forge-jvm');
});

test('stepAllowance is the longest green run of the same matrix job, never below the floor', () => {
	const history = [
		...Array.from({ length: MIN_SAMPLES }, (_, i) =>
			rec({ name: `forge-e2e (${i + 1})`, durationSec: 40 * 60 })
		),
		rec({ name: 'forge-e2e (2)', durationSec: 75 * 60 }),
		// Not counted: a failure, another job, another repo.
		rec({ name: 'forge-e2e (3)', durationSec: 200 * 60, conclusion: 'failure' }),
		rec({ name: 'forge-jvm (1)', durationSec: 120 * 60 }),
		rec({ repo: 'WolffM/other', durationSec: 300 * 60 }),
	];
	// A shard number that has never run green is judged by its siblings.
	assert.deepEqual(stepAllowance('WolffM/hadoku-cardtable', 'forge-e2e (9)', 25, history), {
		minutes: 75,
		samples: MIN_SAMPLES + 1,
	});
	const fast = Array.from({ length: MIN_SAMPLES }, () => rec({ durationSec: 5 * 60 }));
	assert.deepEqual(stepAllowance('WolffM/hadoku-cardtable', 'forge-e2e (1)', 25, fast), {
		minutes: 25,
		samples: MIN_SAMPLES,
	});
});

test('stepAllowance keeps the floor when the history is too thin to judge', () => {
	const thin = Array.from({ length: MIN_SAMPLES - 1 }, () => rec({ durationSec: 90 * 60 }));
	assert.deepEqual(stepAllowance('WolffM/hadoku-cardtable', 'forge-e2e (1)', 25, thin), {
		minutes: 25,
		samples: 0,
	});
});
