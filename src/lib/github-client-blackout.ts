/**
 * Classifying why a GitHub call failed, and the primary-rate-limit blackout
 * that suppresses further calls until it resets. Split out of
 * `github-client.ts` (wave shrink-1 lane C, pure move) to bring that file
 * under the 600-line target.
 */
import { logger } from '../host.js';
import { ghBudgetSummary } from '../gh-budget.js';

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
export async function describeGhFailure(resp: Response): Promise<string> {
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
export function describeGhStatus(resp: Response, message: string): string {
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
export function noteGhRateLimit(resp: Response, nowMs = Date.now()): void {
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

export function noteGhReadBlackout(): void {
	lastGhReadFailure = {
		kind: 'rate-limit',
		detail: `primary rate limit spent — calls suppressed for ${Math.ceil(ghBlackoutRemainingMs() / 1000)}s more`,
	};
}

export function noteGhReadError(err: unknown): string {
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

/** `tick()` (runner-health.ts) calls this at its own start so a stale failure can never be blamed for today's. */
export function resetGhReadFailureForTick(): void {
	lastGhReadFailure = null;
}

/** The tick's own read of `lastGhReadFailure`, for `unreadableTickError`. */
export function currentGhReadFailure(): GhReadFailure | null {
	return lastGhReadFailure;
}

/** Test seam. Not part of the supported API. */
export function __resetGhBlackoutForTesting(): void {
	primaryResetAtMs = 0;
	blackoutAnnounced = false;
}
