/**
 * The fleet's shared read-retry policy — a declarative attempt count and a
 * pure formatter for why one attempt failed, split out of `queue-health.mjs`
 * (wave clean-1 lane D, cut (iii) layer debt) so a config/access-layer reader
 * can use the policy without reaching into queue-health's own
 * observation-domain verdict arithmetic (`FAIL_SECONDS`, `readQueuedWithRetry`
 * and friends), which stays there. `queue-health.mjs` re-exports both names
 * unchanged for every existing importer (`runner-var.mjs` among them).
 */

/**
 * Attempts per repo before a read is called a failure.
 *
 * ONE RETRY, because the failure this gate actually produces is a coin-flip, not
 * a fault. Measured 2026-09-07 over the previous day: five `could not read`
 * findings against ~3,900 calls — 27 repos every 10 minutes — about 0.13%, a
 * different repo each time, every one recovering on the next run untouched.
 *
 * The evidence that it is transient rather than a broken repo: all five repos
 * answer in ~0.45s against a 20s timeout, none is archived or renamed, 216
 * consecutive hand-run calls produced zero failures, and 80 latency probes over
 * the same path gave p50 0.344s / max 0.430s with no outliers.
 *
 * A single blip in one repo out of 27 was paging @here. Retried once, the same
 * rate becomes roughly one finding every 150 days.
 *
 * THIS DOES NOT SOFTEN THE RULE. A repo that fails every attempt is still
 * unreadable and still fails the gate. What changes is that we look twice before
 * saying so, and that we say WHY.
 */
export const READ_ATTEMPTS = 2;

/**
 * Why one read attempt failed, in a form an operator can act on.
 *
 * The caller was a bare `catch { return null }` until 2026-09-07, so a finding
 * could name the repo and nothing else. Reporting that we could not look is
 * necessary; reporting it undiagnosably is only half the rule — a rate limit, a
 * timeout and a deleted repo are three different jobs.
 *
 * Pure over an error-LIKE object so it can be asserted without spawning
 * anything: `execFileSync` sets `killed`/`signal` on a timeout and
 * `status`/`stderr` on a non-zero exit.
 */
export function describeReadFailure(err, timeoutMs) {
	if (err?.killed || err?.signal) {
		const secs = Number.isFinite(timeoutMs) ? `${timeoutMs / 1000}s` : 'the timeout';
		return `timed out after ${secs} (${err.signal ?? 'killed'})`;
	}
	const stderr = String(err?.stderr ?? '')
		.trim()
		.replace(/\s+/g, ' ')
		.slice(0, 200);
	const code = err?.status ?? '?';
	return stderr ? `exit ${code}: ${stderr}` : `exit ${code}: ${err?.message ?? 'unknown error'}`;
}
