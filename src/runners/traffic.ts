/**
 * TRAFFIC — who gets the next job, among the nodes that could take it.
 *
 * THE TWO QUESTIONS ARE SEPARATE:
 *
 *   CAN this node run this job?   Capability, drain, health, admission —
 *                                 `choosePlacement` in placement.ts.
 *   SHOULD it get THIS one?       Ordering. This file.
 *
 * `choosePlacement` walks this order and refuses any node that cannot take the
 * job, so an ordering here can never hand a job to a node that cannot run it.
 *
 * `choosePlacement` ALSO RE-RANKS what this function produced, for the ONE job
 * it is placing (#102, wave 4c): busy counted here is a per-TICK snapshot,
 * while a burst within one tick needs each placement to see the ones before
 * it. Warm affinity (P5.1) and heavy-kind avoidance (#102.4) live there too,
 * as TIE-BREAKS layered on top of THIS function's own busy/speed/idle/name
 * ranking — never a second ranking that can disagree with it. See
 * `choosePlacement`'s own doc for the full comparator and why it was pulled
 * out of an unconditional stable-sort that used to override busy entirely.
 *
 * ONE ORDERING, DERIVED FROM OBSERVED LOAD: fewest busy runners first, then the
 * fastest MEASURED node, then the node idle longest. Not a round-robin counter
 * — a counter is a DECLARATION of what should have happened, and it drifts from
 * what did (a restart resets it, a job that failed to start still advanced it,
 * work GitHub assigned directly is invisible to it). Observed load is
 * self-correcting and needs no state.
 *
 * THE SPEED STEP IS A TIE-BREAK, NEVER A PRIORITY (wave 3z, #83's continuous
 * sibling — operator, 2026-10-05: "if the best claws are already working, i
 * dont necessarily want to stress them further"). It sits strictly AFTER
 * `busy`: a busy fast node never beats an idle slow one. Among nodes tied on
 * `busy` it breaks the tie `longest idle` used to own alone — a free claw-3
 * (measured factor ~1.4) and a free claw-8 (~0.6) used to take work in
 * rotation; now the faster one wins the tie and idle time only decides a
 * further tie between two nodes of equal (or unmeasured) speed.
 *
 * WHY ONLY ONE. There used to be a `tiered` policy walking a hand-maintained
 * ladder in `runner-tiers.json`, selected by that file's `trafficPolicy` key.
 * The key never reached the dispatcher — the tick built the dispatch input
 * without it — so JIT placement ran `tiered` over the fleet manifest's JSON KEY
 * order while the operator had configured `carousel`. That is why claw-1, the
 * first key, took 47% of dispatcher-placed jobs over the 24h to 2026-09-09. The
 * ladder and the key were retired on 2026-09-21; per-node limits (thermal or
 * otherwise) are `maxConcurrent` in the fleet manifest, which admission enforces.
 */

import { percentile, type JobRecord } from '../job-history.js';
import { jobKind } from '../lib/job-kind.js';

/** What the ordering needs to know about a candidate. Deliberately minimal. */
export interface TrafficNode {
	name: string;
	/** Runners on this node GitHub currently reports as running a job. */
	busy: number;
	/**
	 * Can GitHub actually place a job here?
	 *
	 * From runners/schedulable.ts, which exists because "the box has room" and
	 * "GitHub can reach it" come apart exactly when a node is broken in the way
	 * that matters most: on 2026-09-02 claw-4 answered ssh, ran zero workers and
	 * reported two free slots, while all 26 of its registrations were offline
	 * and crash-looping.
	 *
	 * CAROUSEL MAKES THAT FAILURE WORSE IF IT IGNORES THIS. Ordering by "fewest
	 * busy" ranks a node with zero working registrations FIRST — it looks
	 * perfectly idle — so an unschedulable node would win every placement and
	 * the whole queue would pile onto the one box that cannot take it.
	 *
	 * `undefined` means nobody looked, and is treated as schedulable: absent
	 * evidence must not silently remove a working node from the fleet.
	 */
	schedulable?: boolean;
	/**
	 * Seconds since this node last finished or started work, if known.
	 *
	 * `null` means nobody looked — which is NOT "idle forever". It sorts LAST
	 * among equals rather than first, so an unmeasured node never wins a
	 * tie-break it did not earn.
	 */
	idleSeconds: number | null;
	/**
	 * This node's measured speed factor from `SpeedModel.factorOf` (#83's
	 * continuous sibling, wave 3z): 1.0 is typical, lower is faster, higher is
	 * slower. `null` means the node's history is too thin to judge (`'unknown'`
	 * tier) — treated as exactly 1.0 (NEUTRAL), never as fast or slow, so a
	 * brand-new or thin-history node competes on `busy`/idle alone rather than
	 * being favored OR penalized for a measurement nobody has yet.
	 */
	speedFactor: number | null;
}

/**
 * Order the candidates a job may be placed on.
 *
 * `candidates` is every node the caller vetted, in any order; the result is a
 * permutation of it. Ties that survive load, measured speed and idle time fall
 * back to the node NAME, so the order is a pure function of what was observed
 * — never of which node a file happens to list first.
 */
export function orderCandidates(
	candidates: readonly string[],
	nodes: readonly TrafficNode[]
): string[] {
	const byName = new Map(nodes.map((n) => [n.name, n]));
	const known = candidates.filter((n) => byName.has(n));
	const unknown = candidates.filter((n) => !byName.has(n)).sort();

	// UNSCHEDULABLE NODES GO LAST, never out. Dropping them would silently shrink
	// the fleet on a transient GitHub read; ranking them last means a job reaches
	// them only when nothing else can take it, which is the correct weight for
	// "we believe GitHub cannot place here". Ordering by "fewest busy" alone would
	// rank a node with zero working registrations FIRST — it looks idle.
	const placeable = known.filter((n) => byName.get(n)?.schedulable !== false);
	const unplaceable = known.filter((n) => byName.get(n)?.schedulable === false).sort();

	const sorted = [...placeable].sort((a, b) => {
		const x = byName.get(a)!;
		const y = byName.get(b)!;
		// 1. Fewest jobs in flight. This is the whole point: spread the work.
		if (x.busy !== y.busy) return x.busy - y.busy;
		// 2. Fastest MEASURED node (#83's continuous sibling). `null` (thin
		//    history, `'unknown'` tier) reads as exactly 1.0 — NEUTRAL, so an
		//    unmeasured node competes on this step like a typical one rather than
		//    winning or losing a tie-break nobody earned. This is a TIE-BREAK
		//    after `busy`, never ahead of it — see this file's header comment.
		const xf = x.speedFactor ?? 1.0;
		const yf = y.speedFactor ?? 1.0;
		if (xf !== yf) return xf - yf;
		// 3. Idle longest first, so equals rotate. An unmeasured node (`null`)
		//    sorts last among equals: it must not win a tie-break it did not earn.
		const xi = x.idleSeconds ?? -1;
		const yi = y.idleSeconds ?? -1;
		if (xi !== yi) return yi - xi;
		// 4. Name, so a genuine tie is still deterministic.
		return a < b ? -1 : a > b ? 1 : 0;
	});

	// Nodes with no observation go last, never first. An unmeasured node looks
	// idle to every heuristic here, and promoting it on that basis is how a box
	// nobody has looked at attracts the whole queue.
	return [...sorted, ...unplaceable, ...unknown];
}

// ---------------------------------------------------------------------------
// HEAVY KINDS (#102) — derived, never declared, from REAL job history.
// ---------------------------------------------------------------------------

/**
 * A pure model of which (repo, job) KINDS run long enough that stacking them
 * on one node is what turned cardtable's first Forge night into four reruns
 * and three widened budgets (wave 4c, #102): three Forge jobs landed on
 * claw-9 at once and `forge-e2e` took 35 minutes instead of 16 alone.
 *
 * DERIVED, NEVER DECLARED — no label, no per-repo list (CLAUDE.md,
 * `docs/planning/wave4c-2026-10-07.md` "Settled"). A kind is heavy when its
 * MEASURED p75 runtime clears {@link HEAVY_P75_SEC}; see that constant's own
 * doc for the real table it was picked from.
 */
export interface HeavyModel {
	/**
	 * Is THIS (repo, job) kind heavy? Exact match when `jobName` is known —
	 * which it is for a QUEUED job since `dispatch-tick.ts`'s `pending.push`
	 * already carries `j.name` onto `PendingRun.jobName` (#89, landed before
	 * this wave). `jobName: undefined` falls back to {@link isHeavyRepo}: a
	 * caller that cannot name the job (see that method's own note) gets the
	 * coarser, conservative answer rather than a crash or a silent `false`.
	 */
	isHeavy(repo: string, jobName: string | undefined): boolean;
	/**
	 * Does this REPO run ANY heavy kind at all — the only answer available
	 * for a node's CURRENTLY RUNNING workers, whose job NAME the fleet probe
	 * cannot see without a new per-job read. `ephemeral-tick.ts`'s probe
	 * attributes a running `Runner.Worker` to a REPO only (`.runner`'s
	 * `gitHubUrl`, read off the process tree) and never to a job name —
	 * genuinely unavailable without new I/O (CLAUDE.md: "pick the most
	 * faithful approximation, documented"). This is that approximation, and
	 * it is deliberately CONSERVATIVE in one direction only: a light job from
	 * a repo that also runs heavy ones reads as "running heavy" here. The
	 * cost of that is a missed spreading opportunity — ranking a node
	 * slightly lower than it needed to be — never a wrong REFUSAL, because
	 * every place this feeds (`placement.ts`'s heavy-avoidance term,
	 * `ephemeral-tick.ts`'s warm-fill withholding) only ever REORDERS or
	 * WITHHOLDS a fill, never refuses a mint outright (#102.4: "a heavy job
	 * still places (never queue forever)").
	 */
	isHeavyRepo(repo: string): boolean;
}

/**
 * Samples a (repo, job) kind needs before its p75 says anything — the same
 * confidence bar `speed-tier.ts`'s `MIN_SAMPLES` uses and for the same
 * reason: an even count lets one outlier move a quantile outright, and below
 * this a kind is simply unproven — NOT heavy, the safe default, same as a
 * thin-history node reading `'unknown'` rather than `'slow'`.
 */
export const MIN_HEAVY_SAMPLES = 5;

/**
 * The p75 runtime (seconds) a (repo, job) kind must clear to be called heavy.
 *
 * RE-DERIVED 2026-10-07 from the real `~/.hadoku-mgmt/job-history.jsonl`
 * (6,799 records, the file's whole span: 2026-09-23 to 2026-10-07 — job-
 * history.ts's own 14-day retention already bounds the window, so this model
 * takes no separate one) through this module's own code path
 * (`percentile(samples, 75)`, `MIN_HEAVY_SAMPLES` = 5), sorted by p75:
 *
 *   hadoku_site          Static Analysis   n=12   p75=1713s
 *   hadoku-cardtable     forge-jvm         n=37   p75=1320s
 *   hadoku-cardtable     forge-e2e         n=111  p75= 575s
 *   hadoku-dataplatform  pytest            n=37   p75= 564s
 *   ------------------------------------------------------- 420s -----------
 *   hadoku-pygmalion     test              n=31   p75= 292s
 *   hadoku-cardtable     check             n=166  p75= 245s
 *   hadoku-scraper       check             n=29   p75= 232s
 *   hadoku_site          build             n=167  p75= 137s
 *
 * 420 sits in the gap between 292 and 564 — ~128s of margin on either side —
 * and isolates exactly the four kinds this wave's incident named: cardtable's
 * two Forge jobs, dataplatform's GPU-bound pytest, and hadoku_site's periodic
 * static-analysis sweep. Every other measured kind on the fleet, including
 * every OTHER cardtable job (`check`, `dispatch redeploy`, `changes`), sits
 * well below it.
 */
export const HEAVY_P75_SEC = 420;

/**
 * The share of a repo's jobs that must be heavy kinds before the REPO counts as
 * heavy — `isHeavyRepo`, the coarse answer used where a running job's name is
 * not visible (the warm tick's probe, `runningHeavy`).
 *
 * Measured 2026-10-09 over the job history: hadoku_site 12 of 4,030 (0.3%,
 * Static Analysis only), hadoku-dataplatform 35 of 252 (14%, pytest),
 * hadoku-cardtable 461 of 1,549 (30%, forge-e2e/forge-jvm). Without a share,
 * one rare nightly kind made every hadoku_site build "running heavy", so a
 * hadoku_site build on claw-1 evicted claw-1's own hadoku_site warm listener —
 * claw-1, which never runs a heavy job. 10% sits in the gap between 0.3% and
 * 14%. The EXACT per-job answer (`isHeavy` with a job name) is unaffected.
 */
export const HEAVY_REPO_MIN_SHARE = 0.1;

/** `repo` and `name` joined with a separator neither ever contains — the same
 *  trick `speed-tier.ts`'s `kindKey` uses, kept as a private duplicate rather
 *  than imported: that file is unowned this wave (CLAUDE.md "owned by nobody"),
 *  and this model must not depend on an unowned file's internals to stay
 *  correct. */
function heavyKindKey(repo: string, name: string): string {
	return `${repo}\u0000${jobKind(name)}`;
}

/**
 * Build the heavy-kind model from job history — pure, like `buildSpeedModel`:
 * no fs, no network, no clock. The caller (`ephemeral-tick.ts`) is the one
 * reader of `~/.hadoku-mgmt/job-history.jsonl`; this takes the records it
 * already loaded, the same "no second reader" rule `speed-tier.ts` follows.
 */
export function buildHeavyModel(records: readonly JobRecord[]): HeavyModel {
	const samplesByKind = new Map<string, number[]>();
	const jobsByRepo = new Map<string, number>();
	for (const r of records) {
		// Same usability bar as `speed-tier.ts`'s `isUsable`, restated here rather
		// than imported for the same unowned-file reason as `heavyKindKey` above:
		// a failed job's duration is how far it got before failing, not its
		// normal runtime, and a probe sample (`shadow`/`forced-rerun`) is a
		// synthetic placement test, not organic traffic.
		if (r.conclusion !== 'success') continue;
		if (typeof r.runSec !== 'number' || !Number.isFinite(r.runSec)) continue;
		if (r.probe) continue;
		jobsByRepo.set(r.repo, (jobsByRepo.get(r.repo) ?? 0) + 1);
		const kk = heavyKindKey(r.repo, r.name);
		const arr = samplesByKind.get(kk);
		if (arr) arr.push(r.runSec);
		else samplesByKind.set(kk, [r.runSec]);
	}

	const heavyKinds = new Set<string>();
	const heavyJobsByRepo = new Map<string, number>();
	for (const [kk, samples] of samplesByKind) {
		if (samples.length < MIN_HEAVY_SAMPLES) continue;
		const p75 = percentile(samples, 75);
		if (p75 !== null && p75 >= HEAVY_P75_SEC) {
			heavyKinds.add(kk);
			// The repo half of the key, up to the NUL separator — never a second
			// split of `r.repo` itself, which may contain no NUL by construction
			// (a GitHub repo slug cannot).
			const repo = kk.slice(0, kk.indexOf('\u0000'));
			heavyJobsByRepo.set(repo, (heavyJobsByRepo.get(repo) ?? 0) + samples.length);
		}
	}
	const heavyRepos = new Set(
		[...heavyJobsByRepo]
			.filter(([repo, n]) => n / (jobsByRepo.get(repo) ?? n) >= HEAVY_REPO_MIN_SHARE)
			.map(([repo]) => repo)
	);

	return {
		isHeavy(repo, jobName) {
			if (jobName === undefined) return heavyRepos.has(repo);
			// EXACT KIND KNOWN: trust it either way, never fall back to the
			// coarser repo-level answer once the precise one is in hand — a light
			// job from a heavy repo must not read as heavy just because its
			// sibling kind is.
			return heavyKinds.has(heavyKindKey(repo, jobName));
		},
		isHeavyRepo(repo) {
			return heavyRepos.has(repo);
		},
	};
}
