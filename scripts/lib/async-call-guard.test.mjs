/**
 * AN ASYNC EXPORT IS AWAITED IN `scripts/` TOO. `src/` is typed and its
 * floating promises are caught by the type-aware lint; `scripts/` is plain
 * `.mjs`, where calling an async function without `await` is silent and
 * wrong: `const w = writeFacet(...)` reads `w.ok` off a Promise as
 * `undefined`, and a write started before `process.exit` never lands. When
 * the state writers went async (fleet-manager#86), three test fixtures in
 * `bootcamp-prove.test.mjs` did exactly that and no tool said so.
 *
 * So every `.mjs` under `scripts/` and `herdr/` (tests included) that imports
 * a name from `dist/` which `src/` declares `async`, or declares returning a
 * `Promise`, must use each call: `await`, `return`, `void`, a `.then(` or
 * `.catch(` on it, or `Promise.all(`/`allSettled(` around it. The set of async
 * exports is read from `src/` every run, so a function turning async is seen
 * here without editing this file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT } from './f-guards/lib.mjs';

function walk(dir, out = []) {
	for (const n of readdirSync(dir)) {
		if (n === 'node_modules' || n.startsWith('.')) continue;
		const p = join(dir, n);
		if (statSync(p).isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

/** Names `src/` exports as async or Promise-returning, by module path under dist. */
export function asyncExports(files) {
	const byModule = new Map();
	const decl =
		/export\s+(?:async\s+function\s+([A-Za-z_$][\w$]*)|function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*:\s*Promise<)/g;
	for (const { rel, code } of files) {
		const names = new Set();
		for (const m of code.matchAll(decl)) names.add(m[1] ?? m[2]);
		if (names.size) byModule.set(rel.replace(/^src\//, '').replace(/\.ts$/, '.js'), names);
	}
	return byModule;
}

/** `file: line: name(` for each call of an imported async export that nothing uses. */
export function unusedAsyncCalls(scripts, byModule) {
	const out = [];
	const imp = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]*\/dist\/([^'"]+))['"]/g;
	for (const { rel, code } of scripts) {
		const names = new Set();
		for (const m of code.matchAll(imp)) {
			const exported = byModule.get(m[3]);
			if (!exported) continue;
			for (const spec of m[1].split(',')) {
				const [name, local] = spec.trim().split(/\s+as\s+/);
				if (exported.has(name)) names.add((local ?? name).trim());
			}
		}
		for (const name of names) {
			const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\(`, 'g');
			for (const m of code.matchAll(call)) {
				const before = code.slice(Math.max(0, m.index - 40), m.index);
				if (
					/(?:\bawait|\breturn|\bvoid|\bPromise\.(?:all|allSettled|race|any)\(\s*\[?)\s*\(?\s*$/.test(
						before
					)
				)
					continue;
				if (/\bfunction\s+$/.test(before)) continue; // its own definition, re-declared locally
				// A call whose result is chained: name(...).then( / .catch(
				let depth = 0;
				let i = m.index + m[0].length - 1;
				for (; i < code.length; i++) {
					if (code[i] === '(') depth++;
					else if (code[i] === ')' && --depth === 0) break;
				}
				if (/^\s*\.(?:then|catch|finally)\(/.test(code.slice(i + 1, i + 40))) continue;
				// Handed on as a value (`x = name(...)` then `await x`) is not judged here:
				// the next line awaiting it is the common, correct shape.
				const assigned = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before);
				if (assigned && new RegExp(`\\bawait\\s+${assigned[1]}\\b`).test(code.slice(i))) continue;
				out.push(`${rel}:${code.slice(0, m.index).split('\n').length}: ${name}(`);
			}
		}
	}
	return out;
}

const src = walk(join(ROOT, 'src'))
	.filter((p) => p.endsWith('.ts') && !p.includes('/tests/'))
	.map((p) => ({ rel: relative(ROOT, p), code: readFileSync(p, 'utf8') }));
const scripts = [...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'herdr'))]
	// Not this file: its mutation fixtures are source text, not calls.
	.filter((p) => p.endsWith('.mjs') && p !== fileURLToPath(import.meta.url))
	.map((p) => ({ rel: relative(ROOT, p), code: readFileSync(p, 'utf8') }));

void test('every call of an async src/ export from scripts/ or herdr/ is awaited or otherwise used', () => {
	const byModule = asyncExports(src);
	assert.ok(
		byModule.size > 20,
		`found only ${byModule.size} module(s) with async exports — the reader is broken`
	);
	assert.deepEqual(unusedAsyncCalls(scripts, byModule), []);
});

void test('async-call MUTATION: a bare call is found; await, void, return and .then are not', () => {
	const byModule = new Map([['lib/measured.js', new Set(['writeFacet'])]]);
	const imp = "import { writeFacet } from '../dist/lib/measured.js';\n";
	const found = unusedAsyncCalls(
		[
			{ rel: 'scripts/bad.mjs', code: `${imp}const w = writeFacet('x', {});\nif (w.ok) {}` },
			{
				rel: 'scripts/good.mjs',
				code:
					`${imp}const a = await writeFacet('x', {});\nvoid writeFacet('y', {});\n` +
					"function f() { return writeFacet('z', {}); }\nwriteFacet('t', {}).then(() => {});\n",
			},
		],
		byModule
	);
	assert.deepEqual(found, ['scripts/bad.mjs:2: writeFacet(']);
});
