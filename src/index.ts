/**
 * `@wolffm/fleet-manager` — the public surface.
 *
 * The host installs its ports and paths once; everything else is the component
 * exactly as it ran inside mgmt-api. The ceremonial `gh` parameter the fast
 * loop takes is hidden here rather than removed: `tickFleet` keeps it as a
 * genuine test seam, but no CONSUMER should ever have to hand this package its
 * own GitHub client.
 */
import type { Router } from 'express';
import { installHost, type FleetHost } from './host.js';
import {
	ghGetConditional,
	ghGet,
	ghWrite,
	startRunnerHealthMonitor,
	getRunnerHealthSnapshot,
} from './runner-health.js';
import { startFastLoop } from './fleet-loop.js';
import { router as fleetRouter } from './routes/fleet.js';
import type { RunnerHealthSnapshot } from './runner-health.js';
import { startClawReboot } from './claw-reboot.js';
import { startProvisioningConverge } from './provisioning-converge.js';

export type { FleetHost, FleetHostLogger } from './host.js';
export type { RunnerHealthSnapshot } from './runner-health.js';
export type { Reservation } from './node-reservation.js';

// The GET /fleet response contract. The command station imports these instead
// of hand-maintaining a second copy of the same shape — see fleet-report-types.ts.
//
// Re-exported WHOLESALE, not name by name. The named list let `ClawState` be
// added to the contract, shipped in the payload, and typed in the route while
// remaining invisible to the one consumer the file exists for — which is the
// same drift fleet-report-types.ts was written to end, just moved one file
// along. Every type in that module is contract by construction; there is
// nothing in it a consumer should not see.
export type * from './fleet-report-types.js';

// mgmt-api's cron dispatch reports into the same reservation this component
// reads, so these two stay part of the public surface. With `meterGhPool`
// below they are the ONLY inbound calls: everything else here is an output port.
export { noteCronStart, noteCronEnd, inFlightCronJobs } from './node-reservation.js';

/** mgmt-api wraps each cron dispatch in this, so the GitHub budget's books can
 *  name what a cron spent outside this process (fleet-manager#9). */
export { meterGhPool } from './gh-budget.js';
export type { GhPoolReading } from './gh-budget.js';

/** The GitHub client the component already owns. Exported so a host that needs
 *  one does not build a second — it has no non-fleet consumers today. */
export { ghGet, ghWrite } from './runner-health.js';

/**
 * THE BACKSTOP DECISION, as a pure library. hokon is the emergency backstop
 * for cardtable's Forge matches with the CI backstop's rules (operator,
 * 2026-10-25; hadoku-cardtable FLEET_MANAGER_FORGE_HOSTING.md §6), and
 * cardtable calls these with its own inputs rather than copying them — so a
 * rule changed here reaches both backstops in one publish. Pure functions and
 * constants only: the force record's file I/O (`readForce`/`writeForce`)
 * stays inside, because it is THIS fleet's state, not a rule.
 */
export {
	BACKLOG_QUEUE_SECONDS,
	BACKSTOP_CALM_TICKS,
	BACKSTOP_IDLE_MAX_LOAD_PER_CORE,
	BACKSTOP_IDLE_MIN_AVAILABLE_MB,
	SATURATION_QUEUE_SECONDS,
	clawsAreHealthy,
	decideBackstop,
	describeSaturationHost,
	explainBackstop,
	hostMayTakeSaturation,
	isAtCapacity,
	isHostIdle,
} from './runners/backstop.js';
export type {
	BackstopDecision,
	BackstopInput,
	BackstopState,
	SaturationHostVerdict,
} from './runners/backstop.js';
export {
	FORCE_DEFAULT_MINUTES,
	FORCE_MAX_MINUTES,
	activeForces,
	describeForce,
	forceRecord,
	isForced,
	parseForceMinutes,
	pruneForce,
} from './runners/backstop-force.js';
export type { ForceRecord, ForceState } from './runners/backstop-force.js';
/** The /tmp floor the idle gate's caller applies beside `isHostIdle`. */
export { TMP_FREE_FLOOR_MB } from './runners/ephemeral.js';

export interface FleetManager {
	/** Mount at `/api`. Serves `GET /fleet`. Works whether or not `start()` was
	 *  ever called — a passive host (`host.controller === false`) still serves
	 *  `GET /fleet` from whatever `snapshot()` returns. */
	readonly router: Router;
	/**
	 * Starts both loops — runner-health (10 min) and the fast loop — UNLESS
	 * `host.controller === false`, in which case it starts neither and logs one
	 * line saying so. See `FleetHost.controller` in host.ts.
	 */
	start(): void;
	/**
	 * The last runner-health tick, or `null` if none has ever completed.
	 *
	 * On a passive host (`controller: false`) this is ALWAYS `null`: `start()`
	 * never calls `startRunnerHealthMonitor()`, so no tick ever runs and no
	 * snapshot is ever recorded — never "the last known state", because there
	 * is no state to know. The router still returns it, so `GET /fleet` on a
	 * passive host is a well-formed response reporting nothing rather than a
	 * missing route.
	 */
	snapshot(): RunnerHealthSnapshot | null;
}

let constructed = false;

/**
 * Install the host and build the manager.
 *
 * THROWS ON A SECOND CALL. This component holds ~16 module-level mutable
 * singletons (`started`, `tickCount`, `sickNodes`, `offlineTicks`,
 * `labelZeroTicks`, `lastAlertAt`, `hostedRepos`, `failoverReran`,
 * `converged`, …). A handle-returning factory reads as multi-instance; it is
 * not, and two would silently share every one of them.
 *
 * It also throws if any required path is missing — see host.ts for why that
 * check is the load-bearing part of this whole extraction.
 */
export function createFleetManager(host: FleetHost): FleetManager {
	if (constructed) {
		throw new Error(
			'@wolffm/fleet-manager: already constructed. This is a singleton — its modules ' +
				'hold mutable state that two instances would share.'
		);
	}
	installHost(host);
	constructed = true;

	// `getConditional` carries the ETag path. It is a THIRD member rather than a
	// change to `get`, because most callers want a body or null and should not
	// have to think about 304 — only the dispatcher's 26-repo-per-tick listing is
	// hot enough to be worth caching, and it is the one that exhausted the budget.
	const gh = { get: ghGet, write: ghWrite, getConditional: ghGetConditional };

	return {
		router: fleetRouter,
		start() {
			// `controller === false` is the ONLY passive case — omitted and `true`
			// both start both loops, which is today's behaviour and must stay the
			// default so an existing consumer (mgmt-api) that never sets this field
			// is unaffected. Gated HERE, at the call site, rather than inside
			// fleet-loop.ts / runner-health.ts: those modules stay ignorant of the
			// controller concept, which is the smallest change that can't regress
			// their own already-singleton `started` guards.
			if (host.controller === false) {
				host.logger.info(
					'[fleet-manager] controller=false — passive host, no loop started ' +
						'(router and snapshot() still serve whatever state already exists)'
				);
				return;
			}
			startRunnerHealthMonitor();
			// The fast loop (probe, repair, labels, dispatch) runs on its own
			// timers: runner-health ticks every 10 minutes, which is fine for
			// outage detection and far too slow to keep a queue short.
			startFastLoop(() => host.githubToken(), gh);
			// Standing-runner throttle env and slice placement (#1): repaired here
			// on idle units, paged only when a repair does not converge.
			startProvisioningConverge();
			// Staged kernels on the claws: one at a time, drained, verified, undrained.
			startClawReboot();
		},
		snapshot: () => getRunnerHealthSnapshot(),
	};
}

/** Test seam. Not part of the supported API. */
export function __resetFleetManagerForTesting(): void {
	constructed = false;
}
