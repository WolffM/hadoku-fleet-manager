import { logger } from '../host.js';

/**
 * Nodes the guard has reported as having damaged their own pnpm store.
 *
 * SICKNESS OVERRIDES EVERY OTHER ELIGIBILITY INPUT, `alwaysOn` INCLUDED. The
 * fast loop recomputes eligibility from free capacity on every tick, so simply
 * stripping the label elsewhere would be undone within one tick — tier1 is
 * `alwaysOn` and would be re-promoted immediately. Quarantine therefore has to
 * be an INPUT to this decision rather than a competing write to the same label,
 * which is also why it lives in this module: eligibility has one owner.
 *
 * Deliberately NO capacity floor. If every claw damages its store, every claw is
 * retired and `CI_RUNNER` flips the fleet to GitHub-hosted — which is the
 * existing, tested answer to "no self-hosted capacity". Keeping a known-bad
 * node eligible to preserve a number would hand jobs to the one box we have
 * positive evidence against.
 */
export const sickNodes = new Map<string, { repairAttempts: number }>();

/**
 * Clear quarantine state. Test-only seam.
 *
 * `sickNodes` is module-level and therefore LEAKS between tests: a test that
 * marks claw-1 sick makes every later test in the file see it as sick, and
 * `setTierEligibility` then silently declines to promote it. That cost a real
 * debugging round — a correct regression guard failed because a test three
 * hundred lines earlier had poisoned the node it used. runner-health.ts
 * already documents this exact hazard for its own cross-tick maps; this module
 * had the same one with no way to reset it.
 */
export function __resetSickForTesting(): void {
	sickNodes.clear();
}

export function markNodeSick(node: string): void {
	if (!sickNodes.has(node)) {
		sickNodes.set(node, { repairAttempts: 0 });
		logger.warn(`[fleet-loop] QUARANTINE ${node} — its pnpm store was damaged; demoting it`);
	}
}

export function nodeIsSick(node: string): boolean {
	return sickNodes.has(node);
}

export function sickNodeNames(): string[] {
	return [...sickNodes.keys()].sort();
}
