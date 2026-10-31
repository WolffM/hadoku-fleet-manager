import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger, stateDir } from './host.js';
import { TICK_INTERVAL_MS } from './lib/runner-health-shared.js';
import type { BackstopReason, ClawState } from './lib/fleet-vocabulary.js';
import type { LabelFloorVerdict } from './label-floor.js';
import type { DiskWatchLevel } from './runners/disk-watch.js';

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

export let lastSnapshot: RunnerHealthSnapshot | null = null;

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
export type TickReport = {
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

export function captureSnapshot(
	data: TickReport,
	runnersChecked: boolean,
	runsChecked: boolean
): void {
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

/** Test seam: cross-tick memory this module owns. */
export function __resetSnapshotForTesting(): void {
	lastSnapshot = null;
	snapshotRestoreTried = false;
}
