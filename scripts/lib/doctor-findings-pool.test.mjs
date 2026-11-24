/**
 * The storage pool's findings (#138), against typed fixtures: the shape
 * garage-admin.mjs's garageState hands over (#141).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { poolFindings, poolSummary, POOL_COPIES, withRootZones } from './doctor-findings-pool.mjs';
import { ADVISORY } from './preflight.mjs';

const TB = 1e12;
const member = (node, capTb, usedTb, extra = {}) => ({
	node,
	zone: node,
	up: true,
	capacityBytes: capTb * TB,
	usedBytes: usedTb * TB,
	...extra,
});
/** Four 1 TB members, 3 copies, 0.6 TB stored per member: healthy and N+1. */
const healthy = () => ({
	members: ['claw-4', 'claw-8', 'claw-9', 'claw-10'],
	garage: {
		replicationFactor: 3,
		nodes: ['claw-4', 'claw-8', 'claw-9', 'claw-10'].map((n) => member(n, 1, 0.6)),
		underReplicatedBlocks: 0,
		at: new Date().toISOString(),
	},
	why: null,
});
const statuses = (fs) => fs.map((x) => `${x.category}/${x.status}`);

void test('no node offers storage: no pool, and no finding', () => {
	const input = { members: [], garage: null, why: 'nothing reads it' };
	assert.equal(poolSummary(input).state, 'none');
	assert.deepEqual(poolFindings(input), []);
});

void test('members with no Garage state read: one unread finding naming them', () => {
	const input = { members: ['claw-9', 'claw-4'], garage: null, why: 'no reader yet' };
	const s = poolSummary(input);
	assert.equal(s.state, 'unread');
	assert.deepEqual(s.members, ['claw-4', 'claw-9']);
	const fs = poolFindings(input);
	assert.deepEqual(statuses(fs), ['pool-copies/unread']);
	assert.match(fs[0].why, /claw-4, claw-9.*no reader yet/);
});

void test('a healthy four-member pool has no finding', () => {
	assert.equal(POOL_COPIES, 3);
	assert.equal(poolSummary(healthy()).state, 'read');
	assert.deepEqual(poolFindings(healthy()), []);
});

void test('copies: a factor under 3, and blocks under their target', () => {
	const p = healthy();
	p.garage.replicationFactor = 2;
	p.garage.underReplicatedBlocks = 1200;
	assert.deepEqual(statuses(poolFindings(p)), [
		'pool-copies/factor-below-3',
		'pool-copies/under-replicated',
	]);
	p.garage.replicationFactor = null;
	p.garage.underReplicatedBlocks = null;
	assert.deepEqual(statuses(poolFindings(p)), ['pool-copies/unreadable', 'pool-copies/unreadable']);
});

void test('fill: tight at 75%, full at 85%, unreadable with no reading', () => {
	const p = healthy();
	p.garage.nodes[0].usedBytes = 0.8 * TB;
	p.garage.nodes[1].usedBytes = 0.9 * TB;
	const fill = poolFindings(p).filter((x) => x.category === 'pool-fill');
	assert.deepEqual(statuses(fill), ['pool-fill/tight', 'pool-fill/full']);
	assert.deepEqual(
		fill.map((x) => x.node),
		['claw-4', 'claw-8']
	);
	p.garage.nodes[2].capacityBytes = null;
	assert.ok(statuses(poolFindings(p)).includes('pool-fill/unreadable'));
	assert.ok(
		statuses(poolFindings(p)).includes('pool-n-plus-1/unreadable'),
		'N+1 refuses to sum a null'
	);
});

void test('membership: a member down, and a storage node missing from the layout', () => {
	const p = healthy();
	p.garage.nodes[3].up = false;
	p.members.push('claw-1');
	assert.deepEqual(statuses(poolFindings(p)), ['pool-node/not-in-layout', 'pool-node/down']);
});

void test('N+1: three zones for three copies has no spare', () => {
	const p = healthy();
	p.garage.nodes.pop();
	p.members.pop();
	// 1.8 TB stored fits the 2 TB left after one goes; the zones are what is short.
	assert.deepEqual(statuses(poolFindings(p)), ['pool-n-plus-1/no-spare-zone']);
});

void test('N+1: everything stored must fit once the biggest member is gone', () => {
	const p = healthy();
	// 4 TB + three 1 TB, 2.4 TB stored: losing the 4 TB leaves 3 TB, fits.
	p.garage.nodes[0] = member('claw-4', 4, 0.6);
	assert.deepEqual(poolFindings(p), []);
	// 3.3 TB stored against the same 3 TB: does not.
	p.garage.nodes[0].usedBytes = 1.5 * TB;
	assert.deepEqual(statuses(poolFindings(p)), ['pool-n-plus-1/no-headroom']);
});

void test('every pool finding is advisory and shadow', () => {
	const p = healthy();
	p.garage.replicationFactor = 2;
	p.garage.nodes[0].up = false;
	p.garage.nodes[1].usedBytes = 0.99 * TB;
	const fs = poolFindings(p);
	assert.ok(fs.length >= 3);
	for (const x of fs) {
		assert.equal(x.class, ADVISORY);
		assert.equal(x.shadow, true);
	}
});

void test('#141: a root-disk zone is judged against its quota AND the 80% line of /', () => {
	const input = healthy();
	// claw-8: its quota 0.8 used (over 75%), and / at 70%; claw-9: quota fine, / at 85%.
	input.garage.nodes[1] = member('claw-8', 1, 0.8);
	input.garage = withRootZones(input.garage, {
		'claw-8': { sizeBytes: 2 * TB, availBytes: 0.6 * TB },
		'claw-9': { sizeBytes: 1 * TB, availBytes: 0.15 * TB },
	});
	const fill = poolFindings(input).filter((f) => f.category === 'pool-fill');
	assert.deepEqual(
		fill.map((f) => [f.node, f.status]),
		[
			['claw-8', 'tight'],
			['claw-9', 'root-over-ceiling'],
		]
	);
	assert.match(fill[0].why, /claw-8's root-disk quota is 80% used/);
	assert.match(fill[1].why, /claw-9's \/ is 85% used, over the 80% line/);
	assert.ok(fill.every((f) => f.class === ADVISORY && f.shadow));
});

void test('#141: a root-disk zone whose / was not read is unreadable, never fine', () => {
	const input = healthy();
	input.garage = withRootZones(input.garage, { 'claw-9': null });
	assert.ok(statuses(poolFindings(input)).includes('pool-fill/unreadable'));
	// Other members are not root zones and carry no rootFs.
	assert.equal(input.garage.nodes[0].rootFs, undefined);
	assert.equal(withRootZones(null, {}), null);
});
