/**
 * The rule that would have caught claw-5, asserted against its actual shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	drainViolations,
	drainHonoured,
	DEFAULT_GRACE_SEC,
	recordNodeOf,
} from './drain-enforcement.mjs';

const nodeOf = (r) => r.node;
const drained = { 'claw-5': { since: '2026-09-06T10:00:00.000Z', kind: 'maintenance' } };

test('a job STARTED after the drain is a violation', () => {
	const v = drainViolations(
		drained,
		[{ node: 'claw-5', startedAt: '2026-09-06T12:00:00Z', repo: 'WolffM/x', name: 'build' }],
		nodeOf
	);
	assert.equal(v.length, 1);
	assert.equal(v[0].kind, 'NOT-ENFORCED');
	assert.match(v[0].why, /WolffM\/x\/build/);
});

test('a job already RUNNING when the drain landed is NOT a violation', () => {
	// A drain never kills running work; the node reaches `drained` when it
	// finishes. Flagging that would make every correct drain look broken.
	const v = drainViolations(
		drained,
		[{ node: 'claw-5', startedAt: '2026-09-06T09:59:00Z', repo: 'WolffM/x', name: 'build' }],
		nodeOf
	);
	assert.equal(v.length, 0);
});

test('the grace window covers work already in the pipe', () => {
	const inside = new Date(Date.parse(drained['claw-5'].since) + (DEFAULT_GRACE_SEC - 5) * 1000);
	const outside = new Date(Date.parse(drained['claw-5'].since) + (DEFAULT_GRACE_SEC + 5) * 1000);
	assert.equal(
		drainViolations(drained, [{ node: 'claw-5', startedAt: inside.toISOString() }], nodeOf).length,
		0
	);
	assert.equal(
		drainViolations(drained, [{ node: 'claw-5', startedAt: outside.toISOString() }], nodeOf).length,
		1
	);
});

test('work on a node that is NOT drained is ignored', () => {
	const v = drainViolations(
		drained,
		[{ node: 'claw-1', startedAt: '2026-09-06T23:00:00Z' }],
		nodeOf
	);
	assert.equal(v.length, 0);
});

test('a drain with no parseable date is reported, never skipped', () => {
	// "cannot check" is not "enforced" — the whole failure this gate exists for.
	const v = drainViolations({ 'claw-9': { since: 'whenever' } }, [], nodeOf);
	assert.equal(v.length, 1);
	assert.equal(v[0].kind, 'UNDATED');
});

test('an empty drain set has nothing to violate', () => {
	assert.deepEqual(
		drainViolations({}, [{ node: 'claw-5', startedAt: '2026-09-06T23:00:00Z' }], nodeOf),
		[]
	);
	assert.deepEqual(drainViolations(undefined, [], nodeOf), []);
});

test('honoured lists the drains that ARE working, so a pass shows its work', () => {
	const two = { ...drained, 'claw-3': { since: '2026-09-06T10:00:00.000Z' } };
	const v = drainViolations(two, [{ node: 'claw-5', startedAt: '2026-09-06T23:00:00Z' }], nodeOf);
	const ok = drainHonoured(two, v);
	assert.equal(ok.length, 1);
	assert.equal(ok[0].node, 'claw-3');
	assert.equal(ok[0].kind, 'maintenance', 'kind defaults rather than reading undefined');
});

test('the most recent offending job is the one named', () => {
	const v = drainViolations(
		drained,
		[
			{ node: 'claw-5', startedAt: '2026-09-06T12:00:00Z', repo: 'r', name: 'early' },
			{ node: 'claw-5', startedAt: '2026-09-06T18:00:00Z', repo: 'r', name: 'late' },
		],
		nodeOf
	);
	assert.match(v[0].why, /r\/late/);
	assert.equal(v[0].jobs[0].unit, 'r/late');
});

// #91: the gate's runner attribution, not a test-local stand-in. The 23 jobs
// claw-5 served through its warm listener while drained (#90) were recorded as
// `warm-claw-5-hadoku_site`; the old local parser understood only `jit-` and so
// could never report them.
test('a warm listener job inside a drain window is a violation (#91)', () => {
	const since = new Date(Date.now() - 3_600_000);
	const drained = { 'claw-5': { since: since.toISOString(), reason: 'test' } };
	const startedAt = new Date(since.getTime() + (DEFAULT_GRACE_SEC + 60) * 1000).toISOString();
	const history = [
		{ runner: 'warm-claw-5-hadoku_site', repo: 'WolffM/hadoku_site', startedAt },
		{ runner: 'jit-claw-5-hadoku-cardtabl-j1-r2-3', repo: 'WolffM/hadoku-cardtable', startedAt },
	];
	const v = drainViolations(drained, history, recordNodeOf(Object.keys(drained)));
	assert.equal(v.length, 1, `one violation for claw-5; got ${JSON.stringify(v)}`);
	assert.equal(v[0].node, 'claw-5');
	assert.equal(v[0].jobs.length, 2, 'both the warm and the jit job are attributed to claw-5');
});

test('a shorter drained name never claims a longer node’s runner (claw-1 vs claw-10)', () => {
	const since = new Date(Date.now() - 3_600_000);
	const drained = { 'claw-1': { since: since.toISOString(), reason: 'test' } };
	const startedAt = new Date(since.getTime() + (DEFAULT_GRACE_SEC + 60) * 1000).toISOString();
	const history = [
		{ runner: 'warm-claw-10-hadoku_site', repo: 'WolffM/hadoku_site', startedAt },
		{ runner: 'jit-claw-10-hadoku_site-j1-r2-3', repo: 'WolffM/hadoku_site', startedAt },
	];
	assert.equal(drainViolations(drained, history, recordNodeOf(Object.keys(drained))).length, 0);
});
