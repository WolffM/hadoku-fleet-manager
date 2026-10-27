/**
 * The join and the summaries, asserted without a fleet.
 *
 * The cases here are the ones that decide whether a measurement is trustworthy:
 * an exact id match, a weaker fallback key, a row that matches neither (which
 * must be COUNTED, never dropped), and an absent memory limit (which must stay
 * null rather than becoming a ceiling of zero).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOnSync, LOCAL } from './fleet-exec.mjs';
import {
	mb,
	percentile,
	joinMetrics,
	byNode,
	byUnit,
	byNodeRepo,
	varianceAxis,
	durationRatios,
	perJobCosts,
	selectMetricTargets,
	costFacets,
	cpuSec,
	facet,
	parseMetrics,
	selfUnit,
	withUnits,
	READ_END,
	metricsSince,
	metricsReadScript,
	readOutcome,
	perNodeWithReads,
} from './job-metrics.mjs';

const history = [
	{
		repo: 'WolffM/hadoku_site',
		runId: 900,
		jobId: 101,
		name: 'lint',
		runner: 'jit-claw-1-x',
		durationSec: 70,
		conclusion: 'success',
	},
	{
		repo: 'WolffM/hadoku_site',
		runId: 901,
		jobId: 102,
		name: 'lint',
		runner: 'claw-2',
		durationSec: 75,
		conclusion: 'success',
	},
	{
		repo: 'WolffM/hadoku-craft',
		runId: 902,
		jobId: 103,
		name: 'update',
		runner: 'hokon',
		durationSec: 40,
		conclusion: 'success',
	},
];

test('a JIT row joins on jobId — the exact key the cgroup name carries', () => {
	const { joined, unjoined } = joinMetrics(
		[{ kind: 'jit', jobId: 101, runId: 900, node: 'claw-1', peakBytes: 2 * 1048576 }],
		history
	);
	assert.equal(unjoined.length, 0);
	assert.equal(joined[0].via, 'jobId');
	assert.equal(joined[0].unit, 'WolffM/hadoku_site/lint');
});

// ── wave 4c #102 lane C: host-load fields pass through untouched ──────────
//
// `ci-throttle.sh`/`job-metrics.sh` write `hostLoad1m`, `hostCpuPressureAvg10`,
// `hostCoTenants` and `hostCoTenantRepos` onto a metrics row; this module does
// not summarise them (no facet here reports them — see `costFacets`), it only
// joins and groups rows, and a join that silently dropped an unrecognised key
// would be the same lie as a missing measurement. `joinMetrics` spreads the
// raw row (`{...m, ...}`), so a NEW field surviving the join is a property of
// that spread, not something this file has to opt into per field — this pins
// it as a behaviour rather than leaving it implicit.
test('host-load fields on a metric row survive joinMetrics unchanged', () => {
	const { joined } = joinMetrics(
		[
			{
				kind: 'jit',
				jobId: 101,
				runId: 900,
				node: 'claw-1',
				peakBytes: 2 * 1048576,
				hostLoad1m: 2.5,
				hostCpuPressureAvg10: 4.2,
				hostCoTenants: 2,
				hostCoTenantRepos: ['cardtable', 'hadoku_site'],
			},
		],
		history
	);
	assert.equal(joined.length, 1);
	assert.equal(joined[0].hostLoad1m, 2.5);
	assert.equal(joined[0].hostCpuPressureAvg10, 4.2);
	assert.equal(joined[0].hostCoTenants, 2);
	assert.deepEqual(joined[0].hostCoTenantRepos, ['cardtable', 'hadoku_site']);
});

test('a row written before wave 4c — no host-load fields at all — still joins', () => {
	const { joined, unjoined } = joinMetrics(
		[{ kind: 'jit', jobId: 101, runId: 900, node: 'claw-1', peakBytes: 2 * 1048576 }],
		history
	);
	assert.equal(unjoined.length, 0);
	assert.equal(joined[0].hostLoad1m, undefined);
});

test('a standing row falls back to repo+run+runner', () => {
	const { joined } = joinMetrics(
		[
			{
				kind: 'standing',
				jobId: null,
				repo: 'WolffM/hadoku-craft',
				runId: 902,
				runner: 'hokon',
				node: 'hokon',
				peakBytes: 1048576,
			},
		],
		history
	);
	assert.equal(joined[0].via, 'repo+run+runner');
	assert.equal(joined[0].unit, 'WolffM/hadoku-craft/update');
});

test('a row matching nothing is COUNTED, not dropped', () => {
	// A discarded measurement is the same lie as a missing one.
	const { joined, unjoined } = joinMetrics([{ jobId: 999, node: 'claw-9' }], history);
	assert.equal(joined.length, 0);
	assert.equal(unjoined.length, 1);
});

test('jobId wins over the weaker key when both could match', () => {
	const { joined } = joinMetrics(
		[
			{
				jobId: 102,
				repo: 'WolffM/hadoku-craft',
				runId: 902,
				runner: 'hokon',
				node: 'claw-2',
				peakBytes: 5,
			},
		],
		history
	);
	assert.equal(joined[0].via, 'jobId');
	assert.equal(joined[0].unit, 'WolffM/hadoku_site/lint');
});

test('an ABSENT memory limit stays null and never becomes a ceiling of zero', () => {
	const rows = byNode([
		{ node: 'claw-1', peakBytes: 100 * 1048576, oomKill: 0, limitBytes: null, unit: 'a/b' },
	]);
	assert.equal(rows[0].limitMb, null);
	assert.equal(rows[0].headroomPct, null, 'no limit means no headroom figure, not 0%');
});

test('headroom is peak against the real ceiling', () => {
	const rows = byNode([
		{ node: 'claw-2', peakBytes: 3 * 1024 * 1048576, oomKill: 4, limitBytes: 6 * 1024 * 1048576 },
	]);
	assert.equal(rows[0].limitMb, 6144);
	assert.equal(rows[0].headroomPct, 50);
	assert.equal(rows[0].oomKills, 4);
});

test('byUnit needs repeats before it reports a number', () => {
	const one = [{ node: 'claw-1', unit: 'a/b', peakBytes: 1048576 }];
	assert.equal(byUnit(one, { minRuns: 2 }).length, 0);
	assert.equal(byUnit([...one, { ...one[0] }], { minRuns: 2 }).length, 1);
});

test('byUnit reports how many distinct nodes contributed', () => {
	const u = byUnit(
		[
			{ node: 'claw-1', unit: 'a/b', peakBytes: 1048576 },
			{ node: 'claw-2', unit: 'a/b', peakBytes: 2 * 1048576 },
		],
		{ minRuns: 2 }
	);
	assert.equal(u[0].nodes, 2);
	assert.equal(u[0].maxMb, 2);
});

test('a truncated final line costs one record, not the file', () => {
	const { rows, skipped } = parseMetrics('{"a":1}\n{"b":2}\n{"c":');
	assert.equal(rows.length, 2);
	assert.equal(skipped, 1);
});

test('mb and percentile refuse to invent numbers', () => {
	assert.equal(mb(null), null);
	assert.equal(mb('1234'), null);
	assert.equal(percentile([], 0.5), null);
	assert.equal(percentile([1, 2, 3, 4], 0.5), 3);
});

test('a row names its own unit when history has not caught up', () => {
	// job-history ingests on a tick; the first live run had all 6 rows unjoined
	// purely because they were minutes old. The tool must still be useful.
	assert.equal(selfUnit({ repo: 'WolffM/hadoku_site', job: 'build' }), 'WolffM/hadoku_site/build');
	assert.equal(selfUnit({ repo: 'WolffM/x' }), null);
	assert.equal(selfUnit(null), null);
});

test('withUnits keeps both sources and labels which is which', () => {
	const rows = withUnits(
		[{ node: 'a', unit: 'r/lint', peakBytes: 1 }],
		[{ node: 'b', repo: 'r', job: 'build', peakBytes: 2 }]
	);
	assert.equal(rows.length, 2);
	assert.equal(rows.find((r) => r.node === 'a').unitSource, 'history');
	assert.equal(rows.find((r) => r.node === 'b').unitSource, 'row');
	assert.equal(rows.find((r) => r.node === 'b').unit, 'r/build');
});

test('withUnits drops a row that can name no unit at all, rather than inventing one', () => {
	assert.equal(withUnits([], [{ node: 'b', peakBytes: 2 }]).length, 0);
});

// ── the counters that were harvested for weeks and summarised by nothing ────
//
// `job-metrics.sh` has written cpuUsageUsec / cpuUserUsec / cpuSystemUsec /
// ioReadBytes / ioWriteBytes per job since 2026-08, and every summary here read
// peak memory only. Delete the cost facets from byNode/byUnit and these tests go
// red — that is the point of them.

const MB = 1048576;
/** Three rows on one node with a clean 10/20/30 s CPU and 100/200/300 MB of I/O. */
const costed = [10, 20, 30].map((sec, i) => ({
	node: 'claw-1',
	repo: 'WolffM/hadoku_site',
	unit: 'WolffM/hadoku_site/build',
	peakBytes: (i + 1) * 100 * MB,
	cpuUsageUsec: sec * 1e6,
	ioReadBytes: (i + 1) * 100 * MB,
	ioWriteBytes: (i + 1) * 10 * MB,
	durationSec: sec * 2,
}));

test('byNode summarises the CPU and I/O the hook has been writing all along', () => {
	const [n] = byNode(costed);
	assert.equal(n.cpuSamples, 3);
	assert.equal(n.cpuP50Sec, 20);
	assert.equal(n.cpuP95Sec, 30);
	assert.equal(n.ioReadP95Mb, 300);
	assert.equal(n.ioWriteP95Mb, 30);
	assert.equal(n.durationP95Sec, 60);
	assert.equal(n.p95Mb, 300, 'peak memory is still reported beside them');
});

test('byUnit summarises the same cost facets, not memory alone', () => {
	const [u] = byUnit(costed, { minRuns: 2 });
	assert.equal(u.cpuP95Sec, 30);
	assert.equal(u.ioReadP95Mb, 300);
	assert.equal(u.ioWriteP95Mb, 30);
	assert.equal(u.durationP95Sec, 60);
});

test('a facet no row carries is null beside a count of 0, never a zero', () => {
	// io.stat is absent on some cgroup layouts — a hokon standing-runner row from
	// 2026-09-16 carries all three CPU counters and ioReadBytes: null. Reporting
	// 0 MB read would be "I could not look" rendered as "nothing is wrong".
	const [n] = byNode([{ node: 'hokon', peakBytes: MB, cpuUsageUsec: 5e6, ioReadBytes: null }]);
	assert.equal(n.ioReadSamples, 0);
	assert.equal(n.ioReadP50Mb, null);
	assert.equal(n.ioReadP95Mb, null);
	assert.equal(n.cpuSamples, 1, 'the facet that WAS measured still reports');
	assert.equal(n.cpuP95Sec, 5);
});

test('a percentile is judged by its own sample count, not the group row count', () => {
	// 50 rows, two of which carry I/O. The p95 is over those two and says so; a
	// reader who sees only "ioReadP95Mb: 900" would take it for the node's p95.
	const rows = Array.from({ length: 50 }, (_, i) => ({
		node: 'claw-2',
		peakBytes: MB,
		cpuUsageUsec: 1e6,
		ioReadBytes: i < 2 ? 900 * MB : undefined,
	}));
	const [n] = byNode(rows);
	assert.equal(n.jobs, 50);
	assert.equal(n.cpuSamples, 50);
	assert.equal(n.ioReadSamples, 2);
	assert.equal(n.ioReadP95Mb, 900);
});

test('shmem is OPTIONAL — 0 today, summarised the moment the hook writes it', () => {
	// The tmpfs counters land in scripts/job-metrics.sh in a separate change.
	// Reading them as optional is what lets the two ship in either order.
	const before = byNode([{ node: 'claw-3', peakBytes: MB }])[0];
	assert.equal(before.shmemPeakSamples, 0);
	assert.equal(before.shmemPeakP95Mb, null);
	assert.equal(before.shmemSamples, 0);
	const after = byNode([
		{ node: 'claw-3', peakBytes: MB, shmemPeakBytes: 700 * MB, shmemBytes: 12 * MB },
	])[0];
	assert.equal(after.shmemPeakSamples, 1);
	assert.equal(after.shmemPeakP95Mb, 700);
	assert.equal(after.shmemP95Mb, 12);
});

test('cpuSec converts microseconds and refuses anything that is not a number', () => {
	assert.equal(cpuSec(1_500_000), 1.5);
	assert.equal(cpuSec(null), null);
	assert.equal(cpuSec('1000000'), null);
});

test('facet ignores a missing field instead of counting it as zero', () => {
	const f = facet(
		[{ v: 4 }, { v: null }, {}, { v: 'x' }, { v: 8 }],
		(r) => r.v,
		(v) => v
	);
	assert.equal(f.samples, 2);
	assert.equal(f.max, 8);
});

test('costFacets always names every facet, so a consumer never infers one is gone', () => {
	const keys = Object.keys(costFacets([]));
	for (const k of [
		'cpuSamples',
		'cpuP95Sec',
		'ioReadSamples',
		'ioWriteSamples',
		'durationSamples',
		'shmemPeakSamples',
		'shmemSamples',
	]) {
		assert.ok(keys.includes(k), `costFacets must always carry ${k}`);
	}
});

// ── a guest is not swept, and is not unreachable ───────────────────────────
//
// Both directions, because each half fails differently. Lose the skip and a
// sweep ssh's a guest from every box that is not that guest. Lose the opt-in
// and an operator asking a guest for its own numbers gets a silent empty set,
// which is the failure that makes people stop believing the tool.

const FLEET = [
	['claw-1', { role: 'claw' }],
	['claw-2', { role: 'claw' }],
	['hokon', { role: 'guest' }],
];

test('the default sweep does NOT reach a guest, and says that it did not', () => {
	const { targets, skipped } = selectMetricTargets(FLEET);
	assert.deepEqual(
		targets.map(([n]) => n),
		['claw-1', 'claw-2']
	);
	assert.equal(skipped.length, 1, 'a deliberate skip is REPORTED, never silent');
	assert.equal(skipped[0].node, 'hokon');
	assert.match(skipped[0].why, /guest/);
});

test('the skip is by ROLE, never by name — an unroled hokon is swept', () => {
	// Skipping a hostname is a fact about one garage. Skipping a role is a fact
	// about the fleet model, and it is the half that survives a rename.
	const { targets, skipped } = selectMetricTargets([['hokon', { role: 'claw' }]]);
	assert.deepEqual(
		targets.map(([n]) => n),
		['hokon']
	);
	assert.equal(skipped.length, 0);
	// ...and a differently-named guest IS skipped.
	const other = selectMetricTargets([['spare-1', { role: 'guest' }]]);
	assert.equal(other.targets.length, 0);
	assert.equal(other.skipped[0].node, 'spare-1');
});

test('naming a guest with --machine reaches it — asking is not sweeping', () => {
	const { targets, skipped } = selectMetricTargets(FLEET, { only: 'hokon' });
	assert.deepEqual(
		targets.map(([n]) => n),
		['hokon']
	);
	assert.equal(skipped.length, 0, 'nothing was skipped: the operator asked for exactly this');
});

test('--include-guests sweeps everything, guest included', () => {
	const { targets, skipped } = selectMetricTargets(FLEET, { includeGuests: true });
	assert.deepEqual(
		targets.map(([n]) => n),
		['claw-1', 'claw-2', 'hokon']
	);
	assert.equal(skipped.length, 0);
});

test('--machine on a claw still scopes to that claw and reports no guest skip', () => {
	// `fleet capabilities --machine claw-1` silently ignored --machine and probed
	// the whole fleet, hokon included, seven times. The scoping half is not a
	// formality.
	const { targets, skipped } = selectMetricTargets(FLEET, { only: 'claw-1' });
	assert.deepEqual(
		targets.map(([n]) => n),
		['claw-1']
	);
	assert.equal(skipped.length, 0, 'the guest was out of scope, not skipped by role');
});

// ── a long-lived cgroup's counters are not a job's cost ────────────────────

const WARM = '/user.slice/.../warm-claw-7-hadoku_site.service';
/**
 * A fixture timestamp, ANCHORED TO THE CLOCK rather than written down.
 *
 * `perJobCosts` only ever compares these to each other — it orders rows on one
 * cgroup so it can difference consecutive ones — so an absolute date would add
 * nothing and would join the class of fixture that goes red on a calendar rather
 * than on a diff (`fixture-clock-guard.test.mjs`, twice unprompted in 2026-09).
 * Minutes from now keeps the only property the fixture actually needs.
 */
const at = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

test('a JIT row is already per-job and is passed through untouched', () => {
	const { rows, notes } = perJobCosts([
		{
			kind: 'jit',
			node: 'claw-7',
			peakBytes: 300 * MB,
			cpuUsageUsec: 42e6,
			ts: at(60),
		},
	]);
	assert.equal(rows[0].costBasis, 'unit');
	assert.equal(
		rows[0].peakBytes,
		300 * MB,
		'a transient unit dies with the job — this IS its peak'
	);
	assert.equal(rows[0].cpuUsageUsec, 42e6);
	assert.equal(notes.jitRows, 1);
	assert.equal(notes.cumulativeRows, 0);
});

test("a standing unit's CPU clock is differenced into the job that spent it", () => {
	const { rows, notes } = perJobCosts([
		{
			kind: 'standing',
			node: 'claw-7',
			cgroup: WARM,
			ts: at(60),
			cpuUsageUsec: 1000e6,
		},
		{
			kind: 'standing',
			node: 'claw-7',
			cgroup: WARM,
			ts: at(70),
			cpuUsageUsec: 1060e6,
		},
	]);
	assert.equal(rows[0].cpuUsageUsec, null, 'the first row has nothing to difference against');
	assert.equal(rows[1].cpuUsageUsec, 60e6, '60 CPU-seconds, not the 1,060 on the clock');
	assert.equal(notes.clocksDifferenced > 0, true);
});

test("a standing unit's memory.peak is VOIDED, not differenced and not kept", () => {
	// warm-claw-7-hadoku_site.service reported 4,097 MB — its 4 GiB ceiling — on
	// all 217 of its rows, a `guard` job included, because `job-metrics.sh`'s
	// reset is guarded on `[ -w memory.peak ]` and that file is not delegated.
	// A high-water mark's DELTA is a floor that reads 0 for every job after the
	// biggest one, so there is no honest per-job number to recover here.
	const { rows, notes } = perJobCosts([
		{
			kind: 'standing',
			node: 'claw-7',
			cgroup: WARM,
			ts: at(60),
			peakBytes: 4096 * MB,
		},
		{
			kind: 'standing',
			node: 'claw-7',
			cgroup: WARM,
			ts: at(70),
			peakBytes: 4096 * MB,
		},
	]);
	assert.equal(rows[0].peakBytes, null);
	assert.equal(rows[1].peakBytes, null);
	assert.equal(rows[1].peakBytesCumulative, 4096 * MB, 'the raw reading is kept, never discarded');
	assert.equal(notes.peaksVoided, 2);
	// And therefore it cannot reach a per-job percentile at all.
	assert.equal(byNode(rows)[0].memSamples, 0);
	assert.equal(byNode(rows)[0].p95Mb, null);
});

test('a clock that went BACKWARDS is a unit restart, not a negative job', () => {
	const { rows, notes } = perJobCosts([
		{
			kind: 'standing',
			node: 'claw-1',
			cgroup: WARM,
			ts: at(60),
			cpuUsageUsec: 900e6,
		},
		{
			kind: 'standing',
			node: 'claw-1',
			cgroup: WARM,
			ts: at(120),
			cpuUsageUsec: 5e6,
		},
		{
			kind: 'standing',
			node: 'claw-1',
			cgroup: WARM,
			ts: at(180),
			cpuUsageUsec: 11e6,
		},
	]);
	assert.equal(rows[1].cpuUsageUsec, null, 'never a negative cost');
	assert.equal(rows[2].cpuUsageUsec, 6e6, 'and the run after it differences normally again');
	assert.equal(notes.unitRestarts, 1);
});

test('two long-lived units on one node are differenced independently', () => {
	const A = 'warm-claw-1-a.service';
	const B = 'warm-claw-1-b.service';
	const { rows } = perJobCosts([
		{
			kind: 'standing',
			node: 'claw-1',
			cgroup: A,
			ts: at(60),
			cpuUsageUsec: 100e6,
		},
		{
			kind: 'standing',
			node: 'claw-1',
			cgroup: B,
			ts: at(61),
			cpuUsageUsec: 9000e6,
		},
		{
			kind: 'standing',
			node: 'claw-1',
			cgroup: A,
			ts: at(62),
			cpuUsageUsec: 130e6,
		},
	]);
	assert.equal(rows[2].cpuUsageUsec, 30e6, "B's clock must not leak into A's job");
	assert.equal(rows[1].cpuUsageUsec, null);
});

test('rows out of timestamp order are still differenced in the order they ran', () => {
	const { rows } = perJobCosts([
		{
			kind: 'standing',
			node: 'claw-1',
			cgroup: WARM,
			ts: at(180),
			cpuUsageUsec: 300e6,
		},
		{
			kind: 'standing',
			node: 'claw-1',
			cgroup: WARM,
			ts: at(60),
			cpuUsageUsec: 100e6,
		},
	]);
	assert.equal(rows[1].cpuUsageUsec, null, 'the EARLIER row is the one with no predecessor');
	assert.equal(rows[0].cpuUsageUsec, 200e6);
});

// ── node x repo, and the two answers ───────────────────────────────────────

/** n rows in one (node, repo) cell, at a fixed peak / duration. */
const cell = (node, repo, n, mbPeak, durSec) =>
	Array.from({ length: n }, () => ({
		node,
		repo,
		peakBytes: mbPeak * MB,
		durationSec: durSec,
		cpuUsageUsec: durSec * 1e6,
	}));

test('byNodeRepo excludes a thin cell rather than reporting it thin', () => {
	// One run per node read as a 2,000% node effect in the 2026-09-07 join; the
	// fix was a floor on runs, not a wider net.
	const rows = [
		...cell('claw-1', 'WolffM/a', 5, 100, 60),
		...cell('claw-2', 'WolffM/a', 1, 3000, 60),
	];
	const cells = byNodeRepo(rows, { minRuns: 5 });
	assert.equal(cells.length, 1);
	assert.equal(cells[0].node, 'claw-1');
	assert.equal(cells[0].runs, 5);
	assert.equal(cells[0].p95Mb, 100);
	assert.equal(cells[0].cpuP95Sec, 60, 'a cell carries the cost facets too');
});

test('byNodeRepo needs both a node and a repo before it will make a cell', () => {
	assert.equal(byNodeRepo(cell(undefined, 'WolffM/a', 5, 100, 60), { minRuns: 1 }).length, 0);
	assert.equal(byNodeRepo(cell('claw-1', undefined, 5, 100, 60), { minRuns: 1 }).length, 0);
});

test('varianceAxis computes the verdict from the two spreads, not by eye', () => {
	// Three nodes x three repos. Peak tracks the REPO (100 / 400 / 1600 MB) and
	// barely moves with the node, so varying the repo must win.
	const rows = [];
	for (const node of ['claw-1', 'claw-2', 'claw-3']) {
		for (const [repo, peak] of [
			['WolffM/a', 100],
			['WolffM/b', 400],
			['WolffM/c', 1600],
		]) {
			rows.push(...cell(node, repo, 5, peak, 60));
		}
	}
	const axis = varianceAxis(byNodeRepo(rows, { minRuns: 5 }), { minGroups: 3 });
	assert.equal(axis.verdict, 'repo');
	assert.equal(axis.medianAcrossNodesPct, 0, 'the same repo costs the same everywhere here');
	assert.equal(axis.medianAcrossReposPct, 1500, '100 MB to 1600 MB on one node');
	assert.equal(axis.acrossNodes.length, 3);
	assert.equal(axis.acrossRepos.length, 3);
});

test('varianceAxis says INCONCLUSIVE when one axis has no comparable group', () => {
	// An axis that could not be measured is not an axis that came out flat.
	const rows = [];
	for (const node of ['claw-1', 'claw-2', 'claw-3'])
		rows.push(...cell(node, 'WolffM/a', 5, 100, 60));
	const axis = varianceAxis(byNodeRepo(rows, { minRuns: 5 }), { minGroups: 3 });
	assert.equal(axis.medianAcrossReposPct, null, 'no node ran 3 repos');
	assert.equal(axis.verdict, 'inconclusive');
});

test('durationRatios measures each node against the fleet-median node on the SAME repo', () => {
	const rows = [
		...cell('claw-1', 'WolffM/a', 5, 100, 100),
		...cell('claw-2', 'WolffM/a', 5, 100, 100),
		...cell('claw-5', 'WolffM/a', 5, 100, 250),
		...cell('claw-1', 'WolffM/b', 5, 100, 50),
		...cell('claw-2', 'WolffM/b', 5, 100, 50),
		...cell('claw-5', 'WolffM/b', 5, 100, 100),
		...cell('claw-1', 'WolffM/c', 5, 100, 20),
		...cell('claw-2', 'WolffM/c', 5, 100, 20),
		...cell('claw-5', 'WolffM/c', 5, 100, 60),
	];
	const out = durationRatios(byNodeRepo(rows, { minRuns: 5 }), {
		proxies: { 'claw-5': { sha512SingleMBps: 184, memSpeedMTs: 800 } },
	});
	const five = out.find((r) => r.node === 'claw-5');
	assert.equal(out[0].node, 'claw-5', 'the slowest node sorts first');
	assert.equal(five.repos, 3);
	assert.equal(five.medianRatio, 2.5, 'ratios 2.0 / 2.5 / 3.0 across the three repos');
	assert.equal(
		five.proxy.sha512SingleMBps,
		184,
		'the hardware travels with the ratio, so no one axis is captioned as the cause'
	);
});

test('durationRatios skips a repo only one node ran — there is no fleet median to beat', () => {
	const rows = [...cell('claw-1', 'WolffM/solo', 5, 100, 100)];
	assert.equal(durationRatios(byNodeRepo(rows, { minRuns: 5 })).length, 0);
});

// ── #37: the read — window, class, and every node in one list ────────────────
//
// These drive the REAL node-side script through the REAL sync transport, on
// this box (`LOCAL` takes the `bash -s` branch, so no packet leaves it). A
// fixture HOME stands in for the node's; nothing reads a live file.

/** A node's `.hadoku` under a throwaway HOME. */
function fixtureHome() {
	const home = mkdtempSync(join(tmpdir(), 'job-metrics-read-'));
	mkdirSync(join(home, '.hadoku'));
	return { home, file: join(home, '.hadoku', 'job-metrics.jsonl') };
}

/** One hook-shaped row. `ts` FIRST, as the hook writes it — the filter relies on it. */
function row(ts, extra = {}) {
	return JSON.stringify({ ts, node: 'claw-9', kind: 'jit', repo: 'WolffM/x', ...extra });
}

/** The read script with the fixture HOME in front of it — the node's own $HOME, simulated. */
function readVia(home, since) {
	return runOnSync(LOCAL, `HOME='${home}'\n${metricsReadScript(since)}`, {
		timeoutMs: 60_000,
		manifest: { machines: {} },
	});
}

// Every timestamp is anchored to NOW (fixture-clock-guard): the window is
// 14 days back, and rows are placed by how many days old they are.
const DAY = 86_400_000;
const NOW = Date.now();
const SINCE = metricsSince(NOW, 14);
const ago = (days) => metricsSince(NOW, days);

test("metricsSince is the hook's own timestamp shape, N days back to the second", () => {
	const s = metricsSince(NOW, 14);
	assert.match(
		s,
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
		'no milliseconds — the hook writes none'
	);
	assert.equal(Date.parse(s), Math.floor((NOW - 14 * DAY) / 1000) * 1000);
	assert.throws(() => metricsSince(NOW, 0), RangeError, 'a zero window is not a window');
});

test('the read script refuses a `since` that is not a timestamp — it reaches a shell', () => {
	assert.throws(() => metricsReadScript(`${SINCE}'; rm -rf ~; '`), TypeError);
	assert.throws(() => metricsReadScript(SINCE.slice(0, 10)), TypeError);
});

test('only rows inside the window cross the wire, and the rest are COUNTED', () => {
	const { home, file } = fixtureHome();
	try {
		writeFileSync(
			file,
			[
				row(ago(29)),
				row(metricsSince(NOW - 1000, 14)),
				row(SINCE, { edge: true }),
				row(ago(1)),
				'{"truncated',
			].join('\n') + '\n'
		);
		const r = readOutcome('claw-9', readVia(home, SINCE));
		assert.equal(r.read, 'ok', r.why);
		assert.deepEqual(
			r.rows.map((x) => x.ts),
			[SINCE, ago(1)],
			'the boundary row is IN the window'
		);
		assert.equal(r.older, 2, 'what was left behind is a number, not a silence');
		assert.equal(r.skipped, 1, 'a line with no ts is passed through and counted, not dropped');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('the rotated `.1` is read too — right after a rotation it holds the whole window', () => {
	const { home, file } = fixtureHome();
	try {
		writeFileSync(`${file}.1`, [row(ago(48)), row(ago(8))].join('\n') + '\n');
		writeFileSync(file, row(ago(0.1)) + '\n');
		const r = readOutcome('claw-9', readVia(home, SINCE));
		assert.equal(r.read, 'ok', r.why);
		assert.deepEqual(
			r.rows.map((x) => x.ts),
			[ago(8), ago(0.1)]
		);
		assert.equal(r.older, 1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('no file at all is an EMPTY read, not a failure — the hook may not be installed yet', () => {
	const { home } = fixtureHome();
	try {
		const r = readOutcome('claw-9', readVia(home, SINCE));
		assert.equal(r.read, 'ok', r.why);
		assert.equal(r.rows.length, 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('a file that exists and cannot be read is a read-error with its errno, never an empty read', () => {
	// Before #37 the read was `cat ... 2>/dev/null || true`: an unreadable file
	// and an absent one produced the same empty string.
	const { home, file } = fixtureHome();
	try {
		writeFileSync(file, row(ago(1)) + '\n');
		chmodSync(file, 0o000);
		const r = readOutcome('claw-9', readVia(home, SINCE));
		assert.equal(r.read, 'read-error');
		assert.equal(r.errno, 'EACCES');
		assert.match(r.why, /not readable/);
	} finally {
		chmodSync(file, 0o644);
		rmSync(home, { recursive: true, force: true });
	}
});

test('a 2 MiB metrics file reads whole through the sync transport (#37)', () => {
	// THE REGRESSION. claw-1's file was 1,136,332 bytes on 2026-09-18 and Node's
	// default 1 MiB buffer read it as `spawnSync ssh ENOBUFS`. Every row here is
	// inside the window, so the filter cannot shrink the output below the old
	// ceiling — only the transport's default can make this pass.
	const { home, file } = fixtureHome();
	try {
		const one = row(ago(1), { pad: 'x'.repeat(500) });
		const n = Math.ceil((2 * 1024 * 1024) / (one.length + 1));
		writeFileSync(file, `${one}\n`.repeat(n));
		const res = readVia(home, SINCE);
		assert.ok(res.out.length > 2 * 1024 * 1024, `2 MiB crossed the pipe (${res.out.length})`);
		const r = readOutcome('claw-9', res);
		assert.equal(r.read, 'ok', `${r.errno}: ${r.why}`);
		assert.equal(r.rows.length, n);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('an overflowed buffer is a READ-ERROR carrying ENOBUFS — the node answered', () => {
	// The exact 2026-09-18 result, reproduced rather than typed out: a real
	// `runOnSync` given a ceiling below its output.
	const res = runOnSync(LOCAL, 'head -c 4096 /dev/zero | tr "\\0" x', {
		maxBuffer: 1024,
		manifest: { machines: {} },
	});
	assert.equal(res.code, 'ENOBUFS', 'the transport names its own errno');
	const r = readOutcome('claw-1', { ...res, local: false });
	assert.equal(r.read, 'read-error');
	assert.equal(r.errno, 'ENOBUFS');
	assert.equal(r.rows.length, 0);
});

test('ssh exiting 255 is UNREACHABLE — the one status ssh keeps for itself', () => {
	const r = readOutcome('claw-3', {
		ok: false,
		local: false,
		code: null,
		status: 255,
		stderr: 'ssh: connect to host claw-3 port 22: No route to host',
		error: 'ssh: connect to host claw-3 port 22: No route to host',
	});
	assert.equal(r.read, 'unreachable');
	assert.match(r.why, /No route to host/);
});

test('255 from a LOCAL read is not "unreachable" — there was no ssh to fail', () => {
	const r = readOutcome('hokon', { ok: false, local: true, code: null, status: 255, error: 'x' });
	assert.equal(r.read, 'read-error');
});

test('a node-side read failure carries the errno the script printed', () => {
	const r = readOutcome('claw-2', {
		ok: false,
		local: false,
		code: null,
		status: 3,
		stderr: 'job-metrics-read: EIO awk exited 2 reading /home/h/.hadoku/job-metrics.jsonl\n',
		error: 'job-metrics-read: EIO awk exited 2',
	});
	assert.equal(r.read, 'read-error');
	assert.equal(r.errno, 'EIO');
});

test('output that stops before the end-of-read line is a read-error, not a short file', () => {
	const r = readOutcome('claw-4', {
		ok: true,
		local: false,
		out: `${row(ago(1))}\n`,
	});
	assert.equal(r.read, 'read-error');
	assert.equal(r.rows.length, 0, 'a prefix is not handed on as if it were the file');
	const whole = readOutcome('claw-4', {
		ok: true,
		local: false,
		out: `${row(ago(1))}\n${READ_END} kept=1 older=0 files=1\n`,
	});
	assert.equal(whole.read, 'ok');
	assert.equal(whole.rows.length, 1);
	assert.equal(whole.skipped, 0, 'the end-of-read line is not counted as an unparseable row');
});

test('perNode names EVERY node asked — a failed read is in the same list, with its class', () => {
	const summaries = byNode([{ node: 'claw-2', peakBytes: 1048576 }]);
	const reads = [
		{ node: 'claw-2', read: 'ok', errno: null, why: null },
		{ node: 'claw-6', read: 'ok', errno: null, why: null },
		{ node: 'claw-1', read: 'read-error', errno: 'ENOBUFS', why: 'spawnSync ssh ENOBUFS' },
		{ node: 'claw-3', read: 'unreachable', errno: null, why: 'No route to host' },
	];
	const per = perNodeWithReads(summaries, reads);
	assert.deepEqual(
		per.map((p) => [p.node, p.read]),
		[
			['claw-2', 'ok'],
			['claw-6', 'ok'],
			['claw-1', 'read-error'],
			['claw-3', 'unreachable'],
		]
	);
	assert.equal(per.find((p) => p.node === 'claw-6').jobs, 0, 'an idle node read fine and ran 0');
	const c1 = per.find((p) => p.node === 'claw-1');
	assert.equal(c1.jobs, null, '"I could not look" is not a node that ran nothing');
	assert.equal(c1.errno, 'ENOBUFS');
});
