/**
 * The backstop's queue probe ages the oldest WAITING JOB, not the run
 * (2026-11-24). A multi-stage run stays `queued` from its attempt's start while
 * a later job waits, so the run clock read a 20-minute build plus a fresh
 * `deploy` as 20 minutes of queue. Replayed over 11-21..24, the run clock put
 * 99 ticks over an hour against 35 on the jobs' own clocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROBE_JOB_READS_MAX, probeQueuePressure } from '../runners/backstop-queue-probe.js';
import { installRunnerHealthRig, installFetch, jobListings } from './helpers/runner-health-rig.js';

installRunnerHealthRig();

const NOW = Date.now();
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();
const run = (id: number, ageSec: number) => ({
	id,
	status: 'queued',
	created_at: ago(ageSec),
	run_started_at: ago(ageSec),
});

test('a multi-stage run whose later job just queued is not read as the run’s whole age', async () => {
	installFetch({
		queuedRuns: { workflow_runs: [run(1, 2400)] },
		jobs: {
			jobs: [
				{ id: 10, status: 'completed', created_at: ago(2400) },
				{ id: 11, status: 'queued', created_at: ago(30) },
			],
		},
	});
	const q = await probeQueuePressure('tok', ['WolffM/a'], NOW);
	assert.equal(q.pressureSec, 30, 'the deploy has waited 30s, not the build’s 40 minutes');
	assert.equal(jobListings.length, 1);
});

test('a job that really has waited is reported at its own age', async () => {
	installFetch({
		queuedRuns: { workflow_runs: [run(1, 2400)] },
		jobs: { jobs: [{ id: 11, status: 'queued', created_at: ago(900) }] },
	});
	const q = await probeQueuePressure('tok', ['WolffM/a'], NOW);
	assert.equal(q.pressureSec, 900);
});

test('a queued run with no job waiting for a runner is not pressure', async () => {
	// Held between waves, by a concurrency group or an approval: more capacity
	// starts none of it. `runnableJobs` is the dispatcher's definition.
	installFetch({
		queuedRuns: { workflow_runs: [run(1, 2400)] },
		jobs: { jobs: [{ id: 10, status: 'in_progress', created_at: ago(2400) }] },
	});
	const q = await probeQueuePressure('tok', ['WolffM/a'], NOW);
	assert.equal(q.pressureSec, 0);
});

test('an unreadable job list falls back to the run’s age, never to zero', async () => {
	installFetch({ queuedRuns: { workflow_runs: [run(1, 2400)] }, jobsStatus: 500 });
	const q = await probeQueuePressure('tok', ['WolffM/a'], NOW);
	assert.equal(q.pressureSec, 2400, 'could not look reads as the old, louder answer');
});

test('a run no older than the worst job already found is not read', async () => {
	// A job is never older than its run, so the 20-minute run cannot beat the
	// 25-minute wait already found inside the 40-minute one.
	installFetch({
		queuedRuns: { workflow_runs: [run(2, 1200), run(1, 2400)] },
		jobs: { jobs: [{ id: 11, status: 'queued', created_at: ago(1500) }] },
	});
	const q = await probeQueuePressure('tok', ['WolffM/a'], NOW);
	assert.equal(q.pressureSec, 1500);
	assert.equal(jobListings.length, 1, 'only the oldest run’s jobs were read');
	assert.match(jobListings[0], /\/runs\/1\/jobs/);
});

test('the jobs reads are capped per probe, and past the cap a run keeps its own age', async () => {
	// Every repo holds a 60s run whose job just queued: each read finds 5s, so
	// nothing crosses the threshold and the loop would read every repo.
	const repos = Array.from({ length: PROBE_JOB_READS_MAX + 5 }, (_, i) => `WolffM/r${i}`);
	installFetch({
		queuedRuns: { workflow_runs: [run(1, 60)] },
		jobs: { jobs: [{ id: 11, status: 'queued', created_at: ago(5) }] },
	});
	const q = await probeQueuePressure('tok', repos, NOW);
	assert.equal(jobListings.length, PROBE_JOB_READS_MAX);
	assert.equal(q.pressureSec, 60, 'an unread run past the cap counts at its run age');
});

test('a run past the zombie band is refused on its run age and its jobs are never read', async () => {
	installFetch({
		queuedRuns: { workflow_runs: [run(1, 5000)] },
		jobs: { jobs: [{ id: 11, status: 'queued', created_at: ago(5000) }] },
	});
	const q = await probeQueuePressure('tok', ['WolffM/a'], NOW, 3600);
	assert.deepEqual(q, { pressureSec: 0, zombies: 1, oldestZombieSec: 5000 });
	assert.equal(jobListings.length, 0);
});
