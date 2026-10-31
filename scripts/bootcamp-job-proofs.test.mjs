import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';

import { mergeProof, proofPath } from './lib/job-proof-record.mjs';

import { args, CLAW, FFMPEG_ONLY, run, writableFixture } from './lib/bootcamp-fixtures.mjs';

// ── JOB PROOFS ARE REPORTED, NEVER WRITTEN OR REQUIRED (wave 3q lane E) ──────
//
// `fleet prove-job` records into the STATE directory; bootcamp only reads it.
// A proof in the manifest would be a commit and a commit restarts mgmt-api (#59).

const PROOF_RESULT = {
	capability: 'taskauto',
	repo: 'WolffM/hadoku-tenhands',
	workflow: 'test.yml',
	job: 'backend pytest',
	verdict: 'pass',
	ok: true,
	runId: 4242,
	jobId: 1,
	runnerName: 'jit-fixture-proof-hadoku-tenhands-j0-r0-1',
	jobConclusion: 'success',
	ranOnTarget: true,
	evidence: ['claude resolved'],
	finishedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
};

const writeLedger = (f, result) =>
	writeFileSync(
		proofPath(f.env.HADOKU_STATE_DIR),
		JSON.stringify(mergeProof({}, CLAW, result), null, 2)
	);

test('a node that carries taskauto reports its last job-proof and its age — and it is not a finding', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'], claudePresent: true });
	try {
		writeLedger(f, PROOF_RESULT);
		const r = run([...args, '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const row = JSON.parse(r.out).report[CLAW].jobProofs.find((p) => p.id === 'taskauto');
		assert.equal(row.state, 'pass');
		assert.match(row.line, /PASSED .*\(3\.0 h ago\), run 4242 on jit-fixture-proof/);
		const human = run(args, f.env);
		assert.match(human.out, /job-proof: taskauto — PASSED/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('no proof on record is said plainly, with the command — and never fails the run', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'], claudePresent: true });
	try {
		const r = run(args, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.match(
			r.out,
			/job-proof: taskauto — never proved by a job here \(fleet prove-job --node/
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a node that does not carry a job-proofed capability says nothing about it', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: [] });
	try {
		writeLedger(f, PROOF_RESULT);
		const r = run([...args, '--json'], f.env);
		assert.deepEqual(JSON.parse(r.out).report[CLAW].jobProofs, []);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a proof on record does not reach the manifest: --write stays idempotent (#59)', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'], claudePresent: true });
	try {
		const base = f.commits();
		assert.equal(run(args, f.env).code, 0);
		assert.equal(f.commits(), base + 1);
		const first = f.record();
		writeLedger(f, PROOF_RESULT);
		const second = run(args, f.env);
		assert.equal(second.code, 0, `${second.out}\n${second.err}`);
		assert.equal(f.commits(), base + 1, 'a proof made a manifest commit, which redeploys mgmt-api');
		assert.deepEqual(f.record(), first);
		assert.equal(
			JSON.stringify(f.record()).includes('4242'),
			false,
			'the proof leaked into $capabilities'
		);
		assert.match(second.out, /re-probed and UNCHANGED/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('an unreadable proof ledger is SAID, not read as "no proofs"', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'], claudePresent: true });
	try {
		writeFileSync(proofPath(f.env.HADOKU_STATE_DIR), '{ broken');
		const r = run([...args, '--json'], f.env);
		assert.equal(r.code, 0, 'the node is not at fault');
		const doc = JSON.parse(r.out);
		assert.match(doc.jobProofLedgerError, /job-proofs\.json/);
		assert.deepEqual(doc.report[CLAW].jobProofs, []);
		assert.match(run(args, f.env).out, /job-proof ledger unreadable/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
