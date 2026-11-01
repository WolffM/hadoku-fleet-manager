/**
 * fleet-stats — hand-computed expectations for the five `fleet stats`
 * sections (refactor plan §7.3 T6). PURE module, no host/state-dir fixture:
 * every input is built by hand below, the same style `failure-rates.test.ts`
 * already uses for its own pure module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CapacitySampleRow } from '../capacity-sample-store.js';
import {
	automationHealthStats,
	budgetStats,
	capacityStats,
	dailyJobStats,
	repoJobStats,
} from '../fleet-stats.js';
import type { GhBudgetHistoryRow } from '../gh-budget-history-store.js';
import type { JobRunRow } from '../job-run-store.js';
import type { DayRollup, RollupRow, Spread } from '../job-rollups.js';

const NO_SPREAD: Spread = { n: 0, p50: null, p95: null };

function zoneCounts(partial: Partial<Record<string, number>> = {}) {
	return { runner: 0, seam: 0, content: 0, fleet: 0, cancelled: 0, ...partial };
}

function row(
	node: string,
	repo: string,
	kind: string,
	jobs: number,
	opts: { fails?: Partial<Record<string, number>>; queueSec?: Spread } = {}
): RollupRow {
	const z = zoneCounts(opts.fails);
	const failed = Object.values(z).reduce((a, b) => a + b, 0);
	return {
		node,
		repo,
		kind,
		jobs,
		conclusions: { success: jobs - failed, failure: failed },
		failuresByZone: z,
		durationSec: NO_SPREAD,
		queueSec: opts.queueSec ?? NO_SPREAD,
		dispatchSec: NO_SPREAD,
		assignSec: NO_SPREAD,
		setupSec: NO_SPREAD,
		byClass: {},
	};
}

function day(d: string, rows: RollupRow[]): DayRollup {
	return {
		schema: 1,
		day: d,
		writtenAt: `${d}T06:00:00.000Z`,
		completeSince: `${d}T00:00:00.000Z`,
		records: 1,
		probesExcluded: 0,
		rows,
	};
}

// ── (a) dailyJobStats ────────────────────────────────────────────────────────

test('dailyJobStats: fleet row only — a non-fleet node row is never double-counted', () => {
	const days = [
		day('2026-10-01', [
			row('*', 'WolffM/a', 'build', 100, { fails: { runner: 5 } }),
			row('claw-1', 'WolffM/a', 'build', 60, { fails: { runner: 3 } }),
			row('claw-2', 'WolffM/a', 'build', 40, { fails: { runner: 2 } }),
		]),
	];
	const [stats] = dailyJobStats(days);
	assert.equal(stats.day, '2026-10-01');
	assert.equal(stats.jobs, 100, 'only the fleet row counts — not 100+60+40');
	assert.equal(stats.conclusions.success, 95);
	assert.equal(stats.conclusions.failure, 5);
});

test('dailyJobStats: queue p50/p95 is a SAMPLE-WEIGHTED MEAN across the fleet rows for that day', () => {
	const days = [
		day('2026-10-01', [
			row('*', 'WolffM/a', 'build', 80, { queueSec: { n: 80, p50: 10, p95: 20 } }),
			row('*', 'WolffM/a', 'test', 20, { queueSec: { n: 20, p50: 30, p95: 60 } }),
		]),
	];
	const [stats] = dailyJobStats(days);
	// weighted p50 = (80*10 + 20*30) / 100 = 14 ; weighted p95 = (80*20 + 20*60) / 100 = 28
	assert.equal(stats.queueSec.n, 100);
	assert.equal(stats.queueSec.p50, 14);
	assert.equal(stats.queueSec.p95, 28);
});

test('dailyJobStats: a day with zero queued samples reports n:0 and null percentiles, never 0', () => {
	const days = [day('2026-10-01', [row('*', 'WolffM/a', 'build', 5)])];
	const [stats] = dailyJobStats(days);
	assert.deepEqual(stats.queueSec, { n: 0, p50: null, p95: null });
});

test('dailyJobStats: one row per day, oldest-input-order preserved', () => {
	const days = [
		day('2026-10-01', [row('*', 'WolffM/a', 'build', 1)]),
		day('2026-10-02', [row('*', 'WolffM/a', 'build', 2)]),
	];
	const stats = dailyJobStats(days);
	assert.deepEqual(
		stats.map((s) => s.day),
		['2026-10-01', '2026-10-02']
	);
	assert.deepEqual(
		stats.map((s) => s.jobs),
		[1, 2]
	);
});

// ── (b) repoJobStats ─────────────────────────────────────────────────────────

test('repoJobStats: sums the fleet row across days AND kinds for the same repo', () => {
	const days = [
		day('2026-10-01', [
			row('*', 'WolffM/a', 'build', 10, { fails: { runner: 1 } }),
			row('*', 'WolffM/a', 'test', 5, { fails: { seam: 1 } }),
			row('*', 'WolffM/b', 'build', 100),
		]),
		day('2026-10-02', [row('*', 'WolffM/a', 'build', 7)]),
	];
	const stats = repoJobStats(days);
	const a = stats.find((s) => s.repo === 'WolffM/a');
	assert.ok(a);
	assert.equal(a.jobs, 22);
	assert.equal(a.failuresByZone.runner, 1);
	assert.equal(a.failuresByZone.seam, 1);
	// most jobs first
	assert.equal(stats[0].repo, 'WolffM/b');
});

test('repoJobStats: ignores non-fleet rows entirely', () => {
	const days = [day('2026-10-01', [row('claw-1', 'WolffM/a', 'build', 999)])];
	assert.deepEqual(repoJobStats(days), []);
});

// ── (c) automationHealthStats ───────────────────────────────────────────────

function runRow(
	job: string,
	startedAt: string,
	verdict: JobRunRow['verdict'],
	why: string | null = null
): JobRunRow {
	return {
		v: 1,
		job,
		startedAt,
		durationMs: 100,
		kind: 'gate',
		verdict,
		findings: null,
		why,
		host: 'h',
	};
}

test('automationHealthStats: a registry job with ZERO runs in the window is still reported, never absent', () => {
	const stats = automationHealthStats([], ['ci:never-ran']);
	assert.deepEqual(stats, [
		{
			job: 'ci:never-ran',
			runs: 0,
			lastRun: null,
			verdictCounts: { ok: 0, findings: 0, error: 0, 'could-not-look': 0 },
		},
	]);
});

test('automationHealthStats: lastRun is the NEWEST row regardless of input order; verdicts tallied', () => {
	const rows = [
		runRow('ci:x', '2026-10-01T00:00:00.000Z', 'ok'),
		runRow('ci:x', '2026-10-03T00:00:00.000Z', 'error', 'boom'),
		runRow('ci:x', '2026-10-02T00:00:00.000Z', 'findings'),
	];
	const [stats] = automationHealthStats(rows, ['ci:x']);
	assert.equal(stats.runs, 3);
	assert.deepEqual(stats.lastRun, {
		startedAt: '2026-10-03T00:00:00.000Z',
		verdict: 'error',
		why: 'boom',
	});
	assert.deepEqual(stats.verdictCounts, { ok: 1, findings: 1, error: 1, 'could-not-look': 0 });
});

test('automationHealthStats: a row naming a job NOT in the registry list is still surfaced, not dropped', () => {
	const stats = automationHealthStats(
		[runRow('ci:mystery', '2026-10-01T00:00:00.000Z', 'ok')],
		['ci:known']
	);
	assert.deepEqual(
		stats.map((s) => s.job),
		['ci:known', 'ci:mystery']
	);
});

// ── (d) capacityStats ────────────────────────────────────────────────────────

function capRow(node: string, over: Partial<CapacitySampleRow> = {}): CapacitySampleRow {
	return {
		at: '2026-10-01T00:00:00.000Z',
		node,
		maxConcurrent: 4,
		admissionCapacity: 4,
		admissionFree: 2,
		admissionBasis: 'dispatcher',
		state: 'free',
		drained: false,
		refusalReason: null,
		unmeasured: false,
		...over,
	};
}

test('capacityStats: counts unmeasured/drained/atCapacity independently, per node', () => {
	const rows = [
		capRow('claw-1', { admissionFree: 0 }), // at capacity
		capRow('claw-1', { drained: true }),
		capRow('claw-1', { unmeasured: true, admissionCapacity: null, admissionFree: null }),
		capRow('claw-2', {}),
	];
	const stats = capacityStats(rows);
	const c1 = stats.find((s) => s.node === 'claw-1');
	assert.ok(c1);
	assert.equal(c1.samples, 3);
	assert.equal(c1.atCapacity, 1);
	assert.equal(c1.drained, 1);
	assert.equal(c1.unmeasured, 1);
	const c2 = stats.find((s) => s.node === 'claw-2');
	assert.equal(c2?.samples, 1);
	assert.equal(c2?.atCapacity, 0);
});

test('capacityStats: an UNMEASURED sample is never counted at-capacity, even if admissionFree happens to read 0', () => {
	// Should not occur in practice (unmeasured carries null/null), but the
	// guard is `!r.unmeasured && ...` — prove it holds even against a
	// malformed row that claims both.
	const rows = [capRow('claw-1', { unmeasured: true, admissionFree: 0 })];
	const [stats] = capacityStats(rows);
	assert.equal(stats.atCapacity, 0);
	assert.equal(stats.unmeasured, 1);
});

// ── (e) budgetStats ──────────────────────────────────────────────────────────

function budgetRow(over: Partial<GhBudgetHistoryRow> = {}): GhBudgetHistoryRow {
	return {
		windowEnd: '2026-10-01T01:00:00.000Z',
		token: 'main',
		resource: 'core',
		limit: 5000,
		usedAtEnd: 100,
		remainingAtEnd: 4900,
		byCaller: [],
		restarts: 0,
		...over,
	};
}

test('budgetStats: peak used/limit across windows, and top callers summed and ranked', () => {
	const rows = [
		budgetRow({ usedAtEnd: 1000, byCaller: [{ caller: 'ci:a', charged: 10, notModified: 5 }] }),
		budgetRow({
			windowEnd: '2026-10-01T02:00:00.000Z',
			usedAtEnd: 4000,
			byCaller: [
				{ caller: 'ci:a', charged: 40, notModified: 0 },
				{ caller: 'ci:b', charged: 90, notModified: 0 },
			],
		}),
	];
	const [stats] = budgetStats(rows);
	assert.equal(stats.token, 'main');
	assert.equal(stats.resource, 'core');
	assert.equal(stats.windows, 2);
	assert.equal(stats.peakUsed, 4000);
	assert.equal(stats.limit, 5000);
	assert.equal(stats.peakUsedPct, 80);
	assert.deepEqual(stats.topCallers, [
		{ caller: 'ci:b', charged: 90 },
		{ caller: 'ci:a', charged: 50 },
	]);
});

test('budgetStats: counts the windows that ended with nothing left, not just the peak', () => {
	// A 100% peak reads the same whether it happened once or every hour; the
	// count of exhausted windows is what tells the two apart.
	const rows = [
		budgetRow({ usedAtEnd: 5000, remainingAtEnd: 0 }),
		budgetRow({ windowEnd: '2026-10-01T02:00:00.000Z', usedAtEnd: 1500, remainingAtEnd: 3500 }),
		budgetRow({ windowEnd: '2026-10-01T03:00:00.000Z', usedAtEnd: 5000, remainingAtEnd: 0 }),
	];
	const [stats] = budgetStats(rows);
	assert.equal(stats.peakUsedPct, 100);
	assert.equal(stats.exhaustedWindows, 2);
	assert.equal(stats.windows, 3);
});

test('budgetStats: separate (token, resource) pairs never mix', () => {
	const rows = [
		budgetRow({ token: 'main', resource: 'core' }),
		budgetRow({ token: 'secondary', resource: 'graphql' }),
	];
	const stats = budgetStats(rows);
	assert.equal(stats.length, 2);
	assert.deepEqual(
		stats.map((s) => `${s.token}/${s.resource}`),
		['main/core', 'secondary/graphql']
	);
});

test('budgetStats: topCallers is truncated to the requested count, ties broken alphabetically', () => {
	const rows = [
		budgetRow({
			byCaller: [
				{ caller: 'ci:z', charged: 5, notModified: 0 },
				{ caller: 'ci:y', charged: 5, notModified: 0 },
				{ caller: 'ci:x', charged: 1, notModified: 0 },
			],
		}),
	];
	const [stats] = budgetStats(rows, { topCallers: 2 });
	assert.deepEqual(
		stats.topCallers.map((c) => c.caller),
		['ci:y', 'ci:z']
	);
});
