import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	ageText,
	describeProof,
	mergeProof,
	proofKey,
	proofPath,
	readProofs,
	recordProof,
} from './job-proof-record.mjs';

const NOW = 1_790_000_000_000;
const iso = (agoMs) => new Date(NOW - agoMs).toISOString();
const result = (over = {}) => ({
	capability: 'taskauto',
	repo: 'WolffM/hadoku-tenhands',
	workflow: 'test.yml',
	job: 'backend pytest',
	verdict: 'pass',
	ok: true,
	runId: 11,
	jobId: 22,
	runnerName: 'jit-claw-8-proof-x-j0-r0-1',
	jobConclusion: 'success',
	ranOnTarget: true,
	evidence: ['a', 'b'],
	finishedAt: iso(3_600_000),
	...over,
});

function dir() {
	return mkdtempSync(join(tmpdir(), 'fleet-proofs-'));
}

test('a pass is filed under node::capability, with last and lastPass', () => {
	const m = mergeProof({}, 'claw-8', result());
	assert.deepEqual(Object.keys(m), ['claw-8::taskauto']);
	assert.equal(m['claw-8::taskauto'].last.ok, true);
	assert.deepEqual(m['claw-8::taskauto'].lastPass, m['claw-8::taskauto'].last);
	assert.equal(m['claw-8::taskauto'].last.evidenceLines, 2);
	assert.equal(
		'evidence' in m['claw-8::taskauto'].last,
		false,
		'the ledger must not grow with logs'
	);
});

test('a later FAILURE does not erase the last pass', () => {
	const pass = mergeProof({}, 'claw-8', result());
	const m = mergeProof(
		pass,
		'claw-8',
		result({ verdict: 'lost-race', ok: false, ranOnTarget: false })
	);
	assert.equal(m['claw-8::taskauto'].last.verdict, 'lost-race');
	assert.equal(m['claw-8::taskauto'].lastPass.verdict, 'pass');
});

test('a REFUSED run is not recorded — nothing was attempted, and it must not erase a proof', () => {
	const pass = mergeProof({}, 'claw-8', result());
	assert.equal(mergeProof(pass, 'claw-8', result({ verdict: 'refused', ok: false })), pass);
});

test('an ad-hoc job is filed by the job, not by a capability', () => {
	assert.equal(
		proofKey('claw-8', { repo: 'a/b', workflow: 'w.yml', job: 'j' }),
		'claw-8::job:a/b/w.yml/j'
	);
});

test('recordProof writes atomically, and refuses to overwrite a ledger it cannot read', () => {
	const d = dir();
	try {
		assert.deepEqual(recordProof(d, 'claw-8', result()), { ok: true, written: true });
		assert.equal(JSON.parse(readFileSync(proofPath(d), 'utf8'))['claw-8::taskauto'].last.runId, 11);
		writeFileSync(proofPath(d), '{ not json');
		const bad = recordProof(d, 'claw-8', result());
		assert.equal(bad.ok, false);
		assert.match(bad.reason, /not overwriting an unreadable ledger/);
		assert.equal(
			readFileSync(proofPath(d), 'utf8'),
			'{ not json',
			'the damaged file is left for a person'
		);
		assert.equal(readProofs(d).ok, false);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test('a missing ledger is an empty ledger, not an error', () => {
	const d = dir();
	try {
		assert.deepEqual(readProofs(d), { ok: true, proofs: {} });
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test('describeProof: never proved, passed (with its age), and failing-since', () => {
	const none = describeProof(undefined, 'taskauto', 'claw-8', NOW);
	assert.equal(none.state, 'none');
	assert.match(
		none.line,
		/never proved by a job here \(fleet prove-job --node claw-8 --capability taskauto\)/
	);

	const pass = describeProof(
		mergeProof({}, 'claw-8', result())['claw-8::taskauto'],
		'taskauto',
		'claw-8',
		NOW
	);
	assert.equal(pass.state, 'pass');
	assert.match(pass.line, /PASSED .* \(60 min ago\), run 11 on jit-claw-8-proof/);

	const failing = mergeProof(
		mergeProof({}, 'claw-8', result({ finishedAt: iso(5 * 86_400_000) })),
		'claw-8',
		result({ verdict: 'lost-race', ok: false, finishedAt: iso(60_000) })
	)['claw-8::taskauto'];
	const d = describeProof(failing, 'taskauto', 'claw-8', NOW);
	assert.equal(d.state, 'failing');
	assert.match(d.line, /last attempt lost-race .*\(1 min ago\); last pass .*\(5\.0 d ago\)/);
});

test('ageText picks the unit that reads naturally and survives garbage', () => {
	assert.equal(ageText(30 * 60_000), '30 min');
	assert.equal(ageText(5 * 3_600_000), '5.0 h');
	assert.equal(ageText(3 * 86_400_000), '3.0 d');
	assert.equal(ageText(Number.NaN), 'age unknown');
});
