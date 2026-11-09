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
	FLEET_NODE,
	ROLLUP_SCHEMA,
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

function rollupFixture(
	day: string,
	fleet: FleetDayAggregate | undefined,
	rows: RollupRow[] = []
): DayRollup {
	return {
		schema: fleet ? ROLLUP_SCHEMA : 1,
		day,
		writtenAt: NOW.toString(),
		completeSince: '2026-01-01T00:00:00.000Z',
		records: fleet?.jobs ?? 0,
		probesExcluded: 0,
		rows,
		...(fleet ? { fleet } : {}),
	};
}

/** A schema-1 `RollupRow`, the shape every pre-wave rollup row has. */
function rollupRow(o: Partial<RollupRow> & { node: string }): RollupRow {
	return {
		repo: 'WolffM/hadoku-cardtable',
		kind: 'forge-jvm',
		jobs: 0,
		conclusions: {},
		failuresByZone: { runner: 0, seam: 0, content: 0, fleet: 0, cancelled: 0 },
		durationSec: { n: 0, p50: null, p95: null },
		queueSec: { n: 0, p50: null, p95: null },
		dispatchSec: { n: 0, p50: null, p95: null },
		assignSec: { n: 0, p50: null, p95: null },
		setupSec: { n: 0, p50: null, p95: null },
		byClass: {},
		...o,
	};
}

function storeOf(days: DayRollup[]): () => RollupRead<RollupRow, FleetDayAggregate> {
	return () => ({ days, unreadableLines: 0, exists: true });
}

// `historyCompleteSinceMs: () => null` says job-history is EMPTY — nothing
// before today can go live, so every non-today day without a settled
// rollup stays a gap. Tests that want a day to go live override it.
const NO_LIVE: PerformanceDeps = {
	nodes: [],
	jobRecords: (): readonly JobRecord[] => [],
	historyCompleteSinceMs: () => null,
	decisionsSince: () => [],
	capacitySamples: () => [],
};

void test('the contract shape: contract 1, generatedAt/days/since, every array present', () => {
	const r = buildPerformanceReportWith(NOW, 3, { ...NO_LIVE, readRollups: storeOf([]) });
	assert.equal(r.contract, 1);
	assert.equal(r.days, 3);
	assert.equal(r.generatedAt, new Date(NOW).toISOString());
	assert.equal(r.since, dayAt(2), "since is the window's first UTC day, YYYY-MM-DD");
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
		historyCompleteSinceMs: () => null,
		decisionsSince: () => [],
		capacitySamples: () => [],
	});
	const today = r.daily.find((d) => d.day === TODAY);
	assert.ok(today);
	assert.equal(today.jobs, 1, 'the live job record, not the bogus rollup jobs:999');
	assert.equal(today.provisional, true, 'today is computed live, so it is provisional too');
});

void test('the window is exactly `days` UTC days ending today, and `since` is its first day — the dashboard counts `days` forward from it', () => {
	// The dashboard builds its x-axis as `dayRange(since, days)`, i.e.
	// `new Date(`${since}T00:00:00Z`)` plus 0..days-1. Until 2026-11-09 `since`
	// was the ISO timestamp `now - days`, which made that `Invalid Date` and
	// threw `RangeError: invalid date` on every render of Fleet › Performance.
	for (const days of [1, 7, 30, 90]) {
		const r = buildPerformanceReportWith(NOW, days, { ...NO_LIVE, readRollups: storeOf([]) });
		assert.match(r.since, /^\d{4}-\d{2}-\d{2}$/);
		const seen = [...r.daily.map((d) => d.day), ...r.gaps.flatMap((g) => [g.from, g.to])].sort();
		assert.equal(seen[0], r.since, `days=${days}: the oldest day reported is since`);
		assert.equal(seen[seen.length - 1], TODAY, `days=${days}: the window ends today`);
		const counted = new Date(`${r.since}T00:00:00Z`);
		counted.setUTCDate(counted.getUTCDate() + days - 1);
		assert.equal(
			counted.toISOString().slice(0, 10),
			TODAY,
			`days=${days}: since + days-1 is today`
		);
	}
});

void test('a day with no rollup and outside job-history completeness (completeSinceMs null): a gap, "no rollup recorded"', () => {
	const r = buildPerformanceReportWith(NOW, 5, { ...NO_LIVE, readRollups: storeOf([]) });
	const day = dayAt(4);
	assert.ok(!r.daily.some((d) => d.day === day));
	const gap = r.gaps.find((g) => g.from <= day && day <= g.to);
	assert.ok(gap);
	assert.equal(gap.what, 'no rollup recorded for this day');
});

void test('operator fix-up (wave fleettab): days without a settled rollup but WITHIN job-history completeness are computed live and marked provisional, never a gap', () => {
	// "now" = D at 15:00Z, rollups settled through D-3. D-2, D-1 and D (today)
	// have no settled row — the shape that used to render a ~3-day blank at
	// the right edge of every chart, reading as an outage every day.
	const d3 = dayAt(3);
	const d2 = dayAt(2);
	const d1 = dayAt(1);
	const settled = rollupFixture(d3, emptyAggregate({ jobs: 5 }));
	const rec = (day: string): JobRecord => ({
		repo: 'WolffM/hadoku-cardtable',
		runId: 1,
		jobId: 1,
		name: 'forge-jvm',
		runner: 'claw-1',
		labels: [],
		startedAt: new Date(Date.parse(`${day}T01:00:00.000Z`)).toISOString(),
		durationSec: 60,
		queueSec: 5,
		conclusion: 'success',
	});
	const r = buildPerformanceReportWith(NOW, 4, {
		nodes: ['claw-1'],
		readRollups: storeOf([settled]),
		// job-history can vouch for D-3 onward: D-2/D-1/today are all within it.
		historyCompleteSinceMs: () => Date.parse(`${d3}T00:00:00.000Z`),
		jobRecords: () => [rec(d2), rec(d1), rec(TODAY)],
		decisionsSince: () => [],
		capacitySamples: () => [],
	});
	for (const day of [d2, d1, TODAY]) {
		const row = r.daily.find((x) => x.day === day);
		assert.ok(row, `${day} missing from daily — rendered as a gap instead of live`);
		assert.equal(row.provisional, true, `${day} should be provisional`);
		assert.equal(row.jobs, 1, `${day} should reflect the live job record, not a stub`);
		const nodeRow = r.nodes.find((n) => n.day === day);
		assert.equal(nodeRow?.provisional, true, `${day}'s node row should be provisional too`);
		assert.ok(!r.gaps.some((g) => g.from <= day && day <= g.to), `${day} must not appear in gaps`);
	}
	const settledRow = r.daily.find((x) => x.day === d3);
	assert.ok(settledRow);
	assert.equal(settledRow.provisional, undefined, 'a settled day never carries provisional');
});

void test('operator addition: a schema-1 row OUTSIDE job-history completeness is `partial`, not a gap — exact counts, null percentiles', () => {
	const day = dayAt(10);
	const rows: RollupRow[] = [
		rollupRow({
			node: FLEET_NODE,
			jobs: 5,
			conclusions: { success: 3, failure: 1, cancelled: 1 },
			failuresByZone: { runner: 0, seam: 0, content: 1, fleet: 0, cancelled: 1 },
			queueSec: { n: 4, p50: 12, p95: 90 },
		}),
		rollupRow({
			node: 'claw-1',
			jobs: 3,
			conclusions: { success: 2, failure: 1 },
			failuresByZone: { runner: 0, seam: 0, content: 1, fleet: 0, cancelled: 0 },
			queueSec: { n: 3, p50: 10, p95: 50 },
		}),
		rollupRow({
			node: 'claw-5',
			repo: 'WolffM/hadoku_site',
			kind: 'lint',
			jobs: 2,
			conclusions: { success: 1, cancelled: 1 },
			failuresByZone: { runner: 0, seam: 0, content: 0, fleet: 0, cancelled: 1 },
			queueSec: { n: 1, p50: 5, p95: 5 },
		}),
	];
	const r = buildPerformanceReportWith(NOW, 11, {
		...NO_LIVE,
		readRollups: storeOf([rollupFixture(day, undefined, rows)]),
	});
	assert.ok(
		!r.gaps.some((g) => g.from <= day && day <= g.to),
		'a schema-1 row must not render as a gap'
	);
	const daily = r.daily.find((d) => d.day === day);
	assert.ok(daily);
	assert.equal(daily.partial, true);
	assert.equal(daily.jobs, 5, 'summed from the node: "*" row, exact');
	assert.equal(daily.cancelled, 1);
	assert.deepEqual(daily.failures, { code: 1, setup: 0, fleet: 0 });
	assert.equal(daily.runnerHours, null, 'schema 1 kept no raw duration sum');
	assert.deepEqual(
		daily.queue.all,
		{ n: 4, p50: null, p80: null, p95: null },
		'n sums; percentiles never merge across groups'
	);
	assert.deepEqual(daily.queue.byClass, {}, 'no class breakdown existed in schema 1');
	const claw1 = r.nodes.find((n) => n.day === day && n.node === 'claw-1');
	assert.ok(claw1);
	assert.equal(claw1.partial, true);
	assert.equal(claw1.jobs, 3);
	assert.equal(
		claw1.failRate,
		1 / 3,
		'non-success, non-cancelled over jobs — exact from conclusions'
	);
	assert.equal(claw1.runnerHours, null);
	assert.equal(claw1.fullShare, null);
	assert.equal(claw1.unavailableShare, null);
	assert.ok(!r.waits.some((w) => w.day === day), 'schema 1 has no decision-log join at all');
	assert.ok(
		!r.availability.some((a) => a.day === day),
		'schema 1 has no capacity-sample join at all'
	);
});

void test('consecutive gap days (no rollup row at all) coalesce into one {from,to,what} range', () => {
	const r = buildPerformanceReportWith(NOW, 10, { ...NO_LIVE, readRollups: storeOf([]) });
	// A `days=10` window is 10 UTC days (dayAt(9)..dayAt(0) inclusive).
	// dayAt(1..9) (not today) all fail the completeness gate under NO_LIVE,
	// so every one of them is a gap; today alone is live and not a gap.
	assert.equal(r.gaps.length, 1, `expected one coalesced range, got: ${JSON.stringify(r.gaps)}`);
	assert.equal(r.gaps[0].what, 'no rollup recorded for this day');
	assert.equal(r.gaps[0].from, dayAt(9));
	assert.equal(r.gaps[0].to, dayAt(1));
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
