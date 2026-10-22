/**
 * reap-trend — is the reap's timeout rate CLIMBING, not just what it is today.
 *
 * WHY A TREND AND NOT A NUMBER
 * ----------------------------
 * `api-budget-outage-2026-09-07.md`: `reapJitRunners`'s per-repo
 * `GET /actions/runners?per_page=100` timed out 866 times in two hours during
 * the outage — 460/hr at the peak, against a steady ~35/hr today after the
 * cadence fix (`REAP_INTERVAL_MS`, `c0717dc`). `FETCH_TIMEOUT_MS` is still 10s
 * against a client pool that has demonstrably saturated once already, and
 * nothing would notice if that trend resumed — that sentence is the whole
 * spec for this gate.
 *
 * A fixed ceiling on the raw count is the wrong shape for two reasons this
 * fleet has already been burned by (CLAUDE.md, "no gate may get EASIER to pass
 * the worse the failure gets" and its corollaries): the fleet's steady state
 * has already moved once (1,620 -> 6,480 calls/hr riding a faster dispatch
 * timer) and could move again for a reason that has nothing to do with health,
 * and a fixed ceiling picked today is either too loose to catch the NEXT
 * outage's early minutes or too tight to survive the next legitimate cadence
 * change. What both outage windows shared, and what a healthy fleet never
 * shows, is the RATE CLIMBING relative to its own recent past.
 *
 * WHAT THIS COMPARES
 * ------------------
 * The mean per-hour timeout rate over the last {@link RECENT_HOURS} against
 * the mean per-hour rate over the {@link BASELINE_HOURS} immediately before
 * that — two adjacent, non-overlapping windows read from the same log, so a
 * step change between them is a property of the fleet, not of when the gate
 * happened to run. {@link MIN_RECENT_PER_HOUR} is a floor UNDER the trend
 * test, not a replacement for it: today's ~35/hr baseline fluctuates on its
 * own, and without a floor a quiet night going from 2/hr to 8/hr would read as
 * a 4x "trend" that means nothing. The floor is set above the documented
 * steady state specifically so ordinary noise around 35/hr cannot trip it,
 * while a real climb toward the 460/hr outage shape crosses it early.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * -----------------------------------
 * It does not read `dispatch-tick.ts`'s `reaped`/`failed` counters — those
 * count REMOVALS and mint failures, a different signal from a timed-out
 * LISTING, and `src/runners/ephemeral*.ts` is D2's file for Wave 1 regardless.
 * This reads the same evidence the outage was diagnosed from: the mgmt-api
 * log line `runner-health.ts`'s shared `ghGet`/`ghGetWithEtag` already write —
 * `[runner-health] GET ${path} failed: ${message}` — which for this endpoint
 * renders as the exact substring `runners?per_page=100 failed` the outage
 * doc's own re-verification recipe grepped for. Reading the log rather than a
 * counter is also why this is a NEW gate rather than a change to a file this
 * lane may not touch.
 */

/** The exact substring the outage doc verified this signature by. */
export const TIMEOUT_PATTERN = /runners\?per_page=100 failed/;

/** `@wolffm/logger/server`'s line prefix: `[<ISO timestamp>] [LEVEL] ...`. */
const TIMESTAMP_RE = /\[(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\]/;

/**
 * Every timestamped line in `text`, tagged with whether it is a reap timeout.
 *
 * Every line carrying the logger's bracket — not just matches — so the caller
 * can tell "read a quiet window" from "read nothing", which is the difference
 * between a healthy fleet and a log this gate could not actually see.
 */
export function parseLogLines(text) {
	const out = [];
	for (const line of text.split('\n')) {
		const m = TIMESTAMP_RE.exec(line);
		if (!m) continue;
		const ms = Date.parse(m[1]);
		if (Number.isNaN(ms)) continue;
		out.push({ ms, isTimeout: TIMEOUT_PATTERN.test(line) });
	}
	return out;
}

/** The window judged for a rising trend. */
export const RECENT_HOURS = 1;
/** The window it is compared against, immediately before the recent one. */
export const BASELINE_HOURS = 3;
/** How many times over baseline counts as "rising". */
export const RISE_FACTOR = 3;
/**
 * Floor under the trend test, ABOVE today's documented ~35/hr steady state —
 * see the module docblock. Below this, "rising" is noise, not a finding.
 */
export const MIN_RECENT_PER_HOUR = 60;
/** Total log history required before a verdict is trusted at all. */
export const MIN_COVERAGE_MS = (RECENT_HOURS + BASELINE_HOURS) * 3_600_000;

/**
 * The verdict, from parsed log entries.
 *
 * `{ ok: false, error }` (no `findings`) is "I could not look" — an empty log,
 * or one that does not reach back far enough to compare two windows. Never
 * treated as a pass: a log that was too short to judge is not a fleet with no
 * timeouts, whichever produced the emptiness.
 */
export function reapTrendVerdict(entries, { nowMs = Date.now() } = {}) {
	if (!entries.length) {
		return {
			ok: false,
			error:
				'no parseable mgmt-api log lines were read — could not look, which is never ' +
				'the same as a clean fleet.',
		};
	}
	const oldestMs = Math.min(...entries.map((e) => e.ms));
	const coverageMs = nowMs - oldestMs;
	if (coverageMs < MIN_COVERAGE_MS) {
		return {
			ok: false,
			error:
				`only ${(coverageMs / 3_600_000).toFixed(1)}h of mgmt-api log was available, need ` +
				`${(MIN_COVERAGE_MS / 3_600_000).toFixed(0)}h to compare a recent window against a ` +
				'baseline — read more lines, or wait for the log to accumulate.',
			coverageHours: coverageMs / 3_600_000,
		};
	}

	const recentStartMs = nowMs - RECENT_HOURS * 3_600_000;
	const baselineStartMs = recentStartMs - BASELINE_HOURS * 3_600_000;
	const recentCount = entries.filter(
		(e) => e.isTimeout && e.ms >= recentStartMs && e.ms <= nowMs
	).length;
	const baselineCount = entries.filter(
		(e) => e.isTimeout && e.ms >= baselineStartMs && e.ms < recentStartMs
	).length;
	const recentPerHour = recentCount / RECENT_HOURS;
	const baselinePerHour = baselineCount / BASELINE_HOURS;

	const rising =
		recentPerHour >= MIN_RECENT_PER_HOUR && recentPerHour >= baselinePerHour * RISE_FACTOR;

	const findings = [];
	if (rising) {
		findings.push(
			`reap timeouts are RISING: ${recentPerHour.toFixed(0)}/hr over the last ${RECENT_HOURS}h ` +
				`vs ${baselinePerHour.toFixed(1)}/hr over the ${BASELINE_HOURS}h before that — over ` +
				`${RISE_FACTOR}x and past the ${MIN_RECENT_PER_HOUR}/hr floor. The 2026-09-06/07 ` +
				'outage looked exactly like this on its way to 460/hr; nothing else about the fleet ' +
				'needs to look wrong for this to be the leading edge of the same failure.'
		);
	}

	return {
		ok: findings.length === 0,
		findings,
		recentPerHour,
		baselinePerHour,
		coverageHours: coverageMs / 3_600_000,
	};
}
