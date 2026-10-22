/**
 * The execution-log job names a workflow reports under, parsed from its own
 * `report-job` steps.
 *
 * WHY THIS EXISTS. Two alerters watch GitHub Actions from opposite ends:
 * monitoring-api's `job-alerts` (push — every workflow running
 * hadoku-actions/report-job posts its outcome) and fleet-manager's `ci-alerts`
 * (poll — the ci-watch targets). When ci-alerts took over on 2026-09-08,
 * job-alerts was told to skip every row whose `run_id` starts with `gha_`.
 * That is EVERY self-reporting workflow — 86 of them — while ci-alerts watches
 * 62. The other 30 alerted nobody, and it showed the same day: sixteen child
 * `update-wolffm` jobs and two `site:jit-canary` runs failed in silence.
 *
 * A `gha_` prefix cannot express "the ones fleet-manager took over". A job-name
 * list can, and deriving it from the same workflow files the watch list comes
 * from means the handoff boundary cannot drift from the watch list.
 */

/** Pure parser, so the rules below are testable without a checkout. */
export function jobNamesIn(text) {
	const names = [];
	for (const line of String(text).split('\n')) {
		const m = /^\s*job-name:\s*(\S.*?)\s*$/.exec(line);
		if (!m) continue;
		const raw = m[1].replace(/^['"]|['"]$/g, '');
		// Templated names (`site:deploy-worker:${{ matrix.name }}`) cannot be
		// matched literally at alert time, so they are NOT claimed as covered —
		// the consumer must keep alerting on them rather than skip a name it can
		// never match.
		if (raw.includes('${{')) continue;
		names.push(raw);
	}
	return names;
}
