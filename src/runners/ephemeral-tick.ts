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

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isDraining, readDrain } from './drain.js';
import {
	effectiveHosting,
	heldBackMb,
	readHostingDoc,
	sliceUsageProbe,
	takeSliceUsage,
} from './hosting-record.js';
import {
	admitMint,
	DEFAULT_RUNNER_SLICE,
	guestUnitMemoryMaxMb,
	JIT_UNIT_MAX_SEC,
	jitRoot,
	JOB_RESERVE_DEFAULT_MB,
	mintBudget,
	planWarmFleet,
	resolveSliceName,
	spaceRefusal,
	TMP_FREE_FLOOR_MB,
	unitMemoryMaxMb,
	WORK_FREE_FLOOR_MB,
	warmCacheEligible,
	warmListenersHeld,
	warmListenerSlots,
	warmRunnerName,
	warmSlotLocked,
	type WarmFleetNode,
	type WarmServedJob,
	type WarmSlotState,
} from './ephemeral.js';
import {
	evictWarmListener,
	withholdWarmListener,
	warmRegistration,
	readWarmMarker,
	mintWarmListener,
	refreshWarmMarker,
	runnerTarballUrl,
	type GhLike,
} from './ephemeral-exec.js';
import { orderCandidates, buildHeavyModel, type TrafficNode, type HeavyModel } from './traffic.js';
import { recordDiskReadings } from './disk-watch.js';
import { isSchedulable } from './schedulable.js';
import { nodeShell } from '../node-shell.js';
import { nodeHome, type UserBearingNode } from '../lib/node-users.js';
import { isGuestNode, mintsOnDemand } from '../lib/node-role.js';
import { isBackstopHeld } from './backstop-hold.js';

import {
	nodeOffer,
	revokedFor,
	workloadGateContext,
	workloadGatedCapabilities,
	type WorkloadGateContext,
} from '../capabilities.js';
import { readRevocations, REVOCATIONS_FILE, revokedSets } from '../capability-revocations.js';
import { proofFileStatus, readProofsForCapability, type ProofRecord } from '../lib/measured.js';
import { historyFile, idleSecondsByNode, jobRecords } from '../job-history.js';
import { logger, manifest, stateDir } from '../host.js';
import { withGhCaller } from '../gh-budget.js';
import { runDispatchTick } from './dispatch-tick.js';
import { SATURATED_QUEUED_MS } from './queue-discovery.js';
import { buildSpeedModel, type SpeedModel } from './speed-tier.js';
import { heavyMarkedRecently, type DispatchPassResult } from './dispatch-pass.js';
import { slowReposOn, type NodeState } from './placement.js';
import { chargedLikeDispatch, getCapacityLedger } from './capacity-ledger.js';

/** The half of the fast loop's probe this needs. Declared locally, not imported,
 *  so the dependency stays one-directional. */
export interface ProbeLike {
	reachable: boolean;
	busyRepos: ReadonlyMap<string, number> | null;
	/**
	 * Runner.Worker processes running on this node right now — `ProbeResult.workers`
	 * (`fleet-loop.ts`), structurally the same field `NodeProbe` already carries, so
	 * the real caller needs no change to satisfy this (#102.1).
	 *
	 * Optional, and absent falls back to the PRE-#102 approximation (distinct
	 * busy REPOS, from `busyRepos`) rather than 0 — a caller that has not been
	 * touched for this wave (every test fixture written before it) still gets a
	 * real, if coarser, number instead of a node that silently reads idle.
	 */
	workers?: number;
}

export interface EphemeralTickInput {
	fleetProbe: ReadonlyMap<string, ProbeLike>;
	/** Nodes the manifest marks `ephemeral: true`. */
	ephemeral: ReadonlySet<string>;
	nodes: Record<
		string,
		{
			labels?: string[];
			maxConcurrent?: number;
			minFreeMb?: number;
			slice?: { unitMaxMb?: number; name?: string; maxMb?: number };
			/**
			 * `"on-demand"` on a guest: mint for it, gated — see `mintsOnDemand`.
			 * Read through that function, never directly.
			 */
			mint?: string;
			/**
			 * The node's HAND-SET p95 job peak — admission's second answer, after
			 * the queued run's repo figure. See {@link jobReserve}.
			 */
			jobP95Mb?: number;
			/** `"claw"` | `"guest"`. Read through `isGuestNode`, never directly. */
			role?: string;
			/**
			 * `"excluded"` means the reconciler will not register this node for
			 * ANYTHING, standing or JIT (`reconcile-fleet-runners.mjs`'s
			 * `placementFor`/`mayRunRepo`). Any other value, or absent, means
			 * nothing — there is no second value this reads today.
			 */
			placement?: string;
			/**
			 * The manifest's per-repo refusals, reason included — #82. Carried
			 * through to `NodeState.excludedRepos` below (as a `Map`, so
			 * `refusalFor` in `placement.ts` gets O(1) lookup rather than an
			 * object-key scan). `undefined`/absent is "excludes nothing", which is
			 * every node the manifest declares no `excludeRepos` for.
			 */
			excludeRepos?: Record<string, string>;
			/** The node's users by role. Read through `nodeUser`/`nodeHome`, never directly. */
			users?: UserBearingNode['users'];
		}
	>;
	isSick: (node: string) => boolean;
	/** The poll and reap universe. */
	repos: string[];
	/**
	 * Non-ephemeral nodes carrying the eligibility label right now.
	 *
	 * EMPTY means nothing standing can take a queued job, which is the normal
	 * state of an all-JIT fleet. The age gate below is a proxy for "a standing
	 * runner would have taken this by now"; with this empty there is no runner to
	 * wait for and no slot that can free, so the proxy waits for an event that
	 * cannot occur.
	 *
	 * Optional, and ABSENT means "unknown, keep the gate" — a caller that does not
	 * pass it gets the old behaviour rather than a silent removal of the wait.
	 */
	standingEligible?: ReadonlySet<string>;
}

/**
 * THE GENERAL-CAPACITY MINT SET: the ephemeral set, with every guest removed.
 *
 * `input.ephemeral` is general CI capacity, and both entry points
 * (`dispatchEphemeral`, `dispatchWarmCache`) read it that way: the warm cache
 * parks a listener on every member, and every member is ranked by load and
 * speed. Neither is true of a guest — the production host is the last resort,
 * not a peer — so a guest never enters this set, even when the manifest says
 * `ephemeral: true`. That is a manifest contradiction, logged every tick rather
 * than dropped quietly: a node that stops being minted for has to show up
 * somewhere.
 *
 * A guest that mints says so with `mint: "on-demand"` instead, and reaches the
 * dispatcher through {@link onDemandGuests}, placed last and gated — never
 * through this set.
 */
export function withoutGuests(input: EphemeralTickInput): EphemeralTickInput {
	const guests = [...input.ephemeral].filter((n) => isGuestNode(input.nodes[n]));
	if (!guests.length) return input;
	logger.warn(
		`[ephemeral-tick] ${guests.join(', ')} ${guests.length === 1 ? 'is' : 'are'} marked ephemeral ` +
			'but role: guest — a guest is not general capacity; declare `mint: "on-demand"` instead. ' +
			'Not minting there as ephemeral'
	);
	return { ...input, ephemeral: new Set([...input.ephemeral].filter((n) => !guests.includes(n))) };
}

/**
 * The guests the dispatcher mints for on demand (#120), in manifest order.
 *
 * Operator, 2026-10-19: "the runners get brought online the same way the JIT
 * process does. not having standing runners squatting on ram." Until then the
 * guest kept ~30 standing listeners alive around the clock (~2.8 GB RSS+swap on
 * the production host) and the backstop's promotion was a label flip on them.
 * Now promotion is a mint, and demotion leaves nothing listening.
 *
 * A DRAINED guest is still returned: the drain reaches placement as
 * `NodeState.drained` like every other node's, which is what keeps it from
 * taking anything — the drain is the guest's red light, and it has to read the
 * same way here as it does on a claw.
 */
export function onDemandGuests(input: EphemeralTickInput): string[] {
	return Object.keys(input.nodes).filter((n) => mintsOnDemand(input.nodes[n]));
}

/** A repo's derived reserve, as `reconcile --write-coverage` writes it. */
export interface RepoReserve {
	mb: number;
	/** `measured`: this repo's own p95. `fleet-p95`: under the min runs. */
	basis: 'measured' | 'fleet-p95';
	runs: number;
	/**
	 * Was `mb` itself raised to (or backed by) a run that hit a cap — OOM-killed,
	 * or pinned at a node's own ceiling? See `demand-derive.mjs`'s
	 * `deriveJobReserves`, which sets this. Additive; absent means false, the
	 * shape every repo carried before #76. A `true` here means `mb` is a FLOOR,
	 * not a measurement admission can trust as exact — {@link jobReserve} and
	 * `admitMint`'s placement clause both read it.
	 */
	lowerBound?: boolean;
}

/** Which answer admission used. The log line carries it as `from=`. */
export type ReserveSource = 'repo' | 'node' | 'default';

/**
 * What admission RESERVES for one queued job on one node — Wave 3g J2.
 *
 * THREE ANSWERS, IN ORDER, and the caller is told which one it got:
 *
 *   1. `repo`    the queued run's repo, from `fleet-runner-coverage.json`'s
 *                `facets[repo].jobP95Mb`. DERIVED from job-metrics, never
 *                declared. The memory axis is the repo (Wave 3d J: 35 %
 *                cross-node spread against 423 % across repos on one node),
 *                so this is the answer the other two only approximate. A
 *                `fleet-p95` basis is still this answer: the repo is covered
 *                and measured as a fleet, it just has too few runs of its own.
 *   2. `node`    the node's hand-set `jobP95Mb` — what every job reserved
 *                before this existed. Reached for a repo the roster has no
 *                figure for (not covered yet, or the file unreadable).
 *   3. `default` {@link JOB_RESERVE_DEFAULT_MB}.
 *
 * CLAMPED TO THE CAP, whichever answered — UNLESS the answer is a LOWER BOUND
 * (#76). `min()` lets an ordinary estimate and the cap disagree only in the
 * safe direction: a reserve above `MemoryMax` promises room the unit is not
 * permitted to use, so trimming it to the cap costs nothing the job could ever
 * have spent. A FLOOR built from capped runs is the opposite case — clamping
 * it down to a cap smaller than the floor would erase the one fact that makes
 * the floor meaningful (that THIS node's ceiling cannot be shown to clear it)
 * before `admitMint` ever sees it, which is the bug this whole mechanism exists
 * to catch. So a lower-bound repo reserve is passed through UNCLAMPED, and
 * `admitMint`'s own placement clause is where it is compared against the cap.
 * The clamp does not change `from` either way.
 */
export function jobReserve(i: {
	repoReserve?: RepoReserve | null;
	nodeJobP95Mb?: number;
	capMb: number;
}): { mb: number; from: ReserveSource; lowerBound: boolean } {
	const usable = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
	const pick: { mb: number; from: ReserveSource; lowerBound: boolean } = usable(i.repoReserve?.mb)
		? { mb: i.repoReserve.mb, from: 'repo', lowerBound: i.repoReserve?.lowerBound === true }
		: usable(i.nodeJobP95Mb)
			? { mb: i.nodeJobP95Mb, from: 'node', lowerBound: false }
			: { mb: JOB_RESERVE_DEFAULT_MB, from: 'default', lowerBound: false };
	return {
		mb: pick.lowerBound ? pick.mb : Math.min(pick.mb, i.capMb),
		from: pick.from,
		lowerBound: pick.lowerBound,
	};
}

/**
 * Which `admitMint` clause refused a node's GENERIC admission check this tick
 * — see {@link AdmissionVerdict}. `admitMint` has returned exactly three
 * refusal shapes since it was written (`ephemeral.ts`): drained, at-capacity,
 * and memory (the plain clause and the #76 lower-bound PLACEMENT clause,
 * folded together here as 'memory' — both are refused for want of room, and
 * the generic check below never sets `requiredIsLowerBound`, so the
 * placement wording can never actually reach this classifier; it is handled
 * anyway so a future caller that DOES set it is not silently misread).
 *
 * `'other'` is defensive. A reason this file does not recognise must not
 * silently satisfy `clause === 'memory'` and feed the starvation finding
 * (`runner-health.ts`) something `admitMint` was never asked to mean.
 *
 * `'space'` (#101): refused for want of `/tmp` or `~/.hadoku/jit` free space,
 * never folded into `'memory'` — a dataplatform pytest run plus a site build
 * can fill a tmpfs while plenty of RAM remains free, and the finding needs to
 * say which resource actually ran out.
 */
export type AdmissionClause = 'drained' | 'concurrency' | 'memory' | 'space' | 'other';

function classifyAdmissionClause(reason: string): AdmissionClause {
	if (reason.startsWith('drained:')) return 'drained';
	if (reason.startsWith('at capacity:')) return 'concurrency';
	if (reason.startsWith('memory:') || reason.startsWith('placement:')) return 'memory';
	if (reason.startsWith('space:')) return 'space';
	return 'other';
}

/**
 * The verdict `admitMint` reaches for one EPHEMERAL node's GENERIC admission
 * check this tick — DISPLAY, never a second decision (wave 4a §A.1, #100).
 *
 * `placement.ts`'s `refusalFor` calls `admitMint` again, per queued run, with
 * the run's own repo's reserve substituted in when #76's lower bound applies
 * — THAT call is the one which actually gates a mint. This verdict is
 * computed from the SAME `NodeState` `dispatchEphemeral` already builds for
 * placement, before any run is known, so it answers "could this node take A
 * job right now" rather than "could it take THIS one" — close enough to
 * drive a finding and a panel field, wrong to feed back into scheduling.
 * Nothing here changes what `admitMint` admits, the reserves, or the order.
 *
 * WHY THIS EXISTS: claw-6 and claw-2 were refused by the memory clause on
 * every tick for days (2026-09-30 / 2026-10-04) and nothing recorded it —
 * `admitMint`'s own refusal reached nowhere past a per-run log line, and
 * `admissionFree` (fleet-report-types.ts) counts SLOTS and never applies this
 * clause. This is that answer, held where a reader can reach it without
 * re-deriving `admitMint`'s own logic.
 */
export type AdmissionVerdict =
	| { ok: true }
	| {
			ok: false;
			clause: AdmissionClause;
			/** This node's free memory, measured this tick (`NodeState.freeMb`) —
			 *  or, when `clause === 'space'`, the free MB on the filesystem named
			 *  by {@link filesystem} instead. */
			availableMb: number;
			/** What this generic check reserved against it (`NodeState.requiredMb`)
			 *  — or, when `clause === 'space'`, the floor that filesystem failed to
			 *  clear ({@link TMP_FREE_FLOOR_MB} or {@link WORK_FREE_FLOOR_MB}). */
			needMb: number;
			/** Only set when `clause === 'space'`: which filesystem refused —
			 *  `'tmp'` for `/tmp`, `'work'` for the filesystem holding
			 *  `~/.hadoku/jit`. Absent for every other clause. */
			filesystem?: 'tmp' | 'work';
			/** Only set (`true`) when `clause === 'space'` AND the free space on
			 *  {@link filesystem} could not be read (`spaceRefusal`'s `freeMb:
			 *  null`) — `availableMb` is then `0` and is NOT a measurement, only a
			 *  placeholder so the field stays a `number`. A reader that prints
			 *  "…MB free" must check this first. Absent for every other case,
			 *  including a measured below-floor space refusal. */
			unreadable?: true;
			/** Which of `jobReserve`'s three answers produced `needMb`. Meaningless
			 *  for `clause === 'space'` (carried anyway — it is cheap and callers
			 *  already read it unconditionally). */
			reserveBasis: ReserveSource;
			/** `admitMint`'s own reason string, verbatim — the detail a clause alone
			 *  cannot carry (e.g. the exact capacity count, or the exact MB gap). */
			reason: string;
	  };

/**
 * THE VERDICT SNAPSHOT — same shape as `warmRepoByNode` above: module-level,
 * replaced WHOLESALE once per `dispatchEphemeral` pass, never mutated in
 * place, and only ever handed out as a copy (`admissionVerdictsForReport`).
 *
 * WHOLESALE for the same reason `setWarmRepos` is: a node that stops being
 * reachable, or drops out of `input.ephemeral`, must stop being reported on
 * the very next pass rather than carrying a frozen verdict forever.
 *
 * EMPTY AFTER A RESTART, and that is the honest answer, not a bug — mgmt-api
 * restarts ~5x/day and this is in-memory. An ABSENT entry must NEVER be read
 * as "admitted": it means "this pass could not look", and `runner-health.ts`'s
 * starvation check treats it that way — carrying its last known finding
 * forward rather than clearing an alert on a tick that learned nothing.
 */
let admissionVerdictByNode: ReadonlyMap<string, AdmissionVerdict> = new Map();

/** #101: which nodes have already had their `/tmp`/`_work` free space logged
 * once this process's lifetime — see the probe in `dispatchEphemeral`'s node
 * loop. Module-level so "once" means once per mgmt-api process, not once per
 * 15 s tick; reset is never needed because a restart clears it along with
 * everything else in-memory here. */
const loggedSpaceProbeOnce = new Set<string>();

/** Test seam. Not part of the supported API. */
export function __resetAdmissionVerdictsForTesting(): void {
	admissionVerdictByNode = new Map();
	loggedSpaceProbeOnce.clear();
}

/**
 * Test seam: inject the verdict snapshot directly, bypassing a real
 * `dispatchEphemeral` pass. Not part of the supported API.
 *
 * `runner-health.ts`'s starvation check is this file's READER, not its
 * producer — a test of the reader should not have to drive the dispatcher's
 * whole I/O-heavy pass (GitHub `gh`, `sh`, the warm cache, the speed model)
 * just to get one node refused on memory. `dispatchEphemeral` itself is
 * exercised end to end in `warm-cache.test.ts`.
 */
export function __setAdmissionVerdictsForTesting(
	verdicts: ReadonlyMap<string, AdmissionVerdict>
): void {
	admissionVerdictByNode = new Map(verdicts);
}

/**
 * What the last `dispatchEphemeral` pass's generic admission check found, for
 * `runner-health.ts`'s starvation finding and `routes/fleet.ts`'s panel field.
 *
 * Copied, same rule as `warmReposForPlacement` — a caller must not be able to
 * mutate the fleet's belief about its own admission state.
 */
export function admissionVerdictsForReport(): ReadonlyMap<string, AdmissionVerdict> {
	return new Map(admissionVerdictByNode);
}

/** `admitMint(ns)`, folded into the shape callers actually want to read. */
function admissionVerdictFor(ns: NodeState, reserveBasis: ReserveSource): AdmissionVerdict {
	const admit = admitMint(ns);
	if (admit.ok) return { ok: true };
	const reason = admit.reason ?? 'refused';
	const clause = classifyAdmissionClause(reason);
	if (clause === 'space') {
		// Single source of truth with `admitMint` itself — ask `spaceRefusal`
		// the SAME question rather than re-deriving `filesystem` from a string
		// match on `reason`.
		const space = spaceRefusal(ns);
		return {
			ok: false,
			clause,
			availableMb: space?.freeMb ?? 0,
			needMb: space?.floorMb ?? TMP_FREE_FLOOR_MB,
			filesystem: space?.filesystem ?? 'tmp',
			...(space?.freeMb === null ? { unreadable: true as const } : {}),
			reserveBasis,
			reason,
		};
	}
	return {
		ok: false,
		clause,
		availableMb: ns.freeMb,
		needMb: ns.requiredMb,
		reserveBasis,
		reason,
	};
}

/**
 * `facets[repo].jobP95Mb` for every covered repo, read fresh.
 *
 * AN UNREADABLE ROSTER IS NOT A FLEET OF ZERO-MEGABYTE JOBS. It returns an
 * empty map, which sends every job to the node's value — exactly what admission
 * reserved before this facet existed — and says so. Refusing every mint instead
 * would turn a missing file into a CI outage; guessing would be worse.
 */
export function loadRepoReserves(
	path: string = manifest('fleet-runner-coverage.json')
): ReadonlyMap<string, RepoReserve> {
	const out = new Map<string, RepoReserve>();
	let parsed: { facets?: Record<string, { jobP95Mb?: Partial<RepoReserve> } | undefined> };
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8')) as typeof parsed;
	} catch (err) {
		logger.warn(
			`[ephemeral-tick] cannot read per-repo reserves from ${path} ` +
				`(${err instanceof Error ? err.message : String(err)}) — admission falls back to the node's value`
		);
		return out;
	}
	for (const [repo, f] of Object.entries(parsed.facets ?? {})) {
		const r = f?.jobP95Mb;
		if (typeof r?.mb !== 'number' || !(r.mb > 0)) continue;
		out.set(repo, {
			mb: r.mb,
			basis: r.basis === 'measured' ? 'measured' : 'fleet-p95',
			runs: typeof r.runs === 'number' ? r.runs : 0,
			// ADDITIVE (#76): absent on every roster written before this reads as
			// `false` here too, via `=== true` rather than a bare truthy check.
			lowerBound: r.lowerBound === true,
		});
	}
	return out;
}

/**
 * THE LABEL SET A JIT PATH ON THIS NODE PROJECTS — issue #19, through one door.
 *
 * Every JIT path in this file used `m.labels ?? []`, the manifest's DECLARED
 * array, three times: the mint's `labelsFor`, the warm listener's labels, and
 * the `NodeState.labels` that `placement.ts` refuses a node on. So the array
 * was the label WRITER for the whole ephemeral fleet, and the 2026-09-07
 * decision that capabilities are DERIVED and never declared could not be
 * carried out — emptying it minted `self-hosted,Linux,X64` while every covered
 * repo asks for `["self-hosted","hadoku-builder"]`, and `check-label-floor`
 * stayed green through it (proved by execution, Wave 2 closeout).
 *
 * `eligible: true` is not a guess. Under all-JIT no eligibility LABEL is
 * toggled on these nodes at all — `setTierEligibility` skips ephemeral ones —
 * so the dispatcher's decision to mint for a node IS the eligibility decision,
 * and it was already taken upstream: the ladder put the node in `ephemeral`,
 * `choosePlacement` still refuses it when `demoted`, `drained` or over its
 * admission cap. Re-deriving eligibility here would be a SECOND authority that
 * can disagree with the first, and it would disagree exactly when the demand
 * ledger is unreadable. See `nodeOffer`'s own docblock.
 *
 * `gate` (wave 4e follow-up, #102) IS THE PRODUCTION FIX for the defect the
 * manager's verification caught before landing: the lane's first draft had
 * every call here omit `nodeOffer`'s `workloadProofs`/`provenCounts`
 * entirely, which is the SAFE default for a caller that has not been wired
 * yet — but THIS is the mint's `labelsFor`, both warm-listener label sites
 * and placement's `labelsFor`, i.e. every real routing decision in the
 * fleet, and an omitted gate there would have meant claw-3's FAIL (or lane
 * B's STALE mark) withdrew NOTHING in production. `gate` is built ONCE per
 * tick by `loadWorkloadGateContext` (below), not once per node: it is a
 * single state-dir read reused for every node `offerFor` is asked about in
 * that pass.
 */
function offerFor(
	nodes: EphemeralTickInput['nodes'],
	node: string,
	gate: WorkloadGateContext,
	/**
	 * Does this node offer the general CI label? Always for a claw: the
	 * dispatcher's decision to mint IS its eligibility decision. For an
	 * on-demand guest, only while the backstop holds it (#120) — the guest is
	 * still minted for the work only it can do, but `hadoku-builder` is the
	 * backstop's to grant, exactly as it was on the standing registrations.
	 */
	eligible = true
): string[] {
	return nodeOffer(nodes[node] ?? {}, {
		eligible,
		workloadProofs: gate.byNode[node] ?? {},
		provenCounts: gate.provenCounts,
		revoked: revokedFor(gate, node),
	});
}

/**
 * Build this TICK's `WorkloadGateContext` — one state-dir read, reused for
 * every `offerFor` call the tick makes, never one read per node (this runs on
 * the 15s dispatch loop).
 *
 * `proofFileStatus` is checked FIRST, separately from the per-capability
 * reads, for the same reason `src/routes/fleet.ts`'s own loader does it: an
 * UNREADABLE or MALFORMED `$proof` file must never be read as "no records at
 * all" (which `readProofsForCapability` alone would do, silently RE-GRANTING
 * a label a FAIL/STALE mark had just withdrawn). `workloadGateContext`'s
 * `opts.corrupt` is what turns that into "withhold every workload-gated label
 * fleet-wide until the file is fixed" instead — the safe failure direction.
 */
/**
 * The last `(reason, why)` this function logged about a corrupt `$proof`
 * file, or `null` when the file was readable last time this ran. This tick
 * runs every ~15s, so logging unconditionally would write the same line to
 * the log once per tick for as long as the file stays broken — true but
 * useless, and loud enough to bury whatever else is happening. `null` on a
 * HEALTHY read (not merely "same reason as before") is deliberate: a file
 * that recovers and later breaks again, even with byte-identical text, is a
 * NEW transition worth saying out loud again, not a repeat of the old one.
 */
let lastLoggedProofCorruption: string | null = null;

export function loadWorkloadGateContext(nodeNames: readonly string[]): WorkloadGateContext {
	if (workloadGateContextOverride) return workloadGateContextOverride;
	const revoked = loadRevoked();
	const status = proofFileStatus({ dir: stateDir() });
	if (status.corrupt) {
		const key = `${status.reason}:${status.why}`;
		if (key !== lastLoggedProofCorruption) {
			lastLoggedProofCorruption = key;
			logger.error(
				`[ephemeral-tick] $proof is ${status.reason} (${status.why}) — withholding every ` +
					`workload-gated label fleet-wide until it is readable again: "I could not look" must ` +
					`never silently re-grant a label a bad reading withdrew.`
			);
		}
		return workloadGateContext(nodeNames, {}, { corrupt: true, revoked });
	}
	lastLoggedProofCorruption = null;
	const proofsByCapability: Record<string, ProofRecord[]> = {};
	for (const id of workloadGatedCapabilities())
		proofsByCapability[id] = readProofsForCapability(id, { dir: stateDir() });
	return workloadGateContext(nodeNames, proofsByCapability, { revoked });
}

let lastLoggedRevocationCorruption: string | null = null;

/**
 * This tick's revoked labels — one state-dir read, alongside `$proof`'s. A
 * corrupt record withholds every probe-verified routing label (`'all'`) and
 * says so once per distinct reason: "I could not look" must never re-grant a
 * label a failed execution withdrew. See src/capability-revocations.ts.
 */
function loadRevoked(): Record<string, ReadonlySet<string>> | 'all' {
	const read = readRevocations(stateDir());
	if (read.corrupt) {
		if (read.why !== lastLoggedRevocationCorruption) {
			lastLoggedRevocationCorruption = read.why;
			logger.error(
				`[ephemeral-tick] ${REVOCATIONS_FILE} is unreadable (${read.why}) — withholding every ` +
					'probe-verified label fleet-wide until it is readable again.'
			);
		}
	} else lastLoggedRevocationCorruption = null;
	return revokedSets(read);
}

/** Test seam: the corruption-logging dedup is module-level, same leak class as every other reset in this file. */
export function __resetWorkloadGateCorruptionLogForTesting(): void {
	lastLoggedProofCorruption = null;
}

/**
 * Test seam, same shape as `__setAdmissionVerdictsForTesting` and the rest of
 * this file's module-level overrides. Real production code never calls this:
 * a test that wrote a REAL `$proof` fixture into the test host's shared state
 * dir would leak into every other test in the same process, since that
 * directory is not reset between tests the way each test's own `tmp` is.
 * `null` restores the real read.
 */
let workloadGateContextOverride: WorkloadGateContext | null = null;
export function __setWorkloadGateContextForTesting(ctx: WorkloadGateContext | null): void {
	workloadGateContextOverride = ctx;
}

/**
 * Jobs per day per repo, from the persisted history.
 *
 * Feeds the hot/cold poll split. This was a literal empty map for the pilot's
 * whole first day, which made EVERY repo cold: a 10-minute poll interval instead
 * of 60 s, so a starved job waited up to eleven minutes for a runner that could
 * have been minted in two. `deriveHotRepos` exists precisely to stop a
 * hand-maintained list going stale, and it was wired to nothing.
 */
export function recentJobsPerDay(): Map<string, number> {
	const out = new Map<string, number>();
	try {
		const records = jobRecords();
		if (!records.length) return out;
		let oldest = Infinity;
		for (const r of records) {
			const t = Date.parse(r.startedAt);
			if (Number.isFinite(t)) oldest = Math.min(oldest, t);
		}
		const days = Math.max(1, (Date.now() - oldest) / 86_400_000);
		const counts = new Map<string, number>();
		for (const r of records) counts.set(r.repo, (counts.get(r.repo) ?? 0) + 1);
		for (const [repo, n] of counts) out.set(repo, n / days);
	} catch {
		// A missing or unreadable history means every repo polls cold — slower,
		// never wrong. It must not take the dispatch pass down with it.
	}
	return out;
}

/**
 * Every job the FLEET has served, from the persisted history, as the `served`
 * input `planWarmFleet` scores — or `null` when the history could not be read.
 *
 * This is the ONLY input that says what SHOULD be warm — see
 * "The cache is DYNAMIC" in warm-listener-cache-2026-09-05.md. No repo is ever
 * seeded or declared; recent traffic is scored every tick and that answer moves
 * on its own as traffic does.
 *
 * FLEET-WIDE, not per node (wave 3k §B). Lane A reshaped this from the MRU
 * `lastServedRepoByNode` into every job per node; the joint allocation needs
 * the fleet's demand instead, because a warm listener serves its repo's next
 * job wherever GitHub would otherwise have sent it — hokon's and the
 * ineligible nodes' jobs included. Which node served a job says nothing about
 * what a slot elsewhere should hold, so the runner is not resolved at all.
 */
export function fleetServedJobs(): WarmServedJob[] | null {
	try {
		const out: WarmServedJob[] = [];
		for (const r of jobRecords()) {
			const startedAtMs = Date.parse(r.startedAt);
			if (!Number.isFinite(startedAtMs)) continue;
			// The duration is what tells a repo whose jobs overlap from one whose
			// jobs run one at a time — see warmUnitValues.
			out.push({ repo: r.repo, startedAtMs, durationMs: r.durationSec * 1000 });
		}
		return out;
	} catch (err) {
		// COULD NOT LOOK, and it must not be read as "looked, found nothing" in
		// any way that evicts. `null` reaches planWarmFleet as `idle` on every
		// node: every existing slot is KEPT and nothing is filled — slower to
		// warm, never wrong. The partial walk is discarded rather than scored,
		// because a half-read history could rank a repo that merely came first in
		// the file above the one that dominates. Said out loud so the two cases
		// stay distinguishable in the log.
		logger.warn(
			`[warm-cache] job history unreadable, holding every slot as-is: ${
				err instanceof Error ? err.message : String(err)
			}`
		);
		return null;
	}
}

/**
 * Run a command on a node and return its stdout, or null if it could not.
 *
 * `null` means UNREACHABLE and never "empty output" — the reaper refuses to
 * touch a node it cannot see, so collapsing the two would let a network blip
 * delete registrations whose listeners are mid-job.
 */
export function shellOnNode(node: string, cmd: string): Promise<string | null> {
	// The local branch. This function had NONE, which made it the fourth and
	// worst of the four answers to "is this node me?": hokon refuses ssh to
	// itself, so a local ephemeral node would come back `null` on every call —
	// and `null` is UNREACHABLE, which the reaper reads as "do not touch". It
	// would never have been reaped at all. Latent only because the one
	// `ephemeral: true` node today is claw-3 and this runs on hokon.
	// As ci: minting, the reap and the probe all act on CI's units and $HOME.
	let bin: string;
	let argv: string[];
	try {
		[bin, argv] = nodeShell(node, 'ci', cmd);
	} catch (err) {
		logger.warn(
			`[ephemeral] cannot reach ${node} as ci: ${err instanceof Error ? err.message : String(err)}`
		);
		return Promise.resolve(null);
	}
	return new Promise((res) => {
		execFile(bin, [...argv], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
			res(err ? null : String(stdout))
		);
	});
}

/**
 * How often the warm-cache tick may run its own probe, INDEPENDENT of the
 * dispatch tick — the same shape of constant as `REAP_INTERVAL_MS`, and for
 * the same reason.
 *
 * `warmRegistration` below costs one runner listing per eligible node. It is
 * conditional (`ghGet` revalidates with an ETag, and a 304 is GitHub saying the
 * CURRENT listing is the one we hold), but a warm slot's listing changes every
 * time its runner flips busy or online, so the ceiling is still the spend (see
 * REAP_INTERVAL_MS's own note), and this must not ride the dispatch
 * tick's 15s cadence: at today's two eligible nodes that would already be
 * 480 calls/hr, and it grows with every node the warm cache becomes eligible
 * for. 60s bounds it at 1 call/node/minute regardless of fleet size, and
 * nothing about warm-cache maintenance is time-critical enough to need
 * faster — a slot sitting warm for an extra 59 seconds after it should have
 * rotated costs nothing a job is waiting on.
 */
export const WARM_CACHE_INTERVAL_MS = 60_000;

let lastWarmCacheMs = 0;

/** Test seam. Not part of the supported API. */
export function __resetWarmCacheClockForTesting(): void {
	lastWarmCacheMs = 0;
}

/**
 * How often the speed model (#83, `speed-tier.ts`) rebuilds from job history.
 *
 * NOT every 15s dispatch tick — `buildSpeedModel` is pure and cheap, but the
 * tier it computes changes on the scale of days of job history, not seconds,
 * and rebuilding on every tick would mean every log line below fires 240
 * times an hour for a number that essentially never moves between them.
 * 10 minutes matches `runner-health`'s own `TICK_INTERVAL_MS` — there is no
 * sharper requirement than "once in a while", so this reuses the cadence the
 * fleet already has one of rather than inventing a second.
 */
export const SPEED_MODEL_REBUILD_INTERVAL_MS = 10 * 60 * 1000;

let cachedSpeedModel: SpeedModel | null = null;
let speedModelBuiltMs = -1;

/** Test seam. Not part of the supported API. */
export function __resetSpeedModelForTesting(): void {
	cachedSpeedModel = null;
	speedModelBuiltMs = -1;
}

/**
 * The fleet's speed model, rebuilt from the SAME job history `jobRecords()`
 * already loads for this file's other reader (`idleSecondsByNode` above) —
 * no second parser of `~/.hadoku-mgmt/job-history.jsonl`, per the manager's
 * note on this lane.
 *
 * A MISSING OR EMPTY HISTORY MUST NEVER DISABLE SPILL AND MUST NEVER MAKE
 * EVERYTHING SLOW (§A.5). `buildSpeedModel([])` already answers both: with no
 * records, `tierOf` returns `'unknown'` for every node (never `'slow'` by
 * construction — see `speed-tier.ts`'s own tier rule), and `'unknown'` places
 * exactly like `'normal'` in `placement.ts`'s spill gate. So the EMPTY case
 * this function falls back to on an unreadable or not-yet-written history is
 * automatically the safe one; what this function adds on top is SAYING SO,
 * because a silently empty model and a silently thin-but-real one look
 * identical to a caller with no log line to tell them apart.
 *
 * `nodeNames` is the DECLARED node list — every manifest machine, not only
 * `input.ephemeral` — passed to `buildSpeedModel` as `opts.nodes` so it can
 * attribute a runner name to a node from the fleet's own roster rather than a
 * hardcoded naming convention. Without it the model attributes nothing and
 * every node reads 'unknown' — safe (spill never engages) but silently inert
 * — which is why an empty list here is its own warning below, not just a
 * quiet no-op.
 */
function getSpeedModel(nowMs: number, nodeNames: readonly string[]): SpeedModel {
	if (cachedSpeedModel && nowMs - speedModelBuiltMs < SPEED_MODEL_REBUILD_INTERVAL_MS) {
		return cachedSpeedModel;
	}
	speedModelBuiltMs = nowMs;
	const records = jobRecords();
	if (records.length === 0) {
		// `jobRecords()` never throws and never reports WHY it is empty — that is
		// `job-history.ts`'s own concern and this file does not re-read its
		// JSONL to second-guess it (the manager's "no second reader" note). A
		// `statSync` of the path is not a second READER of the DATA — nothing
		// here parses a line of it — it only tells the log whether the file is
		// missing (a fleet with no jobs recorded yet, or a fresh process before
		// `loadHistory` ever ran) or present-but-yielding-nothing (every line
		// failed to parse, or aged out of the window), which are different
		// findings an operator would act on differently.
		let why: string;
		try {
			statSync(historyFile());
			why = 'the file exists but yielded zero usable records';
		} catch (err) {
			why =
				(err as NodeJS.ErrnoException)?.code === 'ENOENT'
					? 'no job history file yet (no jobs recorded this process)'
					: `could not stat it: ${err instanceof Error ? err.message : String(err)}`;
		}
		logger.warn(
			`[speed-tier] job history unreadable or empty — ${why}; the model holds nothing ` +
				`(every node reads 'unknown', which places exactly like 'normal' — spill stays off, ` +
				`nothing is held back)`
		);
	}
	// THE DECLARED NODE LIST MUST BE NON-EMPTY, or `buildSpeedModel` has no
	// roster to attribute a runner name against and silently returns a model
	// that is 'unknown' everywhere — safe (spill never engages) but inert, and
	// indistinguishable from a genuinely thin history unless this says so. An
	// empty list here means the caller passed `Object.keys(input.nodes)` on a
	// tick with no manifest machines at all, which `withoutGuests`/the reaching
	// code above should already have ruled out — this is the "say why, don't
	// let it render as nothing wrong" assertion for that assumption.
	if (nodeNames.length === 0) {
		logger.warn(
			'[speed-tier] rebuilding with an EMPTY declared node list — the model will attribute ' +
				"nothing and every node reads 'unknown' (spill stays off; this is a caller bug, not a " +
				'history problem)'
		);
	}
	const model = buildSpeedModel(records, { nowMs, nodes: nodeNames });
	// ONE LINE PER REBUILD naming every slow-tier node and its p25 (§A.5), AND
	// (wave 3z, #83's continuous sibling) every node's placement speed factor —
	// not per node per tick, which at a 10-minute cadence is already infrequent
	// enough that per-node lines would not flood anything, but one line keeps
	// this grep-able the same way `[dispatch]`'s summary line already is.
	const slow: string[] = [];
	const factors: string[] = [];
	for (const name of nodeNames) {
		const d = model.describe(name);
		if (d.tier === 'slow') slow.push(`${name} (p25 ${d.p25 ?? 'null'}, ${d.kinds} kind(s))`);
		// Rounded to 2 decimals — LOGGING ONLY, never the number `orderCandidates`
		// actually sorts on (that reads `speedFactor` straight off the model,
		// full precision, in `trafficNodes` below). Full float noise (e.g.
		// 0.5981372549019608) makes the live rebuild line hard to read for no
		// placement benefit.
		const f = model.factorOf?.(name);
		factors.push(`${name}=${f === null || f === undefined ? 'null' : f.toFixed(2)}`);
	}
	logger.info(
		(slow.length
			? `[speed-tier] rebuilt from ${records.length} record(s) across ${nodeNames.length} node(s): slow tier = ${slow.join(', ')}`
			: `[speed-tier] rebuilt from ${records.length} record(s) across ${nodeNames.length} node(s): no node is in the slow tier`) +
			`; factors: ${factors.join(', ')}`
	);
	cachedSpeedModel = model;
	return model;
}

let cachedHeavyModel: HeavyModel | null = null;
let heavyModelBuiltMs = -1;

/** Test seam. Not part of the supported API. */
export function __resetHeavyModelForTesting(): void {
	cachedHeavyModel = null;
	heavyModelBuiltMs = -1;
}

/**
 * The fleet's heavy-kind model (#102), rebuilt from the SAME job history
 * `jobRecords()` already loads for `getSpeedModel`'s reader just above — no
 * second parser of `~/.hadoku-mgmt/job-history.jsonl`.
 *
 * CACHED ON THE SAME CADENCE AS THE SPEED MODEL (`SPEED_MODEL_REBUILD_INTERVAL_MS`):
 * which (repo, job) kinds run long changes on the scale of days of job
 * history, not seconds, and rebuilding every 15s dispatch tick would cost a
 * fresh pass over the whole window for a number that essentially never moves
 * between them.
 *
 * A MISSING OR EMPTY HISTORY MUST NEVER MAKE A JOB READ AS HEAVY. `buildHeavyModel([])`
 * already answers that: with no records, `isHeavy`/`isHeavyRepo` return `false`
 * for everything, which is the safe default documented on `HeavyModel` itself.
 */
function getHeavyModel(nowMs: number): HeavyModel {
	if (cachedHeavyModel && nowMs - heavyModelBuiltMs < SPEED_MODEL_REBUILD_INTERVAL_MS) {
		return cachedHeavyModel;
	}
	heavyModelBuiltMs = nowMs;
	const records = jobRecords();
	const model = buildHeavyModel(records);
	cachedHeavyModel = model;
	return model;
}

/**
 * Per-node exponential backoff on consecutive warm-fill failures, capped at
 * 1 hour — issue #7's "no backoff, no kill switch" clause.
 *
 * Every fill was failing on every eligible node, every 60s tick, forever: a
 * registration-token GitHub call plus a heavy provisioning ssh, for nothing,
 * ~360 calls/hr fleet-wide. This is state, same shape as `lastWarmCacheMs`
 * above, because the thing it is protecting — a mint attempt — is I/O the
 * pure decision layer in ephemeral.ts cannot gate on its own: `planWarmCache`
 * correctly says 'fill' every tick there is nothing warm yet, and it should —
 * knowing "try again" is the right call is not the same as knowing "try again
 * this SECOND".
 */
const WARM_BACKOFF_BASE_MS = WARM_CACHE_INTERVAL_MS;
const WARM_BACKOFF_CAP_MS = 60 * 60_000;

interface WarmBackoffEntry {
	failures: number;
	retryAtMs: number;
}

/**
 * ...AND IT LIVES ON DISK, BECAUSE mgmt-api's MEMORY IS NOT A PLACE TO KEEP IT.
 *
 * The backoff above shipped as a module-level Map and, measured against the
 * deployed 0.22.49 on 2026-09-08, it never once reached its second doubling.
 * The log read like a backoff that was not wrapping this failure path at all —
 * claw-1/3/5 failing at 05:07:57, 05:09:05, 05:10:28, 05:11:36, 05:13:15,
 * 05:14:22, 05:16:22, 05:17:29, 05:18:36 — but every one of those retries is
 * explained by the code as written: mgmt-api restarted at 05:07:49, 05:10:20,
 * 05:13:06 and 05:17:20 (17 restarts that day, 164 on the process pm2 was
 * holding), and each restart put `failures` back to 0. Between restarts the
 * streak only ever got as far as 1 -> 2, whose 120s delay skips at most one
 * 60s tick. A guard that resets faster than it can escalate is not a guard.
 *
 * This is the same fact this workstream already writes down everywhere else
 * and for the same stated reason: the warm marker lives on the NODE rather
 * than in this process because "mgmt-api's own memory is wrong after every one
 * of its ~5 daily restarts" (currentWarmSlot, §12.8/B9). A failure streak is
 * exactly that shape of fact, so it goes where the drain state, the job
 * history and the runner-health ledger already are — `stateDir()`.
 *
 * Read once per process and written on every change. An unreadable or absent
 * file is an EMPTY backoff, which is the honest direction here and not a
 * "could not look" that must fail: forgetting a streak costs one extra mint
 * attempt and is visible in the log, whereas inventing one would silently
 * suppress a fill nobody asked to suppress.
 */
const WARM_BACKOFF_FILE = 'warm-backoff.json';

let warmBackoff: Map<string, WarmBackoffEntry> | null = null;

const warmBackoffPath = (): string => join(stateDir(), WARM_BACKOFF_FILE);

function loadWarmBackoff(): Map<string, WarmBackoffEntry> {
	if (warmBackoff) return warmBackoff;
	warmBackoff = new Map();
	try {
		const raw = JSON.parse(readFileSync(warmBackoffPath(), 'utf8')) as {
			nodes?: Record<string, WarmBackoffEntry>;
		};
		for (const [node, e] of Object.entries(raw?.nodes ?? {})) {
			if (Number.isFinite(e?.failures) && Number.isFinite(e?.retryAtMs)) {
				warmBackoff.set(node, { failures: e.failures, retryAtMs: e.retryAtMs });
			}
		}
	} catch {
		// Absent on a fresh box, and unparseable only if something truncated it
		// mid-write — the rename below makes that vanishingly unlikely. Either
		// way an empty streak is the safe reading; see the note above.
	}
	return warmBackoff;
}

function saveWarmBackoff(): void {
	const nodes = Object.fromEntries(loadWarmBackoff());
	try {
		mkdirSync(stateDir(), { recursive: true });
		// Written through a temp file and renamed: a torn write here would be
		// read back as an empty streak on the next restart, which is precisely
		// the failure this file exists to stop.
		const tmp = `${warmBackoffPath()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ nodes }, null, 2)}\n`);
		renameSync(tmp, warmBackoffPath());
	} catch (err) {
		logger.warn(
			`[warm-cache] could not persist the fill backoff: ${
				err instanceof Error ? err.message : String(err)
			} — a restart will retry a failing node sooner than it should`
		);
	}
}

/** Test seam. Not part of the supported API. */
export function __resetWarmBackoffForTesting(): void {
	warmBackoff = new Map();
	saveWarmBackoff();
	warmBackoff = null;
}

/**
 * Test seam: drop only the IN-MEMORY copy, exactly as a process restart does,
 * leaving what is on disk alone. Not part of the supported API — but the
 * property it exists to assert is the entire reason this state moved to disk.
 */
export function __restartWarmBackoffForTesting(): void {
	warmBackoff = null;
}

function warmBackoffActive(node: string, nowMs: number): boolean {
	const e = loadWarmBackoff().get(node);
	return e !== undefined && nowMs < e.retryAtMs;
}

function recordWarmFailure(node: string, nowMs: number): void {
	const map = loadWarmBackoff();
	const failures = (map.get(node)?.failures ?? 0) + 1;
	const delayMs = Math.min(WARM_BACKOFF_BASE_MS * 2 ** (failures - 1), WARM_BACKOFF_CAP_MS);
	map.set(node, { failures, retryAtMs: nowMs + delayMs });
	saveWarmBackoff();
}

function clearWarmFailures(node: string): void {
	if (loadWarmBackoff().delete(node)) saveWarmBackoff();
}

/**
 * Nodes already warned about a slice override, so the check costs one log line
 * per node per process rather than one per tick. Module-level mutable state, in
 * a file that already holds sixteen such singletons — mgmt-api restarts ~5x/day,
 * so the worst case is the warning repeating five times a day, which is the
 * right cadence for something an operator has to act on.
 */
const warnedSliceOverride = new Set<string>();

/**
 * The slice the WARM minter will use for a listener on this node, and a loud
 * complaint if the manifest asked for something else.
 *
 * `buildWarmSpawnPlan` defaults to {@link DEFAULT_RUNNER_SLICE} and the node's
 * name cannot reach it: a warm mint's slice would have to travel through
 * `mintWarmListener`. The JIT path no longer has this gap — since #120 its
 * `MintRequest` carries the node's slice. That is sound only while every
 * warm-capable node agrees with the default, which is true (hokon is the sole
 * override, and as a guest it never holds a listener).
 *
 * "Sound only while" is exactly the kind of claim that rots silently, so it is
 * ASSERTED at the mint sites rather than asserted in a comment. The hard gate
 * lives in `deploy-runners-slice.mjs`, which reads the same manifest and fails
 * `fleet slice --check`; this is the runtime half, on the path that would
 * actually mint the wrong placement.
 *
 * It does NOT refuse the mint. An uncontained runner is bad; no runner at all is
 * worse, and a node whose override is `ci-runner.slice` still gets a real
 * ceiling from the default — just not the one its operator asked for.
 */
export function checkMintSlice(nodes: EphemeralTickInput['nodes'], node: string): void {
	const declared = nodes[node]?.slice?.name;
	const want = resolveSliceName(declared);
	if (want === DEFAULT_RUNNER_SLICE || warnedSliceOverride.has(node)) return;
	warnedSliceOverride.add(node);
	logger.error(
		`[mint] ${node} declares slice.name=${declared} but the warm path can only place listeners in ` +
			`${DEFAULT_RUNNER_SLICE}: the name is not threaded through mintWarmListener. Its ` +
			`warm-* units will be contained in ${DEFAULT_RUNNER_SLICE}, NOT in ${want}. Thread it, ` +
			`or drop the override — 'fleet slice --check' fails until one of those happens.`
	);
}

/** Test seam: the warning is once-per-node-per-process, so a test asserting it
 *  fires must be able to start from a clean sheet. Exported rather than reset
 *  from inside the check, because the once-per-process behaviour IS the thing
 *  under test on the second call. */
export function resetMintSliceWarnings(): void {
	warnedSliceOverride.clear();
}

/**
 * Remove a warm registration whose listener is positively known dead — #61.
 *
 * THE LEAK THIS CLOSES. A warm unit is transient, so a reboot takes it with
 * it while `$HOME/.hadoku/warm/repo` survives. `currentWarmSlot` then reads
 * "no slot" (correctly — there is no listener), the planner takes the FILL
 * branch rather than the rotate branch, and `mintWarmListener` runs `RESET=1`,
 * which overwrites the marker with the NEW repo. Nothing ever held the old
 * repo's name again, so nothing ever deleted `warm-<node>-<old-repo>`. That is
 * how `warm-claw-9-hadoku-tenhands` outlived claw-9's 2026-09-22/23 migration
 * reboots with carriers `[]`. `reapJitRunners` cannot cover it: that sweep is
 * `jit-` prefixed, and by design — it reasons about slot indices in the
 * process tree, which a warm listener has none of.
 *
 * THREE INDEPENDENT FACTS, and a delete needs all three, each from a reader
 * that is not the writer of the thing it reads:
 *
 *   1. the marker names the repo          (the node's own record)
 *   2. systemd reports the unit NOT active (the kernel, and `active === false`
 *      rather than `null` — "could not look" is not "dead")
 *   3. GitHub reports the registration OFFLINE and not busy (the registry)
 *
 * Any disagreement means no delete. An unreachable node never gets this far
 * (the observation pass returns before the marker read), an unreadable listing
 * reads as `null` from `warmRegistration` and stops here, and a registration
 * that is online or busy means something IS answering — the marker is stale,
 * the registration is not, and deleting it would cancel a running job. Same
 * fail-closed direction as §12.8's reap on an unreachable node.
 *
 * Returns whether a registration was actually removed.
 */
async function reapDeadWarmListener(
	node: string,
	repo: string,
	unit: string,
	token: string,
	gh: GhLike & { get: (path: string, token: string, repo?: string) => Promise<unknown> },
	sh: typeof shellOnNode
): Promise<boolean> {
	const reg = await warmRegistration(repo, unit, token, gh);
	if (!reg) return false;
	if (reg.online || reg.busy) return false;
	logger.warn(
		`[warm-cache] ${node}: reaping ${unit} on ${repo} — marker present, unit dead, ` +
			'registration offline. A warm listener died outside this code path.'
	);
	return evictWarmListener(node, repo, unit, token, gh, sh);
}

/**
 * P5.1's placement input: the repo each node holds a VERIFIED-LIVE warm
 * listener for, as of the last warm-cache tick that actually ran.
 *
 * WHY THIS IS A MODULE-LEVEL MAP AND NOT RE-DERIVED PER DISPATCH. The two
 * clocks differ on purpose — `dispatchWarmCache` runs at
 * WARM_CACHE_INTERVAL_MS (60 s) because its per-node probe is a GitHub listing
 * whose ceiling is its spend, while `dispatchEphemeral` runs at the dispatch tick's 15 s.
 * Re-deriving this on every dispatch would quadruple exactly the call this
 * fleet already blacked itself out on (REAP_INTERVAL_MS, 2026-09-06: 19 minutes
 * of every hour at `remaining: 0`). So the dispatcher reads the last
 * observation, which is at most 60 s old.
 *
 * STALENESS IS SAFE IN ONE DIRECTION ONLY, AND IT IS THIS ONE. A stale entry
 * makes placement PREFER a node; every refusal in `choosePlacement` — demoted,
 * drained, unhealthy, label mismatch, `admitMint` — still runs against that node
 * exactly as it would have, so the worst case is a job placed on a node whose
 * listener rotated in the last minute, i.e. a cold mint where a warm hit was
 * expected. That is today's behaviour, not a regression.
 *
 * EMPTY AFTER A RESTART, and that is the honest answer rather than a bug.
 * mgmt-api restarts ~5x/day, so for up to 60 s after each one no node carries
 * affinity — which is precisely what `warmRepo: undefined` is documented to
 * mean ("no listener, or nobody looked — either way this falls through to plain
 * ordering"). It is NEVER a reason to refuse a node, so an empty map costs
 * latency and cannot cost correctness. Persisting it would be the opposite
 * trade: a warm slot remembered across a restart it did not survive.
 */
let warmRepoByNode: ReadonlyMap<string, string> = new Map();

/**
 * Replace the observation wholesale, and say so when it moved.
 *
 * WHOLESALE because a node that lost its listener must stop being preferred on
 * the very next pass — the same rule and the same reason as
 * `setUnschedulableNodes` in schedulable.ts.
 *
 * The log line is this lane's answer to "make it observable at the same time"
 * (`warm-affinity-measured-2026-09-14.md` §10.3). It is the placement INPUT,
 * not the outcome; summing `Placement.viaAffinity` needs a counter that
 * `planTick`/`runDispatchPass` do not carry yet. Joining these lines against
 * `job-history`'s `jit-<node>-<repo>-…` records is what turns "did affinity
 * change anything" into a number in the meantime — §5 of that doc, but against
 * an observation with a timestamp rather than against the warm records
 * themselves.
 */
function setWarmRepos(next: ReadonlyMap<string, string>): void {
	const changed =
		next.size !== warmRepoByNode.size ||
		[...next].some(([node, repo]) => warmRepoByNode.get(node) !== repo);
	warmRepoByNode = next;
	if (!changed) return;
	logger.info(
		`[warm-affinity] verified-live listeners: ${
			next.size
				? [...next]
						.map(([node, repo]) => `${node}=${repo}`)
						.sort()
						.join(' ')
				: '(none — placement falls through to plain ordering)'
		}`
	);
}

/**
 * What the last warm-cache tick observed, for the dispatcher and for tests.
 *
 * Copied, so a caller cannot mutate the fleet's belief — same rule as
 * `unschedulableNodes()`.
 */
export function warmReposForPlacement(): ReadonlyMap<string, string> {
	return new Map(warmRepoByNode);
}

/** Test seam. Not part of the supported API. */
export function __resetWarmReposForTesting(): void {
	warmRepoByNode = new Map();
}

export interface WarmCacheResult {
	filled: number;
	rotated: number;
	kept: number;
	locked: number;
	evicted: number;
	/**
	 * Registrations removed because the listener behind them was positively
	 * observed DEAD — #61's ghost, counted apart from `evicted` on purpose.
	 * An eviction is this tick deciding to move a live slot; a reap is this
	 * tick finding one it never got to decide about. Summing them would hide
	 * exactly the number that says whether the leak is back.
	 */
	reaped: number;
	failed: number;
}

const EMPTY_WARM_RESULT: WarmCacheResult = {
	filled: 0,
	rotated: 0,
	kept: 0,
	locked: 0,
	evicted: 0,
	reaped: 0,
	failed: 0,
};

/** What the warm tick's observation pass learned about one ELIGIBLE node —
 *  everything the joint allocation and the act pass after it need. */
/**
 * `WarmSlotState` plus the registration's OWN labels (wave 4e follow-up,
 * #102) — a LOCAL widening, not an edit to `ephemeral.ts`'s `WarmSlotState`:
 * `planWarmFleet` (pure, in that file) only ever reads `repo`/`busy`/
 * `mintedOrRefreshedAtMs` off `current`, so handing it one of these costs
 * nothing there and needs no change to its own type. `null` means "could not
 * read the registration's labels" (the same `reg` miss that already makes
 * `busy`/`online` unavailable) — never "it has none".
 */
type ObservedWarmSlot = WarmSlotState & { labels: string[] | null };

interface ObservedWarmNode {
	node: string;
	m: EphemeralTickInput['nodes'][string];
	installedMb: number;
	current: ObservedWarmSlot | null;
	/** #101: this pass's OWN measurement, not borrowed from the dispatch
	 *  tick's verdict — see the probe below and `spaceRefusal`. */
	tmpFreeMb: number | null;
	workFreeMb: number | null;
}

/**
 * #101: the `df -Pm` half of the space probe, shared VERBATIM between this
 * file's two ssh round-trips that read free space — `dispatchEphemeral`'s
 * node loop and `dispatchWarmCache`'s observation pass below — so the two
 * cannot drift into asking slightly different questions. Appended to
 * whichever `free -m` invocation each caller already makes; output is
 * always the free/total line(s) first, then exactly these two lines.
 */
const JIT_PROBE_DIR = jitRoot('~');
const JIT_PROBE_PARENT_DIR = JIT_PROBE_DIR.slice(0, JIT_PROBE_DIR.lastIndexOf('/'));
export const SPACE_PROBE_DF_CMD =
	"df -Pm /tmp | awk 'NR==2{print $4, $2}'; " +
	`(df -Pm ${JIT_PROBE_DIR} 2>/dev/null || df -Pm ${JIT_PROBE_PARENT_DIR} 2>/dev/null || df -Pm ~) | awk 'NR==2{print $4}'`;

/**
 * #101: the other half of the shared probe — parses `shellOnNode`'s RAW
 * output (which always ends in a newline, the way `execFile`'s stdout does;
 * a prior version split an already-split array and read the last TWO
 * elements, which on a trailing newline is `['...', '<tmp>', '<work>', '']`
 * — the real shape captured off claw-4 — so it silently read the WORK figure
 * as `/tmp`'s and the trailing empty string as "unreadable" `/work`. This
 * version splits the raw string itself, on `\r?\n`, trims every line, and
 * DROPS empty ones before counting, so a trailing (or stray blank) line
 * never shifts anything.
 *
 * The exact shape required is three non-empty lines: line 1 is the caller's
 * own `free -m` figures, handed back verbatim as `first` for its existing
 * parse; line 2 is `/tmp` free MB, then its total size MB (#132 — the
 * disk-watch advisory is judged against what the tmpfs can hold; a line
 * carrying the free figure alone reads with `tmpSizeMb: null`); line 3 is the
 * jit filesystem's free MB. Digits only, not `Number()`, on lines 2–3: an empty string, a `df` error
 * message, or a negative number must all read as unreadable (`null`), never
 * as 0-as-a-number (which would refuse) and never as `NaN` silently
 * admitted. Any shape other than exactly three non-empty lines makes BOTH
 * figures `null` — a shifted line must never be read as the other
 * filesystem's figure — even though `first` is still handed back whenever a
 * first line exists, since the caller's own parse of it is independent of
 * whether the df probe came back intact.
 */
export function parseSpaceProbe(out: string | null): {
	first: string;
	tmpFreeMb: number | null;
	tmpSizeMb: number | null;
	workFreeMb: number | null;
} {
	const lines = String(out ?? '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const first = lines[0] ?? '';
	if (lines.length !== 3) {
		return { first, tmpFreeMb: null, tmpSizeMb: null, workFreeMb: null };
	}
	const tmp = /^(\d+)(?:\s+(\d+))?$/.exec(lines[1]);
	const workRaw = lines[2];
	return {
		first,
		tmpFreeMb: tmp ? Number(tmp[1]) : null,
		tmpSizeMb: tmp?.[2] !== undefined ? Number(tmp[2]) : null,
		workFreeMb: /^\d+$/.test(workRaw) ? Number(workRaw) : null,
	};
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
	const input = withoutGuests(tickInput);
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
	const sharedHosting = effectiveHosting(readHostingDoc());

	const observed = (
		await Promise.all(
			[...input.ephemeral].map(async (node): Promise<ObservedWarmNode | null> => {
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
					const totalOut = await sh(
						node,
						"free -m | awk '/^Mem:/{print $2}'; " + SPACE_PROBE_DF_CMD
					);
					const { first, tmpFreeMb, workFreeMb } = parseSpaceProbe(totalOut);
					// A SHARED HOSTING SLICE is not CI's to count on: installed memory
					// includes it, so the whole declaration comes off what a listener
					// may plan around (src/runners/hosting-record.ts).
					const hostedMb = sharedHosting[node]?.memoryMb ?? 0;
					const installedMb = Number(first);
					if (!Number.isFinite(installedMb) || installedMb <= 0) {
						logger.warn(
							`[warm-cache] ${node}: could not read installed memory — not eligible this tick`
						);
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

					const marker = await readWarmMarker(node, sh);
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

					return { node, m, installedMb, current, tmpFreeMb, workFreeMb };
				} catch (err) {
					result.failed++;
					logger.warn(`[warm-cache] ${node}: ${err instanceof Error ? err.message : String(err)}`);
					return null;
				}
			})
		)
	).filter((o): o is ObservedWarmNode => o !== null);

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
	const neverWarm = new Set<string>();
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
			if (tier === 'slow' || drained || spaceRefused || runningHeavyNow) {
				neverWarm.add(o.node);
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
					planNodes.push({ node: o.node, current: null });
					continue;
				}
				result.failed++;
				logger.warn(
					`[warm-cache] could not evict ${o.node}'s excluded warm slot for ${o.current.repo}`
				);
			}
			planNodes.push({ node: o.node, current: o.current });
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
			if (!excludedForTick) planNodes.push({ node: o.node, current: o.current });
		}
	}

	// THE JOINT ALLOCATION (wave 3k §B). Every eligible node's slot is decided
	// at once, over the fleet's history, so the Nth node takes the Nth most
	// valuable UNCOVERED repo — a per-node argmax put hadoku_site on all four.
	// `planNodes`, not `observed`, is what is handed over (#82, #83 above):
	// `planWarmFleet` is pure and knows nothing of exclusions or speed, so the
	// node list it is given IS the eligibility it can ever honour.
	const decisions = planWarmFleet({
		nodes: planNodes,
		served: fleetServedJobs(),
		nowMs,
	});

	await Promise.all(
		observed.map(async ({ node, m, installedMb, current }) => {
			if (neverWarm.has(node)) return;
			try {
				const decision = decisions.get(node) ?? { action: 'idle' };
				// #82, THE OTHER HALF: `planWarmFleet` ranks repos by served history
				// alone and can still propose FILLING or ROTATING a node onto a repo
				// that node excludes — it was never told. Caught here, before any
				// mint, rather than trusted to the pre-pass above, which only knows
				// about the repo a node ALREADY holds.
				//
				// COUNTED AS `locked`, not a new field on `WarmCacheResult`: both mean
				// "the allocator wanted to change this slot and something outside its
				// own model said no" — a busy/assign-window lock for `locked`'s usual
				// case, a manifest exclusion for this one. A dedicated counter was
				// tried and reverted: `WarmCacheResult` is asserted by exact shape
				// (`assert.deepEqual`) in a dozen-plus existing tests this lane does
				// not own, and even a strictly additive field broke a chain of them —
				// one assertion without a try/finally around its own
				// `WARM_CACHE_DISABLED` mutation threw before restoring it, which left
				// the kill switch ON for every test after it in the same process.
				const target =
					decision.action === 'fill'
						? decision.repo
						: decision.action === 'rotate'
							? decision.to
							: null;
				if (target !== null) {
					const reason = warmExcluded(node, m, target);
					if (reason !== undefined) {
						result.locked++;
						logger.info(
							`[warm-cache] ${node}: withholding a ${decision.action} onto ${target} — ${reason}`
						);
						return;
					}
				}
				// THE SLICE CEILING for this node, from the SAME measured total the
				// eligibility check above already read — `installedMb` is `free -m`'s
				// `$2`, and `minFreeMb` is the floor that keeps the claw alive. A warm
				// listener serves the same jobs a JIT unit does, so capping it lower
				// would reintroduce #26 on exactly the path the cache exists to make
				// faster.
				const memoryMaxMb = unitMemoryMaxMb({
					requestedMb: m.slice?.unitMaxMb,
					sliceCeilingMb: installedMb - (m.minFreeMb ?? 1536),
				});
				// The warm half of the containment assertion. A warm listener sits in
				// its slice for HOURS rather than for one job, so a node whose declared
				// slice the minter cannot honour is worth saying out loud here too.
				checkMintSlice(input.nodes, node);
				const mintFor = async (repo: string) =>
					mintWarmListener(
						{
							node,
							repo,
							runnerName: warmRunnerName(node, repo),
							// DERIVED, not declared — see `offerFor`. `warmLabels` subtracts
							// the ephemeral-only ones on top of this, because a warm listener
							// is STANDING and must never be able to answer the canary.
							labels: offerFor(input.nodes, node, workloadGate),
							homeDir: nodeHome(input.nodes[node], 'ci'),
							memoryMaxMb,
							tarballUrl: await tarballUrl(),
						},
						token,
						gh,
						sh
					);

				switch (decision.action) {
					case 'idle':
					case 'keep': {
						// WORKLOAD-GATE ROTATION (wave 4e follow-up, #102). A slot
						// `planWarmFleet` is content to KEEP can still be carrying a
						// WORKLOAD-GATED label `offerFor` no longer offers this node —
						// claw-3's own shape, if claw-3 holds a warm listener for
						// cardtable: its jdk21 FAILS, placement and the JIT mint both
						// stop offering it from that tick on, but this already-registered
						// listener answers `jdk21` to GitHub until something else evicts
						// it. Only a GATED label triggers this — any other label drift
						// is out of scope for this wave and must not start churning
						// slots on its own.
						//
						// NO NEW API CALL: `current.labels` is read off the SAME
						// `/actions/runners` listing `warmRegistration` already fetched
						// for the busy/online check above. `null` means that listing
						// could not confirm the registration's labels (same reason
						// `busy` would be `null`) — "could not look" must not churn a
						// slot on a guess, so it is treated exactly like "nothing stale
						// found": kept, not rotated.
						const stale = current?.labels
							? workloadGatedCapabilities().find(
									(id) =>
										current.labels!.includes(id) &&
										!offerFor(input.nodes, node, workloadGate).includes(id)
								)
							: undefined;
						// BUSY IS NEVER ROTATED (same rule `locked`/the eviction passes
						// above already enforce): a listener running a job is not killed
						// mid-job. `current.busy` already fails toward `true` ("could not
						// confirm" — see its own assignment above), so an unreadable
						// registration is treated as busy here too, which is the same
						// safe direction.
						if (!stale || !current || current.busy) {
							result.kept++;
							return;
						}
						if (warmBackoffActive(node, nowMs)) {
							result.kept++;
							return;
						}
						logger.info(
							`[warm-cache] ${node}: rotating ${current.repo} — workload-gate: ` +
								`offerFor no longer offers "${stale}" for this node, which the ` +
								`existing registration still advertises to GitHub`
						);
						const evicted = await evictWarmListener(
							node,
							current.repo,
							warmRunnerName(node, current.repo),
							token,
							gh,
							sh
						);
						if (!evicted) {
							result.failed++;
							logger.warn(
								`[warm-cache] could not evict ${current.repo} warm slot on ${node} for a workload-gate relabel`
							);
							return;
						}
						result.evicted++;
						const outcome = await mintFor(current.repo);
						if (outcome.ok) {
							clearWarmFailures(node);
							result.rotated++;
						} else {
							recordWarmFailure(node, nowMs);
							result.failed++;
							logger.warn(
								`[warm-cache] workload-gate rotate failed on ${node} for ${current.repo}: ${outcome.reason}`
							);
						}
						return;
					}
					case 'locked':
						result.locked++;
						return;
					case 'fill': {
						// issue #7 clause (c): backed off, skip SILENTLY. This is the
						// difference between "the log stops repeating every minute"
						// and "the log repeats but nobody pays for it" — a node stuck
						// on a real fault (e.g. the runner root is unreachable) must
						// not cost a registration-token call and a heavy provisioning
						// ssh every single tick.
						if (warmBackoffActive(node, nowMs)) return;
						const outcome = await mintFor(decision.repo);
						if (outcome.ok) {
							clearWarmFailures(node);
							result.filled++;
						} else {
							recordWarmFailure(node, nowMs);
							result.failed++;
							logger.warn(
								`[warm-cache] fill failed on ${node} for ${decision.repo}: ${outcome.reason}`
							);
						}
						return;
					}
					case 'rotate': {
						if (warmBackoffActive(node, nowMs)) return;
						const evicted = await evictWarmListener(
							node,
							decision.from,
							warmRunnerName(node, decision.from),
							token,
							gh,
							sh
						);
						if (!evicted) {
							result.failed++;
							logger.warn(`[warm-cache] could not evict ${decision.from} warm slot on ${node}`);
							return;
						}
						result.evicted++;
						const outcome = await mintFor(decision.to);
						if (outcome.ok) {
							clearWarmFailures(node);
							result.rotated++;
						} else {
							recordWarmFailure(node, nowMs);
							result.failed++;
							logger.warn(
								`[warm-cache] rotate failed on ${node} for ${decision.to}: ${outcome.reason}`
							);
						}
						return;
					}
				}
			} catch (err) {
				result.failed++;
				logger.warn(`[warm-cache] ${node}: ${err instanceof Error ? err.message : String(err)}`);
			}
		})
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
	// the nodes this set names. See `withoutGuests`.
	const input = withoutGuests(tickInput);
	// THE ON-DEMAND GUESTS (#120), minted for beside the claws but never part of
	// `input.ephemeral`: that set is general CI capacity, and the warm cache just
	// below must not see a guest at all — on-demand means no listener parked on
	// the production host's memory. They are placed LAST and offered
	// `hadoku-builder` only while the backstop holds them; see `offerFor`.
	const guests = onDemandGuests(input);
	const minting = [...input.ephemeral, ...guests];
	if (!minting.length) return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	const isGuest = (name: string): boolean => guests.includes(name);
	// The backstop hold is read ONCE per tick. Placement's `NodeState.labels` and
	// the mint's `labelsFor` both ask this, seconds apart, with probes and GitHub
	// polls in between — and runner-health flips the hold on its own clock. On
	// 2026-10-23 it demoted hokon at 19:21:42, and at 19:21:48 the mint of a
	// `hadoku-builder` job hokon had been PLACED for registered without
	// `hadoku-builder`. The job could never land on it, and "already has a
	// runner in flight" kept every claw from taking it for the unit's full TTL.
	const heldThisTick = new Set(guests.filter(isBackstopHeld));
	const eligibleFor = (name: string): boolean => !isGuest(name) || heldThisTick.has(name);
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

	// REAL free memory, in MB, read from the nodes.
	//
	// The tier probe's `free` is FREE SLOTS (`cap - workers`), not megabytes, and
	// passing it as `freeMb` made admission compute `3 - 4096` and refuse every
	// mint forever — a units mismatch that reads as a correctly-wired dispatcher
	// declining work. One ssh per EPHEMERAL node per tick, so the cost is
	// bounded by the pilot's size, not the fleet's.
	//
	// INSTALLED capacity rides the same call, in the same `free -m` line. It is
	// what the per-unit cap is derived from (`MemTotal − minFreeMb`, the slice's
	// own ceiling — see `unitMemoryMaxMb`), and adding a second ssh for a number
	// already on this line would have doubled the tick's per-node cost for
	// nothing. `$7` is available, `$2` is total; the warm half reads the same two
	// columns the same way.
	const freeMbByNode = new Map<string, number>();
	const sliceCeilingMbByNode = new Map<string, number>();
	// #101: SPACE, read on the SAME ssh call as `free -m` rather than a second
	// round-trip — the fleet already blacked itself out once on an
	// unconditional per-node call run too often (REAP_INTERVAL_MS,
	// 2026-09-06), and this one piggybacks on a call this tick already makes.
	// `df -Pm` (POSIX, MB) on `/tmp`, and on whichever of `~/.hadoku/jit`,
	// `~/.hadoku`, or `$HOME` exists — a node that has never minted has no
	// `jit` directory yet, and that absence is not "unreadable". ALWAYS set,
	// never left unset: `undefined` on `AdmissionInput.tmpFreeMb`/`workFreeMb`
	// means "this caller never looked" (prove-job's literal only) and the
	// live tick must never silently become that caller — see `AdmissionInput`.
	const tmpFreeMbByNode = new Map<string, number | null>();
	const tmpSizeMbByNode = new Map<string, number | null>();
	const workFreeMbByNode = new Map<string, number | null>();
	// SHARED HOSTING (src/runners/hosting-record.ts): a hosting node's probe also
	// reads the tenant slice's usage, on the same ssh, so admission can hold back
	// exactly the part of the slice the tenant is not using yet.
	const sharedHosting = effectiveHosting(readHostingDoc());
	const heldBackMbByNode = new Map<string, number>();
	await Promise.all(
		minting.map(async (name) => {
			const hosted = sharedHosting[name];
			const raw = await sh(
				name,
				"free -m | awk '/^Mem:/{print $7, $2}'; " +
					SPACE_PROBE_DF_CMD +
					(hosted ? `; ${sliceUsageProbe(hosted.tenant)}` : '')
			);
			const { rest: out, sliceCurrentMb } = takeSliceUsage(raw);
			if (hosted) {
				heldBackMbByNode.set(
					name,
					heldBackMb({ declaredMb: hosted.memoryMb, sliceCurrentMb, since: hosted.since })
				);
			}
			const { first, tmpFreeMb, tmpSizeMb, workFreeMb } = parseSpaceProbe(out);
			const [free, total] = first.split(/\s+/).map(Number);
			if (Number.isFinite(free) && free > 0) freeMbByNode.set(name, free);
			// The FLOOR that keeps the claw alive, subtracted here rather than on
			// the node: `minFreeMb` is operator config and MemTotal is measured, so
			// this is the one place both are in hand. A node whose total is smaller
			// than its own floor is a manifest error — `runners-slice-install.sh`
			// answers SLICE-FAIL for it — and it must not become a cap of zero.
			//
			// A GUEST'S CEILING IS ITS ALLOWANCE. On the production host CI gets
			// `slice.maxMb`, deliberately far below MemTotal − minFreeMb, and
			// admission must measure a guest job against what the slice will
			// actually let it have, not against memory production is using.
			const floorCeiling = total - (input.nodes[name]?.minFreeMb ?? 1536);
			const allowance = isGuest(name) ? input.nodes[name]?.slice?.maxMb : undefined;
			const ceiling =
				typeof allowance === 'number' && allowance > 0
					? Math.min(floorCeiling, allowance)
					: floorCeiling;
			if (Number.isFinite(total) && total > 0 && ceiling > 0)
				sliceCeilingMbByNode.set(name, ceiling);
			tmpFreeMbByNode.set(name, tmpFreeMb);
			tmpSizeMbByNode.set(name, tmpSizeMb);
			workFreeMbByNode.set(name, workFreeMb);
			// LOGGED ONCE PER PROCESS LIFETIME PER NODE, not every 15 s tick —
			// `runner-health.ts`'s own tick, and any verdict CHANGE below, are the
			// other two places this is visible. grep: "space probe".
			if (!loggedSpaceProbeOnce.has(name)) {
				loggedSpaceProbeOnce.add(name);
				logger.info(
					`[ephemeral-tick] space probe ${name}: /tmp free=${tmpFreeMb ?? 'unreadable'}MB ` +
						`of ${tmpSizeMb ?? 'unknown'}MB, ` +
						`_work free=${workFreeMb ?? 'unreadable'}MB`
				);
			}
		})
	);
	// Wave 4c §F: hand the SAME per-node space-probe maps this tick already
	// built for admission's own space clause to the early-warning registry in
	// disk-watch.ts/runner-health.ts. No second probe, no second ssh — see
	// disk-watch.ts's own header for why this registry lives there instead of
	// beside admissionVerdictByNode here, and why WHOLESALE replace is the rule.
	recordDiskReadings(tmpFreeMbByNode, workFreeMbByNode, tmpSizeMbByNode);

	const nodes: NodeState[] = [];
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
	const candidates: string[] = [];
	// THE GENERIC ADMISSION VERDICT (wave 4a §A.1, #100), built fresh this pass
	// and published wholesale after the loop — see `admissionVerdictByNode`'s
	// own note on why wholesale, not merged.
	const nextVerdicts = new Map<string, AdmissionVerdict>();
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
		const capMb = isGuest(name)
			? guestUnitMemoryMaxMb({ requestedMb: m.slice?.unitMaxMb, sliceMaxMb: m.slice?.maxMb })
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
			// #15: placement keeps part of a guest back from overflow work.
			onDemandGuest: isGuest(name),
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
				const prev = admissionVerdictByNode.get(name);
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
	// PUBLISHED EVEN WHEN EMPTY — see `admissionVerdictByNode`'s own note. Every
	// node this pass could not reach, or could not read memory for, is simply
	// absent from `nextVerdicts`, which is exactly "could not look" for THAT
	// node and must be published as such rather than left stale.
	admissionVerdictByNode = nextVerdicts;
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
	// GUESTS LAST, whatever the ordering thinks of them. A guest is idle on most
	// ticks and fast, so a load- or speed-ranked order would put the production
	// host FIRST — the inverse of a backstop. It takes what no claw can: a job
	// only its labels fit, or one every claw refused this pass.
	const placementOrder = [
		...orderCandidates(
			candidates.filter((n) => !isGuest(n)),
			trafficNodes
		),
		...orderCandidates(candidates.filter(isGuest), trafficNodes),
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
				// A GUEST'S CAP IS ITS OWN, not a share of the claws' — see
				// `guestUnitMemoryMaxMb` for why the claw rule below would hand one
				// job the whole guest allowance.
				if (isGuest(node)) {
					const g = input.nodes[node]?.slice;
					return guestUnitMemoryMaxMb({ requestedMb: g?.unitMaxMb, sliceMaxMb: g?.maxMb });
				}
				// THE SLICE CEILING, not a flat number (issue #26). See
				// `unitMemoryMaxMb`: a cap below the slice's own ceiling is a second,
				// tighter bound that fires first and attributes the death to whatever
				// was allocating — brave-quartet's `wasm-size` died that way on claw-2
				// against 4 GiB while the node had 13.8 GiB of CI budget unspent.
				//
				// STILL THE FLEET MIN FOR A CLAW, though the node is now known (#120
				// passes it, for the guest above). This used to be forced — the node
				// was chosen after this was asked — and is now only unchanged: a claw
				// cap read off its own ceiling is a separate decision from #120, and
				// it would widen the cap on every larger claw at once. Claws only: a
				// guest's allowance is not a claw's ceiling and must not lower it.
				// Every claw in `nodes` has a MEASURED ceiling, because the loop above
				// refuses to admit a node without one, so this cannot silently fall
				// back while any claw was admitted.
				const ceilings = nodes
					.filter((n) => !isGuest(n.name))
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
			// the guest declares one today; every claw resolves to the default.
			sliceNameFor: (node) => input.nodes[node]?.slice?.name,
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
