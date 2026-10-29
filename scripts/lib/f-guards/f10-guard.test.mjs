/**
 * F10 (plan §4.1): small utilities duplicated across scripts — this guard
 * covers the two named in this lane's brief, `errText` and the raw ANSI
 * escape definitions; `shq`/`sleepSync`/`pm2 jlist`/`allowlist`/the worktree
 * switch are the rest of F10's list and are not pattern-detectable the same
 * mechanical way (several are call-site counts, not a helper DEFINITION), so
 * they stay out of this debt list rather than being approximated.
 *
 * errText's plan figure ("73 uses") is a CALL-SITE census across several
 * differently-named shapes (`errText`, `reasonOf`, inline `instanceof Error
 * ? …` expressions) done to size F10's overall scope. This guard enforces
 * something narrower and mechanically checkable: a DEFINITION literally
 * named `errText`, because that is the one name a `grep` for new copies can
 * reliably catch before they spread further under the same name.
 *
 * ANSI: a `const` assigned the raw escape literal `'\x1b['...` — one file
 * may define several (RESET, BOLD, …); this guard counts the FILE once via
 * its first such definition, since the duplication is "this file rolled its
 * own palette," not "this file has N constants."
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tsAndMjsSources, assertDebt, loadDebt } from './lib.mjs';

const ERR_TEXT = /\b(?:const|function)\s+errText\s*[=(]/;
const ANSI_LITERAL = /=\s*['"`]\\x1b\[/;

function findErrText() {
	const out = [];
	for (const { rel, code } of tsAndMjsSources()) {
		if (ERR_TEXT.test(code)) out.push(`${rel}:errText#1`);
	}
	return out;
}

function findAnsi() {
	const out = [];
	for (const { rel, code } of tsAndMjsSources()) {
		if (ANSI_LITERAL.test(code)) out.push(`${rel}:ansi-palette#1`);
	}
	return out;
}

void test('F10: errText is (re)defined only where debt.json says so', () => {
	assertDebt(
		assert,
		loadDebt(),
		'F10-errText',
		findErrText(),
		'Import the shared errText from F10 instead of redefining it locally.'
	);
});

void test('F10: a raw ANSI escape palette is defined only where debt.json says so', () => {
	assertDebt(
		assert,
		loadDebt(),
		'F10-ansi',
		findAnsi(),
		'Import the shared ANSI palette from F10 instead of rolling local \\x1b[ constants.'
	);
});

void test('F10: the guard sees the shapes it forbids', () => {
	assert.ok(ERR_TEXT.test('const errText = (e) => (e instanceof Error ? e.message : String(e));'));
	assert.ok(ANSI_LITERAL.test("const RESET = '\\x1b[0m';"));
	assert.ok(!ERR_TEXT.test('const reasonOf = (e) => String(e);'));
});
