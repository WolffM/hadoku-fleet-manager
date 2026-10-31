/**
 * `jobPhases` (the setup/run/cleanup breakdown derived from
 * `/actions/runs/{id}/jobs`'s own steps, which always sum to the job
 * duration and are clamped rather than trusted against the job's own
 * clock) and `stepFailure` (P2.1: which step a failed job died on, and
 * which phase it falls in — a SEAM step the workflow named but did not
 * write lands in `run`, not `setup`), plus the one `ingestRuns` integration
 * test proving the failed-step fields are derived with zero extra fetches.
 * Split out of job-history.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/job-history-rig.ts` for the shared `job`/`at` fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { jobRecords } from '../job-history-store.js';
import { ingestRuns } from '../job-history-ingest.js';
import { jobPhases } from '../job-history-ingest.js';
import { stepFailure } from '../job-history-ingest.js';
import { job, at, installJobHistoryRig } from './helpers/job-history-rig.js';

installJobHistoryRig();

// ── phase breakdown ─────────────────────────────────────────────────────────
//
// Derived from steps `/actions/runs/{id}/jobs` already returns. The shapes below
// are copied from a real response (run 33653213284, 2026-09-02).

const step = (name: string, from: string, to: string, conclusion = 'success') => ({
	name,
	started_at: from,
	completed_at: to,
	conclusion,
});

test('jobPhases: setup contains the gap BEFORE the first step', () => {
	// On a JIT node that gap is the runner coming up — the mint — and no other
	// number in the payload exposes it. started_at 16:12:38, first step 16:12:40.
	const start = Date.parse('2026-09-02T16:12:38Z');
	const end = Date.parse('2026-09-02T16:12:47Z');
	const p = jobPhases(
		{
			steps: [
				step('Set up job', '2026-09-02T16:12:40Z', '2026-09-02T16:12:41Z'),
				step('Run actions/checkout@v6', '2026-09-02T16:12:41Z', '2026-09-02T16:12:43Z'),
				step('Post Run actions/checkout@v6', '2026-09-02T16:12:44Z', '2026-09-02T16:12:44Z'),
				step('Complete job', '2026-09-02T16:12:44Z', '2026-09-02T16:12:44Z'),
			],
		},
		start,
		end
	)!;
	assert.equal(p.setupSec, 3, '38 -> 41: the 2s runner gap plus the 1s Set up job');
	assert.equal(p.runSec, 3, '41 -> 44, up to the first Post step');
	assert.equal(p.cleanupSec, 3, '44 -> completed_at 47');
	assert.equal(p.setupSec + p.runSec + p.cleanupSec, Math.round((end - start) / 1000));
});

test('jobPhases: the phases always sum to the job duration', () => {
	// A bar whose segments do not sum to the whole is a bar that lies about
	// proportion, which is the only thing a stacked bar is for.
	const start = Date.parse('2026-09-02T16:12:53Z');
	const end = Date.parse('2026-09-02T16:14:33Z');
	const p = jobPhases(
		{
			steps: [
				step('Set up job', '2026-09-02T16:12:56Z', '2026-09-02T16:12:59Z'),
				step('Install dependencies', '2026-09-02T16:13:10Z', '2026-09-02T16:13:56Z'),
				step('Post Checkout code', '2026-09-02T16:14:29Z', '2026-09-02T16:14:30Z'),
				step('Complete job', '2026-09-02T16:14:30Z', '2026-09-02T16:14:30Z'),
			],
		},
		start,
		end
	)!;
	assert.equal(p.setupSec + p.runSec + p.cleanupSec, Math.round((end - start) / 1000));
	assert.equal(p.cleanupSec, 4, 'the EARLIEST teardown step opens cleanup, not "Complete job"');
});

test('jobPhases: no usable steps is undefined, never zeroes', () => {
	// Same rule as queueSec: a fabricated 0 renders as a phase that took no time
	// rather than one we could not measure, and drags every percentile down.
	const start = Date.parse('2026-09-02T16:12:53Z');
	const end = Date.parse('2026-09-02T16:14:33Z');
	assert.equal(jobPhases({}, start, end), undefined);
	assert.equal(jobPhases({ steps: [] }, start, end), undefined);
	assert.equal(
		jobPhases(
			{ steps: [{ name: 'Set up job', started_at: null, completed_at: null }] },
			start,
			end
		),
		undefined
	);
});

test('jobPhases: a step clock outside the job clock cannot make a negative segment', () => {
	// Clamped rather than trusted — a negative segment renders as a bar running
	// backwards over the ones beside it.
	const start = Date.parse('2026-09-02T16:00:00Z');
	const end = Date.parse('2026-09-02T16:01:00Z');
	const p = jobPhases(
		{
			steps: [
				step('Set up job', '2026-09-02T15:59:00Z', '2026-09-02T16:05:00Z'),
				step('Complete job', '2026-09-02T15:58:00Z', '2026-09-02T15:58:30Z'),
			],
		},
		start,
		end
	)!;
	assert.ok(p.setupSec >= 0 && p.runSec >= 0 && p.cleanupSec >= 0, 'no negative segment');
	assert.equal(p.setupSec + p.runSec + p.cleanupSec, 60, 'still sums to the duration');
});

// ── failed step (P2.1) ──────────────────────────────────────────────────────

test('stepFailure: a successful job never gets a failedStep, even with a failed step record', () => {
	// continue-on-error: the STEP failed, the JOB did not. That is not a
	// fleet-origin failure, and reporting one would be a fabrication.
	const start = Date.parse('2026-09-02T16:12:38Z');
	const end = Date.parse('2026-09-02T16:12:47Z');
	assert.equal(
		stepFailure(
			{ conclusion: 'success', steps: [step('Lint (allowed to fail)', '', '', 'failure')] },
			start,
			end
		),
		undefined
	);
});

test('stepFailure: no step record is undefined, never guessed', () => {
	const start = Date.parse('2026-09-02T16:12:38Z');
	const end = Date.parse('2026-09-02T16:12:47Z');
	assert.equal(stepFailure({ conclusion: 'failure' }, start, end), undefined);
	assert.equal(stepFailure({ conclusion: 'failure', steps: [] }, start, end), undefined);
	// Every step succeeded — GitHub can still report the job as failure/timed_out
	// with no step record naming why (a runner that vanished mid-job).
	assert.equal(
		stepFailure(
			{
				conclusion: 'failure',
				steps: [step('Set up job', '2026-09-02T16:12:38Z', '2026-09-02T16:12:39Z')],
			},
			start,
			end
		),
		undefined
	);
});

test('stepFailure: "Set up job" ITSELF failing lands in setup', () => {
	const start = Date.parse('2026-09-02T16:12:38Z');
	const end = Date.parse('2026-09-02T16:12:47Z');
	const r = stepFailure(
		{
			conclusion: 'failure',
			steps: [
				step('Set up job', '2026-09-02T16:12:38Z', '2026-09-02T16:12:39Z', 'failure'),
				step('Complete job', '2026-09-02T16:12:39Z', '2026-09-02T16:12:47Z'),
			],
		},
		start,
		end
	);
	assert.equal(r?.failedStep, 'Set up job');
	assert.equal(r?.failedPhase, 'setup');
});

test('stepFailure: a SEAM step (uses: after Set up job) lands in run, not setup', () => {
	// jobPhases' `setup` is ONLY "Set up job" itself — everything after it, up
	// to teardown, is `run`, including a `uses:` step the workflow named but
	// did not write. That is coarser than §5.5's runner/seam/content zone
	// table, which WOULD call this a seam step; failedPhase cannot make that
	// distinction alone (see the JobRecord.failedPhase doc comment) — only
	// failedStep's own name can. This pins the boundary so it is not
	// mis-described as "setup" again.
	const start = Date.parse('2026-09-02T16:12:38Z');
	const end = Date.parse('2026-09-02T16:12:47Z');
	const r = stepFailure(
		{
			conclusion: 'failure',
			steps: [
				step('Set up job', '2026-09-02T16:12:38Z', '2026-09-02T16:12:39Z'),
				step(
					'Run actions/setup-python@v5',
					'2026-09-02T16:12:39Z',
					'2026-09-02T16:12:40Z',
					'failure'
				),
				step('Complete job', '2026-09-02T16:12:40Z', '2026-09-02T16:12:47Z'),
			],
		},
		start,
		end
	);
	assert.equal(r?.failedStep, 'Run actions/setup-python@v5');
	assert.equal(r?.failedPhase, 'run');
});

test('stepFailure: a content step the consumer named lands in run', () => {
	const start = Date.parse('2026-09-02T16:12:38Z');
	const end = Date.parse('2026-09-02T16:12:47Z');
	const r = stepFailure(
		{
			conclusion: 'failure',
			steps: [
				step('Set up job', '2026-09-02T16:12:38Z', '2026-09-02T16:12:39Z'),
				step('Tests', '2026-09-02T16:12:39Z', '2026-09-02T16:12:45Z', 'failure'),
				step('Complete job', '2026-09-02T16:12:45Z', '2026-09-02T16:12:47Z'),
			],
		},
		start,
		end
	);
	assert.equal(r?.failedStep, 'Tests');
	assert.equal(r?.failedPhase, 'run');
});

test('stepFailure: a cancelled runner event with no usable phases still names the step', () => {
	// jobPhases returns undefined when steps are unusable; the failed step's
	// NAME must survive that even though its phase cannot.
	const start = Date.parse('2026-09-02T16:12:38Z');
	const end = Date.parse('2026-09-02T16:12:47Z');
	const r = stepFailure(
		{
			conclusion: 'cancelled',
			steps: [
				{ name: 'Set up runner', started_at: null, completed_at: null, conclusion: 'cancelled' },
			],
		},
		start,
		end
	);
	assert.equal(r?.failedStep, 'Set up runner');
	assert.equal(r?.failedPhase, undefined);
});

test('ingestRuns: a failed job records failedStep/failedPhase with zero extra fetches', async () => {
	let calls = 0;
	await ingestRuns(
		'WolffM/x',
		[{ id: 700, status: 'completed', updated_at: new Date().toISOString() }],
		async () => {
			calls++;
			return {
				jobs: [
					job({
						conclusion: 'failure',
						steps: [
							step('Set up job', at(0), at(1)),
							step('Tests', at(1), at(99), 'failure'),
							step('Complete job', at(99), at(100)),
						],
					}),
				],
			};
		},
		5
	);
	assert.equal(calls, 1, 'one call to fetch the jobs — nothing extra for the step data');
	const [r] = jobRecords();
	assert.equal(r.failedStep, 'Tests');
	assert.equal(r.failedPhase, 'run');
});
