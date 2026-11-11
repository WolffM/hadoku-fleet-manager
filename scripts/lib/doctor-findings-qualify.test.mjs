import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	PRODUCTION_MIN_TICKS,
	qualifiedCapacity,
	qualifyFindings,
	rampEntry,
} from './doctor-findings-qualify.mjs';
import { mergeQualifyResults } from './qualify-results.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const CLAW = { role: 'claw', maxConcurrent: 3 };

/** A ledger entry as the runner records it: a pass at `ceiling`, `daysAgo`. */
function passed(ceiling, daysAgo = 1, node = 'n') {
	const at = new Date(NOW - daysAgo * 86_400_000).toISOString();
	const l = mergeQualifyResults(
		{},
		node,
		[{ id: 'concurrency-ramp', status: 'pass', reason: `holds ${ceiling}`, metrics: { ceiling } }],
		at
	);
	return rampEntry(l, node);
}
const perf = (n, workers, cpu) =>
	Array.from({ length: n }, () => ({ workers, psi300: { cpuSome: cpu } }));

void test('the ledger entry is found under node::concurrency-ramp', () => {
	assert.equal(passed(2).lastPass.metrics.ceiling, 2);
});

void test('a ceiling equal to the live limit agrees, and makes no finding', () => {
	const c = qualifiedCapacity({ machine: CLAW, entry: passed(3), perfRows: [], nowMs: NOW });
	assert.equal(c.state, 'agrees');
	assert.deepEqual(qualifyFindings({ node: 'n', qualifiedCapacity: c }), []);
});

void test('a lower ceiling would lower, a higher one would raise; both are SHADOW advisories', () => {
	const lo = qualifiedCapacity({ machine: CLAW, entry: passed(2), perfRows: [], nowMs: NOW });
	const hi = qualifiedCapacity({ machine: CLAW, entry: passed(5), perfRows: [], nowMs: NOW });
	assert.deepEqual(
		[lo.state, lo.proposal, hi.state, hi.proposal],
		['would-lower', 2, 'would-raise', 5]
	);
	const [fd] = qualifyFindings({ node: 'n', qualifiedCapacity: hi });
	assert.equal(fd.class, 'advisory');
	assert.equal(fd.status, 'would-raise');
	assert.match(fd.why, /^SHADOW: qualification proposes maxConcurrent 5 against the live 3/);
	assert.match(fd.why, /Nothing is written/);
});

void test('a week of production over the line at the live limit lowers the proposal to one below it', () => {
	const c = qualifiedCapacity({
		machine: CLAW,
		entry: passed(5),
		perfRows: perf(PRODUCTION_MIN_TICKS, 3, 24),
		nowMs: NOW,
	});
	assert.equal(c.proposal, 2);
	assert.equal(c.state, 'would-lower');
	assert.match(c.why, /production lowered it: at 3 jobs the CPU pressure p90 was 24 %/);
});

void test('production never RAISES, and too few ticks never lowers', () => {
	assert.equal(
		qualifiedCapacity({ machine: CLAW, entry: passed(2), perfRows: perf(500, 3, 1), nowMs: NOW })
			.proposal,
		2
	);
	assert.equal(
		qualifiedCapacity({
			machine: CLAW,
			entry: passed(5),
			perfRows: perf(PRODUCTION_MIN_TICKS - 1, 3, 90),
			nowMs: NOW,
		}).proposal,
		5
	);
	// Ticks at another job count are not "at the limit".
	assert.equal(
		qualifiedCapacity({ machine: CLAW, entry: passed(5), perfRows: perf(500, 2, 90), nowMs: NOW })
			.proposal,
		5
	);
});

void test('the backstop has no proposal', () => {
	const c = qualifiedCapacity({
		machine: { role: 'backstop', maxConcurrent: 4 },
		entry: passed(9),
		perfRows: [],
		nowMs: NOW,
	});
	assert.equal(c.state, 'backstop');
	assert.deepEqual(qualifyFindings({ node: 'hokon', qualifiedCapacity: c }), []);
});

void test('never qualified: no finding; a result past 21 days: expired, no proposal', () => {
	assert.equal(
		qualifiedCapacity({ machine: CLAW, entry: null, perfRows: [], nowMs: NOW }).state,
		'unqualified'
	);
	const old = qualifiedCapacity({ machine: CLAW, entry: passed(2, 22), perfRows: [], nowMs: NOW });
	assert.deepEqual([old.state, old.proposal], ['expired', null]);
});

void test('a ramp that failed at k=1 is a SHADOW advisory naming why', () => {
	const at = new Date(NOW - 86_400_000).toISOString();
	const l = mergeQualifyResults(
		{},
		'n',
		[
			{
				id: 'concurrency-ramp',
				status: 'fail',
				reason: 'package reached 97 °C',
				metrics: { ceiling: 0 },
			},
		],
		at
	);
	const c = qualifiedCapacity({
		machine: CLAW,
		entry: rampEntry(l, 'n'),
		perfRows: [],
		nowMs: NOW,
	});
	assert.equal(c.state, 'failed');
	assert.match(
		qualifyFindings({ node: 'n', qualifiedCapacity: c })[0].why,
		/failed at k=1: package reached 97 °C/
	);
});

void test('could not look is said, never silent', () => {
	const at = new Date(NOW - 86_400_000).toISOString();
	const l = mergeQualifyResults(
		{},
		'n',
		[{ id: 'concurrency-ramp', status: 'could-not-look', reason: 'never went quiet' }],
		at
	);
	const c = qualifiedCapacity({
		machine: CLAW,
		entry: rampEntry(l, 'n'),
		perfRows: [],
		nowMs: NOW,
	});
	assert.equal(c.state, 'could-not-look');
	const [fd] = qualifyFindings({ node: 'n', qualifiedCapacity: c });
	assert.equal(fd.status, 'unjudged');
	assert.match(fd.why, /never went quiet/);
	// The doctor-run join's own unreadable shape.
	const [u] = qualifyFindings({
		node: 'n',
		qualifiedCapacity: {
			state: 'could-not-look',
			why: 'the qualification ledger is unreadable: torn',
		},
	});
	assert.match(u.why, /ledger is unreadable: torn/);
});
