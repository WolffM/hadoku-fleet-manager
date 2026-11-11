/**
 * `refusalFor` — wave 5s lane A split of `placement.ts` (pure move), so that
 * file falls under the 800-line source ceiling.
 *
 * The per-node gate `choosePlacement`'s walk asks of every candidate, in
 * order — see `placement.ts` for the ranking that walks candidates past this
 * gate. `refusalFor` was not exported from `placement.ts` and still is not;
 * it is exported here only so `choosePlacement` can reach it across the
 * module boundary. `SpillContext` is re-exported from `placement.ts` so its
 * existing importers compile unchanged.
 */
import { admitMint } from './ephemeral-admission.js';
import type { NodeState } from './placement-node-state.js';
import { satisfiesLabels } from './placement-node-state.js';
import {
	BACKSTOP_SOLE_CARRIER_SLOTS,
	HEAVY_DOUBLE_HOLD_SEC,
	HEAVY_HOLD_SEC,
	SPILL_FLOOR_SEC,
	describeKind,
	slowKind,
} from './placement-slow.js';

/**
 * Context about the QUEUED JOB the spill gate (#83) needs, beyond `repo` and
 * `wantedLabels` — kept as its own object rather than two more positional
 * parameters because both are specific to that one gate, unlike `repo`, which
 * the affinity term also reads.
 */
export interface SpillContext {
	/**
	 * Seconds the current attempt has been queued, per {@link queuedSinceMs}
	 * (`queue-discovery.ts`) — computed by the CALLER, which holds `nowMs`;
	 * this file stays clockless. `undefined` when the run's timestamps could
	 * not be read, and that must NEVER be treated as "has waited long enough" —
	 * see the gate below, which refuses whenever this is `undefined`.
	 */
	queuedSec?: number;
	/** The queued JOB's own name, for `SpeedModel.expectedExtraSec`'s (repo,
	 *  job) lookup. `undefined` falls back to that function's own (repo), then
	 *  node-ratio, fallback order — never an error. */
	jobName?: string;
}

/**
 * Every per-node refusal in the walk, in order, or `reason: null` for "take
 * it" — alongside the reserve admission actually checked, for a caller that
 * must decrement the SAME number out of its own working copy (#77;
 * {@link Placement.requiredMb}).
 */
export function refusalFor(
	m: NodeState,
	wantedLabels: readonly string[],
	repo?: string,
	spill?: SpillContext,
	heavy = false,
	/** Some other, non-backstop node offers this job's labels (#15). */
	overflow = false
): {
	reason: string | null;
	requiredMb?: number;
	/**
	 * Set on a refusal that TIME alone lifts: the job's queued age, in seconds,
	 * at which this node stops holding it. The dispatcher's probe backoff (#117)
	 * reads it so a hold that is about to release is re-asked at that moment,
	 * not two minutes later. Absent on every refusal a clock cannot change.
	 */
	holdSec?: number;
} {
	if (!m.healthy) return { reason: 'unhealthy or quarantined' };
	if (!m.eligible) return { reason: 'repo excluded here' };
	// PER-REPO EXCLUSION (#82). `m.eligible` above is node-wide and nothing sets
	// it `false` today — this is the manifest's actual `excludeRepos` answer,
	// keyed on the repo THIS job belongs to. `undefined` `repo`, an `undefined`
	// map, or a map with no entry for this repo all fall straight through —
	// every caller before this wave, and every node with no `excludeRepos`.
	const excludedReason = repo ? m.excludedRepos?.get(repo) : undefined;
	if (excludedReason !== undefined) return { reason: `repo excluded here: ${excludedReason}` };
	if (wantedLabels.length && !satisfiesLabels(m.labels ?? [], wantedLabels)) {
		return { reason: `does not carry ${wantedLabels.join(', ')}` };
	}
	// `admitMint` refuses `drained` first, ahead of capacity and memory: an
	// operator saying "nothing lands here" outranks every job-shaped argument.
	//
	// THE QUEUED JOB'S OWN REPO FLOOR, ONLY WHEN ONE IS PROVEN (#76, scoped
	// 2026-10-02). `requiredMbByRepo` is SUPPOSED to hold an entry only for a
	// repo whose own reserve is `lowerBound: true` — the builder
	// (`dispatchEphemeral`) filters on exactly that before it ever inserts one.
	// `own.lowerBound` is checked AGAIN here anyway: this function must not
	// trust a map it did not build to already honour the one rule that makes
	// the override safe, the same reason `admitMint`'s own placement clause
	// re-checks `requiredIsLowerBound` rather than trusting a caller's
	// `requiredMb` at face value. An ORDINARY repo's own figure — above or
	// below the node's — is never consulted, so every repo with no entry, or a
	// `false` one, takes `m` unchanged — bit-for-bit today's walk. And even for
	// a repo that clears the check, the override is `max(m.requiredMb, own.mb)`,
	// never `own.mb` alone: a floor PROVEN on another node (or this one, at a
	// smaller cap) can only RAISE what this node reserves, never shrink it
	// below what every other job already reserves here today.
	const own = repo ? m.requiredMbByRepo?.get(repo) : undefined;
	// `undefined` unless the lower-bound clause actually raises the number —
	// the SAME condition that builds the override below, so this can never
	// disagree with what `admitMint` was actually asked about.
	const requiredMb = own?.lowerBound ? Math.max(m.requiredMb, own.mb) : undefined;
	const admit = admitMint(
		requiredMb !== undefined ? { ...m, requiredMb, requiredIsLowerBound: true } : m
	);
	if (!admit.ok) return { reason: admit.reason ?? 'refused' };

	// THE BACKSTOP'S SOLE-CARRIER RESERVE (#15) — see BACKSTOP_SOLE_CARRIER_SLOTS.
	// After admission, so a backstop that is plainly full still says so.
	if (m.onDemandBackstop && overflow && m.maxConcurrent > BACKSTOP_SOLE_CARRIER_SLOTS) {
		const reserved = `reserved for work only ${m.name} can run`;
		const inFlight = m.liveUnits + m.standingBusy;
		const overflowSlots = m.maxConcurrent - BACKSTOP_SOLE_CARRIER_SLOTS;
		if (inFlight >= overflowSlots) {
			return {
				reason:
					`${reserved}: overflow may hold ${overflowSlots} of ${m.maxConcurrent} slot(s), ` +
					`${inFlight} in flight, and another node offers this job's labels`,
			};
		}
		const after =
			m.freeMb - (requiredMb ?? m.requiredMb) - m.requiredMb * BACKSTOP_SOLE_CARRIER_SLOTS;
		if (after < m.minFreeMb) {
			return {
				reason:
					`${reserved}: memory: ${m.freeMb}MB free, this job peaks at ` +
					`${requiredMb ?? m.requiredMb}MB and ${m.requiredMb}MB stays free for one more, ` +
					`would leave ${after}MB against a ${m.minFreeMb}MB floor`,
			};
		}
	}

	// THE HEAVY HOLD (#102) — see HEAVY_DOUBLE_HOLD_SEC (a node running one
	// heavy job) and HEAVY_HOLD_SEC (two or more). Exact counts only
	// (`heavyJobs`, never the repo-level `runningHeavy`), and an unknown queue
	// age holds, the same rule the spill gate below states for itself.
	// `m.tuning` is the simulator's override (NodeState.tuning); live dispatch
	// never sets it, so these are the constants.
	const heavyHere = m.heavyJobs ?? 0;
	const heavyFree = m.tuning?.heavyFree ?? 1;
	if (heavy && heavyHere >= heavyFree) {
		const holdSec =
			heavyHere === heavyFree
				? (m.tuning?.doubleHoldSec ?? HEAVY_DOUBLE_HOLD_SEC)
				: (m.tuning?.holdSec ?? HEAVY_HOLD_SEC);
		const queuedSec = spill?.queuedSec;
		if (queuedSec === undefined || queuedSec < holdSec) {
			const waited = queuedSec === undefined ? 'unknown' : `${Math.round(queuedSec)}s`;
			return {
				reason:
					`heavy hold: already running ${heavyHere} heavy job(s) ` +
					`(queued ${waited} < ${holdSec}s)`,
				holdSec,
			};
		}
	}

	// THE SLOW-TIER SPILL GATE (#83). Checked LAST, after capacity, so a slow
	// node that is also just plain full still refuses on capacity — the
	// refusal a caller would otherwise expect — rather than on a wait that
	// would be moot anyway. `'normal'` and `'unknown'` are UNAFFECTED: the
	// operator's rule ("if the best claws are already working... queueing to
	// the bottom of the barrel becomes worth it under heavy load") only ever
	// holds back the nodes measured slow, and a brand-new node with no history
	// is `'unknown'`, which places like `'normal'` so it can EARN history
	// rather than being judged on none (§B.3/§A.4 of the wave brief).
	if (m.speedModel?.tierOf(m.name) === 'slow') {
		// `expectedExtraSec` needs `repo`; without one there is nothing to look
		// up and the floor-times-ratio fallback below applies, exactly as it
		// does when the lookup itself returns `null`.
		const extraSec =
			repo !== undefined ? m.speedModel.expectedExtraSec(m.name, repo, spill?.jobName) : null;
		const { p25, p50 } = m.speedModel.describe(m.name);
		// NOT ZERO when there is nothing to estimate from (§A.4): a null extra
		// falls back to the floor scaled by this node's own overall ratio
		// (`describe().p50`), so a node measured only mildly slow overall does
		// not inherit the SAME floor as one measured catastrophically slow on
		// everything. `p50 ?? 1` is the "nothing to scale by either" case —
		// `tierOf` returning 'slow' already implies MIN_KINDS qualifying ratios
		// exist (speed-tier.ts), so this is defensive, not an expected path.
		const floorSec = m.tuning?.spillFloorSec ?? SPILL_FLOOR_SEC;
		const thresholdSec = extraSec !== null ? Math.max(floorSec, extraSec) : floorSec * (p50 ?? 1);
		const queuedSec = spill?.queuedSec;
		// `undefined` is NEVER "waited long enough" — a run whose queue age
		// could not be established must never spill, which is why this is a
		// strict `<` against a defined number rather than `queuedSec < threshold`
		// alone (that would coerce `undefined < x` to `false`, i.e. "not held
		// back", by accident rather than by this being asserted explicitly).
		if (queuedSec === undefined || queuedSec < thresholdSec) {
			const waited = queuedSec === undefined ? 'unknown' : `${Math.round(queuedSec)}s`;
			return {
				reason:
					`slow tier: holding for a faster node (queued ${waited} < ${Math.round(thresholdSec)}s; ` +
					`${m.name} p25 ${p25 ?? 'null'})`,
				holdSec: thresholdSec,
			};
		}
	}

	// THE PER-KIND HOLD (#8). Same shape as the slow tier above, keyed on this
	// exact job: hold until the job has waited as long as running here would
	// cost it, then spill. A slow-tier node already held above.
	const kind =
		repo !== undefined && spill?.jobName !== undefined
			? slowKind(m.speedModel, m.name, repo, spill.jobName)
			: null;
	if (kind) {
		const queuedSec = spill?.queuedSec;
		if (queuedSec === undefined || queuedSec < kind.extraSec) {
			const waited = queuedSec === undefined ? 'unknown' : `${Math.round(queuedSec)}s`;
			return {
				reason:
					`slow kind: holding for a faster node (queued ${waited} < ${Math.round(kind.extraSec)}s; ` +
					`${describeKind(kind)})`,
				holdSec: kind.extraSec,
			};
		}
	}
	return { reason: null, requiredMb };
}
