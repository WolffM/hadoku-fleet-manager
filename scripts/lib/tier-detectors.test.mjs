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

import { blankComments, findNonTopTierEquality } from './tier-detectors.mjs';

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
	const src = "const ok = ['friend', 'service', 'wife', 'admin'].includes(auth.userType);\n";
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
		"  case 'friend': return 1;",
		"  case 'service': return 2;",
		"  case 'wife': return 3;",
		"  case 'admin': return 4;",
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
