/**
 * Conditional-request caches that outlive the process (2026-10-25).
 *
 * WHY THIS EXISTS
 * ---------------
 * Every ETag cache in this package was module state, so every mgmt-api restart
 * began with no ETags and paid full price for the first read of every listing.
 * A restart is not rare: each `@wolffm/*` publish redeploys mgmt-api, and on
 * 2026-10-25 it restarted 12 times between 04:46 and 06:39Z. The process that
 * started at 05:26 spent ~400 charged calls in its first four minutes
 * (runner-health 91, ci-alerts 86, dispatch-probe 70, dispatch-poll 63, reap
 * 43…), almost all of them listings that had not changed since the last
 * process read them, and the general budget was spent at 05:30:36.
 *
 * WHY A RESTORED BODY IS SAFE TO SERVE
 * ------------------------------------
 * dispatch-tick did not persist its cache because that "would risk serving a
 * body from before a restart that the fleet has already acted on". That risk is
 * real for a body served WITHOUT asking GitHub, and no restored entry is ever
 * served that way. A restored entry is only an ETag to send: its body is
 * returned only when GitHub answers 304 to that ETag, and a 304 is GitHub saying
 * the representation it would serve NOW is the one we hold. So the body handed
 * back is current, whatever its age — the same guarantee an in-process 304
 * gives. Readers that answer from the cache WITHOUT a request (runner-health's
 * shared listing) see restored entries as never-vouched-for, so they ask.
 *
 * WHAT IT COSTS
 * -------------
 * One small file per entry, written only when a charged 200 changes the entry —
 * a 304 writes nothing — so disk writes are bounded by the calls the budget
 * already paid for. Bounded on load by age and total bytes, newest kept; a file
 * that is unreadable is deleted and costs one charged read, never a failure.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { logger, stateDir } from './host.js';
import { writeJsonAtomic } from './lib/atomic-json.js';

/** Under `stateDir()`. One subdirectory per cache. */
export const CONDITIONAL_CACHE_DIR = 'gh-conditional-cache';

/**
 * An ETag older than this is dropped on load. Not a correctness bound — a 304
 * vouches for any age — but a per-run `/jobs` path is almost never asked twice,
 * and without an age bound its file would sit on disk for ever.
 */
export const CONDITIONAL_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;

export interface StoredConditional {
	key: string;
	etag: string;
	text: string;
	savedAtMs: number;
}

export interface ConditionalCacheStore {
	/** Every entry on disk within the bounds, OLDEST first, so a Map built from it keeps touch order. */
	load(nowMs?: number): StoredConditional[];
	save(key: string, etag: string, text: string, nowMs?: number): void;
	remove(key: string): void;
	/** Drop every file. Test seam, and the reset a fresh state dir models. */
	clear(): void;
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * A store for one cache. `maxBytes` bounds the TEXT kept across all entries on
 * load; the caller keeps its own in-memory bound and calls `remove` on eviction.
 */
export function conditionalCacheStore(
	name: string,
	opts: { maxBytes: number; maxAgeMs?: number }
): ConditionalCacheStore {
	const maxAgeMs = opts.maxAgeMs ?? CONDITIONAL_CACHE_MAX_AGE_MS;
	const complaints = new Set<string>();
	// SAY WHY, once per process. A store that cannot write costs the next
	// restart its free reads, which is the incident this exists for — silent
	// would make that indistinguishable from working.
	const complainOnce = (what: string, message: string): void => {
		if (complaints.has(what)) return;
		complaints.add(what);
		logger.warn(`[conditional-cache] ${name}: ${message}`);
	};
	const dir = (): string => join(stateDir(), CONDITIONAL_CACHE_DIR, name);
	const fileOf = (key: string): string =>
		join(dir(), `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);

	return {
		load(nowMs = Date.now()) {
			let names: string[];
			try {
				names = readdirSync(dir());
			} catch (e) {
				// ENOENT is a store that has never been written: the normal first boot.
				if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
					complainOnce('list', `could not list ${dir()}: ${reasonOf(e)} — starting cold`);
				}
				return [];
			}
			const entries: StoredConditional[] = [];
			for (const n of names) {
				const path = join(dir(), n);
				if (!n.endsWith('.json')) {
					// A `.tmp` left by a write that died mid-rename.
					rmSync(path, { force: true });
					continue;
				}
				try {
					const v = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredConditional>;
					if (
						typeof v.key !== 'string' ||
						typeof v.etag !== 'string' ||
						!v.etag ||
						typeof v.text !== 'string' ||
						typeof v.savedAtMs !== 'number' ||
						nowMs - v.savedAtMs > maxAgeMs
					) {
						rmSync(path, { force: true });
						continue;
					}
					entries.push(v as StoredConditional);
				} catch (e) {
					complainOnce('parse', `dropped unreadable ${path}: ${reasonOf(e)}`);
					rmSync(path, { force: true });
				}
			}
			// Newest kept under the byte bound; returned oldest first.
			entries.sort((a, b) => b.savedAtMs - a.savedAtMs);
			const kept: StoredConditional[] = [];
			let bytes = 0;
			for (const e of entries) {
				if (bytes + e.text.length > opts.maxBytes) {
					rmSync(fileOf(e.key), { force: true });
					continue;
				}
				bytes += e.text.length;
				kept.push(e);
			}
			return kept.reverse();
		},
		save(key, etag, text, nowMs = Date.now()) {
			const path = fileOf(key);
			try {
				// Temp-and-rename (F3, `lib/atomic-json.ts`): a torn write must not
				// pair one ETag with half a body. fsync SKIPPED — a RECORDED
				// divergence (plan §4.1 step 2): this writes once per conditional
				// GitHub read that changed, and every entry here is disposable —
				// losing one to an unclean restart costs exactly the one read it
				// would have made free, nothing more, so the two extra fsyncs are
				// not worth paying on this path.
				writeJsonAtomic(path, { key, etag, text, savedAtMs: nowMs }, { fsync: false });
			} catch (e) {
				complainOnce(
					'write',
					`could not persist to ${dir()}: ${reasonOf(e)} — the next restart pays full price ` +
						'for the reads this cache would have made free'
				);
			}
		},
		remove(key) {
			try {
				rmSync(fileOf(key), { force: true });
			} catch (e) {
				complainOnce('remove', `could not remove an evicted entry: ${reasonOf(e)}`);
			}
		},
		clear() {
			rmSync(dir(), { recursive: true, force: true });
		},
	};
}
