/**
 * Tests for `runner-health-queue-classify.ts`'s classification of a queued
 * run: busy-pool waits, an uncovered label, the mint-matching rules (#110,
 * fleet-manager#2 — waiting for a mint, a mint that never came online, a
 * mismatched mint), hosted-image detection, re-run aging, and child-repo
 * alerting. Split out of runner-health.test.ts (wave 5p lane B) — see
 * `src/tests/helpers/runner-health-rig.ts` for the shared fetch-stub fixture
 * every file that ticks the monitor installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tick, __setFleetReposForTesting } from '../runner-health.js';
import { __setFleetProbeForTesting } from '../fleet-probe-store.js';
import { omittedByFilter, __resetUnfilteredQueueForTesting } from '../runners/unfiltered-queue.js';
import {
	installRunnerHealthRig,
	installFetch,
	discordPosts,
	quietRecords,
} from './helpers/runner-health-rig.js';
import { clawLabels, hokonLabels, minutesAgo } from './helpers/runner-health-fixtures.js';

installRunnerHealthRig();

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

/** A queued run in a child repo must alert too, and name the repo it is in. */
test('queued: a busy pool is a WAIT, not a fault — ledger only', async () => {
	// "likely no online runner matches its labels" was a guess, and with 27
	// registered instances it was usually wrong. It fired 36 times in the fifteen
	// days to 2026-08-28, the largest single category of runner-health traffic,
	// mostly during the nightly package storm when every claw was legitimately
	// saturated. So it asks now, the same way the in_progress branch does.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		runs: {
			workflow_runs: [
				{
					id: 77,
					display_title: 'Build',
					created_at: minutesAgo(20),
					status: 'queued',
					html_url: 'https://gh/run/77',
				},
			],
		},
		// EXACTLY what `vars.CI_RUNNER` expands to on every covered repo. A bare
		// `['hadoku-builder']` here is the shape that made this test pass against
		// a branch production could never reach.
		jobs: {
			jobs: [
				{ id: 1, status: 'queued', started_at: null, labels: ['self-hosted', 'hadoku-builder'] },
			],
		},
	});
	await tick('tok');

	assert.equal(
		discordPosts.filter((m) => m.includes('QUEUED')).length,
		0,
		'a label that IS online means the job is waiting its turn'
	);
	const quiet = quietRecords.filter((m) => m.includes('QUEUED'));
	assert.equal(quiet.length, 1, 'still recorded — it just does not ring');
	assert.match(quiet[0]!, /every label it wants IS online/);
});

test('queued: a label NOTHING online carries still pings — that is the real gap', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		runs: {
			workflow_runs: [
				{
					id: 78,
					display_title: 'Transcode',
					created_at: minutesAgo(20),
					status: 'queued',
					html_url: 'https://gh/run/78',
				},
			],
		},
		jobs: {
			jobs: [
				{ id: 2, status: 'queued', started_at: null, labels: ['self-hosted', 'label-nobody-has'] },
			],
		},
	});
	await tick('tok');

	const pings = discordPosts.filter((m) => m.includes('QUEUED'));
	assert.equal(pings.length, 1, 'an uncovered label is a coverage gap and must page');
	// NAMES the label. "no online runner matches its labels" sent the operator to
	// open the run every time, and could not tell a dead label from a busy pool.
	assert.match(pings[0]!, /NO online runner carries `label-nobody-has`/);
});

/**
 * #110: under all-JIT a repo's own listing carries no builder runner until a
 * job asks, so "no online runner carries `hadoku-builder`" was the verdict for
 * nearly every queued job — and it PAGED as a coverage gap while a live claw
 * was about to mint. These tests hold the four answers apart: waiting for a
 * mint (quiet), waited too long for one (loud), a mint that never came online
 * (loud, named), and nothing that could mint (loud, a real gap).
 */
function mintQueueFetch(runners: unknown[], ageMin: number, jobId = 21): void {
	installFetch({
		runners: { runners },
		runs: {
			workflow_runs: [
				{
					id: 88,
					name: 'Auto-update @wolffm packages',
					display_title: 'wolffm_published',
					created_at: minutesAgo(ageMin),
					status: 'queued',
					html_url: 'https://gh/run/88',
				},
			],
		},
		jobs: {
			jobs: [
				{
					id: jobId,
					status: 'queued',
					started_at: null,
					labels: ['self-hosted', 'hadoku-builder'],
				},
			],
		},
	});
}

const hokonOnly = () => [
	{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
];

test('queued (#110): no standing builder, a live claw can mint — a WAIT, ledger only', async () => {
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: { 'claw-9': { reachable: true, free: 2, sick: false } },
	} as never);
	mintQueueFetch(hokonOnly(), 12);
	await tick('tok');

	assert.equal(discordPosts.filter((m) => m.includes('QUEUED')).length, 0);
	const quiet = quietRecords.filter((m) => m.includes('QUEUED'));
	assert.equal(quiet.length, 1, 'still recorded — it just does not ring');
	assert.match(
		quiet[0]!,
		/no standing runner carries `hadoku-builder`; claw-9 offers it and can mint/
	);
	assert.match(quiet[0]!, /waiting for a mint/);
});

test('queued (#110): a mint wait past the ceiling PAGES — a mint that never happens is not a wait', async () => {
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: { 'claw-9': { reachable: true, free: 2, sick: false } },
	} as never);
	mintQueueFetch(hokonOnly(), 45);
	await tick('tok');

	const pings = discordPosts.filter((m) => m.includes('QUEUED'));
	assert.equal(pings.length, 1, 'quieter the longer it lasts is the inversion this file refuses');
	assert.match(pings[0]!, /nothing has served it in 30\+ min/);
	assert.match(pings[0]!, /\[dispatch\] skipped run 88/);
});

test('queued (#110): a runner minted for the job and still OFFLINE pages, naming it and its node', async () => {
	// The 2026-10-16 shape: claw-9 lost DNS, the minted listener retried for 65
	// minutes, the dispatcher held the job in flight. By labels alone a live
	// claw offered it, so without this the page went quiet.
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: { 'claw-9': { reachable: true, free: 2, sick: false } },
	} as never);
	const minted = Math.floor((Date.now() - 10 * 60_000) / 1000);
	const deaf = `jit-claw-9-hadoku-bomberma-j21-r88-${minted}`;
	mintQueueFetch(
		[...hokonOnly(), { id: 9, name: deaf, status: 'offline', busy: false, labels: clawLabels() }],
		12
	);
	await tick('tok');

	const pings = discordPosts.filter((m) => m.includes('QUEUED'));
	assert.equal(pings.length, 1, 'a deaf mint is an outage, not a wait');
	assert.match(pings[0]!, new RegExp(`\`${deaf}\` was minted for it on \`claw-9\` 10m ago`));
	assert.match(pings[0]!, /still OFFLINE in GitHub's listing/);
});

test('queued (#110): a fresh offline mint, or one for ANOTHER job, is not called deaf', async () => {
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: { 'claw-9': { reachable: true, free: 2, sick: false } },
	} as never);
	const fresh = Math.floor((Date.now() - 60_000) / 1000);
	const old = Math.floor((Date.now() - 20 * 60_000) / 1000);
	mintQueueFetch(
		[
			...hokonOnly(),
			{ id: 9, name: `jit-claw-9-x-j21-r88-${fresh}`, status: 'offline', busy: false, labels: [] },
			{ id: 10, name: `jit-claw-9-x-j999-r88-${old}`, status: 'offline', busy: false, labels: [] },
		],
		12
	);
	await tick('tok');

	assert.equal(discordPosts.filter((m) => m.includes('QUEUED')).length, 0);
	assert.match(
		quietRecords.find((m) => m.includes('QUEUED'))!,
		/waiting for a mint/
	);
});

test('queued (fleet-manager#2): an ONLINE mint for the job that lacks its labels pages, naming what it lacks', async () => {
	// The 2026-10-23 shape: hokon's mint for bomberman registered without
	// `hadoku-builder`, and the alert said hokon "offers it and can mint" while
	// that runner sat online beside the job it could never take.
	// MUTATION: drop the mismatch check and this reads "waiting for a mint".
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: { 'claw-9': { reachable: true, free: 2, sick: false } },
	} as never);
	const minted = Math.floor((Date.now() - 8 * 60_000) / 1000);
	const stuck = `jit-claw-9-hadoku-bomberma-j21-r88-${minted}`;
	// A node the mint view does not list is not named — `nodeOf` falls back to
	// the bare runner name, which is not a node.
	const unlisted = `jit-hokon-hadoku-bomberman-j21-r88-${minted}`;
	mintQueueFetch(
		[
			...hokonOnly(),
			{ id: 9, name: stuck, status: 'online', busy: false, labels: hokonLabels() },
			{ id: 10, name: unlisted, status: 'online', busy: false, labels: hokonLabels() },
		],
		12
	);
	await tick('tok');

	const pings = discordPosts.filter((m) => m.includes('QUEUED'));
	assert.equal(pings.length, 1, 'a mint that cannot take its job is an outage, not a wait');
	assert.match(
		pings[0]!,
		new RegExp(
			`\`${stuck}\` was minted for it on \`claw-9\` 8m ago and is online, but lacks \`hadoku-builder\``
		)
	);
	assert.match(
		pings[0]!,
		new RegExp(`\`${unlisted}\` was minted for it 8m ago and is online, but lacks`)
	);
	assert.match(pings[0]!, /GitHub will never assign it the job/);
});

test('queued (fleet-manager#2): an online mint that carries the labels, is busy, or is for another job is not a mismatch', async () => {
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: { 'claw-9': { reachable: true, free: 2, sick: false } },
	} as never);
	const minted = Math.floor((Date.now() - 8 * 60_000) / 1000);
	mintQueueFetch(
		[
			...hokonOnly(),
			// Carries `hadoku-builder` in another case — GitHub matches labels case-insensitively.
			{
				id: 9,
				name: `jit-claw-9-x-j21-r88-${minted}`,
				status: 'online',
				busy: false,
				labels: [{ name: 'self-hosted' }, { name: 'HADOKU-BUILDER' }],
			},
			{
				id: 10,
				name: `jit-hokon-x-j21-r88-${minted}`,
				status: 'online',
				busy: true,
				labels: hokonLabels(),
			},
			{
				id: 11,
				name: `jit-hokon-x-j999-r88-${minted}`,
				status: 'online',
				busy: false,
				labels: hokonLabels(),
			},
		],
		12
	);
	await tick('tok');

	assert.equal(discordPosts.filter((m) => m.includes('QUEUED')).length, 0);
	assert.match(
		quietRecords.find((m) => m.includes('QUEUED'))!,
		/waiting for a mint/
	);
});

test('queued (#110): every claw that offers it unreachable — a coverage gap, and it says why', async () => {
	// The default probe: claw-1 and claw-3 looked at and down; the rest absent.
	mintQueueFetch(hokonOnly(), 12);
	await tick('tok');

	const pings = discordPosts.filter((m) => m.includes('QUEUED'));
	assert.equal(pings.length, 1);
	assert.match(pings[0]!, /NO online runner carries `hadoku-builder` \(.*unreachable or sick/);
});

test('queued (#110): an UNMEASURED minting arm holds quietly, and says so', async () => {
	__setFleetProbeForTesting(null as never);
	mintQueueFetch(hokonOnly(), 12);
	await tick('tok');

	assert.equal(discordPosts.filter((m) => m.includes('QUEUED')).length, 0);
	assert.match(
		quietRecords.find((m) => m.includes('QUEUED'))!,
		/the fast loop has not probed the minting nodes that offer it/
	);
});

test('queued: a run with NO jobs at all pings — it was never scheduled', async () => {
	// `jobs: []` is READABLE and empty, which is a different fact from a listing
	// that could not be fetched — this test fed the empty one under the other
	// name for its whole life. Empty past the threshold means GitHub attributed
	// the run to nothing at all, hosted or otherwise, and stays loud.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		runs: {
			workflow_runs: [
				{
					id: 79,
					display_title: 'Build',
					created_at: minutesAgo(20),
					status: 'queued',
					html_url: 'https://gh/run/79',
				},
			],
		},
		jobs: { jobs: [] },
	});
	await tick('tok');
	assert.equal(discordPosts.filter((m) => m.includes('QUEUED')).length, 1);
});

test('queued: a job whose labels cannot be read is NOT treated as covered', async () => {
	// Same rule as assert_region's "rows with no readable ZIP FAIL rather than
	// pass": silence is what this check exists to end, so an unreadable answer
	// must not buy quiet.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		runs: {
			workflow_runs: [
				{
					id: 80,
					display_title: 'Build',
					created_at: minutesAgo(20),
					status: 'queued',
					html_url: 'https://gh/run/80',
				},
			],
		},
		jobs: { jobs: [{ id: 3, status: 'queued', started_at: null }] },
	});
	await tick('tok');
	assert.equal(
		discordPosts.filter((m) => m.includes('QUEUED')).length,
		1,
		'no labels means no evidence of coverage'
	);
});

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

test('queued: a stuck run in a CHILD repo alerts and names that repo', async () => {
	__setFleetReposForTesting(['WolffM/hadoku_site', 'WolffM/hadoku-watchparty']);
	installFetch({
		runners: FLEET_CLAW2_DOWN,
		// The stuck run exists ONLY in the child repo — a sweep that reads
		// hadoku_site alone finds nothing to alert on.
		runs: (repo) =>
			repo === 'WolffM/hadoku-watchparty'
				? {
						workflow_runs: [
							{
								id: 91,
								display_title: 'Build UI',
								created_at: minutesAgo(45),
								status: 'queued',
								html_url: 'https://gh/run/91',
							},
						],
					}
				: { workflow_runs: [] },
	});

	await tick('tok');
	const queued = discordPosts.filter((m) => m.includes('QUEUED'));
	assert.equal(queued.length, 1, 'one queued alert');
	assert.match(queued[0]!, /hadoku-watchparty/, 'the alert must name the repo the run is in');
});

/**
 * A RE-RUN reports the age of THIS attempt, not of the original run.
 *
 * `created_at` pins to the first attempt and GitHub never moves it, so reading
 * the age from it bills a re-run for the entire gap between attempts. On
 * 2026-09-10 two hadoku-tenhands runs were re-run two hours after the push and
 * both paged "QUEUED 122m" while their jobs started four seconds later and
 * every one went green. 122 minutes was exactly push→re-run.
 */
test('queued: a re-run is aged from run_started_at, not the original created_at', async () => {
	installFetch({
		runners: {
			runners: [{ id: 1, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
		runs: {
			workflow_runs: [
				{
					id: 91,
					name: 'Tests',
					display_title: 'refactor(header): derive the app name',
					created_at: minutesAgo(122),
					run_started_at: minutesAgo(1),
					run_attempt: 2,
					status: 'queued',
					html_url: 'https://gh/run/91',
				},
			],
		},
		jobs: {
			jobs: [
				{ id: 1, status: 'queued', started_at: null, labels: ['self-hosted', 'hadoku-builder'] },
			],
		},
	});
	await tick('tok');

	assert.equal(
		[...discordPosts, ...quietRecords].filter((m) => m.includes('QUEUED')).length,
		0,
		'one minute into a fresh attempt is not a stale queue at any threshold'
	);
});

/**
 * A GitHub-HOSTED job is not a fleet coverage gap.
 *
 * `ubuntu-latest` is served by GitHub's pool, and no self-hosted box carries
 * that label — so measuring it against the fleet census can only ever report a
 * gap. hadoku-tenhands' pages.yml is 100% hosted BY DESIGN (a public-repo push
 * trigger must never touch self-hosted), and it paged as an uncovered label.
 */
test('queued: a hosted job is not a fleet gap — ledger only, and says why', async () => {
	installFetch({
		runners: {
			runners: [{ id: 1, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
		runs: {
			workflow_runs: [
				{
					id: 92,
					name: 'Deploy demo to Pages',
					display_title: 'refactor(header): derive the app name',
					created_at: minutesAgo(20),
					status: 'queued',
					html_url: 'https://gh/run/92',
				},
			],
		},
		jobs: { jobs: [{ id: 1, status: 'queued', started_at: null, labels: ['ubuntu-latest'] }] },
	});
	await tick('tok');

	assert.equal(
		discordPosts.filter((m) => m.includes('QUEUED')).length,
		0,
		'the fleet does not serve a hosted job and cannot be the cause of its queue'
	);
	const quiet = quietRecords.filter((m) => m.includes('QUEUED'));
	assert.equal(quiet.length, 1, 'still recorded — hosted minutes are worth seeing');
	assert.match(quiet[0]!, /GitHub-HOSTED/);
});

/** `ubuntu-24.04` is every bit as hosted as `ubuntu-latest`. */
test('queued: a PINNED hosted image is hosted too', async () => {
	installFetch({
		runners: {
			runners: [{ id: 1, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
		runs: {
			workflow_runs: [
				{
					id: 93,
					name: 'kate-plugin',
					display_title: 'build the plugin',
					created_at: minutesAgo(20),
					status: 'queued',
					html_url: 'https://gh/run/93',
				},
			],
		},
		jobs: { jobs: [{ id: 1, status: 'queued', started_at: null, labels: ['ubuntu-24.04'] }] },
	});
	await tick('tok');

	assert.equal(discordPosts.filter((m) => m.includes('QUEUED')).length, 0);
	assert.match(quietRecords.filter((m) => m.includes('QUEUED'))[0]!, /GitHub-HOSTED/);
});

/**
 * A BARE `ubuntu` (no `-` at all) is still a hosted image — plan §4.1 F13,
 * 5a §8.3. This file's own `isHostedLabel` used to require a dash and
 * something after it, so a job pinned to the bare image read as a
 * self-hosted coverage gap and would have paged, exactly the false alarm
 * `ubuntu-24.04` caused before THAT fix landed.
 */
test('queued: a BARE "ubuntu" with no dash is hosted too (F13)', async () => {
	installFetch({
		runners: {
			runners: [{ id: 1, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
		runs: {
			workflow_runs: [
				{
					id: 94,
					name: 'bare-ubuntu-job',
					display_title: 'build on bare ubuntu',
					created_at: minutesAgo(20),
					status: 'queued',
					html_url: 'https://gh/run/94',
				},
			],
		},
		jobs: { jobs: [{ id: 1, status: 'queued', started_at: null, labels: ['ubuntu'] }] },
	});
	await tick('tok');

	assert.equal(discordPosts.filter((m) => m.includes('QUEUED')).length, 0);
	assert.match(quietRecords.filter((m) => m.includes('QUEUED'))[0]!, /GitHub-HOSTED/);
});

/**
 * The alert names the WORKFLOW, not just the commit subject.
 *
 * `display_title` is the commit message, so two different workflows triggered
 * by one push produce byte-identical alerts. On 2026-09-10 a Tests run and a
 * Pages run arrived reading as the same finding posted twice, and telling them
 * apart meant opening both URLs.
 */
test('queued: the alert names the workflow, so two runs on one push differ', async () => {
	installFetch({
		runners: {
			runners: [{ id: 1, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
		runs: {
			workflow_runs: [
				{
					id: 94,
					name: 'Tests',
					display_title: 'one commit, two workflows',
					created_at: minutesAgo(20),
					status: 'queued',
					html_url: 'https://gh/run/94',
				},
			],
		},
		jobs: {
			jobs: [{ id: 1, status: 'queued', started_at: null, labels: ['self-hosted', 'nothing-has'] }],
		},
	});
	await tick('tok');

	const pings = discordPosts.filter((m) => m.includes('QUEUED'));
	assert.equal(pings.length, 1);
	assert.match(pings[0]!, /`Tests`/, 'the workflow name is what tells two runs on one push apart');
});

/**
 * A jobs listing that could not be FETCHED is the "I could not look" case, and
 * it must never buy quiet. Distinct from the empty-but-readable listing above:
 * a rate limit, a timeout and a deleted run are three different jobs, and the
 * reason has to survive into the finding for any of them to be actionable.
 */
test('queued: a jobs listing that 500s pings, and says it could not look', async () => {
	installFetch({
		runners: {
			runners: [{ id: 1, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
		runs: {
			workflow_runs: [
				{
					id: 95,
					name: 'Tests',
					display_title: 'Build',
					created_at: minutesAgo(20),
					status: 'queued',
					html_url: 'https://gh/run/95',
				},
			],
		},
		jobsStatus: 500,
	});
	await tick('tok');

	const pings = discordPosts.filter((m) => m.includes('QUEUED'));
	assert.equal(
		pings.length,
		1,
		'silence on an unreadable answer is the outage this check exists to catch'
	);
	assert.match(pings[0]!, /unreadable/);
});

test('queued: the sweep hands its unfiltered listing to the dispatcher', async () => {
	// GitHub's `?status=queued` filter left hadoku-tenhands 42971351168 out for
	// 11 hours while this listing called it QUEUED; the dispatcher serves what
	// this read shows waiting (unfiltered-queue.ts).
	__resetUnfilteredQueueForTesting();
	__setFleetReposForTesting(['WolffM/hadoku_site', 'WolffM/hadoku-tenhands']);
	installFetch({
		runners: FLEET_CLAW2_DOWN,
		runs: (repo) =>
			repo === 'WolffM/hadoku-tenhands'
				? {
						workflow_runs: [
							{ id: 5, created_at: minutesAgo(3), status: 'queued', html_url: 'https://gh/run/5' },
							{
								id: 6,
								created_at: minutesAgo(3),
								status: 'completed',
								html_url: 'https://gh/run/6',
							},
						],
					}
				: { workflow_runs: [] },
	});
	await tick('tok');
	const omitted = omittedByFilter('WolffM/hadoku-tenhands', 'queued', [], Date.now());
	assert.deepEqual(
		omitted.runs.map((r) => r.id),
		[5],
		'the waiting run, and only it'
	);
	__resetUnfilteredQueueForTesting();
});
