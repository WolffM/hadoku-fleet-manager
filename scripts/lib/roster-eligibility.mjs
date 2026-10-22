/**
 * WHY autoInclude does or does not cover a repo — as one named rule.
 *
 * The three conditions used to be three bare `continue`s inside
 * `resolveDesired`. That shape is what made a roster DEPARTURE invisible: a repo
 * stopped matching and simply fell out of the loop, leaving no record that the
 * fleet had ever considered it. The reconciler could not report what it did not
 * know it had stopped looking at, so a coverage gap closed by the repo leaving
 * scope read exactly like a gap that had been fixed:
 *
 *   08-30  29 repos / 87 pairs  missing=9   <- paged, nothing installed
 *   08-31  26 repos / 78 pairs  missing=0   <- "recovered"
 *
 * Returning a REASON rather than a boolean is the whole point. "Not eligible" is
 * not actionable; "last pushed 2026-02-14, outside autoInclude's 180-day window"
 * tells the operator which of the three rules moved and whether that is intended.
 *
 * Pure, and separate from the reconciler, because the reconciler runs `main()`
 * at import and cannot be loaded by a test at all. The expensive answers arrive
 * through `probe` as FUNCTIONS, not values, so the ordering that matters is
 * preserved: `countWorkflows` is one API call and `targetsSelfHostedFleet` is one
 * per workflow file, and only a repo the cheap proxy would DROP ever pays for
 * either.
 */

/**
 * The reason autoInclude would not cover `repo`, or `null` if it would.
 *
 * @param {{nameWithOwner: string, isFork?: boolean, pushedAt?: string}} repo
 * @param {{excludeForks?: boolean, pushedWithinDays?: number, minWorkflows?: number}} ai
 * @param {{countWorkflows: (name: string) => number, targetsSelfHostedFleet: (name: string) => boolean}} probe
 * @param {number} now epoch ms; injected so the window is testable rather than wall-clock
 * @returns {string | null}
 */
export function autoIncludeDrop(repo, ai, probe, now = Date.now()) {
	const name = repo.nameWithOwner;

	if (ai.excludeForks !== false && repo.isFork) {
		return 'is a fork, and autoInclude excludes forks';
	}

	const days = ai.pushedWithinDays ?? 180;
	// AN UNREADABLE TIMESTAMP IS NOT "PUSHED RECENTLY".
	//
	// `Date.parse` of a missing or garbage value is NaN, and every comparison
	// against NaN is false — so `NaN < cutoff` said "inside the window" and a repo
	// whose date nobody could read stayed eligible on the strength of a field that
	// was never successfully read. That is "I could not look" rendering as
	// "nothing is wrong", in the one place that decides which machines get an
	// 835 MB runner install.
	//
	// It was left that way when this module was extracted (2026-08-31) ON PURPOSE:
	// the extraction existed to make roster departures visible, and moving an
	// eligibility rule inside it would have changed which repos are covered as a
	// side effect of a refactor, silently. That objection is now spent — a repo
	// that leaves the roster is reported as a DEPARTURE carrying this exact
	// reason, so the change announces itself instead of happening quietly. Fixing
	// it needed the guard first; this is the order those two landed in.
	const pushed = Date.parse(repo.pushedAt);
	if (!Number.isFinite(pushed)) {
		return (
			`has no readable pushedAt (${JSON.stringify(repo.pushedAt ?? null)}), so its ` +
			`${days}-day recency cannot be judged. Unknown is not recent.`
		);
	}
	if (pushed < now - days * 86400_000) {
		return `last pushed ${repo.pushedAt.slice(0, 10)}, outside autoInclude's ${days}-day window`;
	}

	const min = ai.minWorkflows ?? 1;
	if (probe.countWorkflows(name) < min && !probe.targetsSelfHostedFleet(name)) {
		return (
			`fewer than autoInclude's ${min} workflows, and no workflow targets ` +
			'the self-hosted fleet'
		);
	}

	return null;
}
