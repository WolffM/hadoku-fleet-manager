import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { writeProof } from '../dist/lib/measured-proof.js';
import { printProveResults } from './lib/bootcamp-canary.mjs';

import {
	CLAW,
	DOCKER_PRESENT_CASE,
	BACKSTOP_TOOLS_PRESENT_CASE,
	JDK_PRESENT_CASE,
	NO_DATA_ENDPOINT,
	run,
	SCRIPTS,
} from './lib/bootcamp-fixtures.mjs';

// ---------------------------------------------------------------------------
// `--prove` (wave 4e, #102) — the CPU pre-filter and the `--due` freshness
// skip, the two gates that fire BEFORE bootcamp would ever drain a node or
// shell out to `fleet prove-job`. The canary-dispatch path itself is already
// proven end to end in `prove-job.test.mjs`/`prove-job.test.ts`; re-driving a
// real drain + a real prove-job subprocess from inside THIS fixture would
// mean standing up a second, parallel copy of that machinery, so this stays
// at the boundary: does bootcamp correctly SKIP, naming why, without ever
// reaching for the node a second time.
//
// RAM IS KEPT BELOW `JDK21_MIN_INSTALLED_MB` DELIBERATELY: `maven`'s REPAIRS
// entry installs on any node whose declared RAM clears that floor, regardless
// of whether it has earned the label yet (the two are independent — see
// `toolchain-floor.mjs`). A low-RAM fixture node never triggers that install
// attempt; the JDK itself applies to every claw and the shim answers its
// detect as present, so the probe is the only thing these two tests are about.
function proveFixture({ cores = 8, excludeRepos } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-bootcamp-prove-'));
	const manifestDir = join(root, 'manifests');
	const stateDir = join(root, 'state');
	const bin = join(root, 'bin');
	for (const d of [manifestDir, stateDir, bin]) mkdirSync(d, { recursive: true });
	const manifestPath = join(manifestDir, 'fleet-runner-manifest.json');
	writeFileSync(
		manifestPath,
		JSON.stringify(
			{
				toolchain: { capabilities: [] },
				machines: {
					[CLAW]: {
						role: 'claw',
						labels: [],
						maxConcurrent: 2,
						minFreeMb: 1024,
						cores,
						ramGb: 8, // below JDK21_MIN_INSTALLED_MB (12 GiB) — no install attempt
						...(excludeRepos ? { excludeRepos } : {}),
					},
				},
			},
			null,
			2
		)
	);
	const calls = join(root, 'calls.log');
	const sshShim = join(bin, 'ssh');
	writeFileSync(
		sshShim,
		[
			'#!/bin/sh',
			'script="$(cat)"',
			'case "$script" in',
			JDK_PRESENT_CASE,
			DOCKER_PRESENT_CASE,
			BACKSTOP_TOOLS_PRESENT_CASE,
			'  *)',
			`    echo PROBE >>${JSON.stringify(calls)}`,
			"    printf 'CAP jdk21 ok 21.0.1\\nPROBE-END\\n' ;;",
			'esac',
			'',
		].join('\n')
	);
	chmodSync(sshShim, 0o755);
	return {
		root,
		manifestPath,
		stateDir,
		calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: manifestDir,
			HADOKU_STATE_DIR: stateDir,
			HADOKU_SITE_ROOT: root,
			FLEET_DATA_URL: NO_DATA_ENDPOINT,
			PATH: `${bin}:${process.env.PATH}`,
		},
	};
}

test('--prove is OFF by default — no CPU check, no $proof read, no canary, byte-identical to before this wave', () => {
	const f = proveFixture({ cores: 4 });
	try {
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		assert.ok(!('prove' in doc), 'the prove key is absent entirely without the flag');
		assert.deepEqual(f.calls(), ['PROBE'], 'exactly the existing probe, nothing more');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("--prove skips an undersized node's canary on the CPU floor — one probe, never a drain", () => {
	const f = proveFixture({ cores: 4 }); // claw-3-shaped: below JDK21_CANARY_MIN_THREADS (6)
	try {
		const r = run(['--machine', CLAW, '--no-push', '--prove', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		assert.deepEqual(doc.prove, [
			{
				node: CLAW,
				capability: 'jdk21',
				status: 'skipped',
				reason: 'CPU floor not met for the canary (cores=4)',
			},
		]);
		assert.deepEqual(
			f.calls(),
			['PROBE'],
			'the pre-filter decided without ever draining the node or shelling out to prove-job'
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('--prove --due <n> skips a node with an existing FRESH pass — "not due yet", no canary attempted', () => {
	const f = proveFixture({ cores: 8 }); // clears the CPU floor
	try {
		writeProof(
			{
				node: CLAW,
				capability: 'jdk21',
				runId: 1,
				runner: 'jit-fixture-claw-1-proof-hadoku-cardtable-j0-r0-1',
				conclusion: 'success',
				durationSec: 300,
				evidenceMatched: true,
				budgetSec: null,
				verdict: 'pass',
				why: 'pass (budget unbootstrapped: 0/2 proven node(s))',
				at: new Date(Date.now() - 1 * 86_400_000).toISOString(),
			},
			{ dir: f.stateDir }
		);
		const r = run(['--machine', CLAW, '--no-push', '--prove', '--due', '30', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		assert.equal(doc.prove.length, 1);
		assert.equal(doc.prove[0].status, 'not-due');
		assert.match(doc.prove[0].reason, /last pass .* \(1\.0\/30d\)/);
		assert.deepEqual(f.calls(), ['PROBE'], 'an existing fresh pass never triggers a new canary');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('--prove waits out --due after a FAIL too, so a failing node is not drained every night', () => {
	const f = proveFixture({ cores: 8 });
	try {
		writeProof(
			{
				node: CLAW,
				capability: 'jdk21',
				runId: 1,
				runner: 'jit-fixture-claw-1-proof-hadoku-cardtable-j0-r0-1',
				conclusion: 'failure',
				durationSec: 300,
				evidenceMatched: false,
				budgetSec: null,
				verdict: 'fail',
				why: 'the job failed',
				at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
			},
			{ dir: f.stateDir }
		);
		const r = run(['--machine', CLAW, '--no-push', '--prove', '--due', '25', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		assert.equal(doc.prove[0].status, 'not-due');
		assert.match(doc.prove[0].reason, /last fail .* \(3\.0\/25d\)/);
		assert.deepEqual(f.calls(), ['PROBE']);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('--prove retries at once after an ERROR: it says nothing about the node, so it never waits out --due', () => {
	const f = proveFixture({ cores: 8 });
	try {
		writeProof(
			{
				node: CLAW,
				capability: 'jdk21',
				runId: 1,
				runner: null,
				conclusion: null,
				durationSec: null,
				evidenceMatched: false,
				budgetSec: null,
				verdict: 'error',
				why: 'the workflow skipped the job',
				at: new Date(Date.now() - 1 * 86_400_000).toISOString(),
			},
			{ dir: f.stateDir }
		);
		const r = run(['--machine', CLAW, '--no-push', '--prove', '--due', '25', '--json'], f.env);
		const doc = JSON.parse(r.out);
		assert.notEqual(doc.prove[0].status, 'not-due', JSON.stringify(doc.prove));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("--prove skips a node that excludes the canary's repo — never drained for a proof it cannot use", () => {
	const f = proveFixture({
		cores: 8,
		excludeRepos: { 'WolffM/hadoku-cardtable': 'fixture: declines cardtable' },
	});
	try {
		const r = run(['--machine', CLAW, '--no-push', '--prove', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		assert.deepEqual(doc.prove, [
			{
				node: CLAW,
				capability: 'jdk21',
				status: 'skipped',
				reason: 'WolffM/hadoku-cardtable is excluded on this node',
			},
		]);
		assert.deepEqual(f.calls(), ['PROBE']);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a DUE canary that could not run (never went quiet, drain refused) is a finding; a not-due or excluded one is not', () => {
	const lines = [];
	const ctx = { findings: 0, log: (m) => lines.push(m) };
	printProveResults(ctx, [
		{
			node: 'claw-8',
			capability: 'jdk21',
			status: 'deferred',
			reason: 'never went quiet: timed out',
		},
		{ node: 'claw-9', capability: 'jdk21', status: 'not-due', reason: 'last pass … (1.0/25d)' },
		{ node: 'claw-1', capability: 'jdk21', status: 'skipped', reason: 'excluded' },
	]);
	assert.equal(ctx.findings, 1);
	assert.ok(lines.some((l) => /DEFERRED: jdk21@claw-8 — never went quiet/.test(l)));
});

// ── the canary's capture is file-based, not a pipe (F6, #33) ───────────────
//
// `runCanary` is not exported from the CLI; since wave 5p lane D it lives in
// `scripts/lib/bootcamp-canary.mjs` (bootcamp.mjs passes its flags and
// run-scoped state in through `ctx`), and the comment above this block
// already explains why a real drain + a real prove-job subprocess is not
// re-driven from this fixture: it would stand up a second copy of that
// machinery. The CORRECTNESS of the file-vs-pipe fix is proven directly
// against the shared helper in `spawn-json.test.mjs` ("a large document
// survives whole"); this is the TOPOLOGY half — that `runCanary` actually
// calls through that helper, with the same argv and ceiling the old
// `execFileSync` call used, so a revert to the pipe-capturing shape is caught
// here even though no fixture drives a real canary this big.
test('the canary reads fleet prove-job through spawnJsonToFile, not a pipe', () => {
	const src = readFileSync(join(SCRIPTS, 'lib', 'bootcamp-canary.mjs'), 'utf8');
	assert.match(src, /import \{ spawnJsonToFile \} from '\.\/spawn-json\.mjs';/);
	assert.ok(
		!src.includes("from 'node:child_process'"),
		'execFileSync is no longer imported at all'
	);
	const canary = src.slice(
		src.indexOf('async function runCanary'),
		src.indexOf('async function proveWorkloads')
	);
	assert.doesNotMatch(
		canary,
		/execFileSync\(/,
		'the prove-job spawn must not go back to a pipe-capturing execFileSync call'
	);
	assert.match(
		canary,
		/spawnJsonToFile\(\s*process\.execPath,\s*\[ctx\.PROVE_JOB_SCRIPT, '--node', name, '--capability', id, '--json', '--under-own-drain'\],\s*\{ timeoutMs: 45 \* 60_000 \}\s*\)/,
		'the same argv and 45-minute ceiling the old execFileSync call used'
	);
	assert.match(
		canary,
		/doc === null/,
		'parseable stdout — not the exit code — decides the outcome'
	);
});
