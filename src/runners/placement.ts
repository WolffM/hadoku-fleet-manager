/**
 * Where a job should be minted, and whether it may be minted at all.
 *
 * B8 (never mint for a fork) from docs/planning/fleet-rearchitecture-2026-08-25.md. Pure, for the same reason as
 * ephemeral.ts: these are decisions, and decisions can be asserted without
 * touching a node.
 *
 * Wave 5s lane A (800-line ceiling) split this file by concern into
 * `placement-fork-safety.ts` (B8), `placement-node-state.ts` (`NodeState`
 * and the capability check), `placement-slow.ts` (the slow-tier/per-kind
 * spill thresholds) and `placement-refusal.ts` (`refusalFor`, the per-node
 * gate `choosePlacement`'s walk below calls). Every moved name is
 * re-exported here so existing importers compile unchanged; `choosePlacement`
 * itself, its signature unchanged, stays in this file.
 */
import type { NodeState } from './placement-node-state.js';
import { satisfiesLabels } from './placement-node-state.js';
import { refusalFor, type SpillContext } from './placement-refusal.js';

export interface Placement {
	node?: string;
	/** Why each node ahead of the chosen one was passed over. Kept because a
	 * dispatcher that silently picks the last candidate looks identical to one
	 * that is broken, and "why did this land there" is the question that gets
	 * asked. */
	passed: { node: string; reason: string; holdSec?: number }[];
	/** Why there is no node. Set only when `node` is not. */
	reason?: string;
	/**
	 * Was the chosen node preferred BECAUSE of warm affinity, rather than
	 * because it was already first among the survivors?
	 *
	 * Not a decision by itself — a caller averaging this over many placements
	 * is how "how often is a warm claw actually the reason a job landed where
	 * it did" gets answered with a number instead of an adjective (P5.3).
	 * `false` (never `undefined`) whenever a node was chosen without `repo`
	 * being supplied, or without that node carrying affinity for it, so a
	 * caller can sum this field directly without a null check.
	 */
	viaAffinity: boolean;
	/**
	 * The reserve admission ACTUALLY USED to decide this placement, when it
	 * differs from the chosen node's flat `requiredMb` (#77).
	 *
	 * Set only by the SAME clause in {@link refusalFor} that raises what
	 * `admitMint` checks for a proven lower-bound reserve
	 * (`NodeState.requiredMbByRepo`, #76): `Math.max(node.requiredMb, own.mb)`.
	 * `undefined` for every ordinary repo — no entry, or an entry with
	 * `lowerBound: false` — which is every call site before #76 and every
	 * repo without a proven floor today.
	 *
	 * `planTick` decrements the chosen node's `freeMb` by
	 * `placed.requiredMb ?? chosen.requiredMb` specifically so an ordinary
	 * repo consumes exactly what it always has (bit-for-bit today's
	 * arithmetic) and only a lower-bound reserve changes what one mint takes
	 * out of the SAME tick's remaining capacity. Before this field existed,
	 * `planTick` decremented by the node's flat `requiredMb` regardless of
	 * what `admitMint` actually admitted against, so a lower-bound repo's
	 * mint freed up less headroom than it had just been proven to need —
	 * wave 3t lane C's two-jobs-one-tick overfill.
	 */
	requiredMb?: number;
	/**
	 * Was the QUEUED JOB ITSELF classified heavy (#102) — from whichever
	 * node's {@link NodeState.heavyModel} this walk found (the same shared
	 * object on every node this tick), keyed on (`repo`, `spill?.jobName`).
	 *
	 * SURFACED here rather than left for the caller to re-derive, because
	 * `planTick` needs it to raise the CHOSEN node's `runningHeavy` for the
	 * rest of the tick, and re-deriving it there would be a SECOND classifier
	 * that could disagree with this one — the same "ONE ranking function, not
	 * two" rule #102.2 states for the busy/affinity walk itself.
	 *
	 * `false` whenever `repo` is omitted or no node carries a `heavyModel` —
	 * every caller before this wave sees no change from this field existing.
	 */
	heavy: boolean;
	/**
	 * Every node in the order this walk asked it — the re-ranked placeable
	 * nodes, then the unschedulable, then names not in the fleet. Nodes after
	 * the winner were never asked. For the decision log; placement reads none
	 * of it.
	 */
	walk?: string[];
	/** The node right behind the winner in the walk, and the first term that
	 *  ranked the winner ahead of it. Absent when nothing stood behind it. */
	rankedOver?: { node: string; key: WalkKey };
}

/**
 * The terms of the placement walk's ranking, in the order they are compared
 * (see {@link choosePlacement}). `baseline-order` is the tick's own
 * `orderCandidates` position — speed, idle time, schedulability, name.
 */
export type WalkKey = 'heavy-jobs' | 'busy' | 'running-heavy' | 'warm-affinity' | 'baseline-order';

/** This node's running jobs — standing registrations GitHub assigned directly,
 *  plus live (minted, not yet finished) units — see `traffic.ts`'s
 *  `TrafficNode.busy` for the ordering concept this mirrors. Computed fresh
 *  every call rather than cached on the node, because `planTick` mutates
 *  `standingBusy`/`liveUnits` on this SAME object between placements within
 *  one tick (#102.2) — a cached value here would go stale after the first
 *  placement.
 *
 * EXPORTED so `planTick` (dispatcher.ts) can read the SAME number it just
 * ranked on, for the dispatch log's `placed=node@busy` report (#102.4) —
 * never a second formula that could silently drift from the one the walk
 * actually used. */
export function busyOf(m: NodeState): number {
	return m.standingBusy + m.liveUnits + (m.warmBusy ?? 0);
}

/**
 * Pick a node, re-ranking `order` (the tick's once-per-pass baseline from
 * `orderCandidates`: speed/idle/schedulability/name) against the fleet's
 * CURRENT load, then taking the first survivor with no refusal.
 *
 * ONE RANKING FUNCTION, NOT TWO (#102.2). Before this wave, `order` was
 * walked exactly as given except for one unconditional reorder: every node
 * carrying a verified-live listener for `repo` was stable-sorted to the
 * FRONT, regardless of how busy it already was — the 05:29:43Z tick that
 * logged `via-affinity=2 affinity-moved=2` while claw-9 stacked three
 * cardtable Forge jobs. That was two ranking engines (the baseline order,
 * then a second affinity-only reorder on top of it) which could — and did —
 * disagree about whether load mattered more than a warm cache. This function
 * is the single replacement: for the ONE job being placed, `walkOrder` below
 * sorts the candidates by
 *
 *   0. for a job that IS heavy: fewest heavy jobs already running
 *      ({@link NodeState.heavyJobs}) — and a node with any is refused
 *      outright until {@link HEAVY_HOLD_SEC};
 *   1. busy — THIS node's running jobs plus live units ({@link busyOf}),
 *      read off the SAME `NodeState` objects `planTick` mutates between
 *      placements (#102.2), so a burst of jobs in one tick sees each other's
 *      placements, not a tick-stale snapshot;
 *   2. for a job NOT itself heavy (#102.4): a node already running a
 *      heavy-kind job sorts after one that is not — "a light job ranks a
 *      node running a heavy job last";
 *   3. warm affinity for `repo` (P5.1) — now correctly a TIE-BREAK among
 *      nodes equal on (1) and (2), never an override of either;
 *   4. the position `order` already gave two nodes neither of the above can
 *      tell apart — so this NEVER disagrees with the tick's own baseline
 *      ranking, only refines it within the tick as placements happen.
 *
 * Everything that must NOT be used at all — unhealthy, quarantined, excluded,
 * missing a label, drained, full, unschedulable — is still a REFUSAL below,
 * not a rank, because a rank can always be out-voted by a heuristic. A
 * per-node ceiling (thermal or otherwise) is the node's `maxConcurrent`,
 * which `admitMint` enforces.
 *
 * There used to be a `demoted` refusal fed by the tier ladder, plus a second
 * walk re-admitting demoted nodes for labels only they carried (issue #35).
 * Nothing in production ever set `demoted`, so both were tested code that could
 * not fire; they went with the ladder on 2026-09-21.
 *
 * `repo` ALSO SELECTS A PER-NODE MEMORY FIGURE, not only the affinity/heavy
 * terms (#76): `refusalFor` reads `NodeState.requiredMbByRepo` for it before
 * calling `admitMint`, so the SAME `repo` this function already took for warm
 * affinity is what lets a job whose own measured runs were all capped (a
 * lower bound, never the whole truth) refuse a node whose slice cannot be
 * shown to hold it — see {@link AdmissionInput.requiredIsLowerBound} and the
 * PLACEMENT clause in `admitMint` for the mechanism. A caller that never
 * populates the map, or never supplies `repo`, sees today's walk unchanged.
 *
 * "A `repo` the caller never supplied" WAS EVERY DISPATCH THIS FLEET MADE for
 * the first five days warm affinity existed. The term is not a no-op any
 * more; see the `repo` parameter's own note for what now supplies it and what
 * keeps it supplied.
 */
export function choosePlacement(
	order: readonly string[],
	nodes: readonly NodeState[],
	/**
	 * Labels the queued JOB asked for.
	 *
	 * Minting a runner that cannot match them spawns a listener nothing will ever
	 * schedule onto — `QueuedRun.labels` has carried a comment saying exactly that
	 * since the field was written, and nothing read it. On 2026-08-29 claw-3
	 * minted for a tenhands job wanting `pm2-host, taskauto`, which it does not
	 * and cannot carry.
	 */
	wantedLabels: readonly string[] = [],
	/**
	 * The queued JOB's repo.
	 *
	 * **SUPPLIED BY THE LIVE MINT PATH SINCE 2026-09-15.** `dispatcher.ts`'s
	 * `planTick` passes `run.repo`, and `ephemeral-tick.ts` supplies the
	 * matching `NodeState.warmRepo` off GitHub's runner listing. Until then it
	 * was supplied by NOTHING, and the whole affinity term below was dead code
	 * in production for five days and ~2,000 jobs while the tracker recorded it
	 * as "landed unmeasured" — `warm-affinity-measured-2026-09-14.md` §3
	 * falsified that in source and in the deployed 0.22.108.
	 *
	 * An OPTIONAL parameter is a feature that can ship switched off without
	 * anything going red, so what guards it is a test of the CALL SITE and not
	 * the type: `placement.test.ts`'s "the live mint path supplies the queued
	 * run's repo" fails if this argument is dropped again.
	 *
	 * Still optional, because omitting it is still SAFE rather than merely
	 * tolerated: the affinity/heavy terms below then treat every node as
	 * equal, so a caller with no repo in hand gets today's walk bit for bit.
	 */
	repo?: string,
	/**
	 * The slow-tier spill gate's (#83) per-run inputs — see {@link SpillContext}.
	 * Omitted entirely by a caller with nothing to offer: `refusalFor` then
	 * never sees a `queuedSec`, which is the same "never spill" path an
	 * explicit `undefined` takes, so a caller unaware of this parameter gets
	 * today's walk bit for bit. `spill.jobName` doubles as the heavy-kind
	 * classifier's exact-match key (#102) — the same field `expectedExtraSec`
	 * already reads, not a second one.
	 */
	spill?: SpillContext
): Placement {
	const byName = new Map(nodes.map((m) => [m.name, m]));

	// THE HEAVY MODEL (#102), shared by reference across every node this tick
	// built — the SAME pattern as `speedModel`. `undefined` when no node
	// carries one (every caller before this wave): `heavy` stays `false`,
	// which is the safe default documented on {@link Placement.heavy}.
	const heavyModel = nodes.find((n) => n.heavyModel)?.heavyModel;
	const heavy = repo !== undefined && heavyModel ? heavyModel.isHeavy(repo, spill?.jobName) : false;

	// UNSCHEDULABLE NODES NEVER WIN A RE-RANK, same rule and same reason as
	// `orderCandidates`'s own split (traffic.ts): "fewest busy" alone would
	// rank a node with zero WORKING registrations first — it looks perfectly
	// idle. Split OFF before the comparator runs, not folded into it, so busy/
	// heavy/affinity can never promote one past a placeable node.
	const known = order.filter((n) => byName.has(n));
	const unknown = order.filter((n) => !byName.has(n));
	const placeable = known.filter((n) => byName.get(n)?.schedulable !== false);
	const unplaceable = known.filter((n) => byName.get(n)?.schedulable === false);

	// THE POSITION `order` ALREADY GAVE EACH NODE — the final tie-break below,
	// and the thing that makes this a REFINEMENT of the tick's baseline
	// ranking rather than a second one that can disagree with it (#102.2's
	// own "ONE ranking function" rule). Two nodes busy/heavy/affinity cannot
	// tell apart keep exactly the relative order `orderCandidates` already
	// gave them upstream.
	const posOf = new Map(order.map((n, i) => [n, i]));

	// THE COMPARATOR, NAMED so the walk and the decision log (`decision-log.ts`)
	// read ONE ranking function: the sort takes `diff`, the log takes `key` — the
	// first term that told two nodes apart. Same terms, same order, same signs
	// as the inline comparator this replaced.
	const compareWalk = (x: NodeState, y: NodeState): { key: WalkKey; diff: number } => {
		// 1. Fewest jobs in flight — THIS is the fix for "busy counted distinct
		//    repos, not jobs" (#102.1): `busyOf` reads the actual running+live
		//    count, and it is read fresh here, after whatever `planTick` has
		//    already mutated onto these SAME objects this tick (#102.2).
		// 0. A heavy job takes the node running the FEWEST heavy jobs first
		//    (#102): once HEAVY_HOLD_SEC expires and every node has one, two
		//    light jobs are still a better neighbour than one Forge shard.
		if (heavy) {
			const xh = x.heavyJobs ?? 0;
			const yh = y.heavyJobs ?? 0;
			if (xh !== yh) return { key: 'heavy-jobs', diff: xh - yh };
		}
		const xb = busyOf(x);
		const yb = busyOf(y);
		if (xb !== yb) return { key: 'busy', diff: xb - yb };
		// 2. Heavy avoidance (#102.4), ONLY for a job that is not itself heavy:
		//    a node already running a heavy-kind job sorts after one that is
		//    not. A heavy job does not apply this — it already gets what it
		//    wants from step 1 (an empty node, when one exists) and must still
		//    place on a busy node rather than queue forever when none does.
		if (!heavy) {
			const xh = x.runningHeavy ? 1 : 0;
			const yh = y.runningHeavy ? 1 : 0;
			if (xh !== yh) return { key: 'running-heavy', diff: xh - yh };
		}
		// 3. Warm affinity (P5.1) — a TIE-BREAK among nodes equal on (1) and
		//    (2), never an override of either. `repo === undefined` (no caller
		//    wired up, or the counterfactual walk below) skips this entirely,
		//    which is the same "reorders to nothing" fallback this term has
		//    always had.
		if (repo !== undefined) {
			const xa = x.warmRepo === repo ? 0 : 1;
			const ya = y.warmRepo === repo ? 0 : 1;
			if (xa !== ya) return { key: 'warm-affinity', diff: xa - ya };
		}
		// 4. The baseline order's own position — see `posOf` above.
		return { key: 'baseline-order', diff: posOf.get(x.name)! - posOf.get(y.name)! };
	};
	const walkOrder = [...placeable].sort((a, b) => compareWalk(byName.get(a)!, byName.get(b)!).diff);

	// OVERFLOW OR SOLE-CARRIER (#15): could a node that is not a backstop take this
	// job, by its labels? Asked of nodes that could take work at all: a claw
	// that is down or drained is no home for it. Only a backstop reads the answer.
	const overflow = nodes.some(
		(n) =>
			!n.onDemandBackstop &&
			n.healthy &&
			!n.drained &&
			(!wantedLabels.length || satisfiesLabels(n.labels ?? [], wantedLabels))
	);

	const passed: Placement['passed'] = [];
	const note = (node: string, reason: string, holdSec?: number): void => {
		passed.push(holdSec === undefined ? { node, reason } : { node, reason, holdSec });
	};
	const walk = [...walkOrder, ...unplaceable, ...unknown];
	for (const name of walk) {
		const m = byName.get(name);
		if (!m) {
			note(name, 'not in the fleet');
			continue;
		}
		const { reason, requiredMb, holdSec } = refusalFor(
			m,
			wantedLabels,
			repo,
			spill,
			heavy,
			overflow
		);
		if (reason) {
			note(name, reason, holdSec);
			continue;
		}
		// What ranked the winner over the node right behind it in the walk — read
		// by the decision log only, never by placement.
		const next = walkOrder[walkOrder.indexOf(name) + 1];
		const rankedOver =
			walkOrder.includes(name) && next !== undefined
				? { node: next, key: compareWalk(m, byName.get(next)!).key }
				: undefined;
		return {
			node: name,
			passed,
			viaAffinity: repo !== undefined && m.warmRepo === repo,
			requiredMb,
			heavy,
			walk,
			...(rankedOver ? { rankedOver } : {}),
		};
	}
	// QUEUE, do not force. Every node being full is the normal shape of a
	// burst, and minting anyway is precisely the OOM this workstream exists to
	// stop — the fleet already has a bounded smoother for jobs GitHub has already
	// placed (§11.1), and it is not a cap.
	return {
		passed,
		reason: 'no node can take this job right now',
		viaAffinity: false,
		heavy,
		walk,
	};
}
