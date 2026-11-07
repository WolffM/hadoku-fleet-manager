/**
 * The join between the fast loop and the JIT dispatcher.
 *
 * This lived inside `fleet-loop.ts` because that is where the fleet probe
 * happened to be, and it took that file from 1,333 lines to 1,522 — a module
 * that owns tier decisions gaining a second, unrelated job. Moved here so JIT
 * code sits with JIT code.
 *
 * NOTHING IS IMPORTED FROM `fleet-loop`. Every input is passed in, which is
 * what keeps this from becoming an import cycle: the fast loop already holds the
 * probe, the manifest and the sick set, so handing them over costs one call and
 * leaves the dependency pointing one way.
 */

import { readDrain } from './drain.js';
import { effectiveSlices, readHostingDoc } from './hosting-record.js';
import { backstopUnitMemoryMaxMb, JIT_UNIT_MAX_SEC } from './ephemeral-slice.js';
import { JOB_RESERVE_DEFAULT_MB, unitMemoryMaxMb, type RepoReserve } from '../lib/job-reserve.js';
import { orderCandidates, type TrafficNode } from './traffic.js';
import { isSchedulable } from './schedulable.js';
import { nodeHome } from '../lib/node-users.js';
import { isBackstopHeld } from './backstop-hold.js';
import { idleSecondsByNode } from '../job-history-stats.js';
import { logger } from '../host.js';
import { withGhCaller } from '../gh-budget.js';
import { runDispatchTick } from './dispatch-tick.js';
import { SATURATED_QUEUED_MS } from './queue-discovery.js';
import { type DispatchPassResult } from './dispatch-pass-types.js';
import {
	withoutBackstops,
	offerFor,
	loadRepoReserves,
	shellOnNode,
	type EphemeralTickInput,
} from './ephemeral-shared.js';
import { loadWorkloadGateContext } from '../workload-gate-store.js';
import { dispatchWarmCache } from './dispatch-warm-cache.js';
import { getSpeedModel, getHeavyModel } from './speed-heavy-cache.js';
import { hostPaceOf } from './speed-tier.js';
import { onDemandBackstops, recentJobsPerDay } from './ephemeral-tick-verdict.js';

import { probeNodeMemory, __resetSpaceProbeLogForTesting } from './ephemeral-tick-probe.js';
import { buildNodeStates } from './ephemeral-tick-nodestate.js';

// Bare re-export for runner-health.ts (lane A, untouched this wave).

// Re-exported (not just imported above) so every existing importer of these
// five from THIS module keeps compiling unchanged.

/**
 * THE VERDICT SNAPSHOT — moved to `../admission-verdict-store.ts` (wave
 * clean-2 lane A, cut (iii)): `runner-health-mint.ts` (observation) read it
 * directly from this file, which is ci-scheduling, and neither domain can
 * host the other's import legally (rule 5, §3.2). `dispatchEphemeral` below
 * is still the one writer — `setAdmissionVerdicts` replaces the old bare
 * assignment — and `admissionVerdictsForReport`/`__setAdmissionVerdictsForTesting`
 * are re-exported here under their original path, so no existing importer
 * changes.
 */
import {
	setAdmissionVerdicts,
	__resetAdmissionVerdictsForTesting as __resetAdmissionVerdictStoreForTesting,
} from '../admission-verdict-store.js';

/**
 * Test seam. Not part of the supported API. Delegates the verdict snapshot's
 * own reset to `admission-verdict-store.ts` (its one writer) and the space
 * probe's own "logged once" set to `ephemeral-tick-probe.ts` (its owner) —
 * a delegating reset, same shape every moved `__reset*ForTesting` seam keeps
 * (wave5r lane rules).
 */
export function __resetAdmissionVerdictsForTesting(): void {
	__resetAdmissionVerdictStoreForTesting();
	__resetSpaceProbeLogForTesting();
}

/**
 * Mint for the nodes the manifest marks `ephemeral: true`.
 *
 * RETURNS WHAT THE PASS OBSERVED, and the distinction between the two
 * non-result answers is the whole point:
 *
 *   - a zeroed result means "looked, nothing to do" — no node is declared
 *     ephemeral, so there is nothing this pass could have minted.
 *   - `null` means COULD NOT LOOK: nodes are declared but not one of them was
 *     reachable with a readable memory figure, so this pass has no idea whether
 *     work was waiting.
 *
 * This returned `void` until 2026-09-01, which collapsed all three answers into
 * one. `recordDispatch` reads a missing result as "attempted and all failed", so
 * the Fleet panel reported `failingSince` from the first tick after every
 * restart, with null counts and a zero mint total, on a dispatcher that was
 * minting ~55 jobs a day successfully. A healthy thing rendered as broken is the
 * same class of bug as "I could not look" rendering as "nothing is wrong".
 */
export async function dispatchEphemeral(
	tickInput: EphemeralTickInput,
	token: string,
	gh: Parameters<typeof runDispatchTick>[2],
	/**
	 * Injected for the reason this file just learned the hard way. The dispatch
	 * RESULT was dropped on the floor here for three days while unit tests on
	 * both sides of the call stayed green, because nothing exercised the seam
	 * between them. The `minQueuedMs` this function chooses is the same shape of
	 * fact — computed here, consumed there — so it gets a seam that can be
	 * asserted without shelling to the garage.
	 */
	sh: typeof shellOnNode = shellOnNode,
	run: typeof runDispatchTick = runDispatchTick,
	/**
	 * `fleet-runner-coverage.json`'s per-repo reserves — `jobReserve`'s `repo`
	 * answer, the most specific of the three, and `admitMint`'s placement clause
	 * depends on seeing an unclamped lower-bound figure where one exists (#76).
	 * Injected for the same seam reason `sh`/`run` are: a test pins the roster's
	 * content without writing a coverage file to disk for every case. Defaults
	 * to the real read, which is itself fail-open to an empty map (see
	 * {@link loadRepoReserves}) — an unreadable roster costs the per-repo
	 * answer, never the whole mint pass.
	 */
	repoReserves: ReadonlyMap<string, RepoReserve> = loadRepoReserves(),
	/** Injected for the same seam reason as `sh`/`run` above — the speed
	 *  model's rebuild cadence (#83) is computed here, consumed by every
	 *  `NodeState` this tick builds. Appended last so every existing positional
	 *  call keeps today's `Date.now()` behaviour unchanged. */
	nowMs: number = Date.now()
): Promise<DispatchPassResult | null> {
	// Before ANY I/O: the warm cache, the `free -m` probe and the mint all reach
	// the nodes this set names. See `withoutBackstops`.
	const input = withoutBackstops(tickInput);
	// THE ON-DEMAND BACKSTOPS (#120), minted for beside the claws but never part of
	// `input.ephemeral`: that set is general CI capacity, and the warm cache just
	// below must not see a backstop at all — on-demand means no listener parked on
	// the production host's memory. They are placed LAST and offered
	// `hadoku-builder` only while the backstop holds them; see `offerFor`.
	const backstops = onDemandBackstops(input);
	const minting = [...input.ephemeral, ...backstops];
	if (!minting.length) return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	const isBackstop = (name: string): boolean => backstops.includes(name);
	// The backstop hold is read ONCE per tick. Placement's `NodeState.labels` and
	// the mint's `labelsFor` both ask this, seconds apart, with probes and GitHub
	// polls in between — and runner-health flips the hold on its own clock. On
	// 2026-10-23 it demoted hokon at 19:21:42, and at 19:21:48 the mint of a
	// `hadoku-builder` job hokon had been PLACED for registered without
	// `hadoku-builder`. The job could never land on it, and "already has a
	// runner in flight" kept every claw from taking it for the unit's full TTL.
	const heldThisTick = new Set(backstops.filter(isBackstopHeld));
	const eligibleFor = (name: string): boolean => !isBackstop(name) || heldThisTick.has(name);
	// ONE state-dir read for this whole tick — see `offerFor`'s own doc. A
	// second read from `dispatchWarmCache`'s OWN call below (it is also called
	// directly, with its own tick) is accepted: both are one read of a small
	// local file, and keeping each entry point self-contained is simpler than
	// threading a context through a call this function does not otherwise own.
	const workloadGate = loadWorkloadGateContext(Object.keys(input.nodes));

	// WARM CACHE OF ONE (P4.1). Runs on its own clock (WARM_CACHE_INTERVAL_MS)
	// and must neither block the JIT mint pass below nor be blocked by it — a
	// slow or failing warm-cache probe must still let this tick mint. Caught
	// here rather than let `dispatchWarmCache`'s own internal catch be the only
	// guard, because a bug in the orchestration around it (not just inside one
	// node's branch) must not read as a dispatch-pass failure on the Fleet
	// panel — `DispatchPassResult` says nothing about the warm cache at all.
	try {
		await withGhCaller('warm-cache', () => dispatchWarmCache(input, token, gh, sh));
	} catch (err) {
		logger.warn(`[warm-cache] tick failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	// REAL free memory, in MB, read from the nodes — see
	// `ephemeral-tick-probe.ts`'s own doc for the full reasoning (why this is
	// megabytes and not the tier probe's free-slot count, why space rides the
	// same ssh, and the shared-hosting held-back share).
	const sharedHosting = effectiveSlices(readHostingDoc());
	const { freeMbByNode, sliceCeilingMbByNode, tmpFreeMbByNode, workFreeMbByNode, heldBackByNode } =
		await probeNodeMemory(minting, input, sh, isBackstop, sharedHosting);

	// Once per tick. A drain is operator state on disk; re-reading it per node
	// would let a node change status halfway through one placement decision.
	const drainRecords = readDrain();
	const drainedNodes = new Set(Object.keys(drainRecords));
	// ONCE PER TICK, not per node (#83): the model is the same fleet-wide
	// answer for every node this tick builds, rebuilt on its own cadence
	// rather than this one's. EVERY DECLARED MACHINE, not only `input.ephemeral`
	// — `buildSpeedModel` needs the fleet's own node roster to attribute a
	// runner name to a node (rather than guessing from a naming convention),
	// and a non-ephemeral node (claw-4, claw-6, hokon) still needs to be
	// attributable even though it is never a mint TARGET, or every job that
	// actually ran there would misattribute into "the other claws" baseline
	// for nothing, or vanish from it entirely.
	const speedModel = getSpeedModel(nowMs, Object.keys(input.nodes));
	// THE SAME CACHED HEAVY MODEL `dispatchWarmCache` uses (#102) — see
	// `getHeavyModel`'s own cadence note.
	const heavyModel = getHeavyModel(nowMs);

	// THIS TICK'S PLACEMENT-READY NODE STATES — see `ephemeral-tick-nodestate.ts`'s
	// own doc for the full per-field reasoning; moved there verbatim.
	const { nodes, candidates, nextVerdicts } = buildNodeStates({
		minting,
		input,
		isBackstop,
		eligibleFor,
		workloadGate,
		repoReserves,
		speedModel,
		heavyModel,
		drainedNodes,
		drainRecords,
		freeMbByNode,
		sliceCeilingMbByNode,
		tmpFreeMbByNode,
		workFreeMbByNode,
		heldBackByNode,
	});

	// PUBLISHED EVEN WHEN EMPTY — see `admission-verdict-store.ts`'s own note.
	// Every node this pass could not reach, or could not read memory for, is
	// simply absent from `nextVerdicts`, which is exactly "could not look" for
	// THAT node and must be published as such rather than left stale.
	setAdmissionVerdicts(nextVerdicts);
	// COULD NOT LOOK, not "nothing to do". Every declared node was unreachable
	// or refused to report its free memory (both logged above), so this pass
	// cannot vouch for anything — including that no work was waiting.
	if (!nodes.length) return null;

	// Who the dispatcher tries first. `busy` is the OBSERVED count of runners
	// already working, so a node that quietly took jobs straight from GitHub
	// sinks in the order without anything having to notice. idleSeconds comes
	// from job history — the end of the last job each node served — so equals
	// rotate. A node with no history stays null and sorts LAST among equals.
	const idleByNode = idleSecondsByNode(nodes.map((m2) => m2.name));
	const trafficNodes: TrafficNode[] = nodes.map((m2) => ({
		name: m2.name,
		busy: m2.standingBusy + m2.liveUnits,
		idleSeconds: idleByNode.get(m2.name) ?? null,
		// From runner-health's last pass. A node whose registrations are all
		// offline looks IDLE to a load-based ordering and would otherwise win
		// every placement — see runners/schedulable.ts for the 2026-09-02 case.
		schedulable: isSchedulable(m2.name),
		// THE SAME speed model this tick already built above (#83's continuous
		// sibling, wave 3z) — no second reader of job history. `null` (thin
		// history) reaches `orderCandidates` as-is; it is the ORDERING's job to
		// treat that as neutral, not this call site's.
		speedFactor: speedModel.factorOf?.(m2.name) ?? null,
	}));
	// BACKSTOPS LAST, whatever the ordering thinks of them. A backstop is idle on most
	// ticks and fast, so a load- or speed-ranked order would put the production
	// host FIRST — the inverse of a backstop. It takes what no claw can: a job
	// only its labels fit, or one every claw refused this pass.
	const placementOrder = [
		...orderCandidates(
			candidates.filter((n) => !isBackstop(n)),
			trafficNodes
		),
		...orderCandidates(candidates.filter(isBackstop), trafficNodes),
	];

	// THE AGE GATE. `MIN_QUEUED_MS` is a proxy for "a standing runner would have
	// taken this by now". With a standing runner eligible (a promoted reserve),
	// the gate is SATURATED_QUEUED_MS: every claw is ephemeral, so every standing
	// slot is below them and "the standing fleet above is full" held on every
	// tick the tier ladder ever computed it — the 90 s default was never the
	// live value. With NOTHING standing there is no runner to wait for and no
	// slot that can free, so the proxy waits for an event that cannot occur and
	// the gate is removed.
	//
	// It costs more than the gate: `mintableRuns` SKIPS a run younger than the
	// gate rather than deferring it, so a job discovered at age 20 s waits for
	// the next poll entirely (measured 2026-09-02: 85-95 s of queue where
	// discovery alone accounts for ~30 s).
	//
	// Undefined (not passed) keeps the gate. Only an explicit empty set removes it.
	const nothingStanding = input.standingEligible !== undefined && input.standingEligible.size === 0;

	return await run(
		{
			order: placementOrder,
			nodes,
			repos: input.repos,
			recentJobCounts: recentJobsPerDay(),
			labelsFor: (node) => offerFor(input.nodes, node, workloadGate, eligibleFor(node)),
			// The HARD CAP, from the manifest — the counterpart to requiredMb's
			// estimate above. Hardcoded 4096 until 2026-09-01, which happened to
			// match every node's declared unitMaxMb and so hid the fact that the
			// declaration was read by nothing.
			memoryMaxMbFor: (repo, node) => {
				void repo;
				// A BACKSTOP'S CAP IS ITS OWN, not a share of the claws' — see
				// `backstopUnitMemoryMaxMb` for why the claw rule below would hand one
				// job the whole backstop allowance.
				if (isBackstop(node)) {
					const g = input.nodes[node]?.slice;
					return backstopUnitMemoryMaxMb({ requestedMb: g?.unitMaxMb, sliceMaxMb: g?.maxMb });
				}
				// THE SLICE CEILING, not a flat number (issue #26). See
				// `unitMemoryMaxMb`: a cap below the slice's own ceiling is a second,
				// tighter bound that fires first and attributes the death to whatever
				// was allocating — brave-quartet's `wasm-size` died that way on claw-2
				// against 4 GiB while the node had 13.8 GiB of CI budget unspent.
				//
				// STILL THE FLEET MIN FOR A CLAW, though the node is now known (#120
				// passes it, for the backstop above). This used to be forced — the node
				// was chosen after this was asked — and is now only unchanged: a claw
				// cap read off its own ceiling is a separate decision from #120, and
				// it would widen the cap on every larger claw at once. Claws only: a
				// backstop's allowance is not a claw's ceiling and must not lower it.
				// Every claw in `nodes` has a MEASURED ceiling, because the loop above
				// refuses to admit a node without one, so this cannot silently fall
				// back while any claw was admitted.
				const ceilings = nodes
					.filter((n) => !isBackstop(n.name))
					.map((n) =>
						unitMemoryMaxMb({
							requestedMb: input.nodes[n.name]?.slice?.unitMaxMb,
							sliceCeilingMb: sliceCeilingMbByNode.get(n.name),
						})
					)
					.filter((v) => v > 0);
				return ceilings.length ? Math.min(...ceilings) : JOB_RESERVE_DEFAULT_MB;
			},
			// The node's own slice, now that the mint path carries it (#120). Only
			// the backstop declares one today; every claw resolves to the default.
			sliceNameFor: (node) => input.nodes[node]?.slice?.name,
			hostPaceFor: (node) => hostPaceOf(speedModel, node),
			homeDirFor: (node) => nodeHome(input.nodes[node], 'ci'),
			// NOT an orphan timeout. It was 3600 until 2026-09-14 and read as one,
			// and systemd stopped the unit at the hour whether it held an idle
			// listener or a build at minute 59 — issue #22. Orphans are bounded by
			// the reap sweep, which deletes the REGISTRATION (the thing that does
			// harm); a running job is bounded by GitHub's own `timeout-minutes`.
			// This is only the backstop above that ceiling.
			ttlSeconds: JIT_UNIT_MAX_SEC,
			minQueuedMs: nothingStanding ? 0 : SATURATED_QUEUED_MS,
		},
		token,
		gh,
		sh
	);
}
