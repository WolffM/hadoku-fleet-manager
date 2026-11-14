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
import { emptyFailuresByZone, failureBucket, type FailuresByZone } from './job-history-zone.js';
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
const isNum = (x: number | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

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
	/** {@link jobKind} of the record's name. */
	kind: string;
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
	Row & { nodesKey: string; runner: string; startedAt: string; durationSec: number; name: string }
>();

function rowOf(r: JobRecord, nodes: string[], nodesKey: string): Row {
	const hit = derived.get(r);
	if (
		hit &&
		hit.nodesKey === nodesKey &&
		hit.runner === r.runner &&
		hit.startedAt === r.startedAt &&
		hit.durationSec === r.durationSec &&
		hit.name === r.name
	) {
		return hit;
	}
	const start = Date.parse(r.startedAt);
	const row = {
		r,
		node: nodeOf(r.runner, nodes),
		finished: start + (r.durationSec ?? 0) * 1000,
		day: Math.floor(start / DAY_MS),
		kind: jobKind(r.name),
		nodesKey,
		runner: r.runner,
		startedAt: r.startedAt,
		durationSec: r.durationSec,
		name: r.name,
	};
	derived.set(r, row);
	return row;
}

/**
 * One group's records, accumulated in the single pass over the window. Every
 * figure the old per-group `map`/`filter` chains computed comes from these.
 */
interface Acc {
	jobs: number;
	failures: number;
	zones: FailuresByZone;
	durations: number[];
	queue: number[];
	/** First-seen order matters: it breaks ties in every sort by count below. */
	machines: Map<string, { jobs: number; busySec: number }>;
}

const newAcc = (): Acc => ({
	jobs: 0,
	failures: 0,
	zones: emptyFailuresByZone(),
	durations: [],
	queue: [],
	machines: new Map(),
});

interface RepoAcc extends Acc {
	dispatch: number[];
	assign: number[];
	kinds: Map<string, number[]>;
}

interface DayAcc extends Acc {
	backstopJobs: number;
}

function add(acc: Acc, x: Row, bucket: keyof FailuresByZone | null): void {
	acc.jobs++;
	if (bucket) {
		acc.failures++;
		acc.zones[bucket]++;
	}
	acc.durations.push(x.r.durationSec);
	if (isNum(x.r.queueSec)) acc.queue.push(x.r.queueSec);
	const m = acc.machines.get(x.node);
	if (m) {
		m.jobs++;
		m.busySec += x.r.durationSec;
	} else acc.machines.set(x.node, { jobs: 1, busySec: x.r.durationSec });
}

/**
 * Most-recent-first by `startedAt`, ties in history order: a stable sort's top
 * `n`. Scanned from the END because history is appended in roughly start
 * order, so nearly every older row is turned away by one comparison. Walking
 * backwards, a tie goes BEFORE the rows already held (they came later).
 */
function newest(rows: readonly Row[], n: number): Row[] {
	const top: Row[] = [];
	for (let k = rows.length - 1; k >= 0; k--) {
		const x = rows[k];
		const at = x.r.startedAt;
		if (top.length === n && at < top[n - 1].r.startedAt) continue;
		let i = top.length;
		while (i > 0 && at >= top[i - 1].r.startedAt) i--;
		top.splice(i, 0, x);
		if (top.length > n) top.pop();
	}
	return top;
}

/**
 * ONE pass over the window into per-node, per-repo and per-day accumulators
 * (fleet-manager#86). The version before folded each group with its own
 * `map`/`filter`/`Set` chains, ~10 passes over 28k records and an allocation
 * per pass, and sorted every record by start for the 40 newest: 316 ms on the
 * production leader per history change, the last stretch over 100 ms in its
 * profile. Output is unchanged, including every tie order.
 */
function baseline(
	nodes: string[],
	backstopNode: string,
	history: readonly JobRecord[],
	today: number
): Baseline {
	const nodesKey = nodes.join('\0');
	const rows: Row[] = history.map((r) => rowOf(r, nodes, nodesKey));

	const byNode = new Map<string, Acc & { repos: Set<string> }>();
	const byRepo = new Map<string, RepoAcc>();
	const byDay = new Map<number, DayAcc>();
	let builderJobs = 0;
	let backstopJobs = 0;
	for (const x of rows) {
		const bucket = failureBucket(x.r);
		const builder = !x.r.labels.includes('pm2-host');
		const backstop = builder && x.node === backstopNode;
		if (builder) builderJobs++;
		if (backstop) backstopJobs++;

		let n = byNode.get(x.node);
		if (!n) byNode.set(x.node, (n = { ...newAcc(), repos: new Set() }));
		add(n, x, bucket);
		n.repos.add(x.r.repo);

		let r = byRepo.get(x.r.repo);
		if (!r) byRepo.set(x.r.repo, (r = { ...newAcc(), dispatch: [], assign: [], kinds: new Map() }));
		add(r, x, bucket);
		if (isNum(x.r.dispatchSec)) r.dispatch.push(x.r.dispatchSec);
		if (isNum(x.r.assignSec)) r.assign.push(x.r.assignSec);
		pushTo(r.kinds, x.kind, x.r.durationSec);

		if (Number.isFinite(x.day)) {
			let d = byDay.get(x.day);
			if (!d) byDay.set(x.day, (d = { ...newAcc(), backstopJobs: 0 }));
			add(d, x, bucket);
			if (backstop) d.backstopJobs++;
		}
	}

	const byMachine = [...byNode.entries()]
		.map(([node, a]) => {
			const durations = ascending(a.durations);
			return {
				machine: node,
				jobs: a.jobs,
				failures: a.failures,
				failuresByZone: a.zones,
				medianSec: medianSorted(durations),
				p95Sec: percentileSorted(durations, 95),
				repos: a.repos.size,
			};
		})
		.sort((a, b) => b.jobs - a.jobs);

	const repos = [...byRepo.entries()]
		.map(([repo, a]) => {
			const durations = ascending(a.durations);
			const queue = ascending(a.queue);
			const slowest = [...a.kinds.entries()]
				.filter(([, ds]) => ds.length >= SLOWEST_MIN_SAMPLES)
				.map(([name, ds]) => ({
					name,
					p95Sec: percentileSorted(ascending(ds), 95) ?? 0,
					jobs: ds.length,
				}))
				.sort((x, y) => y.p95Sec - x.p95Sec)
				.slice(0, 3);
			return {
				repo,
				jobs: a.jobs,
				failures: a.failures,
				failuresByZone: a.zones,
				medianSec: medianSorted(durations),
				p95Sec: percentileSorted(durations, 95),
				queueP50Sec: medianSorted(queue),
				queueP95Sec: percentileSorted(queue, 95),
				dispatchP50Sec: medianSorted(ascending(a.dispatch)),
				assignP50Sec: medianSorted(ascending(a.assign)),
				machines: [...a.machines.entries()]
					.map(([machine, m]) => ({ machine, jobs: m.jobs }))
					.sort((x, y) => y.jobs - x.jobs),
				slowest,
			};
		})
		.sort((a, b) => b.jobs - a.jobs);

	return {
		summary: {
			since: history.length
				? history.reduce((a, r) => (r.startedAt < a ? r.startedAt : a), history[0].startedAt)
				: null,
			total: history.length,
			daily: daily(byDay, today),
			backstopJobs,
			backstopShare: builderJobs ? backstopJobs / builderJobs : 0,
			recent: newest(rows, 40).map((x) => ({ ...x.r, machine: x.node })),
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

function daily(byDay: Map<number, DayAcc>, today: number): DailyJobStats[] {
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
		const a = byDay.get(day) ?? { ...newAcc(), backstopJobs: 0 };
		const durations = ascending(a.durations);
		const queue = ascending(a.queue);
		out.push({
			day: isoDay(day),
			jobs: a.jobs,
			failuresByZone: a.zones,
			runMedianSec: medianSorted(durations),
			runP95Sec: percentileSorted(durations, 95),
			queueMedianSec: medianSorted(queue),
			queueP95Sec: percentileSorted(queue, 95),
			backstopJobs: a.backstopJobs,
			byMachine: [...a.machines.entries()]
				.map(([machine, e]) => ({ machine, ...e }))
				.sort((x, y) => y.jobs - x.jobs),
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
