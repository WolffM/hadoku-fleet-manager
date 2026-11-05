/**
 * The performance window: percentiles of point readings, counter deltas taken
 * only within one boot, loss over every burst, and unmeasured rows counted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pct, summarizeActive, summarizeNode, summarizePerf } from './perf-summary.mjs';

const NOW = Date.now();
const at = (minsAgo) => new Date(NOW - minsAgo * 60_000).toISOString();
const burst = (p50, p95, received = 20) => ({
	target: '192.0.2.9',
	sent: 20,
	received,
	minMs: p50,
	p50Ms: p50,
	p95Ms: p95,
	maxMs: p95,
	jitterMs: 1,
});
const row = (minsAgo, bootId, sectorsWritten, ioMs, extra = {}) => ({
	v: 1,
	at: at(minsAgo),
	node: 'claw-9',
	ok: true,
	bootId,
	lan: burst(3, 10),
	gateway: burst(2, 8),
	link: {
		kind: 'wired',
		speedMbps: 1000,
		rxBytes: 0,
		txBytes: 0,
		rxErrors: 0,
		carrierChanges: 1,
		wifi: null,
	},
	psi: { cpuSome: 1, ioSome: 2, ioFull: 1, memorySome: 0 },
	load: { one: 4, cores: 8 },
	memory: { availableMb: 8000, swapUsedMb: 0 },
	disk: {
		device: 'sda',
		reads: 0,
		readSectors: 0,
		readMs: 0,
		writes: sectorsWritten / 8,
		writeSectors: sectorsWritten,
		writeMs: ioMs,
		ioMs,
		rootUsedPct: 40,
	},
	cpuTempC: 50,
	cpuTempSensor: 'coretemp',
	...extra,
});

void test('nearest-rank percentile ignores nulls; none is null', () => {
	assert.equal(pct([5, 1, null, 3], 50), 3);
	assert.equal(pct([null], 95), null);
});

void test('disk rates come from deltas within one boot; a reboot is not a delta', () => {
	const rows = [
		row(10, 'boot-a', 0, 0),
		// 300 s later: 600,000 sectors = 307.2 MB written -> 1.024 MB/s; 30 s of I/O -> 10% busy.
		row(5, 'boot-a', 600_000, 30_000),
		// a new boot: counters restart, no interval is taken across it
		row(0, 'boot-b', 10, 5),
	];
	const s = summarizeNode('claw-9', rows);
	assert.equal(s.boots, 2);
	assert.equal(s.disk.writeMBps.p50, 1.02);
	assert.equal(s.disk.utilPct.p50, 10);
	assert.equal(s.disk.awaitMs.p50, 0.4);
});

void test('loss is over every burst, and a burst with no reply counts as a dead burst', () => {
	const rows = [row(10, 'b', 0, 0), row(5, 'b', 0, 0, { lan: burst(null, null, 0) })];
	const s = summarizeNode('claw-9', rows);
	assert.equal(s.lan.lossPct, 50);
	assert.equal(s.lan.deadBursts, 1);
	assert.equal(s.lan.rttP50Ms.p50, 3);
});

void test('an unmeasured row is counted, its reason kept, and its controller ping still read', () => {
	const rows = [
		row(10, 'b', 0, 0),
		{
			v: 1,
			at: at(5),
			node: 'claw-9',
			ok: false,
			why: 'could not run the probe: timed out',
			lan: burst(40, 200),
		},
	];
	const s = summarizeNode('claw-9', rows);
	assert.equal(s.samples, 2);
	assert.equal(s.unmeasured, 1);
	assert.match(s.lastWhy, /timed out/);
	assert.equal(s.lan.bursts, 2);
	assert.equal(s.gateway.bursts, 1);
});

void test('a node never measured has no link or disk, not zeros', () => {
	const s = summarizeNode('claw-9', [
		{ v: 1, at: at(1), node: 'claw-9', ok: false, why: 'x', lan: null },
	]);
	assert.equal(s.link, null);
	assert.equal(s.disk, null);
	assert.equal(s.lan, null);
	assert.equal(s.cpuTempC.p50, null);
});

void test('nodes sort naturally: claw-2 before claw-10', () => {
	const mk = (node) => ({ v: 1, at: at(1), node, ok: false, why: 'x', lan: null });
	assert.deepEqual(
		summarizePerf([mk('claw-10'), mk('claw-2'), mk('hokon')]).map((n) => n.node),
		['claw-2', 'claw-10', 'hokon']
	);
});

void test('active: spread over measured results only; attempts that could not test are counted, not averaged', () => {
	const a = (outcome, extra = {}) => ({ v: 1, at: at(1), node: 'claw-1', outcome, ...extra });
	const rows = [
		a('busy', { why: 'not idle' }),
		a('measured', {
			disk: { fs: 'ext4', syncWriteMs: 37, seqWriteMBps: 100, seqReadMBps: 110 },
			net: { upMbps: 170, downMbps: 110 },
		}),
		a('disturbed'),
		a('measured', {
			disk: { fs: 'ext4', syncWriteMs: 41, seqWriteMBps: 90, seqReadMBps: 100 },
			net: null,
		}),
	];
	const s = summarizeActive('claw-1', rows);
	assert.deepEqual([s.attempts, s.measured, s.busy, s.disturbed], [4, 2, 1, 1]);
	assert.equal(s.syncWriteMs.max, 41);
	assert.equal(s.upMbps.p50, 170, 'a dropped network reading is not a zero');
	const never = summarizeActive('claw-2', [a('busy', { why: 'not idle: 2 CI job(s)' })]);
	assert.equal(never.measured, 0);
	assert.equal(never.syncWriteMs.p50, null);
	assert.match(never.lastWhy, /not idle/);
});
