/**
 * The fold behind `summarise` — split out of `job-history-stats.ts` for #49
 * (fleet-manager#49), which measured `GET /fleet` at 210–250 ms of SYNCHRONOUS
 * work on the host's event loop: mgmt-api's, where the vault broker also runs,
 * so every Fleet-panel poll held up every CI secret read for that long.
 *
 * Two changes, each answering a line of that profile.
 *
 * 1. ONE PASS OF PER-RECORD WORK. Each record's node is resolved once (it was
 *    resolved four or five times per request, ~25%), its UTC day is an integer
 *    rather than a `toISOString()` (~30%), its completion is parsed once, and
 *    each sample is sorted once for both its median and its p95 (~20%).
 *
 * 2. THE BASELINE IS MEMOISED. Everything but the trailing-hour figures changes
 *    only when the history does — or when the UTC day turns, which moves the
 *    daily list — so it is kept against the store's `historyVersion()` and the
 *    day. A request then pays for the trailing hour alone: a binary search into
 *    the records sorted by completion, and the few records past it.
 *
 * The memo applies ONLY to the store's own array. A caller that hands in its
 * own history (a test, a script) is folded fresh every time: nothing bumps a
 * version when someone else's array changes, so a memo over it would be a
 * stale answer waiting to happen.
 */

import {
	historyVersion,
	records as storeRecords,
	RETENTION_DAYS,
	type JobRecord,
} from './job-history-store.js';
import { failuresByZone } from './job-history-zone.js';
import { jobKind } from './lib/job-kind.js';
import { nodeOf } from './runners/census.js';
import type {
	DailyJobStats,
	JobHistorySummary,
	NodeJobStats,
	RepoJobStats,
} from './job-history-stats.js';

/** {@link median} over a sample already sorted ascending. */
export function medianSorted(s: ArrayLike<number>): number | null {
	if (!s.length) return null;
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** {@link percentile}'s nearest rank over a sample already sorted ascending. */
export function percentileSorted(s: ArrayLike<number>, p: number): number | null {
	if (!s.length) return null;
	const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
	return s[idx];
}

/** A typed array sorts numerically, natively, with no comparator call per step. */
const ascending = (xs: readonly number[]): Float64Array => Float64Array.from(xs).sort();
const nums = (xs: (number | undefined)[]): number[] =>
	xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));

const DAY_MS = 86_400_000;
const isoDay = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** A record with what every fold below asks of it, worked out once. */
interface Row {
	r: JobRecord;
	node: string;
	/** Completion in epoch ms — `finishedAtMs`; NaN when the start will not parse. */
	finished: number;
	/** Days since the epoch, UTC, by `startedAt`; NaN when it will not parse. */
	day: number;
}

function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
	const xs = m.get(k);
	if (xs) xs.push(v);
	else m.set(k, [v]);
}

/** The summary without its trailing-hour figures, and what they are cut from. */
interface Baseline {
	summary: Omit<JobHistorySummary, 'byMachine' | 'byRepo' | 'recentSince' | 'recentWindowSec'>;
	byMachine: Omit<NodeJobStats, 'recentJobs' | 'recentMedianSec' | 'recentP95Sec'>[];
	byRepo: Omit<RepoJobStats, 'recentJobs' | 'recentMedianSec' | 'recentP95Sec'>[];
	/** Every row with a finite completion, ascending by it, for the trailing cut. */
	byFinished: Row[];
}

/**
 * A record's derived fields, kept across folds: a new tick adds a few records
 * to fourteen days of them, and re-parsing every stamp and re-resolving every
 * JIT name (each one unique, so no per-fold cache catches it) was most of a
 * cold fold. Each entry carries what it was derived FROM and is re-derived when
 * any of that differs, so a record edited in place can never keep a stale row.
 */
const derived = new WeakMap<
	JobRecord,
	Row & { nodesKey: string; runner: string; startedAt: string; durationSec: number }
>();

function rowOf(r: JobRecord, nodes: string[], nodesKey: string): Row {
	const hit = derived.get(r);
	if (
		hit &&
		hit.nodesKey === nodesKey &&
		hit.runner === r.runner &&
		hit.startedAt === r.startedAt &&
		hit.durationSec === r.durationSec
	) {
		return hit;
	}
	const start = Date.parse(r.startedAt);
	const row = {
		r,
		node: nodeOf(r.runner, nodes),
		finished: start + (r.durationSec ?? 0) * 1000,
		day: Math.floor(start / DAY_MS),
		nodesKey,
		runner: r.runner,
		startedAt: r.startedAt,
		durationSec: r.durationSec,
	};
	derived.set(r, row);
	return row;
}

function baseline(
	nodes: string[],
	backstopNode: string,
	history: readonly JobRecord[],
	today: number
): Baseline {
	const nodesKey = nodes.join('\0');
	const rows: Row[] = history.map((r) => rowOf(r, nodes, nodesKey));

	const byNode = new Map<string, Row[]>();
	const byRepo = new Map<string, Row[]>();
	const byDay = new Map<number, Row[]>();
	for (const row of rows) {
		pushTo(byNode, row.node, row);
		pushTo(byRepo, row.r.repo, row);
		if (Number.isFinite(row.day)) pushTo(byDay, row.day, row);
	}

	const byMachine = [...byNode.entries()]
		.map(([node, rs]) => {
			const durations = ascending(rs.map((x) => x.r.durationSec));
			return {
				machine: node,
				jobs: rs.length,
				failures: rs.filter((x) => x.r.conclusion !== 'success').length,
				failuresByZone: failuresByZone(rs.map((x) => x.r)),
				medianSec: medianSorted(durations),
				p95Sec: percentileSorted(durations, 95),
				repos: new Set(rs.map((x) => x.r.repo)).size,
			};
		})
		.sort((a, b) => b.jobs - a.jobs);

	const repos = [...byRepo.entries()]
		.map(([repo, rs]) => {
			const durations = ascending(rs.map((x) => x.r.durationSec));
			const queue = ascending(nums(rs.map((x) => x.r.queueSec)));
			const machines = new Map<string, number>();
			const kinds = new Map<string, number[]>();
			for (const x of rs) {
				machines.set(x.node, (machines.get(x.node) ?? 0) + 1);
				pushTo(kinds, jobKind(x.r.name), x.r.durationSec);
			}
			const slowest = [...kinds.entries()]
				.filter(([, ds]) => ds.length >= SLOWEST_MIN_SAMPLES)
				.map(([name, ds]) => ({
					name,
					p95Sec: percentileSorted(ascending(ds), 95) ?? 0,
					jobs: ds.length,
				}))
				.sort((a, b) => b.p95Sec - a.p95Sec)
				.slice(0, 3);
			return {
				repo,
				jobs: rs.length,
				failures: rs.filter((x) => x.r.conclusion !== 'success').length,
				failuresByZone: failuresByZone(rs.map((x) => x.r)),
				medianSec: medianSorted(durations),
				p95Sec: percentileSorted(durations, 95),
				queueP50Sec: medianSorted(queue),
				queueP95Sec: percentileSorted(queue, 95),
				dispatchP50Sec: medianSorted(ascending(nums(rs.map((x) => x.r.dispatchSec)))),
				assignP50Sec: medianSorted(ascending(nums(rs.map((x) => x.r.assignSec)))),
				machines: [...machines.entries()]
					.map(([machine, jobs]) => ({ machine, jobs }))
					.sort((a, b) => b.jobs - a.jobs),
				slowest,
			};
		})
		.sort((a, b) => b.jobs - a.jobs);

	const isBuilder = (x: Row): boolean => !x.r.labels.includes('pm2-host');
	const builder = rows.filter(isBuilder);
	const backstopJobs = builder.filter((x) => x.node === backstopNode).length;

	return {
		summary: {
			since: history.length
				? history.reduce((a, r) => (r.startedAt < a ? r.startedAt : a), history[0].startedAt)
				: null,
			total: history.length,
			daily: daily(byDay, backstopNode, today, isBuilder),
			backstopJobs,
			backstopShare: builder.length ? backstopJobs / builder.length : 0,
			recent: [...rows]
				.sort((a, b) =>
					a.r.startedAt < b.r.startedAt ? 1 : a.r.startedAt > b.r.startedAt ? -1 : 0
				)
				.slice(0, 40)
				.map((x) => ({ ...x.r, machine: x.node })),
		},
		byMachine,
		byRepo: repos,
		byFinished: rows
			.filter((x) => Number.isFinite(x.finished))
			.sort((a, b) => a.finished - b.finished),
	};
}

/** Runs a job kind needs before it may appear in `RepoJobStats.slowest`. */
export const SLOWEST_MIN_SAMPLES = 3;

function daily(
	byDay: Map<number, Row[]>,
	backstopNode: string,
	today: number,
	isBuilder: (x: Row) => boolean
): DailyJobStats[] {
	let firstDay = Infinity;
	for (const d of byDay.keys()) if (d < firstDay) firstDay = d;
	const out: DailyJobStats[] = [];
	for (let day = today - RETENTION_DAYS; day <= today; day++) {
		// Before the file's first record nothing was looking; after it, an empty
		// day is a real zero.
		if (day < firstDay) {
			out.push({
				day: isoDay(day),
				jobs: null,
				failuresByZone: null,
				runMedianSec: null,
				runP95Sec: null,
				queueMedianSec: null,
				queueP95Sec: null,
				backstopJobs: null,
				byMachine: [],
			});
			continue;
		}
		const rs = byDay.get(day) ?? [];
		const durations = ascending(rs.map((x) => x.r.durationSec));
		const queue = ascending(nums(rs.map((x) => x.r.queueSec)));
		const machines = new Map<string, { jobs: number; busySec: number }>();
		for (const x of rs) {
			const e = machines.get(x.node) ?? { jobs: 0, busySec: 0 };
			e.jobs++;
			e.busySec += x.r.durationSec;
			machines.set(x.node, e);
		}
		out.push({
			day: isoDay(day),
			jobs: rs.length,
			failuresByZone: failuresByZone(rs.map((x) => x.r)),
			runMedianSec: medianSorted(durations),
			runP95Sec: percentileSorted(durations, 95),
			queueMedianSec: medianSorted(queue),
			queueP95Sec: percentileSorted(queue, 95),
			backstopJobs: rs.filter((x) => isBuilder(x) && x.node === backstopNode).length,
			byMachine: [...machines.entries()]
				.map(([machine, e]) => ({ machine, ...e }))
				.sort((a, b) => b.jobs - a.jobs),
		});
	}
	return out;
}

/** The first index whose completion is at or past `from`. */
function firstFinishedFrom(rows: readonly Row[], from: number): number {
	let lo = 0;
	let hi = rows.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (rows[mid].finished < from) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

interface Trailing {
	recentJobs: number;
	recentMedianSec: number | null;
	recentP95Sec: number | null;
}

function trailing(durations: readonly number[] | undefined): Trailing {
	const s = ascending(durations ?? []);
	// No jobs in the hour is NO DATA, never a fast node: null, never 0.
	return {
		recentJobs: s.length,
		recentMedianSec: medianSorted(s),
		recentP95Sec: percentileSorted(s, 95),
	};
}

let memo: { key: string; base: Baseline } | null = null;

/** Tests that rewrite the store's array without going through it. */
export function __resetSummaryMemoForTesting(): void {
	memo = null;
}

export function foldSummary(
	nodes: string[],
	backstopNode: string,
	history: readonly JobRecord[],
	now: number,
	windowMs: number
): JobHistorySummary {
	const today = Math.floor(now / DAY_MS);
	let base: Baseline;
	if (history === storeRecords) {
		// The length rides along with the version as a second witness: a writer
		// that forgot to bump still changes it whenever it adds or drops a record.
		const key = JSON.stringify([historyVersion(), history.length, nodes, backstopNode, today]);
		if (memo?.key !== key) memo = { key, base: baseline(nodes, backstopNode, history, today) };
		base = memo.base;
	} else {
		base = baseline(nodes, backstopNode, history, today);
	}

	// COMPLETION, not start — see `finishedAtMs`. A record whose start will not
	// parse has no completion, is not in `byFinished`, and so is left out of the
	// trailing window rather than placed in it by guess.
	const recentFrom = now - windowMs;
	const node = new Map<string, number[]>();
	const repo = new Map<string, number[]>();
	for (let i = firstFinishedFrom(base.byFinished, recentFrom); i < base.byFinished.length; i++) {
		const x = base.byFinished[i];
		pushTo(node, x.node, x.r.durationSec);
		pushTo(repo, x.r.repo, x.r.durationSec);
	}

	return {
		since: base.summary.since,
		total: base.summary.total,
		byMachine: base.byMachine.map((m) => ({ ...m, ...trailing(node.get(m.machine)) })),
		byRepo: base.byRepo.map(({ machines, slowest, ...r }) => ({
			...r,
			...trailing(repo.get(r.repo)),
			machines,
			slowest,
		})),
		daily: base.summary.daily,
		backstopJobs: base.summary.backstopJobs,
		backstopShare: base.summary.backstopShare,
		recent: base.summary.recent,
		recentSince: new Date(recentFrom).toISOString(),
		recentWindowSec: windowMs / 1000,
	};
}
