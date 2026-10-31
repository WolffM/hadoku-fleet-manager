/**
 * The backstop role, as a predicate.
 *
 * Small surface, and every case here is one a capacity reader acts on: the
 * backstop is left out of the census, the required set, routing rank and the
 * warm cache. The DEFAULT is what those share, so it is asserted here rather
 * than once per reader.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	BACKSTOP_MINT_MODE,
	LEGACY_BACKSTOP_ROLE,
	NODE_ROLES,
	backstopNodeNames,
	fleetHasSudo,
	hostsCiDocker,
	hostsPm2Services,
	isBackstopNode,
	mintsJitRunners,
	mintsOnDemand,
	nodeRole,
} from '../lib/node-role.js';

test('a declared backstop is a backstop, and a declared claw is a claw', () => {
	assert.equal(nodeRole({ role: 'backstop' }), 'backstop');
	assert.equal(nodeRole({ role: 'claw' }), 'claw');
	assert.equal(isBackstopNode({ role: 'backstop' }), true);
	assert.equal(isBackstopNode({ role: 'claw' }), false);
});

test('the legacy value still reads as backstop until the live manifest drops it', () => {
	assert.equal(LEGACY_BACKSTOP_ROLE, 'guest');
	assert.equal(nodeRole({ role: LEGACY_BACKSTOP_ROLE }), 'backstop');
	assert.equal(isBackstopNode({ role: LEGACY_BACKSTOP_ROLE }), true);
	assert.equal(mintsOnDemand({ role: LEGACY_BACKSTOP_ROLE, mint: BACKSTOP_MINT_MODE }), true);
});

test('ABSENCE reads as claw — the strict direction', () => {
	// A machine nobody classified stays capacity rather than silently leaving
	// the census, the required set and routing because someone forgot a line.
	assert.equal(nodeRole({}), 'claw');
	assert.equal(nodeRole(null), 'claw');
	assert.equal(nodeRole(undefined), 'claw');
	assert.equal(isBackstopNode({}), false);
});

test('a TYPO reads as claw too — a misspelling may not take a node out of capacity', () => {
	// `check-capability-schema`'s `unknown-role` rule is what NAMES it; this is
	// what makes naming it safe, because the node stays capacity meanwhile.
	assert.equal(nodeRole({ role: 'backstp' }), 'claw');
	assert.equal(nodeRole({ role: 'BACKSTOP' }), 'claw', 'and the value is case-sensitive');
	assert.equal(nodeRole({ role: true }), 'claw');
	assert.equal(nodeRole({ role: '' }), 'claw');
});

test('mint: on-demand means something only on a backstop', () => {
	assert.equal(mintsOnDemand({ role: 'backstop', mint: BACKSTOP_MINT_MODE }), true);
	assert.equal(mintsOnDemand({ role: 'backstop' }), false);
	assert.equal(mintsOnDemand({ role: 'claw', mint: BACKSTOP_MINT_MODE }), false);
	// The mint path itself: an ephemeral claw or an on-demand backstop.
	assert.equal(mintsJitRunners({ role: 'backstop', mint: BACKSTOP_MINT_MODE }), true);
	assert.equal(mintsJitRunners({ role: 'claw', ephemeral: true }), true);
	assert.equal(mintsJitRunners({ role: 'claw' }), false);
});

test('provisioning reads services and containers on the backstop like any claw', () => {
	assert.equal(hostsPm2Services({ role: 'backstop', services: 'pm2' } as object), true);
	assert.equal(hostsCiDocker({ role: 'backstop', containers: 'docker' } as object), true);
	assert.equal(hostsPm2Services({}), false);
	assert.equal(hostsCiDocker({}), false);
});

test('backstopNodeNames picks exactly the backstops out of a manifest', () => {
	const manifest = {
		machines: {
			'claw-1': { role: 'claw' },
			'claw-2': {},
			hokon: { role: 'backstop' },
		},
	};
	assert.deepEqual([...backstopNodeNames(manifest)], ['hokon']);
});

test('backstopNodeNames on an unreadable manifest takes NOBODY out of capacity', () => {
	// The same direction `nodeRole` takes: a manifest that could not be read must
	// not silently declare the whole fleet a backstop.
	assert.equal(backstopNodeNames(null).size, 0);
	assert.equal(backstopNodeNames({}).size, 0);
	assert.equal(backstopNodeNames({ machines: {} }).size, 0);
});

test('the vocabulary is exactly two roles', () => {
	// The schema gate prints this list in its refusal, so a third role added
	// without a reader would surface as a manifest the gate accepts and nothing
	// acts on.
	assert.deepEqual([...NODE_ROLES], ['claw', 'backstop']);
});

test('fleetHasSudo: the claws yes, the backstop no (its root work is the operator’s)', () => {
	assert.equal(fleetHasSudo({ role: 'claw' }), true);
	assert.equal(fleetHasSudo({}), true);
	assert.equal(fleetHasSudo({ role: 'backstop' }), false);
	assert.equal(fleetHasSudo({ role: 'guest' }), false);
});
