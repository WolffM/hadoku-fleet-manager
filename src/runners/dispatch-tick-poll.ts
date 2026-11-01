/**
 * dispatch-tick.ts's poll cache: the previous process's ETags/bodies, hydrated
 * once, and the dispatcher's own queue snapshot read off them.
 *
 * Wave 5r lane B split of dispatch-tick.ts (plan: 800-line ceiling, pure
 * move): everything here is unmodified from dispatch-tick.ts apart from the
 * `export`s needed to keep it re-exported from there, and the
 * `__setPollCacheHydratedForTesting` seam `pollCacheHydrated` needed once it
 * stopped being assignable from the importing module (an ES module import
 * binding is read-only; the flag is still set and read in the SAME place it
 * always was, through `hydratePollCache` and the two reset functions that now
 * call the setter instead of assigning the variable directly).
 */
import { logger } from '../host.js';
import { ghTokenFingerprint } from '../gh-budget.js';
import {
	etagByRepo,
	runsDisk,
	jobsDisk,
	pendingEtagByRepo,
	pendingDisk,
} from '../lib/dispatch-poll-cache.js';
import { reasonOf } from './stuck-runs.js';
import { ZOMBIE_MS, queuedSinceMs } from './queue-discovery.js';
import type { QueuedJob, QueuedRun } from './queue-discovery.js';

let pollCacheHydrated = false;
const cachedRunsByRepo = new Map<string, { workflow_runs?: QueuedRun[] }>();
const cachedPendingByRepo = new Map<string, { workflow_runs?: QueuedRun[] }>();

/**
 * The previous process's ETags and bodies, once per process, before the first
 * poll. An entry for another token (a rotation since) is skipped, not served.
 */
export function hydratePollCache(token: string): void {
	if (pollCacheHydrated) return;
	pollCacheHydrated = true;
	const fp = ghTokenFingerprint(token);
	const restore = (
		disk: typeof runsDisk,
		put: (key: string, etag: string, body: unknown) => void
	): void => {
		for (const e of disk.load()) {
			const sep = e.key.indexOf('\n');
			if (e.key.slice(0, sep) !== fp) continue;
			try {
				put(e.key.slice(sep + 1), e.etag, JSON.parse(e.text));
			} catch (err) {
				// Written by JSON.stringify, so this is a damaged file: drop it and
				// pay one full read, which is all a missing entry ever costs.
				disk.remove(e.key);
				logger.warn(`[dispatch-tick] dropped an unparseable cached body: ${reasonOf(err)}`);
			}
		}
	};
	restore(runsDisk, (repo, etag, body) => {
		etagByRepo.set(repo, etag);
		cachedRunsByRepo.set(repo, body as { workflow_runs?: QueuedRun[] });
	});
	restore(pendingDisk, (repo, etag, body) => {
		pendingEtagByRepo.set(repo, etag);
		cachedPendingByRepo.set(repo, body as { workflow_runs?: QueuedRun[] });
	});
	restore(jobsDisk, (key, etag, body) => {
		jobsCacheByRun.set(key, { etag, body: body as { jobs?: QueuedJob[] } });
	});
}

/**
 * Each repo's last successfully READ listing (200 or 304) and when. An errored
 * poll leaves the entry alone, and `at` says how old it is. Separate from
 * `cachedRunsByRepo`, which exists for conditional requests only.
 */
const lastReadByRepo = new Map<string, { atMs: number; runs: readonly QueuedRun[] }>();

/**
 * THE QUEUE AS THE DISPATCHER SEES IT, every 15s, for the panel's headline.
 *
 * The headline read runner-health's `queued_now`, which is cut once per
 * 10-minute tick, so on 2026-10-25 "13 queued · oldest 44m" sat on screen while
 * the queue moved under it. This is the same listing the dispatcher mints
 * from, re-evaluated at request time so ages are current. Zombies (past
 * ZOMBIE_MS) are excluded for the reason runner-health excludes them; a run
 * stranded under that line is a real wait and counts.
 *
 * `at` is the OLDEST read among the repos counted, so the figure is never
 * presented as fresher than its stalest input; `unread` names how many of the
 * given repos have no successful read since restart — "could not look" is
 * never folded into zero.
 */
export function getDispatchQueueSnapshot(
	repos: readonly string[],
	nowMs: number = Date.now()
): { at: string | null; runs: number; oldestQueuedMin: number | null; unread: number } {
	let runs = 0;
	let oldestMs: number | null = null;
	let readAt: number | null = null;
	let unread = 0;
	for (const repo of repos) {
		const read = lastReadByRepo.get(repo);
		if (!read) {
			unread++;
			continue;
		}
		readAt = readAt === null ? read.atMs : Math.min(readAt, read.atMs);
		for (const r of read.runs) {
			if (r.status !== 'queued') continue;
			const since = queuedSinceMs(r);
			if (since === undefined || nowMs - since > ZOMBIE_MS) continue;
			runs++;
			oldestMs = oldestMs === null ? since : Math.min(oldestMs, since);
		}
	}
	return {
		at: readAt === null ? null : new Date(readAt).toISOString(),
		runs,
		oldestQueuedMin: oldestMs === null ? null : Math.round((nowMs - oldestMs) / 60_000),
		unread,
	};
}

/**
 * Per candidate run (`repo#runId`): the jobs listing's ETag and the body it
 * belongs to (#117). Same reasoning, and the same restart behaviour, as
 * `etagByRepo`: a 304 is free (measured 2026-10-16 on this endpoint — three
 * conditional `/runs/{id}/jobs` requests answered 304 and `used` did not move),
 * and it means the cached body IS the current one.
 */
const jobsCacheByRun = new Map<string, { etag: string | null; body: { jobs?: QueuedJob[] } }>();

export { cachedRunsByRepo, cachedPendingByRepo, lastReadByRepo, jobsCacheByRun };

/** Test seam: `pollCacheHydrated` is a live import binding and so cannot be
 *  assigned from outside this module; dispatch-tick.ts's own reset seams call
 *  this instead of touching the flag directly. */
export function __setPollCacheHydratedForTesting(v: boolean): void {
	pollCacheHydrated = v;
}
