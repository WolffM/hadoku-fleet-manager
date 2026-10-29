/**
 * F3 (plan §4.1): no shared `writeJsonAtomic`/`readJsonState` exists yet, so
 * two shapes of copy are both debt today:
 *
 *   1. WRITE-THEN-RENAME COPIES: a file that already does the right thing
 *      (write a temp path, then rename it over the real one) but hand-rolls
 *      it instead of calling a shared helper — `writeFileSync` and
 *      `renameSync` close enough together to be the same operation.
 *   2. NOT ATOMIC AT ALL: a `writeFileSync`/`appendFileSync` with no
 *      `renameSync` NEAR IT, so that call writes (or appends to) the real
 *      path directly. A restart mid-write there can leave a truncated file
 *      — plan §4.1 calls this out by name for runner-health's alerts/
 *      snapshot state and job-history.
 *
 *      PER-CALL, not per-file: `job-history.ts` is the reason. It has a
 *      proper `renameSync`-backed `writeFileAtomic` for one write AND a bare
 *      `appendFileSync` straight to the live history file for another — a
 *      file-wide "does this file rename anywhere?" check would clear the
 *      unprotected append just because the file's OTHER write is safe. Each
 *      write call is judged by what is near IT.
 *
 * Proximity (same ~400 chars) is a proxy for "same function", cheap and good
 * enough for a debt list — a false pair would still name a real write/rename
 * site worth looking at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tsAndMjsSources, lineOf, enclosingSymbol, assertDebt, loadDebt } from './lib.mjs';

const WRITE = /\bwriteFileSync\(/g;
const APPEND = /\bappendFileSync\(/g;
const RENAME = /\brenameSync\(/;
const PROXIMITY = 400;

function findWriteThenRename() {
	const out = [];
	for (const { rel, code } of tsAndMjsSources()) {
		let n = 0;
		for (const m of code.matchAll(WRITE)) {
			const windowEnd = Math.min(code.length, m.index + PROXIMITY);
			if (RENAME.test(code.slice(m.index, windowEnd))) {
				n += 1;
				const sym = enclosingSymbol(code, m.index) ?? `line${lineOf(code, m.index)}`;
				out.push(`${rel}:${sym}#${n}`);
			}
		}
	}
	return out;
}

function findNonAtomic() {
	const out = [];
	for (const { rel, code } of tsAndMjsSources()) {
		let n = 0;
		for (const pattern of [WRITE, APPEND]) {
			for (const m of code.matchAll(pattern)) {
				const windowEnd = Math.min(code.length, m.index + PROXIMITY);
				if (RENAME.test(code.slice(m.index, windowEnd))) continue; // this CALL renames nearby
				n += 1;
				const sym = enclosingSymbol(code, m.index) ?? `line${lineOf(code, m.index)}`;
				out.push(`${rel}:${sym}#${n}`);
			}
		}
	}
	return out;
}

void test('F3: write-then-rename is hand-rolled only where debt.json says so', () => {
	assertDebt(
		assert,
		loadDebt(),
		'F3-write-then-rename',
		findWriteThenRename(),
		'Call the shared `writeJsonAtomic` (F3) instead of writing a temp path and renaming it ' +
			'by hand — fsync-before-rename and fsync-the-directory-after belong in one place.'
	);
});

void test('F3: a file with no renameSync at all is only non-atomic where debt.json says so', () => {
	assertDebt(
		assert,
		loadDebt(),
		'F3-non-atomic',
		findNonAtomic(),
		'This writeFileSync has no rename anywhere in its file, so a restart mid-write can leave ' +
			'a truncated or empty file where this code reads it back whole. Route it through the ' +
			'shared `writeJsonAtomic` (F3) rather than adding a bespoke temp-and-rename.'
	);
});

void test('F3: the guard sees the shapes it forbids', () => {
	assert.ok(RENAME.test('x; renameSync(a, b);'));
	assert.ok(WRITE.test('writeFileSync(a, b);'));
});
