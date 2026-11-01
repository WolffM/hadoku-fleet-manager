/**
 * The backstop's queue-pressure probe — split out of `backstop-decision.ts`
 * (wave 5r lane C, pure move) to bring that file under the 800-line
 * ceiling. `QUEUE_ZOMBIE_SECONDS`, `QueuePressure` and `probeQueuePressure`
 * stay re-exported from there, so no importer elsewhere needed to change.
 */
import { ghGet } from '../lib/github-client.js';
import { SATURATION_QUEUE_SECONDS } from './backstop.js';
import { ZOMBIE_MS } from './queue-discovery.js';

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
	 * Age of the oldest queued run INSIDE the band, seconds. This is the only
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
 * Age of the oldest run that cannot start at all, in seconds.
 *
 * RUN level here, deliberately. The justification this comment used to give —
 * "only ever called when `clawsFree === 0`, and with no free runner anywhere a
 * newly-arrived run cannot start ANY of its jobs" — stopped being true on
 * 2026-09-24, when the caller began probing whenever the fleet is UP (#63). It
 * is recorded rather than deleted because the conclusion survives the premise:
 * only the MAXIMUM is returned and only `>= SATURATION_QUEUE_SECONDS` moves the
 * decision, so a run sitting queued for the seconds GitHub takes to place it is
 * under the bar with or without a free claw, and a run still queued past the
 * fleet's measured p90 is STUCK either way — that is precisely the 2026-09-01
 * shape, where `clawsFree` never hit zero and 13 jobs waited 11-19 minutes.
 * (Job-level queue time is the right measure for the DISTRIBUTION, which is why
 * `JobRecord.queueSec` records it; it is not needed to answer "is anything
 * stuck right now".)
 *
 * IT IS NO LONGER FREE ON A HEALTHY FLEET in the worst case. `ghGet` revalidates
 * with an ETag, so an unchanged queue answers 304 for nothing, but a repo whose
 * queue moved between ticks is charged, and the ceiling is sized as if every
 * listing were; the per-hour arithmetic is stated at the call site and asserted by
 * `the queue probe stays inside the hourly API budget at fleet size`. It exits
 * at the first run over the threshold, so "yes, there is pressure" is one API
 * call and the quiet answer is one per repo — and the quiet answer is now the
 * common one, which is the direction that costs.
 *
 * THE ZOMBIE WAS ALSO HIDING THE SPEND. With a permanently-over-threshold run in
 * the first repo swept, this broke after ONE listing on every tick from
 * 2026-09-25 to 09-28 — so the measured cost was ~6 calls/hr and the arithmetic
 * at the call site described a path nothing took. Excluding it restores the
 * worst case the budget test has always asserted: 26 listings x 6 ticks/hr =
 * 156/hr, 3.1% of a 5,000/hr budget. The spend goes UP by design, and it is the
 * number that was already under test.
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
	for (const repo of repos) {
		const resp = await ghGet<{
			workflow_runs?: { created_at?: string; run_started_at?: string }[];
		}>('/actions/runs?status=queued&per_page=20', token, repo);
		for (const run of resp?.workflow_runs ?? []) {
			// THIS ATTEMPT'S CLOCK, like every other age in this file.
			//
			// `created_at` pins to the ORIGINAL run and GitHub never moves it, so on
			// a re-run the two diverge by the whole gap between attempts. That is
			// the bug `GhRun.run_started_at` was added for on 2026-09-10, when a
			// re-run of a 2h-old hadoku-tenhands run alerted as "QUEUED 122m" while
			// its jobs started four seconds later — and this function was still
			// reading the field that mistake was about. A re-run of anything old
			// therefore read as hours of queue pressure the instant it was
			// requeued, which is enough on its own to promote the production host.
			// Both fields are absent on runs old enough to predate `run_started_at`,
			// hence the fallback.
			const started = Date.parse(run.run_started_at ?? run.created_at ?? '');
			if (!Number.isFinite(started)) continue;
			const age = Math.max(0, Math.round((nowMs - started) / 1000));
			if (age > zombieSec) {
				zombies++;
				if (age > oldestZombieSec) oldestZombieSec = age;
				continue;
			}
			if (age > pressureSec) pressureSec = age;
		}
		if (pressureSec >= SATURATION_QUEUE_SECONDS) break;
	}
	return { pressureSec, zombies, oldestZombieSec };
}
