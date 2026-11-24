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
	heaviestCgroup,
	ioStatBytes,
	lowWeightCgroups,
	parsePressure,
	percentile,
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
		host: { some: 0, full: 0 },
		lows: { x: { cpuUsec: 1_000_000, bytes: 0, ioSome: 0 } },
	};
	const b = {
		t: 10_000_000_000n, // 10 s
		prod: { some: 3_100_000, full: 1_000_000 },
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
		hostSome: 50,
		hostFull: 0,
		lowCgroups: 2,
		lowCpuPerSec: 2.5,
		lowMBps: 15,
		lowIoSomeSum: 20,
	});
});

const win = (state, prodSome, p99, lowCpuPerSec) => ({
	state,
	prodSome,
	lowCpuPerSec,
	lowMBps: 100,
	hostSome: 50,
	load1: 200,
	ready: { p99, fails: 0 },
});

void test('ships only when production pressure and p99 fall and the low-weight work holds', () => {
	const good = verdict([win('off', 30, 1200, 10), win('on', 8, 40, 8)], 0.5);
	assert.equal(good.ships, true);
	assert.equal(good.lowKept, 0.8);

	const collapse = verdict([win('off', 30, 1200, 10), win('on', 8, 40, 3)], 0.5);
	assert.equal(collapse.ships, false);
	assert.match(collapse.why, /kept 30% of its OFF rate, under the 50% floor/);

	const noHelp = verdict([win('off', 30, 1200, 10), win('on', 31, 40, 10)], 0.5);
	assert.equal(noHelp.ships, false);
	assert.match(noHelp.why, /production io\.pressure did not fall/);

	assert.equal(verdict([win('off', 30, 1200, 10)], 0.5).ships, null);
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
	assert.deepEqual(lowWeightCgroups(root).sort(), [
		'user.slice/u/app.slice/tmux-a.scope',
		'user.slice/u/ci.slice',
	]);
	assert.equal(heaviestCgroup(root), 'system.slice/prod.service');
	writeFileSync(join(root, 'system.slice/prod.service/io.weight'), 'default 100\n');
	assert.equal(heaviestCgroup(root), null);
});
