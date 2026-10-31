/**
 * F1 (plan §4.1): a typed `loadManifest` lives in `scripts/lib/fleet-exec.mjs`
 * (JS side) and nowhere else is allowed to re-open `fleet-runner-manifest.json`
 * raw. `scripts/` has its own raw readers that bypass `loadManifest` even
 * though it is one import away.
 *
 * SINCE WAVE 5C, `src/` has its own canonical too: `src/lib/manifest.ts`'s
 * `readManifestState`/`readFleetManifest`, the TS-side twin `loadManifest`
 * could not be (`tsconfig.json` sets no `allowJs`, so a `.mjs` is not
 * importable from `src/`). The four TS files that used to re-implement the
 * read (`fleet-loop.ts`, `node-shell.ts`, `routes/fleet.ts`, `runner-health.ts`)
 * import it instead.
 *
 * THE PATTERN: the literal filename `fleet-runner-manifest.json` appearing
 * anywhere in a non-test `.ts`/`.mjs` source file OTHER than the two files
 * that define `manifestPath`/`manifestFile`/`loadManifest` (JS) or
 * `readManifestState`/`readFleetManifest` (TS). Those are the only two places
 * the name is allowed to be spelled; everyone else should receive a manifest
 * object, not a filename.
 *
 * `runner-mem-report.py` is a 6th raw reader by the plan's count, but it is
 * Python: this guard reads `.ts`/`.mjs` only (the pattern it enforces — "call
 * the shared loader" — has no meaning for a language that cannot import it),
 * so that copy is named in the closing note, not in this debt list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tsAndMjsSources, lineOf, enclosingSymbol, assertDebt, loadDebt } from './lib.mjs';

/** The two files allowed to spell the manifest's filename — JS side, TS side. */
const CANONICAL = new Set(['scripts/lib/fleet-exec.mjs', 'src/lib/manifest.ts']);

const LITERAL = /['"`]fleet-runner-manifest\.json['"`]/g;

function find() {
	const out = [];
	for (const { rel, code } of tsAndMjsSources()) {
		if (CANONICAL.has(rel)) continue;
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
		'Import `loadManifest` from scripts/lib/fleet-exec.mjs, or (in src/) `readManifestState`/' +
			'`readFleetManifest` from src/lib/manifest.ts, instead of spelling the filename and ' +
			'parsing it yourself.'
	);
});

void test('F1: the canonical files still define the manifest filename', () => {
	for (const [rel, exportPattern] of [
		['scripts/lib/fleet-exec.mjs', /export function loadManifest\(/],
		['src/lib/manifest.ts', /export function readManifestState\(/],
	]) {
		const canonical = tsAndMjsSources().find((s) => s.rel === rel);
		assert.ok(canonical, `${rel} is missing — the guard's allowlist points at nothing`);
		assert.match(canonical.code, /fleet-runner-manifest\.json/);
		assert.match(canonical.code, exportPattern);
	}
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
