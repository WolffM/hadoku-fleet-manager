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

import { BACKSTOP_LABEL, BUILDER_LABEL, PM2_HOST_LABEL } from './capability-registry-ids.js';
import {
	AV1_NVENC_CAPABILITY,
	BACKSTOP_CAPABILITY,
	BUILDER_LABEL_CAPABILITY,
	CARGO_BEVY_CAPABILITY,
	DATA_PEER_CAPABILITY,
	DOCKER_CAPABILITY,
	JDK21_CAPABILITY,
	JIT_CANARY_CAPABILITY,
	NVENC_H264_CAPABILITY,
	PM2_HOST_CAPABILITY,
	SERVICE_HOST_CAPABILITY,
	TASKAUTO_CAPABILITY,
} from './capability-registry-label.js';
import {
	CUDA_CAPABILITY,
	JAVA21_CAPABILITY,
	JITCONFIG_CAPABILITY,
	NVDEC_CAPABILITY,
	NVENC_HEVC_CAPABILITY,
	PM2_CAPABLE_CAPABILITY,
} from './capability-registry-implicit.js';
import {
	FFMPEG_CAPABILITY,
	MPV_CAPABILITY,
	GH_CAPABILITY,
	PLAYWRIGHT_CAPABILITY,
	PYTHON_TOOLCACHE_CAPABILITY,
	PYTHON_VENV_CAPABILITY,
	RUST_CAPABILITY,
} from './capability-registry-toolchain.js';

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

// Re-exported so every existing importer of these three ids from THIS module
// (census.ts, runner-health-label-floor.ts, manifest.ts, backstop-decision.ts,
// node-eligibility.ts, routes/fleet.ts, and several scripts/) compiles unchanged.
// The canonical declaration moved to capability-registry-ids.ts (see its own
// doc) so capability-registry-label.ts can use them without a cycle.
export { BACKSTOP_LABEL, BUILDER_LABEL, PM2_HOST_LABEL };

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
	BUILDER_LABEL_CAPABILITY,
	PM2_HOST_CAPABILITY,
	PM2_CAPABLE_CAPABILITY,
	TASKAUTO_CAPABILITY,
	AV1_NVENC_CAPABILITY,
	NVENC_H264_CAPABILITY,
	DATA_PEER_CAPABILITY,
	SERVICE_HOST_CAPABILITY,
	NVENC_HEVC_CAPABILITY,
	NVDEC_CAPABILITY,
	CUDA_CAPABILITY,
	JIT_CANARY_CAPABILITY,
	BACKSTOP_CAPABILITY,
	CARGO_BEVY_CAPABILITY,
	JDK21_CAPABILITY,
	JAVA21_CAPABILITY,
	DOCKER_CAPABILITY,
	FFMPEG_CAPABILITY,
	MPV_CAPABILITY,
	GH_CAPABILITY,
	RUST_CAPABILITY,
	PYTHON_VENV_CAPABILITY,
	PYTHON_TOOLCACHE_CAPABILITY,
	PLAYWRIGHT_CAPABILITY,
	JITCONFIG_CAPABILITY,
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

/** The capability with this id, or undefined. Never guesses. */
export function capability(id: string): Capability | undefined {
	return BY_ID.get(id);
}
