/**
 * The telemetry-vocabulary SECTION of the `GET /fleet` contract (wave 5r
 * lane A pure move out of `fleet-report-types.ts`): the closed-enum "terms"
 * shape (`TelemetryTerm` and its two refinements) and `FleetVocabulary`
 * itself — the fleet's own words, shipped with the numbers they describe.
 * See that file's own header for why this is a type-only barrel's section
 * rather than a runtime module — `fleet-report-types.ts` re-exports every
 * name below for every existing importer.
 */
import type { ClawState, BackstopReason } from './lib/fleet-vocabulary.js';
import type {
	AdmissionBasis,
	AdmissionCaveat,
	AdmissionClause,
} from './fleet-report-types-machines.js';
import type { CapacityKind } from './fleet-report-types-capacity.js';
import type { GhCaller } from './gh-budget.js';
import type { FleetFailuresByZone, JobPhase } from './fleet-report-types-jobs.js';

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
