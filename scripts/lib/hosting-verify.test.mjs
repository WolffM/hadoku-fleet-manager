/**
 * Which slices the verifier re-asserts (fleet-manager#31). The rows are
 * `fleet hosting --check --json`'s, as `hosting.mjs` writes them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planVerify } from './hosting-verify.mjs';

const NOW = Date.parse('2026-10-31T18:00:00Z');
const row = (tenant, over = {}) => ({
	node: 'claw-4',
	mode: 'shared',
	declared: { tenant, memoryMb: 512, cores: 1, port: 9002 },
	until: null,
	state: 'not-guaranteed',
	findings: [{ class: 'blocking', category: 'hosting-files', why: '.npmrc is missing' }],
	...over,
});

test('a drifted home is re-asserted; a guaranteed slice is left alone', () => {
	const p = planVerify(
		[row('pygmalion'), row('archivebot', { state: 'guaranteed', findings: [] })],
		NOW
	);
	assert.deepEqual(p.repair, [
		{
			node: 'claw-4',
			tenant: 'pygmalion',
			facet: 'hosting:pygmalion',
			before: 'hosting-files: .npmrc is missing',
		},
	]);
	assert.deepEqual([p.unreadable, p.unrepairable, p.lapsed], [[], [], []]);
});

test('a node that did not answer is unreadable: never written to, never "fine"', () => {
	const p = planVerify(
		[
			row('cardtable', {
				findings: [{ class: 'blocking', category: 'hosting-unobserved', why: 'no answer' }],
			}),
		],
		NOW
	);
	assert.deepEqual(p.repair, []);
	assert.equal(p.unreadable[0].facet, 'hosting:cardtable');
});

test("an unregistered tenant cannot be re-deployed; a slice past its end is --remove's", () => {
	const p = planVerify(
		[
			row('ghost', {
				findings: [{ class: 'blocking', category: 'hosting-tenant', why: 'not registered' }],
			}),
			row('cardtable', { until: '2026-10-31T17:00:00Z' }),
		],
		NOW
	);
	assert.deepEqual(p.repair, []);
	assert.equal(p.unrepairable[0].tenant, 'ghost');
	assert.equal(p.lapsed[0].tenant, 'cardtable');
});

test('an advisory finding alone is not a repair: only the state decides', () => {
	const p = planVerify(
		[
			row('cardtable', {
				state: 'guaranteed',
				findings: [{ class: 'advisory', category: 'hosting-agent', why: 'not installed' }],
			}),
		],
		NOW
	);
	assert.deepEqual(p.repair, []);
});
