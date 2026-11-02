/**
 * Per-NODE offline alerting — the "fleet is DEGRADED, floor still met" half
 * of `checkLabelFloor`, independent of the per-label floor alerting in
 * `runner-health-label-floor-alerts.ts`. Split out of
 * `runner-health-label-floor.ts` (wave shrink-1 lane C).
 */
import { recordAlertQuietly } from './host.js';
import { nodeOf } from './runners/census.js';
import { clearAlert, pagedAlerts } from './lib/alert-ledger.js';
import { TICK_INTERVAL_MS, OFFLINE_TICKS_BEFORE_ALERT } from './lib/runner-health-shared.js';
import { selfHostname } from './lib/runner-health-shared.js';
import type { GhRunner } from './lib/github-client.js';
import type { ClawState } from './lib/fleet-vocabulary.js';

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
 * Indirection purely so tests can SEE the ledger-only path.
 *
 * A quiet record makes no fetch, so the stubbed-fetch harness these tests use
 * cannot observe it — and a test that only asserted "nothing was posted to
 * Discord" would keep passing if the condition stopped being DETECTED at all,
 * which is the failure that matters. This lets them assert the record instead
 * of its absence.
 */
export let quietRecorder: (content: string, source: string) => void = recordAlertQuietly;

/** Test-only seam. */
export function __setQuietRecorderForTesting(
	fn: ((content: string, source: string) => void) | null
): void {
	quietRecorder = fn ?? recordAlertQuietly;
}

/**
 * Per-node offline alerting (fleet DEGRADED, floor still met).
 *
 * The label-floor check only fires at ZERO online. With claw-1 and claw-2 up,
 * claw-3 sat dead for a full day and nothing ever said so — found by hand on
 * 2026-08-15, Tailscale reporting "last seen 1d ago". The first node to die is
 * the one worth hearing about; by the time the floor breaks, CI is already
 * stopped.
 *
 * Suppressed to hourly by alertOnce while it stays down, cleared the moment
 * it returns, and skipped entirely during a FULL outage — that pages twice
 * already (backstop promote + label floor), and a third message per dead
 * node for one root cause is noise the operator learns to skip.
 *
 * `floorAlreadyBreached` is checked separately from the floor because the
 * backstop PROMOTES hokon to hadoku-builder in that case, which repairs the
 * floor in this same tick — so the floor alone reads healthy during exactly
 * the outage this needs to stay quiet for.
 */
export function runOfflineNodeAlerts(
	runners: readonly GhRunner[],
	fleetNodes: readonly string[],
	ephemeral: ReadonlySet<string>,
	clawState: Record<string, ClawState>,
	floorAlreadyBreached: boolean,
	onlineNames: string
): void {
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
		const wait = OFFLINE_REPEAT_BACKOFF_MS[Math.min(repeats, OFFLINE_REPEAT_BACKOFF_MS.length - 1)];
		const last = pagedAlerts[key] ? Date.parse(pagedAlerts[key]) : 0;
		if (repeats > 0 && Date.now() - last < wait) continue;

		const mins = Math.round((seen * TICK_INTERVAL_MS) / 60000);
		const downFor = mins >= 120 ? `${Math.round(mins / 60)}h` : `${mins} min`;
		const instances = e.names.length > 1 ? ` (${e.names.join(', ')})` : '';
		// Bypasses alertOnce deliberately: that helper is a fixed hourly window,
		// and this condition needs the escalating ladder instead.
		pagedAlerts[key] = new Date().toISOString();
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
}

/** Test seam: cross-tick memory this module owns. */
export function __resetOfflineNodeAlertsForTesting(): void {
	offlineTicks.clear();
	offlineRepeats.clear();
	quietRecorder = recordAlertQuietly;
}
