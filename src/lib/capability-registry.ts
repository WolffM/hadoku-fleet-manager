/**
 * The capability registry — what a fleet label MEANS, in one typed place.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Until now the fleet's label vocabulary was five string literals scattered
 * across five modules, with the meaning of each living only in a comment beside
 * one of them:
 *
 *   census.ts               BUILDER_LABEL / PM2_HOST_LABEL / BACKSTOP_LABEL
 *   runner-health.ts        REQUIRED_LABELS = ['hadoku-builder', 'pm2-host', …]
 *   reconcile-fleet-runners `const BUILDER_LABEL` + two `.filter(l => l !== …)`
 *   check-capabilities.mjs  PROBEABLE = {…} and ROLE_LABELS = {…}
 *   the manifest            machines[].labels, toolchain.capabilities
 *
 * Every one of those lists had to be edited by hand to add a capability, and
 * nothing said so. `taskauto` and `av1-nvenc` were absent from REQUIRED_LABELS
 * for months — the first cost `hadoku-tenhands / Task automation` 6h45m of
 * silent queueing on 2026-08-26, because the only runner offering the label died
 * and no floor alert was possible. `hokon-backstop` is in `census.ts` and in
 * NEITHER set in `check-capabilities.mjs`, so a node that declared it would
 * be reported as "declares hokon-backstop and nothing can verify it" — a false
 * finding waiting for the first operator to write it down.
 *
 * So: one entry per capability, and everything else derives.
 *
 * THE DISTINCTION THAT MUST SURVIVE: IDENTITY vs ELIGIBILITY
 * ----------------------------------------------------------
 * `census.ts` documents this as load-bearing and it is the reason this file has
 * a `kind` field rather than just a list of strings:
 *
 *   IDENTITY    a FACT about the node. It has an NVENC-capable GPU; it is
 *               the PM2 production host; it mints per job. Facts do not change
 *               between ticks, and the reconciler projects them onto every
 *               runner it registers.
 *
 *   ELIGIBILITY a ROUTING LEVER, owned by the fast loop, rewritten every few
 *               minutes. `hadoku-builder` is the only one. A demoted node is
 *               ineligible and still perfectly healthy.
 *
 * Collapsing the two is a P2 bug with a name: `clawsOnline` counted runners
 * carrying `hadoku-builder`, so a healthy-but-demoted claw vanished from the
 * count and the fleet reported `clawsOnline = 1` with three claws reachable.
 * The consequence for every derivation here is the same one the reconciler
 * already states in prose: **the registration path must never write an
 * eligibility capability onto a node a tier policy demotes**, or the node
 * is born schedulable and stays that way until something notices. 24 hokon
 * runners came up eligible on the PRODUCTION host exactly that way.
 *
 * WHAT THIS FILE IS NOT
 * ---------------------
 * It is not a scheduler, a prober or a writer. It decides nothing and performs
 * no I/O — it states the vocabulary and validates a manifest against it, so the
 * modules that DO decide can stop carrying their own copy of the list.
 */

/** A fact about the node, or a routing lever the fast loop flips. */
export type CapabilityKind = 'identity' | 'eligibility';

/**
 * Where a capability is expressed.
 *
 *   label      declared in `machines[].labels`, projected onto every runner the
 *              node hosts, and therefore routable by a workflow's `runs-on`.
 *   toolchain  declared once in `toolchain.capabilities` and required of EVERY
 *              managed node. Never a label — there is nothing to route to,
 *              because everybody has it.
 *   implicit   neither declared nor routable, but probed. `jitconfig` is the
 *              whole ephemeral dispatcher's dependency on an UNDOCUMENTED
 *              `Runner.Listener` flag; a runner self-update is the expected way
 *              to lose it, so it is probed even though nothing declares it.
 */
export type CapabilitySurface = 'label' | 'toolchain' | 'implicit';

/**
 * How the fleet PROVES a node really has this, distinct from how it declares
 * it. "The reader for a facet may not read what the writer wrote."
 *
 *   probe  `capability-probe.sh` EXECUTES it on the node. An encoder listing
 *          lies — Debian's ffmpeg reports av1_nvenc whether or not the GPU can
 *          use it — so only a real 256x256 encode separates hokon's RTX 4090
 *          from claw-1's GTX 860M.
 *   role   a declarative fact about the node's job in the fleet. There is
 *          nothing to execute: `hadoku-builder` is a routing lever nobody can
 *          prove. The declaration is the only evidence there is.
 *   mint   proven only by a JIT mint succeeding. No standing runner carries
 *          `jit-canary`, so there is nothing to probe against; what proves it is
 *          `.github/workflows/jit-canary.yml`, a job no standing runner in the
 *          fleet can serve, which therefore goes red precisely when minting
 *          stops working.
 */
export type CapabilityVerification = 'probe' | 'role' | 'mint';

/** The manifest fields this module reads. A superset lives in fleet-loop.ts. */
export interface ManifestNode {
	labels?: string[];
	/**
	 * `"claw"` | `"backstop"`. DECLARED here rather than left to the index
	 * signature, so a weak-type check cannot let any object through where a
	 * role-bearing node is wanted. Read via `isBackstopNode`, never
	 * compared directly — `src/lib/node-role.ts` is the one answer, and the
	 * strict default (absent reads as `claw`) lives there.
	 */
	role?: unknown;
	ephemeral?: boolean;
	maxConcurrent?: number;
	minFreeMb?: number;
	maxRegistrations?: number;
	placement?: string;
	[key: string]: unknown;
}

export interface FleetManifestShape {
	machines?: Record<string, ManifestNode>;
	toolchain?: { capabilities?: string[]; toolCache?: Record<string, unknown> };
	[key: string]: unknown;
}

/**
 * The `$capabilities` facet `fleet bootcamp --write` writes onto a machine
 * entry — the supply ledger's capability row
 * (`docs/planning/supply-ledger-2026-09-07.md` P1.1).
 *
 * `earned` is what bootcamp PROVED BY EXECUTION (settled 2026-09-10); `prereqs`
 * is the imaging-floor subset `capability-probe.sh` answered for
 * `toolchain.capabilities`. Both are read here because the second is the
 * transition bridge: until bootcamp has re-run under the new semantics, `earned`
 * is `[]` on every claw and `prereqs` holds the only proof on record.
 */
export interface BootcampFacet {
	at?: string;
	by?: string;
	declared?: string[];
	earned?: string[];
	unclaimed?: string[];
	unearned?: { id: string; detail?: string }[];
	blocked?: { id: string; detail?: string }[];
	prereqs?: { id: string; detail?: string }[];
	unprobed?: string[];
	/**
	 * Per IDLE-ONLY capability ({@link measuredIdleOnly}), the measurement that
	 * DECIDED its current verdict, taken with no live `Runner.Worker` on the
	 * node (2026-10-10). Moves only when the verdict does (#59). No entry means
	 * the verdict predates idle-only measurement, or was never judged idle.
	 */
	measurements?: Record<
		string,
		{ value: number | null; idle: boolean; earned: boolean; at: string }
	>;
}

/**
 * A manifest field a node must DECLARE before it may claim a capability.
 *
 * Not style. Every one of these is read by a deployer that has a SILENT
 * PERMISSIVE DEFAULT, so an omission does not fail — it removes a limit:
 * `renderConf` in deploy-ci-throttle.mjs interpolates `MAX_CONCURRENT=${m.maxConcurrent}`
 * straight into the node's config, and `ci-throttle.sh` rejects a non-numeric
 * value and falls through to `MAX_CONCURRENT=99, MIN_FREE_MB=0` — "NO LIMIT,
 * silently, because this hook never fails a job". That is the exact state that
 * OOM-killed two jobs on claw-2 on 2026-08-24.
 */
export interface RequiredField {
	field: string;
	why: string;
}

/** A structural predicate over the node's manifest entry. */
export interface RequiredFact {
	id: string;
	why: string;
	holds(node: ManifestNode): boolean;
}

/**
 * A capability whose answer is a NUMBER against a bar, not a yes/no.
 *
 * THE PROBE MEASURES; THE REGISTRY JUDGES. That split is the whole point and it
 * is what keeps the next one of these from being new code. `av1-nvenc` can be
 * binary because a GPU either encodes the frame or it does not; a payload
 * capability like `cargo-bevy` is "fast enough", and "enough" is a number
 * somebody has to own. Putting it in the probe script would give the threshold
 * two homes — the shell that applies it and the doc that explains it — and
 * re-tuning it would mean editing a file that runs on every node.
 *
 * So the probe emits the measurement in its detail field and NEVER decides, and
 * this is the only place a bar is written down. Adding the Nth payload
 * capability is then a registry entry plus a probe block that prints a number:
 * no new parsing, no new bootcamp branch, no second comparator to keep in step.
 */
export interface CapabilityMeasure {
	/** What was measured, for the operator-facing finding. e.g. 'compile throughput'. */
	metric: string;
	/** The unit the probe prints. e.g. 'crates/min'. */
	unit: string;
	/** Pass when the measurement is at least this. Mutually exclusive with atMost. */
	atLeast?: number;
	/** Pass when the measurement is at most this. Mutually exclusive with atLeast. */
	atMost?: number;
	/** WHY this number. A bar with no derivation is a guess with a decimal point. */
	why: string;
	/**
	 * WHY this measurement does NOT move with what else the node is running —
	 * present only when that is true, and it must say why.
	 *
	 * ABSENT MEANS IDLE-ONLY, and that default is the point (2026-10-10). On
	 * 2026-09-14 claw-4 scored 2281 on `cargo-bevy` and claw-6 1529; re-probed on
	 * 2026-10-10 while CI jobs ran they gave 1169 and 1024 — contention, not
	 * hardware, and both readings fell below the 1200 bar. A throughput figure
	 * taken beside a running job measures the job as much as the box. So a
	 * measured capability counts ONLY when it was taken with no live
	 * `Runner.Worker` on the node (see {@link judgeMeasurement}); a new measured
	 * capability inherits that unless it states here why load cannot touch it. A
	 * default of "load is fine" would let the next one repeat 2026-10-10 by
	 * omission.
	 */
	loadInvariant?: string;
}

/**
 * A workload proof's DURATION budget (wave 4e, #102) — "claw-3 earned jdk21 on
 * a RAM floor and a tool probe, neither of which said anything about the WORK
 * the label routes" (the operator, 2026-10-07).
 *
 * The bar is not a constant: a canary that merely CONCLUDES is not proof a
 * node can carry the label's real work at an acceptable pace, and a fixed
 * number guessed once would need re-tuning by hand every time the canary's
 * own shape changed. So the bar is derived from the SAME canary on nodes that
 * have ALREADY passed it — `factor x median(duration on proven nodes)` — and
 * it does not apply at all until `minProven` of them exist, because a median
 * of one or two readings is noise wearing a decimal point. See
 * {@link proofBudget}.
 */
export interface JobProofBudget {
	/** Pass within this many times the median duration of already-proven nodes. */
	factor: number;
	/** Fresh-passing nodes required before the budget applies at all. */
	minProven: number;
}

/**
 * How a capability is PROVED BY A REAL JOB on a node — data, so `fleet prove-job`
 * and bootcamp's report read one declaration instead of a hardcoded call.
 *
 * A `verify: 'role'` capability is ASSIGNED and no probe can settle it; `taskauto`
 * needs a secret that lives only in a GitHub Actions store, so the only honest
 * proof is the job that uses it, run ON the node. This names that job.
 *
 * `budget` (wave 4e) is what separates a TOOL proof (this job merely exists
 * and concludes) from a WORKLOAD proof (it finishes within what the SAME job
 * takes on nodes already proven). Absent — `taskauto`'s own shape — a
 * conclusion alone decides, exactly as before this wave. Present, `nodeOffer`
 * additionally withholds the label from a node whose proof is missing, failed,
 * stale, or ran over budget; see {@link workloadGateStatus}.
 */
export interface JobProof {
	/** `owner/name` of the repo whose workflow carries the job. */
	repo: string;
	/** Workflow FILE under `.github/workflows/`, which must be `workflow_dispatch`-able. */
	workflow: string;
	/** The job's `name:` (what the Checks UI and the jobs API call it). */
	job: string;
	/**
	 * Regex (case-insensitive) selecting the log lines that show the capability was
	 * EXERCISED. A job that goes green without printing any of them proved nothing
	 * about it, and the proof fails rather than passing on a conclusion alone.
	 */
	evidence: string;
	/** Branch or tag to dispatch on. Defaults to `main`. */
	ref?: string;
	/**
	 * `workflow_dispatch` inputs, passed verbatim as the dispatch body's
	 * `inputs` — a targeted canary rather than the workflow's full derived set.
	 */
	inputs?: Record<string, string>;
	/**
	 * The job's `runs-on` is fed by a `workflow_dispatch` input taking a JSON
	 * label array, and `labels` is the pool it defaults to. `prove-job` then
	 * mints its runner with these labels plus one only that runner carries, and
	 * sends that set as `input` — so no other listener can take the canary.
	 *
	 * WHY (2026-10-08): without it every jdk21 listener in the fleet could take
	 * the dispatched canary, and on the first live run two of three did.
	 */
	runsOn?: { input: string; labels: string[] };
	/**
	 * Dispatch on a throwaway branch made at `ref`'s head, deleted at teardown,
	 * never on `ref` itself. A canary is a judgement of the NODE; on `main` it
	 * reads as a red main to everything that judges main by its latest run
	 * (cardtable's head watcher paged on claw-3's, 2026-10-08). Opt-in per
	 * canary, because creating a branch is a push: set it only where no
	 * workflow fires on a push to an arbitrary branch.
	 */
	scratchBranch?: boolean;
	/** A WORKLOAD proof — see {@link JobProofBudget}. Absent: pass/fail alone decides, as before. */
	budget?: JobProofBudget;
}

export interface Capability {
	id: string;
	kind: CapabilityKind;
	surface: CapabilitySurface;
	verify: CapabilityVerification;
	/** At most six words, for a UI that shows labels and keeps prose for hover. */
	label: string;
	/** One line, operator-facing. Rendered verbatim in every gate finding. */
	description: string;
	/**
	 * MAY THE MANIFEST DECLARE THIS? Present and true for the labels where a
	 * declaration is the RIGHT source, and absent everywhere else.
	 *
	 * Capabilities are DERIVED, not declared (operator, 2026-09-09), and there
	 * is exactly ONE exception to that: a MINT-ONLY label is declared because
	 * no probe can ever settle it: it is proven by MINTING, so
	 * bootcamp cannot put it in `earned` and `earned` is where every other label
	 * comes from. `jit-canary` is the case that exists — its entry below, and
	 * {@link ephemeralOnlyLabels}, carry the reasoning and the 2026-09-08/09
	 * incident; this flag is only the marker, and does not restate them.
	 *
	 * WHAT READS IT. `check-label-floor`'s derivation-disagreement check, which
	 * compares the derived offer against the declaration and must not report a
	 * declaration that is correct. Exempting it there loses no coverage:
	 * `check-capability-schema` is what refuses `jit-canary` on a node without
	 * `ephemeral: true`, and that is the failure this label actually has.
	 *
	 * NOT A SECOND SOURCE OF TRUTH. `verify: 'mint'` already says how the
	 * capability is proven; this says who may declare it. Today those coincide
	 * for every label-surface capability, and `scripts/lib/label-floor.test.mjs`
	 * asserts the coincidence rather than letting it be assumed — the day a label
	 * is proven by minting and must NOT be declared, that test is where the two
	 * answers part company on purpose instead of by drift.
	 */
	mintOnly?: boolean;
	/**
	 * This capability's rung on the PRIORITY LADDER, 1 = highest, absent = not a
	 * rung at all.
	 *
	 * The ladder is `pm2-host > hadoku-builder > taskauto`, and until now it was
	 * written down only in prose — twice in the descriptions below, once in
	 * `node-reservation.ts`, once in `runner-health.ts`, and once more in the
	 * command station's reservation callout, which is a different REPO. Five
	 * copies of an ordering that decides which work yields to which, none of
	 * them readable by a program.
	 *
	 * Declared here so `ladder()` derives it and every reader — the panel
	 * included — quotes one list.
	 */
	rung?: number;
	requires?: {
		fields?: RequiredField[];
		facts?: RequiredFact[];
	};
	/**
	 * Present when the probe reports a MEASUREMENT rather than a verdict.
	 *
	 * `ok` from the probe then means "I measured it", not "it passed" — the bar
	 * below decides. See {@link CapabilityMeasure} and {@link meetsBar}.
	 */
	measure?: CapabilityMeasure;
	/**
	 * The real job that proves this capability on a node — see {@link JobProof}.
	 * Absent for every capability a probe can settle by itself.
	 */
	jobProof?: JobProof;
}

/**
 * Judge one probe result against the capability's declared bar.
 *
 * ONE comparator for every measured capability, called from bootcamp, so a new
 * payload capability inherits the judging instead of bringing its own.
 *
 * A capability with no `measure` is binary and passes on `ok` alone — which is
 * every capability that existed before this. An unparseable measurement FAILS
 * and says so: a probe that printed prose where a number was declared has not
 * shown the node can do anything, and reading it as a pass is the same silence
 * this registry refuses everywhere else.
 */
export function meetsBar(
	cap: Capability | undefined,
	ok: boolean,
	detail: string
): { proven: boolean; reason: string } {
	if (!cap) return { proven: false, reason: 'no registry entry' };
	if (!ok) return { proven: false, reason: detail || 'probe reported failure' };
	const m = cap.measure;
	if (!m) return { proven: true, reason: detail };
	// The FIRST number in the detail, so a probe may print units after it.
	const n = Number(/-?\d+(\.\d+)?/.exec(detail)?.[0]);
	if (!Number.isFinite(n)) {
		return {
			proven: false,
			reason: `declared a ${m.metric} measurement but printed "${detail}" — not a number`,
		};
	}
	if (typeof m.atLeast === 'number' && n < m.atLeast) {
		return { proven: false, reason: `${m.metric} ${n}${m.unit} < ${m.atLeast}${m.unit} required` };
	}
	if (typeof m.atMost === 'number' && n > m.atMost) {
		return { proven: false, reason: `${m.metric} ${n}${m.unit} > ${m.atMost}${m.unit} allowed` };
	}
	return { proven: true, reason: `${m.metric} ${n}${m.unit}` };
}

/**
 * Must this capability be measured on an IDLE node to count? True for every
 * capability with a `measure` that does not declare `loadInvariant`. See
 * {@link CapabilityMeasure.loadInvariant}.
 */
export function measuredIdleOnly(cap: Capability | undefined): boolean {
	return Boolean(cap?.measure) && !cap?.measure?.loadInvariant;
}

/**
 * {@link meetsBar}, plus the one question a measurement cannot answer about
 * itself: was the node idle while it was taken?
 *
 * `workers` is the most live `Runner.Worker` processes the probe saw while the
 * measurement ran (its `LOAD <id> <n>` line), `null`/`undefined` when it could
 * not count. Anything but a counted ZERO leaves an idle-only capability
 * UNJUDGED — `judged: false`, `proven: false` — and the caller must neither
 * earn nor strip on it: "measured under load" is "I could not look", never
 * "it cannot". A `no` is unjudged too: a compile that died beside a running
 * job may have died of the job (an 8 GB claw's tmpfs is RAM).
 *
 * A capability that is not idle-only is judged exactly as `meetsBar` judges it.
 */
export function judgeMeasurement(
	cap: Capability | undefined,
	ok: boolean,
	detail: string,
	workers: number | null | undefined
): { proven: boolean; reason: string; judged: boolean } {
	const verdict = meetsBar(cap, ok, detail);
	if (!measuredIdleOnly(cap) || workers === 0) return { ...verdict, judged: true };
	const load =
		typeof workers === 'number'
			? `${workers} live Runner.Worker`
			: 'live Runner.Worker count unknown';
	return {
		proven: false,
		judged: false,
		reason: `measured under load (${load}): ${verdict.reason} — not judged`,
	};
}

const MUST_BE_EPHEMERAL: RequiredFact = {
	id: 'ephemeral',
	why:
		'the canary is a job NO standing runner can serve, which is the only thing that proves ' +
		'minting works. A standing runner carrying this label would answer the canary without ' +
		'minting anything, so it would stay green through a total dispatcher outage. It also ' +
		'lies to the label floor, which counts a standing online runner carrying a label as ' +
		'SERVING it: the floor would read the canary label as served by a registration that ' +
		'proves nothing about minting.',
	holds: (m) => m.ephemeral === true,
};

const THROTTLE_FIELDS: RequiredField[] = [
	{
		field: 'maxConcurrent',
		why:
			'`fleet throttle` writes MAX_CONCURRENT straight from this field. Undefined renders ' +
			'as the literal string `undefined`, ci-throttle.sh rejects the non-numeric value and ' +
			'falls through to MAX_CONCURRENT=99 — no limit, silently, on a node general CI ' +
			'lands on.',
	},
	{
		field: 'minFreeMb',
		why:
			'same path: undefined becomes MIN_FREE_MB=0, so the node will start a job with ' +
			'no memory left. That is the state that OOM-killed two jobs on claw-2 on 2026-08-24.',
	},
];

// Identity/eligibility label ids, as literals, so importers keep the narrow type
// they had when these were declared inline in census.ts.
//
// DECLARED ABOVE THE REGISTRY, and that position is load-bearing: the registry
// entries below NAME these rather than spelling the the same three strings a second
// time, and a `const` referenced before its declaration in the same module is a
// TDZ throw at import, not a lint warning. Two spellings of one label is how
// `hokon-backstop` came to exist in census.ts and in neither set in
// check-capabilities.mjs — the exact split this file was written to close.
export const BUILDER_LABEL = 'hadoku-builder';
export const PM2_HOST_LABEL = 'pm2-host';
export const BACKSTOP_LABEL = 'hokon-backstop';

/**
 * THE REGISTRY.
 *
 * WHAT IS NOT HERE: a floor flag. Whether the fleet pages when nothing serves a
 * label is decided by DEMAND (does any job ask for it?) and by ONE rule for
 * every label (a standing online runner, or an eligible minting node that
 * offers it) — `src/label-floor.ts`. Until 2026-10-10 each entry carried
 * `floor: boolean`, and `jdk21`/`cargo-bevy` were `false` because a
 * standing-only floor could not watch a label claws serve by minting.
 */
export const CAPABILITIES: readonly Capability[] = [
	{
		id: BUILDER_LABEL,
		label: 'General CI',
		kind: 'eligibility',
		surface: 'label',
		verify: 'role',
		description:
			'General CI eligibility. THE routing lever: GitHub has no runner priority, so the ' +
			'fast loop adds and removes this label every few minutes to decide which nodes ' +
			'GitHub can see at all. A node without it is invisible, not broken.',
		rung: 2,
		requires: { fields: THROTTLE_FIELDS },
	},
	{
		id: PM2_HOST_LABEL,
		label: 'Production PM2 host',
		kind: 'identity',
		surface: 'label',
		verify: 'probe',
		description:
			'THE box that hosts the PM2 production stack — not a box that COULD. Runs mgmt-api, ' +
			'the tunnel and the other production services, and serves the six infra workflows that carry ' +
			'`runs-on: [self-hosted, pm2-host]` (redeploy-mgmt-api, redeploy-service, ' +
			'reload-ecosystem, cron-schedules-sync, recreate-pm2-registrations, ' +
			'temporal-cluster-diag). Top rung of the priority ladder — see {@link ladder}, which ' +
			'derives it from `rung` so this text does not carry a fifth prose copy — so a busy ' +
			'runner carrying it means CI must not add load on top. ' +
			'PROVEN BY EXECUTION since 2026-09-15 (#6) and NARROWED 2026-09-26 (wave 3o): the ' +
			'probe confirms a pm2 daemon is ALIVE under the DEFAULT PM2_HOME — from its pid file ' +
			'and socket, before pm2 is run at all, because `pm2 jlist` LAUNCHES a daemon where ' +
			'none is running — and that it reports at least one app `online`. The narrowing is ' +
			'not tidying: the 2026-09-15 probe answered "is pm2 installed and can it supervise ' +
			'under a throwaway home", which is the CAPABILITY, and {@link nodeOffer} puts every ' +
			'earned identity label onto a node’s registrations and JIT mints. A claw proving it ' +
			'would have started answering redeploy-mgmt-api on a box with no ecosystem file and ' +
			'no vault, left `census.clawPool` (which subtracts this label) silently short, and ' +
			'made `census.pm2Busy` read a busy claw as the production host being busy. The ' +
			'capability question moved to {@link CAPABILITIES} entry `pm2-capable`, which is ' +
			'`surface: "implicit"` and therefore routable by nothing. ' +
			'It read `verify: "role"` before #6, with "the fleet’s own topology is the ' +
			'evidence" beside it, which was true of exactly one machine — and that machine is a ' +
			'backstop. THE DECLARED PATH IS RETIRED FOR EVERY NODE: nothing can type its way ' +
			'in, because `nodeOffer` REPLACES a declared probe-verified label with the proof ' +
			'record. (Until 2026-10-31 the backstop kept its declaration by role; its own ' +
			'bootcamp record now earns `pm2-host`.) Measured 2026-09-26: ' +
			'`ok 24-online` on hokon, `no absent` on all eight claws.',
		rung: 1,
		requires: {
			fields: [
				{
					field: 'minFreeMb',
					why:
						'the production host reserves headroom for mgmt-api, the tunnel and the other production services ' +
						'against the CI it now also hosts. Undefined becomes MIN_FREE_MB=0 in the ' +
						'generated throttle config, which removes exactly that protection.',
				},
			],
		},
	},
	{
		/*
		 * COULD this box host the pm2 role — asked separately from whether it IS
		 * the host, and deliberately held one step short of being a routing lever.
		 *
		 * `surface: 'implicit'` is the documented shape for exactly this, and the
		 * GPU family above is the precedent: "the measurement, held one step short
		 * of being a routing lever … promoting one of these to `surface: 'label'`
		 * is a deliberate, reviewed, one-line change made against probe output that
		 * already exists". It lands in `$capabilities.earned` — which is what
		 * `resident-placement-2026-09-10.md` filter 1 reads — and `nodeOffer` skips
		 * it because it is not a label, so no workflow can route on it and
		 * `census.clawPool` is unaffected. That separation is the whole point of
		 * wave 3o lane C; the `pm2-host` entry above carries what merging the two
		 * would have cost.
		 *
		 * PROVED BY PROVISIONING, AND NOTHING IS LEFT BEHIND. The probe installs
		 * pm2 into a throwaway prefix under $HOME, starts a real process, reads it
		 * back `online`, `save`s, `kill`s the daemon, `resurrect`s it, requires the
		 * process online again WITH A DIFFERENT PID, and then removes the lot. A
		 * permanent pm2 on nine boxes is ~540 MB of node/pm2 footprint per box and
		 * is precisely what issue #6 wants moved OFF a machine, not onto eight
		 * more. Measured on claw-9 2026-09-26: 2 s to install, 5 s end to end,
		 * 41 MB under $HOME, `~/.npm` byte-identical before and after.
		 *
		 * SURVIVING A RESTART IS THE POINT, not starting. A pm2 that cannot write
		 * its dump starts everything perfectly and loses the lot the first time the
		 * daemon restarts, which is the failure a resident service actually meets.
		 * And the pid must CHANGE: `resurrect` returning 0 against a process the
		 * kill never reached proves nothing.
		 */
		id: 'pm2-capable',
		label: 'Could host PM2',
		kind: 'identity',
		surface: 'implicit',
		verify: 'probe',
		description:
			'This box could host the pm2 role: a supervisor installs, starts a process, reports ' +
			'it online, SURVIVES the supervisor being killed and resurrected (with a new pid), ' +
			'and is then removed without trace. Probed, declared by nobody, routable by nothing ' +
			'— `pm2-host` is the routing label and this is deliberately not it. Read by ' +
			'`resident-placement-2026-09-10.md` filter 1 out of `$capabilities.earned`.',
		measure: {
			metric: 'installed memory',
			unit: 'MiB',
			atLeast: 9784,
			why:
				'`resident-placement-2026-09-10.md` §1.6, measured on the role at its current ' +
				'home (`/sys/fs/cgroup/system.slice/pm2-hadoku.service`, `memory.current` ' +
				'10,259,140,608 B = 9,784 MiB steady; `memory.peak` 20,482 MiB is an upper bound ' +
				'because it includes reclaimable page cache). THE ROLE, NOT ITS FIRST TENANT: ' +
				'§1.6 rules that a placement establishing a ROLE is sized against the role, and ' +
				'issue #6’s one bot is only its first tenant — cron (47 jobs across 9 profiles) ' +
				'and the deploy trees are behind it. ' +
				'A FLOOR ON THE HARDWARE, NOT THE FIT. A node whose ENTIRE installed memory is ' +
				'below the role’s steady demand can never host it under any policy, which is a ' +
				'fact about the box and does not move; whether it has ROOM today is filters 2-4 ' +
				'(`slack = usable − ciCommitment`, margin `slack / ram >= 2.0`) and is NOT ' +
				're-derived here. Two homes for that arithmetic would disagree, because free ' +
				'memory moves with whatever CI is running — and a capability that flickers with ' +
				'load is an ELIGIBILITY lever wearing an IDENTITY’s clothes, the P2 collapse ' +
				'this file opens with. Measured 2026-09-26: claw-1 11,885, claw-3 15,918, ' +
				'claw-4 15,936, claw-5 15,877, claw-8 15,915, claw-9 32,003 clear it; claw-2 ' +
				'7,872 and claw-6 7,849 do not, and their `no` says the number.',
			loadInvariant:
				'`MemTotal` is the INSTALLED memory the kernel found at boot, not free memory: a ' +
				'running job moves `MemAvailable` and leaves this number exactly where it was, ' +
				'so draining a node to read it would buy nothing.',
		},
	},
	{
		/*
		 * THE FIRST WORKLOAD LEAVING THE BACKSTOP, AND IT IS NOT SIZED BY THE ROLE ABOVE.
		 *
		 * `pm2-capable`'s bar is 9,784 MiB because a placement establishing a ROLE
		 * is sized against the role. `taskauto` is one small TENANT of that role,
		 * and sizing a tenant by its landlord is what produced wave 3o's "NO BOX
		 * TODAY" with claw-9 missing on margin at 1.18x. Measured per job on
		 * claw-8 2026-09-28 (`taskauto-onto-a-claw-2026-09-28.md` §1.3):
		 * `drain the board` peaks at 517 MiB, 12.3 s of CPU, zero OOM kills —
		 * 19x under the role figure and 27x under claw-8's 13,867 MiB slice
		 * ceiling, so the margin question does not arise for this tenant at all.
		 *
		 * NO BAR IS DECLARED HERE, DELIBERATELY. 517 MiB would admit every box in
		 * the fleet including the two 7.8 GB claws that `pm2-capable` refuses, so
		 * a `measure` would be a bar that discriminates nothing while reading as
		 * though it had been considered. The number belongs in the doc that
		 * measured it until a node is actually rejected by it.
		 *
		 * WHAT THE LABEL DOES NOT CARRY, measured the same day: the host plumbing.
		 * `pm2` is NOT among it — neither `taskauto.yml`'s `drain the board` nor
		 * `test.yml`'s `backend pytest` invokes pm2 anywhere, so `pm2-host` in
		 * their `runs-on` is routing and nothing else. What IS needed beyond
		 * python-venv and gh is a tokenless `~/.npmrc` (no secret, expands
		 * `${NODE_AUTH_TOKEN}` from the job env) and the `claude` binary at
		 * `TASKAUTO_CLAUDE_BIN`, which NO claw carried on 2026-09-28. The
		 * `~/.bashrc` vault export is not needed and never was: it sits after the
		 * interactive guard, which is why the workflow passes the token as a job
		 * env var instead.
		 */
		id: 'taskauto',
		label: 'Task automation',
		kind: 'identity',
		surface: 'label',
		verify: 'role',
		description:
			'Scheduled task automation — tenhands’ board sweep and its backend suite. ' +
			'Bottom rung of the priority ladder, yielded to both CI and pm2-host work. ' +
			'288 jobs / 1.87 h in the 14 days to 2026-09-28, every one of them served by the ' +
			'backstop’s registration; 517 MiB peak per job, measured on claw-8, which is ' +
			'a NINETEENTH of the pm2-host role figure `pm2-capable` carries above.',
		rung: 3,
		// `backend pytest` is the job that EXERCISES the LLM judge (`taskauto.yml`'s
		// own sweep exits at "nothing to drive" on an empty board and never invokes
		// `claude`). Its `Require the claude CLI on PATH` step prints
		// `claude resolved to <path>`, and pytest's summary line carries the
		// pass/skip counts — a judge test skipped for want of the token reads as
		// `skipped`, which is why the evidence asks for both.
		jobProof: {
			repo: 'WolffM/hadoku-tenhands',
			workflow: 'test.yml',
			job: 'backend pytest',
			evidence: 'claude resolved|\\d+ passed|\\d+ skipped|\\d+ deselected',
		},
	},
	{
		id: 'av1-nvenc',
		label: 'NVENC AV1 encode',
		kind: 'identity',
		surface: 'label',
		verify: 'probe',
		description:
			'Hardware AV1 encoding through NVENC. One node deep, and the reason 22 ' +
			'dataplatform tests skip when hokon is dark.',
	},
	/*
	 * THE REST OF THE GPU FAMILY, ADDED 2026-09-08 (WS-N) WITH THE ARRIVAL OF
	 * claw-7 (Maxwell GM200) AND claw-8 (Turing TU104).
	 *
	 * `surface: 'implicit'` — PROBED, DECLARED BY NOBODY, ROUTABLE BY NOTHING. That
	 * is the documented meaning of the surface and `jitconfig` is the precedent:
	 * measured because the answer matters, not exposed because no workflow asks.
	 *
	 * It is also the only honest option, and the test suite is what made that
	 * concrete. Registering these as `label` failed two invariants at once: every
	 * label capability must be declared by some node (they are declared by none,
	 * and could not be — the boxes did not exist yet), and a watched label nothing
	 * offers pages forever. Declaring them on claw-7/claw-8 up front to satisfy the
	 * first would have been precisely what node-profiles.json's gpu.$why-no-labels
	 * forbids: a claim entered before anything proved it. The 2026-09-07 settled
	 * decision says capabilities are DERIVED from what a box proves and the required
	 * set is the union of what covered repos actually ask for — and no covered repo
	 * asks for GPU work today.
	 *
	 * SO THIS IS THE MEASUREMENT, HELD ONE STEP SHORT OF BEING A ROUTING LEVER.
	 * When a real workload wants a GPU, promoting one of these to `surface: 'label'`
	 * is a deliberate, reviewed, one-line change made against probe output that
	 * already exists — instead of a guess made today about hardware nobody has
	 * booted.
	 *
	 * `nvenc-h264` WAS THE FIRST TO TAKE THAT STEP, 2026-10-23 (fleet-manager#3):
	 * hadoku-watchparty's ingest encodes with `h264_nvenc` and moved from a child
	 * process of its server to a fleet job. Its entry carries why.
	 *
	 * The honest expected answers on the two new cards, so nobody reads a `no` as a
	 * regression: NVENC AV1 encode arrived with Ada (RTX 40), so `av1-nvenc` is NO
	 * on both. H.264 and HEVC are YES on both. And every one of them is NO on an
	 * unrebooted box, because the DKMS module is not in the running kernel yet.
	 */
	{
		/*
		 * PROMOTED TO A LABEL 2026-10-23 (fleet-manager#3), against probe output that
		 * already existed: bootcamp had earned it on hokon (10-09), claw-1 (10-10),
		 * claw-8 and claw-9 (10-06). No `nodeOffer` change came with it — every
		 * earned identity label is offered, on the backstop too, which is how hokon
		 * already carried `jdk21`.
		 *
		 * FOUR NODES DEEP, ON PURPOSE. watchparty's ingest needs only H.264, so
		 * any of them can encode. What it also needs is the data endpoint's
		 * admission, a separate question with its own label (`data-peer`).
		 * Narrowing this label to hokon would make an encoder capability lie
		 * about the nodes that have it.
		 */
		id: 'nvenc-h264',
		label: 'NVENC H.264 encode',
		kind: 'identity',
		surface: 'label',
		verify: 'probe',
		description:
			'Hardware H.264 encoding through NVENC. The broadest NVENC codec — every ' +
			'NVIDIA card the fleet owns can do it, back to Maxwell. Routed on by ' +
			'watchparty’s ingest, alongside `data-peer`.',
	},
	{
		/*
		 * ADMISSION, NOT A TOOL — proved by connecting, never by a membership list.
		 *
		 * dataplatform's data listener refuses a peer it has not admitted BEFORE it
		 * reads a key, so "can encode" plus a key is not enough. It replaced
		 * `watchparty-media` (a host pin by data locality) on 2026-10-28, once the
		 * library moved into the endpoint. Before #28 the refusal was a bare 404:
		 * watchparty's ingest landed on claw-1 and every call 404'd (run
		 * 40639427546, fleet-manager#16). Who is admitted is dataplatform's
		 * decision (hadoku-dataplatform#28); this only READS the outcome, from the
		 * node, the way the job will meet it. An unkeyed request is 401 to an
		 * admitted peer, and nothing answers 401 before the peer check
		 * (dataplatform data/AGENTS.md). A refused one gets 403 `peer not
		 * admitted` (a bare 404 before 2026-10-28). So no secret is needed.
		 *
		 * The endpoint is the controller's to name (`probe-script.mjs`), because
		 * its address is private and this repo is public. A probe run without it
		 * prints nothing for this label, which is "not judged", never "no".
		 */
		id: 'data-peer',
		label: 'Admitted by the data endpoint',
		kind: 'identity',
		surface: 'label',
		verify: 'probe',
		description:
			'dataplatform’s data listener admits this node as a peer: an unkeyed request ' +
			'from the node gets the 401 an admitted peer gets, not the bare 404 a refused ' +
			'one does. Routed on by any job that reads or writes the data endpoint.',
	},
	{
		/*
		 * CAN SERVE A PLACED SERVICE — proved on the node, never read from a list.
		 *
		 * fleet-manager#16: the fleet places `kind: service` tenants itself, and
		 * hadoku_site can deploy one only to a node with the tenant toolchain on
		 * the PATH sudo gives a tenant, its own cloudflared tunnel up, and a
		 * service state root (hadoku_site docs/operations/MULTI_HOST_PM2.md,
		 * service-move gatherFacts()). Which nodes hadoku_site deploys to is its
		 * call (pm2-hosts.json); this reads whether the node CAN, the way
		 * `data-peer` reads the listener's verdict. Not `pm2-host`, which means
		 * the HUB and is hokon's alone: gating on it would rule out claw-6.
		 *
		 * The evidence is the tunnel ID, for hadoku_site's drift gate. Readiness
		 * of one tenant on the node (its user, pm2, clone, ingress rule) is
		 * `hosting --check`'s, since it cannot be known before the tenant exists.
		 */
		id: 'service-host',
		label: 'Can serve a placed pm2 service',
		kind: 'identity',
		surface: 'label',
		verify: 'probe',
		description:
			'A tenant’s toolchain (pm2, node, git, curl, rsync, pnpm, python3 with venv) on ' +
			'the PATH sudo hands a tenant, this node’s own cloudflared tunnel ready, and ' +
			'the service state root present. Required of a node before the fleet places a ' +
			'`kind: service` tenant there.',
	},
	{
		id: 'nvenc-hevc',
		label: 'NVENC HEVC encode',
		kind: 'identity',
		surface: 'implicit',
		verify: 'probe',
		description:
			'Hardware HEVC/H.265 encoding through NVENC. Maxwell 2nd-gen and later, so ' +
			'it separates a genuinely old card from a merely old one.',
	},
	{
		id: 'nvdec',
		label: 'NVDEC video decode',
		kind: 'identity',
		surface: 'implicit',
		verify: 'probe',
		description:
			'Hardware video DECODE on the GPU. Separate silicon and a separate driver ' +
			'path from NVENC — a card can lose one and keep the other.',
	},
	{
		id: 'cuda',
		label: 'CUDA kernels',
		kind: 'identity',
		surface: 'implicit',
		verify: 'probe',
		description:
			'A usable CUDA context on the device, proven by running a kernel — not by ' +
			'nvidia-smi answering, which only proves the driver is alive.',
	},
	{
		id: 'jit-canary',
		label: 'JIT runner per job',
		kind: 'identity',
		surface: 'label',
		verify: 'mint',
		description:
			'This node mints a runner per job. Carried ONLY by JIT mints, never by a standing ' +
			'registration, so the canary workflow that requests it can be answered only by the ' +
			'ephemeral dispatcher actually working.',
		// Offered to every ephemeral node by `nodeOffer` — declaring it is
		// redundant. `mintOnly` still keeps it off warm/standing listeners.
		mintOnly: true,
		requires: { facts: [MUST_BE_EPHEMERAL] },
	},
	{
		id: BACKSTOP_LABEL,
		label: 'Backstop on hokon',
		kind: 'identity',
		surface: 'label',
		verify: 'role',
		description:
			'An idle instance on the production host, promoted to hadoku-builder only when the ' +
			'claws are all down. WRITTEN BY runner-health, never declared in the manifest — it is ' +
			'here so that a node which does declare it is recognised rather than reported as ' +
			'unverifiable, and so census.ts stops being the only place its meaning is written.',
	},
	{
		id: 'cargo-bevy',
		label: 'Fast Bevy builds',
		kind: 'identity',
		surface: 'label',
		verify: 'probe',
		description:
			'This node compiles a large Bevy workspace FAST ENOUGH to be worth routing there. ' +
			'THE FIRST MEASURED CAPABILITY — `rust` answers whether the node can build at all ' +
			'and every managed node must, so it is a toolchain entry; this answers how fast, ' +
			'which only some nodes clear, so it is a LABEL. The payload is brave-quartet, a ' +
			'12-member Bevy 0.18 workspace: measured cold on all seven nodes 2026-09-14, ' +
			'`cargo build --workspace --locked` on real disk ran 6.9 min on claw-7 and 47.0 min ' +
			'on claw-3 — a 6.8x spread on identical source, which is why a general "heavy" tier ' +
			'cannot express this. DECLARED BY NO NODE, deliberately: it is EARNED from the ' +
			'bootcamp record and routed by `nodeOffer`, so `machines[].labels` stays untouched ' +
			'and the manifest cannot claim a speed the box has not demonstrated. ' +
			'Watched by the label floor like every demanded label: served while a standing ' +
			'runner carries it or an eligible claw that earned it can mint.',
		measure: {
			metric: 'compile throughput',
			unit: ' monomorphisations/s',
			atLeast: 1200,
			why:
				'Derived from the payload, not chosen. The measured proxy figures against the ' +
				'measured full build (2026-09-14, seven nodes, `payload-routing-2026-09-14.md` ' +
				'§6): claw-7 3528/6.9min, claw-4 2281/10.9min, claw-6 1529/17.0min, ' +
				'claw-1 1495/18.7min, claw-2 1521/24.0min, claw-3 923/47.0min, claw-5 734/33.4min. ' +
				'Spearman 0.929 against build rank, Pearson 0.984 against 1/build-seconds. The ' +
				'full `check` is 1.3x the build — measured, not guessed: claw-3 passed steps 1-25 ' +
				'and was killed by the 3600s JIT TTL at 60 min against a 47-min build, and the ' +
				'ratio then predicts the ~61 min that was observed. 1200 admits claw-7/4/6/1/2 ' +
				'and excludes claw-5 (~43 min full check, 72% of the TTL, no margin) and claw-3 ' +
				'(over it). It sits in the WIDE EMPTY BAND 923 -> 1495, so the one proxy ' +
				'inversion that exists (claw-1 vs claw-2, 2% apart) cannot flip anybody across ' +
				'it. And it is not just "the big boxes": claw-6 has 4 cores and 8 GB and earns ' +
				'it, claw-5 has 8 cores and 16 GB and does not — the existing 16 GB heavy rule ' +
				'selects claw-3/4/5 and would have routed a CPU-bound compile to two of the ' +
				'three WORST nodes for it. Re-tune here and nowhere else; the probe prints the ' +
				'number and never compares it.',
		},
	},
	{
		/*
		 * jdk21 (cardtable#5, added 2026-10-05): forge-e2e/forge-jvm move off
		 * the production host onto whichever claws can hold the JVM's
		 * footprint (p50 2.9 GB, p95 5.5 GB, max 10 GB). EARNED, like
		 * `cargo-bevy` and `av1-nvenc` — never declared, because
		 * `command -v java` lies the same way an encoder listing does:
		 * present-and-broken is indistinguishable from absent without running
		 * it.
		 *
		 * A DIFFERENTIATOR BETWEEN CLAWS, NOT A REQUIREMENT OF THE GENERAL
		 * POOL. Only SOME claws will ever earn it
		 * (`scripts/lib/toolchain-floor.mjs`'s `installedRamAtLeast` gates it on
		 * measured RAM — forge's footprint does not fit every box), and
		 * `requiredIdentitySet` does not add a pinned job's `jdk21` demand to the
		 * set every claw must prove, for the same reason `pm2-host`'s workload is
		 * not a fleet-wide requirement just because one repo pins to it.
		 *
		 * THE LABEL FLOOR WATCHES IT LIKE ANY OTHER DEMANDED LABEL
		 * (`src/label-floor.ts`, 2026-10-10). It was `floor: false` until then,
		 * because the floor counted standing runners only and every claw is JIT;
		 * now it is served while a standing runner carries it OR a claw that
		 * earned it — tool probe AND a fresh workload proof, through `nodeOffer`'s
		 * gate — can mint, and pages when neither holds.
		 *
		 * PROVEN BY THE SAME EXECUTION `REPAIRS.jdk21`/`REPAIRS.maven` use for
		 * `detect` (`scripts/lib/toolchain-floor.mjs`): compile and run a
		 * one-class program with the installed `javac`/`java`, then run
		 * `mvn -v`, all from a non-login shell on the stock PATH.
		 * `scripts/capability-probe.sh` runs the identical execution and emits
		 * `CAP jdk21`, so `fleet bootcamp` both INSTALLS jdk21/maven on an
		 * assigned, qualifying claw (`ensureTools` reads `applicableRepairs`,
		 * keyed off `tool.when`) and WRITES the result into
		 * `$capabilities.earned` once the probe confirms it — the same two-step
		 * contract every other `verify: 'probe'` label here already has.
		 *
		 * WAVE 4E (#102, 2026-10-08): THE TOOL PROOF ABOVE IS NOT ENOUGH.
		 * claw-3 cleared the RAM floor and the tool probe and then failed five
		 * full cardtable `forge-e2e` jobs — a 2-core/4-thread laptop part
		 * saturated by the two JVMs + server + Chromium one job runs alone.
		 * Neither check above says anything about the WORK the label routes,
		 * so this is the second, WORKLOAD proof: the label's real job, run for
		 * real, within a budget derived from nodes that already pass it. See
		 * {@link JobProofBudget} and `workloadGateStatus`.
		 *
		 * THE CHOSEN SPECS, AND WHY (`inputs.specs`). `play.spec.ts` and
		 * `arrow.spec.ts`, read-only off hadoku-cardtable 2026-10-08:
		 *   - `play.spec.ts`'s one forge-gated test drives a match through
		 *     plain `startPlayStack` — the DIRECT match-start path, no scenario
		 *     seed.
		 *   - `arrow.spec.ts`'s one forge-gated test drives `startPlayStack`
		 *     THEN `startScenarioMatch` — the SCENARIO match-start path, the
		 *     other of the two the harness has.
		 * Together: more than one match (done-when), both match-start paths
		 * covered, and — because EVERY `startPlayStack` call boots the
		 * server's host with the warm spare ready behind the live match's own
		 * JVM (`apps/server/src/play/host.ts`'s "warm spare") — both runs
		 * carry the job's real two-JVM footprint, not a trimmed one. Neither
		 * spec is the single biggest file in the suite; both are the smallest
		 * PAIR that still exercises every path the full 27-spec job does, so
		 * the canary costs minutes, not the ~15-18 min the full job takes.
		 * `only: 'e2e'` skips `forge-jvm` — the workload this label's probe
		 * (`detect`, above) already proves end-to-end on every call.
		 *
		 * THE BUDGET: `factor: 1.5, minProven: 2`. Two already-passing claws
		 * are enough to say "this is the fleet's normal pace for this canary"
		 * without over-fitting to one box's quirks, and 1.5x covers ordinary
		 * contention (wave 4e's own forge.yml note: three concurrent proof
		 * dispatches ran 2x their usual time under load) without admitting a
		 * node that is merely slow rather than saturated.
		 */
		id: 'jdk21',
		label: 'Java 21 + Maven',
		kind: 'identity',
		surface: 'label',
		verify: 'probe',
		description:
			'A Temurin 21 JDK and Maven that actually compile and run a program, not merely ' +
			"present on disk. Carried only by claws with room for forge's footprint (cardtable#5) " +
			'— a differentiator between claws, like av1-nvenc, never a requirement of the general ' +
			'pool.',
		jobProof: {
			repo: 'WolffM/hadoku-cardtable',
			workflow: 'forge.yml',
			job: 'forge-e2e',
			ref: 'main',
			inputs: { only: 'e2e', specs: 'play.spec.ts arrow.spec.ts' },
			runsOn: { input: 'runs_on', labels: ['self-hosted', BUILDER_LABEL, 'jdk21'] },
			// cardtable's ci.yml and forge.yml fire on push to main only.
			scratchBranch: true,
			evidence:
				'two friends play one Forge match|cast arrow, measured in a real browser|\\d+ passed',
			budget: { factor: 1.5, minProven: 2 },
		},
	},
	{
		/*
		 * java21 (2026-10-24, hadoku-cardtable's FLEET_MANAGER_FORGE_HOSTING
		 * request §2): a Java 21 runtime that RUNS, which is what a node needs to
		 * host Forge matches — and nothing else. Not `jdk21`, on purpose: that
		 * label routes forge-e2e CI jobs (p95 5.5 GB, max 10 GB), so it keeps its
		 * 12 GiB floor, Maven, and its workload canary. A hosting node runs no CI
		 * at all, and an idle JDK costs disk, not RAM, so claw-1/2/6 can hold this
		 * one without being offered the other.
		 *
		 * `surface: 'implicit'`: PROBED, ROUTABLE BY NOTHING. Cardtable reads it
		 * from `$capabilities.earned` to decide where it can place; no workflow
		 * may ask for it, which is what keeps it from becoming a backdoor onto
		 * the jdk21 workload.
		 *
		 * The probe compiles and runs a class and checks the MAJOR version, so a
		 * Java 17 on the stock PATH reads `no`, not `ok`.
		 */
		id: 'java21',
		label: 'Java 21 runtime',
		kind: 'identity',
		surface: 'implicit',
		verify: 'probe',
		description:
			'A Java 21 JDK that compiles and runs a class from a non-login shell. What a node ' +
			'needs to host Forge matches; carries no CI routing, unlike `jdk21`.',
	},
	{
		/*
		 * docker (2026-10-27, node-users §5.2): a daemon the CI user can BUILD
		 * an image with. brave-quartet's publish-server-image is the one job that
		 * needs it, and it appends this label to the fleet array.
		 *
		 * A LABEL, NOT TOOLCHAIN, since the CI user moved off admin. Before that
		 * every claw's CI was in the `docker` group and docker was a requirement
		 * of the general pool. A cut-over claw's ci user has no group and no
		 * sudo; only the claws given a rootless daemon (`containers: "docker"`,
		 * claw-8 and claw-5) can build, so this differentiates claws now.
		 *
		 * EARNED, never declared: the probe builds FROM scratch with buildx and
		 * reads the layer back, as the ci user, the way the job does.
		 */
		id: 'docker',
		label: 'Docker image builds',
		kind: 'identity',
		surface: 'label',
		verify: 'probe',
		description:
			'The CI user can build a docker image with buildx and read it back: rootless on a ' +
			'cut-over claw, the system daemon through the docker group before that.',
	},
	{
		id: 'ffmpeg',
		label: 'ffmpeg',
		kind: 'identity',
		surface: 'toolchain',
		verify: 'probe',
		description: 'A working ffmpeg binary. Required of every managed node.',
	},
	{
		id: 'gh',
		label: 'GitHub CLI',
		kind: 'identity',
		surface: 'toolchain',
		verify: 'probe',
		description:
			'A working `gh` that can REACH the API. Required of every managed node. Workflow ' +
			'steps across the fleet shell out to it — the alert-issue open/close pair on every ' +
			'update-wolffm job is the widest user — and a node without it fails those steps ' +
			'with exit 127 AFTER the real work has already succeeded. It was absent on ' +
			'claw-4/5/6 from their 2026-09-02 enrolment until 2026-09-05, and nothing noticed: ' +
			'no gate named gh, so which node a job drew decided whether it passed. Four repos ' +
			'failed in one fan-out and the same jobs had been green for days on claw-1/2/3.',
	},
	{
		id: 'rust',
		label: 'Rust toolchain',
		kind: 'identity',
		surface: 'toolchain',
		verify: 'probe',
		description:
			'A Rust toolchain that BUILDS, reachable from the stock PATH. TOOLCHAIN rather ' +
			'than a routing label: brave-quartet runs on fromJSON(vars.CI_RUNNER) — the ' +
			'GENERAL POOL — so any claw can draw its jobs, which makes rustc a requirement of ' +
			'every managed node rather than a differentiator between them. Modelling it as a ' +
			'label would make the fleet route around a hole instead of closing it, the same ' +
			'mistake the first draft of `playwright` made. The probe is PATH-SENSITIVE on ' +
			'purpose: on 2026-09-10 all seven claws were given rustup and a hand-check over ' +
			'ssh passed on all seven, because that check exported ~/.cargo/bin first the way ' +
			'a login shell does. A workflow `run:` step gets the stock PATH and sources no ' +
			'profile, so the first fleet run died on `rustup: command not found` against ' +
			'seven boxes that all "had" rustup. Fixed by symlinking the rustup proxies into ' +
			'/usr/local/bin; this capability is what keeps that true.',
	},
	{
		id: 'python-venv',
		label: 'Python venv',
		kind: 'identity',
		surface: 'toolchain',
		verify: 'probe',
		description:
			'`python3 -m venv` can CREATE a usable venv. Required of every managed node. The ' +
			'probe creates one rather than asking, because `venv --help` succeeds on a box where ' +
			'creation then fails for want of ensurepip — the claw-1/claw-2 drift of 2026-08-25, ' +
			'which read as a flaky test rather than as fleet drift.',
	},
	{
		id: 'python-toolcache',
		label: 'Python 3.11 + 3.12 cache',
		kind: 'identity',
		surface: 'toolchain',
		verify: 'probe',
		description:
			'A cached Python 3.11 AND 3.12 under /opt/hostedtoolcache that EXECUTES. Required of ' +
			'every managed node, because 5 of the 26 covered repos use `actions/setup-python` on ' +
			"the general pool as of 2026-09-07 (measured by `fleet tool-inventory --write`'s demand " +
			'ledger — re-run it rather than trusting this number, it already moved once: 3 on ' +
			'2026-09-03, then hadoku-pygmalion reverted a workaround and hadoku-games-host joined ' +
			'coverage) and the claws run trixie, for which actions/python-versions publishes NO build — so the ' +
			'cache is not an optimisation here, it is the only way that action can succeed. ' +
			'toolchain rather than label: every node must have it, so routing on it would say ' +
			'nothing. The probe RUNS the interpreter because the directory is the presence-check ' +
			'trap in miniature: on claw-1 it lists 3.11.15 and 3.12.13, du reports 20K, and both ' +
			'are symlinks into uv store. Measured 2026-09-02: claw-5 and claw-6 were registered, ' +
			'online and carrying hadoku-builder with the cache entirely absent.',
	},
	{
		id: 'playwright',
		label: 'Playwright browser',
		kind: 'identity',
		surface: 'toolchain',
		verify: 'probe',
		description:
			'A Playwright browser that LAUNCHES. TOOLCHAIN, not a routing label, and the first ' +
			'draft had that wrong. hadoku_site e2e-canary.yml runs on fromJSON(vars.CI_RUNNER) — ' +
			'the GENERAL POOL — so any claw can receive it, which makes a browser a requirement ' +
			'of every managed node rather than a differentiator between them. Measured 2026-09-02: ' +
			'claw-1, claw-2, claw-3 and hokon launch one; claw-5 and claw-6 have no binary. That ' +
			'gap is DRIFT TO FIX, not a routing fact to encode - and modelling it as a label ' +
			'would have made the fleet route around a hole instead of closing it. The probe ' +
			'launches a browser rather than running `playwright --version`, which answers about ' +
			'the npm package: ~/.cache/ms-playwright can hold 631MB and still lack the binary a ' +
			'spec needs, and e2e-canary carries NO `playwright install` step deliberately.',
	},
	{
		id: 'jitconfig',
		label: 'JIT runner config',
		kind: 'identity',
		surface: 'implicit',
		verify: 'probe',
		description:
			'`Runner.Listener` accepts `--jitconfig`. An UNDOCUMENTED flag the entire ephemeral ' +
			'dispatcher depends on, so a runner self-update is the expected way to lose it. ' +
			'Declared by nobody and routable by nothing; probed on every node that could mint.',
	},
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

/** The capability with this id, or undefined. Never guesses. */
export function capability(id: string): Capability | undefined {
	return BY_ID.get(id);
}
