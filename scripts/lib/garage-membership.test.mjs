/**
 * The pool's one membership answer (#153): the zones garage-layout.json
 * declares, read by the gate, the doctor's pool reader and F4's `when` alike.
 * No node here carries an earned `storage` label, which is the live fleet:
 * capability-probe.sh answers `storage no` everywhere.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { GARAGE_LAYOUT_FILE, declaredMembers } from './garage-layout-declared.mjs';
import { judgePool } from './storage-pool-gate.mjs';
import { toolAppliesTo } from './toolchain-floor.mjs';

const ZONES = ['claw-fixture-a', 'claw-fixture-b', 'claw-fixture-c'];
const NO_STORAGE = { role: 'claw', labels: [], $capabilities: { earned: ['docker', 'rust'] } };
const TB = 1e12;
const NOW = new Date();

let dir;
let saved;
before(() => {
	dir = mkdtempSync(join(tmpdir(), 'garage-membership-'));
	const zones = Object.fromEntries(
		ZONES.map((n) => [
			n,
			{ state: 'active', disks: [{ serial: null, capacityBytes: TB, root: true }] },
		])
	);
	writeFileSync(join(dir, GARAGE_LAYOUT_FILE), JSON.stringify({ version: 1, zones }));
	saved = process.env.HADOKU_STATE_DIR;
	process.env.HADOKU_STATE_DIR = dir;
});
after(() => {
	if (saved === undefined) delete process.env.HADOKU_STATE_DIR;
	else process.env.HADOKU_STATE_DIR = saved;
	rmSync(dir, { recursive: true, force: true });
});

test('declared and running, no earned storage: the gate reads the pool, not "no pool"', () => {
	const { nodes: members, error } = declaredMembers();
	assert.equal(error, null);
	assert.deepEqual(members, ZONES);
	const garage = {
		replicationFactor: 3,
		nodes: members.map((node) => ({ node, zone: node, up: true, capacityBytes: TB, usedBytes: 0 })),
		underReplicatedBlocks: 0,
		at: NOW.toISOString(),
	};
	const v = judgePool({ members, membersWhy: error, garage, why: null }, null, NOW);
	assert.equal(v.state, 'read');
	assert.equal(v.ok, true);
	assert.deepEqual(v.members, ZONES);
	assert.doesNotMatch(v.summary, /no pool/);
});

test('a declared member down is seen: the 2-of-3 pool the label-keyed gate called green', () => {
	const { nodes: members } = declaredMembers();
	const garage = {
		replicationFactor: 3,
		nodes: members.map((node, i) => ({
			node,
			zone: node,
			up: i !== 0,
			capacityBytes: TB,
			usedBytes: 0,
		})),
		underReplicatedBlocks: 0,
		at: NOW.toISOString(),
	};
	const v = judgePool({ members, garage, why: null }, null, NOW);
	assert.deepEqual(
		v.warnings.map((w) => `${w.node} ${w.kind}`),
		['claw-fixture-a pool-node/down']
	);
});

test("F4's when: Garage applies to a declared zone with no storage label, and nowhere else", () => {
	for (const n of ZONES) assert.equal(toolAppliesTo('garage', NO_STORAGE, n), true, n);
	assert.equal(toolAppliesTo('garage', NO_STORAGE, 'claw-fixture-z'), false);
	assert.equal(toolAppliesTo('garage', NO_STORAGE), false);
});

test('a declaration nobody could read fails the gate; it is never "no pool"', () => {
	writeFileSync(join(dir, GARAGE_LAYOUT_FILE), '{ not json');
	try {
		const { nodes: members, error } = declaredMembers();
		const v = judgePool({ members, membersWhy: error, garage: null, why: null }, null, NOW);
		assert.equal(v.ok, false);
		assert.equal(v.state, 'unread');
		assert.match(v.why, /is unreadable/);
	} finally {
		const zones = Object.fromEntries(ZONES.map((n) => [n, { state: 'active', disks: [] }]));
		writeFileSync(join(dir, GARAGE_LAYOUT_FILE), JSON.stringify({ version: 1, zones }));
	}
});
