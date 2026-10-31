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
 */
const WARM_SCORE_EPSILON = 1e-9;

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

// --- the fleet allocation (wave 3k §B) ----------------------------------------

/**
 * How much a listener a node ALREADY holds is worth, relative to one it would
 * have to mint: a challenger displaces an incumbent only when its marginal
 * value is more than this many times the incumbent's.
 *
 * THIS IS THE DAMPING, and it exists because the fleet allocation is decided at
 * the boundary between the last listener granted and the first one refused,
 * which is the long tail — two or three recent jobs apiece, swapping rank every
 * time one of them runs a job. Without it every such swap is a rotation, and a
 * rotation is a DELETE, a registration-token POST and a provisioning ssh, paid
 * to hold a repo worth no more than the one just evicted. A RATIO, not a
 * margin, because the values have no fixed scale (decayed counts anchored at
 * the newest job — see {@link warmRepoScores}), so an additive margin would be
 * enormous at the head and meaningless in the tail.
 *
 * TWO, chosen by replay — `docs/planning/warm-allocation-2026-09-21.md`
 * tabulates served coverage and mints across 1, 1.5, 2, 3 and 4 over the same
 * 14 days. It does not weaken either lock (those are absolute) and it cannot
 * pin anything: an incumbent whose repo stops firing halves every
 * {@link WARM_HALF_LIFE_MS}, so it is overtaken within one half-life of a
 * challenger doubling it, and a repo that leaves the window is worth zero,
 * which no ratio protects.
 */
export const WARM_INCUMBENT_RATIO = 2;

/**
 * What the 1st, 2nd, ... `maxUnits`th warm listener for each repo is worth:
 * `values.get(repo)[k - 1]` is the decayed count of that repo's jobs that
 * started while `k - 1` of its OTHER jobs were still running.
 *
 * WHY NOT JUST THE SCORE. A warm listener serves ONE job at a time. A repo
 * whose jobs fan out — hadoku_site: of 4,766 jobs in 14 days only 801 started
 * with no other hadoku_site job running — gets from its first listener only the
 * jobs that arrive while it is free; the rest go cold unless a second listener
 * is there too. So the value of a SECOND listener for the head repo can dwarf
 * the value of a FIRST for the tenth, and ranking repos by volume alone
 * (`#54`'s "82%") counts a job as warm when the only listener that could take
 * it is already busy. Replayed, that ranking SERVED fewer jobs than the
 * per-node argmax it was meant to replace; see the doc above.
 *
 * A job whose start rank is k is served by k listeners but not by k - 1, so
 * this is exactly the marginal value of the kth. Weights are
 * {@link warmRepoScores}'s, so the values across all ranks sum to the score.
 * Jobs with no duration never overlap and all rank 1, so the whole value sits
 * on the first listener — the "Nth node takes the Nth uncovered repo" case.
 */
export function warmUnitValues(
	served: readonly WarmServedJob[],
	nowMs: number,
	maxUnits: number,
	opts: { windowMs?: number; halfLifeMs?: number } = {}
): Map<string, number[]> {
	const windowMs = opts.windowMs ?? WARM_HISTORY_WINDOW_MS;
	const halfLifeMs = opts.halfLifeMs ?? WARM_HALF_LIFE_MS;
	const inWindow = served.filter(
		(j) => Number.isFinite(j.startedAtMs) && nowMs - j.startedAtMs <= windowMs
	);
	const values = new Map<string, number[]>();
	if (!inWindow.length || maxUnits < 1) return values;
	const newestMs = Math.max(...inWindow.map((j) => j.startedAtMs));
	const byRepo = new Map<string, WarmServedJob[]>();
	for (const j of inWindow) {
		let list = byRepo.get(j.repo);
		if (!list) byRepo.set(j.repo, (list = []));
		list.push(j);
	}
	for (const [repo, list] of byRepo) {
		// Stable, so jobs that started in the same second keep file order and
		// rank one after another rather than all claiming the first listener.
		const ordered = [...list].sort((a, b) => a.startedAtMs - b.startedAtMs);
		const units = new Array<number>(maxUnits).fill(0);
		let runningEnds: number[] = [];
		for (const j of ordered) {
			runningEnds = runningEnds.filter((end) => end > j.startedAtMs);
			const rank = runningEnds.length + 1;
			const d = j.durationMs;
			runningEnds.push(j.startedAtMs + (d !== undefined && Number.isFinite(d) && d > 0 ? d : 0));
			if (rank > maxUnits) continue;
			// Same weight, and the same clamp, as warmRepoScores.
			const ageMs = Math.max(0, newestMs - j.startedAtMs);
			units[rank - 1] += halfLifeMs <= 0 ? (ageMs === 0 ? 1 : 0) : 2 ** (-ageMs / halfLifeMs);
		}
		values.set(repo, units);
	}
	return values;
}

/** One node the CALLER has already judged eligible, with what it holds now. */
export interface WarmFleetNode {
	node: string;
	current: WarmSlotState | null;
	/**
	 * Repos THIS node must not hold a listener for (fleet-manager#36): the
	 * manifest's `excludeRepos` (#82) and any repo with a kind it runs slowly
	 * (#8, `slowReposOn`). The allocation never offers this node one of them.
	 *
	 * Before this the allocator was never told: it handed claw-1 hadoku_site,
	 * the caller withheld it (slow Static Analysis), and claw-1 sat cold 62
	 * times on 2026-10-31 while hadoku-cardtable, which it can hold, went
	 * unwarmed there. A node left empty that way also read as `not-warm` to
	 * `fleet warm-canary`, every day.
	 */
	excluded?: ReadonlySet<string>;
}

const excludes = (n: WarmFleetNode, repo: string): boolean => n.excluded?.has(repo) ?? false;

const byNodeName = (a: WarmFleetNode, b: WarmFleetNode) =>
	a.node < b.node ? -1 : a.node > b.node ? 1 : 0;

/**
 * node → repo, the whole fleet at once. `null` means "nothing worth holding
 * beyond what is already granted" — the node keeps what it has, if anything.
 */
function assignWarmRepos(
	nodes: readonly WarmFleetNode[],
	values: ReadonlyMap<string, readonly number[]>,
	latestMs: ReadonlyMap<string, number>,
	locked: ReadonlySet<string>,
	ratio: number
): Map<string, string | null> {
	const out = new Map<string, string | null>();
	// Deterministic whatever order the caller observed its nodes in — the tick
	// observes them in parallel, and an allocation that depended on which ssh
	// answered first would churn on its own.
	const byName = [...nodes].sort(byNodeName);

	// 1. LOCKED NODES KEEP THEIR REPO, and each one is a listener that repo
	//    already has: the next listener anyone is granted for it is valued as
	//    its SECOND, not its first. This runs first so no ranking can move them.
	const granted = new Map<string, number>();
	for (const n of byName) {
		if (!n.current || !locked.has(n.node)) continue;
		out.set(n.node, n.current.repo);
		granted.set(n.current.repo, (granted.get(n.current.repo) ?? 0) + 1);
	}
	const free = byName.filter((n) => !out.has(n.node));
	const holders = new Map<string, WarmFleetNode[]>();
	for (const n of free) {
		// A node holding a repo it excludes is not that repo's incumbent: the
		// caller evicts it, and keeping it would re-grant the excluded slot.
		if (!n.current || excludes(n, n.current.repo)) continue;
		let list = holders.get(n.current.repo);
		if (!list) holders.set(n.current.repo, (list = []));
		list.push(n);
	}

	// 2. GREEDY BY MARGINAL VALUE, one listener at a time: each round grants the
	//    listener worth most, where a repo's next listener is worth what its
	//    (granted + 1)th serves, times the ratio while a free node already holds
	//    it. Over repos that do not overlap that is exactly "the Nth node takes
	//    the Nth most valuable uncovered repo"; over one that does, a second
	//    listener competes on what it would actually serve.
	const incumbentsLeft = new Map([...holders].map(([repo, list]) => [repo, list.length]));
	const newcomers: string[] = [];
	// One round per free node: at most one listener each.
	for (const _ of free) {
		let best: { repo: string; eff: number; incumbent: boolean } | null = null;
		for (const [repo, units] of values) {
			const k = granted.get(repo) ?? 0;
			const v = units[k] ?? 0;
			if (v <= 0) continue;
			const incumbent = (incumbentsLeft.get(repo) ?? 0) > 0;
			const eff = incumbent ? v * ratio : v;
			if (best && eff < best.eff - WARM_SCORE_EPSILON) continue;
			if (best && eff <= best.eff + WARM_SCORE_EPSILON) {
				// Ties: an incumbent, then the more recently served, then by name.
				if (best.incumbent !== incumbent) {
					if (best.incumbent) continue;
				} else {
					const bl = latestMs.get(best.repo) ?? -Infinity;
					const l = latestMs.get(repo) ?? -Infinity;
					if (l < bl || (l === bl && repo > best.repo)) continue;
				}
			}
			best = { repo, eff, incumbent };
		}
		if (!best) break;
		granted.set(best.repo, (granted.get(best.repo) ?? 0) + 1);
		if (best.incumbent) {
			const list = holders.get(best.repo) ?? [];
			const left = incumbentsLeft.get(best.repo) ?? 0;
			const keeper = list[list.length - left];
			if (keeper) out.set(keeper.node, best.repo);
			incumbentsLeft.set(best.repo, left - 1);
		} else {
			newcomers.push(best.repo);
		}
	}

	// 3. Newcomers go to the nodes whose eviction costs least: an empty slot
	//    first (a fill evicts nothing), then a displaced holder, least valuable
	//    repo first.
	const cost = (n: WarmFleetNode): number =>
		n.current ? (values.get(n.current.repo) ?? []).reduce((a, b) => a + b, 0) : -Infinity;
	//    A newcomer goes only to a node that does not exclude it; one no open
	//    node may take is dropped, and its listener is re-granted in step 4.
	const open = free.filter((n) => !out.has(n.node)).sort((a, b) => cost(a) - cost(b));
	for (const repo of newcomers) {
		const i = open.findIndex((n) => !excludes(n, repo));
		if (i < 0) {
			granted.set(repo, (granted.get(repo) ?? 0) - 1);
			continue;
		}
		out.set(open[i].node, repo);
		open.splice(i, 1);
	}

	// 4. An EMPTY node still open (nothing held, or only a repo it excludes)
	//    takes the most valuable next listener it is allowed to hold. Without
	//    this, a newcomer dropped in step 3 leaves the node cold although
	//    another repo was worth a listener there (fleet-manager#36).
	for (const n of [...open]) {
		if (n.current && !excludes(n, n.current.repo)) continue;
		let best: { repo: string; v: number } | null = null;
		for (const [repo, units] of values) {
			if (excludes(n, repo)) continue;
			const v = units[granted.get(repo) ?? 0] ?? 0;
			if (v <= 0) continue;
			if (best && v < best.v - WARM_SCORE_EPSILON) continue;
			if (best && v <= best.v + WARM_SCORE_EPSILON) {
				const bl = latestMs.get(best.repo) ?? -Infinity;
				const l = latestMs.get(repo) ?? -Infinity;
				if (l < bl || (l === bl && repo > best.repo)) continue;
			}
			best = { repo, v };
		}
		if (!best) continue;
		granted.set(best.repo, (granted.get(best.repo) ?? 0) + 1);
		out.set(n.node, best.repo);
		open.splice(open.indexOf(n), 1);
	}
	// Nothing left worth a listener: they keep what they hold, unless it is a
	// repo they exclude.
	for (const n of open)
		out.set(n.node, n.current && !excludes(n, n.current.repo) ? n.current.repo : null);
	return out;
}

/**
 * The warm cache across the WHOLE fleet, over plain data: which repo each
 * eligible node's slot should hold, decided jointly.
 *
 * WHY JOINT (wave 3k §B, issue #54). {@link planWarmCache} asks each node
 * "what have you served most?" on its own, so no node's answer can take into
 * account what another node already holds. Here the fleet's listeners are
 * granted one at a time to whichever repo the NEXT listener is worth most to
 * — see {@link warmUnitValues} for what "worth" has to mean when one listener
 * serves one job at a time.
 *
 * DYNAMIC, exactly like planWarmCache: every value is derived from the
 * fleet's served history, every tick. No repo is named anywhere;
 * `residentRepos` is a different mechanism.
 *
 * ONLY THE NODES GIVEN. Eligibility (drain, memory, backstop role) is the
 * caller's; this never widens it. Per-REPO exclusions are the caller's too,
 * passed as `WarmFleetNode.excluded`, and honoured here so a node is offered
 * a repo it may actually hold rather than one the caller must then refuse.
 *
 * BOTH LOCKS STILL SIT BETWEEN THE TARGET AND ANY EVICTION. A busy listener or
 * one inside {@link WARM_ASSIGN_WINDOW_MS} keeps its repo whatever the ranking
 * says, and counts as a listener that repo already HAS: nobody else is moved
 * onto it unless a further one is worth it in its own right. A locked node
 * reports `locked` when the unlocked allocation would warm its repo nowhere,
 * `keep` otherwise.
 *
 * STABILITY: an incumbent is ranked at {@link WARM_INCUMBENT_RATIO} x its
 * marginal value — see there for the value and why.
 *
 * COULD NOT LOOK: `served: null` (history unreadable) and an empty window both
 * hold every slot as-is — `idle` everywhere, never an eviction.
 */
export function planWarmFleet(i: {
	nodes: readonly WarmFleetNode[];
	/** The fleet's served jobs, every node's. `null` = could not read them. */
	served: readonly WarmServedJob[] | null;
	nowMs: number;
	/** Defaults to {@link WARM_HISTORY_WINDOW_MS}. */
	windowMs?: number;
	/** Defaults to {@link WARM_HALF_LIFE_MS}. */
	halfLifeMs?: number;
	/** Defaults to {@link WARM_INCUMBENT_RATIO}. 1 is no damping. */
	incumbentRatio?: number;
}): Map<string, WarmCacheDecision> {
	const decisions = new Map<string, WarmCacheDecision>();
	const windowMs = i.windowMs ?? WARM_HISTORY_WINDOW_MS;
	const values = i.served
		? warmUnitValues(i.served, i.nowMs, i.nodes.length, {
				windowMs,
				halfLifeMs: i.halfLifeMs,
			})
		: new Map<string, number[]>();
	if (!i.served || values.size === 0) {
		for (const n of i.nodes) decisions.set(n.node, { action: 'idle' });
		return decisions;
	}
	const latestMs = new Map<string, number>();
	for (const j of i.served) {
		if (!Number.isFinite(j.startedAtMs) || i.nowMs - j.startedAtMs > windowMs) continue;
		if (j.startedAtMs > (latestMs.get(j.repo) ?? -Infinity)) latestMs.set(j.repo, j.startedAtMs);
	}
	const ratio = i.incumbentRatio ?? WARM_INCUMBENT_RATIO;
	const locked = new Set(
		i.nodes
			.filter(
				(n) =>
					n.current !== null &&
					warmSlotLocked({
						busy: n.current.busy,
						mintedOrRefreshedAtMs: n.current.mintedOrRefreshedAtMs,
						nowMs: i.nowMs,
					})
			)
			.map((n) => n.node)
	);
	const actual = assignWarmRepos(i.nodes, values, latestMs, locked, ratio);
	// What the fleet would warm with no lock in the way — only to tell a locked
	// node that is merely standing still (`keep`) from one the lock is holding
	// on a repo the allocation no longer wants anywhere (`locked`).
	const wanted = new Set(
		(locked.size ? assignWarmRepos(i.nodes, values, latestMs, new Set(), ratio) : actual).values()
	);

	for (const n of i.nodes) {
		const target = actual.get(n.node) ?? null;
		if (n.current && locked.has(n.node)) {
			decisions.set(n.node, wanted.has(n.current.repo) ? { action: 'keep' } : { action: 'locked' });
		} else if (target === null) {
			decisions.set(n.node, { action: 'idle' });
		} else if (!n.current) {
			decisions.set(n.node, { action: 'fill', repo: target });
		} else if (n.current.repo === target) {
			decisions.set(n.node, { action: 'keep' });
		} else {
			decisions.set(n.node, { action: 'rotate', from: n.current.repo, to: target });
		}
	}
	return decisions;
}
