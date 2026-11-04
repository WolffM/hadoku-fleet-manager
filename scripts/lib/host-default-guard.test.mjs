/**
 * A script may not lean on a default argument that only the in-process host
 * can supply.
 *
 * `host.ts`'s accessors (`stateDir()` and friends) THROW until
 * `createFleetManager(host)` has run, which happens only inside mgmt-api. A
 * `src/` function whose parameter defaults to one of them therefore works
 * in-process and crashes in every standalone script that omits that argument.
 * `node-users-cutover.mjs` did exactly that: `readHostingDoc()` with no
 * directory, on the first real cutover (claw-10, 2026-11-03). It crashed AFTER
 * the manifest flip had landed and skipped the whole re-prove chain behind it.
 * Every other caller passes `stateDir()` from fleet-paths. This test holds all
 * of them, and the next such function, to that.
 *
 * DERIVED, not listed: the guarded functions are read off `src/`. Any exported
 * function with a parameter defaulting to something imported from a `host.js`
 * module is guarded. Comments are blanked first (see node-identity-guard).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function walk(dir, keep, out = []) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name !== 'node_modules' && e.name !== 'tests') walk(p, keep, out);
		} else if (keep(e.name)) out.push(p);
	}
	return out;
}

/** Split a parameter or argument list on top-level commas. */
function topLevelParts(s) {
	const parts = [];
	let depth = 0;
	let cur = '';
	for (const ch of s) {
		if ('([{'.includes(ch)) depth++;
		if (')]}'.includes(ch)) depth--;
		if (ch === ',' && depth === 0) {
			parts.push(cur);
			cur = '';
		} else cur += ch;
	}
	if (cur.trim()) parts.push(cur);
	return parts;
}

/** The text between the paren at `open` and its match. */
function balanced(src, open) {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '(') depth++;
		else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
	}
	return null;
}

/** name -> index of the first parameter whose default comes from host.js. */
function guardedFunctions() {
	const guarded = new Map();
	for (const file of walk(join(ROOT, 'src'), (n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
		const src = blankComments(readFileSync(file, 'utf8'));
		const fromHost = new Set();
		for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[./]*host\.js'/g)) {
			for (const name of m[1].split(',')) {
				const local = name
					.trim()
					.split(/\s+as\s+/)
					.pop();
				if (local) fromHost.add(local);
			}
		}
		if (!fromHost.size) continue;
		for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)) {
			const params = topLevelParts(balanced(src, m.index + m[0].length - 1) ?? '');
			const at = params.findIndex((p) => {
				const def = p.split('=').slice(1).join('=').trim();
				return [...fromHost].some((h) => def.startsWith(`${h}(`));
			});
			if (at > -1) guarded.set(m[1], at);
		}
	}
	return guarded;
}

test('the guard finds the host-defaulted functions it exists for', () => {
	// Proves the derivation still works. An empty map would pass every
	// script below by checking nothing.
	const g = guardedFunctions();
	assert.equal(g.get('readHostingDoc'), 0);
	assert.equal(g.get('writeHostingDoc'), 1);
});

test('no script omits an argument whose default needs the in-process host', () => {
	const guarded = guardedFunctions();
	const findings = [];
	for (const file of walk(
		join(ROOT, 'scripts'),
		(n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs')
	)) {
		const src = blankComments(readFileSync(file, 'utf8'));
		for (const [name, at] of guarded) {
			for (const m of src.matchAll(new RegExp(`(?<![\\w.])${name}\\s*\\(`, 'g'))) {
				const args = topLevelParts(balanced(src, m.index + m[0].length - 1) ?? '');
				if (args.length <= at) {
					const line = src.slice(0, m.index).split('\n').length;
					findings.push(`${relative(ROOT, file)}:${line} ${name}() omits argument ${at + 1}`);
				}
			}
		}
	}
	assert.deepEqual(
		findings,
		[],
		'pass the directory explicitly (stateDir() from dist/lib/fleet-paths.js)'
	);
});
