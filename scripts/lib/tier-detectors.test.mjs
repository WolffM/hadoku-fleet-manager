/**
 * #98 — the tier detectors, mutation-tested one source shape at a time.
 *
 * `tier-detectors.mjs` is a PUBLISHED subpath export (hadoku_site's
 * `check-tier-gating.mjs` imports it), so every case here goes through the
 * exported functions with their existing signatures and return shapes — the
 * API is the thing under test, not a private helper.
 *
 * Each "is caught" case below returned `[]` before #98. Each "is left alone"
 * case is the precision half: a widened rule that starts flagging complete,
 * correct code is a rule people learn to wave through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blankComments, findNonTopTierEquality, findStaleVocabularies } from './tier-detectors.mjs';

const lines = (hits) => hits.map((h) => h.line);

test('`in` with a SET literal is caught, as the tuple and list forms already were', () => {
	assert.deepEqual(lines(findNonTopTierEquality('if user.tier in {"service", "admin"}:\n')), [1]);
	assert.deepEqual(lines(findNonTopTierEquality('if user.tier in ("service", "admin"):\n')), [1]);
});

test('`[...].includes(tier)` naming a partial list is caught', () => {
	const src = "const ok = ['service', 'admin'].includes(auth.userType);\n";
	assert.deepEqual(lines(findNonTopTierEquality(src)), [1]);
});

test('`[...].includes(tier)` naming EVERY assignable tier is left alone', () => {
	const src =
		"const ok = ['guest', 'member', 'friend', 'service', 'wife', 'admin'].includes(auth.userType);\n";
	assert.deepEqual(findNonTopTierEquality(src), []);
});

test('a `switch (tier)` whose labels leave a tier out is caught, at the switch line', () => {
	const src = [
		'function gate(ctx) {',
		'  switch (ctx.tier) {',
		"    case 'service':",
		"    case 'admin':",
		'      return true;',
		'    default:',
		'      return false;',
		'  }',
		'}',
	].join('\n');
	const hits = findNonTopTierEquality(src);
	assert.deepEqual(lines(hits), [2]);
	assert.match(hits[0].text, /switch \(ctx\.tier\)/);
});

test('a `switch (tier)` labelling every assignable tier is a complete mapping, left alone', () => {
	const src = [
		'switch (auth.userType) {',
		"  case 'guest': return 1;",
		"  case 'member': return 2;",
		"  case 'friend': return 3;",
		"  case 'service': return 4;",
		"  case 'wife': return 5;",
		"  case 'admin': return 6;",
		'}',
	].join('\n');
	assert.deepEqual(findNonTopTierEquality(src), []);
});

test('a docstring on the SAME line as a gate no longer blanks the gate', () => {
	const src = 'if user.tier in ("service", "admin"): log("""denied""")\n';
	const text = blankComments(src, { python: true });
	assert.deepEqual(lines(findNonTopTierEquality(text)), [1]);
	assert.doesNotMatch(text, /denied/);
});

test('code after a closing docstring delimiter survives; the docstring itself does not', () => {
	const src = [
		'"""Records that tier in ("admin", "service") was FIXED.',
		'still prose: tier == "service"',
		'"""; ok = user.tier == "service"',
	].join('\n');
	const text = blankComments(src, { python: true });
	assert.equal(text.split('\n').length, 3, 'line numbers must stay true');
	assert.deepEqual(lines(findNonTopTierEquality(text)), [3]);
});

test('a \'\'\' inside a """ block is prose, not the end of it', () => {
	const src = ['"""Opens.', "it's ''' not a close", 'tier == "service" is prose', '"""'].join('\n');
	assert.deepEqual(findNonTopTierEquality(blankComments(src, { python: true })), []);
});

// `member`, the bottom of the ladder, joined ASSIGNABLE_TIERS weeks after it
// joined the platform. Every list written before it named the other four and
// read as complete, so a ladder without it was never flagged, and a floor set
// to `member` in such a copy ranked as public.
//
// The deliberately incomplete fixtures below are split with `+`, which is not
// vocabulary glue, so the fleet's scan of THIS file does not read them as
// ladders of its own.

test('a ladder naming every tier but member is an incomplete vocabulary', () => {
	const src =
		'const TIER_RANK = { public: 0, guest: 1, ' +
		'friend: 2, service: 3, ' +
		'wife: 4, admin: 5 };\n';
	const hits = findStaleVocabularies(src).map(({ line, found, missing }) => ({
		line,
		named: found.length,
		missing,
	}));
	assert.deepEqual(hits, [{ line: 1, named: 5, missing: ['member'] }]);
});

// `guest` went under `member` on 2026-11-18, and every ladder written before
// it reads as complete without it: the same hole `member` left.
test('a ladder naming every tier but guest is an incomplete vocabulary', () => {
	const src =
		'const TIER_RANK = { public: 0, member: 1, ' +
		'friend: 2, service: 3, ' +
		'wife: 4, admin: 5 };\n';
	const hits = findStaleVocabularies(src).map(({ line, found, missing }) => ({
		line,
		named: found.length,
		missing,
	}));
	assert.deepEqual(hits, [{ line: 1, named: 5, missing: ['guest'] }]);
});

test('the whole ladder, member included, is complete', () => {
	const src =
		'const TIER_RANK = { public: 0, guest: 1, member: 2, friend: 3, service: 4, wife: 5, admin: 6 };\n';
	assert.deepEqual(findStaleVocabularies(src), []);
	assert.deepEqual(
		findStaleVocabularies("TIERS = ('admin', 'wife', 'service', 'friend', 'member', 'guest')\n"),
		[]
	);
});

test('an exact match against member alone is left alone, as one against admin is', () => {
	// The fleet's verified-member checks ask "a self-signed-up account and nothing
	// more", which excludes every tier above member on purpose.
	assert.deepEqual(
		findNonTopTierEquality("if (auth.userType === 'member' && auth.verified) ok();\n"),
		[]
	);
	assert.deepEqual(findNonTopTierEquality("return ctx.tier !== 'member';\n"), []);
	assert.deepEqual(
		findNonTopTierEquality("const solo = ['member'].includes(auth.userType);\n"),
		[]
	);
	assert.deepEqual(findNonTopTierEquality("return ctx.tier === 'guest';\n"), []);
});

test('member alongside any other tier is still a partial allowlist', () => {
	assert.deepEqual(
		lines(findNonTopTierEquality("const ok = ['member', 'admin'].includes(auth.userType);\n")),
		[1]
	);
	assert.deepEqual(lines(findNonTopTierEquality('if user.tier in ("member", "friend"):\n')), [1]);
});

test('the four tiers above member, as an allowlist, are partial now', () => {
	// A friend-and-up list admits the right tiers today, but it is the shape that
	// went stale: write it as a rank check against the ladder.
	const src = "const ok = ['friend', 'service', " + "'wife', 'admin'].includes(auth.userType);\n";
	assert.deepEqual(lines(findNonTopTierEquality(src)), [1]);
});
