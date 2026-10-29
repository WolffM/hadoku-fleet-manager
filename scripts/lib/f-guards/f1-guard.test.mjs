/**
 * F1 (plan §4.1): a typed `loadManifest` lives in `scripts/lib/fleet-exec.mjs`
 * (JS side) and nowhere else is allowed to re-open `fleet-runner-manifest.json`
 * raw. `src/` has no JS-importable twin yet (tsconfig sets no `allowJs`), so
 * four TS files each re-implement the read; `scripts/` has its own raw
 * readers that bypass `loadManifest` even though it is one import away.
 *
 * THE PATTERN: the literal filename `fleet-runner-manifest.json` appearing
 * anywhere in a non-test `.ts`/`.mjs` source file OTHER than the file that
 * defines `manifestPath`/`manifestFile`/`loadManifest`. That file is the one
 * place the name is allowed to be spelled; everyone else should receive a
 * manifest object, not a filename.
 *
 * `runner-mem-report.py` is a 6th raw reader by the plan's count, but it is
 * Python: this guard reads `.ts`/`.mjs` only (the pattern it enforces — "call
 * the shared loader" — has no meaning for a language that cannot import it),
 * so that copy is named in the closing note, not in this debt list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tsAndMjsSources, lineOf, enclosingSymbol, assertDebt, loadDebt } from './lib.mjs';

/** The one file allowed to spell the manifest's filename. */
const CANONICAL = 'scripts/lib/fleet-exec.mjs';

const LITERAL = /['"`]fleet-runner-manifest\.json['"`]/g;

function find() {
	const out = [];
	for (const { rel, code } of tsAndMjsSources()) {
		if (rel === CANONICAL) continue;
		let n = 0;
		for (const m of code.matchAll(LITERAL)) {
			n += 1;
			const sym = enclosingSymbol(code, m.index) ?? `line${lineOf(code, m.index)}`;
			out.push(`${rel}:${sym}#${n}`);
		}
	}
	return out;
}

void test('F1: fleet-runner-manifest.json is read raw only where debt.json says so', () => {
	assertDebt(
		assert,
		loadDebt(),
		'F1',
		find(),
		'Import `loadManifest` from scripts/lib/fleet-exec.mjs (or, in src/, the equivalent once ' +
			'F1 lands a typed TS loader) instead of spelling the filename and parsing it yourself.'
	);
});

void test('F1: the canonical file still defines the manifest filename', () => {
	const canonical = tsAndMjsSources().find((s) => s.rel === CANONICAL);
	assert.ok(canonical, `${CANONICAL} is missing — the guard's allowlist points at nothing`);
	assert.match(canonical.code, /fleet-runner-manifest\.json/);
	assert.match(canonical.code, /export function loadManifest\(/);
});

void test('F1: the guard sees the shape it forbids', () => {
	assert.ok(
		[
			..."const x = JSON.parse(readFileSync(manifest('fleet-runner-manifest.json')));".matchAll(
				LITERAL
			),
		].length === 1
	);
});
