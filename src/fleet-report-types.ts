/**
 * The `GET /fleet` response contract.
 *
 * DECLARED, not inferred. `buildFleetReport` had no return type, and the
 * command station hand-maintained a 76-line copy of this shape in
 * `System/types.ts` — two descriptions of one payload with nothing checking
 * they agreed. A field renamed here would have surfaced as `undefined` in the
 * panel at runtime, on a page nobody opens until something is already wrong.
 *
 * The UI now imports these, so tsc fails the build instead.
 *
 * `floorBreach` LEFT THIS CONTRACT on 2026-09-02. It was computed in
 * captureSnapshot from `label_online` — a count of ONLINE STANDING runners
 * carrying each required label — and on an all-JIT fleet nothing standing
 * carries any label, so it read `true` permanently while the fleet placed and
 * completed work normally. 840a696 had already taught the ALERT path
 * (`checkLabelFloor`) to count minting; the snapshot's own copy was the second
 * answer to the same question and was never updated.
 *
 * It had exactly ONE consumer — a red banner on this panel saying "every fleet
 * job will queue until one returns", which was false every time it rendered.
 * The genuine floor alerting is `checkLabelFloor` and is unaffected. A field
 * that is both wrong and unread is not a contract, so it is gone rather than
 * fixed-and-unrendered.
 *
 * The COMPONENTS deliberately stay in the command station. It owns the panels
 * for PM2, secrets and keys the same way; the fleet is not special, and moving
 * them would make this package ship React. The contract is what had to be
 * shared, not the presentation.
 */
/**
 * HOW SEVERE A TELEMETRY TERM IS, on an axis that outlives the mechanism that
 * produced it.
 *
 * The point of shipping this is that a reader stops holding an opinion about
 * the fleet's states. The command station held one: a `Record<ClawState, Tone>`
 * and a prose line per state, in a repo with no way to learn when this package
 * changes them. Two of the states it described — `demoted` and `mintable` —
 * exist only because of the tier ladder and standing/ephemeral split, so the
 * moment either is reworked the panel keeps rendering confident sentences about
 * a mechanism that is gone. Nothing fails to compile; it just lies.
 *
 * A KIND, NOT A TONE. `warning` and `danger` are presentation and stay in the
 * consumer, which maps this axis onto its own palette once. What travels is
 * what only this package knows: whether a state is fine, deliberately held
 * back, degraded, broken, or unknown. A new state then arrives already
 * renderable, and a deleted one disappears without a commit in another repo.
 *
 *   ok         working as intended.
 *   reserve    healthy and deliberately not in use. NOT a fault — reading it as
 *              one is how idle capacity gets "fixed".
 *   degraded   serving, but worse than it should be.
 *   fault      not serving. Somebody has to do something.
 *   unknown    we could not look. Never render this as a zero — see the
 *              `?? 0` note on `FleetReport.fleet.clawsFreeMintable`.
 */
export type TelemetryKind = 'ok' | 'reserve' | 'degraded' | 'fault' | 'unknown';

/**
 * One value of a closed telemetry enum, described where it is defined.
 *
 * Mirrors `Capability` deliberately: that registry already ships
 * `{ kind, description }` per LABEL so a tooltip cannot describe a label
 * differently from the gate enforcing it. This is the same contract for the
 * report's own enums, which had no registry and were therefore re-described by
 * hand downstream.
 */
export interface TelemetryTerm {
	kind: TelemetryKind;
	/** One line, operator-facing, rendered verbatim. The only description there is. */
	description: string;
}

/**
 * A term with a short display label — at most six words — for a UI that shows
 * labels and keeps the description for hover. Every registry added since
 * 2026-10-09 carries one; the older ones may gain it as they are touched.
 */
export interface LabelledTerm extends TelemetryTerm {
	label: string;
}

/**
 * One failure zone, described. `group` is the coarse split a panel shows —
 * the fleet's side (`box`), the code's side (`code`), or neither — decided
 * here, beside the classifier, rather than re-derived downstream.
 */
export interface FailureZoneTerm extends LabelledTerm {
	group: 'box' | 'code' | 'neither';
}

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

/** @see FleetMachine.state */
export type ClawState =
	'free' | 'busy' | 'demoted' | 'offline' | 'absent' | 'mintable' | 'unreachable' | 'sick';

/**
 * A node's non-success records split by whose half of the fence they fell on —
 * `claw-floor-design-2026-09-07.md` §5.5's zone table, plus the fleet's own
 * kills, on the wire.
 *
 * THE FIVE SUM TO `FleetMachineJobStats.failures`. Every bucket is always
 * present with an explicit zero: a sparse object would render a node with no
 * runner-zone failures and a node nobody could look at identically.
 *
 * `runner`   GitHub's own synthetic steps (`Set up job`, `Complete job`, `Post
 *            *`), or no step record at all. The fleet's half by elimination.
 * `seam`     steps the workflow NAMED but did not write — `setup-python`,
 *            `checkout`, `install`. The seam between the consumer's yaml and
 *            the fleet's boxes; both known real fleet bugs landed here.
 * `content`  the consumer's own step.
 * `fleet`    the fleet's unit TTL stopped the job out from under it (issue
 *            #22) — a kill the fleet CAUSED, never the consumer's failure.
 * `cancelled` cancelled, deliberately unclassified: 420 of 639 non-success
 *            records in the 2026-09-08 window were `cancel-in-progress`
 *            supersedes, and the step one lands on is arbitrary.
 *
 * A ZONE IS A PRIOR, NOT A VERDICT. A content-zone step can still be the
 * fleet's (an OOM-killed test reports as `Tests` failing) and a seam step can
 * still be the consumer's (pinning `python-version: '3.13'` fails `Set up
 * Python` everywhere).
 *
 * RENDER `jobs` BESIDE ANY RATE COMPUTED FROM THESE. The fleet's measured
 * runner+seam rate is ~0.15 %, so at one node's volume a single event moves a
 * percentage by more than any real difference between boxes —
 * `docs/planning/failures-by-node-2026-09-15.md` has the arithmetic.
 */
export interface FleetFailuresByZone {
	runner: number;
	seam: number;
	content: number;
	fleet: number;
	cancelled: number;
}

export interface FleetMachineJobStats {
	machine: string;
	jobs: number;
	failures: number;
	/**
	 * `failures` SPLIT BY ZONE — see {@link FleetFailuresByZone}.
	 *
	 * ADDITIVE, and the reason it had to go on the wire rather than be derived:
	 * folding a failure into a zone needs `failedStep` and `failedPhase` AND
	 * §5.5's pattern table, none of which this package publishes to a browser
	 * bundle. The command station could show "claw-2: 11 failures" and could not
	 * show that ten of them were the consumer's own test — which is the whole
	 * question issue #3 asks.
	 */
	failuresByZone: FleetFailuresByZone;
	/**
	 * THE BASELINE — cut over the whole retained window (14 days, thousands of
	 * records), which is the only reason a percentile here is worth anything.
	 */
	medianSec: number | null;
	p95Sec: number | null;
	repos: number;
	/**
	 * THE SAME TWO FIGURES OVER THE TRAILING HOUR, beside the baseline and never
	 * instead of it.
	 *
	 * The panel could show a 14-day p50 and it could show the last 40 jobs, and
	 * it could not put the two together — "is the fleet slower than usual right
	 * now" was the one thing the operator asked for that this payload could not
	 * answer (issue #18, WolffM/hadoku_site#385). A consumer cutting its own
	 * window over `jobs.recent` cannot fix that: 40 records across 8 machines is
	 * n = 1..6 per node, and it is a RECORD count, so it spans minutes on a busy
	 * fleet and days on a quiet one and silently means something different each
	 * time. This window is a TIME window, cut server-side over the full history.
	 *
	 *   `recentJobs`       jobs this node FINISHED in the window. A count, so 0
	 *                      is a genuine reading.
	 *   `recentMedianSec`  `null` whenever `recentJobs` is 0, NEVER 0. A
	 *   `recentP95Sec`     percentile over no samples is no data, not a fast
	 *                      node — render it as "no data", the same way an
	 *                      unprobed machine's `free` is rendered.
	 *
	 * The window's own bounds travel too, so no reader has to assume them:
	 * `jobs.recentSince` and `jobs.recentWindowSec`.
	 *
	 * WHAT THEY CANNOT SEE. Job history holds COMPLETED jobs only, so a fleet
	 * that is stalled — everything queued or hung — empties this window rather
	 * than reddening it. An empty window is NOT a healthy one; `fleet.queuedNow`,
	 * `oldestQueuedMin` and `longestRunningMin` are what catch that. The window
	 * does guarantee the converse: because it is cut on COMPLETION rather than
	 * start, a three-hour job enters it in full the moment it lands, so it
	 * cannot get quieter the slower the fleet gets.
	 */
	recentJobs: number;
	recentMedianSec: number | null;
	recentP95Sec: number | null;
}

/** Mirrors `job-history.RepoJobStats`. */
export interface FleetRepoJobStats {
	repo: string;
	jobs: number;
	failures: number;
	failuresByZone: FleetFailuresByZone;
	/** Whole-job `durationSec`. */
	medianSec: number | null;
	p95Sec: number | null;
	queueP50Sec: number | null;
	queueP95Sec: number | null;
	dispatchP50Sec: number | null;
	assignP50Sec: number | null;
	recentJobs: number;
	recentMedianSec: number | null;
	recentP95Sec: number | null;
	machines: { machine: string; jobs: number }[];
	/** Slowest job kinds by p95, at most three, each with enough runs to mean something. */
	slowest: { name: string; p95Sec: number; jobs: number }[];
}

/**
 * Mirrors `job-history.DailyJobStats`, plus the day's dispatch counts. `null`
 * means nothing was looking that day; `0` means it looked and it was empty.
 */
export interface FleetDailyJobStats {
	day: string;
	jobs: number | null;
	failuresByZone: FleetFailuresByZone | null;
	runMedianSec: number | null;
	runP95Sec: number | null;
	queueMedianSec: number | null;
	queueP95Sec: number | null;
	backstopJobs: number | null;
	byMachine: { machine: string; jobs: number; busySec: number }[];
	/** Runners the dispatcher minted that day; `null` before its persisted history began. */
	dispatch: { minted: number; failed: number; mintedViaAffinity: number } | null;
}

export interface FleetJobRecord {
	repo: string;
	/**
	 * The forge's own ids for this job, so a reader can link to it.
	 *
	 * Already on the wire — `jobs.recent` passes whole JobRecords through — and
	 * declared nowhere until now, which is the third time that combination has
	 * cost something on this payload (`dispatchSec`/`assignSec` were the second).
	 * Values a consumer cannot see the type of are values a consumer does not
	 * use, and the guard below cannot pin.
	 */
	runId: number;
	jobId: number;
	name: string;
	runner: string;
	/**
	 * The NODE that served this job — `runner` folded by `nodeOf`, the fleet's
	 * one implementation of that question.
	 *
	 * `runner` cannot be folded by a consumer and must not be tried. It is
	 * `jit-claw-1-hadoku-conjure-j102671642063-r34413053817-1788993392` on a JIT
	 * node, `warm-claw-3-hadoku_site` on a warm listener, `hokon-tenhands` on an
	 * instance and `GitHub Actions 1000024103` when the job went hosted. Folding
	 * those needs `JIT_PREFIX`, `WARM_PREFIX`, `HOSTED_NAME` and a longest-prefix
	 * rule against the live node list, none of which this package publishes into
	 * a browser bundle — and `runners/census.ts` records that this question had
	 * FIVE implementations, two of which disagreed. A sixth in the command
	 * station, on its own deploy cadence, is exactly the drift `vocabulary` was
	 * added to this payload to stop.
	 *
	 * So the answer travels instead. It is the same value `jobs.byMachine[].machine`
	 * is keyed by, from the same call on the same node list, which is what makes
	 * "this job took 3m03s against claw-1's p50 of 38s" a join rather than a
	 * guess. Issue #18 / WolffM/hadoku_site#385.
	 *
	 * ATTACHED AT SERIALISE TIME, not stored: it is a pure function of the runner
	 * name and the CURRENT manifest, so a stored copy would outlive a retired
	 * node, and the fourteen days of records already on disk carry no such field.
	 */
	machine: string;
	labels: string[];
	startedAt: string;
	durationSec: number;
	conclusion: string;
	/**
	 * WHERE THE TIME WENT, in seconds. All four are optional and absent
	 * TOGETHER when GitHub's step timings were unusable — never a guessed 0,
	 * which would render as a phase that took no time rather than one we could
	 * not measure.
	 *
	 *   queueSec    waiting for a runner (`created_at` -> `started_at`)
	 *   setupSec    runner coming up + "Set up job". On a JIT node this contains
	 *               the MINT, which no other figure in this payload exposes.
	 *   runSec      the job's own steps
	 *   cleanupSec  `Post *` teardown + "Complete job"
	 *
	 * Derived from steps `/actions/runs/{id}/jobs` already returns, so this cost
	 * no new request. There is no "waiting" or "finalizing" bucket because the
	 * API exposes nothing that separates either from `run` and `cleanup`, and a
	 * segment invented to fill out a legend means nothing.
	 */
	queueSec?: number;
	/**
	 * `queueSec` split by WHO WAS SLOW. Present together or not at all, and they
	 * sum to `queueSec` exactly — `assignSec` is computed as the remainder, so a
	 * renderer can draw them in place of the total without the bar disagreeing
	 * with itself.
	 *
	 *   dispatchSec  job created -> runner minted.   OURS.
	 *   assignSec    runner minted -> job started.   GITHUB'S.
	 *
	 * They were derived and stored on 2026-09-03 and reached this contract on
	 * 2026-09-04, which is a gap worth naming: `jobs.recent` passes whole
	 * JobRecords through, so the VALUES were on the wire the whole time while the
	 * type declared nothing. A consumer could not read them without a type error
	 * and the wire-contract test could not pin them — the split existed and the
	 * operator could not see it.
	 *
	 * Backfilled over 636 real jobs when it landed: queue p50 89s, of which
	 * dispatch p50 80s and assign p50 8s. The median wait is ours and worth
	 * tuning; the 610s assign outlier that triggered the work was not.
	 */
	dispatchSec?: number;
	assignSec?: number;
	setupSec?: number;
	runSec?: number;
	cleanupSec?: number;
}

/**
 * One segment of a job's wall time, in the order it happens.
 *
 * SHIPPED FOR THE SAME REASON `capacityKinds` IS. The panel carried its own
 * table of four phases — id, label and meaning — which is the last copy of
 * fleet-manager's semantics living in another repo on another deploy cadence.
 * When `queueSec` gained a dispatch/assign split, that table did not fail to
 * compile: it kept drawing one confident `queued` block over two numbers that
 * say different things about who to go and fix.
 *
 * `detail` is how a phase subdivides. A renderer draws the detail segments
 * INSTEAD of the parent when the record carries all of them, and the parent
 * when it does not — which is exactly the mixed history a rolling window holds
 * for the hours after a split ships. They sum to the parent, so either choice
 * totals the same.
 *
 * A fifth phase, or a second split, is a new entry here and no consumer change.
 */
export interface JobPhase {
	id: string;
	/** The `FleetJobRecord` field carrying this phase's seconds. */
	field: 'queueSec' | 'dispatchSec' | 'assignSec' | 'setupSec' | 'runSec' | 'cleanupSec';
	/** One line, operator-facing, rendered verbatim. The only description there is. */
	description: string;
	/** Finer segments that SUM to this one. @see JobPhase */
	detail?: JobPhase[];
}

/**
 * What the JIT dispatcher did on its last pass.
 *
 * Exists because mint failures reached NOTHING (handoff §5 item 1): they were a
 * `logger.warn` in dispatch-pass.ts with no report field, no panel and no alert,
 * so a node dead for JIT looked identical to a node with nothing to mint. The
 * 409 name collision ran at ~7% of mints for the pilot's entire life and was
 * found by grepping a pm2 buffer that rolls, not by anything the fleet said.
 *
 * EVERY COUNT IS NULLABLE ON PURPOSE. The fast loop wraps the dispatcher in a
 * `.catch` so a JIT bug cannot stop label toggling — which means a pass that
 * THREW previously rendered the same as a pass that minted nothing. `null` with
 * `error` set is "I could not look"; `0` is "I looked, there was nothing".
 */
export interface FleetDispatch {
	/** When the last pass finished. `null` = it has not run since restart. */
	at: string | null;
	/** `null` when the pass threw — see `error`. Never conflate with 0. */
	minted: number | null;
	failed: number | null;
	skipped: number | null;
	inFlight: number | null;
	reaped: number | null;
	/** The throw from the last pass, if it threw. */
	error: string | null;
	/**
	 * Start of the current unbroken run of passes that failed every mint they
	 * attempted. `null` = not currently failing. This is the field that answers
	 * "is this machine dead for JIT", which a single-pass count cannot.
	 */
	failingSince: string | null;
	/** Since process start, so a panel can show a RATE rather than one tick. */
	totals: { minted: number; failed: number };
}

/**
 * Did warm affinity DECIDE where the dispatcher's mints went, or were they warm
 * by chance? (`warm-affinity-measured-2-2026-09-15.md` §5e.)
 *
 * Three counts per mint that SUCCEEDED, each a subset of the one before:
 *   minted              every successful JIT mint
 *   mintedViaAffinity   ...landing on a node warm for that repo (the
 *                       concentration metric: 74 % with the term OFF)
 *   mintedAffinityMoved ...that plain ordering would have sent ELSEWHERE —
 *                       the term's own effect
 *
 * `lastPass` is the last pass that minted anything (`null` = none since
 * restart); `totals` are since process start. Neither is persisted: mgmt-api
 * restarts several times a day, so the RECORD is the per-pass `[dispatch]` log
 * line, summed across restarts. These are for a glance, not a re-cut.
 */
export interface FleetDispatchAffinity {
	lastPass: {
		at: string;
		minted: number;
		mintedViaAffinity: number;
		mintedAffinityMoved: number;
	} | null;
	totals: { minted: number; mintedViaAffinity: number; mintedAffinityMoved: number };
}

export interface FleetReservation {
	reserved: boolean;
	reason: string | null;
	detail: string | null;
}

/**
 * The fleet's own vocabulary, shipped WITH the numbers it describes.
 *
 * WHY THIS IS IN THE PAYLOAD
 * --------------------------
 * The command station cannot import this package: it is an express-bearing Node
 * library and the panel is a browser micro-frontend. So every fleet word the UI
 * needed, it re-typed — `hadoku-builder` and `pm2-host` to colour a pill,
 * `['self-hosted','Linux','X64']` to subtract the labels GitHub adds by itself,
 * `'hokon'` in five places to mean "the backstop", the ladder
 * `pm2-host > hadoku-builder > taskauto` in a sentence, and `10` for the
 * queued-stale threshold. Twelve literals in a repo that has no way to know when
 * this one changes them.
 *
 * None of that is presentation. It is the same vocabulary `capabilities.ts`
 * exists to hold exactly once, arriving one HTTP hop late. Type-sharing cannot
 * fix it — a type says `backstopReason` is a string, not which strings — so the
 * VALUES travel with the report and the UI stops holding opinions about what the
 * fleet's labels are called.
 *
 * Everything here is derived at request time from the capability registry and
 * the manifest. Nothing in it is configuration.
 */
export interface FleetVocabulary {
	/** The one eligibility label — the fast loop's routing lever. */
	builderLabel: string;
	/** The production-host identity label. Top rung of the ladder. */
	pm2HostLabel: string;
	/** The label runner-health writes on a promoted backstop instance. */
	backstopLabel: string;
	/**
	 * Labels GitHub adds to every self-hosted registration by itself. A reader
	 * showing "what is this node serving" subtracts these: they are carried by
	 * everything and therefore distinguish nothing.
	 */
	implicitLabels: string[];
	/** The priority ladder, HIGHEST RUNG FIRST. Work yields to the rung above it. */
	ladder: string[];
	/**
	 * The node the ladder promotes when the claws cannot cope — the box carrying
	 * `pm2HostLabel` in the manifest. `null` if the manifest declares none, which
	 * is a fleet with no backstop rather than a fleet whose backstop is unnamed.
	 *
	 * DERIVED from the manifest, not the literal `'hokon'` that was a default
	 * parameter in job-history, a Set in the retired tier ladder, a `const` in the command
	 * station's charts and two sentences of its prose.
	 */
	backstopNode: string | null;
	/**
	 * Every label the fleet knows, and what it means. The `description` is the
	 * registry's own operator-facing line, so a tooltip cannot describe a label
	 * differently from the gate that enforces it.
	 */
	labels: Record<string, { kind: CapabilityKind; description: string }>;
	/**
	 * EVERY registered capability, every surface — label, toolchain and
	 * implicit (`jitconfig`, `python-venv`, `cuda`…) — so each id in a
	 * machine's `capabilities` has its description on the wire.
	 * `workloadGated` marks the ones a canary of the real job must earn.
	 */
	capabilities: Record<
		string,
		{
			kind: CapabilityKind;
			surface: CapabilitySurface;
			verify: CapabilityVerification;
			/** At most six words. */
			label: string;
			description: string;
			workloadGated: boolean;
		}
	>;
	/** @see CapabilitySurface */
	capabilitySurfaces: Record<CapabilitySurface, LabelledTerm>;
	/** @see CapabilityVerification */
	capabilityVerifications: Record<CapabilityVerification, LabelledTerm>;
	/** The five buckets of `failuresByZone`, with the box/code split. */
	failureZones: Record<keyof FleetFailuresByZone, FailureZoneTerm>;
	/** A bootcamp record older than this many days is stale — the doctor's own threshold. */
	bootcampStaleDays: number;
	/**
	 * Minutes a job may sit queued before the fleet calls it stale. The same
	 * constant `fleet.queuedStale` is counted with, so a panel can state its
	 * threshold instead of hard-coding a number that agrees today.
	 */
	queuedWarnMinutes: number;
	/**
	 * The repo whose runner listing the census reads. Registration state is
	 * PER-REPO, so a node reading `absent` is absent from THIS repo — a
	 * distinction a panel has to name to be honest, and could not.
	 */
	censusRepo: string;
	/**
	 * EVERY CLOSED ENUM IN THIS PAYLOAD, DESCRIBED WHERE IT IS DEFINED.
	 *
	 * `labels` above already did this for the fleet's NOUNS. These four do it
	 * for its VERBS, which is where the drift actually was: the command station
	 * held a tone map and a prose line for every `ClawState`, a four-branch
	 * switch over `BackstopReason`, and wrote its own sentence for
	 * `admissionBasis` — none of it presentation, all of it this package's
	 * meaning re-typed in a repo that cannot learn when the meaning changes.
	 *
	 * They are `Record<Union, TelemetryTerm>`, so adding a state without
	 * describing it fails tsc HERE rather than rendering blank there. Removing
	 * one — `demoted` and `mintable` are both tier/standing artifacts and both
	 * are on borrowed time — removes its row from the payload and needs no
	 * commit downstream at all. That is the whole point of shipping them.
	 */
	states: Record<ClawState, TelemetryTerm>;
	backstopReasons: Record<BackstopReason, TelemetryTerm>;
	admissionBases: Record<AdmissionBasis, TelemetryTerm>;
	admissionCaveats: Record<AdmissionCaveat, TelemetryTerm>;
	/** @see AdmissionClause, FleetMachine.admissionRefusal (wave 4a, #100). */
	admissionClauses: Record<AdmissionClause, TelemetryTerm>;
	/**
	 * The rows of `fleet.capacity.byKind`, so a reader can label and explain a
	 * row it has never seen. Without this the breakdown is only half data — the
	 * numbers travel and the meaning stays behind, which is the same split that
	 * made the scalars a cross-repo rename.
	 */
	capacityKinds: Record<CapacityKind, TelemetryTerm>;
	/** The rows of `githubBudget[].byCaller` (#119). */
	ghCallers: Record<GhCaller, LabelledTerm>;
	/**
	 * The segments of a job's wall time, IN ORDER, first to last.
	 *
	 * Order is significant here and is the fleet's to state: a stacked bar drawn
	 * in the wrong order is a bar that lies about sequence. @see JobPhase
	 */
	jobPhases: JobPhase[];
}

/** @see FleetVocabulary.labels — mirrors `capabilities.CapabilityKind`. */
export type CapabilityKind = 'identity' | 'eligibility';

/** Mirrors `capabilities.CapabilitySurface`. */
export type CapabilitySurface = 'label' | 'toolchain' | 'implicit';

/** Mirrors `capabilities.CapabilityVerification`. */
export type CapabilityVerification = 'probe' | 'role' | 'mint';

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

/**
 * Why the backstop is up, or `'none'`. A UNION, not `string`.
 *
 * `decideBackstop` has returned exactly these four since it was written, and the
 * report widened them to `string | null` on the way out — so the panel's
 * four-branch switch fell through to "unknown" for any value it had not been
 * told about, and a rename here would have surfaced as a grey pill on the one
 * page opened when something is already wrong.
 */
export type BackstopReason = 'outage' | 'saturation' | 'holding' | 'none';

/**
 * A way capacity becomes available — the ROWS of `FleetCapacity.byKind`.
 *
 * One axis: what has to happen before a job can land. Deliberately NOT the
 * mechanism that provides it, because every mechanism this fleet has had is on
 * its way out and the question survives all of them.
 */
export type CapacityKind = 'immediate' | 'mintable';

/** One row of the capacity breakdown. @see FleetReport.fleet.capacity */
export interface CapacitySlice {
	kind: CapacityKind;
	/** Free job SLOTS of this kind. `null` = not measured, which is not zero. */
	free: number | null;
	/**
	 * Why part of `free` is a guess, by reason, counted per node.
	 *
	 * A slot count cannot say this on its own: it is summed with `?? 0`, so a
	 * node nobody could reach contributes the same zero as a node that is
	 * genuinely full. Those are two different emergencies. Empty = every node in
	 * this row was measured against a budget its operator declared.
	 */
	caveats: Partial<Record<AdmissionCaveat, number>>;
	/**
	 * Is this row counted in `FleetCapacity.free`?
	 *
	 * DECLARED, never inferred: a row can be real capacity that no job can reach
	 * yet, and counting it as free is how a saturation promote of the production
	 * host gets justified by slots nothing can currently use.
	 *
	 * A consumer must not decide this for itself by matching on `kind`. That is
	 * precisely the fleet logic this shape exists to keep out of the panel.
	 */
	available: boolean;
}

/** @see FleetReport.fleet.capacity */
export interface FleetCapacity {
	/**
	 * MACHINES that can take a job right now.
	 *
	 * THE headline, and the only figure here that counts boxes. `clawsOnline`
	 * counts machines that are UP — a fully saturated fleet is fully online — and
	 * every number in `byKind` counts SLOTS, which on an all-JIT fleet is larger
	 * than the fleet itself ("15 free" across 6 machines) and reads as a bug
	 * rather than as capacity.
	 */
	ready: number | null;
	/**
	 * Free SLOTS right now: the sum of the rows below with `available: true`.
	 *
	 * Summed HERE so no consumer has to know which rows count. A panel that adds
	 * up the breakdown itself will one day add up a row that should not have been
	 * in the total, and it will be right about the arithmetic and wrong about the
	 * fleet.
	 */
	free: number | null;
	/** Free slots by what has to happen first. Order is not significant. */
	byKind: CapacitySlice[];
	/**
	 * No probe has been taken since the last restart, so every figure above is a
	 * FLOOR rather than a reading.
	 *
	 * A reader must render this as "not measured", never as zero capacity. The
	 * two are the difference between a healthy garage and a dark one, and
	 * collapsing them put a red "0 standing · 0 mintable" over six reachable
	 * claws after every deploy.
	 */
	unmeasured: boolean;
}

/** Who made a GitHub call. One word per loop, so a page can name the spender (#119). */
export type GhCaller =
	| 'reap'
	| 'dispatch-poll'
	| 'dispatch-probe'
	| 'mint'
	| 'warm-cache'
	| 'fleet-loop'
	| 'runner-health'
	| 'backstop'
	| 'ci-alerts'
	| 'ci-runner-var'
	| 'route'
	| 'unattributed';

/**
 * One token's hourly GitHub budget, as GitHub last reported it, with who in
 * this process spent it (#119). See `gh-budget.ts`.
 *
 * `used`/`remaining` are the TOKEN's — HADOKU_SITE_TOKEN is shared with the
 * workflows that use it — while `byCaller` is only this process's calls since
 * `countedSince` (a restart resets it). `otherSinceFirst` is the difference:
 * what the token was charged in that time that no caller here accounts for.
 */
export interface FleetGithubBudget {
	/** A label and a hash prefix, never the token. */
	token: string;
	resource: string;
	limit: number;
	remaining: number;
	used: number;
	/** remaining / limit, 0..1. */
	fractionLeft: number;
	resetAt: string;
	observedAt: string;
	/** True once the clock has passed `resetAt` — a past window's reading. */
	expired: boolean;
	countedSince: string;
	/** Charged calls (non-304) and free 304s per caller, most charged first. */
	byCaller: { caller: GhCaller; charged: number; notModified: number }[];
	otherSinceFirst: number;
	/** The low-budget alert has fired for this window. */
	alerted: boolean;
}

export interface FleetReport {
	success: boolean;
	probedAt: string | null;
	healthAt: string | null;
	machines: FleetMachine[];
	fleet: {
		runnersOnline: number | null;
		runnersOffline: number | null;
		clawsOnline: number | null;
		/**
		 * FREE CAPACITY, SPLIT BY WHAT HAS TO HAPPEN BEFORE A JOB CAN LAND ON IT.
		 *
		 * This replaced five scalars — `clawsReady`, `clawsFree`,
		 * `clawsFreeStanding`, `clawsFreeMintable`, `clawsPromotable` — plus
		 * `ephemeralUnknown`, on 2026-09-03.
		 *
		 * THE PROBLEM WAS THE NAMES. Three of those five encoded a MECHANISM in a
		 * wire key: `Standing` and `Mintable` are the standing/ephemeral split,
		 * `Promotable` was the tier ladder (retired 2026-09-21). Mechanisms get
		 * replaced, and a
		 * consumer cannot be asked to notice. Worse, a fleet that grew a THIRD way
		 * of becoming available had nowhere to put it: adding a scalar is a
		 * cross-repo rename, so the pressure was always to fold the new thing into
		 * an existing number and lose it.
		 *
		 * The axis underneath all three is the same question, and it is not about
		 * mechanism at all: WHAT HAS TO HAPPEN BEFORE WORK LANDS HERE. Nothing (a
		 * runner is standing by) or the dispatcher mints. A new
		 * mechanism is a new ROW, described in `vocabulary.capacityKinds`, and no
		 * consumer changes.
		 */
		capacity: FleetCapacity;
		/** machine -> state. A count cannot be diagnosed; this can. */
		clawState: Record<string, ClawState> | null;
		backstopReason: BackstopReason | null;
		/**
		 * Nodes an operator is holding eligible with `fleet backstop --force`,
		 * each with its expiry — the green light (`backstop-force.ts`). Empty
		 * when nobody has the switch on; `null` when the switch file could not
		 * be read, which is "could not look", not "off".
		 */
		backstopForced: BackstopForced[] | null;
		queuedNow: number | null;
		runningNow: number | null;
		oldestQueuedMin: number | null;
		longestRunningMin: number | null;
		queuedStale: number | null;
		hung: number | null;
		failoverReruns: number | null;
		oomReruns: number | null;
		pm2HostBusy: boolean | null;
	};
	reservation: FleetReservation;
	/** `affinity` is the only field not from the fast loop's snapshot — see FleetDispatchAffinity. */
	dispatch: FleetDispatch & { affinity: FleetDispatchAffinity };
	/** @see FleetGithubBudget — empty until this process has seen a GitHub response. */
	githubBudget: FleetGithubBudget[];
	/** @see FleetVocabulary — the words, shipped with the numbers. */
	vocabulary: FleetVocabulary;
	jobs: {
		since: string | null;
		total: number;
		byMachine: FleetMachineJobStats[];
		/** Per repo over the same window, most jobs first. */
		byRepo: FleetRepoJobStats[];
		/** Every UTC day of the window, oldest first, today included. */
		daily: FleetDailyJobStats[];
		backstopJobs: number;
		backstopShare: number;
		recent: FleetJobRecord[];
		/**
		 * THE TRAILING WINDOW'S OWN BOUNDS — what `byMachine[].recent*` was cut
		 * against, stated rather than assumed.
		 *
		 * `recentSince` is the START of the window, ISO; the report was built at
		 * `recentSince + recentWindowSec`, so both ends are recoverable from the
		 * payload. They are always present, including on a fleet that completed
		 * nothing: "we looked at 14:05–15:05 and it was empty" is a statement and
		 * it needs the hour named to be one. A consumer that renders the window
		 * from these can never disagree with the figures, which is the same reason
		 * `vocabulary.queuedWarnMinutes` travels with the count it thresholds.
		 */
		recentSince: string;
		recentWindowSec: number;
	};
}
