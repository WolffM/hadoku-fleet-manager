/**
 * Fleet performance route (wave fleettab §A) — `GET /fleet/performance?days=
 * <1..120>`, the data behind the Command Station's Fleet › Performance view.
 *
 * A JOIN, LIKE `GET /fleet`, BUT OVER DURABLE HISTORY RATHER THAN LIVE STATE.
 * `job-rollups.ts` already folds every closed day (job-history, the
 * dispatch-decision log, the capacity-sample store) into one durable row per
 * day — see that module's own header for why a day is written once, days
 * after it ends, and never rewritten. This route reads that store for every
 * CLOSED day in the window and computes TODAY — the one day that cannot be
 * closed yet — live, from the same three sources, through the identical pure
 * builder (`buildFleetDayAggregate`) the writer uses. The two paths therefore
 * can never disagree about what a day MEANS, only about whether it is
 * finished.
 *
 * A DAY WITHOUT A SETTLED ROLLUP ROW IS NOT, BY ITSELF, A GAP. The last
 * `SETTLE_HOURS`-ish days before "now" never have one — that is what
 * "settled" means — and treating every one of them as a gap put a ~3-day
 * blank at the right edge of every chart, reading as an outage every single
 * day (operator finding, wave fleettab fix-up). So any day lacking a settled
 * row is instead computed LIVE, the identical way `liveDay` computes TODAY:
 * job-history, the decision log and the capacity-sample store for exactly
 * that day's [start, end) range, through the same `buildFleetDayAggregate`
 * the writer uses. Such a day's `daily`/`nodes`/`waits`/`availability` rows
 * carry `provisional: true`; a settled row never does.
 *
 * LIVE ONLY WHEN JOB-HISTORY CAN VOUCH FOR THE DAY. `historyCompleteSinceMs`
 * is the same boundary `job-rollups.ts`'s own writer uses to decide a day is
 * WHOLE — before it, retention or a fresh file may have cut the day short,
 * and computing "live" over a half-seen day would silently undercount it
 * forever (this route runs once per request, never writes anything down, so
 * there is no later backfill to fix it). A day neither settled NOR provably
 * whole is still a GAP, with a reason — never a fabricated zero (AGENTS.md:
 * "I could not look" must never render as "nothing is wrong"). TODAY is the
 * one exception to the completeness gate: it is always computed live,
 * however little of it has happened yet, the same guarantee this route has
 * always made.
 *
 * The per-field `null`s inside a day that WAS found or computed (`waits`/
 * `availability`/`fullShare`/`unavailableShare`) are a narrower version of
 * the same rule — see `job-rollups-fleet.ts`'s own header — and this route
 * passes them through unchanged rather than coercing them to zero.
 *
 * A DAY PAST JOB-HISTORY'S COMPLETENESS, WITH A SCHEMA-1 ROW, IS `partial`,
 * NOT A GAP (operator addition, same fix-up). The writer upgrades every
 * schema-1 day it can still see (`job-rollups.ts`'s own header); a day old
 * enough to have fallen out of job-history cannot be upgraded OR computed
 * live, but its schema-1 row still carries real counts — summed from the
 * `node: '*'` rows `rollupDay` already wrote for every repo+kind that day.
 * Counts (`jobs`, `cancelled`, `failures`, `queue.all.n`, per-node `jobs`/
 * `failRate`) are EXACT: every organic job is folded into exactly one
 * (FLEET_NODE, repo, kind) group, so summing those groups recovers the
 * day's true total. Everything schema 1 stored only as a per-group
 * PERCENTILE — `runnerHours` (no raw sum at all), `queue.all.p50/p80/p95`,
 * `queue.byClass` (no class breakdown existed yet), every node's
 * `runnerHours`/`fullShare`/`unavailableShare`, and the whole of `waits`/
 * `availability` (no decision-log or capacity-sample join existed yet) —
 * is `null`, never averaged or guessed across groups: merging percentiles
 * from different (repo, kind) buckets is not a valid percentile of the
 * whole (the same reason `job-rollups.ts`'s own `RollupRow` stores the
 * fleet's percentile directly rather than leaving a reader to fake it).
 */
import { join } from 'node:path';

import type { Request, Response } from 'express';

import { logger, stateDir } from '../host.js';
import { loadFleetNodeNames } from '../lib/manifest.js';
import { jobRecords, historyCompleteSinceMs, type JobRecord } from '../job-history-store.js';
import { readDecisions, decisionLogDir } from '../runners/decision-log-storage.js';
import type { DecisionRecord } from '../runners/decision-log-types.js';
import { capacitySampleStore, CAPACITY_SAMPLE_FILE } from '../capacity-sample-store.js';
import type { CapacitySampleRow } from '../capacity-sample-store.js';
import {
	readRollupStore,
	utcDay,
	FLEET_NODE,
	type DayRollup,
	type RollupRow,
} from '../job-rollups.js';
import type { RollupRead } from '../job-rollup-store.js';
import { buildFleetDayAggregate, type FleetDayAggregate } from '../job-rollups-fleet.js';

const CONTRACT = 1;
const DAY_MS = 86_400_000;
const MIN_DAYS = 1;
const MAX_DAYS = 120;
const DEFAULT_DAYS = 30;

function parseDays(raw: unknown): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
	return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.floor(n)));
}

export interface DailyEntry {
	day: string;
	jobs: number;
	/**
	 * `null` on a `partial` day: schema 1 kept only a per-(repo,kind)
	 * PERCENTILE for duration, never a raw sum, so there is no honest total
	 * to report (see the module header).
	 */
	runnerHours: number | null;
	cancelled: number;
	/** Exact even on a `partial` day — summed from schema 1's own `failuresByZone`, never a percentile. */
	failures: FleetDayAggregate['failures'];
	queue: FleetDayAggregate['queue'];
	/** Computed live rather than read from a settled rollup row. Omitted (never `false`) on a settled day. */
	provisional?: true;
	/** Reconstructed from a schema-1 row's counts, outside job-history's completeness — never live, never a settled schema-2 row. Omitted otherwise. */
	partial?: true;
}

export interface NodeEntry {
	day: string;
	node: string;
	jobs: number;
	/** `null` on a `partial` day — see `DailyEntry.runnerHours`. */
	runnerHours: number | null;
	failRate: number;
	fullShare: number | null;
	unavailableShare: number | null;
	provisional?: true;
	partial?: true;
}

export interface WaitsEntry {
	day: string;
	capacity: number;
	constraints: number;
	held: number;
	other: number;
	provisional?: true;
}

export interface AvailabilityEntry {
	day: string;
	claws: number;
	provisional?: true;
}

export interface GapEntry {
	from: string;
	to: string;
	what: string;
}

export interface PerformanceResponse {
	contract: 1;
	generatedAt: string;
	days: number;
	since: string;
	daily: DailyEntry[];
	nodes: NodeEntry[];
	waits: WaitsEntry[];
	availability: AvailabilityEntry[];
	gaps: GapEntry[];
}

function dailyEntry(day: string, a: FleetDayAggregate, provisional: boolean): DailyEntry {
	return {
		day,
		jobs: a.jobs,
		runnerHours: a.runnerHours,
		cancelled: a.cancelled,
		failures: a.failures,
		queue: a.queue,
		...(provisional ? { provisional: true } : {}),
	};
}

/** Everything `buildPerformanceReportWith` reads from the live process or disk — a test seam, each defaulting to the real read. */
export interface PerformanceDeps {
	nodes?: readonly string[];
	/** The rollup store's own read. Thrown by a real I/O error, which a test can reproduce by injecting a function that throws. */
	readRollups?: () => RollupRead<RollupRow, FleetDayAggregate>;
	/** `historyCompleteSinceMs` — the instant before which job-history cannot vouch a day is whole. `null`: the ledger holds nothing. */
	historyCompleteSinceMs?: () => number | null;
	/** Every in-memory job-history record, any day — filtered down to one day's by the caller. */
	jobRecords?: () => readonly JobRecord[];
	/** Every dispatch-decision row in `[sinceMs, untilMs)`. `null`: the log could not be read. */
	decisionsSince?: (sinceMs: number, untilMs: number) => readonly DecisionRecord[] | null;
	/** Every capacity-sample row the store currently holds, any day. `null`: the store could not be read. */
	capacitySamples?: () => readonly CapacitySampleRow[] | null;
}

function realDecisionsSince(sinceMs: number, untilMs: number): readonly DecisionRecord[] | null {
	try {
		return readDecisions(decisionLogDir(), { sinceMs, untilMs }).records;
	} catch (err) {
		logger.warn(
			`[fleet-performance] could not read the dispatch-decision log: ` +
				`${err instanceof Error ? err.message : String(err)}`
		);
		return null;
	}
}

function realCapacitySamples(): readonly CapacitySampleRow[] | null {
	try {
		return capacitySampleStore(join(stateDir(), CAPACITY_SAMPLE_FILE)).read().rows;
	} catch (err) {
		logger.warn(
			`[fleet-performance] could not read capacity samples: ` +
				`${err instanceof Error ? err.message : String(err)}`
		);
		return null;
	}
}

/**
 * One day's aggregate, computed LIVE over whatever each source currently
 * holds — never from the rollup store, which cannot hold a day that has not
 * settled. Works identically for today (partial, growing) and for a day
 * that has already fully ended but has not settled yet: the `[dayStartMs,
 * dayEndMs)` window is clamped to `nowMs`, so a past day reads its whole
 * span and today reads only what has happened so far.
 */
function liveDay(
	day: string,
	nowMs: number,
	nodes: readonly string[],
	deps: Required<Pick<PerformanceDeps, 'jobRecords' | 'decisionsSince' | 'capacitySamples'>>
): FleetDayAggregate {
	const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
	const dayEndMs = Math.min(nowMs, dayStartMs + DAY_MS);
	const inDay = (atIso: string): boolean => {
		const ms = Date.parse(atIso);
		return Number.isFinite(ms) && ms >= dayStartMs && ms < dayStartMs + DAY_MS;
	};
	const records = deps.jobRecords().filter((r) => inDay(r.startedAt) && !r.probe);
	const decisions = deps.decisionsSince(dayStartMs, dayEndMs);
	const capacitySamples = deps.capacitySamples();
	return buildFleetDayAggregate(records, nodes, {
		decisions: decisions === null ? null : decisions.filter((r) => inDay(r.at)),
		capacitySamples: capacitySamples === null ? null : capacitySamples.filter((r) => inDay(r.at)),
	});
}

/** Every UTC day from `since` through `nowMs`'s day, oldest first. */
function windowDays(sinceMs: number, nowMs: number): string[] {
	const out: string[] = [];
	for (let t = Date.parse(`${utcDay(sinceMs)}T00:00:00.000Z`); t <= nowMs; t += DAY_MS)
		out.push(utcDay(t));
	return out;
}

/**
 * What `partialFromRows` can recover from a day's raw rollup rows, by
 * summing every `node: '*'` row (fleet-wide, exact) and every other row
 * grouped by node (also exact) — see the module header for what this
 * deliberately leaves `null`.
 */
interface PartialDay {
	jobs: number;
	cancelled: number;
	failures: FleetDayAggregate['failures'];
	queueAllN: number;
	nodes: { node: string; jobs: number; failRate: number }[];
}

function partialFromRows(rows: readonly RollupRow[]): PartialDay {
	let jobs = 0;
	let cancelled = 0;
	let code = 0;
	let setup = 0;
	let fleetZone = 0;
	let queueAllN = 0;
	for (const r of rows) {
		if (r.node !== FLEET_NODE) continue;
		jobs += r.jobs;
		cancelled += r.conclusions.cancelled ?? 0;
		code += r.failuresByZone.content;
		setup += r.failuresByZone.seam;
		fleetZone += r.failuresByZone.runner + r.failuresByZone.fleet;
		queueAllN += r.queueSec.n;
	}
	const perNode = new Map<string, { jobs: number; nonSuccess: number }>();
	for (const r of rows) {
		if (r.node === FLEET_NODE) continue;
		const cur = perNode.get(r.node) ?? { jobs: 0, nonSuccess: 0 };
		cur.jobs += r.jobs;
		cur.nonSuccess += r.jobs - (r.conclusions.success ?? 0) - (r.conclusions.cancelled ?? 0);
		perNode.set(r.node, cur);
	}
	const nodes = [...perNode.entries()]
		.map(([node, v]) => ({ node, jobs: v.jobs, failRate: v.jobs ? v.nonSuccess / v.jobs : 0 }))
		.sort((a, b) => a.node.localeCompare(b.node));
	return { jobs, cancelled, failures: { code, setup, fleet: fleetZone }, queueAllN, nodes };
}

/** Coalesce consecutive gap days sharing the same reason into one {from,to,what} range. */
function coalesceGaps(perDay: readonly { day: string; what: string }[]): GapEntry[] {
	const out: GapEntry[] = [];
	for (const g of perDay) {
		const last = out[out.length - 1];
		if (last && last.what === g.what && nextDay(last.to) === g.day) {
			last.to = g.day;
		} else {
			out.push({ from: g.day, to: g.day, what: g.what });
		}
	}
	return out;
}

function nextDay(day: string): string {
	return utcDay(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS);
}

export function buildPerformanceReport(nowMs: number = Date.now()): PerformanceResponse {
	return buildPerformanceReportWith(nowMs, DEFAULT_DAYS);
}

/**
 * The route's own assembly, pulled out as a named function so a test can hand
 * it `days`/`nowMs` and every dependency as a FIXTURE — never a real file
 * under `stateDir()`. `deps` defaults to the real reads in production; a
 * test overrides exactly the pieces it cares about.
 */
export function buildPerformanceReportWith(
	nowMs: number,
	days: number,
	deps: PerformanceDeps = {}
): PerformanceResponse {
	const sinceMs = nowMs - days * DAY_MS;
	const nodes = deps.nodes ?? loadFleetNodeNames();
	const store = (deps.readRollups ?? readRollupStore)();
	const byDay = new Map<string, DayRollup>(store.days.map((d) => [d.day, d]));
	const today = utcDay(nowMs);
	const completeSinceMs = (deps.historyCompleteSinceMs ?? (() => historyCompleteSinceMs(nowMs)))();
	const liveDeps = {
		jobRecords: deps.jobRecords ?? jobRecords,
		decisionsSince: deps.decisionsSince ?? realDecisionsSince,
		capacitySamples: deps.capacitySamples ?? realCapacitySamples,
	};

	const daily: DailyEntry[] = [];
	const nodeRows: NodeEntry[] = [];
	const waits: WaitsEntry[] = [];
	const availability: AvailabilityEntry[] = [];
	const gapDays: { day: string; what: string }[] = [];

	for (const day of windowDays(sinceMs, nowMs)) {
		const row = byDay.get(day);
		// TODAY never reads the rollup store at all — it cannot hold a day
		// that has not closed, and the one exception a stray/bogus row for
		// today must not be trusted over the live truth.
		const settled = day === today ? undefined : row?.fleet;
		if (settled) {
			daily.push(dailyEntry(day, settled, false));
			for (const n of settled.nodes)
				nodeRows.push({
					day,
					node: n.node,
					jobs: n.jobs,
					runnerHours: n.runnerHours,
					failRate: n.failRate,
					fullShare: n.fullShare,
					unavailableShare: n.unavailableShare,
				});
			if (settled.waits) waits.push({ day, ...settled.waits });
			if (settled.availability) availability.push({ day, claws: settled.availability.claws });
			continue;
		}
		const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
		// TODAY is always live, however little of it has happened — the one
		// exception to the completeness gate. Every other unsettled day needs
		// job-history's own word that it can see the whole day.
		const canGoLive = day === today || (completeSinceMs !== null && dayStartMs >= completeSinceMs);
		if (canGoLive) {
			const fleet = liveDay(day, nowMs, nodes, liveDeps);
			daily.push(dailyEntry(day, fleet, true));
			for (const n of fleet.nodes)
				nodeRows.push({
					day,
					node: n.node,
					jobs: n.jobs,
					runnerHours: n.runnerHours,
					failRate: n.failRate,
					fullShare: n.fullShare,
					unavailableShare: n.unavailableShare,
					provisional: true,
				});
			if (fleet.waits) waits.push({ day, ...fleet.waits, provisional: true });
			if (fleet.availability)
				availability.push({ day, claws: fleet.availability.claws, provisional: true });
			continue;
		}
		// Past job-history's completeness: cannot go live. A row of ANY
		// schema still carries real counts — reconstruct what it can.
		if (row) {
			const p = partialFromRows(row.rows);
			daily.push({
				day,
				jobs: p.jobs,
				runnerHours: null,
				cancelled: p.cancelled,
				failures: p.failures,
				queue: { all: { n: p.queueAllN, p50: null, p80: null, p95: null }, byClass: {} },
				partial: true,
			});
			for (const n of p.nodes)
				nodeRows.push({
					day,
					node: n.node,
					jobs: n.jobs,
					runnerHours: null,
					failRate: n.failRate,
					fullShare: null,
					unavailableShare: null,
					partial: true,
				});
			// waits/availability: schema 1 has no decision-log or
			// capacity-sample join at all — never pushed for this day.
			continue;
		}
		gapDays.push({ day, what: 'no rollup recorded for this day' });
	}

	return {
		contract: CONTRACT,
		generatedAt: new Date(nowMs).toISOString(),
		days,
		since: new Date(sinceMs).toISOString(),
		daily,
		nodes: nodeRows,
		waits,
		availability,
		gaps: coalesceGaps(gapDays),
	};
}

/**
 * GET /api/fleet/performance?days=<1..120>
 * Same auth as GET /fleet: mgmt-api's `edgeOriginGuard` covers all of `/api`.
 * Mounted as `router.get('/fleet/performance', countHit, performanceHandler)`
 * in `routes/fleet.ts`, the same way every other route there is — a plain
 * handler rather than its own sub-router, so `countHit` stays the first
 * middleware the `FLEET_ROUTES` test checks for.
 *
 * `createPerformanceHandler` is the factory, so a test can hand it fixtures;
 * `performanceHandler` — the one `routes/fleet.ts` mounts — is that factory
 * called with no overrides. It cannot itself take a third `deps` parameter:
 * Express calls every route handler with `(req, res, next)`, and a `deps`
 * there would silently receive `next` in production.
 */
export function createPerformanceHandler(
	deps: PerformanceDeps = {}
): (req: Request, res: Response) => void {
	return (req, res) => {
		const days = parseDays(req.query.days);
		try {
			res.json(buildPerformanceReportWith(Date.now(), days, deps));
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Unknown error';
			// "I could not look" — the rollup store could not be read — is
			// never the same as an empty success (AGENTS.md).
			logger.error(`[fleet] GET /fleet/performance → 503 ${msg}`);
			res.status(503).json({ ok: false, reason: msg });
		}
	};
}

export const performanceHandler: (req: Request, res: Response) => void = createPerformanceHandler();
