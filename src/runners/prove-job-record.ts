/**
 * The result-to-record half of `prove-job.ts` (wave 5o lane D split, pure
 * move): is a `proveJob` result conclusive about the node at all, and — when
 * it is — turning it into the registry's `$proof` record. See `prove-job.ts`
 * for the orchestration that produces the result these read.
 */
import type { Capability } from '../lib/capability-registry.js';
import { judgeWorkloadProof, proofBudget } from '../lib/workload-gate.js';
import type { ProofRecord } from '../lib/measured.js';
import type { ProofResult } from './prove-job-types.js';

/**
 * Did this canary run say anything about the NODE? Only a job that ran on the
 * target does: it passed, failed, or was still running when the bound ran out.
 * Everything else is "could not look" — the job went to another runner
 * (`lost-race`), a read or dispatch failed, the run was aborted, or a green
 * job's log could not be read for evidence — and must never be filed as a
 * verdict on the node.
 *
 * WHY (2026-10-08). The first live `bootcamp --prove` recorded FAIL for claw-4
 * and claw-8, both "the job did not land on the target node": every other
 * `jdk21` listener in the fleet could take the dispatched canary, and did. An
 * explicit FAIL withholds the label even while the gate is dormant, so a
 * dispatch race on the canary pulled `jdk21` off two healthy claws and left
 * cardtable's Forge jobs one node.
 */
export function proofConclusive(
	result: ProofResult
): { conclusive: true; timedOut: boolean } | { conclusive: false; why: string } {
	const lastAttempt = result.attempts[result.attempts.length - 1];
	// A timeout AFTER landing is the node's own result (it ran and did not
	// finish) — the claw-3 shape. `r.ranOnTarget` is only set on completion, so
	// the landing is read from the attempt that landed.
	if (result.verdict === 'timeout' && lastAttempt?.ranOnTarget) {
		return { conclusive: true, timedOut: true };
	}
	if (!result.ranOnTarget || result.jobConclusion === null) {
		const took = result.attempts.map((a) => a.runnerName ?? 'none').join(', ');
		return {
			conclusive: false,
			why:
				result.verdict === 'lost-race'
					? `the job never ran on ${result.node} (taken by: ${took || 'none'}) — says nothing about the node`
					: `the job never completed on ${result.node} (${result.verdict}) — says nothing about the node`,
		};
	}
	if (
		result.jobConclusion === 'success' &&
		result.findings.some((f) => f.rule === 'log-unreadable')
	) {
		return {
			conclusive: false,
			why: `the job went green on ${result.node} but its log could not be read for evidence`,
		};
	}
	return { conclusive: true, timedOut: false };
}

/**
 * Turn a FRESH `proveJob` result into the `$proof` record `measured.ts#writeProof`
 * files — the one place `proveJob`'s raw facts (conclusion, ranOnTarget,
 * evidence, duration) meet the registry's budget judgement (`proofBudget`,
 * `judgeWorkloadProof`). `scripts/prove-job.mjs` is the only writer, and
 * `scripts/bootcamp.mjs --prove` reaches it through that script.
 *
 * Returns `{ inconclusive }` instead of a record when the run said nothing
 * about the node ({@link proofConclusive}); the caller writes nothing then.
 *
 * Only meaningful for a capability whose `jobProof` declares a `budget` — see
 * `workloadGatedCapabilities()`. Callers check that before calling this; it is
 * not re-checked here (`judgeWorkloadProof` already fails loudly when it is
 * missing, rather than silently).
 *
 * `otherNodesProofs` MUST already exclude `result.node` — this is the budget
 * computed from NODES OTHER THAN the one just proven, so a node cannot bootstrap
 * its own bar from a stale reading of itself.
 */
export function buildProofRecord(
	cap: Capability,
	result: ProofResult,
	otherNodesProofs: readonly ProofRecord[],
	opts: { now?: Date } = {}
): { record: ProofRecord } | { inconclusive: string } {
	const c = proofConclusive(result);
	if (!c.conclusive) return { inconclusive: c.why };
	const now = opts.now ?? new Date();
	const budget = proofBudget(cap, otherNodesProofs, now);
	const evidenceMatched = result.evidence.length > 0;
	const judged = judgeWorkloadProof(
		cap,
		{
			conclusion: result.jobConclusion,
			ranOnTarget: true,
			evidenceMatched,
			durationSec: result.durationSec,
			timedOut: c.timedOut,
		},
		budget
	);
	return {
		record: {
			node: result.node,
			capability: cap.id,
			runId: result.runId,
			runner: result.runnerName,
			conclusion: result.jobConclusion,
			durationSec: result.durationSec,
			evidenceMatched,
			budgetSec: budget.budgetSec,
			verdict: judged.verdict,
			why: judged.why,
			at: now.toISOString(),
		},
	};
}
