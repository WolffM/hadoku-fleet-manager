import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveClawState } from '../runners/claw-state.js';

const base = {
	fleetNodes: ['claw-2', 'claw-3'],
	ephemeral: new Set(['claw-3']),
	runners: [] as { name: string; status?: string; busy?: boolean; labelled?: boolean }[],
	nodeOf: (n: string) => (n.startsWith('jit-claw-3') ? 'claw-3' : n),
	isEligible: (r: { labelled?: boolean }) => r.labelled === true,
	probeFor: () => undefined as { reachable: boolean; sick?: boolean } | undefined,
};

test('an ephemeral node with NO probe yet is omitted, not called unreachable', () => {
	// The bug. Both loops start together, the health tick wins the race, and the
	// tier probe has not run — so every ephemeral node was stamped `unreachable`
	// on every restart and that verdict was served for a full 10-minute tick.
	// The panel showed `unreachable` beside `reachable: true` in one payload.
	const out = deriveClawState({ ...base, probeFor: () => undefined });
	assert.equal('claw-3' in out, false, 'no probe means no verdict — the key must be absent');
});

test('an ephemeral node PROBED and down is still unreachable', () => {
	// The other half: omitting must not swallow a real outage.
	const out = deriveClawState({ ...base, probeFor: () => ({ reachable: false }) });
	assert.equal(out['claw-3'], 'unreachable');
});

test('a probed, healthy ephemeral node is mintable', () => {
	const out = deriveClawState({ ...base, probeFor: () => ({ reachable: true }) });
	assert.equal(out['claw-3'], 'mintable');
});

test('a probed ephemeral node that reported sick says so', () => {
	const out = deriveClawState({ ...base, probeFor: () => ({ reachable: true, sick: true }) });
	assert.equal(out['claw-3'], 'sick');
});

test('a standing node with registrations that are ALL offline is offline', () => {
	// claw-4's state on 2026-09-02: registrations present, none connected.
	const out = deriveClawState({
		...base,
		runners: [
			{ name: 'claw-2', status: 'offline', labelled: true },
			{ name: 'claw-2', status: 'offline', labelled: true },
		],
	});
	assert.equal(out['claw-2'], 'offline');
});

test('a standing node with no registration at all is absent, not offline', () => {
	// Distinct states: `absent` means the reconciler never installed one, which is
	// a coverage question; `offline` means it did and the runner is not connected,
	// which is an incident.
	assert.equal(deriveClawState({ ...base, runners: [] })['claw-2'], 'absent');
});

test('online but unlabelled is demoted, which is the ladder working', () => {
	const out = deriveClawState({
		...base,
		runners: [{ name: 'claw-2', status: 'online', labelled: false }],
	});
	assert.equal(out['claw-2'], 'demoted');
});

test('online, labelled and all busy is busy; one idle makes it free', () => {
	const busy = deriveClawState({
		...base,
		runners: [{ name: 'claw-2', status: 'online', labelled: true, busy: true }],
	});
	assert.equal(busy['claw-2'], 'busy');
	const free = deriveClawState({
		...base,
		runners: [
			{ name: 'claw-2', status: 'online', labelled: true, busy: true },
			{ name: 'claw-2', status: 'online', labelled: true, busy: false },
		],
	});
	assert.equal(free['claw-2'], 'free');
});

test('a JIT runner name folds to its node rather than becoming its own', () => {
	// Without folding, a four-node fleet rendered 70 rows.
	const out = deriveClawState({
		...base,
		ephemeral: new Set(),
		fleetNodes: ['claw-3'],
		runners: [{ name: 'jit-claw-3-hadoku_site-j1-r2-3', status: 'online', labelled: true }],
	});
	assert.deepEqual(Object.keys(out), ['claw-3']);
});
