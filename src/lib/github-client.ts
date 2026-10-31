/**
 * The GitHub Actions API client, moved out of `runner-health.ts` 2026-10-29
 * (plan §4.1 F2): URL building, failure classification, the PRIMARY-rate-limit
 * blackout, the conditional-request cache, and `ghGet`/`ghWrite`. Access
 * layer — imports nothing from `runner-health.ts` or any other
 * observation/domain module. Every line below is byte-identical to its old
 * self except for imports and the `export` keyword some names needed to stay
 * reachable. Three functions at the end are NEW, not moved: `runner-health.ts`
 * used to reach into this module's state directly (same-scope assignments);
 * an import binding cannot be reassigned from outside its module, so each site
 * became a call into a named export here instead.
 */
import { logger } from '../host.js';
import { recordGhResponse, ghBudgetSummary, ghTokenFingerprint } from '../gh-budget.js';
import { conditionalCacheStore } from '../conditional-cache-store.js';
import { hubRepoFull, userAgent } from './fleet-config.js';

export const FETCH_TIMEOUT_MS = 10_000;

/**
 * The repo this monitor runs out of. Its runner listing is the fleet-wide view
 * (the claws register to every covered repo under the same names), so the
 * label-floor and backstop checks read it alone.
 *
 * The RUNS checks below do NOT — see `fleetRepos`. Until 2026-08-17 every call
 * here was hardcoded to this repo, which meant the dropped-job failover, the
 * queued-too-long alert and the hung-job alert all covered exactly 1 of 20
 * repos. On 2026-08-17 claw-3 died mid-job and took four child-repo publishes
 * with it (aggregator, contact-ui, resume-bot, watchparty); `failover_reruns`
 * reported 0 and every one of them stayed red, because none of them were this
 * repo. They only went green again because an unrelated package-update cascade
 * happened to re-trigger them ~20 minutes later. That was luck, not recovery.
 *
 * EXPORTED so a reader can NAME it. Registration state is per-repo, so a node
 * reading `absent` in `claw_state` is absent from THIS repo — not from the
 * fleet. The panel could only assert that in a tooltip it typed by hand.
 *
 * WHICH repo comes from `fleet-config`, not from here — it is the hub repo, the
 * same one `ci-runner-fallback` degrades to. Resolved ONCE, at import, because
 * this is a `const` and `src/routes/fleet.ts` imports it as one; that is exactly
 * the binding it has always had, so an operator setting `FLEET_HUB_REPO` must set
 * it before the process starts, as they already must for `HADOKU_STATE_DIR`.
 */
export const SELF_REPO = hubRepoFull();

export function ghUrl(repo: string, path: string): string {
	return `https://api.github.com/repos/${repo}${path}`;
}

export interface GhRunner {
	id: number;
	name: string;
	status: string; // 'online' | 'offline'
	busy: boolean;
	labels?: { name: string }[];
}

/**
 * Why a GitHub call failed, in one line an operator can act on.
 *
 * `resp.status` alone is not a diagnosis. A 403 is primary rate limiting,
 * SECONDARY (burst) rate limiting, or a permissions failure — three different
 * problems with three different fixes, and this logged the same word for all
 * three while discarding the body that distinguishes them.
 *
 * That cost real time on 2026-09-02: `ci:queue-health` failed with "could not
 * read the queue for 26 repo(s)" and pinning it to a concurrency burst took a
 * subagent and an archaeology pass through the logs, because nothing recorded
 * GitHub's own message or a single x-ratelimit header. Both were on the
 * response and both were thrown away.
 *
 * PRIMARY is `remaining: 0` — the hourly budget is spent and `reset` says when.
 * SECONDARY is a burst: the budget still has room, GitHub says so in the
 * message, and `retry-after` is the wait. They are told apart HERE rather than
 * by a human reading a count later.
 *
 * Never throws and never blocks the caller's fail-soft path: a body that will
 * not read degrades to the status line it already had.
 */
async function describeGhFailure(resp: Response): Promise<string> {
	let message = '';
	try {
		const text = await resp.text();
		message = messageFrom(text);
	} catch {
		// A body that will not read is not worth failing over — the status and
		// the headers are already more than this used to say.
	}
	const described = describeGhStatus(resp, message);
	// Every failed READ also records its kind, for `unreadableTickError`.
	lastGhReadFailure = {
		kind: classifyGhReadFailure(resp.status, resp.headers.get('x-ratelimit-remaining'), message),
		detail: described,
	};
	return described;
}

/** The `message` GitHub sent, from a body that may not be JSON. */
function messageFrom(text: string): string {
	if (!text) return '';
	try {
		const parsed = JSON.parse(text) as { message?: string };
		return parsed.message ?? text.slice(0, 160);
	} catch {
		return text.slice(0, 160);
	}
}

/**
 * The classification, over a response whose body the caller has already read.
 *
 * Split out because `ghWrite` consumes its own body to return it, and a
 * Response body can only be read once — re-reading it there would throw and
 * lose the diagnosis entirely.
 */
function describeGhStatus(resp: Response, message: string): string {
	const h = (n: string) => resp.headers.get(n);
	const remaining = h('x-ratelimit-remaining');
	const limit = h('x-ratelimit-limit');
	const used = h('x-ratelimit-used');
	const reset = h('x-ratelimit-reset');
	const retryAfter = h('retry-after');

	const parts = [`HTTP ${resp.status}`];
	if (message) parts.push(`"${message}"`);

	// The classification is the point. `remaining: 0` is the hourly budget;
	// anything else that mentions a rate limit is the burst one, and only the
	// second is fixed by narrowing concurrency.
	const isPrimary = remaining === '0';
	const mentionsSecondary = /secondary rate limit/i.test(message);
	if (isPrimary) parts.push('PRIMARY rate limit (hourly budget spent)');
	else if (mentionsSecondary || retryAfter)
		parts.push('SECONDARY rate limit (burst — narrow concurrency)');

	if (remaining !== null) parts.push(`rate=${used ?? '?'}/${limit ?? '?'} remaining=${remaining}`);
	if (reset) {
		const secs = Number(reset) - Math.floor(Date.now() / 1000);
		if (Number.isFinite(secs)) parts.push(`resets_in=${Math.max(0, secs)}s`);
	}
	if (retryAfter) parts.push(`retry_after=${retryAfter}s`);
	return parts.join(' ');
}

/**
 * When the PRIMARY budget refills, epoch ms. 0 means "not known to be spent".
 *
 * @see noteGhRateLimit for why this exists.
 */
let primaryResetAtMs = 0;
/** Whether the current blackout has already been logged. One line, not thousands. */
let blackoutAnnounced = false;

/**
 * The longest blackout this will honour, however bad the header looks.
 *
 * GitHub's window is an hour, so anything past that is a clock skew or a
 * malformed header rather than a real reset — and a bad header must not be able
 * to mute the fleet's only view of itself for longer than the real limit could.
 */
const MAX_BLACKOUT_MS = 60 * 60_000;

/**
 * Record a spent hourly budget, so the callers stop asking until it refills.
 *
 * WHY SUPPRESSION IS THE RIGHT ANSWER HERE, AND ONLY HERE. `remaining: 0` is
 * not a fault in one call — it is one fact about the TOKEN, and every other
 * call sharing it is already decided. Retrying is not optimism, it is arithmetic
 * that cannot come out differently until the reset.
 *
 * Measured 2026-09-06: the reap sweep kept walking all 27 repos, and the timer
 * ran it again 15 seconds later, for the whole 19-minute blackout — ~108
 * guaranteed-403 calls a minute, 6,903 in the log. None of them could have
 * succeeded. They cost no primary budget (a denied call is already denied) but
 * they are exactly the burst shape GitHub's SECONDARY limiter watches for, so
 * the spin risked converting a blackout that ends on a clock into one that
 * extends itself.
 *
 * ONLY THE PRIMARY LIMIT. A secondary limit means "too fast", is usually seconds
 * long and carries `retry-after`; the fix for it is narrower concurrency, not a
 * fleet-wide stop. Tripping this on one would stall everything over a burst that
 * had already passed.
 *
 * FAILS OPEN. A response with no usable `x-ratelimit-reset` does not trip it: a
 * few doomed calls are cheaper than a blackout with no end, and a missing header
 * is the one case where we genuinely do not know when to look again.
 */
function noteGhRateLimit(resp: Response, nowMs = Date.now()): void {
	if (resp.headers.get('x-ratelimit-remaining') !== '0') return;
	const reset = Number(resp.headers.get('x-ratelimit-reset'));
	if (!Number.isFinite(reset) || reset <= 0) return;
	const until = reset * 1000;
	if (until <= nowMs) return;
	primaryResetAtMs = Math.min(until, nowMs + MAX_BLACKOUT_MS);
}

/**
 * Milliseconds until the budget refills, or 0 when it is not known to be spent.
 *
 * This is the ONLY thing that reads the blackout, and it clears itself: once the
 * clock passes the reset, the next call goes out for real and either succeeds or
 * re-arms this. Nothing has to remember to reopen it.
 *
 * EXPORTED since 2026-09-08 so `scripts/floor-probe.mjs` can honour the same
 * blackout the reap and the label sweep already do, instead of becoming the
 * fourth uncoordinated caller on this token. Export only — the behaviour, the
 * clearing and the one-line-per-blackout warning are unchanged.
 */
export function ghBlackoutRemainingMs(nowMs = Date.now()): number {
	if (!primaryResetAtMs) return 0;
	if (nowMs >= primaryResetAtMs) {
		primaryResetAtMs = 0;
		blackoutAnnounced = false;
		return 0;
	}
	if (!blackoutAnnounced) {
		blackoutAnnounced = true;
		logger.warn(
			`[runner-health] PRIMARY rate limit spent — suppressing GitHub calls for ` +
				`${Math.ceil((primaryResetAtMs - nowMs) / 1000)}s until the budget refills. ` +
				`Callers see "could not look", NOT "nothing to do" (said ONCE per blackout). ` +
				`Spent by: ${ghBudgetSummary()}`
		);
	}
	return primaryResetAtMs - nowMs;
}

/**
 * Why the most recent GitHub GET came back "could not look", by KIND.
 *
 * `tick` fails the job when neither the runner listing nor the runs could be
 * read, and until 2026-10-11 it said "GitHub Actions API unreachable or
 * HADOKU_SITE_TOKEN lacks repo scope" whatever the cause. That day's 08:14Z
 * failure was a spent primary budget — 403 "API rate limit exceeded" at
 * 08:12:52 and a 226 s blackout — while the token logged `scopes='repo,
 * workflow'` on every start. A rate limit, a network fault and a missing scope
 * are three different jobs, and only the last is fixed by touching the token.
 */
export type GhReadFailureKind = 'rate-limit' | 'auth' | 'http' | 'network';
export interface GhReadFailure {
	kind: GhReadFailureKind;
	detail: string;
}
let lastGhReadFailure: GhReadFailure | null = null;

/** The kind of a non-ok response. Rate limits are 403s too, so they go first. */
export function classifyGhReadFailure(
	status: number,
	remaining: string | null,
	message: string
): GhReadFailureKind {
	if (status === 429 || remaining === '0' || /rate limit/i.test(message)) return 'rate-limit';
	if (status === 401 || status === 403 || status === 404) return 'auth';
	return 'http';
}

function noteGhReadBlackout(): void {
	lastGhReadFailure = {
		kind: 'rate-limit',
		detail: `primary rate limit spent — calls suppressed for ${Math.ceil(ghBlackoutRemainingMs() / 1000)}s more`,
	};
}

function noteGhReadError(err: unknown): string {
	const detail = err instanceof Error ? err.message : String(err);
	lastGhReadFailure = { kind: 'network', detail };
	return detail;
}

/**
 * The job error for a tick that could read nothing, from WHY it could not.
 * Only an auth-shaped answer points at the token's scope.
 */
export function unreadableTickError(f: GhReadFailure | null): string {
	if (!f)
		return 'GitHub Actions API could not be read this tick (no failure was recorded — could not look)';
	switch (f.kind) {
		case 'rate-limit':
			return `GitHub API rate limit spent — could not look this tick, the token is fine (${f.detail})`;
		case 'network':
			return `GitHub Actions API unreachable (network/timeout: ${f.detail}) — could not look this tick`;
		case 'http':
			return `GitHub Actions API answered an error (${f.detail}) — could not look this tick`;
		case 'auth':
			return (
				`HADOKU_SITE_TOKEN was refused (${f.detail}) — it may lack repo scope ` +
				'(need runner-listing + Actions:read)'
			);
	}
}

/**
 * Drop the PROCESS's half of the conditional cache and keep the disk, which is
 * exactly what an mgmt-api deploy does. Test seam.
 */
export function __restartGhCacheForTesting(): void {
	ghCache.clear();
	ghCacheBytes = 0;
	ghCacheHydrated = false;
	runnerWriteGen.clear();
}

/** Test seam. Not part of the supported API. */
export function __resetGhBlackoutForTesting(): void {
	primaryResetAtMs = 0;
	blackoutAnnounced = false;
}

/**
 * A GET that can come back "unchanged" for FREE.
 *
 * GitHub does not charge a conditional request that answers 304 against the
 * hourly budget. Measured 2026-09-04 on this account: 20 conditional requests
 * moved `used` by 0, 20 plain ones moved it by 19.
 *
 * That is the difference between polling being affordable and not. The
 * dispatcher lists queued runs for 26 repos every tick, and almost every one is
 * unchanged almost every time — on 2026-09-04 the token hit `remaining: 0` and
 * 424 of the 478 rate-limited calls were this exact listing, while the daily
 * 13:00 cron cluster shared the same budget.
 *
 * `unchanged` is NOT `error` and must never be collapsed into it: the caller
 * reuses its cached body, where an error means "I could not look" and has to
 * suppress action. That distinction is the whole point of the three-valued
 * return.
 */
export type ConditionalGet<T> =
	{ status: 'ok'; body: T; etag: string | null } | { status: 'unchanged' } | { status: 'error' };

export async function ghGetConditional<T>(
	path: string,
	token: string,
	repo: string,
	etag: string | null
): Promise<ConditionalGet<T>> {
	// `error`, never `unchanged`. Suppression means we did not look, and
	// `unchanged` would tell the dispatcher its cached body is still current —
	// turning a blackout into a fleet that confidently mints against a stale
	// queue for 19 minutes.
	if (ghBlackoutRemainingMs() > 0) {
		noteGhReadBlackout();
		return { status: 'error' };
	}
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': userAgent('runner-health'),
		};
		if (etag) headers['If-None-Match'] = etag;
		const resp = await fetch(ghUrl(repo, path), { headers, signal: controller.signal });
		clearTimeout(timeoutId);
		recordGhResponse(token, resp.status, resp.headers);
		// 304 is a SUCCESS that costs nothing. `resp.ok` is false for it, so this
		// must be checked before the generic failure path below or every free
		// answer would be logged as a fault.
		if (resp.status === 304) return { status: 'unchanged' };
		if (!resp.ok) {
			noteGhRateLimit(resp);
			logger.warn(`[runner-health] GET ${path} → ${await describeGhFailure(resp)}`);
			return { status: 'error' };
		}
		return { status: 'ok', body: (await resp.json()) as T, etag: resp.headers.get('etag') };
	} catch (err) {
		clearTimeout(timeoutId);
		logger.warn(`[runner-health] GET ${path} failed: ${noteGhReadError(err)}`);
		return { status: 'error' };
	}
}

/**
 * EVERY `ghGet` IS A CONDITIONAL REQUEST, and a 304 is free.
 *
 * Until 2026-10-16 only the dispatcher's queued-runs poll and its jobs probe
 * sent `If-None-Match`; everything else through `ghGet` paid full price on
 * every call. That was justified, at four call sites, as "this reader must see
 * CURRENT state, so it cannot send an ETag". The premise is false. A 304 is
 * GitHub's statement that the representation it would serve NOW has the ETag
 * we sent — it is a fresh look at current state, answered from the server's
 * side, not a cached guess. The dispatcher's own cache already says so ("it
 * means the cached body IS the current one"), and acts on it every 15s.
 * Checked live the same day: 160 conditional requests, each made right AFTER
 * an unconditional read of the same URL (three repos' runner listings and an
 * in-progress runs listing, during CI traffic). The body changed 39 times and
 * every one of those was answered 200; none of the 117 304s disagreed with
 * the read just before it.
 *
 * Why it matters, from the first measured hour (#119, 762 charged calls): the
 * reap (348), runner-health (289), ci-alerts (288), the warm cache (195) and
 * the backstop sweep (93) had ZERO 304s between them, against 4,764 for the
 * one poll that sent an ETag. Every one of those reads is a listing that is
 * unchanged on most calls on a quiet fleet.
 *
 * THE CEILING IS STILL THE SPEND. A listing whose body changes between calls —
 * a repo with jobs running, whose runners flip `busy` — answers 200 every time
 * and is charged every time. So a cadence must still be sized against the case
 * where every answer changed; this lowers the typical bill, not the worst one,
 * and must never be the reason a timer is sped up.
 *
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
 * has not vouched for it in THIS process — so the shared listing below never
 * answers from it without asking; it is only ever served on a 304. Before
 * this, every one of the 12 restarts on 2026-10-25 04:46-06:39Z paid full price
 * for every listing it read first: runner-health 85-91, ci-alerts 75-104 and
 * the reap 22-43 charged calls in the window holding each boot.
 */
export const GH_CACHE_MAX_BYTES = 32 * 1024 * 1024;
interface GhCached {
	repo: string;
	path: string;
	etag: string | null;
	text: string;
	/**
	 * When GitHub last vouched for this body: the 200 that carried it, or a 304
	 * since. 0 when a runner write for the repo may have made it stale — see
	 * `readRunnerListingShared`.
	 */
	atMs: number;
}
const ghCache = new Map<string, GhCached>();
let ghCacheBytes = 0;
const ghCacheDisk = conditionalCacheStore('runner-health', { maxBytes: GH_CACHE_MAX_BYTES });
let ghCacheHydrated = false;

function ghCacheKey(token: string, repo: string, path: string): string {
	return `${ghTokenFingerprint(token)}\n${repo}\n${path}`;
}

/**
 * The previous process's entries, once per process, before the first read.
 * Synchronous, so every concurrent first read of a tick sees the same cache.
 */
function hydrateGhCache(): void {
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
function ghCacheStore(key: string, entry: GhCached, persist: boolean): void {
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
 * ONE RUNNER LISTING PER REPO PER WINDOW, shared by every loop that can use one
 * that is a few minutes old (#118).
 *
 * The same `/actions/runners` listing was fetched per repo by the JIT reap,
 * the warm cache, runner-health's backstop sweep and its queued-run classifier,
 * each on its own clock and none aware of the others. runner-health's share —
 * ~120-150 calls a tick, six ticks in the 2026-10-16 18:30-19:15Z window that
 * ended in the blackout — repeated listings another loop had just paid for.
 *
 * So every SUCCESSFUL listing read through `ghGet` is kept (in `ghCache`,
 * above), whoever asked, and `readRunnerListingShared` answers from it while
 * GitHub vouched for it recently enough — a 304 counts. It is GitHub's
 * response, not anyone's record of what they wrote: the reader-writer rule is
 * not touched by who happened to pay for the read.
 *
 * WHO MAY READ IT, AND WHO MAY NOT. A reader that DELETES or EVICTS on the
 * answer — the reap, the warm cache's busy/online check — must see current
 * state and keeps calling `ghGet` itself (a revalidation: free when unchanged,
 * and it refreshes this as a side effect). The label-floor census pages, so it
 * and its confirming second look stay fresh too. What reads from here is
 * runner-health's backstop label sweep and its queued-run classifier, which
 * already act on a 10-minute tick.
 *
 * ANY WRITE UNDER `/actions/runners` FOR A REPO MAKES ITS ENTRY STALE — a label
 * write, a delete, a mint — so a loop never reads back a listing from before
 * its own change. A GET that was in flight across such a write is kept for its
 * ETag (GitHub decides whether it still holds) but is never fresh.
 */
export const SHARED_LISTING_MAX_AGE_MS = 5 * 60_000;
const RUNNER_LISTING_PATH = '/actions/runners?per_page=100';
type RunnerListing = { runners?: GhRunner[]; total_count?: number };
/** Bumped by every runner write per repo, so an in-flight GET cannot outlive it. */
const runnerWriteGen = new Map<string, number>();

/**
 * The repo's runner listing, from the cache when GitHub vouched for it within
 * `maxAgeMs`, otherwise read now. `null` is "could not look", as from `ghGet`.
 */
export async function readRunnerListingShared(
	repo: string,
	token: string,
	maxAgeMs = SHARED_LISTING_MAX_AGE_MS,
	nowMs = Date.now()
): Promise<RunnerListing | null> {
	hydrateGhCache();
	const hit = ghCache.get(ghCacheKey(token, repo, RUNNER_LISTING_PATH));
	if (hit && hit.atMs > 0 && nowMs - hit.atMs < maxAgeMs) {
		return JSON.parse(hit.text) as RunnerListing;
	}
	return ghGet<RunnerListing>(RUNNER_LISTING_PATH, token, repo);
}

export async function ghGet<T>(path: string, token: string, repo = SELF_REPO): Promise<T | null> {
	// `null` is this function's "I could not look", and every caller in the
	// dispatcher already treats it that way — see the `null` is the error return,
	// NOT an empty queue comment in dispatch-tick. Suppression must land there.
	if (ghBlackoutRemainingMs() > 0) {
		noteGhReadBlackout();
		return null;
	}
	hydrateGhCache();
	const genAtStart = runnerWriteGen.get(repo) ?? 0;
	const key = ghCacheKey(token, repo, path);
	// Held by reference: the entry may be evicted while the request is in
	// flight, and a 304 to an ETag we sent is still an answer about THIS body.
	const cached = ghCache.get(key);
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': userAgent('runner-health'),
		};
		if (cached?.etag) headers['If-None-Match'] = cached.etag;
		const resp = await fetch(ghUrl(repo, path), { headers, signal: controller.signal });
		clearTimeout(timeoutId);
		recordGhResponse(token, resp.status, resp.headers);
		const fresh = (runnerWriteGen.get(repo) ?? 0) === genAtStart;
		// Before the `ok` check: `resp.ok` is false for a 304, and treating the
		// free answer as a failure would turn every unchanged listing into
		// "could not look".
		if (resp.status === 304 && cached?.etag) {
			ghCacheStore(key, { ...cached, atMs: fresh ? Date.now() : cached.atMs }, false);
			return JSON.parse(cached.text) as T;
		}
		if (!resp.ok) {
			noteGhRateLimit(resp);
			logger.warn(`[runner-health] GET ${path} → ${await describeGhFailure(resp)}`);
			return null;
		}
		const text = await resp.text();
		const body = JSON.parse(text) as T;
		// Optional for the same reason `recordGhResponse` takes a missing bag.
		const etag = resp.headers?.get('etag') ?? null;
		// The runner listing is kept even without an ETag — it is also the shared
		// listing — but never an unreadable one: a body with no `runners` array
		// must not answer the next reader as an empty fleet.
		const keep =
			path === RUNNER_LISTING_PATH
				? Array.isArray((body as RunnerListing | null)?.runners)
				: etag !== null;
		if (keep) ghCacheStore(key, { repo, path, etag, text, atMs: fresh ? Date.now() : 0 }, true);
		return body;
	} catch (err) {
		clearTimeout(timeoutId);
		logger.warn(`[runner-health] GET ${path} failed: ${noteGhReadError(err)}`);
		return null;
	}
}

export async function ghWrite(
	method: 'POST' | 'DELETE',
	path: string,
	token: string,
	body?: unknown,
	repo = SELF_REPO
	// The BODY is returned as well as the status. Every caller until the JIT mint
	// needed only `ok`, so the response was discarded — and `generate-jitconfig`
	// answers 201 with the config IN THE BODY, so the mint created a real
	// registration and then reported failure because it could not see the reply.
): Promise<{ ok: boolean; status: number; body?: unknown }> {
	// Status 0, the same shape the transport-failure path returns. A write during
	// a blackout would 403 anyway; refusing it here means a mint fails BEFORE it
	// creates a registration nothing will answer, rather than after.
	if (ghBlackoutRemainingMs() > 0) return { ok: false, status: 0 };
	// Before the call, not after: a GET overlapping this write must not store
	// the pre-write body once it lands (see readRunnerListingShared).
	if (path.startsWith('/actions/runners')) {
		// Stale, not dropped: the ETag is still worth sending, and GitHub will
		// answer 200 if this write changed the listing.
		for (const e of ghCache.values())
			if (e.repo === repo && e.path === RUNNER_LISTING_PATH) e.atMs = 0;
		runnerWriteGen.set(repo, (runnerWriteGen.get(repo) ?? 0) + 1);
	}
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': userAgent('runner-health'),
		};
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		const resp = await fetch(ghUrl(repo, path), {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
		clearTimeout(timeoutId);
		recordGhResponse(token, resp.status, resp.headers);
		// 204 (DELETE) and any empty response parse to undefined rather than
		// throwing — a body is optional for every caller but this one.
		let parsed: unknown;
		try {
			const text = await resp.text();
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			parsed = undefined;
		}
		if (!resp.ok) {
			// Writes hit the same limits reads do, and a rate-limited label write
			// or mint used to surface only as a bare status at the call site.
			noteGhRateLimit(resp);
			const message = (parsed as { message?: string } | undefined)?.message ?? '';
			logger.warn(`[runner-health] ${method} ${path} → ${describeGhStatus(resp, message)}`);
		}
		return { ok: resp.ok, status: resp.status, body: parsed };
	} catch (err) {
		clearTimeout(timeoutId);
		logger.warn(
			`[runner-health] ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`
		);
		return { ok: false, status: 0 };
	}
}

/** `tick()` (runner-health.ts) calls this at its own start so a stale failure can never be blamed for today's. NEW: an import binding cannot be reassigned from outside its module. */
export function resetGhReadFailureForTick(): void {
	lastGhReadFailure = null;
}

/** The tick's own read of `lastGhReadFailure`, for `unreadableTickError`. NEW for the same reason as `resetGhReadFailureForTick`. */
export function currentGhReadFailure(): GhReadFailure | null {
	return lastGhReadFailure;
}

/** Full reset of this module's cross-tick cache state (process + disk), for `runner-health.ts`'s `__resetRunnerHealthAlertsForTesting`. Unlike `__restartGhCacheForTesting` above (models a restart: disk and hydration survive), this clears both. Test-only seam. */
export function __resetGhCacheStateForTesting(): void {
	ghCache.clear();
	ghCacheBytes = 0;
	ghCacheDisk.clear();
	ghCacheHydrated = true;
	runnerWriteGen.clear();
}

/**
 * The timeout + fetch + catch SKELETON every raw GitHub call in this package
 * shared, independently, before this existed (plan §4.1 F2b): four call
 * sites each hand-rolled an `AbortController` + `setTimeout` + try/catch
 * around `fetch`, with their own header set and verb. `ghGet`/`ghWrite`
 * above are NOT rebuilt on this — they already had their own tested
 * transport and a cache/blackout/classification contract this skeleton does
 * not touch; folding them in would have been a second, riskier move
 * alongside this one. This is for the sites that need the raw `Response`
 * (headers, or a status `ghGet`'s single `null` would collapse) or a header
 * set `ghGet` cannot vary (gh-budget's unauthenticated-by-version probe).
 *
 * DIVERGENCE TABLE — the four sites, what each disagreed on, and why each
 * difference stayed a per-call parameter rather than getting normalized away
 * (plan §2):
 *
 * | site | verb(s) | headers | timeout | on non-2xx | budget recording |
 * |---|---|---|---|---|---|
 * | `ci-runner-fallback.ts` `ghVar` | GET/POST/PATCH/DELETE, conditional (`If-None-Match`) | `userAgent('ci-runner-fallback')` | 10s (own local const, now this module's) | returns `{ok:false,status}`, parses GET body on 2xx | normal — `recordGhResponse` every response |
 * | `routes/fleet.ts` job-history backfill | GET only, one per job id | hand-written literal `'hadoku-mgmt-api/job-history-backfill'` (a leftover from before the 2026-08-30 extraction — normalized here to `userAgent('job-history-backfill')`, same fix `ci-runner-fallback.ts`'s own docstring already describes for itself) | NONE at all (a real gap — normalized to this module's 10s default, the "most demanding copy") | must tell a 404 (job aged out, stop asking) from any other failure — `ghGet` folds every failure into one `null`, which this caller cannot afford | normal |
 * | `runner-health.ts` `logTokenCapabilities` | GET only, one-shot at startup | `userAgent('runner-health')` | 10s (`FETCH_TIMEOUT_MS`, already this module's) | reads `x-oauth-scopes` off the HEADERS regardless of `ok` — `ghGet` returns a parsed body, never headers | normal |
 * | `gh-budget.ts` `readGhPool` | GET only, `/rate_limit` | `Accept` + `Authorization` ONLY — no `X-GitHub-Api-Version`, no `User-Agent` (kept exactly as it was; GitHub does not require either on this endpoint and the point of this move is zero behaviour change) | 10s (its own `POOL_READ_TIMEOUT_MS`, kept) | returns `null`, logs "booked unread" | **`skipBudgetRecord: true` — the ONLY caller that sets it.** GitHub does not charge `/rate_limit`; booking it would show a phantom charged call AND double-count the very reading `meterGhPool` subtracts it from (see that function's own doc) |
 *
 * NEVER TOUCHES THE PRIMARY BLACKOUT, either direction, for any caller: not
 * `ghBlackoutRemainingMs()` before the call, not `noteGhRateLimit`/
 * `noteGhReadBlackout` after. `readGhPool` must read straight through an
 * active blackout — it is what tells every OTHER caller (`ghGet`/`ghWrite`)
 * when the blackout ends, so gating it on the blackout it measures would
 * mean a spent budget could hide its own reset time from the thing timing
 * it. The other three callers never checked the blackout before this move
 * either (a genuine gap for `ci-runner-fallback.ts` and the backfill route,
 * left as-is: adding blackout-awareness to them is a BEHAVIOUR change, and
 * this move's contract is "no change to call counts or cadence" — plan §2's
 * "pure move" rule). `caller` attribution to the `[gh-budget] window ended`
 * books is untouched either way: it comes from `currentGhCaller()`
 * (`AsyncLocalStorage`, set by each site's own `withGhCaller` wrapper,
 * already in place before this move), never from which function performs
 * the fetch.
 */
export async function ghFetchRaw(
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
	url: string,
	token: string,
	opts: {
		headers: Record<string, string>;
		body?: unknown;
		timeoutMs?: number;
		/** @see this function's own doc — `readGhPool` only. */
		skipBudgetRecord?: boolean;
	}
): Promise<{ resp: Response | null; error?: string }> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
	try {
		const resp = await fetch(url, {
			method,
			headers: opts.headers,
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
			signal: controller.signal,
		});
		clearTimeout(timeoutId);
		if (!opts.skipBudgetRecord) recordGhResponse(token, resp.status, resp.headers);
		return { resp };
	} catch (err) {
		clearTimeout(timeoutId);
		return { resp: null, error: err instanceof Error ? err.message : String(err) };
	}
}
