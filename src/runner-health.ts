/**
 * Self-hosted runner health monitor.
 *
 * Polls the GitHub Actions API for hadoku_site's runners + recent runs and
 * Discord-alerts on the failure modes the 2026-06-03 incident exposed:
 *
 *   1. label-floor breach — a label set that some workflow's `runs-on`
 *      requires has ZERO online runners. Those jobs queue forever (the
 *      "no online runner matches its labels" failure). `pm2-host` is the
 *      thin one: only hokon satisfies it.
 *   2. queued-too-long — a run queued past QUEUED_WARN_MINUTES (the symptom
 *      of #1, or capacity starvation).
 *   3. hung-job — a run in_progress past INPROGRESS_WARN_MINUTES (a backstop
 *      to per-job `timeout-minutes`; catches a job that pins a runner).
 *
 * And takes the corrective actions the 2026-06-03 incident actually needed:
 *
 *   4. dropped-job failover — a run that FAILED with a failed job on a runner
 *      that is OFFLINE now (the claw dropped mid-job; GitHub does NOT
 *      reschedule it). Auto-reruns just the failed jobs, which GitHub then
 *      places on the next available claw. Gated on the runner being offline so
 *      a legitimately red build (runner still healthy) is never masked or
 *      slowed. Bounded to ONE automatic attempt, then it fails honestly.
 *      Needs `actions: write` on the token; a non-ok response is logged.
 *   5. hokon backstop — when FEWER THAN HALF the claws are online
 *      (`clawsAreHealthy`), or when the queue is saturated, temporarily add the
 *      `hadoku-builder` label to hokon (the pm2-host) so jobs have somewhere to
 *      run, then strip it again the moment a claw returns. Keeps the prod host
 *      out of normal CI while still covering a full claw outage. Needs
 *      runner-admin on the token; a non-ok response is logged.
 *
 * Fail-soft by design: no token, missing `actions:read` scope, or an API
 * error records a failed job result and returns WITHOUT alerting — we never
 * turn "couldn't read the API" into a false "0 runners online" page.
 *
 * Modeled on tailscale-health.ts (periodic poller + Discord sink + job record).
 * It used to say it was "simpler: no hysteresis state machine" — that stopped
 * being true. The backstop has one (`backstopCalmTicks` / BACKSTOP_CALM_TICKS)
 * so a flapping claw cannot promote and demote the production host every tick,
 * and per-node offline alerts have an escalating backoff ladder
 * (OFFLINE_REPEAT_BACKOFF_MS) on top of the RE_ALERT_MS re-arm.
 */

import { isStopping, trackPass } from './lib/loop-lifecycle.js';
import { logger, githubToken, TOKEN_RETRY_MS, recordJobResult } from './host.js';
import { withGhCaller } from './gh-budget.js';
import { labelGhToken } from './gh-budget-windows.js';

import { coveredRepos } from './lib/covered-repos.js';
import { setBackstopHold } from './runners/backstop-hold.js';
import { __resetAlertLedgerForTesting } from './lib/alert-ledger.js';
import { writeClosedDays } from './job-rollups.js';
import { loadFleetNodeNames } from './lib/manifest.js';
import { runCiAlerts } from './ci-alerts.js';
import { CI_ALERTS_BOOT_SKIP_MS, ciAlertsBootPassDue } from './ci-alerts-state.js';
import { userAgent } from './lib/fleet-config.js';
import { noteTick, registerLoop, TOKEN_WAIT_GRACE_MS } from './lib/liveness.js';
import { every } from './lib/every.js';
import { TICK_INTERVAL_MS, selfHostname } from './lib/runner-health-shared.js';
import {
	checkLabelFloor,
	__resetLabelFloorForTesting,
	lastTickEphemeralUnknown,
	__clearLastTickEphemeralUnknownForTesting,
} from './runner-health-label-floor.js';

// The umbrella reset below resets the backstop decision's and the hosted
// fallback's own cross-tick memory through these PORTS, not by importing
// `runners/backstop-decision.ts`/`runners/hosted-fallback.ts` directly —
// this file is observation, those are ci-scheduling (rule 5, §3.2). See
// `runner-health-ports.ts`'s header.
import { resetBackstopDecisionPort, resetHostedFallbackPort } from './runner-health-ports.js';
import { checkRunsAndFailover, __resetRunsForTesting } from './runner-health-runs.js';

import { __resetFailoverForTesting } from './runners/failover.js';
import {
	checkStarvation,
	checkDiskWatch,
	checkNodeRegression,
	checkHostSupervision,
	installDefaultSupervisionCheck,
} from './runner-health-watch.js';
import {
	captureSnapshot,
	__resetSnapshotForTesting,
	type RunnerHealthSnapshot,
	type TickReport,
} from './runner-health-snapshot.js';
// The GitHub Actions API client, moved to its own module 2026-10-29 (plan §4.1 F2).
import {
	SELF_REPO,
	ghUrl,
	ghGet,
	ghFetchRaw,
	__resetGhCacheStateForTesting,
} from './lib/github-client.js';
import {
	ghBlackoutRemainingMs,
	unreadableTickError,
	resetGhReadFailureForTick,
	currentGhReadFailure,
} from './lib/github-client-blackout.js';
// Re-exported for routes/fleet.ts and the non-lane test suites that still import these from here.

export type { RunnerHealthSnapshot };

/**
 * Repos swept at once in `checkRunsAndFailover`. Sequential, 27 repos took ~35s
 * of every tick, and after a restart the Fleet tab sat blank for that long. The
 * cap stays small on purpose: the token behind these listings also serves the
 * fast loop, and a wide burst risks GitHub's secondary rate limit, which would
 * stall both. Six turns 27 listings into five rounds — single-digit seconds.
 */

// re-ping a sustained condition at most hourly: job-runner.ts's shared
// HOUR_MS, imported under this module's own name (F12, plan §4.1) — see the
// `import` above and the alert ledger below, now a thin `createPager` wrapper.
// Exported so a test can assert the actual boundary rather than only "still
// inside some window" (no test did, before this — the characterization test
// beside `alertOnce` in runner-health.test.ts).

const JOB_NAME = 'ci:runner-health';

/**
 * Test-only override of the repo list the RUNS checks sweep. Null means the real
 * fleet. Exists because the suite stubs `fetch` by URL SUBSTRING, so without it
 * every test would silently replay its one mocked response across all 20 repos —
 * dedupe would hide it in the Discord assertions and expose it in the rerun ones.
 */
let fleetReposOverride: string[] | null = null;

export function __setFleetReposForTesting(repos: string[] | null): void {
	fleetReposOverride = repos;
}

export function __resetRunnerHealthAlertsForTesting(): void {
	__resetAlertLedgerForTesting();
	// The snapshot is cross-tick memory too, and since it is persisted a stale
	// in-memory copy would let one test's tick answer the next test's read.
	__resetSnapshotForTesting();
	__resetLabelFloorForTesting();
	resetHostedFallbackPort();
	resetBackstopDecisionPort();
	__resetFailoverForTesting();
	// Cross-tick memory — see the comment below; every piece of it belongs here.
	__resetRunsForTesting();
	// The hold's EDGES announce an on-demand promotion (#120), so a hold left by
	// one test would swallow the next test's 🔻 and pass while measuring nothing.
	setBackstopHold([]);
	// The shared runner listing (process cache + disk) is cross-LOOP memory: left
	// behind, one test's listing answers the next test's sweep, which then lists
	// nothing and passes. This state moved to github-client.ts (F2); see its
	// `__resetGhCacheStateForTesting` doc for why this is a call, not a reach-in.
	__resetGhCacheStateForTesting();
}

export async function tick(token: string): Promise<void> {
	// Hoisted to the top of the tick: the runs sweep further down uses this, and
	// so does the saturation gate in the runner check above it. One definition, so
	// the two cannot come to disagree about which repos are the fleet.
	const fleetRepos = fleetReposOverride ?? Array.from(new Set([SELF_REPO, ...coveredRepos()]));
	// Read only by this tick's own could-not-read-anything verdict, so a
	// failure left over from an earlier tick must not name today's cause.
	resetGhReadFailureForTick();
	// The two checks need different privileges, so they're attempted
	// independently and degrade gracefully:
	//   - runner listing (label-floor) → GET /actions/runners — for a classic
	//     `repo` PAT owned by a repo admin this works; a fine-grained token
	//     would need "Administration: read".
	//   - recent runs (queued/hung) → GET /actions/runs — needs only
	//     "Actions: read" (covered by `repo`).
	// We only record a FAILED job if BOTH are unreadable; a partial token still
	// gets the queued-job safety net. We never alert "0 online" off an endpoint
	// we couldn't read.
	const data: TickReport = { host: selfHostname() };

	// `selfHostedRunnerNames` is every self-hosted runner registered on the repo,
	// ONLINE OR OFFLINE. A GitHub-hosted runner (runs-on: ubuntu-latest, named
	// "GitHub Actions NNNN") never appears in /actions/runners, so it is absent
	// from that set — which is exactly how the failover below tells "our claw
	// dropped" apart from "a github-hosted build failed for real".
	const { runnersChecked, onlineRunnerNames, selfHostedRunnerNames, onlineLabels, selfRunners } =
		await checkLabelFloor(token, fleetRepos, data);

	const runsChecked = await checkRunsAndFailover(
		token,
		fleetRepos,
		data,
		runnersChecked,
		onlineRunnerNames,
		selfHostedRunnerNames,
		onlineLabels,
		selfRunners
	);
	// Only a hard failure if NEITHER endpoint was readable (token invalid /
	// API down). A partial read still records succeeded with what we got.
	if (!runnersChecked && !runsChecked) {
		captureSnapshot(data, runnersChecked, runsChecked);
		await recordJobResult(JOB_NAME, 'failed', 0, {
			error: unreadableTickError(currentGhReadFailure()),
		});
		return;
	}

	await checkHostSupervision(data);
	// Wave 4a (#100): a claw refused by memory admission for hours, with other
	// claws serving work, is a finding — see `checkStarvation`'s own docblock.
	// Runs on whatever `data.queued_now` this tick already paid for above; no
	// second queue read.
	await checkStarvation(data);
	// Wave 4c §F: the `_work` filesystem read EARLY, before admission's own
	// clause would refuse a mint — see `checkDiskWatch`'s own docblock.
	await checkDiskWatch(data);
	// Wave 4e §B (#102): a node that fails proven work loses the label — see
	// `checkNodeRegression`'s own docblock.
	await checkNodeRegression();
	// T2: fold every newly CLOSED day of job-history into the durable daily
	// rollups. Here because this tick is the one loop that owns job-history —
	// `ingestRuns` ran above — so it adds no timer and no GitHub call; on almost
	// every tick it finds nothing due and returns. See `job-rollups.ts`.
	writeClosedDays({ nodes: loadFleetNodeNames() });

	data.runners_checked = runnersChecked;
	data.runs_checked = runsChecked;
	captureSnapshot(data, runnersChecked, runsChecked);
	await recordJobResult(JOB_NAME, 'succeeded', 0, { data });

	const labelSummary = runnersChecked
		? `labels ${Object.entries(data.label_online ?? {})
				.map(([l, n]) => `${l}=${n}${data.label_floor?.[l] === 'minting' ? '+mint' : ''}`)
				.join(' ')} claws_online=${data.claws_online ?? '?'} ` +
			`claws=${
				Object.entries(data.claw_state ?? {})
					.map(([m, st]) => `${m}:${st}`)
					.join(',') || '?'
			} `
		: '';
	const runsSummary = runsChecked
		? `queued_stale=${data.queued_stale as number} inprogress_stale=${data.inprogress_stale as number} ` +
			`failover_reruns=${data.failover_reruns ?? 0}`
		: '';
	logger.info(
		`[runner-health] runners_checked=${runnersChecked} runs_checked=${runsChecked} ${labelSummary}${runsSummary}`
	);
}

let started = false;
/** The tick currently running, so a test can wait for one it did not call. */
let inFlightTick: Promise<void> | null = null;
/**
 * The ONGOING interval, ported onto `every()` (wave5j-2026-10-31 lane D) —
 * `every()`'s own overlap guard, a new property the original bare
 * `setInterval(() => void runTick(token), TICK_INTERVAL_MS)` did not have,
 * now stops a tick that runs past TICK_INTERVAL_MS from being joined by a
 * second one before the first finishes. `registerLiveness: false`: this
 * loop is registered EARLIER, in `startRunnerHealthMonitor`, before the
 * token wait below — see `EveryOptions.registerLiveness`'s header for why
 * `every()` must not redo that registration once a token is finally in
 * hand. `noteTick: false`: `runTick` notes its own liveness, at the end of
 * its own success path (`.then(() => noteTick(...))` below) — see
 * `EveryOptions.noteTick`'s header.
 */
let runnerHealthHandle: { stop(): void } | null = null;
/** Pending re-read of the host's token while start() waits for it (#133). */
let tokenWaitHandle: ReturnType<typeof setTimeout> | null = null;

let remeasureHandle: ReturnType<typeof setTimeout> | null = null;

/**
 * THE BLIND TICK AFTER EVERY RESTART, CLOSED (2026-10-21).
 *
 * The first tick fires at t=0 and the fast loop's first probe lands ~60 s
 * later, so that tick reads every claw count as a floor and the backstop
 * holds its previous answer — which after a restart is "not promoted". The
 * next tick is TICK_INTERVAL_MS away: ten minutes in which the backstop
 * decides nothing. On 2026-10-21 a package fan-out restarted mgmt-api eight
 * times in seventy minutes, and `BACKSTOP could not look … decided nothing`
 * was most of what the log said while 20 runs queued.
 *
 * So an unmeasured first tick is followed by a re-tick once the probe has
 * had time to land, and again every REMEASURE_DELAY_MS until a tick is
 * measured or REMEASURE_MAX_ATTEMPTS is spent — bounded, because a fast loop
 * that never probes is its own fault with its own page, not a reason to tick
 * forever. The interval keeps its own cadence; this is one extra tick per
 * restart in the common case.
 */
export const REMEASURE_DELAY_MS = 90_000;
export const REMEASURE_MAX_ATTEMPTS = 4;
let remeasureDelayMs = REMEASURE_DELAY_MS;
/** Test seam: shorten the re-tick delay. */
export function __setRemeasureDelayForTesting(ms: number | null): void {
	remeasureDelayMs = ms ?? REMEASURE_DELAY_MS;
}

function scheduleRemeasure(token: string, attempt = 1): void {
	if (remeasureHandle) return;
	remeasureHandle = setTimeout(() => {
		remeasureHandle = null;
		if (lastTickEphemeralUnknown !== true) return;
		if (inFlightTick) {
			// A tick is still running; its answer decides whether to go again.
			void inFlightTick.finally(() => {
				if (lastTickEphemeralUnknown === true && attempt < REMEASURE_MAX_ATTEMPTS) {
					scheduleRemeasure(token, attempt + 1);
				}
			});
			return;
		}
		logger.info(
			`[runner-health] re-tick ${attempt}/${REMEASURE_MAX_ATTEMPTS}: the last tick read the fleet ` +
				'as UNMEASURED (no probe since the restart) and the backstop decided nothing — ' +
				'the fast loop has had time to probe, deciding now rather than at the next interval'
		);
		// Without ci-alerts: this re-tick exists for the backstop's measurement,
		// and ci-alerts has nothing waiting on the fleet probe. It ran a second
		// full pass ~90s after every boot until 2026-10-25.
		void runTick(token, { alerts: false }).finally(() => {
			if (lastTickEphemeralUnknown === true && attempt < REMEASURE_MAX_ATTEMPTS) {
				scheduleRemeasure(token, attempt + 1);
			}
		});
	}, remeasureDelayMs);
	remeasureHandle.unref?.();
}

/**
 * THE TICK THAT FELL IN A BLACKOUT, ASKED AGAIN WHEN IT ENDS (2026-10-25).
 *
 * A tick inside a spent primary budget decides nothing — every read is
 * suppressed as "could not look" — and the next interval tick is up to ten
 * minutes past the reset. On 2026-10-25 the budget was spent from 05:30:36 to
 * 05:59:00Z while a package fan-out queued; the dispatcher resumed at the
 * reset, but the backstop's next look was the 06:03 interval tick, so hokon
 * stayed out of a queue whose oldest run was 42 minutes old.
 *
 * So a tick that ends with the blackout still armed schedules ONE more, just
 * past the reset. Budget: at most one extra runner-health tick per blackout,
 * and one blackout per hourly window, so the ceiling is one tick an hour —
 * ~45 calls (measured 2026-10-25: runner-health 85–91 per gh-budget window
 * holding a tick and its re-tick), spent in the first seconds of a full
 * budget. ci-alerts is NOT re-run with it: it has no decision waiting on the
 * reset, and it costs as much again (86–104 a window).
 */
export const POST_BLACKOUT_SLACK_MS = 5_000;
let postBlackoutSlackMs = POST_BLACKOUT_SLACK_MS;
let postBlackoutHandle: ReturnType<typeof setTimeout> | null = null;
/** Test seam: shorten the margin past the reset. */
export function __setPostBlackoutSlackForTesting(ms: number | null): void {
	postBlackoutSlackMs = ms ?? POST_BLACKOUT_SLACK_MS;
}

function scheduleAfterBlackout(token: string): void {
	if (postBlackoutHandle) return;
	const remainingMs = ghBlackoutRemainingMs();
	if (remainingMs <= 0) return;
	postBlackoutHandle = setTimeout(() => {
		postBlackoutHandle = null;
		logger.info(
			'[runner-health] re-tick: the last tick fell inside a spent GitHub budget and decided ' +
				'nothing — the budget has reset, deciding now rather than at the next interval'
		);
		const run = (): void => void runTick(token, { alerts: false });
		if (inFlightTick) void inFlightTick.finally(run);
		else run();
	}, remainingMs + postBlackoutSlackMs);
	postBlackoutHandle.unref?.();
}

function runTick(token: string, opts: { alerts?: boolean } = {}): Promise<void> {
	// The loops are stopping (lib/loop-lifecycle.ts): no new tick, and no new
	// ci-alerts pass, whichever timer asked.
	if (isStopping()) return inFlightTick ?? Promise.resolve();
	// CI-red alerting rides this cadence but runs INDEPENDENTLY of the tick.
	// Two separate concerns sharing a timer: a GitHub blackout or a thrown error
	// in either must not take the other down, and ci-alerts must not be able to
	// delay runner mint/failover decisions by sitting in the same await chain.
	if (opts.alerts !== false) {
		void trackPass(
			withGhCaller('ci-alerts', () => runCiAlerts(token, ghGet)).catch((err) =>
				logger.warn(`[ci-alerts] pass failed: ${err instanceof Error ? err.message : String(err)}`)
			)
		);
	}
	inFlightTick = withGhCaller('runner-health', () => tick(token))
		// Recorded only on the success path — see lib/liveness.ts. A tick that
		// throws falls straight to `.catch` below and is never noted as alive.
		.then(() => noteTick('runner-health', TICK_INTERVAL_MS))
		.catch((err) =>
			logger.warn(
				`[runner-health] tick failed: ${err instanceof Error ? err.message : String(err)}`
			)
		)
		.finally(() => {
			inFlightTick = null;
			if (started && !isStopping()) scheduleAfterBlackout(token);
		});
	return trackPass(inFlightTick);
}

/** Resolves once the tick in flight (if any) has finished. Test-only seam. */
export function __awaitInFlightTickForTesting(): Promise<void> {
	return inFlightTick ?? Promise.resolve();
}

/** Undo `startRunnerHealthMonitor` so a suite can start it again. Test-only seam. */
export function __stopRunnerHealthMonitorForTesting(): void {
	if (tokenWaitHandle) clearTimeout(tokenWaitHandle);
	tokenWaitHandle = null;
	runnerHealthHandle?.stop();
	runnerHealthHandle = null;
	if (remeasureHandle) clearTimeout(remeasureHandle);
	remeasureHandle = null;
	if (postBlackoutHandle) clearTimeout(postBlackoutHandle);
	postBlackoutHandle = null;
	__clearLastTickEphemeralUnknownForTesting();
	started = false;
}

/**
 * One-shot at startup: log what the token can do, so failover readiness is
 * visible in the logs without waiting for a real outage. Reads the granted
 * classic-PAT scopes from the `X-OAuth-Scopes` response header (empty for a
 * fine-grained PAT — that case can only be confirmed by an actual write).
 */
/**
 * The raw `fetch` moved onto `github-client.ts`'s `ghFetchRaw` (plan §4.1
 * F2b) — a pure move. This one reads the raw RESPONSE HEADERS
 * (`x-oauth-scopes`), not a parsed body, which is why it cannot go through
 * `ghGet` either (that returns a parsed body, never headers).
 */
async function logTokenCapabilities(token: string): Promise<void> {
	const { resp, error } = await ghFetchRaw(
		'GET',
		ghUrl(SELF_REPO, '/actions/runs?per_page=1'),
		token,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': userAgent('runner-health'),
			},
		}
	);
	if (!resp) {
		logger.warn(`[runner-health] token capability probe failed: ${error}`);
		return;
	}
	const scopes = (resp.headers.get('x-oauth-scopes') ?? '').trim();
	const scopeList = scopes
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	let writeReady: string;
	if (scopeList.includes('repo')) {
		writeReady = "YES (classic 'repo' scope authorizes rerun-failed-jobs + runner label mgmt)";
	} else if (scopes === '') {
		writeReady =
			'UNKNOWN (fine-grained PAT — scopes not exposed in header; a failover write will 403 if ' +
			'Actions:write / Administration:write are missing)';
	} else {
		writeReady = `LIKELY NO (classic token without 'repo'; failover writes will 403)`;
	}
	logger.info(
		`[runner-health] token capability: read=${resp.ok ? 'ok' : `HTTP ${resp.status}`} ` +
			`scopes='${scopes || '(fine-grained/none)'}' failover-write=${writeReady}`
	);
}
/** Test seam — this had no direct test before plan §4.1 F2b moved its transport. */
export { logTokenCapabilities as __logTokenCapabilitiesForTesting };

let tokenRetryMs = TOKEN_RETRY_MS;
/** Test seam: shorten the wait between token reads. */
export function __setTokenRetryForTesting(ms: number | null): void {
	tokenRetryMs = ms ?? TOKEN_RETRY_MS;
}

export function startRunnerHealthMonitor(): void {
	if (started) return;
	started = true;
	// Registered BEFORE the token wait below — see lib/liveness.ts. A vault
	// that stays sealed (an operator who hasn't re-unlocked it) is exactly the
	// "hangs from boot" case this ledger exists to surface, as `pending` while
	// inside the grace and `stale` (with no tick ever recorded) past it.
	registerLoop('runner-health', TICK_INTERVAL_MS, { firstTickGraceMs: TOKEN_WAIT_GRACE_MS });

	// Injected, not read from the environment: the host owns credential
	// resolution, and this package is consumed in-process by a service that
	// already resolves it through the vault broker.
	//
	// No token yet is a SEALED vault on boot, not a disabled monitor (#133).
	// This returned for the life of the process until 2026-10-22, so a boot
	// that beat the unseal by a minute went unmonitored until the next restart.
	const waitStartedMs = Date.now();
	let waited = false;
	const begin = (): void => {
		tokenWaitHandle = null;
		const token = (githubToken() ?? '').trim();
		if (!token) {
			if (!waited) {
				logger.warn(
					`[runner-health] no GitHub token from host yet (vault sealed?) — waiting, ` +
						`retrying every ${tokenRetryMs / 1000}s; no tick runs until it arrives`
				);
			}
			waited = true;
			tokenWaitHandle = setTimeout(begin, tokenRetryMs);
			tokenWaitHandle.unref?.();
			return;
		}
		if (waited) {
			logger.info(
				`[runner-health] GitHub token arrived after ${Math.round((Date.now() - waitStartedMs) / 1000)}s — starting`
			);
		}
		startWithToken(token);
	};
	begin();
}

function startWithToken(token: string): void {
	// The host's token is HADOKU_SITE_TOKEN (see AGENTS.md "Secrets"); naming it
	// is what lets a low-budget page say which credential it is about.
	labelGhToken(token, 'HADOKU_SITE_TOKEN');

	// Only the real process SSHes the claws — see `supervisionCheck`. A test that
	// starts the monitor installs its double first, and this keeps it.
	installDefaultSupervisionCheck();

	// The first tick goes out NOW, on this turn. It waited 30s here until
	// 2026-09-01, commented "let the server settle" — but nothing in a tick
	// depends on the server: the token probe, the label floor, the runs sweep and
	// the supervision probe all work at t=0. What the delay actually did was keep
	// every runner-health field on the Fleet tab null for 30s after each of the
	// day's ten mgmt-api restarts, on top of the tick's own duration.
	withGhCaller('runner-health', () => logTokenCapabilities(token)).catch(() => undefined);
	// …and if that first tick could not measure the fleet, a second one once the
	// fast loop's probe has landed — see `scheduleRemeasure`.
	// ci-alerts only when its last clean pass is not recent — see
	// `CI_ALERTS_BOOT_SKIP_MS`. A restart storm otherwise runs it per boot.
	const alerts = ciAlertsBootPassDue();
	if (!alerts) {
		logger.info(
			`[ci-alerts] boot pass skipped: a clean pass finished under ${CI_ALERTS_BOOT_SKIP_MS / 60_000}m ` +
				'ago (before this restart); the next one runs on the interval tick'
		);
	}
	const firstTick = runTick(token, { alerts }).finally(() => {
		if (lastTickEphemeralUnknown === true) scheduleRemeasure(token);
	});
	runnerHealthHandle = every('runner-health', TICK_INTERVAL_MS, () => runTick(token), {
		registerLiveness: false,
		noteTick: false,
		// This first tick runs OUTSIDE every()'s own schedule (it carries its
		// own one-shot boot args, `{alerts}`, that no later tick repeats) —
		// without seeding it, the regular interval's first firing would be
		// invisible to the overlap guard and could start a SECOND `runTick`
		// while this one was still running. See `EveryOptions.seedInFlight`.
		seedInFlight: firstTick,
	});
	logger.info(
		`[runner-health] monitor started (every ${TICK_INTERVAL_MS / 60000}m), supervision probe on`
	);
}
