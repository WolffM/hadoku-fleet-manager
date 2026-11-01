/**
 * `buildProofRecord` — the budget judgement — exercised over a REAL
 * `ProofResult` shape, independent of the simulated world: these tests hand
 * it hand-built results directly rather than running `proveJob`. Wave 5s
 * lane A split of `prove-job.test.ts` (1,000-line test ceiling); see
 * `prove-job-core.test.ts`, `prove-job-identity.test.ts` and
 * `prove-job-canary.test.ts` for the orchestration tests, which share
 * `helpers/prove-job-rig.ts`'s simulated world that this file does not need.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { capability } from '../lib/capability-registry.js';
import type { ProofRecord } from '../lib/measured.js';
import { buildProofRecord } from '../runners/prove-job-record.js';
import type { ProofResult } from '../runners/prove-job-types.js';

// --- buildProofRecord: the budget judgement, over a REAL ProofResult shape ---

const JDK21 = capability('jdk21')!;

function proofResult(over: Partial<ProofResult> = {}): ProofResult {
	return {
		ok: true,
		verdict: 'pass',
		node: 'claw-4',
		repo: JDK21.jobProof!.repo,
		workflow: JDK21.jobProof!.workflow,
		job: JDK21.jobProof!.job,
		ref: 'main',
		dispatchRef: 'main',
		capability: 'jdk21',
		labels: ['self-hosted', 'hadoku-builder', 'jdk21'],
		labelSource: 'runs-on',
		runId: 1,
		jobId: 1,
		jobConclusion: 'success',
		runnerName: 'jit-claw-4-proof-hadoku-cardtable-j0-r0-1',
		durationSec: 300,
		ranOnTarget: true,
		attempts: [],
		evidence: ['two friends play one Forge match'],
		findings: [],
		minted: [],
		staleCleaned: [],
		teardown: { ok: true, runners: [], cancelledRuns: [], problems: [] },
		startedAt: new Date(0).toISOString(),
		finishedAt: new Date(1000).toISOString(),
		...over,
	};
}

const otherProof = (over: Partial<ProofRecord> = {}): ProofRecord => ({
	node: 'claw-8',
	capability: 'jdk21',
	runId: 2,
	runner: 'jit-claw-8-proof-hadoku-cardtable-j0-r0-2',
	conclusion: 'success',
	durationSec: 300,
	evidenceMatched: true,
	budgetSec: null,
	verdict: 'pass',
	why: 'pass (budget unbootstrapped: 1/2 proven node(s))',
	at: new Date().toISOString(),
	...over,
});

/** The record, failing the test if the run was judged inconclusive. */
function recordOf(built: ReturnType<typeof buildProofRecord>): ProofRecord {
	assert.ok(
		'record' in built,
		`expected a record, got inconclusive: ${'inconclusive' in built ? built.inconclusive : ''}`
	);
	return built.record;
}

test('buildProofRecord: unbootstrapped PASSES on the raw result alone, and records why', () => {
	const rec = recordOf(buildProofRecord(JDK21, proofResult(), []));
	assert.equal(rec.node, 'claw-4');
	assert.equal(rec.capability, 'jdk21');
	assert.equal(rec.verdict, 'pass');
	assert.match(rec.why, /unbootstrapped: 0\/2/);
	assert.equal(rec.budgetSec, null);
	assert.equal(rec.runId, 1);
	assert.equal(rec.runner, 'jit-claw-4-proof-hadoku-cardtable-j0-r0-1');
	assert.equal(rec.evidenceMatched, true);
});

test('buildProofRecord: bootstrapped and OVER budget FAILS, even though the job itself passed', () => {
	const rec = recordOf(
		buildProofRecord(JDK21, proofResult({ durationSec: 10_000 }), [
			otherProof({ node: 'claw-8', durationSec: 300 }),
			otherProof({ node: 'claw-9', durationSec: 300 }),
		])
	);
	assert.equal(rec.verdict, 'fail');
	assert.match(rec.why, /against a/);
	assert.equal(rec.budgetSec, 300 * 1.5);
});

test('buildProofRecord: bootstrapped and WITHIN budget passes', () => {
	const rec = recordOf(
		buildProofRecord(JDK21, proofResult({ durationSec: 400 }), [
			otherProof({ node: 'claw-8', durationSec: 300 }),
			otherProof({ node: 'claw-9', durationSec: 300 }),
		])
	);
	assert.equal(rec.verdict, 'pass');
});

test('buildProofRecord: a job that ran on the node with no evidence FAILS regardless of budget state', () => {
	const noEvidence = recordOf(buildProofRecord(JDK21, proofResult({ evidence: [] }), []));
	assert.equal(noEvidence.verdict, 'fail');
	assert.match(noEvidence.why, /no evidence/);
	const failed = recordOf(
		buildProofRecord(JDK21, proofResult({ verdict: 'fail', jobConclusion: 'failure' }), [])
	);
	assert.equal(failed.verdict, 'fail');
	assert.match(failed.why, /concluded "failure"/);
});

// 2026-10-08: the first live canaries on claw-4 and claw-8 lost the dispatch
// to other jdk21 listeners and were filed as FAIL, withholding jdk21 from two
// healthy claws. A run that never ran on the node says nothing about it.
test('buildProofRecord: a job that never ran on the node is INCONCLUSIVE and builds no record', () => {
	const lostRace = buildProofRecord(
		JDK21,
		proofResult({
			verdict: 'lost-race',
			ranOnTarget: false,
			jobConclusion: 'success',
			runnerName: 'jit-claw-9-hadoku-cardtable-1',
			attempts: [
				{
					attempt: 1,
					runId: 1,
					jobId: 1,
					runnerName: 'jit-claw-9-hadoku-cardtable-1',
					jobConclusion: null,
					ranOnTarget: false,
				},
			],
		}),
		[]
	);
	assert.ok('inconclusive' in lostRace, 'a lost race must not become a record');
	assert.match(lostRace.inconclusive, /never ran on claw-4.*jit-claw-9/);

	for (const verdict of ['error', 'timeout'] as const) {
		const r = buildProofRecord(
			JDK21,
			proofResult({ verdict, ranOnTarget: false, jobConclusion: null, durationSec: null }),
			[]
		);
		assert.ok('inconclusive' in r, `${verdict} before landing must not become a record`);
	}
});

test('buildProofRecord: a green job whose log could not be read is INCONCLUSIVE, not "no evidence"', () => {
	const r = buildProofRecord(
		JDK21,
		proofResult({
			verdict: 'error',
			evidence: [],
			findings: [{ rule: 'log-unreadable', message: 'HTTP 502' }],
		}),
		[]
	);
	assert.ok('inconclusive' in r);
	assert.match(r.inconclusive, /log could not be read/);
});

test('buildProofRecord: a job that landed and did not finish in time FAILS — the node ran it', () => {
	const r = recordOf(
		buildProofRecord(
			JDK21,
			proofResult({
				verdict: 'timeout',
				ranOnTarget: false,
				jobConclusion: null,
				durationSec: null,
				attempts: [
					{
						attempt: 1,
						runId: 1,
						jobId: 1,
						runnerName: 'jit-claw-4-proof-hadoku-cardtable-j0-r0-1',
						jobConclusion: null,
						ranOnTarget: true,
					},
				],
			}),
			[]
		)
	);
	assert.equal(r.verdict, 'fail');
	assert.match(r.why, /did not finish/);
});

test("buildProofRecord: `at` is NOW, not the proof's own startedAt/finishedAt", () => {
	const now = new Date('2026-10-08T12:00:00Z');
	const rec = recordOf(buildProofRecord(JDK21, proofResult(), [], { now }));
	assert.equal(rec.at, now.toISOString());
});
