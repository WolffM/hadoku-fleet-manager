import test from 'node:test';
import assert from 'node:assert/strict';

import { requiredIdentitySet } from '../lib/bootcamp-proof.js';

// ---------------------------------------------------------------------------
// requiredIdentitySet — hadoku-builder's required set, from ledger records
// ---------------------------------------------------------------------------

test('requiredIdentitySet unions capabilities across general-pool records only', () => {
	assert.deepEqual(
		[
			...requiredIdentitySet([
				{ fleetForm: true, selfHosted: true, hosted: false, capabilities: ['python-toolcache'] },
				{ fleetForm: true, selfHosted: true, hosted: false, capabilities: ['playwright'] },
				{ fleetForm: true, selfHosted: true, hosted: false, capabilities: ['python-toolcache'] },
			]),
		].sort(),
		['playwright', 'python-toolcache']
	);
});

test('requiredIdentitySet excludes hosted and non-fleet-form jobs', () => {
	// A repo must not raise the fleet-wide bar with a job no claw will ever run.
	assert.deepEqual(
		[
			...requiredIdentitySet([
				{ fleetForm: false, selfHosted: true, hosted: false, capabilities: ['docker'] },
				{ fleetForm: true, selfHosted: true, hosted: true, capabilities: ['ffmpeg'] },
				{ fleetForm: true, selfHosted: false, hosted: false, capabilities: ['playwright'] },
			]),
		],
		[]
	);
});

test('requiredIdentitySet on empty demand is the empty set', () => {
	assert.deepEqual([...requiredIdentitySet([])], []);
});

test(
	"jdk21 is absent from the general pool's required set even when a PINNED job demands it " +
		"(cardtable#5's own forge-e2e shape)",
	() => {
		// The exact shape the wave brief names: forge-e2e runs on
		// [self-hosted, pm2-host] — pinned to one machine, not the general pool
		// — so `fleetForm` is false and the row must never raise the floor.
		const pinnedForgeE2e = {
			fleetForm: false,
			selfHosted: true,
			hosted: false,
			capabilities: ['jdk21'],
		};
		assert.deepEqual([...requiredIdentitySet([pinnedForgeE2e])], []);
		// And if jdk21 ever DID appear in a general-pool row (it does not today —
		// no covered repo asks for it on fromJSON(vars.CI_RUNNER) — the union
		// still works exactly like every other capability; this is not a
		// jdk21-specific exemption inside requiredIdentitySet itself).
		const generalPoolRow = {
			fleetForm: true,
			selfHosted: true,
			hosted: false,
			capabilities: ['jdk21'],
		};
		assert.deepEqual([...requiredIdentitySet([generalPoolRow])], ['jdk21']);
	}
);
