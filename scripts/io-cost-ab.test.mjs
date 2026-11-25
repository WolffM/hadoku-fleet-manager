/**
 * The io.cost A/B's arithmetic (hadoku-fleet-manager#158). The switching and
 * the probing run only on a box with the root helper installed; what is pinned
 * here is how counters become a window and windows become a verdict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	ddSeconds,
	heaviestCgroup,
	ioStatBytes,
	lowWeightCgroups,
	parsePressure,
	percentile,
	summarizeProbe,
	verdict,
	windowDelta,
} from './io-cost-ab.mjs';

void test('PSI totals and one device’s bytes are read from the kernel’s own text', () => {
	assert.deepEqual(
		parsePressure(
			'some avg10=8.30 avg60=6.68 avg300=19.32 total=3525098935\nfull avg10=8.12 avg60=6.42 avg300=18.83 total=3309001812\n'
		),
		{ some: 3525098935, full: 3309001812 }
	);
	const io =
		'254:0 rbytes=9 wbytes=9 rios=1 wios=1\n259:8 rbytes=100 wbytes=50 rios=1 wios=1 dbytes=0 dios=0\n';
	assert.equal(ioStatBytes(io, '259:8'), 150);
	assert.equal(ioStatBytes(io, '8:0'), 0);
	assert.equal(percentile([], 99), null);
	assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
	assert.equal(percentile([1, 2, 3, 4, 100], 99), 100);
});

void test('a window is rates over its length; a scope born in the window counts from zero', () => {
	const a = {
		t: 0n,
		prod: { some: 0, full: 0 },
		inter: { some: 0, full: 0 },
		host: { some: 0, full: 0 },
		lows: { x: { cpuUsec: 1_000_000, bytes: 0, ioSome: 0 } },
	};
	const b = {
		t: 10_000_000_000n, // 10 s
		prod: { some: 3_100_000, full: 1_000_000 },
		inter: { some: 400_000, full: 0 },
		host: { some: 5_000_000, full: 0 },
		lows: {
			x: { cpuUsec: 21_000_000, bytes: 100e6, ioSome: 2_000_000 },
			born: { cpuUsec: 5_000_000, bytes: 50e6, ioSome: 0 },
		},
	};
	assert.deepEqual(windowDelta(a, b), {
		seconds: 10,
		prodSome: 31,
		prodFull: 10,
		interSome: 4,
		hostSome: 50,
		hostFull: 0,
		lowCgroups: 2,
		lowCpuPerSec: 2.5,
		lowMBps: 15,
		lowIoSomeSum: 20,
	});
});

const win = (state, interP99, prodSome, readyP99, lowCpuPerSec) => ({
	state,
	inter: { p99: interP99 },
	interSome: 1,
	prodSome,
	lowCpuPerSec,
	lowMBps: 100,
	hostSome: 50,
	load1: 200,
	ready: { p99: readyP99, fails: 0 },
});
const OFF = win('off', 480, 3.8, 737, 10);

void test('ships when interactive p99 falls, production holds within the band, and agents keep the floor', () => {
	// Production slightly worse but inside +25% +1 pt / +25% +50 ms; agents at 30%.
	const good = verdict([OFF, win('on', 40, 5.5, 950, 3)], 0.25);
	assert.equal(good.ships, true, good.why);
	assert.equal(good.lowKept, 0.3);
	assert.match(good.band, /1\.25/);
});

void test('the interactive side is the target: production improving does not ship it alone', () => {
	const v = verdict([OFF, win('on', 500, 1, 100, 10)], 0.25);
	assert.equal(v.ships, false);
	assert.match(v.why, /interactive p99 did not fall \(480 -> 500 ms\)/);
});

void test('production rising past the band is a fail, as the first A/B measured', () => {
	// 11-24: prod io some 3.8% -> 6.5%, ready p99 737 -> 2187 ms.
	const v = verdict([OFF, win('on', 40, 6.5, 2187, 10)], 0.25);
	assert.equal(v.ships, false);
	assert.match(v.why, /production io\.pressure rose past the band \(3\.8% -> 6\.5%/);
	assert.match(v.why, /ready p99 rose past the band \(737 -> 2187 ms/);
});

void test('stalled agents are a fail: slower is the point, under the floor is not', () => {
	const v = verdict([OFF, win('on', 40, 3.8, 737, 2)], 0.25);
	assert.equal(v.ships, false);
	assert.match(v.why, /kept 20% of its OFF rate, under the 25% floor/);
	assert.equal(verdict([OFF], 0.25).ships, null);
});

void test('dd times itself; the probe summary counts failures and names the first', () => {
	assert.equal(
		ddSeconds(
			'1+0 records in\n1+0 records out\n4096 bytes (4.1 kB, 4.0 KiB) copied, 0.00507664 s, 807 kB/s\n'
		),
		0.00507664
	);
	assert.equal(ddSeconds('dd: failed to open'), null);
	const s = summarizeProbe(
		[
			{ ms: 2, readMs: 1, writeMs: 1 },
			{ ms: 10, readMs: 2, writeMs: 8 },
			{ err: 'dd exit 1: No space left' },
		],
		'/u/session.slice/run-1.scope'
	);
	assert.deepEqual(s, {
		cgroup: '/u/session.slice/run-1.scope',
		samples: 3,
		fails: 1,
		p50: 2,
		p99: 10,
		max: 10,
		readP99: 2,
		writeP99: 8,
		firstError: 'dd exit 1: No space left',
	});
});

void test('the low-weight set stops at the first cgroup below the default, so work is counted once', () => {
	const root = mkdtempSync(join(tmpdir(), 'io-ab-'));
	const cg = (rel, w) => {
		mkdirSync(join(root, rel), { recursive: true });
		writeFileSync(join(root, rel, 'io.weight'), `default ${w}\n`);
	};
	cg('system.slice', 100);
	cg('system.slice/prod.service', 1000);
	cg('user.slice', 100);
	cg('user.slice/u/ci.slice', 25);
	cg('user.slice/u/ci.slice/runner.slice', 50);
	cg('user.slice/u/app.slice/tmux-a.scope', 20);
	cg('user.slice/u/session.slice', 5000); // the desktop: heavier, and not production
	assert.deepEqual(lowWeightCgroups(root).sort(), [
		'user.slice/u/app.slice/tmux-a.scope',
		'user.slice/u/ci.slice',
	]);
	assert.equal(heaviestCgroup(root), 'system.slice/prod.service');
	writeFileSync(join(root, 'system.slice/prod.service/io.weight'), 'default 100\n');
	assert.equal(heaviestCgroup(root), null);
});
