/**
 * The per-tick tally for `ci-alerts.ts`, split out (wave 5r lane C, pure
 * move) to bring that file under the 800-line ceiling. Every name here
 * stays re-exported from `ci-alerts.ts`, so no importer elsewhere needed to
 * change.
 */
import { logger } from './host.js';

/**
 * What one tick did, counted rather than inferred.
 *
 * The tally exists because #32 was invisible: a target that is polled and says
 * nothing and a target that is never polled at all produced byte-identical
 * output — none. Every way of looking away has its own counter here, and the
 * summary prints all of them, so "quiet" can be told apart from "blind" from
 * the log alone.
 */
export interface CiTickSummary {
	/** Watch-list size. Zero is a FINDING, not a quiet fleet. */
	targets: number;
	/** ghGet returned null: a timeout, a non-2xx, or the rate-limit blackout. */
	unreadable: number;
	/**
	 * Polled fine, but no completed run of the workflow is in the window and
	 * there is no record of one — a workflow that has never run, as far as this
	 * alerter knows.
	 */
	noRuns: number;
	/**
	 * Completed runs of a watched workflow skipped because they came from a fork
	 * (`isForeignRun`). Counted so a public repo's quiet is legible.
	 */
	foreign: number;
	/**
	 * Completed runs of a watched workflow skipped because they ran on a branch
	 * other than the repo's default (`isOffDefaultBranch`).
	 */
	offBranch: number;
	/**
	 * Repos whose default branch could not be read this tick, so their targets
	 * judged every branch's runs, as they did before #61.
	 */
	branchUnread: number;
	/** Polled fine, and nothing has concluded since the last tick. */
	nothingNew: number;
	/** Runs actually put through the state machine. */
	evaluated: number;
	broken: number;
	recovered: number;
	/** A real transition that a guard held back. Counted by reason below. */
	suppressed: number;
	/** cancelled / skipped — no signal either way. */
	ignored: number;
	/** The target threw. */
	errors: number;
	/** `CiDecision.reason` -> how many times, so a silence is diagnosable. */
	reasons: Record<string, number>;
}

export function emptySummary(targets: number): CiTickSummary {
	return {
		targets,
		unreadable: 0,
		noRuns: 0,
		foreign: 0,
		offBranch: 0,
		branchUnread: 0,
		nothingNew: 0,
		evaluated: 0,
		broken: 0,
		recovered: 0,
		suppressed: 0,
		ignored: 0,
		errors: 0,
		reasons: {},
	};
}

/**
 * The one line per tick that makes silence legible.
 *
 * It prints the zeroes. A summary that omitted `unreadable 0` would make a tick
 * that could not look indistinguishable from one that looked and found nothing
 * — which is the whole bug, restated one level up.
 */
export function formatCiTickSummary(s: CiTickSummary): string {
	const reasons = Object.entries(s.reasons)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([reason, n]) => `${reason} x${n}`)
		.join('; ');
	return (
		`[ci-alerts] polled ${s.targets} targets, evaluated ${s.evaluated} runs, ` +
		`announced ${s.broken + s.recovered} (broken ${s.broken}, recovered ${s.recovered}), ` +
		`suppressed ${s.suppressed}${reasons ? ` (${reasons})` : ''}, ignored ${s.ignored}, ` +
		`nothing-new ${s.nothingNew}, no-runs ${s.noRuns}, fork-runs ${s.foreign}, ` +
		`off-branch-runs ${s.offBranch}, branch-unread ${s.branchUnread}, ` +
		`unreadable ${s.unreadable}, ` +
		`errors ${s.errors}`
	);
}

/** A tick that could not look anywhere is a finding, and says so at WARN. */
export function logCiTickSummary(s: CiTickSummary): void {
	// branch-unread is not blind (every run was still judged) but it is a
	// degraded pass, and WARN is where a degraded pass is looked for.
	const blind = s.targets === 0 || s.unreadable > 0 || s.errors > 0 || s.branchUnread > 0;
	const line = formatCiTickSummary(s);
	if (blind) logger.warn(line);
	else logger.info(line);
}
