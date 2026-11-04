import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	EARN,
	KEEP,
	MIN_EVIDENCE_MS,
	RELIABILITY_WINDOW_MS,
	SAMPLE_MS,
	judgeNode,
	reliabilityOf,
} from './host-reliability.mjs';

const NOW = Date.now();
const ENOUGH = MIN_EVIDENCE_MS / SAMPLE_MS;

/** `n` consecutive 5-minute rows ending at `endMs`, all up, with `down` overriding by index. */
function rows(n, { endMs = NOW, node = 'claw-x', down = {}, drained = {} } = {}) {
	return Array.from({ length: n }, (_, i) => ({
		at: new Date(endMs - (n - 1 - i) * SAMPLE_MS).toISOString(),
		node,
		state: down[i] ?? 'mintable',
		drained: drained[i] ?? false,
		unmeasured: false,
	}));
}
const span = (from, len, state = 'unreachable') =>
	Object.fromEntries(Array.from({ length: len }, (_, k) => [from + k, state]));

test('a node that stayed up earns and keeps', () => {
	const v = judgeNode(rows(ENOUGH));
	assert.equal(v.earn, true);
	assert.equal(v.keep, true);
	assert.equal(v.downMin, 0);
});

test('the 2026-11-03 cable: one 95 min outage fails EARN and passes KEEP', () => {
	const v = judgeNode(rows(ENOUGH, { down: span(500, 19) }));
	assert.equal(v.downMin, 95);
	assert.equal(v.outages.length, 1);
	assert.equal(v.earn, false);
	assert.equal(v.keep, true);
	assert.match(v.why, /95 min down, 1 outage.*a new slice needs ≤ 30 min/);
});

test('a single down tick is a blip: its minutes count, it is not an outage', () => {
	const v = judgeNode(rows(ENOUGH, { down: { 10: 'unreachable', 400: 'sick' } }));
	assert.equal(v.downMin, 10);
	assert.equal(v.outages.length, 0);
	assert.equal(v.earn, true);
});

test('flaky: many short outages fail KEEP even when the minutes are small', () => {
	const down = { ...span(100, 2), ...span(300, 2), ...span(500, 2), ...span(700, 2) };
	const v = judgeNode(rows(ENOUGH, { down }));
	assert.equal(v.outages.length, KEEP.outages + 1);
	assert.ok(v.downMin <= KEEP.downMin);
	assert.equal(v.keep, false);
	assert.match(v.why, /a held slice needs/);
});

test('a planned (drained) down is not counted; an undrained one is', () => {
	const planned = judgeNode(
		rows(ENOUGH, {
			down: span(200, 12),
			drained: Object.fromEntries([...Array(12)].map((_, k) => [200 + k, true])),
		})
	);
	assert.equal(planned.downMin, 0);
	assert.equal(planned.earn, true);
	const unplanned = judgeNode(rows(ENOUGH, { down: span(200, 12) }));
	assert.equal(unplanned.downMin, 60);
	assert.equal(unplanned.earn, false);
});

test('a gap in the samples ends a run: an outage is never merged into fewer', () => {
	const half = ENOUGH / 2;
	const after = rows(half, { down: span(0, 2) });
	// `before` ends an hour before `after` starts: mgmt-api was down in between.
	const before = rows(half, {
		endMs: Date.parse(after[0].at) - 60 * 60_000,
		down: span(half - 2, 2),
	});
	assert.equal(judgeNode([...before, ...after]).outages.length, 2);
	const joined = rows(ENOUGH, { down: span(half - 2, 4) });
	assert.equal(
		judgeNode(joined).outages.length,
		1,
		'the same four ticks with no gap are one outage'
	);
});

test('not enough evidence is null on both bars, and says how much there is', () => {
	const v = judgeNode(rows(ENOUGH - 1));
	assert.equal(v.earn, null);
	assert.equal(v.keep, null);
	assert.match(v.why, /h are needed to judge/);
});

test('reliabilityOf: the window, per node; could-not-look is null with the reason, never a pass', () => {
	const old = rows(ENOUGH, {
		endMs: NOW - RELIABILITY_WINDOW_MS - SAMPLE_MS,
		node: 'claw-a',
		down: span(0, 50),
	});
	const fresh = rows(ENOUGH, { node: 'claw-a' });
	const of = reliabilityOf({ rows: [...old, ...fresh], exists: true, unreadableLines: 0 }, NOW);
	assert.equal(of('claw-a').earn, true, 'an outage past the window has aged out');
	assert.equal(of('claw-new').earn, null);

	assert.match(reliabilityOf({ error: 'EACCES' }, NOW)('claw-a').why, /unreadable: EACCES/);
	assert.equal(reliabilityOf({ rows: [], exists: false }, NOW)('claw-a').keep, null);
	assert.ok(EARN.downMin < KEEP.downMin && EARN.outages < KEEP.outages, 'EARN is the stricter bar');
});
