/**
 * Runs GitHub's UNFILTERED runs listing shows waiting, as runner-health last
 * read them, so the dispatcher can serve a run its own `?status=` listing
 * omits.
 *
 * WHY THIS EXISTS
 * ---------------
 * The dispatcher discovers work from `/actions/runs?status=queued` (and
 * `status=pending`). GitHub's status FILTER can leave out a run whose own
 * `status` is `queued`, and keep leaving it out for hours. Three measured
 * cases, each with zero dispatch-decision rows for any of its jobs while
 * runner-health's unfiltered `/actions/runs?per_page=30` listing reported it
 * `QUEUED` the whole time, and queue-health (the same two filtered listings,
 * read separately by `gh api`) reported `waiting=0`:
 *
 *   - hadoku-rally 41449963520 `update`, 2026-11-02: queued 31,652 s;
 *   - hadoku-task 41694912563, four jobs, 2026-11-03: queued 15,442-16,738 s;
 *   - hadoku-tenhands 42971351168 `drain the board`, 2026-11-11: created
 *     06:17:09Z, started 17:37:22Z.
 *
 * Each was served only by ACCIDENT: a JIT runner minted for a later job with
 * the same labels came online and GitHub handed it the older job first.
 *
 * WHAT IT COSTS
 * -------------
 * Nothing on GitHub: runner-health already pays for the unfiltered listing
 * every tick and this only keeps what it read. A run seen here and absent from
 * the filtered listing costs the dispatcher one jobs probe, the call every
 * candidate gets. A run the probe shows nothing waiting for is forgotten until
 * runner-health lists it waiting again, so a run that started since that read
 * is probed once, not every tick.
 *
 * In memory only. A restart forgets it until the next runner-health tick,
 * which is at most one tick of the latency this file removes, never a mint.
 */

/**
 * A run as a runs listing serves it — the fields this file reads. Declared
 * here, not imported from `queue-discovery.ts` (the domain layer above this
 * one); the dispatcher's `QueuedRun` is the same shape and accepts it. The
 * objects are kept whole, so every other field the listing carried is still
 * on them.
 */
export interface ListedRun {
	id: number;
	status?: string;
	created_at?: string;
	run_started_at?: string;
}

/**
 * How long one runner-health read stands. Two of its 10-minute ticks plus
 * margin: a single unreadable tick must not drop a run the filter is hiding,
 * and a read older than this says nothing about now.
 */
export const UNFILTERED_FRESH_MS = 25 * 60_000;

/** The statuses a run waits in. Anything else already has its runner, or is done. */
const WAITING = new Set(['queued', 'pending']);

const byRepo = new Map<string, { atMs: number; runs: ListedRun[] }>();

/**
 * runner-health's unfiltered listing for `repo`, as read at `atMs`. Replaces
 * the repo's previous read whole: a run absent now is no longer waiting.
 */
export function noteUnfilteredListing(
	repo: string,
	runs: readonly ListedRun[],
	atMs: number
): void {
	byRepo.set(repo, {
		atMs,
		// The run objects WHOLE, as the filtered listing would have served them:
		// fork safety reads `event`, `repository` and `head_repository` off them.
		runs: runs.filter((r) => typeof r.status === 'string' && WAITING.has(r.status)),
	});
}

/**
 * The runs of `repo` the unfiltered listing showed in `status` that the
 * filtered listing just read (`listed`) does not contain, and how old that
 * unfiltered read is. Empty when the read is missing or stale.
 */
export function omittedByFilter(
	repo: string,
	status: 'queued' | 'pending',
	listed: readonly ListedRun[],
	nowMs: number
): { runs: ListedRun[]; readAgoMs: number } {
	const read = byRepo.get(repo);
	if (!read || nowMs - read.atMs > UNFILTERED_FRESH_MS) return { runs: [], readAgoMs: 0 };
	const seen = new Set(listed.map((r) => r.id));
	return {
		runs: read.runs.filter((r) => r.status === status && !seen.has(r.id)),
		readAgoMs: Math.max(0, nowMs - read.atMs),
	};
}

/**
 * Drop one run: its jobs probe found nothing waiting, so the unfiltered read
 * that named it is out of date. It comes back with the next read that lists it
 * waiting.
 */
export function forgetUnfiltered(repo: string, runId: number): void {
	const read = byRepo.get(repo);
	if (read) read.runs = read.runs.filter((r) => r.id !== runId);
}

/**
 * `repo#runId` of the omitted runs the dispatcher has already said in its log,
 * so it says each once. The dispatcher prunes it to the runs still omitted.
 */
export const announcedOmitted = new Set<string>();

/** Test seam. */
export function __resetUnfilteredQueueForTesting(): void {
	byRepo.clear();
	announcedOmitted.clear();
}
