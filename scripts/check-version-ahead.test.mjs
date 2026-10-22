import test from 'node:test';
import assert from 'node:assert/strict';

import { isAhead } from './check-version-ahead.mjs';
import { classify } from './version-bump.mjs';

/**
 * The gate exists because the failure is SILENT: the commit is fine, the push
 * succeeds, and publish rejects the version afterwards — so a real fix sits in
 * git looking merged while production never receives it. That happened twice on
 * 2026-09-02/03 with two agents on one checkout.
 */
test('a version equal to the base is NOT ahead — that is the collision', () => {
	// The exact shape a rebase produces: both sides bumped to the same number
	// from the same parent, and the second one to land is already published.
	assert.equal(isAhead('0.21.75', '0.21.75'), false);
});

test('behind is not ahead', () => {
	assert.equal(isAhead('0.21.74', '0.21.75'), false);
});

test('a patch, minor or major step is ahead', () => {
	assert.equal(isAhead('0.21.76', '0.21.75'), true);
	assert.equal(isAhead('0.22.0', '0.21.99'), true);
	assert.equal(isAhead('1.0.0', '0.99.99'), true);
});

test('the rollover this package uses is ahead, not a numeric downgrade', () => {
	// nextVersion rolls .20 to the next minor, so the patch NUMBER decreases.
	// Comparing the strings, or the patch alone, would read that as going
	// backwards and block a legitimate release.
	assert.equal(isAhead('0.22.0', '0.21.20'), true);
});

test('the gate uses the SAME published-surface predicate as the bump hook', () => {
	// Three definitions of "what ships" would drift, and the one that drifts is
	// the one nobody reads. publish.yml diffs `package.json src scripts deploy`.
	assert.equal(classify(['src/runners/traffic.ts']), true);
	assert.equal(classify(['scripts/check-version-ahead.mjs']), true);
	assert.equal(classify(['docs/planning/handoff-2026-09-02.md']), false);
	assert.equal(classify(['README.md']), false);
});
