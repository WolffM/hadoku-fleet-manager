/**
 * fleet-manager#58: a memory refusal splits its floor into the node's own and
 * the hosting hold-back, and the starved alert names the repos a node refused.
 *
 * claw-8 at 2026-11-05 16:52Z, from the issue: 8914MB free, a 4096MB reserve,
 * minFreeMb 2048 (fleet-runner-manifest.json), and two hosting slices holding
 * back 2850MB between them (cardtable 1314, watchparty 1536). The refusal was
 * right; the alert read "against a 4898MB floor" and the node looked broken.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { admitMint, type AdmissionInput } from '../runners/ephemeral-admission.js';
import {
	noteRefusedRuns,
	refusedRunsFor,
	REFUSED_RUN_TTL_MS,
	__resetRefusedRunsForTesting,
} from '../admission-verdict-store.js';

const CLAW8: AdmissionInput = {
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 3,
	freeMb: 8914,
	requiredMb: 4096,
	minFreeMb: 2048 + 1314 + 1536,
	heldForHosting: [
		{ tenant: 'cardtable', mb: 1314 },
		{ tenant: 'watchparty', mb: 1536 },
	],
};

beforeEach(() => __resetRefusedRunsForTesting());

void test("claw-8's refusal splits its 4898MB floor and says the hosting reserve did it", () => {
	assert.deepEqual(admitMint(CLAW8), {
		ok: false,
		reason:
			'memory: 8914MB free, this repo peaks at 4096MB, would leave 4818MB against a 4898MB floor ' +
			'(2048 node floor + 2850 held for hosting: cardtable 1314, watchparty 1536) — hosting reserve, not a fault',
	});
});

void test('a shortfall past the node floor itself splits the floor but does not call it hosting', () => {
	const r = admitMint({ ...CLAW8, freeMb: 5000 });
	assert.equal(
		r.reason,
		'memory: 5000MB free, this repo peaks at 4096MB, would leave 904MB against a 4898MB floor ' +
			'(2048 node floor + 2850 held for hosting: cardtable 1314, watchparty 1536)'
	);
});

void test('a node with no hold-back reads exactly as before', () => {
	const r = admitMint({ ...CLAW8, minFreeMb: 2048, heldForHosting: undefined, freeMb: 5000 });
	assert.equal(
		r.reason,
		'memory: 5000MB free, this repo peaks at 4096MB, would leave 904MB against a 2048MB floor'
	);
	// A tenant using all it was promised holds nothing back, and is not listed.
	const used = admitMint({
		...CLAW8,
		minFreeMb: 2048,
		heldForHosting: [{ tenant: 'cardtable', mb: 0 }],
		freeMb: 5000,
	});
	assert.equal(used.reason, r.reason);
});

void test('refused runs keep memory and space refusals only, newest first, and age out', () => {
	const t = 1_793_900_000_000;
	noteRefusedRuns(
		[
			{ node: 'claw-8', repo: 'WolffM/hadoku_site', runId: 1, reason: 'memory: older' },
			{
				node: 'claw-8',
				repo: 'WolffM/hadoku-cardtable',
				runId: 2,
				reason: 'at capacity: 3/3 in flight',
			},
			{
				node: 'claw-9',
				repo: 'WolffM/hadoku-cardtable',
				runId: 2,
				reason: 'space: /tmp has 300MB free',
			},
		],
		t
	);
	noteRefusedRuns(
		[{ node: 'claw-8', repo: 'WolffM/hadoku-cardtable', runId: 3, reason: 'memory: newer' }],
		t + 1000
	);
	assert.deepEqual(
		refusedRunsFor('claw-8', t + 1000).map((r) => [r.repo, r.runId, r.reason]),
		[
			['WolffM/hadoku-cardtable', 3, 'memory: newer'],
			['WolffM/hadoku_site', 1, 'memory: older'],
		]
	);
	assert.equal(refusedRunsFor('claw-9', t).length, 1);
	assert.deepEqual(
		refusedRunsFor('claw-8', t + REFUSED_RUN_TTL_MS + 500).map((r) => r.runId),
		[3],
		'the older refusal aged out'
	);
});
