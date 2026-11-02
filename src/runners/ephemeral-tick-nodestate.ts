/**
 * BUILDS THIS TICK'S PLACEMENT-READY NODE STATES — one `NodeState` per
 * reachable, memory-measured minting node, plus the generic admission
 * verdict `GET /fleet` reports for it. Split out of `ephemeral-tick.ts`
 * (wave shrink-1 lane B, 800-line ceiling): everything here is a pure
 * build over the tick's own probe results and the fleet-wide models
 * (speed, heavy) it was handed; no I/O of its own.
 */
import { logger } from '../host.js';
import { mintBudget, warmListenersHeld } from './ephemeral.js';
import { backstopUnitMemoryMaxMb } from './ephemeral-slice.js';
import { TMP_FREE_FLOOR_MB } from '../lib/jit-naming.js';
import { unitMemoryMaxMb, jobReserve, type RepoReserve } from '../lib/job-reserve.js';
import { WORK_FREE_FLOOR_MB } from './ephemeral-admission.js';
import { isSchedulable } from './schedulable.js';
import { offerFor, type EphemeralTickInput } from './ephemeral-shared.js';
import type { WorkloadGateContext } from '../lib/workload-gate.js';
import { warmRepoByNode } from './dispatch-warm-cache-state.js';
import { chargedLikeDispatch, getCapacityLedger } from './capacity-ledger.js';
import type { NodeState } from './placement-node-state.js';
import type { SpeedModel } from './speed-tier.js';
import type { HeavyModel } from './traffic.js';
import { admissionVerdictFor } from './ephemeral-tick-verdict.js';
import { type AdmissionVerdict } from '../lib/fleet-vocabulary.js';
import { admissionVerdictsForReport } from '../admission-verdict-store.js';
import type { DrainRecord } from './drain.js';

export interface NodeStateBuild {
	nodes: NodeState[];
	candidates: string[];
	nextVerdicts: Map<string, AdmissionVerdict>;
}

/**
 * One `NodeState` per node in `minting` that is reachable and whose free
 * and installed memory this tick could read — a node failing either check
 * is logged and simply absent from `nodes`/`candidates`, "not minting
 * there this tick" rather than a cap of zero. See each field's own comment
 * below for why it is built the way it is; moved verbatim from
 * `dispatchEphemeral`'s own loop.
 */
export function buildNodeStates(args: {
	minting: readonly string[];
	input: EphemeralTickInput;
	isBackstop: (name: string) => boolean;
	eligibleFor: (name: string) => boolean;
	workloadGate: WorkloadGateContext;
	repoReserves: ReadonlyMap<string, RepoReserve>;
	speedModel: SpeedModel;
	heavyModel: HeavyModel | undefined;
	drainedNodes: ReadonlySet<string>;
	drainRecords: Record<string, DrainRecord>;
	freeMbByNode: ReadonlyMap<string, number>;
	sliceCeilingMbByNode: ReadonlyMap<string, number>;
	tmpFreeMbByNode: ReadonlyMap<string, number | null>;
	workFreeMbByNode: ReadonlyMap<string, number | null>;
	heldBackMbByNode: ReadonlyMap<string, number>;
}): NodeStateBuild {
	const {
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
		heldBackMbByNode,
	} = args;
	const nodes: NodeState[] = [];
	const candidates: string[] = [];
	// THE GENERIC ADMISSION VERDICT (wave 4a §A.1, #100), built fresh this pass
	// and published wholesale after the loop — see `admission-verdict-store.ts`'s
	// own note on why wholesale, not merged.
	const nextVerdicts = new Map<string, AdmissionVerdict>();
	// LAST pass's published snapshot, read ONCE before this pass starts writing
	// `nextVerdicts` — the store's one value does not change again until
	// `setAdmissionVerdicts` (the caller's job), so one copy here reads exactly
	// what every per-node `.get(name)` in the loop used to read off the live
	// module variable directly.
	const prevVerdicts = admissionVerdictsForReport();
	for (const name of minting) {
		const p = input.fleetProbe.get(name);
		const m = input.nodes[name];
		if (!p?.reachable || !m) continue;
		// An unreadable memory figure must not silently become 0 and refuse every
		// mint. Declining is right — admission needs a real number — but it has to
		// be VISIBLE, because the previous failure of this exact shape produced a
		// dispatcher that looked healthy and minted nothing.
		if (!freeMbByNode.has(name)) {
			logger.warn(
				`[ephemeral-tick] ${name} mints but its free memory could not be read — not minting there this tick`
			);
			continue;
		}
		// The SAME refusal for the total, and for the same reason. The per-unit cap
		// is now derived from it, so a node here without a measured ceiling would
		// mint at the fallback — a tighter cap than the operator asked for, applied
		// silently, which is #26 coming back through the "I could not look" door.
		// Both numbers come off one `free -m` line, so this fires only when that
		// line was malformed rather than absent.
		if (!sliceCeilingMbByNode.has(name)) {
			logger.warn(
				`[ephemeral-tick] ${name} mints but its installed memory could not be read ` +
					`(or is not above minFreeMb=${m.minFreeMb ?? 1536}) — not minting there this tick`
			);
			continue;
		}
		candidates.push(name);
		const sliceCeilingMb = sliceCeilingMbByNode.get(name);
		const capMb = isBackstop(name)
			? backstopUnitMemoryMaxMb({ requestedMb: m.slice?.unitMaxMb, sliceMaxMb: m.slice?.maxMb })
			: unitMemoryMaxMb({ requestedMb: m.slice?.unitMaxMb, sliceCeilingMb });
		// PER NODE HERE, per repo once the run is known — hoisted out of the literal
		// below because the warm reservation is measured in the same unit and must
		// be the same number, not a second estimate of it. `.from` rides along for
		// the generic admission verdict below — it is the same `reserveBasis` a
		// per-run `admitMint` call would have reserved against, absent a repo.
		const genericReserve = jobReserve({ nodeJobP95Mb: m.jobP95Mb, capMb });
		const requiredMb = genericReserve.mb;
		// THE REPO'S OWN ANSWER, BUT ONLY WHEN IT IS A PROVEN FLOOR (#76, scoped
		// 2026-10-02). `requiredMb` above is the node-level fallback every repo
		// has always reserved. Activating a repo's own `jobP95Mb` for EVERY
		// covered repo — not only the capped ones — would be a second, unasked
		// admission change: a repo measured ABOVE the node figure would newly
		// refuse a node it fits on today, and one measured BELOW it would newly
		// pack tighter than today. Neither is what #76 asked for — "Only a
		// reservation PROVEN to be a lower bound is raised" — so an ORDINARY
		// repo (measured or fleet-p95, `lowerBound` false) gets NO entry here at
		// all and `refusalFor` falls straight through to `requiredMb`, bit for
		// bit today's behaviour. Only a repo whose own capped runs proved a
		// floor is in this map, and even then the stored figure is the RAW
		// floor — `refusalFor` takes `max(requiredMb, floor)` at the point of
		// use, so the override can only RAISE the reservation, never lower it.
		const requiredMbByRepo = new Map<string, { mb: number; lowerBound: boolean }>();
		for (const repo of input.repos) {
			const r = jobReserve({
				repoReserve: repoReserves.get(repo),
				nodeJobP95Mb: m.jobP95Mb,
				capMb,
			});
			if (!r.lowerBound) continue;
			requiredMbByRepo.set(repo, { mb: r.mb, lowerBound: true });
		}
		// THE WARM RESERVATION — the other half of the warm placement decision
		// `dispatchWarmCache` made a few lines above, in the unit THIS pass spends.
		// A node the warm cache may place a listener on holds one slot of its
		// `maxConcurrent` back for it, because a listener is handed work by GitHub
		// without passing `admitMint` at all: the cap bound mints exactly (max 3
		// concurrent JIT units on claw-3 against `maxConcurrent: 3`) and was
		// exceeded only by the path it does not sit on (max 4 including the warm
		// listener, at 48 job starts in the 14 days to 2026-09-22).
		//
		// DERIVED FROM ELIGIBILITY, NOT FROM AN OBSERVATION OF THE SLOT, and that
		// is deliberate. `warmRepoByNode` — the affinity map read below — is empty
		// for the first 60 s after each of mgmt-api's ~5 daily restarts and drops
		// any node whose listing call failed; its own note says staleness there is
		// safe in ONE direction, because affinity only ever PREFERS a node. A
		// reservation read from it would be unsafe in precisely the other one: a
		// live listener with no slot held for it, after every restart. Eligibility
		// is measured fresh on this tick from the same `free -m` line, so it can
		// neither go stale nor read empty after a restart. What it costs is a slot
		// held on an eligible node whose listener is MISSING — and a cache that is
		// not filling is a fault `fleet check-warm-canary` already fails on, not a
		// state to size the thermal cap around.
		const warmListeners = warmListenersHeld({
			usableMb: sliceCeilingMb!,
			jobMb: requiredMb,
			role: m.role,
			maxConcurrent: m.maxConcurrent,
		});
		const ns: NodeState = {
			name,
			healthy: !input.isSick(name),
			// An operator holding this box out of service. Read HERE and passed
			// down, because placement.ts is pure on purpose — decisions there
			// must be assertable without a filesystem.
			drained: drainedNodes.has(name),
			drainedAs: drainRecords[name],
			// NODE-WIDE `placement: "excluded"` (reconcile-fleet-runners.mjs's own
			// `placementFor`/`mayRunRepo`: "the reconciler must not register here
			// at all"). Found while writing the placement-keys guard (#82's shape,
			// for a different key): nothing on the JIT path read this before —
			// `eligible` was hardcoded `true` for every node, so a node an operator
			// marked `excluded` from STANDING registration would still mint
			// EPHEMERAL ones, which is exactly the "two assignment paths disagree"
			// bug this wave's guard exists to catch. No manifest machine sets this
			// today (verified: neither `manifests/fleet-runner-manifest.json` nor
			// the production copy declares it), so this changes nothing live; it
			// closes the gap for the day one does.
			eligible: m.placement !== 'excluded',
			// THE MANIFEST'S PER-REPO REFUSALS, carried through verbatim (#82).
			// Read HERE, beside `drained` above, for the same reason: a `Map`
			// rather than the raw `Record` so `placement.ts` gets O(1) lookup, and
			// built fresh every tick rather than cached, so an operator editing
			// the manifest takes effect on the next tick like every other
			// manifest-sourced field here.
			excludedRepos: m.excludeRepos ? new Map(Object.entries(m.excludeRepos)) : undefined,
			// THE SPEED MODEL (#83), the SAME object for every node this tick —
			// see `getSpeedModel`'s own cadence note just above the loop.
			speedModel,
			// WHAT THIS NODE OFFERS, derived — not the manifest's declared array.
			// `placement.ts:287` refuses a node whose labels do not satisfy the
			// job, so the fleet breaks HERE, one step before the mint, if this
			// reads a stripped declaration. Substituted at this line rather than
			// inside `choosePlacement`: placement.ts is pure on purpose and is
			// handed a label list, exactly like `drained` above.
			labels: offerFor(input.nodes, name, workloadGate, eligibleFor(name)),
			// #15: placement keeps part of a backstop back from overflow work.
			onDemandBackstop: isBackstop(name),
			// P5.1 (`warm-listener-cache-2026-09-05.md`): "placement must gain
			// warm-affinity as a first-order term ahead of least-loaded". The term
			// shipped in `a6a19a4` and was INERT for five days and ~2,000 jobs
			// because this line did not exist and nothing anywhere ever assigned
			// `NodeState.warmRepo` — `warm-affinity-measured-2026-09-14.md` §3
			// proved it in source and in the deployed package. This is the FLEET
			// half of that wiring; the queued job's own repo is the other half,
			// supplied by `dispatcher.ts`'s `choosePlacement` call. Either one
			// missing makes both inert, which is why they were wired together.
			//
			// Read from the warm tick's last observation, which is GitHub's runner
			// listing rather than this process's fill/rotate bookkeeping — see
			// `warmRepoByNode` and `warmRegistration`. `undefined` for a node the
			// warm cache is not eligible for, has not reached yet, or could not
			// confirm; placement documents that as "falls through to plain
			// ordering", never as a reason to refuse the node.
			warmRepo: warmRepoByNode.get(name),
			liveUnits: 0,
			// Standing registrations GitHub can assign WITHOUT asking us. On a
			// node mid-migration this is non-zero and must count against the cap,
			// or the mint budget is computed against a fiction.
			//
			// JOBS, NOT DISTINCT REPOS (#102.1). This was
			// `[...p.busyRepos.values()].filter((n) => n > 0).length` — the COUNT
			// OF REPOS with at least one running worker, not the count of workers —
			// so three simultaneous cardtable Forge jobs on one claw read as
			// `standingBusy: 1`, and `TrafficNode.busy` (built from this same
			// field below) looked perfectly idle for the second and third job. The
			// tick already has the real count on the SAME probe line
			// (`ProbeResult.workers`, `fleet-loop.ts`) — no second probe.
			// `p.workers` absent (a caller that predates #102) falls back to the
			// old distinct-repo approximation rather than 0.
			standingBusy:
				p.workers ?? (p.busyRepos ? [...p.busyRepos.values()].filter((n) => n > 0).length : 0),
			// `p.workers` is EVERY Runner.Worker on the box — a JIT unit's and the
			// held warm listener's included. `dispatch-pass.ts` takes those back
			// out once it has listed the units; it needs the held count to do so.
			warmHeld: warmListeners,
			// GitHub cannot currently place a job here — see `NodeState.schedulable`'s
			// own doc for why `choosePlacement` needs this now that it re-ranks by
			// busy itself, rather than only trusting the order an already-schedulability-
			// aware `orderCandidates` produced upstream.
			schedulable: isSchedulable(name),
			// THE HEAVY MODEL (#102), the SAME object for every node this tick —
			// see `getHeavyModel`'s own cadence note, mirroring `speedModel` just
			// below.
			heavyModel,
			// THE OBSERVED INITIAL VALUE (#102.4): is this node CURRENTLY running a
			// job from a repo that runs heavy kinds? REPO-LEVEL ONLY — see
			// `HeavyModel.isHeavyRepo`'s own doc for why a running worker's exact
			// job name is not observable here without a new per-job read, and the
			// conservative direction that approximation takes. `planTick` RAISES
			// this to `true` on the SAME object as it places heavy jobs within the
			// tick; this is only the floor it starts from.
			runningHeavy:
				heavyModel !== undefined && p.busyRepos
					? [...p.busyRepos.entries()].some(([repo, n]) => n > 0 && heavyModel.isHeavyRepo(repo))
					: false,
			// ONE expression of the budget, shared with the fleet panel. See
			// `mintBudget`: this used to be the only copy, and the route's copy
			// disagreed with it.
			//
			// WHAT THE PANEL REPORTS IS STILL THE CEILING, and it is still true:
			// `routes/fleet` calls this with the manifest entry alone, so it prints
			// `maxConcurrent` — the bound on CONCURRENT WORK here, which the listener
			// is part of. What the dispatcher may MINT is that ceiling less the slots
			// held for listeners. The two numbers answer different questions; they do
			// not disagree.
			maxConcurrent: mintBudget({ maxConcurrent: m.maxConcurrent, warmListeners }).slots,
			freeMb: freeMbByNode.get(name) ?? 0,
			// The ESTIMATE, not the cap. Reserving unitMaxMb per job made claw-1
			// admit ONE concurrent mint at 10GB free, which is how 13 jobs sat
			// queued on 2026-09-01 while dispatch logged 'no node can take this
			// job right now'. MemoryMax still caps the unit at unitMaxMb.
			//
			// CLAMPED to the cap. The estimate is operator-edited; the cap is what
			// the kernel enforces. A jobP95Mb above the cap would admit work the
			// unit is then OOM-killed for - a reservation promising room the job is
			// not permitted to use. Min() lets the two disagree only safely.
			//
			// THE FALLBACK IS NO LONGER THE CAP (2026-09-14). It was
			// `jobP95Mb ?? unitMaxMb`, which read as one number because the two
			// happened to be the same 4096. The cap is now this node's slice
			// ceiling, and reserving ~13.8 GB for an unmeasured job would admit ONE
			// mint and queue the rest — the 2026-09-01 shape this very comment was
			// written about. An unmeasured job reserves JOB_RESERVE_DEFAULT_MB; the
			// clamp still holds, it is simply no longer doing the work.
			//
			// PER NODE HERE, per repo once the run is known: this is the answer for
			// a job whose repo has no figure (`jobReserve`'s `node`/`default`). The
			// queued run's own figure is `jobReserve` with its `repoReserve`, read
			// via `requiredMbByRepo` below.
			requiredMb,
			// A shared hosting slice's unused share is held back on top of the floor,
			// so no job is admitted into memory the tenant was promised.
			minFreeMb: (m.minFreeMb ?? 1536) + (heldBackMbByNode.get(name) ?? 0),
			// #76: `refusalFor` (placement.ts) looks this up by the queued job's
			// repo and overrides `requiredMb`/`requiredIsLowerBound` with it when
			// present. A repo not in the map (never measured) leaves `requiredMb`
			// above untouched.
			requiredMbByRepo,
			// #76: what `admitMint`'s placement clause compares a lower-bound
			// `requiredMb` against — this node's own ceiling, the same number
			// `capMb` above was derived from.
			sliceCeilingMb,
			// #101: ALWAYS a number or `null` here, never left `undefined` — the
			// probe above sets both maps for every node in `input.ephemeral`
			// unconditionally, so `.get(name)` is never missing for a node that
			// reaches this point. `undefined` is reserved for callers with no
			// node to probe at all (`prove-job.ts`).
			tmpFreeMb: tmpFreeMbByNode.get(name) ?? null,
			workFreeMb: workFreeMbByNode.get(name) ?? null,
		};
		nodes.push(ns);
		// THE GENERIC VERDICT (wave 4a §A.1, #100) — `admitMint` run on the SAME
		// `ns` placement just built, before any queued run is known. See
		// `admissionVerdictFor`'s own docblock for why this is display and not a
		// second gate.
		// Charged as the dispatcher charged it, when its ledger is fresh — see
		// `chargedLikeDispatch`. Display only: `ns` itself goes to placement as is.
		const verdict = admissionVerdictFor(
			chargedLikeDispatch(name, ns, getCapacityLedger()),
			genericReserve.from
		);
		nextVerdicts.set(name, verdict);
		// #101: LOGGED ON CHANGE, not every 15 s tick — the probe above already
		// logs once per process lifetime; this catches a node crossing the
		// floor in either direction afterwards. grep: "space verdict".
		{
			const wasSpace = (() => {
				const prev = prevVerdicts.get(name);
				return !!prev && !prev.ok && prev.clause === 'space';
			})();
			const isSpace = !verdict.ok && verdict.clause === 'space';
			if (wasSpace !== isSpace) {
				logger.info(
					`[ephemeral-tick] space verdict change ${name}: tmpFree=${ns.tmpFreeMb ?? 'unreadable'}MB ` +
						`(floor ${TMP_FREE_FLOOR_MB}MB), _workFree=${ns.workFreeMb ?? 'unreadable'}MB ` +
						`(floor ${WORK_FREE_FLOOR_MB}MB) -> ${isSpace ? 'REFUSED' : 'admitted'}`
				);
			}
		}
	}
	return { nodes, candidates, nextVerdicts };
}
