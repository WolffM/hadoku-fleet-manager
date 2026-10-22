/**
 * The guest role, as a predicate.
 *
 * Small surface, and every case here is one a gate acts on: a guest is skipped
 * by `converge-toolchain`, classed advisory by `preflight`/`doctor`, excluded
 * from bootcamp's proof pool, and dropped by the tier ladder before it writes.
 * The DEFAULT is what those four share, so it is asserted here rather than four
 * times over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NODE_ROLES, guestNodeNames, isGuestNode, nodeRole } from '../lib/node-role.js';

test('a declared guest is a guest, and a declared claw is a claw', () => {
	assert.equal(nodeRole({ role: 'guest' }), 'guest');
	assert.equal(nodeRole({ role: 'claw' }), 'claw');
	assert.equal(isGuestNode({ role: 'guest' }), true);
	assert.equal(isGuestNode({ role: 'claw' }), false);
});

test('ABSENCE reads as claw — the strict direction', () => {
	// A machine nobody classified gets the whole fleet chain rather than a silent
	// pass. The lenient default would be a box that opts out of convergence,
	// health findings and the required set because someone forgot a line of JSON.
	assert.equal(nodeRole({}), 'claw');
	assert.equal(nodeRole(null), 'claw');
	assert.equal(nodeRole(undefined), 'claw');
	assert.equal(isGuestNode({}), false);
});

test('a TYPO reads as claw too — a misspelling may not exempt a node', () => {
	// `check-capability-schema`'s `unknown-role` rule is what NAMES it; this is
	// what makes naming it safe, because the node stays in the chain meanwhile.
	assert.equal(nodeRole({ role: 'gest' }), 'claw');
	assert.equal(nodeRole({ role: 'GUEST' }), 'claw', 'and the value is case-sensitive');
	assert.equal(nodeRole({ role: true }), 'claw');
	assert.equal(nodeRole({ role: '' }), 'claw');
});

test('guestNodeNames picks exactly the guests out of a manifest', () => {
	const manifest = {
		machines: {
			'claw-1': { role: 'claw' },
			'claw-2': {},
			hokon: { role: 'guest' },
		},
	};
	assert.deepEqual([...guestNodeNames(manifest)], ['hokon']);
});

test('guestNodeNames on an unreadable manifest exempts NOBODY', () => {
	// The same direction `nodeRole` takes: a manifest that could not be read must
	// not silently declare the whole fleet out of scope.
	assert.equal(guestNodeNames(null).size, 0);
	assert.equal(guestNodeNames({}).size, 0);
	assert.equal(guestNodeNames({ machines: {} }).size, 0);
});

test('the vocabulary is exactly two roles', () => {
	// The schema gate prints this list in its refusal, so a third role added
	// without a reader would surface as a manifest the gate accepts and nothing
	// acts on.
	assert.deepEqual([...NODE_ROLES], ['claw', 'guest']);
});
