/**
 * Tests for the runner-health monitor's tick(). Drives the real tick against a
 * stubbed globalThis.fetch (both the GitHub Actions API and the Discord sink go
 * through fetch), so the alert decisions are verified end-to-end without a token
 * or a live webhook.
 *
 * Conditions under test:
 *   - label-floor breach (a required label has 0 ONLINE runners) → 🚨
 *   - all-healthy → silent
 *   - run queued past threshold → ⏱
 *   - run in-progress past threshold → 🚨 (hung)
 *   - fail-soft: runners API !ok → NO alert (never false-page off a dead API)
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, cleanupTempDirs } from './tmpdir.js';
import {
	__setHistoryPathForTesting,
	__resetJobHistoryForTesting,
	historyFile,
	MAX_FETCH_PER_TICK,
} from '../job-history.js';
import { __resetFallbackConvergenceForTesting } from '../ci-runner-fallback.js';
import { __setHostForTesting } from '../host.js';
import { testHost, testStateDir } from './install-test-host.js';

import {
	__setBackstopMachinesForTesting,
	__setHostLoadReaderForTesting,
	tick,
	startRunnerHealthMonitor,
	MAX_RERUNS_PER_TICK,
	TICK_INTERVAL_MS,
	SNAPSHOT_RESTORE_MAX_AGE_MS,
	SWEEP_CONCURRENCY,
	STARVED_NO_JOB_MS,
	__awaitInFlightTickForTesting,
	__stopRunnerHealthMonitorForTesting,
	__setRemeasureDelayForTesting,
	__setPostBlackoutSlackForTesting,
	__setTokenRetryForTesting,
	__resetRunnerHealthAlertsForTesting,
	__reloadAlertLedgerForTesting,
	__setFleetReposForTesting,
	__setSnapshotPathForTesting,
	__setSupervisionCheckerForTesting,
	getRunnerHealthSnapshot,
	__setReservationForTesting,
	__setQuietRecorderForTesting,
	__setFloorConfirmDelayForTesting,
	__setFloorDemandForTesting,
	QUEUE_ZOMBIE_SECONDS,
	refusedAtAdmission,
	classifyGhReadFailure,
	unreadableTickError,
	__resetGhBlackoutForTesting,
	ghGet,
	__logTokenCapabilitiesForTesting,
	RE_ALERT_MS,
} from '../runner-health.js';
import { __setFleetProbeForTesting } from '../fleet-loop.js';
import { __resetSickForTesting, markNodeSick } from '../lib/sick-node.js';
import { writeDrain } from '../runners/drain.js';
import { writeForce } from '../runners/backstop-force.js';
import {
	__resetCapacityLedgerForTesting,
	recordCapacityLedger,
} from '../runners/capacity-ledger.js';
import { backstopHold } from '../runners/backstop-hold.js';
import {
	__resetAdmissionVerdictsForTesting,
	__setAdmissionVerdictsForTesting,
	__setWorkloadGateContextForTesting,
	type AdmissionVerdict,
} from '../runners/ephemeral-tick.js';
import { workloadGateContext } from '../capabilities.js';
import {
	__resetDiskReadingsForTesting,
	__setDiskReadingsForTesting,
} from '../runners/disk-watch.js';
import {
	__resetNodeRegressionForTesting,
	__setGatedKindsForTesting,
	__setMarkStaleForTesting,
	__setReadProofForTesting,
	type GatedKind,
} from '../runners/node-regression.js';
import type { ProofRecord } from '../lib/measured.js';

const FAKE_WEBHOOK = 'https://discord.test/webhook';

// Fresh array per call: the monitor mutates runner.labels in place.
//
// `self-hosted` is here because GitHub STAMPS it on every registration — no
// runner anywhere lacks it. Leaving it out is what let the queued-coverage
// check ship broken: `vars.CI_RUNNER` is `["self-hosted","hadoku-builder"]`, so
// every real fleet job asks for a label these fixtures said nothing carried,
// and the busy-pool branch was unreachable in production while its test passed
// against a bare `['hadoku-builder']` that `runs-on` never produces.
const clawLabels = () => [{ name: 'self-hosted' }, { name: 'hadoku-builder' }];
// hokon mid-backstop: pm2-host PLUS the builder label, which is what a successful
// promotion leaves behind. Also the "covers every required label" stub in tests
// that only care about queued/hung alerting.
// Every capability hokon DECLARES in fleet-runner-manifest.json, which is what
// makes this a truthful "covers every required label" stub. taskauto and
// av1-nvenc joined REQUIRED_LABELS on 2026-08-27 — they are real routing
// dependencies (2 jobs and 1 job request them) and their absence from the floor
// is why taskauto could queue 6h45m unalerted on 2026-08-26.
// hokon at REST: every capability it declares, and no builder label. That is
// what the manifest says the node offers, and what the label floor watches.
const hokonLabels = () => [
	{ name: 'self-hosted' },
	{ name: 'pm2-host' },
	{ name: 'taskauto' },
	{ name: 'av1-nvenc' },
];

const hokonPromotedLabels = () => [
	...hokonLabels(),
	...clawLabels().filter((l) => l.name !== 'self-hosted'),
];

let originalFetch: typeof globalThis.fetch;
let discordPosts: string[];
let rerunPosts: string[];
let jobSinkPosts: Record<string, unknown>[];
let labelOps: string[];
let labelPostBodies: string[][];
let queuedListings: string[];
/** Every GET /actions/runs/{id}/jobs — the calls the per-tick budget bounds. */
let jobListings: string[];
/** The repo of every GET /actions/runners — one per repo the converge pass read. */
let runnerListings: string[];
/** The full URL of every GET /actions/runners — the page SIZE is part of the read. */
let runnerListingUrls: string[];
/** Where this test's tick persists its snapshot. Fresh per test. */
let snapshotPath: string;
/** Every fetch the harness did not recognise. Must be empty at the end of a test. */
let unmatchedCalls: string[];
/**
 * A truthful GitHub Actions *variables* store, per repo — the surface the
 * hosted-runner fallback writes when it moves the fleet onto billed minutes.
 *
 * Modelled with real status codes rather than a blanket 200, because
 * ci-runner-fallback branches on them: it PATCHes first and POSTs only on 404,
 * and treats a DELETE 404 as "there was nothing to remove" (success, but NOT a
 * change). Under the old catch-all every PATCH and DELETE returned 200, so the
 * POST-create path and the nothing-to-remove path never executed in any test
 * while reading as covered.
 */
let repoVars: Map<string, Map<string, string>>;
/** `${method} ${repo} ${name}=${value}` for every variables write. */
let variableOps: string[];
let prevWebhook: string | undefined;
let prevCronKey: string | undefined;

function okJson(obj: unknown) {
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		json: async () => obj,
		text: async () => JSON.stringify(obj),
	} as unknown as Response;
}
function notOk(status: number) {
	return {
		ok: false,
		status,
		headers: new Headers(),
		json: async () => ({}),
		text: async () => '',
	} as unknown as Response;
}

/** Ledger-only alert records — the ⚠️/⏱ conditions that no longer ring the channel. */
const quietRecords: string[] = [];

/**
 * The per-node OFFLINE alerts (⚠️). These are LEDGER records now, not Discord
 * posts: the message says "CI has capacity ... and nothing is queuing", so there
 * is nothing to do at the moment it fires. Asserted through the recorder rather
 * than as an absence from `discordPosts`, so these tests still fail if the
 * condition stops being detected at all.
 */
const offlineAlerts = () => quietRecords.filter((m) => m.includes('⚠️'));

function minutesAgo(min: number): string {
	return new Date(Date.now() - min * 60_000).toISOString();
}

/**
 * RELATIVE, like every other clock in this suite.
 *
 * The zombie cases below are about runs that have been queued since 2026-08-17
 * and 2026-08-19, and writing those dates in as literals is how a fixture goes
 * red on a calendar rather than a commit — twice already in this repo, against
 * the 14-day job-history window. What matters is the age, not the date.
 */
function daysAgo(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Install a fetch stub. runners/runs bodies are provided per test. */
/**
 * A body, or a function of the repo the URL names. Three tests need per-repo
 * answers — the 2026-08-17 regression was that every runs call was hardcoded to
 * hadoku_site, and proving it is fixed requires hadoku_site to be QUIET while a
 * child repo holds the drop. They used to hand-roll a whole second fetch stub to
 * get that, which duplicated every handler and re-introduced the permissive
 * catch-all this harness exists to refuse.
 */
type Body = Record<string, unknown> | ((repo: string) => Record<string, unknown>);

/** `WolffM/x` out of any api.github.com/repos/WolffM/x/... URL. */
function repoOf(url: string): string {
	return /repos\/([^/]+\/[^/]+)/.exec(url)?.[1] ?? '';
}

function resolveBody(b: Body | undefined, url: string): Record<string, unknown> | undefined {
	return typeof b === 'function' ? b(repoOf(url)) : b;
}

function installFetch(opts: {
	runners?: Body;
	runnersStatus?: number; // if set and != 200, return notOk
	runs?: Body;
	runsStatus?: number; // if set and != 200, return notOk
	// Body for the saturation gate's `?status=queued` listing. Separate from
	// `runs` because the two answer different questions of the same endpoint:
	// `runs` is the sweep's recent-activity window, this is "what cannot start".
	queuedRuns?: Body;
	jobs?: Body; // body for GET /actions/runs/{id}/jobs
	jobsStatus?: number; // if set and != 200, the jobs listing returns notOk
	rerunStatus?: number; // if set and != 200, the rerun POST returns notOk
	annotations?: unknown; // body for GET /check-runs/{job_id}/annotations
	labelStatus?: number; // if set and != 200, label add/remove returns notOk
	labelDeleteStatus?: number; // if set and != 200, only label REMOVAL returns notOk
	variableStatus?: number; // if set and != 200, every variables call returns notOk
	/** Repos that ALREADY carry a CI_RUNNER pin when the tick starts. */
	hostedRepos?: string[];
	/**
	 * Awaited before the sweep's runs listing for `repo` is answered. Lets a
	 * test hold one repo's listing open, or count how many are open at once —
	 * the fan-out tests below are about TIMING, which a body cannot express.
	 */
	runsGate?: (repo: string) => Promise<void>;
	/** Same, for the runner listing — the converge pass reads one per repo. */
	runnersGate?: (repo: string) => Promise<void>;
}) {
	for (const repo of opts.hostedRepos ?? []) {
		repoVars.set(repo, new Map([['CI_RUNNER', '["ubuntu-latest"]']]));
	}
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const method = (init?.method ?? 'GET').toUpperCase();
		// Specific run sub-paths first — they contain '/actions/runs' as a prefix.
		if (url.includes('/rerun-failed-jobs')) {
			rerunPosts.push(url);
			if (opts.rerunStatus && opts.rerunStatus !== 200) return notOk(opts.rerunStatus);
			return okJson({});
		}
		// Runner label add/remove — contains '/actions/runners' as a prefix.
		if (url.includes('/labels')) {
			labelOps.push(`${method} ${url}`);
			if (method === 'POST') {
				const body = JSON.parse(String(init?.body ?? '{}')) as { labels?: string[] };
				labelPostBodies.push(body.labels ?? []);
			}
			if (opts.labelStatus && opts.labelStatus !== 200) return notOk(opts.labelStatus);
			if (method === 'DELETE' && opts.labelDeleteStatus && opts.labelDeleteStatus !== 200) {
				return notOk(opts.labelDeleteStatus);
			}
			return okJson({});
		}
		// Before '/jobs': a check-run annotations URL contains neither, but keep it
		// above the generic handlers so a future rename cannot shadow it silently.
		if (url.includes('/annotations')) {
			return okJson(opts.annotations ?? []);
		}
		// MUST STAY ABOVE the generic '/jobs' handler. The sink URL is
		// `${EDGE_BASE}/health/api/jobs`, which CONTAINS '/jobs' — so while this
		// sat below, every recordJobResult call was answered with `{ jobs: [] }`,
		// a body the real sink never returns, and `jobSinkPosts` was permanently
		// empty while its own comment claimed it proved a counter was reported.
		// Same shadowing hazard the '/annotations' comment above warns about.
		//
		// recordJobResult → monitoring-api jobs sink. This is the surface the
		// daily ci-digest actually reads, so asserting on it proves a counter is
		// REPORTED rather than merely incremented in a local.
		if (url.includes('/health/api/jobs')) {
			jobSinkPosts.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			return okJson({});
		}
		if (url.includes('/jobs')) {
			jobListings.push(url);
			if (opts.jobsStatus && opts.jobsStatus !== 200) return notOk(opts.jobsStatus);
			return okJson(resolveBody(opts.jobs, url) ?? { jobs: [] });
		}
		if (url.includes('/actions/runners')) {
			runnerListings.push(repoOf(url));
			runnerListingUrls.push(url);
			if (opts.runnersGate) await opts.runnersGate(repoOf(url));
			if (opts.runnersStatus && opts.runnersStatus !== 200) return notOk(opts.runnersStatus);
			// CLONED per call, because a real one is. The monitor mutates
			// `runner.labels` in place to track what it just granted, and a shared
			// object turns that bookkeeping into a cross-REPO side effect: the
			// fan-out's listing for repo 2 would arrive already carrying the label
			// the promote wrote for repo 1, and skip it as done. Production returns
			// an independent body per repo, so the harness must too.
			return okJson(structuredClone(resolveBody(opts.runners, url) ?? { runners: [] }));
		}
		if (url.includes('/actions/runs') && url.includes('status=queued')) {
			queuedListings.push(url);
			return okJson(resolveBody(opts.queuedRuns, url) ?? { workflow_runs: [] });
		}
		if (url.includes('/actions/runs')) {
			if (opts.runsGate) await opts.runsGate(repoOf(url));
			if (opts.runsStatus && opts.runsStatus !== 200) return notOk(opts.runsStatus);
			return okJson(resolveBody(opts.runs, url) ?? { workflow_runs: [] });
		}
		if (url === FAKE_WEBHOOK) {
			const body = JSON.parse(String(init?.body ?? '{}')) as { content?: string };
			discordPosts.push(body.content ?? '');
			return okJson({});
		}
		// GitHub Actions repo VARIABLES, with the real status codes.
		const varMatch = /repos\/([^/]+\/[^/]+)\/actions\/variables(?:\/([^/?]+))?/.exec(url);
		if (varMatch) {
			const repo = varMatch[1];
			const named = varMatch[2];
			const store = repoVars.get(repo) ?? new Map<string, string>();
			repoVars.set(repo, store);
			const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string; value?: string };
			if (opts.variableStatus && opts.variableStatus !== 200) return notOk(opts.variableStatus);
			if (method === 'PATCH' && named) {
				// 404 when the variable does not exist yet — this is what drives the
				// POST-create fallback in ci-runner-fallback.setVar().
				if (!store.has(named)) return notOk(404);
				store.set(named, body.value ?? '');
				variableOps.push(`PATCH ${repo} ${named}=${body.value ?? ''}`);
				return okJson({});
			}
			if (method === 'POST' && !named) {
				const name = body.name ?? '';
				// The real API 409s on creating one that exists; setVar only ever
				// reaches POST after a 404, so a 409 here means the flow is wrong.
				if (store.has(name)) return notOk(409);
				store.set(name, body.value ?? '');
				variableOps.push(`POST ${repo} ${name}=${body.value ?? ''}`);
				return okJson({});
			}
			if (method === 'DELETE' && named) {
				// 404 = nothing to remove. Success, but NOT a change.
				if (!store.has(named)) return notOk(404);
				store.delete(named);
				variableOps.push(`DELETE ${repo} ${named}`);
				return okJson({});
			}
			if (method === 'GET') {
				if (named) {
					const v = store.get(named);
					return v === undefined ? notOk(404) : okJson({ name: named, value: v });
				}
				return okJson({
					variables: [...store].map(([name, value]) => ({ name, value })),
				});
			}
			return notOk(422);
		}
		// The telemetry sink. Accepted, not asserted on — it is fire-and-forget and
		// no decision reads its response.
		if (url.includes('/health/api/telemetry')) {
			return okJson({});
		}
		// UNMATCHED. This used to `return okJson({})` — "any other call: succeed
		// quietly" — which made the harness strictly more permissive than the real
		// API and is the exact shape that let four JIT bugs ship: a call to an
		// endpoint that does not exist, or with a body GitHub would reject, came
		// back 200 OK and the test passed. A stub that accepts what production
		// refuses is not a test, it is a second implementation that always agrees.
		//
		// Now recorded and refused. `afterEach` fails any test that reaches here,
		// so a new or renamed endpoint has to be declared above before its test can
		// go green.
		unmatchedCalls.push(`${method} ${url}`);
		return notOk(404);
	}) as typeof globalThis.fetch;
}

beforeEach(() => {
	// THE SUITE MUST NOT TOUCH THE OPERATOR'S REAL JOB HISTORY.
	//
	// checkRunsAndFailover calls ingestRuns, which loads ~/.hadoku-mgmt/
	// job-history.jsonl and then calls compactHistory() — and compactHistory
	// REWRITES that file unconditionally as soon as any record falls outside the
	// 14-day retention window. On 2026-08-30 the live file was 944 KB / 3,939
	// records with its oldest entry at 2026-08-16, i.e. hours from that trigger.
	// The suite would have silently rewritten a fortnight of fleet history.
	//
	// It also polluted `seenRuns` with real run ids, a second way for host state
	// to change what these tests measure.
	//
	// job-history.ts:89 already says "Overridable so tests never touch the real
	// host file" and exports the seam for it. This suite never used it.
	__setHistoryPathForTesting(join(tempDir('rh-history-'), 'job-history.jsonl'));
	__resetJobHistoryForTesting();
	// Same rule for the persisted snapshot: a fresh file per test, so one test's
	// tick can never be served as another test's "restored" census.
	snapshotPath = join(tempDir('rh-snapshot-'), 'runner-health-snapshot.json');
	__setSnapshotPathForTesting(snapshotPath);
	// converged is module state in ci-runner-fallback that nothing reset, so
	// the hosted-fallback path behaved differently in the FIRST test of this file
	// than in every later one — and adding a test at the top silently changed
	// which.
	__resetFallbackConvergenceForTesting();
	// Wave 4a (#100): the generic admission verdict snapshot is module state in
	// a DIFFERENT module (`ephemeral-tick.ts`), same leak class as every other
	// reset in this block — a verdict set in one test must not survive to the
	// next.
	__resetAdmissionVerdictsForTesting();
	// Wave 4c §F: same leak class, a different module (`disk-watch.ts`) — a
	// reading set in one test must not survive to the next.
	__resetDiskReadingsForTesting();
	// Wave 4e §B: same leak class again, `node-regression.ts`'s own test
	// overrides (gated kinds, injected markStale) — must not survive to the
	// next test either.
	__resetNodeRegressionForTesting();
	originalFetch = globalThis.fetch;
	discordPosts = [];
	rerunPosts = [];
	jobSinkPosts = [];
	labelOps = [];
	labelPostBodies = [];
	queuedListings = [];
	jobListings = [];
	runnerListings = [];
	runnerListingUrls = [];
	unmatchedCalls = [];
	repoVars = new Map();
	variableOps = [];
	// Pin the priority ladder OPEN by default. The real reservation reads the
	// declared cron window out of profiles.json, so without this every saturation
	// test would silently invert for 90 minutes after each daily cron.
	__setReservationForTesting(() => ({ reserved: false, reason: null, detail: null }));
	// The probe is module-level state on fleet-loop. Leaving one test's fleet
	// visible to the next makes the label floor suppress or page for reasons the
	// test never set up — 14 unrelated tests failed that way before this reset.
	//
	// The default is "we LOOKED and manifests/ ephemeral nodes are down", not
	// "we never looked". These tests predate ephemeral nodes and were written for
	// a fleet where those claws contribute nothing, which is what an unreachable
	// probe says. A null probe now means UNMEASURED, and the backstop deliberately
	// holds rather than acting on it, so leaving it null would quietly make every
	// backstop assertion below inert instead of failing loudly.
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: {
			'claw-1': { reachable: false, free: 0, sick: false },
			'claw-3': { reachable: false, free: 0, sick: false },
		},
	} as never);
	prevWebhook = process.env.DISCORD_EMERGENCY_NOTIFICATIONS_WEBHOOK;
	prevCronKey = process.env.MGMT_CRON_KEY;
	process.env.DISCORD_EMERGENCY_NOTIFICATIONS_WEBHOOK = FAKE_WEBHOOK;
	process.env.MGMT_CRON_KEY = 'test-cron-key'; // so recordJobResult doesn't self-alert
	__resetRunnerHealthAlertsForTesting();
	quietRecords.length = 0;
	__setQuietRecorderForTesting((content) => quietRecords.push(content));
	// Default every test to the single repo they were written against; the
	// fleet-wide sweep is exercised explicitly below.
	__setFleetReposForTesting(['WolffM/hadoku_site']);
	// The floor's confirming read waits FLOOR_CONFIRM_DELAY_MS in production so
	// the listener has re-polled in between. Here it would add five seconds to
	// every breach test and prove nothing: what is under test is that a SECOND
	// READ happens and is believed, not how long it waited.
	__setFloorConfirmDelayForTesting(0);
	// The label floor watches DEMAND (job history + the persisted static half).
	// These tests were written against the four labels the old hand list held,
	// and hokon's fixture carries exactly those; pin that demand so a test about
	// something else is not also a test about which jobs this process recorded.
	__setFloorDemandForTesting(['hadoku-builder', 'pm2-host', 'taskauto', 'av1-nvenc']);
});

afterEach(() => {
	// The assertion below is the point of this hook, and it THROWS. Everything
	// that puts the process back how it was found therefore has to sit in a
	// `finally`, or the first suite to reach the catch-all takes the rest of the
	// file down with it: before this was restructured, a failing `unmatchedCalls`
	// skipped the `globalThis.fetch` restore and both env vars, so every later
	// test in the file ran against the dead stub and reported its own unrelated
	// failure. Cleanup that only runs on the happy path is not cleanup.
	try {
		// Before anything else: a call the harness did not model is a call whose
		// success this suite never actually verified.
		assert.deepEqual(
			unmatchedCalls,
			[],
			'fetch reached the harness catch-all — declare the endpoint in installFetch ' +
				'rather than letting an unmodelled call report 200'
		);
	} finally {
		__resetSickForTesting();
		writeDrain({});
		__setHistoryPathForTesting(null);
		__setSnapshotPathForTesting(null);
		__setFleetReposForTesting(null);
		__setSupervisionCheckerForTesting(null);
		__setFloorDemandForTesting(null);
		__setWorkloadGateContextForTesting(null);
		globalThis.fetch = originalFetch;
		if (prevWebhook === undefined) delete process.env.DISCORD_EMERGENCY_NOTIFICATIONS_WEBHOOK;
		else process.env.DISCORD_EMERGENCY_NOTIFICATIONS_WEBHOOK = prevWebhook;
		if (prevCronKey === undefined) delete process.env.MGMT_CRON_KEY;
		else process.env.MGMT_CRON_KEY = prevCronKey;
		// Last: `writeDrain` above still needs the state dir, and the seams still
		// need their paths. This suite churns two directories per test across
		// ~200 tests, so it clears them per test rather than leaning on the exit
		// handler in tmpdir.ts.
		cleanupTempDirs();
	}
});

test('runner-health: pm2-host with 0 online runners pages; hadoku-builder (1 online) does not', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
	});
	// Two ticks: the floor debounces so a transient disconnect cannot page.
	await tick('tok');
	await tick('tok');
	// One alert PER breached capability. This fixture is claws only, so every
	// label hokon offers is at zero — pm2-host, taskauto and av1-nvenc alike.
	// Asserting a total of 1 would pin the size of REQUIRED_LABELS rather than
	// the behaviour, and adding a genuine routing dependency would then "fail"
	// a test about something else.
	const floor = discordPosts.filter((p) => /will queue/.test(p));
	assert.equal(floor.length, 3, 'pm2-host, taskauto and av1-nvenc are all at zero here');
	assert.ok(
		floor.some((p) => /pm2-host/.test(p)),
		'the pm2-host breach must be among them'
	);
	assert.ok(
		!discordPosts.some((p) => /hadoku-builder/.test(p)),
		'hadoku-builder has one online runner and must NOT page'
	);
});

// RETIRED 2026-09-08 (decision C0b, `claw-floor-design-2026-09-07.md` §10).
// Under all-JIT the standing hadoku-builder count is zero BY DESIGN and stays
// zero forever, so this alert used to fire every 20 minutes while the
// dispatcher minted 9 of 9 queued jobs — the real 2026-09-02 outage was
// indistinguishable from the routine noise. It used to be exempted by a
// mint-aware branch (suppress unless NO ephemeral node could mint one
// either); that branch is gone along with the alert, so the regression this
// pins is stronger than "suppressed while a claw can mint" — it is NEVER
// alerted, in either direction, because `check-queue-health` owns this page
// now. `label floor: a mintable fleet does not excuse pm2-host` right below
// is the control: an IDENTITY label (no mint can substitute for it) still
// pages exactly as before.
test('label floor: hadoku-builder never pages, even when nothing can mint either', async () => {
	// hokon OFFLINE and both claws unreachable/sick: the worst case the retired
	// alert used to catch. If retiring it regressed into "the floor silently
	// covers for a genuinely dead fleet", this is where it would show.
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: {
			'claw-1': { reachable: false, free: 0, sick: false },
			'claw-3': { reachable: true, free: 0, sick: true },
		},
	} as never);
	installFetch({
		runners: {
			runners: [{ name: 'hokon', status: 'offline', busy: false, labels: hokonLabels() }],
		},
	});
	await tick('tok');
	await tick('tok');
	assert.ok(
		!discordPosts.some((p) => /hadoku-builder/.test(p)),
		'hadoku-builder must never page — check-queue-health owns this now'
	);
	// Still MEASURED, just never alerted on — the snapshot/panel keep the count.
	assert.equal(getRunnerHealthSnapshot()?.labelOnline?.['hadoku-builder'], 0);
});

test('label floor: a mintable fleet does not excuse pm2-host, which no mint can carry', async () => {
	// Minting serves only what a minting node OFFERS, and no claw offers
	// pm2-host — it is a fact about the production host. A reachable claw must
	// not be read as covering it.
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: { 'claw-1': { reachable: true, free: 4, sick: false } },
	} as never);
	installFetch({
		runners: { runners: [{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }] },
	});
	await tick('tok');
	await tick('tok');
	assert.ok(
		discordPosts.some((p) => /pm2-host/.test(p) && /will queue/.test(p)),
		'pm2-host still pages'
	);
});

// ---------------------------------------------------------------------------
// ONE FLOOR MODEL FOR EVERY LABEL (2026-10-10). A label is served by a
// standing online runner OR by an eligible minting node that offers it —
// `jdk21` and `cargo-bevy` "function the same as other runners". Driven
// against the fixture manifest: claw-3/4/5/8/9 are ephemeral and EARNED jdk21,
// hokon is the standing guest whose listing below does NOT carry it.
// ---------------------------------------------------------------------------

/** Every ephemeral fixture claw whose bootcamp record earned jdk21. */
const JDK21_CLAWS = ['claw-3', 'claw-4', 'claw-5', 'claw-8', 'claw-9'];
const FIXTURE_NODES = [
	'claw-1',
	'claw-2',
	'claw-3',
	'claw-4',
	'claw-5',
	'claw-6',
	'claw-8',
	'claw-9',
	'hokon',
];

const jdkProof = (node: string, over: Partial<ProofRecord> = {}): ProofRecord => ({
	node,
	capability: 'jdk21',
	runId: 1,
	runner: `jit-${node}-proof-hadoku-cardtable-j0-r0-1`,
	conclusion: 'success',
	durationSec: 300,
	evidenceMatched: true,
	budgetSec: null,
	verdict: 'pass',
	why: 'pass',
	at: new Date().toISOString(),
	...over,
});

/** The probe the fast loop would publish with exactly `up` reachable. */
function probeWith(up: string[]): void {
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: Object.fromEntries(
			FIXTURE_NODES.map((n) => [
				n,
				{ reachable: up.includes(n), free: up.includes(n) ? 2 : 0, sick: false },
			])
		),
	} as never);
}

/** hokon online, carrying everything it declares — and NOT jdk21. */
const hokonOnlyListing = () => ({
	runners: [{ name: 'hokon', status: 'online', busy: false, labels: hokonLabels() }],
});

const jdkPages = () => discordPosts.filter((p) => /`jdk21`/.test(p) && /will queue/.test(p));

test('label floor: a label served ONLY by minting nodes does not page', async () => {
	__setFloorDemandForTesting(['jdk21']);
	__setWorkloadGateContextForTesting(workloadGateContext(FIXTURE_NODES, {}));
	probeWith(['claw-4']);
	installFetch({ runners: hokonOnlyListing() });
	await tick('tok');
	await tick('tok');
	await tick('tok');
	assert.deepEqual(jdkPages(), [], 'no standing runner carries jdk21, and claw-4 can mint it');
	assert.equal(getRunnerHealthSnapshot()?.labelOnline?.['jdk21'], 0, 'the standing half is zero');
	assert.equal(getRunnerHealthSnapshot()?.labelFloor?.['jdk21'], 'minting');
});

test('label floor: every minting offerer DRAINED and no standing runner pages', async () => {
	__setFloorDemandForTesting(['jdk21']);
	__setWorkloadGateContextForTesting(workloadGateContext(FIXTURE_NODES, {}));
	probeWith(JDK21_CLAWS);
	writeDrain(
		Object.fromEntries(
			JDK21_CLAWS.map((n) => [n, { since: 's', reason: 'operator', by: 'hadoku' }])
		)
	);
	installFetch({ runners: hokonOnlyListing() });
	await tick('tok');
	assert.deepEqual(jdkPages(), [], 'one tick is debounced like every other floor zero');
	await tick('tok');
	const pages = jdkPages();
	assert.equal(pages.length, 1, 'reachable but drained is not mintable');
	assert.match(pages[0], /drained/, 'the page names WHY nothing can mint it');
	assert.equal(getRunnerHealthSnapshot()?.labelFloor?.['jdk21'], 'unserved');
});

test('label floor: an UNMEASURED probe holds — never pages, never counts as served', async () => {
	__setFloorDemandForTesting(['jdk21']);
	__setWorkloadGateContextForTesting(workloadGateContext(FIXTURE_NODES, {}));
	installFetch({ runners: hokonOnlyListing() });
	const drainAll = () =>
		writeDrain(
			Object.fromEntries(
				JDK21_CLAWS.filter((n) => n !== 'claw-4').map((n) => [
					n,
					{ since: 's', reason: 'operator', by: 'hadoku' },
				])
			)
		);

	// 1. Measured, and the only undrained offerer (claw-4) is unreachable: a
	//    real zero. Streak 1.
	drainAll();
	probeWith([]);
	await tick('tok');
	// 2. mgmt-api restarted: the fast loop has not probed yet. claw-4 is not
	//    drained, so minting MIGHT serve it — nobody has looked.
	__setFleetProbeForTesting(null);
	await tick('tok');
	await tick('tok');
	assert.deepEqual(jdkPages(), [], 'unmeasured must not advance the streak into a page');
	assert.equal(getRunnerHealthSnapshot()?.labelFloor?.['jdk21'], 'unmeasured');
	// 3. Measured again, still nothing can serve it. The streak HELD through the
	//    unmeasured ticks rather than resetting, so this second real zero pages.
	probeWith([]);
	await tick('tok');
	assert.equal(jdkPages().length, 1, 'unmeasured must not have cleared the streak either');
});

test('label floor: a claw whose jdk21 workload proof is STALE is not counted as an offerer', async () => {
	__setFloorDemandForTesting(['jdk21']);
	// The gate is ACTIVE (two fresh passes elsewhere) and claw-4 — the only
	// reachable claw — holds a STALE mark: the dispatcher would not mint jdk21
	// there, so the floor must not count it.
	__setWorkloadGateContextForTesting(
		workloadGateContext(FIXTURE_NODES, {
			jdk21: [
				jdkProof('claw-8'),
				jdkProof('claw-9'),
				jdkProof('claw-4', { verdict: 'stale', why: 'marked stale by node-regression' }),
			],
		})
	);
	probeWith(['claw-4']);
	installFetch({ runners: hokonOnlyListing() });
	await tick('tok');
	await tick('tok');
	assert.equal(jdkPages().length, 1, 'a stale proof withdraws the offer, so nothing serves jdk21');
	assert.match(jdkPages()[0], /unreachable or sick/, 'claw-8/claw-9 still offer it but are down');
});

test('label floor: the same claw with a FRESH passing proof serves jdk21 (control)', async () => {
	__setFloorDemandForTesting(['jdk21']);
	__setWorkloadGateContextForTesting(
		workloadGateContext(FIXTURE_NODES, {
			jdk21: [jdkProof('claw-8'), jdkProof('claw-9'), jdkProof('claw-4')],
		})
	);
	probeWith(['claw-4']);
	installFetch({ runners: hokonOnlyListing() });
	await tick('tok');
	await tick('tok');
	assert.deepEqual(jdkPages(), []);
	assert.equal(getRunnerHealthSnapshot()?.labelFloor?.['jdk21'], 'minting');
});

test('label floor: a label that LEAVES the demand takes its armed alert with it', async () => {
	__setFloorDemandForTesting(['jdk21']);
	__setWorkloadGateContextForTesting(workloadGateContext(FIXTURE_NODES, {}));
	probeWith([]);
	installFetch({ runners: hokonOnlyListing() });
	await tick('tok');
	await tick('tok');
	assert.equal(jdkPages().length, 1, 'precondition: jdk21 is paging');
	assert.equal(getRunnerHealthSnapshot()?.floorBreach, true);
	__setFloorDemandForTesting(['pm2-host']);
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.labelFloor?.['jdk21'], undefined, 'no longer watched');
	assert.equal(getRunnerHealthSnapshot()?.floorBreach, false);
});

test('label floor: a label that comes BACK into demand starts a fresh streak and pages again', async () => {
	// Leaving the demand must clear the streak AND re-arm the alert. Kept, the
	// streak would carry over and the hour-long re-alert window would swallow
	// the page when the label returns still unserved.
	__setFloorDemandForTesting(['jdk21']);
	__setWorkloadGateContextForTesting(workloadGateContext(FIXTURE_NODES, {}));
	probeWith([]);
	installFetch({ runners: hokonOnlyListing() });
	await tick('tok');
	await tick('tok');
	assert.equal(jdkPages().length, 1, 'precondition: jdk21 paged');
	__setFloorDemandForTesting(['pm2-host']);
	await tick('tok');
	__setFloorDemandForTesting(['jdk21']);
	await tick('tok');
	assert.equal(jdkPages().length, 1, 'one tick back is debounced afresh');
	await tick('tok');
	assert.equal(jdkPages().length, 2, 'and the second pages, because the alert was re-armed');
});

test('label floor: the watched set is job history UNIONED with the persisted static demand', async () => {
	// No override: the real read. taskauto comes only from a job record,
	// cargo-bevy only from the file `fleet label-floor` writes — the label no
	// job in the window asked for, which observed demand alone would miss.
	__setFloorDemandForTesting(null);
	appendFileSync(
		historyFile(),
		JSON.stringify({
			repo: 'WolffM/hadoku-tenhands',
			runId: 1,
			jobId: 1,
			name: 'sweep',
			runner: 'hokon',
			labels: ['self-hosted', 'taskauto'],
			startedAt: minutesAgo(5),
			durationSec: 10,
		}) + '\n'
	);
	const demandFile = join(testStateDir, 'label-floor-demand.json');
	writeFileSync(demandFile, JSON.stringify({ at: minutesAgo(60), labels: ['cargo-bevy'] }));
	try {
		installFetch({ runners: hokonOnlyListing() });
		await tick('tok');
		const watched = Object.keys(getRunnerHealthSnapshot()?.labelFloor ?? {}).sort();
		assert.deepEqual(watched, ['cargo-bevy', 'taskauto']);
	} finally {
		rmSync(demandFile, { force: true });
	}
});

test('label floor: an EMPTY demand pages on its own key rather than watching nothing', async () => {
	__setFloorDemandForTesting([]);
	installFetch({ runners: hokonOnlyListing() });
	await tick('tok');
	assert.ok(
		discordPosts.some((p) => /NOTHING to watch/.test(p)),
		'a floor over an empty set passes every outage'
	);
});

test('runner-health: a ONE-tick label-floor blip does not page', async () => {
	// The 2026-08-20 false alarm: all four hokon runners dropped their broker
	// long-poll for ~10s, so one tick saw zero pm2-host runners while nothing
	// was actually wrong. A single observation must never page.
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
	});
	await tick('tok');
	assert.equal(discordPosts.length, 0, 'a single zero-tick must stay silent');
});

/**
 * THE LIVE hadoku_site RUNNER LISTING, `gh api repos/WolffM/hadoku_site/actions/runners`
 * on 2026-09-14 — ids, names, statuses and labels exactly as GitHub returned
 * them, including the `X64`/`Linux` labels GitHub stamps and the `jit-canary`
 * one the dispatcher writes. It is the listing issue #24 quotes.
 *
 * Fresh objects per call: the monitor mutates `runner.labels` in place.
 */
const LIVE_LISTING = () => ({
	total_count: 7,
	runners: [
		{
			id: 2491,
			name: 'claw-8',
			status: 'offline',
			busy: false,
			labels: [{ name: 'self-hosted' }, { name: 'X64' }, { name: 'Linux' }],
		},
		{
			id: 69,
			name: 'hokon',
			status: 'online',
			busy: false,
			labels: [
				{ name: 'self-hosted' },
				{ name: 'X64' },
				{ name: 'Linux' },
				{ name: 'pm2-host' },
				{ name: 'taskauto' },
				{ name: 'av1-nvenc' },
			],
		},
		{
			id: 2998,
			name: 'warm-claw-5-hadoku_site',
			status: 'online',
			busy: false,
			labels: [
				{ name: 'self-hosted' },
				{ name: 'X64' },
				{ name: 'Linux' },
				{ name: 'hadoku-builder' },
			],
		},
		{
			id: 3057,
			name: 'warm-claw-3-hadoku_site',
			status: 'online',
			busy: false,
			labels: [
				{ name: 'self-hosted' },
				{ name: 'X64' },
				{ name: 'Linux' },
				{ name: 'hadoku-builder' },
			],
		},
		{
			id: 3143,
			name: 'jit-claw-3-hadoku_site-j104143747556-r34894126603-1789418307',
			status: 'online',
			busy: false,
			labels: [
				{ name: 'self-hosted' },
				{ name: 'X64' },
				{ name: 'Linux' },
				{ name: 'hadoku-builder' },
				{ name: 'jit-canary' },
			],
		},
		{
			id: 3145,
			name: 'jit-claw-5-hadoku_site-j104143747283-r34894126507-1789418307',
			status: 'online',
			busy: false,
			labels: [
				{ name: 'self-hosted' },
				{ name: 'X64' },
				{ name: 'Linux' },
				{ name: 'hadoku-builder' },
			],
		},
		{
			id: 2884,
			name: 'warm-claw-7-hadoku_site',
			status: 'online',
			busy: false,
			labels: [
				{ name: 'self-hosted' },
				{ name: 'X64' },
				{ name: 'Linux' },
				{ name: 'hadoku-builder' },
			],
		},
	],
});

/** The same listing with hokon's `status` flipped — the 2026-09-13 06:13:49Z read. */
const LIVE_LISTING_HOKON_OFFLINE = () => {
	const body = LIVE_LISTING();
	const hokon = body.runners.find((r) => r.name === 'hokon');
	if (!hokon) throw new Error('fixture lost hokon');
	hokon.status = 'offline';
	return body;
};

/** Answer the Nth runner listing of a tick from a different body. */
function listingSequence(...bodies: (() => Record<string, unknown>)[]) {
	let n = 0;
	return () => (bodies[Math.min(n++, bodies.length - 1)] as () => Record<string, unknown>)();
}

test('label floor: the live listing from #24 reports ZERO missing labels', async () => {
	// The regression fixture. hokon online carrying pm2-host, taskauto and
	// av1-nvenc is what `gh api` returns, and the floor must read it as covered
	// — no alert, and a census of 1 for each.
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	await tick('tok');
	assert.deepEqual(discordPosts, [], 'a healthy listing pages nothing');
	const census = getRunnerHealthSnapshot()?.labelOnline;
	assert.equal(census?.['pm2-host'], 1);
	assert.equal(census?.['taskauto'], 1);
	assert.equal(census?.['av1-nvenc'], 1);
});

test('label floor: the listing is read a PAGE AT A TIME big enough to be a census', async () => {
	// GitHub's default page is 30. Every other runner listing in this package
	// asks for 100; this one asked for the default, and a page-one eviction is
	// indistinguishable from a capability that went offline.
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.ok(runnerListingUrls.length > 0, 'the floor read the listing at all');
	assert.ok(
		runnerListingUrls.every((u) => u.includes('per_page=100')),
		`every runner listing asks for a full page; got ${runnerListingUrls.join(' | ')}`
	);
});

test('label floor: a status FLAP is not an outage — the confirming read wins (#24)', async () => {
	// 2026-09-12/13. GitHub's broker answered hokon's message long-poll with
	// InternalServerError for hours, and `/actions/runners` reported hokon
	// `offline` on some reads and `online` on others ten minutes apart. It was
	// running jobs throughout: a `redeploy` job completed ON hokon at
	// 06:12:50Z and the 06:13:49Z tick then read `pm2-host=0 hokon:offline`.
	//
	// Eighteen 🚨 went out over eleven hours on that reading. A zero that a
	// second read seconds later contradicts is two answers, not an outage.
	installFetch({ runners: listingSequence(LIVE_LISTING_HOKON_OFFLINE, LIVE_LISTING) });
	await tick('tok');
	installFetch({ runners: listingSequence(LIVE_LISTING_HOKON_OFFLINE, LIVE_LISTING) });
	await tick('tok');
	assert.deepEqual(
		discordPosts.filter((p) => /will queue/.test(p)),
		[],
		'a flapping status field must not page as a capability outage'
	);
});

test('label floor: a zero BOTH reads agree on still pages — retrying is not tolerating', async () => {
	// The control for the test above. hokon is gone in the first read and in the
	// confirming one, so the floor pages exactly as it always has — and the
	// message carries the EVIDENCE it was judged on, because a finding whose
	// reason is missing is a finding nobody can act on.
	installFetch({ runners: LIVE_LISTING_HOKON_OFFLINE });
	await tick('tok');
	await tick('tok');
	const floor = discordPosts.filter((p) => /will queue/.test(p));
	assert.equal(floor.length, 3, 'pm2-host, taskauto and av1-nvenc are all at zero here');
	const pm2 = floor.find((p) => /pm2-host/.test(p));
	assert.ok(pm2, 'the pm2-host breach must be among them');
	assert.match(pm2, /Two reads/, 'the alert says it looked twice');
	assert.match(pm2, /7 registration\(s\)/, 'and how many registrations it saw');
});

test('label floor: a TRUNCATED listing pages as truncated, not as an outage', async () => {
	// `total_count` above what came back means the census is PART of the fleet.
	// A label missing from part of a listing is not a label missing from the
	// fleet — but it is not a clean bill of health either, so it pages on its
	// own key and the per-label streaks are held.
	const partial = () => {
		const body = LIVE_LISTING();
		return { total_count: 41, runners: body.runners.filter((r) => r.name !== 'hokon') };
	};
	installFetch({ runners: partial });
	await tick('tok');
	await tick('tok');
	assert.deepEqual(
		discordPosts.filter((p) => /will queue/.test(p)),
		[],
		'a partial census cannot say a capability is gone'
	);
	const truncated = discordPosts.filter((p) => /PARTIAL/.test(p));
	assert.equal(truncated.length, 1, `exactly one truncation page; got ${discordPosts.join(' | ')}`);
	assert.match(truncated[0] as string, /6 of 41/, 'it names what it saw and what it missed');
});

test('runner-health: label floor recovering before the debounce re-arms it', async () => {
	// Blip, recover, blip again: the counter must RESET on recovery, or two
	// unrelated single-tick blips would add up to a page that never described a
	// real outage.
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
	});
	await tick('tok');
	installFetch({
		runners: {
			runners: [
				{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
				{ name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
			],
		},
	});
	await tick('tok');
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
	});
	await tick('tok');
	assert.equal(discordPosts.length, 0, 'two separate one-tick blips must not sum into an alert');
});

test('runner-health: both labels online + no stuck runs → silent', async () => {
	// hokon is pm2-host only (dynamic model — it carries hadoku-builder only
	// during a full claw outage); claw-1 covers hadoku-builder.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{
					id: 2,
					name: 'claw-1',
					status: 'online',
					// IDLE, deliberately. This test asserts a healthy fleet is silent, and
					// since 2026-08-23 a fully BUSY claw set is a promote trigger of its
					// own (saturation) — so `busy: true` here would have been asserting
					// the opposite of what the test name claims.
					busy: false,
					labels: clawLabels(),
				},
			],
		},
		runs: {
			workflow_runs: [
				{ display_title: 'fine', created_at: minutesAgo(2), status: 'in_progress', html_url: 'u' },
			],
		},
	});
	await tick('tok');
	assert.equal(discordPosts.length, 0, 'healthy fleet must not alert');
	assert.equal(labelOps.length, 0, 'no label churn when a claw is online');
});

test('runner-health: a run queued past threshold alerts (⏱)', async () => {
	installFetch({
		runners: {
			runners: [
				{
					name: 'hokon',
					status: 'online',
					busy: false,
					labels: hokonPromotedLabels(),
				},
			],
		},
		runs: {
			workflow_runs: [
				{
					display_title: 'Update Packages',
					created_at: minutesAgo(20),
					status: 'queued',
					html_url: 'https://gh/run/1',
				},
			],
		},
	});
	await tick('tok');
	// Count the queued alert specifically: the stub's hokon carries pm2-host
	// without the heavy label, so the backstop also posts a promote note.
	const queuedAlerts = discordPosts.filter((m) => m.includes('⏱'));
	assert.equal(queuedAlerts.length, 1);
	assert.match(queuedAlerts[0]!, /QUEUED/);
	assert.match(queuedAlerts[0]!, /Update Packages/);
});

test('runner-health: a run in-progress past threshold alerts as hung (🚨)', async () => {
	installFetch({
		runners: {
			runners: [
				{
					name: 'hokon',
					status: 'online',
					busy: true,
					labels: hokonPromotedLabels(),
				},
			],
		},
		runs: {
			workflow_runs: [
				{
					display_title: 'Redeploy PM2 Service',
					created_at: minutesAgo(45),
					status: 'in_progress',
					html_url: 'https://gh/run/2',
				},
			],
		},
	});
	await tick('tok');
	// Count the hung alert specifically: the stub's hokon carries pm2-host
	// without the heavy label, so the backstop also posts a promote note.
	const hungAlerts = discordPosts.filter((m) => m.includes('IN-PROGRESS'));
	assert.equal(hungAlerts.length, 1);
	assert.match(hungAlerts[0]!, /IN-PROGRESS/);
	assert.match(hungAlerts[0]!, /hung/);
});

test('runner-health: runner-listing 403 alone does NOT page (no false 0-online alert)', async () => {
	// Only /actions/runners forbidden; /actions/runs readable but empty.
	installFetch({ runnersStatus: 403 });
	await tick('tok');
	assert.equal(
		discordPosts.length,
		0,
		'an unreadable runners API must never become a runner-down page'
	);
});

test('runner-health: graceful degradation — runner-listing forbidden but a queued run still alerts', async () => {
	// Simulates a fine-grained token with Actions:read but no Administration:read.
	// The label-floor check is skipped, but the queued-job safety net still fires.
	installFetch({
		runnersStatus: 403,
		runs: {
			workflow_runs: [
				{
					display_title: 'Update Packages',
					created_at: minutesAgo(20),
					status: 'queued',
					html_url: 'https://gh/run/9',
				},
			],
		},
	});
	await tick('tok');
	assert.equal(discordPosts.length, 1);
	assert.match(discordPosts[0]!, /QUEUED/);
});

test('runner-health: both endpoints unreadable → silent (true fail-soft)', async () => {
	installFetch({ runnersStatus: 403, runsStatus: 500 });
	await tick('tok');
	assert.equal(discordPosts.length, 0, 'a dead API records a failed job but never pages');
	// Asserting only the SILENCE would pass if tick() were a no-op. The tick must
	// still REPORT that it failed, to the surface the daily digest reads.
	const failed = jobSinkPosts.filter((p) => p.status === 'failed');
	assert.equal(
		failed.length,
		1,
		`a dead API must record a FAILED job, got ${JSON.stringify(jobSinkPosts)}`
	);
	assert.equal(failed[0]?.job_name, 'ci:runner-health');
});

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

/**
 * Suppression must survive a RESTART.
 *
 * `lastAlertAt` was in-memory only, so every mgmt-api restart re-armed every
 * condition and the next tick re-paged all of them. On 2026-08-29 a
 * deploy-heavy session restarted the process six times and one failed unit
 * plus one queued run paged 10 minutes apart repeatedly — each alert correct,
 * the channel unreadable. That is how an alert gets trained away.
 *
 * `__resetRunnerHealthAlertsForTesting` clears the in-memory map the way a
 * restart does, WITHOUT clearing the persisted ledger — which is exactly the
 * situation the fix exists for.
 */
void test('runner-health: a restart does not re-page a condition already alerted', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
	});
	await tick('tok');
	await tick('tok'); // breach confirmed — alerts here
	const afterAlert = discordPosts.length;
	assert.ok(afterAlert > 0, 'the breach must alert once confirmed');

	// Simulate the restart: in-memory suppression gone, ledger on disk intact.
	__resetRunnerHealthAlertsForTesting();
	__reloadAlertLedgerForTesting();
	discordPosts = [];

	await tick('tok');
	await tick('tok');
	assert.equal(
		discordPosts.length,
		0,
		'the same unchanged condition must stay suppressed across a restart'
	);
});

test('runner-health: same condition does not re-alert within the suppression window', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
	});
	// The floor DEBOUNCES: nothing pages until a breach has been seen on two
	// consecutive ticks, so the alerts land on the second one. Capturing the
	// count after the first tick reads 0 and measures the debounce rather than
	// the suppression window.
	await tick('tok');
	await tick('tok'); // breach confirmed — this is where it alerts
	const afterAlert = discordPosts.length;
	assert.ok(afterAlert > 0, 'the breach must alert once confirmed');
	await tick('tok'); // same breach again
	// Suppression is per CONDITION, and this claws-only fixture breaches every
	// capability hokon offers — so the assertion is that the count does not GROW,
	// not that it equals one. Pinning the total would pin the size of
	// REQUIRED_LABELS into a test about the suppression window.
	assert.equal(discordPosts.length, afterAlert, 'a repeated breach must not re-alert');
	assert.ok(
		discordPosts.some((p) => /pm2-host/.test(p)),
		'the pm2-host breach is among them'
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

// --- Failover: OOM kills (2026-08-24) ---
//
// The offline-runner failover above cannot see these. The kernel OOM killer reaps
// the JOB, not the listener, so the runner is still online at the next tick and
// every gate the drop-failover uses reports a perfectly healthy fleet. The run
// just stays red and pages @here as if the build were broken.
//
// Real event: the 13:00 UTC @wolffm fan-out dispatched 14 repos inside 4 seconds,
// 11 landed on claw-2 (7.8GB, smallest box in the fleet, tier1 so never demoted),
// and the kernel killed hadoku-craft and hadoku-resume-bot 82 seconds apart.

/** A fleet where every claw is ONLINE — so nothing here is a runner drop. */
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

// --- Failover: refused at admission by ci-throttle (2026-10-11) ---
//
// A backstop promotion labels hokon on every repo, GitHub seats far more builder
// jobs there than its cap of 4, and ci-throttle refuses the losers after 90s in
// `Set up runner`. Three went red at 01:38Z and needed a hand rerun. The steps
// below are pygmalion run 38102526617's `test` job as the API returned it.

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

test('refusedAtAdmission: only a failed `Set up runner` with no workflow step run', () => {
	assert.equal(refusedAtAdmission({ conclusion: 'failure', steps: REFUSED_STEPS }), true);
	const ranCheckout = REFUSED_STEPS.map((st) =>
		st.number === 3 ? { ...st, conclusion: 'success' } : st
	);
	assert.equal(
		refusedAtAdmission({ conclusion: 'failure', steps: ranCheckout }),
		false,
		'once a workflow step ran, a rerun could repeat its side effects'
	);
	const redTests = REFUSED_STEPS.map((st) =>
		st.number === 2
			? { ...st, conclusion: 'success' }
			: st.number === 6
				? { ...st, conclusion: 'failure' }
				: st.number > 2 && st.number < 6
					? { ...st, conclusion: 'success' }
					: st
	);
	assert.equal(
		refusedAtAdmission({ conclusion: 'failure', steps: redTests }),
		false,
		'a red build'
	);
	assert.equal(refusedAtAdmission({ conclusion: 'failure' }), false, 'no steps is not evidence');
	assert.equal(refusedAtAdmission({ conclusion: 'cancelled', steps: REFUSED_STEPS }), false);
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

// --- Dynamic hokon backstop label (promote during a full claw outage) ---

test('backstop: all claws OFFLINE → adds hadoku-builder to hokon (🔻) and no floor page', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{
					id: 2,
					name: 'claw-1',
					status: 'offline',
					busy: false,
					labels: clawLabels(),
				},
				{
					id: 3,
					name: 'claw-2',
					status: 'offline',
					busy: false,
					labels: clawLabels(),
				},
			],
		},
	});
	await tick('tok');
	assert.equal(labelOps.length, 1, 'one label add');
	assert.match(labelOps[0]!, /^POST .*\/actions\/runners\/1\/labels$/);
	// One label now. hadoku-builder-heavy was retired 2026-08-19 — see the note on claw-3, so a
	// backstop that omitted it would leave heavy jobs queueing through the exact
	// outage it exists for.
	assert.deepEqual(
		labelPostBodies[0],
		['hadoku-builder'],
		'promotion adds the builder AND heavy labels'
	);
	assert.equal(
		discordPosts.length,
		1,
		'only the promote note — promotion covers the builder floor'
	);
	assert.match(discordPosts[0]!, /promoted/);
	assert.match(discordPosts[0]!, /hokon/);
});

test('backstop: a claw back online + hokon still labeled → removes the temporary label (🔺)', async () => {
	// A full CYCLE, not a bare demote. The 🔺 exists to close a 🔻 the operator
	// actually saw, so the outage that opened it has to be part of the test —
	// otherwise this asserts a recovery note for an incident that never happened,
	// which is precisely the noise the saturation path must not generate.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
	});
	await tick('tok');
	assert.equal(discordPosts.length, 1, 'the outage pages first');
	assert.match(discordPosts[0]!, /promoted/);
	labelOps.length = 0;
	discordPosts.length = 0;

	installFetch({
		runners: {
			runners: [
				{
					id: 1,
					name: 'hokon',
					status: 'online',
					busy: false,
					labels: hokonPromotedLabels(),
				},
				{
					id: 2,
					name: 'claw-1',
					status: 'online',
					busy: false,
					labels: clawLabels(),
				},
			],
		},
	});
	await tick('tok');
	assert.equal(labelOps.length, 1, 'one label remove');
	assert.match(labelOps[0]!, /^DELETE .*\/actions\/runners\/1\/labels\/hadoku-builder$/);
	assert.equal(discordPosts.length, 1);
	assert.match(discordPosts[0]!, /released the backstop/);
});

test('backstop: all claws AND hokon offline → cannot promote, pages pm2-host at its floor', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'offline', busy: false, labels: hokonLabels() },
				{
					id: 2,
					name: 'claw-1',
					status: 'offline',
					busy: false,
					labels: clawLabels(),
				},
			],
		},
	});
	// Twice: the floor debounces, and a total-fleet outage is exactly the shape a
	// blip on the monitoring host also produces, so it earns no exemption.
	await tick('tok');
	await tick('tok');
	assert.equal(labelOps.length, 0, 'hokon offline → no promotion possible');
	// hadoku-builder is retired from this alert (C0b) — with hokon offline too,
	// pm2-host (an IDENTITY label nothing else can carry) is what proves the
	// floor breach still pages when it genuinely should.
	assert.ok(
		discordPosts.some((p) => /pm2-host/.test(p) && /will queue/.test(p)),
		'pm2-host floor breach pages'
	);
	assert.ok(
		!discordPosts.some((p) => /hadoku-builder/.test(p)),
		'hadoku-builder itself must not page — retired, see C0b'
	);

	// THE LAST RESORT MUST ACTUALLY ENGAGE.
	//
	// With every claw AND the whole hokon pool dark, selfHostedOnline is 0 and
	// the fleet has to flip to GitHub-hosted runners. Nothing asserted that. The
	// only test that inspected `variableOps` asserted it was EMPTY (the hokon-can-
	// serve case), so the rung that spends billed minutes on 12 private repos was
	// verified never to fire and never verified to fire.
	//
	// This is also the only coverage of the sum at the call site —
	// `selfHostedOnline = clawsOnline + backstopOnline` — which is the exact line
	// the 2026-08-23 comment beside it was written about. ci-runner-fallback's own
	// suite tests the module, not this addition.
	const flips = variableOps.filter((o) => o.startsWith('PATCH') || o.startsWith('POST'));
	assert.ok(
		flips.length > 0,
		`a total self-hosted outage must pin CI_RUNNER to hosted, got: ${JSON.stringify(variableOps)}`
	);
	for (const f of flips) {
		assert.match(f, /CI_RUNNER=\["ubuntu-latest"\]|CI_RUNNER=/, 'the pin names CI_RUNNER');
	}
});

// ── saturation: every claw online but BUSY ──────────────────────────────────
// "A job needs a runner but would hit a queue" is the rule the backstop exists
// to serve, and availability alone cannot see it: from a queued job's point of
// view, three claws all mid-build are indistinguishable from three dead ones.

test('backstop: all claws BUSY *and* backed up → promotes hokon, and stays SILENT', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
				{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		// Busy alone is no longer enough — something has to be WAITING. See
		// SATURATION_QUEUE_SECONDS.
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 1, 'saturation promotes the hokon pool');
	assert.match(labelOps[0]!, /^POST .*\/actions\/runners\/1\/labels$/);
	assert.deepEqual(labelPostBodies[0], ['hadoku-builder']);
	assert.equal(
		discordPosts.length,
		0,
		'busy claws are a normal weekday — paging for them would train the operator ' +
			'to skim past the 🔻 that means the garage is actually dark'
	);
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'saturation');
});

test('backstop, 2026-10-09: a BUSY hokon is not promoted on mere saturation — "promote if the queue is full and hokon is idle"', async () => {
	// 2026-10-21: the ceiling is 4.0/core now (load 46 on 12 cores, the
	// operator's own sessions, still lets hokon in). 60 on 12 is a pegged box.
	// Two minutes queued is saturation (≥100s) but not a backlog (<300s).
	__setHostLoadReaderForTesting(() => ({ load1: 60, cores: 12, memAvailableMb: 32_768 }));
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [{ created_at: minutesAgo(2) }] },
		});
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'saturation', 'the WANT is there');
		assert.equal(labelOps.length, 0, 'load 60 on 12 cores is a pegged box, not a reserve');
	} finally {
		__setHostLoadReaderForTesting(() => ({ load1: 0, cores: 12, memAvailableMb: 32_768 }));
	}
});

test('backstop, 2026-10-21: a BACKLOG past 300s promotes a pegged hokon anyway — "hokon MUST come in when the queue shows up"', async () => {
	// Same pegged box; the queue has sat six minutes, past ci:queue-health's own
	// "not serving work" floor. The desktop yields.
	__setHostLoadReaderForTesting(() => ({ load1: 60, cores: 12, memAvailableMb: 32_768 }));
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
		});
		await tick('tok');
		assert.equal(labelOps.length, 1, 'a backlog promotes the pool whatever the load');
		assert.match(labelOps[0]!, /^POST .*\/actions\/runners\/1\/labels$/);
		assert.equal(discordPosts.length, 0, 'a backlog promote is still saturation: no page');
	} finally {
		__setHostLoadReaderForTesting(() => ({ load1: 0, cores: 12, memAvailableMb: 32_768 }));
	}
});

test('backstop, 2026-10-21: a backlog does NOT waive memory — a starved hokon stays out', async () => {
	__setHostLoadReaderForTesting(() => ({ load1: 2, cores: 12, memAvailableMb: 4_000 }));
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [{ created_at: minutesAgo(20) }] },
		});
		await tick('tok');
		assert.equal(
			labelOps.length,
			0,
			'a Forge job without memory fails slowly; no backlog changes that'
		);
	} finally {
		__setHostLoadReaderForTesting(() => ({ load1: 0, cores: 12, memAvailableMb: 32_768 }));
	}
});

// ── on-demand guest (#120): promotion is a MINT, not a label ────────────────
// Operator, 2026-10-19: "the runners get brought online the same way the JIT
// process does. not having standing runners squatting on ram." hokon keeps one
// standing registration — hadoku_site's deploy runner, `pm2-host` — and the
// backstop must never write `hadoku-builder` onto it. Its decision reaches the
// dispatcher through the HOLD, which offers the label on hokon's mints.

const ON_DEMAND = {
	hokon: { role: 'guest', mint: 'on-demand', standingRepos: ['WolffM/hadoku_site'] },
};

test('#120: saturation promotes an on-demand guest through the HOLD and writes no label', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
		});
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'saturation');
		assert.deepEqual(
			backstopHold(),
			['hokon'],
			'the dispatcher is told hokon may take builder work'
		);
		assert.equal(labelOps.length, 0, 'the deploy runner must never be labelled hadoku-builder');
		assert.equal(discordPosts.length, 0, 'saturation stays silent, minted or not');
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('#120: an on-demand guest is held with NO registration at all — retiring them must not retire the backstop', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				],
			},
		});
		await tick('tok');
		assert.deepEqual(backstopHold(), ['hokon'], 'the manifest names the backstop, not the pool');
		assert.ok(
			discordPosts.some((p) => p.includes('🔻') && p.includes('hokon (mint)')),
			`an OUTAGE promotion still pages, by the hold's edge: ${discordPosts.join(' | ')}`
		);
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test("#120: a leftover hadoku-builder on an on-demand guest's registration is STRIPPED, even while promoted", async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	try {
		installFetch({
			runners: {
				runners: [
					{
						id: 1,
						name: 'hokon',
						status: 'online',
						busy: false,
						labels: [...hokonLabels(), { name: 'hadoku-builder' }],
					},
					{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				],
			},
		});
		await tick('tok');
		assert.deepEqual(backstopHold(), ['hokon'], 'promoted');
		const ops = labelOps.filter((o) => o.includes('/actions/runners/1/'));
		assert.ok(ops.length > 0, 'the leftover label is acted on');
		assert.ok(
			ops.every((o) => o.startsWith('DELETE ') && o.endsWith('/labels/hadoku-builder')),
			`demote-only — the label is the standing registrations' path, and hokon has left it:\n${ops.join('\n')}`
		);
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

// ── the capacity invariant (2026-10-21): the dispatcher's ledger, paged ─────

const brokenLedger = () =>
	recordCapacityLedger([
		// claw-1 as the 2026-10-07 formula read it: one JIT job charged twice.
		{
			node: 'claw-1',
			liveUnits: 1,
			probeWorkers: 1,
			standingBusy: 1,
			warmHeld: 1,
			budget: 2,
			inFlight: 2,
		},
	]);
const soundLedger = () =>
	recordCapacityLedger([
		{
			node: 'claw-1',
			liveUnits: 1,
			probeWorkers: 1,
			standingBusy: 0,
			warmHeld: 1,
			budget: 2,
			inFlight: 1,
		},
	]);
const quietFleet = () =>
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [] },
	});

test('capacity invariant: three consecutive broken ticks page ONCE, naming the node and the clause', async () => {
	__resetCapacityLedgerForTesting();
	try {
		for (let i = 0; i < 3; i++) {
			brokenLedger();
			quietFleet();
			await tick('tok');
			if (i < 2) assert.equal(discordPosts.length, 0, `tick ${i + 1}: a race is not a bug yet`);
		}
		const page = discordPosts.find((p) => p.includes('dispatcher accounting'));
		assert.ok(page, `paged on the third tick: ${discordPosts.join(' | ')}`);
		assert.match(page!, /claw-1: charged 2 in flight/);
		brokenLedger();
		quietFleet();
		await tick('tok');
		assert.equal(
			discordPosts.filter((p) => p.includes('dispatcher accounting')).length,
			1,
			'still broken, still one page — alertOnce rate-limits it'
		);
	} finally {
		__resetCapacityLedgerForTesting();
	}
});

test('capacity invariant: a single broken pass is a race, not a page; a sound ledger re-arms', async () => {
	__resetCapacityLedgerForTesting();
	try {
		brokenLedger();
		quietFleet();
		await tick('tok');
		brokenLedger();
		quietFleet();
		await tick('tok');
		soundLedger(); // the third tick reads a sound ledger: the streak resets
		quietFleet();
		await tick('tok');
		brokenLedger();
		quietFleet();
		await tick('tok');
		assert.equal(
			discordPosts.filter((p) => p.includes('dispatcher accounting')).length,
			0,
			'two broken, one sound, one broken: never three in a row'
		);
	} finally {
		__resetCapacityLedgerForTesting();
	}
});

test('capacity invariant: a stale ledger (dispatcher not running) is not a broken one', async () => {
	__resetCapacityLedgerForTesting();
	try {
		for (let i = 0; i < 3; i++) {
			recordCapacityLedger(
				[
					{
						node: 'claw-1',
						liveUnits: 1,
						probeWorkers: 1,
						standingBusy: 1,
						warmHeld: 1,
						budget: 2,
						inFlight: 2,
					},
				],
				Date.now() - 60 * 60_000
			);
			quietFleet();
			await tick('tok');
		}
		assert.equal(
			discordPosts.filter((p) => p.includes('dispatcher accounting')).length,
			0,
			'an hour-old ledger says nothing about now; that is dispatch.failingSince’s page'
		);
	} finally {
		__resetCapacityLedgerForTesting();
	}
});

// ── the green light (2026-10-21): `fleet backstop --force` ──────────────────
// The retro's §4.1: on 2026-10-20/21 the backstop wanted hokon every tick and
// the idle gate refused it, and every way to bring it in was a code change. A
// force is a time-boxed operator record the tick reads like the drain.

const forceUntil = (minutesFromNow: number) => ({
	since: new Date(Date.now() - 60_000).toISOString(),
	until: new Date(Date.now() + minutesFromNow * 60_000).toISOString(),
	reason: 'queue backed up',
	by: 'hadoku',
});

test('green light: a forced on-demand guest is HELD on a quiet, measured tick, pegged or not', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	// A pegged box — the idle gate would refuse this — and NO saturation.
	__setHostLoadReaderForTesting(() => ({ load1: 60, cores: 12, memAvailableMb: 32_768 }));
	writeForce({ hokon: forceUntil(30) });
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'online', busy: false, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [] },
		});
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none', 'nothing WANTS it');
		assert.deepEqual(backstopHold(), ['hokon'], 'the operator does, so it is held');
		assert.equal(labelOps.length, 0, 'held through the mint path; no label on the deploy runner');
	} finally {
		writeForce({});
		__setHostLoadReaderForTesting(() => ({ load1: 0, cores: 12, memAvailableMb: 32_768 }));
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('green light: a force does NOT beat the drain — red wins', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	writeForce({ hokon: forceUntil(30) });
	writeDrain({ hokon: { since: 's', reason: 'lid off', by: 'hadoku' } });
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [] },
		});
		await tick('tok');
		assert.deepEqual(backstopHold(), [], 'drained: not held, forced or not');
	} finally {
		writeDrain({});
		writeForce({});
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('green light: an expired force lapses on its own — nobody has to remember to turn it off', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	writeForce({ hokon: forceUntil(-1) });
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [] },
		});
		await tick('tok');
		assert.deepEqual(backstopHold(), [], 'a minute past its until, the force is as good as absent');
	} finally {
		writeForce({});
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('#120: the drain is the red light — a drained on-demand guest is not held, outage included', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	writeDrain({ hokon: { since: 's', reason: 'operator', by: 'hadoku' } });
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				],
			},
		});
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'outage', 'the WANT is unchanged');
		assert.deepEqual(backstopHold(), [], 'blocked means no jobs, an emergency included');
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('#120: releasing an on-demand promotion clears the hold and closes the 🔻 it opened', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				],
			},
		});
		await tick('tok');
		assert.deepEqual(backstopHold(), ['hokon']);
		installFetch({
			runners: {
				runners: [
					{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'online', busy: false, labels: clawLabels() },
				],
			},
			queuedRuns: { workflow_runs: [] },
		});
		await tick('tok');
		assert.deepEqual(backstopHold(), [], 'demotion leaves nothing listening and nothing offered');
		assert.ok(
			discordPosts.some((p) => p.includes('🔺') && p.includes('hokon (mint)')),
			discordPosts.join(' | ')
		);
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('an unreadable manifest writes NO builder label — a deploy runner and a backstop look alike without it', async () => {
	__setBackstopMachinesForTesting(() => null);
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
				],
			},
		});
		await tick('tok');
		assert.equal(labelOps.length, 0, 'not even on an outage');
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('backstop: an OUTAGE promotes hokon even when it is busy — CI with nowhere to run outranks idle', async () => {
	__setHostLoadReaderForTesting(() => ({ load1: 9, cores: 12, memAvailableMb: 2_000 }));
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
					{ id: 3, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				],
			},
		});
		await tick('tok');
		assert.ok(
			labelOps.some((o) => /^POST .*\/actions\/runners\/1\/labels$/.test(o)),
			labelOps.join('\n')
		);
	} finally {
		__setHostLoadReaderForTesting(() => ({ load1: 0, cores: 12, memAvailableMb: 32_768 }));
	}
});

// ── the saturation gate: at capacity is not the same as backed up ───────────
// `clawsFree === 0` says every claw is busy. It does NOT say anything is
// waiting. A fleet running flat out with an empty queue is a fleet working, and
// pulling the PRODUCTION host into that buys nothing — which is what the trigger
// did on ordinary load until 2026-08-25.

test('backstop: busy claws with an EMPTY queue do NOT promote the prod host', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
				{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 0, 'nothing is waiting, so hokon stays out of CI');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none');
	assert.equal(getRunnerHealthSnapshot()?.at_capacity, true, 'still reported as at capacity');
	assert.equal(getRunnerHealthSnapshot()?.queue_pressure_sec, 0);
});

test('backstop: a queue YOUNGER than the p90 threshold does not promote either', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		// 30s: real, but well inside what the fleet absorbs unaided (p50 3s, p90 100s).
		queuedRuns: { workflow_runs: [{ created_at: new Date(Date.now() - 30_000).toISOString() }] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 0, 'a 30s wait is ordinary, not an escalation');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none');
	const pressure = getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0;
	assert.ok(
		pressure >= 25 && pressure < 100,
		`measured the wait but stayed under the bar (${pressure}s)`
	);
});

test('backstop: a real backlog does NOT promote hokon while the nightly crons run', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		// Everything the saturation path wants: every claw busy, 6 minutes queued.
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	__setReservationForTesting(() => ({
		reserved: true,
		reason: 'cron-running',
		detail: 'dp-daily-pipeline',
	}));
	await tick('tok');
	assert.equal(labelOps.length, 0, 'the crons outrank CI being slow');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none');
	assert.equal(getRunnerHealthSnapshot()?.reserved_reason, 'cron-running');
	assert.ok(
		(getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0) >= 100,
		'the backlog was real and measured — it was OVERRULED, not unnoticed'
	);
});

// ── the pm2-host rung is PER NODE (3e §H) ──────────────────────────────────
// `pm2-host` became a PROBED capability on 2026-09-15 (#6), so a claw can EARN
// it and migration one's box will. Until 2026-09-16 the rung was ONE
// module-level boolean for the whole fleet, and with two holders it answered
// about the FLEET while the backstop was asking about a BOX — wrong in both
// directions, and both directions cost the fleet its backstop during a backlog.

/** A claw that has EARNED pm2-host: it offers the rung and no builder label. */
const clawPm2HostLabels = () => [{ name: 'self-hosted' }, { name: 'pm2-host' }];

/**
 * The REAL rung, answered per node.
 *
 * `nodeReservation` itself is not called: it consults the wall clock and the
 * declared cron window, so a suite run inside the 90 minutes after any daily
 * cron would reserve everything and read as a pass for the wrong reason. This
 * stands in for it with the one rung under test, and it is handed whatever busy
 * flag the tick computed — so a tick that collapses two holders into one answer
 * gets a reservation for a box that is not busy.
 */
const pm2RungOnly = () =>
	__setReservationForTesting((busy) =>
		busy
			? { reserved: true, reason: 'pm2-host', detail: 'serving pm2-host work' }
			: { reserved: false, reason: null, detail: null }
	);

test('backstop: a BUSY claw holder of pm2-host does not hold an idle hokon off builder work', async () => {
	// Everything the saturation path wants — every eligible claw busy, 6 minutes
	// queued — plus claw-2 serving the top rung. hokon is idle and is the box the
	// backstop places on. Fleet-wide, claw-2's rung reserved hokon for work hokon
	// was not doing and the backlog kept waiting.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
				{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawPm2HostLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	pm2RungOnly();
	await tick('tok');
	assert.deepEqual(
		labelOps.map((o) => o.replace(/^(\w+) .*\/actions\/runners\//, '$1 ')),
		['POST 1/labels'],
		`only the idle holder is promoted, and the busy one is left alone: ${labelOps.join(', ')}`
	);
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'saturation');
	assert.equal(
		getRunnerHealthSnapshot()?.reserved_reason,
		null,
		'the POOL is not reserved while one holder is free'
	);
	assert.equal(
		getRunnerHealthSnapshot()?.pm2_host_busy,
		true,
		'the fleet-wide pill still says someone is serving the rung — it just no longer decides'
	);
});

test('backstop: an IDLE claw holder of pm2-host does not clear a BUSY hokon onto builder work', async () => {
	// The other direction of the same collapse, and the dangerous one: one flag
	// read `false` because claw-2 was idle, and the pool promoted the box that was
	// actually serving the rung. Here hokon is busy with pm2-host work and must be
	// left out of CI while claw-2, which is not, takes the backstop.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: true, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
				{ id: 3, name: 'claw-2', status: 'online', busy: false, labels: clawPm2HostLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	pm2RungOnly();
	await tick('tok');
	assert.deepEqual(
		labelOps.map((o) => o.replace(/^(\w+) .*\/actions\/runners\//, '$1 ')),
		['POST 3/labels'],
		`the free holder takes the backstop, never the busy one: ${labelOps.join(', ')}`
	);
});

test('backstop: EVERY holder busy still reserves the whole pool, exactly as one flag did', async () => {
	// The case the fleet-wide flag got right, pinned so the split did not trade one
	// failure for another: with no free holder there is nowhere for the backstop to
	// go, and a backed-up queue does not outrank the top rung.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: true, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
				{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawPm2HostLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	pm2RungOnly();
	await tick('tok');
	assert.equal(labelOps.length, 0, 'the top rung outranks CI being slow');
	assert.equal(getRunnerHealthSnapshot()?.reserved_reason, 'pm2-host');
	assert.ok(
		(getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0) >= 100,
		'the backlog was real and measured — it was OVERRULED, not unnoticed'
	);
});

test('backstop: an already-promoted hokon comes DOWN when cron work starts', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 1, 'promoted while the fleet was backed up and nothing reserved');
	labelOps.length = 0;

	// Same backlog, but the crons have now started. Declining to promote is not
	// enough — a promotion from 23:50 would otherwise sit through the whole run.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonPromotedLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	__setReservationForTesting(() => ({ reserved: true, reason: 'cron-window', detail: '00:00' }));
	await tick('tok');
	assert.equal(labelOps.length, 1, 'the label is taken back, not merely withheld');
	assert.match(labelOps[0]!, /^DELETE .*\/labels\/hadoku-builder$/);
});

test('backstop: an OUTAGE overrules the crons — CI being impossible outranks them', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [] },
	});
	__setReservationForTesting(() => ({ reserved: true, reason: 'cron-running', detail: 'nightly' }));
	await tick('tok');
	assert.equal(labelOps.length, 1, 'a fleet with nowhere to run is worth interrupting a cron for');
	assert.deepEqual(labelPostBodies[0], ['hadoku-builder']);
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'outage');
});

test('backstop: an OUTAGE promotes with no queue at all — nothing can queue behind a dark fleet', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 1, 'the outage path must not wait to observe a queue');
	assert.deepEqual(labelPostBodies[0], ['hadoku-builder']);
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'outage');
});

// ── #63: the caller must not answer the function's question for it ────────
// Every test in this block is at the CALLER. `decideBackstop` has been right
// since 2026-09-01 and its own unit tests pass today with the fleet inert in
// production, because the caller handed it a queue of 0 whenever `atCapacity`
// was false. A test against the function alone cannot fail here — that is the
// whole of #63 — so these drive a real tick through `tick()` and assert on the
// fetches it makes and the label it writes.

test('#63 THE 2026-09-01 SHAPE: a long queue promotes while claws are FREE', async () => {
	// The outage this lane exists for. Three of four nodes ephemeral, so
	// census.ts folded their mintable slots into `clawsFree` and it never hit
	// zero; 13 jobs sat 11-19 minutes across nine repos and the backstop stayed
	// down, because the caller asked "is the fleet full?" before "is anything
	// stuck?" and the first question could no longer be true.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				// FREE, not busy. `isAtCapacity` is false for this fleet, and that
				// is exactly the state the old gate refused to probe in.
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
				{ id: 3, name: 'claw-2', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(13) }] },
	});
	await tick('tok');
	assert.ok(queuedListings.length > 0, 'the queue must be PROBED off-capacity, not assumed empty');
	assert.equal(
		getRunnerHealthSnapshot()?.at_capacity,
		false,
		'the fixture is genuinely off-capacity — a free claw, which is the point'
	);
	assert.ok(
		(getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0) >= 100,
		'and the backlog was MEASURED, not passed in as the literal 0'
	);
	assert.equal(
		getRunnerHealthSnapshot()?.backstop_reason,
		'saturation',
		'a backed-up queue is sufficient on its own — `atCapacity` is not a precondition'
	);
	assert.equal(labelOps.length, 1, 'and the promotion actually reaches GitHub');
	assert.match(labelOps[0]!, /^POST .*\/actions\/runners\/1\/labels$/);
	assert.deepEqual(labelPostBodies[0], ['hadoku-builder']);
	assert.equal(
		discordPosts.length,
		0,
		'saturation is ordinary load and pages nobody — only an outage is an incident'
	);
});

test('#63: an EMPTY queue off-capacity still does not promote', async () => {
	// The other half, and the one that keeps the fix from being a loosening.
	// Probing more often must not mean promoting more often: 2026-08-24 fired on
	// ordinary load with nothing waiting, and `queuePressureSec` is what fixed
	// it. An idle fleet is now probed and must come back quiet.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [] },
	});
	await tick('tok');
	assert.ok(queuedListings.length > 0, 'it LOOKED');
	assert.equal(labelOps.length, 0, 'and found nothing, so the prod host stays out of CI');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none');
	assert.equal(getRunnerHealthSnapshot()?.queue_pressure_sec, 0);
});

test('#63: a YOUNG queue off-capacity does not promote either', async () => {
	// The threshold is what makes the run-level measure safe once a free claw no
	// longer gates the probe: a run is briefly `queued` while GitHub places it,
	// and 30s is well inside what the fleet absorbs unaided (p50 3s, p90 100s).
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: new Date(Date.now() - 30_000).toISOString() }] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 0, 'a 30s placement wait is not an escalation');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none');
	const pressure = getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0;
	assert.ok(
		pressure >= 25 && pressure < 100,
		`measured it and stayed under the bar (${pressure}s)`
	);
});

test('#63: an OUTAGE still skips the probe — that half of 2029454 is CORRECT', async () => {
	// Wave 3m's reasoning stands and must not be collateral damage here: nothing
	// can queue behind a fleet with nowhere to run, `decideBackstop` promotes on
	// the outage alone, and waiting to observe a queue would add the threshold to
	// every job's latency during the incident.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
	});
	await tick('tok');
	assert.equal(queuedListings.length, 0, 'a dark fleet must not pay the threshold in latency');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'outage', 'and it promotes anyway');
	assert.deepEqual(labelPostBodies[0], ['hadoku-builder']);
});

test('#63: UNMEASURED counts skip the probe — nothing downstream reads it', async () => {
	// `decideBackstop` returns on `ephemeralUnknown` before it ever looks at
	// `queuePressureSec`, holding the previous answer. runner-health's first tick
	// after every mgmt-api restart lands in that window (observed over three
	// deploys on 2026-09-07), and mgmt-api restarts often enough that a listing
	// per repo there is a standing cost bought for an input nothing consumes.
	__setFleetProbeForTesting(null);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(13) }] },
	});
	await tick('tok');
	assert.equal(
		getRunnerHealthSnapshot()?.ephemeral_unknown,
		true,
		'the fixture really is unmeasured'
	);
	assert.equal(queuedListings.length, 0, 'no probe for a decision that holds regardless');
	assert.equal(labelOps.length, 0, 'and an unmeasured fleet is neither promoted nor demoted');
});

test('2026-10-09: the FIRST tick after a restart never demotes an already-promoted hokon', async () => {
	// Memory is empty after a restart, so the remembered state reads "not
	// promoted"; the unmeasured tick used to converge every hokon registration
	// to that and strip hadoku-builder (20:36, 20:52), re-promoting ten minutes
	// later. An unmeasured tick writes nothing.
	__setFleetProbeForTesting(null);
	installFetch({
		runners: {
			runners: [
				{
					id: 1,
					name: 'hokon',
					status: 'online',
					busy: false,
					labels: [...hokonLabels(), { name: 'hadoku-builder' }],
				},
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
	});
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.ephemeral_unknown, true);
	assert.deepEqual(labelOps, [], 'nothing demoted on evidence nobody gathered');
});

test('#120: the FIRST tick after a restart neither holds nor strips an on-demand guest', async () => {
	// The claws read dark here only because nothing has been measured yet — the
	// 2026-09-02 shape. An on-demand guest is promoted by the HOLD, so "could not
	// look" must leave the hold empty: no builder work minted on the production
	// host on evidence nobody gathered. Nothing is stripped either — the units it
	// may already be running are one-job units the hold never touches.
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	__setFleetProbeForTesting(null);
	try {
		installFetch({
			runners: {
				runners: [
					{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
					{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
				],
			},
		});
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.ephemeral_unknown, true, 'the fixture is unmeasured');
		assert.deepEqual(backstopHold(), [], 'no mint for builder work on an unmeasured tick');
		assert.deepEqual(labelOps, [], 'and no label written either way');
		assert.equal(
			discordPosts.some((p) => p.includes('🔻')),
			false,
			'a restart is not an outage'
		);
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('#63: the queue probe stays inside the hourly API budget at fleet size', async () => {
	// BUDGET ARITHMETIC IS PART OF THE FIX (AGENTS.md). `probeQueuePressure`
	// goes through `ghGet`, which revalidates with an ETag, but a queue that
	// moved between ticks is charged, so the CEILING — every listing changed —
	// is what is asserted here, and widening WHEN it runs raises it. The
	// cadence itself is unchanged: still at most one probe per runner-health
	// tick. What changed is how often that one probe is taken, from "only at
	// capacity" (which under all-JIT is approximately never) to "whenever the
	// fleet is up", so the honest ceiling is every tick.
	//
	// The listing count comes from a real tick at fleet size rather than a
	// literal, because the loop breaks early at the first run over the threshold
	// and the QUIET answer — the common one — is the expensive one.
	const REPOS = Array.from({ length: 26 }, (_, i) => `WolffM/repo-${i}`); // coveredRepos(), 2026-09-24
	const BUDGET_PER_HOUR = 5000; // GitHub primary limit, per token
	__setFleetReposForTesting(REPOS);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [] }, // the worst case: nothing to break early on
	});
	await tick('tok');
	assert.equal(queuedListings.length, REPOS.length, 'one listing per repo, once per tick');

	const ticksPerHour = 3_600_000 / TICK_INTERVAL_MS;
	const cost = ticksPerHour * queuedListings.length;
	assert.equal(cost, 156, '26 repos x 6 ticks/hr — the number stated at the call site');
	assert.ok(
		cost < BUDGET_PER_HOUR / 10,
		`the queue probe would spend ${cost}/hr of a ${BUDGET_PER_HOUR}/hr budget — it must ` +
			'leave room for polling, minting, the JIT reap, job-history and the crons on this token'
	);
});

// ── #56: a days-old queued run is not queue pressure ──────────────────────
// THE REGRESSION #63 SHIPPED. `2383b18` made the queue probe unconditional,
// which is the right fix for the 2026-09-01 shape above — and on the first tick
// after that deploy the probe returned ~3.5 MILLION seconds, 35,000x the 100s
// threshold, off two runs that have been `queued` and uncancellable since
// 2026-08-17 and 2026-08-19 (`dispatch-tick.ts` records the three API refusals).
// `saturated` was therefore permanently true and hokon carried
// `hadoku-builder` continuously.
//
// Measured in the DEPLOYED tree, not this checkout: zero `BACKSTOP` lines in
// mgmt-api's log for 2026-09-22..24, then 37 / 111 / 149 / 116 on 09-25..28,
// every one of them `reason=saturation queue=~3,510,000s` against a fleet
// reporting `claws=12/12 online free=27`. hokon's share of `hadoku-builder`
// work went 0.0% on 09-22..24 to 2.8 / 11.9 / 12.6 / 19.7% on 09-25..28.
//
// These are at the CALLER for the same reason the #63 block above is: the
// decision function was always right, and it is what the caller measures and
// hands it that was wrong.
test('#56 THE REGRESSION: a run queued for weeks does NOT promote the production host', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		// The two real ones, by age. Nothing will ever pick these up.
		queuedRuns: { workflow_runs: [{ created_at: daysAgo(42) }, { created_at: daysAgo(40) }] },
	});
	await tick('tok');
	assert.ok(queuedListings.length > 0, 'it still LOOKS — the probe stays unconditional');
	assert.equal(
		getRunnerHealthSnapshot()?.queue_pressure_sec,
		0,
		'a stuck run is not work waiting for capacity'
	);
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none');
	assert.equal(labelOps.length, 0, 'and the production host is not pulled into CI');
});

test('#56: the refusal is SAID, not silently dropped', async () => {
	// "I deliberately did not act on this" must never render as "there was
	// nothing there". A zombie count of 2 beside a pressure of 0 is two separate
	// facts — stuck work, and no live backlog — and they are two different jobs
	// for the operator. The log line says it too, on CHANGE rather than every
	// tick; the snapshot is what a test can observe, since the test host's logger
	// is deliberately a no-op.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: daysAgo(42) }, { created_at: daysAgo(40) }] },
	});
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.queue_zombies_ignored, 2);
	assert.equal(getRunnerHealthSnapshot()?.queue_pressure_sec, 0);
});

test('#56: a FRESH backlog behind a zombie still promotes — the fix is not undone', async () => {
	// The direction that matters. #63 is correct and must not be reverted: the
	// 2026-09-01 incident recurs without it. So the band has to remove the stuck
	// run WITHOUT removing the live one sitting behind it in the same listing.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: {
			workflow_runs: [{ created_at: daysAgo(42) }, { created_at: minutesAgo(13) }],
		},
	});
	await tick('tok');
	const pressure = getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0;
	assert.ok(pressure >= 100 && pressure < 1000, `the LIVE run is what was measured: ${pressure}s`);
	assert.equal(getRunnerHealthSnapshot()?.queue_zombies_ignored, 1);
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'saturation');
	assert.equal(labelOps.length, 1, 'and it reaches GitHub');
});

test('#56: a stall LONGER than the band still promotes — the exclusion cannot be manufactured', async () => {
	// CLAUDE.md's rule, checked: if you exclude a category, check what happens
	// when a real failure MAKES that category. `queue-health`'s p95 broke exactly
	// this way — every casualty of a long stall eventually crossed the one-hour
	// ceiling and LEFT the percentile, so a two-hour outage read greener than a
	// twenty-minute one.
	//
	// A MAXIMUM over a sliding band does not have that shape. A stall lasting
	// longer than a day means runs are still arriving and still not being served,
	// so the band is full of recent ones. Here: the oldest casualty has aged out
	// entirely, and the run just inside the boundary is still over the threshold
	// by four orders of magnitude.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: {
			workflow_runs: [
				{ created_at: daysAgo(3) }, // aged out of the band by the stall's own length
				{ created_at: new Date(Date.now() - (QUEUE_ZOMBIE_SECONDS - 60) * 1000).toISOString() },
			],
		},
	});
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.queue_zombies_ignored, 1, 'the 3-day-old one is refused');
	assert.ok(
		(getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0) >= QUEUE_ZOMBIE_SECONDS - 120,
		'and the one inside the band carries the stall'
	);
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'saturation');
	assert.equal(labelOps.length, 1);
});

test("#56: the probe reads THIS attempt's clock, not the original run's", async () => {
	// `created_at` pins to the ORIGINAL run and GitHub never moves it, so on a
	// re-run the two diverge by the whole gap between attempts. That is the bug
	// `GhRun.run_started_at` was added for on 2026-09-10, when a re-run of a
	// 2h-old hadoku-tenhands run alerted as "QUEUED 122m" while its jobs started
	// four seconds later — and the saturation probe was still reading the field
	// that mistake was about, so requeueing anything old promoted the production
	// host on the next tick.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: {
			workflow_runs: [{ created_at: minutesAgo(122), run_started_at: minutesAgo(0) }],
		},
	});
	await tick('tok');
	const pressure = getRunnerHealthSnapshot()?.queue_pressure_sec ?? 0;
	assert.ok(pressure < 100, `this attempt has barely waited: ${pressure}s`);
	assert.equal(getRunnerHealthSnapshot()?.queue_zombies_ignored, 0, 'not a zombie either');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none');
	assert.equal(labelOps.length, 0);
});

test('backstop: one claw frees up → demotes again, with no 🔺 for a silent promote', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 1, 'promoted while saturated');
	labelOps.length = 0;
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonPromotedLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		// STILL QUEUED, just no longer past the threshold — 40s against 100s.
		//
		// This fixture omitted `queuedRuns` entirely and so measured the hold over
		// a queue of ZERO, which since #56 stands the reserve down on the first
		// calm tick: nothing is waiting, so there is no flap left to damp and no
		// reason to keep the production host eligible for another half hour. The
		// flap this test is about is a queue crossing the threshold and coming
		// back, and a queue at 40s is exactly that state. The empty case has its
		// own test below.
		queuedRuns: { workflow_runs: [{ created_at: new Date(Date.now() - 40_000).toISOString() }] },
	});
	// A SATURATION stand-down waits for sustained calm. One free tick is not
	// evidence the pool is calm — it is what the flap looked like: measured
	// 2026-08-25, promote/demote/promote inside twenty minutes, each pass
	// rewriting labels on 13-25 runners fleet-wide. Only the outage and cron
	// reservation paths stand down in the same tick, and both have their own
	// tests above.
	await tick('tok');
	assert.equal(labelOps.length, 0, 'one calm tick is not calm enough');
	await tick('tok');
	assert.equal(labelOps.length, 0, 'nor two');

	await tick('tok');
	assert.equal(labelOps.length, 1, 'sustained calm demotes the pool');
	assert.match(labelOps[0]!, /^DELETE .*\/labels\/hadoku-builder$/);
	assert.equal(discordPosts.length, 0, 'a promote nobody was told about needs no recovery note');
});

test('#56: a queue measured EMPTY demotes on the FIRST calm tick, not the third', async () => {
	// The other half of #63, at the caller. The hold used to run a fixed thirty
	// minutes whether or not anything was still queued, and it could not have done
	// better: until `2383b18` the caller handed `decideBackstop` a literal 0 on
	// every off-capacity tick, so the queue reading carried no information. Now it
	// is probed every tick and 0 means PROBED AND EMPTY — and a standing hokon
	// registration wins GitHub's assignment race outright, so thirty minutes of
	// eligibility over an empty queue is thirty minutes of hokon taking builder
	// work no claw was slow to take.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 1, 'promoted while saturated');
	labelOps.length = 0;

	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonPromotedLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [] },
	});
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.queue_pressure_sec, 0, 'probed, and empty');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'none', 'not "holding"');
	assert.equal(labelOps.length, 1, 'the reserve stands down now');
	assert.match(labelOps[0]!, /^DELETE .*\/labels\/hadoku-builder$/);
});

test('backstop: a single busy tick inside the calm window restarts the count', async () => {
	// The whole point: saturation that comes back before the window elapses must
	// not get a demote-then-promote pair out of it.
	const saturated = {
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	};
	const calm = {
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonPromotedLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
			],
		},
		// Below the threshold but NOT empty — see the fixture note above. An empty
		// queue ends the hold immediately since #56, which would make this whole
		// sequence measure the stand-down rather than the window.
		queuedRuns: { workflow_runs: [{ created_at: new Date(Date.now() - 40_000).toISOString() }] },
	};
	installFetch(saturated);
	await tick('tok');
	labelOps.length = 0;

	installFetch(calm);
	await tick('tok');
	await tick('tok');
	// Saturated AGAIN, but with hokon still promoted — that is the point of the
	// window. Handing back the un-promoted fixture would make the tick re-add a
	// label it never lost, measuring the fixture instead of the hysteresis.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonPromotedLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	await tick('tok'); // busy again — the counter resets
	installFetch(calm);
	await tick('tok');
	await tick('tok');
	assert.equal(labelOps.length, 0, 'no label churn across the whole sequence');
});

// ── the fan-out: hokon is relabelled on EVERY fleet repo ────────────────────
// A runner ID is repo-scoped, so promoting by ID reaches exactly one repo.
// hokon has carried a runner on all 26 repos since 2026-08-23, so an outage
// used to promote it for hadoku_site and strand the other 25 — and the hosted
// fallback could not rescue them either, because it counts hokon as capacity.

test('backstop: an outage promotes hokon on every fleet repo, not just this one', async () => {
	__setFleetReposForTesting(['WolffM/hadoku_site', 'WolffM/hadoku-rally', 'WolffM/hadoku-task']);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
	});
	await tick('tok');
	const repos = labelOps
		.filter((o) => o.startsWith('POST'))
		.map((o) => o.match(/repos\/([^/]+\/[^/]+)\//)?.[1])
		.filter(Boolean);
	assert.deepEqual(
		[...new Set(repos)].sort(),
		['WolffM/hadoku-rally', 'WolffM/hadoku-task', 'WolffM/hadoku_site'],
		'every fleet repo gets its hokon runner promoted'
	);
});

// ── a reserve must be SOUND when it is brought in ───────────────────────────
// The backstop is the only writer of hadoku-builder on a guest, so the fleet
// loop's quarantine meant nothing here until 2026-09-21 — a hokon whose store
// the guard had flagged would still be promoted the moment the claws saturated.

test('backstop: a QUARANTINED hokon is not promoted on saturation', async () => {
	markNodeSick('hokon');
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
				{ id: 3, name: 'claw-2', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.backstop_reason, 'saturation', 'the WANT is unchanged');
	assert.equal(labelOps.length, 0, 'but a quarantined node gets no builder work');
});

test('backstop: a DRAINED hokon is not promoted either', async () => {
	writeDrain({ hokon: { since: 's', reason: 'operator', by: 'hadoku' } });
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 0, 'an operator took it out of service');
});

test('backstop: a quarantined hokon ALREADY labelled is stripped, not left serving', async () => {
	markNodeSick('hokon');
	installFetch({
		runners: {
			runners: [
				{
					id: 1,
					name: 'hokon',
					status: 'online',
					busy: false,
					labels: [...hokonLabels(), { name: 'hadoku-builder' }],
				},
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(6) }] },
	});
	await tick('tok');
	assert.equal(labelOps.length, 1);
	assert.match(labelOps[0]!, /^DELETE .*\/actions\/runners\/1\/labels\/hadoku-builder$/);
});

test('backstop: an outage does not fan a quarantined hokon out to the fleet', async () => {
	markNodeSick('hokon');
	__setFleetReposForTesting(['WolffM/hadoku_site', 'WolffM/hadoku-rally', 'WolffM/hadoku-task']);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
	});
	await tick('tok');
	assert.deepEqual(
		labelOps.filter((o) => o.startsWith('POST')),
		[],
		'no repo may promote a node the local loop refused — the fan-out shares its predicate'
	);
});

test('backstop: the fan-out never touches a claw, only the hokon pool', async () => {
	__setFleetReposForTesting(['WolffM/hadoku_site', 'WolffM/hadoku-rally']);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
				// Demoted by the fast loop — carries neither pm2-host nor
				// hokon-backstop — so the fan-out must leave it exactly as it found it.
				//
				// OFFLINE since 2026-08-27. It used to be `online`, which produced an
				// outage only because liveness was counted by LABEL: a demoted node
				// vanished from the count and the fleet read as dead while it was
				// running. That is the P2 bug, now fixed, and it is pinned as its own
				// test below. The scenario here needs a REAL outage to exercise
				// fan-out targeting, so every claw is down.
				{ id: 9, name: 'claw-2', status: 'offline', busy: false, labels: [] },
			],
		},
	});
	await tick('tok');
	assert.ok(labelOps.length > 0, 'the outage did promote something');
	assert.ok(
		labelOps.every((o) => /\/runners\/1\/labels/.test(o)),
		`only hokon (id 1) may be relabelled, got: ${labelOps.join(', ')}`
	);
});

test('backstop: an ONLINE demoted claw is not an outage and promotes nothing', async () => {
	// The regression guard for P2. claw-1 is down and claw-2 is up but demoted,
	// which is the fleet's ordinary steady state since tier1 became claw-2 alone.
	// Counting liveness by LABEL made this read as a total outage and promoted the
	// PRODUCTION host, while a healthy idle node sat there — the right response
	// being a tier promotion, which costs nothing on the prod box.
	__setFleetReposForTesting(['WolffM/hadoku_site']);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
				{ id: 9, name: 'claw-2', status: 'online', busy: false, labels: [] },
			],
		},
	});
	await tick('tok');
	assert.deepEqual(labelOps, [], 'a live claw means no backstop promotion');
});

// ── degraded fleet: one claw down while the floor is still met ───────────────
// The label-floor alert only fires at ZERO online, so claw-3 sat offline for a
// full day and nothing ever said so. These pin the first-node-down signal —
// and, just as importantly, that it stays QUIET afterwards.

// Every claw in the fixture manifest is EPHEMERAL, as in production, so a
// claw's liveness here is the fast loop's probe — its listing entries are JIT
// registrations that read `offline` around every job (2026-10-22, claw-8).
// The listing still decides for a STANDING node, and hokon is the one there is.

/** The fast loop's view: every fixture claw reachable except `down`. */
function probeClaws(down: string[] = []): void {
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: Object.fromEntries(
			['claw-1', 'claw-3'].map((n) => [n, { reachable: !down.includes(n), free: 1, sick: false }])
		),
	} as never);
}

/** claw-1 online and carrying every floor label, so the floor holds and only
 *  the node-offline check speaks; claw-3 a JIT registration in `jit` state. */
const jitListing = (jit: string) => ({
	runners: [
		{
			name: 'claw-1',
			status: 'online',
			busy: false,
			labels: [...clawLabels(), ...hokonLabels().slice(1)],
		},
		{
			name: 'jit-claw-3-hadoku_site-j2-r1-1792638584',
			status: jit,
			busy: false,
			labels: clawLabels(),
		},
		{ name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
	],
});

test('runner-health: an unreachable claw is SILENT on the first tick (reboot/blip)', async () => {
	probeClaws(['claw-3']);
	installFetch({ runners: jitListing('online') });
	await tick('tok');
	assert.deepEqual(offlineAlerts(), [], 'one tick offline is a blip, not an incident');
});

test('runner-health 2026-10-22: an OFFLINE JIT registration on a reachable claw is not a dead node', async () => {
	// claw-8 was written up "OFFLINE for 20 min" at 03:16Z while it minted
	// and ran a job every few minutes: two ticks each caught a JIT runner
	// between its mint and its listener connecting, or after its job.
	probeClaws();
	for (let i = 0; i < 4; i++) {
		installFetch({ runners: jitListing('offline') });
		await tick('tok');
	}
	assert.deepEqual(offlineAlerts(), [], 'a JIT registration is not the box');
});

test('runner-health: a dead claw is ONE ledger line, and does not ring the channel', async () => {
	probeClaws(['claw-3']);
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	installFetch({ runners: jitListing('offline') });
	await tick('tok');

	const alerts = offlineAlerts();
	assert.equal(alerts.length, 1, alerts.join(' | '));
	assert.match(alerts[0]!, /`claw-3` OFFLINE for 20 min/);
	assert.match(alerts[0]!, /nothing is queuing/);
	// 24 of the 114 runner-health pings in the fifteen days to 2026-08-28 were
	// this condition announcing that redundancy had done its job.
	assert.equal(
		discordPosts.filter((m) => m.includes('OFFLINE for')).length,
		0,
		'a covered box going down is a morning-read item, not a ping'
	);
});

test('runner-health: ticks down must be CONSECUTIVE — one between them that saw the node up resets it', async () => {
	probeClaws(['claw-3']);
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	probeClaws();
	installFetch({
		runners: { runners: jitListing('online').runners.filter((r) => !r.name.startsWith('jit-')) },
	});
	await tick('tok');
	probeClaws(['claw-3']);
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	assert.deepEqual(offlineAlerts(), [], 'two blips an hour apart are not 20 minutes down');
});

test('runner-health: a sustained outage backs off instead of pinging hourly forever', async () => {
	probeClaws(['claw-3']);
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	assert.equal(offlineAlerts().length, 1);

	// Six more ticks (~1h of real time) with no clock advance: the ladder must
	// hold it at one message. Before the backoff this produced a message an hour
	// forever, which is what actually spammed the channel on 2026-08-15.
	for (let i = 0; i < 6; i++) {
		installFetch({ runners: jitListing('offline') });
		await tick('tok');
	}
	assert.equal(offlineAlerts().length, 1, 'still one — the re-alert is not due yet');
});

test('runner-health: a returning claw clears, so the next outage alerts immediately', async () => {
	probeClaws(['claw-3']);
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	assert.equal(offlineAlerts().length, 1);

	probeClaws();
	installFetch({ runners: jitListing('online') });
	await tick('tok');
	assert.equal(offlineAlerts().length, 1, 'recovery is silent');

	probeClaws(['claw-3']);
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	installFetch({ runners: jitListing('offline') });
	await tick('tok');
	assert.equal(offlineAlerts().length, 2, 'a fresh outage is not swallowed by the backoff');
});

/** A STANDING node's two instances — hokon and its twin — with claw-1 online
 *  carrying every floor label, so the floor holds while hokon is down. */
const hokonTwins = (a: string, b: string) => ({
	runners: [
		{
			name: 'claw-1',
			status: 'online',
			busy: false,
			labels: [...clawLabels(), ...hokonLabels().slice(1)],
		},
		{ name: 'hokon', status: a, busy: false, labels: hokonLabels() },
		{ name: 'hokon-tenhands', status: b, busy: false, labels: hokonLabels() },
	],
});

test('runner-health: a dead STANDING node is ONE message naming every instance', async () => {
	probeClaws();
	installFetch({ runners: hokonTwins('offline', 'offline') });
	await tick('tok');
	installFetch({ runners: hokonTwins('offline', 'offline') });
	await tick('tok');
	const alerts = offlineAlerts();
	assert.equal(alerts.length, 1, alerts.join(' | '));
	assert.match(alerts[0]!, /`hokon` \(hokon, hokon-tenhands\) OFFLINE/);
});

test('runner-health: one instance down while its twin serves is NOT a dead node', async () => {
	// That is a runner fault, not a box needing hands, and the label floor
	// already answers the capacity question.
	probeClaws();
	installFetch({ runners: hokonTwins('offline', 'online') });
	await tick('tok');
	installFetch({ runners: hokonTwins('offline', 'online') });
	await tick('tok');
	assert.deepEqual(offlineAlerts(), [], 'half a node is not a node outage');
});

test('runner-health: a full claw outage does NOT double-page per node', async () => {
	// Every claw down trips the backstop (which pages on its own) and sets
	// `floorAlreadyBreached` via `clawsOnline === 0`. A second message per dead
	// box for one root cause is the noise this guard exists to prevent.
	const allDown = () => ({
		runners: [
			{ name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			{ name: 'claw-3', status: 'offline', busy: false, labels: clawLabels() },
			{ name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
		],
	});
	installFetch({ runners: allDown() });
	await tick('tok');
	installFetch({ runners: allDown() });
	await tick('tok');
	// Asserted against the LEDGER, not against Discord. The per-node notice is
	// a quiet record — its only producer is `quietRecorder`, which this harness
	// routes to `quietRecords` — so checking `discordPosts` for it was vacuously
	// true and had been since the ledger conversion. Deleting the suppression
	// entirely would not have failed it.
	assert.deepEqual(
		offlineAlerts(),
		[],
		`no per-node degraded alert during a floor breach; got: ${offlineAlerts().join(' | ')}`
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
 * Escalation order is claws → hokon → GitHub-hosted, and hosted is genuinely
 * LAST. It costs billed minutes on 12 private repos, and a hosted runner cannot
 * reach the vault — the fetch returns a CF challenge, which is what broke
 * auto-format on 2026-08-17. So an all-claws-down outage must land on the hokon
 * pool and stay off hosted for as long as that pool can serve.
 */
test('tiers: all claws down but hokon pool online → promotes hokon, does NOT go hosted', async () => {
	installFetch({
		runners: {
			runners: [
				// Every claw dark.
				{ id: 1, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
				{ id: 2, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				// hokon + its idle backstop instances.
				{ id: 10, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{
					id: 11,
					name: 'hokon-b',
					status: 'online',
					busy: false,
					labels: [{ name: 'hokon-backstop' }],
				},
			],
		},
	});

	await tick('tok');

	// The whole pool is promoted, not just hokon — one slot would serialise the
	// entire fleet's CI behind a single job.
	assert.equal(labelPostBodies.length, 2, 'hokon AND hokon-b are promoted');
	for (const body of labelPostBodies) {
		assert.deepEqual(body, ['hadoku-builder']);
	}
	// Tier 3 must NOT engage while tier 2 is serving.
	//
	// The assertion is on the VALUE, not on whether a write happened. Since
	// 2026-08-30 the fleet branch WRITES the fleet target rather than deleting
	// the variable — that is what lets 107 workflows drop their own
	// `|| '["self-hosted","hadoku-builder"]'` fallback. So "no PATCH at all"
	// would now fail for the right behaviour; only a write carrying
	// ubuntu-latest is the flip this test exists to forbid.
	const flips = variableOps.filter(
		(o) => (o.startsWith('PATCH') || o.startsWith('POST')) && o.includes('ubuntu-latest')
	);
	assert.deepEqual(flips, [], 'hokon can serve, so the fleet must stay off hosted runners');
});

/**
 * Host-side supervision — the class the GitHub API structurally cannot report.
 *
 * A listener that has escaped its systemd unit still answers GitHub, so the
 * runner reads ONLINE while nothing will ever restart it. Nine runners sat that
 * way across three claws for three days in August 2026 with every existing
 * alert (label floor, queued, hung) green, because all of them ask GitHub.
 */
test('runner-health: supervision problems alert, one per broken runner', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: hokonPromotedLabels() }],
		},
	});
	__setSupervisionCheckerForTesting(async () => ({
		nodes: ['claw-2'],
		unreachable: [],
		listenersSeen: 25,
		problems: [
			{
				node: 'claw-2',
				dir: 'actions-runner-hadoku-study',
				kind: 'orphan' as const,
				listeners: 1,
				scope: 'system' as const,
				unit: 'actions.runner.WolffM-hadoku-study.claw-2.service',
				unitState: 'inactive',
			},
			{
				node: 'claw-2',
				dir: 'actions-runner-hadoku-rally',
				kind: 'duplicate' as const,
				listeners: 2,
				scope: 'system' as const,
				unit: 'actions.runner.WolffM-hadoku-rally.claw-2.service',
				unitState: 'active',
			},
		],
	}));

	await tick('tok');

	const sup = discordPosts.filter((p) => /runner supervision/.test(p));
	// One alert PER broken runner, not one collapsed summary: a whole claw
	// going wrong must not look like a single runner going wrong.
	assert.equal(sup.length, 2);
	assert.ok(sup.some((p) => /hadoku-study/.test(p) && /ONLINE/.test(p)));
	assert.ok(sup.some((p) => /hadoku-rally/.test(p) && /2 listeners/.test(p)));
});

test('runner-health: a clean supervision report says nothing', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: hokonPromotedLabels() }],
		},
	});
	__setSupervisionCheckerForTesting(async () => ({
		nodes: ['claw-1', 'claw-2', 'claw-3'],
		unreachable: [],
		listenersSeen: 66,
		problems: [],
	}));

	await tick('tok');
	assert.equal(discordPosts.filter((p) => /runner supervision/.test(p)).length, 0);
});

test('runner-health: a failing supervision probe never breaks the tick', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: hokonPromotedLabels() }],
		},
	});
	__setSupervisionCheckerForTesting(() => Promise.reject(new Error('ssh exploded')));

	// The probe is an ADDITION to a monitor that already had jobs to do; it must
	// never turn "could not reach a claw over ssh" into a dead runner-health tick.
	await assert.doesNotReject(() => tick('tok'));
});

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

// --- failure arms of the write paths (2026-08-30) --------------------------
//
// `labelStatus` and `rerunStatus` were declared in installFetch and used by no
// test, so the arms they exist for had never executed: a promote that GitHub
// refuses, and a rerun POST that fails. Both are the "we tried and could not"
// case, and in both the correct behaviour is to stay quiet and leave the state
// untouched rather than claim success.

test('backstop: a promote GitHub REFUSES is not recorded as promoted', async () => {
	// A token that has lost runner-admin still lists runners fine, so the monitor
	// reaches the write and gets a 403. It must not count that as a promotion —
	// the next tick has to try again, and the 🔻 must not claim hokon is serving.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
				{ id: 2, name: 'claw-2', status: 'offline', busy: false, labels: clawLabels() },
				{ id: 10, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
			],
		},
		labelStatus: 403,
	});
	await tick('tok');

	assert.ok(
		labelOps.some((o) => o.startsWith('POST')),
		'the promote must be ATTEMPTED — otherwise this test proves nothing'
	);
	assert.ok(
		!discordPosts.some((p) => /promoted/.test(p) && /so jobs still have somewhere to run/.test(p)),
		`a refused promote must not announce that hokon is serving; got: ${discordPosts.join(' | ')}`
	);
});

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

// ── CI_RUNNER write failures are a FINDING, not a log line ──────────────────
//
// `fb.failed` reached nothing but `logger.warn`, so a repo whose variable could
// not be written retried every 10 minutes forever and said so only into a log
// nobody tails. With the bare `runs-on: ${{ fromJSON(vars.CI_RUNNER) }}` form,
// a repo that never got its value has runs-on resolve to NOTHING and every
// workflow in it fails to start.

/** All claws healthy — the fleet branch, which writes CI_RUNNER too. */
function healthyFleet() {
	return {
		runners: {
			runners: [
				{ id: 1, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
				{ id: 2, name: 'claw-2', status: 'online', busy: false, labels: clawLabels() },
			],
		},
	};
}

test('a CI_RUNNER write failure does NOT page on the first tick', async () => {
	// Same debounce as the label floor, for the same reason: a 502 from GitHub's
	// control plane is not worth waking anyone, a revoked token scope is.
	installFetch({ ...healthyFleet(), variableStatus: 500 });
	await tick('tok');
	assert.ok(
		!discordPosts.some((p) => /CI_RUNNER/.test(p) && /could not be written/.test(p)),
		`one failed tick must debounce, got: ${JSON.stringify(discordPosts)}`
	);
});

test('a SUSTAINED CI_RUNNER write failure pages, naming the repo and the consequence', async () => {
	installFetch({ ...healthyFleet(), variableStatus: 500 });
	await tick('tok');
	await tick('tok');
	const alert = discordPosts.find((p) => /could not be written/.test(p));
	assert.ok(alert, `two failed ticks must page, got: ${JSON.stringify(discordPosts)}`);
	// Names the affected repo(s) and how many. ONE message, not one per repo:
	// a revoked token covers the whole roster, and 26 pages for one cause is the
	// noise this file refuses to send elsewhere.
	assert.match(alert, /WolffM\//, 'names at least one affected repo');
	assert.match(alert, /could not be written on \d+ repo\(s\)/, 'reports the count');
	const alerts = discordPosts.filter((p) => /could not be written/.test(p));
	assert.equal(alerts.length, 1, `one summary alert, got ${alerts.length}`);
	// The consequence is the whole point: "a variable did not write" is not
	// actionable, "that repo's workflows will not start" is.
	assert.match(alert, /FAIL TO START/);
	assert.match(alert, /actions:write/, 'names the usual cause');
});

test('a write that SUCCEEDS never pages, however many ticks run', async () => {
	// The guard must be silent on the ordinary path, or it is noise that gets
	// muted — and a muted alert is worse than none.
	installFetch(healthyFleet());
	await tick('tok');
	await tick('tok');
	await tick('tok');
	assert.ok(
		!discordPosts.some((p) => /could not be written/.test(p)),
		`a healthy write must stay silent, got: ${JSON.stringify(discordPosts)}`
	);
});

test('recovery clears the count, so a later failure debounces again', async () => {
	// Proves the clear path is real. Without it the count only ever grows, and
	// the NEXT single blip — months later — pages instantly off a stale tally.
	installFetch({ ...healthyFleet(), variableStatus: 500 });
	await tick('tok');
	globalThis.fetch = originalFetch;
	installFetch(healthyFleet()); // recovered
	await tick('tok');
	globalThis.fetch = originalFetch;
	installFetch({ ...healthyFleet(), variableStatus: 500 }); // fails again, once
	await tick('tok');
	assert.ok(
		!discordPosts.some((p) => /could not be written/.test(p)),
		`the recovery must reset the debounce, got: ${JSON.stringify(discordPosts)}`
	);
});

test('the failure count reaches the digest, not just the channel', async () => {
	// The daily ci-digest reads the job sink. A finding only the Discord channel
	// ever saw is one nobody can review after the fact.
	installFetch({ ...healthyFleet(), variableStatus: 500 });
	await tick('tok');
	const reported = jobSinkPosts.some((p) => {
		const d = (p.data ?? {}) as Record<string, unknown>;
		return typeof d.ci_runner_write_failed === 'number' && d.ci_runner_write_failed > 0;
	});
	assert.ok(reported, `the count must reach the sink, got: ${JSON.stringify(jobSinkPosts)}`);
});

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
		await new Promise((r) => setTimeout(r, resetAtSec * 1000 - Date.now() + 200));
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

// --- The persisted snapshot ---
//
// Optional half of the same fix: a restarted process serves the previous
// process's last census, dated as it was, until its own first tick replaces it.

test('snapshot: a restarted process serves the last persisted census, dated as it was', async () => {
	installFetch({ runners: FLEET_ALL_UP });
	await tick('tok');
	const live = getRunnerHealthSnapshot();
	assert.ok(live, 'the tick produced a snapshot');
	// Forget the in-memory copy, as a restart does. The file is all that is left.
	__resetRunnerHealthAlertsForTesting();
	const restored = getRunnerHealthSnapshot();
	assert.deepEqual(restored, JSON.parse(JSON.stringify(live)), 'the file round-trips the census');
	assert.equal(restored?.at, live.at, 'stamped with ITS time, not re-stamped to now');
	// And a live tick replaces it.
	await tick('tok');
	assert.notEqual(getRunnerHealthSnapshot(), restored, 'the next tick replaces the restored copy');
});

test('snapshot: a census older than the restore window is not served', async () => {
	installFetch({ runners: FLEET_ALL_UP });
	await tick('tok');
	const stale = {
		...getRunnerHealthSnapshot(),
		at: new Date(Date.now() - SNAPSHOT_RESTORE_MAX_AGE_MS - 60_000).toISOString(),
	};
	writeFileSync(snapshotPath, JSON.stringify(stale));
	__resetRunnerHealthAlertsForTesting();
	assert.equal(
		getRunnerHealthSnapshot(),
		null,
		'an hour-old census is not a better answer than "not measured yet"'
	);
});

test('snapshot: a corrupt or malformed file restores nothing', () => {
	writeFileSync(snapshotPath, '{not json');
	assert.equal(getRunnerHealthSnapshot(), null, 'unparseable');
	__resetRunnerHealthAlertsForTesting();
	writeFileSync(snapshotPath, JSON.stringify({ at: new Date().toISOString() }));
	assert.equal(getRunnerHealthSnapshot(), null, 'parseable but not a snapshot');
});

test('backstop: a demote that finds the label ALREADY GONE is converged, not failed', async () => {
	// The tier ladder strips hokon's builder label on its own first pass after a
	// restart, at the same moment the first tick here converges the fleet. The
	// DELETE then 404s. That is the desired state, so it must settle
	// backstopFleetState — a "failure" here forced a second full converge on
	// the next tick and logged that the repo would queue, which it would not.
	__setFleetReposForTesting(['WolffM/hadoku_site', 'WolffM/hadoku-rally']);
	installFetch({
		runners: (repo) =>
			repo === 'WolffM/hadoku-rally'
				? {
						runners: [
							{ id: 1, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
							{ id: 2, name: 'claw-2', status: 'online', busy: false, labels: clawLabels() },
							{
								id: 10,
								name: 'hokon',
								status: 'online',
								busy: false,
								labels: hokonPromotedLabels(),
							},
						],
					}
				: FLEET_ALL_UP,
		labelDeleteStatus: 404,
	});
	await tick('tok');
	assert.ok(
		labelOps.some((o) => o.startsWith('DELETE') && o.includes('hadoku-rally')),
		'the demote must be ATTEMPTED on the child repo — otherwise this proves nothing'
	);
	assert.ok(
		!discordPosts.some((p) => /queue until/.test(p)),
		`a label that is already gone is not a repo that will queue; got: ${discordPosts.join(' | ')}`
	);

	// Settled: the next tick must not converge the fleet again.
	runnerListings.length = 0;
	await tick('tok');
	assert.ok(
		!runnerListings.includes('WolffM/hadoku-rally'),
		'a converged fleet is not re-read every tick — the 404 must have counted as done'
	);
});

test('backstop: the restart converge reads the fleet concurrently, bounded by SWEEP_CONCURRENCY', async () => {
	// A new process has backstopFleetState = null, so its first tick converges
	// every child repo — one runner listing each. Read one after another, that
	// was ~12s of the first tick after every restart.
	const repos = ['WolffM/hadoku_site', ...sweepRepos(2 * SWEEP_CONCURRENCY)];
	__setFleetReposForTesting(repos);
	let inFlight = 0;
	let peak = 0;
	installFetch({
		runners: FLEET_ALL_UP,
		runnersGate: async (repo) => {
			if (repo === 'WolffM/hadoku_site') return; // the label floor's own read
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
		},
	});
	await tick('tok');
	const converged = runnerListings.filter((r) => r !== 'WolffM/hadoku_site');
	assert.equal(
		new Set(converged).size,
		2 * SWEEP_CONCURRENCY,
		'every child repo was read by the converge pass — otherwise the peak means nothing'
	);
	assert.equal(peak, SWEEP_CONCURRENCY, 'listings in flight at the peak');
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
test('an UNMEASURED probe must not pin CI_RUNNER — a restart is not an outage', async () => {
	// Exactly the shape that DOES flip when measured: claws down, hokon down.
	// The only difference from the total-outage test above is that we never
	// looked, and that difference alone must change the decision.
	__setFleetProbeForTesting(null);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'offline', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
	});

	await tick('tok');

	const writes = variableOps.filter((o) => o.startsWith('PATCH') || o.startsWith('POST'));
	assert.equal(
		writes.length,
		0,
		`an unmeasured tick must write no CI_RUNNER at all, got: ${JSON.stringify(writes)}`
	);
});

test('once the probe exists, the same dark fleet DOES flip — holding is one tick, not forever', async () => {
	// The negative half. A hold that never releases is just an outage the fleet
	// cannot escape, so the very next tick with a snapshot must decide normally.
	__setFleetProbeForTesting(null);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'offline', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
	});
	await tick('tok');
	assert.equal(variableOps.filter((o) => /PATCH|POST/.test(o)).length, 0, 'held');

	// The fast loop has now run: we LOOKED, and the claws really are down.
	variableOps.length = 0;
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: { 'claw-1': { reachable: false, free: 0, sick: false } },
	} as never);
	await tick('tok');

	const writes = variableOps.filter((o) => o.startsWith('PATCH') || o.startsWith('POST'));
	assert.ok(writes.length > 0, 'a MEASURED total outage must still reach hosted');
	for (const w of writes) assert.match(w, /CI_RUNNER/);
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

// ── starvation finding (wave 4a, #100) ───────────────────────────────────────
//
// claw-6 and claw-2 were refused by the memory clause on every tick for days,
// and nothing recorded it. `checkStarvation` reads `ephemeral-tick.ts`'s own
// generic admission verdict (injected here through its test seam — driving
// the real `dispatchEphemeral` end to end is `warm-cache.test.ts`'s job) and
// job history already written by the suite's normal fixtures.

function writeJobRecord(r: Partial<Record<string, unknown>>) {
	appendFileSync(
		historyFile(),
		JSON.stringify({
			repo: 'WolffM/hadoku_site',
			runId: 1,
			jobId: Math.floor(Math.random() * 1e9),
			name: 'check',
			runner: 'claw-1',
			labels: ['self-hosted', 'hadoku-builder'],
			startedAt: new Date().toISOString(),
			durationSec: 60,
			conclusion: 'success',
			...r,
		}) + '\n'
	);
}

/** claw-6's real numbers from the wave 4a writeup (docs/planning/wave4a-2026-10-06.md). */
const CLAW6_MEMORY_REFUSAL: AdmissionVerdict = {
	ok: false,
	clause: 'memory',
	availableMb: 4813,
	needMb: 5632,
	reserveBasis: 'node',
	reason:
		'memory: 4813MB free, this repo peaks at 5632MB, would leave -819MB against a 1536MB floor',
};

/** Comfortably past STARVED_NO_JOB_MS, whatever its current value. */
const WELL_PAST_STARVED_MS = STARVED_NO_JOB_MS + 60 * 60_000;

const starvedPings = () => discordPosts.filter((m) => m.includes('claw-6') && m.includes('MEMORY'));

test('starved: a claw refused on MEMORY for hours while another claw worked is a finding, and pages once', async () => {
	writeJobRecord({ runner: 'claw-1', startedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
	assert.equal(starvedPings().length, 1);
	assert.match(starvedPings()[0]!, /4813MB/);
	assert.match(starvedPings()[0]!, /5632MB/);
	assert.match(starvedPings()[0]!, /basis: node/);

	await tick('tok');
	assert.equal(starvedPings().length, 1, 'not every tick — RE_ALERT_MS dedupes');
});

/** #101: refused for want of `/tmp` space, not memory. */
const CLAW6_SPACE_REFUSAL: AdmissionVerdict = {
	ok: false,
	clause: 'space',
	availableMb: 300,
	needMb: 2048,
	filesystem: 'tmp',
	reserveBasis: 'node',
	reason: 'space: /tmp has 300MB free, under the 2048MB floor',
};

test('starved: a claw refused on SPACE for hours is a finding too, named as SPACE and never "on hokon"', async () => {
	writeJobRecord({ runner: 'claw-1', startedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_SPACE_REFUSAL]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
	const pings = discordPosts.filter((m) => m.includes('claw-6') && m.includes('SPACE'));
	assert.equal(pings.length, 1);
	assert.match(pings[0]!, /300MB free on \/tmp/);
	assert.match(pings[0]!, /2048MB floor/);
	// THE WORDING FIX (#101 send-back): the reporter is named, never read as
	// the refused node's location — "starved on hokon: claw-6" would say
	// claw-6 lives on hokon, which is false.
	assert.doesNotMatch(pings[0]!, /starved[^(]*on `?hokon/i);
	assert.match(pings[0]!, /reported by/i);
});

/** #101: the free space on `/tmp` could not be read at all — `availableMb`
 *  is a placeholder `0`, not a measurement. */
const CLAW6_SPACE_UNREADABLE: AdmissionVerdict = {
	ok: false,
	clause: 'space',
	availableMb: 0,
	needMb: 2048,
	filesystem: 'tmp',
	unreadable: true,
	reserveBasis: 'node',
	reason: 'space: could not read /tmp free space',
};

test('starved (d): an UNREADABLE space verdict says it could not read free space, and never prints an "…MB free" figure', async () => {
	writeJobRecord({ runner: 'claw-1', startedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_SPACE_UNREADABLE]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
	const pings = discordPosts.filter((m) => m.includes('claw-6') && m.includes('SPACE'));
	assert.equal(pings.length, 1);
	assert.match(pings[0]!, /could not read/i);
	assert.doesNotMatch(pings[0]!, /\d+MB free/);
});

test('starved: the same claw with an IDLE FLEET is not a finding', async () => {
	// No other claw has run anything, and the queue is empty (installFetch
	// defaults `runs` to an empty listing) — no evidence of demand.
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], false);
	assert.equal(starvedPings().length, 0);
});

test('starved: a DRAINED node’s clause is never read as starved, even with demand and an old job', async () => {
	writeJobRecord({ runner: 'claw-1', startedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	__setAdmissionVerdictsForTesting(
		new Map([
			[
				'claw-6',
				{
					ok: false,
					clause: 'drained',
					availableMb: 0,
					needMb: 0,
					reserveBasis: 'default',
					reason: 'drained: held out of service for maintenance',
				},
			],
		])
	);
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], false);
	assert.equal(discordPosts.filter((m) => m.includes('claw-6')).length, 0);
});

test('starved: a node at its CONCURRENCY cap (not memory) is never read as starved', async () => {
	// Same shape as the drained case — a non-memory clause must never satisfy
	// (a), however long it has been idle or however busy the rest of the fleet
	// is. Also covers a slow-tier node held by the #83 spill gate: that hold is
	// a PLACEMENT refusal `admitMint` never sees, so a spill-held node reads
	// `ok: true` here, which this same assertion shape (clause !== 'memory')
	// already proves is never starved.
	writeJobRecord({ runner: 'claw-1', startedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	__setAdmissionVerdictsForTesting(
		new Map([
			[
				'claw-6',
				{
					ok: false,
					clause: 'concurrency',
					availableMb: 0,
					needMb: 0,
					reserveBasis: 'default',
					reason: 'at capacity: 2/2 in flight',
				},
			],
		])
	);
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], false);
});

test('starved: an admitted verdict does NOT re-arm the page — only a job actually starting clears it', async () => {
	// claw-6 measured 2026-10-06 04:00Z: it sits AT the admission line and
	// flips between `ok` and memory-refused from one tick to the next with no
	// job ever landing. Clearing on every `ok` tick would re-page every
	// ~10 minutes instead of at most once an hour (RE_ALERT_MS) — the exact
	// regression this test pins.
	const base = Date.now();
	const real = Date.now;
	try {
		Date.now = () => base;
		writeJobRecord({ runner: 'claw-1', startedAt: new Date(base - 5 * 60_000).toISOString() });
		writeJobRecord({
			runner: 'claw-6',
			startedAt: new Date(base - WELL_PAST_STARVED_MS).toISOString(),
		});
		__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
		installFetch({ runners: LIVE_LISTING });

		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
		assert.equal(starvedPings().length, 1);

		// Admission flips to admitted for one tick. No job ran.
		Date.now = () => base + 60_000;
		__setAdmissionVerdictsForTesting(new Map([['claw-6', { ok: true }]]));
		await tick('tok');
		assert.equal(
			getRunnerHealthSnapshot()?.starved?.['claw-6'],
			false,
			'the PANEL stops showing it'
		);
		assert.equal(starvedPings().length, 1, 'but the LEDGER must not be touched — no job ran');

		// Flips back to memory-refused. Still well inside RE_ALERT_MS (1h), and
		// the ledger was never cleared, so this must NOT re-page.
		Date.now = () => base + 120_000;
		__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
		assert.equal(
			starvedPings().length,
			1,
			'the same finding — a bare admission flip never re-arms the page'
		);

		// A job ACTUALLY starts on claw-6. The starvation genuinely ended.
		// `jobRecords()` loads the file exactly ONCE per process (`loadHistory`'s
		// own `if (loaded) return`) — the first `tick()` above already took that
		// snapshot, so a record appended straight to disk needs a forced reload
		// or this write is invisible for the rest of the test, same trap
		// `__setHistoryPathForTesting`'s own doc comment warns about.
		Date.now = () => base + 180_000;
		writeJobRecord({ runner: 'claw-6', startedAt: new Date(base + 180_000).toISOString() });
		__resetJobHistoryForTesting();
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], false);

		// Starved again, well past the threshold measured from that real job.
		// Demand evidence has to move WITH the window: claw-6's own idle window
		// now starts at its real job (base+180s), so claw-1's job from the very
		// top of the test (base-5min) is before that window and no longer
		// counts — a fresh claw-1 job inside the new window is what an idle
		// fleet actually looks like here.
		Date.now = () => base + 180_000 + WELL_PAST_STARVED_MS;
		writeJobRecord({
			runner: 'claw-1',
			startedAt: new Date(base + 180_000 + 5 * 60_000).toISOString(),
		});
		__resetJobHistoryForTesting();
		__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
		assert.equal(
			starvedPings().length,
			2,
			'the REAL job cleared the ledger, so this re-pages immediately rather than waiting RE_ALERT_MS'
		);
	} finally {
		Date.now = real;
	}
});

test('starved: the idle-fleet branch does not clear the alert either — only a real job does', async () => {
	// Demand here rides the QUEUE rather than another claw, deliberately: once
	// a FIXED job record falls inside claw-6's idle window, it never ages back
	// out (the window's start is claw-6's own last job, which does not move
	// forward on its own), so a job-record-only fixture cannot toggle `othersActive`
	// from true to false across ticks. The queue can.
	const base = Date.now();
	const real = Date.now;
	const queuedRun = (id: number, atMs: number) => ({
		workflow_runs: [
			{
				id,
				status: 'queued',
				conclusion: null,
				created_at: new Date(atMs).toISOString(),
				html_url: `https://gh/run/${id}`,
				display_title: 'queued thing',
			},
		],
	});
	try {
		Date.now = () => base;
		writeJobRecord({
			runner: 'claw-6',
			startedAt: new Date(base - WELL_PAST_STARVED_MS).toISOString(),
		});
		__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
		installFetch({ runners: LIVE_LISTING, runs: queuedRun(1, base) });

		await tick('tok');
		assert.equal(
			getRunnerHealthSnapshot()?.starved?.['claw-6'],
			true,
			'a non-empty queue is demand too'
		);
		assert.equal(starvedPings().length, 1);

		// The queue drains. No demand at all now — an idle fleet.
		Date.now = () => base + 60_000;
		installFetch({ runners: LIVE_LISTING });
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], false);
		assert.equal(
			starvedPings().length,
			1,
			'idle fleet — not a finding, but no job ran on claw-6 either'
		);

		// Demand returns, well inside RE_ALERT_MS. If the idle-fleet tick above
		// had cleared the ledger, this would re-page immediately; it must not,
		// because the claw-6 starvation itself never actually ended.
		Date.now = () => base + 120_000;
		installFetch({ runners: LIVE_LISTING, runs: queuedRun(2, base + 120_000) });
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
		assert.equal(
			starvedPings().length,
			1,
			'the idle-fleet tick must not have cleared the ledger — still the same finding'
		);
	} finally {
		Date.now = real;
	}
});

test('starved: an ABSENT verdict carries the previous reading forward and never clears or re-fires the alert', async () => {
	writeJobRecord({ runner: 'claw-1', startedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
	assert.equal(starvedPings().length, 1);

	// Simulate the restart's blind window: `ephemeral-tick.ts` has not ticked
	// yet this process, so there is no verdict for claw-6 at all — "could not
	// look", never "admitted".
	__resetAdmissionVerdictsForTesting();
	await tick('tok');
	assert.equal(
		getRunnerHealthSnapshot()?.starved?.['claw-6'],
		true,
		'could not look this tick — the previous finding carries forward'
	);
	assert.equal(
		starvedPings().length,
		1,
		'no new post — a tick that learned nothing must not touch the alert ledger'
	);

	// Restore the SAME refusal. The ledger was never cleared while absent, so
	// this must stay inside RE_ALERT_MS rather than re-firing.
	__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
	await tick('tok');
	assert.equal(
		starvedPings().length,
		1,
		'the ledger was untouched while the verdict was absent — this is still the same finding'
	);
});

test('starved: a restart (fresh alert ledger, no verdict yet) finds it from job history alone the moment a verdict lands', async () => {
	writeJobRecord({ runner: 'claw-1', startedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	// A restart: the alert ledger AND the verdict snapshot both start empty —
	// no accumulated module state to wait out.
	__resetRunnerHealthAlertsForTesting();
	__resetAdmissionVerdictsForTesting();
	// The first post-restart `ephemeral-tick` pass has now landed.
	__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(
		getRunnerHealthSnapshot()?.starved?.['claw-6'],
		true,
		'found on the FIRST tick — from persisted job history, not accumulated module state'
	);
	assert.equal(starvedPings().length, 1);
});

// ── disk-watch finding (wave 4c §F, the operator's disk ask 2026-10-07) ─────
//
// An early warning on the `_work` filesystem, read from `disk-watch.ts`'s own
// registry (injected here through its test seam — the real `ephemeral-tick.ts`
// hunk that fills it in production lands after lane A and is not under test
// here, same split `checkStarvation` already draws against
// `__setAdmissionVerdictsForTesting`).

const diskPings = (level: 'advisory' | 'page' | 'unreadable') =>
	discordPosts.filter(
		(m) => m.includes('claw-6') && m.includes('**disk**') && pingMatches(m, level)
	);

function pingMatches(m: string, level: 'advisory' | 'page' | 'unreadable'): boolean {
	// Matched on the leading emoji, not a phrase — the advisory message itself
	// names the page line it has not yet crossed ("before it crosses the 10GB
	// page line"), so a text match on "page line" alone would also catch an
	// advisory post.
	if (level === 'unreadable') return m.startsWith('🥀 **disk**');
	if (level === 'page') return m.startsWith('🔥 **disk**');
	return m.startsWith('⚠️ **disk**');
}

test('disk-watch: a node under the advisory line is advisory, and pages once', async () => {
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 20 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'advisory');
	assert.equal(diskPings('advisory').length, 1);
	assert.match(diskPings('advisory')[0]!, /20GB free/);
	assert.match(diskPings('advisory')[0]!, /25GB advisory line/);

	await tick('tok');
	assert.equal(diskPings('advisory').length, 1, 'not every tick — RE_ALERT_MS dedupes');
});

test('disk-watch 2026-10-21: /tmp under the mint floor pages even with _work wide open, and names the floor', async () => {
	// hokon's shape that night: 370 GB free on the disk, 1.7 GB on the tmpfs.
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 1718, workFreeMb: 370 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'page', 'the worse of the two');
	const page = diskPings('page');
	assert.equal(page.length, 1);
	assert.match(page[0]!, /\/tmp has 1\.7GB free/);
	assert.match(page[0]!, /2048MB mint floor/);
	assert.doesNotMatch(page[0]!, /pm2-host deploys/, 'a claw loses CI, not deploys');

	await tick('tok');
	assert.equal(diskPings('page').length, 1, 'once');
});

test('disk-watch #132: a small, nearly empty /tmp is not a repeating advisory — the size is said once, filling still pages', async () => {
	// claw-6's shape: a 3994MB tmpfs with ~100MB used.
	__setDiskReadingsForTesting(
		new Map([['claw-6', { tmpFreeMb: 3900, tmpSizeMb: 3994, workFreeMb: 189 * 1024 }]])
	);
	installFetch({ runners: LIVE_LISTING });
	const capacity = () =>
		discordPosts.filter((m) => m.startsWith('ℹ️ **disk**') && m.includes('`claw-6`'));

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'ok');
	assert.equal(diskPings('advisory').length, 0, 'no leak warning for space that was never there');
	assert.equal(capacity().length, 1);
	assert.match(capacity()[0]!, /3\.9GB filesystem/);
	assert.equal(getRunnerHealthSnapshot()?.tmpSmall?.['claw-6'], 3994);

	// A restart: the persisted snapshot, not the hour-long alert ledger, is
	// what remembers the capacity fact was already said.
	__resetRunnerHealthAlertsForTesting();
	__reloadAlertLedgerForTesting();
	await tick('tok');
	await tick('tok');
	assert.equal(capacity().length, 1, 'once, not hourly');
	assert.equal(diskPings('advisory').length, 0);

	__setDiskReadingsForTesting(
		new Map([['claw-6', { tmpFreeMb: 2300, tmpSizeMb: 3994, workFreeMb: 189 * 1024 }]])
	);
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'page');
	assert.equal(diskPings('page').length, 1);
	assert.match(diskPings('page')[0]!, /\/tmp has 2\.2GB free/);
	assert.equal(capacity().length, 1);
});

test('disk-watch 2026-10-21: an on-demand guest is watched too, and its page says deploys stop', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	__setDiskReadingsForTesting(new Map([['hokon', { tmpFreeMb: 1718, workFreeMb: 370 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });
	try {
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['hokon'], 'page');
		// `diskPings` is pinned to claw-6; look for hokon's own page directly.
		const page = discordPosts.find(
			(p) => p.startsWith('🔥 **disk**') && p.includes('`hokon`') && p.includes('/tmp')
		);
		assert.ok(page, `hokon is judged: ${discordPosts.join(' | ')}`);
		assert.match(page!, /pm2-host deploys nothing else can run/);
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('disk-watch: a node under the page line pages once, not every tick', async () => {
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 5 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'page');
	assert.equal(diskPings('page').length, 1);
	assert.match(diskPings('page')[0]!, /5GB free/);
	assert.match(diskPings('page')[0]!, /10GB page line/);

	await tick('tok');
	assert.equal(diskPings('page').length, 1, 'not every tick — RE_ALERT_MS dedupes');
});

/**
 * Characterization test (F12, plan §4.1 — written against this file BEFORE
 * `alertOnce` was ported onto `createPager`, and still green after). Every
 * other `RE_ALERT_MS dedupes` test above only advances time by seconds or
 * minutes — none crosses the window itself, so none would have caught a
 * migration that silently changed the actual boundary (e.g. collapsing the
 * import to the wrong shared duration, `DAY_MS` instead of `HOUR_MS`). This
 * one does: one millisecond short of RE_ALERT_MS is still silence, and the
 * window itself is a fresh page.
 */
test('disk-watch: RE_ALERT_MS is the actual boundary, not just "some window" — one ms short is silence, the window itself re-pages', async () => {
	// A hard-coded expectation, not a derived one: this is read from the
	// export only for the boundary math below, which must still be checked
	// against the real-world number a migration could silently repoint —
	// `job-runner.ts`'s DAY_MS instead of its HOUR_MS, say.
	assert.equal(RE_ALERT_MS, 60 * 60_000, 're-pings a sustained condition at most HOURLY');
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 5 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });
	const base = Date.now();
	const real = Date.now;
	try {
		Date.now = () => base;
		await tick('tok');
		assert.equal(diskPings('page').length, 1);

		Date.now = () => base + RE_ALERT_MS - 1;
		await tick('tok');
		assert.equal(diskPings('page').length, 1, 'one ms short of the window: still suppressed');

		Date.now = () => base + RE_ALERT_MS;
		await tick('tok');
		assert.equal(diskPings('page').length, 2, 'the window itself is due');
	} finally {
		Date.now = real;
	}
});

test('disk-watch: a node back under the lines clears — the next crossing re-fires immediately', async () => {
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 5 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.equal(diskPings('page').length, 1);

	// Recovered well past both lines.
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 100 * 1024 }]]));
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'ok');

	// Crosses the page line again — fires immediately, not suppressed by the
	// earlier page's RE_ALERT_MS window.
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 5 * 1024 }]]));
	await tick('tok');
	assert.equal(diskPings('page').length, 2, 'cleared, so the re-crossing is a fresh finding');
});

test('disk-watch: an unreadable work-free reading is its own finding, never silently "ok"', async () => {
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: null }]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'unreadable');
	assert.equal(diskPings('unreadable').length, 1);

	await tick('tok');
	assert.equal(diskPings('unreadable').length, 1, 'not every tick — RE_ALERT_MS dedupes');
});

test('disk-watch: a node this tick has NO reading for carries the previous reading forward, and never touches the ledger', async () => {
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 5 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'page');
	assert.equal(diskPings('page').length, 1);

	// The registry goes empty — e.g. the producing tick has not run since a
	// restart. "Could not look" must not read as "fine".
	__resetDiskReadingsForTesting();
	await tick('tok');
	assert.equal(
		getRunnerHealthSnapshot()?.diskWatch?.['claw-6'],
		'page',
		'the PREVIOUS reading carries forward, not a reset to ok'
	);
	assert.equal(
		diskPings('page').length,
		1,
		'a tick that learned nothing must not touch the ledger'
	);
});

test('disk-watch: hokon never appears, even if a reading is injected for it', async () => {
	__setDiskReadingsForTesting(new Map([['hokon', { tmpFreeMb: 100, workFreeMb: 100 }]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(
		getRunnerHealthSnapshot()?.diskWatch?.hokon,
		undefined,
		'hokon is a guest and is never judged, however the registry reads'
	);
	assert.equal(
		discordPosts.some((m) => m.includes('hokon') && m.includes('**disk**')),
		false
	);
});

test('disk-watch: every claw is judged, not just the one under test', async () => {
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 100 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	const snap = getRunnerHealthSnapshot()?.diskWatch ?? {};
	for (const node of [
		'claw-1',
		'claw-2',
		'claw-3',
		'claw-4',
		'claw-5',
		'claw-6',
		'claw-8',
		'claw-9',
	]) {
		assert.equal(
			node in snap,
			true,
			`${node} is in the ephemeral set and must be judged every tick`
		);
	}
});

// ── node regression finding (wave 4e §B, #102) ───────────────────────────────
//
// claw-3 earned `jdk21` on a RAM floor and a tool probe, then failed five
// full cardtable `forge-e2e` jobs while every one passed on another claw
// within the hour. `node-regression.ts` holds the detection, the "real
// product red" exclusion and the injected stale-mark; these tests drive it
// through the real `tick()` call site, same split the starvation/disk-watch
// blocks above use against their own modules.

const JDK21_KIND: GatedKind = {
	capability: 'jdk21',
	repo: 'WolffM/hadoku-cardtable',
	job: 'forge-e2e',
};

/**
 * A fresh PASS, filed under whichever (node, capability) it is asked for.
 * Every regression test below injects one via `__setReadProofForTesting` so
 * none of them ever reach the real `measured.ts#readProof` — which would
 * read this suite's throwaway test-host state dir rather than a fixture the
 * test controls, the same "never a real state dir" rule the suite already
 * follows for history and snapshots.
 */
function passProofAt(atIso: string): (node: string, capability: string) => ProofRecord {
	return (node, capability) => ({
		node,
		capability,
		runId: null,
		runner: null,
		conclusion: null,
		durationSec: null,
		evidenceMatched: true,
		budgetSec: null,
		verdict: 'pass',
		why: 'fixture',
		at: atIso,
	});
}

/** Safely before every divergence timestamp `writeDivergences` ever writes. */
const FAR_PAST = new Date(0).toISOString();

/** `count` claw-3-shaped pairs: claw-3 FAILED, claw-8 PASSED, same commit, minutes apart. */
function writeDivergences(opts: { count?: number; failNode?: string; alsoFailOn?: string } = {}) {
	const failNode = opts.failNode ?? 'claw-3';
	const count = opts.count ?? 5;
	for (let i = 0; i < count; i++) {
		const sha = `${i}`.repeat(40).slice(0, 40);
		const base = Date.now() - (count - i) * 3600_000; // spread across the retained window
		writeJobRecord({
			repo: JDK21_KIND.repo,
			name: JDK21_KIND.job,
			runId: 10_000 + i,
			runner: failNode,
			conclusion: 'failure',
			headSha: sha,
			startedAt: new Date(base).toISOString(),
		});
		if (opts.alsoFailOn) {
			writeJobRecord({
				repo: JDK21_KIND.repo,
				name: JDK21_KIND.job,
				runId: 20_000 + i,
				runner: opts.alsoFailOn,
				conclusion: 'failure',
				headSha: sha,
				startedAt: new Date(base + 2 * 60_000).toISOString(),
			});
		}
		writeJobRecord({
			repo: JDK21_KIND.repo,
			name: JDK21_KIND.job,
			runId: 30_000 + i,
			runner: 'claw-8',
			conclusion: 'success',
			headSha: sha,
			startedAt: new Date(base + 10 * 60_000).toISOString(),
		});
	}
}

const regressionPings = () => discordPosts.filter((m) => m.includes('**regression**'));

test('regression: five claw-3-shaped divergences mark the proof stale and page once', async () => {
	writeDivergences();
	const marked: { node: string; capability: string }[] = [];
	__setGatedKindsForTesting([JDK21_KIND]);
	__setReadProofForTesting(passProofAt(FAR_PAST));
	__setMarkStaleForTesting((node, capability) => {
		marked.push({ node, capability });
		return { ok: true, path: '/fake', logPath: '/fake.log', written: [node] };
	});
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(marked.length, 1, 'the proof is marked stale exactly once this tick');
	assert.equal(marked[0]?.node, 'claw-3');
	assert.equal(marked[0]?.capability, 'jdk21');
	assert.equal(regressionPings().length, 1);
	assert.match(regressionPings()[0]!, /claw-3/);
	assert.match(regressionPings()[0]!, /STALE/);

	await tick('tok');
	assert.equal(regressionPings().length, 1, 'not every tick — same dedupe as starved/disk-watch');
});

test('regression: one divergence below N does not act', async () => {
	writeDivergences({ count: 4 }); // REGRESSION_THRESHOLD - 1
	__setGatedKindsForTesting([JDK21_KIND]);
	__setReadProofForTesting(passProofAt(FAR_PAST));
	let calls = 0;
	__setMarkStaleForTesting(() => {
		calls++;
		return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
	});
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.equal(calls, 0, 'four divergences is one short of the threshold');
	assert.equal(regressionPings().length, 0);
});

test('regression: a failure that ALSO failed elsewhere (a real product red) does not count', async () => {
	writeDivergences({ alsoFailOn: 'claw-9' });
	__setGatedKindsForTesting([JDK21_KIND]);
	__setReadProofForTesting(passProofAt(FAR_PAST));
	let calls = 0;
	__setMarkStaleForTesting(() => {
		calls++;
		return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
	});
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.equal(
		calls,
		0,
		'two distinct nodes failing the same commit is a product red, not claw-3 regressing'
	);
	assert.equal(regressionPings().length, 0);
});

test('regression: hokon never acts, even with five divergences of its own', async () => {
	writeDivergences({ failNode: 'hokon' });
	__setGatedKindsForTesting([JDK21_KIND]);
	__setReadProofForTesting(passProofAt(FAR_PAST));
	let calls = 0;
	__setMarkStaleForTesting(() => {
		calls++;
		return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
	});
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.equal(calls, 0, 'hokon is a guest — never proven, never canaried, never marked stale');
	assert.equal(regressionPings().length, 0);
});

test('regression: a job without a head sha never counts', async () => {
	for (let i = 0; i < 5; i++) {
		const base = Date.now() - (5 - i) * 3600_000;
		writeJobRecord({
			repo: JDK21_KIND.repo,
			name: JDK21_KIND.job,
			runId: 40_000 + i,
			runner: 'claw-3',
			conclusion: 'failure',
			startedAt: new Date(base).toISOString(),
			// no headSha
		});
		writeJobRecord({
			repo: JDK21_KIND.repo,
			name: JDK21_KIND.job,
			runId: 50_000 + i,
			runner: 'claw-8',
			conclusion: 'success',
			startedAt: new Date(base + 10 * 60_000).toISOString(),
			// no headSha
		});
	}
	__setGatedKindsForTesting([JDK21_KIND]);
	__setReadProofForTesting(passProofAt(FAR_PAST));
	let calls = 0;
	__setMarkStaleForTesting(() => {
		calls++;
		return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
	});
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.equal(calls, 0, 'no head sha, no same-commit comparison, no divergence');
	assert.equal(regressionPings().length, 0);
});

// ── manager send-back: a divergence only counts against the node's CURRENT proof ──
//
// checkNodeRegressions never consulted the node's $proof at all, so a
// re-proved node could never regain the label for the rest of the 14-day
// retention window, and a stale mark (plus its facet log line) was rewritten
// every ~10-minute tick forever. `node-regression.ts`'s `readProof`
// (injected, same pattern as `markStale`) now gates both halves.

test('regression (1): five PRE-proof divergences + a fresh pass written after them do not re-trigger', async () => {
	writeDivergences();
	// Every divergence `writeDivergences()` writes is dated in the past
	// relative to `Date.now()` (its own `base` is `Date.now() - Nh`); "now" is
	// therefore safely AFTER all of them — the tracker re-proving the node
	// AFTER the incident.
	__setGatedKindsForTesting([JDK21_KIND]);
	__setReadProofForTesting(passProofAt(new Date().toISOString()));
	let calls = 0;
	__setMarkStaleForTesting(() => {
		calls++;
		return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
	});
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.equal(calls, 0, 'a fresh proof written after the divergences retires every one of them');
	assert.equal(regressionPings().length, 0);
});

test('regression (3): the transition tick marks once; a FOLLOWING tick on the same divergences does not re-mark', async () => {
	writeDivergences();
	__setGatedKindsForTesting([JDK21_KIND]);
	// Starts PASS (FAR_PAST, i.e. before every divergence): the transition
	// tick must mark it stale. `markStale` flips the fixture's own verdict,
	// exactly as the real `markProofStale` flips the record it writes, so the
	// SECOND tick reads the state a following real tick actually would.
	let verdict: 'pass' | 'stale' = 'pass';
	__setReadProofForTesting((node, capability) => ({
		...passProofAt(FAR_PAST)(node, capability),
		verdict,
	}));
	let calls = 0;
	__setMarkStaleForTesting(() => {
		calls++;
		verdict = 'stale';
		return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
	});
	installFetch({ runners: LIVE_LISTING });

	await tick('tok'); // transition tick
	assert.equal(calls, 1, 'the transition tick marks it stale exactly once');
	assert.equal(regressionPings().length, 1);

	await tick('tok'); // following tick, same divergences still in the 14-day window
	assert.equal(
		calls,
		1,
		'a following tick over the SAME divergence set must not re-mark — already stale'
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
