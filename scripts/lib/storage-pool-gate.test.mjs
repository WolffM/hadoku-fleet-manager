/**
 * The ci:storage-pool verdict (#142) over F3's findings, against typed
 * fixtures of the pool input the doctor's reader hands over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { POOL_FILL_ADVISORY_PCT, POOL_FILL_FULL_PCT } from './doctor-findings-pool.mjs';
import { UNDER_REPLICATED_PAGE_MS, judgePool } from './storage-pool-gate.mjs';

const TB = 1e12;
const NOW = new Date();
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const pool = (names, usedTb = 0.3) => ({
	members: [...names],
	garage: {
		replicationFactor: 3,
		nodes: names.map((node) => ({
			node,
			zone: node,
			up: true,
			capacityBytes: TB,
			usedBytes: usedTb * TB,
		})),
		underReplicatedBlocks: 0,
		at: NOW.toISOString(),
	},
	why: null,
	via: names[0],
});
const FOUR = ['claw-4', 'claw-8', 'claw-9', 'claw-10'];
const kinds = (list) => list.map((f) => `${f.node} ${f.kind}`);

void test('no zone declared: "no pool", ok, nothing read', () => {
	const v = judgePool({ members: [], garage: null, why: null }, null, NOW);
	assert.equal(v.ok, true);
	assert.equal(v.state, 'none');
	assert.match(v.summary, /^no pool/);
	assert.deepEqual([v.findings, v.warnings, v.known, v.unreadable], [[], [], [], []]);
});

void test('members nobody could read: not ok, unreadable, never green', () => {
	const v = judgePool({ members: ['claw-9'], garage: null, why: 'ssh refused' }, null, NOW);
	assert.equal(v.ok, false);
	assert.equal(v.unreadable.length, 1);
	assert.match(v.why, /ssh refused/);
});

void test('an unread pool whose every member is drained warns; one undrained member fails', () => {
	const input = { members: ['claw-4', 'claw-9'], garage: null, why: 'ssh refused' };
	const both = new Map([
		['claw-4', 'expected down: claw-4 drained for maintenance today'],
		['claw-9', 'expected down: claw-9 drained for maintenance today'],
	]);
	const v = judgePool(input, null, NOW, both);
	assert.equal(v.ok, true);
	assert.deepEqual(v.unreadable, []);
	assert.match(v.warnings[0].reason, /claw-9 drained for maintenance/);
	const one = new Map([['claw-4', 'expected down: claw-4 drained for maintenance today']]);
	assert.equal(judgePool(input, null, NOW, one).ok, false);
});

void test('a healthy four-zone pool is ok and quiet', () => {
	const v = judgePool(pool(FOUR), null, NOW);
	assert.equal(v.ok, true);
	assert.equal(v.state, 'read');
	assert.deepEqual([v.findings, v.warnings, v.known, v.unreadable], [[], [], [], []]);
	assert.equal(v.record.underReplicatedSince, null);
});

void test('the pilot: three zones for three copies is a known state, not a warning', () => {
	const v = judgePool(pool(FOUR.slice(0, 3)), null, NOW);
	assert.equal(v.ok, true);
	assert.deepEqual(v.warnings, []);
	assert.deepEqual(kinds(v.known), ['pool pool-n-plus-1/no-spare-zone']);
	// Full enough that N+1's room is gone too: still known at three zones.
	const tight = judgePool(pool(FOUR.slice(0, 3), 0.7), null, NOW);
	assert.deepEqual(kinds(tight.known), [
		'pool pool-n-plus-1/no-spare-zone',
		'pool pool-n-plus-1/no-headroom',
	]);
	assert.equal(tight.ok, true);
});

void test('fewer zones than copies pages', () => {
	const v = judgePool(pool(FOUR.slice(0, 2)), null, NOW);
	assert.equal(v.ok, false);
	assert.deepEqual(kinds(v.findings), ['pool pool-n-plus-1/no-spare-zone']);
});

void test('N+1 broken on four zones warns and stays ok', () => {
	// 4 x 0.8 TB stored against the 3 TB left once one member goes.
	const v = judgePool(pool(FOUR, 0.8), null, NOW);
	assert.equal(v.ok, true);
	assert.ok(kinds(v.warnings).includes('pool pool-n-plus-1/no-headroom'));
	assert.deepEqual(v.known, []);
});

void test("fill: F3's advisory line warns, its full line pages", () => {
	const p = pool(FOUR);
	p.garage.nodes[0].usedBytes = ((POOL_FILL_ADVISORY_PCT + 1) / 100) * TB;
	p.garage.nodes[1].usedBytes = ((POOL_FILL_FULL_PCT + 1) / 100) * TB;
	const v = judgePool(p, null, NOW);
	assert.equal(v.ok, false);
	assert.deepEqual(kinds(v.findings), ['claw-8 pool-fill/full']);
	assert.ok(kinds(v.warnings).includes('claw-4 pool-fill/tight'));
});

void test('under-replicated: warns from the first sighting, pages past 24 h, clears on zero', () => {
	const p = pool(FOUR);
	p.garage.underReplicatedBlocks = 12;
	const first = judgePool(p, null, NOW);
	assert.equal(first.ok, true);
	assert.deepEqual(kinds(first.warnings), ['pool pool-copies/under-replicated']);
	assert.equal(first.record.underReplicatedSince, NOW.toISOString());

	const day = judgePool(p, { underReplicatedSince: hoursAgo(23) }, NOW);
	assert.equal(day.ok, true, 'under 24 h is a warning');
	assert.equal(day.record.underReplicatedSince, hoursAgo(23), 'the first sighting is kept');

	const late = judgePool(p, { underReplicatedSince: hoursAgo(25) }, NOW);
	assert.equal(late.ok, false);
	assert.deepEqual(kinds(late.findings), ['pool pool-copies/under-replicated']);
	assert.match(late.findings[0].reason, /Short for 25 h/);
	assert.ok(25 * 3600_000 > UNDER_REPLICATED_PAGE_MS);

	p.garage.underReplicatedBlocks = 0;
	assert.equal(
		judgePool(p, { underReplicatedSince: hoursAgo(25) }, NOW).record.underReplicatedSince,
		null
	);
});

void test('an unread block count keeps the clock running and fails', () => {
	const p = pool(FOUR);
	p.garage.underReplicatedBlocks = null;
	const v = judgePool(p, { underReplicatedSince: hoursAgo(30) }, NOW);
	assert.equal(v.ok, false);
	assert.equal(v.record.underReplicatedSince, hoursAgo(30));
	assert.ok(v.unreadable.length >= 1);
});

void test('a factor under 3 pages; a member down warns', () => {
	const p = pool(FOUR);
	p.garage.replicationFactor = 2;
	p.garage.nodes[2].up = false;
	const v = judgePool(p, null, NOW);
	assert.deepEqual(kinds(v.findings), ['pool pool-copies/factor-below-3']);
	assert.ok(kinds(v.warnings).includes('claw-9 pool-node/down'));
});

void test("a root-disk zone's / over its ceiling warns; the doctor owns that line nightly", () => {
	const p = pool(FOUR);
	p.garage.nodes[1].rootFs = { sizeBytes: 100, availBytes: 10 };
	const v = judgePool(p, null, NOW);
	assert.equal(v.ok, true);
	assert.deepEqual(kinds(v.warnings), ['claw-8 pool-fill/root-over-ceiling']);
});
