/**
 * THE FLEET ALLOCATION — split out to `ephemeral-warm-fleet.ts` (wave
 * shrink-1 lane B, 614-line ceiling): `WARM_INCUMBENT_RATIO`,
 * `warmUnitValues`, `WarmFleetNode` and `planWarmFleet`, re-exported here
 * under their original path so every existing importer of this module
 * keeps compiling unchanged.
 */

/** The busy-lock's other half — see {@link warmSlotLocked}. Same value as the
 * dispatcher's own SATURATED_QUEUED_MS-adjacent reasoning: GitHub's assign
 * window measured p50 9s, p90 17s, so 20s covers it with margin without
 * pinning a slot open for long after a job that never arrived. */
export const WARM_ASSIGN_WINDOW_MS = 20_000;

export interface WarmLockInput {
	/** From the GitHub API — authoritative, but polled, hence the second clause
	 * below. */
	busy: boolean;
	/** When this warm listener was last minted OR handed a job (refreshed to
	 * MRU). */
	mintedOrRefreshedAtMs: number;
	nowMs: number;
}

/**
 * May this warm slot be evicted right now?
 *
 * Two conditions, not one — see "Eviction, and the window that makes it
 * unsafe" in the design doc. `busy` alone misses the gap between GitHub
 * deciding to dispatch and the job reporting started: a listener is idle by
 * every observable signal in that window and already has work coming, so
 * evicting there kills a job that never got the chance to exist. The second
 * clause is what covers it.
 */
export function warmSlotLocked(i: WarmLockInput): boolean {
	if (i.busy) return true;
	return i.nowMs - i.mintedOrRefreshedAtMs < WARM_ASSIGN_WINDOW_MS;
}

/** A live warm slot, as observed on its node. */
export interface WarmSlotState {
	repo: string;
	busy: boolean;
	mintedOrRefreshedAtMs: number;
}

export type WarmCacheDecision =
	| { action: 'idle' } // nothing has been observed served here yet
	| { action: 'keep' } // the slot already holds the right repo
	| { action: 'fill'; repo: string } // no slot yet; mint one
	| { action: 'locked' } // wrong repo, but not safe to evict yet
	| { action: 'rotate'; from: string; to: string }; // wrong repo, safe to evict

/**
 * One job a node has already served, reduced to the two facts selection needs.
 *
 * Deliberately NOT `JobRecord`: everything in this module is pure and must not
 * depend on job-history's wire shape, and the caller has already resolved the
 * runner name to a node (`nodeOf`) by the time it gets here.
 */
export interface WarmServedJob {
	/** `owner/repo`, exactly the string that will be handed to the mint. */
	repo: string;
	/** job-history's `startedAt`, parsed. Non-finite values are dropped. */
	startedAtMs: number;
	/**
	 * How long the job held its runner (job-history's `durationSec`, in ms).
	 * Only {@link planWarmFleet} reads it, to tell a repo whose jobs run one at
	 * a time from one whose jobs OVERLAP — see {@link warmUnitValues}. Absent
	 * reads as zero: no overlap, which is the plain distinct-repo allocation.
	 * That errs toward spreading listeners, never toward an eviction.
	 */
	durationMs?: number;
}

/**
 * How far back a job counts AT ALL. Older than this and it is not evidence
 * about what the node will serve next; it is history.
 *
 * SIX HOURS, and the two measurements that fix it — both replayed from
 * `~/.hadoku-mgmt/job-history.jsonl`, see
 * `docs/planning/warm-selection-2026-09-09.md` for the scripts:
 *
 *  - BELOW 6 h the window is empty too often, and an empty window is no signal
 *    at all (`{action:'idle'}`, which keeps whatever the slot already holds).
 *    Per eligible node over the 7 days to 2026-09-09, sampling every 10 min, a
 *    window is empty at: 1 h → 67.3% of samples, 2 h → 52.6%, 3 h → 43.1%,
 *    4 h → 36.0%, 6 h → 27.1%, 12 h → 14.9%. The curve flattens after 6 h.
 *  - ABOVE 6 h buys no throughput. Replaying the cache-of-one over the same
 *    7 days, total jobs served by the warm slot is 1500 (W=3 h), 1503 (4 h),
 *    1507 (6 h), 1513 (12 h) — under 1% across a 4x change in window. What DOES
 *    keep changing above 6 h is how long a genuine shift in concentration takes
 *    to reach the slot, which is the thing the operator's "nothing is pinned"
 *    rules out. 6 h is the knee.
 *
 * 6 h also clears the busy repo's own lulls: over the same 7 days the p95
 * gap between consecutive `hadoku_site` jobs on an eligible node is 44.7 min
 * (claw-1), 155.9 (claw-3), 168.7 (claw-4) and 124.0 (claw-5), so the
 * dominant repo never falls out of its own window during a normal quiet spell.
 */
export const WARM_HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * How fast a job's vote decays INSIDE the window: after this long, a job counts
 * half as much as one that just landed.
 *
 * NINETY MINUTES, which is {@link WARM_HISTORY_WINDOW_MS} / 4, and the ratio is
 * what actually matters:
 *
 *  - THE RATIO IS THE SAFETY PROPERTY. A job at the very edge of the window
 *    still weighs `2^-(window/halfLife)` of a job that just landed, so one
 *    fresh job can outrank at most `2^(window/halfLife)` old ones. At 6 h / 90
 *    min that is 2^4 = 16: **a repo with a single job in the window can never
 *    outrank a repo with 17 or more, wherever in the window those 17 fell.**
 *    Issue #16's "a repo with one job in the window never evicts one with
 *    fifty" therefore holds with a 3x margin, structurally, not by tuning.
 *    Any change to either constant must keep `2^(window/halfLife) < 50`.
 *  - It is also where the measured yield turns the corner. Replaying this very
 *    function over the 7 days to 2026-09-09 with a 6 h window, the fraction of
 *    fills that went on to serve >=1 job is 48.1% (halfLife 45 min), 51.1%
 *    (60), 57.0% (75), **60.3% (90)**, 60.0% (105), 58.2% (120), against 41.9%
 *    for MRU. The same shape holds on a 14-day replay (50.0 / 49.3 / 54.0 /
 *    **56.0** / 56.2 / 53.2 against 41.1%), so it is not one week's weather.
 *    The bigger win is churn: 68 fills over those 7 days where MRU took 554,
 *    each fill being a DELETE, a registration-token POST and a provisioning
 *    ssh — while serving 1507 jobs against MRU's 1367.
 *  - Responsiveness, which is the other half of "nothing is pinned": a repo
 *    that stops firing halves every 90 min, so it is overtaken within a few
 *    hours rather than at the end of the window.
 *
 * ZERO IS A LEGAL VALUE AND MEANS "MRU": with no decay time at all, only the
 * single most recent job carries any weight, so the argmax is exactly the
 * last-served repo — the behaviour this selection replaced. That is the limit
 * of the formula, not a special case bolted on, and
 * `src/tests/ephemeral.test.ts` mutates it to zero and asserts MRU comes back.
 */
export const WARM_HALF_LIFE_MS = 90 * 60 * 1000;

/**
 * Scores are compared for equality within this — they are sums of powers of
 * two, so an exact tie is common (two repos with one job each at the same
 * instant) and a float-equality test would break it arbitrarily.
 *
 * Exported for `ephemeral-warm-fleet.ts`'s `assignWarmRepos`, which compares
 * the same kind of score and must use the same tolerance.
 */
export const WARM_SCORE_EPSILON = 1e-9;

/**
 * Decayed recent frequency per repo, for ONE node's history.
 *
 * Age is measured from the NEWEST job still in the window, not from `nowMs`.
 * That is deliberate and load-bearing twice over: it makes the ranking depend
 * only on how recent jobs are relative to EACH OTHER (so a tick that runs five
 * minutes after a quiet spell ranks the same as one that runs five seconds
 * after a burst), and it is what makes a half-life of zero collapse to MRU
 * rather than to "every score is zero".
 */
export function warmRepoScores(
	served: readonly WarmServedJob[],
	nowMs: number,
	opts: { windowMs?: number; halfLifeMs?: number } = {}
): Map<string, number> {
	const windowMs = opts.windowMs ?? WARM_HISTORY_WINDOW_MS;
	const halfLifeMs = opts.halfLifeMs ?? WARM_HALF_LIFE_MS;
	const scores = new Map<string, number>();
	let newestMs = -Infinity;
	for (const j of served) {
		if (!Number.isFinite(j.startedAtMs)) continue;
		if (nowMs - j.startedAtMs > windowMs) continue;
		if (j.startedAtMs > newestMs) newestMs = j.startedAtMs;
	}
	if (!Number.isFinite(newestMs)) return scores;
	for (const j of served) {
		if (!Number.isFinite(j.startedAtMs)) continue;
		if (nowMs - j.startedAtMs > windowMs) continue;
		// Clamped, so a timestamp ahead of the newest (clock skew between a node
		// and hokon) can never weigh MORE than a job that just landed.
		const ageMs = Math.max(0, newestMs - j.startedAtMs);
		const weight = halfLifeMs <= 0 ? (ageMs === 0 ? 1 : 0) : 2 ** (-ageMs / halfLifeMs);
		scores.set(j.repo, (scores.get(j.repo) ?? 0) + weight);
	}
	return scores;
}

/**
 * The repo this node's warm slot SHOULD hold, or null when the window holds
 * nothing to go on.
 *
 * Ties go to the repo already in the slot when there is one — a tie is not a
 * reason to pay a DELETE, a registration-token POST and a provisioning ssh —
 * and otherwise to the more recently served repo.
 */
export function warmTargetRepo(
	served: readonly WarmServedJob[],
	nowMs: number,
	opts: { windowMs?: number; halfLifeMs?: number; preferRepo?: string | null } = {}
): string | null {
	const scores = warmRepoScores(served, nowMs, opts);
	if (scores.size === 0) return null;
	const windowMs = opts.windowMs ?? WARM_HISTORY_WINDOW_MS;
	const latestMs = new Map<string, number>();
	for (const j of served) {
		if (!Number.isFinite(j.startedAtMs)) continue;
		if (nowMs - j.startedAtMs > windowMs) continue;
		const prev = latestMs.get(j.repo);
		if (prev === undefined || j.startedAtMs > prev) latestMs.set(j.repo, j.startedAtMs);
	}
	let best: string | null = null;
	let bestScore = -Infinity;
	for (const [repo, score] of scores) {
		if (best === null || score > bestScore + WARM_SCORE_EPSILON) {
			best = repo;
			bestScore = score;
			continue;
		}
		if (score < bestScore - WARM_SCORE_EPSILON) continue;
		if (repo === opts.preferRepo) {
			best = repo;
			continue;
		}
		if (best === opts.preferRepo) continue;
		if ((latestMs.get(repo) ?? -Infinity) > (latestMs.get(best) ?? -Infinity)) best = repo;
	}
	return best;
}

/**
 * The whole cache-of-one policy in one place, over plain data.
 *
 * DYNAMIC, nothing pinned, nothing seeded — see "The cache is DYNAMIC" in the
 * design doc, and the operator's 2026-09-09 restatement of it. What SHOULD be
 * warm is derived from the node's own job history every tick; no repo is ever
 * named in a file. `residentRepos` is the disaster backstop and is a different
 * mechanism entirely.
 *
 * The SIGNAL changed on 2026-09-09 (issue #16) and nothing else did: last-served
 * MRU became decayed recent frequency ({@link WARM_HALF_LIFE_MS}), because MRU
 * chases the repo that just went quiet. Both locks are unchanged and still sit
 * between the target and any eviction — a busy listener and one inside the
 * ~20 s assign window are `locked`, never rotated.
 *
 * NO LONGER WHAT THE TICK CALLS (wave 3k §B): the tick decides every node at
 * once through {@link planWarmFleet}, because this per-node argmax, asked on
 * every node over a shared skewed history, cannot see what the others hold.
 * It stays the one-node rule its own tests pin and the baseline the fleet
 * allocation's replay is measured against.
 */
export function planWarmCache(i: {
	current: WarmSlotState | null;
	nowMs: number;
	/** Defaults to {@link WARM_HISTORY_WINDOW_MS}. Tests override it. */
	windowMs?: number;
	/** Defaults to {@link WARM_HALF_LIFE_MS}. Zero is MRU — see there. */
	halfLifeMs?: number;
	/**
	 * The node's own served jobs, scored by {@link warmTargetRepo}. The ONLY
	 * signal: the MRU `lastServedRepo` arm this used to accept beside it was
	 * deleted in wave 3k §A, because the production call site
	 * kept passing it for twelve days after this signal was built — both arms
	 * typechecked, so nothing said the fix was inert.
	 */
	served: readonly WarmServedJob[];
}): WarmCacheDecision {
	const target = warmTargetRepo(i.served, i.nowMs, {
		windowMs: i.windowMs,
		halfLifeMs: i.halfLifeMs,
		preferRepo: i.current?.repo ?? null,
	});
	if (!target) return { action: 'idle' };
	if (!i.current) return { action: 'fill', repo: target };
	if (i.current.repo === target) return { action: 'keep' };
	if (
		warmSlotLocked({
			busy: i.current.busy,
			mintedOrRefreshedAtMs: i.current.mintedOrRefreshedAtMs,
			nowMs: i.nowMs,
		})
	) {
		return { action: 'locked' };
	}
	return { action: 'rotate', from: i.current.repo, to: target };
}
