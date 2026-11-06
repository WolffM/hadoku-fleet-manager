/**
 * How long a job may sit on one step before the hung-job check pages.
 *
 * A FIXED ALLOWANCE IS WRONG FOR A JOB THAT IS ONE LONG STEP. The check counts
 * finished steps between ticks, so it cannot see progress INSIDE a step. A test
 * suite that runs as one Playwright invocation is a single step from start to
 * end. hadoku-cardtable's `forge-e2e` shards are one: 1,026 green runs in the
 * 14-day history had p95 56 min and max 75 min. A fixed 25 min paged
 * "stuck … likely pinning a runner" on healthy shards (2026-11-06, run
 * 42248044760, still running tests when the page went out).
 *
 * So the allowance is the job's OWN history: the longest a SUCCESSFUL run of the
 * same repo and job took, end to end. A step cannot take longer than the job
 * that holds it. While a step has sat for less than a green run of this job has
 * already taken, nothing has happened that a healthy run has not also done. Past
 * that point it is evidence of a hang. `floorMin` stays the minimum, so a job
 * that is always fast still pages at 25 min. A job with too few green runs to
 * judge keeps the floor too.
 *
 * The job name is matched with its matrix suffix stripped (`forge-e2e (5)` →
 * `forge-e2e`). Shards of one matrix do the same work, and a shard number that
 * has never run green would otherwise have no history.
 */
import { jobRecords, type JobRecord } from './job-history-store.js';

/** Fewer green runs than this and the history says too little; the floor applies. */
export const MIN_SAMPLES = 5;

/** `forge-e2e (5)` and `test (ubuntu, 3)` → their matrix job's name. */
export function matrixBase(name: string): string {
	return name.replace(/\s*\([^()]*\)$/, '');
}

export interface StepAllowance {
	/** Minutes a job may go without finishing a step. */
	minutes: number;
	/** Green runs the allowance was measured from; 0 when it is the floor. */
	samples: number;
}

export function stepAllowance(
	repo: string,
	jobName: string,
	floorMin: number,
	history: readonly JobRecord[] = jobRecords()
): StepAllowance {
	const base = matrixBase(jobName);
	let longest = 0;
	let samples = 0;
	for (const r of history) {
		if (r.conclusion !== 'success' || r.repo !== repo || matrixBase(r.name) !== base) continue;
		samples++;
		if (r.durationSec > longest) longest = r.durationSec;
	}
	if (samples < MIN_SAMPLES) return { minutes: floorMin, samples: 0 };
	return { minutes: Math.max(floorMin, longest / 60), samples };
}
