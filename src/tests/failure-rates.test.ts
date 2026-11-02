/**
 * failure-rates — hand-computed expectations for the standardized-excess
 * statistic (refactor plan §7.3 T3). PURE module, no host/state-dir fixture:
 * every input is a {@link DayRollup} built by hand below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { failuresByZone } from '../job-history-zone.js';
import type { DayRollup, RollupRow, Spread } from '../job-rollups.js';
import {
	ALL_ZONES,
	FLEET_ORIGIN_ZONES,
	computeFailureRates,
	type FailureZoneName,
} from '../failure-rates.js';

const NO_SPREAD: Spread = { n: 0, p50: null, p95: null };

function zoneCounts(partial: Partial<Record<FailureZoneName, number>> = {}) {
	const out: Record<FailureZoneName, number> = {
		runner: 0,
		seam: 0,
		content: 0,
		fleet: 0,
		cancelled: 0,
	};
	return { ...out, ...partial };
}

/** One rollup row. `fails` names which zones' counts to set; the rest default to 0. */
function row(
	node: string,
	repo: string,
	kind: string,
	jobs: number,
	fails: Partial<Record<FailureZoneName, number>> = {}
): RollupRow {
	const z = zoneCounts(fails);
	const failed = Object.values(z).reduce((a, b) => a + b, 0);
	return {
		node,
		repo,
		kind,
		jobs,
		conclusions: { success: jobs - failed, failure: failed },
		failuresByZone: z,
		durationSec: NO_SPREAD,
		queueSec: NO_SPREAD,
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
		records: rows.filter((r) => r.node !== '*').reduce((n, r) => n + r.jobs, 0),
		probesExcluded: 0,
		rows,
	};
}

const REPO = 'WolffM/hadoku-cardtable';

// ── the zone list is not a second source of truth ──────────────────────────

test('ALL_ZONES matches FailuresByZone exactly, so the two can never drift apart', () => {
	const real = Object.keys(failuresByZone([])).sort();
	assert.deepEqual([...ALL_ZONES].sort(), real);
});

// ── the statistic, hand-computed ────────────────────────────────────────────

test('z and p-value match a hand-computed balanced cell (q=0.5)', () => {
	const days = [
		day('2026-10-20', [
			row('*', REPO, 'build', 100, { runner: 50 }),
			// expected = 4*0.5 = 2; excess = 4-2 = 2; variance = 4*0.5*0.5 = 1; z = 2
			row('claw-1', REPO, 'build', 4, { runner: 4 }),
			// expected = 4*0.5 = 2; excess = 0; z = 0
			row('claw-2', REPO, 'build', 4, { runner: 2 }),
		]),
	];
	const report = computeFailureRates(days, {
		minNodeJobs: 1,
		minExpected: 0.1,
		minCellFleetJobs: 1,
	});
	const c1 = report.nodes.find((n) => n.node === 'claw-1')!;
	const c2 = report.nodes.find((n) => n.node === 'claw-2')!;

	assert.equal(c1.insufficientData, false);
	assert.equal(c1.expected, 2);
	assert.equal(c1.excess, 2);
	assert.ok(c1.z !== null && Math.abs(c1.z - 2) < 1e-9, `z=${c1.z}`);
	// Standard normal upper tail at z=2 is 0.0227501319... (a textbook figure,
	// not re-derived from this module's own erf approximation).
	assert.ok(c1.pValue !== null && Math.abs(c1.pValue - 0.02275) < 0.0005, `p=${c1.pValue}`);

	assert.equal(c2.excess, 0);
	assert.equal(c2.z, 0);
	assert.equal(c2.pValue, 0.5);

	// claw-1 (the only node with an excess) ranks worse than claw-2.
	assert.ok(
		report.nodes.findIndex((n) => n.node === 'claw-1') <
			report.nodes.findIndex((n) => n.node === 'claw-2')
	);
});

test('a node with a HARD job mix but a FLEET-NORMAL per-cell rate does not rank as worst', () => {
	const days = [
		day('2026-10-20', [
			// The heavy cell: fleet-wide 20% failure rate because the WORK is hard.
			row('*', 'WolffM/hadoku-forge', 'forge-jvm', 500, { runner: 100 }),
			// claw-heavy runs ONLY this cell, at EXACTLY the fleet's own rate for it.
			row('claw-heavy', 'WolffM/hadoku-forge', 'forge-jvm', 200, { runner: 40 }),
			// The light cell: fleet-wide 2% failure rate — ordinary work.
			row('*', REPO, 'unit', 1000, { runner: 20 }),
			// claw-light runs this cell at DOUBLE the fleet's rate (4%), with
			// enough volume for that to be a real signal.
			row('claw-light', REPO, 'unit', 500, { runner: 20 }),
		]),
	];
	const report = computeFailureRates(days); // defaults: no override needed

	const heavy = report.nodes.find((n) => n.node === 'claw-heavy')!;
	const light = report.nodes.find((n) => n.node === 'claw-light')!;

	// The trap this statistic exists to avoid: a RAW rate ranks claw-heavy (20%)
	// far worse than claw-light (4%).
	assert.ok(heavy.observed / heavy.jobs > light.observed / light.jobs);

	// The corrected statistic says the opposite: claw-heavy has zero excess
	// (it is exactly at its cell's fleet rate) and must not rank as worst.
	assert.equal(heavy.excess, 0);
	assert.equal(heavy.z, 0);
	assert.ok(
		light.z !== null && light.z > 3,
		`claw-light's z should be clearly significant, got ${light.z}`
	);
	assert.equal(report.nodes[0].node, 'claw-light');
	assert.notEqual(report.nodes[0].node, 'claw-heavy');
});

test('a small-sample node is reported insufficientData, never healthy', () => {
	const days = [
		day('2026-10-20', [
			row('*', REPO, 'build', 100, { runner: 50 }),
			// 5 jobs: below the default minNodeJobs (30) AND the default
			// minExpected (5*0.5=2.5 < 5).
			row('claw-tiny', REPO, 'build', 5, { runner: 5 }),
		]),
	];
	const report = computeFailureRates(days);
	const tiny = report.nodes.find((n) => n.node === 'claw-tiny')!;

	assert.equal(tiny.insufficientData, true);
	assert.equal(tiny.z, null);
	assert.equal(tiny.pValue, null);
	assert.ok(tiny.insufficientReason && tiny.insufficientReason.length > 0);
	// The raw counts are still reported — "could not look" is not "zero".
	assert.equal(tiny.observed, 5);
	assert.equal(tiny.jobs, 5);
});

test('insufficientData nodes always sort after every measured node', () => {
	const days = [
		day('2026-10-20', [
			row('*', REPO, 'build', 1000, { runner: 20 }),
			// A clearly-worse, well-measured node.
			row('claw-bad', REPO, 'build', 500, { runner: 50 }),
			// A tiny node whose raw rate LOOKS fine, but has no standing to say so.
			row('claw-tiny', REPO, 'build', 3, { runner: 0 }),
		]),
	];
	const report = computeFailureRates(days);
	const order = report.nodes.map((n) => n.node);
	assert.deepEqual(order, ['claw-bad', 'claw-tiny']);
	assert.equal(report.nodes[1].insufficientData, true);
});

test('a cell with too thin a fleet baseline is excluded, not silently folded in', () => {
	const days = [
		day('2026-10-20', [
			// Included cell: plenty of fleet-wide sample.
			row('*', REPO, 'build', 200, { runner: 20 }),
			row('claw-1', REPO, 'build', 60, { runner: 6 }),
			// Excluded cell: only 5 fleet-wide jobs total (< default minCellFleetJobs 20).
			row('*', REPO, 'deploy', 5, { runner: 1 }),
			row('claw-1', REPO, 'deploy', 3, { runner: 1 }),
		]),
	];
	const report = computeFailureRates(days);
	const c1 = report.nodes.find((n) => n.node === 'claw-1')!;

	assert.equal(c1.cellsIncluded, 1);
	assert.equal(c1.cellsExcluded, 1);
	assert.equal(c1.excludedCells.length, 1);
	assert.equal(c1.excludedCells[0].repo, REPO);
	assert.equal(c1.excludedCells[0].kind, 'deploy');
	assert.equal(c1.excludedCells[0].fleetJobs, 5);
	assert.equal(c1.excludedCells[0].nodeJobs, 3);
	// The excluded cell's jobs are counted but not folded into the statistic.
	assert.equal(c1.jobs, 60);
	assert.equal(c1.jobsExcluded, 3);
});

test('zoneExcess breaks down every zone, including ones the headline statistic does not count', () => {
	const days = [
		day('2026-10-20', [
			row('*', REPO, 'build', 200, { runner: 10, content: 20 }),
			// At the fleet's runner rate (5%) but double the fleet's content rate (10% vs 20% — wait, set explicitly below)
			row('claw-1', REPO, 'build', 100, { runner: 5, content: 40 }),
		]),
	];
	// Default zones = runner+seam, so the headline excess ignores `content`
	// entirely — but zoneExcess must still show it, and clearly.
	const report = computeFailureRates(days);
	const c1 = report.nodes.find((n) => n.node === 'claw-1')!;

	// runner: fleet rate 10/200=5%; expected = 100*0.05 = 5; observed 5 -> excess 0.
	assert.equal(c1.zoneExcess.runner.excess, 0);
	// content: fleet rate 20/200=10%; expected = 100*0.10 = 10; observed 40 -> excess 30.
	assert.equal(c1.zoneExcess.content.excess, 30);
	assert.equal(c1.topZone, 'content');
	// The headline statistic (runner+seam only) is unmoved by content's excess.
	assert.equal(c1.excess, 0);
});

test('deterministic cells (fleet rate 0% or 100%) do not divide by zero', () => {
	const days = [
		day('2026-10-20', [
			// The fleet ALWAYS fails this cell's `content` zone (q=1).
			row('*', REPO, 'always-red', 10, { content: 10 }),
			// claw-under: fewer content failures than its job count -> negative excess.
			row('claw-under', REPO, 'always-red', 5, { content: 3 }),
			// claw-exact: matches the deterministic rate exactly -> zero excess.
			row('claw-exact', REPO, 'always-red', 3, { content: 3 }),
		]),
	];
	const opts = { zones: ['content'] as const, minNodeJobs: 1, minExpected: 1, minCellFleetJobs: 1 };
	const report = computeFailureRates(days, opts);
	const under = report.nodes.find((n) => n.node === 'claw-under')!;
	const exact = report.nodes.find((n) => n.node === 'claw-exact')!;

	assert.equal(under.excess, -2);
	assert.equal(under.z, -Infinity);
	assert.equal(under.pValue, 1);

	assert.equal(exact.excess, 0);
	assert.equal(exact.z, 0);
	assert.equal(exact.pValue, 0.5);
});

test('fromDay/toDay windows the input; days outside it are not folded in', () => {
	const days = [
		day('2026-10-01', [
			row('*', REPO, 'build', 100, { runner: 50 }),
			row('claw-1', REPO, 'build', 100, { runner: 50 }),
		]),
		day('2026-10-20', [
			row('*', REPO, 'build', 100, { runner: 10 }),
			row('claw-1', REPO, 'build', 100, { runner: 10 }),
		]),
	];
	const windowed = computeFailureRates(days, { fromDay: '2026-10-15' });
	assert.equal(windowed.days, 1);
	const c1 = windowed.nodes.find((n) => n.node === 'claw-1')!;
	assert.equal(c1.jobs, 100);
	assert.equal(c1.observed, 10);

	const everything = computeFailureRates(days);
	assert.equal(everything.days, 2);
	const c1All = everything.nodes.find((n) => n.node === 'claw-1')!;
	assert.equal(c1All.jobs, 200);
	assert.equal(c1All.observed, 60);
});

test('multiple days for the same node+cell are summed, not overwritten', () => {
	const days = [
		day('2026-10-19', [
			row('*', REPO, 'build', 50, { runner: 5 }),
			row('claw-1', REPO, 'build', 50, { runner: 5 }),
		]),
		day('2026-10-20', [
			row('*', REPO, 'build', 50, { runner: 5 }),
			row('claw-1', REPO, 'build', 50, { runner: 5 }),
		]),
	];
	const report = computeFailureRates(days);
	const c1 = report.nodes.find((n) => n.node === 'claw-1')!;
	assert.equal(c1.jobs, 100);
	assert.equal(c1.observed, 10);
	assert.equal(c1.cellsIncluded, 1);
});

test('the default zones option is runner+seam, matching the fleet-origin figure elsewhere', () => {
	assert.deepEqual([...FLEET_ORIGIN_ZONES].sort(), ['runner', 'seam']);
});
