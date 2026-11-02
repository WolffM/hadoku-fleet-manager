/**
 * THE PASS'S PLACEMENT ORDER — oldest first, with a head start by event
 * kind. Pure: no I/O, no module state. Split out of `dispatch-pass.ts`
 * (wave shrink-1 lane B, 800-line ceiling); `dispatch-pass.ts` re-exports
 * both names here under their original path.
 */
import type { PendingRun } from './dispatcher.js';

/**
 * How far ahead of the queue each event band starts, in milliseconds of age.
 *
 * A HEAD START, NOT A LANE. A push still goes first among jobs that arrived
 * within a few minutes of it — the 2026-10-09 case below — but a job that has
 * waited longer than its band's head start outranks every push that arrived
 * after that. Until 2026-10-25 the bands were strict, and a strict lane starves
 * the lower one for as long as the upper one keeps arriving: that morning a
 * package fan-out queued 57 `repository_dispatch` auto-update runs, every one
 * of which pushes a commit, so pushes never ran out. hadoku-study run
 * 40165607402 (queued 05:27:37Z) and hadoku-resume-bot 40165520825 (05:26:07Z)
 * waited 47 minutes; between 05:27:37 and their mints at 06:12–06:14 the
 * dispatcher minted 87 runners, 65 of them for push runs created AFTER them,
 * and not one for a younger auto-update run — age order held inside the band
 * and the band was the whole wait.
 *
 * 300 s per band is the fan-out's own p90 job wait that day (571 self-hosted
 * jobs, created_at -> started_at: p50 84 s, p90 311 s) and the line at which
 * ci:queue-health declares the fleet not serving work. It keeps the 2026-10-09
 * order exactly: a verify-branch dispatch (band 2, ten minutes) still yields
 * to a push that arrived up to ten minutes after it.
 */
export const BAND_HEAD_START_MS = 300_000;

/**
 * The order a pass places queued jobs in: oldest first, with a PUSH given a
 * head start over everything else and a manual dispatch starting furthest back
 * (see {@link BAND_HEAD_START_MS}).
 *
 * Capacity a job kind can use is sometimes three nodes deep (jdk21), and then
 * order is the whole policy. On 2026-10-09 20:27Z cardtable's push to main —
 * the run its deploy waits on — had three Forge shards queued since 20:05
 * behind eleven verify-branch dispatches that arrived after it, because the
 * pass placed jobs in the order repos and runs were listed. A dispatch is
 * somebody checking a branch; a push is the branch everyone else builds on.
 * Stable, and a job with no readable age sorts last.
 */
export function byPriority(pending: readonly PendingRun[]): PendingRun[] {
	const band = (r: PendingRun): number =>
		r.event === 'push' ? 0 : r.event === 'workflow_dispatch' ? 2 : 1;
	const rank = (r: PendingRun): number => {
		const t = Date.parse(r.jobCreatedAt ?? (r as { created_at?: string }).created_at ?? '');
		return Number.isFinite(t) ? t + band(r) * BAND_HEAD_START_MS : Number.POSITIVE_INFINITY;
	};
	return [...pending].sort((a, b) => rank(a) - rank(b) || band(a) - band(b));
}
