/**
 * speed-tier — a PURE model of which claws are measurably slow, built from
 * observed job history. Wave 3w / #83.
 *
 * WHY THIS EXISTS. hadoku-cardtable's `check` timed out on claw-5 (run
 * 37109806015: 262.7s against 55-80s on claw-4/9) and nothing in the fleet
 * routes around a slow box — a job queues for the first claw with room,
 * whatever that claw costs. The operator's rule (2026-10-03): "if the best
 * claws are already working, i dont necessarily want to stress them further,
 * so eventually queueing to the bottom of the barrel becomes worth it under
 * heavy load." A slow node is SPILL capacity, gated by how long a job has
 * already waited — never removed, never ranked first. This module answers
 * only "how slow, by how much, on what evidence" from measured runSec; the
 * gate itself (§A, `placement.ts`) is a different lane's file and is not
 * imported here.
 *
 * PURE ON PURPOSE. `buildSpeedModel` takes `JobRecord[]` and nothing else
 * that reaches a file or the network — no manifest read, no fs, no clock
 * except the injectable `nowMs`. That is the fixed B->A interface two lanes
 * coded against in parallel (`docs/planning/wave3w-2026-10-03.md`), and it is
 * also what makes every rule below testable over a fixture with no network
 * and no file. The interface's one ADDITIVE widening is `opts.nodes`: the
 * declared fleet node list, passed straight through to `job-history.ts`'s own
 * `nodeOf` (see "Node attribution" below) — a caller's data, not a read this
 * module performs.
 */

import { median, nodeOf, percentile, type JobRecord } from '../job-history.js';
import { jobKind } from '../lib/job-kind.js';

export type SpeedTier = 'normal' | 'slow' | 'unknown';

export interface SpeedModel {
	/** 'slow' only on measured evidence; 'unknown' when history is too thin. Never 'slow' by default. */
	tierOf(node: string): SpeedTier;
	/**
	 * Expected EXTRA seconds this job would take on `node` compared with the other
	 * claws' median for the same job: (nodeMedian - othersMedian) for (repo, job),
	 * falling back to (repo), then to the node's overall ratio x the job's others-median.
	 * null when there is nothing to estimate from.
	 */
	expectedExtraSec(node: string, repo: string, jobName: string | undefined): number | null;
	/**
	 * A continuous per-node speed factor for PLACEMENT ties (wave 3z, #83's
	 * continuous sibling): how this node's job runtimes compare to the fleet's,
	 * where 1.0 is "typical" and lower is faster. `null` exactly when
	 * `tierOf(node)` is `'unknown'` — thin history must read as NEUTRAL (the
	 * caller treats null as 1.0), never as fast or slow; this is the same
	 * MIN_KINDS confidence bar `tierOf` already enforces, not a second one.
	 *
	 * IS THE MEDIAN OF PER-KIND RATIOS — `describe(node).p50`, already computed
	 * for the tier rule — not a fresh fixed-effects regression. Verified
	 * 2026-10-05 against the real 30-day `job-history.jsonl` (5,766 usable
	 * records) against the operator's independently-fit additive-model table
	 * (claw-8 0.73, claw-4 0.85, claw-6 0.87, claw-9 1.02, claw-2 1.03, claw-1
	 * 1.23, claw-3 1.42): the p50-ratio path reproduced that exact rank order
	 * (claw-8 .60 < claw-4 .77 < claw-6 .81 < claw-9 .97 < claw-2 1.00 < claw-1
	 * 1.12 < claw-3 1.42). A second candidate — a log-residual fit against each
	 * kind's cross-node median (including the node's own samples in its own
	 * baseline) — was tried and DISCARDED: it pulled every node's own outliers
	 * toward its own baseline, inverting claw-6/claw-9's order and compressing
	 * claw-3 to 1.01 and claw-1 to 1.06, well off the measured order.
	 *
	 * OPTIONAL ON THE INTERFACE, not on the real model (`buildSpeedModel` always
	 * implements it, below). `SpeedModel` is mocked as a plain object literal in
	 * several other files' tests (`dispatcher.test.ts`, `dispatch-tick.test.ts`,
	 * `placement.test.ts` — none of them this lane's), and `tierOf`,
	 * `expectedExtraSec` and `describe` were the fixed contract those were
	 * written against. Making this ADDITIVE member required would force every
	 * one of those unrelated mocks to grow a method they have no reason to
	 * know about, outside this lane's owned files. Every real caller still gets
	 * a function (the object below always has one); `?.()` at a call site is
	 * only ever reached by a test's incomplete mock.
	 */
	factorOf?(node: string): number | null;
	/**
	 * How THIS node runs ONE exact (repo, job) kind against the other claws
	 * (#8): a node's tier is one number, and a node can be normal overall and
	 * still several times slower on one kind. claw-1 (median 1.14x, normal)
	 * ran hadoku-dataplatform's browser e2e at ~3x, on a spinning disk.
	 *
	 * `null` when there is not enough to compare: fewer than MIN_SAMPLES
	 * successful runs on the other claws, an others-median under TRIVIAL_SEC,
	 * or fewer than MIN_KIND_SAMPLES on this node. A judgement, not a verdict:
	 * the caller decides what ratio and extra are worth holding a job for.
	 *
	 * OPTIONAL ON THE INTERFACE for the same reason as `factorOf`.
	 */
	kindSlowness?(node: string, repo: string, jobName: string): KindSlowness | null;
	/** Every kind this node has a {@link kindSlowness} reading for. */
	kindsOn?(node: string): KindSlowness[];
	/** For logs and reports: the inputs behind the tier. */
	describe(node: string): {
		tier: SpeedTier;
		p25: number | null;
		p50: number | null;
		kinds: number;
	};
}

/** One node's reading on one (repo, job) kind — see {@link SpeedModel.kindSlowness}. */
export interface KindSlowness {
	repo: string;
	/** The job KIND (`jobKind`), so matrix shards share one reading. */
	job: string;
	/** Node median / other claws' median. */
	ratio: number;
	/** Node median - other claws' median, in seconds. */
	extraSec: number;
	/** Samples on this node, lower bounds included. */
	samples: number;
	/** How many of `samples` are runs that did not succeed (see MIN_KIND_SAMPLES). */
	lowerBounds: number;
}

// ---------------------------------------------------------------------------
// Constants — every one of these decided a real boundary against real data.
// ---------------------------------------------------------------------------

/**
 * How far back a record may be and still inform the model.
 *
 * A TIME window, not "whatever job-history happens to hold" — so a node that
 * is repaired, upgraded or degrades mid-window is re-tiered from what it has
 * done LATELY, never pinned to its whole remembered past (§B.3). 30 days:
 * wider than `job-history.ts`'s own `RETENTION_DAYS` (14), deliberately. That
 * makes this currently a no-op against the real file — verified 2026-10-03,
 * `~/.hadoku-mgmt/job-history.jsonl` spans 2026-09-20T06:29Z to
 * 2026-10-04T06:22Z, 14 days — and that is the point: this module's notion of
 * "recent" must not be silently redefined the day someone widens job-history's
 * own retention for an unrelated reason. A node whose repair predates this
 * window by more than 30 days is exactly the case this constant exists to stop
 * mattering.
 */
export const WINDOW_DAYS = 30;

/**
 * The ratio a node's LOWER QUARTILE (p25, across qualifying kinds) must clear
 * to be called 'slow': slow at nearly everything, not merely on average. A
 * quantile, not the median, because a node that is merely uneven (fast on some
 * kinds, slow on others — claw-1/claw-3's shape) must read as 'normal'. Its
 * lower quartile sits near 1 even when its median does not.
 *
 * THE QUARTILE, NOT THE DECILE — changed 2026-10-07. This was p10 until a
 * single kind took claw-5 out of the tier. With 9 qualifying kinds p10 is
 * effectively the MINIMUM, so the rule meant "slow at nearly everything" was
 * decided by one outlier: `hadoku-promptsmith:check` ran at 1.29x on claw-5
 * while its other eight kinds ran 2.16x-3.70x. claw-5's p10 fell from 2.04 to
 * 1.30, it read 'normal', and both #83 gates fell off at once: the spill gate
 * stopped holding work for faster nodes, and the warm path gave it a standing
 * `hadoku_site` listener, which only brings it more work. p25 tolerates one
 * or two outlier kinds at 9 kinds, and still exactly one at MIN_KINDS.
 *
 * RE-DERIVED 2026-10-07 from the real file through this module's OWN code
 * path (`nodeOf(r.runner, nodes)` with the live
 * `hadoku_site/scripts/admin/fleet-runner-manifest.json` machine list): 6,612
 * records spanning 2026-09-23 to 2026-10-07. With MIN_SAMPLES=5, MIN_KINDS=5,
 * TRIVIAL_SEC=20:
 *
 *   claw-1  15 kinds  p10 0.90  p25 1.07  p50 1.14
 *   claw-2   9 kinds  p10 0.79  p25 0.90  p50 1.00
 *   claw-3  15 kinds  p10 1.09  p25 1.23  p50 1.45
 *   claw-4  18 kinds  p10 0.55  p25 0.69  p50 0.78
 *   claw-5   9 kinds  p10 1.30  p25 2.38  p50 2.97
 *   claw-6   3 kinds  (below MIN_KINDS -> unknown)
 *   claw-8  17 kinds  p10 0.55  p25 0.58  p50 0.66
 *   claw-9  22 kinds  p10 0.79  p25 0.90  p50 0.98
 *
 * 1.8 sits in the gap between claw-5's 2.38 and the next-highest qualifying
 * p25 (claw-3's 1.23): ~0.58 of margin on either side. It isolates claw-5
 * alone. Note claw-3's p10 is now ABOVE 1 (1.09), so the decile rule's own
 * premise ("an uneven node's p10 dips below 1") no longer held either.
 */
export const SLOW_P25 = 1.8;

/**
 * Distinct (repo, job-name) kinds a node needs qualifying data on before its
 * ratios say anything about it at all. Below this: 'unknown', never 'slow' —
 * a brand-new node (a replacement box; names are never reused, see
 * `docs/VOCABULARY.md` and CLAUDE.md's "node names immutable") starts here
 * and must place like 'normal', not be judged on one or two samples.
 *
 * 5: on the real file this is exactly the line that puts claw-6 (3 kinds)
 * into 'unknown' while leaving every node with real history (9+ kinds)
 * judged — it has real, if thin, traffic, and the kind count is what is too
 * small, not the fleet's attention to it. (claw-7 reads as 0 kinds, not 3 —
 * see `SLOW_P25`'s table — because the manifest list used for that reading
 * does not currently name it; a genuinely thin node and an undeclared one
 * both land in 'unknown', for different reasons, and that is the correct
 * shared fallback for both.)
 */
export const MIN_KINDS = 5;

/**
 * Runs required on the node AND combined across the other claws, per kind,
 * before that kind's ratio is computed at all. 5: the smallest sample that
 * appears anywhere in the real per-kind breakdown and still anchors a median
 * against one outlier — an even count of 4 lets a single slow run move the
 * median outright (it becomes the average of the two middle values, one of
 * which IS the outlier); 5 has a true middle value a lone bad run cannot be.
 */
export const MIN_SAMPLES = 5;

/**
 * A kind whose OTHER-claws median duration is under this is ignored —
 * "ignore trivial kinds (an others-median under ~20s; dispatch pings measure
 * nothing)" per §B.2. A 2s job that takes 6s on one node is a 3x ratio built
 * from rounding and scheduling noise, not speed; crossing SLOW_P25 on kinds
 * like that would be a false positive manufactured by the metric itself,
 * the same shape CLAUDE.md warns against elsewhere ("no gate may get EASIER
 * to pass the worse the failure gets" — here, easier to call 'slow' the
 * smaller the job).
 */
export const TRIVIAL_SEC = 20;

/**
 * Samples a node needs on ONE kind before {@link SpeedModel.kindSlowness}
 * reads it (#8). Lower than MIN_SAMPLES on purpose. A per-kind hold only
 * delays a job by at most the extra it would cost on this node, so a false
 * reading costs a bounded wait. Waiting for five runs of a job that times out
 * here would mean five lost runs.
 *
 * LOWER BOUNDS COUNT. A run that did not succeed but outlasted the other
 * claws' median took AT LEAST that long, so it is a sample at its runSec.
 * Without this the gate gets easier to pass the worse the node is: claw-1's
 * two dataplatform e2e runs as of 2026-10-27 were a 60-minute timeout and an
 * 82-minute failure, against an others-median of ~25 minutes, and neither
 * was a success. A run that failed sooner than that median says nothing about
 * speed and is ignored.
 *
 * ONLY WHERE SUCCESSES ARE MISSING: below MIN_SAMPLES successes on this node.
 * The baseline is successes only, so adding long failures to one side alone
 * biases a flaky kind upward. Measured 2026-10-27: cardtable's forge-e2e fails
 * ~35% of runs on every claw, and claw-9 read 1.30x on its 306 successes but
 * 1.86x with its 93 long failures added. A node that keeps finishing a job is
 * measured by those finishes; one that cannot is measured by how long it ran.
 */
export const MIN_KIND_SAMPLES = 2;

/**
 * Distinct OTHER claws a kind's baseline must come from before
 * {@link SpeedModel.kindSlowness} reads it. A kind only two claws run compares
 * one node against ONE other, which measures that other node, not the fleet.
 * Measured 2026-10-27: claw-9 read 1.86x on hadoku-cardtable's forge-e2e
 * against claw-8 alone, the fastest claw, and would have lost cardtable's warm
 * listener for it.
 */
export const MIN_OTHER_NODES = 2;

// ---------------------------------------------------------------------------
// Node attribution — delegated, not parsed here.
// ---------------------------------------------------------------------------

/**
 * Which attributed names count as claws for the "others" baseline — IDENTITY
 * filtering over whatever `nodeOf` already returned, not a second parser of
 * runner names. This is also the ENTIRE mechanism by which the guest is kept
 * out of the baseline: nothing in this module spells the guest's name. A
 * node that is not `claw-<digits>` — the guest, `github-hosted`, or anything
 * `nodeOf` could not resolve — never enters `clawNodes` and so never enters
 * `othersFor`'s pool and is never tiered as a claw. Structural, the same way
 * `othersFor`'s doc below describes it, and it is what lets this file carry
 * zero occurrences of the guest's name in code (only in comments, which this
 * repo's `ecosystem-literals` gate already blanks before it counts).
 */
const CLAW_NODE = /^claw-\d+$/;

/** A record this model may learn from: it finished, it ran successfully
 * (a failed job's duration is not its speed — it is however far it got
 * before failing), it carries a measured `runSec`, it is organic traffic
 * (not a `shadow`/`forced-rerun` probe sample — see `JobRecord.probe`: a
 * `forced-rerun` is conditioned on an earlier failure and a `shadow` is a
 * synthetic placement test, neither is "how long this job normally takes"),
 * and it falls inside the window. */
function isUsable(r: JobRecord, cutoffIso: string): r is JobRecord & { runSec: number } {
	return (
		r.conclusion === 'success' &&
		typeof r.runSec === 'number' &&
		Number.isFinite(r.runSec) &&
		!r.probe &&
		r.startedAt >= cutoffIso
	);
}

/** A finished run that did NOT succeed — a lower bound on how long the job
 * takes there, read only by `kindSlowness` (see MIN_KIND_SAMPLES). */
function isLowerBound(r: JobRecord, cutoffIso: string): r is JobRecord & { runSec: number } {
	return (
		r.conclusion !== 'success' &&
		r.conclusion !== 'skipped' &&
		typeof r.runSec === 'number' &&
		Number.isFinite(r.runSec) &&
		!r.probe &&
		r.startedAt >= cutoffIso
	);
}

/** `repo` and `name` joined with a separator neither ever contains (a GitHub
 * repo slug and a job name are both NUL-free), so the pair round-trips as one
 * map key without a collision between e.g. `("a-b", "c")` and `("a", "b-c")`. */
function kindKey(repo: string, name: string): string {
	return `${repo}\u0000${jobKind(name)}`;
}

function pushSample(
	into: Map<string, Map<string, number[]>>,
	outerKey: string,
	node: string,
	sec: number
): void {
	let inner = into.get(outerKey);
	if (!inner) {
		inner = new Map();
		into.set(outerKey, inner);
	}
	const arr = inner.get(node);
	if (arr) arr.push(sec);
	else inner.set(node, [sec]);
}

/** Every OTHER claw's samples pooled, from one kind's or repo's per-node map.
 * `exclude` is the node being asked about; `claws` is the whole claw
 * universe, which never contains hokon (see `CLAW_NODE`) — this is the one
 * place "the other claws" is assembled, so hokon's exclusion is structural,
 * not a filter someone could forget to apply at a second call site. */
function othersFor(
	nodeMap: Map<string, number[]>,
	claws: ReadonlySet<string>,
	exclude: string
): number[] {
	const out: number[] = [];
	for (const other of claws) {
		if (other === exclude) continue;
		const s = nodeMap.get(other);
		if (s) out.push(...s);
	}
	return out;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export function buildSpeedModel(
	records: readonly JobRecord[],
	opts: { nowMs?: number; nodes?: readonly string[] } = {}
): SpeedModel {
	const now = opts.nowMs ?? Date.now();
	const nodes = opts.nodes ?? [];
	const cutoffIso = new Date(now - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

	// (repo, job) -> node -> runSec[], and an index of which kind-keys belong to
	// each repo — expectedExtraSec's repo-level fallback walks kinds ONE AT A
	// TIME through this index rather than pooling raw rows across job names
	// (see that fallback's own comment for why pooling was wrong).
	const byKindNode = new Map<string, Map<string, number[]>>();
	// Runs that finished without success, same window and probe rules, kept
	// apart: only `kindSlowness` reads them, and only as lower bounds.
	const lowerByKindNode = new Map<string, Map<string, number[]>>();
	const kindsByRepo = new Map<string, Set<string>>();
	const clawNodes = new Set<string>();

	// WITHOUT `opts.nodes` THIS IS A SAFE NO-OP, NOT A SILENT MIS-ATTRIBUTION.
	// `nodeOf(runner, [])` cannot find where a JIT/warm name's node ends and its
	// trailing repo slug begins without a declared list — it falls back to
	// returning the whole de-prefixed remainder, which embeds this record's own
	// job/run/epoch and so is therefore UNIQUE to this one record. Such a string
	// never recurs, never reaches MIN_SAMPLES, never enters `ratiosByNode`, and
	// never matches `CLAW_NODE` either — so every node named only through a
	// JIT/warm runner comes out `'unknown'` (describe().kinds === 0), which
	// places exactly like `'normal'` downstream. A BARE registration (a
	// standing runner, or the guest's own name) still resolves correctly with
	// no list at all, because `nodeOf` returns an unprefixed name unchanged.
	// Nothing is ever held back by a missing list; see the test pinning this.
	for (const r of records) {
		if (isLowerBound(r, cutoffIso)) {
			pushSample(lowerByKindNode, kindKey(r.repo, r.name), nodeOf(r.runner, nodes), r.runSec);
			continue;
		}
		if (!isUsable(r, cutoffIso)) continue;
		const node = nodeOf(r.runner, nodes);
		if (CLAW_NODE.test(node)) clawNodes.add(node);
		const kk = kindKey(r.repo, r.name);
		pushSample(byKindNode, kk, node, r.runSec);
		let kindsHere = kindsByRepo.get(r.repo);
		if (!kindsHere) {
			kindsHere = new Set();
			kindsByRepo.set(r.repo, kindsHere);
		}
		kindsHere.add(kk);
	}

	// node -> the per-kind ratios that qualified — the SAME list both `describe`
	// (tiering) and `expectedExtraSec`'s ratio fallback read, computed once.
	const ratiosByNode = new Map<string, number[]>();
	for (const node of clawNodes) {
		const ratios: number[] = [];
		for (const nodeMap of byKindNode.values()) {
			const nodeSamples = nodeMap.get(node);
			if (!nodeSamples || nodeSamples.length < MIN_SAMPLES) continue;
			const othersSamples = othersFor(nodeMap, clawNodes, node);
			if (othersSamples.length < MIN_SAMPLES) continue;
			const othersMed = median(othersSamples);
			if (othersMed === null || othersMed < TRIVIAL_SEC) continue;
			const nodeMed = median(nodeSamples);
			if (nodeMed === null) continue;
			ratios.push(nodeMed / othersMed);
		}
		ratiosByNode.set(node, ratios);
	}

	function describe(node: string): {
		tier: SpeedTier;
		p25: number | null;
		p50: number | null;
		kinds: number;
	} {
		const ratios = ratiosByNode.get(node) ?? [];
		const kinds = ratios.length;
		if (kinds === 0) return { tier: 'unknown', p25: null, p50: null, kinds: 0 };
		const p25 = percentile(ratios, 25);
		const p50 = percentile(ratios, 50);
		// Below MIN_KINDS: 'unknown' regardless of how high p25 reads — thin
		// evidence must never be read as 'slow' (§B.4(c)). At or above it: 'slow'
		// only when the lower quartile clears SLOW_P25; otherwise 'normal'.
		const tier: SpeedTier =
			kinds < MIN_KINDS ? 'unknown' : p25 !== null && p25 >= SLOW_P25 ? 'slow' : 'normal';
		return { tier, p25, p50, kinds };
	}

	function tierOf(node: string): SpeedTier {
		return describe(node).tier;
	}

	/** See {@link SpeedModel.factorOf}'s own doc for why this is `describe().p50`
	 * gated on the TIER (not merely `kinds > 0`): a node with 1-4 qualifying
	 * kinds has a numeric p50 but is still `'unknown'`, and `'unknown'` must
	 * read as neutral, never as a measured speed. */
	function factorOf(node: string): number | null {
		const d = describe(node);
		return d.tier === 'unknown' ? null : d.p50;
	}

	function expectedExtraSec(
		node: string,
		repo: string,
		jobName: string | undefined
	): number | null {
		// 1. Exact (repo, job): direct median difference, no gating beyond "both
		// sides have at least one sample" — unlike the tier rule, an estimate for
		// ONE queued job does not need MIN_SAMPLES/TRIVIAL_SEC confidence; it needs
		// to exist.
		if (jobName !== undefined) {
			const nodeMap = byKindNode.get(kindKey(repo, jobName));
			if (nodeMap) {
				const nodeSamples = nodeMap.get(node);
				const othersSamples = othersFor(nodeMap, clawNodes, node);
				if (nodeSamples?.length && othersSamples.length) {
					const nodeMed = median(nodeSamples);
					const othersMed = median(othersSamples);
					if (nodeMed !== null && othersMed !== null) return nodeMed - othersMed;
				}
			}
		}

		// 2. (repo) only: the node has run THIS repo, just not (provably) this
		// exact job. PER KIND, NEVER POOLED ACROSS JOB NAMES — pooling raw
		// durations across every job in the repo compares the NODE's job MIX
		// against the OTHERS' job mix, and the two mixes need not match. A node
		// that happened to run disproportionately more of a repo's SHORT jobs
		// (or the others happened to run more of its LONG ones) then reads as
		// faster than it is, however much slower it actually runs every job it
		// shares with the others — a Simpson's-paradox shape, not a rounding
		// error: measured live, `expectedExtraSec('claw-5', 'hadoku-cardtable',
		// undefined)` returned -133 (reads as FASTER) on 2026-10-04 while the
		// exact-kind level for the one job both sides share returned +149. This
		// matters more than a cosmetic sign flip: `dispatch-tick.ts` never puts
		// the job name on `PendingRun`, so production calls this with
		// `jobName: undefined` and ALWAYS lands here, never at level 1.
		//
		// So: for every (repo, job) kind this repo has seen, where the node AND
		// the others each clear `MIN_SAMPLES` (the same confidence bar used
		// everywhere else here — no second number to justify), take
		// (nodeMedian - othersMedian) for THAT kind alone, then return the
		// MEDIAN of those per-kind deltas. A kind where only one side has
		// enough samples contributes nothing, rather than being guessed at.
		const repoDeltas: number[] = [];
		for (const kk of kindsByRepo.get(repo) ?? []) {
			const nodeMap = byKindNode.get(kk);
			if (!nodeMap) continue;
			const nodeSamples = nodeMap.get(node);
			if (!nodeSamples || nodeSamples.length < MIN_SAMPLES) continue;
			const othersSamples = othersFor(nodeMap, clawNodes, node);
			if (othersSamples.length < MIN_SAMPLES) continue;
			const nodeMed = median(nodeSamples);
			const othersMed = median(othersSamples);
			if (nodeMed === null || othersMed === null) continue;
			repoDeltas.push(nodeMed - othersMed);
		}
		if (repoDeltas.length > 0) {
			const d = median(repoDeltas);
			if (d !== null) return d;
		}

		// 3. The node has never (measurably) run this repo at all — no kind
		// qualified above. Fall back to how slow the node runs OVERALL — the
		// median of its own qualifying per-kind ratios, the same number
		// `describe().p50` reports — applied to whatever baseline duration this
		// job has on the other claws: (repo, job) if they have run it, else a
		// representative per-kind baseline for the repo (median of each
		// qualifying kind's OTHERS-median, never raw others rows pooled across
		// kinds — the same like-with-like rule as level 2, applied to the one
		// side that still has data).
		const ratios = ratiosByNode.get(node) ?? [];
		if (ratios.length === 0) return null;
		const overallRatio = median(ratios);
		if (overallRatio === null) return null;

		let othersMed: number | null = null;
		if (jobName !== undefined) {
			const nodeMap = byKindNode.get(kindKey(repo, jobName));
			if (nodeMap) {
				const othersSamples = othersFor(nodeMap, clawNodes, node);
				if (othersSamples.length) othersMed = median(othersSamples);
			}
		}
		if (othersMed === null) {
			const perKindOthersMeds: number[] = [];
			for (const kk of kindsByRepo.get(repo) ?? []) {
				const nodeMap = byKindNode.get(kk);
				if (!nodeMap) continue;
				const othersSamples = othersFor(nodeMap, clawNodes, node);
				if (!othersSamples.length) continue;
				const m = median(othersSamples);
				if (m !== null) perKindOthersMeds.push(m);
			}
			othersMed = perKindOthersMeds.length ? median(perKindOthersMeds) : null;
		}
		if (othersMed === null) return null; // nothing anywhere to estimate from
		return (overallRatio - 1) * othersMed;
	}

	function slownessOf(node: string, kk: string): KindSlowness | null {
		// Claws only, like the tier: the guest is judged by the backstop, not here.
		if (!CLAW_NODE.test(node)) return null;
		const nodeMap = byKindNode.get(kk);
		if (!nodeMap) return null;
		const otherNodes = [...clawNodes].filter((n) => n !== node && nodeMap.has(n));
		if (otherNodes.length < MIN_OTHER_NODES) return null;
		const othersSamples = othersFor(nodeMap, clawNodes, node);
		if (othersSamples.length < MIN_SAMPLES) return null;
		const othersMed = median(othersSamples);
		if (othersMed === null || othersMed < TRIVIAL_SEC) return null;
		const ok = nodeMap.get(node) ?? [];
		const lower =
			ok.length < MIN_SAMPLES
				? (lowerByKindNode.get(kk)?.get(node) ?? []).filter((sec) => sec > othersMed)
				: [];
		const samples = [...ok, ...lower];
		if (samples.length < MIN_KIND_SAMPLES) return null;
		const nodeMed = median(samples);
		if (nodeMed === null) return null;
		const [repo, job] = kk.split('\u0000');
		return {
			repo,
			job,
			ratio: nodeMed / othersMed,
			extraSec: nodeMed - othersMed,
			samples: samples.length,
			lowerBounds: lower.length,
		};
	}

	function kindSlowness(node: string, repo: string, jobName: string): KindSlowness | null {
		return slownessOf(node, kindKey(repo, jobName));
	}

	function kindsOn(node: string): KindSlowness[] {
		const out: KindSlowness[] = [];
		for (const kk of byKindNode.keys()) {
			const k = slownessOf(node, kk);
			if (k) out.push(k);
		}
		return out;
	}

	return { tierOf, expectedExtraSec, factorOf, kindSlowness, kindsOn, describe };
}
