/**
 * F13 (plan §4.1): one "hosted runner label" predicate does not exist yet.
 * `scripts/lib/demand-derive.mjs` exports `HOSTED_RE`, correctly reused by
 * `runs-on-demand.mjs` — but `runs-on-demand.mjs` then ALSO ORs in its own
 * extra inline regex, `src/label-floor.ts` re-declares its own `HOSTED_RE`
 * instead of importing the export, and `src/runner-health.ts` reimplements
 * the whole predicate as a separate `isHostedLabel` function.
 *
 * THE PATTERN: a regex literal that alternates all three hosted-OS prefixes
 * (`ubuntu`, `windows`, `macos`, in any order) — that three-way alternation
 * is the signature of "this is a hosted-label test," wherever it is spelled.
 * `demand-derive.mjs`'s own export is EXCLUDED from the debt list, not
 * because it is correct (it is only half-adopted — `label-floor.ts` should
 * import it and does not) but because a single source of truth has to live
 * SOMEWHERE, and F13's helper is the better successor to point migrations at
 * than asking every caller to duplicate `demand-derive.mjs` as well.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tsAndMjsSources, lineOf, enclosingSymbol, assertDebt, loadDebt } from './lib.mjs';

const CANONICAL = 'scripts/lib/demand-derive.mjs';

/** A regex literal naming all three hosted OS prefixes, in any order. */
const HOSTED_REGEX_LITERAL = /\/(?=[^/\n]*ubuntu)(?=[^/\n]*windows)(?=[^/\n]*macos)[^/\n]+\//gi;

function find() {
	const out = [];
	for (const { rel, code } of tsAndMjsSources()) {
		if (rel === CANONICAL) continue;
		let n = 0;
		for (const m of code.matchAll(HOSTED_REGEX_LITERAL)) {
			n += 1;
			const sym = enclosingSymbol(code, m.index) ?? `line${lineOf(code, m.index)}`;
			out.push(`${rel}:${sym}#${n}`);
		}
	}
	return out;
}

void test('F13: a hosted-label regex is defined only where debt.json says so', () => {
	assertDebt(
		assert,
		loadDebt(),
		'F13-hosted-label',
		find(),
		'Import HOSTED_RE from scripts/lib/demand-derive.mjs (or the F13 successor once it ships) ' +
			'instead of writing a new ubuntu|windows|macos regex.'
	);
});

void test('F13: the canonical export still exists', () => {
	const canonical = tsAndMjsSources().find((s) => s.rel === CANONICAL);
	assert.ok(canonical, `${CANONICAL} is missing — the guard's allowlist points at nothing`);
	assert.match(canonical.code, /export const HOSTED_RE\s*=/);
});

void test('F13: the guard sees the shape it forbids', () => {
	assert.equal(
		[...'/ubuntu-latest|ubuntu-\\d|windows-|macos-/'.matchAll(HOSTED_REGEX_LITERAL)].length,
		1
	);
	assert.equal([...'/ubuntu-\\d/'.matchAll(HOSTED_REGEX_LITERAL)].length, 0);
});
