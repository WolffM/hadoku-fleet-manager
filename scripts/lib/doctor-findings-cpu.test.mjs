import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	CPU_OVERSUB_MIN_TICKS,
	CPU_OVERSUB_PCT,
	cpuFindings,
	cpuLoadFacet,
} from './doctor-findings-cpu.mjs';
import { doctorFindings } from './doctor-findings.mjs';
import { healthRecord } from './doctor-facet.mjs';

const row = (workers, cpuSome, extra = {}) => ({
	ok: true,
	node: 'claw-10',
	workers,
	psi300: { cpuSome },
	...extra,
});
const many = (n, workers, cpuSome) => Array.from({ length: n }, () => row(workers, cpuSome));

test('claw-10 at 3: a day of at-limit ticks stalled ~40 % is oversubscribed, and 2 is what it supports', () => {
	const rows = [...many(20, 3, 40), ...many(20, 2, 8), ...many(30, 0, 0)];
	const c = cpuLoadFacet(rows, 3);
	assert.equal(c.judged, true);
	assert.equal(c.atLimitTicks, 20);
	assert.equal(c.p50AtLimit, 40);
	assert.equal(c.oversubscribed, true);
	assert.equal(c.supports, 2);
	const [fd] = cpuFindings({ node: 'claw-10', cpuLoad: c });
	assert.equal(fd.status, 'cpu-oversubscribed');
	assert.equal(fd.class, 'advisory');
	assert.match(fd.why, /lowering maxConcurrent to 2/);
});

test('a median, so a few heavy builds at the limit do not flag a node', () => {
	const rows = [...many(15, 3, 2), ...many(5, 3, 90)];
	assert.equal(cpuLoadFacet(rows, 3).oversubscribed, false);
});

test('under an hour at the limit is not enough evidence to judge', () => {
	const c = cpuLoadFacet(many(CPU_OVERSUB_MIN_TICKS - 1, 3, 80), 3);
	assert.equal(c.oversubscribed, false);
	assert.deepEqual(cpuFindings({ node: 'claw-10', cpuLoad: c }), []);
});

test('the line is inclusive, and a count above the limit counts as at it', () => {
	assert.equal(
		cpuLoadFacet(many(CPU_OVERSUB_MIN_TICKS, 4, CPU_OVERSUB_PCT), 3).oversubscribed,
		true
	);
});

test('with no clean lower count, it says so instead of naming one', () => {
	const c = cpuLoadFacet([...many(20, 3, 40), ...many(3, 2, 5)], 3);
	assert.equal(c.supports, null);
	assert.match(cpuFindings({ node: 'x', cpuLoad: c })[0].why, /No lower job count/);
});

test('could not look is an advisory with the reason, never silence', () => {
	for (const [c, re] of [
		[cpuLoadFacet([], 3), /no perf samples/],
		[cpuLoadFacet([{ ok: true, psi: { cpuSome: 1 } }], 3), /none carrying avg300/],
		[cpuLoadFacet(many(20, 3, 40), null), /no maxConcurrent/],
		[cpuLoadFacet([], 3, { unreadable: 'perf day file(s) unreadable: x' }), /unreadable/],
	]) {
		const [fd] = cpuFindings({ node: 'x', cpuLoad: c });
		assert.equal(fd.status, 'unjudged');
		assert.equal(fd.class, 'advisory');
		assert.match(fd.why, re);
	}
});

test('rows the node could not measure, or with no job count, are not evidence', () => {
	const rows = [...many(20, 3, 40).map((r) => ({ ...r, ok: false })), ...many(20, null, 40)];
	assert.equal(cpuLoadFacet(rows, 3).judged, false);
});

test('doctor carries the finding, and the join is never stored in $health', () => {
	const cpuLoad = cpuLoadFacet(many(20, 3, 40), 3);
	const health = { node: 'claw-10', reachable: true, cpuLoad };
	assert.ok(doctorFindings(health).some((fd) => fd.status === 'cpu-oversubscribed'));
	assert.equal('cpuLoad' in healthRecord(health), false);
});
