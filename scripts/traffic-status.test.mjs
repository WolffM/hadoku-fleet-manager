/**
 * `fleet traffic`'s two wave-4a corrections (#100, found by 3z's manager):
 *
 *   1. The order it PRINTS must be the order the dispatcher actually RUNS —
 *      fewest busy, then fastest MEASURED node, then idle longest, then name
 *      (`orderCandidates`, wave 3z's speed tie-break) — not the retired
 *      "fewest busy, then idle longest" rule this file used to claim.
 *   2. Admission (can GitHub even place here right now) is a SEPARATE axis
 *      from order, read live from the controller's own `GET /api/fleet`
 *      rather than recomputed here. "Could not look" (mgmt-api unreachable,
 *      or an older deploy with no such field yet) must read `unknown`, NEVER
 *      `admitted` — AGENTS.md's first rule, applied to a diagnostic.
 *
 * See `scripts/lib/traffic-status.test.mjs` for the pre-existing drain/label
 * suite (verdict and placement filtering) — untouched by this wave and not
 * duplicated here.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'traffic-status.mjs');

const madeDirs = [];
const madeServers = [];
after(() => {
	madeDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
	madeServers.forEach((s) => s.close());
});

/**
 * A node that is REFUSED to connect, immediately — never a hang. Loopback,
 * nothing listens on 1 without root, so this is the fast "mgmt-api is not
 * running" case without a 3s timeout eating every test.
 */
const MGMT_API_UNREACHABLE = 'http://127.0.0.1:1';

function manifestDir(machines) {
	const d = mkdtempSync(join(tmpdir(), 'fleet-traffic-order-'));
	madeDirs.push(d);
	writeFileSync(join(d, 'fleet-runner-manifest.json'), JSON.stringify({ machines }));
	writeFileSync(join(d, 'fleet-drain.json'), JSON.stringify({ nodes: {} }));
	return d;
}

/**
 * One job-history.jsonl record. `isUsable` in speed-tier.ts needs a
 * `success` conclusion, a finite `runSec`, no `probe`, and a `startedAt`
 * inside the model's 30-day window — everything else is along for the ride.
 */
function record(repo, jobName, runner, runSec, startedAt, seq) {
	return JSON.stringify({
		repo,
		runId: seq,
		jobId: seq,
		name: jobName,
		runner,
		labels: [],
		startedAt,
		durationSec: runSec,
		conclusion: 'success',
		runSec,
	});
}

/**
 * `MIN_KINDS` (5) distinct (repo, job) kinds, `MIN_SAMPLES` (5) samples per
 * side each — the exact confidence bar `speed-tier.ts` requires before a
 * node's ratio counts at all. `node` and `other` get the SAME `startedAt`
 * for every sample, so idle time is controlled separately (by the caller,
 * via `nodeStartedAt`) rather than smeared by this fixture.
 */
function speedKinds(repo, node, nodeSec, other, otherSec, nodeStartedAt, otherStartedAt, seqStart) {
	const lines = [];
	let seq = seqStart;
	for (let kind = 0; kind < 5; kind++) {
		const jobName = `job${kind}`;
		for (let s = 0; s < 5; s++) {
			lines.push(record(repo, jobName, node, nodeSec, nodeStartedAt, seq++));
			lines.push(record(repo, jobName, other, otherSec, otherStartedAt, seq++));
		}
	}
	return { lines, nextSeq: seq };
}

function writeHistory(dir, lines) {
	writeFileSync(join(dir, 'job-history.jsonl'), lines.join('\n') + '\n');
}

function run(dir, argv = [], mgmtApiUrl = MGMT_API_UNREACHABLE) {
	return spawnSync(process.execPath, [SCRIPT, ...argv, '--json'], {
		encoding: 'utf8',
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: dir,
			HADOKU_STATE_DIR: dir,
			MGMT_API_URL: mgmtApiUrl,
		},
	});
}

/**
 * `spawnSync` BLOCKS this process's event loop until the child exits — fine
 * when the child's only dependency is an unreachable port, fatal when the
 * child must fetch a server THIS SAME PROCESS owns: the in-process HTTP
 * server from `startFleetApi` below can never accept the connection because
 * nothing is left running the event loop to service it, so the child's fetch
 * hangs to its own timeout and this process hangs behind `spawnSync` waiting
 * for a child that is itself waiting on it — a deadlock, not a script bug.
 * `spawn` (async) keeps this process's event loop alive while the child runs.
 */
function runAsync(dir, argv, mgmtApiUrl) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [SCRIPT, ...argv, '--json'], {
			env: {
				...process.env,
				FLEET_MANIFEST_DIR: dir,
				HADOKU_STATE_DIR: dir,
				MGMT_API_URL: mgmtApiUrl,
			},
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.on('close', (status) => resolve({ status, stdout, stderr }));
	});
}

function startFleetApi(machines) {
	return new Promise((resolve) => {
		const server = createServer((_req, res) => {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ success: true, machines }));
		});
		server.listen(0, '127.0.0.1', () => {
			madeServers.push(server);
			resolve(`http://127.0.0.1:${server.address().port}`);
		});
	});
}

test('the speed tie-break outranks idle — a fixture matching the real 3z factors (claw-8 0.67, claw-3 1.42)', () => {
	// claw-8: fast (factor .67) but barely idle (10 min). claw-3: slow (factor
	// 1.42) but idle far longer (3 h). The RETIRED rule ("fewest busy, then
	// idle longest") would print claw-3 first. `orderCandidates`'s speed
	// tie-break sits BEFORE idle, so claw-8 — the faster node — must print
	// first regardless. This is the one fact this test exists to pin: reverting
	// the `speedFactor` wiring in `traffic-status.mjs` restores the OLD
	// (idle-only) order and must fail this assertion.
	const dir = manifestDir({
		'claw-8': { labels: ['hadoku-builder'] },
		'claw-3': { labels: ['hadoku-builder'] },
		'claw-9': { labels: ['hadoku-builder'] },
	});
	const now = Date.now();
	const claw8Started = new Date(now - 10 * 60_000).toISOString(); // 10 min ago
	const claw3Started = new Date(now - 180 * 60_000).toISOString(); // 3 h ago
	const baseline = new Date(now - 10 * 60_000).toISOString();
	const a = speedKinds('demo-8', 'claw-8', 67, 'claw-9', 100, claw8Started, baseline, 1);
	const b = speedKinds('demo-3', 'claw-3', 142, 'claw-9', 100, claw3Started, baseline, a.nextSeq);
	writeHistory(dir, [...a.lines, ...b.lines]);

	const r = run(dir);
	assert.equal(r.status, 0, r.stderr);
	const out = JSON.parse(r.stdout);

	const claw8 = out.nodes.find((n) => n.name === 'claw-8');
	const claw3 = out.nodes.find((n) => n.name === 'claw-3');
	assert.ok(Math.abs(claw8.speedFactor - 0.67) < 0.01, `claw-8 factor was ${claw8.speedFactor}`);
	assert.ok(Math.abs(claw3.speedFactor - 1.42) < 0.01, `claw-3 factor was ${claw3.speedFactor}`);
	assert.equal(out.order[0], 'claw-8', `claw-8 (faster) must lead the order; got ${out.order}`);
	assert.ok(
		out.order.indexOf('claw-8') < out.order.indexOf('claw-3'),
		`claw-8 must outrank claw-3 despite less idle time; got ${out.order}`
	);
});

test('the heading states the measured rule, not the retired idle-only one', () => {
	const dir = manifestDir({ 'claw-1': { labels: ['hadoku-builder'] } });
	writeHistory(dir, []);
	const r = spawnSync(process.execPath, [SCRIPT], {
		encoding: 'utf8',
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: dir,
			HADOKU_STATE_DIR: dir,
			MGMT_API_URL: MGMT_API_UNREACHABLE,
		},
	});
	assert.equal(r.status, 0, r.stderr);
	// eslint-disable-next-line no-control-regex
	const plain = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
	assert.match(plain, /fastest measured/, 'the heading must name the speed step');
	assert.doesNotMatch(
		plain,
		/fewest busy first, then idle longest/,
		'the heading must not still claim the pre-3z rule'
	);
});

test('a refused node carries its real numbers from the live /api/fleet admission field', async () => {
	const dir = manifestDir({
		'claw-2': { labels: ['hadoku-builder'] },
		'claw-6': { labels: ['hadoku-builder'] },
	});
	writeHistory(dir, []);
	const mgmtApiUrl = await startFleetApi([
		{ name: 'claw-2', admissionRefusal: null },
		{
			name: 'claw-6',
			admissionRefusal: {
				clause: 'memory',
				availableMb: 4813,
				needMb: 5632,
				reserveBasis: 'default-4096',
				reason: 'memory: 4813MB free, this repo peaks at 5632MB',
			},
		},
	]);

	const r = await runAsync(dir, [], mgmtApiUrl);
	assert.equal(r.status, 0, r.stderr);
	const out = JSON.parse(r.stdout);

	const claw2 = out.nodes.find((n) => n.name === 'claw-2');
	const claw6 = out.nodes.find((n) => n.name === 'claw-6');
	assert.equal(claw2.admission.verdict, 'admitted');
	assert.equal(claw6.admission.verdict, 'refused');
	assert.equal(claw6.admission.clause, 'memory');
	assert.equal(claw6.admission.availableMb, 4813);
	assert.equal(claw6.admission.needMb, 5632);
	assert.equal(claw6.admission.reserveBasis, 'default-4096');
});

test('the why is the controller’s own reason, never an inequality built from the numbers', async () => {
	// The live payload from 2026-10-25: claw-1 at its concurrency cap, claw-8
	// drained, claw-2 refused on its memory FLOOR with more free than it needs.
	// The old display printed "9788MB available < 3400MB needed" for claw-1 —
	// false on its face, and the clause is not about memory at all.
	const dir = manifestDir({
		'claw-1': { labels: ['hadoku-builder'] },
		'claw-2': { labels: ['hadoku-builder'] },
		'claw-8': { labels: ['hadoku-builder'] },
	});
	writeHistory(dir, []);
	const memoryReason =
		'memory: 4644MB free, this repo peaks at 3400MB, would leave 1244MB against a 1536MB floor';
	const mgmtApiUrl = await startFleetApi([
		{
			name: 'claw-1',
			admissionRefusal: {
				clause: 'concurrency',
				availableMb: 9179,
				needMb: 3400,
				reserveBasis: 'node',
				reason: 'at capacity: 3/2 in flight',
			},
		},
		{
			name: 'claw-2',
			admissionRefusal: {
				clause: 'memory',
				availableMb: 4644,
				needMb: 3400,
				reserveBasis: 'node',
				reason: memoryReason,
			},
		},
		{
			name: 'claw-8',
			admissionRefusal: {
				clause: 'drained',
				availableMb: 14349,
				needMb: 4096,
				reserveBasis: 'default',
				reason: 'drained: held out of service for maintenance',
			},
		},
	]);

	const r = await runAsync(dir, [], mgmtApiUrl);
	assert.equal(r.status, 0, r.stderr);
	const nodes = JSON.parse(r.stdout).nodes;
	const why = (n) => nodes.find((x) => x.name === n).admission.why;
	assert.equal(why('claw-1'), 'at capacity: 3/2 in flight');
	assert.equal(why('claw-2'), memoryReason);
	assert.equal(why('claw-8'), 'drained: held out of service for maintenance');
	for (const n of ['claw-1', 'claw-2', 'claw-8']) assert.doesNotMatch(why(n), /available </);
	// The numbers are still there for a reader that wants them.
	assert.equal(nodes.find((x) => x.name === 'claw-1').admission.availableMb, 9179);
});

test('a refusal with no reason says so, and still claims no inequality', async () => {
	const dir = manifestDir({ 'claw-6': { labels: ['hadoku-builder'] } });
	writeHistory(dir, []);
	const mgmtApiUrl = await startFleetApi([
		{
			name: 'claw-6',
			admissionRefusal: {
				clause: 'concurrency',
				availableMb: 5000,
				needMb: 3400,
				reserveBasis: 'node',
			},
		},
	]);
	const r = await runAsync(dir, [], mgmtApiUrl);
	assert.equal(r.status, 0, r.stderr);
	const claw6 = JSON.parse(r.stdout).nodes.find((n) => n.name === 'claw-6');
	assert.equal(claw6.admission.verdict, 'refused');
	assert.equal(claw6.admission.why, 'concurrency: the controller gave no reason');
});

test('a deploy with no admissionRefusal field reads unknown, never admitted', async () => {
	const dir = manifestDir({ 'claw-5': { labels: ['hadoku-builder'] } });
	writeHistory(dir, []);
	// An OLDER mgmt-api deploy, before wave 4a's field existed at all.
	const mgmtApiUrl = await startFleetApi([{ name: 'claw-5' }]);

	const r = await runAsync(dir, [], mgmtApiUrl);
	assert.equal(r.status, 0, r.stderr);
	const out = JSON.parse(r.stdout);
	const claw5 = out.nodes.find((n) => n.name === 'claw-5');
	assert.equal(
		claw5.admission.verdict,
		'unknown',
		'an absent field must never be read as "admitted"'
	);
});

test('mgmt-api being unreachable reads every node unknown, never admitted', () => {
	const dir = manifestDir({ 'claw-4': { labels: ['hadoku-builder'] } });
	writeHistory(dir, []);
	const r = run(dir, [], MGMT_API_UNREACHABLE);
	assert.equal(r.status, 0, r.stderr);
	const out = JSON.parse(r.stdout);
	const claw4 = out.nodes.find((n) => n.name === 'claw-4');
	assert.equal(claw4.admission.verdict, 'unknown');
	assert.match(claw4.admission.why, /unreachable/);
});
