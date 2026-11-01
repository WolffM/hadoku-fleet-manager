/**
 * fleet-stats — the pure computation behind `fleet stats` (refactor plan
 * §7.3, T6: "surfaces: `fleet stats`; render `daily`/`byRepo`; bound the
 * facet logs" — this file is the first half). PURE, same shape as
 * `failure-rates.ts` beside it: every input is a caller-supplied array of
 * rows already read from one of the T2/T4/T5/T7 stores, every output is a
 * value, no file, no clock, no network.
 *
 * WHY ONE FILE FOR FIVE STORES. `fleet stats` answers five of the §7.2
 * operator questions, each from its own store (`job-rollup-store.ts` twice —
 * daily and by-repo are two different folds of the same rows —
 * `job-run-store.ts`, `capacity-sample-store.ts`, `gh-budget-history-store.ts`).
 * None of the five computations depends on another, so they are five
 * independent functions rather than one that threads all five stores
 * through — `scripts/stats.mjs` reads each store on its own and may report
 * "could not look" for one while the other four answer normally.
 *
 * DAILY QUEUE PERCENTILES ARE AN APPROXIMATION, NAMED AS ONE. A rollup row
 * keeps only each (day, node, repo, kind) cell's OWN `p50`/`p95` — never the
 * raw queue-time samples a true cross-cell percentile would need (see
 * `job-rollups.ts`'s own header: "percentiles cannot [be summed]... so the
 * fleet's own p50/p95 for the same repo+kind is stored rather than left for
 * a reader to fake"). {@link dailyJobStats} therefore reports a SAMPLE-
 * WEIGHTED MEAN of the fleet row's own per-cell percentiles for that day —
 * a reasonable operator-dashboard approximation, but not a recomputed
 * percentile, and the doc comment on {@link DailyJobStats.queueSec} says so
 * rather than passing it off as exact. `n` is exact (a sum of real counts);
 * `p50`/`p95` are the approximation.
 *
 * FLEET ROWS ONLY, FOR TOTALS. Every rollup row carries a `node` — one row
 * per real node plus one FLEET row (`job-rollups.FLEET_NODE`, `'*'`) that
 * already sums every node for that (day, repo, kind) cell. Folding totals
 * from the per-node rows here would double-count; {@link dailyJobStats} and
 * {@link repoJobStats} therefore read ONLY the fleet row, matching
 * `job-rollups.mjs`'s own human-mode renderer. `fleetNode` is a caller
 * option (default `'*'`), never imported as a value from `job-rollups.ts`:
 * importing the TYPE `DayRollup` from there is already the established
 * cross-file edge (`failure-rates.ts` does the same); inlining the literal
 * default here, the way `capacity-sample-store.ts` inlines `ClawState`'s
 * sibling-type literals, costs two characters and avoids a second one.
 */
import { ALL_ZONES, type FailureZoneName } from './failure-rates.js';
import type { CapacitySampleRow } from './capacity-sample-store.js';
import type { GhBudgetHistoryRow } from './gh-budget-history-store.js';
import type { FailuresByZone } from './job-history-stats.js';
import type { JobRunRow, JobRunVerdict } from './job-run-store.js';
import type { DayRollup, Spread } from './job-rollups.js';

// ── (a) daily jobs, queue p50/p95, conclusions per day — T2 ─────────────────

export interface DailyJobStats {
	day: string;
	/** Summed across the fleet row's (repo, kind) cells — exact. */
	jobs: number;
	/** GitHub's own conclusions, summed the same way. */
	conclusions: Record<string, number>;
	/**
	 * A sample-weighted MEAN of the fleet row's own per-cell `p50`/`p95` for
	 * this day — see the module header. `n` is the exact total sample count
	 * behind the mean; `p50`/`p95` are `null` only when `n` is 0.
	 */
	queueSec: Spread;
}

export function dailyJobStats(
	days: readonly DayRollup[],
	opts: { fleetNode?: string } = {}
): DailyJobStats[] {
	const fleetNode = opts.fleetNode ?? '*';
	return days.map((d) => {
		let jobs = 0;
		const conclusions: Record<string, number> = {};
		let weightedP50 = 0;
		let weightedP95 = 0;
		let weightN = 0;
		for (const r of d.rows) {
			if (r.node !== fleetNode) continue;
			jobs += r.jobs;
			for (const [k, v] of Object.entries(r.conclusions))
				conclusions[k] = (conclusions[k] ?? 0) + v;
			const n = r.queueSec.n;
			if (n > 0) {
				weightedP50 += (r.queueSec.p50 ?? 0) * n;
				weightedP95 += (r.queueSec.p95 ?? 0) * n;
				weightN += n;
			}
		}
		return {
			day: d.day,
			jobs,
			conclusions,
			queueSec: {
				n: weightN,
				p50: weightN > 0 ? weightedP50 / weightN : null,
				p95: weightN > 0 ? weightedP95 / weightN : null,
			},
		};
	});
}

// ── (b) per-repo totals over the window — T2 ────────────────────────────────

function emptyZoneTotals(): Record<FailureZoneName, number> {
	return Object.fromEntries(ALL_ZONES.map((z) => [z, 0])) as Record<FailureZoneName, number>;
}

export interface RepoJobStats {
	repo: string;
	jobs: number;
	conclusions: Record<string, number>;
	failuresByZone: FailuresByZone;
}

/** Worst-first (most jobs), then alphabetical — matches `failure-rates.ts`'s own tie-break style. */
export function repoJobStats(
	days: readonly DayRollup[],
	opts: { fleetNode?: string } = {}
): RepoJobStats[] {
	const fleetNode = opts.fleetNode ?? '*';
	const byRepo = new Map<string, RepoJobStats>();
	for (const d of days) {
		for (const r of d.rows) {
			if (r.node !== fleetNode) continue;
			const e = byRepo.get(r.repo) ?? {
				repo: r.repo,
				jobs: 0,
				conclusions: {},
				failuresByZone: emptyZoneTotals(),
			};
			e.jobs += r.jobs;
			for (const [k, v] of Object.entries(r.conclusions))
				e.conclusions[k] = (e.conclusions[k] ?? 0) + v;
			for (const z of ALL_ZONES) e.failuresByZone[z] += r.failuresByZone[z] ?? 0;
			byRepo.set(r.repo, e);
		}
	}
	return [...byRepo.values()].sort((a, b) => b.jobs - a.jobs || a.repo.localeCompare(b.repo));
}

// ── (c) automation health — T7 ───────────────────────────────────────────────

export type JobRunVerdictCounts = Record<JobRunVerdict, number>;

function emptyVerdictCounts(): JobRunVerdictCounts {
	return { ok: 0, findings: 0, error: 0, 'could-not-look': 0 };
}

export interface AutomationHealthRow {
	job: string;
	/** Runs of THIS job inside the window handed to this function. */
	runs: number;
	/**
	 * `null` when `runs` is 0 — a registry job with no run in the window is a
	 * finding of its own (the cron may never have fired), never folded into a
	 * verdict mix that would read as "0 errors, therefore healthy".
	 */
	lastRun: { startedAt: string; verdict: JobRunVerdict; why: string | null } | null;
	verdictCounts: JobRunVerdictCounts;
}

/**
 * One row per name in `jobNames` (typically every `JOB_REGISTRY` entry, so a
 * job with ZERO runs in the window still appears — `runs: 0`, `lastRun:
 * null` — rather than being silently absent) PLUS one for any row's `job`
 * that `jobNames` does not name (defensive: a caller should never see this,
 * but a row is never dropped on the floor for not matching the registry).
 *
 * `rows` need not be sorted; this function sorts each job's own rows itself.
 */
export function automationHealthStats(
	rows: readonly JobRunRow[],
	jobNames: readonly string[]
): AutomationHealthRow[] {
	const byJob = new Map<string, JobRunRow[]>();
	for (const r of rows) {
		const list = byJob.get(r.job) ?? [];
		list.push(r);
		byJob.set(r.job, list);
	}
	const names = new Set([...jobNames, ...byJob.keys()]);
	return [...names].sort().map((job) => {
		const jobRows = byJob.get(job) ?? [];
		const newestFirst = [...jobRows].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
		const verdictCounts = emptyVerdictCounts();
		for (const r of jobRows) verdictCounts[r.verdict]++;
		const newest = newestFirst[0];
		return {
			job,
			runs: jobRows.length,
			lastRun: newest
				? { startedAt: newest.startedAt, verdict: newest.verdict, why: newest.why }
				: null,
			verdictCounts,
		};
	});
}

// ── (d) capacity/admission state — T4 ────────────────────────────────────────

export interface NodeCapacityStats {
	node: string;
	samples: number;
	/** The probe never reached this node — `CapacitySampleRow.unmeasured`. */
	unmeasured: number;
	/** An operator drain was in effect — `CapacitySampleRow.drained`. */
	drained: number;
	/** Measured AND at its admission ceiling (`admissionFree === 0`) — never counted from an unmeasured sample. */
	atCapacity: number;
}

export function capacityStats(rows: readonly CapacitySampleRow[]): NodeCapacityStats[] {
	const byNode = new Map<string, NodeCapacityStats>();
	for (const r of rows) {
		const e = byNode.get(r.node) ?? {
			node: r.node,
			samples: 0,
			unmeasured: 0,
			drained: 0,
			atCapacity: 0,
		};
		e.samples++;
		if (r.unmeasured) e.unmeasured++;
		if (r.drained) e.drained++;
		if (!r.unmeasured && r.admissionFree === 0) e.atCapacity++;
		byNode.set(r.node, e);
	}
	return [...byNode.values()].sort((a, b) => a.node.localeCompare(b.node));
}

// ── (e) GitHub budget — T5 ───────────────────────────────────────────────────

export interface BudgetCallerShare {
	caller: string;
	/** Summed across every window in the range — charged calls only, never free 304s. */
	charged: number;
}

export interface TokenBudgetStats {
	token: string;
	resource: string;
	/** Ended windows observed in the range. */
	windows: number;
	/** The limit AT the peak window — a token's limit can itself change. */
	limit: number;
	/** The highest `usedAtEnd` across every window in range. */
	peakUsed: number;
	/** `null` only when `limit` is 0 at the peak (never seen in practice; guarded rather than dividing by zero). */
	peakUsedPct: number | null;
	/** Windows that ended with no budget left (`remainingAtEnd === 0`): each is
	 * time the fleet could not poll or mint. A lone `peakUsedPct` of 100 cannot
	 * say whether that happened once or every hour. */
	exhaustedWindows: number;
	/** Highest-charged first; ties broken alphabetically. */
	topCallers: BudgetCallerShare[];
}

export function budgetStats(
	rows: readonly GhBudgetHistoryRow[],
	opts: { topCallers?: number } = {}
): TokenBudgetStats[] {
	const topN = opts.topCallers ?? 5;
	const byKey = new Map<
		string,
		{ token: string; resource: string; windows: GhBudgetHistoryRow[] }
	>();
	for (const r of rows) {
		const key = `${r.token}\u0000${r.resource}`;
		const e = byKey.get(key) ?? { token: r.token, resource: r.resource, windows: [] };
		e.windows.push(r);
		byKey.set(key, e);
	}
	const out: TokenBudgetStats[] = [];
	for (const { token, resource, windows } of byKey.values()) {
		let peakUsed = 0;
		let peakLimit = 0;
		let exhaustedWindows = 0;
		const callerTotals = new Map<string, number>();
		for (const w of windows) {
			if (w.remainingAtEnd === 0) exhaustedWindows += 1;
			if (w.usedAtEnd >= peakUsed) {
				peakUsed = w.usedAtEnd;
				peakLimit = w.limit;
			}
			for (const c of w.byCaller)
				callerTotals.set(c.caller, (callerTotals.get(c.caller) ?? 0) + c.charged);
		}
		const topCallers = [...callerTotals.entries()]
			.map(([caller, charged]) => ({ caller, charged }))
			.sort((a, b) => b.charged - a.charged || a.caller.localeCompare(b.caller))
			.slice(0, topN);
		out.push({
			token,
			resource,
			windows: windows.length,
			limit: peakLimit,
			peakUsed,
			peakUsedPct: peakLimit > 0 ? (peakUsed / peakLimit) * 100 : null,
			exhaustedWindows,
			topCallers,
		});
	}
	return out.sort((a, b) => a.token.localeCompare(b.token) || a.resource.localeCompare(b.resource));
}
