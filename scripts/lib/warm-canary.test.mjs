import { test } from 'node:test';
import assert from 'node:assert/strict';

import { warmCanaryVerdict, slowTierCandidates } from './warm-canary.mjs';
import { warmCacheEligible, warmEligibleSlots } from '../../dist/runners/ephemeral.js';

// The REAL threshold, from the build — a local copy of the arithmetic is a
// second implementation that the predicate can change under without this file
// noticing, which is the drift the injection exists to prevent.
const fns = { warmEligibleSlots, warmCacheEligible };

// claw-3's measured shape: 15918 MB, minFree 2048, jobP95Mb 3400.
const eligible = (node, activeRepo = null) => ({
	node,
	reachable: true,
	totalMb: 15_918,
	minFreeMb: 2048,
	jobMb: 3400,
	role: 'claw',
	activeRepo,
});

// claw-2's measured shape: 7872 MB, minFree 1536 -> usable 6336, a 3168 MB
// JIT half that holds less than one 3400 MB mint.
const ineligible = (node) => ({
	node,
	reachable: true,
	totalMb: 7872,
	minFreeMb: 1536,
	jobMb: 3400,
	role: 'claw',
	activeRepo: null,
});

const unreachable = (node) => ({
	node,
	reachable: false,
	totalMb: null,
	minFreeMb: 1536,
	jobMb: 0,
	activeRepo: null,
});

test('no candidate nodes at all — fails, names why', () => {
	const v = warmCanaryVerdict([], fns);
	assert.equal(v.ok, false);
	assert.match(v.reason, /no candidate node/);
});

test('every candidate unreachable — "could not look", never a pass', () => {
	const v = warmCanaryVerdict([unreachable('claw-1'), unreachable('claw-3')], fns);
	assert.equal(v.ok, false);
	assert.match(v.reason, /could not reach any candidate node/);
	assert.deepEqual(v.unreachable, ['claw-1', 'claw-3']);
});

test('measured, but none has enough capacity — fails, distinct reason', () => {
	const v = warmCanaryVerdict([ineligible('claw-2'), ineligible('claw-6')], fns);
	assert.equal(v.ok, false);
	assert.match(v.reason, /room for a busy warm listener beside the 50% mint reserve/);
	assert.deepEqual(v.eligible, []);
});

test('eligible nodes exist, but none holds a warm listener — the issue #7 shape', () => {
	const v = warmCanaryVerdict([eligible('claw-1'), eligible('claw-3')], fns);
	assert.equal(v.ok, false);
	assert.match(v.reason, /2 of 2 eligible node\(s\) not holding a warm listener/);
	assert.deepEqual(v.eligible.sort(), ['claw-1', 'claw-3']);
	assert.deepEqual(v.warm, []);
});

test('one of two eligible nodes holds a listener — fails, PER ELIGIBLE NODE (issue #17)', () => {
	// The exact shape that stayed green for six hours: 5 eligible, 1 warm. The
	// criterion is per eligible node, not "at least one" — see warm-canary.mjs.
	const v = warmCanaryVerdict([eligible('claw-1', 'WolffM/hadoku_site'), eligible('claw-3')], fns);
	assert.equal(v.ok, false);
	assert.match(v.reason, /1 of 2 eligible node\(s\) not holding a warm listener: claw-3/);
	assert.deepEqual(v.warm, [{ node: 'claw-1', repo: 'WolffM/hadoku_site' }]);
});

test('every eligible node holds a listener — passes', () => {
	const v = warmCanaryVerdict(
		[eligible('claw-1', 'WolffM/hadoku_site'), eligible('claw-3', 'WolffM/hadoku_site')],
		fns
	);
	assert.equal(v.ok, true);
	assert.equal(v.reason, null);
	assert.deepEqual(
		v.warm.sort((a, b) => a.node.localeCompare(b.node)),
		[
			{ node: 'claw-1', repo: 'WolffM/hadoku_site' },
			{ node: 'claw-3', repo: 'WolffM/hadoku_site' },
		]
	);
});

test('an ineligible node holding a listener would be a different bug, and does not count', () => {
	// Cannot actually happen once the dispatcher enforces eligibility before
	// filling, but this canary must not be fooled by one that has drifted:
	// an ineligible node's `activeRepo` is never consulted.
	const v = warmCanaryVerdict([{ ...ineligible('claw-2'), activeRepo: 'WolffM/hadoku_site' }], fns);
	assert.equal(v.ok, false);
	assert.match(v.reason, /room for a busy warm listener beside the 50% mint reserve/);
});

test('an unreachable node alongside a fully-warm fleet still fails — "could not look" is not a pass', () => {
	// The trap named in the handoff: losing a node (drained, unreachable, a
	// bad memory read) must never turn a red gate green. Even though the one
	// REACHABLE eligible node is warm, this run cannot vouch for claw-4, so it
	// must not report the same confidence a full measurement would.
	const v = warmCanaryVerdict(
		[eligible('claw-1', 'WolffM/hadoku_site'), unreachable('claw-4')],
		fns
	);
	assert.equal(v.ok, false);
	assert.match(v.reason, /1 candidate node\(s\) unreachable \(claw-4\)/);
	assert.deepEqual(v.unreachable, ['claw-4']);
	// Still reported, for a human reading the failure — just not load-bearing
	// for `ok`.
	assert.deepEqual(v.warm, [{ node: 'claw-1', repo: 'WolffM/hadoku_site' }]);
});

test('an unreachable node dropping a fleet from 2-of-2 warm to 1-of-1 must not read as healthier', () => {
	// Same trap, sharper: if the unreachable node were silently excluded from
	// `eligible` (rather than failing the run outright), a fleet that just
	// lost visibility into one of its two warm nodes would report the SAME
	// verdict as a fleet that was always fully healthy with one node. That
	// collapse is exactly what must not happen.
	const allWarm = warmCanaryVerdict(
		[eligible('claw-1', 'WolffM/hadoku_site'), eligible('claw-3', 'WolffM/hadoku_site')],
		fns
	);
	const oneWentDark = warmCanaryVerdict(
		[eligible('claw-1', 'WolffM/hadoku_site'), unreachable('claw-3')],
		fns
	);
	assert.equal(allWarm.ok, true);
	assert.equal(oneWentDark.ok, false);
});

test('a NEWLY eligible node that is not holding a listener FAILS — the denominator never widens into a pass', () => {
	// The shape that the 4 GB-slot rule excluded and the mint-unit rule admits:
	// a ~10 GB box (usable 7000 MB, floor(7000/4096) = 1 old slot) whose jobs
	// measure 3400 MB — its 3500 MB JIT half holds a full mint, so it may hold
	// a listener. Admitting it must add a node the gate DEMANDS a listener on,
	// not a node the warm ones get averaged against.
	const grown = { ...eligible('claw-7'), totalMb: 9048, minFreeMb: 2048, jobMb: 3400 };
	const v = warmCanaryVerdict([eligible('claw-1', 'WolffM/hadoku_site'), grown], fns);
	assert.equal(v.ok, false);
	assert.deepEqual(v.eligible, ['claw-1', 'claw-7']);
	assert.match(v.reason, /1 of 2 eligible node\(s\) not holding a warm listener: claw-7/);
});

test('a guest that reaches the canary is never eligible, whatever its memory', () => {
	// `selectNodes` skips guests before measuring; this is the second answer. A
	// 62 GB box passes any memory test, so a fleet of ONLY it must fail as
	// "nothing eligible", never pass on the guest's listener.
	const hokon = {
		...eligible('hokon', 'WolffM/hadoku_site'),
		totalMb: 63_402,
		minFreeMb: 8192,
		jobMb: 4096,
		role: 'guest',
	};
	const v = warmCanaryVerdict([hokon], fns);
	assert.equal(v.ok, false);
	assert.deepEqual(v.eligible, []);
});

// The slow tier never holds a warm listener (#83). The canary used to count
// claw-5 as eligible and fail because it was not warm, which is the warm path
// doing exactly what it was told (ci:audit-gates, 2026-10-06).
const fakeModel = (tiers) => () => ({
	tierOf: (n) => tiers[n] ?? 'unknown',
	describe: (n) => ({ p25: tiers[n] === 'slow' ? 2.04 : 0.8 }),
});

test('a slow-tier node is taken out of the canary candidates, with its p25', () => {
	const got = slowTierCandidates(
		[],
		['claw-4', 'claw-5', 'claw-8'],
		fakeModel({ 'claw-5': 'slow', 'claw-4': 'normal', 'claw-8': 'normal' }),
		0
	);
	assert.deepEqual(got, [{ node: 'claw-5', p25: 2.04 }]);
});

test('with no usable history no node is slow, so the canary stays strict', () => {
	assert.deepEqual(slowTierCandidates([], ['claw-4', 'claw-5'], fakeModel({}), 0), []);
});
