/**
 * WHAT THE REPORT'S OWN WORDS MEAN, declared once, beside the code that emits
 * them.
 *
 * `capabilities.ts` is the model for this and the reason it works: a label's
 * `description` lives with the gate that enforces it, so a tooltip cannot
 * describe a capability differently from the check. Everything in this file is
 * the same contract applied to the enums `GET /fleet` puts on the wire.
 *
 * WHY IT IS NOT IN THE CONSUMER
 * -----------------------------
 * It was. The command station carried a `Record<ClawState, Tone>`, a
 * description per state, a four-branch switch over `BackstopReason` and a
 * hand-written sentence for `admissionBasis`. FleetView's own header already
 * states the rule that forbids this — "THIS FILE HOLDS NO OPINION ABOUT THE
 * FLEET'S VOCABULARY … If you find yourself typing a label name here, it
 * belongs there instead" — and the rule was applied to the nouns and missed for
 * the verbs. Both halves drift the same way; only the nouns were fixed.
 *
 * The cost is not hypothetical and it is not cosmetic. Two of the eight claw
 * states exist ONLY because of mechanisms currently being replaced: `demoted`
 * is the tier ladder holding a node back, `mintable` is the standing/ephemeral
 * split. When those go, a consumer holding its own copy does not break loudly —
 * it keeps rendering fluent, confident prose about a system that no longer
 * exists. A missing row in this file renders as nothing at all, which is the
 * failure everyone wants.
 *
 * WHAT DELIBERATELY DOES NOT TRAVEL
 * ---------------------------------
 * Tones, colours, icons, and any word chosen for a layout. `TelemetryKind` is a
 * SEVERITY, and a consumer maps it onto its palette once. Shipping `'warning'`
 * from here would make this package responsible for how a browser looks, which
 * is exactly the line `fleet-report-types.ts` draws when it says the components
 * stay in the command station.
 *
 * ORDER IS NOT SIGNIFICANT and no reader may treat it as such. These are
 * lookups. `vocabulary.ladder` is the one ordered list in the payload and it
 * says so.
 */
import type {
	AdmissionBasis,
	AdmissionCaveat,
	AdmissionClause,
	BackstopReason,
	CapacityKind,
	CapabilitySurface,
	CapabilityVerification,
	ClawState,
	FailureZoneTerm,
	FleetFailuresByZone,
	GhCaller,
	LabelledTerm,
	TelemetryTerm,
} from './fleet-report-types.js';

/**
 * What a machine is doing, in one word.
 *
 * `Record<ClawState, …>` on purpose: a ninth state fails this file to compile
 * rather than reaching a panel undescribed.
 */
export const CLAW_STATES: Record<ClawState, TelemetryTerm> = {
	free: {
		kind: 'ok',
		description: 'online, eligible, and at least one instance is idle',
	},
	busy: {
		kind: 'ok',
		description: 'online and eligible; every instance is running a job',
	},
	demoted: {
		kind: 'reserve',
		description:
			'online and healthy, but not switched on for scheduling — capacity held ' +
			'in reserve, not a fault',
	},
	offline: {
		kind: 'fault',
		description: 'registered for this repo, but the runner is not connected',
	},
	absent: {
		kind: 'fault',
		description: 'no registration at all for the repo the census reads',
	},
	mintable: {
		kind: 'ok',
		description: 'holds no standing registration, and can mint a runner on demand',
	},
	unreachable: {
		kind: 'unknown',
		// The wording is load-bearing. This node's capacity is UNKNOWN and every
		// rollup that sums it as zero is understating the fleet, not measuring it.
		description: 'the last probe could not reach it — its capacity is unknown, not zero',
	},
	sick: {
		kind: 'fault',
		description: "the install guard found this node's pnpm store damaged",
	},
};

/**
 * Why the backstop is up.
 *
 * `none` is `ok` and must render as such: an idle backstop is the system
 * working. It was rendered as an absence, which is how "the production host is
 * correctly reserved" and "we have no idea" looked the same.
 */
export const BACKSTOP_REASONS: Record<BackstopReason, TelemetryTerm> = {
	outage: {
		kind: 'fault',
		description: 'promoted because the claws are down — the fleet has no other capacity',
	},
	saturation: {
		kind: 'degraded',
		description: 'promoted because every claw is busy; the production host is absorbing CI',
	},
	holding: {
		kind: 'degraded',
		description:
			'still up after a saturation promote — one-sided hysteresis, so a fleet ' +
			'that just recovered is not immediately dropped back into a queue',
	},
	none: {
		kind: 'ok',
		description: 'reserved and idle — the claws are coping, which is the intended state',
	},
};

/**
 * Which budget admitted the number beside it. Data, so a consumer never has to
 * know what the word means — the retired `tier` basis left without a change
 * downstream.
 */
export const ADMISSION_BASES: Record<AdmissionBasis, TelemetryTerm> = {
	dispatcher: {
		kind: 'ok',
		description:
			'this node mints a runner per job, so the dispatcher’s own concurrency ' +
			'cap is what admits work',
	},
	standing: {
		kind: 'ok',
		description:
			'this node holds standing registrations: GitHub assigns to them directly, ' +
			'bounded by the node’s declared maxConcurrent',
	},
};

/**
 * Which clause of `admitMint`'s GENERIC per-tick check refused this node —
 * @see AdmissionClause, FleetMachine.admissionRefusal (wave 4a, #100).
 *
 * `memory` is the one worth alarming about: it is what left claw-6 and
 * claw-2 starving in silence for days while `admissionFree` kept reporting
 * `mintable`. `concurrency` is the fleet working as intended (a busy node),
 * and `drained` is an operator's own decision — neither is a fault.
 */
export const ADMISSION_CLAUSES: Record<AdmissionClause, TelemetryTerm> = {
	memory: {
		kind: 'fault',
		description:
			'refused for want of free memory against this repo’s reserve — the clause ' +
			'`admissionFree` never applies, and the one `runner-health.ts`’s ' +
			'starvation finding watches',
	},
	concurrency: {
		kind: 'ok',
		description:
			'refused only because every concurrency slot is already in flight — a busy node, not a fault',
	},
	drained: {
		kind: 'reserve',
		description: 'held out of service for maintenance — an operator’s own decision, not a fault',
	},
	space: {
		kind: 'fault',
		description:
			'refused for want of free space on `/tmp` or `_work` (the filesystem holding the JIT ' +
			'slots) (#101) — measured by `df`, never declared; the starvation finding watches this ' +
			'clause too',
	},
	other: {
		kind: 'unknown',
		description:
			'`admitMint` returned a refusal this payload does not yet classify — read ' +
			'the raw `reason` string',
	},
};

/** Why an admission figure is missing or provisional. @see AdmissionCaveat */
export const ADMISSION_CAVEATS: Record<AdmissionCaveat, TelemetryTerm> = {
	unreachable: {
		kind: 'unknown',
		description: 'not measured — the probe could not reach this node',
	},
	undeclared: {
		kind: 'degraded',
		description:
			'no concurrency cap has been declared for this node, so the figure is a ' +
			'fallback the dispatcher also uses — an operator still owes it a real one',
	},
};

/**
 * The rows of the capacity breakdown — what has to happen before work lands.
 *
 * THE POINT OF THESE BEING DATA. Each names a mechanism, and mechanisms change:
 * `mintable` exists because of the JIT dispatcher. There was a third row,
 * `promotable`, for the tier ladder; when the ladder was retired on 2026-09-21
 * its row went with it and the panel needed no commit — where a wire key would
 * have had to be deleted in two repos, in the right order, without a window.
 *
 * The kinds are ordered as they appear here for readability only. Nothing may
 * treat `byKind` as ordered.
 */
export const CAPACITY_KINDS: Record<CapacityKind, TelemetryTerm> = {
	immediate: {
		kind: 'ok',
		description:
			'a runner is standing by — GitHub can assign a job to it this second, ' +
			'with nothing in this fleet having to act first',
	},
	mintable: {
		kind: 'ok',
		// NOT `degraded`. Minting is the normal, intended path on an all-JIT
		// fleet; the thing worth alarming about is this being the ONLY row with
		// anything in it while the dispatcher is failing, which is a question
		// about the dispatcher and is answered there.
		description:
			'the dispatcher must mint a runner first — real capacity, roughly two ' +
			'minutes away rather than instant',
	},
};

/**
 * Who spent a GitHub call — the rows of `githubBudget[].byCaller` (#119). All
 * `ok`: a caller is a name, not a verdict; whether its spend is a problem is
 * the budget's own `fractionLeft`.
 */
export const GH_CALLERS: Record<GhCaller, LabelledTerm> = {
	reap: {
		kind: 'ok',
		label: 'JIT reap',
		description:
			'the sweep that deletes orphaned JIT registrations; one runner listing per repo it walks',
	},
	'dispatch-poll': {
		kind: 'ok',
		label: 'Queue poll',
		description: "the dispatcher's queued-runs listing per repo; conditional, so a 304 is free",
	},
	'dispatch-probe': {
		kind: 'ok',
		label: 'Jobs probe',
		description: "the dispatcher's per-run jobs listing, to learn what a queued run is waiting on",
	},
	mint: {
		kind: 'ok',
		label: 'Mint',
		description: 'generate-jitconfig and the cleanup around a JIT mint',
	},
	'warm-cache': {
		kind: 'ok',
		label: 'Warm cache',
		description: "the warm listener's registration checks, fills and rotations",
	},
	'fleet-loop': {
		kind: 'ok',
		label: 'Fast loop',
		description: 'the 60-second probe/repair/label loop, outside the dispatch it hands off to',
	},
	'runner-health': {
		kind: 'ok',
		label: 'Runner health',
		description: "the 10-minute health tick's own reads: census, runs sweep, queue pressure",
	},
	backstop: {
		kind: 'ok',
		label: 'Backstop sweep',
		description: "runner-health's fan-out of the backstop label across every repo",
	},
	'ci-alerts': {
		kind: 'ok',
		label: 'CI alerts',
		description: 'the CI-red alerting pass that rides the health tick',
	},
	'ci-runner-var': {
		kind: 'ok',
		label: 'CI_RUNNER sync',
		description: 'the per-repo CI_RUNNER variable read and write',
	},
	route: {
		kind: 'ok',
		label: 'HTTP route',
		description: "a call made to answer a request to this package's router",
	},
	unattributed: {
		kind: 'unknown',
		label: 'Unattributed',
		description: 'a call made outside every named scope — a caller this list does not know yet',
	},
};

/** Where a capability shows up — what kind of thing proving it settles. */
export const CAPABILITY_SURFACES: Record<CapabilitySurface, LabelledTerm> = {
	label: {
		kind: 'ok',
		label: 'Routing label',
		description:
			'a runner label GitHub routes jobs by; a node offers it only once it has earned it',
	},
	toolchain: {
		kind: 'ok',
		label: 'Toolchain',
		description: 'a tool jobs shell out to; required of nodes, never a routing label',
	},
	implicit: {
		kind: 'ok',
		label: 'Implicit',
		description: 'a fact about the node the fleet relies on but nothing routes by',
	},
};

/** How a capability is settled. */
export const CAPABILITY_VERIFICATIONS: Record<CapabilityVerification, LabelledTerm> = {
	probe: {
		kind: 'ok',
		label: 'Probed',
		description: 'bootcamp proves it by running it on the node',
	},
	role: {
		kind: 'ok',
		label: 'Assigned',
		description: 'assigned by the fleet topology; no probe can settle it',
	},
	mint: {
		kind: 'ok',
		label: 'Set at mint',
		description: 'carried only by runners the dispatcher mints, never by a standing one',
	},
};

/**
 * The failure zones `job-history.failuresByZone` counts. A zone is a prior,
 * not a verdict (see `classifyZone`): `box` failures are worth re-running on
 * another node, `code` ones are the repo's own red.
 */
export const FAILURE_ZONES: Record<keyof FleetFailuresByZone, FailureZoneTerm> = {
	runner: {
		kind: 'fault',
		group: 'box',
		label: 'Runner',
		description: "failed in the runner's own setup, or left no step record at all",
	},
	seam: {
		kind: 'fault',
		group: 'box',
		label: 'Setup step',
		description: 'failed installing or checking out — the seam between the node and the job',
	},
	fleet: {
		kind: 'fault',
		group: 'box',
		label: 'Fleet kill',
		description: 'killed by the fleet itself, at the unit TTL',
	},
	content: {
		kind: 'degraded',
		group: 'code',
		label: 'Code',
		description: "failed in the job's own steps — tests, build, lint",
	},
	cancelled: {
		kind: 'reserve',
		group: 'neither',
		label: 'Cancelled',
		description: 'stopped on purpose before it finished',
	},
};
