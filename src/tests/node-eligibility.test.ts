import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeFailsBootcamp } from '../runners/node-eligibility.js';

// --- nodeFailsBootcamp: the required set, and the three states that refuse ---
//
// The label rule adopted `provesRequiredSet` in wave 3c §G. `REQUIRED` is the bar
// every case below is judged against; it is passed EXPLICITLY so no test here
// depends on whether the operator's real demand ledger happens to exist.

/** The demand-derived bar. Two ids is enough for "prove all of them". */
const REQUIRED = new Set(['python-toolcache', 'gh']);

/** A node bootcamp probed cleanly, proving the whole required set. */
const provenNode = () => ({
	$capabilities: {
		blocked: [],
		unprobed: [],
		// `earned` is load-bearing, not decoration: `provenCapabilities` returns
		// `null` when it is not an array, which `provesRequiredSet` reads as
		// "nothing has looked".
		earned: [],
		prereqs: [{ id: 'python-toolcache' }, { id: 'gh' }],
	},
});

test('nodeFailsBootcamp: no recorded finding fails OPEN — never probed is not proven bad', () => {
	assert.equal(nodeFailsBootcamp('claw-1', { machines: { 'claw-1': {} } }, REQUIRED), false);
	assert.equal(nodeFailsBootcamp('claw-9', { machines: {} }, REQUIRED), false);
	assert.equal(nodeFailsBootcamp('claw-1', null, REQUIRED), false);
});

test('nodeFailsBootcamp: a clean finding proving the required set passes', () => {
	assert.equal(
		nodeFailsBootcamp('claw-1', { machines: { 'claw-1': provenNode() } }, REQUIRED),
		false
	);
});

test('nodeFailsBootcamp: MUTATION — removing one capability from the proof fails it', () => {
	// The fixture starts clean, then loses exactly one proof — python-toolcache
	// stops passing — which is the mutation item 4 of the handoff names.
	const clean = { machines: { 'claw-1': provenNode() } };
	assert.equal(nodeFailsBootcamp('claw-1', clean, REQUIRED), false);
	const mutated = {
		machines: {
			'claw-1': {
				$capabilities: {
					blocked: [{ id: 'python-toolcache', detail: 'not found' }],
					unprobed: [],
					earned: [],
					prereqs: [{ id: 'gh' }],
				},
			},
		},
	};
	assert.equal(nodeFailsBootcamp('claw-1', mutated, REQUIRED), true);
});

test('nodeFailsBootcamp: MUTATION — one node missing a capability moves ONLY that node', () => {
	// The third state of §G item 3, and the one that separates a per-node verdict
	// from a fleet-wide one. claw-2 is untouched by claw-1's gap.
	const fleet = {
		machines: {
			'claw-1': {
				$capabilities: { blocked: [], unprobed: [], earned: [], prereqs: [{ id: 'gh' }] },
			},
			'claw-2': provenNode(),
		},
	};
	assert.equal(nodeFailsBootcamp('claw-1', fleet, REQUIRED), true, 'the gap is claw-1s');
	assert.equal(nodeFailsBootcamp('claw-2', fleet, REQUIRED), false, 'and nobody elses');
});

test('nodeFailsBootcamp: an UNPROBED required capability also disqualifies', () => {
	// The manifest and capability-probe.sh disagree about what exists — not a
	// pass, and must not read as one.
	assert.equal(
		nodeFailsBootcamp(
			'claw-1',
			{
				machines: {
					'claw-1': {
						$capabilities: {
							blocked: [],
							unprobed: ['gh'],
							earned: [],
							prereqs: [{ id: 'python-toolcache' }],
						},
					},
				},
			},
			REQUIRED
		),
		true
	);
});

test('nodeFailsBootcamp: an UNREADABLE required set moves NO label, fleet-wide', () => {
	// `null` is "I could not read the bar". Demoting here takes the whole fleet
	// down at once on one bad file — `provesRequiredSet`'s own header is explicit
	// that the flip is only safe once the set can be read reliably.
	// MUTATION: the node below is missing BOTH required capabilities and still
	// must not move, so a `null` silently coerced to an empty Set would fail this.
	const starved = {
		machines: {
			'claw-1': { $capabilities: { blocked: [], unprobed: [], earned: [], prereqs: [] } },
		},
	};
	assert.equal(nodeFailsBootcamp('claw-1', starved, null), false);
	assert.equal(nodeFailsBootcamp('claw-1', starved, REQUIRED), true, 'and the bar DOES bite');
});

test('nodeFailsBootcamp: an EMPTY required set moves NO label either', () => {
	// A ledger that parsed and asked for nothing. Every node clears a bar of
	// zero, so enforcing it would be a green fleet proving nothing (3a).
	//
	// THE FIXTURE CARRIES A BLOCKED CAPABILITY, and that is what makes this test
	// bite. `provesRequiredSet` reports `blocked`/`unprobed` as a failure
	// WHATEVER the bar is, so a node with an empty record would return the same
	// `false` with or without the guard and the mutation would survive —
	// measured: deleting the empty-set branch failed 0 of 119 tests against the
	// empty-record fixture this used to carry.
	const blocked = {
		machines: {
			'claw-1': {
				$capabilities: {
					blocked: [{ id: 'gh', detail: 'not found' }],
					unprobed: [],
					earned: [],
					prereqs: [],
				},
			},
		},
	};
	assert.equal(nodeFailsBootcamp('claw-1', blocked, new Set()), false);
	// MUTATION: the same node against a REAL bar is demoted, so the refusal is
	// the empty set's doing and not the fixture being harmless.
	assert.equal(nodeFailsBootcamp('claw-1', blocked, REQUIRED), true);
});

test('nodeFailsBootcamp: a GUEST is never judged by the fast loop, however bad its record', () => {
	// A guest lends the fleet a registration and is out of scope for bootcamp's
	// required set (operator, 2026-09-14). `planTierWrites` already drops it;
	// this is the second half of the same statement, so a resident-registration
	// caller cannot route around it.
	const guest = {
		machines: {
			hokon: {
				role: 'guest',
				$capabilities: { blocked: [{ id: 'gh' }], unprobed: ['python-toolcache'] },
			},
		},
	};
	assert.equal(nodeFailsBootcamp('hokon', guest, REQUIRED), false);
	// MUTATION: the same record on a CLAW fails, so this is the role and not the
	// fixture being harmless.
	const asClaw = { machines: { hokon: { ...guest.machines.hokon, role: 'claw' } } };
	assert.equal(nodeFailsBootcamp('hokon', asClaw, REQUIRED), true);
});
