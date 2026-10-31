// warm-orphan-doc.test.mjs — wave 5j lane B. `reconcile-runner-identity.mjs`
// reaches real nodes over ssh and `gh api` and has no hermetic CLI-level
// fixture that fails the SECOND look at a node while the first one succeeds
// (see that file's own header, and `warm-orphan-doc.mjs`'s, pulled out for
// the identical reason `throttle-drift-doc.mjs` was) — so this file drives
// `warmOrphanUnreadable` directly, as a pure function, over the REAL strings
// `reconcile-runner-identity.mjs` actually produces for each of its three
// `warmOrphans` shapes.
//
// "I could not look" (the second look's own probe or re-read never
// completed) must read `true`; everything the second look actually RESOLVED
// must read `false` — the same rule every other migrated gate's GateDoc
// tests pin.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { warmOrphanUnreadable } from './warm-orphan-doc.mjs';

test('a second look whose own probe never completed is unreadable', () => {
	const why =
		'second look at fx-claw-1 failed: ssh: connect to host fx-claw-1 port 22: No route to host';
	assert.equal(warmOrphanUnreadable(why), true);
});

test('a second look whose follow-up gh re-read never completed is unreadable', () => {
	const why =
		'no unit on fx-claw-1; re-reading the registration failed: ' +
		'gh: HTTP 502: Bad gateway (attempt 2/2)';
	assert.equal(warmOrphanUnreadable(why), true);
});

test('a registration naming no manifest node is NOT unreadable — nothing was left to probe', () => {
	assert.equal(warmOrphanUnreadable('names no manifest node, so no unit can back it'), false);
});

test('both looks completed and found no active unit is NOT unreadable — a real conclusion', () => {
	assert.equal(warmOrphanUnreadable('no active unit on fx-claw-1 on either look'), false);
});
