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

import os from 'node:os';

import {
	getFleetProbeSnapshot,
	loadClawNodes,
	loadEphemeralNodes,
	loadFleetManifestMachines,
	loadFleetNodeNames,
} from './fleet-loop.js';
import {
	BACKSTOP_LABEL,
	BUILDER_LABEL,
	PM2_HOST_LABEL,
	nodeOf,
	runnerCensus,
} from './runners/census.js';
import {
	FLOOR_DEMAND_FILE,
	buildMintView,
	floorLabels,
	judgeJobMint,
	judgeLabelFloor,
	observedFloorDemand,
	type LabelFloorVerdict,
	type MintView,
} from './label-floor.js';
import { parseJitName, TMP_FREE_FLOOR_MB } from './runners/ephemeral.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger, githubToken, manifest, stateDir } from './host.js';
import {
	checkSupervision,
	describeProblem,
	logReport,
	type SupervisionReport,
} from './runner-supervision.js';
import { postDiscord as postDiscordSink, recordAlertQuietly } from './host.js';
import {
	recordGhResponse,
	ghBudgetSummary,
	ghTokenFingerprint,
	labelGhToken,
	withGhCaller,
} from './gh-budget.js';
import { recordJobResult } from './host.js';
import { coveredRepos, syncHostedFallback } from './ci-runner-fallback.js';
import {
	SATURATION_QUEUE_SECONDS,
	backstopLabelWrite,
	clawsAreHealthy,
	decideBackstop,
	explainBackstop,
	hostMayTakeSaturation,
	describeSaturationHost,
} from './runners/backstop.js';
import { isLocalNode } from './lib/node-identity.js';
import {
	isGuestNode,
	mintsOnDemand,
	type MintBearingNode,
	type RoleBearingNode,
} from './lib/node-role.js';
import { backstopHold, isBackstopHeld, setBackstopHold } from './runners/backstop-hold.js';
import { describeForce, isForced, readForce, type ForceState } from './runners/backstop-force.js';
import { getCapacityLedger } from './runners/capacity-ledger.js';
// ONE zombie boundary for the whole fleet — see QUEUE_ZOMBIE_SECONDS below.
import { ZOMBIE_MS } from './runners/queue-discovery.js';
import { setUnschedulableNodes } from './runners/schedulable.js';
import { deriveClawState } from './runners/claw-state.js';
import { nodeIsSick } from './fleet-loop.js';
import { isDraining, readDrain } from './runners/drain.js';
import { setPm2HostBusy, nodeReservation, type Reservation } from './node-reservation.js';
import {
	ingestRuns,
	FetchBudget,
	MAX_FETCH_PER_TICK,
	RETENTION_DAYS,
	jobRecords,
} from './job-history.js';
import { isProofRunnerName } from './runners/prove-job.js';
import { runCiAlerts } from './ci-alerts.js';
import { SWEEP_CONCURRENCY, mapConcurrent } from './lib/concurrency.js';
import { fleetOwner, hubRepoFull, userAgent } from './lib/fleet-config.js';
import { admissionVerdictsForReport, loadWorkloadGateContext } from './runners/ephemeral-tick.js';
import {
	diskReadingsForReport,
	judgeWorkDisk,
	judgeTmpDisk,
	tmpAdvisoryLineMb,
	tmpIsSmall,
	worseDiskLevel,
	DISK_WATCH_ADVISORY_FREE_GB,
	DISK_WATCH_PAGE_FREE_GB,
	TMP_WATCH_PAGE_MARGIN_MB,
	type DiskWatchLevel,
} from './runners/disk-watch.js';
import { checkNodeRegressions, defaultGatedKinds } from './runners/node-regression.js';
import type { BackstopReason, ClawState } from './fleet-report-types.js';

/**
 * EXPORTED so the queue-probe budget test multiplies by the REAL cadence.
 *
 * Not part of the package's client contract — `src/index.ts` does not re-export
 * it, and the test imports this module directly. A test that hard-codes "6 ticks
 * an hour" asserts its own arithmetic, not the code's, and would stay green
 * through exactly the change the assertion exists to catch: 2026-09-05 moved a
 * timer and quadrupled an unconditional sweep nobody had re-counted.
 */
export const TICK_INTERVAL_MS = 10 * 60 * 1000; // 10 min
const FETCH_TIMEOUT_MS = 10_000;
/**
 * Repos swept at once in `checkRunsAndFailover`. Sequential, 27 repos took ~35s
 * of every tick, and after a restart the Fleet tab sat blank for that long. The
 * cap stays small on purpose: the token behind these listings also serves the
 * fast loop, and a wide burst risks GitHub's secondary rate limit, which would
 * stall both. Six turns 27 listings into five rounds — single-digit seconds.
 */
export { SWEEP_CONCURRENCY } from './lib/concurrency.js';
/**
 * Minutes a job may sit queued before it counts toward `queuedStale`.
 *
 * EXPORTED because it also has to be SAID. The command station's "Queued past
 * 10m" card wrote the number into its own label, so the two agreed only by
 * coincidence — change it here and the card keeps claiming 10 while counting
 * something else. It reaches the panel through `FleetVocabulary`.
 */
export const QUEUED_WARN_MINUTES = 10;
const INPROGRESS_WARN_MINUTES = 30;
const RE_ALERT_MS = 60 * 60 * 1000; // re-ping a sustained condition at most hourly
const MAX_RERUN_ATTEMPTS = 2; // failover: auto-rerun once — only when run_attempt < this
const FAILOVER_RECENT_MINUTES = 30; // ignore stale failures (e.g. on monitor restart)
const JOB_NAME = 'ci:runner-health';

/**
 * The repo this monitor runs out of. Its runner listing is the fleet-wide view
 * (the claws register to every covered repo under the same names), so the
 * label-floor and backstop checks read it alone.
 *
 * The RUNS checks below do NOT — see `fleetRepos`. Until 2026-08-17 every call
 * here was hardcoded to this repo, which meant the dropped-job failover, the
 * queued-too-long alert and the hung-job alert all covered exactly 1 of 20
 * repos. On 2026-08-17 claw-3 died mid-job and took four child-repo publishes
 * with it (aggregator, contact-ui, resume-bot, watchparty); `failover_reruns`
 * reported 0 and every one of them stayed red, because none of them were this
 * repo. They only went green again because an unrelated package-update cascade
 * happened to re-trigger them ~20 minutes later. That was luck, not recovery.
 *
 * EXPORTED so a reader can NAME it. Registration state is per-repo, so a node
 * reading `absent` in `claw_state` is absent from THIS repo — not from the
 * fleet. The panel could only assert that in a tooltip it typed by hand.
 *
 * WHICH repo comes from `fleet-config`, not from here — it is the hub repo, the
 * same one `ci-runner-fallback` degrades to. Resolved ONCE, at import, because
 * this is a `const` and `src/routes/fleet.ts` imports it as one; that is exactly
 * the binding it has always had, so an operator setting `FLEET_HUB_REPO` must set
 * it before the process starts, as they already must for `HADOKU_STATE_DIR`.
 */
export const SELF_REPO = hubRepoFull();

/**
 * Last backstop state we pushed to the NON-self repos. `null` = unknown, which
 * is the state after every mgmt-api restart, and it deliberately forces one
 * converge pass rather than assuming the fleet matches: a restart during an
 * outage would otherwise leave 25 repos promoted with nothing left to demote
 * them.
 */
let backstopFleetState: boolean | null = null;

/**
 * The manifest's machines, as the backstop reads them: which nodes are guests,
 * and which of those are minted for on demand rather than relabelled.
 *
 * `null` when unreadable. The backstop then falls back to what GitHub says —
 * the registrations carrying `pm2-host` or `backstop` — which is the reading it
 * ran on before the manifest was consulted at all.
 */
function readManifestMachines(): Record<string, unknown> | null {
	try {
		const raw = JSON.parse(readFileSync(manifest('fleet-runner-manifest.json'), 'utf8')) as {
			machines?: Record<string, unknown>;
		};
		return raw.machines ?? null;
	} catch {
		return null;
	}
}
let backstopMachinesReader: () => Record<string, unknown> | null = readManifestMachines;
/** Test seam: the manifest's machines map, as the backstop reads it. */
export function __setBackstopMachinesForTesting(
	fn: (() => Record<string, unknown> | null) | null
): void {
	backstopMachinesReader = fn ?? readManifestMachines;
}

type HostLoad = { load1: number; cores: number; memAvailableMb: number };
let hostLoadReader: (node: string) => HostLoad | null = readHostLoadFromProc;
const readHostLoad = (node: string): HostLoad | null => hostLoadReader(node);
/** Test seam: the backstop's idle check reads this instead of /proc. */
export function __setHostLoadReaderForTesting(
	fn: ((node: string) => HostLoad | null) | null
): void {
	hostLoadReader = fn ?? readHostLoadFromProc;
}

/** The backstop host's load and memory for `isHostIdle`, read from /proc when it is THIS box. */
function readHostLoadFromProc(
	node: string
): { load1: number; cores: number; memAvailableMb: number } | null {
	if (!isLocalNode(node)) return null;
	try {
		const load1 = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
		const mem = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
		return { load1, cores: os.cpus().length, memAvailableMb: mem ? Number(mem[1]) / 1024 : 0 };
	} catch {
		return null;
	}
}

/**
 * When the fan-out last READ the fleet's registrations, rather than trusting
 * `backstopFleetState`.
 *
 * THE BELIEF IS THE BUG THIS BOUNDS. The fan-out ran only on a change of that
 * boolean, so it only ever looked when IT had changed its own mind — and a
 * label written by anything else was invisible to it for as long as its mind
 * stayed made up. Measured 2026-09-10 → 09-19: the retired tier ladder's
 * 13:00 prewarm put `hadoku-builder` on hokon across the fleet, the ID-based
 * loop below stripped it from the hub repo within five minutes each day
 * (`BACKSTOP demote: N claw(s) online`, 09-17/18/19), and the other 26 repos
 * kept it for DAYS — 165 of the 169 non-prewarm builder jobs hokon served in
 * that window ran on repos the fan-out never looked at. The only lines in any
 * retained log that cleared them (`BACKSTOP fleet demote: 26/27 runner(s)`,
 * 09-18T19:29Z, 09-18T21:47Z, 09-19T20:51Z) are restarts, which set the belief
 * to `null` and forced a converge by accident.
 *
 * The ladder is gone and nothing else writes this label on a guest today (the
 * fast loop skips guests — `fleet-loop.ts`, `if (guestNodes.has(node))
 * continue`). That makes the sweep below a guard against a writer that does
 * not currently exist, which is exactly what it should be: the reader for this
 * facet now reads the REGISTRATIONS, not its own record of what it wrote, so a
 * divergence from any source is bounded by this interval instead of being
 * permanent.
 *
 * ARITHMETIC, because a cadence is a budget. One GET per fleet repo, 27 repos,
 * at most once an hour = 27 calls/hr against 5,000 — and only in the
 * backstop-DOWN state, since while it is up the existing re-assert already
 * converges every tick. It is deliberately much slower than the 10-minute tick
 * for that reason: the fault it catches is rare and its cost is measured in
 * hours of exposure, not seconds of latency.
 */
let backstopConvergedMs = 0;

/** @see backstopConvergedMs — how stale the fan-out's reading may get. */
export const BACKSTOP_CONVERGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Whether the operator has an open 🔻 for the backstop. Gates the 🔺 so a
 * recovery note only ever closes a promote the operator actually saw — a
 * saturation promote is silent, and a silent promote must not produce a loud
 * "a claw is back" for an outage that never happened.
 */
let backstopAlerted = false;

/**
 * Consecutive ticks the backstop has been UNwanted. Demotion waits for this to
 * reach BACKSTOP_CALM_TICKS; promotion never waits.
 *
 * The asymmetry is the point. Promoting early costs one extra label on a box
 * that was going to sit idle; demoting early costs a flap, because saturation
 * is computed from an instantaneous `atCapacity && queuePressure >= 100s` that
 * toggles every time a job starts or finishes. Measured on 2026-08-25 the
 * backstop promoted and demoted on almost every tick:
 *
 *   05:04 promote (saturation): 2/2 online, 0 free
 *   05:13 promote (saturation): 2/2 online, 0 free
 *   05:23 demote: 3 claw(s) online → stripped temporary labels
 *   05:25 promote (saturation): 3/3 online, 0 free
 *   05:51 promote (saturation): 3/3 online, 0 free
 *
 * Each of those rewrites `hadoku-builder` on 13-25 runners across the fleet, so
 * the flap is both the source of the 🔺 spam and a standing pile of GitHub API
 * writes. It also defeats the `backstopAlerted` gate below: over the fifteen
 * days to 2026-08-28 the channel got 19 "a claw is back online" against 3
 * outage notices, six of them on 2026-08-21 alone, a day with no outage at all.
 */
let backstopCalmTicks = 0;

/**
 * Why the backstop was last wanted. Hysteresis applies to SATURATION only.
 *
 * Every flap in the logs says `(saturation)` — that is the condition computed
 * from an instantaneous `atCapacity && queuePressure >= 100s`, and it is the one
 * that oscillates. An outage ending is a real state change, and a cron
 * reservation taking the node back is a priority decision that must land in
 * the same tick: "declining to promote is not enough — a promotion from 23:50
 * would otherwise sit through the whole run." Damping either of those would turn
 * a noise fix into a 30-minute delay on the thing the ladder exists to protect.
 */
let backstopLastReason: 'outage' | 'saturation' | null = null;

/**
 * Zombie count last announced, so the warning fires on CHANGE rather than every
 * tick. `null` is "never announced", which is why zero is not the initial value:
 * a fleet that starts with zero zombies must not print the all-clear.
 *
 * Cross-tick memory, so it is in `__resetRunnerHealthAlertsForTesting`.
 */
let queueZombiesLogged: number | null = null;

/**
 * Apply the backstop label to hokon's runner on EVERY fleet repo, not just this
 * one.
 *
 * SELF_REPO's runner listing is a valid fleet-wide view for the CLAWS — they
 * register to every covered repo under the same names with the same labels — and
 * that is what the comment on SELF_REPO means. It was never true of hokon, and
 * on 2026-08-23 it stopped being harmless: hokon gained a runner on all 26 repos,
 * each carrying only `pm2-host,taskauto`. The promote below writes labels by
 * runner ID, and a runner ID is repo-scoped, so a full claw outage promoted
 * hokon for hadoku_site and left the other 25 repos' hokon runners unlabelled.
 *
 * That combination strands them. `runs-on: [self-hosted, hadoku-builder]` matches
 * nothing once the claws are down, and the hosted fallback cannot rescue them
 * either — it flips on `clawsOnline + backstopOnline`, and backstopOnline counts
 * hokon as capacity even though that capacity was only ever reachable from one
 * repo. So the escalation claws → hokon → hosted silently skipped BOTH remaining
 * rungs for 25 of 26 repos, and their jobs would queue until a claw came back.
 *
 * Costs nothing on the happy path: the fan-out only runs on a state CHANGE, and
 * re-asserts every tick only while the backstop is up — the state where a write
 * that silently failed last tick is worth the calls.
 *
 * One state change it ALWAYS sees is a restart: `backstopFleetState` is null in
 * a new process, so the first tick reads every child repo's runner listing to
 * converge. Read one after another that was ~12s of the first tick — measured
 * 2026-09-01 on 0.21.2, the first tick took 19.5s with the runs sweep already
 * fanned out. The repos are independent here (each is read and written on its
 * own id), so they go `SWEEP_CONCURRENCY` at a time. The two result lists are
 * sorted, so the log line does not depend on which listing answered first.
 */
async function syncBackstopAcrossFleet(
	on: boolean,
	token: string,
	repos: string[],
	/**
	 * Runners that must NOT carry the label whatever `on` says — the pool
	 * members on a quarantined or drained node. Same predicate as the local
	 * loop, so the fan-out cannot re-label on twenty repos a node this tick
	 * refused on this one.
	 */
	unsafe: (runnerName: string) => boolean = () => false
): Promise<{ changed: string[]; failed: string[] }> {
	const changed: string[] = [];
	const failed: string[] = [];
	const converge = async (repo: string): Promise<void> => {
		if (repo === SELF_REPO) return; // handled by the ID-based loop above
		// Shared (#118): the reap and the warm cache list these repos on a minute
		// clock, and a label sweep on a 10-minute one can use their answer. Its
		// own writes drop the entry, so a re-assert never reads back its past.
		const resp = await readRunnerListingShared(repo, token);
		if (!resp || !Array.isArray(resp.runners)) {
			failed.push(repo);
			return;
		}
		for (const r of resp.runners) {
			const labels = r.labels ?? [];
			const inPool = labels.some((l) => l.name === PM2_HOST_LABEL || l.name === BACKSTOP_LABEL);
			// Only the hokon pool is ever relabelled here. A claw carries neither
			// label, so it can never be demoted by this path even by accident.
			if (!inPool) continue;
			// ONE PREDICATE, shared with the id-based loop in `tick` — see
			// `backstopLabelWrite`. This arm used to skip an offline runner for the
			// DEMOTE as well as the promote, which is how hadoku-cardtable kept
			// `hadoku-builder` through the 2026-09-18T19:29Z sweep and served seven
			// more builder jobs on it.
			const write = backstopLabelWrite(
				{
					hasBuilder: labels.some((l) => l.name === BUILDER_LABEL),
					online: r.status === 'online',
				},
				on && !unsafe(r.name)
			);
			if (write === null) continue;
			const want = write === 'promote';
			const res = want
				? await ghWrite(
						'POST',
						`/actions/runners/${r.id}/labels`,
						token,
						{
							labels: [BUILDER_LABEL],
						},
						repo
					)
				: await ghWrite(
						'DELETE',
						`/actions/runners/${r.id}/labels/${BUILDER_LABEL}`,
						token,
						undefined,
						repo
					);
			// A demote that 404s found the label already gone — which is the state
			// being converged to, so it is neither a change nor a failure. The other
			// writer of this label (the tier ladder, see runners/backstop-hold.ts)
			// demotes hokon on its own first pass after a restart, and since the
			// first tick here fires at t=0 the two can strip the same label within
			// the same second. Counting that as failed left `backstopFleetState`
			// unset, which forced a second full converge next tick, and logged
			// "those repos queue until this succeeds" about repos that were fine.
			if (res.ok) changed.push(`${repo.split('/')[1]}:${r.name}`);
			else if (!(want === false && res.status === 404)) {
				failed.push(`${repo.split('/')[1]}:${r.name}`);
			}
		}
	};
	await mapConcurrent(repos, SWEEP_CONCURRENCY, converge);
	changed.sort();
	failed.sort();
	return { changed, failed };
}

/** Cap on auto-reruns in a single tick, so one bad claw cannot storm the API. */
export const MAX_RERUNS_PER_TICK = 10;

function ghUrl(repo: string, path: string): string {
	return `https://api.github.com/repos/${repo}${path}`;
}

/**
 * Test-only override of the repo list the RUNS checks sweep. Null means the real
 * fleet. Exists because the suite stubs `fetch` by URL SUBSTRING, so without it
 * every test would silently replay its one mocked response across all 20 repos —
 * dedupe would hide it in the Discord assertions and expose it in the rerun ones.
 */
let fleetReposOverride: string[] | null = null;

/**
 * Reservation override for tests.
 *
 * REQUIRED, not a convenience: the real `nodeReservation` consults the
 * DECLARED cron window derived from profiles.json, so a suite run inside the 90
 * minutes after any daily cron would see the backstop correctly decline to
 * promote and read that as a broken test. A wall-clock-dependent test is a flake
 * with a schedule.
 */
let reservationOverride: ((pm2Busy: boolean) => Reservation) | null = null;
export function __setReservationForTesting(fn: ((pm2Busy: boolean) => Reservation) | null): void {
	reservationOverride = fn;
}

export function __setFleetReposForTesting(repos: string[] | null): void {
	fleetReposOverride = repos;
}

/**
 * Host-side supervision probe, or null to skip it.
 *
 * Deliberately null by default. The probe SSHes every claw, so leaving it on
 * would make a plain `tick()` in the unit suite open real network connections
 * and sit through a 15s timeout per unreachable node — a test suite that
 * depends on the garage being up is not a test suite. `startRunnerHealthMonitor`
 * turns it on for the real process; tests opt in with a fake.
 */
let supervisionCheck: (() => Promise<SupervisionReport | null>) | null = null;

export function __setSupervisionCheckerForTesting(
	fn: (() => Promise<SupervisionReport | null>) | null
): void {
	supervisionCheck = fn;
}

// Every demanded `runs-on` label must be SERVED: carried by >=1 standing online
// runner, or offered by an eligible minting node.
//
// THE LABEL FLOOR'S WATCHED SET — every label covered repos DEMAND.
//
// This was `REQUIRED_LABELS`, a list derived from a per-capability `floor`
// boolean, and before that a hand-written literal. Both shapes had the same
// hole: a routing dependency was watched only if somebody remembered to say
// so. `taskauto` and `av1-nvenc` were absent until 2026-08-27, and their
// absence had already cost an outage: github-runner-tenhands.service was the
// ONLY runner offering `taskauto`, it died with its registration deleted on
// 2026-08-26, and `hadoku-tenhands / Task automation` queued 6h45m with no
// floor alert possible. `jdk21` and `cargo-bevy` repeated it on 2026-10-10 in
// the other direction: `floor: false`, because a standing-only floor could not
// watch a label claws serve by minting without paging forever.
//
// Now the set comes from DEMAND (see `label-floor.ts`): observed job labels
// over job history's retention window, unioned with the static workflow
// demand `fleet label-floor` persists. And every watched label is judged by
// one rule — standing online runner, OR an eligible minting node that offers
// it — so a JIT-served label needs no exemption to be watchable.
/**
 * Test seam: a fixed demand instead of job history + the persisted file.
 * `null` restores the real read. Not part of the supported API.
 */
let floorDemandOverride: string[] | null = null;
export function __setFloorDemandForTesting(labels: string[] | null): void {
	floorDemandOverride = labels;
}

/** The last static-demand problem logged, so an unchanged one is said once, not every tick. */
let lastStaticDemandProblem: string | null = null;

/**
 * This tick's watched set, and why its static half is missing when it is.
 *
 * The static half missing is NOT fatal here and must not be silent: the floor
 * still watches everything jobs actually asked for, and `fleet label-floor`
 * — which is what writes the file — goes red on its own when it cannot read
 * the workflows. Logged once per change, and carried on the tick report.
 */
function floorWatchSet(): { labels: string[]; staticProblem: string | null } {
	if (floorDemandOverride) return { labels: floorLabels(floorDemandOverride), staticProblem: null };
	const nodes = loadFleetNodeNames();
	const observed = observedFloorDemand(jobRecords(), {
		sinceIso: new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString(),
		isProof: (runner) => nodes.some((n) => isProofRunnerName(runner, n)),
	});
	const path = join(stateDir(), FLOOR_DEMAND_FILE);
	let staticLabels: string[] = [];
	let staticProblem: string | null = null;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as { labels?: unknown };
		if (!Array.isArray(parsed.labels)) throw new Error('it carries no `labels` array');
		staticLabels = parsed.labels.filter((l): l is string => typeof l === 'string');
	} catch (err) {
		staticProblem =
			`${path}: ${err instanceof Error ? err.message : String(err)} — the floor watches only ` +
			'labels jobs actually requested in the retention window, so a label only a rarely-run ' +
			'workflow asks for is unwatched until `fleet label-floor` writes it again';
	}
	if (staticProblem !== lastStaticDemandProblem) {
		lastStaticDemandProblem = staticProblem;
		if (staticProblem) logger.warn(`[runner-health] label floor static demand: ${staticProblem}`);
	}
	return { labels: floorLabels([...observed, ...staticLabels]), staticProblem };
}

/**
 * The MINTING half of the fleet as the floor sees it — `null` when the manifest
 * could not be read, which is "I could not look", never "nothing mints".
 *
 * Built from the SAME inputs the dispatcher reads (`ephemeral-tick.ts`): the
 * workload gate from the same loader, the drain file, the fast loop's sick set
 * and its last probe. A floor that judged mintability by a different rule than
 * the mint would be a second authority, and it would disagree exactly when it
 * matters.
 *
 * AN UNREADABLE DRAIN FILE FAILS CLOSED, like every other reader of it
 * (`drain.ts`): every node reads as drained, so a label served only by minting
 * reads unserved — which is true, because the dispatcher's tick throws on the
 * same file and mints nothing. `drainProblem` goes into the page so it names
 * the real cause.
 */
function loadMintView(
	probe: { nodes?: Record<string, { reachable?: boolean; sick?: boolean }> } | null
): { view: MintView; drainProblem: string | null } | null {
	const machines = loadFleetManifestMachines();
	if (!machines) return null;
	let drained: Set<string>;
	let drainProblem: string | null = null;
	try {
		drained = new Set(Object.keys(readDrain()));
	} catch (err) {
		drained = new Set(Object.keys(machines));
		drainProblem = `the drain file is unreadable (${err instanceof Error ? err.message : String(err)}), so every node reads as drained`;
	}
	const view = buildMintView({
		machines,
		gate: loadWorkloadGateContext(Object.keys(machines)),
		drained,
		isSick: nodeIsSick,
		probe,
		held: isBackstopHeld,
	});
	return { view, drainProblem };
}

// Dynamic failover: hokon (the PM2_HOST runner) normally does NOT carry any
// builder label, so normal CI never lands on the prod host. When every claw is
// offline we temporarily add them so GitHub can place queued/rerun jobs on hokon,
// then strip them again the moment a claw returns. Under this model hokon never
// NATIVELY carries a builder label, so a present one is always our temporary
// promotion (self-heals across an mgmt-api restart mid-outage).
//
// BUILDER_LABEL / PM2_HOST_LABEL / BACKSTOP_LABEL are imported from
// ./runners/census.js, which is where the counting that reads them lives.
//
// BACKSTOP_LABEL marks the extra idle runner instances ON hokon, registered
// 2026-08-17. They carry only that label natively, so they sit out of normal CI
// exactly like hokon itself, and the backstop promotes the whole pool at once
// when the garage goes dark. Four instances rather than one because a single
// backstop slot serialises the entire fleet's CI behind one job.

/**
 * Past this, a queued run is a ZOMBIE and is NOT queue pressure.
 *
 * ONE BOUNDARY, ONE NAME — imported from the dispatcher rather than restated,
 * for the reason `queue-discovery.ts` gives beside it: two copies of this number
 * means a run the dispatcher will never mint for is one this probe still reads
 * as work waiting for capacity. `zombie-boundary-guard.test.mjs` already pins
 * `ZOMBIE_MS` against `queue-health.mjs`'s `ZOMBIE_SECONDS`; importing puts this
 * third reader inside that guard instead of beside it.
 *
 * WHY THE BACKSTOP NEEDED IT AND DID NOT HAVE IT. The two runs the dispatcher's
 * band was written for — hadoku-tenhands 32072350405 (2026-08-17T21:40:51Z) and
 * hadoku_site 32218726912 (2026-08-19T05:15:08Z) — are permanently `queued` and
 * cannot be cancelled, force-cancelled or deleted; `dispatch-tick.ts` records
 * the three refusals and why. They were harmless here while the probe was gated
 * on `isAtCapacity(...)`, which under all-JIT is never true, so this function
 * effectively never ran. `2383b18` (#63) made it run every tick — and on the
 * first tick after that deploy it returned **3.5 million seconds**, 35,000x the
 * 100s threshold, and `reason=saturation` has been true on essentially every
 * tick since. Measured in the deployed tree: ZERO `BACKSTOP` lines in
 * `mgmt-api-out` for 2026-09-22..24, then 37 on 09-25, 111 on 09-26, 149 on
 * 09-27 and 116 by 21:00Z on 09-28, every one of them `reason=saturation
 * queue=~3,510,000s` against a fleet reporting `claws=12/12 online free=27`.
 * That is the #56 regression: hokon was not catching overflow, it was carrying
 * `hadoku-builder` permanently and winning GitHub's assignment race with a
 * standing registration (builder queue p50 2s against the claws' 4s).
 *
 * THE FAILURE THIS EXCLUSION DOES *NOT* MANUFACTURE. CLAUDE.md's rule is that no
 * gate may get easier to pass the worse the failure gets, and that if you
 * exclude a category you must check what happens when a real failure MAKES that
 * category. `queue-health`'s p95 broke exactly that way: every casualty of a
 * long stall eventually crossed the one-hour ceiling and LEFT the percentile, so
 * a two-hour outage read greener than a twenty-minute one. A MAXIMUM over a
 * sliding age band does not have that shape. A saturation lasting longer than
 * the band means runs are still arriving and still not being served, so the band
 * is full of recent ones and the maximum inside it stays far over 100s; the only
 * way the band empties is that nothing has queued for a whole day, which is a
 * genuinely idle fleet. The passage of time cannot move a run out of the band
 * without newer runs moving in behind it — unless the queue really did drain.
 *
 * AND THEY ARE COUNTED, NOT DISCARDED. "I deliberately did not act on this" is
 * not "there was nothing there": the count and the oldest age ride out on
 * `QueuePressure` and reach both the snapshot and the log.
 */
export const QUEUE_ZOMBIE_SECONDS = ZOMBIE_MS / 1000;

/** What the queue probe saw, split into what it acted on and what it refused. */
export interface QueuePressure {
	/**
	 * Age of the oldest queued run INSIDE the band, seconds. This is the only
	 * field the backstop decision reads.
	 */
	pressureSec: number;
	/**
	 * Queued runs excluded by age — SEEN, and deliberately not acted on.
	 *
	 * Understated when `pressureSec` already crossed the threshold, because the
	 * loop stops looking at that point. It is a diagnostic, never an input to a
	 * decision, so a partial count costs nothing; the alternative is paying the
	 * full 26-repo sweep on a fleet already known to be backed up.
	 */
	zombies: number;
	/** The oldest of them, seconds, so the log can name what it refused. */
	oldestZombieSec: number;
}

/**
 * Age of the oldest run that cannot start at all, in seconds.
 *
 * RUN level here, deliberately. The justification this comment used to give —
 * "only ever called when `clawsFree === 0`, and with no free runner anywhere a
 * newly-arrived run cannot start ANY of its jobs" — stopped being true on
 * 2026-09-24, when the caller began probing whenever the fleet is UP (#63). It
 * is recorded rather than deleted because the conclusion survives the premise:
 * only the MAXIMUM is returned and only `>= SATURATION_QUEUE_SECONDS` moves the
 * decision, so a run sitting queued for the seconds GitHub takes to place it is
 * under the bar with or without a free claw, and a run still queued past the
 * fleet's measured p90 is STUCK either way — that is precisely the 2026-09-01
 * shape, where `clawsFree` never hit zero and 13 jobs waited 11-19 minutes.
 * (Job-level queue time is the right measure for the DISTRIBUTION, which is why
 * `JobRecord.queueSec` records it; it is not needed to answer "is anything
 * stuck right now".)
 *
 * IT IS NO LONGER FREE ON A HEALTHY FLEET in the worst case. `ghGet` revalidates
 * with an ETag, so an unchanged queue answers 304 for nothing, but a repo whose
 * queue moved between ticks is charged, and the ceiling is sized as if every
 * listing were; the per-hour arithmetic is stated at the call site and asserted by
 * `the queue probe stays inside the hourly API budget at fleet size`. It exits
 * at the first run over the threshold, so "yes, there is pressure" is one API
 * call and the quiet answer is one per repo — and the quiet answer is now the
 * common one, which is the direction that costs.
 *
 * THE ZOMBIE WAS ALSO HIDING THE SPEND. With a permanently-over-threshold run in
 * the first repo swept, this broke after ONE listing on every tick from
 * 2026-09-25 to 09-28 — so the measured cost was ~6 calls/hr and the arithmetic
 * at the call site described a path nothing took. Excluding it restores the
 * worst case the budget test has always asserted: 26 listings x 6 ticks/hr =
 * 156/hr, 3.1% of a 5,000/hr budget. The spend goes UP by design, and it is the
 * number that was already under test.
 */
export async function probeQueuePressure(
	token: string,
	repos: string[],
	nowMs: number,
	zombieSec: number = QUEUE_ZOMBIE_SECONDS
): Promise<QueuePressure> {
	let pressureSec = 0;
	let zombies = 0;
	let oldestZombieSec = 0;
	for (const repo of repos) {
		const resp = await ghGet<{
			workflow_runs?: { created_at?: string; run_started_at?: string }[];
		}>('/actions/runs?status=queued&per_page=20', token, repo);
		for (const run of resp?.workflow_runs ?? []) {
			// THIS ATTEMPT'S CLOCK, like every other age in this file.
			//
			// `created_at` pins to the ORIGINAL run and GitHub never moves it, so on
			// a re-run the two diverge by the whole gap between attempts. That is
			// the bug `GhRun.run_started_at` was added for on 2026-09-10, when a
			// re-run of a 2h-old hadoku-tenhands run alerted as "QUEUED 122m" while
			// its jobs started four seconds later — and this function was still
			// reading the field that mistake was about. A re-run of anything old
			// therefore read as hours of queue pressure the instant it was
			// requeued, which is enough on its own to promote the production host.
			// Both fields are absent on runs old enough to predate `run_started_at`,
			// hence the fallback.
			const started = Date.parse(run.run_started_at ?? run.created_at ?? '');
			if (!Number.isFinite(started)) continue;
			const age = Math.max(0, Math.round((nowMs - started) / 1000));
			if (age > zombieSec) {
				zombies++;
				if (age > oldestZombieSec) oldestZombieSec = age;
				continue;
			}
			if (age > pressureSec) pressureSec = age;
		}
		if (pressureSec >= SATURATION_QUEUE_SECONDS) break;
	}
	return { pressureSec, zombies, oldestZombieSec };
}

interface GhRunner {
	id: number;
	name: string;
	status: string; // 'online' | 'offline'
	busy: boolean;
	labels?: { name: string }[];
}

interface GhRun {
	id: number;
	name?: string;
	display_title?: string;
	created_at: string;
	/**
	 * When THIS ATTEMPT began. `created_at` pins to the ORIGINAL run and GitHub
	 * never moves it, so on a re-run the two diverge by the whole gap between
	 * attempts — which is exactly the age this monitor used to report. On
	 * 2026-09-10 a re-run of a 2h-old hadoku-tenhands run alerted as "QUEUED
	 * 122m" while its jobs started four seconds later and every one went green.
	 * Absent on runs old enough to predate the field, hence the fallback.
	 */
	run_started_at?: string;
	updated_at?: string;
	status: string; // 'queued' | 'in_progress' | 'completed' | ...
	conclusion?: string | null; // 'success' | 'failure' | 'cancelled' | ... (when completed)
	run_attempt?: number;
	html_url: string;
}

interface GhJob {
	/** Also the CHECK-RUN id, which is how the annotations endpoint is addressed. */
	id?: number;
	status?: string;
	conclusion?: string | null;
	runner_name?: string | null;
	/** null until a runner actually picks the job up — the queued/running tell. */
	started_at?: string | null;
	/** `runs-on` as GitHub resolved it. What a queued job is WAITING for. */
	labels?: string[];
	/**
	 * The job's steps, each with a `conclusion` that is null while it runs.
	 *
	 * This is the PROGRESS signal — see `stuckSince`. A count of finished steps
	 * that advances between ticks is a job doing work, however long it takes.
	 */
	steps?: { number?: number; name?: string; conclusion?: string | null }[];
}

/** Steps the RUNNER adds to every job. Everything else is the workflow's own. */
const RUNNER_BOOKKEEPING_STEPS = new Set([
	'Set up job',
	'Set up runner',
	'Complete runner',
	'Complete job',
]);

/**
 * True when the job-started hook refused the job: `Set up runner` failed and
 * not one of the workflow's own steps ran.
 *
 * `Set up runner` is where the runner executes `ACTIONS_RUNNER_HOOK_JOB_STARTED`,
 * which on every node is `ci-throttle.sh`, and a non-zero exit there fails the
 * job before checkout. ci-throttle only exits non-zero to REFUSE admission — its
 * /tmp prune and every other side task are bounded and never fail the job — so
 * this is an infrastructure failure in the same class as a runner going offline
 * or an OOM kill. No user code ran, so a rerun cannot repeat a side effect. Both
 * refusal kinds qualify: CONTENTION clears when a slot frees, and a PLACEMENT
 * refusal ("this node cannot host it") may land elsewhere on the rerun. The
 * attempt cap (`MAX_RERUN_ATTEMPTS`) makes it one rerun, so a refusal that
 * repeats stays red and still reaches a human.
 *
 * The case it exists for: on 2026-10-11 at 01:38Z the backstop promoted 29
 * hokon runners for saturation, GitHub seated ~20 builder jobs there inside a
 * minute, and ci-throttle (cap 4, which is right for hokon's 16 GiB CI slice)
 * refused three of them after its 90s wait. hadoku-study's publish,
 * hadoku-pygmalion's redeploy and hadoku-resume-bot's auto-update each failed
 * red and needed a hand rerun. hokon must stay labelled on EVERY repo while
 * promoted (see `syncBackstopAcrossFleet`), so over-seating is the cost of the
 * backstop, and the refusal is where it has to be absorbed.
 *
 * Read from the jobs listing the failover already fetched — zero extra calls.
 */
export function refusedAtAdmission(job: Pick<GhJob, 'conclusion' | 'steps'>): boolean {
	if (job.conclusion !== 'failure') return false;
	const steps = job.steps ?? [];
	const setup = steps.find((st) => st.name === 'Set up runner');
	if (setup?.conclusion !== 'failure') return false;
	return steps
		.filter((st) => !RUNNER_BOOKKEEPING_STEPS.has(st.name ?? ''))
		.every((st) => st.conclusion === 'skipped');
}

/**
 * Exit 137 is 128+9 — the job's process tree took a SIGKILL. Nothing in a build
 * sends itself SIGKILL, so in CI this is the kernel OOM killer essentially every
 * time, and it is the one failure class the offline-runner failover below is
 * structurally blind to: the OOM killer reaps the JOB, not the listener, so the
 * runner is still online at the next tick and the rerun never fires.
 *
 * That is not theoretical. On 2026-08-24 the 13:00 UTC @wolffm fan-out dispatched
 * 14 repos inside 4 seconds; 11 landed on claw-2 (7.8GB, the smallest box in the
 * fleet, and tier1 so it is never demoted) and the kernel killed two of them
 * 82 seconds apart. Both stayed red and paged @here as breakage.
 */
const SIGKILL_ANNOTATION = /\bexit code 137\b/;

interface GhAnnotation {
	message?: string;
}

/**
 * True when a job died to SIGKILL. Costs ONE extra API call, and only for a run
 * that is already a failover candidate (recent, failed, on one of our runners,
 * under the attempt cap) — a quiet tick never reaches it.
 *
 * Reads the check-run annotations rather than the logs: the exit code is in the
 * `##[error]` annotation, which is a small JSON document, where the log is a
 * multi-megabyte zip.
 */
async function jobWasKilled(repo: string, jobId: number, token: string): Promise<boolean> {
	const anns = await ghGet<GhAnnotation[]>(`/check-runs/${jobId}/annotations`, token, repo);
	if (!Array.isArray(anns)) return false;
	return anns.some((a) => typeof a?.message === 'string' && SIGKILL_ANNOTATION.test(a.message));
}

let started = false;
/**
 * NODE name → consecutive ticks seen OFFLINE. Keyed by node, not runner,
 * so one dead box is one message rather than one per registration.
 *
 * The `claw-N-b` second instances this was written for were retired on
 * 2026-08-24, but the grouping is not vestigial: `hokon-tenhands` is a live
 * second registration on hokon (443 job records), and a JIT runner is named per
 * job. `nodeOf` folds both.
 */
const offlineTicks = new Map<string, number>();

/**
 * Watched label → consecutive ticks it was judged UNSERVED (no standing online
 * runner, no eligible minting offerer).
 *
 * The label floor used to page on the FIRST tick at zero, which made it fire on
 * every transient disconnect. On 2026-08-20 all four hokon runners dropped
 * their broker long-poll for ~10s (`SocketException (125): Operation canceled`,
 * then `Back off 9.591 seconds`), and `pm2-host` paged "will queue forever"
 * while nothing was wrong — no process had restarted, and the PM2 deploy 36
 * minutes earlier had run fine. That runner log holds 115 such backoffs in two
 * days, so this was not a one-off.
 *
 * `alertOnce` could not absorb it: that is a re-alert RATE LIMIT, and
 * `clearAlert` deliberately re-arms so the next occurrence fires immediately —
 * correct for a condition that stays broken, wrong for one that flaps.
 *
 * So the floor now debounces on OFFLINE_TICKS_BEFORE_ALERT, exactly as the
 * per-node check below already does, and for the reason that constant
 * already documents: a blip clears well inside it, a real outage does not.
 * Only the ALERT waits — `labelOnline` and the sitrep still report zero the
 * moment it is true, because that is a fact about now and this is a judgement
 * about whether it is worth waking someone.
 */
const labelZeroTicks = new Map<string, number>();

/**
 * Repo → consecutive ticks its CI_RUNNER write has FAILED.
 *
 * Counted rather than alerted on sight for the same reason the label floor is:
 * a 403 from a token whose scope was revoked is permanent and worth waking
 * someone for, a 502 from GitHub's control plane is neither. Two ticks is 20
 * minutes, which no transient survives and every real one does.
 */
const ciRunnerWriteFailTicks = new Map<string, number>();

/** NODE name → how many times its outage has been re-announced. */
const offlineRepeats = new Map<string, number>();

/**
 * Escalating re-alert schedule for a sustained outage, mirroring heartbeat.ts
 * and worker-health-alerts. A dead node needs hands and may wait days; a
 * fixed hourly ping for a condition the operator already knows about is the
 * noise that teaches people to mute the channel.
 */
const OFFLINE_REPEAT_BACKOFF_MS = [
	1 * 60 * 60 * 1000,
	4 * 60 * 60 * 1000,
	12 * 60 * 60 * 1000,
	24 * 60 * 60 * 1000,
];

/**
 * Ticks a runner must be offline before it is worth saying anything (~20 min at
 * TICK_INTERVAL_MS). A reboot or a Tailscale blip clears well inside that; a
 * node that is actually gone does not. Same debounce shape as
 * worker-health-alerts.
 */
const OFFLINE_TICKS_BEFORE_ALERT = 2;

/**
 * Consecutive ticks the dispatcher's capacity ledger (`capacity-ledger.ts`)
 * must show a node charged more than it is running before it pages. Three,
 * not two: a unit listed between a job's end and its unit's exit, or a probe
 * one fast-loop tick behind a warm assignment, can break the invariant for one
 * pass honestly; three ticks is a quarter of an hour, and no race lasts that.
 */
const CAPACITY_TICKS_BEFORE_ALERT = 3;
/** NODE name → consecutive ticks its ledger entry has been broken. */
const capacityBrokenTicks = new Map<string, number>();

/**
 * A floor zero is READ TWICE, seconds apart, before the tick counts as a breach.
 *
 * The tick debounce above absorbs a blip that clears within ten minutes. It does
 * NOT absorb the failure mode it was written for when that failure lasts hours:
 * on 2026-09-12 GitHub's broker answered hokon's message long-poll with
 * `InternalServerError` repeatedly between 19:21Z and 22:45Z, and through that
 * window `/actions/runners` reported hokon — and every warm claw — `offline`
 * on some reads and `online` on others, ten minutes apart. Eighteen 🚨 went out
 * over eleven hours claiming `pm2-host`, `taskauto` and `av1-nvenc` had no
 * online runner and that jobs "will queue" (#24).
 *
 * They had not. GitHub scheduled and completed a `redeploy` job ON hokon at
 * 06:12:32-06:12:50Z, and the 06:13:49Z tick then read `pm2-host=0
 * hokon:offline` seventy-seven seconds later. The listing was faithful to what
 * the API returned; the API's `status` was momentarily wrong. Two consecutive
 * TICKS can both land in such a window — and did, twelve times in a row —
 * because the degradation outlives the debounce. Two READS seconds apart do
 * not, because the listener re-polls in between.
 *
 * Retrying is NOT tolerating (see `check-queue-health`'s READ_ATTEMPTS): a zero
 * both reads agree on still advances the streak and still pages. Only an
 * UNCONFIRMED zero is held — and held, not cleared, so a sustained outage that
 * flaps keeps its streak instead of being reset by the flapping.
 */
const FLOOR_CONFIRM_DELAY_MS = 5000;

/** Test seam for {@link FLOOR_CONFIRM_DELAY_MS}. Not part of the supported API. */
let floorConfirmDelayMs: number = FLOOR_CONFIRM_DELAY_MS;
export function __setFloorConfirmDelayForTesting(ms: number | null): void {
	floorConfirmDelayMs = ms ?? FLOOR_CONFIRM_DELAY_MS;
}

/**
 * Indirection purely so tests can SEE the ledger-only path.
 *
 * A quiet record makes no fetch, so the stubbed-fetch harness these tests use
 * cannot observe it — and a test that only asserted "nothing was posted to
 * Discord" would keep passing if the condition stopped being DETECTED at all,
 * which is the failure that matters. This lets them assert the record instead
 * of its absence.
 */
let quietRecorder: (content: string, source: string) => void = recordAlertQuietly;

/** Test-only seam. */
export function __setQuietRecorderForTesting(
	fn: ((content: string, source: string) => void) | null
): void {
	quietRecorder = fn ?? recordAlertQuietly;
}

// key → last alert epoch ms. A key absent (or older than RE_ALERT_MS) re-fires.
const lastAlertAt = new Map<string, number>();

/**
 * Alert suppression SURVIVES A RESTART.
 *
 * `lastAlertAt` was in-memory only, so every mgmt-api restart re-armed every
 * condition and the next tick re-paged all of them. A sustained problem is
 * supposed to ping hourly; on 2026-08-29 a deploy-heavy session restarted this
 * process six times and the same two conditions — one failed unit, one queued
 * run — paged 10 minutes apart repeatedly. The alert was correct every time and
 * the channel still became unreadable, which is how an alert gets trained away.
 *
 * Persisted as a plain map of key -> epoch ms next to the other operator state.
 * Entries older than the window are dropped on load, so the file cannot grow
 * without bound and a long-cleared condition still alerts immediately when it
 * returns.
 *
 * Fail-soft in BOTH directions: an unreadable or corrupt ledger means "nothing
 * suppressed" (alert, do not go quiet), and a failed write is logged and
 * ignored (a noisy channel beats a crashed monitor).
 */
const ALERT_LEDGER = () => join(stateDir(), 'runner-health-alerts.json');
let ledgerLoaded = false;

function loadAlertLedger(): void {
	if (ledgerLoaded) return;
	ledgerLoaded = true;
	try {
		const raw = JSON.parse(readFileSync(ALERT_LEDGER(), 'utf8')) as Record<string, unknown>;
		const cutoff = Date.now() - RE_ALERT_MS;
		for (const [k, v] of Object.entries(raw)) {
			if (typeof v === 'number' && v > cutoff) lastAlertAt.set(k, v);
		}
	} catch {
		// No file yet, or unreadable. Suppress nothing — alerting twice is a
		// nuisance, staying silent about a live problem is not.
	}
}

function saveAlertLedger(): void {
	try {
		const cutoff = Date.now() - RE_ALERT_MS;
		const out: Record<string, number> = {};
		for (const [k, v] of lastAlertAt) if (v > cutoff) out[k] = v;
		mkdirSync(dirname(ALERT_LEDGER()), { recursive: true });
		writeFileSync(ALERT_LEDGER(), JSON.stringify(out));
	} catch (err) {
		logger.warn(
			`[runner-health] could not persist the alert ledger: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}
// Repos currently flipped to hosted. Process-local, and deliberately so: it is a
// CHANGE-detector for alerting, not the source of truth. The GitHub variable is
// the truth.
//
// This set is EMPTY after a restart, and empty means "unknown", not "nothing is
// hosted". `syncHostedFallback` therefore ignores it on the first pass of a new
// process and writes through — without that, a restart during a hosted window
// left every repo pinned to billed runners with nothing able to clear it, which
// is exactly what happened on 2026-08-17. Do not reintroduce a skip that treats
// this set as authoritative before the first reconcile.
const hostedRepos = new Set<string>();

// Failover dedupe: runs we've already auto-rerun, keyed `${runId}@${attempt}`.
// Persists across ticks so we never double-fire before GitHub bumps the attempt.
const failoverReran = new Set<string>();

/** Last-tick health snapshot, surfaced through the local-sitrep so runner
 *  state is visible without waiting for a Discord alert. Null until the first
 *  tick of a process, unless a recent one was persisted — see `lastSnapshot`. */
export interface RunnerHealthSnapshot {
	at: string;
	runnersChecked: boolean;
	runsChecked: boolean;
	online?: number;
	offline?: number;
	labelOnline?: Record<string, number>;
	/** Watched label → the floor's verdict this tick. `labelOnline` is the standing half only. */
	labelFloor?: Record<string, LabelFloorVerdict['state']>;
	clawsOnline?: number;
	/** Claws online AND idle. Zero means the next job queues — see backstop_reason. */
	claws_free?: number;
	claws_free_standing?: number;
	claws_free_mintable?: number;
	/**
	 * NODES that can mint, as distinct from the SLOTS they have free.
	 *
	 * Published so a reader holding a FRESHER probe can subtract the ephemeral
	 * half out of `clawsOnline` / `claws_free` and put its own back in — which is
	 * what the fleet route does. Without it the two halves are only available
	 * summed, and the sum cannot be re-based.
	 */
	claws_mintable_online?: number;
	/** MACHINES ready to take a job now. See census.clawsReady. */
	claws_ready?: number;
	/** Ready STANDING machines alone, so a fresher reader can re-base the ephemeral half. */
	claws_ready_standing?: number;
	/**
	 * The fleet declares ephemeral nodes and no probe snapshot existed when these
	 * counts were taken, so every mintable figure above is a FLOOR, not a
	 * reading. See census.mintableCapacity.
	 */
	ephemeral_unknown?: boolean;
	/** node -> what it is doing. Contract shared with the fleet route's UI. */
	claw_state?: Record<string, ClawState>;
	/** Every claw busy. Necessary for a saturation promote, no longer sufficient. */
	at_capacity?: boolean;
	/**
	 * Age of the oldest run that cannot start, in seconds, EXCLUDING zombies.
	 *
	 * 0 means "probed, and nothing recent is waiting". It is not 0 off capacity —
	 * that stopped being true on 2026-09-24 (#63) — and it is no longer inflated
	 * by a permanently-queued run: see `QUEUE_ZOMBIE_SECONDS`.
	 */
	queue_pressure_sec?: number;
	/**
	 * Queued runs the probe SAW and refused on age. Never zero-meaning-nothing:
	 * a positive value here with `queue_pressure_sec: 0` is a fleet with stuck
	 * work and no live pressure, which is two separate facts and two jobs.
	 */
	queue_zombies_ignored?: number;
	/** Why hokon is being held off builder work, if it is: cron-running | cron-window | pm2-host. */
	reserved_reason?: string | null;
	/** Why the hokon backstop is up: 'outage' | 'saturation' | 'none'. */
	backstop_reason?: BackstopReason;
	/** hokon runners relabelled across the fleet on the last transition. */
	/**
	 * SOME node is serving pm2-host work — the top rung of the priority ladder.
	 *
	 * Fleet-wide on purpose: it is a panel pill, and the wire type
	 * (`fleet-report-types.ts`) is a boolean. WHICH nodes is kept per node inside
	 * the tick and published through `setPm2HostBusy`, because the ladder places
	 * on a box and this does not.
	 */
	pm2_host_busy?: boolean;
	/** Live per-runner state: what GitHub will actually schedule right now. */
	runner_state?: { name: string; status: string; busy: boolean; labels: string[] }[];
	queuedStale?: number;
	inprogressStale?: number;
	/** Runs queued right now, at ANY age — the stale counters only see the tail. */
	queued_now?: number;
	running_now?: number;
	/** Age of the oldest queued run, minutes. The queue-depth signal. */
	oldest_queued_min?: number;
	/** Age of the longest in-progress run, minutes. The runtime signal. */
	longest_running_min?: number;
	/** Jobs auto-rerun this tick (dropped runner + OOM). */
	failoverReruns?: number;
	/** The subset of failoverReruns that were OOM kills — a CAPACITY signal. */
	oomReruns?: number;
	/** A watched label nothing serves — no standing online runner, no eligible mint. Jobs would queue forever. */
	floorBreach: boolean;
	/**
	 * node -> is `checkStarvation`'s finding currently true for it (wave 4a,
	 * #100). Only EPHEMERAL nodes this process has a fresh `admitMint` verdict
	 * for can appear `true`; an absent key is "never found", not "admitted" —
	 * see `checkStarvation`'s own docblock for why a tick that could not look
	 * carries the PREVIOUS reading forward instead of clearing it here.
	 */
	starved?: Record<string, boolean>;
	/**
	 * node -> `checkDiskWatch`'s verdict this tick (wave 4c §F) — the `_work`
	 * filesystem read early, before admission itself would refuse a mint. An
	 * absent key is "never looked yet" (the `ephemeral-tick.ts` hunk has not
	 * landed, or this process just restarted), never "ok" — see
	 * `checkDiskWatch`'s own docblock.
	 */
	diskWatch?: Record<string, DiskWatchLevel>;
	/**
	 * node -> its /tmp size in MB, for every node whose /tmp is too small to
	 * hold a full floor of runway (#132, `tmpIsSmall`). A capacity fact, not a
	 * finding: `checkDiskWatch` says it ONCE, when a node first appears here,
	 * and this persisted field is what remembers it said so across mgmt-api's
	 * restarts — the alert ledger forgets after RE_ALERT_MS, which is exactly
	 * the hourly repeat this replaced.
	 */
	tmpSmall?: Record<string, number>;
}

let lastSnapshot: RunnerHealthSnapshot | null = null;

/**
 * The last tick's snapshot also lives on disk, so a restarted process can serve
 * a DATED census while its first tick is still in flight.
 *
 * mgmt-api redeploys on every push that touches it — ten times on 2026-09-01 —
 * and each restart used to blank every runner-health field on the Fleet tab
 * until the first tick landed. The first tick now fires at t=0, so the window is
 * seconds rather than a minute, but it is still a window, and "null" there is
 * indistinguishable from "the monitor is broken".
 *
 * The restored snapshot keeps ITS OWN `at`. The fleet route renders that as
 * `healthAt`, separately from the probe's timestamp, so a stale census reads as
 * stale rather than as now. Never re-stamp it. And a census older than
 * `SNAPSHOT_RESTORE_MAX_AGE_MS` is not served at all: six ticks without a write
 * means the fleet has gone unwatched for an hour, and nothing that old is a
 * better answer than "not measured yet".
 *
 * Fail-soft in both directions: an unreadable, corrupt or malformed file
 * restores nothing, and a failed write is logged and ignored.
 */
export const SNAPSHOT_RESTORE_MAX_AGE_MS = 6 * TICK_INTERVAL_MS;
let snapshotPathOverride: string | null = null;
const SNAPSHOT_FILE = () => snapshotPathOverride ?? join(stateDir(), 'runner-health-snapshot.json');
let snapshotRestoreTried = false;

export function __setSnapshotPathForTesting(path: string | null): void {
	snapshotPathOverride = path;
}

function persistSnapshot(snap: RunnerHealthSnapshot): void {
	try {
		mkdirSync(dirname(SNAPSHOT_FILE()), { recursive: true });
		writeFileSync(SNAPSHOT_FILE(), JSON.stringify(snap));
	} catch (err) {
		logger.warn(
			`[runner-health] could not persist the health snapshot: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

function restoreSnapshot(): RunnerHealthSnapshot | null {
	try {
		const raw = JSON.parse(readFileSync(SNAPSHOT_FILE(), 'utf8')) as Partial<RunnerHealthSnapshot>;
		if (
			typeof raw.at !== 'string' ||
			typeof raw.runnersChecked !== 'boolean' ||
			typeof raw.runsChecked !== 'boolean' ||
			typeof raw.floorBreach !== 'boolean'
		) {
			return null;
		}
		const age = Date.now() - Date.parse(raw.at);
		if (!Number.isFinite(age) || age < 0 || age > SNAPSHOT_RESTORE_MAX_AGE_MS) return null;
		return raw as RunnerHealthSnapshot;
	} catch {
		return null;
	}
}

export function getRunnerHealthSnapshot(): RunnerHealthSnapshot | null {
	if (!lastSnapshot && !snapshotRestoreTried) {
		snapshotRestoreTried = true;
		lastSnapshot = restoreSnapshot();
	}
	return lastSnapshot;
}

/**
 * What one tick measured. Every `data.*` key the three check functions write.
 *
 * This was `Record<string, unknown>`, and `captureSnapshot` read it back through
 * 21 `as T` casts. Both sides compiled fine if either misspelled a key — the
 * snapshot field simply came back `undefined`, `routes/fleet.ts` mapped that to
 * `null`, and the Fleet panel rendered "—", which is indistinguishable from "not
 * measured yet". 17 of the 24 fields had no test that would have noticed.
 *
 * A type alias rather than an interface on purpose: it must stay assignable to
 * `Record<string, unknown>` for the job-sink payload, and an interface is not.
 */
type TickReport = {
	/** The node this tick ran on — stamped into every job-sink record. */
	host?: string;
	runners_checked?: boolean;
	runs_checked?: boolean;
	claws_online?: number;
	claws_registered?: number;
	backstop_online?: number;
	claws_free?: number;
	claws_free_standing?: number;
	claws_free_mintable?: number;
	claws_mintable_online?: number;
	/** MACHINES ready to take a job now. See census.clawsReady. */
	claws_ready?: number;
	/** Ready STANDING machines alone, so a fresher reader can re-base the ephemeral half. */
	claws_ready_standing?: number;
	ephemeral_unknown?: boolean;
	claw_state?: Record<string, ClawState>;
	pm2_host_busy?: boolean;
	runner_state?: RunnerHealthSnapshot['runner_state'];
	queue_pressure_sec?: number;
	queue_zombies_ignored?: number;
	at_capacity?: boolean;
	reserved_reason?: string | null;
	backstop_reason?: BackstopReason;
	backstop_calm_ticks?: number;
	/** 'hosted' | 'fleet' — reaches the digest through the job-sink payload. */
	ci_runner?: string;
	ci_runner_write_failed?: number;
	online?: number;
	offline?: number;
	label_online?: Record<string, number>;
	/**
	 * Watched label → how the floor judged it this tick: `standing`, `minting`,
	 * `unmeasured` (held — the probe has not run) or `unserved`. See label-floor.ts.
	 */
	label_floor?: Record<string, LabelFloorVerdict['state']>;
	/** Why the static half of the floor's demand could not be read, or absent when it was. */
	label_floor_static_problem?: string;
	queued_stale?: number;
	inprogress_stale?: number;
	queued_now?: number;
	running_now?: number;
	oldest_queued_min?: number;
	longest_running_min?: number;
	failover_reruns?: number;
	oom_reruns?: number;
	repos_scanned?: number;
	supervision_problems?: number;
	supervision_listeners?: number;
	supervision_unreachable?: string[];
	/** @see RunnerHealthSnapshot.starved */
	starved?: Record<string, boolean>;
	/** @see RunnerHealthSnapshot.diskWatch */
	diskWatch?: Record<string, DiskWatchLevel>;
	/** @see RunnerHealthSnapshot.tmpSmall */
	tmp_small?: Record<string, number>;
};

function captureSnapshot(data: TickReport, runnersChecked: boolean, runsChecked: boolean): void {
	const labelOnline = data.label_online;
	const floorBreach = runnersChecked
		? Object.values(data.label_floor ?? {}).some((v) => v === 'unserved')
		: false;
	lastSnapshot = {
		at: new Date().toISOString(),
		runnersChecked,
		runsChecked,
		online: data.online,
		offline: data.offline,
		labelOnline,
		labelFloor: data.label_floor,
		clawsOnline: data.claws_online,
		claws_free: data.claws_free,
		claws_free_standing: data.claws_free_standing,
		claws_free_mintable: data.claws_free_mintable,
		claws_mintable_online: data.claws_mintable_online,
		claws_ready: data.claws_ready,
		claws_ready_standing: data.claws_ready_standing,
		ephemeral_unknown: data.ephemeral_unknown,
		claw_state: data.claw_state,
		at_capacity: data.at_capacity,
		queue_pressure_sec: data.queue_pressure_sec,
		queue_zombies_ignored: data.queue_zombies_ignored,
		reserved_reason: data.reserved_reason,
		backstop_reason: data.backstop_reason,
		pm2_host_busy: data.pm2_host_busy,
		runner_state: data.runner_state,
		queuedStale: data.queued_stale,
		inprogressStale: data.inprogress_stale,
		queued_now: data.queued_now,
		running_now: data.running_now,
		oldest_queued_min: data.oldest_queued_min,
		longest_running_min: data.longest_running_min,
		// Auto-reruns this tick. Previously these survived ONLY if the sink write
		// succeeded, so the one number that says "CI is self-healing, and how hard"
		// was invisible to the local sitrep.
		failoverReruns: data.failover_reruns,
		oomReruns: data.oom_reruns,
		floorBreach,
		starved: data.starved,
		diskWatch: data.diskWatch,
		tmpSmall: data.tmp_small,
	};
	persistSnapshot(lastSnapshot);
}

/**
 * The string `os.hostname()` returns for THIS box.
 *
 * Named for the meaning, not the word: `host` in this package is the injected
 * dependency container (`FleetHost`), and this used to be a private
 * `function host()` returning a hostname — the third meaning of the word spelled
 * as the first. See docs/VOCABULARY.md §"`host` is three different things".
 */
function selfHostname(): string {
	return os.hostname();
}

/**
 * Why a GitHub call failed, in one line an operator can act on.
 *
 * `resp.status` alone is not a diagnosis. A 403 is primary rate limiting,
 * SECONDARY (burst) rate limiting, or a permissions failure — three different
 * problems with three different fixes, and this logged the same word for all
 * three while discarding the body that distinguishes them.
 *
 * That cost real time on 2026-09-02: `ci:queue-health` failed with "could not
 * read the queue for 26 repo(s)" and pinning it to a concurrency burst took a
 * subagent and an archaeology pass through the logs, because nothing recorded
 * GitHub's own message or a single x-ratelimit header. Both were on the
 * response and both were thrown away.
 *
 * PRIMARY is `remaining: 0` — the hourly budget is spent and `reset` says when.
 * SECONDARY is a burst: the budget still has room, GitHub says so in the
 * message, and `retry-after` is the wait. They are told apart HERE rather than
 * by a human reading a count later.
 *
 * Never throws and never blocks the caller's fail-soft path: a body that will
 * not read degrades to the status line it already had.
 */
async function describeGhFailure(resp: Response): Promise<string> {
	let message = '';
	try {
		const text = await resp.text();
		message = messageFrom(text);
	} catch {
		// A body that will not read is not worth failing over — the status and
		// the headers are already more than this used to say.
	}
	const described = describeGhStatus(resp, message);
	// Every failed READ also records its kind, for `unreadableTickError`.
	lastGhReadFailure = {
		kind: classifyGhReadFailure(resp.status, resp.headers.get('x-ratelimit-remaining'), message),
		detail: described,
	};
	return described;
}

/** The `message` GitHub sent, from a body that may not be JSON. */
function messageFrom(text: string): string {
	if (!text) return '';
	try {
		const parsed = JSON.parse(text) as { message?: string };
		return parsed.message ?? text.slice(0, 160);
	} catch {
		return text.slice(0, 160);
	}
}

/**
 * The classification, over a response whose body the caller has already read.
 *
 * Split out because `ghWrite` consumes its own body to return it, and a
 * Response body can only be read once — re-reading it there would throw and
 * lose the diagnosis entirely.
 */
function describeGhStatus(resp: Response, message: string): string {
	const h = (n: string) => resp.headers.get(n);
	const remaining = h('x-ratelimit-remaining');
	const limit = h('x-ratelimit-limit');
	const used = h('x-ratelimit-used');
	const reset = h('x-ratelimit-reset');
	const retryAfter = h('retry-after');

	const parts = [`HTTP ${resp.status}`];
	if (message) parts.push(`"${message}"`);

	// The classification is the point. `remaining: 0` is the hourly budget;
	// anything else that mentions a rate limit is the burst one, and only the
	// second is fixed by narrowing concurrency.
	const isPrimary = remaining === '0';
	const mentionsSecondary = /secondary rate limit/i.test(message);
	if (isPrimary) parts.push('PRIMARY rate limit (hourly budget spent)');
	else if (mentionsSecondary || retryAfter)
		parts.push('SECONDARY rate limit (burst — narrow concurrency)');

	if (remaining !== null) parts.push(`rate=${used ?? '?'}/${limit ?? '?'} remaining=${remaining}`);
	if (reset) {
		const secs = Number(reset) - Math.floor(Date.now() / 1000);
		if (Number.isFinite(secs)) parts.push(`resets_in=${Math.max(0, secs)}s`);
	}
	if (retryAfter) parts.push(`retry_after=${retryAfter}s`);
	return parts.join(' ');
}

/**
 * When the PRIMARY budget refills, epoch ms. 0 means "not known to be spent".
 *
 * @see noteGhRateLimit for why this exists.
 */
let primaryResetAtMs = 0;
/** Whether the current blackout has already been logged. One line, not thousands. */
let blackoutAnnounced = false;

/**
 * The longest blackout this will honour, however bad the header looks.
 *
 * GitHub's window is an hour, so anything past that is a clock skew or a
 * malformed header rather than a real reset — and a bad header must not be able
 * to mute the fleet's only view of itself for longer than the real limit could.
 */
const MAX_BLACKOUT_MS = 60 * 60_000;

/**
 * Record a spent hourly budget, so the callers stop asking until it refills.
 *
 * WHY SUPPRESSION IS THE RIGHT ANSWER HERE, AND ONLY HERE. `remaining: 0` is
 * not a fault in one call — it is one fact about the TOKEN, and every other
 * call sharing it is already decided. Retrying is not optimism, it is arithmetic
 * that cannot come out differently until the reset.
 *
 * Measured 2026-09-06: the reap sweep kept walking all 27 repos, and the timer
 * ran it again 15 seconds later, for the whole 19-minute blackout — ~108
 * guaranteed-403 calls a minute, 6,903 in the log. None of them could have
 * succeeded. They cost no primary budget (a denied call is already denied) but
 * they are exactly the burst shape GitHub's SECONDARY limiter watches for, so
 * the spin risked converting a blackout that ends on a clock into one that
 * extends itself.
 *
 * ONLY THE PRIMARY LIMIT. A secondary limit means "too fast", is usually seconds
 * long and carries `retry-after`; the fix for it is narrower concurrency, not a
 * fleet-wide stop. Tripping this on one would stall everything over a burst that
 * had already passed.
 *
 * FAILS OPEN. A response with no usable `x-ratelimit-reset` does not trip it: a
 * few doomed calls are cheaper than a blackout with no end, and a missing header
 * is the one case where we genuinely do not know when to look again.
 */
function noteGhRateLimit(resp: Response, nowMs = Date.now()): void {
	if (resp.headers.get('x-ratelimit-remaining') !== '0') return;
	const reset = Number(resp.headers.get('x-ratelimit-reset'));
	if (!Number.isFinite(reset) || reset <= 0) return;
	const until = reset * 1000;
	if (until <= nowMs) return;
	primaryResetAtMs = Math.min(until, nowMs + MAX_BLACKOUT_MS);
}

/**
 * Milliseconds until the budget refills, or 0 when it is not known to be spent.
 *
 * This is the ONLY thing that reads the blackout, and it clears itself: once the
 * clock passes the reset, the next call goes out for real and either succeeds or
 * re-arms this. Nothing has to remember to reopen it.
 *
 * EXPORTED since 2026-09-08 so `scripts/floor-probe.mjs` can honour the same
 * blackout the reap and the label sweep already do, instead of becoming the
 * fourth uncoordinated caller on this token. Export only — the behaviour, the
 * clearing and the one-line-per-blackout warning are unchanged.
 */
export function ghBlackoutRemainingMs(nowMs = Date.now()): number {
	if (!primaryResetAtMs) return 0;
	if (nowMs >= primaryResetAtMs) {
		primaryResetAtMs = 0;
		blackoutAnnounced = false;
		return 0;
	}
	if (!blackoutAnnounced) {
		blackoutAnnounced = true;
		logger.warn(
			`[runner-health] PRIMARY rate limit spent — suppressing GitHub calls for ` +
				`${Math.ceil((primaryResetAtMs - nowMs) / 1000)}s until the budget refills. ` +
				`Callers see "could not look", NOT "nothing to do" (said ONCE per blackout). ` +
				`Spent by: ${ghBudgetSummary()}`
		);
	}
	return primaryResetAtMs - nowMs;
}

/**
 * Why the most recent GitHub GET came back "could not look", by KIND.
 *
 * `tick` fails the job when neither the runner listing nor the runs could be
 * read, and until 2026-10-11 it said "GitHub Actions API unreachable or
 * HADOKU_SITE_TOKEN lacks repo scope" whatever the cause. That day's 08:14Z
 * failure was a spent primary budget — 403 "API rate limit exceeded" at
 * 08:12:52 and a 226 s blackout — while the token logged `scopes='repo,
 * workflow'` on every start. A rate limit, a network fault and a missing scope
 * are three different jobs, and only the last is fixed by touching the token.
 */
export type GhReadFailureKind = 'rate-limit' | 'auth' | 'http' | 'network';
export interface GhReadFailure {
	kind: GhReadFailureKind;
	detail: string;
}
let lastGhReadFailure: GhReadFailure | null = null;

/** The kind of a non-ok response. Rate limits are 403s too, so they go first. */
export function classifyGhReadFailure(
	status: number,
	remaining: string | null,
	message: string
): GhReadFailureKind {
	if (status === 429 || remaining === '0' || /rate limit/i.test(message)) return 'rate-limit';
	if (status === 401 || status === 403 || status === 404) return 'auth';
	return 'http';
}

function noteGhReadBlackout(): void {
	lastGhReadFailure = {
		kind: 'rate-limit',
		detail: `primary rate limit spent — calls suppressed for ${Math.ceil(ghBlackoutRemainingMs() / 1000)}s more`,
	};
}

function noteGhReadError(err: unknown): string {
	const detail = err instanceof Error ? err.message : String(err);
	lastGhReadFailure = { kind: 'network', detail };
	return detail;
}

/**
 * The job error for a tick that could read nothing, from WHY it could not.
 * Only an auth-shaped answer points at the token's scope.
 */
export function unreadableTickError(f: GhReadFailure | null): string {
	if (!f)
		return 'GitHub Actions API could not be read this tick (no failure was recorded — could not look)';
	switch (f.kind) {
		case 'rate-limit':
			return `GitHub API rate limit spent — could not look this tick, the token is fine (${f.detail})`;
		case 'network':
			return `GitHub Actions API unreachable (network/timeout: ${f.detail}) — could not look this tick`;
		case 'http':
			return `GitHub Actions API answered an error (${f.detail}) — could not look this tick`;
		case 'auth':
			return (
				`HADOKU_SITE_TOKEN was refused (${f.detail}) — it may lack repo scope ` +
				'(need runner-listing + Actions:read)'
			);
	}
}

/** Test seam. Not part of the supported API. */
export function __resetGhBlackoutForTesting(): void {
	primaryResetAtMs = 0;
	blackoutAnnounced = false;
}

/**
 * A GET that can come back "unchanged" for FREE.
 *
 * GitHub does not charge a conditional request that answers 304 against the
 * hourly budget. Measured 2026-09-04 on this account: 20 conditional requests
 * moved `used` by 0, 20 plain ones moved it by 19.
 *
 * That is the difference between polling being affordable and not. The
 * dispatcher lists queued runs for 26 repos every tick, and almost every one is
 * unchanged almost every time — on 2026-09-04 the token hit `remaining: 0` and
 * 424 of the 478 rate-limited calls were this exact listing, while the daily
 * 13:00 cron cluster shared the same budget.
 *
 * `unchanged` is NOT `error` and must never be collapsed into it: the caller
 * reuses its cached body, where an error means "I could not look" and has to
 * suppress action. That distinction is the whole point of the three-valued
 * return.
 */
export type ConditionalGet<T> =
	{ status: 'ok'; body: T; etag: string | null } | { status: 'unchanged' } | { status: 'error' };

export async function ghGetConditional<T>(
	path: string,
	token: string,
	repo: string,
	etag: string | null
): Promise<ConditionalGet<T>> {
	// `error`, never `unchanged`. Suppression means we did not look, and
	// `unchanged` would tell the dispatcher its cached body is still current —
	// turning a blackout into a fleet that confidently mints against a stale
	// queue for 19 minutes.
	if (ghBlackoutRemainingMs() > 0) {
		noteGhReadBlackout();
		return { status: 'error' };
	}
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': userAgent('runner-health'),
		};
		if (etag) headers['If-None-Match'] = etag;
		const resp = await fetch(ghUrl(repo, path), { headers, signal: controller.signal });
		clearTimeout(timeoutId);
		recordGhResponse(token, resp.status, resp.headers);
		// 304 is a SUCCESS that costs nothing. `resp.ok` is false for it, so this
		// must be checked before the generic failure path below or every free
		// answer would be logged as a fault.
		if (resp.status === 304) return { status: 'unchanged' };
		if (!resp.ok) {
			noteGhRateLimit(resp);
			logger.warn(`[runner-health] GET ${path} → ${await describeGhFailure(resp)}`);
			return { status: 'error' };
		}
		return { status: 'ok', body: (await resp.json()) as T, etag: resp.headers.get('etag') };
	} catch (err) {
		clearTimeout(timeoutId);
		logger.warn(`[runner-health] GET ${path} failed: ${noteGhReadError(err)}`);
		return { status: 'error' };
	}
}

/**
 * EVERY `ghGet` IS A CONDITIONAL REQUEST, and a 304 is free.
 *
 * Until 2026-10-16 only the dispatcher's queued-runs poll and its jobs probe
 * sent `If-None-Match`; everything else through `ghGet` paid full price on
 * every call. That was justified, at four call sites, as "this reader must see
 * CURRENT state, so it cannot send an ETag". The premise is false. A 304 is
 * GitHub's statement that the representation it would serve NOW has the ETag
 * we sent — it is a fresh look at current state, answered from the server's
 * side, not a cached guess. The dispatcher's own cache already says so ("it
 * means the cached body IS the current one"), and acts on it every 15s.
 * Checked live the same day: 160 conditional requests, each made right AFTER
 * an unconditional read of the same URL (three repos' runner listings and an
 * in-progress runs listing, during CI traffic). The body changed 39 times and
 * every one of those was answered 200; none of the 117 304s disagreed with
 * the read just before it.
 *
 * Why it matters, from the first measured hour (#119, 762 charged calls): the
 * reap (348), runner-health (289), ci-alerts (288), the warm cache (195) and
 * the backstop sweep (93) had ZERO 304s between them, against 4,764 for the
 * one poll that sent an ETag. Every one of those reads is a listing that is
 * unchanged on most calls on a quiet fleet.
 *
 * THE CEILING IS STILL THE SPEND. A listing whose body changes between calls —
 * a repo with jobs running, whose runners flip `busy` — answers 200 every time
 * and is charged every time. So a cadence must still be sized against the case
 * where every answer changed; this lowers the typical bill, not the worst one,
 * and must never be the reason a timer is sped up.
 *
 * Kept per (token, repo, path) as response TEXT, parsed on every read: a caller
 * that edits the object it was handed (runner-health demotes a runner by
 * rewriting `labels` in place) can never corrupt what the next caller is
 * served. Bounded by bytes, oldest-touched first, because per-run `/jobs`
 * paths are unbounded in number and almost never asked twice.
 *
 * Module state, lost on restart: the first read of each path after a restart
 * is charged, and refills its entry.
 */
export const GH_CACHE_MAX_BYTES = 32 * 1024 * 1024;
interface GhCached {
	repo: string;
	path: string;
	etag: string | null;
	text: string;
	/**
	 * When GitHub last vouched for this body: the 200 that carried it, or a 304
	 * since. 0 when a runner write for the repo may have made it stale — see
	 * `readRunnerListingShared`.
	 */
	atMs: number;
}
const ghCache = new Map<string, GhCached>();
let ghCacheBytes = 0;

function ghCacheKey(token: string, repo: string, path: string): string {
	return `${ghTokenFingerprint(token)}\n${repo}\n${path}`;
}

function ghCacheStore(key: string, entry: GhCached): void {
	const prev = ghCache.get(key);
	if (prev) {
		ghCacheBytes -= prev.text.length;
		ghCache.delete(key);
	}
	// Re-inserted, so Map order is touch order and the first key is the oldest.
	ghCache.set(key, entry);
	ghCacheBytes += entry.text.length;
	for (const [k, v] of ghCache) {
		if (ghCacheBytes <= GH_CACHE_MAX_BYTES || k === key) break;
		ghCache.delete(k);
		ghCacheBytes -= v.text.length;
	}
}

/**
 * ONE RUNNER LISTING PER REPO PER WINDOW, shared by every loop that can use one
 * that is a few minutes old (#118).
 *
 * The same `/actions/runners` listing was fetched per repo by the JIT reap,
 * the warm cache, runner-health's backstop sweep and its queued-run classifier,
 * each on its own clock and none aware of the others. runner-health's share —
 * ~120-150 calls a tick, six ticks in the 2026-10-16 18:30-19:15Z window that
 * ended in the blackout — repeated listings another loop had just paid for.
 *
 * So every SUCCESSFUL listing read through `ghGet` is kept (in `ghCache`,
 * above), whoever asked, and `readRunnerListingShared` answers from it while
 * GitHub vouched for it recently enough — a 304 counts. It is GitHub's
 * response, not anyone's record of what they wrote: the reader-writer rule is
 * not touched by who happened to pay for the read.
 *
 * WHO MAY READ IT, AND WHO MAY NOT. A reader that DELETES or EVICTS on the
 * answer — the reap, the warm cache's busy/online check — must see current
 * state and keeps calling `ghGet` itself (a revalidation: free when unchanged,
 * and it refreshes this as a side effect). The label-floor census pages, so it
 * and its confirming second look stay fresh too. What reads from here is
 * runner-health's backstop label sweep and its queued-run classifier, which
 * already act on a 10-minute tick.
 *
 * ANY WRITE UNDER `/actions/runners` FOR A REPO MAKES ITS ENTRY STALE — a label
 * write, a delete, a mint — so a loop never reads back a listing from before
 * its own change. A GET that was in flight across such a write is kept for its
 * ETag (GitHub decides whether it still holds) but is never fresh.
 */
export const SHARED_LISTING_MAX_AGE_MS = 5 * 60_000;
const RUNNER_LISTING_PATH = '/actions/runners?per_page=100';
type RunnerListing = { runners?: GhRunner[]; total_count?: number };
/** Bumped by every runner write per repo, so an in-flight GET cannot outlive it. */
const runnerWriteGen = new Map<string, number>();

/**
 * The repo's runner listing, from the cache when GitHub vouched for it within
 * `maxAgeMs`, otherwise read now. `null` is "could not look", as from `ghGet`.
 */
export async function readRunnerListingShared(
	repo: string,
	token: string,
	maxAgeMs = SHARED_LISTING_MAX_AGE_MS,
	nowMs = Date.now()
): Promise<RunnerListing | null> {
	const hit = ghCache.get(ghCacheKey(token, repo, RUNNER_LISTING_PATH));
	if (hit && hit.atMs > 0 && nowMs - hit.atMs < maxAgeMs) {
		return JSON.parse(hit.text) as RunnerListing;
	}
	return ghGet<RunnerListing>(RUNNER_LISTING_PATH, token, repo);
}

export async function ghGet<T>(path: string, token: string, repo = SELF_REPO): Promise<T | null> {
	// `null` is this function's "I could not look", and every caller in the
	// dispatcher already treats it that way — see the `null` is the error return,
	// NOT an empty queue comment in dispatch-tick. Suppression must land there.
	if (ghBlackoutRemainingMs() > 0) {
		noteGhReadBlackout();
		return null;
	}
	const genAtStart = runnerWriteGen.get(repo) ?? 0;
	const key = ghCacheKey(token, repo, path);
	// Held by reference: the entry may be evicted while the request is in
	// flight, and a 304 to an ETag we sent is still an answer about THIS body.
	const cached = ghCache.get(key);
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': userAgent('runner-health'),
		};
		if (cached?.etag) headers['If-None-Match'] = cached.etag;
		const resp = await fetch(ghUrl(repo, path), { headers, signal: controller.signal });
		clearTimeout(timeoutId);
		recordGhResponse(token, resp.status, resp.headers);
		const fresh = (runnerWriteGen.get(repo) ?? 0) === genAtStart;
		// Before the `ok` check: `resp.ok` is false for a 304, and treating the
		// free answer as a failure would turn every unchanged listing into
		// "could not look".
		if (resp.status === 304 && cached?.etag) {
			ghCacheStore(key, { ...cached, atMs: fresh ? Date.now() : cached.atMs });
			return JSON.parse(cached.text) as T;
		}
		if (!resp.ok) {
			noteGhRateLimit(resp);
			logger.warn(`[runner-health] GET ${path} → ${await describeGhFailure(resp)}`);
			return null;
		}
		const text = await resp.text();
		const body = JSON.parse(text) as T;
		// Optional for the same reason `recordGhResponse` takes a missing bag.
		const etag = resp.headers?.get('etag') ?? null;
		// The runner listing is kept even without an ETag — it is also the shared
		// listing — but never an unreadable one: a body with no `runners` array
		// must not answer the next reader as an empty fleet.
		const keep =
			path === RUNNER_LISTING_PATH
				? Array.isArray((body as RunnerListing | null)?.runners)
				: etag !== null;
		if (keep) ghCacheStore(key, { repo, path, etag, text, atMs: fresh ? Date.now() : 0 });
		return body;
	} catch (err) {
		clearTimeout(timeoutId);
		logger.warn(`[runner-health] GET ${path} failed: ${noteGhReadError(err)}`);
		return null;
	}
}

export async function ghWrite(
	method: 'POST' | 'DELETE',
	path: string,
	token: string,
	body?: unknown,
	repo = SELF_REPO
	// The BODY is returned as well as the status. Every caller until the JIT mint
	// needed only `ok`, so the response was discarded — and `generate-jitconfig`
	// answers 201 with the config IN THE BODY, so the mint created a real
	// registration and then reported failure because it could not see the reply.
): Promise<{ ok: boolean; status: number; body?: unknown }> {
	// Status 0, the same shape the transport-failure path returns. A write during
	// a blackout would 403 anyway; refusing it here means a mint fails BEFORE it
	// creates a registration nothing will answer, rather than after.
	if (ghBlackoutRemainingMs() > 0) return { ok: false, status: 0 };
	// Before the call, not after: a GET overlapping this write must not store
	// the pre-write body once it lands (see readRunnerListingShared).
	if (path.startsWith('/actions/runners')) {
		// Stale, not dropped: the ETag is still worth sending, and GitHub will
		// answer 200 if this write changed the listing.
		for (const e of ghCache.values())
			if (e.repo === repo && e.path === RUNNER_LISTING_PATH) e.atMs = 0;
		runnerWriteGen.set(repo, (runnerWriteGen.get(repo) ?? 0) + 1);
	}
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': userAgent('runner-health'),
		};
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		const resp = await fetch(ghUrl(repo, path), {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
		clearTimeout(timeoutId);
		recordGhResponse(token, resp.status, resp.headers);
		// 204 (DELETE) and any empty response parse to undefined rather than
		// throwing — a body is optional for every caller but this one.
		let parsed: unknown;
		try {
			const text = await resp.text();
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			parsed = undefined;
		}
		if (!resp.ok) {
			// Writes hit the same limits reads do, and a rate-limited label write
			// or mint used to surface only as a bare status at the call site.
			noteGhRateLimit(resp);
			const message = (parsed as { message?: string } | undefined)?.message ?? '';
			logger.warn(`[runner-health] ${method} ${path} → ${describeGhStatus(resp, message)}`);
		}
		return { ok: resp.ok, status: resp.status, body: parsed };
	} catch (err) {
		clearTimeout(timeoutId);
		logger.warn(
			`[runner-health] ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`
		);
		return { ok: false, status: 0 };
	}
}

/** Online-runner label census for this tick, or null when the runner check could not run. */
/**
 * Every label carried by these runners, with a count. NOT filtered to the
 * label floor's watched set.
 *
 * That filter is why this check spent its whole life answering one question.
 * The label floor watches DEMANDED capabilities — the ones that page
 * when they hit zero — and it does not contain `self-hosted`, which GitHub
 * stamps on every registration and which `vars.CI_RUNNER`
 * (`["self-hosted","hadoku-builder"]`) puts on every fleet job. So every real
 * fleet job read as "no online runner matches its labels" no matter how much
 * capacity was up, and the busy-pool branch below was unreachable in
 * production. The test that covered it asked for a bare `['hadoku-builder']`,
 * a shape `runs-on` never produces here.
 *
 * A floor is not a census. Coverage has to be answered from what the runners
 * actually carry.
 */
function countLabels(runners: GhRunner[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const r of runners) for (const l of r.labels ?? []) out[l.name] = (out[l.name] ?? 0) + 1;
	return out;
}

/**
 * SELF_REPO's self-hosted runner listing, asked for a page big enough to BE a
 * census. `null` is "I could not look" and every caller treats it that way.
 *
 * One door for this read so the floor check and the read that CONFIRMS a floor
 * breach cannot drift apart — a confirmation taken through a differently-shaped
 * request is not a confirmation of anything.
 */
async function readRunnerListing(
	token: string
): Promise<{ runners?: GhRunner[]; total_count?: number } | null> {
	return ghGet<{ runners?: GhRunner[]; total_count?: number }>(
		'/actions/runners?per_page=100',
		token
	);
}

/** What a second look at the listing found, or `null` for "I could not look". */
interface FloorConfirmation {
	/** Online-runner label census from the CONFIRMING read. */
	labels: Record<string, number>;
	/** Online runner names from the confirming read, for the message. */
	names: string;
	/** Registrations the confirming read saw, online or not. */
	registrations: number;
}

/**
 * Look a second time before saying a routing label has no online runner.
 *
 * Seconds apart, not ticks: see FLOOR_CONFIRM_DELAY_MS for the 2026-09-12
 * measurement that distinguishes the two. Costs one GitHub call, and only on a
 * tick that is about to page.
 *
 * `null` for anything it could not READ — an unreadable listing, a suppressed
 * budget, or a listing that came back TRUNCATED. A partial census cannot
 * confirm a zero any more than it can produce one.
 */
async function confirmFloorZero(token: string): Promise<FloorConfirmation | null> {
	if (floorConfirmDelayMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, floorConfirmDelayMs));
	}
	const resp = await readRunnerListing(token);
	if (!resp || !Array.isArray(resp.runners)) return null;
	if (typeof resp.total_count === 'number' && resp.total_count > resp.runners.length) return null;
	const online = resp.runners.filter((r) => r.status === 'online');
	return {
		labels: countLabels(online),
		names: online.map((r) => r.name).join(', ') || '(none)',
		registrations: resp.runners.length,
	};
}

/**
 * A GitHub-HOSTED image label, e.g. `ubuntu-latest`, `ubuntu-24.04`,
 * `windows-2022`, `macos-14`.
 *
 * Deliberately the same shape `reconcile-repo-policy.mjs` matches, so the gate
 * that POLICES hosted runners and the monitor that EXCUSES them agree on what
 * one is. Hosted jobs are served by GitHub's pool, so they can never be a fleet
 * coverage gap — the fleet has nothing to do with whether they start.
 */
function isHostedLabel(label: string): boolean {
	return /^(ubuntu|windows|macos)-[\w.]+$/.test(label);
}

/** Why a queued run is waiting — the message half of the classification. */
interface QueueVerdict {
	/** true = not a fleet fault, record it quietly. false = ping. */
	covered: boolean;
	/** Always populated. A finding with no reason is not actionable. */
	reason: string;
}

/**
 * How long a job may wait on a MINT before the wait itself is the finding.
 *
 * A mint serves in about 2.5 minutes at worst (MIN_QUEUED_MS + a fast-loop
 * tick + the mint), and a saturated fleet adds the length of the job ahead.
 * Under this, a job no standing runner covers but a live minting node offers
 * is waiting its turn and is recorded quietly (#110). Past it, it pages,
 * because a mint that never happens looks exactly like one that has not
 * happened YET — the dispatcher skipping the run, a repo it cannot mint for,
 * a node that accepts the mint and never serves — and a wait that only gets
 * quieter the longer it lasts is the inversion this file refuses.
 */
const MINT_WAIT_LOUD_MINUTES = 30;

/**
 * How long a minted runner may stay OFFLINE before it is called deaf.
 *
 * A JIT listener connects within seconds of its unit starting. Three minutes
 * is far past that, and the check only runs on a job already queued past
 * QUEUED_WARN_MINUTES, so nothing legitimate is caught by it.
 */
const DEAF_MINT_MINUTES = 3;

/** One repo's registrations as this tick read them — the part the classifier needs. */
interface RepoRunnerState {
	labels: Record<string, number>;
	runners: GhRunner[];
}

/**
 * Can anything actually serve this queued run?
 *
 * `covered` distinguishes "waiting its turn" from "waiting for a machine that
 * does not exist", and `reason` says WHICH — a bare "no online runner matches
 * its labels" sent the operator to look up the run every time, and could not
 * tell a busy pool from a hosted job from a genuinely dead label.
 *
 * A JOB NO STANDING RUNNER COVERS MAY STILL BE SERVED BY A MINT (#110). Under
 * all-JIT that is most jobs: a claw holds no registration until a job asks, so
 * the repo's own listing shows nothing that carries `hadoku-builder` or `jdk21`
 * while a claw is about to. That is judged by the label floor's own minting arm
 * (`judgeJobMint`), unmeasured hold included, and is quiet only inside
 * MINT_WAIT_LOUD_MINUTES.
 *
 * A MINTED RUNNER THAT NEVER CAME ONLINE IS NAMED FIRST, and loudly. On
 * 2026-10-16 the dispatcher minted hadoku-bomberman's runner on claw-9 at
 * 13:00:41Z; claw-9 had lost DNS, the listener retried for 65 minutes, and the
 * dispatcher held the job as in flight throughout, so nothing else could serve
 * it. Judged by labels alone that job was "covered by a mint" — the minting arm
 * offered it on a live claw — and would have gone quiet. The registration was
 * right there in the repo's listing, offline, carrying the job's id.
 *
 * Fails LOUD on anything it could not READ — a missing census or an unreadable
 * jobs list pings, because silence on an uncovered label is the outage this
 * check exists to catch. It does NOT fail loud on things it read successfully
 * and found empty; "I looked and nothing is waiting" is evidence, not absence
 * of it.
 */
async function classifyQueuedRun(
	runId: number | undefined,
	token: string,
	repo: string,
	state: RepoRunnerState | null,
	mint: { view: MintView } | null,
	ageMin: number,
	nowMs: number
): Promise<QueueVerdict> {
	if (!runId)
		return { covered: false, reason: 'the run carried no id, so its jobs are unreadable.' };
	if (!state)
		return {
			covered: false,
			reason: `the runner listing for \`${repo}\` was unreadable, so coverage could not be judged.`,
		};
	const labelOnline = state.labels;
	const detail = await ghGet<{ jobs?: GhJob[] }>(`/actions/runs/${runId}/jobs`, token, repo);
	if (!detail || !Array.isArray(detail.jobs))
		return {
			covered: false,
			reason: 'its job list was unreadable, so coverage could not be judged.',
		};
	// A queued run with NO jobs at all has not been scheduled — nothing has been
	// attributed to a runner, hosted or otherwise. Past the threshold that is a
	// stuck run and stays LOUD, which is what it has always been.
	if (!detail.jobs.length)
		return {
			covered: false,
			reason: 'the run has NO jobs at all — GitHub has not scheduled it.',
		};
	const waiting = detail.jobs.filter((j) => j.status === 'queued' || !j.started_at);
	// Jobs exist and every one has been picked up. The run listing lags job state
	// by a few seconds, so a run can still read `queued` with nothing waiting —
	// not "I could not look" but "I looked and nothing is waiting", which is
	// evidence rather than the absence of it.
	if (!waiting.length)
		return {
			covered: true,
			reason: 'every job has already been picked up; the run listing is lagging.',
		};

	const deaf = deafMints(waiting, runId, state.runners, mint, nowMs);
	if (deaf.length)
		return {
			covered: false,
			reason:
				`${deaf.join('; ')} — still OFFLINE in GitHub's listing, so its listener cannot reach ` +
				'GitHub, and the dispatcher holds the job as in flight so nothing else will serve it.',
		};

	const unmet = new Set<string>();
	/** Jobs no standing runner covers, for the minting arm. */
	const forMint: string[][] = [];
	let hostedOnly = true;
	let unlabelled = false;
	for (const j of waiting) {
		const labels = Array.isArray(j.labels) ? j.labels : [];
		// A job with no readable labels cannot be shown to be covered.
		if (!labels.length) {
			unlabelled = true;
			continue;
		}
		// A job is hosted if ANY of its labels is a hosted image — `runs-on` picks
		// one runner, and no self-hosted box carries `ubuntu-latest`.
		if (labels.some(isHostedLabel)) continue;
		hostedOnly = false;
		const missing = labels.filter((l) => (labelOnline[l] ?? 0) === 0);
		for (const l of missing) unmet.add(l);
		if (missing.length) forMint.push(labels);
	}
	if (unlabelled)
		return {
			covered: false,
			reason: 'a queued job reported no labels, so coverage could not be judged.',
		};
	if (unmet.size) {
		const named = Array.from(unmet)
			.map((l) => `\`${l}\``)
			.join(', ');
		// The manifest could not be read, so the minting arm cannot be asked:
		// nothing showed the job covered, which is the old verdict, unchanged.
		if (!mint)
			return {
				covered: false,
				reason: `NO online runner carries ${named} — that is a coverage gap, not a busy pool.`,
			};
		const verdicts = forMint.map((labels) => judgeJobMint(labels, mint.view));
		const unserved = verdicts.find((v) => v.state === 'unserved');
		if (unserved && unserved.state === 'unserved')
			return {
				covered: false,
				reason: `NO online runner carries ${named} (${unserved.why}) — that is a coverage gap, not a busy pool.`,
			};
		const via = [
			...new Set(
				verdicts.flatMap((v) => (v.state === 'minting' || v.state === 'unmeasured' ? v.nodes : []))
			),
		].join(', ');
		const unmeasured = verdicts.some((v) => v.state === 'unmeasured');
		const how = unmeasured
			? `the fast loop has not probed the minting nodes that offer it (${via}) since the restart`
			: `${via} offer${via.includes(',') ? '' : 's'} it and can mint`;
		if (ageMin > MINT_WAIT_LOUD_MINUTES)
			return {
				covered: false,
				reason:
					`no standing runner carries ${named}; ${how}, but nothing has served it in ` +
					`${MINT_WAIT_LOUD_MINUTES}+ min. Check \`[dispatch] skipped run ${runId}\` in mgmt-api's log.`,
			};
		return {
			covered: true,
			reason: `no standing runner carries ${named}; ${how}, so it is waiting for a mint.`,
		};
	}
	if (hostedOnly)
		return {
			covered: true,
			reason:
				'every queued job is GitHub-HOSTED, so the fleet does not serve it and cannot be the cause.',
		};
	return { covered: true, reason: 'every label it wants IS online; the pool is busy.' };
}

/**
 * JIT registrations minted for one of these waiting jobs that never came online.
 *
 * Matched by the job id the name carries (`parseJitName`), or by the run id
 * for a name from before the job-scoped format. Only a registration that is
 * OFFLINE and older than DEAF_MINT_MINUTES counts: an online one is either
 * about to take the job or serving another (the dispatcher's own reassignment
 * case), and neither is deaf. One line per runner, naming its node.
 */
function deafMints(
	waiting: GhJob[],
	runId: number,
	runners: GhRunner[],
	mint: { view: MintView } | null,
	nowMs: number
): string[] {
	const jobIds = new Set(
		waiting.map((j) => j.id).filter((id): id is number => typeof id === 'number')
	);
	const nodes = mint?.view.nodes.map((n) => n.name) ?? [];
	const out: string[] = [];
	for (const r of runners) {
		if (r.status === 'online') continue;
		const parsed = parseJitName(r.name);
		if (!parsed) continue;
		const ours = parsed.jobId !== null ? jobIds.has(parsed.jobId) : parsed.runId === runId;
		if (!ours) continue;
		const ageMin = (nowMs - parsed.mintedAtMs) / 60000;
		if (!(ageMin > DEAF_MINT_MINUTES)) continue;
		const node = nodes.length ? nodeOf(r.name, nodes) : '';
		const where = node && node !== r.name ? ` on \`${node}\`` : '';
		out.push(`\`${r.name}\` was minted for it${where} ${Math.round(ageMin)}m ago`);
	}
	return out;
}

/**
 * Per-job progress, carried BETWEEN ticks: jobId -> {done, since}.
 *
 * `done` is how many of the job's steps had finished when we last looked, and
 * `since` is when that count last CHANGED. A job whose count is still moving is
 * working, not hung — which is the distinction a wall-clock threshold cannot
 * make and the reason this map exists.
 *
 * Cross-tick memory, so it is reset by `__resetRunnerHealthAlertsForTesting`
 * along with everything else of its kind. A leaked entry would let one test's
 * job answer the next test's staleness question.
 */
const jobProgress = new Map<number, { done: number; since: number }>();

/**
 * How long a job may sit on the SAME step before it is called hung.
 *
 * Separate from `INPROGRESS_WARN_MINUTES`, which bounds total runtime. The two
 * measure different things and conflating them is what paged on 2026-09-10:
 * brave-quartet's Bevy compile takes 8-9 minutes on a hosted runner and 40+ on
 * a claw, so moving it onto the fleet put a perfectly healthy job past a
 * 30-minute ceiling that predated any fleet job running that long. It was
 * advancing through its steps the whole time.
 *
 * A threshold on TOTAL runtime has to be re-tuned every time the workload mix
 * changes, and is wrong for the fleet's slowest node by construction. Progress
 * does not: a job that has not finished a step in this long is stuck no matter
 * how fast or slow the box is.
 */
const STUCK_MINUTES = 25;

/** Fire at most once per RE_ALERT_MS per condition key. */
async function alertOnce(key: string, content: string): Promise<void> {
	loadAlertLedger();
	const now = Date.now();
	const prev = lastAlertAt.get(key) ?? 0;
	if (now - prev < RE_ALERT_MS) return;
	lastAlertAt.set(key, now);
	saveAlertLedger();
	await postDiscordSink(content, 'runner-health');
}

/** Condition cleared — re-arm so the next occurrence alerts immediately. */
function clearAlert(key: string): void {
	loadAlertLedger();
	if (lastAlertAt.delete(key)) saveAlertLedger();
}

/** Reset per-condition alert suppression. Test-only seam. */
/** Re-read the persisted ledger, as a fresh process would. Test-only seam. */
export function __reloadAlertLedgerForTesting(): void {
	ledgerLoaded = false;
	loadAlertLedger();
}

export function __resetRunnerHealthAlertsForTesting(): void {
	ledgerLoaded = true; // never read the operator's ledger from a test
	lastAlertAt.clear();
	// The snapshot is cross-tick memory too, and since it is persisted a stale
	// in-memory copy would let one test's tick answer the next test's read.
	lastSnapshot = null;
	snapshotRestoreTried = false;
	labelZeroTicks.clear();
	// Cross-tick memory: a leaked value would suppress the next test's warning.
	lastStaticDemandProblem = null;
	// Cross-tick memory, so it belongs in this list — see the comment below. A
	// leaked count would let one test's failed write pre-arm the next test's
	// debounce, which passes while measuring nothing.
	ciRunnerWriteFailTicks.clear();
	capacityBrokenTicks.clear();
	offlineTicks.clear();
	offlineRepeats.clear();
	failoverReran.clear();
	// Cross-tick memory — see the comment below; every piece of it belongs here.
	jobProgress.clear();
	// Same leak class as `hostedRepos` below: a promoted backstop would otherwise
	// carry into the next test, which would then see no fan-out because the state
	// already matched, and pass while measuring nothing.
	backstopFleetState = null;
	backstopAlerted = false;
	// The hold's EDGES announce an on-demand promotion (#120), so a hold left by
	// one test would swallow the next test's 🔻 and pass while measuring nothing.
	setBackstopHold([]);
	// The shared runner listing is cross-LOOP memory: left behind, one test's
	// listing answers the next test's sweep, which then lists nothing and passes.
	ghCache.clear();
	ghCacheBytes = 0;
	runnerWriteGen.clear();
	// Cross-tick memory — see the comment below. A leaked timestamp would make
	// the verify sweep "not due" for an hour of test time and pass while
	// measuring nothing.
	backstopConvergedMs = 0;
	// Every piece of cross-tick memory has to be listed here — see the comment
	// below. Hysteresis is cross-tick by definition.
	backstopCalmTicks = 0;
	backstopLastReason = null;
	// Cross-tick memory — see the comment below. A leaked count would suppress the
	// zombie warning in the next test, which would then pass while measuring
	// nothing.
	queueZombiesLogged = null;
	quietRecorder = recordAlertQuietly;
	// `hostedRepos` is module-level and therefore leaks between tests: an
	// all-claws-down case leaves every repo marked hosted, so the NEXT test sees
	// a fleet→hosted recovery it never set up and posts an unexpected alert.
	// Every piece of cross-tick memory in this module has to be listed here.
	hostedRepos.clear();
}

export async function tick(token: string): Promise<void> {
	// Hoisted to the top of the tick: the runs sweep further down uses this, and
	// so does the saturation gate in the runner check above it. One definition, so
	// the two cannot come to disagree about which repos are the fleet.
	const fleetRepos = fleetReposOverride ?? Array.from(new Set([SELF_REPO, ...coveredRepos()]));
	// Read only by this tick's own could-not-read-anything verdict, so a
	// failure left over from an earlier tick must not name today's cause.
	lastGhReadFailure = null;
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
		await recordJobResult(JOB_NAME, 'failed', 0, { error: unreadableTickError(lastGhReadFailure) });
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

/**
 * Check 1 — the label floor: is every DEMANDED routing label SERVED — carried
 * by a standing online runner, or offered by a minting node the dispatcher
 * could mint on now? One rule for every label; see `label-floor.ts`.
 *
 * EXCEPT `hadoku-builder` (retired 2026-09-08, decision C0b): it is still
 * MEASURED and JUDGED here but never alerted on. `check-queue-health` owns
 * that page now. See `claw-floor-design-2026-09-07.md` §10 and the comment
 * inside the loop below.
 *
 * Extracted from tick() on 2026-08-28. tick() was 830 lines holding three
 * unrelated checks plus its own reporting, which is why the only way to test any
 * part of it was to drive the whole thing — 82 of this suite's tests do exactly
 * that, and they are what verifies this extraction changed nothing.
 *
 * `data` is the shared report payload and is mutated by reference. The three
 * returned facts are the ENTIRE remaining data flow across the seam; everything
 * else in here is local, which is what made the split safe to do mechanically.
 */
async function checkLabelFloor(
	token: string,
	fleetRepos: string[],
	data: TickReport
): Promise<{
	runnersChecked: boolean;
	onlineRunnerNames: Set<string> | null;
	selfHostedRunnerNames: Set<string> | null;
	onlineLabels: Record<string, number> | null;
	selfRunners: GhRunner[] | null;
}> {
	const out = {
		runnersChecked: false,
		onlineRunnerNames: null as Set<string> | null,
		selfHostedRunnerNames: null as Set<string> | null,
		onlineLabels: null as Record<string, number> | null,
		selfRunners: null as GhRunner[] | null,
	};
	// --- Check 1: runner label-floor (needs runner-listing privilege) ---
	//
	// `per_page=100`, like every other runner listing in this package. This call
	// was the one exception and took GitHub's DEFAULT PAGE OF 30, which stops
	// being a fleet-wide census the moment JIT registrations outrun the reap.
	// The listing is not ordered by anything this code controls — a live read on
	// 2026-09-14 came back `claw-8, hokon, warm-claw-5, warm-claw-3, jit…,
	// jit…, warm-claw-7`, neither id nor name nor status order — so a 31st
	// registration evicts an arbitrary one, and a standing runner evicted off
	// page one reads EXACTLY like a capability that went offline. That is the
	// loudest alert in this file.
	const runnersResp = await readRunnerListing(token);
	if (runnersResp && Array.isArray(runnersResp.runners)) {
		out.runnersChecked = true;
		const runners = runnersResp.runners;
		// A PARTIAL census cannot answer a per-label question, and answering one
		// anyway is how "I could not look" renders as "nothing is wrong" — or, in
		// this direction, as a capability outage that never happened. GitHub caps
		// `per_page` at 100, so this is reachable on a fleet larger than that
		// rather than hypothetical.
		const truncated =
			typeof runnersResp.total_count === 'number' && runnersResp.total_count > runners.length;
		const online = runners.filter((r) => r.status === 'online');
		const onlineNames = online.map((r) => r.name).join(', ') || '(none)';
		out.onlineRunnerNames = new Set(online.map((r) => r.name));
		out.selfHostedRunnerNames = new Set(runners.map((r) => r.name));
		out.onlineLabels = countLabels(online);
		out.selfRunners = runners;

		// --- Census: how much capacity is there, and is this an outage? ---
		// Pure arithmetic, extracted to ./runners/census.ts so it can be checked
		// against a hand-written listing with no network. Both P2 counting bugs of
		// 2026-08-27/28 lived here and neither was reachable by a test while this
		// was inline in a function that also makes the API calls.
		const fleetNodes = loadFleetNodeNames();
		const has = (r: GhRunner, label: string) => (r.labels ?? []).some((l) => l.name === label);
		const isEligible = (r: GhRunner) =>
			has(r, BUILDER_LABEL) && !has(r, PM2_HOST_LABEL) && !has(r, BACKSTOP_LABEL);

		const c = runnerCensus({
			runners,
			clawNodes: loadClawNodes(),
			ephemeralNodes: loadEphemeralNodes(),
			probe: getFleetProbeSnapshot(),
		});
		const { hokonPool, clawsOnline, clawsRegistered, clawsFree, backstopOnline, pm2Busy } = c;

		data.claws_online = clawsOnline;
		data.claws_registered = clawsRegistered;
		data.backstop_online = backstopOnline;
		data.claws_free = clawsFree;
		// Kept alongside, not instead of. Both halves are real capacity; what the
		// fleet could not previously express is that all of it might need the
		// dispatcher to act before a single job can start.
		data.claws_free_standing = c.clawsFreeStanding;
		data.claws_free_mintable = c.clawsFreeMintable;
		data.claws_mintable_online = c.clawsMintableOnline;
		data.claws_ready = c.clawsReady;
		// The standing half alone. The fleet route re-bases the ephemeral half onto
		// a probe 10 minutes fresher than this tick's, and it can only do that if
		// the two halves arrive separable.
		data.claws_ready_standing = c.clawsReadyStanding;
		data.ephemeral_unknown = c.ephemeralUnknown;
		lastTickEphemeralUnknown = c.ephemeralUnknown === true;

		// WHICH nodes those numbers are made of.
		//
		// `claws_online=1` is not a diagnosis. Reconstructing a 2026-08-29 window
		// from the logs cost an hour and still could not answer whether claw-1 was
		// demoted, offline, or simply not registered for this repo — three states
		// with three different fixes, all rendered as the digit 1. The counts are
		// what the backstop acts on; this is what an operator needs to act on.
		//
		// Registration state is per-REPO. These figures come from SELF_REPO's
		// listing, so a node reading `absent` here is absent from hadoku_site,
		// not necessarily from the fleet — and that distinction is exactly what
		// was unrecoverable from `claws_online=1`.
		const clawState: Record<string, ClawState> = {};
		// Every STANDING node, which is `loadClawNodes()` PLUS the production
		// host. loadClawNodes drops anything the manifest labels `pm2-host`,
		// correctly — it answers "is this a claw" — and using it here left hokon
		// with no state at all, rendering an em dash for the one node the whole
		// backstop is about. `demoted` is the right word for a hokon in standby:
		// it is online and carries no `hadoku-builder`, which is exactly what the
		// backstop being down means.
		const ephemeral = loadEphemeralNodes();
		Object.assign(
			clawState,
			deriveClawState({
				fleetNodes,
				ephemeral,
				runners,
				nodeOf,
				isEligible,
				probeFor: (n) => getFleetProbeSnapshot()?.nodes?.[n],
			})
		);

		// PUBLISH WHO GITHUB CANNOT PLACE WORK ON, for the tier ladder.
		//
		// `offline` (registrations exist, none online) and `absent` (no
		// registration at all) are both unschedulable however healthy the box
		// looks over ssh. claw-4 was the case that made this necessary: reachable,
		// idle, two free slots reported into tier1, and every one of its 26
		// registrations offline — which held tier2 demoted while work queued.
		//
		// `mintable` is NOT included. An ephemeral node has no standing
		// registration by design and is reached through the dispatcher, so reading
		// its empty listing as unschedulable would switch off every JIT node in the
		// fleet. That distinction is the whole reason this is computed here, where
		// the ephemeral set is already known, rather than from a runner listing.
		setUnschedulableNodes(
			Object.entries(clawState)
				.filter(([, st]) => st === 'offline' || st === 'absent')
				.map(([node]) => node)
		);
		data.claw_state = clawState;
		data.pm2_host_busy = pm2Busy;

		// WHICH NODES are serving that rung — the same listing, asked per node.
		//
		// The census answers "is ANY", which is what the report field above means
		// and all the ladder ever needed while hokon alone carried `pm2-host`. The
		// label has been PROBED since 2026-09-15 (#6), so a claw can earn it, and
		// one boolean for two holders reserves the wrong box in both directions: a
		// busy claw would hold an idle hokon off builder duty, and an idle claw
		// would clear a busy one.
		const pm2BusyNodes = new Set(
			runners.filter((r) => has(r, PM2_HOST_LABEL) && r.busy).map((r) => nodeOf(r.name, fleetNodes))
		);

		// Publish the pm2-host rung of the priority ladder for the fast loop.
		// Free here: we already hold the listing.
		setPm2HostBusy(pm2BusyNodes);

		// The LIVE runner facts, for the Fleet panel. Declared capability (what the
		// manifest says a node is for) and current eligibility (what GitHub will
		// actually schedule onto it) are different things, and the panel rendered
		// the former while labelling it the latter — so a promoted hokon could
		// never be seen carrying `hadoku-builder`, which is the single most
		// interesting thing the ladder does.
		data.runner_state = runners.map((r) => ({
			name: r.name,
			status: r.status,
			busy: r.busy,
			labels: (r.labels ?? []).map((l) => l.name),
		}));

		// Two independent reasons to want the backstop up, kept distinct because they
		// warrant different noise: an OUTAGE is an incident the operator should see,
		// SATURATION is ordinary load and pages nobody.
		//
		// WHAT DECIDES WHETHER TO PROBE IS WHAT THE ANSWER CAN CHANGE, AND
		// `atCapacity` IS NOT THAT.
		//
		// This gate read `isAtCapacity(...)` until 2026-09-24, so off-capacity the
		// queue was handed to `decideBackstop` as the literal 0 and `saturated`
		// could not be true there — the caller answering the function's question
		// for it, and silently undoing the fix the function took on 2026-09-01.
		// That fix removed `atCapacity` as a precondition BECAUSE census.ts folds
		// mintable slots into `clawsFree`: once enough of the fleet is JIT the
		// count never reaches zero, so the one state this caller was willing to
		// pay for never arrives. On 2026-09-01, three of four nodes ephemeral, 13
		// jobs sat 11-19 minutes across nine repos while `clawsFree` never hit
		// zero and this line passed 0 (#63).
		//
		// Two states still skip the probe, and NEITHER of them is "a claw was
		// free":
		//   - an OUTAGE. There is nothing to queue BEHIND a fleet with nowhere to
		//     run, `decideBackstop` promotes on the outage alone, and waiting to
		//     observe a queue would add the threshold to every job's latency
		//     during the incident. Skipping here BUYS latency; it does not save a
		//     call that mattered.
		//   - UNMEASURED counts. `decideBackstop` returns on `ephemeralUnknown`
		//     before it ever reads `queuePressureSec`, holding the previous
		//     answer, so a probe there is one listing per repo spent on an input
		//     nothing consumes — and runner-health's first tick after every
		//     mgmt-api restart lands in that window.
		//
		// BUDGET, sized as if every listing were charged: `probeQueuePressure`
		// goes through `ghGet`, which revalidates with an ETag, so an unchanged
		// queue is free — but a moving one is not, and the ceiling is what a
		// cadence answers to. One listing per repo, breaking at the first run
		// over the threshold, on runner-health's own 10-minute tick —
		// 26 covered repos x 6 ticks/hr = 156 calls/hr against 5,000/hr, 3.1%,
		// and that is the WORST case: a fleet actually backed up breaks early and
		// costs LESS. No timer changed here, so nothing else hanging off this
		// tick moved with it. Asserted in runner-health.test.ts.
		//
		// AND A DAYS-OLD QUEUED RUN IS NOT PRESSURE, which is what made the
		// unconditional probe a regression rather than a fix. See
		// `QUEUE_ZOMBIE_SECONDS`: from 2026-09-25 this line returned ~3.5 MILLION
		// seconds every tick off two runs that have been `queued` and
		// uncancellable since 2026-08-17/19, so `saturation` was permanently true
		// and hokon carried `hadoku-builder` continuously. The probe is right to be
		// unconditional; it was reading the wrong population.
		const fleetIsUp = clawsAreHealthy(clawsOnline, clawsRegistered);
		const queue =
			fleetIsUp && !c.ephemeralUnknown
				? await probeQueuePressure(token, fleetRepos, Date.now())
				: { pressureSec: 0, zombies: 0, oldestZombieSec: 0 };
		const queuePressureSec = queue.pressureSec;

		// SAY WHAT WAS REFUSED, ONCE PER CHANGE. A zombie stays a zombie — that is
		// what makes it one — so a line every tick is six an hour forever and the
		// fleet's own logs become the thing nobody reads (`dispatch-tick.ts` learned
		// this about the same two runs). But silence here is the failure this whole
		// file is about: the operator had no way to know the saturation trigger was
		// reading a 40-day-old run, and the only number printed was the inflated
		// one. Logged when the count MOVES, and carried on the snapshot every tick.
		if (queue.zombies !== queueZombiesLogged) {
			queueZombiesLogged = queue.zombies;
			if (queue.zombies > 0) {
				logger.warn(
					`[runner-health] queue probe ignored ${queue.zombies} run(s) queued longer than ` +
						`${Math.round(QUEUE_ZOMBIE_SECONDS / 3600)}h (oldest ` +
						`${Math.round(queue.oldestZombieSec / 86400)}d) — a run that old is STUCK, not ` +
						'starved, and the backstop cannot serve it. Saturation is decided on the ' +
						`remainder: ${queuePressureSec}s`
				);
			} else {
				logger.info('[runner-health] queue probe: no zombie runs left to ignore');
			}
		}

		// The reservation ladder — pm2-host > builder > taskauto. hokon's nightly
		// crons are Temporal work GitHub cannot see, so no label or queue signal
		// reveals them; only this does. It gates the BACKSTOP, which is the only
		// writer of `hadoku-builder` on the pool.
		//
		// PER NODE on the pm2-host rung, fleet-wide on the cron ones. The pool is
		// held off builder work by `pm2-host` only when EVERY node in it is serving
		// that rung — one free holder means the backstop still has somewhere to go,
		// and the busy holder is skipped individually in the loop below. The cron
		// rungs have no node to key on (one mgmt-api, one profiles.json), so they
		// reserve the whole pool exactly as before.
		//
		// `poolNodes` is every NODE the pool sits on in listing order — the prod
		// host carries several registrations, so it repeats, and `backstopNodes` is
		// that folded to machines.
		const poolNodes = hokonPool.map((r) => nodeOf(r.name, fleetNodes));
		// THE MANIFEST'S GUESTS AS WELL AS THE POOL'S NODES (#120). The pool is
		// read off registrations, and an on-demand guest's whole point is to keep
		// none — so a node that retired its standing runners would otherwise
		// vanish from the backstop the moment it stopped squatting on memory.
		const machines = backstopMachinesReader();
		const backstopNodes = [
			...new Set([
				...poolNodes,
				...Object.entries(machines ?? {})
					.filter(([, m]) => isGuestNode(m as RoleBearingNode))
					.map(([n]) => n),
			]),
		];
		// Promoted by the HOLD alone: the dispatcher mints for it, so nothing here
		// may write `hadoku-builder` onto one of its registrations — the one it
		// keeps (`standingRepos`) is a deploy runner, and labelling it would put
		// builder work on a listener outside the mint path and its slice.
		const onDemand = (node: string): boolean =>
			mintsOnDemand(machines?.[node] as MintBearingNode | undefined);
		// "I could not look" writes no label. Without the manifest a deploy runner
		// and a backstop registration look identical — both carry `pm2-host` — so a
		// promotion here would label whichever the pool happens to hold.
		const labelsMayPromote = (node: string): boolean => machines !== null && !onDemand(node);
		if (machines === null) {
			logger.warn(
				'[runner-health] BACKSTOP could not read the manifest — writing no builder label this ' +
					'tick (a deploy runner is indistinguishable from a backstop registration without it)'
			);
		}
		const poolPm2Busy = backstopNodes.length > 0 && backstopNodes.every((n) => pm2BusyNodes.has(n));
		const reservation = (reservationOverride ?? ((busy) => nodeReservation(new Date(), busy)))(
			poolPm2Busy
		);

		const backstopInput = {
			clawsOnline,
			clawsRegistered,
			clawsFree,
			queuePressureSec,
			reserved: reservation.reserved,
			// Do not act on capacity that was never measured. Null probe =>
			// every claw count is a floor, not a reading.
			ephemeralUnknown: c.ephemeralUnknown,
		};
		const decision = decideBackstop(backstopInput, {
			calmTicks: backstopCalmTicks,
			lastReason: backstopLastReason,
			promoted: backstopFleetState,
		});
		backstopCalmTicks = decision.next.calmTicks;
		backstopLastReason = decision.next.lastReason;

		const outage = decision.outage;
		const backstopWanted = decision.wanted;
		const backstopReason = decision.reason;
		data.queue_pressure_sec = queuePressureSec;
		data.queue_zombies_ignored = queue.zombies;
		data.at_capacity = decision.atCapacity;
		data.reserved_reason = reservation.reserved ? reservation.reason : null;
		data.backstop_reason = backstopReason;
		data.backstop_calm_ticks = backstopCalmTicks;

		// Tell the fast loop before touching a single label. The two are
		// phase-locked ~8s apart and the ladder does not know tier4 exists as far
		// as the backstop is concerned; without this it strips the label this loop
		// is about to write. Set on BOTH branches — a stale hold would pin hokon
		// eligible forever once the backstop stood down.
		//
		// PER NODE, and the hold and the write must use ONE predicate: a node the
		// pm2-host rung excludes is one the loop below is about to DEMOTE, and
		// holding it would tell the fast loop to preserve the label we are
		// removing. An OUTAGE overrules the rung for the reason `decideBackstop`
		// gives — a fleet with nowhere to run is worth interrupting for.
		//
		// A QUARANTINED OR DRAINED NODE IS NEVER PROMOTED, outage included. The
		// backstop is the ONLY writer of this label on a guest (the ladder skips
		// guests), so until 2026-09-21 the fleet loop's quarantine of hokon was a
		// log line and nothing else: on saturation this would have handed CI to a
		// node whose store the guard had flagged. hokon is a reserve, brought in
		// when work needs it — which is exactly when it must be sound. The loop
		// keeps repairing it, so a sick reserve returns on its own. An outage with
		// the reserve also sick is the "no self-hosted capacity" case, which
		// CI_RUNNER's hosted flip already answers.
		const drain = readDrain();
		const unsafeNode = (node: string): boolean => nodeIsSick(node) || isDraining(node, drain);
		// IDLE (2026-10-09): saturation promotes the backstop host only while it
		// is quiet — see `isHostIdle`. Read locally (the backstop host is the
		// controller); a node this process cannot read is not idle.
		//
		// THE RED LIGHT IS THE DRAIN (operator, 2026-10-19: "a traffic signal that
		// just makes it so jobs dont go to hokon if we have it blocked"). It was a
		// manifest mode, `backstop: "outage-only"`, from 2026-10-09 — and hokon's
		// live entry never carried the key, so the block the operator asked for
		// was not in force for ten days. `fleet drain hokon` is the one switch:
		// `unsafeNode` refuses a drained node on an outage too, and the dispatcher
		// reads the same drain file for every mint.
		//
		// THE GREEN LIGHT IS THE FORCE (2026-10-21, `backstop-force.ts`). An
		// operator holding a node eligible beats the saturation decision and the
		// idle gate — that is what the switch is for — but NOT the drain or the
		// quarantine (red beats green) and NOT the pm2-host rung (a deploy on the
		// box finishes first, as the ladder orders). Read every tick like the
		// drain, so a force set between ticks takes effect on the next one and an
		// expired one lapses on its own. An unreadable file is NO force, said
		// aloud: a corrupt switch must neither route work nor vanish silently.
		let force: ForceState = {};
		try {
			force = readForce();
		} catch (err) {
			logger.warn(
				'[runner-health] BACKSTOP force file unreadable — treating no node as forced: ' +
					(err instanceof Error ? err.message : String(err))
			);
		}
		const forceNowMs = Date.now();
		const forcedOn = (node: string): boolean => isForced(node, force, forceNowMs);
		//
		// THE BACKLOG ESCALATION (2026-10-21, `hostMayTakeSaturation`): past
		// BACKLOG_QUEUE_SECONDS the load clause is waived — the same 300 s at
		// which ci:queue-health declares the fleet not serving work. Memory is
		// still required. One verdict with its reason, reused by REACHED NOBODY.
		const saturationHost = (node: string) =>
			hostMayTakeSaturation(readHostLoad(node), queuePressureSec);
		const wantedOnNode = (node: string): boolean =>
			((forcedOn(node) && !pm2BusyNodes.has(node)) ||
				(backstopWanted && (outage || (!pm2BusyNodes.has(node) && saturationHost(node).ok)))) &&
			!unsafeNode(node);
		const refused = backstopWanted ? backstopNodes.filter(unsafeNode) : [];
		if (refused.length) {
			logger.warn(
				`[runner-health] BACKSTOP wanted (${backstopReason}) but ${refused.join(', ')} ` +
					'is quarantined or drained — not promoting it'
			);
		}
		const heldNodes = backstopNodes.filter(wantedOnNode);
		// The hold's EDGES, for the nodes promoted by it alone. A relabelled node
		// announces itself through its label writes below; an on-demand one has
		// none, so without this its promotion — the 🔻 on an outage included —
		// would happen silently.
		const wasHeld = new Set(backstopHold());
		setBackstopHold(heldNodes);

		// A FORCE SAYS SO EVERY TICK IT IS IN EFFECT, held or refused. Six lines
		// an hour while an operator has the switch on is the cheapest possible
		// answer to "is it doing anything", and a refused force names the one
		// thing that outranks it — the same per-node spelling REACHED NOBODY uses.
		for (const node of backstopNodes.filter(forcedOn)) {
			const why = describeForce(node, force[node], forceNowMs);
			if (heldNodes.includes(node)) {
				logger.info(`[runner-health] BACKSTOP FORCED — ${why}`);
			} else {
				const blocker = nodeIsSick(node)
					? 'quarantined'
					: isDraining(node, drain)
						? 'drained (the red light beats the green one)'
						: pm2BusyNodes.has(node)
							? 'serving pm2-host (the deploy finishes first)'
							: 'unknown';
				logger.warn(`[runner-health] BACKSTOP FORCED but REFUSED (${blocker}) — ${why}`);
			}
		}

		// THE CAPACITY INVARIANT, PAGED (2026-10-21, `capacity-ledger.ts`). The
		// dispatcher judges what it charged each node against what it could see
		// every pass; this reads its last ledger and pages once when a node has
		// stayed broken for CAPACITY_TICKS_BEFORE_ALERT consecutive ticks. One
		// broken pass is a race between the unit listing and the probe; a quarter
		// of an hour of it is the 2026-10-07 bug, which ran fourteen days unseen
		// because every number on every panel was a different number from the
		// one that was wrong. A ledger older than two ticks is a dispatcher that
		// is not running, which is a different page (`dispatch.failingSince`),
		// not this one.
		const capLedger = getCapacityLedger();
		const freshLedger =
			capLedger !== null && Date.now() - Date.parse(capLedger.at) <= 2 * TICK_INTERVAL_MS
				? capLedger
				: null;
		const brokenNow = new Set((freshLedger?.nodes ?? []).filter((e) => !e.ok).map((e) => e.node));
		for (const node of [...capacityBrokenTicks.keys()]) {
			if (!brokenNow.has(node)) capacityBrokenTicks.delete(node);
		}
		const sustainedBroken: string[] = [];
		for (const node of brokenNow) {
			const seen = (capacityBrokenTicks.get(node) ?? 0) + 1;
			capacityBrokenTicks.set(node, seen);
			if (seen >= CAPACITY_TICKS_BEFORE_ALERT) sustainedBroken.push(node);
		}
		if (!sustainedBroken.length) {
			clearAlert('capacity-invariant');
		} else {
			const detail = (freshLedger?.nodes ?? [])
				.filter((e) => sustainedBroken.includes(e.node))
				.map((e) => `${e.node}: ${e.why}`)
				.join('; ');
			const mins = Math.round((CAPACITY_TICKS_BEFORE_ALERT * TICK_INTERVAL_MS) / 60000);
			await alertOnce(
				'capacity-invariant',
				`🚨 **dispatcher accounting** has been wrong on ${sustainedBroken.join(', ')} for ` +
					`${mins}+ min — a node is charged more in-flight jobs than it is running or ` +
					`starting, so it refuses mints it has room for (this is the 2026-10-07 double ` +
					`count's shape). ${detail}. Read \`[dispatch] skipped run\` lines and ` +
					'`GET /fleet` machines[].dispatchLedger.'
			);
		}

		// WHY THE PRODUCTION HOST IS REACHABLE, ON THE TICK IT IS REACHABLE.
		//
		// Until now the only lines this decision ever printed were its two EDGES,
		// the promote and the demote. Everything in between — the whole interval
		// during which hokon actually takes jobs — was silent, and a standing
		// registration wins GitHub's assignment race outright (hokon builder queue
		// p50 2s against a claw JIT's 16s), so that interval is where all the
		// traffic is. Over 2026-09-10 → 09-19 hokon served 204 `hadoku-builder`
		// jobs, 98 of them with ZERO claw jobs running anywhere, and there is not
		// one promote line in any retained log to explain a single one: the label
		// came from elsewhere and this function never knew. An operator asking
		// "why did hokon take that job" had nothing to read.
		//
		// So the eligible state says so every tick, and it says it through
		// `explainBackstop`, which lives beside the decision — a log line written
		// here by hand is a second copy of the reasoning and drifts from it. Six
		// lines an hour, and only while the reserve is actually in play.
		const why = explainBackstop(backstopInput, decision);
		if (backstopWanted && heldNodes.length) {
			logger.info(
				`[runner-health] BACKSTOP ELIGIBLE — ${heldNodes
					.map((n) =>
						outage ? n : `${n} (${describeSaturationHost(saturationHost(n), queuePressureSec)})`
					)
					.join(', ')} may take '${BUILDER_LABEL}' work: ${why}`
			);
		} else if (backstopWanted) {
			// WANTED AND REACHED NOBODY. "We rejected them" and "they never asked"
			// are different facts and the fleet could not tell them apart (wave 3l);
			// so is "every holder is quarantined" against "every holder is serving
			// pm2-host", which are two different jobs for the operator. Say which,
			// per node.
			//
			// NOT IDLE IS THE COMMON REASON AND IT READ `unknown`. The host gate
			// (`hostMayTakeSaturation`, 2026-10-09/21) is the fourth clause of
			// `wantedOnNode`, and this map named the other three. On 2026-10-21
			// hokon sat at load 30-46 on 12 cores under the operator's own sessions
			// while a 20-run fan-out queued for 25 minutes, and every tick printed
			// `hokon=unknown` — the one word that sends an operator to the wrong
			// problem. The verdict carries its own measurement against the gate, so
			// the line says what would have to change.
			const because = backstopNodes.length
				? backstopNodes
						.map((n) => {
							const host = saturationHost(n);
							return `${n}=${
								nodeIsSick(n)
									? 'quarantined'
									: isDraining(n, drain)
										? 'drained'
										: pm2BusyNodes.has(n)
											? 'serving pm2-host'
											: !host.ok
												? host.why
												: 'unknown'
							}`;
						})
						.join(', ')
				: 'the pool is EMPTY — no runner in this repo carries pm2-host or backstop';
			logger.warn(
				`[runner-health] BACKSTOP wanted but REACHED NOBODY (${because}): ${why} — ` +
					'jobs queue until a claw returns or a holder frees up'
			);
		} else if (decision.unmeasured) {
			// "I could not look" must never render as "nothing is wrong", and it
			// must say WHY. This branch decided nothing at all.
			logger.info(`[runner-health] BACKSTOP could not look: ${why}`);
		}

		const promoted: string[] = [];
		const demoted: string[] = [];

		// COULD NOT LOOK IS NOT AN ORDER. On an unmeasured tick (the first after
		// every restart) `decision.wanted` is the remembered state, and memory is
		// empty after a restart — so this loop and the sweep below DEMOTED a
		// promoted hokon on every deploy, and the next measured tick promoted it
		// again ten minutes later (2026-10-09 20:36, 20:52). Nothing is written
		// until a tick has actually measured the fleet.
		for (const runner of decision.unmeasured ? [] : hokonPool) {
			// THE RUNG IS THIS NODE'S, NOT THE FLEET'S. A pool node serving pm2-host
			// work stays off builder duty while the rest of the pool is promoted;
			// fleet-wide, this was the whole pool or none of it.
			const runnerNode = nodeOf(runner.name, fleetNodes);
			const nodeWanted = wantedOnNode(runnerNode) && labelsMayPromote(runnerNode);
			// ONE PREDICATE, shared with the fan-out — see `backstopLabelWrite`.
			// Spelled out twice, the two came to disagree about offline runners.
			const write = backstopLabelWrite(
				{ hasBuilder: has(runner, BUILDER_LABEL), online: runner.status === 'online' },
				nodeWanted
			);
			const missing = [BUILDER_LABEL];
			if (write === 'promote') {
				const res = await ghWrite('POST', `/actions/runners/${runner.id}/labels`, token, {
					labels: missing,
				});
				if (res.ok) {
					for (const l of missing) (runner.labels ??= []).push({ name: l });
					promoted.push(runner.name);
				} else {
					logger.warn(
						`[runner-health] promote ${runner.name} → ${missing.join(',')} failed: HTTP ${res.status} ` +
							'(token may lack runner-admin) — all-claws-down jobs will queue until a claw returns'
					);
				}
			} else if (write === 'demote') {
				// Strip only what we grant. hokon keeps pm2-host, the backstops keep
				// their own label, so the pool returns to being invisible to CI.
				// One label, since hadoku-builder-heavy was retired on 2026-08-19 and no
				// runner reports it any more (checked across four repos, 2026-08-29).
				const res = await ghWrite(
					'DELETE',
					`/actions/runners/${runner.id}/labels/${BUILDER_LABEL}`,
					token
				);
				if (res.ok) {
					runner.labels = (runner.labels ?? []).filter((l) => l.name !== BUILDER_LABEL);
					if (!demoted.includes(runner.name)) demoted.push(runner.name);
				} else {
					logger.warn(
						`[runner-health] demote ${runner.name} (remove ${BUILDER_LABEL}) failed: HTTP ${res.status}`
					);
				}
			}
		}

		for (const n of heldNodes) if (onDemand(n) && !wasHeld.has(n)) promoted.push(`${n} (mint)`);
		for (const n of wasHeld) {
			if (onDemand(n) && !heldNodes.includes(n)) demoted.push(`${n} (mint)`);
		}

		// Fan the same decision out to the rest of the fleet. Edge-triggered, plus a
		// re-assert while up; see syncBackstopAcrossFleet for why this cannot be
		// derived from this repo's listing.
		//
		// The re-assert is only for a node the label PROMOTES. An on-demand guest
		// is promoted by the hold above, and its sweep is demote-only — running it
		// every tick of a promotion would read the whole fleet's listings to change
		// nothing.
		const relabels = backstopNodes.some(labelsMayPromote);
		// The third condition is the VERIFY sweep — see `backstopConvergedMs`. The
		// first two ask "did I change my mind?"; only this one asks "is the fleet
		// actually in the state I believe it is?", which is the question the 165
		// jobs on 26 unlooked-at repos needed somebody to ask.
		const convergeDue = Date.now() - backstopConvergedMs >= BACKSTOP_CONVERGE_INTERVAL_MS;
		if (
			!decision.unmeasured &&
			(backstopFleetState !== backstopWanted || (backstopWanted && relabels) || convergeDue)
		) {
			try {
				const fleet = await withGhCaller('backstop', () =>
					syncBackstopAcrossFleet(backstopWanted, token, fleetRepos, (name) => {
						const node = nodeOf(name, fleetNodes);
						return unsafeNode(node) || !labelsMayPromote(node);
					})
				);
				// Only claim the state once nothing failed, so a partial fan-out is
				// retried next tick instead of being recorded as done. Same rule for
				// the verify clock: a sweep that could not read every repo has not
				// verified anything, and must not buy itself another hour of silence.
				if (!fleet.failed.length) {
					backstopFleetState = backstopWanted;
					backstopConvergedMs = Date.now();
				}
				if (convergeDue && fleet.changed.length && backstopFleetState === backstopWanted) {
					// A divergence the belief could not have shown. Warn, not info:
					// somebody other than this function wrote the one label it owns.
					logger.warn(
						`[runner-health] BACKSTOP verify sweep found ${fleet.changed.length} ` +
							`registration(s) out of step with reason=${backstopReason} — ` +
							`${fleet.changed.join(', ')}. This label has one writer; something else moved it.`
					);
				}
				if (fleet.changed.length) {
					logger.info(
						`[runner-health] BACKSTOP fleet ${backstopWanted ? 'promote' : 'demote'}: ` +
							`${fleet.changed.length} runner(s) — ${fleet.changed.join(', ')}`
					);
				}
				if (fleet.failed.length) {
					logger.warn(
						`[runner-health] BACKSTOP fleet ${backstopWanted ? 'promote' : 'demote'} FAILED on ` +
							`${fleet.failed.length}: ${fleet.failed.join(', ')} — those repos queue until this succeeds`
					);
				}
			} catch (err) {
				// Fail-soft like every other write in this tick: a broken fan-out must
				// not take down the monitor reporting the outage.
				logger.warn(
					`[runner-health] BACKSTOP fleet sync failed: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}

		if (promoted.length) {
			logger.info(
				`[runner-health] BACKSTOP promote (${backstopReason}): ` +
					`${clawsOnline}/${clawsRegistered} claw instances online, ${clawsFree} free ` +
					`→ ${promoted.join(', ')} now offer '${BUILDER_LABEL}'`
			);
			// Saturation is deliberately silent. Every claw being busy is a normal
			// weekday, and paging for it would train the operator to skim past the
			// 🔻 that means the garage is actually dark.
			if (outage) {
				await postDiscordSink(
					`🔻 **runners** on \`${selfHostname()}\`: only ${clawsOnline}/${clawsRegistered} claw instances ` +
						'online — promoted ' +
						`${promoted.map((n) => `\`${n}\``).join(', ')} so jobs still have somewhere to run. ` +
						'Degraded backstop on the prod host; reverts automatically when a claw returns.',
					'runner-health'
				);
				backstopAlerted = true;
			}
		}
		if (demoted.length) {
			logger.info(
				`[runner-health] BACKSTOP demote: ${clawsOnline} claw(s) online → released ` +
					`${demoted.join(', ')} — no longer offered '${BUILDER_LABEL}': ${why}`
			);
			// Mirror of the promote arm: only announce the recovery the operator was
			// told about. A demote after mere saturation never had a 🔻 to close.
			if (backstopAlerted) {
				await postDiscordSink(
					`🔺 **runners** on \`${selfHostname()}\`: a claw is back online — released the backstop on ` +
						`${demoted.map((n) => `\`${n}\``).join(', ')}.`,
					'runner-health'
				);
				backstopAlerted = false;
			}
		}

		// --- Hosted-runner fallback (CI_RUNNER across the whole fleet) ---
		// Now a genuine LAST resort. The hokon backstop above is fleet-wide (see
		// syncBackstopAcrossFleet), so counting hokon as self-hosted capacity here
		// finally describes capacity every repo can actually reach — which is what
		// this sum always assumed and, until 2026-08-23, never had.
		//
		// Driven purely by runner availability — never by a job's outcome — so a red
		// build is never retried or masked.
		try {
			// Escalation order is claws → hokon → GitHub-hosted. Hosted is the LAST
			// resort, not the second: it costs billed minutes on 12 private repos,
			// and a hosted runner cannot reach the vault (the fetch comes back as a
			// CF challenge, which is what broke auto-format on 2026-08-17). So the
			// fallback is driven by TOTAL self-hosted capacity — claws plus the
			// promoted hokon pool — and only flips when both are gone.
			// `null`, not the sum, when the probe has not run. Under all-JIT both
			// terms are derived from it, so on the first tick after a restart this
			// sum is not a small reading — it is no reading at all. `census` already
			// draws that line as `ephemeralUnknown`; the backstop consults it and
			// this call was the last consumer still acting on the zero.
			const selfHostedOnline = c.ephemeralUnknown ? null : clawsOnline + backstopOnline;
			const fb = await withGhCaller('ci-runner-var', () =>
				syncHostedFallback(selfHostedOnline, token, { alreadyHosted: hostedRepos })
			);
			data.ci_runner = fb.desired;
			// Deliberately NOT its own Discord alert. All-claws-down already pages
			// through the backstop promote and the label-floor breach, and a second
			// message for the same root cause is noise the operator learns to skip.
			// The fleet flip is reported inside the promote note (below) and here in
			// the log. `ci_runner` reaches the daily digest through the job-sink
			// payload below — NOT through the snapshot, which has no such field.
			if (fb.changed.length) {
				logger.info(
					`[runner-health] CI_RUNNER → ${fb.desired} on ${fb.changed.length} repo(s): ${fb.changed.join(', ')}`
				);
			}
			data.ci_runner_write_failed = fb.failed.length;
			// A FAILED WRITE IS A FINDING, NOT A LOG LINE.
			//
			// This was `logger.warn` alone, and nothing else read `fb.failed` — no
			// alert, no cron finding, no digest field — while the enclosing catch
			// is fail-soft too. So a repo whose variable could not be written
			// retried every 10 minutes, forever, and said so only into a log nobody
			// tails.
			//
			// What that costs depends on the runs-on form, and BOTH are bad. Fleet
			// workflows are now bare `fromJSON(vars.CI_RUNNER)`, so a repo that
			// never got its value has `runs-on` resolve to nothing and EVERY
			// workflow in it fails to start. And on the hosted flip — the one path
			// that only runs while every claw is already down — a failed write
			// leaves that repo pointed at claws that are not there, so it queues
			// through the outage the fallback exists to route around.
			//
			// COUNTED per repo, ANNOUNCED once.
			//
			// The debounce has to be per repo — one flaky repo and a fleet-wide token
			// scope loss are different faults and must not share a counter. The ALERT
			// must not be, though: these fail together far more often than singly (one
			// revoked token covers all 26), and a message per repo would be a 26-page
			// storm for one cause — the same noise this file already refuses to send
			// for the all-claws-down case.
			const failedNow = new Set(fb.failed);
			for (const repo of [...ciRunnerWriteFailTicks.keys()]) {
				// Not failing this tick — including repos syncHostedFallback SKIPPED
				// because its cache says they already hold the desired value. Skipped is
				// not failed, and treating it as such would hold this open on a repo
				// that is fine.
				if (failedNow.has(repo)) continue;
				ciRunnerWriteFailTicks.delete(repo);
			}
			const sustained: string[] = [];
			for (const repo of fb.failed) {
				const seen = (ciRunnerWriteFailTicks.get(repo) ?? 0) + 1;
				ciRunnerWriteFailTicks.set(repo, seen);
				if (seen >= OFFLINE_TICKS_BEFORE_ALERT) sustained.push(repo);
			}
			if (!sustained.length) {
				clearAlert('ci-runner-write');
			} else {
				const mins = Math.round((OFFLINE_TICKS_BEFORE_ALERT * TICK_INTERVAL_MS) / 60000);
				const named = sustained.slice(0, 5).join(', ');
				const more = sustained.length > 5 ? ` (+${sustained.length - 5} more)` : '';
				await alertOnce(
					'ci-runner-write',
					`🚨 **CI_RUNNER** could not be written on ${sustained.length} repo(s) for ` +
						`${mins}+ min (wanted \`${fb.desired}\`): ${named}${more}. Fleet workflows use ` +
						'bare `runs-on: ${{ fromJSON(vars.CI_RUNNER) }}`, so a repo that never got ' +
						'the value will FAIL TO START rather than queue. Usually the token has lost ' +
						'`actions:write`. Check: `gh api /repos/<repo>/actions/variables`'
				);
			}
			if (fb.failed.length) {
				logger.warn(
					`[runner-health] CI_RUNNER ${fb.desired} FAILED on ${fb.failed.length} repo(s): ${fb.failed.join(', ')} ` +
						'(token needs actions:write on each repo)'
				);
			}
		} catch (err) {
			// Fail-soft, like every other write here: a broken fallback must not
			// take down the monitor that is reporting the outage.
			logger.warn(
				`[runner-health] CI_RUNNER sync threw: ${err instanceof Error ? err.message : String(err)}`
			);
		}

		// MEASURED first, for everyone. The snapshot, the panel and the sitrep read
		// `label_online`, and they report what is true NOW — the confirmation below
		// gates the ALERT, which is a judgement about whether to wake someone.
		const watch = floorWatchSet();
		if (watch.staticProblem) data.label_floor_static_problem = watch.staticProblem;
		const labelOnline: Record<string, number> = {};
		for (const label of watch.labels) {
			labelOnline[label] = online.filter((r) =>
				(r.labels ?? []).some((l) => l.name === label)
			).length;
		}

		// ONE RULE FOR EVERY LABEL (label-floor.ts): served by a standing online
		// runner, OR offered by a minting node the dispatcher could mint on now.
		// The probe is the one this tick's census already used, so the two cannot
		// disagree about which claws are up.
		const mint = loadMintView(getFleetProbeSnapshot());
		const verdicts: Record<string, LabelFloorVerdict> = {};
		for (const label of watch.labels) {
			const standing = labelOnline[label] ?? 0;
			verdicts[label] = mint
				? judgeLabelFloor(label, standing, mint.view)
				: standing > 0
					? { state: 'standing', count: standing }
					: // The manifest is unreadable, so the minting arm cannot be asked.
						// Not served (nothing looked), not unserved (no evidence): held.
						{ state: 'unmeasured', nodes: [] };
		}
		data.label_floor = Object.fromEntries(Object.entries(verdicts).map(([l, v]) => [l, v.state]));

		// A DEMAND WITH NOTHING IN IT IS NOT A FLEET WITH NOTHING TO SERVE. The
		// fleet runs hundreds of jobs a day; an empty watched set means job history
		// stopped recording AND the persisted static demand is gone, and a floor
		// that watches nothing passes everything. Paged on its own key.
		if (!watch.labels.some((l) => l !== BUILDER_LABEL)) {
			await alertOnce(
				'label-floor:no-demand',
				`🚨 **runners** on \`${selfHostname()}\`: the label floor has NOTHING to watch — no ` +
					'job in the retention window requested a routing label, and the static demand ' +
					`could not be read (${watch.staticProblem ?? 'it was empty'}). A floor over an ` +
					'empty set passes every outage. Check that job history is recording and run ' +
					'`fleet label-floor`.'
			);
		} else {
			clearAlert('label-floor:no-demand');
		}

		// The minting arm could not be asked at all. Loud on its own key, like a
		// truncated listing, and every label that needed it is HELD below.
		const needsMint = watch.labels.filter(
			(l) => l !== BUILDER_LABEL && verdicts[l].state === 'unmeasured'
		);
		if (!mint && needsMint.length) {
			await alertOnce(
				'label-floor:mint-unknown',
				`🚨 **runners** on \`${selfHostname()}\`: the fleet manifest is unreadable, so the label ` +
					`floor cannot ask which minting nodes offer ${needsMint.map((l) => `\`${l}\``).join(', ')} ` +
					'— no standing runner carries them online. Not judged this tick; fix the manifest.'
			);
		} else {
			clearAlert('label-floor:mint-unknown');
		}

		// A zero is not paged on one look. `confirmFloorZero` is called at most
		// once per tick, and only when a label this check can page for is judged
		// UNSERVED in the first read — so the happy path costs nothing, and a label
		// the claws are minting fine never costs a second listing.
		const pageable = watch.labels.filter((l) => l !== BUILDER_LABEL);
		const suspected = pageable.filter((l) => verdicts[l].state === 'unserved');
		const confirmation =
			suspected.length && !truncated
				? await confirmFloorZero(token)
				: (null as FloorConfirmation | null);
		if (truncated) {
			// LOUD, and about the right thing. A truncated listing is not a
			// capability outage and must not be rendered as one — but it is also not
			// a clean bill of health, so it pages on its own key and the per-label
			// streaks below are HELD rather than advanced or cleared.
			await alertOnce(
				'label-floor:truncated',
				`🚨 **runners** on \`${selfHostname()}\`: the runner listing for \`${SELF_REPO}\` came back ` +
					`PARTIAL — ${runners.length} of ${runnersResp.total_count} registrations. The label floor ` +
					'cannot be judged from part of a census, so it is not being judged this tick. ' +
					"`per_page` is already at GitHub's maximum of 100; this needs a page-until-empty loop."
			);
		} else {
			clearAlert('label-floor:truncated');
		}

		// A label that LEFT the watched set (its demand aged out) takes its streak
		// and its alert with it — otherwise an alert for a label nothing asks for
		// any more stays armed, and the next unrelated blip re-pages it.
		for (const label of [...labelZeroTicks.keys()]) {
			if (watch.labels.includes(label)) continue;
			labelZeroTicks.delete(label);
			clearAlert(`label-floor:${label}`);
		}

		for (const label of watch.labels) {
			const verdict = verdicts[label];
			const key = `label-floor:${label}`;
			// RETIRED 2026-09-08 (decision C0b, see `claw-floor-design-2026-09-07.md`
			// §10). `hadoku-builder` is the fleet's one ELIGIBILITY label: the fast
			// loop writes it, every claw mints it, and "can CI run right now" is
			// owned by `check-queue-health`, measured by queue age. An all-claws-down
			// outage — the only state in which nothing could serve it — already pages
			// through the backstop's 🔻, which promotes hokon onto it in this same
			// tick. Still MEASURED and JUDGED (the snapshot and the per-node
			// suppression below read the verdict), just never alerted on here.
			if (label === BUILDER_LABEL) {
				labelZeroTicks.delete(label);
				clearAlert(key);
				continue;
			}
			if (verdict.state === 'standing' || verdict.state === 'minting') {
				labelZeroTicks.delete(label);
				clearAlert(key);
				continue;
			}
			if (verdict.state === 'unmeasured') {
				// THE FAST LOOP HAS NOT PROBED YET — ~60s after every mgmt-api restart,
				// and runner-health's first tick lands inside it. Nothing stands, and
				// the minting nodes that offer this have not been looked at. HOLD:
				// clearing would be "I could not look" rendering as "nothing is wrong";
				// advancing would page a healthy fleet on every deploy (census.ts,
				// 2026-09-02).
				logger.warn(
					`[runner-health] label floor \`${label}\`: no standing runner online, and the minting ` +
						`node(s) offering it (${verdict.nodes.join(', ') || 'unknown — manifest unreadable'}) ` +
						'have not been probed yet — holding the streak, not paging.'
				);
				continue;
			}
			// UNSERVED on the first read. A partial census produced the standing
			// zero — it is not evidence.
			if (truncated) continue;
			// Could not look a second time: a suppressed budget, an unreadable
			// listing, or one that came back truncated. HOLD the streak. Clearing
			// it would be "I could not look" rendering as "nothing is wrong";
			// advancing it would page on a single look, which is the thing this
			// confirmation exists to stop.
			if (!confirmation) {
				logger.warn(
					`[runner-health] label floor \`${label}\` read UNSERVED but the confirming listing was ` +
						'unreadable — holding the streak, not paging. Check the token and the rate-limit ' +
						'budget: an unconfirmed zero is neither a breach nor a pass.'
				);
				continue;
			}
			const second = confirmation.labels[label] ?? 0;
			// The two reads DISAGREED. That is the 2026-09-12 shape (#24): GitHub's
			// `status` said offline on one read and online seconds later, while it
			// was scheduling jobs onto the very runner in question. Held, not
			// cleared — a sustained outage that flaps keeps its streak instead of
			// being reset by the flapping, so it still pages on the next tick both
			// reads agree on.
			if (second > 0) {
				logger.warn(
					`[runner-health] label floor \`${label}\`: first read said 0 online, the confirming ` +
						`read ${Math.round(floorConfirmDelayMs / 1000)}s later said ${second} ` +
						`(online: ${confirmation.names}). Two answers is not evidence — holding.`
				);
				continue;
			}
			const seen = (labelZeroTicks.get(label) ?? 0) + 1;
			labelZeroTicks.set(label, seen);
			if (seen >= OFFLINE_TICKS_BEFORE_ALERT) {
				const mins = Math.round((seen * TICK_INTERVAL_MS) / 60000);
				await alertOnce(
					key,
					`🚨 **runners** on \`${selfHostname()}\`: nothing has served label \`${label}\` for ` +
						`${mins} min — ${verdict.why}${mint?.drainProblem ? ` (${mint.drainProblem})` : ''}. ` +
						`Jobs using \`runs-on: [self-hosted, ${label}]\` will queue. Two reads ` +
						`${Math.round(floorConfirmDelayMs / 1000)}s apart agreed: \`${SELF_REPO}\` lists ` +
						`${confirmation.registrations} registration(s), none of them carrying it online. ` +
						`Online runners: ${confirmation.names}`
				);
			}
		}

		// --- Individual runner offline (fleet DEGRADED, floor still met) ---
		// The label-floor check above only fires at ZERO online. With claw-1 and
		// claw-2 up, claw-3 sat dead for a full day and nothing ever said so —
		// found by hand on 2026-08-15, Tailscale reporting "last seen 1d ago".
		// The first node to die is the one worth hearing about; by the time the
		// floor breaks, CI is already stopped.
		//
		// Suppressed to hourly by alertOnce while it stays down, cleared the moment
		// it returns, and skipped entirely during a FULL outage — that pages twice
		// already (backstop promote + label floor), and a third message per dead
		// node for one root cause is noise the operator learns to skip.
		//
		// `clawsOnline === 0` is checked separately from the floor because the
		// backstop PROMOTES hokon to hadoku-builder in that case, which repairs the
		// floor in this same tick — so the floor alone reads healthy during exactly
		// the outage this needs to stay quiet for.
		const floorAlreadyBreached =
			clawsOnline === 0 || Object.values(verdicts).some((v) => v.state === 'unserved');

		// Group by NODE first: one dead claw hosts two runner instances, and
		// announcing each separately doubles every message for a single fault.
		// `fleetNodes`, loaded once above, is what lets `hokon-tenhands` fold
		// onto `hokon` and a JIT runner onto the node that minted it. Without
		// it every instance name is its own "node" and one dead box reports
		// twice.
		//
		// AN EPHEMERAL NODE IS JUDGED BY ITS PROBE, NOT THIS LISTING. Its only
		// registrations here are JIT runners, and a JIT runner reads `offline`
		// between its mint and its listener connecting and again after its job,
		// until GitHub drops it. A tick that caught claw-8 in that gap counted as
		// a tick down, and a later one did the same, so `claw-8 OFFLINE for 20
		// min` was written on 2026-10-22 03:16Z while it ran a job every few
		// minutes. claw-9 on 2026-10-16 17:30Z was the same shape. And a dead
		// ephemeral node has no registrations at all, so this listing could
		// only ever accuse a live one. `deriveClawState` already draws this line
		// from the fast loop's probe; `unreachable` there is what down means.
		// An unprobed node (no state yet) holds its count, neither direction.
		const byNode = new Map<string, { names: string[]; allOffline: boolean }>();
		for (const r of runners) {
			const m = nodeOf(r.name, fleetNodes);
			if (ephemeral.has(m)) continue;
			const e = byNode.get(m) ?? { names: [], allOffline: true };
			e.names.push(r.name);
			if (r.status === 'online') e.allOffline = false;
			byNode.set(m, e);
		}
		for (const m of ephemeral) {
			const st = clawState[m];
			if (st === undefined) continue;
			byNode.set(m, { names: [], allOffline: st === 'unreachable' });
		}
		// CONSECUTIVE ticks, or it is not "for 20 min". A node that is in no
		// listing this tick was not seen down, so its count starts over — the
		// count is what the message multiplies into a duration.
		for (const m of offlineTicks.keys()) {
			if (byNode.has(m) || (ephemeral.has(m) && clawState[m] === undefined)) continue;
			offlineTicks.delete(m);
			offlineRepeats.delete(m);
			clearAlert(`runner-offline:${m}`);
		}

		for (const [node, e] of byNode) {
			const key = `runner-offline:${node}`;
			// A node only counts as down when EVERY instance on it is offline —
			// one instance dying while its twin serves is a runner fault, not a
			// dead box, and the label floor already covers the capacity question.
			if (!e.allOffline) {
				offlineTicks.delete(node);
				offlineRepeats.delete(node);
				clearAlert(key);
				continue;
			}
			const seen = (offlineTicks.get(node) ?? 0) + 1;
			offlineTicks.set(node, seen);
			if (floorAlreadyBreached || seen < OFFLINE_TICKS_BEFORE_ALERT) continue;

			const repeats = offlineRepeats.get(node) ?? 0;
			const wait =
				OFFLINE_REPEAT_BACKOFF_MS[Math.min(repeats, OFFLINE_REPEAT_BACKOFF_MS.length - 1)];
			const last = lastAlertAt.get(key) ?? 0;
			if (repeats > 0 && Date.now() - last < wait) continue;

			const mins = Math.round((seen * TICK_INTERVAL_MS) / 60000);
			const downFor = mins >= 120 ? `${Math.round(mins / 60)}h` : `${mins} min`;
			const instances = e.names.length > 1 ? ` (${e.names.join(', ')})` : '';
			// Bypasses alertOnce deliberately: that helper is a fixed hourly window,
			// and this condition needs the escalating ladder instead.
			lastAlertAt.set(key, Date.now());
			offlineRepeats.set(node, repeats + 1);
			// LEDGER ONLY. Read the message: capacity is fine and nothing is
			// queuing, so there is no action that has to happen now — the box needs
			// hands on it eventually, which is a morning-read item, not a ping. It
			// was 24 of the 114 runner-health alerts in the fifteen days to
			// 2026-08-28, all of them announcing that nothing was wrong. The
			// escalating ladder above is kept: it still paces the ledger rows, so a
			// box down for a week does not write one every ten minutes.
			//
			// The floor breach and the all-claws-down backstop still PING — this is
			// only the case where redundancy did its job.
			quietRecorder(
				`⚠️ **runners** on \`${selfHostname()}\`: \`${node}\`${instances} OFFLINE for ${downFor}. ` +
					`CI has capacity (online: ${onlineNames}) and nothing is queuing — the box needs power/network.`,
				'runner-health'
			);
		}
		data.online = online.length;
		data.offline = runners.length - online.length;
		data.label_online = labelOnline;
	} else {
		logger.warn(
			'[runner-health] /actions/runners unreadable — skipping label-floor check ' +
				'(token may lack runner-listing privilege). Queued-job check still runs.'
		);
	}
	return out;
}

/**
 * Checks 2 & 3 — queued/hung runs, and failover for jobs whose runner vanished.
 *
 * Returns whether ANY repo's runs were readable. A partial read still counts:
 * tick() hard-fails only when neither this nor the label floor could read
 * anything, so a token that has lost runner-listing privilege still keeps the
 * queued-job safety net.
 */
async function checkRunsAndFailover(
	token: string,
	fleetRepos: string[],
	data: TickReport,
	runnersChecked: boolean,
	onlineRunnerNames: Set<string> | null,
	selfHostedRunnerNames: Set<string> | null,
	onlineLabels: Record<string, number> | null,
	selfRunners: GhRunner[] | null
): Promise<boolean> {
	// --- Checks 2 & 3: queued / hung / dropped-job failover — FLEET-WIDE ---
	//
	// These read RUNS, and runs are per-repo. Until 2026-08-17 every call was
	// hardcoded to hadoku_site, so all three covered 1 repo out of 20 while
	// reporting fleet-wide numbers. See SELF_REPO for what that cost.
	//
	// Cost: one runs listing per repo per tick (~27 calls / 10 min). Runner
	// listings are fetched LAZILY and only for a repo that actually has a
	// failover candidate, so a quiet tick adds nothing beyond the listings.
	// (hoisted to the top of tick() — the saturation gate above needs it too)
	//
	// Time: the listings used to go out one after another, ~35s of every tick,
	// which is most of why the Fleet tab sat blank after each mgmt-api restart.
	// They now go out `SWEEP_CONCURRENCY` at a time — see `sweepRepo` below for
	// what that required of the state they share.

	// Per-tick runner state, keyed by repo. hadoku_site is seeded from Check 1.
	// A child repo may carry runners hadoku_site does not (hokon-tenhands), so
	// its own listing is the only correct source for "was this runner ours, and
	// is it offline now".
	//
	// It carries the repo's LABEL CENSUS as well, for the same reason it carries
	// its names: hadoku_site's registrations do not describe hadoku-tenhands,
	// which registers two boxes to hadoku_site's dozen. Classifying a tenhands
	// queue against hadoku_site's labels answers a question about the wrong repo.
	//
	// And the registrations themselves, offline ones included: a JIT runner
	// minted for a queued job and never come online is only visible there.
	const runnerStateCache = new Map<
		string,
		({ online: Set<string>; known: Set<string> } & RepoRunnerState) | null
	>();
	if (onlineRunnerNames && selfHostedRunnerNames && onlineLabels && selfRunners) {
		runnerStateCache.set(SELF_REPO, {
			online: onlineRunnerNames,
			known: selfHostedRunnerNames,
			labels: onlineLabels,
			runners: selfRunners,
		});
	}
	// The minting arm for the queued-run classifier, read at most once per tick
	// and only when a run is actually past the threshold. Same loader, same
	// probe, as the label floor above it.
	let queuedMint: ReturnType<typeof loadMintView> | undefined;
	const queuedMintView = () => {
		if (queuedMint === undefined) queuedMint = loadMintView(getFleetProbeSnapshot());
		return queuedMint;
	};
	const runnerStateFor = async (repo: string) => {
		if (runnerStateCache.has(repo)) return runnerStateCache.get(repo) ?? null;
		// Shared (#118) — see readRunnerListingShared for who may read it.
		const resp = await readRunnerListingShared(repo, token);
		const state =
			resp && Array.isArray(resp.runners)
				? {
						online: new Set(resp.runners.filter((r) => r.status === 'online').map((r) => r.name)),
						known: new Set(resp.runners.map((r) => r.name)),
						labels: countLabels(resp.runners.filter((r) => r.status === 'online')),
						runners: resp.runners,
					}
				: null;
		runnerStateCache.set(repo, state);
		return state;
	};

	const now = Date.now();
	// Ages, not just counts. A count answers "is anything stuck" but not "how
	// bad" — and the stale counters only tick ABOVE the warn thresholds, so a
	// fleet with nine jobs queued for nine minutes reports queued_stale=0 and
	// looks idle. These track every queued/running job regardless of threshold,
	// which is what makes a queue visible before it is an incident.
	let oldestQueuedMin = 0;
	let longestRunningMin = 0;
	let queuedNow = 0;
	let runningNow = 0;
	// Shared across the whole fleet sweep, not per repo: the cap exists to bound
	// this TICK's API cost, and a per-repo budget would multiply it by 26. One
	// object rather than a number because the repos below run concurrently.
	const jobFetchBudget = new FetchBudget(MAX_FETCH_PER_TICK);
	let queuedStale = 0;
	let inProgressStale = 0;
	let failoverReruns = 0;
	// Rerun slots CLAIMED this tick, as distinct from reruns that succeeded. With
	// several repos in flight, checking `failoverReruns` alone would let every
	// repo that passed the check before the first POST resolved fire its own,
	// and the cap would hold only in the sequential case. A slot is claimed right
	// before the POST and handed back if GitHub refuses it, so a refused rerun
	// still does not count against the cap — the same rule as before.
	let rerunSlotsTaken = 0;
	// Subset of failoverReruns that were OOM kills rather than a runner going away.
	// Tracked separately because a rising count here is a CAPACITY signal — the
	// fleet is being asked to run more concurrent jobs than a box can hold — where
	// a rising failover count is an AVAILABILITY one.
	let oomReruns = 0;
	let reposRead = 0;

	// One repo's sweep. The repos run `SWEEP_CONCURRENCY` at a time (below), so
	// everything this closure shares with its siblings has to be safe under
	// interleaving. Audited when the fan-out went in:
	//   - counters and maxima above: order-independent.
	//   - `runnerStateCache`: keyed by repo, and each repo is swept once.
	//   - `failoverReran`, alert keys: carry the repo or the run URL.
	//   - `jobFetchBudget`, `rerunSlotsTaken`: claimed with no await in between.
	//   - `ingestRuns`: dedupes on run id before its await, appends synchronously.
	// Within a repo the runs are still visited in listing order, one at a time,
	// so the per-repo rerun and alert ordering is exactly what it was.
	const sweepRepo = async (repo: string): Promise<void> => {
		const runsResp = await ghGet<{ workflow_runs?: GhRun[] }>(
			'/actions/runs?per_page=30',
			token,
			repo
		);
		if (!runsResp || !Array.isArray(runsResp.workflow_runs)) return;
		reposRead++;
		const ownerPrefix = `${fleetOwner()}/`;
		const short = repo.startsWith(ownerPrefix) ? repo.slice(ownerPrefix.length) : repo;

		// Feed the job-history window off the listing we just paid for. Only
		// newly-COMPLETED runs cost anything (one jobs call each, capped per tick),
		// so a quiet fleet adds nothing and a burst simply catches up next tick.
		await ingestRuns(
			repo,
			runsResp.workflow_runs,
			(r, runId) => ghGet<{ jobs?: unknown[] }>(`/actions/runs/${runId}/jobs`, token, r) as never,
			jobFetchBudget
		);

		for (const run of runsResp.workflow_runs) {
			// THIS attempt's clock, not the original run's — see `run_started_at`.
			const startedMs = Date.parse(run.run_started_at ?? run.created_at);
			if (isNaN(startedMs)) continue;
			const ageMin = (now - startedMs) / 60000;
			if (run.status === 'queued') {
				queuedNow++;
				if (ageMin > oldestQueuedMin) oldestQueuedMin = ageMin;
			} else if (run.status === 'in_progress') {
				runningNow++;
				if (ageMin > longestRunningMin) longestRunningMin = ageMin;
			}
			const title = run.display_title || run.name || '(unnamed run)';

			if (run.status === 'queued' && ageMin > QUEUED_WARN_MINUTES) {
				queuedStale++;
				// "likely no online runner matches its labels" was a GUESS, and it was
				// usually wrong: with 27 registered instances a ten-minute queue is
				// far more often a busy pool than an uncovered one. It fired 36 times
				// in the fifteen days to 2026-08-28, the largest single category of
				// runner-health traffic, mostly during the nightly package storm when
				// every claw was legitimately saturated.
				//
				// So ASK, the same way the in_progress branch below does and for the
				// same reason: classify from the jobs. If an online runner carries
				// every label the job wants, the job is queuing behind work, which is
				// a wait, not a fault. Only a label nothing online can serve is a
				// coverage gap worth a ping.
				// Judged against THIS repo's registrations, not hadoku_site's.
				const verdict = await classifyQueuedRun(
					run.id,
					token,
					repo,
					await runnerStateFor(repo),
					queuedMintView(),
					ageMin,
					now
				);
				// The workflow NAME, not just the commit subject. `display_title` is
				// the commit message, so two different workflows on one push render as
				// byte-identical alerts — on 2026-09-10 a Tests run and a Pages run
				// arrived looking like the same finding posted twice.
				const wf = run.name ? `\`${run.name}\` / ` : '';
				const line =
					`⏱ **runners** on \`${selfHostname()}\`: \`${short}\` — ${wf}\`${title}\` has been ` +
					`QUEUED ${Math.round(ageMin)}m (>${QUEUED_WARN_MINUTES}m) — ${verdict.reason}` +
					`\n${run.html_url}`;
				if (verdict.covered) quietRecorder(line, 'runner-health');
				else await alertOnce(`queued:${run.html_url}`, line);
				continue;
			}
			if (run.status === 'in_progress' && ageMin > INPROGRESS_WARN_MINUTES) {
				// A run's status CANNOT distinguish a running job from one still
				// waiting for a runner: GitHub marks the run `in_progress` as soon
				// as it picks it up, whether or not anything is executing. Reading
				// it as "hung" therefore reports the exact OPPOSITE of a coverage
				// gap — on 2026-08-23 hadoku-games-host, which had no runners at
				// all, sat 854 minutes and alerted as "possible hung job pinning a
				// runner". Nothing was pinning anything; nothing could run. The
				// moment a runner existed the job finished in 32 seconds.
				//
				// So classify from the JOBS, which is the rule this repo already
				// states for CI timing and this check was not following. Costs one
				// extra listing, and only for a run already past the threshold.
				const detail = await ghGet<{ jobs?: GhJob[] }>(`/actions/runs/${run.id}/jobs`, token, repo);
				const jobs = Array.isArray(detail?.jobs) ? detail.jobs : [];
				const running = jobs.filter((j) => j.status === 'in_progress' && j.started_at);
				const waiting = jobs.filter((j) => j.status === 'queued' || !j.started_at);

				if (running.length) {
					// Measure from when the job STARTED, not when the run was created:
					// a job that queued 9h and has been executing 2min is not hung.
					//
					// LONG IS NOT HUNG, and that is the whole difference. Runtime alone
					// says a job is slow; only a job that has stopped FINISHING STEPS is
					// stuck. brave-quartet's Bevy compile runs 8-9 minutes hosted and
					// 40+ on a claw, so moving it onto the fleet on 2026-09-10 put a
					// healthy job past this ceiling within the hour — it was advancing
					// through its steps the entire time it was being called hung.
					//
					// So the ceiling is now a TRIGGER TO LOOK, and the step count is
					// what answers. Re-tuning a runtime threshold every time the
					// workload mix changes is a treadmill, and it is wrong for the
					// fleet's slowest node by construction.
					// PROGRESS IS ONLY READABLE WHEN GITHUB REPORTS STEPS. When it does
					// not — an older payload, a job it has not expanded — this falls
					// back to the runtime ceiling and stays LOUD. "I could not tell
					// whether it was progressing" must never render as "it is fine";
					// that is the same silence the 854-minute games-host outage taught
					// this check to refuse, one question deeper.
					let worst: { min: number; stuckMin: number; step: string; readable: boolean } | null =
						null;
					// The LONGEST-RUNNING readable job, for the slow-not-hung ledger
					// row below. Not `worst`: that is picked by time without progress,
					// so it can be a job that started a minute ago (#131).
					let slowest: { min: number; step: string } | null = null;
					for (const j of running) {
						const min = (now - Date.parse(j.started_at!)) / 60000;
						const steps = Array.isArray(j.steps) ? j.steps : [];
						const id = typeof j.id === 'number' ? j.id : -1;
						const readable = steps.length > 0 && id >= 0;
						if (!readable) {
							// An unreadable job outranks a readable one — it is the case
							// that can hide a real stall — and among unreadable ones, the
							// longest-running is the one worth naming.
							if (!worst || worst.readable || min > worst.min) {
								worst = { min, stuckMin: min, step: '(steps unreadable)', readable: false };
							}
							continue;
						}
						const done = steps.filter((st) => st.conclusion).length;
						const prev = jobProgress.get(id);
						// First sighting, or the count moved: it is working. Reset the clock.
						if (!prev || prev.done !== done) jobProgress.set(id, { done, since: now });
						const stuckMin = (now - jobProgress.get(id)!.since) / 60000;
						// Name the step it is sitting on — a finding that says only
						// "hung" sends the operator to open the run every time.
						const cur = steps.find((st) => !st.conclusion)?.name ?? '(no step reported)';
						if (!slowest || min > slowest.min) slowest = { min, step: cur };
						if (!worst || stuckMin > worst.stuckMin) {
							worst = { min, stuckMin, step: cur, readable: true };
						}
					}

					if (worst && !worst.readable && worst.min > INPROGRESS_WARN_MINUTES) {
						// Fail loud, and SAY the reason is missing evidence rather than
						// asserting a stall we could not observe.
						inProgressStale++;
						await alertOnce(
							`hung:${run.html_url}`,
							`🚨 **runners** on \`${selfHostname()}\`: \`${short}\` — \`${title}\` has been ` +
								`EXECUTING ${Math.round(worst.min)}m (>${INPROGRESS_WARN_MINUTES}m) — possible hung ` +
								`job pinning a runner. (GitHub reported no steps, so progress could not be ` +
								`checked and this is unconfirmed.)\n${run.html_url}`
						);
					} else if (worst && worst.readable && worst.stuckMin > STUCK_MINUTES) {
						inProgressStale++;
						await alertOnce(
							`hung:${run.html_url}`,
							`🚨 **runners** on \`${selfHostname()}\`: \`${short}\` — \`${title}\` has been ` +
								`EXECUTING ${Math.round(worst.min)}m and has not finished a step in ` +
								`${Math.round(worst.stuckMin)}m (>${STUCK_MINUTES}m) — stuck on ` +
								`\`${worst.step}\`, likely pinning a runner.\n${run.html_url}`
						);
					} else if (slowest && slowest.min > INPROGRESS_WARN_MINUTES) {
						// Past the runtime ceiling but still finishing steps. Worth a
						// ledger row — a job that has doubled its usual runtime is a
						// capacity signal — but not a page: nothing is wrong.
						//
						// Gated on the JOB's own runtime (#131). This block is entered on
						// the RUN's age, which counts every minute its later jobs spent
						// queued, so a job one minute in printed "EXECUTING 1m (>30m)".
						quietRecorder(
							`⏳ **runners** on \`${selfHostname()}\`: \`${short}\` — \`${title}\` has been ` +
								`EXECUTING ${Math.round(slowest.min)}m (>${INPROGRESS_WARN_MINUTES}m) but is still ` +
								`finishing steps — currently \`${slowest.step}\`. Slow, not hung.\n${run.html_url}`,
							'runner-health'
						);
					}
					continue;
				}

				if (waiting.length) {
					// Same condition the queued branch above reports, reached by a
					// different route — the run says in_progress while its work has
					// never been placed. Keyed as `queued:` so it dedupes with that
					// branch rather than paging twice for one starvation.
					queuedStale++;
					// Name the CAUSE, not just the symptom. The label-floor check
					// reads hadoku_site's listing as the fleet-wide view, which is
					// right for the claws but structurally blind to a repo with no
					// runners of its own — hadoku_site had six `hadoku-builder`
					// runners online while hadoku-games-host had ZERO, so the floor
					// looked healthy for the entire 854 minutes. This repo's own
					// listing is the only thing that can say so.
					const state = await runnerStateFor(repo);
					const onlineHere = state?.online.size ?? null;
					const cause =
						onlineHere === 0
							? `**this repo has NO online runners registered** — a job requesting ` +
								`self-hosted here can never be placed`
							: onlineHere === null
								? `its runner listing was unreadable`
								: `${onlineHere} runner(s) online here, none matching this job's labels`;
					await alertOnce(
						`queued:${run.html_url}`,
						`⏱ **runners** on \`${selfHostname()}\`: \`${short}\` — \`${title}\` has been WAITING FOR A ` +
							`RUNNER ${Math.round(ageMin)}m (>${QUEUED_WARN_MINUTES}m): ${cause}. ` +
							`A COVERAGE gap, not a hung job — check \`pnpm run fleet:reconcile\`.` +
							`\n${run.html_url}`
					);
				}
				// Could not identify a single job — either the listing was
				// unreadable or it came back empty. Fall back to the old run-level
				// alert rather than going quiet: "we could not classify it" must
				// never silently retire the hung-job signal, which is the same
				// fail-toward-reporting rule the rest of this file follows. Only a
				// run whose jobs were READ and are all finished stays silent, which
				// is the genuinely uninteresting case (a workflow finalising).
				if (!detail || jobs.length === 0) {
					inProgressStale++;
					await alertOnce(
						`hung:${run.html_url}`,
						`🚨 **runners** on \`${selfHostname()}\`: \`${short}\` — \`${title}\` has been IN-PROGRESS ` +
							`${Math.round(ageMin)}m (>${INPROGRESS_WARN_MINUTES}m) — possible hung job pinning ` +
							`a runner. (Job detail unavailable, so this is unconfirmed: it may instead be ` +
							`waiting for a runner.)\n${run.html_url}`
					);
				}
				continue;
			}

			// --- dropped-job failover (needs Actions:write) ---
			if (!runnersChecked) continue;
			if (rerunSlotsTaken >= MAX_RERUNS_PER_TICK) continue;
			if (run.status !== 'completed' || run.conclusion !== 'failure') continue;
			const attempt = run.run_attempt ?? 1;
			if (attempt >= MAX_RERUN_ATTEMPTS) continue;
			const updatedMs = Date.parse(run.updated_at ?? run.created_at);
			if (!isNaN(updatedMs) && (now - updatedMs) / 60000 > FAILOVER_RECENT_MINUTES) continue;
			const dedupeKey = `${repo}#${run.id}@${attempt}`;
			if (failoverReran.has(dedupeKey)) continue;

			const state = await runnerStateFor(repo);
			if (!state) continue;

			const jobsResp = await ghGet<{ jobs?: GhJob[] }>(`/actions/runs/${run.id}/jobs`, token, repo);
			if (!jobsResp || !Array.isArray(jobsResp.jobs)) continue;

			// Only jobs that failed on a runner WE own are ever rerun. A failure on
			// a hosted runner, or on someone else's, is not ours to second-guess.
			const failedOnOurs = jobsResp.jobs.filter(
				(j): j is GhJob & { runner_name: string } =>
					j.conclusion === 'failure' && !!j.runner_name && state.known.has(j.runner_name)
			);
			if (failedOnOurs.length === 0) continue;

			// Two INFRASTRUCTURE failure modes, both retryable, and they are
			// distinguished by opposite evidence — so they need separate probes:
			//
			//   runner offline   the box went away UNDER the job. GitHub reports it,
			//                    so the runner listing is the evidence.
			//   SIGKILL          the box is fine and the JOB was killed (OOM). The
			//                    runner is still online, so the listing says nothing
			//                    and only the job's own exit code shows it.
			//
			// Checking the listing first keeps the common case at zero extra calls.
			let reason = failedOnOurs.find((j) => !state.online.has(j.runner_name))
				? `'${failedOnOurs.find((j) => !state.online.has(j.runner_name))!.runner_name}' went offline`
				: '';

			if (!reason) {
				const refused = failedOnOurs.find((j) => refusedAtAdmission(j));
				if (refused) reason = `refused at admission by ci-throttle on '${refused.runner_name}'`;
			}

			if (!reason) {
				for (const j of failedOnOurs) {
					if (typeof j.id !== 'number') continue;
					if (await jobWasKilled(repo, j.id, token)) {
						reason = `SIGKILL (exit 137, OOM) on '${j.runner_name}'`;
						oomReruns++;
						break;
					}
				}
			}
			if (!reason) continue;

			// Re-checked here, not only at the top: the probes above awaited, and a
			// sibling repo may have taken the last slot meanwhile.
			if (rerunSlotsTaken >= MAX_RERUNS_PER_TICK) continue;
			rerunSlotsTaken++;
			logger.info(
				`[runner-health] FAILOVER rerun: ${short} run ${run.id} '${title}' — ${reason} ` +
					`→ POST rerun-failed-jobs ` +
					`(attempt ${attempt + 1}/${MAX_RERUN_ATTEMPTS}) ${run.html_url}`
			);
			const res = await ghWrite(
				'POST',
				`/actions/runs/${run.id}/rerun-failed-jobs`,
				token,
				undefined,
				repo
			);
			if (res.ok) {
				failoverReran.add(dedupeKey);
				failoverReruns++;
				// A self-healed claw drop is NOT outage-worthy — GitHub reruns the
				// failed jobs onto the next ready claw and CI stays green. So this
				// records but does NOT ping Discord live; the daily ci-digest rolls
				// up "N auto-reruns today" instead (workers/monitoring-api/ci-digest).
				logger.info(
					`[runner-health] FAILOVER rerun: ${short} run ${run.id} accepted (HTTP ${res.status})`
				);
			} else {
				rerunSlotsTaken--;
				logger.warn(
					`[runner-health] failover rerun for ${short} run ${run.id} → HTTP ${res.status} ` +
						'(token may lack actions:write) — job left failed for the operator'
				);
			}
		}
	};

	await mapConcurrent(fleetRepos, SWEEP_CONCURRENCY, sweepRepo);

	const runsChecked = reposRead > 0;
	data.queued_stale = queuedStale;
	data.inprogress_stale = inProgressStale;
	data.queued_now = queuedNow;
	data.running_now = runningNow;
	data.oldest_queued_min = Math.round(oldestQueuedMin);
	data.longest_running_min = Math.round(longestRunningMin);
	data.failover_reruns = failoverReruns;
	data.oom_reruns = oomReruns;
	data.repos_scanned = reposRead;
	return runsChecked;
}

/**
 * How long a node may sit refused by memory admission, with demand elsewhere
 * in the fleet, before `checkStarvation` calls it STARVED rather than a
 * transient dip.
 *
 * 2 HOURS. Far longer than any transient memory pressure this fleet has
 * actually measured — a pytest basetemp or a `node-compile-cache` filling
 * tmpfs builds up over days and clears only on a cleanup or a reboot, not
 * over minutes — and short enough to catch a lost claw the SAME DAY an
 * operator could act on it. claw-6 and claw-2 sat refused by memory for
 * DAYS before anything said so (wave 4a, #100): this threshold is picked to
 * have caught both within one working day, not tuned from a distribution
 * (there isn't one — the whole point is this had never been measured before
 * this wave). Same shape of judgment call as `LOWER_BOUND_HEADROOM`'s own
 * note in `ephemeral.ts`.
 */
export const STARVED_NO_JOB_MS = 2 * 60 * 60 * 1000;

/**
 * The epoch ms each node most recently STARTED a job, from job history —
 * never the end time `idleSecondsByNode` (`job-history.ts`) reads, because
 * `checkStarvation` needs to know when a node's own idle window BEGAN, not
 * how long its last job ran. A node absent from the map has no job in the
 * retained window at all, which `checkStarvation` reads as "idle forever",
 * never as "just started".
 */
function lastStartedAtMsByNode(nodes: readonly string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const r of jobRecords()) {
		const node = nodeOf(r.runner, nodes);
		const t = Date.parse(r.startedAt);
		if (!Number.isFinite(t)) continue;
		const prev = out.get(node);
		if (prev === undefined || t > prev) out.set(node, t);
	}
	return out;
}

/**
 * A claw refused by memory admission for hours, while the rest of the fleet
 * served work, is a FINDING — wave 4a, #100: claw-6 and claw-2 sat refused by
 * the memory clause on every tick for days, and the only places that could
 * have said so (`admitMint`'s own per-run log line, and `admissionFree`,
 * which never applies the memory clause at all — see its doc comment)
 * reported `mintable` the whole time.
 *
 * STARVED requires all three, every tick:
 *
 *   (a) the LATEST verdict (`ephemeral-tick.ts`'s `admissionVerdictsForReport`)
 *       is a MEMORY or SPACE refusal (#101: a node out of `/tmp`/`_work`
 *       space is as starved as one out of memory) — never `concurrency` (a
 *       busy node is working, not starved) or `drained` (an operator's own
 *       decision) or `other`.
 *       This is also how a slow-tier node held by the #83 spill gate is
 *       excluded for free: that hold is a PLACEMENT refusal in
 *       `placement.ts`'s `refusalFor`, after `admitMint` already said `ok`,
 *       so the generic verdict here never sees it.
 *   (b) that node's LAST STARTED JOB (job history, persisted — survives a
 *       restart) is older than {@link STARVED_NO_JOB_MS}.
 *   (c) EVIDENCE OF DEMAND: some OTHER node started a job since this node's
 *       idle window began, or the queue is non-empty right now. An idle
 *       fleet is never a finding — a node with nothing to do is not starved
 *       by refusing to do it.
 *
 * `admitMint` ITSELF excludes drained nodes and hokon from ever reaching here
 * refused-on-memory in the first place: a guest never appears in
 * `admissionVerdictsForReport` at all (`withoutGuests`, `ephemeral-tick.ts`),
 * and a drained node's verdict clause is `'drained'`, not `'memory'`.
 *
 * AN ABSENT VERDICT IS "COULD NOT LOOK", NEVER "ADMITTED". Right after a
 * restart, `ephemeral-tick.ts`'s verdict snapshot is empty until its own
 * first tick lands — which, on its 15s dispatch cadence, is almost always
 * well inside this function's own 10-minute one. For a node this map simply
 * has no entry for, this tick neither sets nor clears `starved[node]`: the
 * PREVIOUS tick's reading (from `lastSnapshot.starved`, itself restorable
 * from disk — see `RunnerHealthSnapshot`) carries forward untouched, and the
 * alert ledger is left alone rather than cleared. That is also the shape
 * that makes "a restart finds the starvation from history alone" true: the
 * moment the first post-restart verdict records a memory refusal, (b) and
 * (c) are answered from PERSISTED job history, which a restart never resets
 * — there is no fresh-module-state clock to wait out.
 *
 * THE ALERT CLEARS ONLY WHEN A JOB ACTUALLY STARTED, never merely because
 * admission flipped back to `ok` (or to a non-memory clause) for one tick.
 * claw-6 measured 2026-10-06 04:00Z sits AT the admission line — 6,370 MB
 * available against a 5,632 MB reserve — and flips between admitted and
 * memory-refused from one tick to the next with no job ever landing. Clearing
 * on every `ok` tick re-armed `RE_ALERT_MS`'s dedupe on each flip, so a node
 * that is still, in every sense that matters, starved would re-page every
 * ~10 minutes instead of at most hourly. `starved[node]` still flips to
 * `false` the instant the clause stops being `memory` — the PANEL must not
 * keep showing a stale finding — but the LEDGER (`clearAlert`) is only
 * touched when {@link lastStartedAtMsByNode} shows a job genuinely started
 * within {@link STARVED_NO_JOB_MS}, which is the one fact that means the
 * starvation actually ended rather than admission merely sitting on a
 * boundary.
 */
async function checkStarvation(data: TickReport): Promise<void> {
	const nowMs = Date.now();
	const nodeNames = loadFleetNodeNames();
	const lastStarted = lastStartedAtMsByNode(nodeNames);
	const verdicts = admissionVerdictsForReport();
	const queuedNow = data.queued_now ?? 0;
	const prevStarved = lastSnapshot?.starved ?? {};
	const starved: Record<string, boolean> = {};

	for (const node of loadEphemeralNodes()) {
		const verdict = verdicts.get(node);
		if (verdict === undefined) {
			// COULD NOT LOOK — see this function's own docblock. Carry the last
			// known reading forward; do not touch the alert ledger either way.
			starved[node] = prevStarved[node] ?? false;
			continue;
		}
		const last = lastStarted.get(node);
		const idleMs = last === undefined ? Infinity : nowMs - last;
		// THE STARVATION GENUINELY ENDED: a job actually started, however the
		// CURRENT verdict reads. Checked FIRST and ahead of the clause check,
		// so a job landing clears the ledger regardless of what admission says
		// about the NEXT one. This is the only branch allowed to clearAlert.
		if (idleMs < STARVED_NO_JOB_MS) {
			starved[node] = false;
			clearAlert(`starved:${node}`);
			continue;
		}
		// #101: SPACE is a starvation clause too — a node refused for want of
		// `/tmp` or `~/.hadoku/jit` free space is exactly as idle-while-others-
		// work as one refused for want of memory, and the same silent-for-days
		// failure (#100) applies to either resource.
		if (verdict.ok || (verdict.clause !== 'memory' && verdict.clause !== 'space')) {
			// Admitted (or refused for a clause this finding does not watch)
			// this tick, but no job has actually started — do NOT clear. See
			// this function's own "alert clears only when a job started" note:
			// a node sitting at the admission line flips `ok` for single ticks
			// with nothing ever running, and clearing here would re-arm the
			// page for each flip.
			starved[node] = false;
			continue;
		}
		// EVIDENCE OF DEMAND: another node started a job since this one went
		// idle, or the queue is non-empty right now. `windowStartMs` is where
		// this node's OWN idle window began — never-started falls back to the
		// threshold window, which is the most conservative window available.
		const windowStartMs = last ?? nowMs - STARVED_NO_JOB_MS;
		const othersActive = [...lastStarted].some(([n, t]) => n !== node && t >= windowStartMs);
		if (!othersActive && queuedNow <= 0) {
			// Idle fleet. Not a finding — see (c) above. Still no job ran, so
			// the ledger (if armed) stays armed — same "only a real job clears
			// it" rule as the `ok`/non-memory branch above.
			starved[node] = false;
			continue;
		}
		starved[node] = true;
		const idleH = (idleMs / 3_600_000).toFixed(1);
		const lastJobAt =
			last === undefined ? 'never (no job in the retained window)' : new Date(last).toISOString();
		// NAMES THE REPORTER, NOT THE NODE'S LOCATION (#101 send-back): the
		// original wording — "starved on hokon: claw-6 …" — reads as claw-6
		// LIVING on hokon, which is false; hokon is only where this check runs.
		// `clauseWord`/`clauseDetail` also say WHICH resource refused: MEMORY
		// (free MB vs. this check's reserve) or SPACE (free MB vs. the floor
		// on whichever filesystem `verdict.filesystem` names), never a bare
		// "admission" that leaves the reader to re-derive it from the raw
		// `reason` string.
		const clauseWord = verdict.clause === 'space' ? 'SPACE' : 'MEMORY';
		const spaceFsName =
			verdict.clause === 'space' && verdict.filesystem === 'tmp' ? '/tmp' : '_work';
		const clauseDetail =
			verdict.clause === 'space'
				? verdict.unreadable
					? `could not read free space on ${spaceFsName}`
					: `${verdict.availableMb}MB free on ${spaceFsName}, under this check's ${verdict.needMb}MB floor`
				: `${verdict.availableMb}MB free, this check reserves ${verdict.needMb}MB ` +
					`(basis: ${verdict.reserveBasis})`;
		await alertOnce(
			`starved:${node}`,
			`🥀 **starved** (reported by \`${selfHostname()}\`): \`${node}\` has been refused by ` +
				`${clauseWord} admission for ${idleH}h (no job started since ${lastJobAt}) while other ` +
				`claws kept working — ${clauseDetail}: ${verdict.reason}`
		);
	}
	data.starved = starved;
}

/**
 * An early warning on the `_work` filesystem — wave 4c §F, the operator's disk
 * ask (2026-10-07). `disk-watch.ts` holds the pure judgement
 * ({@link judgeWorkDisk}) and the per-tick reading registry
 * ({@link diskReadingsForReport}, filled by the `ephemeral-tick.ts` hunk this
 * lane lands after A); this function is the READER, same split
 * `checkStarvation` already uses against `admissionVerdictsForReport`.
 *
 * AN ABSENT READING IS "COULD NOT LOOK YET", NEVER "FINE" — same rule as
 * `checkStarvation`'s own docblock, for the same reason: right after a
 * restart, or before the `ephemeral-tick.ts` hunk has run its first tick, the
 * registry is empty. For a node this tick has no reading for, the PREVIOUS
 * tick's level carries forward untouched and the alert ledger is left alone.
 *
 * HOKON NEVER APPEARS HERE — `loadEphemeralNodes()` is the same set
 * `checkStarvation` walks, and hokon is never in it (`ephemeral: true` is
 * never set on a guest; `ephemeral-tick.ts`'s `withoutGuests` enforces it a
 * second time on the producing side). `disk-watch.ts`'s own header has the
 * full chain.
 *
 * ALERTING: `'page'` and `'advisory'` each page through `alertOnce` on their
 * OWN key, so a node already paging at `'page'` still gets a fresh notice the
 * moment it recovers to `'advisory'` (a transition, not a re-statement of the
 * same finding) — and `alertOnce`'s own RE_ALERT_MS window is what keeps
 * either from re-firing every ~10-minute tick while the level does not change.
 * `'unreadable'` is its OWN finding (CLAUDE.md: "could not look" must never
 * render as "nothing is wrong"), on its own key, so a node that stops
 * reporting free space at all is never silently read as whatever level it last
 * held. Every alert key clears the moment the node is no longer in that state,
 * so the NEXT crossing (in either direction) alerts immediately rather than
 * sitting inside the previous state's dedupe window.
 */
async function checkDiskWatch(data: TickReport): Promise<void> {
	const readings = diskReadingsForReport();
	const prevDiskWatch = lastSnapshot?.diskWatch ?? {};
	const diskWatch: Record<string, DiskWatchLevel> = {};
	// Through the restoring getter: right after a restart `lastSnapshot` is null
	// until this tick captures, and the capacity fact must not be said again.
	const prevTmpSmall = getRunnerHealthSnapshot()?.tmpSmall ?? {};
	const tmpSmall: Record<string, number> = {};

	// Every node the dispatcher mints on: the ephemeral claws AND the
	// manifest's on-demand guests (#120). hokon's /tmp refused every mint there
	// on 2026-10-20/21, deploys included, and nothing here was watching it.
	const machines = backstopMachinesReader();
	const onDemand = Object.entries(machines ?? {})
		.filter(([, m]) => mintsOnDemand(m as MintBearingNode))
		.map(([n]) => n);
	for (const node of new Set([...loadEphemeralNodes(), ...onDemand])) {
		const reading = readings.get(node);
		if (reading === undefined) {
			// COULD NOT LOOK — see this function's own docblock. Carry the last
			// known reading forward; do not touch the alert ledger either way.
			diskWatch[node] = prevDiskWatch[node] ?? 'ok';
			if (prevTmpSmall[node] !== undefined) tmpSmall[node] = prevTmpSmall[node];
			continue;
		}
		// /tmp FIRST (2026-10-21): judged against the mint floor it is about to
		// hit, its own alert keys, and folded into the node's one snapshot level
		// as the worse of the two. On a guest the page says what the refusal
		// costs, because there it is not CI that stops.
		//
		// #132: judged against the tmpfs's own SIZE. An 8 GB claw's ~3.9 GB /tmp
		// sat under the absolute advisory line while empty and re-pinged hourly;
		// that is a property of the box, said once below, not a leak.
		const tmpSizeMb = reading.tmpSizeMb ?? null;
		if (tmpSizeMb !== null && tmpIsSmall(tmpSizeMb)) {
			tmpSmall[node] = tmpSizeMb;
			if (prevTmpSmall[node] === undefined) {
				await postDiscordSink(
					`ℹ️ **disk** (reported by \`${selfHostname()}\`): \`${node}\`'s /tmp is a ` +
						`${Math.round((tmpSizeMb / 1024) * 10) / 10}GB filesystem — less than one mint floor ` +
						`(${TMP_FREE_FLOOR_MB}MB) of runway above the floor even when empty. A capacity fact, ` +
						`said once: its advisory line sits at ${tmpAdvisoryLineMb(tmpSizeMb)}MB free instead.`,
					'runner-health'
				);
			}
		}
		const tmp = judgeTmpDisk(reading.tmpFreeMb, tmpSizeMb);
		if (tmp.level !== 'page') clearAlert(`diskwatch:tmp:page:${node}`);
		if (tmp.level !== 'advisory') clearAlert(`diskwatch:tmp:advisory:${node}`);
		if (tmp.level === 'advisory') {
			await alertOnce(
				`diskwatch:tmp:advisory:${node}`,
				`⚠️ **disk** (reported by \`${selfHostname()}\`): \`${node}\`'s /tmp has ${tmp.freeGb}GB free — ` +
					`within ${tmpAdvisoryLineMb(tmpSizeMb) - TMP_FREE_FLOOR_MB}MB of the ` +
					`${TMP_FREE_FLOOR_MB}MB floor under which the dispatcher refuses to mint there. ` +
					'Leaked temp dirs are the usual cause (`find /tmp -maxdepth 1 -mmin +60`).'
			);
		} else if (tmp.level === 'page') {
			const cost = onDemand.includes(node)
				? ' On this node that includes the pm2-host deploys nothing else can run.'
				: '';
			await alertOnce(
				`diskwatch:tmp:page:${node}`,
				`🔥 **disk** (reported by \`${selfHostname()}\`): \`${node}\`'s /tmp has ${tmp.freeGb}GB free — ` +
					`${TMP_WATCH_PAGE_MARGIN_MB}MB from the ${TMP_FREE_FLOOR_MB}MB mint floor, under which the ` +
					`dispatcher refuses EVERY mint there, forced or not.${cost} Free /tmp now.`
			);
		}

		const verdict = judgeWorkDisk(reading.workFreeMb);
		diskWatch[node] = worseDiskLevel(verdict.level, tmp.level);

		if (verdict.level !== 'unreadable') clearAlert(`diskwatch:unreadable:${node}`);
		if (verdict.level === 'unreadable') {
			await alertOnce(
				`diskwatch:unreadable:${node}`,
				`🥀 **disk** (reported by \`${selfHostname()}\`): \`${node}\`'s _work filesystem free ` +
					`space could not be read this tick — "I could not look" is not "fine".`
			);
			continue;
		}
		if (verdict.level === 'ok') {
			clearAlert(`diskwatch:advisory:${node}`);
			clearAlert(`diskwatch:page:${node}`);
			continue;
		}
		if (verdict.level === 'advisory') {
			clearAlert(`diskwatch:page:${node}`);
			await alertOnce(
				`diskwatch:advisory:${node}`,
				`⚠️ **disk** (reported by \`${selfHostname()}\`): \`${node}\`'s _work filesystem has ` +
					`${verdict.freeGb}GB free — under the ${DISK_WATCH_ADVISORY_FREE_GB}GB advisory line. ` +
					`Not urgent; plan a cleanup before it crosses the ${DISK_WATCH_PAGE_FREE_GB}GB page line.`
			);
			continue;
		}
		// 'page'
		await alertOnce(
			`diskwatch:page:${node}`,
			`🔥 **disk** (reported by \`${selfHostname()}\`): \`${node}\`'s _work filesystem has ` +
				`${verdict.freeGb}GB free — under the ${DISK_WATCH_PAGE_FREE_GB}GB page line. Admission's ` +
				`own floor is 2GB; this is the warning before that refusal, not after it.`
		);
	}
	data.diskWatch = diskWatch;
	data.tmp_small = tmpSmall;
}

/**
 * Wave 4e §B (#102) — a node that fails PROVEN work loses the label. The
 * detection, the "real product red" exclusion and the injected stale-mark
 * all live in `runners/node-regression.ts`; this is that module's one
 * reader, same split `checkStarvation` uses against `admissionVerdictsForReport`
 * and `checkDiskWatch` against `diskReadingsForReport`.
 *
 * The operator, 2026-10-07: "this is exactly the thing that bootcamping a
 * claw should catch. if they are not suitable to handle a job, then we
 * should have seen that coming before we allowed them to earn that tag."
 * This is the automatic half of that: claw-3 failed five full cardtable
 * `forge-e2e` jobs while every one passed elsewhere within the hour, and a
 * human had to notice, diagnose and manually evict it — see
 * `node-regression.ts`'s own header for why 5 divergences in a 1-hour window
 * is the exact bar that incident cleared.
 *
 * PAGES ONCE, same mechanism as `checkStarvation`/`checkDiskWatch`:
 * `alertOnce` keyed per `node`+`capability`, which re-arms only after
 * `RE_ALERT_MS` or a genuine crossing. A node/kind pair that no longer meets
 * the threshold has its key cleared so the NEXT crossing — in either
 * direction — alerts immediately rather than sitting inside the previous
 * dedupe window. That "no longer meets the threshold" case covers two
 * genuinely different reasons, both handled inside `node-regression.ts`
 * (`filterDivergencesByFreshProof`), not here: its divergences aged out of
 * the 14-day retention, OR the node's `$proof` is no longer a fresh PASS —
 * either because THIS check already marked it stale (so the same divergence
 * set cannot re-trigger `markStale` on the next tick, which is also what
 * stops this from rewriting the facet every ~10 minutes forever), or because
 * the tracker re-proved the node after the divergences, in which case only
 * divergences dated AFTER that fresh proof count against it — a node is
 * never pinned by its own pre-proof history for the rest of the 14 days.
 *
 * HOKON NEVER APPEARS HERE — `loadEphemeralNodes()` is passed as
 * `watchedNodes`, the same set `checkStarvation`/`checkDiskWatch` already
 * walk, and `node-regression.ts`'s own fold refuses to charge any node
 * outside it.
 */
async function checkNodeRegression(): Promise<void> {
	const nodes = loadFleetNodeNames();
	const watched = [...loadEphemeralNodes()];
	const gatedKinds = defaultGatedKinds();
	const applied = checkNodeRegressions(jobRecords(), nodes, watched);
	const activeKeys = new Set(applied.map((a) => `${a.node}\u0000${a.capability}`));
	for (const node of watched) {
		for (const kind of gatedKinds) {
			if (!activeKeys.has(`${node}\u0000${kind.capability}`)) {
				clearAlert(`regression:${node}:${kind.capability}`);
			}
		}
	}
	for (const a of applied) {
		const staleNote = a.result.ok
			? 'its $proof is marked STALE — the label is withdrawn'
			: `its $proof could NOT be marked stale (${a.result.reason}): ${a.result.why}`;
		await alertOnce(
			`regression:${a.node}:${a.capability}`,
			`🥀 **regression** (reported by \`${selfHostname()}\`): \`${a.node}\` failed ` +
				`${a.divergenceCount} \`${a.capability}\` run(s) that passed on another claw at the ` +
				`same commit within the hour — ${staleNote}. Runs: ${a.runIds.join(', ')}.`
		);
	}
}

/**
 * Host-side supervision — the one check GitHub structurally cannot answer.
 *
 * Fail-soft by design: an unreachable claw is reported, never counted as
 * healthy, and never fails the tick.
 */
async function checkHostSupervision(data: TickReport): Promise<void> {
	// --- node-side supervision, which the GitHub API structurally cannot see ---
	//
	// Everything above asks GitHub which runners are ONLINE, and GitHub answers
	// about the listener process. A listener that has escaped its systemd unit
	// therefore reports perfectly healthy while nothing will ever restart it —
	// which is how nine orphaned runners across three claws went unnoticed for
	// three days in August 2026. Fail-soft: an unreachable claw is reported, not
	// counted as healthy, and never fails the tick.
	try {
		const sup = supervisionCheck ? await supervisionCheck() : null;
		if (sup) {
			data.supervision_problems = sup.problems.length;
			data.supervision_listeners = sup.listenersSeen;
			if (sup.unreachable.length) data.supervision_unreachable = sup.unreachable;
			logReport(sup);
			for (const p of sup.problems) {
				// Keyed by node+dir+kind so each broken runner pings on its own
				// hourly schedule — a whole claw going wrong must not collapse into
				// one alert that looks like a single runner.
				await alertOnce(
					`supervision:${p.node}:${p.dir}:${p.kind}`,
					`🩺 **runner supervision** on \`${selfHostname()}\`: ${describeProblem(p)}`
				);
			}
		}
	} catch (err) {
		logger.warn(
			`[runner-health] supervision probe failed: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

/** The tick currently running, so a test can wait for one it did not call. */
let inFlightTick: Promise<void> | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Did the last tick read the fleet as UNMEASURED (no fast-loop probe snapshot
 * yet)? `null` until a tick has run. Set where the census is read, so the
 * re-tick below asks the same fact the backstop acted on.
 */
let lastTickEphemeralUnknown: boolean | null = null;
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
		void runTick(token).finally(() => {
			if (lastTickEphemeralUnknown === true && attempt < REMEASURE_MAX_ATTEMPTS) {
				scheduleRemeasure(token, attempt + 1);
			}
		});
	}, remeasureDelayMs);
	remeasureHandle.unref?.();
}

function runTick(token: string): Promise<void> {
	// CI-red alerting rides this cadence but runs INDEPENDENTLY of the tick.
	// Two separate concerns sharing a timer: a GitHub blackout or a thrown error
	// in either must not take the other down, and ci-alerts must not be able to
	// delay runner mint/failover decisions by sitting in the same await chain.
	void withGhCaller('ci-alerts', () => runCiAlerts(token, ghGet)).catch((err) =>
		logger.warn(`[ci-alerts] pass failed: ${err instanceof Error ? err.message : String(err)}`)
	);
	inFlightTick = withGhCaller('runner-health', () => tick(token))
		.catch((err) =>
			logger.warn(
				`[runner-health] tick failed: ${err instanceof Error ? err.message : String(err)}`
			)
		)
		.finally(() => {
			inFlightTick = null;
		});
	return inFlightTick;
}

/** Resolves once the tick in flight (if any) has finished. Test-only seam. */
export function __awaitInFlightTickForTesting(): Promise<void> {
	return inFlightTick ?? Promise.resolve();
}

/** Undo `startRunnerHealthMonitor` so a suite can start it again. Test-only seam. */
export function __stopRunnerHealthMonitorForTesting(): void {
	if (intervalHandle) clearInterval(intervalHandle);
	intervalHandle = null;
	if (remeasureHandle) clearTimeout(remeasureHandle);
	remeasureHandle = null;
	lastTickEphemeralUnknown = null;
	started = false;
}

/**
 * One-shot at startup: log what the token can do, so failover readiness is
 * visible in the logs without waiting for a real outage. Reads the granted
 * classic-PAT scopes from the `X-OAuth-Scopes` response header (empty for a
 * fine-grained PAT — that case can only be confirmed by an actual write).
 */
async function logTokenCapabilities(token: string): Promise<void> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const resp = await fetch(ghUrl(SELF_REPO, '/actions/runs?per_page=1'), {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': userAgent('runner-health'),
			},
			signal: controller.signal,
		});
		clearTimeout(timeoutId);
		recordGhResponse(token, resp.status, resp.headers);
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
	} catch (err) {
		clearTimeout(timeoutId);
		logger.warn(
			`[runner-health] token capability probe failed: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

export function startRunnerHealthMonitor(): void {
	if (started) return;
	started = true;

	// Injected, not read from the environment: the host owns credential
	// resolution, and this package is consumed in-process by a service that
	// already resolves it through the vault broker.
	const token = (githubToken() ?? '').trim();
	if (!token) {
		logger.info('[runner-health] no GitHub token from host — monitor disabled');
		return;
	}
	// The host's token is HADOKU_SITE_TOKEN (see AGENTS.md "Secrets"); naming it
	// is what lets a low-budget page say which credential it is about.
	labelGhToken(token, 'HADOKU_SITE_TOKEN');

	// Only the real process SSHes the claws — see `supervisionCheck`. A test that
	// starts the monitor installs its double first, and this keeps it.
	supervisionCheck ??= checkSupervision;

	// The first tick goes out NOW, on this turn. It waited 30s here until
	// 2026-09-01, commented "let the server settle" — but nothing in a tick
	// depends on the server: the token probe, the label floor, the runs sweep and
	// the supervision probe all work at t=0. What the delay actually did was keep
	// every runner-health field on the Fleet tab null for 30s after each of the
	// day's ten mgmt-api restarts, on top of the tick's own duration.
	withGhCaller('runner-health', () => logTokenCapabilities(token)).catch(() => undefined);
	// …and if that first tick could not measure the fleet, a second one once the
	// fast loop's probe has landed — see `scheduleRemeasure`.
	void runTick(token).finally(() => {
		if (lastTickEphemeralUnknown === true) scheduleRemeasure(token);
	});
	intervalHandle = setInterval(() => void runTick(token), TICK_INTERVAL_MS);
	logger.info(
		`[runner-health] monitor started (every ${TICK_INTERVAL_MS / 60000}m), supervision probe on`
	);
}
