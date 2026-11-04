/**
 * `@wolffm/fleet-manager` — the public surface.
 *
 * The host installs its ports and paths once; everything else is the component
 * exactly as it ran inside mgmt-api. The ceremonial `gh` parameter the fast
 * loop takes is hidden here rather than removed: `tickFleet` keeps it as a
 * genuine test seam, but no CONSUMER should ever have to hand this package its
 * own GitHub client.
 */
import { installHost, type FleetHost } from './host.js';
import { ghGetConditional, ghGet, ghWrite } from './lib/github-client.js';
import { startRunnerHealthMonitor, __stopRunnerHealthMonitorForTesting } from './runner-health.js';
import { getRunnerHealthSnapshot } from './runner-health-snapshot.js';
import { startFastLoop, __resetFleetLoopForTesting } from './fleet-loop.js';
import { router as fleetRouter } from './routes/fleet.js';
import { startClawReboot, __stopClawRebootForTesting } from './claw-reboot.js';
import { startBackstopTools, __stopBackstopToolsForTesting } from './backstop-tools.js';
import { startHostingConverge, __stopHostingConvergeForTesting } from './hosting-converge.js';
import { startHostingVerify, __stopHostingVerifyForTesting } from './hosting-verify.js';
import {
	startProvisioningConverge,
	__stopProvisioningConvergeForTesting,
} from './provisioning-converge.js';
import { startCapacitySampling, __stopCapacitySamplingForTesting } from './capacity-sample.js';
import { startPerfSampling, __stopPerfSamplingForTesting } from './perf-sample.js';
// runner-health (observation) calls the backstop decision and the hosted
// fallback (both ci-scheduling) through a port it does not own the import
// side of (rule 5, §3.2; see `runner-health-ports.ts`'s header). THIS file
// is composition — it may import either domain — so it is the one place
// that wires the real functions in, once, before any tick can run.
import {
	runBackstopDecision,
	__resetBackstopDecisionForTesting,
} from './runners/backstop-decision.js';
import { runHostedFallback, __resetHostedFallbackForTesting } from './runners/hosted-fallback.js';
import {
	setBackstopDecisionRunner,
	setHostedFallbackRunner,
	setBackstopDecisionReset,
	setHostedFallbackReset,
} from './runner-health-ports.js';
import { startPpeSweep, __stopPpeSweepForTesting } from './ppe-sweep.js';

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
export { noteCronStart, noteCronEnd } from './node-reservation.js';

/** mgmt-api wraps each cron dispatch in this, so the GitHub budget's books can
 *  name what a cron spent outside this process (fleet-manager#9). */
export { meterGhPool } from './gh-budget.js';
export type { GhPoolReading } from './gh-budget.js';

/** The job schedule declaration (wave 5e). mgmt-api's in-process staleness watcher feature-detects this — an installed copy from before 2026-10-31 will not have it. */
export { JOB_REGISTRY, cadencePeriodMs, parseDurationMs } from './lib/job-registry.js';

/**
 * Whether the fleet's own control loops are still ticking — dispatch, the
 * fast loop, runner-health, and every scheduled converger/claw-reboot. The
 * host's `/api/status` folds this in so the off-box heartbeat (wave 5e lane
 * C, `docs/planning/wave5e-2026-10-31.md`) can alarm on a silently stopped
 * loop, which a process-liveness probe alone cannot see. Additive: an older
 * consumer that does not call this sees nothing missing, because it was
 * never calling it before.
 */
export { getFleetLiveness } from './lib/liveness.js';
export type { FleetLiveness, LoopLiveness } from './lib/liveness.js';

/**
 * Whether a claw can serve a hosted tenant now, and whether hokon steps in
 * (operator, 2026-11-04: fleet-manager decides). `fleet node-status --json`
 * publishes the same verdicts as `backstops[]`; the app layer's lease follower
 * imports these to read its own node-status document the same way.
 */
export { judgeTenantBackstop, tenantUsableOn } from './lib/tenant-usable.js';
export type {
	TenantBackstop,
	TenantUsable,
	UsableNodeRow,
	UsableSlice,
	UsableVerdict,
} from './lib/tenant-usable.js';

/**
 * THE BACKSTOP DECISION's TYPES, as a pure contract. hokon is the emergency
 * backstop for cardtable's Forge matches with the CI backstop's rules
 * (operator, 2026-10-25; hadoku-cardtable FLEET_MANAGER_FORGE_HOSTING.md
 * §6) — the plan was for cardtable to call this package's backstop
 * functions with its own inputs rather than copy them, but cardtable does
 * not depend on `@wolffm/fleet-manager` (it only runs the `fleet` CLI), so
 * it ended up with its own parallel `BackstopState`/`BackstopInput`
 * (`hadoku-cardtable/apps/server/src/play/placement/rules.ts`) instead. The
 * functions and constants these types went with (`decideBackstop`,
 * `isHostIdle`, `BACKLOG_QUEUE_SECONDS`, the force-record helpers,
 * `TMP_FREE_FLOOR_MB`, …) had no consumer anywhere and were removed in wave
 * cruft-1 (fleet-manager, 2026-11-02). These type-only exports remain in
 * case something still structurally needs the shape.
 */
export type {
	BackstopDecision,
	BackstopInput,
	BackstopState,
	SaturationHostVerdict,
} from './runners/backstop.js';
export type { ForceRecord, ForceState } from './runners/backstop-force.js';

/**
 * Moved to `server.ts` (wave clean-1 lane C, cut (iii)): that is the one
 * other file that needs it typed, and composition importing surfaces is the
 * legal direction (not the reverse). Re-exported here under its original
 * path for every existing importer.
 */
import type { FleetManager } from './server.js';
export type { FleetManager } from './server.js';

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

	// Wire runner-health's ci-scheduling ports (see `runner-health-ports.ts`'s
	// header) — once, before `start()` can ever begin a tick. `createFleetManager`
	// is itself guarded as a singleton (see this function's own doc), so this
	// runs exactly once per process, same as `installHost` just above.
	setBackstopDecisionRunner(runBackstopDecision);
	setHostedFallbackRunner(runHostedFallback);
	setBackstopDecisionReset(__resetBackstopDecisionForTesting);
	setHostedFallbackReset(__resetHostedFallbackForTesting);

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
			// Hosted tenants' slices, to each tenant's demand (#16). Acts only for
			// placement.auto tenants; plans for the rest.
			startHostingConverge();
			// Every hosted tenant's home, re-asserted when it drifted (#31).
			startHostingVerify();
			// Every node's latency, link, disk, pressure and temperature, every 5 minutes.
			startPerfSampling();
			// The backstop's hand-installed yt-dlp and deno: a reminder, at most monthly (#34).
			startBackstopTools();
			// T4 (refactor plan §7.3): one admission-state row per node, every 5
			// minutes, read entirely from state the loops above already hold.
			startCapacitySampling();
			// ppe promotion's one timer: wakes a repo's promoter once its ppe has
			// gone quiet inside the 30-minute window, which no GitHub event signals.
			startPpeSweep();
		},
		snapshot: () => getRunnerHealthSnapshot(),
	};
}

/**
 * Test seam. Not part of the supported API.
 *
 * Undoes a `createFleetManager()` AND everything its `start()` started: one stop
 * per `start*()` call above, in the same order, so a test that starts the real
 * loops leaves no timer behind. The list lives here, beside `start()`, because a
 * teardown kept in a test file drifted: it stopped seven of the nine loops, and
 * the capacity sampler and the ppe sweep kept their timers for the rest of the
 * test process. Every stop is safe when its loop never started.
 */
export function __resetFleetManagerForTesting(): void {
	__stopRunnerHealthMonitorForTesting();
	__resetFleetLoopForTesting();
	__stopProvisioningConvergeForTesting();
	__stopClawRebootForTesting();
	__stopHostingConvergeForTesting();
	__stopHostingVerifyForTesting();
	__stopBackstopToolsForTesting();
	__stopCapacitySamplingForTesting();
	__stopPerfSamplingForTesting();
	__stopPpeSweepForTesting();
	constructed = false;
}
