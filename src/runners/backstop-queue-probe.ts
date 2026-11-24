/**
 * The backstop's queue-pressure probe — split out of `backstop-decision.ts`
 * (wave 5r lane C, pure move) to bring that file under the 800-line
 * ceiling. `QUEUE_ZOMBIE_SECONDS`, `QueuePressure` and `probeQueuePressure`
 * stay re-exported from there, so no importer elsewhere needed to change.
 */
import { ghGet } from '../lib/github-client.js';
import { SATURATION_QUEUE_SECONDS } from './backstop.js';
import { jobQueuedSinceMs, runnableJobs, ZOMBIE_MS, type QueuedJob } from './queue-discovery.js';

/**
 * Past this, a queued run is a ZOMBIE and is NOT queue pressure.
 *
 * ONE BOUNDARY, ONE NAME — imported from the dispatcher rather than restated,
 * for the reason `queue-discovery.ts` gives beside it: two copies of this number
 * means a run the dispatcher will never mint for is one this probe still reads
 * as work waiting for capacity. `zombie-boundary-guard.test.mjs` already pins
 * `ZOMBIE_MS` against `queue-health.mjs`'s `ZOMBIE_SECONDS`; importing puts this
 * third reader inside that guard instead of beside it.
 *
 * WHY THE BACKSTOP NEEDED IT AND DID NOT HAVE IT. The two runs the dispatcher's
 * band was written for — hadoku-tenhands 32072350405 (2026-08-17T21:40:51Z) and
 * hadoku_site 32218726912 (2026-08-19T05:15:08Z) — are permanently `queued` and
 * cannot be cancelled, force-cancelled or deleted; `dispatch-tick.ts` records
 * the three refusals and why. They were harmless here while the probe was gated
 * on `isAtCapacity(...)`, which under all-JIT is never true, so this function
 * effectively never ran. `2383b18` (#63) made it run every tick — and on the
 * first tick after that deploy it returned **3.5 million seconds**, 35,000x the
 * 100s threshold, and `reason=saturation` has been true on essentially every
 * tick since. Measured in the deployed tree: ZERO `BACKSTOP` lines in
 * `mgmt-api-out` for 2026-09-22..24, then 37 on 09-25, 111 on 09-26, 149 on
 * 09-27 and 116 by 21:00Z on 09-28, every one of them `reason=saturation
 * queue=~3,510,000s` against a fleet reporting `claws=12/12 online free=27`.
 * That is the #56 regression: hokon was not catching overflow, it was carrying
 * `hadoku-builder` permanently and winning GitHub's assignment race with a
 * standing registration (builder queue p50 2s against the claws' 4s).
 *
 * THE FAILURE THIS EXCLUSION DOES *NOT* MANUFACTURE. CLAUDE.md's rule is that no
 * gate may get easier to pass the worse the failure gets, and that if you
 * exclude a category you must check what happens when a real failure MAKES that
 * category. `queue-health`'s p95 broke exactly that way: every casualty of a
 * long stall eventually crossed the one-hour ceiling and LEFT the percentile, so
 * a two-hour outage read greener than a twenty-minute one. A MAXIMUM over a
 * sliding age band does not have that shape. A saturation lasting longer than
 * the band means runs are still arriving and still not being served, so the band
 * is full of recent ones and the maximum inside it stays far over 100s; the only
 * way the band empties is that nothing has queued for a whole day, which is a
 * genuinely idle fleet. The passage of time cannot move a run out of the band
 * without newer runs moving in behind it — unless the queue really did drain.
 *
 * AND THEY ARE COUNTED, NOT DISCARDED. "I deliberately did not act on this" is
 * not "there was nothing there": the count and the oldest age ride out on
 * `QueuePressure` and reach both the snapshot and the log.
 */
export const QUEUE_ZOMBIE_SECONDS = ZOMBIE_MS / 1000;

/** What the queue probe saw, split into what it acted on and what it refused. */
export interface QueuePressure {
	/**
	 * Age of the oldest JOB waiting for a runner, among runs INSIDE the band,
	 * seconds (the run's own age where its jobs could not be read). This is the only
	 * field the backstop decision reads.
	 */
	pressureSec: number;
	/**
	 * Queued runs excluded by age — SEEN, and deliberately not acted on.
	 *
	 * Understated when `pressureSec` already crossed the threshold, because the
	 * loop stops looking at that point. It is a diagnostic, never an input to a
	 * decision, so a partial count costs nothing; the alternative is paying the
	 * full 26-repo sweep on a fleet already known to be backed up.
	 */
	zombies: number;
	/** The oldest of them, seconds, so the log can name what it refused. */
	oldestZombieSec: number;
}

/**
 * Most per-run jobs reads one probe may spend. Past it, a run is aged by its
 * own clock, the pre-2026-11-24 answer, which can only overstate.
 */
export const PROBE_JOB_READS_MAX = 10;

/**
 * Age of the oldest JOB waiting for a runner, in seconds.
 *
 * JOB level since 2026-11-24 (operator-approved). The run's clock overstates
 * the wait on any multi-stage run: a run whose first wave finished and whose
 * `deploy` was just created stays `queued` from the attempt's start, so a
 * 20-minute build followed by a fresh job read as 20 minutes of queue. Replayed
 * over job-history against every probed BACKSTOP line from 11-21 to 11-24
 * (665 ticks), the run clock read an hour or more on 99 of them and the jobs
 * themselves on 35. The 100 s promote line barely moved: 415 ticks over it on
 * the run clock, 427 on the job clock. The probe's early exit had hidden
 * job-level waits behind a first repo that was just over the line. So this
 * mostly makes the number honest; it is not a quieter backstop.
 *
 * A job's wait is {@link jobQueuedSinceMs}: its own `created_at`, bounded below
 * by the attempt's start, so it is never older than its run. That bound is what
 * keeps the extra reads cheap. Runs are read oldest first, and once a run is no
 * older than the worst job already found, no job inside it can be, so the rest
 * are skipped. A queued run with no job waiting for a runner (held by
 * `concurrency`, an environment approval, or between waves) contributes 0;
 * {@link runnableJobs} is the dispatcher's own definition of waiting.
 *
 * "I could not look" stays loud. A jobs read that fails, a run with no id, or a
 * read past {@link PROBE_JOB_READS_MAX} falls back to the run's age: the old
 * answer, an overstatement, never a zero.
 *
 * BUDGET, sized as if every read were charged. The listing ceiling is unchanged
 * (26 repos x 6 ticks/hr = 156/hr, asserted in `runner-health-backstop.test.ts`).
 * The jobs reads add at most {@link PROBE_JOB_READS_MAX} per tick, 60/hr, for
 * 216/hr worst case: 4.3% of a 5,000/hr budget. On a quiet fleet there are no
 * in-band queued runs and they cost nothing. The loop still exits at the first
 * job over the threshold, so a backed-up fleet costs less, not more.
 *
 * Zombies are still decided on the RUN's age: a run queued past the band is
 * stuck whatever its jobs say, and reading its jobs would spend calls on a run
 * the backstop deliberately refuses.
 *
 * THE ZOMBIE WAS ALSO HIDING THE SPEND. With a permanently-over-threshold run in
 * the first repo swept, this broke after ONE listing on every tick from
 * 2026-09-25 to 09-28, so the measured cost was ~6 calls/hr and the arithmetic
 * at the call site described a path nothing took.
 */
export async function probeQueuePressure(
	token: string,
	repos: string[],
	nowMs: number,
	zombieSec: number = QUEUE_ZOMBIE_SECONDS
): Promise<QueuePressure> {
	let pressureSec = 0;
	let zombies = 0;
	let oldestZombieSec = 0;
	let jobReads = 0;
	const ageOf = (sinceMs: number) => Math.max(0, Math.round((nowMs - sinceMs) / 1000));
	for (const repo of repos) {
		const resp = await ghGet<{
			workflow_runs?: { id?: number; created_at?: string; run_started_at?: string }[];
		}>('/actions/runs?status=queued&per_page=20', token, repo);
		const inBand: {
			id?: number;
			run: { created_at?: string; run_started_at?: string };
			age: number;
		}[] = [];
		for (const run of resp?.workflow_runs ?? []) {
			// THIS ATTEMPT'S CLOCK. `created_at` pins to the ORIGINAL run and
			// GitHub never moves it, so a re-run of a 2h-old run read as "QUEUED
			// 122m" while its jobs started four seconds later (2026-09-10). Both
			// fields are absent on runs old enough to predate `run_started_at`,
			// hence the fallback.
			const started = Date.parse(run.run_started_at ?? run.created_at ?? '');
			if (!Number.isFinite(started)) continue;
			const age = ageOf(started);
			if (age > zombieSec) {
				zombies++;
				if (age > oldestZombieSec) oldestZombieSec = age;
				continue;
			}
			inBand.push({ id: run.id, run, age });
		}
		inBand.sort((a, b) => b.age - a.age);
		for (const { id, run, age } of inBand) {
			if (age <= pressureSec) break;
			let waited = age;
			if (id !== undefined && jobReads < PROBE_JOB_READS_MAX) {
				jobReads++;
				const jobs = await ghGet<{ jobs?: QueuedJob[] }>(
					`/actions/runs/${id}/jobs?per_page=100`,
					token,
					repo
				);
				if (jobs) {
					waited = 0;
					for (const job of runnableJobs(jobs.jobs ?? [])) {
						const since = jobQueuedSinceMs(run, job.created_at);
						if (since !== undefined) waited = Math.max(waited, Math.min(age, ageOf(since)));
					}
				}
			}
			if (waited > pressureSec) pressureSec = waited;
			if (pressureSec >= SATURATION_QUEUE_SECONDS) break;
		}
		if (pressureSec >= SATURATION_QUEUE_SECONDS) break;
	}
	return { pressureSec, zombies, oldestZombieSec };
}
