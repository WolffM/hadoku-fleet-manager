/**
 * The `GET /fleet` join itself — `buildFleetReport` and its two small wire
 * helpers — a pure move out of `routes/fleet.ts` (wave 5r lane A), split off
 * because that module crossed the 800-line source ceiling. `routes/fleet.ts`
 * re-exports `buildFleetReport` for every existing importer (the route
 * handler, `capacity-sample.ts`, and every `fleet-report-*.test.ts`), so
 * nothing downstream changes by a path.
 *
 * See `routes/fleet.ts`'s own header for WHY this route probes nothing: both
 * snapshots `buildFleetReport` reads by default are already-ticking module
 * state, injected here only so a test never drives the real loops.
 */
import { getRunnerHealthSnapshot, type RunnerHealthSnapshot } from '../runner-health.js';
import { getDispatchSnapshot, getFleetProbeSnapshot } from '../fleet-loop.js';
import { getReservationSnapshot } from '../fleet-loop.js';
import { type NodeProbe } from '../lib/node-probe.js';
import { summarise, type JobHistorySummary } from '../job-history-stats.js';
import { ephemeralState } from '../runners/claw-state.js';
import { isBackstopHeld } from '../runners/backstop-hold.js';
import { mintsOnDemand } from '../lib/node-role.js';
import { mintableCapacity } from '../runners/census.js';
import { BUILDER_LABEL } from '../lib/capability-registry.js';
import { bootcampFacet } from '../lib/bootcamp-proof.js';
import { workloadGateContext, workloadGateReasons } from '../lib/workload-gate.js';
import { type ProofRecord } from '../lib/measured.js';
import { getGhBudgetSnapshot } from '../gh-budget.js';
import { getCapacityLedger } from '../runners/capacity-ledger.js';
import { admissionVerdictsForReport } from '../runners/ephemeral-tick.js';
import { getDispatchAffinitySnapshot } from '../runners/dispatch-pass.js';
import { getDispatchQueueSnapshot } from '../runners/dispatch-tick.js';
import { coveredRepos } from '../ci-runner-fallback.js';
import { dispatchForDay, readDispatchDaily } from '../runners/dispatch-daily.js';
import type {
	AdmissionCaveat,
	CapacitySlice,
	ClawState,
	FleetMachine,
	FleetMachineLedger,
	FleetMachineMeasured,
	FleetWorkloadProof,
	FleetReport,
} from '../fleet-report-types.js';
import { backstopNodeOf, requireManifestNodes, type ManifestNode } from './fleet-manifest.js';
import { admission, forcedForReport } from './fleet-admission.js';
import { buildVocabulary } from './fleet-vocabulary.js';
import { loadWorkloadGateInputs } from './fleet-workload.js';

/** Shape of the raw probe `fleet-loop.getFleetProbeSnapshot()` returns. */
interface FleetProbeSnapshot {
	at: string;
	nodes: Record<string, NodeProbe>;
}

/**
 * The join itself, separated from the route so it is testable without an HTTP
 * layer — same split as buildLocalSitrep. Both snapshots are INJECTABLE: they
 * are module state on two different long-running loops, and a test that had to
 * drive those loops to assert a rendering contract would be testing the loops.
 */
export function buildFleetReport(
	health: RunnerHealthSnapshot | null = getRunnerHealthSnapshot(),
	probe: FleetProbeSnapshot | null = getFleetProbeSnapshot(),
	manifest: Record<string, ManifestNode> = requireManifestNodes(),
	// `Object.keys(manifest)`, NOT a second `loadManifestNodes()` call. A
	// default parameter may reference the ones declared before it, and this one
	// must: `summarise` folds JIT runner names onto nodes with `nodeOf`,
	// which needs the node LIST. Re-reading the file here meant an injected
	// manifest reached the `machines` half of the report and the REAL manifest
	// reached the `jobs` half — two halves describing different fleets, which is
	// exactly the shape a caller injecting a manifest is trying to avoid. It also
	// cost every `GET /fleet` a second readFileSync + JSON.parse of the same file.
	// `backstopNodeOf(manifest)`, NOT summarise's own `'hokon'` default. The
	// default was the fifth copy of that name, and it is the one that decides
	// `backstopJobs` — so a fleet whose pm2-host moved would have gone on
	// reporting the old box's builder work as "the backstop stepping in", and
	// the new box's as ordinary claw work, silently and in both directions.
	//
	// THE CLOCK IS SUMMARISE'S OWN DEFAULT, AND THAT IS THE POINT. `byMachine`
	// now carries a trailing one-hour p50/p95 beside the 14-day baseline, and a
	// trailing window is only meaningful relative to when it was cut. Leaving
	// `summarise`'s `now` defaulted means the hour reported by `GET /fleet` is
	// the hour up to THIS REQUEST — this route probes nothing and joins what is
	// already in memory, so the window costs one pass over the window and moves
	// with the operator rather than with the last tick. Both ends of it travel
	// as `jobs.recentSince` / `jobs.recentWindowSec` so no reader has to guess.
	jobs: JobHistorySummary = summarise(Object.keys(manifest), backstopNodeOf(manifest) ?? undefined),
	// WAVE 4E (#102): see `loadWorkloadGateInputs`'s own doc. Injectable so a
	// test never touches a real state dir, the same reason every snapshot
	// above is.
	workloadGateInputs: {
		proofsByCapability: Record<string, ProofRecord[]>;
		corrupt: boolean;
	} = loadWorkloadGateInputs(),
	dispatchDaily: ReturnType<typeof readDispatchDaily> = readDispatchDaily(),
	// The SAME repo list the dispatcher polls (fleet-loop hands it `coveredRepos()`),
	// so `unread` counts repos it was asked to watch, not a second roster.
	dispatchQueue: FleetReport['dispatch']['queue'] = getDispatchQueueSnapshot(coveredRepos())
): Omit<FleetReport, 'success'> {
	const names = [...new Set([...Object.keys(manifest), ...Object.keys(probe?.nodes ?? {})])];
	const workloadGateInput = workloadGateContext(names, workloadGateInputs.proofsByCapability, {
		corrupt: workloadGateInputs.corrupt,
	});
	const live = health?.runner_state ?? [];
	const vocabulary = buildVocabulary(manifest);
	// A HELD ON-DEMAND BACKSTOP IS MINTABLE, whatever the census says. The census
	// reads the runner listing, and a backstop's one standing registration is a
	// deploy runner the backstop never labels `hadoku-builder` (#120) — so it
	// wrote `demoted` for hokon on every tick since 2026-10-19, promoted or not.
	// On 2026-10-25 the panel showed hokon demoted beside 13 queued jobs while
	// the dispatcher was minting onto it. The hold is this process's own record
	// of the promotion, read here at request time like the probe is; an
	// unheld backstop keeps the census's word, which is correct for it.
	const stateOf = (name: string, m: ManifestNode, p: NodeProbe | undefined): ClawState | null => {
		if (m.ephemeral || (mintsOnDemand(m) && isBackstopHeld(name))) return ephemeralState(p);
		return health?.claw_state?.[name] ?? null;
	};

	// RE-BASE THE MINTABLE HALF ONTO THE FRESH PROBE.
	//
	// Same fix as `machines[].state` below, one level up, and for the same
	// reason. Every claw-capacity figure runner-health publishes is
	// `standing + mintable`, and the mintable addend is a pure function of the
	// ssh probe — which the health tick reads at 10-minute granularity and this
	// route holds at 60-second granularity.
	//
	// Under all-JIT that addend is the WHOLE fleet. runner-health's first tick
	// lands ~20s after a restart, before the fast loop's first probe, so for up
	// to ten minutes after every deploy the panel rendered six reachable claws
	// with nine free mint slots as "0 standing · 0 mintable", in red, with eight
	// jobs queued. Measured 2026-09-02 15:34:19 against a 15:36:09 probe.
	//
	// 8762ea36 fixed the half that ACTS on this — the backstop now holds through
	// the blind window instead of promoting the production host. This is the half
	// that DISPLAYS it, and a display can do better than hold: it can look again.
	//
	// The standing half stays the census's. It depends on the runner LISTING,
	// which only that loop holds, so re-deriving it here is not possible and not
	// wanted — a panel showing a fresher probe beside a 10-minute-old listing is
	// exactly what the two timestamps in the header are for.
	const freshMint = mintableCapacity(
		new Set(
			Object.entries(manifest)
				.filter(([, m]) => m.ephemeral)
				.map(([n]) => n)
		),
		probe
	);
	// `claws_mintable_online` is subtracted back out so the standing half can be
	// recovered from a sum. Both come from the SAME tick, so the subtraction is
	// exact; `?? null` keeps an un-ticked health loop reporting null rather than
	// arithmetic on undefined.
	const standingOnline =
		health?.clawsOnline === undefined || health.claws_mintable_online === undefined
			? null
			: health.clawsOnline - health.claws_mintable_online;
	const clawsOnline =
		freshMint === null || standingOnline === null
			? (health?.clawsOnline ?? null)
			: standingOnline + freshMint.online;
	// MACHINES ready, re-based the same way. This is the number the panel leads
	// with: `clawsOnline` counts boxes that are UP (a saturated fleet is fully
	// online) and `clawsFree` counts SLOTS, which on an all-JIT fleet is larger
	// than the fleet itself and reads as a mistake.
	const clawsReady =
		freshMint === null || health?.claws_ready_standing === undefined
			? (health?.claws_ready ?? null)
			: health.claws_ready_standing + freshMint.ready;
	const clawsFreeStanding = health?.claws_free_standing ?? null;
	// SLOTS that could actually start a job, against the dispatcher's budget —
	// not the ladder's. Display-only: `clawsFree` below still carries the census
	// sum, and the backstop reads the census directly rather than this payload,
	// so nothing about scheduling moves.
	const ephemeralAdmissions = probe
		? Object.entries(manifest)
				.filter(([, m]) => m.ephemeral)
				.map(([name, m]) => admission(m, probe.nodes[name]))
		: null;
	const mintableAdmission =
		ephemeralAdmissions === null
			? null
			: ephemeralAdmissions.reduce((n, a) => n + (a.admissionFree ?? 0), 0);
	// WHAT THE SUM ABOVE CANNOT SAY. `?? 0` is load-bearing there — a partial
	// reading beats no reading, and an unreachable node genuinely contributes no
	// slot anyone can use right now. What it must not do is disappear: a fleet
	// with three dark claws and a fleet with three busy ones produce the same
	// integer, and they are the two different emergencies this payload exists to
	// keep apart.
	const mintableCaveats: Partial<Record<AdmissionCaveat, number>> = {};
	for (const a of ephemeralAdmissions ?? []) {
		if (a.admissionCaveat === null) continue;
		mintableCaveats[a.admissionCaveat] = (mintableCaveats[a.admissionCaveat] ?? 0) + 1;
	}
	const clawsFreeMintable = freshMint === null ? null : (mintableAdmission ?? freshMint.free);
	// THE BREAKDOWN, BY WHAT HAS TO HAPPEN FIRST — see `FleetCapacity`.
	//
	// The rows are DATA. A fourth way of becoming available is a
	// row here and a term in the registry, not a new wire key and a rename in
	// another repo.
	//
	const byKind: CapacitySlice[] = [
		{ kind: 'immediate', free: clawsFreeStanding, caveats: {}, available: true },
		{ kind: 'mintable', free: clawsFreeMintable, caveats: mintableCaveats, available: true },
	];
	// Summed HERE, over the rows that declare themselves available, so no reader
	// has to know which those are. A `null` row makes the total `null`: a partial
	// sum presented as a total is the same lie as `?? 0` was one level down.
	//
	// The census's own sum is the fallback, NOT zero, so the two agree on what
	// "free" means even when the re-based rows are unavailable.
	const countable = byKind.filter((k) => k.available);
	const capacityFree = countable.some((k) => k.free === null)
		? (health?.claws_free ?? null)
		: countable.reduce((n, k) => n + (k.free ?? 0), 0);

	// WAVE 4A (#100): the generic admission verdict `ephemeral-tick.ts` records
	// per pass, read once for the whole node list rather than once per node.
	// JIT-only — `admitMint` never runs for a standing node, so a standing
	// node's entry (if any leaked in) is never consulted below.
	const admissionVerdicts = admissionVerdictsForReport();
	const capLedger = getCapacityLedger();
	const ledgerByNode = new Map<string, FleetMachineLedger>(
		(capLedger?.nodes ?? []).map((e) => [
			e.node,
			{
				at: capLedger!.at,
				liveUnits: e.liveUnits,
				probeWorkers: e.probeWorkers,
				standingBusy: e.standingBusy,
				warmHeld: e.warmHeld,
				budget: e.budget,
				inFlight: e.inFlight,
				ok: e.ok,
				why: e.why,
			},
		])
	);
	const nodes = names.map((name) => {
		const m = manifest[name] ?? {};
		const p = probe?.nodes[name];
		// `undefined` (KEY OMITTED below) on a STANDING node, or on an EPHEMERAL
		// node this process has not looked at yet this tick — "could not look",
		// never "admitted". See `FleetMachine.admissionRefusal`'s own doc
		// comment for why the key itself, not a `null` value, is what has to
		// carry that: lane B's `fleet traffic` already reads an absent key as
		// "unknown" and a present `null` as "admitted", and those are different
		// claims about the SAME node.
		const verdict = m.ephemeral ? admissionVerdicts.get(name) : undefined;
		// A SPREADABLE PARTIAL, never a bare `admissionRefusal: undefined` —
		// assigning `undefined` leaves the key present (`'admissionRefusal' in
		// obj` is still `true`), which is exactly the collapse this field
		// exists to avoid. Spreading `{}` is the one way to omit a key from an
		// object literal conditionally.
		const admissionRefusalField: Pick<FleetMachine, 'admissionRefusal'> | Record<string, never> =
			verdict === undefined
				? {}
				: {
						admissionRefusal: verdict.ok
							? null
							: {
									clause: verdict.clause,
									availableMb: verdict.availableMb,
									needMb: verdict.needMb,
									// #101: KEY OMITTED, not `filesystem: undefined` — same
									// reason as `admissionRefusalField` itself just above:
									// an object literal with the key present-as-`undefined`
									// is not deep-equal to one that omits it, and this is
									// only meaningful for `clause === 'space'` anyway.
									...(verdict.filesystem ? { filesystem: verdict.filesystem } : {}),
									...(verdict.unreadable ? { unreadable: true as const } : {}),
									reserveBasis: verdict.reserveBasis,
									reason: verdict.reason,
								},
					};
		// Every runner registration BELONGING to this node (hokon-tenhands is
		// hokon's), so eligibility is reported for the box, not one registration.
		const mine = live.filter((r) => r.name === name || r.name.startsWith(`${name}-`));
		const liveLabels = [...new Set(mine.flatMap((r) => r.labels))].sort();
		// `p` absent ⇒ never probed ⇒ null, NOT zero. `p.reachable === false`
		// ⇒ probed and down, which is also null for the load figures (we have no
		// reading) but `reachable: false` rather than `null`. Those are three
		// distinct states and the UI colours them differently.
		return {
			name,
			cores: p?.cores || m.cores || null,
			ramGb: m.ramGb ?? null,
			labels: m.labels ?? [],
			maxRegistrations: m.maxRegistrations ?? null,
			maxConcurrent: m.maxConcurrent ?? null,
			excludedRepos: Object.keys(m.excludeRepos ?? {}),
			reachable: p ? p.reachable : null,
			workers: p?.reachable ? p.workers : null,
			capacity: p?.reachable ? p.capacity : null,
			free: p?.reachable ? p.free : null,
			// LIVE eligibility, distinct from declared capability above. The panel
			// used to render `labels` under a "Capabilities" heading, which meant a
			// promoted hokon could never be shown carrying `hadoku-builder`.
			liveLabels: mine.length ? liveLabels : null,
			eligible: mine.length ? liveLabels.includes(BUILDER_LABEL) : null,
			runnersBusy: mine.length ? mine.filter((r) => r.busy).length : null,
			runnersOnline: mine.length ? mine.filter((r) => r.status === 'online').length : null,
			// free | busy | demoted | offline | absent | mintable | unreachable |
			// sick — one word for what this node is doing. `eligible` above says
			// only whether a label is present; it cannot distinguish "demoted"
			// from "not registered here".
			//
			// AN EPHEMERAL NODE IS ANSWERED HERE, NOT READ FROM THE CENSUS. It
			// holds no standing registration, so its state is a pure function of
			// the probe (census.ephemeralState) and the census's copy is that
			// same function applied on a 10-MINUTE tick. Reading it back put
			// `state: 'unreachable'` in the Scheduling column of a row whose own
			// `reachable: true, workers: 2` came from the 60-second probe beside
			// it — one measurement contradicting a stale photograph of itself.
			//
			// Standing nodes still come from the census: their state depends on
			// the runner LISTING, which only that loop holds.
			// The budget that actually admits work here — maxConcurrent for an
			// ephemeral node (what `admitMint` tests), tierCapacity for a standing
			// one (what the ladder's slot maths tests). See FleetMachine.
			//
			// Clamped at 0: `workers` can exceed a budget that was lowered while
			// jobs were running, and a negative "free" renders as a bar running
			// backwards.
			...admission(m, p),
			state: stateOf(name, m, p),
			ephemeral: m.ephemeral === true,
			...admissionRefusalField,
			// The DISPATCHER's own in-flight number for this node, with its
			// invariant verdict — `capacity-ledger.ts`. `null` when this process
			// has run no pass or the node was not in the last one.
			dispatchLedger: ledgerByNode.get(name) ?? null,
			// `runner-health.ts`'s own finding, keyed by node — never re-derived
			// here. `false` for a name `getRunnerHealthSnapshot` never named
			// (never ticked a verdict for it, or it is standing/hokon).
			starved: health?.starved?.[name] ?? false,
			// WAVE 4E (#102): one entry per workload-gated capability this node's
			// TOOL proof has EARNED, with the gate's reason, visible — "the reason
			// is visible... never a silent absence" (wave4e Settled). Empty for a
			// node that has not earned any gated capability's tool, which is not
			// the same as an empty object meaning "clean": `nodeOffer` itself is
			// the authority on what is actually routed; this is why a label a node
			// carries is, or is not, among the ones it offers.
			workloadGates: workloadGateReasons(
				m as unknown as Parameters<typeof workloadGateReasons>[0],
				workloadGateInput.byNode[name] ?? {},
				workloadGateInput.provenCounts
			),
			workloadProofs: Object.fromEntries(
				Object.entries(workloadGateInput.byNode[name] ?? {}).map(([cap, rec]) => [
					cap,
					rec ? withoutKey(rec) : null,
				])
			),
			// `null` — never `{}` — for a node bootcamp has never reached.
			capabilities: bootcampFacet({ $capabilities: m.$capabilities }),
			measured: trimMeasured(m.$measured),
			os: p?.reachable ? (p.os ?? null) : null,
		};
	});

	return {
		probedAt: probe?.at ?? null,
		healthAt: health?.at ?? null,
		// WIRE KEY. The payload says `machines`; the value is the node list built
		// above. See docs/VOCABULARY.md §"Where the rename stops".
		machines: nodes,
		fleet: {
			runnersOnline: health?.online ?? null,
			runnersOffline: health?.offline ?? null,
			clawsOnline,
			capacity: {
				ready: clawsReady,
				free: capacityFree,
				byKind,
				// A `null` row anywhere is UNMEASURED, not zero — but this flag is
				// the fleet-wide statement of it: no probe since the last restart,
				// so every figure above is a floor.
				unmeasured: freshMint === null,
			},
			// Per-node, because a count cannot be diagnosed. `demoted`,
			// `offline` and `absent` all render as a smaller clawsOnline and have
			// three different fixes.
			// The census's map, with every held on-demand backstop re-read the way
			// `machines[].state` is — two answers for one node in one payload is
			// the bug `stateOf` exists to end.
			// A null answer OMITS the key, as the census does for "not looked at".
			clawState: health?.claw_state
				? Object.fromEntries(
						Object.entries(health.claw_state).flatMap(([n, st]) => {
							if (!(mintsOnDemand(manifest[n]) && isBackstopHeld(n))) return [[n, st]];
							const fresh = ephemeralState(probe?.nodes[n]);
							return fresh ? [[n, fresh]] : [];
						})
					)
				: null,
			backstopReason: health?.backstop_reason ?? null,
			backstopForced: forcedForReport(),
			queuedNow: health?.queued_now ?? null,
			runningNow: health?.running_now ?? null,
			oldestQueuedMin: health?.oldest_queued_min ?? null,
			longestRunningMin: health?.longest_running_min ?? null,
			queuedStale: health?.queuedStale ?? null,
			hung: health?.inprogressStale ?? null,
			failoverReruns: health?.failoverReruns ?? null,
			oomReruns: health?.oomReruns ?? null,
			pm2HostBusy: health?.pm2_host_busy ?? null,
		},
		// The priority ladder: pm2-host > hadoku-builder > taskauto. Surfaced so
		// "hokon is idle while CI queues" reads as a DECISION rather than a fault.
		reservation: getReservationSnapshot(),
		// `affinity` is counted by the pass itself, not folded by the fast loop —
		// so it is spread on here rather than widening `recordDispatch`'s input.
		dispatch: {
			...getDispatchSnapshot(),
			affinity: getDispatchAffinitySnapshot(),
			queue: dispatchQueue,
		},
		githubBudget: getGhBudgetSnapshot(),
		vocabulary,
		jobs: {
			...jobs,
			daily: jobs.daily.map((d) => ({ ...d, dispatch: dispatchForDay(dispatchDaily, d.day) })),
		},
	};
}

/** A proof record minus the (node, capability) it is already keyed by on the wire. */
function withoutKey(rec: ProofRecord): FleetWorkloadProof {
	return {
		runId: rec.runId,
		runner: rec.runner,
		conclusion: rec.conclusion,
		durationSec: rec.durationSec,
		budgetSec: rec.budgetSec,
		evidenceMatched: rec.evidenceMatched,
		verdict: rec.verdict,
		why: rec.why,
		at: rec.at,
	};
}

/** `$measured`, trimmed to the hardware/OS fields the panel shows; `null` when absent. */
function trimMeasured(raw: unknown): FleetMachineMeasured | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
	const num = (v: unknown): number | null =>
		typeof v === 'number' && Number.isFinite(v) ? v : null;
	return {
		at: str(r.at),
		memTotalMb: num(r.memTotalMb),
		diskFreeGb: num(r.diskFreeGb),
		diskModel: str(r.diskModel),
		kernel: str(r.kernel),
		osCodename: str(r.osCodename),
		verified: typeof r.verified === 'boolean' ? r.verified : null,
	};
}
