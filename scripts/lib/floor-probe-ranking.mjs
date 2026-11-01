/**
 * floor-probe's §2-4 candidate ranking and the §1.2 demand-ledger class rule —
 * split out of `floor-probe.mjs` (wave 5q lane A, pure move) so that file
 * reaches the 800-line ceiling. No IO here either; see that file's own header
 * for why the split exists at all.
 *
 * Grouped together because `buildCandidateList` is what a demand-filtered
 * `excluded` list feeds: the two were already adjacent sections of the one
 * file this was split from.
 */
import { tripleKey } from './floor-probe-flaky.mjs';

// ---------------------------------------------------------------------------
// §3, §4 — margin and the two cold-start thresholds
// ---------------------------------------------------------------------------

/** GitHub's own default when a workflow sets no `timeout-minutes`: 360 min. */
export const DEFAULT_JOB_TIMEOUT_SEC = 21_600;
/** §3 — a candidate must clear this to be the FIRST-tried weakest node. */
export const MARGIN_BAR = 2.0;
/** §4 — measured runs before a `(repo, job)` gets a floor. */
export const MEASURED_RUNS = 10;
/** §4 — routable jobs before a claw is ranked rather than sorted last. */
export const RANKING_JOBS = 20;

/**
 * Samples of THIS `(node, unit)` before this node's p50 may outrank another's.
 *
 * THE THIRD THRESHOLD `floor-probe-2026-09-08.md` §3.4 named, and the defect it
 * names is live. Measured on `WolffM/hadoku_site#site-tests`, 2026-09-10:
 *
 *   3. claw-2   p50=87   p95=107   n=121
 *   4. claw-6   p50=86   p95=93    n=3
 *   5. claw-4   p50=81   p95=97    n=24
 *
 * claw-6 is placed between two nodes with 40x and 8x its sample count, on a p50
 * computed from THREE points: 31 s, 86 s, 93 s. The existing two thresholds
 * cannot catch it — `MEASURED_RUNS` counts the UNIT's samples (383 here) and
 * `RANKING_JOBS` counts the NODE's routable jobs across all units (well past 20)
 * — so neither says anything about how many times THIS node ran THIS job.
 *
 * WHY A MINIMUM-n RULE AND NOT A CONFIDENCE BAND: at the sample size that
 * caused the defect there is no band to compute. A distribution-free 95 %
 * interval on a median is an order-statistic interval, and the WIDEST one
 * available at n — the full range — covers only 1 − 2·(1/2)^n. That is 0.750 at
 * n=3, so claw-6's three points support no 95 % statement at all; the band rule
 * degenerates into exactly this rule precisely where it matters. Coverage
 * reaches 0.95 only at n≥6 (0.969, and only by spanning min..max), and a band
 * that can discard the extremes (the `[x₂, xₙ₋₁]` interval) first clears 0.95 at
 * n=9 (0.961). Ten is the next whole number above both, and it is the number
 * `MEASURED_RUNS` already carries, so "enough runs to believe a duration" has
 * ONE definition in this file rather than two that agree until one moves.
 *
 * It also bites exactly where the defect is and nowhere else: on this unit the
 * per-node counts are 3, 24, 30, 90, 115, 121, so every threshold from 4 to 24
 * separates claw-6 from the rest, and 10 sits in that gap with a 3.3x margin
 * below and 2.4x above. The same arithmetic says the workload join's
 * `--min-runs-per-node` default of 3 is too low — see
 * `harness-hygiene-2026-09-10.md`, where a 4-sample node produced a 2,934 %
 * "per-node" memory gap that was not per-node.
 */
export const PER_NODE_SAMPLES = MEASURED_RUNS;

export function median(xs) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function percentile(xs, p) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
	return s[i];
}

/**
 * §8 — is this claw a BATCH-LANE node for this unit?
 *
 * "A claw belongs in the batch lane (never tried first, and only ever a
 * candidate when nothing else is eligible) when its measured `p50Sec` for a
 * unit exceeds the REST of the fleet's `p95Sec` for that same unit."
 *
 * A GENERAL RULE, not a claw-5 exception — that is §8's whole point, and it is
 * why this takes the other nodes' samples rather than a hardcoded name. A node
 * with nobody to compare against is NOT batch-lane: with one candidate there is
 * no fast node being kept free, so the comparison has no meaning.
 */
export function isBatchLane(ownDurations, otherDurations) {
	if (!ownDurations.length || !otherDurations.length) return false;
	const own = median(ownDurations);
	const rest = percentile(otherDurations, 95);
	if (own === null || rest === null) return false;
	return own > rest;
}

/**
 * §2 — the ordered candidate list for one `(repo, job)`.
 *
 * `samples` are JobRecord-shaped and must already carry a resolved `node` (the
 * caller owns `nodeOf`, which lives in `census.ts` and is not this file's
 * business). `roster` is the node universe in the roster's EXISTING order, which
 * is what a cold-start list falls back to.
 *
 * WEAKEST-FIRST MEANS DESCENDING p50, NOT ASCENDING. Sorting ascending would put
 * the FASTEST node first, which is the opposite of "assign the weakest claw that
 * can carry it, keep the strongest free for bursts". The floor is the slowest
 * candidate still worth trying and it is tried FIRST.
 *
 * THE ORDER OF THE TIE-BREAK KEYS IS THE POLICY, so they are named:
 *
 *   1. `flaky`   — §5: behind every non-flaky candidate, regardless of margin.
 *   2. `batch`   — §8: never tried first.
 *   3. `unmeasured` — §4: "sorts last, not out", the same sentence the carousel
 *      already uses for idle time. Behind every measured candidate, INCLUDING
 *      ones that fail the margin bar: a node measured and known slow is a better
 *      first try than a node nobody has looked at. A node whose (node, unit)
 *      sample is THIN (`PER_NODE_SAMPLES`) is unmeasured by this key and carries
 *      `thinSample: true` to say which of the three reasons it was — three
 *      samples, zero samples, or under the 20-routable-jobs bar.
 *   4. `belowBar` — §3: a candidate under `MARGIN_BAR` is not excluded (GitHub's
 *      own timeout is still the backstop) but is not tried first.
 *   5. p50 descending — weakest first, within the group.
 *
 * WHERE A THIN CANDIDATE CAN STILL SIT ABOVE A THICK ONE, stated because the
 * ordering is a safety control and a half-true claim about it is worse than
 * none: keys 1 and 2 run first, so a node with three samples is ordered ahead of
 * a FLAKY or BATCH-LANE node that has 121. That is the pre-existing ordering for
 * an unmeasured node — it is visible in the live list, where claw-7 (n=0) sits
 * ahead of claw-5 (batch-lane, n=30) — and it is deliberate: §5 and §8 are
 * CATEGORICAL demotions out of the fast lane, decided before any duration is
 * compared, and "unknown" is a better first try than "measured three times
 * slower than the fleet". What the rule guarantees absolutely is that no
 * DURATION comparison ever puts a thin sample above a thick one.
 *
 * A NOTE ON `unmeasured` AND `excluded`. §2's `excluded` vocabulary lists
 * `unmeasured` as a reason, and §4 and §5 both say the opposite: §4 has it
 * "sorted last among equals" and §5 reserves `excluded` "for eligibility
 * failures the manifest and the ledger can state with certainty". Not having
 * measured a node is not a certainty about it. So an unmeasured node stays a
 * CANDIDATE, sorted last, with `p50Sec`/`p95Sec`/`margin` undefined and
 * `measured: false` saying why — and `excluded` carries only the four
 * eligibility reasons. Handing a caller an empty candidate list because nobody
 * has run anything there yet is exactly the cold-start failure §4 exists to
 * prevent.
 */
export function buildCandidateList({
	key,
	samples = [],
	roster = [],
	excluded = [],
	timeoutSec = DEFAULT_JOB_TIMEOUT_SEC,
	flaky = [],
	routableJobsByNode = {},
}) {
	const excludedNodes = new Set(excluded.map((e) => e.node));
	const flakySet = new Set(flaky.map((f) => tripleKey({ node: f.node, repo: f.repo, job: f.job })));
	const eligible = roster.filter((n) => !excludedNodes.has(n));

	const durationsByNode = new Map();
	for (const s of samples) {
		if (typeof s.durationSec !== 'number' || !Number.isFinite(s.durationSec)) continue;
		if (!eligible.includes(s.node)) continue;
		if (!durationsByNode.has(s.node)) durationsByNode.set(s.node, []);
		durationsByNode.get(s.node).push(s.durationSec);
	}

	const measuredTotal = [...durationsByNode.values()].reduce((a, xs) => a + xs.length, 0);
	// §4 — below 10 measured runs on this unit the ordering falls back to the
	// roster's existing order, unranked but STILL eligibility-filtered. This is
	// the fallback the handoff asks be expressed explicitly rather than left as
	// "unmeasured is excluded".
	const floorConfidence = measuredTotal >= MEASURED_RUNS ? 'measured' : 'cold-start';

	const candidates = eligible.map((node, rosterIndex) => {
		const own = durationsByNode.get(node) ?? [];
		const others = [...durationsByNode.entries()]
			.filter(([n]) => n !== node)
			.flatMap(([, xs]) => xs);
		// A node is ranked only when the UNIT has a floor AND the node itself has
		// cleared the 20-routable-jobs bar. Both, because they answer different
		// questions: the first is "do we know this job", the second "do we know
		// this box".
		const nodeRoutable = routableJobsByNode[node] ?? own.length;
		// THE THIRD THRESHOLD. `own.length > 0` was the whole of the per-(node,
		// unit) bar and it let a p50 of three points rank — see PER_NODE_SAMPLES
		// for the arithmetic and the live ordering it produced.
		const thinSample = own.length > 0 && own.length < PER_NODE_SAMPLES;
		const ranked =
			floorConfidence === 'measured' &&
			own.length >= PER_NODE_SAMPLES &&
			nodeRoutable >= RANKING_JOBS;
		const p50Sec = ranked ? median(own) : undefined;
		const p95Sec = ranked ? percentile(own, 95) : undefined;
		const margin = p95Sec ? Number((timeoutSec / p95Sec).toFixed(2)) : undefined;
		return {
			node,
			p50Sec,
			p95Sec,
			sampleCount: own.length,
			routableJobs: nodeRoutable,
			margin,
			measured: ranked,
			// WHICH KIND of unmeasured this is. `measured: false` alone cannot tell a
			// node with three samples from one with none from one under the routable
			// bar, and those are three different things to do about it: wait, probe,
			// or route more traffic. `sampleCount` carries the number either way — a
			// row that loses its samples is a row that reads as "nothing ran here".
			thinSample,
			batchLane: ranked && isBatchLane(own, others),
			flaky: flakySet.has(tripleKey({ node, repo: key.repo, job: key.job })),
			rosterIndex,
		};
	});

	if (floorConfidence === 'cold-start') {
		// Unranked: the roster's own order, untouched. Flaky and batch cannot be
		// decided without measurements either, so neither key applies here.
		candidates.sort((a, b) => a.rosterIndex - b.rosterIndex);
	} else {
		candidates.sort(
			(a, b) =>
				Number(a.flaky) - Number(b.flaky) ||
				Number(a.batchLane) - Number(b.batchLane) ||
				Number(!a.measured) - Number(!b.measured) ||
				// WITHIN THE UNRANKED GROUP ONLY, more samples first: three is not a p50
				// but it is more than zero, and an operator reading the tail should see
				// the node we know something about before the one we know nothing about.
				// Guarded on both being unranked — applied to the ranked group it would
				// order by sample count and silently overrule weakest-first, which is
				// the policy the whole sort exists to express.
				(!a.measured && !b.measured ? (b.sampleCount ?? 0) - (a.sampleCount ?? 0) : 0) ||
				Number((a.margin ?? Infinity) < MARGIN_BAR) - Number((b.margin ?? Infinity) < MARGIN_BAR) ||
				(b.p50Sec ?? -1) - (a.p50Sec ?? -1) ||
				a.rosterIndex - b.rosterIndex
		);
	}

	return {
		key,
		candidates: candidates.map(({ rosterIndex: _drop, ...c }) => c),
		excluded,
		floorConfidence,
		measuredRuns: measuredTotal,
	};
}

// ---------------------------------------------------------------------------
// §1.2 — reading the demand ledger, which now holds TWO classes
// ---------------------------------------------------------------------------

/**
 * The demand class a CI job's eligibility may be computed from.
 *
 * Wave 3-prep's settled decision: "resident demand is a second CLASS in the same
 * ledger, not a second ledger" — `{ class: "ci" | "resident", ... }` with the
 * same resource shape, so the floor reads one file. That makes an UNFILTERED
 * read of `demand-ledger.jsonl` wrong in a way it was not before: a PM2
 * service's capabilities would be unioned into a CI job's required set, every
 * claw that cannot satisfy them would land in `excluded` with reason
 * `capability`, and the candidate list for a job the fleet serves all day would
 * come back empty. An empty list is what §4's cold-start fallback exists to
 * prevent, and it would arrive wearing `excluded`'s certainty.
 */
export const CI_DEMAND_CLASS = 'ci';

/**
 * Does this demand-ledger row describe the CI job `(repo, job)`?
 *
 * THE ABSENT CLASS IS `ci`, and that is not laxness — it is what the 147 rows in
 * the live ledger look like today (measured 2026-09-10: `class` is absent on
 * every one of them). A reader that required the field would report
 * `demandKnown: false` for every unit in the fleet the moment it shipped, which
 * renders "I could not look" as the operator's problem instead of reading the
 * data that is actually there.
 *
 * AN UNRECOGNISED CLASS IS REFUSED, not folded in. `resident` is the one that
 * exists now, but the next one is somebody else's lane and this reader must not
 * silently adopt it: a row whose class this function has never heard of is
 * excluded from a CI job's demand, because the alternative is the union it
 * cannot check.
 */
export function isCiDemandRow(row, { repo, job } = {}) {
	if (!row || typeof row !== 'object') return false;
	const cls = row.class ?? CI_DEMAND_CLASS;
	if (cls !== CI_DEMAND_CLASS) return false;
	if (repo !== undefined && row.repo !== repo) return false;
	if (job !== undefined && row.job !== job) return false;
	return true;
}
