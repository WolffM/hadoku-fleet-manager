/**
 * OBSERVES EACH EPHEMERAL NODE'S WARM-CACHE ELIGIBILITY AND CURRENT SLOT —
 * one `free -m`/`df` probe, the warm marker, and GitHub's registration, per
 * node, read once per tick. Split out of `dispatch-warm-cache.ts` (wave
 * shrink-1 lane B, 800-line ceiling): everything here is a READ; the
 * eviction/mint decisions that follow live back in that file and in
 * `dispatch-warm-cache-classify.ts`/`dispatch-warm-cache-act.ts`.
 */
import { logger } from '../host.js';
import { sharedMbOn, type HostingDoc } from './hosting-record.js';
import { warmListenerSlots } from './ephemeral.js';
import { unitMemoryMaxMb, jobReserve } from '../lib/job-reserve.js';
import { warmCacheEligible } from '../lib/warm-eligibility.js';
import { readWarmMarkerState, refreshWarmMarker, warmRegistration } from './ephemeral-exec.js';
import { type GhLike } from '../lib/fleet-vocabulary.js';
import { reapDeadWarmListener } from './dispatch-warm-cache-state.js';
import {
	shellOnNode,
	SPACE_PROBE_DF_CMD,
	parseSpaceProbe,
	type EphemeralTickInput,
} from './ephemeral-shared.js';
import type {
	ObservedWarmNode,
	ObservedWarmSlot,
	WarmCacheResult,
} from './dispatch-warm-cache-state.js';

/**
 * One node's installed memory, warm-cache eligibility, and current slot (if
 * any), or `null` for a node that is unreachable or ineligible this tick.
 * NEVER THROWS: caught per node, same reason the act loop (elsewhere) is.
 *
 * See each field's own comment in `dispatch-warm-cache.ts`'s history for
 * the full reasoning (issue #7, #101, #61, #17) — moved here verbatim.
 */
export async function observeWarmNode(
	node: string,
	input: EphemeralTickInput,
	hostingDoc: HostingDoc,
	token: string,
	gh: GhLike & { get: (path: string, token: string, repo?: string) => Promise<unknown> },
	sh: typeof shellOnNode,
	nowMs: number,
	result: WarmCacheResult,
	/** Set for a node whose slot is confirmed ONLINE — see the comment below. */
	observedWarm: Map<string, string>
): Promise<ObservedWarmNode | null> {
	try {
		const m = input.nodes[node];
		const p = input.fleetProbe.get(node);
		if (!m || !p?.reachable) return null;

		// issue #7 clause (b), the eligibility half: MEASURED installed
		// capacity, never `mintBudget`'s job-concurrency cap AS THE MEMORY
		// FIGURE — see warmEligibleSlots for why feeding it maxConcurrent
		// was the bug that put a warm listener on claw-2's single
		// 4GB-class slot. The cap is a SECOND, independent condition
		// (`warmConcurrencySlots`, folded into `warmListenerSlots` below),
		// not a substitute for the first: one asks whether the box has the
		// memory, the other whether its ceiling has the slot.
		// Read live, the same shape of call dispatchEphemeral already makes
		// for available memory, just the TOTAL column instead of the
		// available one — this is INSTALLED capacity, which does not move
		// tick to tick, but the manifest's ramGb is display-only and must
		// never be gated on (fleet-runner-manifest.json's own
		// $why-display-only note).
		const totalOut = await sh(node, "free -m | awk '/^Mem:/{print $2}'; " + SPACE_PROBE_DF_CMD);
		const { first, tmpFreeMb, workFreeMb } = parseSpaceProbe(totalOut);
		// A SHARED HOSTING SLICE is not CI's to count on: installed memory
		// includes it, so the whole declaration comes off what a listener
		// may plan around (src/runners/hosting-record.ts).
		const hostedMb = sharedMbOn(hostingDoc, node);
		const installedMb = Number(first);
		if (!Number.isFinite(installedMb) || installedMb <= 0) {
			logger.warn(`[warm-cache] ${node}: could not read installed memory — not eligible this tick`);
			return null;
		}
		// #101: this pass's OWN measurement — see `ObservedWarmNode`'s
		// docblock for why the pre-pass below must not borrow
		// `dispatchEphemeral`'s verdict instead.
		const minFreeMb = m.minFreeMb ?? 1536;
		// THE SAME CALL dispatchEphemeral makes to decide how many slots of
		// this node's cap to hold BACK for the listener this may place —
		// same `usableMb`, same `jobMb`, same tick. See warmListenerSlots:
		// if the two ever disagreed, the node would carry a listener nobody
		// reserved for, which is the 48 four-concurrent starts on claw-3.
		const slots = warmListenerSlots({
			usableMb: installedMb - minFreeMb - hostedMb,
			role: m.role,
			maxConcurrent: m.maxConcurrent,
			// A MINT's worth — the same figure admission reserves below for a
			// job whose repo it cannot name.
			jobMb: jobReserve({
				nodeJobP95Mb: m.jobP95Mb,
				capMb: unitMemoryMaxMb({
					requestedMb: m.slice?.unitMaxMb,
					sliceCeilingMb: installedMb - minFreeMb,
				}),
			}).mb,
		});
		if (!warmCacheEligible(slots)) return null;

		const markerState = await readWarmMarkerState(node, sh);
		const marker = markerState.kind === 'marker' ? markerState.marker : null;
		// POSITIVELY no listener: the node said there is no marker, or systemd
		// said the marker's unit is not active. An unreadable answer is neither.
		const slotEmpty = markerState.kind === 'none' || (marker !== null && marker.active === false);
		// #61. A marker whose unit systemd positively reports dead is a
		// registration this tick is about to walk away from: the planner
		// below sees `current: null` and FILLS, and the fill's `RESET=1`
		// overwrites the marker with a different repo. Deleting it here —
		// before the plan, so the act pass cannot mint over the evidence —
		// is the only place in the fleet that holds the dead repo's name.
		if (marker?.active === false) {
			if (await reapDeadWarmListener(node, marker.repo, marker.unit, token, gh, sh)) {
				result.reaped++;
			}
		}
		const slot = marker?.active === true ? marker : null;
		let current: ObservedWarmSlot | null = null;
		if (slot) {
			const reg = await warmRegistration(slot.repo, slot.unit, token, gh);
			const busy = reg ? reg.busy : null;
			if (busy) await refreshWarmMarker(node, sh);
			// P5.1'S PLACEMENT INPUT, AND THE ONLY SOURCE IT IS ALLOWED TO
			// HAVE. Three independent facts must agree before this node is
			// preferred for this repo: the marker names it (the node's own
			// record), systemd reports the unit ACTIVE (`currentWarmSlot` —
			// the kernel, not our bookkeeping), and GitHub's listing reports
			// the registration ONLINE. Issue #17 is precisely the case where
			// the first holds and the third does not.
			//
			// NOT SET BY THE FILL OR ROTATE BELOW, deliberately. A mint that
			// has just returned has not appeared in GitHub's listing yet, and
			// recording it here would be this file believing its own write —
			// the exact failure it exists to guard against. The next tick's
			// listing confirms it 60 s later, which costs at most four
			// dispatch cycles of missed affinity and cannot manufacture a
			// false one.
			if (reg?.online) observedWarm.set(node, slot.repo);
			current = {
				repo: slot.repo,
				// `null` (could not confirm) fails toward LOCKED — the same
				// direction every other "I could not look" in this workstream
				// takes. A slot we cannot vouch for is not safe to evict.
				busy: busy ?? true,
				mintedOrRefreshedAtMs: busy ? nowMs : slot.markerAtMs,
				// `null` here (reg unreadable) must NOT be read as "carries no
				// gated label" — the workload-gate rotate check below treats a
				// null the same way it treats `null` busy: cannot vouch for it,
				// so it must not churn the slot on a guess.
				labels: reg ? reg.labels : null,
			};
		}

		return { node, m, installedMb, current, slotEmpty, tmpFreeMb, workFreeMb };
	} catch (err) {
		result.failed++;
		logger.warn(`[warm-cache] ${node}: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}
