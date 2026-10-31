import { ghTokenFingerprint } from '../gh-budget.js';
import { conditionalCacheStore } from '../conditional-cache-store.js';

/**
 * Per-repo ETag and the body it belongs to.
 *
 * PERSISTED since 2026-10-25, with the jobs cache below. This said persisting
 * "would risk serving a body from before a restart that the fleet has already
 * acted on" — true of a body served without asking, and these never are: the
 * cached body is read ONLY on `unchanged`, which is GitHub answering 304 to the
 * ETag stored beside it, i.e. saying that body is the one it would serve now.
 * What persisting changes is the price of the first poll after a restart, not
 * what it returns: on 2026-10-25 the dispatcher's first minutes after each of 12
 * restarts charged 36-63 polls and 23-70 probes, every one a full listing.
 * The bounds and the write rule are in conditional-cache-store.ts.
 */
export const etagByRepo = new Map<string, string>();
const POLL_CACHE_MAX_BYTES = 8 * 1024 * 1024;
export const runsDisk = conditionalCacheStore('dispatch-runs', { maxBytes: POLL_CACHE_MAX_BYTES });
export const jobsDisk = conditionalCacheStore('dispatch-jobs', { maxBytes: POLL_CACHE_MAX_BYTES });
/** The pending listing's ETag and body (fleet-manager#11), kept exactly like the queued one's. */
export const pendingEtagByRepo = new Map<string, string>();
export const pendingDisk = conditionalCacheStore('dispatch-pending', {
	maxBytes: POLL_CACHE_MAX_BYTES,
});
/** `${token fingerprint}\n${repo or repo#runId}` — an ETag is answered per credential. */
export const diskKey = (token: string, key: string): string =>
	`${ghTokenFingerprint(token)}\n${key}`;

/** Last poll time per repo. Module state, and safe to lose: `reposDue` treats an
 * unknown repo as due, so a restart polls everything once and re-tiers itself. */
export const lastPolledMs = new Map<string, number>();

/**
 * `repo#runId` of the runs each repo's last pending listing returned. Their
 * jobs cache and backoff must outlive the ticks between pending polls, or every
 * probe would be a full read; they are dropped once a listing no longer has them.
 */
export const pendingKeysByRepo = new Map<string, Set<string>>();
