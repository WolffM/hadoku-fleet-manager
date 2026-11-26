import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
	BASELINE_WINDOW,
	NODE_BASELINES_FILE,
	WRITTEN_FILE,
	bandOf,
	judgeReading,
	learnReading,
	mergeNodeBaselines,
	nodeQuantities,
	nodeWeakPoints,
	readNodeBaselines,
	recordNodeBaselines,
} from './node-baselines.mjs';

const SPEC = { unit: 'ms', worse: 'higher', rel: 0.5, abs: 5 };
const AT = new Date().toISOString();
const LATER = new Date(Date.now() + 9 * 86_400_000).toISOString();

void test('no estimate yet is learning, never a verdict', () => {
	assert.deepEqual(judgeReading(undefined, 150, SPEC), { verdict: 'learning' });
	assert.deepEqual(judgeReading({ n: 0, mean: 0, sd: 0 }, 150, SPEC), { verdict: 'learning' });
});

void test('the band is the widest of 3 sd, the relative and the absolute tolerance', () => {
	assert.equal(bandOf({ mean: 100, sd: 0 }, SPEC), 50);
	assert.equal(bandOf({ mean: 100, sd: 30 }, SPEC), 90);
	assert.equal(bandOf({ mean: 2, sd: 0 }, SPEC), 5);
});

void test('a reading in the band is within; outside it is drift, worse or better by the spec', () => {
	const e = { mean: 150, sd: 0, n: 1 };
	assert.equal(judgeReading(e, 200, SPEC).verdict, 'within');
	assert.deepEqual(
		{ ...judgeReading(e, 240, SPEC) },
		{ verdict: 'drift', direction: 'worse', mean: 150, sd: 0, n: 1, band: 75 }
	);
	assert.equal(judgeReading(e, 40, SPEC).direction, 'better');
	assert.equal(judgeReading(e, 40, { ...SPEC, worse: 'lower' }).direction, 'worse');
});

void test('minReadings: an estimate with fewer readings is learning, not drift (#165)', () => {
	const e = { mean: 150, sd: 0, n: 2 };
	assert.deepEqual(judgeReading(e, 400, { ...SPEC, minReadings: 3 }), {
		verdict: 'learning',
		mean: 150,
		sd: 0,
		n: 2,
		band: 75,
	});
	assert.equal(judgeReading({ ...e, n: 3 }, 400, { ...SPEC, minReadings: 3 }).verdict, 'drift');
	// The default judges from the first reading: an exact counter needs no history.
	assert.equal(judgeReading({ ...e, n: 1 }, 400, SPEC).verdict, 'drift');
});

void test('learning: the first reading seeds; later ones step with weight never below 1/window', () => {
	let e = learnReading(undefined, 100, SPEC, AT, false);
	assert.deepEqual(
		{ mean: e.mean, sd: e.sd, n: e.n, worse: e.worse, unit: e.unit },
		{ mean: 100, sd: 0, n: 1, worse: 'higher', unit: 'ms' }
	);
	e = learnReading(e, 120, SPEC, AT, false);
	assert.equal(e.n, 2);
	assert.equal(e.mean, 110);
	assert.equal(e.sd, 10);
	for (let i = 0; i < 20; i++) e = learnReading(e, 120, SPEC, AT, false);
	assert.equal(e.n, BASELINE_WINDOW);
	assert.ok(e.mean > 119 && e.mean <= 120, `followed the new level: ${e.mean}`);
});

void test('a drift re-seeds AT the reading, keeps the spread, and says where it came from', () => {
	const e = learnReading({ mean: 60, sd: 8, n: 5 }, 150, SPEC, AT, true);
	assert.equal(e.mean, 150);
	assert.equal(e.sd, 8);
	assert.equal(e.n, 1);
	assert.deepEqual(e.lastDrift, { at: AT, from: 60, to: 150 });
	// The next ordinary night is judged against the new level, not the old.
	assert.equal(judgeReading(e, 155, SPEC).verdict, 'within');
});

void test('weak points: a new one records since; a repeat keeps since; a pass clears it', () => {
	const w1 = {
		readings: [],
		weak: [{ test: 'disk-sync-writes', reason: 'p99 150 > 80' }],
		cleared: [],
	};
	let s = mergeNodeBaselines({ quantities: {}, weakPoints: {} }, 'claw-1', w1, AT);
	assert.equal(s.weakPoints['claw-1']['disk-sync-writes'].since, AT);
	s = mergeNodeBaselines(s, 'claw-1', w1, LATER);
	assert.equal(s.weakPoints['claw-1']['disk-sync-writes'].since, AT);
	assert.equal(s.weakPoints['claw-1']['disk-sync-writes'].lastSeen, LATER);
	s = mergeNodeBaselines(
		s,
		'claw-1',
		{ readings: [], weak: [], cleared: ['disk-sync-writes'] },
		AT
	);
	assert.equal(s.weakPoints['claw-1'], undefined);
});

void test('the store: missing is empty; unreadable is said and never overwritten', () => {
	const dir = mkdtempSync(join(tmpdir(), 'node-baselines-'));
	assert.deepEqual(readNodeBaselines(dir), { ok: true, store: { quantities: {}, weakPoints: {} } });
	const w = {
		readings: [{ quantity: 'disk.holdRatio', value: 0.9, spec: SPEC, drifted: false }],
		weak: [],
		cleared: [],
	};
	assert.deepEqual(recordNodeBaselines(dir, 'claw-1', w, AT), { ok: true });
	const read = readNodeBaselines(dir);
	assert.equal(nodeQuantities(read.store, 'claw-1')['disk.holdRatio'].mean, 0.9);
	assert.deepEqual(nodeQuantities(read.store, 'claw-10'), {});

	writeFileSync(join(dir, NODE_BASELINES_FILE), '{not json');
	const bad = recordNodeBaselines(dir, 'claw-1', w, AT);
	assert.equal(bad.ok, false);
	assert.equal(readFileSync(join(dir, NODE_BASELINES_FILE), 'utf8'), '{not json');
});

void test('weak points for a status reader: oldest first; unreadable is null with the reason', () => {
	const store = {
		quantities: {},
		weakPoints: {
			'claw-1': {
				'disk-sync-writes': { reason: 'p99 150 > 80', since: LATER, lastSeen: LATER },
				'concurrency-ramp': { reason: '98 °C', since: AT, lastSeen: LATER },
			},
		},
	};
	assert.deepEqual(
		nodeWeakPoints({ ok: true, store }, 'claw-1').weakPoints.map((w) => w.test),
		['concurrency-ramp', 'disk-sync-writes']
	);
	assert.deepEqual(nodeWeakPoints({ ok: true, store }, 'claw-4'), { weakPoints: [] });
	assert.deepEqual(nodeWeakPoints({ ok: false, reason: 'bad json' }, 'claw-1'), {
		weakPoints: null,
		why: 'bad json',
	});
});

void test('the writer writes the file the reader reads', () => {
	assert.equal(WRITTEN_FILE, NODE_BASELINES_FILE);
});
