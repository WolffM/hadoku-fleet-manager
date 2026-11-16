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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { logger, stateDir } from './host.js';
import { writeFileAtomic } from './lib/atomic-json.js';

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
	/** False when the write failed: the caller must not rely on the disk copy. */
	save(key: string, etag: string, text: string, nowMs?: number): Promise<boolean>;
	/**
	 * One entry's body, read asynchronously, or `null` when there is no file,
	 * it does not parse, or it holds a different ETag. For a caller that keeps
	 * a large body on disk only (`github-client-cache.ts`, fleet-manager#86).
	 */
	read(key: string, etag: string): Promise<string | null>;
	remove(key: string): void;
	/** Drop every file. Test seam, and the reset a fresh state dir models. */
	clear(): void;
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * ON DISK: one line of JSON (`key`, `etag`, `savedAtMs`), a newline, then the
 * body as it came from GitHub. The body is not a JSON string inside the
 * header, so reading it back costs a file read and a split, not a second
 * parse of the whole body: ~2.6 ms of event loop per 304 on a 1.3 MB runs
 * listing (fleet-manager#86). `.json` files hold the older all-JSON form
 * (`{key, etag, text, savedAtMs}`). They are still read, and the next save
 * of the same key replaces each one.
 */
const EXT = '.etag';
const LEGACY_EXT = '.json';

interface Header {
	key: string;
	etag: string;
	savedAtMs: number;
}

function parseEntry(raw: string, legacy: boolean): StoredConditional | null {
	if (legacy) {
		const v = JSON.parse(raw) as Partial<StoredConditional>;
		return typeof v.key === 'string' &&
			typeof v.etag === 'string' &&
			v.etag &&
			typeof v.text === 'string' &&
			typeof v.savedAtMs === 'number'
			? (v as StoredConditional)
			: null;
	}
	const nl = raw.indexOf('\n');
	if (nl < 0) return null;
	const h = JSON.parse(raw.slice(0, nl)) as Partial<Header>;
	if (typeof h.key !== 'string' || typeof h.etag !== 'string' || !h.etag) return null;
	if (typeof h.savedAtMs !== 'number') return null;
	return { key: h.key, etag: h.etag, savedAtMs: h.savedAtMs, text: raw.slice(nl + 1) };
}

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
	const stem = (key: string): string =>
		join(dir(), createHash('sha256').update(key).digest('hex').slice(0, 32));
	const fileOf = (key: string): string => stem(key) + EXT;
	const legacyFileOf = (key: string): string => stem(key) + LEGACY_EXT;

	// WHICH FILES THIS STORE HAS ON DISK, once `load` has listed the directory
	// (fleet-manager#86). `null` is "never listed": then every removal goes to
	// the disk, as before. `github-client-cache` calls `remove` for every
	// response it will not keep and every `save` cleared a legacy file that had
	// been gone for weeks: two synchronous `rm`s each, 2.2 s of the leader's
	// loop per 300 s in the 2026-11-16 profile, for files that were never
	// there. A file some other process wrote after the listing is not known
	// here and survives a `remove`; the next `load` reads it back, and its ETag
	// is checked by GitHub before its body is ever used.
	let onDisk: Set<string> | null = null;
	const rm = (path: string): void => {
		if (onDisk && !onDisk.has(path)) return;
		rmSync(path, { force: true });
		onDisk?.delete(path);
	};

	return {
		load(nowMs = Date.now()) {
			let names: string[];
			try {
				names = readdirSync(dir());
			} catch (e) {
				// ENOENT is a store that has never been written: the normal first boot.
				if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
					complainOnce('list', `could not list ${dir()}: ${reasonOf(e)} — starting cold`);
					// Could not look, so nothing is known about what is there.
					onDisk = null;
				} else onDisk = new Set();
				return [];
			}
			onDisk = new Set(names.map((n) => join(dir(), n)));
			const entries: StoredConditional[] = [];
			for (const n of names) {
				const path = join(dir(), n);
				const legacy = n.endsWith(LEGACY_EXT);
				if (!legacy && !n.endsWith(EXT)) {
					// A `.tmp` left by a write that died mid-rename.
					rm(path);
					continue;
				}
				try {
					const v = parseEntry(readFileSync(path, 'utf8'), legacy);
					if (!v || nowMs - v.savedAtMs > maxAgeMs) {
						rm(path);
						continue;
					}
					entries.push(v);
				} catch (e) {
					complainOnce('parse', `dropped unreadable ${path}: ${reasonOf(e)}`);
					rm(path);
				}
			}
			// Newest kept under the byte bound; returned oldest first.
			entries.sort((a, b) => b.savedAtMs - a.savedAtMs);
			const kept: StoredConditional[] = [];
			let bytes = 0;
			for (const e of entries) {
				if (bytes + e.text.length > opts.maxBytes) {
					rm(fileOf(e.key));
					rm(legacyFileOf(e.key));
					continue;
				}
				bytes += e.text.length;
				kept.push(e);
			}
			return kept.reverse();
		},
		async save(key, etag, text, nowMs = Date.now()) {
			const path = fileOf(key);
			try {
				// Temp-and-rename (F3, `lib/atomic-json.ts`): a torn write must not
				// pair one ETag with half a body.
				const header: Header = { key, etag, savedAtMs: nowMs };
				// Known before the write lands, so a `remove` that overtakes it still
				// goes to the disk.
				onDisk?.add(path);
				await writeFileAtomic(path, `${JSON.stringify(header)}\n${text}`);
				rm(legacyFileOf(key));
				return true;
			} catch (e) {
				complainOnce(
					'write',
					`could not persist to ${dir()}: ${reasonOf(e)} — the next restart pays full price ` +
						'for the reads this cache would have made free'
				);
				return false;
			}
		},
		async read(key, etag) {
			for (const [path, legacy] of [
				[fileOf(key), false],
				[legacyFileOf(key), true],
			] as const) {
				let raw: string;
				try {
					raw = await readFile(path, 'utf8');
				} catch (e) {
					if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
					complainOnce('read', `could not read ${path}: ${reasonOf(e)}`);
					return null;
				}
				try {
					const v = parseEntry(raw, legacy);
					return v && v.key === key && v.etag === etag ? v.text : null;
				} catch (e) {
					complainOnce('parse', `unreadable ${path}: ${reasonOf(e)}`);
					return null;
				}
			}
			return null;
		},
		remove(key) {
			try {
				rm(fileOf(key));
				rm(legacyFileOf(key));
			} catch (e) {
				complainOnce('remove', `could not remove an evicted entry: ${reasonOf(e)}`);
			}
		},
		clear() {
			rmSync(dir(), { recursive: true, force: true });
			onDisk = new Set();
		},
	};
}
