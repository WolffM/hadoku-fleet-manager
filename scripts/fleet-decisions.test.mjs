/**
 * `fleet decisions` through the real door, against a state dir holding day
 * files shaped exactly as `decision-log.ts` writes them.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, cleanupTempDirs } from './lib/test-tmpdir.mjs';

after(cleanupTempDirs);

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'dist', 'cli.js');
const NOW = Date.now();
const iso = (agoSec) => new Date(NOW - agoSec * 1000).toISOString();
const day = (agoSec) => iso(agoSec).slice(0, 10);

const figures = (node, over = {}) => ({
	node,
	busy: 0,
	max: 2,
	units: 0,
	standing: 0,
	warmBusy: 0,
	warmHeld: 0,
	freeMb: 9000,
	requiredMb: 900,
	minFreeMb: 1536,
	heavyJobs: 0,
	runningHeavy: false,
	warmRepo: null,
	healthy: true,
	drained: false,
	schedulable: null,
	...over,
});

const row = (over) => ({
	v: 1,
	at: iso(120),
	path: 'jit',
	kind: 'placed',
	repo: 'WolffM/hadoku-cardtable',
	runId: 41002,
	jobId: 9002,
	jobName: 'forge-e2e (1)',
	labels: ['self-hosted', 'hadoku-builder', 'jdk21'],
	event: 'push',
	queuedSec: 30,
	heavy: true,
	order: ['claw-8', 'claw-4', 'claw-3', 'claw-9'],
	candidates: ['claw-9', 'claw-4', 'claw-3', 'claw-8'],
	refused: [],
	winner: 'claw-9',
	rule: {
		position: 0,
		rankedOver: { node: 'claw-4', key: 'busy' },
		viaAffinity: false,
		affinityMoved: false,
		busyAtChoice: 0,
		passIndex: 0,
	},
	outcome: 'minted',
	runner: 'jit-claw-9-hadoku-cardtable-j9002-r41002-1790000000',
	error: null,
	reason: null,
	action: null,
	capacity: [figures('claw-9', { max: 1 }), figures('claw-8', { busy: 1, heavyJobs: 1 })],
	fingerprint: '0123456789ab',
	...over,
});

function stateWith(files) {
	const state = tempDir('fleet-decisions-');
	const dir = join(state, 'dispatch-decisions');
	mkdirSync(dir, { recursive: true });
	for (const [name, rows] of Object.entries(files)) {
		writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
	}
	return state;
}

function fleet(state, ...args) {
	const r = spawnSync(process.execPath, [CLI, 'decisions', ...args], {
		encoding: 'utf8',
		env: { ...process.env, HADOKU_STATE_DIR: state, FLEET_NO_BANNER: '1' },
	});
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const placed = row({});
const refusedShard = row({
	at: iso(100),
	kind: 'unplaceable',
	jobId: 9003,
	jobName: 'forge-e2e (2)',
	winner: null,
	rule: null,
	outcome: null,
	runner: null,
	reason: 'no node can take this job right now',
	candidates: ['claw-4', 'claw-3', 'claw-8', 'claw-9'],
	refused: [
		{ node: 'claw-4', reason: 'does not carry self-hosted, hadoku-builder, jdk21' },
		{ node: 'claw-3', reason: 'repo excluded here: Forge OOMs on 8 GB' },
		{
			node: 'claw-8',
			reason: 'heavy hold: already running 1 heavy job(s) (queued 30s < 3600s)',
			holdSec: 3600,
		},
		{ node: 'claw-9', reason: 'at capacity: 1/1 in flight' },
	],
});
const warmListener = row({
	at: iso(90),
	path: 'warm',
	kind: 'warm-listener',
	repo: 'WolffM/hadoku_site',
	runId: null,
	jobId: null,
	jobName: null,
	labels: [],
	queuedSec: null,
	heavy: null,
	order: [],
	candidates: ['claw-4'],
	winner: 'claw-4',
	rule: null,
	outcome: null,
	runner: null,
	action: 'keep',
	capacity: [],
	fingerprint: null,
});
const lastWeek = row({ at: iso(7 * 86_400), jobId: 7001, runId: 40001 });

test('the default window is the last hour, and every row in it is printed with its refusals', () => {
	const state = stateWith({
		[`${day(120)}.jsonl`]: [placed, refusedShard, warmListener],
		[`${day(7 * 86_400)}.jsonl`]: [lastWeek],
	});
	const r = fleet(state);
	assert.equal(r.status, 0, r.stderr);
	assert.match(
		r.stdout,
		/jit\/placed WolffM\/hadoku-cardtable run 41002 job 9002 \(forge-e2e \(1\)\) -> claw-9/
	);
	assert.match(r.stdout, /ahead of claw-4 on busy/);
	assert.match(r.stdout, /^ {4}claw-3: repo excluded here: Forge OOMs on 8 GB$/m);
	assert.match(r.stdout, /warm\/warm-listener WolffM\/hadoku_site claw-4: keep/);
	assert.doesNotMatch(r.stdout, /job 7001/, 'last week is outside the default hour');
	assert.match(r.stdout, /3 decision\(s\) of 3 scanned/);
});

test('--job reaches across the whole retention window; --json is one document', () => {
	const state = stateWith({
		[`${day(120)}.jsonl`]: [placed, refusedShard],
		[`${day(7 * 86_400)}.jsonl`]: [lastWeek],
	});
	const r = fleet(state, '--job', '7001', '--json');
	assert.equal(r.status, 0, r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, true);
	assert.equal(doc.count, 1);
	assert.equal(doc.records[0].jobId, 7001);
	assert.deepEqual(doc.filter, { jobId: 7001 });
});

test('--node matches what a node won AND what it refused', () => {
	const state = stateWith({ [`${day(120)}.jsonl`]: [placed, refusedShard] });
	const doc = JSON.parse(fleet(state, '--node', 'claw-9', '--json').stdout);
	assert.deepEqual(
		doc.records.map((x) => x.jobId),
		[9002, 9003]
	);
	const only = JSON.parse(fleet(state, '--node', 'claw-3', '--json').stdout);
	assert.deepEqual(
		only.records.map((x) => x.jobId),
		[9003]
	);
});

test('no log directory is could-not-look: exit 1, and --json still parses', () => {
	const state = tempDir('fleet-decisions-');
	const r = fleet(state, '--json');
	assert.equal(r.status, 1);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, false);
	assert.equal(doc.why, 'no-log');
});

test('an empty window is an answer, and says how much it scanned', () => {
	const state = stateWith({ [`${day(7 * 86_400)}.jsonl`]: [lastWeek] });
	const r = fleet(state);
	assert.equal(r.status, 0);
	assert.match(r.stdout, /0 decision\(s\) of 0 scanned/);
});

test('bad arguments are refused, never ignored', () => {
	const state = stateWith({ [`${day(120)}.jsonl`]: [placed] });
	assert.equal(fleet(state, '--since', 'yesterday').status, 1);
	assert.equal(fleet(state, '--job', 'abc').status, 1);
	assert.equal(fleet(state, '--jobs', '1').status, 1);
	const doc = JSON.parse(fleet(state, '--frobnicate', '--json').stdout);
	assert.equal(doc.why, 'bad-args');
});
