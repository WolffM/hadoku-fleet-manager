/**
 * Fleet route — one read-only view of the CI fleet for the command station.
 *
 * `GET /api/fleet` rides the general `/mgmt/*` proxy in edge-router, so it needs
 * no scoped edge mount: the cookie resolves to a key, the key is stamped as a
 * tier, and the edgeOriginGuard in index.ts covers all of `/api/*`. Same shape
 * as GET /api/local-sitrep.
 *
 * WHY IT PROBES NOTHING
 * ---------------------
 * Every number here is already in memory. The fast loop ssh's each node once
 * a minute and now keeps the raw probe (fleet-loop.getFleetProbeSnapshot);
 * runner-health polls GitHub every ten and keeps its own snapshot. A dashboard
 * that opened its own ssh or GitHub call per HTTP request would add fleet load
 * proportional to how often someone is WATCHING the fleet, which is exactly
 * backwards — the operator is most likely to be watching during an incident.
 *
 * So this endpoint is a join, not a collector. It is cheap enough to poll, and
 * its staleness is bounded by the two loops (60s / 10m) rather than by itself.
 * `null` for either half means "that loop has not ticked since the last restart"
 * — reported as such rather than rendered as zeroes, because a fleet showing 0
 * free slots and a fleet we have not looked at yet must not look identical.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';

import {
	QUEUED_WARN_MINUTES,
	SELF_REPO,
	getRunnerHealthSnapshot,
	type RunnerHealthSnapshot,
} from '../runner-health.js';
import {
	getDispatchSnapshot,
	getFleetProbeSnapshot,
	getReservationSnapshot,
	type NodeProbe,
} from '../fleet-loop.js';
import {
	backfillFailedSteps,
	summarise,
	type GhJob,
	type JobHistorySummary,
} from '../job-history.js';
import { ephemeralState } from '../runners/claw-state.js';
import { isBackstopHeld } from '../runners/backstop-hold.js';
import { mintsOnDemand } from '../lib/node-role.js';
import { mintableCapacity } from '../runners/census.js';
import {
	BACKSTOP_LABEL,
	BOOTCAMP_STALE_DAYS,
	BUILDER_LABEL,
	CAPABILITIES,
	IMPLICIT_LABELS,
	PM2_HOST_LABEL,
	labelCapabilities,
	bootcampFacet,
	ladder,
	workloadGateContext,
	workloadGateReasons,
	workloadGatedCapabilities,
} from '../capabilities.js';
import { proofFileStatus, readProofsForCapability, type ProofRecord } from '../lib/measured.js';
import { githubToken, logger, stateDir } from '../host.js';
import { readManifestState } from '../lib/manifest.js';
import { packageVersion } from '../lib/provenance.js';
import { recordRouteHit } from '../lib/usage-log.js';
import { getGhBudgetSnapshot, withGhCaller } from '../gh-budget.js';
import { ghFetchRaw } from '../lib/github-client.js';
import { userAgent } from '../lib/fleet-config.js';
import { loadTargets, readStates, stateKey } from '../ci-alerts.js';
import { mintBudget } from '../runners/ephemeral.js';
import { activeForces, readForce } from '../runners/backstop-force.js';
import { getCapacityLedger } from '../runners/capacity-ledger.js';
import { admissionVerdictsForReport } from '../runners/ephemeral-tick.js';
import { getDispatchAffinitySnapshot } from '../runners/dispatch-pass.js';
import { getDispatchQueueSnapshot } from '../runners/dispatch-tick.js';
import { coveredRepos } from '../ci-runner-fallback.js';
import { dispatchForDay, readDispatchDaily } from '../runners/dispatch-daily.js';
import {
	ADMISSION_BASES,
	ADMISSION_CAVEATS,
	ADMISSION_CLAUSES,
	BACKSTOP_REASONS,
	CAPABILITY_SURFACES,
	CAPABILITY_VERIFICATIONS,
	CAPACITY_KINDS,
	GH_CALLERS,
	CLAW_STATES,
	FAILURE_ZONES,
} from '../telemetry-vocabulary.js';
import type {
	AdmissionBasis,
	AdmissionCaveat,
	CapacitySlice,
	ClawState,
	FleetMachine,
	FleetMachineLedger,
	FleetMachineMeasured,
	FleetWorkloadProof,
	FleetReport,
	FleetVocabulary,
	JobPhase,
} from '../fleet-report-types.js';

/** Shape of the raw probe `fleet-loop.getFleetProbeSnapshot()` returns. */
interface FleetProbeSnapshot {
	at: string;
	nodes: Record<string, NodeProbe>;
}

/** Static per-node facts. The manifest is the single source for placement. */
interface ManifestNode {
	cores?: number;
	ramGb?: number;
	labels?: string[];
	maxRegistrations?: number;
	maxConcurrent?: number;
	tierCapacity?: number;
	placement?: string;
	excludeRepos?: Record<string, string>;
	/** This node mints a runner per job and holds no standing registration. */
	ephemeral?: boolean;
	/** `guest` + `mint: 'on-demand'` — read through `mintsOnDemand`, never directly. */
	role?: unknown;
	mint?: unknown;
	/** Bootcamp's record — read through `bootcampFacet`, never directly. */
	$capabilities?: unknown;
	/** Onboarding's hardware/OS measurement — read through `trimMeasured`. */
	$measured?: unknown;
}

/**
 * `null` is "I could not look" — AGENTS.md: never conflated with an empty
 * fleet. This one was missed when the component moved out of mgmt-api on
 * 2026-08-30 (two `__dirname`-relative candidates that resolve, from inside
 * node_modules, to paths that do not exist) and failed exactly the way the
 * extraction was warned about: SOFTLY. The catch returned `{}`, the route
 * answered 200, and the command station's Machines table rendered em dashes
 * in five of seven columns while looking like a working dashboard. Worse,
 * `summarise()` is called with `Object.keys()` of this map, so an empty one
 * robs `nodeOf` of the node list and every JIT runner becomes its own node —
 * 36 rows for a four-node fleet, and an understated backstopShare.
 *
 * NAMED, NOT FIXED, IN WAVE 5C (lane A, F1); FIXED HERE (wave 5d, lane A, F
 * "routes/fleet loadManifestNodes"). The directory-resolution failure above
 * is now a genuine `{}` only through this function's own return — the
 * narrower case (the directory resolves but the FILE does not read or
 * parse) now returns `null` instead of swallowing it into `{}`.
 * `requireManifestNodes()` below is `buildFleetReport`'s own door onto this:
 * it throws the moment the read fails, so every one of `buildFleetReport`'s
 * LATER default parameters and every read of `manifest` in its body keeps
 * assuming a real object — `admission`, `buildVocabulary` and `stateOf`
 * never observe a null manifest at all, because the throw lands before any
 * of them is called.
 */
function loadManifestNodes(): Record<string, ManifestNode> | null {
	const result = readManifestState();
	if (!result.ok) {
		// Reported, never swallowed — the silent `{}` is what hid this for a day.
		logger.error(`[fleet] cannot read the node manifest: ${result.why}`);
		return null;
	}
	return (result.doc.machines as Record<string, ManifestNode> | undefined) ?? {};
}

/** Thrown by {@link requireManifestNodes}; the route answers 503 for it, not 500. */
class ManifestUnreadableError extends Error {}

/**
 * `loadManifestNodes()`, or a thrown, named error when the manifest could not
 * be read — see that function's own doc. `buildFleetReport` uses this as
 * `manifest`'s default so a could-not-look never reaches `Object.keys()`,
 * `Object.entries()` or an index read as an empty/zero-node fleet.
 */
function requireManifestNodes(): Record<string, ManifestNode> {
	const nodes = loadManifestNodes();
	if (nodes === null) {
		throw new ManifestUnreadableError(
			'cannot read the node manifest — see the preceding [fleet] log line for why'
		);
	}
	return nodes;
}

/**
 * The node the backstop promotes when the claws cannot cope.
 *
 * DERIVED: it is the box the manifest gives `pm2-host` to. The literal `'hokon'`
 * was a default parameter in `job-history.summarise`, a `RESERVABLE_NODES` set
 * in the retired tier ladder, a `const BACKSTOP` in the command station's charts and two
 * sentences of its prose — four repos-worth of a name that the manifest already
 * states once, structurally.
 *
 * `null` rather than a guess when no node declares the label: a fleet with no
 * backstop is a real (bad) state, and inventing a name for it would make the
 * panel claim a machine is standing by that is not.
 */
/**
 * The green light, for the panel. `null` is "could not read the switch file",
 * never "off" — a corrupt switch rendered as nothing forced is the same
 * collapse this report refuses everywhere else.
 */
function forcedForReport(): FleetReport['fleet']['backstopForced'] {
	try {
		return activeForces(readForce()).map((f) => ({
			node: f.node,
			since: f.record.since,
			until: f.record.until,
			remainingMin: f.remainingMin,
			reason: f.record.reason,
			by: f.record.by,
		}));
	} catch {
		return null;
	}
}

function backstopNodeOf(nodes: Record<string, ManifestNode>): string | null {
	const carriers = Object.entries(nodes)
		.filter(([, m]) => (m.labels ?? []).includes(PM2_HOST_LABEL))
		.map(([name]) => name);
	return carriers[0] ?? null;
}

/**
 * Free capacity against the budget that really gates this node.
 *
 * Two different questions wear the word "capacity" in this payload, and the
 * panel has now printed the wrong one twice. See `FleetMachine.admissionFree`
 * for which is which and why the ladder's own numbers are left alone.
 */
function admission(
	m: ManifestNode,
	p: NodeProbe | undefined
): {
	admissionCapacity: number | null;
	admissionFree: number | null;
	admissionBasis: AdmissionBasis | null;
	admissionCaveat: AdmissionCaveat | null;
} {
	if (!p?.reachable) {
		// UNKNOWN, and it has to survive as unknown all the way to the rollup.
		// `admissionCaveat` is what carries it: the two nulls below are
		// indistinguishable from a node with no room once anything sums them.
		return {
			admissionCapacity: null,
			admissionFree: null,
			admissionBasis: null,
			admissionCaveat: 'unreachable',
		};
	}
	if (m.ephemeral) {
		// The DISPATCHER's budget, from the dispatcher's own function — see
		// `mintBudget`. Reading `m.maxConcurrent` directly here is what let this
		// report `null` for a node `ephemeral-tick` was actively minting on,
		// because the tick falls back and this did not.
		const budget = mintBudget(m);
		return {
			admissionCapacity: budget.slots,
			admissionFree: Math.max(0, budget.slots - p.workers),
			admissionBasis: 'dispatcher',
			admissionCaveat: budget.basis === 'declared' ? null : 'undeclared',
		};
	}
	return {
		admissionCapacity: p.capacity,
		admissionFree: p.free,
		admissionBasis: 'standing',
		admissionCaveat: null,
	};
}

/**
 * The segments of a job's wall time, in order, with the fleet's own words.
 *
 * DECLARED HERE, not in the panel, for the same reason `capacityKinds` is: the
 * panel's own copy of this table did not fail to compile when `queueSec` gained
 * a dispatch/assign split, it just kept drawing one `queued` block over two
 * numbers that name different people to go and fix.
 *
 * `queue` keeps its own entry AND its detail: `jobs.recent` is a rolling window
 * and records ingested before the split carry only the total, so both shapes are
 * live at once for as long as the window takes to turn over.
 */
const JOB_PHASES: JobPhase[] = [
	{
		id: 'queue',
		field: 'queueSec',
		description: 'waiting for a runner — job created until the job started',
		detail: [
			{
				id: 'dispatch',
				field: 'dispatchSec',
				description:
					'OURS: job created until this fleet minted a runner. The median wait is this half, ' +
					'so it is the half worth tuning.',
			},
			{
				id: 'assign',
				field: 'assignSec',
				description:
					"GITHUB'S: the runner was up and idle, waiting to be handed its job. Nothing in " +
					'this fleet can shorten it.',
			},
		],
	},
	{
		id: 'setup',
		field: 'setupSec',
		description:
			'the runner coming up, plus "Set up job". On a JIT node this contains the mint itself.',
	},
	{ id: 'run', field: 'runSec', description: "the job's own steps" },
	{ id: 'cleanup', field: 'cleanupSec', description: '`Post *` teardown and "Complete job"' },
];

/**
 * The fleet's vocabulary, assembled for the wire. See `FleetVocabulary` for why
 * words travel with the numbers.
 *
 * Every field is DERIVED — from the capability registry, from the manifest, or
 * from the constant the counting itself uses. Nothing here is a second copy
 * that could disagree with the first.
 */
function buildVocabulary(nodes: Record<string, ManifestNode>): FleetVocabulary {
	return {
		builderLabel: BUILDER_LABEL,
		pm2HostLabel: PM2_HOST_LABEL,
		backstopLabel: BACKSTOP_LABEL,
		implicitLabels: [...IMPLICIT_LABELS],
		ladder: ladder(),
		backstopNode: backstopNodeOf(nodes),
		labels: Object.fromEntries(
			labelCapabilities().map((c) => [c.id, { kind: c.kind, description: c.description }])
		),
		capabilities: (() => {
			const gated = new Set(workloadGatedCapabilities());
			return Object.fromEntries(
				CAPABILITIES.map((c) => [
					c.id,
					{
						kind: c.kind,
						surface: c.surface,
						verify: c.verify,
						label: c.label,
						description: c.description,
						workloadGated: gated.has(c.id),
					},
				])
			);
		})(),
		bootcampStaleDays: BOOTCAMP_STALE_DAYS,
		capabilitySurfaces: CAPABILITY_SURFACES,
		capabilityVerifications: CAPABILITY_VERIFICATIONS,
		failureZones: FAILURE_ZONES,
		queuedWarnMinutes: QUEUED_WARN_MINUTES,
		censusRepo: SELF_REPO,
		// The report's own enums, described where they are emitted. Quoted, never
		// re-authored: a consumer that writes its own sentence for a state is
		// holding an opinion this package is supposed to own.
		states: CLAW_STATES,
		backstopReasons: BACKSTOP_REASONS,
		admissionBases: ADMISSION_BASES,
		admissionCaveats: ADMISSION_CAVEATS,
		admissionClauses: ADMISSION_CLAUSES,
		jobPhases: JOB_PHASES,
		capacityKinds: CAPACITY_KINDS,
		ghCallers: GH_CALLERS,
	};
}

/**
 * Every workload-gated capability's CURRENT `$proof` records, by capability
 * id, PLUS whether the facet file itself is corrupt (wave 4e, #102) — the one
 * state-dir read `buildFleetReport` needs to render each node's
 * `workloadGates` reason via the shared `workloadGateContext`
 * (`src/capabilities.ts`). A real read on every call, like
 * `loadManifestNodes()` above; `buildFleetReport`'s own parameter is where a
 * test replaces it. See `measured.ts#proofFileStatus` for why `corrupt` is
 * checked FIRST and the per-capability reads are skipped entirely when it is
 * true: an unreadable/malformed file must never be read as "no records",
 * which `readProofsForCapability` alone would do.
 */
function loadWorkloadGateInputs(): {
	proofsByCapability: Record<string, ProofRecord[]>;
	corrupt: boolean;
} {
	const status = proofFileStatus({ dir: stateDir() });
	if (status.corrupt) {
		logger.error(
			`[fleet] $proof is ${status.reason} (${status.why}) — every workload-gated label's ` +
				`reason will read as withheld fleet-wide until this is fixed; see workloadGateContext.`
		);
		return { proofsByCapability: {}, corrupt: true };
	}
	const proofsByCapability: Record<string, ProofRecord[]> = {};
	for (const id of workloadGatedCapabilities())
		proofsByCapability[id] = readProofsForCapability(id, { dir: stateDir() });
	return { proofsByCapability, corrupt: false };
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
	// A HELD ON-DEMAND GUEST IS MINTABLE, whatever the census says. The census
	// reads the runner listing, and a guest's one standing registration is a
	// deploy runner the backstop never labels `hadoku-builder` (#120) — so it
	// wrote `demoted` for hokon on every tick since 2026-10-19, promoted or not.
	// On 2026-10-25 the panel showed hokon demoted beside 13 queued jobs while
	// the dispatcher was minting onto it. The hold is this process's own record
	// of the promotion, read here at request time like the probe is; an
	// unheld guest keeps the census's word, which is correct for it.
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
			// The census's map, with every held on-demand guest re-read the way
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

// Annotated explicitly: this package emits declarations (mgmt-api did not), and
// the inferred Router type cannot be named without reaching into a pnpm-internal
// @types path — which would make the .d.ts unportable for consumers.
export const router: Router = Router();

/**
 * FIRST HANDLER ON EVERY ROUTE: count the hit into the invocation log
 * (`lib/usage-log.ts`) once the response is sent. By the route's PATTERN, not
 * the raw path. Per route rather than `router.use`, because mgmt-api mounts
 * this router on all of `/api` and a router-wide middleware would count every
 * other service's requests too. `FLEET_ROUTES` must name every route below;
 * the router test holds the two equal.
 */
function countHit(req: Request, res: Response, next: NextFunction): void {
	const start = performance.now();
	const route = (req.route as { path?: unknown } | undefined)?.path;
	res.on('finish', () => {
		try {
			recordRouteHit(
				{
					method: req.method,
					route: typeof route === 'string' ? route : '(unknown)',
					status: res.statusCode,
					ms: performance.now() - start,
				},
				{ stateDir, version: packageVersion }
			);
		} catch (err) {
			logger.error(`[fleet] usage log: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
	next();
}

router.get('/fleet', countHit, (_req: Request, res: Response) => {
	try {
		res.json({ success: true, ...buildFleetReport() });
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown error';
		// "I could not look" is not "nothing is wrong" — a 503, never the same
		// 500 an unrelated bug would also raise, so a dashboard or a monitor can
		// tell "the manifest is unreadable right now" from "this route broke".
		if (err instanceof ManifestUnreadableError) {
			logger.error(`[fleet] GET /fleet → 503 ${msg}`);
			res.status(503).json({ success: false, error: msg });
			return;
		}
		logger.error(`[fleet] GET /fleet → 500 ${msg}`);
		res.status(500).json({ success: false, error: msg });
	}
});

/**
 * The CI state this package's alerter maintains, for monitoring-api's sitrep.
 *
 * WHY IT IS SERVED RATHER THAN SHARED. The sitrep's `ci` domain used to read
 * monitoring-api's own KV, written by the ci-check poller that lived there.
 * That poller moved here with the rest of "did a GitHub Action work", so the
 * panel has to read the state from its new owner — and one owner for both the
 * data and the paging is the whole point of the move. Reported, never
 * re-derived: this returns exactly what the alerter decided from, so the panel
 * and the alert can never disagree about what is red.
 *
 * `lastSeen` is per-row and deliberately exposed. A row whose lastSeen is old
 * means the poll has not reached that workflow lately, which is a DIFFERENT
 * condition from "green" and the consumer must be able to tell them apart.
 *
 * GET /api/fleet/ci-state
 * Loopback/edge-gated like the rest of `/api` by mgmt-api's edgeOriginGuard.
 */
router.get('/fleet/ci-state', countHit, (_req: Request, res: Response) => {
	try {
		const states = readStates();
		const targets = loadTargets();
		// Driven by the TARGET list, not by the state file, so a watched
		// workflow that has never been polled appears as `null` rather than
		// vanishing. A missing row and a green row are not the same answer, and
		// the sitrep already renders "not yet polled" separately.
		const workflows = targets.map((t) => {
			const row = states[stateKey(t)];
			return {
				label: t.label,
				repo: `${t.owner}/${t.repo}`,
				workflow: t.workflow,
				conclusion: row?.lastConclusion ?? null,
				lastSeen: row?.lastSeen ?? null,
			};
		});
		res.json({ success: true, workflows });
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown error';
		logger.error(`[fleet] GET /fleet/ci-state → 500 ${msg}`);
		res.status(500).json({ success: false, error: msg });
	}
});

/**
 * One job read for {@link backfillFailedSteps} below. Deliberately NOT
 * runner-health's `ghGet`: that one folds every failure into a single
 * `null`, and this caller must tell an aged-out job (gone forever, stop
 * asking) from a timeout (worth another pass) — `expired` carries that.
 *
 * Extracted to a named export (plan §4.1 F2b) so its own behaviour —
 * especially "a network failure never reports `expired: true`" — can be
 * pinned without standing up the whole Express route.
 *
 * The raw `fetch` moved onto `github-client.ts`'s `ghFetchRaw`: a pure move
 * except for the `User-Agent`, normalized from a hand-written literal
 * (`hadoku-mgmt-api/job-history-backfill`, a leftover from before the
 * 2026-08-30 extraction — the exact bug `ci-runner-fallback.ts`'s own
 * docstring already names and fixes for itself) to `userAgent(...)`, and the
 * timeout, normalized from NONE AT ALL to this module's 10s default — a read
 * that never finishes used to never report, on a route meant to run once
 * over many job ids.
 */
export async function fetchJobForBackfill(
	repo: string,
	jobId: number,
	token: string
): Promise<{ job: GhJob | null; expired: boolean }> {
	const { resp } = await ghFetchRaw(
		'GET',
		`https://api.github.com/repos/${repo}/actions/jobs/${jobId}`,
		token,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': userAgent('job-history-backfill'),
			},
		}
	);
	if (!resp) return { job: null, expired: false };
	if (!resp.ok) return { job: null, expired: resp.status === 404 };
	try {
		return { job: (await resp.json()) as GhJob, expired: false };
	} catch {
		return { job: null, expired: false };
	}
}

/**
 * Backfill `failedStep` onto pre-0.22.24 records — INSIDE the process that owns
 * the file.
 *
 * This is a route rather than a script because it has to be. `job-history.jsonl`
 * has exactly one writer, this process, and that writer never re-reads the file
 * after boot; a one-shot script that patches the file is overwritten by the next
 * compaction without an error anywhere, which is what happened to 502 records on
 * 2026-09-07. See `backfillFailedSteps`.
 *
 * A route, not a startup step: it costs one GitHub call per record and the whole
 * point is that it is ONE-TIME. It also lives here rather than in mgmt-api so it
 * ships with the function it calls — the two cannot drift apart across repos.
 *
 * POST /api/fleet/job-history/backfill?max=600&concurrency=5
 * Loopback-only in practice: mgmt-api's `edgeOriginGuard` gates all of `/api`.
 */
router.post('/fleet/job-history/backfill', countHit, (req: Request, res: Response) => {
	const num = (v: unknown, fallback: number): number => {
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
	};
	const max = num(req.query.max, 2000);
	const concurrency = Math.min(10, num(req.query.concurrency, 5));
	const token = githubToken();
	if (!token) {
		// "I could not look" is not "nothing to do" — 503, never an empty success.
		logger.error('[fleet] POST /fleet/job-history/backfill → 503 no GitHub token');
		res.status(503).json({ success: false, error: 'no GitHub token configured' });
		return;
	}
	withGhCaller('route', () =>
		backfillFailedSteps((repo, jobId) => fetchJobForBackfill(repo, jobId, token), {
			max,
			concurrency,
		})
	)
		.then((report) => {
			res.json({ success: true, ...report });
		})
		.catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : 'Unknown error';
			logger.error(`[fleet] POST /fleet/job-history/backfill → 500 ${msg}`);
			res.status(500).json({ success: false, error: msg });
		});
});
