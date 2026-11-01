/**
 * `fleet failures` — strict argv (run DIRECTLY, bypassing the door, same rig
 * `job-rollups.test.mjs` uses) PLUS a functional pass over a fixture rollup
 * store, since this script's whole job is reading that store and wiring it
 * into `computeFailureRates` — the statistic itself is unit-tested in
 * `src/tests/failure-rates.test.ts` and is not re-derived here.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, cleanupTempDirs } from './lib/test-tmpdir.mjs';

after(cleanupTempDirs);

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'failures.mjs');

const STUBS = [
	'ssh',
	'scp',
	'rsync',
	'gh',
	'sudo',
	'apt',
	'apt-get',
	'systemctl',
	'npm',
	'pnpm',
	'curl',
];

function sandbox() {
	const dir = tempDir('failures-strict-argv-');
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	mkdirSync(join(dir, 'home'));
	mkdirSync(join(dir, 'state'));
	const log = join(dir, 'touched.log');
	for (const s of STUBS) {
		writeFileSync(join(bin, s), `#!/bin/sh\necho "${s} $*" >> "${log}"\nexit 97\n`);
		chmodSync(join(bin, s), 0o755);
	}
	return { dir, bin, log };
}

function run(args, sb) {
	return spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: 'utf8',
		timeout: 15_000,
		env: {
			PATH: `${sb.bin}:${process.env.PATH}`,
			HOME: join(sb.dir, 'home'),
			HADOKU_STATE_DIR: join(sb.dir, 'state'),
			FLEET_MANIFEST_DIR: join(sb.dir, 'no-manifests'),
			HADOKU_SITE_ROOT: join(sb.dir, 'no-site'),
			REPOS_DIR: join(sb.dir, 'no-repos'),
			MGMT_API_URL: 'http://127.0.0.1:9',
			FLEET_NO_BANNER: '1',
		},
	});
}

test('fleet-manager#F8: failures.mjs run DIRECTLY with an unknown flag exits 2 and touches nothing', () => {
	const sb = sandbox();
	const r = run(['--not-a-real-flag'], sb);
	const touched = existsSync(sb.log) ? readFileSync(sb.log, 'utf8').trim() : '';
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.match(r.stdout + r.stderr, /unknown flag\(s\) --not-a-real-flag/);
	assert.equal(touched, '', `failures.mjs called external tools:\n${touched}`);
});

test('--help still answers, even in the same sandbox', () => {
	const sb = sandbox();
	const r = run(['--help'], sb);
	const touched = existsSync(sb.log) ? readFileSync(sb.log, 'utf8').trim() : '';
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(touched, '', `failures.mjs --help called external tools:\n${touched}`);
});

test('no store at all is "could not look", not "zero failures" — exit 1', () => {
	const sb = sandbox();
	const r = run(['--json'], sb);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, false);
	assert.match(doc.error, /no rollups at/);
});

test('--days must be a positive integer', () => {
	const sb = sandbox();
	const r = run(['--days', 'nope', '--json'], sb);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, false);
	assert.match(doc.error, /--days must be a positive integer/);
});

// ── functional: a real fixture rollup store, read for real ────────────────

const NO_SPREAD = { n: 0, p50: null, p95: null };
function zoneCounts(partial = {}) {
	return { runner: 0, seam: 0, content: 0, fleet: 0, cancelled: 0, ...partial };
}
function row(node, repo, kind, jobs, fails = {}) {
	const z = zoneCounts(fails);
	const failed = Object.values(z).reduce((a, b) => a + b, 0);
	return {
		node,
		repo,
		kind,
		jobs,
		conclusions: { success: jobs - failed, failure: failed },
		failuresByZone: z,
		durationSec: NO_SPREAD,
		queueSec: NO_SPREAD,
		dispatchSec: NO_SPREAD,
		assignSec: NO_SPREAD,
		setupSec: NO_SPREAD,
		byClass: {},
	};
}

function fixtureStore(sb) {
	const day = new Date().toISOString().slice(0, 10);
	const rollup = {
		schema: 1,
		day,
		writtenAt: `${day}T06:00:00.000Z`,
		completeSince: `${day}T00:00:00.000Z`,
		records: 200,
		probesExcluded: 0,
		rows: [
			// fleet rate 5% (10/200) — well above minCellFleetJobs (20), so the
			// cell itself is never excluded for any node below.
			row('*', 'WolffM/hadoku-cardtable', 'build', 200, { runner: 10 }),
			// double the fleet's rate, enough volume to be significant
			row('claw-1', 'WolffM/hadoku-cardtable', 'build', 100, { runner: 10 }),
			// exactly the fleet's rate
			row('claw-2', 'WolffM/hadoku-cardtable', 'build', 100, { runner: 5 }),
			// below minNodeJobs (30, default): the ONLY node in this fixture that
			// reaches the insufficientData branch. Without this row nothing here
			// ever exercised it — the 2026-11-01 test audit's finding against
			// this file (`failures.test.mjs:181-188`): a test titled "... and
			// marks insufficient data" whose fixture could not reach that branch.
			row('claw-3', 'WolffM/hadoku-cardtable', 'build', 10, { runner: 2 }),
		],
	};
	writeFileSync(join(sb.dir, 'state', 'job-rollups.jsonl'), `${JSON.stringify(rollup)}\n`);
}

test('a real fixture store: ranks the excess node first, the fleet-normal node not flagged', () => {
	const sb = sandbox();
	fixtureStore(sb);
	const r = run(['--json'], sb);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, true);
	assert.deepEqual(doc.zones, ['runner', 'seam']);

	const byNode = Object.fromEntries(doc.nodes.map((n) => [n.node, n]));
	assert.equal(byNode['claw-1'].observed, 10);
	assert.equal(byNode['claw-1'].expected, 5);
	assert.equal(byNode['claw-1'].excess, 5);
	assert.equal(byNode['claw-1'].insufficientData, false);

	assert.equal(byNode['claw-2'].excess, 0);
	assert.equal(byNode['claw-2'].z, 0);

	// claw-3 has only 10 pooled jobs, below the default minNodeJobs (30) — the
	// branch `human mode ... marks insufficient data` below claims to exercise
	// but, before this fixture carried an under-threshold row, never did.
	assert.equal(byNode['claw-3'].insufficientData, true);
	assert.match(
		byNode['claw-3'].insufficientReason,
		/only 10 job\(s\) in judgeable cells \(need 30\)/
	);
	assert.equal(byNode['claw-3'].z, null, 'insufficient data gets no z-score, not a fabricated one');
	assert.equal(byNode['claw-3'].pValue, null);

	assert.equal(doc.nodes[0].node, 'claw-1', 'the node with real excess ranks first');
	assert.equal(
		doc.nodes[doc.nodes.length - 1].node,
		'claw-3',
		'an insufficientData node sorts after every measured one'
	);
});

test('--node filters the shown rows without changing the baseline computation', () => {
	const sb = sandbox();
	fixtureStore(sb);
	const r = run(['--node', 'claw-2', '--json'], sb);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.nodes.length, 1);
	assert.equal(doc.nodes[0].node, 'claw-2');
	// Unaffected by --node: claw-2's own excess is still computed against the
	// SAME fleet baseline (0), not against a baseline of itself alone.
	assert.equal(doc.nodes[0].excess, 0);
});

test('human mode renders a table and marks insufficient data', () => {
	const sb = sandbox();
	fixtureStore(sb);
	const r = run([], sb);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /claw-1/);
	assert.match(r.stdout, /claw-2/);
	// claw-3 is the fixture's only under-threshold node (10 jobs, below
	// minNodeJobs=30): this is the one line in the table that must render
	// `insufficient` rather than a fabricated `z=.. p=..`.
	assert.match(r.stdout, /claw-3\s+10\s.*insufficient/);
});
