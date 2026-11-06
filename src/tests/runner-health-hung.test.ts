/**
 * Tests for `runner-health-runs.ts`'s hung-job detection: queue starvation vs
 * a genuinely hung job, step-progress ("slow, not hung"), naming the slow job
 * by its OWN runtime (#131), and the two-tick same-step stall. Split out of
 * runner-health.test.ts (wave 5p lane B) — see
 * `src/tests/helpers/runner-health-rig.ts` for the shared fetch-stub fixture
 * every file that ticks the monitor installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tick } from '../runner-health.js';
import {
	installRunnerHealthRig,
	installFetch,
	discordPosts,
	quietRecords,
} from './helpers/runner-health-rig.js';
import { hokonPromotedLabels } from './helpers/runner-health-fixtures.js';
import { records } from '../job-history-store.js';

installRunnerHealthRig();

/**
 * A run that says `in_progress` while its job has never been placed.
 *
 * GitHub marks a RUN in_progress as soon as it picks it up, whether or not
 * anything is executing — so run-level status cannot tell a running job from
 * one starved of runners. On 2026-08-23 hadoku-games-host, which had ZERO
 * runners registered, sat 854 minutes and alerted as "possible hung job pinning
 * a runner". Nothing was pinning anything; the moment a runner existed the job
 * finished in 32 seconds. The alert pointed at the opposite of the cause, which
 * is why 14 hours of starvation went unactioned.
 */
test('runner-health: in_progress with an UNSTARTED job is queue starvation, not a hung job', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: hokonPromotedLabels() }],
		},
		runs: {
			workflow_runs: [
				{
					id: 900,
					status: 'in_progress',
					conclusion: null,
					created_at: new Date(Date.now() - 800 * 60_000).toISOString(),
					html_url: 'https://github.com/WolffM/x/actions/runs/900',
					display_title: 'vibeCompact',
				},
			],
		},
		// The job exists but was never placed: status queued, no started_at.
		jobs: { jobs: [{ name: 'audit', status: 'queued', started_at: null }] },
	});

	await tick('tok');

	const alerts = discordPosts.filter((p) => /WAITING FOR A RUNNER|hung job/.test(p));
	assert.equal(alerts.length, 1, 'exactly one alert for this run');
	assert.match(alerts[0]!, /WAITING FOR A RUNNER/, 'must read as starvation');
	assert.ok(!/pinning a runner/.test(alerts[0]!), 'must NOT claim a job is pinning a runner');
	assert.match(alerts[0]!, /COVERAGE gap/, 'must name the actionable cause');
});

test('runner-health: a genuinely long-EXECUTING job still alerts as hung', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: hokonPromotedLabels() }],
		},
		runs: {
			workflow_runs: [
				{
					id: 901,
					status: 'in_progress',
					conclusion: null,
					created_at: new Date(Date.now() - 200 * 60_000).toISOString(),
					html_url: 'https://github.com/WolffM/x/actions/runs/901',
					display_title: 'build',
				},
			],
		},
		// Placed 90 minutes ago and still running — that IS a hung job.
		jobs: {
			jobs: [
				{
					name: 'build',
					status: 'in_progress',
					started_at: new Date(Date.now() - 90 * 60_000).toISOString(),
				},
			],
		},
	});

	await tick('tok');

	const alerts = discordPosts.filter((p) => /EXECUTING|WAITING FOR A RUNNER/.test(p));
	assert.equal(alerts.length, 1);
	assert.match(alerts[0]!, /EXECUTING 9\dm/, 'measured from job start, not run creation');
	assert.match(alerts[0]!, /pinning/);
});

test('runner-health: a job that queued for hours but is now running is NOT hung', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: hokonPromotedLabels() }],
		},
		runs: {
			workflow_runs: [
				{
					id: 902,
					status: 'in_progress',
					conclusion: null,
					// Created 9h ago — run-level age alone would scream "hung".
					created_at: new Date(Date.now() - 540 * 60_000).toISOString(),
					html_url: 'https://github.com/WolffM/x/actions/runs/902',
					display_title: 'late starter',
				},
			],
		},
		// ...but it only started executing 2 minutes ago.
		jobs: {
			jobs: [
				{
					name: 'audit',
					status: 'in_progress',
					started_at: new Date(Date.now() - 2 * 60_000).toISOString(),
				},
			],
		},
	});

	await tick('tok');
	assert.equal(
		discordPosts.filter((p) => /EXECUTING|WAITING FOR A RUNNER/.test(p)).length,
		0,
		'2 minutes of execution is not a hung job, however long it waited first'
	);
});

/**
 * LONG IS NOT HUNG.
 *
 * brave-quartet's Bevy compile runs 8-9 minutes on a hosted runner and 40+ on a
 * claw, so moving it onto the fleet on 2026-09-10 put a perfectly healthy job
 * past the 30-minute ceiling within the hour and paged "possible hung job
 * pinning a runner". It was advancing through its steps the whole time. A
 * runtime threshold has to be re-tuned every time the workload mix changes and
 * is wrong for the fleet's slowest node by construction; step progress is not.
 */
test('hung: a long job that is still FINISHING STEPS is slow, not hung — ledger only', async () => {
	const started = new Date(Date.now() - 45 * 60_000).toISOString();
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: hokonPromotedLabels() }],
		},
		runs: {
			workflow_runs: [
				{
					id: 902,
					status: 'in_progress',
					conclusion: null,
					created_at: started,
					html_url: 'https://gh/run/902',
					display_title: 'ci: Bevy build',
				},
			],
		},
		jobs: {
			jobs: [
				{
					id: 55,
					name: 'check',
					status: 'in_progress',
					started_at: started,
					steps: [
						{ number: 1, name: 'Checkout', conclusion: 'success' },
						{ number: 2, name: 'Install Rust', conclusion: 'success' },
						{ number: 3, name: 'Clippy', conclusion: null },
					],
				},
			],
		},
	});
	await tick('tok');

	assert.equal(
		discordPosts.filter((m) => m.includes('EXECUTING')).length,
		0,
		'45 minutes of real work is not an incident'
	);
	const quiet = quietRecords.filter((m) => m.includes('EXECUTING'));
	assert.equal(quiet.length, 1, 'still recorded — a job that doubled its runtime is worth seeing');
	assert.match(quiet[0]!, /Slow, not hung/);
	assert.match(quiet[0]!, /Clippy/, 'names the step it is on');
});

/**
 * #131: "EXECUTING 1m (>30m)". The block is entered on the RUN's age, which
 * counts the time its later jobs sat queued; the row must judge and print a
 * JOB's own runtime, and name the job that is actually slow.
 */
function slowRunFixture(jobs: unknown[]) {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: hokonPromotedLabels() }],
		},
		runs: {
			workflow_runs: [
				{
					id: 904,
					status: 'in_progress',
					conclusion: null,
					created_at: new Date(Date.now() - 35 * 60_000).toISOString(),
					html_url: 'https://gh/run/904',
					display_title: 'ci: fan-out',
				},
			],
		},
		jobs: { jobs },
	});
}
const stepsOn = (current: string) => [
	{ number: 1, name: 'Checkout', conclusion: 'success' },
	{ number: 2, name: current, conclusion: null },
];

test('hung: a job one minute in, inside a 35-minute run, is not "slow" — #131', async () => {
	slowRunFixture([
		{
			id: 57,
			name: 'e2e',
			status: 'in_progress',
			started_at: new Date(Date.now() - 60_000).toISOString(),
			steps: stepsOn('Install'),
		},
	]);
	await tick('tok');
	assert.deepEqual(
		[...quietRecords, ...discordPosts].filter((m) => m.includes('EXECUTING')),
		[],
		'a one-minute job is below the 30-minute ceiling it would print'
	);
});

test('hung: the slow row names the job that is slow, with ITS runtime — #131', async () => {
	slowRunFixture([
		// The fresh job FIRST: on a first sighting both have made no progress,
		// and the old pick (most time without progress) took the first listed.
		{
			id: 59,
			name: 'e2e',
			status: 'in_progress',
			started_at: new Date(Date.now() - 60_000).toISOString(),
			steps: stepsOn('Install'),
		},
		{
			id: 58,
			name: 'build',
			status: 'in_progress',
			started_at: new Date(Date.now() - 34 * 60_000).toISOString(),
			steps: stepsOn('Compile'),
		},
	]);
	await tick('tok');
	const quiet = quietRecords.filter((m) => m.includes('EXECUTING'));
	assert.equal(quiet.length, 1);
	assert.match(quiet[0]!, /EXECUTING 34m \(>30m\)/);
	assert.match(quiet[0]!, /Compile/);
});

/**
 * A job that has stopped finishing steps IS hung, however fast the box is.
 *
 * Two ticks with the same completed-step count is the evidence; the first tick
 * only starts the clock, which is why this drives `tick` twice with time moved
 * between them.
 */
test('hung: a job stuck on the SAME step across ticks pages, and names the step', async () => {
	const started = new Date(Date.now() - 90 * 60_000).toISOString();
	const body = {
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: hokonPromotedLabels() }],
		},
		runs: {
			workflow_runs: [
				{
					id: 903,
					status: 'in_progress',
					conclusion: null,
					created_at: started,
					html_url: 'https://gh/run/903',
					display_title: 'ci: wedged',
				},
			],
		},
		jobs: {
			jobs: [
				{
					id: 56,
					name: 'check',
					status: 'in_progress',
					started_at: started,
					// Same two-of-three finished on both ticks: no progress.
					steps: [
						{ number: 1, name: 'Checkout', conclusion: 'success' },
						{ number: 2, name: 'Install Rust', conclusion: 'success' },
						{ number: 3, name: 'Test', conclusion: null },
					],
				},
			],
		},
	};
	installFetch(body);
	await tick('tok'); // starts the clock — cannot page yet
	assert.equal(
		discordPosts.filter((m) => m.includes('EXECUTING')).length,
		0,
		'one sighting is not evidence of a stall'
	);

	// Move the clock past STUCK_MINUTES with the step count unchanged.
	const real = Date.now;
	Date.now = () => real() + 30 * 60_000;
	try {
		await tick('tok');
	} finally {
		Date.now = real;
	}

	const pings = discordPosts.filter((m) => m.includes('EXECUTING'));
	assert.equal(pings.length, 1, 'a job that has not finished a step in 30m is stuck');
	assert.match(pings[0]!, /has not finished a step/);
	assert.match(pings[0]!, /stuck on `Test`/, 'names the step, so the finding is actionable');
});

/**
 * A job that is ONE long step is judged against its own green runs.
 *
 * hadoku-cardtable's forge-e2e shards run their whole suite as one step; green
 * ones take up to 75 min. On 2026-11-06 a shard 30 min into that step paged
 * "stuck … likely pinning a runner" while it was still passing tests.
 */
test('hung: a job inside its own green runtime is not stuck; past it, it is', async () => {
	const started = new Date(Date.now() - 5 * 60_000).toISOString();
	for (let i = 0; i < 6; i++) {
		records.push({
			repo: 'WolffM/hadoku_site',
			runId: 1000 + i,
			jobId: 2000 + i,
			name: `e2e (${i + 1})`,
			runner: 'claw-1',
			labels: [],
			startedAt: started,
			durationSec: (i === 0 ? 75 : 50) * 60,
			conclusion: 'success',
		});
	}
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: hokonPromotedLabels() }],
		},
		runs: {
			workflow_runs: [
				{
					id: 904,
					status: 'in_progress',
					conclusion: null,
					created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
					html_url: 'https://gh/run/904',
					display_title: 'Forge',
				},
			],
		},
		jobs: {
			jobs: [
				{
					id: 57,
					name: 'e2e (5)',
					status: 'in_progress',
					started_at: new Date(Date.now() - 35 * 60_000).toISOString(),
					steps: [
						{ number: 1, name: 'Set up job', conclusion: 'success' },
						{ number: 2, name: 'E2E', conclusion: null },
					],
				},
			],
		},
	});
	const at = async (min: number): Promise<void> => {
		const real = Date.now;
		Date.now = () => real() + min * 60_000;
		try {
			await tick('tok');
		} finally {
			Date.now = real;
		}
	};
	const pings = (): string[] => discordPosts.filter((m) => m.includes('has not finished a step'));

	await at(0); // starts the clock
	await at(40);
	assert.equal(pings().length, 0, '40m on one step is shorter than a green run of this job');
	const slow = quietRecords.filter((r) => /Slow, not hung/.test(r));
	assert.ok(
		slow.length >= 1,
		'still a ledger row: past the runtime ceiling, inside its own allowance'
	);

	await at(80);
	assert.equal(pings().length, 1, '80m on one step is past the longest green run (75m)');
	assert.match(pings()[0]!, /the longest of this job's 6 green runs was 75m/);
	assert.match(pings()[0]!, /stuck on `E2E`/);
});
