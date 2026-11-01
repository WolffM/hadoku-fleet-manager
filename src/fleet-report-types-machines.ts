/**
 * `FleetMachine` and the per-node wire shapes it is built from — one SECTION
 * of the `GET /fleet` contract (wave 5r lane A pure move out of
 * `fleet-report-types.ts`). See that file's own header for why this is a
 * type-only barrel's section rather than a runtime module: nothing here
 * does any I/O, and `fleet-report-types.ts` re-exports every name below for
 * every existing importer.
 */
import type { ClawState } from './lib/fleet-vocabulary.js';

/** @see FleetMachine.admissionBasis */
export type AdmissionBasis = 'dispatcher' | 'standing';

/**
 * @see FleetMachine.admissionRefusal
 *
 * Mirrors `ephemeral-tick.ts`'s own `AdmissionClause` (not imported — this
 * package's wire-contract file stays free of runtime imports, same as every
 * other enum here). `memory` covers both the plain memory clause and the #76
 * lower-bound PLACEMENT clause: both are refused for want of room. `space`
 * (#101) is refused for want of `/tmp` or `~/.hadoku/jit` free space — a
 * filesystem can fill while memory stays free, so it is never folded into
 * `memory`; see `AdmissionRefusal.filesystem` for which one. `other` is
 * defensive, for a clause this contract does not yet name.
 */
export type AdmissionClause = 'drained' | 'concurrency' | 'memory' | 'space' | 'other';

/**
 * Why `admitMint`'s GENERIC per-tick check refuses this EPHEMERAL node right
 * now. THREE STATES, not two — see `FleetMachine.admissionRefusal`, which is
 * where the key being ABSENT, present-as-`null`, and present-as-an-object are
 * each spelled out. This interface is the third of those.
 *
 * THIS IS THE FIELD `admissionFree` COULD NOT BE (wave 4a, #100). See
 * `FleetMachine.admissionFree`'s own doc comment: that figure counts SLOTS
 * against `maxConcurrent` and never applies the memory clause, so a node can
 * read `admissionFree: 2` while refusing every mint on memory — exactly the
 * shape that left claw-6 and claw-2 starving in silence for days. Read
 * `FleetMachine.admissionRefusal`, not `admissionFree`, to answer "can this
 * node actually take a job right now".
 *
 * GENERIC, not per-run: computed once per node per `ephemeral-tick.ts` pass,
 * before any specific queued job is known, so it answers "could this node
 * take A job" rather than "could it take THIS one". Display only — nothing
 * here feeds back into scheduling.
 */
export interface AdmissionRefusal {
	clause: AdmissionClause;
	/** This node's free memory, measured the tick the verdict was taken — or,
	 *  when `clause === 'space'`, the free MB on {@link filesystem} instead
	 *  (still measured, never declared: `df -Pm`, not a manifest figure). */
	availableMb: number;
	/** What that tick's generic check reserved against it — or, when
	 *  `clause === 'space'`, the free-MB floor {@link filesystem} failed to
	 *  clear. */
	needMb: number;
	/** Present only when `clause === 'space'`: which filesystem refused —
	 *  `'tmp'` for `/tmp`, `'work'` for the filesystem holding
	 *  `~/.hadoku/jit` (or its fallback, `~/.hadoku`/`$HOME`, on a node that
	 *  has never minted). Absent for every other clause. */
	filesystem?: 'tmp' | 'work';
	/** Present only when the free space on {@link filesystem} could not be
	 *  read — `availableMb` is then `0` and is not a measurement. Absent for
	 *  every other refusal, including a measured below-floor space
	 *  refusal. */
	unreadable?: true;
	/** Which of the three reserve answers (`repo` measured, `node` hand-set,
	 *  `default`) produced `needMb`. Meaningless for `clause === 'space'`
	 *  (carried anyway, same reasoning as `ephemeral-tick.ts`'s own
	 *  `AdmissionVerdict`). */
	reserveBasis: 'repo' | 'node' | 'default';
	/** `admitMint`'s own reason string, verbatim — detail a clause alone
	 *  cannot carry (the exact capacity count, or the exact MB gap). */
	reason: string;
}

/**
 * Why a node's admission numbers are absent or provisional. `null` is the
 * healthy case: measured, and against a budget its operator actually chose.
 *
 * SEPARATE FROM THE NUMBERS because "could not look" and "looked, but nobody
 * has said what this box is allowed to do" are different problems with
 * different owners, and both used to arrive as the same `null`.
 */
export type AdmissionCaveat = 'unreachable' | 'undeclared';

export interface FleetMachine {
	name: string;
	cores: number | null;
	ramGb: number | null;
	labels: string[];
	maxRegistrations: number | null;
	maxConcurrent: number | null;
	excludedRepos: string[];
	reachable: boolean | null;
	workers: number | null;
	/**
	 * THREE CAPACITY NUMBERS LIVE ON THIS OBJECT AND THEY ARE NOT THE SAME NUMBER.
	 *
	 *   `maxConcurrent`      the BOX's ceiling. What the hardware and the throttle
	 *                        allow to run at once.
	 *   `capacity` / `free`  the TIER LADDER's budget (`tierCapacity`), and what
	 *                        is left of it. These feed `worstRepoFreeSlots` ->
	 *                        `decideTiers`, i.e. which tiers get labelled.
	 *   `admissionCapacity`  the budget that ACTUALLY decides whether one more
	 *   / `admissionFree`    job can start on THIS node. See below.
	 *
	 * A reader showing "can this node take work" wants the third pair. Which one
	 * that is depends on the node, and getting it wrong is not cosmetic — it is
	 * how the panel came to print "full" on a node the dispatcher would happily
	 * mint on twice more.
	 */
	capacity: number | null;
	free: number | null;
	/**
	 * The budget that admits work on this node, and what is left of it.
	 *
	 * EPHEMERAL nodes: `maxConcurrent`. `admitMint` tests
	 * `liveUnits + standingBusy >= maxConcurrent` and nothing else caps
	 * concurrency there. The dispatcher never consults tier ACTIVATION at all —
	 * `ephemeral-tick` builds its candidate list from every ephemeral node and
	 * uses the ladder only as a preference ORDER — so `tierCapacity` gates
	 * nothing on a JIT node. It still feeds `decideTiers`, but that acts by
	 * writing labels, and an ephemeral node holds no standing registration to
	 * label.
	 *
	 * STANDING nodes: `tierCapacity`, unchanged. There the ladder's slot maths
	 * really is what decides whether the node is switched on.
	 *
	 * Measured 2026-09-02 across six JIT claws: the tier numbers reported 7 free
	 * slots where the dispatcher would have taken 12, and claw-3 rendered "full"
	 * with two mints' worth of room.
	 *
	 * DERIVED FOR DISPLAY. `capacity`/`free` above are deliberately untouched, as
	 * are the census and the probe: those feed `isAtCapacity` and the backstop's
	 * saturation promote, and re-basing them would be a scheduling change wearing
	 * a display fix's clothes.
	 *
	 * `admissionFree` COUNTS SLOTS AGAINST `maxConcurrent` AND NEVER APPLIES THE
	 * MEMORY CLAUSE (wave 4a, #100). `admitMint` refuses on TWO grounds —
	 * capacity (`liveUnits + standingBusy >= maxConcurrent`) and memory (free
	 * MB cannot clear the repo's reserve with `minFreeMb` left over) — and this
	 * figure is built from `mintBudget`'s slot arithmetic alone. A node can
	 * therefore show `admissionFree: 2` while `admitMint` refuses every mint on
	 * memory, which is exactly the shape that left claw-6 and claw-2 starving
	 * in silence for days: both reported `mintable` here while admission
	 * refused them on every tick. Read `admissionRefusal` below to answer "can
	 * this node actually take a job right now" — do not repeat this field's
	 * mistake by inferring that answer from a slot count.
	 */
	admissionCapacity: number | null;
	admissionFree: number | null;
	/**
	 * Which budget `admissionCapacity` is, so a reader can say so rather than
	 * guess. `vocabulary.admissionBases` describes each value, so a consumer
	 * never has to know what the word means — which is what lets `'tier'`
	 * disappear when the ladder does, without a change downstream.
	 */
	admissionBasis: AdmissionBasis | null;
	/**
	 * Why the two numbers above are missing or provisional. `null` means they are
	 * measured AND declared.
	 *
	 *   `unreachable`  the probe could not reach the box, so both are `null`.
	 *                  Its capacity is UNKNOWN, which is not zero.
	 *   `undeclared`   the box is reachable and the dispatcher will mint on it,
	 *                  but its operator has declared no `maxConcurrent`, so the
	 *                  figures come from `mintBudget`'s fallback. Real, and worth
	 *                  saying out loud: `fleet enroll` writes exactly this node.
	 *
	 * Before this existed both arrived as a bare `null` and `fleet.ts` summed
	 * them as `?? 0`, so an unreachable claw and a claw with no room rendered
	 * identically. `vocabulary.admissionCaveats` carries the wording.
	 */
	admissionCaveat: AdmissionCaveat | null;
	/** LIVE labels from GitHub — what the machine will actually be scheduled for. */
	liveLabels: string[] | null;
	eligible: boolean | null;
	runnersBusy: number | null;
	runnersOnline: number | null;
	/**
	 * What this machine is doing, in one word, from the census the backstop acted
	 * on: free | busy | demoted | offline | absent | mintable | unreachable | sick.
	 *
	 * `eligible` above says only whether a label is present. It cannot separate
	 * "demoted" from "not registered for this repo at all" — and those two states
	 * both render as a smaller `clawsOnline` while needing different fixes.
	 */
	state: ClawState | null;
	/**
	 * This node mints a runner per job instead of carrying standing ones.
	 *
	 * Load-bearing for RENDERING, not just for the dispatcher: an ephemeral node
	 * holds no standing registration, so `liveLabels`, `eligible`, `runnersBusy`
	 * and `runnersOnline` are all legitimately `null` on it — forever, on a
	 * perfectly healthy node. Without this flag a reader cannot tell that apart
	 * from a standing node GitHub has stopped listing, and the two look identical
	 * in the payload: five null columns either way.
	 */
	ephemeral: boolean;
	/**
	 * Why `admitMint`'s generic check refuses this node right now. ADDITIVE
	 * (wave 4a, #100). @see AdmissionRefusal for the full story, including why
	 * this is the field to read instead of `admissionFree`.
	 *
	 * THREE STATES ON THE WIRE, and a reader must tell all three apart —
	 * collapsing any two is "could not look" rendering as "nothing is wrong"
	 * (CLAUDE.md), which is the exact bug this field exists to stop repeating:
	 *
	 *   KEY ABSENT   this process has NO VERDICT for this node right now —
	 *                `ephemeral-tick.ts` has not ticked since a restart yet,
	 *                this node is not in that pass's ephemeral set this tick
	 *                (unreachable, or an unreadable memory figure), or the
	 *                node is STANDING (`admitMint` is JIT-only — see
	 *                `ephemeral` above). NEVER "admitted" and never emitted as
	 *                `null`: an absent key is what lets a reader (lane B's
	 *                `fleet traffic`, `scripts/traffic-status.mjs`) map it to
	 *                "unknown" rather than silently agreeing with whatever a
	 *                stale `null` would have implied.
	 *   `null`       a verdict EXISTS and it currently ADMITS. The key is
	 *                present; its value says "fine as of this tick".
	 *   an object    a verdict exists and it currently REFUSES — the numbers
	 *                in {@link AdmissionRefusal}.
	 *
	 * `JSON.stringify` drops a key whose value is the literal `undefined`, so
	 * "absent" here means omitted at the point this object is BUILT
	 * (`routes/fleet.ts`), not merely assigned `undefined` — the two look
	 * identical to `in`/`hasOwnProperty` on the object as constructed, but a
	 * caller that assigns `undefined` explicitly is one slip away from the
	 * key surviving a non-JSON transport. `routes/fleet.ts`'s own test pins
	 * the key's absence through a JSON round-trip for exactly this reason.
	 */
	admissionRefusal?: AdmissionRefusal | null;
	/**
	 * What the DISPATCHER charged this node at the start of its last pass,
	 * beside what it could see (`runners/capacity-ledger.ts`, 2026-10-21).
	 * `inFlight/budget` is the number the dispatcher's `at capacity` refusal
	 * reads — a different question from `busy`/`maxConcurrent` above, which
	 * count registrations. The two were shown as one for fourteen days while
	 * the first was double-counting. `ok: false` is the invariant broken and
	 * `why` says how. `null`: this process has run no dispatch pass yet, or
	 * the node was not in the last one (standing nodes are not).
	 */
	dispatchLedger?: FleetMachineLedger | null;
	/**
	 * Is `runner-health.ts`'s starvation check currently alerting on this node?
	 * ADDITIVE (wave 4a, #100).
	 *
	 * TRUE requires all three of: the latest verdict above is a MEMORY refusal,
	 * this node's last started job (from job history) is older than
	 * `STARVED_NO_JOB_MS`, and OTHER nodes started jobs in that same window —
	 * an idle fleet is never a finding, and a node refused for any other
	 * reason (drained, at capacity, or excluded) is never starved by this
	 * field even while `admissionRefusal` is an object for it. `false` on
	 * every standing node, and on hokon, which this check never names.
	 *
	 * NEVER `undefined`, unlike `admissionRefusal` above — a reader always
	 * gets a definite answer to "is this currently paging", even on a node
	 * `runner-health.ts` has never named (defaults `false`).
	 */
	starved: boolean;
	/**
	 * What bootcamp PROVED here by executing it — the node's `$capabilities`
	 * record, passed through. `null` when bootcamp has never reached the node:
	 * no evidence, which is not evidence of no capability. `prereqs[].detail`
	 * carries the toolchain versions (ffmpeg, gh, chromium build).
	 */
	capabilities: FleetMachineCapabilities | null;
	/**
	 * One entry per workload-gated capability whose TOOL this node has earned
	 * (wave 4e, #102): whether the gate offers the label here and why. An empty
	 * object means the node earned no gated tool, not that every gate is clean.
	 */
	workloadGates: Record<string, FleetWorkloadGate>;
	/**
	 * The CURRENT workload proof per gated capability — the canary run that
	 * decided the gate, with its time, duration and budget — or `null` for a
	 * gated capability this node has no proof of.
	 */
	workloadProofs: Record<string, FleetWorkloadProof | null>;
	/**
	 * Hardware and OS as onboarding last measured them (`$measured`), trimmed.
	 * `null` for a node onboarding never measured.
	 */
	measured: FleetMachineMeasured | null;
	/**
	 * The OS as the node RUNS it now, from the 60s probe: `/etc/debian_version`
	 * (the point release `measured` cannot see) and `uname -r`. `null` for a
	 * node not probed yet; a half the node could not read is `null`. Prefer
	 * this over `measured.osCodename`/`kernel`, which are enrollment-time.
	 */
	os: { release: string | null; kernel: string | null } | null;
}

/** Mirrors `capabilities.BootcampFacet` — every key optional, as the producer writes it. */
export interface FleetMachineCapabilities {
	at?: string;
	by?: string;
	declared?: string[];
	earned?: string[];
	unclaimed?: string[];
	unearned?: { id: string; detail?: string }[];
	blocked?: { id: string; detail?: string }[];
	prereqs?: { id: string; detail?: string }[];
	unprobed?: string[];
	/** The idle measurement behind each idle-only verdict (2026-10-10). */
	measurements?: Record<
		string,
		{ value: number | null; idle: boolean; earned: boolean; at: string }
	>;
}

/** Mirrors `capabilities.WorkloadGateStatus`. */
export interface FleetWorkloadGate {
	/** Does this gate currently let the label through for this node? */
	offer: boolean;
	/** Has the gate cleared its minimum proven count fleet-wide? */
	active: boolean;
	provenCount: number;
	/** One operator-facing line. */
	reason: string;
}

/** Mirrors `measured.ProofRecord`, minus the node and capability it is keyed by. */
export interface FleetWorkloadProof {
	runId: number | null;
	runner: string | null;
	conclusion: string | null;
	durationSec: number | null;
	/** `null` while the gate is unbootstrapped (fewer proven nodes than its minimum). */
	budgetSec: number | null;
	evidenceMatched: boolean;
	verdict: 'pass' | 'fail' | 'stale';
	why: string;
	at: string;
}

export interface FleetMachineMeasured {
	at: string | null;
	memTotalMb: number | null;
	diskFreeGb: number | null;
	diskModel: string | null;
	kernel: string | null;
	osCodename: string | null;
	verified: boolean | null;
}

/** @see FleetMachine.dispatchLedger */
export interface FleetMachineLedger {
	at: string;
	liveUnits: number;
	probeWorkers: number;
	standingBusy: number;
	warmHeld: number;
	budget: number;
	inFlight: number;
	ok: boolean;
	why: string | null;
}

/** One operator force in effect — see `backstop-force.ts`. */
export interface BackstopForced {
	node: string;
	since: string;
	until: string;
	remainingMin: number;
	reason: string;
	by: string;
}
