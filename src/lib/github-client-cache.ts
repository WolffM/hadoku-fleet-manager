/**
 * The conditional-request cache store `ghGet`/`ghWrite`/`readRunnerListingShared`
 * (github-client.ts) read and write through — the process map, its disk
 * persistence, and hydration. Split out of `github-client.ts` (wave shrink-1
 * lane C, pure move) to bring that file under the 600-line target.
 */
import { ghTokenFingerprint } from '../gh-budget-windows.js';
import { conditionalCacheStore } from '../conditional-cache-store.js';

/**
 * Kept per (token, repo, path) as response TEXT, parsed on every read: a caller
 * that edits the object it was handed (runner-health demotes a runner by
 * rewriting `labels` in place) can never corrupt what the next caller is
 * served. Bounded by bytes, oldest-touched first, because per-run `/jobs`
 * paths are unbounded in number and almost never asked twice.
 *
 * PERSISTED, so a restart does not start cold (2026-10-25). Every entry with an
 * ETag is written through to `stateDir()` (see conditional-cache-store.ts for
 * the bounds and for why a restored body is safe), and the first `ghGet` of a
 * process loads them back. A restored entry is loaded with `atMs: 0` — GitHub
 * has not vouched for it in THIS process — so the shared listing in
 * `github-client.ts` never answers from it without asking; it is only ever
 * served on a 304. Before this, every one of the 12 restarts on 2026-10-25
 * 04:46-06:39Z paid full price for every listing it read first: runner-health
 * 85-91, ci-alerts 75-104 and the reap 22-43 charged calls in the window
 * holding each boot.
 */
export const GH_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export interface GhCached {
	repo: string;
	path: string;
	etag: string | null;
	text: string;
	/**
	 * When GitHub last vouched for this body: the 200 that carried it, or a 304
	 * since. 0 when a runner write for the repo may have made it stale — see
	 * `readRunnerListingShared` in github-client.ts.
	 */
	atMs: number;
}
export const ghCache = new Map<string, GhCached>();
let ghCacheBytes = 0;
const ghCacheDisk = conditionalCacheStore('runner-health', { maxBytes: GH_CACHE_MAX_BYTES });
let ghCacheHydrated = false;

export function ghCacheKey(token: string, repo: string, path: string): string {
	return `${ghTokenFingerprint(token)}\n${repo}\n${path}`;
}

/**
 * The previous process's entries, once per process, before the first read.
 * Synchronous, so every concurrent first read of a tick sees the same cache.
 */
export function hydrateGhCache(): void {
	if (ghCacheHydrated) return;
	ghCacheHydrated = true;
	for (const e of ghCacheDisk.load()) {
		const [, repo, path] = e.key.split('\n');
		if (!repo || !path || ghCache.has(e.key)) continue;
		ghCacheStore(e.key, { repo, path, etag: e.etag, text: e.text, atMs: 0 }, false);
	}
}

/**
 * `persist`: write the entry through to disk. TRUE only for a body GitHub just
 * sent — a 304 changes nothing worth writing, and a write per 304 would turn
 * the free answers into the most frequent disk write in the process.
 */
export function ghCacheStore(key: string, entry: GhCached, persist: boolean): void {
	const prev = ghCache.get(key);
	if (prev) {
		ghCacheBytes -= prev.text.length;
		ghCache.delete(key);
	}
	// Re-inserted, so Map order is touch order and the first key is the oldest.
	ghCache.set(key, entry);
	ghCacheBytes += entry.text.length;
	if (persist) {
		// An entry with no ETag can never earn a 304, so the disk copy of an
		// older one goes rather than staying behind as a pair that no longer
		// matches what this process holds.
		if (entry.etag) ghCacheDisk.save(key, entry.etag, entry.text);
		else ghCacheDisk.remove(key);
	}
	for (const [k, v] of ghCache) {
		if (ghCacheBytes <= GH_CACHE_MAX_BYTES || k === key) break;
		ghCache.delete(k);
		ghCacheBytes -= v.text.length;
		ghCacheDisk.remove(k);
	}
}

/**
 * Drop the PROCESS's half of the conditional cache and keep the disk, which is
 * exactly what an mgmt-api deploy does. Test seam. `github-client.ts`'s own
 * `__restartGhCacheForTesting` also clears `runnerWriteGen`, which this
 * module does not own.
 */
export function __restartGhCacheStoreForTesting(): void {
	ghCache.clear();
	ghCacheBytes = 0;
	ghCacheHydrated = false;
}

/**
 * Full reset of this module's cross-tick cache state (process + disk).
 * `github-client.ts`'s own `__resetGhCacheStateForTesting` also clears
 * `runnerWriteGen`, which this module does not own.
 */
export function __resetGhCacheStoreForTesting(): void {
	ghCache.clear();
	ghCacheBytes = 0;
	ghCacheDisk.clear();
	ghCacheHydrated = true;
}
