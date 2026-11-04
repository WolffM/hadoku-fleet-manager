import {
	CAPABILITIES,
	capability,
	type Capability,
	type ManifestNode,
} from './capability-registry.js';
import { provenCapabilities } from './bootcamp-proof.js';

/**
 * One (node, capability) workload-proof result.
 *
 * Lives here, not in `measured.ts`, even though `measured.ts` is what reads
 * and writes it: this is config's own edge into the state layer (wave
 * clean-1 lane C, cut (iii)), fixed by moving the plain data shape down to
 * the layer that needs it rather than importing it up. Every caller imports
 * it from here directly; `measured.ts` no longer re-exports it.
 */
export interface ProofRecord {
	node: string;
	capability: string;
	runId: number | null;
	runner: string | null;
	conclusion: string | null;
	durationSec: number | null;
	evidenceMatched: boolean;
	budgetSec: number | null;
	verdict: 'pass' | 'fail' | 'stale';
	why: string;
	at: string;
}
// Re-exported too: `capability-offer.ts` needs the type as well.

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
 * How recent a peer's pass must be to set a BUDGET, as opposed to counting as
 * PROVEN ({@link WORKLOAD_PROOF_DUE_DAYS}). A budget compares durations, which
 * is only meaningful against the same suite, and a workload's suite grows: on
 * 2026-11-03 claw-10's forge-e2e was judged against passes from 2026-10-08 and
 * failed 6.9 min vs 5.0, while the fastest claw ran the same specs on the same
 * commit only 1.1-1.5x faster. A week keeps peers close to the suite being
 * judged. With fewer comparable peers than `minProven` the budget is
 * unbootstrapped, and the proof is judged on what can still be judged: green,
 * on the node, with evidence.
 */
export const WORKLOAD_BUDGET_PEER_DAYS = 7;

/**
 * The duration budget for a capability's workload proof, derived from the
 * durations of RECENT passing proofs on OTHER nodes
 * ({@link WORKLOAD_BUDGET_PEER_DAYS}; not the whole freshness window).
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
		.filter((r) => (now.getTime() - Date.parse(r.at)) / 86_400_000 <= WORKLOAD_BUDGET_PEER_DAYS)
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
