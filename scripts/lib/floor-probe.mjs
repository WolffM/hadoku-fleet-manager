/**
 * floor-probe — the decisions the forced-placement harness makes, with no IO.
 *
 * P3.2. Everything here is specified by `docs/planning/claw-floor-design-2026-09-07.md`
 * (lane F), and the section numbers in the comments below are that document's.
 * The harness proper (`scripts/floor-probe.mjs`) does the dispatching, the
 * minting and the waiting; this file decides what a table says, whether a node
 * is flaky, whether now is a quiet window and what a probe is allowed to cost.
 *
 * SPLIT THIS WAY FOR ONE REASON: every rule below is a claim that can be wrong,
 * and a rule that only exists inside a script that talks to GitHub and ssh's to
 * six boxes cannot be exercised. `lib/queue-health.mjs` is the same shape and
 * for the same reason — "the verdict is lib/queue-health.mjs's, so the rule that
 * decides an outage is the one the tests beside it exercise, not a second copy
 * living here".
 *
 * NOTHING HERE READS A CLOCK, A FILE OR THE NETWORK. `now` is always an
 * argument. The one import below is the BUILT zone classifier and it reads
 * neither — see the note on it.
 */
import { classifyZone, zoneOf } from '../../dist/job-history-stats.js';

// ---------------------------------------------------------------------------
// §1.3 / master §5.5 — the zone classifier
// ---------------------------------------------------------------------------

/**
 * §5.5's zone classifier, and the `fleet` fold on top of it.
 *
 * DEFINED IN `src/job-history.ts`, RE-EXPORTED HERE, and that direction is
 * deliberate. The rule started life in this file because it was the harness's
 * alone; it is now also what `summarise` folds `NodeJobStats.failuresByZone`
 * with and therefore what `GET /fleet` puts on the wire. Two copies of one
 * question is `isLocalNode` over again — five implementations, one FQDN, only
 * one survivor — so the script half imports the built copy exactly as
 * `fleet-exec.mjs` imports the built `isLocalNode`. A source checkout that has
 * not been built fails LOUDLY on this import rather than quietly on a second
 * opinion.
 *
 * `classifyZone` is the three-zone rule §5.5 states and `warrantsForcedRerun`
 * below still asks IT, not `zoneOf`: a job the fleet's TTL killed is not a
 * placement question, and folding `fleet` into the function the rerun gate
 * consults would have changed that decision as a side effect of adding a
 * counter.
 */
export { classifyZone, zoneOf };

/**
 * Is this failure worth a forced re-run? §5.1 — runner or seam zone only.
 *
 * Returns `{ ok, zone, reason }` rather than a boolean, because a REFUSAL here
 * has to be explainable: "no probe was spent" and "no probe was warranted" look
 * identical from the outside, and the whole point of Control A is that a probe
 * is spent only where there is already reason to suspect the node.
 *
 * A CANCELLATION IS NEVER WORTH A PROBE, and this is the one place the
 * implementation departs from the master doc's zone table. That table says "or
 * no step record" is the runner zone, which is true and stays true — the ZONE is
 * unchanged. What does not follow is that a cancelled job is evidence about a
 * node. Measured over the live window, 2026-09-08: of 639 non-success records,
 * **420 are cancellations** (123 with no step record, 297 with one), against 219
 * genuine failures. Several fleet workflows set `cancel-in-progress`, so a push
 * that supersedes another cancels whatever was mid-flight — and the step it
 * happens to be standing on is arbitrary. Three of the sampled cancelled steps
 * are `Post Run actions/setup-node@v6`, `Update packages` and `Admin script
 * tests (python)`: the first classifies as the RUNNER zone purely because
 * teardown is where the supersede landed.
 *
 * The one cancellation shape the master doc does treat as evidence — claw-2 at
 * 01:49 showing `Set up runner[cancelled]` across three repos in one minute — is
 * identified by CORRELATION (three repos, one minute, one node), not by anything
 * visible in a single record. This rule sees one record at a time, so it cannot
 * make that call and does not pretend to.
 */
export function warrantsForcedRerun(record) {
	if (!record || !record.conclusion || record.conclusion === 'success') {
		return { ok: false, zone: null, reason: 'not a failure' };
	}
	const zone = classifyZone(record);
	if (record.conclusion === 'cancelled') {
		return {
			ok: false,
			zone,
			reason:
				'cancelled, not failed — cancel-in-progress supersedes account for 420 of the ' +
				'639 non-success records in the window, and the step one lands on is arbitrary',
		};
	}
	if (zone === 'content') {
		return { ok: false, zone, reason: "the consumer's own step failed" };
	}
	return { ok: true, zone, reason: null };
}

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

// ---------------------------------------------------------------------------
// §5 — the flaky rule
// ---------------------------------------------------------------------------

/** §5.3 — points against one triple before the verdict lands. */
export const FLAKY_POINTS = 2;
/** §5.5 — consecutive clean probes on the triple that clear it. */
export const RECOVERY_PROBES = 5;

/**
 * The separator inside a composite `(node, repo, job)` key.
 *
 * NOT A SPACE, and the escape is written out rather than typed as a literal.
 *
 * A space looks obvious and is wrong on this fleet's own data: `hadoku_site`
 * has a job called `Build variants`, so `'claw-2 WolffM/hadoku_site Build
 * variants'.split(' ')` destructures to job `'Build'` — a flaky verdict silently
 * scoped to a unit that does not exist, which is the mis-attribution §5.4 exists
 * to prevent. `\u0000` cannot occur in a repo or job name.
 *
 * SPELLED AS AN ESCAPE because the first version of this file carried the byte
 * itself. Seven of them. Everything worked — join and split agreed — but git
 * classifies a file containing a NUL as BINARY: no diff, no `git grep`, no code
 * review. A correct value that makes the file unreviewable is not an acceptable
 * trade for two characters.
 */
const TRIPLE_SEP = '\u0000';

const tripleKey = (e) => `${e.node}${TRIPLE_SEP}${e.repo}${TRIPLE_SEP}${e.job}`;

/**
 * §5 — decide `flaky-for-(node, repo, job)` from settled probe outcomes.
 *
 * `outcomes` are the harness's own settled ledger entries, oldest first. Two
 * shapes matter:
 *
 *   - `{ node, repo, job, conclusion }` — a probe that RAN on `node`. A success
 *     is the intervening pass §5.3 requires and a step toward §5.5's recovery.
 *   - `{ node, repo, job, conclusion: 'success', against: '<node>' }` — a
 *     re-dispatch that passed on a DIFFERENT node after `against` failed. That
 *     is the one point of evidence §5.2 describes.
 *
 * FOUR THINGS THIS DELIBERATELY DOES NOT DO, each named in §5:
 *
 *   - It never acts on one point. A content-zone failure that happens to
 *     coincide with a bad node is not evidence.
 *   - Scope is `(node, repo, job)`, NEVER the node alone. claw-2's OOM history
 *     is fleet overcommitment, not claw-2 incapability, and a verdict that
 *     generalised would demote a healthy claw for a scheduling mistake.
 *   - A pass on that node for that unit resets the points to zero. Two points
 *     count only "with no intervening pass".
 *   - It never EXCLUDES. A flaky verdict moves a candidate to the back of the
 *     order; `excluded` is for certainties.
 */
export function flakyVerdicts(outcomes = []) {
	const state = new Map();
	const get = (k) => {
		if (!state.has(k)) state.set(k, { points: 0, clean: 0, flaky: false });
		return state.get(k);
	};
	for (const o of outcomes) {
		if (!o || !o.node || !o.repo || !o.job) continue;
		if (o.against && o.conclusion === 'success' && o.against !== o.node) {
			// Evidence against the node that failed, not against the one that passed.
			const s = get(tripleKey({ node: o.against, repo: o.repo, job: o.job }));
			s.points += 1;
			s.clean = 0;
			if (s.points >= FLAKY_POINTS) s.flaky = true;
			continue;
		}
		const s = get(tripleKey(o));
		if (o.conclusion === 'success') {
			s.points = 0;
			s.clean += 1;
			if (s.clean >= RECOVERY_PROBES) s.flaky = false;
		} else {
			// A failure ON the node is not itself a point — §5.2 requires the
			// re-dispatch to have PASSED elsewhere. It does break a recovery run,
			// because recovery is "5 CONSECUTIVE clean probes".
			s.clean = 0;
		}
	}
	const out = [];
	for (const [k, s] of state) {
		const [node, repo, job] = k.split(TRIPLE_SEP);
		if (s.flaky) out.push({ node, repo, job, points: s.points, cleanProbes: s.clean });
	}
	return out.sort((a, b) => a.node.localeCompare(b.node) || a.repo.localeCompare(b.repo));
}

// ---------------------------------------------------------------------------
// §7 — what probing may cost
// ---------------------------------------------------------------------------

/**
 * §7 — the whole shadow allowance for one quiet-window run.
 *
 * 200 is under 5% of a single hour's 5,000-call budget even if every call
 * happened to land in the same clock hour, and it leaves the reap's measured
 * 1,620/hr untouched.
 *
 * THE FORCED RE-RUN PATH IS NOT GOVERNED BY THIS and must not be: it is a
 * POST plus the listings the failover check already makes, it fires only on a
 * genuine failure (17 in 1,030 jobs), and metering it would mean declining to
 * investigate a real fleet failure because a synthetic sweep had already spent
 * the allowance.
 */
export const SHADOW_CALL_BUDGET = 200;

/**
 * A sanity ceiling for the FORCED RE-RUN path. **This is not §7's cap.**
 *
 * §7 is explicit that the forced re-run rides the existing budget rather than
 * the shadow allowance, and the reason matters: metering it would mean declining
 * to investigate a real fleet failure because a synthetic sweep had already
 * spent the allowance. So this is not an allowance at all — it is the ceiling a
 * single re-run may not exceed however long the job takes, so a bug in the watch
 * loop cannot spin against the API. The blackout check is the part that actually
 * coordinates with the rest of the fleet, and it applies here exactly as it does
 * to the shadow path.
 */
export const RERUN_CALL_CEILING = 60;

/**
 * The calls one shadow probe makes, worst case. NOT an estimate — the harness
 * is bounded by exactly these numbers and stops when the meter says so.
 *
 * EVERY ONE OF THESE IS UNCONDITIONAL, so the ceiling IS the spend. That is the
 * distinction CLAUDE.md draws and the one the 2026-09-05 change got wrong: the
 * dispatcher's queued-runs listing sends an ETag and a 304 is genuinely free, so
 * its ceiling is not its spend; nothing here can send one, because every poll
 * below exists precisely to see state CHANGE.
 */
export const PROBE_CALLS = {
	/** POST the workflow_dispatch. */
	dispatch: 1,
	/** Finding the run id the dispatch created — it is not in the POST's reply. */
	runLookupPolls: 6,
	/** Watching the job: queued -> the runner picks it up -> completed. */
	jobPolls: 24,
	/** generate-jitconfig, plus the delete that cleans up a failed mint. */
	mint: 2,
};

export const callsPerProbe = (calls = PROBE_CALLS) =>
	calls.dispatch + calls.runLookupPolls + calls.jobPolls + calls.mint;

/** How many probes fit in the allowance. Never rounded up. */
export const maxProbesPerRun = (budget = SHADOW_CALL_BUDGET, calls = PROBE_CALLS) =>
	Math.floor(budget / callsPerProbe(calls));

/**
 * A meter, so the cap binds WITHIN a run rather than merely being asserted about
 * one.
 *
 * `FetchBudget` in job-history.ts is the same shape and for the same reason: a
 * number handed to each probe would let every probe see the full allowance and
 * spend it over again.
 */
export class CallBudget {
	constructor(limit = SHADOW_CALL_BUDGET) {
		this.limit = limit;
		this.spent = 0;
	}
	get remaining() {
		return Math.max(0, this.limit - this.spent);
	}
	/** Claim `n` calls. False once the allowance is spent — the caller STOPS. */
	take(n = 1) {
		if (this.spent + n > this.limit) return false;
		this.spent += n;
		return true;
	}
}

/**
 * The subcommand's MODE: the first argument, and only the first.
 *
 * WHY NOT `argv.find((a) => !a.startsWith('--'))`, WHICH IS WHAT THIS WAS.
 * That expression scans the WHOLE argv for the first non-flag token, so it does
 * not read a positional — it reads the first thing that is not spelled like a
 * flag, INCLUDING A FLAG'S VALUE. Measured against this command's own arguments:
 *
 *     floor-probe --unit 'WolffM/hadoku_site#lint'
 *         -> mode = "WolffM/hadoku_site#lint"   (unknown mode, exit 1)
 *     floor-probe --onto claw-6 --repo … --run …
 *         -> mode = "claw-6"                    (a NODE NAME, from a positional)
 *
 * The second one is `node-scoping.test.mjs`'s bug verbatim: `bootcamp`'s parser
 * was this exact shape, and it made `--machine=claw-7 --write` mean every node
 * including the production host. That guard flagged this file and it was RIGHT —
 * a mode was never what the expression actually read.
 *
 * So: the mode is `argv[0]`, or the fallback when the first argument is a flag
 * or absent. `git` and every other subcommand CLI works this way; a mode that
 * may appear anywhere is not a subcommand, it is a scan.
 *
 * Validation is the CALLER's: an unrecognised first argument comes back as
 * itself so the caller can say `unknown mode "…"` instead of silently falling
 * back to the default, which is how a typo becomes a table nobody asked for.
 */
export function parseMode(argv = [], fallback = 'table') {
	const first = argv[0];
	if (typeof first !== 'string' || first.startsWith('-')) return fallback;
	return first;
}

/**
 * Which flags each mode accepts. `--json` is everywhere and is not listed.
 *
 * This exists because of what the parser fix ABOVE left behind. Once the mode is
 * `argv[0]` and nothing else, `floor-probe --onto claw-6 --repo … --run …`
 * parses as no mode at all, falls back to `table`, and prints a table of the
 * busiest unit — an operator asked for a forced re-run and got an unrelated
 * report, exit 0. That is the same defect class the mode fix was for: an
 * argument that means one thing being silently read as another. Refusing is the
 * only honest answer, and it costs one map.
 */
export const MODE_FLAGS = {
	report: ['days', 'repo'],
	table: ['unit'],
	candidates: ['unit', 'timeout-sec'],
	window: [],
	probe: ['repo', 'workflow', 'job', 'node', 'ref', 'confirm', 'ignore-window'],
	rerun: ['repo', 'run', 'onto', 'confirm'],
};

/** Accepted by every mode, so never foreign. */
const UNIVERSAL_FLAGS = ['json'];

/**
 * Flags in `argv` that `mode` does not accept, each with the modes that do.
 *
 * Returns `[]` for an unknown mode: the caller's "unknown mode" message is the
 * better error, and reporting every flag as foreign on top of it would bury it.
 */
export function foreignFlags(mode, argv = []) {
	const accepted = MODE_FLAGS[mode];
	if (!accepted) return [];
	const allowed = new Set([...accepted, ...UNIVERSAL_FLAGS]);
	const out = [];
	for (const a of argv) {
		if (!a.startsWith('--')) continue;
		const name = a.slice(2).split('=')[0];
		if (!name || allowed.has(name)) continue;
		const owners = Object.keys(MODE_FLAGS).filter((m) => MODE_FLAGS[m].includes(name));
		out.push({ flag: `--${name}`, owners });
	}
	return out;
}

/**
 * May the next GitHub call go out? Returns a REASON, or null for "yes".
 *
 * Pure, and separated from the caller that actually fetches, because this is the
 * rule that decides whether the harness becomes a fourth uncoordinated caller on
 * a token that has already been to zero once. `blackoutRemainingMs` is
 * `runner-health.ts`'s own `ghBlackoutRemainingMs()` at the call site — the same
 * blackout the reap and the label sweep honour, not a second opinion about it.
 *
 * A REASON, NEVER A BARE FALSE, AND NEVER ANYTHING RESEMBLING "unchanged". A
 * spent budget, a spent allowance and a call that simply failed are three
 * different jobs, and a caller that cannot tell them apart will retry the one
 * that cannot succeed. Telling a caller its cached state is still current when
 * we did not look is the failure CLAUDE.md names first.
 */
export function probeGate(budget, blackoutRemainingMs) {
	if (blackoutRemainingMs > 0) {
		return `the primary GitHub budget is spent — ${Math.ceil(blackoutRemainingMs / 1000)}s to reset`;
	}
	if (!budget.take(1)) return `the ${budget.limit}-call probe budget is spent`;
	return null;
}

// ---------------------------------------------------------------------------
// §7 — the quiet window
// ---------------------------------------------------------------------------

/** §7 — how far back a daily cron firing still blocks the probe. */
export const QUIET_LOOKBACK_MINUTES = 15;

/**
 * §7 — may the shadow path run right now?
 *
 * Two conditions, both from §7, and the return is a REASON rather than a
 * boolean because "not now" and "I could not tell" are different jobs and the
 * caller must not treat the second as the first.
 *
 *   (a) `nodeReservation()` reports hokon is NOT reserved. Irrelevant to claws
 *       directly, but a cheap correlated signal that the fleet is not
 *       mid-nightly-fan-out.
 *   (b) None of the covered repos' staggered daily crons fired in the preceding
 *       15 minutes. Eleven of them exist, at minutes 3, 8, … 53 of hour 06 UTC
 *       (board P6.6), and this reads their SCHEDULES rather than that sentence —
 *       "a fixed window is a guess about someone else's schedule, and it goes
 *       stale silently", which is node-reservation.ts's own argument and applies
 *       here unchanged.
 *
 * `schedules` IS REQUIRED TO BE NON-EMPTY. A caller that could not read the
 * workflows gets `could-not-tell`, not a quiet window: eleven repos are known
 * to carry daily crons, so zero schedules means the reader failed, and probing
 * on that basis is exactly the "I could not look rendering as nothing is wrong"
 * failure. This is the one place this file differs from `node-reservation.ts`,
 * which fails OPEN on an unreadable profiles file — correctly, because there the
 * failure direction is "CI keeps working". Here it is "add load to a fleet that
 * may be mid-fan-out", so it fails CLOSED.
 */
export function quietWindow({
	nowMinutesOfDay,
	reserved = false,
	reservationReason = null,
	schedules = [],
	lookbackMinutes = QUIET_LOOKBACK_MINUTES,
}) {
	if (!Number.isFinite(nowMinutesOfDay)) {
		return { quiet: false, why: 'could-not-tell', detail: 'no clock' };
	}
	if (!schedules.length) {
		return {
			quiet: false,
			why: 'could-not-tell',
			detail: 'no daily cron schedules could be read — refusing to probe blind',
		};
	}
	if (reserved) {
		return { quiet: false, why: 'reserved', detail: reservationReason ?? 'hokon is reserved' };
	}
	for (const s of schedules) {
		const at = typeof s === 'number' ? s : s.minutesOfDay;
		if (!Number.isFinite(at)) continue;
		const since = (nowMinutesOfDay - at + 1440) % 1440;
		if (since < lookbackMinutes) {
			return {
				quiet: false,
				why: 'cron',
				detail: `${typeof s === 'number' ? 'a daily cron' : (s.name ?? 'a daily cron')} fired ${since}m ago`,
			};
		}
	}
	return { quiet: true, why: null, detail: null };
}

/**
 * Minutes-of-day a 5-field DAILY cron fires, or null for anything else.
 *
 * A deliberate re-derivation of `node-reservation.ts#dailyCronMinutes` over a
 * different input (GitHub workflow `schedule:` expressions, not cron-worker
 * profiles) — and the narrowness is the same on purpose: an expression with a
 * step, a list or a day-of-week constraint contributes NO window rather than a
 * half-understood one. A star-slash-10 minute field firing every ten minutes
 * would otherwise block the probe permanently, and a weekly `0 6 * * SUN` would
 * block it on the wrong day.
 */
export function dailyCronMinutes(expr) {
	if (typeof expr !== 'string') return null;
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [min, hour, dom, mon, dow] = parts;
	if (dom !== '*' || mon !== '*' || (dow !== '*' && dow !== '?')) return null;
	if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null;
	const m = Number(min);
	const h = Number(hour);
	if (m > 59 || h > 23) return null;
	return h * 60 + m;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * Rows for the per-node table this harness exists to produce.
 *
 * `manufactured` is broken out from `organic` because the two populations are
 * not interchangeable: a `forced-rerun` sample exists BECAUSE something already
 * failed, so its failure rate is conditioned on failure and means nothing on its
 * own. A table that summed them would report a fleet getting worse the more
 * carefully it was measured.
 *
 * NO GATE MAY GET EASIER TO PASS THE WORSE THE FAILURE GETS. A node so broken it
 * produces NO samples does not vanish from this table — it appears with
 * `samples: 0` and `measured: false`, because a row that disappears is a row
 * nobody notices. That is the `queue-health` p95-exclusion lesson: if you
 * exclude a category, check what happens when a real failure manufactures it.
 */
export function unitTable({ key, samples = [], roster = [] }) {
	const byNode = new Map(roster.map((n) => [n, []]));
	for (const s of samples) {
		if (!byNode.has(s.node)) byNode.set(s.node, []);
		byNode.get(s.node).push(s);
	}
	const rows = [];
	for (const [node, rs] of byNode) {
		const durations = rs
			.map((r) => r.durationSec)
			.filter((d) => typeof d === 'number' && Number.isFinite(d));
		// CANCELLED IS NOT FAILED, and counting them together makes this table
		// unreadable: 420 of the 639 non-success records in the live window are
		// cancellations, mostly `cancel-in-progress` supersedes whose step is
		// arbitrary. A `failures` column that is three-quarters supersede noise
		// would send every reader after the wrong node.
		const failures = rs.filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out');
		const cancelled = rs.filter((r) => r.conclusion === 'cancelled').length;
		rows.push({
			node,
			samples: rs.length,
			organic: rs.filter((r) => !r.probe).length,
			shadow: rs.filter((r) => r.probe === 'shadow').length,
			// `rerun`, not `forced`. The ledger already uses `forced` for a probe
			// that landed on the node it was AIMED at, and one word meaning two
			// things across two files is how a reader draws the wrong conclusion
			// from a correct number. Here it means Control A — the re-dispatch of a
			// job that already failed.
			rerun: rs.filter((r) => r.probe === 'forced-rerun').length,
			// Manufactured samples that landed where they were aimed. This is the
			// only column that is EVIDENCE ABOUT THIS NODE in the §5 sense: a probe
			// aimed at claw-2 and served by claw-1 is a real sample of claw-1 and
			// says nothing whatever about claw-2.
			pinned: rs.filter((r) => r.probe && r.intendedNode === node).length,
			p50Sec: median(durations),
			p95Sec: percentile(durations, 95),
			failures: failures.length,
			cancelled,
			// `zoneOf`, not `classifyZone`: a job the fleet's own unit TTL stopped is
			// counted as `fleet` rather than as `runner`, so a kill the fleet caused
			// is never read as a box that could not start a job. Those are different
			// repairs and the raw three-zone rule cannot tell them apart.
			zones: failures.reduce((acc, r) => {
				const z = zoneOf(r);
				acc[z] = (acc[z] ?? 0) + 1;
				return acc;
			}, {}),
			measured: rs.length >= 1,
		});
	}
	rows.sort((a, b) => (b.p50Sec ?? -1) - (a.p50Sec ?? -1) || a.node.localeCompare(b.node));
	return { key, rows, total: rows.reduce((a, r) => a + r.samples, 0) };
}

// ---------------------------------------------------------------------------
// The REPORT table — every node, every repo, read-only
// ---------------------------------------------------------------------------

/** The zone buckets, in the order the report prints them. */
export const ZONE_NAMES = ['runner', 'seam', 'content', 'fleet'];

/**
 * The per-node zone table over a WHOLE window rather than one unit.
 *
 * `unitTable` above answers "who is slow at this job"; this answers "whose
 * failures are the fleet's". Same classifier, different fold, and it exists
 * because the question issue #3 asks — is claw-2 worse than the other boxes —
 * cannot be asked one unit at a time: claw-2 served 31 pygmalion jobs in
 * fourteen days, and no rate computed on 31 samples separates anything.
 *
 * READ-ONLY BY CONSTRUCTION. It takes records and a roster and returns rows.
 * Nothing here dispatches, re-runs, mints or writes — that is the property the
 * `report` mode exists to have, and it is held by this function taking no
 * callbacks rather than by a promise in a docblock.
 *
 * `samples` must already carry a resolved `node` (`nodeOf` is the caller's, and
 * it lives in `census.ts`). Records outside the roster are NOT discarded: they
 * come back under their own `node` key with `inRoster: false`, because the
 * `github-hosted` rows and any retired box are real jobs that really failed,
 * and a table that silently dropped them would under-report the fleet's own
 * denominator.
 *
 * A NODE WITH NO DATA IS A ROW, NOT AN ABSENCE. Every roster node appears, with
 * `jobs: 0` and `why: 'no records in the window'`. That is the `queue-health`
 * lesson in its general form: a node so broken it produces no samples must not
 * vanish from the table that would have shown it, and "I could not look" must
 * never render as "nothing is wrong".
 *
 * RATES ARE NOT COMPUTED FOR A NODE THAT HAS NO DENOMINATOR. `runnerSeamPct` is
 * `null` at `jobs: 0`, never 0 — the same rule `NodeJobStats.recentMedianSec`
 * follows one level down, and for the same reason: zero-over-zero rendered as
 * 0 % draws a node nobody measured as the healthiest box in the fleet.
 */
export function nodeZoneTable({ samples = [], roster = [] } = {}) {
	const byNode = new Map(roster.map((n) => [n, []]));
	for (const s of samples) {
		const n = s.node ?? '(unattributed)';
		if (!byNode.has(n)) byNode.set(n, []);
		byNode.get(n).push(s);
	}
	const rows = [];
	for (const [node, rs] of byNode) {
		const durations = rs
			.map((r) => r.durationSec)
			.filter((d) => typeof d === 'number' && Number.isFinite(d));
		const zones = { runner: 0, seam: 0, content: 0, fleet: 0 };
		let cancelled = 0;
		let failures = 0;
		for (const r of rs) {
			if (r.conclusion === 'success') continue;
			if (r.conclusion === 'cancelled') {
				cancelled += 1;
				continue;
			}
			failures += 1;
			zones[zoneOf(r)] += 1;
		}
		const runnerSeam = zones.runner + zones.seam;
		rows.push({
			node,
			inRoster: roster.includes(node),
			jobs: rs.length,
			failures,
			cancelled,
			zones,
			// THE FIGURE THE VERDICT IS MADE ON, named rather than left to a reader
			// to add up: §5.5's two fleet-origin zones, with the fleet's own TTL
			// kills EXCLUDED because those are the fleet stopping a job, not a box
			// failing to run one.
			runnerSeam,
			runnerSeamPct: rs.length ? Number(((100 * runnerSeam) / rs.length).toFixed(3)) : null,
			repos: new Set(rs.map((r) => r.repo)).size,
			p50Sec: median(durations),
			p95Sec: percentile(durations, 95),
			why: rs.length ? null : 'no records in the window',
		});
	}
	rows.sort((a, b) => b.jobs - a.jobs || a.node.localeCompare(b.node));
	const totals = { jobs: 0, failures: 0, cancelled: 0, runner: 0, seam: 0, content: 0, fleet: 0 };
	for (const r of rows) {
		totals.jobs += r.jobs;
		totals.failures += r.failures;
		totals.cancelled += r.cancelled;
		for (const z of ZONE_NAMES) totals[z] += r.zones[z];
	}
	return { rows, totals, nodesWithNoData: rows.filter((r) => r.jobs === 0).map((r) => r.node) };
}

// ---------------------------------------------------------------------------
// §6 — never a consumer's only attempt
// ---------------------------------------------------------------------------

/**
 * Things a workflow must not do if the harness is going to dispatch it.
 *
 * A REFUSAL LIST, NOT AN APPROVAL LIST, and the distinction is the whole safety
 * argument. The primary control is that the operator names the workflow: this
 * command is operator-invoked, single repo, no cron. This backstop exists
 * because the one workflow anybody would reach for first — hadoku-pygmalion's
 * `redeploy.yml`, which holds the `test` job issue #3 is actually about — ends
 * in a `dispatch-redeploy` job that POSTs `repository_dispatch: redeploy_service`
 * to hadoku_site and takes the production pygmalion service down and back up.
 * A "shadow" run that redeploys prod is not a shadow run.
 *
 * `tests.yml` in the same repo runs the SAME timing-sensitive test with no
 * deploy on the end, which is why the probe aims there.
 */
const UNSAFE_TOKENS = [
	{ re: /repository_dispatch/i, why: 'triggers or sends a repository_dispatch' },
	{ re: /\/dispatches\b/i, why: 'POSTs to a dispatches endpoint' },
	{ re: /\bpm2\s+(restart|start|stop|reload)/i, why: 'touches a live PM2 service' },
	{ re: /\b(npm|pnpm|yarn)\s+publish\b/i, why: 'publishes a package' },
];

/**
 * May the harness dispatch this workflow as a shadow run?
 *
 * `body` is the workflow yaml WITH ITS COMMENTS ALREADY BLANKED — see
 * `blank-comments.mjs`. This repo has read a COMMENT as evidence three separate
 * times, and every one of the tokens above appears in prose in at least one
 * fleet workflow. A raw grep would refuse `tests.yml`, whose only mention of a
 * dispatch is a comment pointing at the workflow this list exists to refuse.
 */
export function shadowSafety(body) {
	const src = String(body ?? '');
	if (!/^\s*workflow_dispatch\s*:/m.test(src)) {
		return { ok: false, reason: 'no workflow_dispatch trigger — it cannot be dispatched at all' };
	}
	// Remove the trigger itself before looking for the dangerous kind: every
	// dispatchable workflow contains the word.
	const withoutTrigger = src.replace(/workflow_dispatch/g, '');
	for (const { re, why } of UNSAFE_TOKENS) {
		if (re.test(withoutTrigger)) return { ok: false, reason: why };
	}
	return { ok: true, reason: null };
}
