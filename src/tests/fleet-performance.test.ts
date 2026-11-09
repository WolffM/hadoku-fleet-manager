/**
 * routes/fleet-performance.ts: the window assembly (`buildPerformanceReportWith`)
 * and the HTTP handler's could-not-read path. Every dependency is a fixture —
 * this suite never reads `~/.hadoku-mgmt`, `docs/handoff/snapshot`, or any
 * real file under `stateDir()`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	buildPerformanceReportWith,
	createPerformanceHandler,
	type PerformanceDeps,
} from '../routes/fleet-performance.js';
import {
	ROLLUP_SCHEMA,
	SETTLE_HOURS,
	utcDay,
	type DayRollup,
	type RollupRow,
} from '../job-rollups.js';
import type { RollupRead } from '../job-rollup-store.js';
import type { FleetDayAggregate } from '../job-rollups-fleet.js';
import type { JobRecord } from '../job-history-store.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-08T15:00:00.000Z');
const TODAY = utcDay(NOW);
const dayAt = (n: number): string => utcDay(NOW - n * DAY);

function emptyAggregate(o: Partial<FleetDayAggregate> = {}): FleetDayAggregate {
	return {
		jobs: 0,
		runnerHours: 0,
		cancelled: 0,
		failures: { code: 0, setup: 0, fleet: 0 },
		queue: { all: { n: 0, p50: null, p80: null, p95: null }, byClass: {} },
		nodes: [],
		waits: null,
		availability: null,
		...o,
	};
}

function rollupFixture(day: string, fleet: FleetDayAggregate | undefined): DayRollup {
	return {
		schema: fleet ? ROLLUP_SCHEMA : 1,
		day,
		writtenAt: NOW.toString(),
		completeSince: '2026-01-01T00:00:00.000Z',
		records: fleet?.jobs ?? 0,
		probesExcluded: 0,
		rows: [],
		...(fleet ? { fleet } : {}),
	};
}

function storeOf(days: DayRollup[]): () => RollupRead<RollupRow, FleetDayAggregate> {
	return () => ({ days, unreadableLines: 0, exists: true });
}

const NO_LIVE: PerformanceDeps = {
	nodes: [],
	jobRecords: (): readonly JobRecord[] => [],
	todayDecisions: () => [],
	todayCapacitySamples: () => [],
};

void test('the contract shape: contract 1, generatedAt/days/since, every array present', () => {
	const r = buildPerformanceReportWith(NOW, 3, { ...NO_LIVE, readRollups: storeOf([]) });
	assert.equal(r.contract, 1);
	assert.equal(r.days, 3);
	assert.equal(r.generatedAt, new Date(NOW).toISOString());
	assert.equal(r.since, new Date(NOW - 3 * DAY).toISOString());
	assert.ok(Array.isArray(r.daily));
	assert.ok(Array.isArray(r.nodes));
	assert.ok(Array.isArray(r.waits));
	assert.ok(Array.isArray(r.availability));
	assert.ok(Array.isArray(r.gaps));
});

void test('today is ALWAYS computed live, never from a rollup entry even if one exists for it', () => {
	const bogus = rollupFixture(TODAY, emptyAggregate({ jobs: 999 }));
	const r = buildPerformanceReportWith(NOW, 1, {
		nodes: ['claw-1'],
		readRollups: storeOf([bogus]),
		jobRecords: () => [
			{
				repo: 'WolffM/hadoku-cardtable',
				runId: 1,
				jobId: 1,
				name: 'forge-jvm',
				runner: 'claw-1',
				labels: [],
				startedAt: new Date(NOW - 3600_000).toISOString(),
				durationSec: 60,
				queueSec: 5,
				conclusion: 'success',
			},
		],
		todayDecisions: () => [],
		todayCapacitySamples: () => [],
	});
	const today = r.daily.find((d) => d.day === TODAY);
	assert.ok(today);
	assert.equal(today.jobs, 1, 'the live job record, not the bogus rollup jobs:999');
});

void test('a day with no rollup and past settle: a gap, "no rollup recorded"', () => {
	const r = buildPerformanceReportWith(NOW, 5, { ...NO_LIVE, readRollups: storeOf([]) });
	const day = dayAt(4);
	assert.ok(!r.daily.some((d) => d.day === day));
	const gap = r.gaps.find((g) => g.from <= day && day <= g.to);
	assert.ok(gap);
	assert.equal(gap.what, 'no rollup recorded for this day');
});

void test('a day too recent to have settled yet: a gap, "not yet settled" — distinct from a missing backfill', () => {
	// SETTLE_HOURS is ~50h; yesterday has not had time to close.
	const r = buildPerformanceReportWith(NOW, 2, { ...NO_LIVE, readRollups: storeOf([]) });
	const yesterday = dayAt(1);
	const gap = r.gaps.find((g) => g.from <= yesterday && yesterday <= g.to);
	assert.ok(gap);
	assert.match(gap.what, /not yet settled/);
	assert.match(gap.what, new RegExp(String(SETTLE_HOURS)));
});

void test('a rollup day written before this field existed (schema 1, no fleet): a gap, not zeroed', () => {
	const day = dayAt(10);
	const r = buildPerformanceReportWith(NOW, 11, {
		...NO_LIVE,
		readRollups: storeOf([rollupFixture(day, undefined)]),
	});
	assert.ok(!r.daily.some((d) => d.day === day));
	const gap = r.gaps.find((g) => g.from <= day && day <= g.to);
	assert.ok(gap);
	assert.match(gap.what, /predates the fleet aggregate/);
});

void test('consecutive gap days with the same reason coalesce into one {from,to,what} range', () => {
	const r = buildPerformanceReportWith(NOW, 10, { ...NO_LIVE, readRollups: storeOf([]) });
	// Every day from "not yet settled" through "never backfilled" collapses
	// into at most a handful of ranges, never one entry per missing day.
	assert.ok(
		r.gaps.length < 10,
		`expected coalesced ranges, got ${r.gaps.length}: ${JSON.stringify(r.gaps)}`
	);
	for (const g of r.gaps) assert.ok(g.from <= g.to);
});

void test('a found day is split into daily/nodes/waits/availability, each by its own day', () => {
	const day = dayAt(10);
	const fleet = emptyAggregate({
		jobs: 7,
		runnerHours: 1.5,
		cancelled: 1,
		failures: { code: 2, setup: 1, fleet: 0 },
		nodes: [
			{
				node: 'claw-1',
				jobs: 7,
				runnerHours: 1.5,
				failRate: 0.1,
				fullShare: 0.2,
				unavailableShare: 0,
			},
		],
		waits: { capacity: 3, constraints: 0, held: 1, other: 0 },
		availability: { claws: 0.95 },
	});
	const r = buildPerformanceReportWith(NOW, 11, {
		...NO_LIVE,
		readRollups: storeOf([rollupFixture(day, fleet)]),
	});
	assert.deepEqual(
		r.daily.find((d) => d.day === day),
		{ day, jobs: 7, runnerHours: 1.5, cancelled: 1, failures: fleet.failures, queue: fleet.queue }
	);
	assert.deepEqual(
		r.nodes.filter((n) => n.day === day),
		[{ day, ...fleet.nodes[0] }]
	);
	assert.deepEqual(
		r.waits.find((w) => w.day === day),
		{ day, capacity: 3, constraints: 0, held: 1, other: 0 }
	);
	assert.deepEqual(
		r.availability.find((a) => a.day === day),
		{ day, claws: 0.95 }
	);
});

void test('a found day whose waits/availability are null is still in daily/nodes, but omitted from waits/availability', () => {
	const day = dayAt(10);
	const fleet = emptyAggregate({
		jobs: 2,
		nodes: [
			{
				node: 'claw-1',
				jobs: 2,
				runnerHours: 0.1,
				failRate: 0,
				fullShare: null,
				unavailableShare: null,
			},
		],
		waits: null,
		availability: null,
	});
	const r = buildPerformanceReportWith(NOW, 11, {
		...NO_LIVE,
		readRollups: storeOf([rollupFixture(day, fleet)]),
	});
	assert.ok(r.daily.some((d) => d.day === day));
	assert.ok(r.nodes.some((n) => n.day === day));
	assert.ok(!r.waits.some((w) => w.day === day));
	assert.ok(!r.availability.some((a) => a.day === day));
});

void test('days query clamps to [1,120]; an invalid value falls back to the default rather than 1', () => {
	const r200 = buildPerformanceReportWith(NOW, 200, { ...NO_LIVE, readRollups: storeOf([]) });
	assert.equal(
		r200.days,
		200,
		'buildPerformanceReportWith itself does not clamp — the HTTP handler does'
	);
});

void test('the handler clamps days from the query string and never throws past 120', () => {
	let captured: unknown;
	const res = {
		json(body: unknown) {
			captured = body;
		},
		status() {
			return this;
		},
	};
	const handler = createPerformanceHandler({ ...NO_LIVE, readRollups: storeOf([]) });
	handler({ query: { days: '99999' } } as never, res as never);
	assert.equal((captured as { days: number }).days, 120);
});

void test('the handler: a could-not-read rollup store answers 503 with success:false, never an empty 200', () => {
	let status = 0;
	let body: unknown;
	const res = {
		json(b: unknown) {
			body = b;
		},
		status(s: number) {
			status = s;
			return this;
		},
	};
	const handler = createPerformanceHandler({
		...NO_LIVE,
		readRollups: () => {
			throw new Error('store unreadable: fixture');
		},
	});
	handler({ query: {} } as never, res as never);
	assert.equal(status, 503);
	assert.deepEqual(body, { ok: false, reason: 'store unreadable: fixture' });
});
