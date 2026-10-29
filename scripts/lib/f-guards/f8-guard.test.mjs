/**
 * F8 (plan §4.1): `lib/argv.mjs` does not exist yet, so every script that
 * reads its own flags defines its own tiny `has`/`valueOf`/`flag` helper
 * (plus ~20 inline `indexOf` calls the plan counts separately — this guard
 * is scoped to the three HELPER shapes, not every ad hoc `argv.indexOf`,
 * because a helper definition is the thing F8 replaces and an inline
 * one-off `indexOf` has no single site to migrate).
 *
 * Each shape is narrow on purpose, so it does not also catch the many
 * UNRELATED local helpers that happen to share a name:
 *
 *   - `has`: `const has = (f) => args.includes(f)` (or `argv`/`ARGV`) — not
 *     `const has = (r, label) => ...` (operates on a record, not argv) and
 *     not `const has = new Set(...)`.
 *   - `valueOf`: `const`/`function valueOf` at all — rare enough as an
 *     identifier that a name match alone is safe (no caller in this repo
 *     calls the BUILT-IN `Object.prototype.valueOf` by that bare name).
 *   - `flag`: `function flag(name` / `const flag = (name` — not
 *     `const flag = r.drift ? 'DRIFT' : 'ok'` (a value, not a function).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tsAndMjsSources, lineOf, enclosingSymbol, assertDebt, loadDebt } from './lib.mjs';

const HAS = /\bconst\s+has\s*=\s*\([^)]*\)\s*=>\s*(?:args|argv|ARGV)\.includes\(/g;
const VALUE_OF = /\b(?:const|function)\s+valueOf\s*[=(]/g;
const FLAG = /\b(?:function\s+flag\s*\(\s*name\b|const\s+flag\s*=\s*\(\s*name\b)/g;

function find(pattern) {
	const out = [];
	for (const { rel, code } of tsAndMjsSources()) {
		let n = 0;
		for (const m of code.matchAll(pattern)) {
			n += 1;
			const sym = enclosingSymbol(code, m.index) ?? `line${lineOf(code, m.index)}`;
			out.push(`${rel}:${sym}#${n}`);
		}
	}
	return out;
}

const HINT =
	'Use the shared strict argv helper (F8, lib/argv.mjs) instead of a local has/valueOf/flag — ' +
	'strict argv means an unknown flag is an error and --help is answered before any side effect.';

void test('F8: a local has(f) argv helper is defined only where debt.json says so', () => {
	assertDebt(assert, loadDebt(), 'F8-has', find(HAS), HINT);
});

void test('F8: a local valueOf argv helper is defined only where debt.json says so', () => {
	assertDebt(assert, loadDebt(), 'F8-valueOf', find(VALUE_OF), HINT);
});

void test('F8: a local flag(name) argv helper is defined only where debt.json says so', () => {
	assertDebt(assert, loadDebt(), 'F8-flag', find(FLAG), HINT);
});

void test('F8: the guard sees the shapes it forbids and not their look-alikes', () => {
	assert.equal([...`const has = (f) => args.includes(f);`.matchAll(HAS)].length, 1);
	assert.equal([...`const has = (r, label) => r.labels.includes(label);`.matchAll(HAS)].length, 0);
	assert.equal([...`const has = new Set(lower(r.labels));`.matchAll(HAS)].length, 0);
	assert.equal([...`const valueOf = (f) => { };`.matchAll(VALUE_OF)].length, 1);
	assert.equal([...`function flag(name, fallback = null) { }`.matchAll(FLAG)].length, 1);
	assert.equal([...`const flag = r.drift ? 'DRIFT' : 'ok';`.matchAll(FLAG)].length, 0);
});
