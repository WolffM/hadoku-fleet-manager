/**
 * toolchain-deferral-streak: a node deferred four nights running pages; three
 * or fewer, or any run that actually reached a verdict, does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	DEFERRAL_STREAK_PAGE_AFTER,
	deferralStreakFindings,
	nextDeferralStreaks,
	readDeferralStreaks,
	writeDeferralStreaks,
} from './toolchain-deferral-streak.mjs';

function withDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), 'deferral-streak-'));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('a missing file reads as no streaks, not a throw', () => {
	withDir((dir) => {
		assert.deepEqual(readDeferralStreaks(join(dir, 'nope.json')), {});
	});
});

test('an unparseable or non-object file reads as no streaks', () => {
	withDir((dir) => {
		const p = join(dir, 's.json');
		writeFileSync(p, '{ not json');
		assert.deepEqual(readDeferralStreaks(p), {});
		writeFileSync(p, '[1,2,3]');
		assert.deepEqual(readDeferralStreaks(p), {});
		writeFileSync(p, 'null');
		assert.deepEqual(readDeferralStreaks(p), {});
	});
});

test('a non-numeric or negative entry is dropped, not propagated', () => {
	withDir((dir) => {
		const p = join(dir, 's.json');
		writeFileSync(p, JSON.stringify({ a: 'two', b: -1, c: 2 }));
		assert.deepEqual(readDeferralStreaks(p), { c: 2 });
	});
});

test('a deferred node EXTENDS its streak; any other status resets it', () => {
	const previous = { 'claw-a': 2, 'claw-b': 5, 'claw-c': 1 };
	const statuses = [
		{ node: 'claw-a', status: 'deferred' },
		{ node: 'claw-b', status: 'updated' }, // reset: the cycle reached it
		{ node: 'claw-c', status: 'current' }, // reset
		{ node: 'claw-d', status: 'deferred' }, // new
	];
	assert.deepEqual(nextDeferralStreaks(previous, statuses), { 'claw-a': 3, 'claw-d': 1 });
});

test('round trip: write then read gives back the same streaks', () => {
	withDir((dir) => {
		const p = join(dir, 's.json');
		const streaks = { 'claw-a': 4 };
		writeDeferralStreaks(streaks, p);
		assert.deepEqual(readDeferralStreaks(p), streaks);
	});
});

test('PAGE RULE: more than 3 nights in a row pages, named with the node', () => {
	const findings = deferralStreakFindings({ 'claw-a': 4, 'claw-b': 3, 'claw-c': 0 });
	assert.deepEqual(
		findings.map((f) => f.node),
		['claw-a']
	);
	assert.equal(findings[0].kind, 'deferral-streak');
	assert.match(findings[0].reason, /4 night/);
});

test('MUTATION: reverting the threshold check (always finding, or never) fails against this fixture', () => {
	const streaks = { exactly3: 3, four: 4, zero: 0 };

	// REVERTED to ">= pageAfter" (one off): exactly3 would wrongly page.
	const tooEager = Object.entries(streaks)
		.filter(([, n]) => n >= DEFERRAL_STREAK_PAGE_AFTER)
		.map(([node]) => node);
	assert.deepEqual(
		tooEager,
		['exactly3', 'four'],
		'sanity: the off-by-one variant would page on exactly3 too'
	);

	// RESTORED: the real function pages only past the threshold.
	const real = deferralStreakFindings(streaks).map((f) => f.node);
	assert.deepEqual(real, ['four'], 'exactly 3 must not page; only strictly more than 3 does');
});

test('DEFERRAL_STREAK_PAGE_AFTER is 3', () => {
	assert.equal(DEFERRAL_STREAK_PAGE_AFTER, 3);
});
