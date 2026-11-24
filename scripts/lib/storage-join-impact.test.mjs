import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JOIN_JOB_RATIO, compareJoin, joinImpact, nodeOfRunner } from './storage-join-impact.mjs';

const DAY = 86_400_000;
const JOINED = Date.now() - 10 * DAY;
const at = (dayOffset) => new Date(JOINED + dayOffset * DAY).toISOString();
const jobs = (factor) =>
	['a', 'b', 'c'].flatMap((name) =>
		[1, 2, 3, 4].flatMap((d) => [
			{ repo: 'r', name, runSec: 100, startedAt: at(-d), conclusion: 'success' },
			{ repo: 'r', name, runSec: 100 * factor, startedAt: at(d), conclusion: 'success' },
		])
	);
const perf = (io) => [
	...[1, 2, 3].map((d) => ({ at: at(-d), psi: { ioSome: 1, cpuSome: 3 } })),
	...[1, 2, 3].map((d) => ({ at: at(d), psi: { ioSome: io, cpuSome: 3 } })),
];

void test('a node whose jobs or pressure moved across the join is a regression', () => {
	const ok = compareJoin({
		node: 'claw-9',
		joinedMs: JOINED,
		nowMs: Date.now(),
		jobs: jobs(1.05),
		perf: perf(2),
	});
	assert.equal(ok.status, 'ok', ok.reason);
	const slow = compareJoin({
		node: 'claw-9',
		joinedMs: JOINED,
		nowMs: Date.now(),
		jobs: jobs(1.3),
		perf: perf(2),
	});
	assert.equal(slow.status, 'regressed');
	assert.match(slow.reason, new RegExp(`1.3x .* > ${JOIN_JOB_RATIO}x`));
	const io = compareJoin({
		node: 'claw-9',
		joinedMs: JOINED,
		nowMs: Date.now(),
		jobs: jobs(1),
		perf: perf(9),
	});
	assert.match(io.reason, /IO pressure median 9% vs 1%/);
});

void test('too soon, or too little to compare, is known, never ok', () => {
	const quick = jobs(1.8).map((x) =>
		Date.parse(x.startedAt) > JOINED ? { ...x, startedAt: at(0.1) } : x
	);
	const early = compareJoin({
		node: 'claw-9',
		joinedMs: JOINED,
		nowMs: JOINED + DAY / 3,
		jobs: quick,
		perf: [],
	});
	assert.match(early.reason, /too early to judge the join .* so far: CI jobs run 1.8x/);
	assert.equal(early.status, 'known', 'a third of a day is not a regression');
	const soon = compareJoin({
		node: 'claw-8',
		joinedMs: Date.now() - DAY,
		nowMs: Date.now(),
		jobs: [],
		perf: [],
	});
	assert.equal(soon.status, 'known');
	assert.match(soon.reason, /1 of 7 days/);
	const thin = compareJoin({
		node: 'claw-8',
		joinedMs: JOINED,
		nowMs: Date.now(),
		jobs: jobs(1).slice(0, 4),
		perf: perf(1),
	});
	assert.equal(thin.status, 'known');
	// A failed job is not a time.
	const failed = jobs(3).map((j) => (j.runSec > 100 ? { ...j, conclusion: 'failure' } : j));
	assert.equal(
		compareJoin({ node: 'x', joinedMs: JOINED, nowMs: Date.now(), jobs: failed, perf: perf(1) })
			.status,
		'known'
	);
});

void test('runners map to the longest node name, and only active zones are compared', () => {
	const nodes = ['claw-1', 'claw-10', 'hokon'];
	assert.equal(nodeOfRunner('jit-claw-10-hadoku-x-j1-r2-3', nodes), 'claw-10');
	assert.equal(nodeOfRunner('jit-claw-1-hadoku-x-j1-r2-3', nodes), 'claw-1');
	assert.equal(nodeOfRunner('warm-claw-1-hadoku_site', nodes), 'claw-1');
	assert.equal(nodeOfRunner('hokon', nodes), 'hokon');
	assert.equal(nodeOfRunner('ubuntu-latest', nodes), null);
	const out = joinImpact({
		declared: {
			zones: {
				'claw-1': { state: 'active', at: at(0) },
				'claw-10': { state: 'drain', at: at(0) },
				'claw-9': { state: 'active' },
			},
		},
		nodes,
		nowMs: Date.now(),
		jobs: jobs(1).map((j) => ({ ...j, runner: 'jit-claw-1-hadoku-x' })),
		perf: perf(1).map((p) => ({ ...p, node: 'claw-1' })),
	});
	assert.deepEqual(
		out.map((o) => [o.node, o.status]),
		[
			['claw-1', 'ok'],
			['claw-9', 'known'],
		]
	);
});
