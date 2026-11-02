/**
 * `job-history-stats.ts`'s own pure helpers: `median`/`percentile`'s edge
 * cases, and `nodeOf`'s runner-name-to-node attribution (an instance suffix
 * aggregates to its node, the longest prefix wins, and an unrecognised
 * runner keeps its own name). Split out of job-history.test.ts (wave 5o
 * lane B) — see `src/tests/helpers/job-history-rig.ts` for the shared
 * per-test temp history file this file's hook parity requires (these tests
 * do not read it themselves).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nodeOf } from '../runners/census.js';
import { median, percentile } from '../job-history-stats.js';
import { installJobHistoryRig } from './helpers/job-history-rig.js';

installJobHistoryRig();

const NODES = ['claw-1', 'claw-2', 'claw-3', 'hokon'];

// ── statistics ──────────────────────────────────────────────────────────────

test('median / percentile: empty input is null, not 0', () => {
	assert.equal(median([]), null);
	assert.equal(percentile([], 95), null);
});

test('median: odd and even lengths', () => {
	assert.equal(median([5, 1, 3]), 3);
	assert.equal(median([4, 1, 3, 2]), 3); // (2+3)/2 rounded
});

test('percentile: nearest-rank, clamped at both ends', () => {
	const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
	assert.equal(percentile(xs, 95), 10);
	assert.equal(percentile(xs, 50), 5);
	assert.equal(percentile(xs, 0), 1);
});

// ── node attribution ─────────────────────────────────────────────────────

test('nodeOf: an instance suffix aggregates to its node', () => {
	assert.equal(nodeOf('hokon-tenhands', NODES), 'hokon');
	assert.equal(nodeOf('hokon', NODES), 'hokon');
	assert.equal(nodeOf('claw-1', NODES), 'claw-1');
});

test('nodeOf: longest prefix wins, and an unknown runner keeps its own name', () => {
	// 'claw-1' must not swallow a hypothetical 'claw-10'.
	assert.equal(nodeOf('claw-10', [...NODES, 'claw-10']), 'claw-10');
	assert.equal(nodeOf('mystery-box', NODES), 'mystery-box');
});
