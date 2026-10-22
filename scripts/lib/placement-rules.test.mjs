import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mayRunRepo, reposOnNode } from './placement-rules.mjs';

/** claw-3's real shape: ephemeral, empty resident set, excludes watchparty. */
const M = {
	machines: {
		'claw-2': { labels: ['hadoku-builder'] },
		'claw-3': {
			labels: ['hadoku-builder'],
			ephemeral: true,
			residentRepos: [],
			excludeRepos: { 'WolffM/hadoku-watchparty': 'thermal rebalance 2026-08-19' },
		},
		hokon: { labels: ['pm2-host', 'taskauto'] },
		retired: { placement: 'excluded', labels: ['hadoku-builder'] },
	},
	repos: { 'WolffM/hadoku-tenhands': { needs: ['taskauto'] } },
};

test('an EPHEMERAL node may run a repo it holds no standing runner for', () => {
	// The whole reason this is split from the reconciler's placementFor. claw-3
	// has residentRepos: [] and mints for hadoku_site many times a day; asking
	// the placement question returns NO and would mark every cache on every
	// ephemeral node abandoned.
	assert.ok(mayRunRepo('WolffM/hadoku_site', M).includes('claw-3'));
});

test('excludeRepos still removes the node', () => {
	assert.ok(!mayRunRepo('WolffM/hadoku-watchparty', M).includes('claw-3'));
	assert.ok(mayRunRepo('WolffM/hadoku-watchparty', M).includes('claw-2'));
});

test('placement: excluded is honoured', () => {
	assert.ok(!mayRunRepo('WolffM/hadoku_site', M).includes('retired'));
});

test('a repo needing a label only reaches nodes carrying it', () => {
	const on = mayRunRepo('WolffM/hadoku-tenhands', M);
	assert.deepEqual(on, ['hokon'], `only hokon carries taskauto, got ${JSON.stringify(on)}`);
});

test('reposOnNode inverts the view without re-deriving the rules', () => {
	const repos = ['WolffM/hadoku_site', 'WolffM/hadoku-watchparty', 'WolffM/hadoku-tenhands'];
	assert.deepEqual(reposOnNode('claw-3', repos, M), ['WolffM/hadoku_site']);
	assert.deepEqual(reposOnNode('claw-2', repos, M), [
		'WolffM/hadoku_site',
		'WolffM/hadoku-watchparty',
	]);
});

test('a missing manifest yields no nodes rather than throwing', () => {
	// Callers read this from disk. An unreadable manifest must not crash the
	// cleanup pass it is only one report inside.
	assert.deepEqual(mayRunRepo('WolffM/x', undefined), []);
	assert.deepEqual(mayRunRepo('WolffM/x', {}), []);
	assert.deepEqual(reposOnNode('claw-1', undefined, {}), []);
});
