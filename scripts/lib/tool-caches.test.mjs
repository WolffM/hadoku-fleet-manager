import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reclaimableCaches } from './tool-caches.mjs';

/** The live shape as of 2026-09-01: trunk serves vibecheck and watchparty. */
const CACHES = {
	trunk: { path: '~/.cache/trunk', repos: ['WolffM/vibecheck', 'WolffM/hadoku-watchparty'] },
	'ms-playwright': { path: '~/.cache/ms-playwright', repos: ['WolffM/hadoku_site'] },
	// Deliberately unowned — the pnpm store serves everything and belongs to no
	// single repo.
	pnpm: { path: '~/.cache/pnpm' },
};

const on = (map) => (node) => map[node] ?? [];

test('the claw-3 case: a cache whose repos all moved away is reclaimable', () => {
	// claw-3 excludes vibecheck and watchparty since the 2026-08-19 rebalance and
	// held 5.5 GB of their cache on 2026-09-01.
	const out = reclaimableCaches({
		node: 'claw-3',
		caches: CACHES,
		reposOn: on({ 'claw-3': ['WolffM/hadoku_site', 'WolffM/hadoku-meet'] }),
	});
	assert.deepEqual(
		out.map((c) => c.name),
		['trunk']
	);
	assert.match(out[0].reason, /serves none of its 2 declared repo/);
});

test('ONE surviving repo keeps the whole cache', () => {
	// Caches are shared per-tool and cannot be split per-repo, so the rule has to
	// be "any owner still here" rather than "most owners gone".
	const out = reclaimableCaches({
		node: 'claw-2',
		caches: CACHES,
		reposOn: on({ 'claw-2': ['WolffM/hadoku-watchparty'] }),
	});
	// Asserted on trunk specifically, NOT on an empty result: this node serves no
	// hadoku_site either, so ms-playwright is correctly reclaimable here and an
	// `assert.deepEqual(out, [])` would be testing the fixture rather than the rule.
	assert.equal(
		out.find((c) => c.name === 'trunk'),
		undefined,
		'watchparty alone is enough to keep trunk'
	);
});

test('an UNDECLARED cache is never reclaimed', () => {
	// The branch that stops this deleting the pnpm store on the busiest node in
	// the fleet. Silence means nobody has said what the cache is for, which is not
	// evidence that nothing needs it.
	const out = reclaimableCaches({
		node: 'claw-9',
		caches: CACHES,
		reposOn: on({ 'claw-9': [] }),
	});
	assert.equal(
		out.find((c) => c.name === 'pnpm'),
		undefined,
		'a cache with no declared owners must survive a node that serves nothing'
	);
});

test('a node serving nothing still only loses DECLARED caches', () => {
	const out = reclaimableCaches({
		node: 'claw-9',
		caches: CACHES,
		reposOn: on({ 'claw-9': [] }),
	});
	assert.deepEqual(
		out.map((c) => c.name),
		['ms-playwright', 'trunk'],
		'both owned caches go; the unowned one stays'
	);
});

test('no declarations at all reclaims nothing', () => {
	// The state every node is in before the manifest carries `toolCaches`. It must
	// be inert rather than maximally destructive.
	assert.deepEqual(reclaimableCaches({ node: 'claw-1', caches: {}, reposOn: () => [] }), []);
	assert.deepEqual(reclaimableCaches({ node: 'claw-1', caches: undefined, reposOn: () => [] }), []);
});

test('an empty repos LIST is treated as undeclared, not as "owned by nobody"', () => {
	// `repos: []` is the shape a half-finished manifest edit leaves behind, and
	// reading it as "no owner is still here, therefore reclaim" would delete a
	// cache on every node the moment someone started declaring it.
	const out = reclaimableCaches({
		node: 'claw-1',
		caches: { half: { path: '~/.cache/half', repos: [] } },
		reposOn: on({ 'claw-1': ['WolffM/hadoku_site'] }),
	});
	assert.deepEqual(out, []);
});

test('coverage comes from the caller, so a cache cannot disagree with an install', () => {
	// reposOn is injected rather than re-derived here: the reconciler already owns
	// "which repos does this node serve", and a second implementation of that
	// question is the P2 shape this fleet keeps hitting (five answers to
	// isLocalNode, ten copies of "not claw-3").
	let asked = null;
	reclaimableCaches({
		node: 'claw-7',
		caches: CACHES,
		reposOn: (n) => {
			asked = n;
			return [];
		},
	});
	assert.equal(asked, 'claw-7', 'the node under test is the node asked about');
});
