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
 * GAPS ARE NAMED, NEVER ZEROED. A day with no durable row (not yet settled,
 * written before this wave and so missing the `fleet` field, or simply never
 * backfilled) is listed in `gaps`, with a reason, and left OUT of `daily`/
 * `nodes`/`waits`/`availability` — a day this route could not account for
 * must never render identically to a day that was genuinely quiet
 * (AGENTS.md: "I could not look" must never render as "nothing is wrong").
 * The per-field `null`s inside a day that WAS found (`waits`/`availability`/
 * `fullShare`/`unavailableShare`) are a narrower version of the same rule —
 * see `job-rollups-fleet.ts`'s own header — and this route passes them
 * through unchanged rather than coercing them to zero.
 */
import { join } from 'node:path';

import type { Request, Response } from 'express';

import { logger, stateDir } from '../host.js';
import { loadFleetNodeNames } from '../lib/manifest.js';
import { jobRecords, type JobRecord } from '../job-history-store.js';
import { readDecisions, decisionLogDir } from '../runners/decision-log-storage.js';
import type { DecisionRecord } from '../runners/decision-log-types.js';
import { capacitySampleStore, CAPACITY_SAMPLE_FILE } from '../capacity-sample-store.js';
import type { CapacitySampleRow } from '../capacity-sample-store.js';
import {
	readRollupStore,
	SETTLE_HOURS,
	utcDay,
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

/** A day the window needs has SETTLED (would be closed in a healthy fleet) once this long has passed since it ended. */
function isSettled(day: string, nowMs: number): boolean {
	const dayEndMs = Date.parse(`${day}T00:00:00.000Z`) + DAY_MS;
	return nowMs - dayEndMs >= SETTLE_HOURS * 3600_000;
}

export interface DailyEntry {
	day: string;
	jobs: number;
	runnerHours: number;
	cancelled: number;
	failures: FleetDayAggregate['failures'];
	queue: FleetDayAggregate['queue'];
}

export interface NodeEntry {
	day: string;
	node: string;
	jobs: number;
	runnerHours: number;
	failRate: number;
	fullShare: number | null;
	unavailableShare: number | null;
}

export interface WaitsEntry {
	day: string;
	capacity: number;
	constraints: number;
	held: number;
	other: number;
}

export interface AvailabilityEntry {
	day: string;
	claws: number;
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

function dailyEntry(day: string, a: FleetDayAggregate): DailyEntry {
	return {
		day,
		jobs: a.jobs,
		runnerHours: a.runnerHours,
		cancelled: a.cancelled,
		failures: a.failures,
		queue: a.queue,
	};
}

/** Everything `buildPerformanceReportWith` reads from the live process or disk — a test seam, each defaulting to the real read. */
export interface PerformanceDeps {
	nodes?: readonly string[];
	/** The rollup store's own read. Thrown by a real I/O error, which a test can reproduce by injecting a function that throws. */
	readRollups?: () => RollupRead<RollupRow, FleetDayAggregate>;
	/** Every in-memory job-history record, any day — filtered down to today's by the caller. */
	jobRecords?: () => readonly JobRecord[];
	/** Today's dispatch-decision rows. `null`: the log could not be read. */
	todayDecisions?: () => readonly DecisionRecord[] | null;
	/** Today's capacity-sample rows. `null`: the store could not be read. */
	todayCapacitySamples?: () => readonly CapacitySampleRow[] | null;
}

function realTodayDecisions(dayStartMs: number, nowMs: number): readonly DecisionRecord[] | null {
	try {
		return readDecisions(decisionLogDir(), { sinceMs: dayStartMs, untilMs: nowMs }).records;
	} catch (err) {
		logger.warn(
			`[fleet-performance] could not read the dispatch-decision log for today: ` +
				`${err instanceof Error ? err.message : String(err)}`
		);
		return null;
	}
}

function realTodayCapacitySamples(): readonly CapacitySampleRow[] | null {
	try {
		return capacitySampleStore(join(stateDir(), CAPACITY_SAMPLE_FILE)).read().rows;
	} catch (err) {
		logger.warn(
			`[fleet-performance] could not read capacity samples for today: ` +
				`${err instanceof Error ? err.message : String(err)}`
		);
		return null;
	}
}

/** Today's aggregate, computed LIVE over whatever each source currently holds — never from the rollup store, which cannot hold an open day. */
function liveToday(
	day: string,
	nowMs: number,
	nodes: readonly string[],
	deps: Required<Pick<PerformanceDeps, 'jobRecords' | 'todayDecisions' | 'todayCapacitySamples'>>
): FleetDayAggregate {
	const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
	const inDay = (atIso: string): boolean => {
		const ms = Date.parse(atIso);
		return Number.isFinite(ms) && ms >= dayStartMs && ms < dayStartMs + DAY_MS;
	};
	const records = deps.jobRecords().filter((r) => inDay(r.startedAt) && !r.probe);
	const decisions = deps.todayDecisions();
	const capacitySamples = deps.todayCapacitySamples();
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

function gapReason(
	day: string,
	today: string,
	nowMs: number,
	found: DayRollup | undefined
): string {
	if (!isSettled(day, nowMs) && day !== today)
		return `not yet settled (closes ${SETTLE_HOURS}h after the day ends)`;
	if (!found) return 'no rollup recorded for this day';
	return 'rollup predates the fleet aggregate (schema 1)';
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
	const todayStartMs = Date.parse(`${today}T00:00:00.000Z`);
	const liveDeps = {
		jobRecords: deps.jobRecords ?? jobRecords,
		todayDecisions: deps.todayDecisions ?? (() => realTodayDecisions(todayStartMs, nowMs)),
		todayCapacitySamples: deps.todayCapacitySamples ?? realTodayCapacitySamples,
	};

	const daily: DailyEntry[] = [];
	const nodeRows: NodeEntry[] = [];
	const waits: WaitsEntry[] = [];
	const availability: AvailabilityEntry[] = [];
	const gapDays: { day: string; what: string }[] = [];

	for (const day of windowDays(sinceMs, nowMs)) {
		const fleet: FleetDayAggregate | undefined =
			day === today ? liveToday(day, nowMs, nodes, liveDeps) : byDay.get(day)?.fleet;
		if (!fleet) {
			gapDays.push({ day, what: gapReason(day, today, nowMs, byDay.get(day)) });
			continue;
		}
		daily.push(dailyEntry(day, fleet));
		for (const n of fleet.nodes)
			nodeRows.push({
				day,
				node: n.node,
				jobs: n.jobs,
				runnerHours: n.runnerHours,
				failRate: n.failRate,
				fullShare: n.fullShare,
				unavailableShare: n.unavailableShare,
			});
		if (fleet.waits) waits.push({ day, ...fleet.waits });
		if (fleet.availability) availability.push({ day, claws: fleet.availability.claws });
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
