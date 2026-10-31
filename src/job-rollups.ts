/**
 * job-rollups — one durable row per (UTC day, node, repo, job kind), folded
 * from job-history once the day can no longer change. Refactor plan §7.3, T2.
 *
 * WHY. job-history is the fleet's only CI ledger and it keeps fourteen days.
 * Every trend question longer than that — "p95 queue per day this month", "is
 * claw-5 slower on kind K than it was in September", "which claw fails most" —
 * had no data at all, and the one computed answer (`GET /fleet`'s `daily`) is
 * recomputed per request over whatever the ledger still holds. These rows are
 * small enough to keep for a year, so the ledger can stay short.
 *
 * THE KEY IS BUILT FOR COMPARISON. Every (day, repo, kind) carries one row per
 * node AND one row for the whole fleet (`node: '*'`). Counts can be summed
 * across rows; percentiles cannot, so the fleet's own p50/p95 for the same
 * repo+kind is stored rather than left for a reader to fake. A node's failure
 * rate against the fleet's for the same work (T3) is one lookup.
 *
 * ORGANIC ONLY. Records the forced-placement harness manufactured (`probe`) are
 * left out of every row and counted on the day (`probesExcluded`): a
 * `forced-rerun` sample exists because something already failed, so it would
 * poison any failure rate it joined.
 *
 * WHEN A DAY IS FINAL. A record is filed under the UTC day its job STARTED, and
 * `ingestRuns` may still fetch a run up to {@link FRESH_HORIZON_H} after it was
 * last updated. So a day is closed only once {@link SETTLE_HOURS} have passed
 * since it ended — written once, after that, and never rewritten. That costs
 * rollups a two-day lag and buys rows that do not change under a reader.
 *
 * WHEN A DAY IS WHOLE. Before {@link historyCompleteSinceMs} nothing proves the
 * ledger saw everything — retention, the safety budget or a fresh file may
 * have cut that day short. Such a day is never written: a partial day recorded
 * as whole would be a permanent, silent undercount.
 *
 * WHERE IT RUNS. On runner-health's tick, after `ingestRuns` — the one loop
 * that already owns job-history. It adds no timer and no GitHub call: on almost
 * every tick it compares at most fourteen day keys against a cached set and
 * returns. Module state is never durable here (mgmt-api restarts dozens of
 * times a day), so the store is the only memory: a restarted process re-reads
 * which days exist and writes only the missing ones. The FIRST run writes every
 * closed day the ledger still holds — that backfill is the baseline.
 */
import { join } from 'node:path';

import { logger, stateDir } from './host.js';
import { FRESH_HORIZON_H } from './job-history-ingest.js';
import { historyCompleteSinceMs, jobRecords, type JobRecord } from './job-history-store.js';
import { failuresByZone, nodeOf, percentile, type FailuresByZone } from './job-history-stats.js';
import { ROLLUP_FILE, jsonlRollupStore, type RollupStore } from './job-rollup-store.js';
import { jobKind } from './lib/job-kind.js';
import { HOSTED_NODE } from './runners/census.js';
import { JIT_PREFIX, WARM_PREFIX } from './runners/ephemeral.js';

/** Bumped when a row's meaning changes, so a reader can refuse a mix. */
export const ROLLUP_SCHEMA = 1;
/** The `node` value of a row that folds every node. */
export const FLEET_NODE = '*';
/** A day is closed this long after it ends. See the module header. */
export const SETTLE_HOURS = FRESH_HORIZON_H + 2;
/** Kept a year and a month, so "the same week last year" is answerable. */
export const ROLLUP_RETENTION_DAYS = 400;

const DAY_MS = 86_400_000;

/** How the job got its runner. `jit` vs `warm` is the cold/warm mint split. */
export type RunnerClass = 'jit' | 'warm' | 'standing' | 'hosted';

/** A sample's size and nearest-rank percentiles. `null` when `n` is 0 — no data, never 0s. */
export interface Spread {
	n: number;
	p50: number | null;
	p95: number | null;
}

export interface ClassStats {
	jobs: number;
	queueSec: Spread;
	setupSec: Spread;
}

export interface RollupRow {
	/** `nodeOf(runner)`, or {@link FLEET_NODE} for the whole fleet. */
	node: string;
	repo: string;
	/** `jobKind(name)` — matrix shards fold into one kind. */
	kind: string;
	jobs: number;
	/** GitHub's `conclusion`, counted. `success` included, so a rate needs no other field. */
	conclusions: Record<string, number>;
	/** Non-success jobs by zone — `job-history`'s own classifier, the one `GET /fleet` uses. */
	failuresByZone: FailuresByZone;
	durationSec: Spread;
	queueSec: Spread;
	/** JIT only: job created -> runner minted. */
	dispatchSec: Spread;
	/** JIT only: runner minted -> job started. */
	assignSec: Spread;
	setupSec: Spread;
	/** Only the classes that served at least one job are present. */
	byClass: Partial<Record<RunnerClass, ClassStats>>;
}

export interface DayRollup {
	schema: number;
	/** `YYYY-MM-DD`, UTC, by `startedAt`. */
	day: string;
	writtenAt: string;
	/** The evidence boundary this day was judged whole against. */
	completeSince: string;
	/** Organic records folded into `rows`. 0 is a day the ledger saw and found empty. */
	records: number;
	probesExcluded: number;
	rows: RollupRow[];
}

export function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export function runnerClass(runner: string, nodes: readonly string[]): RunnerClass {
	if (runner.startsWith(JIT_PREFIX)) return 'jit';
	if (runner.startsWith(WARM_PREFIX)) return 'warm';
	if (nodeOf(runner, nodes) === HOSTED_NODE) return 'hosted';
	return 'standing';
}

function spread(xs: readonly (number | undefined)[]): Spread {
	const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
	return { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95) };
}

function foldRow(
	node: string,
	repo: string,
	kind: string,
	rs: JobRecord[],
	nodes: readonly string[]
): RollupRow {
	const conclusions: Record<string, number> = {};
	for (const r of rs) conclusions[r.conclusion] = (conclusions[r.conclusion] ?? 0) + 1;
	const classes = new Map<RunnerClass, JobRecord[]>();
	for (const r of rs) {
		const c = runnerClass(r.runner, nodes);
		const xs = classes.get(c);
		if (xs) xs.push(r);
		else classes.set(c, [r]);
	}
	const byClass: Partial<Record<RunnerClass, ClassStats>> = {};
	for (const [c, xs] of [...classes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		byClass[c] = {
			jobs: xs.length,
			queueSec: spread(xs.map((r) => r.queueSec)),
			setupSec: spread(xs.map((r) => r.setupSec)),
		};
	}
	return {
		node,
		repo,
		kind,
		jobs: rs.length,
		conclusions,
		failuresByZone: failuresByZone(rs),
		durationSec: spread(rs.map((r) => r.durationSec)),
		queueSec: spread(rs.map((r) => r.queueSec)),
		dispatchSec: spread(rs.map((r) => r.dispatchSec)),
		assignSec: spread(rs.map((r) => r.assignSec)),
		setupSec: spread(rs.map((r) => r.setupSec)),
		byClass,
	};
}

/**
 * Fold one day's records. PURE: the caller has already chosen the records
 * (every one must have started on `day`) and decided the day is whole.
 */
export function rollupDay(
	day: string,
	dayRecords: readonly JobRecord[],
	nodes: readonly string[],
	meta: { completeSinceMs: number; nowMs: number }
): DayRollup {
	const organic = dayRecords.filter((r) => !r.probe);
	const groups = new Map<string, JobRecord[]>();
	const add = (k: string, r: JobRecord) => {
		const xs = groups.get(k);
		if (xs) xs.push(r);
		else groups.set(k, [r]);
	};
	for (const r of organic) {
		const kind = jobKind(r.name);
		add(JSON.stringify([nodeOf(r.runner, nodes), r.repo, kind]), r);
		add(JSON.stringify([FLEET_NODE, r.repo, kind]), r);
	}
	const rows = [...groups.entries()]
		.map(([k, rs]) => {
			const [node, repo, kind] = JSON.parse(k) as [string, string, string];
			return foldRow(node, repo, kind, rs, nodes);
		})
		.sort(
			(a, b) =>
				a.repo.localeCompare(b.repo) || a.kind.localeCompare(b.kind) || a.node.localeCompare(b.node)
		);
	return {
		schema: ROLLUP_SCHEMA,
		day,
		writtenAt: new Date(meta.nowMs).toISOString(),
		completeSince: new Date(meta.completeSinceMs).toISOString(),
		records: organic.length,
		probesExcluded: dayRecords.length - organic.length,
		rows,
	};
}

/**
 * Every day that is both WHOLE (began at or after `completeSinceMs`) and FINAL
 * (ended at least {@link SETTLE_HOURS} before `nowMs`), oldest first.
 */
export function closableDays(nowMs: number, completeSinceMs: number): string[] {
	const firstStart = Math.ceil(completeSinceMs / DAY_MS) * DAY_MS;
	const settledBy = nowMs - SETTLE_HOURS * 3600_000;
	const out: string[] = [];
	for (let start = firstStart; start + DAY_MS <= settledBy; start += DAY_MS)
		out.push(utcDay(start));
	return out;
}

export function rollupFile(): string {
	return join(stateDir(), ROLLUP_FILE);
}

let defaultStore: RollupStore | null = null;
let defaultStorePath: string | null = null;
function storeAtStateDir(): RollupStore {
	const path = rollupFile();
	if (!defaultStore || defaultStorePath !== path) {
		defaultStore = jsonlRollupStore(path);
		defaultStorePath = path;
	}
	return defaultStore;
}

export interface WriteRollupsResult {
	/** Days written by this call, oldest first. */
	written: string[];
	/** Why nothing could be written, when that is a finding rather than "nothing due". */
	refused?: string;
}

/**
 * Write every closed day the store does not hold yet. Idempotent: a second
 * call with the same inputs writes nothing.
 *
 * NEVER THROWS. It runs on the runner-health tick, which must not die for a
 * telemetry write; every failure is logged with its reason and returned.
 */
export function writeClosedDays(opts: {
	nodes: readonly string[];
	nowMs?: number;
	records?: readonly JobRecord[];
	completeSinceMs?: number | null;
	store?: RollupStore;
}): WriteRollupsResult {
	const now = opts.nowMs ?? Date.now();
	try {
		const store = opts.store ?? storeAtStateDir();
		const since =
			opts.completeSinceMs !== undefined ? opts.completeSinceMs : historyCompleteSinceMs(now);
		// An empty ledger proves nothing about any day.
		if (since === null) return { written: [] };
		const held = store.writtenDays();
		const due = closableDays(now, since).filter((d) => !held.has(d));
		if (!due.length) return { written: [] };
		// Without the node list `nodeOf` answers the raw runner name, and that
		// would be written durably as a node called `jit-claw-8-hadoku-…`.
		if (!opts.nodes.length) {
			const refused = `no node list (manifest unreadable?) — ${due.length} closed day(s) left unwritten`;
			logger.warn(`[job-rollups] ${refused}`);
			return { written: [], refused };
		}
		const dueSet = new Set(due);
		const byDay = new Map<string, JobRecord[]>();
		for (const r of opts.records ?? jobRecords()) {
			const ms = Date.parse(r.startedAt);
			if (!Number.isFinite(ms)) continue;
			const d = utcDay(ms);
			if (!dueSet.has(d)) continue;
			const xs = byDay.get(d);
			if (xs) xs.push(r);
			else byDay.set(d, [r]);
		}
		const rollups = due.map((d) =>
			rollupDay(d, byDay.get(d) ?? [], opts.nodes, { completeSinceMs: since, nowMs: now })
		);
		store.put(rollups, utcDay(now - ROLLUP_RETENTION_DAYS * DAY_MS));
		logger.info(
			`[job-rollups] wrote ${due.length} day(s): ${due[0]}${due.length > 1 ? ` .. ${due[due.length - 1]}` : ''} ` +
				`(${rollups.reduce((n, r) => n + r.records, 0)} record(s))`
		);
		return { written: due };
	} catch (err) {
		const refused = `could not write rollups: ${err instanceof Error ? err.message : String(err)}`;
		logger.warn(`[job-rollups] ${refused}`);
		return { written: [], refused };
	}
}
