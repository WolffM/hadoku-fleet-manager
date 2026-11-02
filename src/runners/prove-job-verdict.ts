/**
 * WAITS FOR THE LANDED JOB AND READS ITS FINAL VERDICT FROM THE API — once
 * `proveJob`'s race has a job running on the target runner, this is what
 * decides `pass`/`fail`/`timeout`/`lost-race` from what GitHub reports,
 * never from silence. Split out of `prove-job.ts` (wave shrink-1 lane B,
 * 800-line ceiling); mutates the caller's `ProofResult` in place exactly as
 * the inline code did, so every path still ends in the caller's own
 * `return finalise(r)`.
 */
import { jobDurationSec, type ProofResult, type JobRow, type RunRow } from './prove-job-types.js';
import { extractEvidence } from './prove-job-parse.js';
import type { ProveSpec, ProveDeps } from './prove-job-types.js';

/** GitHub calls here go through the operator's own `gh` auth, never a token we hold. */
const NO_TOKEN = '';

/**
 * Waits for `landed.job` to complete (polling `read`/`nap` like every other
 * wait in `proveJob`) and fills in `r`'s verdict fields. Returns once `r`
 * is ready for the caller's own `finalise(r)` — every branch below is a
 * point the original inline code also returned from immediately.
 */
export async function awaitLandedVerdict(
	spec: ProveSpec,
	d: ProveDeps,
	r: ProofResult,
	find: (rule: string, message: string) => void,
	read: <T>(what: string, fn: () => Promise<T>) => Promise<T>,
	nap: (ms: number) => Promise<void>,
	jobMs: number,
	landed: { run: RunRow; job: JobRow },
	isTarget: (name: string | null | undefined) => boolean,
	pollMs: number
): Promise<void> {
	const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
	let done: JobRow | null = landed.job;
	for (let t = d.now(); done && done.status !== 'completed' && d.now() - t < jobMs;) {
		await nap(pollMs);
		const res = (await read('jobs listing', () =>
			d.gh.get(`/actions/runs/${landed.run.id}/jobs?per_page=100`, NO_TOKEN, spec.repo)
		)) as { jobs?: JobRow[] } | null;
		done = res?.jobs?.find((j) => j.id === landed.job.id) ?? null;
	}
	if (!done || done.status !== 'completed') {
		r.verdict = 'timeout';
		find(
			'timeout',
			`the job was still ${done?.status ?? 'unreadable'} after ${Math.round(jobMs / 60_000)} minutes`
		);
		return;
	}
	r.jobId = done.id;
	r.jobConclusion = done.conclusion ?? null;
	r.runnerName = done.runner_name ?? null;
	r.durationSec = jobDurationSec(done);
	// Read AGAIN from the final object: what counts is where it finished.
	r.ranOnTarget = isTarget(done.runner_name);
	const last = r.attempts[r.attempts.length - 1];
	last.jobConclusion = r.jobConclusion;
	last.ranOnTarget = r.ranOnTarget;
	if (!r.ranOnTarget) {
		r.verdict = 'lost-race';
		find(
			'lost-race',
			`the job finished on ${done.runner_name ?? 'no runner'}, not a proof runner on ${spec.node}`
		);
		return;
	}

	let logFound = false;
	if (spec.evidence !== undefined) {
		try {
			const log = await read('job log', () =>
				d.gh.text(`/actions/jobs/${done.id}/logs`, NO_TOKEN, spec.repo)
			);
			logFound = true;
			r.evidence = extractEvidence(log, spec.evidence);
		} catch (e) {
			find('log-unreadable', why(e));
		}
	}
	if (r.jobConclusion !== 'success') {
		r.verdict = 'fail';
		find('job-failed', `the job ran on ${spec.node} and concluded "${r.jobConclusion}"`);
	} else if (spec.evidence !== undefined && !logFound) {
		r.verdict = 'error';
	} else if (spec.evidence !== undefined && !r.evidence.length) {
		r.verdict = 'fail';
		find(
			'no-evidence',
			`the job went green on ${spec.node} but no log line matched /${spec.evidence}/i — a pass with no evidence is not a pass`
		);
	} else r.verdict = 'pass';
}
