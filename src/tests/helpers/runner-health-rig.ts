/**
 * Shared fixture for runner-health's tests: the fetch stub, the arrays it
 * records calls into, and the beforeEach/afterEach that resets them.
 *
 * node:test scopes beforeEach/afterEach PER FILE, so a test that moved away
 * from runner-health.test.ts without this rig would run against whatever the
 * PREVIOUS test in its new file left behind — or nothing at all. Every file
 * that ticks the monitor — runner-health.test.ts itself included — calls
 * `installRunnerHealthRig()` once at its own top level, before any `test()`
 * calls, exactly where the old inline `beforeEach`/`afterEach` used to sit.
 *
 * The exported arrays/maps are never REASSIGNED by a caller, only by this
 * module's own `beforeEach` — and they are exported as live ESM bindings
 * (`export let`), so an import of `discordPosts` always reads the CURRENT
 * array rather than the one that existed at import time. A `const` copy
 * taken once (e.g. CommonJS-style destructuring) would go stale after the
 * first reset; a live binding cannot, because ES module imports are
 * references into the exporting module's own scope, not a value copied out
 * of it.
 */
import { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir, cleanupTempDirs } from '../tmpdir.js';
import {
	__setHistoryPathForTesting,
	__resetJobHistoryForTesting,
} from '../../job-history-store.js';
import { __resetFallbackConvergenceForTesting } from '../../ci-runner-fallback.js';
import {
	__resetRunnerHealthAlertsForTesting,
	__setFleetReposForTesting,
} from '../../runner-health.js';
import { __setSnapshotPathForTesting } from '../../runner-health-snapshot.js';
import { __setSupervisionCheckerForTesting } from '../../runner-health-watch.js';
import { __setQuietRecorderForTesting } from '../../runner-health-label-floor-nodes.js';
import { __setFloorConfirmDelayForTesting } from '../../runner-health-label-floor-confirm.js';
import { __setFloorDemandForTesting } from '../../runner-health-label-floor.js';
import {
	runBackstopDecision,
	__resetBackstopDecisionForTesting,
} from '../../runners/backstop-decision.js';
import { __setReservationForTesting } from '../../runners/backstop-decision-state.js';
import {
	runHostedFallback,
	__resetHostedFallbackForTesting,
} from '../../runners/hosted-fallback.js';
import {
	setBackstopDecisionRunner,
	setHostedFallbackRunner,
	setBackstopDecisionReset,
	setHostedFallbackReset,
} from '../../runner-health-ports.js';
import { __setFleetProbeForTesting } from '../../fleet-probe-store.js';
import { __resetSickForTesting } from '../../lib/sick-node.js';
import { writeDrain } from '../../runners/drain.js';
import { __resetAdmissionVerdictsForTesting } from '../../runners/ephemeral-tick.js';
import { __setWorkloadGateContextForTesting } from '../../workload-gate-store.js';
import { __resetDiskReadingsForTesting } from '../../runners/disk-watch.js';
import { __resetNodeRegressionForTesting } from '../../runners/node-regression.js';
// Static fixture data (wave shrink-1 lane C, pure move) — re-exported below
// so every existing `from '.../helpers/runner-health-rig.js'` import of these
// names keeps working unchanged.
import { FAKE_WEBHOOK } from './runner-health-fixtures.js';

// `tick()` calls `checkLabelFloor` straight from `runner-health.js` in these
// tests — there is no `createFleetManager()` in a test process, so nothing
// else wires the backstop decision / hosted fallback into their ports (see
// `runner-health-ports.ts`'s header: production wires them in `index.ts`).
// Wired once here, at module load, exactly like `index.ts` wires the real
// ones — this rig uses the SAME real functions, not a fake, so a test
// observes the genuine decision logic.
setBackstopDecisionRunner(runBackstopDecision);
setHostedFallbackRunner(runHostedFallback);
setBackstopDecisionReset(__resetBackstopDecisionForTesting);
setHostedFallbackReset(__resetHostedFallbackForTesting);

export let originalFetch: typeof globalThis.fetch;
export let discordPosts: string[];
export let rerunPosts: string[];
export let jobSinkPosts: Record<string, unknown>[];
export let labelOps: string[];
export let labelPostBodies: string[][];
export let queuedListings: string[];
/** Every GET /actions/runs/{id}/jobs — the calls the per-tick budget bounds. */
export let jobListings: string[];
/** The repo of every GET /actions/runners — one per repo the converge pass read. */
export let runnerListings: string[];
/** The full URL of every GET /actions/runners — the page SIZE is part of the read. */
export let runnerListingUrls: string[];
/** Where this test's tick persists its snapshot. Fresh per test. */
export let snapshotPath: string;
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
export let repoVars: Map<string, Map<string, string>>;
/** `${method} ${repo} ${name}=${value}` for every variables write. */
export let variableOps: string[];
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
export const quietRecords: string[] = [];

/**
 * The per-node OFFLINE alerts (⚠️). These are LEDGER records now, not Discord
 * posts: the message says "CI has capacity ... and nothing is queuing", so there
 * is nothing to do at the moment it fires. Asserted through the recorder rather
 * than as an absence from `discordPosts`, so these tests still fail if the
 * condition stops being detected at all.
 */
export const offlineAlerts = () => quietRecords.filter((m) => m.includes('⚠️'));

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

export function installFetch(opts: {
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

/**
 * Registers this suite's `beforeEach`/`afterEach` against whichever test
 * file calls it. node:test hooks scope to the file currently being loaded,
 * not to the module where `beforeEach`/`afterEach` were imported from, so
 * each test file (including this one's own `runner-health.test.ts`) must
 * call this once, at its own top level, before any `test(...)` calls.
 */
export function installRunnerHealthRig(): void {
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
		// Pin the priority ladder OPEN by default. The real reservation reads
		// module-level live state (the cron counter, the host-lease ledger), so
		// without this a saturation test would invert on another test's leftovers.
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
}
