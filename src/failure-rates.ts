/**
 * failure-rates — a per-node CI failure rate judged against the FLEET's rate
 * for the SAME (repo, job kind), not against the fleet's overall average.
 * Refactor plan §7.3, T3. PURE: no file, no network, no clock read. Every
 * input is a caller-supplied {@link DayRollup} (the T2 daily store,
 * `job-rollup-store.ts`) and every output is a value.
 *
 * WHY "AGAINST THE SAME CELL" AND NOT A RAW PER-NODE RATE. The 16 GB heavy
 * rule (AGENTS.md) steers memory-hungry job kinds toward the nodes that can
 * hold them, so nodes do not see the same MIX of work. A raw per-node failure
 * rate mostly measures which claw gets handed the hardest jobs, not which
 * claw is bad at them. `job-rollups.ts` was built for exactly this
 * comparison: every (day, repo, kind) carries one row per node AND one FLEET
 * row (`node: '*'`), so "the fleet's own rate for this exact cell" is
 * something this module reads back rather than re-derives — see that file's
 * header, "A node's failure rate against the fleet's for the same work (T3)
 * is one lookup."
 *
 * THE STATISTIC: A STANDARDIZED EXCESS, SUMMED OVER CELLS. For node N and
 * cell c=(repo,kind), the fleet row gives a baseline rate `q_c` for the
 * zones under test (see below). Node N's cell is one Bernoulli trial per job
 * at that SAME rate under the null hypothesis "N is not different from the
 * fleet here." Summed across every cell N appears in:
 *
 *   observed  = Σ N's own failures in the zones under test
 *   expected  = Σ N's jobs in cell c × q_c
 *   excess    = observed − expected
 *   variance  = Σ N's jobs in cell c × q_c × (1 − q_c)      (binomial, per cell)
 *   z         = excess / √variance
 *
 * This is a sum of independent, non-identically-distributed Bernoulli trials
 * — a Poisson-binomial sum — standardized by its own variance: the same shape
 * as an indirect-standardized incidence ratio (epidemiology) or a funnel-plot
 * control limit (healthcare quality monitoring), both built for exactly this
 * problem: many small, heterogeneous strata, one pooled verdict per unit.
 * CHOSEN OVER Fisher's exact (what the hand-written `failures-by-node-*.md`
 * docs this replaces used): Fisher is built for ONE 2×2 table. T3's whole
 * point is pooling dozens of tiny, heterogeneous (repo,kind) cells into one
 * per-node verdict, and running Fisher once per cell would need either a
 * multiple-comparisons correction or picking a single cell to trust — most
 * cells here are far too small for an exact test individually, while their
 * SUM has enough trials for the normal approximation (Lyapunov CLT) to hold.
 * `z` is converted to a ONE-SIDED p-value (is N worse than the fleet, not
 * merely different) via the standard normal CDF.
 *
 * THE SIGNIFICANCE FLOOR. The normal approximation to a sum of Bernoullis is
 * only trustworthy once the expected count clears roughly 5 — the same rule
 * of thumb a chi-square/z test conventionally uses, and the fleet's own
 * organic-traffic power analysis (`failures-by-node-2026-09-15.md` §5) found
 * nothing subtler than a ~5-10x effect is detectable within a month anyway.
 * A node (or a cell) below its floor is reported `insufficientData: true`
 * with `z`/`pValue` withheld — never folded into "healthy", per CLAUDE.md's
 * "'I could not look' must never render as 'nothing is wrong'".
 *
 * ZONES UNDER TEST. `failuresByZone` (`job-history-stats.ts`) splits every
 * non-success job into `runner` (the fleet's own setup), `seam` (a step the
 * workflow named but did not write), `content` (the consumer's own test),
 * `fleet` (a unit-TTL kill) and `cancelled` (superseded, unclassified). The
 * default statistic counts only `runner`+`seam` — "fleet-origin" failures,
 * the same `runner+seam` ("r+s") figure `fleet-report-types.ts` and every
 * `failures-by-node-*.md` report already use, because a node that merely
 * hosts a flaky TEST (`content`) is not a node with a problem. Every zone is
 * still folded per-node (`zoneExcess`) so a reader can see WHY a node is
 * flagged, not only THAT it is.
 */
import type { FailuresByZone } from './job-history-zone.js';
import type { DayRollup } from './job-rollups.js';

/** Mirrors `FailuresByZone`'s five keys. Cross-checked against the real shape in tests. */
export const ALL_ZONES = ['runner', 'seam', 'content', 'fleet', 'cancelled'] as const;
export type FailureZoneName = (typeof ALL_ZONES)[number];

/** The established "fleet-origin" failure definition — see the module header. */
export const FLEET_ORIGIN_ZONES: readonly FailureZoneName[] = ['runner', 'seam'];

export interface FailureRateOptions {
	/** Only days with `day >= fromDay` (UTC, `YYYY-MM-DD`). */
	fromDay?: string;
	/** Only days with `day <= toDay`. */
	toDay?: string;
	/** Which zones count as a "failure" for `observed`/`expected`/`excess`/`z`. Default {@link FLEET_ORIGIN_ZONES}. */
	zones?: readonly FailureZoneName[];
	/**
	 * A cell's FLEET-WIDE job count below this is too thin to trust as a
	 * baseline rate — one failure either way would swing it. Default 20.
	 */
	minCellFleetJobs?: number;
	/** A node's pooled job count (over included cells) below this is `insufficientData`. Default 30. */
	minNodeJobs?: number;
	/** A node's pooled EXPECTED count below this is `insufficientData` — the normal-approximation floor. Default 5. */
	minExpected?: number;
	/** The rollup row that folds every node. Must match `job-rollups.FLEET_NODE`. Default `'*'`. */
	fleetNode?: string;
}

/** One (repo, kind) cell a node appears in but could not be judged against. */
export interface ExcludedCell {
	repo: string;
	kind: string;
	/** The fleet's total jobs in this cell — why it fell below {@link FailureRateOptions.minCellFleetJobs}. */
	fleetJobs: number;
	/** This node's own jobs in the excluded cell — counted, never silently dropped. */
	nodeJobs: number;
}

/** One zone's observed vs. expected-at-the-fleet's-rate count, for one node, summed over its included cells. */
export interface ZoneTally {
	observed: number;
	expected: number;
	excess: number;
}

export interface NodeFailureRate {
	node: string;
	/** (repo, kind) cells with enough fleet-wide sample to judge this node against. */
	cellsIncluded: number;
	/** Cells this node appears in that could not be judged — see {@link excludedCells}. */
	cellsExcluded: number;
	excludedCells: ExcludedCell[];
	/** Jobs in included cells — the denominator `z`/`pValue` are computed over. */
	jobs: number;
	/** Jobs in excluded cells. Not nothing: counted so a node is never silently shrunk. */
	jobsExcluded: number;
	/** Sum of {@link FailureRateOptions.zones} actually observed, over included cells. */
	observed: number;
	/** What the fleet's own rate for each included cell predicts for this node's job count. */
	expected: number;
	/** `observed - expected`, summed over included cells. */
	excess: number;
	/**
	 * Standardized excess. `null` when {@link insufficientData} — a precise-
	 * looking number from too little evidence invites exactly the
	 * "could not look rendered as nothing is wrong" mistake this exists to
	 * refuse.
	 */
	z: number | null;
	/** One-sided: P(a node this far above the fleet's rate, by chance alone). `null` with `z`. */
	pValue: number | null;
	insufficientData: boolean;
	/** Set only when {@link insufficientData}. */
	insufficientReason: string | null;
	/** Every zone, not only the ones under test — the "why" behind `observed`/`excess`. */
	zoneExcess: Record<FailureZoneName, ZoneTally>;
	/** The zone with the largest excess, i.e. the biggest contributor to this node standing out. `null` with zero jobs. */
	topZone: FailureZoneName | null;
}

export interface FailureRateReport {
	fromDay: string | null;
	toDay: string | null;
	days: number;
	zones: readonly FailureZoneName[];
	minCellFleetJobs: number;
	minNodeJobs: number;
	minExpected: number;
	/** Worst-first (highest `z`); every `insufficientData` node sorts after every measured one, by name. */
	nodes: NodeFailureRate[];
}

// --------------------------------------------------------------------------
// the normal CDF (Abramowitz & Stegun 7.1.26, max error 1.5e-7) — no
// dependency pulls this in for one function, and the accuracy this problem
// needs is nowhere near the approximation's limit.
// --------------------------------------------------------------------------

function erf(x: number): number {
	const sign = x < 0 ? -1 : 1;
	const ax = Math.abs(x);
	const a1 = 0.254829592;
	const a2 = -0.284496736;
	const a3 = 1.421413741;
	const a4 = -1.453152027;
	const a5 = 1.061405429;
	const p = 0.3275911;
	const t = 1 / (1 + p * ax);
	const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
	const y = 1 - poly * Math.exp(-ax * ax);
	return sign * y;
}

/** The upper tail of the standard normal: P(Z > z). */
function normalUpperTail(z: number): number {
	if (z === Infinity) return 0;
	if (z === -Infinity) return 1;
	// Short-circuited rather than left to the approximation: P(Z>0)=0.5 is
	// exact for any continuous symmetric distribution, and `erf(0)` under the
	// A&S polynomial above lands a few parts in 1e-9 away from zero.
	if (z === 0) return 0.5;
	const p = 0.5 * (1 - erf(z / Math.SQRT2));
	return Math.min(1, Math.max(0, p));
}

function emptyZones(): Record<FailureZoneName, number> {
	return { runner: 0, seam: 0, content: 0, fleet: 0, cancelled: 0 };
}

interface Accum {
	jobs: number;
	zones: Record<FailureZoneName, number>;
}

function newAccum(): Accum {
	return { jobs: 0, zones: emptyZones() };
}

function addRow(acc: Accum, jobs: number, zones: FailuresByZone): void {
	acc.jobs += jobs;
	for (const z of ALL_ZONES) acc.zones[z] += zones[z];
}

function cellKey(repo: string, kind: string): string {
	return `${repo}\u0000${kind}`;
}

/**
 * The per-node failure rate, standardized against the fleet's own rate for
 * the same (repo, kind) cells. See the module header for the statistic and
 * why it is the right one.
 */
export function computeFailureRates(
	days: readonly DayRollup[],
	opts: FailureRateOptions = {}
): FailureRateReport {
	const zones = opts.zones ?? FLEET_ORIGIN_ZONES;
	const minCellFleetJobs = opts.minCellFleetJobs ?? 20;
	const minNodeJobs = opts.minNodeJobs ?? 30;
	const minExpected = opts.minExpected ?? 5;
	const fleetNode = opts.fleetNode ?? '*';

	const included = days.filter(
		(d) =>
			(opts.fromDay === undefined || d.day >= opts.fromDay) &&
			(opts.toDay === undefined || d.day <= opts.toDay)
	);

	// node -> cellKey -> accum, and cellKey -> the fleet's own accum for that cell.
	const byNode = new Map<string, Map<string, Accum>>();
	const byCellRepoKind = new Map<string, { repo: string; kind: string }>();
	const fleetByCell = new Map<string, Accum>();

	for (const day of included) {
		for (const row of day.rows) {
			const key = cellKey(row.repo, row.kind);
			byCellRepoKind.set(key, { repo: row.repo, kind: row.kind });
			if (row.node === fleetNode) {
				const acc = fleetByCell.get(key) ?? newAccum();
				addRow(acc, row.jobs, row.failuresByZone);
				fleetByCell.set(key, acc);
				continue;
			}
			let cells = byNode.get(row.node);
			if (!cells) {
				cells = new Map();
				byNode.set(row.node, cells);
			}
			const acc = cells.get(key) ?? newAccum();
			addRow(acc, row.jobs, row.failuresByZone);
			cells.set(key, acc);
		}
	}

	const nodes: NodeFailureRate[] = [];
	for (const [node, cells] of byNode) {
		let cellsIncluded = 0;
		let jobs = 0;
		let jobsExcluded = 0;
		let observed = 0;
		let expected = 0;
		let variance = 0;
		const excludedCells: ExcludedCell[] = [];
		const zoneObserved = emptyZones();
		const zoneExpected = emptyZones();

		for (const [key, nodeAcc] of cells) {
			const fleetAcc = fleetByCell.get(key) ?? newAccum();
			if (fleetAcc.jobs < minCellFleetJobs) {
				const { repo, kind } = byCellRepoKind.get(key) ?? { repo: key, kind: '' };
				excludedCells.push({ repo, kind, fleetJobs: fleetAcc.jobs, nodeJobs: nodeAcc.jobs });
				jobsExcluded += nodeAcc.jobs;
				continue;
			}
			cellsIncluded++;
			jobs += nodeAcc.jobs;

			let q = 0;
			for (const z of zones) q += fleetAcc.zones[z] / fleetAcc.jobs;
			let cellObserved = 0;
			for (const z of zones) cellObserved += nodeAcc.zones[z];
			observed += cellObserved;
			expected += nodeAcc.jobs * q;
			variance += nodeAcc.jobs * q * (1 - q);

			for (const z of ALL_ZONES) {
				zoneObserved[z] += nodeAcc.zones[z];
				zoneExpected[z] += nodeAcc.jobs * (fleetAcc.zones[z] / fleetAcc.jobs);
			}
		}

		const excess = observed - expected;
		const insufficientReasons: string[] = [];
		if (jobs < minNodeJobs)
			insufficientReasons.push(`only ${jobs} job(s) in judgeable cells (need ${minNodeJobs})`);
		if (expected < minExpected)
			insufficientReasons.push(
				`expected count ${expected.toFixed(2)} is below the normal-approximation floor (${minExpected})`
			);
		const insufficientData = insufficientReasons.length > 0;

		let z: number | null = null;
		let pValue: number | null = null;
		if (!insufficientData) {
			if (variance > 0) {
				z = excess / Math.sqrt(variance);
				pValue = normalUpperTail(z);
			} else {
				// Every included cell has the fleet at a 0% or 100% rate — no
				// variability was possible under the null, so any excess at all
				// is maximal evidence (or none happened, and there is nothing to say).
				z = excess > 0 ? Infinity : excess < 0 ? -Infinity : 0;
				pValue = excess > 0 ? 0 : excess < 0 ? 1 : 0.5;
			}
		}

		const zoneExcess = Object.fromEntries(
			ALL_ZONES.map((zn) => [
				zn,
				{
					observed: zoneObserved[zn],
					expected: zoneExpected[zn],
					excess: zoneObserved[zn] - zoneExpected[zn],
				},
			])
		) as Record<FailureZoneName, ZoneTally>;
		let topZone: FailureZoneName | null = jobs > 0 ? ALL_ZONES[0] : null;
		if (topZone) {
			for (const zn of ALL_ZONES)
				if (zoneExcess[zn].excess > zoneExcess[topZone].excess) topZone = zn;
		}

		nodes.push({
			node,
			cellsIncluded,
			cellsExcluded: excludedCells.length,
			excludedCells,
			jobs,
			jobsExcluded,
			observed,
			expected,
			excess,
			z,
			pValue,
			insufficientData,
			insufficientReason: insufficientReasons.length ? insufficientReasons.join('; ') : null,
			zoneExcess,
			topZone,
		});
	}

	nodes.sort((a, b) => {
		if (a.insufficientData !== b.insufficientData) return a.insufficientData ? 1 : -1;
		if (a.insufficientData) return a.node.localeCompare(b.node);
		return (b.z as number) - (a.z as number) || b.excess - a.excess || a.node.localeCompare(b.node);
	});

	return {
		fromDay: opts.fromDay ?? null,
		toDay: opts.toDay ?? null,
		days: included.length,
		zones,
		minCellFleetJobs,
		minNodeJobs,
		minExpected,
		nodes,
	};
}
