import test from 'node:test';
import assert from 'node:assert/strict';

import { capability } from '../lib/capability-registry.js';
import {
	workloadGatedCapabilities,
	isProofFresh,
	freshPassingProofs,
	proofBudget,
	judgeWorkloadProof,
	workloadGateStatus,
	workloadGateReasons,
	WORKLOAD_PROOF_DUE_DAYS,
} from '../lib/workload-gate.js';
import { proof, jdk21Earner } from './capability-fixtures.js';

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

test('workloadGatedCapabilities is jdk21 alone — a budget is the discriminator, not merely having a jobProof', () => {
	assert.deepEqual(workloadGatedCapabilities(), ['jdk21']);
});

test('isProofFresh: within the 30-day cadence is fresh, past it is not, and a tie is fresh', () => {
	// ONE clock for both sides. `ago()` reads Date.now() and isProofFresh reads
	// it again, so under load the "exact tie" landed a millisecond past 30 days
	// and failed: it refused two pushes on 2026-10-10 inside the shifted-clock
	// guard, and passed every time it was rerun alone.
	const now = new Date();
	const at = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
	assert.equal(isProofFresh(proof({ at: at(1) }), now), true);
	assert.equal(isProofFresh(proof({ at: at(29) }), now), true);
	assert.equal(
		isProofFresh(proof({ at: at(30) }), now),
		true,
		'exactly the boundary counts as fresh'
	);
	assert.equal(isProofFresh(proof({ at: at(31) }), now), false);
	assert.equal(
		WORKLOAD_PROOF_DUE_DAYS,
		30,
		'pinned to the same cadence as fleet benchmark --due 30'
	);
});

test('freshPassingProofs: only the matching capability, a PASS, and fresh', () => {
	const records = [
		proof({ node: 'claw-4' }),
		proof({ node: 'claw-8', verdict: 'fail' }),
		proof({ node: 'claw-9', at: ago(60) }),
		proof({ node: 'claw-5', capability: 'other' }),
	];
	assert.deepEqual(
		freshPassingProofs(records, 'jdk21').map((r) => r.node),
		['claw-4']
	);
});

test('proofBudget: unbootstrapped below minProven, bootstrapped at it, median x factor', () => {
	const cap = capability('jdk21')!; // factor 1.5, minProven 2
	const one = proofBudget(cap, [proof({ node: 'claw-4', durationSec: 300 })]);
	assert.equal(one.bootstrapped, false);
	assert.equal(one.budgetSec, null);
	assert.equal(one.provenCount, 1);

	const two = proofBudget(cap, [
		proof({ node: 'claw-4', durationSec: 300 }),
		proof({ node: 'claw-8', durationSec: 500 }),
	]);
	assert.equal(two.bootstrapped, true);
	assert.equal(two.provenCount, 2);
	assert.equal(two.budgetSec, 400 * 1.5, 'median of 300/500 is 400, x the 1.5 factor');

	const three = proofBudget(cap, [
		proof({ node: 'claw-4', durationSec: 300 }),
		proof({ node: 'claw-8', durationSec: 500 }),
		proof({ node: 'claw-9', durationSec: 700 }),
	]);
	assert.equal(three.budgetSec, 500 * 1.5, 'odd count: the middle value, no averaging');

	// STALE and FAIL records, and a different capability, never feed the median.
	const poisoned = proofBudget(cap, [
		proof({ node: 'claw-4', durationSec: 300 }),
		proof({ node: 'claw-8', durationSec: 999_999, verdict: 'stale' }),
		proof({ node: 'claw-9', durationSec: 999_999, verdict: 'fail' }),
		proof({ node: 'claw-5', durationSec: 999_999, capability: 'other' }),
	]);
	assert.equal(poisoned.provenCount, 1, 'only the one real pass counts');

	assert.deepEqual(proofBudget(undefined, []), {
		bootstrapped: false,
		budgetSec: null,
		provenCount: 0,
	});
});

test('judgeWorkloadProof: a job that did not land, failed, or had no evidence is FAIL, named why', () => {
	const cap = capability('jdk21')!;
	const unbootstrapped = { bootstrapped: false, budgetSec: null, provenCount: 0 };
	assert.equal(
		judgeWorkloadProof(
			cap,
			{ conclusion: null, ranOnTarget: false, evidenceMatched: false, durationSec: null },
			unbootstrapped
		).verdict,
		'fail'
	);
	assert.equal(
		judgeWorkloadProof(
			cap,
			{ conclusion: 'failure', ranOnTarget: true, evidenceMatched: false, durationSec: 100 },
			unbootstrapped
		).verdict,
		'fail'
	);
	assert.match(
		judgeWorkloadProof(
			cap,
			{ conclusion: 'failure', ranOnTarget: true, evidenceMatched: false, durationSec: 100 },
			unbootstrapped
		).why,
		/concluded "failure"/
	);
	const noEvidence = judgeWorkloadProof(
		cap,
		{ conclusion: 'success', ranOnTarget: true, evidenceMatched: false, durationSec: 100 },
		unbootstrapped
	);
	assert.equal(noEvidence.verdict, 'fail');
	assert.match(noEvidence.why, /no evidence/);
});

test('judgeWorkloadProof: unbootstrapped PASSES on conclusion+evidence alone, and says so', () => {
	const cap = capability('jdk21')!;
	const r = judgeWorkloadProof(
		cap,
		{ conclusion: 'success', ranOnTarget: true, evidenceMatched: true, durationSec: 100_000 },
		{ bootstrapped: false, budgetSec: null, provenCount: 1 }
	);
	assert.equal(r.verdict, 'pass');
	assert.match(r.why, /unbootstrapped: 1\/2/);
});

test('judgeWorkloadProof: bootstrapped enforces the budget — within it passes, over it fails', () => {
	const cap = capability('jdk21')!;
	const bootstrapped = { bootstrapped: true, budgetSec: 600, provenCount: 2 };
	const within = judgeWorkloadProof(
		cap,
		{ conclusion: 'success', ranOnTarget: true, evidenceMatched: true, durationSec: 599 },
		bootstrapped
	);
	assert.equal(within.verdict, 'pass');
	const over = judgeWorkloadProof(
		cap,
		{ conclusion: 'success', ranOnTarget: true, evidenceMatched: true, durationSec: 601 },
		bootstrapped
	);
	assert.equal(over.verdict, 'fail');
	assert.match(over.why, /against a 10\.0 min/);
	const noDuration = judgeWorkloadProof(
		cap,
		{ conclusion: 'success', ranOnTarget: true, evidenceMatched: true, durationSec: null },
		bootstrapped
	);
	assert.equal(noDuration.verdict, 'fail');
	assert.match(noDuration.why, /no duration recorded/);
});

test('workloadGateStatus: DORMANT offers regardless of a missing record — "routing stays exactly as today"', () => {
	const cap = capability('jdk21')!; // minProven 2
	const s = workloadGateStatus(cap, null, 1);
	assert.equal(s.offer, true);
	assert.equal(s.active, false);
	assert.match(s.reason, /dormant: 1\/2/);
});

test('workloadGateStatus: ACTIVE withholds with no record, offers a fresh pass', () => {
	const cap = capability('jdk21')!;
	const noRecord = workloadGateStatus(cap, null, 2);
	assert.equal(noRecord.offer, false);
	assert.equal(noRecord.active, true);
	assert.match(noRecord.reason, /no workload proof/);
	const fresh = workloadGateStatus(cap, proof({ at: ago(1) }), 2);
	assert.equal(fresh.offer, true);
	assert.match(fresh.reason, /PASSED/);
});

test('workloadGateStatus: an EXPLICIT fail or stale withdraws the label whether the gate is active or dormant', () => {
	const cap = capability('jdk21')!;
	for (const provenCount of [0, 2]) {
		const failed = workloadGateStatus(
			cap,
			proof({ verdict: 'fail', why: '27/62 specs' }),
			provenCount
		);
		assert.equal(failed.offer, false, `provenCount=${provenCount}`);
		assert.match(failed.reason, /workload FAILED: 27\/62 specs/);
		const stale = workloadGateStatus(
			cap,
			proof({ verdict: 'stale', why: 'diverged' }),
			provenCount
		);
		assert.equal(stale.offer, false, `provenCount=${provenCount}`);
		assert.match(stale.reason, /workload STALE: diverged/);
	}
});

test('workloadGateStatus: an ACTIVE gate also withholds an EXPIRED pass — age, not just verdict', () => {
	const cap = capability('jdk21')!;
	const expired = workloadGateStatus(cap, proof({ at: ago(31) }), 2);
	assert.equal(expired.offer, false);
	assert.match(expired.reason, /EXPIRED/);
});

test('workloadGateStatus: a capability with no budget is never gated', () => {
	assert.deepEqual(workloadGateStatus(capability('taskauto'), null, 0), {
		offer: true,
		active: false,
		provenCount: 0,
		reason: 'not workload-gated',
	});
});

test('workloadGateReasons: reports only ids the node EARNED the tool for, one gate status each', () => {
	assert.deepEqual(workloadGateReasons({ labels: [] }, { jdk21: null }, { jdk21: 2 }), {});
	const reasons = workloadGateReasons(jdk21Earner(), { jdk21: null }, { jdk21: 2 });
	assert.deepEqual(Object.keys(reasons), ['jdk21']);
	assert.equal(reasons.jdk21.offer, false);
});
