/**
 * drain-progress.mjs: the refresh cycle's drain wait ends on SIGNALS, never on
 * a wall clock of its own (fleet-manager#114). On 2026-11-18 claw-9 held two
 * Forge e2e shards that ran 52 and 56 min and was put back un-refreshed by a
 * 45-minute wait, then paged. These hold the three ways the wait may end
 * apart: quiet, stuck/unreadable, and the run's own budget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	PROGRESS_POLL_MS,
	UNREADABLE_READS,
	WORKER_JOBS_SCRIPT,
	parseWorkerJobs,
	waitUntilQuiet,
} from './drain-progress.mjs';
import { POLL_MS, SETTLE_MS } from './drain-wait.mjs';
import { tempDir } from './test-tmpdir.mjs';

const MIN = 60_000;

/**
 * A node whose jobs follow `script(t)`: `{ jobs: [{repo, jobId}] | null,
 * steps: { [jobId]: done | null } }` at time t (null = unreadable).
 */
function world(script) {
	let t = 0;
	const reads = { workers: 0, jobs: 0 };
	return {
		reads,
		now: () => t,
		opts: {
			node: 'claw-fixture',
			clock: { now: () => t, sleep: async (ms) => void (t += ms) },
			readWorkers: async () => {
				reads.workers++;
				return script(t).jobs;
			},
			readJob: async (_repo, jobId) => {
				reads.jobs++;
				const done = script(t).steps?.[jobId];
				return done === null || done === undefined
					? null
					: { status: 'in_progress', name: 'forge-e2e (2)', done, step: `step ${done + 1}` };
			},
			readSessions: async () => script(t).sessions ?? { live: 0, pastCap: 0 },
			allowance: () => ({ minutes: 25, samples: 0 }),
		},
	};
}

const SHARD = { repo: 'WolffM/hadoku-cardtable', jobId: 7 };

test('quiet: refreshed as soon as the count reaches 0 and holds past the settle', async () => {
	const w = world((t) => ({ jobs: t < 5 * MIN ? [SHARD] : [], steps: { 7: Math.floor(t / MIN) } }));
	const r = await waitUntilQuiet(w.opts);
	assert.deepEqual(r, { drained: true });
	assert.ok(w.now() >= 5 * MIN + SETTLE_MS, 'declared quiet before the zero held');
	assert.ok(w.now() < 5 * MIN + SETTLE_MS + 2 * POLL_MS, 'waited on after the node went quiet');
});

test('the 11-18 shape: an 80-min job that keeps finishing steps is WAITED FOR, past any 45 minutes', async () => {
	// A step every 20 min (inside the 25-min floor), then the worker exits.
	const w = world((t) => ({
		jobs: t < 80 * MIN ? [SHARD] : [],
		steps: { 7: Math.floor(t / (20 * MIN)) },
	}));
	const r = await waitUntilQuiet(w.opts);
	assert.deepEqual(r, { drained: true });
	assert.ok(w.now() >= 80 * MIN);
});

test('no deadline means no clock: only a signal ends the wait', async () => {
	// Advancing forever, and the test's own guard ends it: the wait never would.
	const w = world((t) => ({ jobs: [SHARD], steps: { 7: Math.floor(t / (10 * MIN)) } }));
	const guard = 24 * 60 * MIN;
	const r = await waitUntilQuiet({
		...w.opts,
		readWorkers: async () => (w.now() < guard ? [SHARD] : []),
	});
	assert.deepEqual(r, { drained: true });
	assert.ok(w.now() >= guard, 'ended before any signal said so');
});

test('stuck: a job that stops finishing steps past its allowance is the finding, naming the step', async () => {
	const w = world((t) => ({ jobs: [SHARD], steps: { 7: Math.min(3, Math.floor(t / MIN)) } }));
	const r = await waitUntilQuiet(w.opts);
	assert.equal(r.drained, false);
	assert.equal(r.stuck, true);
	assert.equal(r.running, 1);
	assert.match(
		r.reason,
		/job 7 \(forge-e2e \(2\)\) has not finished a step in \d+m \(>25m\); stuck on `step 4`/
	);
	// Judged against the allowance, not reported the moment it crossed: within one progress sample.
	assert.ok(w.now() <= 3 * MIN + 25 * MIN + PROGRESS_POLL_MS + POLL_MS);
});

test("the job's OWN green history raises its allowance: one 60-min silent step is not stuck under an 80-min allowance", async () => {
	const w = world((t) => ({
		jobs: t < 70 * MIN ? [SHARD] : [],
		steps: { 7: t < 65 * MIN ? 1 : 2 },
	}));
	const r = await waitUntilQuiet({ ...w.opts, allowance: () => ({ minutes: 80, samples: 12 }) });
	assert.deepEqual(r, { drained: true });
});

test('a count that cannot be read once is a blip; twice running is the finding', async () => {
	let n = 0;
	const blip = world(() => ({ jobs: [] }));
	const r1 = await waitUntilQuiet({
		...blip.opts,
		readWorkers: async () => (n++ === 0 ? null : []),
	});
	assert.deepEqual(r1, { drained: true });

	const dead = world(() => ({ jobs: null }));
	const r2 = await waitUntilQuiet(dead.opts);
	assert.equal(r2.stuck, true);
	assert.equal(r2.running, null);
	assert.match(r2.reason, /could not count running jobs/);
	assert.equal(dead.reads.workers, UNREADABLE_READS);
});

test("a job whose progress GitHub will not give twice running is the finding, never 'fine'", async () => {
	const w = world(() => ({ jobs: [SHARD], steps: { 7: null } }));
	const r = await waitUntilQuiet(w.opts);
	assert.equal(r.stuck, true);
	assert.match(r.reason, /could not read the progress of WolffM\/hadoku-cardtable job 7/);
	assert.equal(w.reads.jobs, UNREADABLE_READS);
});

test('a worker whose job cannot be named is the finding after two progress samples', async () => {
	const w = world(() => ({ jobs: [{ repo: 'WolffM/x', jobId: null }] }));
	const r = await waitUntilQuiet(w.opts);
	assert.equal(r.stuck, true);
	assert.match(r.reason, /job id could not be read from its worker/);
	assert.equal(w.reads.jobs, 0, 'nothing to ask GitHub about');
});

test("the run's budget ends the wait and SAYS so: budget, not stuck", async () => {
	const w = world((t) => ({ jobs: [SHARD], steps: { 7: Math.floor(t / (5 * MIN)) } }));
	const r = await waitUntilQuiet({ ...w.opts, deadline: 30 * MIN });
	assert.equal(r.drained, false);
	assert.equal(r.budget, true);
	assert.equal(r.stuck, undefined);
	assert.equal(r.running, 1);
	assert.match(
		r.reason,
		/run's time budget ended while 1 job\(s\) were still running and advancing/
	);
	assert.ok(w.now() >= 30 * MIN && w.now() < 30 * MIN + POLL_MS + 1);
});

test('GitHub is sampled per job at the progress rate, not every poll', async () => {
	const w = world((t) => ({
		jobs: t < 60 * MIN ? [SHARD] : [],
		steps: { 7: Math.floor(t / (10 * MIN)) },
	}));
	await waitUntilQuiet(w.opts);
	assert.ok(
		w.reads.jobs <= Math.ceil((60 * MIN) / PROGRESS_POLL_MS) + 1,
		`${w.reads.jobs} job reads`
	);
	assert.ok(w.reads.workers > w.reads.jobs, 'the count is the fast signal');
});

test('parseWorkerJobs: no END is no answer; `-` is a half it could not read', () => {
	assert.equal(parseWorkerJobs(''), null);
	assert.equal(parseWorkerJobs('W WolffM/a 12\n'), null, 'died before END');
	assert.equal(parseWorkerJobs('garbage\nEND'), null);
	assert.deepEqual(parseWorkerJobs('END\n'), []);
	assert.deepEqual(parseWorkerJobs('W WolffM/a 12\nW - -\nW WolffM/b -\nEND'), [
		{ repo: 'WolffM/a', jobId: 12 },
		{ repo: null, jobId: null },
		{ repo: 'WolffM/b', jobId: null },
	]);
});

test('WORKER_JOBS_SCRIPT reads the job the worker RUNS from its log, and skips a test fixture', () => {
	// The 11-18 measurement: the runner was named for j135031304064, its worker
	// log's check_run_id was 135031304097.
	const dir = tempDir('drain-progress-');
	const slot = join(dir, 'jit', 'slot0');
	mkdirSync(join(slot, 'bin.2.330.0'), { recursive: true });
	mkdirSync(join(slot, '_diag'), { recursive: true });
	writeFileSync(
		join(slot, '.runner'),
		'{"AgentName":"jit-claw-4-hadoku-cardtabl-j135031304064-r44369196776-1795026243","GitHubUrl":"https://github.com/WolffM/hadoku-cardtable","WorkFolder":"_work"}'
	);
	writeFileSync(
		join(slot, '_diag', 'Worker_20261118-182410-utc.log'),
		'    "job": {\n      "d": [\n        {\n          "k": "check_run_id",\n          "v": 135031304097.0\n        },\n'
	);
	// A second worker with no log yet: the job id half is unreadable.
	const slot1 = join(dir, 'jit', 'slot1');
	mkdirSync(join(slot1, 'bin.2.330.0'), { recursive: true });
	writeFileSync(join(slot1, '.runner'), '{"GitHubUrl":"https://github.com/WolffM/hadoku_site"}');
	// This package's own suite, running as a job: a fake worker in the job's temp tree.
	const fixture = join(dir, 'runner-tmp', 'runner-drift-x', 'actions-runner-x');
	mkdirSync(join(fixture, 'bin'), { recursive: true });
	writeFileSync(join(fixture, '.runner'), '{"GitHubUrl":"https://github.com/WolffM/fixture"}');
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(
		join(bin, 'pgrep'),
		`#!/bin/sh\necho "101 ${slot}/bin.2.330.0/Runner.Worker spawnclient 1 2"\necho "102 ${slot1}/bin.2.330.0/Runner.Worker spawnclient 3 4"\necho "103 ${fixture}/bin/Runner.Worker spawnclient 5 6"\n`,
		{ mode: 0o755 }
	);
	const r = spawnSync('bash', ['-c', WORKER_JOBS_SCRIPT], {
		env: { ...process.env, HOME: dir, TMPDIR: '', PATH: `${bin}:${process.env.PATH}` },
		encoding: 'utf8',
	});
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(parseWorkerJobs(r.stdout), [
		{ repo: 'WolffM/hadoku-cardtable', jobId: 135031304097 },
		{ repo: 'WolffM/hadoku_site', jobId: null },
	]);

	// An idle node: read, and nothing runs.
	writeFileSync(join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
	const idle = spawnSync('bash', ['-c', WORKER_JOBS_SCRIPT], {
		env: { ...process.env, HOME: dir, TMPDIR: '', PATH: `${bin}:${process.env.PATH}` },
		encoding: 'utf8',
	});
	assert.deepEqual(parseWorkerJobs(idle.stdout), []);
});

test('a live session holds the node not-quiet with no job running, and is never judged stuck', async () => {
	const w = world((t) => ({ jobs: [], sessions: { live: t < 3 * 3_600_000 ? 1 : 0, pastCap: 0 } }));
	const r = await waitUntilQuiet(w.opts);
	assert.deepEqual(r, { drained: true });
	assert.ok(w.now() >= 3 * 3_600_000, 'went quiet while the session was still live');
	assert.equal(w.reads.jobs, 0, 'a session has no GitHub progress to read');
});

test("the run's budget ends a wait on a session, and the reason names the session", async () => {
	const w = world(() => ({ jobs: [], sessions: { live: 2, pastCap: 0 } }));
	const r = await waitUntilQuiet({ ...w.opts, deadline: 60 * MIN });
	assert.equal(r.drained, false);
	assert.equal(r.budget, true);
	assert.match(r.reason, /2 session\(s\) were live/);
});

test('sessions that cannot be counted twice running are the finding, like jobs', async () => {
	const w = world(() => ({ jobs: [] }));
	const r = await waitUntilQuiet({ ...w.opts, readSessions: async () => null });
	assert.equal(r.drained, false);
	assert.equal(r.stuck, true);
	assert.match(r.reason, /could not count running sessions on claw-fixture/);
});
