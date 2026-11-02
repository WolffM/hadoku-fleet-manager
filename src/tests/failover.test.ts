/**
 * Tests for `runners/failover.ts`: the auto-rerun of a job dropped by a
 * claw that went offline mid-run, vs. a genuine red build that must stay
 * red. Split out of runner-health.test.ts (wave 5j lane A) — see
 * `src/tests/helpers/runner-health-rig.ts` for the shared fetch-stub fixture
 * every file that ticks the monitor installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tick, __setFleetReposForTesting } from '../runner-health.js';
import { SWEEP_CONCURRENCY } from '../lib/concurrency.js';
import { getRunnerHealthSnapshot } from '../runner-health-snapshot.js';
import { MAX_RERUNS_PER_TICK } from '../runners/failover.js';
import {
	installRunnerHealthRig,
	installFetch,
	discordPosts,
	rerunPosts,
} from './helpers/runner-health-rig.js';
import { clawLabels, hokonLabels, minutesAgo } from './helpers/runner-health-fixtures.js';

installRunnerHealthRig();

// --- Failover (Check 3): auto-rerun a job dropped on a now-OFFLINE runner ---

// A healthy fleet: hokon (both labels) + claw-1 online; claw-2 OFFLINE. No
// label-floor breach, so discordPosts captures only failover notes.
const FLEET_CLAW2_DOWN = {
	runners: [
		{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
		{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
		{ id: 3, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
	],
};

/** All claws online — the drop is isolated to whatever the test overrides. */
const FLEET_ALL_UP = {
	runners: [
		{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
		{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
		{ id: 3, name: 'claw-2', status: 'online', busy: false, labels: clawLabels() },
	],
};

function oomRun(id: number) {
	return {
		workflow_runs: [
			{
				id,
				display_title: 'Auto-update @wolffm packages',
				created_at: minutesAgo(3),
				updated_at: minutesAgo(2),
				status: 'completed',
				conclusion: 'failure',
				run_attempt: 1,
				html_url: `https://gh/run/${id}`,
			},
		],
	};
}

const REFUSED_STEPS = [
	{ number: 1, name: 'Set up job', conclusion: 'success' },
	{ number: 2, name: 'Set up runner', conclusion: 'failure' },
	{ number: 3, name: 'Run actions/checkout@v6', conclusion: 'skipped' },
	{ number: 4, name: 'Run WolffM/hadoku-actions/setup-python-venv@v1', conclusion: 'skipped' },
	{ number: 5, name: 'Ruff', conclusion: 'skipped' },
	{ number: 6, name: 'Tests', conclusion: 'skipped' },
	{ number: 12, name: 'Complete runner', conclusion: 'success' },
	{ number: 13, name: 'Complete job', conclusion: 'success' },
];

/** `WolffM/sweep-0` … `WolffM/sweep-{n-1}`: a fleet with nothing to say. */
const sweepRepos = (n: number) => Array.from({ length: n }, (_, i) => `WolffM/sweep-${i}`);

test('failover: a run that failed on a now-OFFLINE claw is rerun onto a healthy runner — silently (digest, not a live ping)', async () => {
	installFetch({
		runners: FLEET_CLAW2_DOWN,
		runs: {
			workflow_runs: [
				{
					id: 42,
					display_title: 'Update Packages',
					created_at: minutesAgo(3),
					updated_at: minutesAgo(2),
					status: 'completed',
					conclusion: 'failure',
					run_attempt: 1,
					html_url: 'https://gh/run/42',
				},
			],
		},
		jobs: { jobs: [{ status: 'completed', conclusion: 'failure', runner_name: 'claw-2' }] },
	});
	await tick('tok');
	assert.equal(rerunPosts.length, 1, 'exactly one rerun-failed-jobs POST');
	assert.match(rerunPosts[0]!, /\/actions\/runs\/42\/rerun-failed-jobs$/);
	// A self-healed claw drop is rolled up by the daily ci-digest, not pinged live.
	assert.equal(discordPosts.length, 0, 'a successful failover must not ping Discord in real time');
});

test('failover: a job SIGKILLed on a still-ONLINE runner is an OOM, not a red build → rerun', async () => {
	installFetch({
		runners: FLEET_ALL_UP,
		runs: oomRun(137),
		jobs: {
			jobs: [{ id: 900, status: 'completed', conclusion: 'failure', runner_name: 'claw-2' }],
		},
		annotations: [{ message: 'Process completed with exit code 137.' }],
	});
	await tick('tok');
	assert.equal(rerunPosts.length, 1, 'an OOM-killed job must be rerun');
	assert.match(rerunPosts[0]!, /\/actions\/runs\/137\/rerun-failed-jobs$/);
	assert.equal(discordPosts.length, 0, 'and like any successful failover it must not ping live');
});

test('failover: a job ci-throttle refused at admission is rerun, with no annotation read and no live ping', async () => {
	installFetch({
		runners: FLEET_ALL_UP,
		runs: oomRun(38102526617),
		jobs: {
			jobs: [
				{
					id: 905,
					status: 'completed',
					conclusion: 'failure',
					runner_name: 'hokon',
					steps: REFUSED_STEPS,
				},
			],
		},
		// The OOM probe must not be what decides it.
		annotations: [{ message: 'Process completed with exit code 1.' }],
	});
	await tick('tok');
	assert.equal(rerunPosts.length, 1, 'a refused job never ran, so it is rerun');
	assert.match(rerunPosts[0]!, /\/actions\/runs\/38102526617\/rerun-failed-jobs$/);
	assert.equal(discordPosts.length, 0);
	assert.equal(getRunnerHealthSnapshot()?.oomReruns, 0, 'and it is not counted as an OOM');
});

test('failover: a genuine red build on an online runner is NOT rerun just because we looked at annotations', async () => {
	installFetch({
		runners: FLEET_ALL_UP,
		runs: oomRun(138),
		jobs: {
			jobs: [{ id: 901, status: 'completed', conclusion: 'failure', runner_name: 'claw-2' }],
		},
		// The shape the probe must NOT match: a real test failure.
		annotations: [{ message: 'Process completed with exit code 1.' }],
	});
	await tick('tok');
	assert.equal(
		rerunPosts.length,
		0,
		'exit 1 is the build failing — masking it would be the worst bug here'
	);
});

test('failover: an OOM on a runner that is not ours is never rerun', async () => {
	installFetch({
		runners: FLEET_ALL_UP,
		runs: oomRun(139),
		jobs: {
			jobs: [
				{
					id: 902,
					status: 'completed',
					conclusion: 'failure',
					runner_name: 'GitHub Actions 1000019745',
				},
			],
		},
		annotations: [{ message: 'Process completed with exit code 137.' }],
	});
	await tick('tok');
	assert.equal(rerunPosts.length, 0, 'a hosted runner is not ours to second-guess');
});

test('failover: an OOM rerun is counted separately from a drop (capacity vs availability)', async () => {
	installFetch({
		runners: FLEET_ALL_UP,
		runs: oomRun(140),
		jobs: {
			jobs: [{ id: 903, status: 'completed', conclusion: 'failure', runner_name: 'claw-2' }],
		},
		annotations: [{ message: 'Process completed with exit code 137.' }],
	});
	await tick('tok');
	const snap = getRunnerHealthSnapshot();
	assert.equal(snap?.failoverReruns, 1, 'still a failover');
	assert.equal(snap?.oomReruns, 1, 'and specifically an OOM one');
});

test('failover: a job with no annotations (or an unreadable list) is left failed', async () => {
	installFetch({
		runners: FLEET_ALL_UP,
		runs: oomRun(141),
		jobs: {
			jobs: [{ id: 904, status: 'completed', conclusion: 'failure', runner_name: 'claw-2' }],
		},
		annotations: {}, // not an array — the unreadable case
	});
	await tick('tok');
	assert.equal(rerunPosts.length, 0, 'no evidence of a kill ⇒ treat it as a real failure');
});

test('failover: a failure on a still-ONLINE runner is a real red build → never rerun', async () => {
	installFetch({
		runners: FLEET_CLAW2_DOWN,
		runs: {
			workflow_runs: [
				{
					id: 7,
					display_title: 'Lint',
					created_at: minutesAgo(3),
					updated_at: minutesAgo(2),
					status: 'completed',
					conclusion: 'failure',
					run_attempt: 1,
					html_url: 'u',
				},
			],
		},
		jobs: { jobs: [{ status: 'completed', conclusion: 'failure', runner_name: 'claw-1' }] },
	});
	await tick('tok');
	assert.equal(rerunPosts.length, 0, 'a legit red build on a healthy runner must not be masked');
});

test('failover: a red build on a GitHub-hosted runner is NOT a drop → never rerun', async () => {
	// deploy.yml runs on ubuntu-latest. Its runner ("GitHub Actions 1000019745")
	// is never in the self-hosted /actions/runners list, so "not online" is
	// trivially true — but it is NOT one of our claws dropping. A real red
	// ubuntu-latest build must stay red, not get a wasteful auto-rerun.
	installFetch({
		runners: FLEET_CLAW2_DOWN,
		runs: {
			workflow_runs: [
				{
					id: 21,
					display_title: 'Deploy to GitHub Pages',
					created_at: minutesAgo(3),
					updated_at: minutesAgo(2),
					status: 'completed',
					conclusion: 'failure',
					run_attempt: 1,
					html_url: 'u',
				},
			],
		},
		jobs: {
			jobs: [
				{ status: 'completed', conclusion: 'failure', runner_name: 'GitHub Actions 1000019745' },
			],
		},
	});
	await tick('tok');
	assert.equal(
		rerunPosts.length,
		0,
		'a github-hosted red build is a real failure, not a claw drop'
	);
	assert.equal(discordPosts.length, 0, 'and it must not post a misleading OFFLINE failover note');
});

test('failover: a run already at the attempt cap fails honestly (no rerun)', async () => {
	installFetch({
		runners: FLEET_CLAW2_DOWN,
		runs: {
			workflow_runs: [
				{
					id: 8,
					display_title: 'Deploy',
					created_at: minutesAgo(3),
					updated_at: minutesAgo(2),
					status: 'completed',
					conclusion: 'failure',
					run_attempt: 2,
					html_url: 'u',
				},
			],
		},
		jobs: { jobs: [{ status: 'completed', conclusion: 'failure', runner_name: 'claw-2' }] },
	});
	await tick('tok');
	assert.equal(rerunPosts.length, 0, 'the one-retry budget is spent → stays red');
});

test('failover: a failure older than the recency window is not rerun (no restart storms)', async () => {
	installFetch({
		runners: FLEET_CLAW2_DOWN,
		runs: {
			workflow_runs: [
				{
					id: 9,
					display_title: 'Deploy',
					created_at: minutesAgo(120),
					updated_at: minutesAgo(90),
					status: 'completed',
					conclusion: 'failure',
					run_attempt: 1,
					html_url: 'u',
				},
			],
		},
		jobs: { jobs: [{ status: 'completed', conclusion: 'failure', runner_name: 'claw-2' }] },
	});
	await tick('tok');
	assert.equal(rerunPosts.length, 0, 'failures past the window are not auto-rerun');
});

test('failover: does not double-fire for the same (run, attempt) across ticks', async () => {
	installFetch({
		runners: FLEET_CLAW2_DOWN,
		runs: {
			workflow_runs: [
				{
					id: 42,
					display_title: 'Update Packages',
					created_at: minutesAgo(3),
					updated_at: minutesAgo(2),
					status: 'completed',
					conclusion: 'failure',
					run_attempt: 1,
					html_url: 'https://gh/run/42',
				},
			],
		},
		jobs: { jobs: [{ status: 'completed', conclusion: 'failure', runner_name: 'claw-2' }] },
	});
	await tick('tok');
	await tick('tok');
	assert.equal(
		rerunPosts.length,
		1,
		'one rerun per (run, attempt), even if it still reads as failed next tick'
	);
});

test('failover: runner listing unreadable → no rerun (cannot correlate the drop)', async () => {
	installFetch({
		runnersStatus: 403,
		runs: {
			workflow_runs: [
				{
					id: 5,
					display_title: 'Deploy',
					created_at: minutesAgo(2),
					updated_at: minutesAgo(1),
					status: 'completed',
					conclusion: 'failure',
					run_attempt: 1,
					html_url: 'u',
				},
			],
		},
		jobs: { jobs: [{ status: 'completed', conclusion: 'failure', runner_name: 'claw-2' }] },
	});
	await tick('tok');
	assert.equal(
		rerunPosts.length,
		0,
		'without the online-runner set we cannot tell a drop from a red build'
	);
});

/**
 * The 2026-08-17 regression. Every RUNS call used to be hardcoded to
 * hadoku_site, so when claw-3 died mid-job it took four CHILD-repo publishes
 * with it and `failover_reruns` reported 0 — the failover could not see them.
 * They only recovered because an unrelated push happened to re-trigger them.
 *
 * The stub answers per-repo here (the shared one keys on URL substring alone),
 * so hadoku_site is quiet and the drop exists only in the child repo. Before the
 * fix this asserts 0 reruns; after it, exactly one, aimed at the child.
 */
test('failover: a drop in a CHILD repo is rerun, not just hadoku_site', async () => {
	__setFleetReposForTesting(['WolffM/hadoku_site', 'WolffM/hadoku-aggregator']);
	installFetch({
		runners: FLEET_CLAW2_DOWN,
		jobs: { jobs: [{ status: 'completed', conclusion: 'failure', runner_name: 'claw-2' }] },
		// Only the child repo has the dropped run; hadoku_site is quiet. That
		// asymmetry IS the test — a hardcoded-to-hadoku_site sweep sees nothing.
		runs: (repo) =>
			repo === 'WolffM/hadoku-aggregator'
				? {
						workflow_runs: [
							{
								id: 77,
								display_title: 'Publish Package',
								created_at: minutesAgo(3),
								updated_at: minutesAgo(2),
								status: 'completed',
								conclusion: 'failure',
								run_attempt: 1,
								html_url: 'https://gh/run/77',
							},
						],
					}
				: { workflow_runs: [] },
	});

	await tick('tok');
	assert.equal(rerunPosts.length, 1, 'the child-repo drop must be rerun exactly once');
	assert.match(
		rerunPosts[0]!,
		/hadoku-aggregator\/actions\/runs\/77\/rerun-failed-jobs$/,
		'the rerun must be aimed at the child repo, not hadoku_site'
	);
});

// --- failure arms of the write paths (2026-08-30) --------------------------
//
// `labelStatus` and `rerunStatus` were declared in installFetch and used by no
// test, so the arms they exist for had never executed: a promote that GitHub
// refuses, and a rerun POST that fails. Both are the "we tried and could not"
// case, and in both the correct behaviour is to stay quiet and leave the state
// untouched rather than claim success.

test('failover: a rerun POST that FAILS does not count as a rerun', async () => {
	// failover_reruns is the number the daily digest reports as "CI is
	// self-healing, and how hard". Counting a failed POST would overstate it and
	// hide a token that has lost actions:write.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
				{ id: 3, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				{ id: 10, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
			],
		},
		runs: {
			workflow_runs: [
				{
					id: 4242,
					display_title: 'Publish Package',
					created_at: minutesAgo(3),
					updated_at: minutesAgo(2),
					status: 'completed',
					conclusion: 'failure',
					run_attempt: 1,
					html_url: 'https://gh/run/4242',
				},
			],
		},
		jobs: { jobs: [{ status: 'completed', conclusion: 'failure', runner_name: 'claw-2' }] },
		rerunStatus: 500,
	});
	await tick('tok');

	assert.equal(rerunPosts.length, 1, 'the rerun must be ATTEMPTED, or this proves nothing');
	const snap = getRunnerHealthSnapshot();
	assert.equal(snap?.failoverReruns, 0, 'a failed rerun POST must not be counted as a rerun');
});

test('failover: the per-tick rerun cap holds across a concurrent sweep', async () => {
	const repos = sweepRepos(2 * SWEEP_CONCURRENCY);
	__setFleetReposForTesting(repos);
	installFetch({
		runners: FLEET_CLAW2_DOWN,
		// Every repo holds a fresh drop on the offline claw — more candidates than
		// the cap, arriving from several repos at once.
		runs: (repo) => oomRun(1000 + repos.indexOf(repo)),
		jobs: { jobs: [{ status: 'completed', conclusion: 'failure', runner_name: 'claw-2' }] },
	});
	await tick('tok');
	assert.equal(
		rerunPosts.length,
		MAX_RERUNS_PER_TICK,
		'exactly the cap, however the repos interleave'
	);
	assert.equal(getRunnerHealthSnapshot()?.failoverReruns, MAX_RERUNS_PER_TICK);
});
