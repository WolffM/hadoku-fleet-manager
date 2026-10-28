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

import { isGuestNode } from './lib/node-role.js';
import type { ProofRecord } from './lib/measured.js';

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
 *          nothing to execute, or nothing the fleet is ALLOWED to execute:
 *          `hadoku-builder` is a routing lever nobody can prove, and a GUEST's
 *          labels stay declared because the fleet does not touch a guest at all.
 *          The declaration is the only evidence there is.
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
	 * `"claw"` | `"guest"`. DECLARED here rather than left to the index
	 * signature, because {@link verificationFor} reads it and a weak-type check
	 * would otherwise let any object through. Read via `isGuestNode`, never
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
	 * are exactly TWO exceptions to that. hokon's labels stay declared because
	 * hokon is a guest and nothing here probes it. And a MINT-ONLY label is
	 * declared because no probe can ever settle it: it is proven by MINTING, so
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
			'GUEST. That half still holds and is why the ROLE, not this field, decides for a ' +
			'guest — see {@link verificationFor}. THE DECLARED PATH IS RETIRED FOR EVERY ' +
			'NON-GUEST: a claw cannot type its way in, because `nodeOffer` REPLACES a declared ' +
			'probe-verified label with the proof record. hokon’s declaration is the one ' +
			'exception and it is held by the role, not by this entry. Measured 2026-09-26: ' +
			'`ok 24-online` on hokon (read-only, off the fleet chain), `no absent` on all eight ' +
			'claws.',
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
		 * THE FIRST WORKLOAD LEAVING THE GUEST, AND IT IS NOT SIZED BY THE ROLE ABOVE.
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
			'guest’s backstop registration; 517 MiB peak per job, measured on claw-8, which is ' +
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
		 * earned identity label is offered, on a guest too, which is how hokon
		 * already carried `jdk21`.
		 *
		 * FOUR NODES DEEP, ON PURPOSE. watchparty's ingest needs only H.264, so
		 * any of them can encode. What pins the job to one box is the DATA, and
		 * that is a separate question with its own label — `watchparty-media`
		 * below. Narrowing this label to hokon instead would make an encoder
		 * capability lie about three nodes that have it.
		 */
		id: 'nvenc-h264',
		label: 'NVENC H.264 encode',
		kind: 'identity',
		surface: 'label',
		verify: 'probe',
		description:
			'Hardware H.264 encoding through NVENC. The broadest NVENC codec — every ' +
			'NVIDIA card the fleet owns can do it, back to Maxwell. Routed on by ' +
			'watchparty’s ingest, alongside `watchparty-media`.',
	},
	{
		/*
		 * DATA LOCALITY, NOT A TOOL — and still proved by looking, not declared.
		 *
		 * watchparty's ingest runs IN PLACE against its ~290 GB library
		 * (`INGEST_MEDIA_ROOT`, a repo variable there), reading sources and writing
		 * ~1 GB outputs beside them. A node without the library refuses the job at
		 * once (`ingest-job.sh`, exit 2). So "can encode H.264" was never enough,
		 * and "is hokon" would be the wrong answer the day the library moves.
		 *
		 * The probe reads the directory the job will read. That makes the label
		 * follow the library: move it to a claw at the same path and the next
		 * bootcamp earns it there, with no declaration to forget. THE PATH IS A
		 * CROSS-REPO CONTRACT with watchparty's `INGEST_MEDIA_ROOT`; the probe
		 * names it and says why.
		 */
		id: 'watchparty-media',
		label: 'Holds watchparty library',
		kind: 'identity',
		surface: 'label',
		verify: 'probe',
		description:
			'This node holds watchparty’s media library, which ingest encodes in ' +
			'place: `input/` is present and non-empty and the media root is writable. ' +
			'Proved by reading the directory, so the label moves with the library rather ' +
			'than with a hostname.',
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

/**
 * How this capability is proven ON THIS NODE — `verify`, narrowed by the ROLE.
 *
 * THE REGISTRY SAYS WHAT THE EVIDENCE IS; THE ROLE SAYS WHETHER THE FLEET IS
 * ALLOWED TO GO AND GET IT. Those are different questions and `verify` alone can
 * only answer the first, which was survivable while every probe-verified label
 * was also one the fleet was free to execute anywhere. `pm2-host` is the first
 * that is not: it is the bar a CLAW must EARN (#6), and simultaneously a fact
 * about hokon that nothing here may test, because hokon is a GUEST (operator,
 * 2026-09-14: "I do NOT want hokon being impacted by the fleet chain").
 *
 * So for a guest a LABEL capability reads as `role` no matter what the registry
 * says — the declaration is the only evidence there is, which is the first of
 * the two exceptions {@link Capability.mintOnly} already names. It is deliberately
 * NOT restricted to `pm2-host`: the exemption belongs to the role, and the next
 * label promoted to `probe` would otherwise silently start demanding proof from
 * a machine nothing is allowed to probe.
 *
 * WHAT IT COSTS IF THIS IS WRONG. `nodeOffer` REPLACES a declared probe-verified
 * label with the proof record. hokon carries a `$capabilities` record, so without
 * this narrowing its declared `pm2-host` is dropped from the offer the moment the
 * registry entry flips — and `pm2-host` is what the five infra workflows route
 * on. `k-node-offer.test.ts` pins both directions.
 *
 * `toolchain` and `implicit` capabilities are untouched: neither is routable, so
 * neither is anything a guest declares.
 */
export function verificationFor(
	node: ManifestNode,
	cap: Capability | undefined
): CapabilityVerification | undefined {
	if (!cap) return undefined;
	if (cap.surface === 'label' && isGuestNode(node)) return 'role';
	return cap.verify;
}

/** Every capability expressed as a GitHub runner label. */
export function labelCapabilities(): Capability[] {
	return CAPABILITIES.filter((c) => c.surface === 'label');
}

/**
 * The PRIORITY LADDER, highest rung first: `pm2-host > hadoku-builder > taskauto`.
 *
 * GitHub has no runner priority, so this ordering is not something the forge
 * enforces — it is enforced by the fast loop writing and removing
 * `hadoku-builder`, and by `node-reservation` holding the production host off
 * lower rungs while it serves a higher one. Which makes the ordering itself a
 * FACT ABOUT THE FLEET that readers need and, until now, could only copy out of
 * a comment.
 *
 * Derived from `rung`, so adding a middle rung reorders every reader at once
 * instead of leaving four prose copies to be found by hand.
 */
export function ladder(): string[] {
	return labelCapabilities()
		.filter((c) => typeof c.rung === 'number')
		.sort((a, b) => (a.rung ?? 0) - (b.rung ?? 0))
		.map((c) => c.id);
}

/**
 * Labels GitHub puts on every self-hosted registration by itself.
 *
 * Not capabilities: nothing declares them, nothing can lose them, and a job
 * asking for one is not asking for anything a node had to earn. They are here
 * because every reader that displays a runner's labels has to subtract them,
 * and there were THREE copies of this list — `placement.IMPLICIT_LABELS`
 * (lower-cased, for matching), `ephemeral-exec.mintLabels` (cased, because a
 * JIT mint must add them explicitly — `generate-jitconfig` does not), and a
 * fourth in the command station's Machines table, in another repo entirely.
 *
 * Cased as GitHub reports them. Compare case-insensitively; `satisfiesLabels`
 * does, and a JIT mint sends `Linux`/`X64` while a job asks for `linux`/`x64`.
 */
export const IMPLICIT_LABELS: readonly string[] = ['self-hosted', 'Linux', 'X64'];

/**
 * Labels a STANDING listener must never carry, derived from the registry.
 *
 * A capability whose `requires.facts` include the ephemeral fact is one only a
 * JIT mint may offer. `jit-canary` is the case that exists, and its own entry
 * says why: "A standing runner carrying this label would answer the canary
 * without minting anything, so it would stay green through a total dispatcher
 * outage."
 *
 * WHY THIS EXISTS. The warm-listener cache provisioned its runners with
 * `mintLabels()` — the same set a JIT mint gets — so a warm listener on claw-3
 * inherited `jit-canary` and answered the canary. Observed 2026-09-08/09: five
 * consecutive `site:jit-canary` failures, every one served by
 * `warm-claw-3-hadoku_site`, failing on the step named "prove this ran on a
 * minted runner". The canary caught it, which is the system working — but the
 * warm cache should never have been able to answer it.
 *
 * DERIVED, not a hardcoded list, because the whole point of this registry is
 * that a new ephemeral-only capability should not need three files edited. If
 * one is added tomorrow, warm listeners stop carrying it for free.
 */
export function ephemeralOnlyLabels(): string[] {
	return CAPABILITIES.filter(
		(c) => c.surface === 'label' && (c.requires?.facts ?? []).some((f) => f.id === 'ephemeral')
	).map((c) => c.id);
}

/**
 * Eligibility label ids — the ones the fast loop owns and this package must
 * never write from the registration path.
 */
export function eligibilityLabels(): string[] {
	return labelCapabilities()
		.filter((c) => c.kind === 'eligibility')
		.map((c) => c.id);
}

/** Ids a probe can execute, and ids a probe cannot. Split by `verify`. */
export function probeableIds(): Set<string> {
	return new Set(CAPABILITIES.filter((c) => c.verify === 'probe').map((c) => c.id));
}

/** Capabilities whose truth is declarative or proven by a mint, not by a probe. */
export function unprobeableIds(): Set<string> {
	return new Set(CAPABILITIES.filter((c) => c.verify !== 'probe').map((c) => c.id));
}

/**
 * One record from `~/.hadoku-mgmt/demand-ledger.jsonl`, the shape
 * `fleet tool-inventory --write` emits (`scripts/lib/demand-derive.mjs`). Only
 * the fields `requiredIdentitySet` reads.
 */
export interface DemandRecord {
	/**
	 * `"ci"` or `"resident"` — the wave-3-prep discriminator
	 * (`docs/planning/service-ledger-2026-09-10.md` §1). One file, two
	 * populations, so the floor reads one ledger; absent on every row written
	 * before 2026-09-10.
	 */
	class?: string;
	fleetForm?: boolean;
	selfHosted?: boolean;
	hosted?: boolean;
	capabilities?: string[];
}

/** The demand ledger's CI class — one row per `(repo, job)`. */
export const CI_DEMAND_CLASS = 'ci';

/**
 * Is this a CI-demand row?
 *
 * ABSENT COUNTS AS `ci`, and that is the backward-compatibility half rather
 * than a looseness: `fleet tool-inventory --write` was the ledger's only writer
 * until 2026-09-10, so every one of the 147 rows on the live ledger is a CI row
 * with no `class` field. Treating absent as "not ci" would empty
 * `requiredIdentitySet` the instant this shipped and before the ledger was
 * re-emitted — and an empty required set makes `check-label-floor`'s
 * required-gap check pass having checked nothing, which is CLAUDE.md's "no gate
 * may get easier to pass the worse the failure gets" exactly.
 *
 * The ledger's other writer discharges the mirror obligation: resident rows
 * ALWAYS carry `class: "resident"` (S's §2), so nothing unlabelled is ever
 * resident demand.
 */
export function isCiDemandRecord(record: DemandRecord): boolean {
	return record.class === undefined || record.class === CI_DEMAND_CLASS;
}

/**
 * The identity capabilities the covered repos' jobs actually ask for, on the
 * GENERAL POOL — union of every demand-ledger record's `capabilities` where
 * the job can land on ANY claw (`fleetForm && selfHosted && !hosted`).
 *
 * DERIVED, NEVER DECLARED (`bootcamp-earned-labels-2026-09-02.md` §4,
 * `tier-assignment-2026-09-03.md` §5.3): this is `hadoku-builder`'s required
 * set, and it is computed from the ledger every time rather than typed by
 * hand, so it cannot go stale the way "9 of the 26 covered repos" and then
 * "3" did before the ledger existed.
 *
 * Excludes a job pinned to hosted runners or to one specific machine
 * (`hosted`, or `selfHosted` without `fleetForm`) on purpose — a repo must not
 * be able to raise the FLEET-WIDE bar with a job no claw will ever receive.
 *
 * Pure: the caller reads the ledger file and hands the parsed records here.
 * An id this returns that is not a registered capability (`docker` is
 * demand-derivable and, at zero demand as of 2026-09-07, unregistered) is a
 * real gap — `check-label-floor` is what turns that into a finding, because
 * "the ledger asks for it" and "the registry knows how to prove it" are
 * different facts and only the second is decided here.
 */
export function requiredIdentitySet(records: readonly DemandRecord[]): Set<string> {
	const out = new Set<string>();
	for (const r of records) {
		// EXPLICIT, not safe-by-accident. A resident row has no `fleetForm`, so the
		// next line already dropped it — but that is the accident of a CI-only
		// predicate needing a field resident demand does not carry, and the next
		// reader to be written will not be so lucky
		// (`service-ledger-2026-09-10.md` §3).
		if (!isCiDemandRecord(r)) continue;
		if (!r.fleetForm || !r.selfHosted || r.hosted) continue;
		for (const id of r.capabilities ?? []) out.add(id);
	}
	return out;
}

/**
 * A node's IDENTITY labels — the facts about it, projected onto every runner
 * the reconciler registers.
 *
 * DERIVED, not filtered by hand. The reconciler carried
 * `.filter(l => l !== BUILDER_LABEL)` in two places with a paragraph beside each
 * explaining that `hadoku-builder` is eligibility and must be excluded. That is
 * the registry's `kind` field written twice in prose, and it only ever excluded
 * the ONE eligibility label someone remembered to name.
 *
 * An UNDECLARED label is passed through unchanged rather than dropped. The
 * reconciler is additive on purpose — it registers and relabels, it never
 * strips — and a derivation that silently swallowed an unknown label would
 * unroute live jobs on a manifest typo. The schema gate is what rejects the
 * typo; this function must not also be a filter, or the two fight.
 */
export function identityLabels(node: ManifestNode): string[] {
	const eligibility = new Set(eligibilityLabels());
	return (node.labels ?? []).filter((l) => !eligibility.has(l));
}

/**
 * The bootcamp facet on this node, or null when nothing has ever looked.
 *
 * `null` is the "I could not look" answer and every caller must keep it
 * distinct from an empty one: a node bootcamp has never reached has no
 * evidence, which is not the same as evidence that it can do nothing.
 */
export function bootcampFacet(node: ManifestNode): BootcampFacet | null {
	const rec: unknown = node.$capabilities;
	if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
	return rec;
}

/**
 * What this node has PROVEN BY EXECUTION — or `null` when nothing has looked.
 *
 * `earned ∪ prereqs`, and the union is the transition bridge rather than
 * belt-and-braces. Until 2026-09-10 bootcamp promoted only
 * `proven ∩ declared` among probeable LABEL capabilities, and `av1-nvenc` is
 * the fleet's only earnable label — so `earned` is `[]` on all seven claws on
 * the live manifest (measured 2026-09-10) while `prereqs` carries the five
 * capabilities each of them actually proved. Reading `earned` alone would say
 * every claw has proven nothing, which is how a derivation that is "more
 * correct" takes a healthy fleet down. `earned` alone is sufficient once the
 * producer has run; the union stays correct either way because `earned`
 * supersets `prereqs` under the new semantics.
 *
 * `null` when there is no facet at all, AND when the facet carries no `earned`
 * array — a record written by something that is not this bootcamp cannot
 * answer the question, and guessing is what "I could not look must never
 * render as nothing is wrong" forbids.
 */
export function provenCapabilities(node: ManifestNode): Set<string> | null {
	const rec = bootcampFacet(node);
	if (!rec || !Array.isArray(rec.earned)) return null;
	const prereqs = (Array.isArray(rec.prereqs) ? rec.prereqs : [])
		.map((p) => p?.id)
		.filter((id): id is string => typeof id === 'string');
	return new Set([...rec.earned, ...prereqs]);
}

// ---------------------------------------------------------------------------
// Workload proofs — wave 4e (#102): bootcamp earns the workload, not just the
// tool. See JobProofBudget's own doc for WHY the bar is derived rather than
// fixed, and `workloadGateStatus`/`nodeOffer` for how it withholds a label.
// ---------------------------------------------------------------------------

/**
 * How long a `$proof` stays FRESH, in days, before `nodeOffer` stops trusting
 * a pass it recorded.
 *
 * Pinned to the SAME cadence `fleet benchmark --due 30` already uses for
 * `$benchmark` (`scripts/benchmark-fleet.mjs`, wired through hadoku_site's
 * `ci:benchmark-cadence` cron at `--due 30`) rather than a second number: both
 * are "a monthly re-measure keeps a state-dir facet honest", and re-deriving
 * that argument here would be one more cadence nobody re-tunes together with
 * the other.
 */
export const WORKLOAD_PROOF_DUE_DAYS = 30;

/**
 * A bootcamp record older than this many days no longer describes the node:
 * toolchains drift and capabilities rot between runs. The doctor fails a node
 * past it, and `GET /fleet` ships it so the panel tones "bootcamped N days
 * ago" on the same line rather than inventing one. Moved here from
 * `scripts/lib/doctor.mjs` (2026-10-09) so both read one number.
 */
export const BOOTCAMP_STALE_DAYS = 30;

/**
 * Capability ids that declare a WORKLOAD proof — a `jobProof` with a `budget`,
 * as opposed to `taskauto`'s plain `jobProof` (conclusion alone decides,
 * forever). These are the only ids `nodeOffer`'s gate ever applies to, and the
 * set `fleet bootcamp --prove` canaries and `src/runners/node-regression.ts`
 * (wave 4e §B) watches for a repeat failure.
 */
export function workloadGatedCapabilities(): string[] {
	return CAPABILITIES.filter((c) => c.jobProof?.budget).map((c) => c.id);
}

/** Has this proof aged past the monthly cadence? Pure over an injected clock. */
export function isProofFresh(record: ProofRecord, now: Date = new Date()): boolean {
	const ms = now.getTime() - Date.parse(record.at);
	return Number.isFinite(ms) && ms >= 0 && ms / 86_400_000 <= WORKLOAD_PROOF_DUE_DAYS;
}

/**
 * Every record in `records` that counts as an ALREADY-PROVEN node for
 * `capabilityId`: a FRESH PASS. The same selector feeds both the gate's
 * `minProven` count and the budget's median — one notion of "proven",
 * reused, rather than two that could disagree about the same record.
 */
export function freshPassingProofs(
	records: readonly ProofRecord[],
	capabilityId: string,
	now: Date = new Date()
): ProofRecord[] {
	return records.filter(
		(r) => r.capability === capabilityId && r.verdict === 'pass' && isProofFresh(r, now)
	);
}

export interface ProofBudgetVerdict {
	/** Has the budget cleared `minProven`? False: pass/fail alone decides. */
	bootstrapped: boolean;
	/** Seconds, or null while unbootstrapped. */
	budgetSec: number | null;
	/** How many fresh-passing OTHER nodes fed the median. */
	provenCount: number;
}

/**
 * The duration budget for a capability's workload proof, derived from the
 * durations of already fresh-passing proofs on OTHER nodes.
 *
 * PURE: the caller reads the state dir (`measured.ts#readProofsForCapability`)
 * and hands in the result, filtered to nodes other than the one being judged
 * — this function does the arithmetic and nothing else.
 */
export function proofBudget(
	cap: Capability | undefined,
	otherNodesProofs: readonly ProofRecord[],
	now: Date = new Date()
): ProofBudgetVerdict {
	const budget = cap?.jobProof?.budget;
	if (!budget || !cap) return { bootstrapped: false, budgetSec: null, provenCount: 0 };
	const durations = freshPassingProofs(otherNodesProofs, cap.id, now)
		.map((r) => r.durationSec)
		.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
		.sort((a, b) => a - b);
	if (durations.length < budget.minProven) {
		return { bootstrapped: false, budgetSec: null, provenCount: durations.length };
	}
	const mid = Math.floor(durations.length / 2);
	const median = durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
	return { bootstrapped: true, budgetSec: median * budget.factor, provenCount: durations.length };
}

/** The raw facts a fresh canary run produced, before the budget judges them. */
export interface WorkloadProofOutcome {
	conclusion: string | null;
	ranOnTarget: boolean;
	evidenceMatched: boolean;
	durationSec: number | null;
	/** It landed on the node and was still running when the bound ran out. */
	timedOut?: boolean;
}

/**
 * Pass/fail for a FRESH canary run, against the budget computed from
 * already-proven nodes. THE PROBE MEASURES; THE REGISTRY JUDGES — same split
 * as {@link meetsBar}, one level up: `proveJob` only reports what happened,
 * this is the one place a bar is written down for what happened to mean PASS.
 */
export function judgeWorkloadProof(
	cap: Capability | undefined,
	outcome: WorkloadProofOutcome,
	budget: ProofBudgetVerdict
): { verdict: 'pass' | 'fail'; why: string } {
	const jp = cap?.jobProof;
	if (!jp?.budget) return { verdict: 'fail', why: 'capability declares no workload-proof budget' };
	if (outcome.ranOnTarget && outcome.timedOut) {
		return { verdict: 'fail', why: 'the job ran on the node and did not finish within the bound' };
	}
	if (!outcome.ranOnTarget || outcome.conclusion !== 'success') {
		return {
			verdict: 'fail',
			why: outcome.ranOnTarget
				? `the job ran on the node and concluded "${outcome.conclusion ?? 'unknown'}"`
				: 'the job did not land on the target node',
		};
	}
	if (!outcome.evidenceMatched) {
		return {
			verdict: 'fail',
			why: 'the job went green but no evidence line matched — a pass with no evidence is not a pass',
		};
	}
	if (!budget.bootstrapped) {
		return {
			verdict: 'pass',
			why: `pass (budget unbootstrapped: ${budget.provenCount}/${jp.budget.minProven} proven node(s))`,
		};
	}
	if (outcome.durationSec === null) {
		return { verdict: 'fail', why: 'no duration recorded against a bootstrapped budget' };
	}
	const budgetSec = budget.budgetSec ?? Number.POSITIVE_INFINITY;
	if (outcome.durationSec > budgetSec) {
		return {
			verdict: 'fail',
			why:
				`${(outcome.durationSec / 60).toFixed(1)} min against a ${(budgetSec / 60).toFixed(1)} min ` +
				`budget (${jp.budget.factor}x over ${budget.provenCount} proven node(s))`,
		};
	}
	return {
		verdict: 'pass',
		why:
			`${(outcome.durationSec / 60).toFixed(1)} min within the ${(budgetSec / 60).toFixed(1)} min ` +
			`budget (${budget.provenCount} proven node(s))`,
	};
}

export interface WorkloadGateStatus {
	/** Does this gate currently let the label through for this node? */
	offer: boolean;
	/** Has the gate cleared `minProven` fleet-wide, for anyone? */
	active: boolean;
	provenCount: number;
	/** One operator-facing line — rendered in `fleet capabilities` and `GET /fleet`, never silent. */
	reason: string;
}

/**
 * Does a node's PROVEN label still get offered, once a capability declares a
 * workload-proof budget? The fourth kind of evidence `nodeOffer` consults,
 * beside the three its own doc names — and the only one that can say NO about
 * a label the TOOL proof already said YES to.
 *
 * THE ROLLOUT CONSTRAINT (wave 4e, "Lane A must land with the gate SWITCHED
 * OFF for existing earned nodes"). `provenCount` is FLEET-WIDE and already
 * freshness-filtered by the caller (`freshPassingProofs` over every node's
 * record for this capability): the gate is ACTIVE only once it clears
 * `budget.minProven`. Until then — DORMANT — this node's missing or never-run
 * proof changes nothing, so routing stays exactly as it is today. The ONE
 * thing that is NEVER dormant: an explicit FAIL or STALE verdict on THIS
 * node withdraws the label immediately, active or not — a degraded node must
 * lose the label the same tick ("Settled"), not after the tracker runs enough
 * canaries elsewhere to switch the gate on for everybody else.
 */
export function workloadGateStatus(
	cap: Capability | undefined,
	record: ProofRecord | null | undefined,
	provenCount: number,
	now: Date = new Date()
): WorkloadGateStatus {
	const budget = cap?.jobProof?.budget;
	if (!budget) return { offer: true, active: false, provenCount: 0, reason: 'not workload-gated' };
	const active = provenCount >= budget.minProven;
	if (record && (record.verdict === 'fail' || record.verdict === 'stale')) {
		return {
			offer: false,
			active,
			provenCount,
			reason: `tool present, workload ${record.verdict === 'fail' ? 'FAILED' : 'STALE'}: ${record.why}`,
		};
	}
	if (!active) {
		return {
			offer: true,
			active,
			provenCount,
			reason: `workload gate dormant: ${provenCount}/${budget.minProven} proofs`,
		};
	}
	if (!record || record.verdict !== 'pass') {
		return {
			offer: false,
			active,
			provenCount,
			reason: record
				? `tool present, workload is not a pass (last verdict ${record.verdict})`
				: 'tool present, no workload proof',
		};
	}
	if (!isProofFresh(record, now)) {
		return {
			offer: false,
			active,
			provenCount,
			reason: `tool present, workload proof EXPIRED: last pass ${record.at}, over ${WORKLOAD_PROOF_DUE_DAYS} days ago`,
		};
	}
	return { offer: true, active, provenCount, reason: `tool present, workload PASSED ${record.at}` };
}

/**
 * Every workload-gated capability a node's TOOL proof already earned, with
 * its gate status — one call for a reporter (`GET /fleet`, `fleet bootcamp`)
 * instead of re-running `nodeOffer`'s own loop to recover the REASON a label
 * it already filtered out is missing.
 *
 * `workloadProofs`/`provenCounts` are the same per-id maps `nodeOffer` takes;
 * an id the node has not EARNED the tool for is omitted — there is nothing
 * new to say about it here, and the existing unearned/bootcamp reporting
 * already covers that half.
 */
export function workloadGateReasons(
	node: ManifestNode,
	workloadProofs: Record<string, ProofRecord | null>,
	provenCounts: Record<string, number> = {}
): Record<string, WorkloadGateStatus> {
	const proven = provenCapabilities(node);
	const out: Record<string, WorkloadGateStatus> = {};
	if (!proven) return out;
	for (const id of workloadGatedCapabilities()) {
		if (!proven.has(id)) continue;
		out[id] = workloadGateStatus(capability(id), workloadProofs[id] ?? null, provenCounts[id] ?? 0);
	}
	return out;
}

/** The two inputs `nodeOffer`'s gate (and `workloadGateReasons`) need, for every node at once. */
export interface WorkloadGateContext {
	byNode: Record<string, Record<string, ProofRecord | null>>;
	provenCounts: Record<string, number>;
	/** Per-node revoked labels, or `'all'` when the record is unreadable. Absent: none. */
	revoked?: Record<string, ReadonlySet<string>> | 'all';
}

/** The revoked set `nodeOffer` takes for one node, from a tick's context. */
export function revokedFor(
	gate: Pick<WorkloadGateContext, 'revoked'>,
	node: string
): ReadonlySet<string> | 'all' | undefined {
	return gate.revoked === 'all' ? 'all' : gate.revoked?.[node];
}

/**
 * Build the fleet-wide `{byNode, provenCounts}` a ROUTING caller feeds to
 * `nodeOffer`/`workloadGateReasons` for EVERY node in one pass — the function
 * that closes the defect the manager's verification caught before landing
 * (the lane's first draft left every real caller omitting the gate, which is
 * safe only as a rollout default, not as the production answer):
 * `ephemeral-tick.ts`'s `offerFor` (the mint, both warm-listener label sites,
 * and placement's `labelsFor`), `scripts/floor-probe.mjs`'s two probe mints,
 * and `scripts/check-capabilities.mjs`'s report all build this ONCE per
 * tick/pass/run and read it for every node, rather than each re-deriving it
 * (or, as the lane's first draft had it, not deriving it at all — the defect).
 *
 * PURE: the caller reads the state dir (`measured.ts#readProofsForCapability`
 * per gated id) and hands in the result; this does only the arithmetic.
 *
 * `opts.corrupt` IS THE SAFETY DECISION, made explicit rather than inferred
 * from an empty `proofsByCapability`: an UNREADABLE or MALFORMED `$proof` file
 * must never collapse to "no record for anyone", because that is exactly what
 * would silently RE-GRANT a label a FAIL/STALE mark this very tick was
 * supposed to enforce. So `corrupt: true` forces every workload-gated id
 * ACTIVE (`provenCounts[id] = Number.MAX_SAFE_INTEGER`, clearing any
 * `minProven`) with NO record for any node — which `workloadGateStatus`
 * reads as "tool present, no workload proof" and WITHHOLDS, fleet-wide, until
 * the file is readable again. A false negative (a healthy node briefly loses
 * the label) is the safe failure direction; silently keeping a known-bad
 * node routable is not. See `measured.ts#proofFileStatus`, which is what a
 * caller reads to decide `corrupt`.
 */
export function workloadGateContext(
	nodeNames: readonly string[],
	proofsByCapability: Readonly<Record<string, readonly ProofRecord[]>>,
	opts: {
		corrupt?: boolean;
		now?: Date;
		revoked?: Record<string, ReadonlySet<string>> | 'all';
	} = {}
): WorkloadGateContext {
	const ids = workloadGatedCapabilities();
	const byNode: Record<string, Record<string, ProofRecord | null>> = {};
	for (const name of nodeNames) byNode[name] = {};
	const provenCounts: Record<string, number> = {};
	for (const id of ids) {
		if (opts.corrupt) {
			provenCounts[id] = Number.MAX_SAFE_INTEGER;
			for (const name of nodeNames) byNode[name][id] = null;
			continue;
		}
		const records = proofsByCapability[id] ?? [];
		provenCounts[id] = freshPassingProofs(records, id, opts.now).length;
		for (const name of nodeNames) byNode[name][id] = records.find((r) => r.node === name) ?? null;
	}
	return { byNode, provenCounts, ...(opts.revoked ? { revoked: opts.revoked } : {}) };
}

/**
 * THE ONE ANSWER TO "WHAT LABELS DOES THIS NODE OFFER" — issue #19.
 *
 * Four readers asked it separately off `machines[].labels` and the array was
 * both the JIT mint's label WRITER and a filtered identity source, with no type
 * and no gate separating the two: `ephemeral-tick.ts` (mints and warm
 * listeners), `placement.ts` (refuses a node whose labels do not satisfy the
 * job), `floor-probe.mjs` (mints probes). Stripping the eight `hadoku-builder`
 * declarations — which the 2026-09-07 operator decision requires, since
 * capabilities are DERIVED and never declared — therefore minted
 * `self-hosted,Linux,X64` while every covered repo asks for
 * `["self-hosted","hadoku-builder"]`, and `check-label-floor` stayed GREEN
 * through it. Proved by execution, twice, in the Wave 2 closeout.
 *
 * THE THREE KINDS OF EVIDENCE, AND WHY THEY ARE NOT INTERCHANGEABLE:
 *
 *   verify: 'probe'  the bootcamp record ANSWERS it. A declaration is a claim,
 *                    and `av1-nvenc` is the registry's own example of a claim
 *                    that lies (Debian's ffmpeg reports the encoder whether or
 *                    not the GPU can use it). So a declared probe-verified
 *                    label is REPLACED by `provenCapabilities` — not unioned
 *                    with it, or this function could never disagree with the
 *                    manifest and `check-label-floor`'s disagreement check
 *                    would be the verifier-reads-its-own-writer trap.
 *   verify: 'role'   nothing to execute, or nothing this fleet may execute.
 *          / 'mint'  `hadoku-builder` is a routing lever, `jit-canary` is proven
 *                    only by a mint, and EVERY label on a GUEST reads as `role`
 *                    ({@link verificationFor}) because the fleet does not touch a
 *                    guest at all. The declaration is the only evidence there is
 *                    and it is passed through.
 *   ELIGIBILITY      never derived here at all — see `opts.eligible`.
 *
 * A FOURTH, ADDED WAVE 4E (#102): a capability whose `jobProof` declares a
 * `budget` is a WORKLOAD proof, not just a tool proof, and `provenCapabilities`
 * saying the tool is earned is no longer sufficient to offer it — see
 * {@link workloadGateStatus}. `opts.workloadProofs`/`opts.provenCounts` are
 * how the caller supplies that evidence; OMITTING `workloadProofs` (every
 * call site today) is the WAVE 4E ROLLOUT CONSTRAINT made structural rather
 * than a flag: no `$proof` exists yet for any node, so a caller that always
 * supplied an empty gate would offer `jdk21` to NOBODY and queue every
 * cardtable Forge job the moment this landed. Until a caller is wired to
 * read the state dir and pass real records, this id is offered exactly as it
 * was before this wave — tool-earned, nothing more.
 *
 * AND WHEN NOTHING HAS LOOKED, the declaration stands. A node with no bootcamp
 * facet keeps exactly the labels it declares, so this function is a no-op
 * against a node the producer has never reached. That is the only direction
 * that is safe: the alternative silently strips `av1-nvenc` off hokon — one
 * node deep, and the reason 22 dataplatform tests skip when it is dark — on an
 * unreadable state file. `check-label-floor` is what turns the missing record
 * into a FINDING, so the quiet fallback is never also a silent one.
 *
 * An UNREGISTERED label passes through unchanged, for the reason
 * `identityLabels` already gives: the schema gate rejects a manifest typo, and
 * a derivation that also filtered would unroute live jobs on one.
 *
 * @param opts.eligible has the CALLER decided this node may take general CI?
 *        This function does not re-decide it: a second authority here could
 *        disagree with the real one — precisely when the demand ledger is
 *        unreadable, i.e. at 3am. For a mint, the dispatcher's decision to mint
 *        IS the eligibility decision. For a standing registration the fast
 *        loop's safety rule decides (`nodeIsSafe`), or the backstop on a guest,
 *        and never at registration time — see `registrationLabels`. See `provesRequiredSet` for the
 *        consumer-contract predicate, which is this function's input, not its
 *        business.
 * @param opts.workloadProofs This node's OWN `$proof` record per workload-gated
 *        capability id — `undefined`/`null` for an id the caller looked up and
 *        found nothing. An id with NO entry in this map (including the whole
 *        map being omitted) is left ungated: see the fourth-evidence note
 *        above for why that is the safe default everywhere this has not been
 *        wired to the state dir yet.
 * @param opts.provenCounts Fleet-wide fresh-passing-node count per workload-
 *        gated capability id, deciding whether that id's gate is ACTIVE yet
 *        (`>= budget.minProven`). Missing or absent reads as 0 (dormant).
 */
export function nodeOffer(
	node: ManifestNode,
	opts: {
		eligible: boolean;
		workloadProofs?: Record<string, ProofRecord | null | undefined>;
		provenCounts?: Record<string, number>;
		/**
		 * Labels a probe EXECUTED on this node and judged failed
		 * (src/capability-revocations.ts). Withheld until a passing probe clears
		 * them. `'all'`: the revocation record is unreadable, so every
		 * probe-verified routing label is withheld — never re-granted on a bad read.
		 */
		revoked?: ReadonlySet<string> | 'all';
	}
): string[] {
	const eligibility = new Set(eligibilityLabels());
	const proven = provenCapabilities(node);
	const out: string[] = [];
	for (const id of node.labels ?? []) {
		if (eligibility.has(id)) continue;
		const cap = capability(id);
		// The declaration is a CLAIM about something executable, and the record
		// is the answer. Skipped only when there IS a record to answer with —
		// and `verificationFor`, not `cap.verify`, because on a GUEST there is
		// nothing the fleet is allowed to execute and the declaration stands.
		if (cap && cap.surface === 'label' && verificationFor(node, cap) === 'probe' && proven) {
			continue;
		}
		out.push(id);
	}
	if (proven) {
		for (const id of proven) {
			const cap = capability(id);
			if (!cap || cap.surface !== 'label' || cap.kind !== 'identity') continue;
			// THE FOURTH KIND OF EVIDENCE (wave 4e): a workload-gated id additionally
			// needs `workloadGateStatus` to say yes. Gated ONLY when the caller opted
			// in by naming this id in `workloadProofs` — see this function's own doc.
			if (opts.workloadProofs && Object.hasOwn(opts.workloadProofs, id)) {
				const gate = workloadGateStatus(cap, opts.workloadProofs[id], opts.provenCounts?.[id] ?? 0);
				if (!gate.offer) continue;
			}
			out.push(id);
		}
	}
	// MINT-VERIFIED LABELS ARE DERIVED, NEVER DECLARED. `jit-canary` is true of
	// every node that mints a runner per job, and it was hand-declared on claw-3
	// alone — so the hourly canary only ever proved claw-3's JIT path, read the
	// weakest claw being down as the dispatcher being down, and the panel showed
	// "JIT runner per job" on one claw of eight that all do it.
	//
	// Only on a node bootcamp has reached, like every earned label: a node with
	// no record offers nothing routable ("no evidence is not evidence").
	if (proven) {
		for (const cap of CAPABILITIES) {
			if (cap.surface !== 'label' || cap.verify !== 'mint') continue;
			if ((cap.requires?.facts ?? []).every((f) => f.holds(node))) out.push(cap.id);
		}
	}
	const revoked = opts.revoked;
	const kept = revoked
		? out.filter((id) => {
				if (revoked !== 'all') return !revoked.has(id);
				const cap = capability(id);
				return !(cap && cap.surface === 'label' && verificationFor(node, cap) === 'probe');
			})
		: out;
	// Eligibility is the fast loop's and the backstop's to grant, never a probe's
	// to revoke: general CI keeps flowing whatever the revocation record says.
	if (opts.eligible) kept.push(...eligibilityLabels());
	return [...new Set(kept)];
}

/**
 * The `--labels` argument for a fresh registration on this node.
 *
 * NEVER BORN ELIGIBLE. A registration carries the node's capabilities and
 * nothing that grants general CI: eligibility is granted by the fast loop once
 * the node is judged safe (or by the backstop, on a guest), within one tick. A
 * node born eligible starts schedulable before anything has judged it — which
 * is how 24 hokon runners once came up eligible on the PRODUCTION host. (Until
 * 2026-09-21 this took a `demotable` flag from the tier ladder, and a node in
 * an `alwaysOn` tier WAS born eligible.)
 *
 * DELEGATES to `nodeOffer` rather than carrying its own derivation: "one
 * question, one answer" is this repo's first critical rule, and a standing
 * registration and a JIT mint are the same question asked on different paths.
 */
export function registrationLabels(
	node: ManifestNode,
	gate: {
		workloadProofs?: Record<string, ProofRecord | null | undefined>;
		provenCounts?: Record<string, number>;
		revoked?: ReadonlySet<string> | 'all';
	} = {}
): string[] {
	// NEVER a mint-only label on a standing registration. `nodeOffer` derives
	// `jit-canary` for every ephemeral node since 0.29.5 — right for a mint, and
	// fatal here: a standing runner carrying it answers the canary with nothing
	// minted, which is the outage the canary exists to catch.
	const mintOnly = new Set(ephemeralOnlyLabels());
	return nodeOffer(node, { eligible: false, ...gate }).filter((l) => !mintOnly.has(l));
}

/** Why a node does or does not satisfy `hadoku-builder`'s consumer contract. */
export interface RequiredSetVerdict {
	ok: boolean;
	/** Required ids this node does not prove. Empty when `ok`. */
	missing: string[];
	/** One operator-facing line, or null when the contract holds. */
	reason: string | null;
}

/**
 * `hadoku-builder`'s CONSUMER CONTRACT, as a predicate: "a node carries it iff
 * it proves the required set" (operator, 2026-09-07).
 *
 * `required` is the demand-derived set — `requiredIdentitySet` over the
 * `class: "ci"` rows of the demand ledger — never a declared list. Pure, so the
 * caller does the I/O.
 *
 * NOT YET WIRED INTO THE LADDER, DELIBERATELY. `nodeFailsBootcamp`
 * (`src/fleet-loop.ts:266`) fails OPEN: a node with no recorded finding is
 * born eligible, which is the opposite of "iff it proves". Flipping it is the
 * right end state and is NOT a same-commit change, because the flip is only
 * safe once the required set can be read reliably — an unreadable ledger would
 * otherwise demote the entire fleet at once. This function exists so the gate
 * that REPORTS the gap and the ladder that will eventually enforce it share one
 * implementation instead of two that drift. See
 * `docs/planning/claw-floor-design-2026-09-07.md` §1.1.
 */
export function provesRequiredSet(
	node: ManifestNode,
	required: ReadonlySet<string>
): RequiredSetVerdict {
	const rec = bootcampFacet(node);
	const proven = provenCapabilities(node);
	if (!rec || !proven) {
		return {
			ok: false,
			missing: [...required].sort(),
			reason:
				'no `fleet bootcamp --write` finding on record — nothing has looked, which is ' +
				'not the same as having failed',
		};
	}
	const blocked = (rec.blocked ?? []).map((b) => b?.id).filter(Boolean);
	const unprobed = rec.unprobed ?? [];
	if (blocked.length || unprobed.length) {
		return {
			ok: false,
			missing: [...required].filter((id) => !proven.has(id)).sort(),
			reason:
				`bootcamp ${rec.at ?? '(undated)'} reports blocked ${blocked.join(', ') || '(none)'}, ` +
				`unprobed ${unprobed.join(', ') || '(none)'}`,
		};
	}
	const missing = [...required].filter((id) => !proven.has(id)).sort();
	return {
		ok: missing.length === 0,
		missing,
		reason: missing.length ? `does not prove ${missing.join(', ')}` : null,
	};
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface CapabilityFinding {
	/** Stable id so a gate can be reasoned about without matching prose. */
	rule: string;
	/**
	 * The node this finding is about. The KEY stays `node`: findings are
	 * printed by `fleet capability-schema --json`, and stdout shape is a
	 * contract. See docs/VOCABULARY.md §"Where the rename stops".
	 */
	machine: string | null;
	capability: string | null;
	message: string;
}

/**
 * Validate a manifest against the registry.
 *
 * PURE. No network, no ssh, no filesystem — which is the point: `fleet
 * capabilities` proves a node can DO what it claims and needs to reach every
 * box to say so, and a node it cannot reach is a node whose promises went
 * unchecked. This answers the cheaper question, offline and completely: is what
 * the manifest CLAIMS even coherent. The two are different layers and neither
 * substitutes for the other.
 *
 * @param manifest the parsed fleet-runner-manifest.json
 * @param probeEmits the capability ids `capability-probe.sh` actually prints,
 *        parsed from the script itself. Omit to skip the drift rule — a caller
 *        that cannot read the probe must not silently report it as consistent.
 * @param opts.workloadGate the `$proof` state, built by `workloadGateContext`
 *        exactly as the reconciler builds it. The only input that is not the
 *        manifest itself — the caller reads the state dir. Omitted, a standing
 *        node's workload-gated label cannot be judged and is reported.
 */
export function validateCapabilities(
	manifest: FleetManifestShape,
	probeEmits?: Set<string>,
	opts: { workloadGate?: WorkloadGateContext } = {}
): CapabilityFinding[] {
	const findings: CapabilityFinding[] = [];
	const nodes = Object.entries(manifest.machines ?? {});
	const add = (rule: string, node: string | null, cap: string | null, message: string): void => {
		findings.push({ rule, machine: node, capability: cap, message });
	};

	// --- what nodes declare -------------------------------------------
	for (const [name, m] of nodes) {
		for (const id of m.labels ?? []) {
			const cap = capability(id);
			if (!cap) {
				add(
					'unknown-capability',
					name,
					id,
					`declares label "${id}", which is in no capability registry entry. A label is a ` +
						`PROMISE that GitHub routes on: an unregistered one has no meaning, no floor ` +
						`alert and nothing that can verify it. Add it to CAPABILITIES in src/capabilities.ts.`
				);
				continue;
			}
			if (cap.surface !== 'label') {
				add(
					'surface-mismatch',
					name,
					id,
					`declares "${id}" as a node label, but it is a ${cap.surface} capability — ` +
						`${cap.description}`
				);
			}
		}
	}

	// --- what nodes OFFER must be supportable --------------------------------
	// READ FROM `nodeOffer`, NOT FROM `labels` (#98). This loop used to walk the
	// declared array only, and under the 2026-09-09 decision nothing declares
	// `hadoku-builder` any more — so its THROTTLE_FIELDS were checked on no node
	// at all, and a claw with no `maxConcurrent` would have rendered
	// MAX_CONCURRENT=99 with this rule green. A capability's requirements bind
	// whoever OFFERS it: declared, earned, or eligible for general CI.
	//
	// ELIGIBLE means every non-guest. That is not `nodeFailsBootcamp`'s answer
	// for this tick and does not try to be: the fast loop can grant the builder
	// label to any claw at any tick, so any claw must be ready to carry it. A
	// guest gets it only through the backstop, and its declared and earned labels
	// are still checked here.
	for (const [name, m] of nodes) {
		const offered = new Set([
			...(m.labels ?? []).filter((id) => capability(id)?.surface === 'label'),
			...nodeOffer(m, { eligible: !isGuestNode(m) }),
		]);
		for (const id of offered) {
			const cap = capability(id);
			if (!cap || cap.surface !== 'label') continue;
			for (const f of cap.requires?.fields ?? []) {
				if (m[f.field] === undefined) {
					add(
						'missing-required-field',
						name,
						id,
						`offers "${id}" (declared, earned or eligible) but declares no \`${f.field}\`. ${f.why}`
					);
				}
			}
			for (const fact of cap.requires?.facts ?? []) {
				if (!fact.holds(m)) {
					add(
						'unsupported-claim',
						name,
						id,
						`claims "${id}" but does not satisfy \`${fact.id}\`. ${fact.why}`
					);
				}
			}
		}
	}

	// --- what the fleet requires of everybody ------------------------------
	// AN ABSENT OR EMPTY REQUIREMENT IS A FINDING (#98). `?? []` made a missing
	// `toolchain.capabilities` iterate nothing and report nothing — every node
	// then clears a bar of zero, and bootcamp, converge-toolchain and
	// check-capabilities all read this list. Same for `toolCache`: the versions
	// seeded under /opt/hostedtoolcache are what `actions/setup-python` finds,
	// and an empty map means no node is checked for any of them.
	const required = manifest.toolchain?.capabilities;
	if (!Array.isArray(required) || required.length === 0) {
		add(
			'toolchain-unset',
			null,
			null,
			`toolchain.capabilities is ${Array.isArray(required) ? 'empty' : 'missing'}. It is what ` +
				`every managed node must prove; without it every node clears a bar of zero and ` +
				`nothing says so.`
		);
	}
	const toolCache = manifest.toolchain?.toolCache;
	const seeded = Object.entries(toolCache ?? {}).filter(
		([k, v]) => !k.startsWith('$') && Array.isArray(v) && v.length > 0
	);
	if (!seeded.length) {
		add(
			'toolchain-unset',
			null,
			null,
			`toolchain.toolCache is ${toolCache ? 'empty (no language with any version)' : 'missing'}. ` +
				`It names the versions seeded under /opt/hostedtoolcache that actions/setup-python ` +
				`reads; without it no node is checked for any of them.`
		);
	}
	for (const id of required ?? []) {
		const cap = capability(id);
		if (!cap) {
			add(
				'unknown-capability',
				null,
				id,
				`toolchain.capabilities requires "${id}", which is in no capability registry entry. ` +
					`Nothing can probe it, so it is required of every node and checked on none.`
			);
		} else if (cap.surface !== 'toolchain') {
			add(
				'surface-mismatch',
				null,
				id,
				`toolchain.capabilities requires "${id}", but it is a ${cap.surface} capability. ` +
					`A toolchain requirement applies to EVERY managed node, so it can never be ` +
					`something one node offers and another does not.`
			);
		}
	}

	// --- the floor: a STANDING offer must be EARNED like a mint ------------
	// The label floor (`src/label-floor.ts`) counts a label SERVED when a
	// standing online runner carries it, or when a minting node offers it
	// through `nodeOffer` — tool probe, plus the workload proof for a gated
	// label. The minting arm therefore only ever counts capacity that proved
	// itself. The standing arm counts whatever GitHub's listing shows, so a
	// standing registration carrying an earnable label its node has NOT earned
	// is capacity the floor reads as serving, and nothing has shown it can do
	// the work. That is the bypass, and it is the only one left.
	//
	// WHAT IT IS NOT, any more: "a standing node offers a `floor: false` label".
	// That rule existed because the old floor was standing-only and a label
	// claws minted had to be kept out of it; with one rule for every label there
	// is no exemption for a standing offerer to break, and hokon earning `jdk21`
	// and `cargo-bevy` the way a claw does is exactly what it should do.
	//
	// HOW A STANDING NODE COMES TO OFFER WHAT IT DID NOT EARN. A guest's labels
	// read as `role` ({@link verificationFor}), so its DECLARATIONS stand — the
	// documented exception for a guest nothing has looked at. The gap is a guest
	// bootcamp HAS looked at: a declared `av1-nvenc` or `pm2-host` its record does
	// not earn is a declaration the evidence contradicts, still projected onto
	// every standing registration. And a workload-gated label, when nobody
	// supplied the gate to judge it by.
	//
	// The standing offer is `registrationLabels` — what the reconciler projects —
	// with the same workload gate the reconciler builds. Without `workloadGate`
	// a gated label cannot be judged, and "I could not look" is a finding.
	//
	// `floor-unoffered` (a watched label no node offers) is GONE from this
	// static check: "watched" is now DEMAND, which only `fleet label-floor` can
	// read (it scans every covered repo's workflows and job history), and that
	// gate fails on exactly this case as `unoffered`.
	for (const [name, m] of nodes) {
		if (m.ephemeral === true) continue;
		const proven = provenCapabilities(m);
		const gate = opts.workloadGate
			? {
					workloadProofs: opts.workloadGate.byNode[name] ?? {},
					provenCounts: opts.workloadGate.provenCounts,
				}
			: {};
		for (const id of registrationLabels(m, gate)) {
			const cap = capability(id);
			if (!cap || cap.surface !== 'label' || cap.kind !== 'identity' || cap.verify !== 'probe') {
				continue;
			}
			let unearned: string | null = null;
			if (!proven) {
				// A GUEST nothing has looked at keeps its declarations — the documented
				// exception (`Capability.mintOnly`), not a gap: the fleet does not probe
				// a guest by policy. Anyone else standing with no record has simply not
				// been bootcamped.
				if (!isGuestNode(m)) {
					unearned = 'it has no bootcamp record, so nothing has executed the probe on it';
				}
			} else if (!proven.has(id)) {
				unearned =
					'its bootcamp record does not earn it — the offer stands on a declaration the ' +
					'evidence contradicts';
			} else if (cap.jobProof?.budget && !opts.workloadGate) {
				unearned =
					'it is workload-gated and no workload-proof context was supplied, so whether a ' +
					'minting node in its place would be offered it was not judged';
			}
			if (!unearned) continue;
			add(
				'floor-bypassed',
				name,
				id,
				`offers "${id}" on STANDING registrations, and the label floor counts every one of ` +
					`them online as SERVING "${id}" — but ${unearned}. A minting node offers it only ` +
					`once it has earned it (probe, plus the workload proof where one is declared), so ` +
					`the floor would read green on capacity nothing has proven. Run ` +
					`\`fleet bootcamp --write\` against ${name}, or stop declaring it.`
			);
		}
	}

	// --- registry vs probe ---------------------------------------------------
	// The registry says which capabilities are proven by EXECUTING them. The
	// probe script is what executes them. Neither reads the other at runtime, so
	// nothing but this rule stops them drifting — and the drift is silent in both
	// directions: a registry `verify: 'probe'` the script does not emit reports
	// `no result` on every node forever, and a `CAP` line the registry does not
	// know is a probe nobody reads.
	if (probeEmits) {
		for (const id of probeableIds()) {
			if (!probeEmits.has(id)) {
				add(
					'probe-drift',
					null,
					id,
					`the registry says "${id}" is proven by EXECUTING it, but capability-probe.sh ` +
						`emits no \`CAP ${id}\` line. Every node claiming it would report ` +
						`"no result" — a promise that can never be verified reads as drift on a ` +
						`healthy fleet.`
				);
			}
		}
		for (const id of probeEmits) {
			const cap = capability(id);
			if (!cap) {
				add(
					'probe-drift',
					null,
					id,
					`capability-probe.sh emits \`CAP ${id}\` and no registry entry claims it. ` +
						`The probe result is computed on every node and read by nothing.`
				);
			} else if (cap.verify !== 'probe') {
				add(
					'probe-drift',
					null,
					id,
					`capability-probe.sh executes "${id}", but the registry says it is verified by ` +
						`\`${cap.verify}\` — so check-capabilities skips the probe result it just paid ` +
						`an ssh round-trip for.`
				);
			}
		}
	}

	// --- workload-proof budgets (wave 4e, #102) -----------------------------
	// Registry-internal: a nonsensical bar is a nonsensical bar whether or not
	// any node has ever claimed the capability, so this does not wait for a
	// manifest declaration to find it — unlike every rule above, it checks
	// `CAPABILITIES` itself, not `manifest`.
	for (const cap of CAPABILITIES) findings.push(...jobProofBudgetFindings(cap));

	return findings;
}

/**
 * The `invalid-job-proof-budget` arm, pulled out of {@link validateCapabilities}
 * so it is callable with a FIXTURE `Capability` directly — `CAPABILITIES` is
 * the live registry, not a test manifest, and there is no other seam for
 * proving each check actually fires.
 */
export function jobProofBudgetFindings(cap: Capability): CapabilityFinding[] {
	const budget = cap.jobProof?.budget;
	if (!budget) return [];
	const out: CapabilityFinding[] = [];
	const add = (message: string): void =>
		void out.push({ rule: 'invalid-job-proof-budget', machine: null, capability: cap.id, message });
	if (!(budget.factor > 1)) {
		add(
			`"${cap.id}"'s workload-proof budget.factor is ${budget.factor}, which admits no slack ` +
				`over the median at all (or shrinks it) — every proven node would be at permanent risk ` +
				`of falling outside its own measurement.`
		);
	}
	if (!(Number.isInteger(budget.minProven) && budget.minProven >= 1)) {
		add(
			`"${cap.id}"'s workload-proof budget.minProven is ${budget.minProven} — it must be a ` +
				`positive integer, or the budget can never bootstrap.`
		);
	}
	try {
		new RegExp(cap.jobProof!.evidence, 'i');
	} catch (err) {
		add(`"${cap.id}"'s jobProof.evidence is not a valid regex: ${(err as Error).message}`);
	}
	return out;
}

/**
 * The capability ids `capability-probe.sh` emits, parsed from the script text.
 *
 * Reads the `say <id> …` calls rather than a hand-kept list beside them: a
 * verifier that reads its own writer's artifact cannot fail. Returns null when
 * the text contains no `say` calls at all, because an empty set would make the
 * drift rule report every probeable capability as missing — a parser failure
 * must not render as a fleet finding.
 */
export function parseProbeCapabilities(scriptText: string): Set<string> | null {
	const out = new Set<string>();
	for (const m of scriptText.matchAll(/^\s*say\s+([A-Za-z0-9_-]+)\s/gm)) out.add(m[1]);
	return out.size ? out : null;
}
