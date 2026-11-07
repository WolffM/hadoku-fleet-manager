/**
 * Tests for `runner-health.ts`'s own orchestrator: the gh-read-failure
 * classification that feeds the daily digest, `start()`'s settle-free first
 * tick and its unmeasured/budget-spent/no-token retry paths, the concurrent
 * repo sweep and its shared per-tick jobs budget, the #118 cross-loop listing
 * dedupe, and the one-shot `logTokenCapabilities` startup probe. Split out
 * of runner-health.test.ts (wave 5p lane B) — see
 * `src/tests/helpers/runner-health-rig.ts` for the shared fetch-stub fixture
 * every file that ticks the monitor installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_FETCH_PER_TICK } from '../job-history-ingest.js';
import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';

import {
	tick,
	startRunnerHealthMonitor,
	__awaitInFlightTickForTesting,
	__stopRunnerHealthMonitorForTesting,
	__setRemeasureDelayForTesting,
	__setPostBlackoutSlackForTesting,
	__setTokenRetryForTesting,
	__setFleetReposForTesting,
	__logTokenCapabilitiesForTesting,
} from '../runner-health.js';
import { SWEEP_CONCURRENCY } from '../lib/concurrency.js';
import { __setSupervisionCheckerForTesting } from '../runner-health-watch.js';
import { getRunnerHealthSnapshot } from '../runner-health-snapshot.js';
import {
	classifyGhReadFailure,
	unreadableTickError,
	__resetGhBlackoutForTesting,
} from '../lib/github-client-blackout.js';
import { ghGet } from '../lib/github-client.js';
import { __setFleetProbeForTesting } from '../fleet-probe-store.js';
import {
	installRunnerHealthRig,
	installFetch,
	jobSinkPosts,
	jobListings,
	runnerListings,
} from './helpers/runner-health-rig.js';
import { minutesAgo, FLEET_ALL_UP } from './helpers/runner-health-fixtures.js';
import { scaledMs } from './helpers/host-pace.js';

installRunnerHealthRig();

// The 08:14Z failure on 2026-10-11 said "unreachable OR lacks repo scope" for a
// spent rate limit, while the token logged scopes='repo, workflow' on every start.

test('classifyGhReadFailure: a rate-limit 403 is not a scope problem', () => {
	assert.equal(
		classifyGhReadFailure(403, '0', 'API rate limit exceeded for user ID 1'),
		'rate-limit'
	);
	assert.equal(
		classifyGhReadFailure(403, '4000', 'You have exceeded a secondary rate limit'),
		'rate-limit'
	);
	assert.equal(classifyGhReadFailure(429, null, ''), 'rate-limit');
	assert.equal(
		classifyGhReadFailure(403, '4000', 'Resource not accessible by integration'),
		'auth'
	);
	assert.equal(classifyGhReadFailure(401, null, 'Bad credentials'), 'auth');
	assert.equal(classifyGhReadFailure(404, null, 'Not Found'), 'auth');
	assert.equal(classifyGhReadFailure(502, null, ''), 'http');
});

test('unreadableTickError: only an auth answer blames the token', () => {
	assert.doesNotMatch(unreadableTickError({ kind: 'rate-limit', detail: 'x' }), /scope/);
	assert.match(unreadableTickError({ kind: 'rate-limit', detail: 'x' }), /rate limit/);
	assert.doesNotMatch(unreadableTickError({ kind: 'network', detail: 'aborted' }), /scope/);
	assert.doesNotMatch(unreadableTickError({ kind: 'http', detail: '502' }), /scope/);
	assert.match(unreadableTickError({ kind: 'auth', detail: '403' }), /lack repo scope/);
	assert.match(unreadableTickError(null), /could not look/);
});

test('runner-health: a tick that reads nothing under a spent budget says RATE LIMIT, not scope', async () => {
	installFetch({});
	const inner = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (
			url.includes('api.github.com') &&
			(url.includes('/actions/runners') || url.includes('/actions/runs'))
		) {
			return {
				ok: false,
				status: 403,
				headers: new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' }),
				json: async () => ({}),
				text: async () =>
					JSON.stringify({ message: 'API rate limit exceeded for user ID 8714327.' }),
			} as unknown as Response;
		}
		return inner(input, init);
	}) as typeof fetch;
	try {
		await tick('tok');
	} finally {
		__resetGhBlackoutForTesting();
	}
	const failed = jobSinkPosts.filter((p) => p.status === 'failed');
	assert.equal(failed.length, 1, JSON.stringify(jobSinkPosts));
	const error = JSON.stringify(failed[0]);
	assert.match(error, /rate limit spent/);
	assert.doesNotMatch(error, /lack repo scope/);
});

test('runner-health: a tick refused 403 without a rate limit still names the token scope', async () => {
	installFetch({ runnersStatus: 403, runsStatus: 403 });
	await tick('tok');
	const failed = jobSinkPosts.filter((p) => p.status === 'failed');
	assert.equal(failed.length, 1);
	assert.match(JSON.stringify(failed[0]), /lack repo scope/);
});

// --- failure arms of the write paths (2026-08-30) --------------------------
//
// `labelStatus` and `rerunStatus` were declared in installFetch and used by no
// test, so the arms they exist for had never executed: a promote that GitHub
// refuses, and a rerun POST that fails. Both are the "we tried and could not"
// case, and in both the correct behaviour is to stay quiet and leave the state
// untouched rather than claim success.

// --- Startup latency and the fan-out (2026-09-01) ---
//
// After every mgmt-api restart — ten of them on 2026-09-01 — the Fleet tab sat
// blank for 65–90s: a 30s "let the server settle" delay before the first tick,
// then ~35s of listing 27 repos one after another. Neither was load-bearing.
// These pin the two fixes: the first tick fires on the turn start() is called,
// and the sweep runs repos in parallel under a small cap.

test('start: the first tick goes out on the turn start() is called, not after a settle delay', async () => {
	installFetch({ runners: FLEET_ALL_UP });
	// Installed BEFORE start(): the real probe SSHes the claws, and start() must
	// keep a double that is already in place.
	__setSupervisionCheckerForTesting(() => Promise.resolve(null));
	__setHostForTesting({ ...testHost, githubToken: () => 'tok' });
	const seen: string[] = [];
	const inner = globalThis.fetch;
	globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
		seen.push(String(input));
		return inner(input, init);
	}) as typeof globalThis.fetch;
	try {
		startRunnerHealthMonitor();
		// Asserted with NO await between start() and here: the listing has to be
		// in flight already. Any delay at all — even setTimeout(fn, 0) — fails this.
		assert.ok(
			seen.some((u) => u.includes('/actions/runners')),
			`the runner listing must already be in flight when start() returns; saw [${seen.join(', ')}]`
		);
		await __awaitInFlightTickForTesting();
		assert.equal(getRunnerHealthSnapshot()?.runnersChecked, true, 'and that tick completed');
	} finally {
		__stopRunnerHealthMonitorForTesting();
		__setHostForTesting(testHost);
	}
});

/**
 * THE UNMEASURED FIRST TICK — the call site, not the module.
 *
 * ci-runner-fallback's own suite proves the writer holds on `null`. Nothing
 * proved this tick PASSES null, and that gap was real: removing the
 * `ephemeralUnknown` check at the call site compiled and left all 959 tests
 * green, because `clawsOnline + backstopOnline` is a `number` and satisfies a
 * `number | null` parameter perfectly well. The type cannot catch it. This does.
 *
 * The condition is a restart. Under all-JIT every claw's capacity comes from the
 * fast loop's probe, which is null until its first pass ~60s after boot, so this
 * tick reads zero claws on a healthy fleet. Observed 2026-09-07 over three
 * consecutive deploys: 1, then 10, then 0, then 3, against a steady 6 in
 * between, while `runners_checked=true` claimed the read had succeeded.
 *
 * `desired` has no debounce, so one such tick would pin every covered repo to
 * `ubuntu-latest` — billed minutes on 12 private repos, and a hosted runner
 * cannot reach the vault.
 */

test('start: an UNMEASURED first tick is followed by a re-tick once the probe lands, not by ten minutes of nothing', async () => {
	installFetch({ runners: FLEET_ALL_UP });
	__setSupervisionCheckerForTesting(() => Promise.resolve(null));
	__setHostForTesting({ ...testHost, githubToken: () => 'tok' });
	// The restart shape: no fast-loop probe yet.
	__setFleetProbeForTesting(null);
	__setRemeasureDelayForTesting(25);
	try {
		startRunnerHealthMonitor();
		await __awaitInFlightTickForTesting();
		assert.equal(
			getRunnerHealthSnapshot()?.ephemeral_unknown,
			true,
			'the first tick could not measure'
		);
		const firstAt = getRunnerHealthSnapshot()?.at;
		// The fast loop's first pass lands.
		__setFleetProbeForTesting({ at: new Date().toISOString(), nodes: {} });
		await new Promise((r) => setTimeout(r, 80));
		await __awaitInFlightTickForTesting();
		const snap = getRunnerHealthSnapshot();
		assert.notEqual(snap?.at, firstAt, 'a second tick ran without waiting for the interval');
		assert.equal(snap?.ephemeral_unknown, false, 'and it measured the fleet');
	} finally {
		__stopRunnerHealthMonitorForTesting();
		__setRemeasureDelayForTesting(null);
		__setHostForTesting(testHost);
	}
});

test('start: a tick that falls in a spent budget is re-run just past the reset, not at the next interval', async () => {
	// 2026-10-25: budget spent 05:30:36 -> 05:59:00Z; the backstop's next look
	// was the 06:03 interval tick while the oldest queued run was 42 minutes old.
	installFetch({ runners: FLEET_ALL_UP });
	const inner = globalThis.fetch;
	const resetAtSec = Math.ceil(Date.now() / 1000) + 1;
	let spent = true;
	let reads = 0;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.includes('api.github.com') && url.includes('/actions/runners')) reads++;
		if (spent && url.includes('api.github.com')) {
			return {
				ok: false,
				status: 403,
				headers: new Headers({
					'x-ratelimit-remaining': '0',
					'x-ratelimit-reset': String(resetAtSec),
				}),
				json: async () => ({}),
				text: async () => JSON.stringify({ message: 'API rate limit exceeded for user ID 1.' }),
			} as unknown as Response;
		}
		return inner(input, init);
	}) as typeof fetch;
	__setSupervisionCheckerForTesting(() => Promise.resolve(null));
	__setHostForTesting({ ...testHost, githubToken: () => 'tok' });
	__setFleetProbeForTesting({ at: new Date().toISOString(), nodes: {} });
	__setPostBlackoutSlackForTesting(10);
	try {
		startRunnerHealthMonitor();
		await __awaitInFlightTickForTesting();
		assert.notEqual(getRunnerHealthSnapshot()?.runnersChecked, true, 'the blind tick read nothing');
		spent = false;
		const blindReads = reads;
		// Wait for the re-tick itself, not a fixed 200ms past the reset: on 11-02
		// claw-1 under load had not started it yet, and the push was reverted
		// (fleet-manager#68). The bound is seconds; the next interval tick is
		// minutes away, so "just past the reset" is still what this proves.
		const deadline = resetAtSec * 1000 + scaledMs(3000);
		while (reads <= blindReads && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 25));
		}
		await __awaitInFlightTickForTesting();
		assert.ok(reads > blindReads, 'a tick went out once the budget reset');
		assert.equal(getRunnerHealthSnapshot()?.runnersChecked, true, 'and it read the fleet');
	} finally {
		__stopRunnerHealthMonitorForTesting();
		__setPostBlackoutSlackForTesting(null);
		__resetGhBlackoutForTesting();
		__setHostForTesting(testHost);
	}
});

test('start: a MEASURED first tick schedules no re-tick', async () => {
	installFetch({ runners: FLEET_ALL_UP });
	__setSupervisionCheckerForTesting(() => Promise.resolve(null));
	__setHostForTesting({ ...testHost, githubToken: () => 'tok' });
	__setRemeasureDelayForTesting(25);
	try {
		startRunnerHealthMonitor();
		await __awaitInFlightTickForTesting();
		assert.equal(getRunnerHealthSnapshot()?.ephemeral_unknown, false);
		const firstAt = getRunnerHealthSnapshot()?.at;
		await new Promise((r) => setTimeout(r, 80));
		await __awaitInFlightTickForTesting();
		assert.equal(getRunnerHealthSnapshot()?.at, firstAt, 'one tick, as before');
	} finally {
		__stopRunnerHealthMonitorForTesting();
		__setRemeasureDelayForTesting(null);
		__setHostForTesting(testHost);
	}
});

test('start: no token at boot (vault sealed) — waits, then starts on its own once the token arrives (#133)', async () => {
	// 2026-10-22 02:32: start() read no token, logged "monitor disabled" and
	// returned for the life of the process — 17 minutes with no tick until the
	// next restart happened to boot unsealed.
	installFetch({ runners: FLEET_ALL_UP });
	__setSupervisionCheckerForTesting(() => Promise.resolve(null));
	let token: string | undefined;
	__setHostForTesting({ ...testHost, githubToken: () => token });
	__setTokenRetryForTesting(10);
	try {
		startRunnerHealthMonitor();
		await new Promise((r) => setTimeout(r, 40));
		assert.equal(getRunnerHealthSnapshot(), null, 'no tick may run without a token');
		token = 'tok';
		await new Promise((r) => setTimeout(r, 40));
		await __awaitInFlightTickForTesting();
		assert.equal(
			getRunnerHealthSnapshot()?.runnersChecked,
			true,
			'the monitor started by itself once the token appeared — no restart needed'
		);
	} finally {
		__stopRunnerHealthMonitorForTesting();
		__setTokenRetryForTesting(null);
		__setHostForTesting(testHost);
	}
});

/** `WolffM/sweep-0` … `WolffM/sweep-{n-1}`: a fleet with nothing to say. */
const sweepRepos = (n: number) => Array.from({ length: n }, (_, i) => `WolffM/sweep-${i}`);

/** The tick's report as the job sink received it — `repos_scanned` lives there. */
const lastReport = () =>
	(jobSinkPosts.at(-1)?.data ?? {}) as { repos_scanned?: number; runs_checked?: boolean };

test('sweep: repos are listed concurrently, and no more than SWEEP_CONCURRENCY at once', async () => {
	const repos = sweepRepos(2 * SWEEP_CONCURRENCY);
	__setFleetReposForTesting(repos);
	let inFlight = 0;
	let peak = 0;
	installFetch({
		runners: FLEET_ALL_UP,
		runsGate: async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
		},
	});
	await tick('tok');
	assert.equal(
		peak,
		SWEEP_CONCURRENCY,
		`listings in flight at the peak (cap ${SWEEP_CONCURRENCY})`
	);
	assert.ok(SWEEP_CONCURRENCY > 1, 'a cap of one would be the sequential sweep this replaced');
	assert.equal(lastReport().repos_scanned, repos.length, 'and every repo was still read');
});

test('sweep: one slow repo does not hold up the others', async () => {
	const slow = 'WolffM/slow';
	const others = sweepRepos(SWEEP_CONCURRENCY + 2);
	// The slow repo goes FIRST, where a sequential sweep would block on it before
	// asking anyone else. More `others` than free slots, so the sweep also has
	// to drain past the held one rather than merely fill the cap around it.
	__setFleetReposForTesting([slow, ...others]);
	const requested = new Set<string>();
	let releaseSlow: () => void = () => undefined;
	const slowGate = new Promise<void>((r) => (releaseSlow = r));
	installFetch({
		runners: FLEET_ALL_UP,
		runsGate: (repo) => {
			requested.add(repo);
			return repo === slow ? slowGate : Promise.resolve();
		},
	});

	const done = tick('tok');
	const deadline = Date.now() + 2000;
	while (!others.every((r) => requested.has(r)) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 1));
	}
	assert.deepEqual(
		others.filter((r) => !requested.has(r)),
		[],
		'every other repo must have been listed while the slow one was still pending'
	);
	releaseSlow();
	await done;
	assert.equal(lastReport().repos_scanned, others.length + 1, 'the slow repo was read too');
});

test('sweep: the per-tick jobs budget is one allowance across the fan-out, not one per repo', async () => {
	const repos = sweepRepos(2 * SWEEP_CONCURRENCY);
	__setFleetReposForTesting(repos);
	const perRepo = 5; // 60 unseen completed runs in total — five times the budget
	installFetch({
		runners: FLEET_ALL_UP,
		runs: (repo) => ({
			workflow_runs: Array.from({ length: perRepo }, (_, i) => ({
				id: repos.indexOf(repo) * 100 + i,
				display_title: 'CI',
				created_at: minutesAgo(3),
				updated_at: minutesAgo(2),
				status: 'completed',
				conclusion: 'success',
				html_url: `https://gh/${repo}/run/${i}`,
			})),
		}),
	});
	await tick('tok');
	assert.equal(
		jobListings.length,
		MAX_FETCH_PER_TICK,
		'six repos in flight each seeing the full budget would spend it six times over'
	);
});

// --- #118: one runner listing per repo per window ------------------------

/**
 * runner-health re-listed `/actions/runners` per repo for its backstop sweep
 * when the JIT reap and the warm cache had just listed the same repos — ~800
 * calls in the 2026-10-16 18:30-19:15Z window that ended in the blackout.
 */
test('#118: a tick re-reads NO listing another loop fetched inside the window', async () => {
	const children = sweepRepos(4);
	__setFleetReposForTesting(['WolffM/hadoku_site', ...children]);
	installFetch({ runners: FLEET_ALL_UP });
	// Another loop — the reap — listed every child repo a moment ago.
	for (const repo of children) await ghGet('/actions/runners?per_page=100', 'tok', repo);
	runnerListings.length = 0;
	await tick('tok');
	assert.deepEqual(
		runnerListings.filter((r) => children.includes(r)),
		[],
		'the backstop sweep used the listings the reap already paid for'
	);
	assert.ok(
		runnerListings.includes('WolffM/hadoku_site'),
		'the label-floor census still reads FRESH — it pages'
	);
});

test('#118 control: without another loop, the same tick lists each child repo exactly once', async () => {
	// Proves the test above measured a real sweep, not a tick that never looked.
	const children = sweepRepos(4);
	__setFleetReposForTesting(['WolffM/hadoku_site', ...children]);
	installFetch({ runners: FLEET_ALL_UP });
	await tick('tok');
	for (const repo of children)
		assert.equal(runnerListings.filter((r) => r === repo).length, 1, `${repo} listed once`);
});

// ---------------------------------------------------------------------------
// logTokenCapabilities: moved onto github-client.ts's `ghFetchRaw` (plan
// §4.1 F2b) — a pure move, but this one-shot startup probe had NO direct
// test before this wave (every existing coverage of this file ticks the
// whole monitor, which never asserts on this log line). It reads the raw
// response HEADERS (`x-oauth-scopes`), which is exactly why it cannot go
// through `ghGet` (a parsed body, never headers).
// ---------------------------------------------------------------------------

test('logTokenCapabilities: a classic repo-scoped token logs write-ready YES', async () => {
	const infos: string[] = [];
	__setHostForTesting({
		...testHost,
		logger: { info: (m: string) => infos.push(m), warn() {}, error() {} },
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response('{}', {
			status: 200,
			headers: { 'x-oauth-scopes': 'repo, workflow' },
		})) as typeof fetch;
	try {
		await __logTokenCapabilitiesForTesting('tok');
		assert.ok(infos.some((m) => m.includes("scopes='repo, workflow'")));
		assert.ok(infos.some((m) => m.includes('failover-write=YES')));
	} finally {
		globalThis.fetch = originalFetch;
		__setHostForTesting(testHost);
	}
});

test('logTokenCapabilities: a fine-grained PAT (no scopes header) logs UNKNOWN, never a throw', async () => {
	const infos: string[] = [];
	__setHostForTesting({
		...testHost,
		logger: { info: (m: string) => infos.push(m), warn() {}, error() {} },
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
	try {
		await __logTokenCapabilitiesForTesting('tok');
		assert.ok(infos.some((m) => m.includes('failover-write=UNKNOWN')));
	} finally {
		globalThis.fetch = originalFetch;
		__setHostForTesting(testHost);
	}
});

test('logTokenCapabilities: a network failure logs a warning and never throws', async () => {
	const warns: string[] = [];
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn: (m: string) => warns.push(m), error() {} },
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw new Error('ECONNRESET');
	}) as typeof fetch;
	try {
		await __logTokenCapabilitiesForTesting('tok');
		assert.ok(warns.some((m) => m.includes('ECONNRESET')));
	} finally {
		globalThis.fetch = originalFetch;
		__setHostForTesting(testHost);
	}
});
