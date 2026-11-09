import { isDraining, readDrain } from './drain.js';
import { readHostingDoc } from './hosting-record.js';
import { spaceRefusal } from './ephemeral-admission.js';
import { warmRunnerName } from '../lib/jit-naming.js';
import { planWarmFleet, type WarmFleetNode } from './ephemeral-warm-fleet.js';
import { warmSlotLocked } from './ephemeral-warm.js';
import { evictWarmListener, withholdWarmListener } from './ephemeral-exec.js';
import { type GhLike } from '../lib/fleet-vocabulary.js';
import { runnerTarballUrl } from './ephemeral-exec-jit.js';
import { observeWarmNode } from './dispatch-warm-cache-observe.js';
import { actOnWarmNode } from './dispatch-warm-cache-act.js';
import { holdWarmChangesForQueue, liftYieldsOfIneligible, warmYieldStep } from './warm-yield.js';
import { heavyMarkedRecently } from './dispatch-pass-state.js';
import { flushWarmHolds, noteWarmHold } from './warm-holds.js';
import { slowReposOn } from './placement-slow.js';
import { recordWarmListenerDecisions, type WarmListenerDecision } from './decision-log-record.js';
import { logger } from '../host.js';
import { withoutBackstops, shellOnNode, type EphemeralTickInput } from './ephemeral-shared.js';
import { loadWorkloadGateContext } from '../workload-gate-store.js';
import { getSpeedModel, getHeavyModel } from './speed-heavy-cache.js';
import { hostPaceOf } from './speed-tier.js';
import { WARM_CACHE_INTERVAL_MS, warmBackoffActive } from './warm-backoff.js';
import {
	fleetServedJobs,
	setWarmRepos,
	EMPTY_WARM_RESULT,
	type WarmCacheResult,
	type ObservedWarmNode,
} from './dispatch-warm-cache-state.js';

let lastWarmCacheMs = 0;

/** Test seam. Not part of the supported API. */
export function __resetWarmCacheClockForTesting(): void {
	lastWarmCacheMs = 0;
}

/**
 * Maintain the warm cache of one, for every eligible ephemeral node.
 *
 * INDEPENDENT of the JIT mint pass in `dispatchEphemeral`, on its own clock —
 * see WARM_CACHE_INTERVAL_MS. Eligibility, the lock and the fill/rotate
 * decision are all pure (see ephemeral.ts); this function only does the I/O
 * the decision calls for, exactly the split `mintEphemeralRunner` and
 * `admitMint` already keep.
 *
 * NEVER THROWS. A node's warm-cache maintenance failing must not stop
 * another node's, and must not stop the JIT mint pass this runs alongside —
 * every per-node step below is caught and counted as `failed` rather than
 * propagated.
 */
export async function dispatchWarmCache(
	tickInput: EphemeralTickInput,
	token: string,
	gh: GhLike & { get: (path: string, token: string, repo?: string) => Promise<unknown> },
	sh: typeof shellOnNode = shellOnNode,
	nowMs: number = Date.now()
): Promise<WarmCacheResult> {
	// THE KILL SWITCH. issue #7's clause (a): a way to stop this without a
	// redeploy. Checked before the tick's own clock so it also holds off
	// `lastWarmCacheMs`, which is deliberate — a disabled cache should not
	// consume the first eligible tick once re-enabled either.
	if (process.env.WARM_CACHE_DISABLED === '1') {
		// The kill switch takes the AFFINITY half with it. With maintenance off,
		// nothing re-confirms a slot against GitHub, and a remembered map would go
		// on steering placement toward listeners nobody is checking are still
		// there — a belief with no reader, which is the shape this whole
		// workstream keeps paying for. Placement falls through to plain ordering,
		// which is what the fleet did before P5.1 existed.
		setWarmRepos(new Map());
		return { ...EMPTY_WARM_RESULT };
	}
	const input = withoutBackstops(tickInput);
	if (!input.ephemeral.size) return { ...EMPTY_WARM_RESULT };
	if (nowMs - lastWarmCacheMs < WARM_CACHE_INTERVAL_MS) return { ...EMPTY_WARM_RESULT };
	lastWarmCacheMs = nowMs;
	// ONE state-dir read for this whole tick — see `offerFor`'s own doc.
	const workloadGate = loadWorkloadGateContext(Object.keys(input.nodes));

	const result: WarmCacheResult = { ...EMPTY_WARM_RESULT };
	/**
	 * This pass's observation, published wholesale at the end.
	 *
	 * Built fresh rather than mutated in place, so a node that went drained,
	 * unreachable, ineligible or listener-less between ticks simply does not
	 * appear — there is no path here that can leave a stale entry behind.
	 */
	const observedWarm = new Map<string, string>();

	/**
	 * Where a node with NO runner payload at all may fetch a release.
	 *
	 * This was hard-coded `null` until 2026-09-08, which meant the fallback
	 * `warm-provision.sh` documents was, in production, never once taken —
	 * `RUNNER_TARBALL_URL` had exactly one caller and it was the JIT half.
	 * That is only half of why claw-1/3/5 could not fill (the script also
	 * needed a runner ROOT it could not build; it now registers straight
	 * through `$PAYLOAD/bin/Runner.Listener` and needs no root at all), but a
	 * hard-coded null is still a fallback that cannot fire, so it goes.
	 *
	 * RESOLVED LAZILY, and that matters for the API budget. `runnerTarballUrl`
	 * memoises for a day, so the steady-state cost is one call per day — but
	 * only if something asks. Calling it unconditionally at the top of the
	 * tick would spend that call on every tick of a fleet where no node has
	 * ever needed it, and this tick's whole cadence design (see
	 * WARM_CACHE_INTERVAL_MS) is about not doing that.
	 */
	let tarballPromise: Promise<string | null> | null = null;
	const tarballUrl = (): Promise<string | null> =>
		(tarballPromise ??= runnerTarballUrl(gh.get, token, input.repos[0] ?? ''));
	// Read ONCE per tick, same as dispatchEphemeral's own drainedNodes below —
	// a drain is operator state on disk, and re-reading it per node would let a
	// node change status mid-pass.
	const drainState = readDrain();
	// Shared hosting slices, read once with it. Unreadable THROWS, as the drain
	// does: a tick that cannot tell what a tenant was promised mints nothing.
	const hostingDoc = readHostingDoc();

	// Per-node eligibility, current slot and installed memory — see
	// `dispatch-warm-cache-observe.ts`'s own doc for the full reasoning
	// (issues #7, #101, #61, #17). `observedWarm` is set by a node whose
	// slot is confirmed ONLINE, for the affinity map published below.
	const ineligible = new Set<string>();
	const observed = (
		await Promise.all(
			[...input.ephemeral].map((node) =>
				observeWarmNode(
					node,
					input,
					hostingDoc,
					token,
					gh,
					sh,
					nowMs,
					result,
					observedWarm,
					ineligible
				)
			)
		)
	).filter((o): o is ObservedWarmNode => o !== null);
	// A yielded node that can no longer hold a listener at all never reaches
	// warmYieldStep again, so its yield would never lift (fleet-manager#79).
	liftYieldsOfIneligible(ineligible, nowMs);

	// WAVE 3W (#82, #83): THE WARM PATH IS A SECOND ASSIGNMENT PATH.
	// A warm listener is a STANDING registration GitHub hands work to
	// DIRECTLY — `choosePlacement` never sees it, and neither #82's per-repo
	// exclusion nor #83's slow-tier spill gate reaches here on its own. Found
	// live (send-back on this wave): `~/.hadoku-mgmt/job-history.jsonl` shows
	// claw-5 served 23 hadoku-cardtable jobs and 164 hadoku_site jobs through
	// `warm-claw-5-*` listeners while it was excluded from JIT only.
	//
	// THE SAME CACHED MODEL the mint tick uses, not a second build — see
	// `getSpeedModel`'s own module-level cache; calling it twice in one
	// process just returns the SAME object inside its 10-minute window.
	const speedModel = getSpeedModel(nowMs, Object.keys(input.nodes));
	// THE SAME CACHED HEAVY MODEL, same reason (#102) — see `getHeavyModel`'s
	// own cadence note.
	const heavyModel = getHeavyModel(nowMs);

	// A node fully excluded from the joint allocation below (slow tier: it
	// must never be GIVEN a slot, not merely told to give one back) is also
	// excluded from the act loop after this — there is nothing for `decisions`
	// to say about it, and reading that absence as `idle` would count a
	// deliberate, permanent hold-back as an ordinary quiet tick.
	const neverWarm = new Map<string, string>();
	/** Nodes whose listener yielded to the queue this tick — no longer cover for anyone. */
	const yieldedThisTick = new Set<string>();
	const planNodes: WarmFleetNode[] = [];
	// The repos a node must not hold a listener for: the manifest's
	// `excludeRepos` (#82), then any repo with a kind this node runs slowly
	// (#8, `slowReposOn`). Both check points below read this, never one alone.
	const slowRepos = new Map(observed.map((o) => [o.node, slowReposOn(speedModel, o.node)]));
	const warmExcluded = (
		node: string,
		m: { excludeRepos?: Record<string, string> },
		repo: string
	): string | undefined => {
		const manifest = (m.excludeRepos ?? {})[repo];
		if (manifest !== undefined) return `repo excluded here: ${manifest} (#82)`;
		const slow = slowRepos.get(node)?.get(repo);
		return slow !== undefined ? `${slow} (#8)` : undefined;
	};
	// The same two sources as a set, for `planWarmFleet` (fleet-manager#36):
	// told up front, it offers the node a repo it may hold instead of one the
	// act loop below must withhold, which left the node cold.
	const excludedRepos = (
		node: string,
		m: { excludeRepos?: Record<string, string> }
	): ReadonlySet<string> =>
		new Set([...Object.keys(m.excludeRepos ?? {}), ...(slowRepos.get(node)?.keys() ?? [])]);
	for (const o of observed) {
		const tier = speedModel.tierOf(o.node);
		// THE THIRD ENFORCEMENT POINT (#90, drain-node.mjs's header). A warm
		// listener is neither of the first two (placement never sees it; it is
		// not `hadoku-builder` on a standing registration either) — GitHub
		// assigns straight to it. Folded into the SAME exclude-and-evict branch
		// the slow tier already uses (#83) rather than a second one: both are
		// "this node must hold nothing, and whatever it already holds gets
		// evicted on the next pass, respecting the same busy/assign-window
		// lock". A node drained mid-pass (either `kind`) reads the same
		// `drainState` `dispatchEphemeral` already read once this tick.
		const drained = isDraining(o.node, drainState);
		// #101: THIS PASS'S OWN MEASUREMENT (`o.tmpFreeMb`/`o.workFreeMb`,
		// read by the probe above), not `dispatchEphemeral`'s verdict.
		// Borrowing that verdict had two real holes: (a) MASKING —
		// `admitMint` returns the FIRST refusing clause, so a node that is
		// ALSO at capacity or memory-refused reports `concurrency`/`memory`
		// and would keep its warm listener while out of `/tmp` — exactly the
		// busy-and-full #101 state; (b) right after a process restart there
		// is no verdict at all yet, and a node this check has no opinion on
		// is not the same as a node confirmed to have space — the warm pass
		// could FILL an unmeasured node. Asking `spaceRefusal` directly from
		// this pass's own probe closes both: it never masks (no other
		// clause can suppress it) and it is never missing for a node this
		// loop actually reached (the probe above always sets both fields,
		// `null` on an unreadable `df`, never `undefined`).
		const space = spaceRefusal({ tmpFreeMb: o.tmpFreeMb, workFreeMb: o.workFreeMb });
		const spaceRefused = space !== null;
		// #102.4: "a node running a heavy job is not a place to (re)fill a warm
		// listener" — a warm listener hands work with ZERO queue wait, which is
		// exactly as bad an idea on a node ALREADY crunching a heavy job as it is
		// on a slow one (the `tier === 'slow'` clause just above). REPO-LEVEL
		// ONLY — see `HeavyModel.isHeavyRepo`'s own doc for the approximation
		// this rests on, the same one `dispatchEphemeral`'s `NodeState.runningHeavy`
		// uses.
		const runningHeavyNow =
			[...(input.fleetProbe.get(o.node)?.busyRepos ?? [])].some(
				([repo, n]) => n > 0 && heavyModel.isHeavyRepo(repo)
			) ||
			// The dispatcher's own, fresher word (#102): it placed or saw a heavy
			// job here within the last HEAVY_MARK_MS, which the probe may not show
			// yet — without this the tick refills the listener the pass evicted.
			heavyMarkedRecently(o.node, nowMs);
		// EVERY NODE'S PRE-PASS WORK IS ITS OWN TRY/CATCH, same reason the act
		// loop below already wraps each node: `evictWarmListener` awaits `sh`
		// and a GitHub delete, either of which can throw. Before this, ONE
		// node's throw rejected the whole pass — no other node's fill or
		// rotate ran, `setWarmRepos` never published, and it would have kept
		// throwing every WARM_CACHE_INTERVAL_MS tick forever. Caught per node,
		// exactly like the act loop already treats a per-node failure: count
		// it, say why with the node and the real error, move on.
		try {
			// WARM YIELD (`warm-yield.ts`): a slot the dispatcher asked to give to
			// a long-waiting job, or one already given and not yet due back. Held
			// out of the joint allocation, so nothing refills it. FIRST, ahead of
			// the never-warm branch: a node running a heavy job holds its slot
			// empty, and that empty slot is exactly what a waiting job can use.
			const y = await warmYieldStep({
				o,
				nowMs,
				token,
				gh,
				sh,
				freeSlotFor: (node) => {
					const workers = input.fleetProbe.get(node)?.workers;
					return workers === undefined ? null : workers < (input.nodes[node]?.maxConcurrent ?? 1);
				},
				stillWarm: (node, repo) => observedWarm.get(node) === repo && !yieldedThisTick.has(node),
			});
			if (y.hold) {
				neverWarm.set(o.node, y.reason);
				if (y.evicted) {
					result.evicted++;
					yieldedThisTick.add(o.node);
					observedWarm.delete(o.node);
				}
				continue;
			}
			if (y.failed) result.failed++;
			if (tier === 'slow' || drained || spaceRefused || runningHeavyNow) {
				// Said out loud for the canary, which runs on its own clock and
				// cannot see this decision (`warm-holds.ts`, fleet-manager#79).
				if (tier !== 'slow' && (drained || runningHeavyNow))
					noteWarmHold(o.node, drained ? 'drained' : 'heavy', nowMs);
				neverWarm.set(
					o.node,
					tier === 'slow'
						? 'slow tier'
						: drained
							? 'drained'
							: spaceRefused
								? (space?.reason ?? 'space refusal')
								: 'running a heavy-kind job'
				);
				// A DRAIN MAY NOT WAIT FOR AN IDLE MOMENT. The eviction below is locked
				// while the listener is busy, and a listener under load is busy at
				// nearly every look — see `withholdWarmListener`. Withholding first
				// stops new assignments at once; the eviction follows when it idles.
				// Drain only: the other three reasons are about where work SHOULD go,
				// and a job finishing on a slow node is not a safety question.
				if (drained && o.current) {
					const w = await withholdWarmListener(
						o.current.repo,
						warmRunnerName(o.node, o.current.repo),
						token,
						gh
					);
					if (w === 'failed') result.failed++;
				}
				if (
					o.current &&
					!warmBackoffActive(o.node, nowMs) &&
					!warmSlotLocked({
						busy: o.current.busy,
						mintedOrRefreshedAtMs: o.current.mintedOrRefreshedAtMs,
						nowMs,
					})
				) {
					const reason = drained
						? `drained (#90): a warm listener is a standing registration GitHub assigns ` +
							'to directly, which neither of the other two enforcement points reaches'
						: spaceRefused
							? (space?.reason ?? 'space refusal')
							: tier === 'slow'
								? `slow tier never holds one (p25 ${speedModel.describe(o.node).p25 ?? 'null'}, #83): ` +
									'a warm listener takes work with ZERO queue wait, which is exactly what the ' +
									'spill gate exists to forbid'
								: 'running a heavy-kind job (#102.4): a warm listener takes work with ZERO ' +
									'queue wait, which is exactly what stacking onto a heavy job must not do';
					logger.info(
						`[warm-cache] ${o.node}: evicting its warm listener for ${o.current.repo} — ${reason}`
					);
					const evicted = await evictWarmListener(
						o.node,
						o.current.repo,
						warmRunnerName(o.node, o.current.repo),
						token,
						gh,
						sh
					);
					if (evicted) result.evicted++;
					else {
						result.failed++;
						logger.warn(
							`[warm-cache] could not evict ${drained ? 'drained' : spaceRefused ? 'space-refused' : tier === 'slow' ? 'slow-tier' : 'heavy-busy'} ${o.node}'s warm slot for ${o.current.repo}`
						);
					}
				}
				// Excluded from `planNodes` regardless of whether an eviction ran
				// this tick (busy, backed off, or just failed) — the point is that
				// `planWarmFleet` must never be offered this node to FILL, not only
				// that a live listener gets removed. This is also why a drained
				// node is never RE-FILLED while drained: it never reaches
				// `planNodes` to be offered a slot in the first place.
				continue;
			}
			// #82: THE CURRENT repo is one THIS node refuses. Evict it (respecting
			// the same busy/assign-window lock `planWarmFleet`'s own `rotate`
			// decision already respects, and the same backoff every other eviction
			// here does) and offer the node up with `current: null` — it still
			// competes for a DIFFERENT, allowed repo below, exactly like a node
			// whose listener was just found dead by the reap check above.
			const excludedReason = o.current ? warmExcluded(o.node, o.m, o.current.repo) : undefined;
			if (
				o.current &&
				excludedReason !== undefined &&
				!warmBackoffActive(o.node, nowMs) &&
				!warmSlotLocked({
					busy: o.current.busy,
					mintedOrRefreshedAtMs: o.current.mintedOrRefreshedAtMs,
					nowMs,
				})
			) {
				logger.info(
					`[warm-cache] ${o.node}: evicting its warm listener for ${o.current.repo} — ${excludedReason}`
				);
				const evicted = await evictWarmListener(
					o.node,
					o.current.repo,
					warmRunnerName(o.node, o.current.repo),
					token,
					gh,
					sh
				);
				if (evicted) {
					result.evicted++;
					planNodes.push({ node: o.node, current: null, excluded: excludedRepos(o.node, o.m) });
					continue;
				}
				result.failed++;
				logger.warn(
					`[warm-cache] could not evict ${o.node}'s excluded warm slot for ${o.current.repo}`
				);
			}
			planNodes.push({ node: o.node, current: o.current, excluded: excludedRepos(o.node, o.m) });
		} catch (err) {
			result.failed++;
			const excludedForTick = tier === 'slow' || drained || runningHeavyNow;
			logger.warn(
				`[warm-cache] ${o.node}: pre-pass failed (${tier} tier${drained ? ', drained' : ''}${runningHeavyNow ? ', running heavy' : ''}), ` +
					`${excludedForTick ? 'leaving it excluded from this tick' : 'passing it through with its current slot unchanged'}: ` +
					`${err instanceof Error ? err.message : String(err)}`
			);
			// Same rule the slow-tier/drained/heavy-busy branch already enforces on
			// success: never let an excluded node reach `planNodes`, thrown or not.
			// A node that failed mid-eviction for none of those reasons is passed
			// through UNCHANGED — today's behaviour before this wave, for the same
			// reason the eviction-failed branch above already does it on a clean
			// `false` rather than a throw: an eviction we could not confirm is not
			// safe to assume.
			if (!excludedForTick)
				planNodes.push({ node: o.node, current: o.current, excluded: excludedRepos(o.node, o.m) });
		}
	}
	flushWarmHolds(nowMs);

	// THE JOINT ALLOCATION (wave 3k §B). Every eligible node's slot is decided
	// at once, over the fleet's history, so the Nth node takes the Nth most
	// valuable UNCOVERED repo — a per-node argmax put hadoku_site on all four.
	// `planNodes`, not `observed`, is what is handed over (#82, #83 above):
	// `planWarmFleet` is pure and knows nothing of speed, so the node list it
	// is given IS the eligibility it can ever honour, and each node's
	// `excluded` set is the only per-repo rule it sees (fleet-manager#36).
	const decisions = planWarmFleet({
		nodes: planNodes,
		served: fleetServedJobs(),
		nowMs,
	});
	// A node a job is waiting for keeps its slot free for JIT: no fill, no
	// rotate onto it (warm-nofill; `holdWarmChangesForQueue`).
	holdWarmChangesForQueue(
		decisions,
		planNodes.map((n) => n.node),
		nowMs
	);
	// THE DECISION LOG (T1): each node's slot decision, as the act loop below
	// will read it — the warm path's placement, which `planTick` never sees.
	// Written only when a node's decision changes; never throws.
	recordWarmListenerDecisions(
		() =>
			observed.map((o): WarmListenerDecision => {
				const never = neverWarm.get(o.node);
				const held = o.current?.repo ?? null;
				if (never !== undefined) {
					return { node: o.node, action: 'never-warm', repo: held, reason: never };
				}
				const d = decisions.get(o.node) ?? { action: 'idle' };
				const target = d.action === 'fill' ? d.repo : d.action === 'rotate' ? d.to : null;
				const withheld = target !== null ? warmExcluded(o.node, o.m, target) : undefined;
				if (withheld !== undefined) {
					return { node: o.node, action: 'withheld', repo: target, reason: withheld };
				}
				return {
					node: o.node,
					action: d.action,
					repo: target ?? held,
					from: d.action === 'rotate' ? d.from : null,
					reason: null,
				};
			}),
		nowMs
	);

	// Carries out each node's decision — see `dispatch-warm-cache-act.ts`'s
	// own doc for the full per-action reasoning (mint, evict-then-mint, or
	// leave alone, plus the workload-gate rotation `planWarmFleet` never
	// decides).
	await Promise.all(
		observed.map((o) =>
			actOnWarmNode({
				observed: o,
				decision: decisions.get(o.node) ?? { action: 'idle' },
				neverWarm,
				warmExcluded,
				input,
				workloadGate,
				token,
				gh,
				sh,
				tarballUrl,
				hostPaceFor: (node) => hostPaceOf(speedModel, node),
				nowMs,
				result,
			})
		)
	);

	// PUBLISHED AFTER EVERY NODE HAS BEEN WALKED, never incrementally: the map is
	// a statement about the whole fleet at one instant, and a half-built one read
	// mid-pass would say "no node is warm for this repo" about a node the pass
	// had simply not reached yet.
	setWarmRepos(observedWarm);

	if (result.filled || result.rotated || result.evicted || result.reaped || result.failed) {
		logger.info(
			`[warm-cache] filled=${result.filled} rotated=${result.rotated} kept=${result.kept} ` +
				`locked=${result.locked} evicted=${result.evicted} reaped=${result.reaped} ` +
				`failed=${result.failed}`
		);
	}
	return result;
}
