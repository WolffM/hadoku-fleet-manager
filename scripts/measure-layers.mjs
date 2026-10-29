#!/usr/bin/env node
/**
 * MEASURE THE LAYER CUT — the real import graph against `lib/layer-map.mjs`,
 * counted four ways (refactor plan 2026-10-28 §3.3, wave 5a §A).
 *
 * WHY A READER, NOT `dependency-cruiser`. `dependency-cruiser` resolves a
 * live `node_modules` graph; this repo's scripts import the BUILT output
 * (`scripts/lib/paths.mjs` imports `../../dist/lib/fleet-paths.js`, two
 * directories up from a source tree where `dist/lib/fleet-paths.ts` does not
 * exist — only `src/lib/fleet-paths.ts` does). Teaching `dependency-cruiser`
 * that `dist/x.js` really means `src/x.ts` means handing it a custom resolver
 * plugin, at which point most of what it buys over a direct reader is gone.
 * `node-role-guard.test.mjs` already proves the house style for this: read
 * the source text yourself, blank its comments first, and trust the regex.
 * This file is that style, applied to import statements instead of a role
 * comparison.
 *
 * SCOPE. `.ts` and `.mjs` files under `src/`, `scripts/`, `scripts/lib/`,
 * excluding tests (`*.test.ts`, `*.test.mjs`, everything under `src/tests/`).
 * An import is counted only when BOTH ends resolve to a file this script
 * also classifies — an import of `node:fs`, `express`, or a file this script
 * cannot resolve (logged to stderr, never silently dropped) does not
 * participate in a layer violation, because there is no second layer to
 * violate against.
 *
 * THE FOUR CUTS (plan §3.3 step 3), as one placement function parameterised
 * by two booleans: `foldTenancy` (cut ii/iv: a tenancy-domain file is placed
 * as if its domain were ci-scheduling) and `extractObservation` (cut iii/iv:
 * an observation-domain file is placed in its OWN flat stratum, between
 * automation and the domain stratum, rather than inside the domain stratum
 * beside lifecycle/ci-scheduling/tenancy). "Imports point down" means a
 * file's stratum INDEX may only stay the same or increase along an edge;
 * "a domain never imports another domain" is the same-index, different-group
 * case within whichever stratum is the domain stratum for that cut.
 */
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve as pathResolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { blankComments } from './lib/blank-comments.mjs';
import { createEmitter, keepStdoutWhole } from './lib/emit.mjs';
import { LAYERS, DOMAINS, matchLayer } from './lib/layer-map.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, '');

// ---------------------------------------------------------------- walking

const EXT_RE = /\.(ts|mjs)$/;
const TEST_RE = /\.test\.(ts|mjs)$/;

/**
 * Every `.ts`/`.mjs` file under `src/`, `scripts/`, `scripts/lib/` that is
 * not a test, as POSIX-style paths relative to the repo root. `src/tests/`
 * is excluded wholesale: it is test code and test-only helpers
 * (`install-test-host.ts`, `helpers/fleet-fakes.ts`, `tmpdir.ts`), none of
 * which ships, so none of which has a place in the target shape.
 *
 * @returns {string[]}
 */
export function listSourceFiles() {
	const out = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			if (name === 'node_modules' || name === 'dist') continue;
			const abs = join(dir, name);
			const rel = relative(ROOT, abs).split(sep).join('/');
			if (statSync(abs).isDirectory()) {
				if (rel === 'src/tests') continue;
				// `__mut`-prefixed directories are generated mutation-test scratch
				// (observed live: a concurrent lane's F-guard mutation test wrote
				// and removed `scripts/lib/__mut/f5-mutant.mjs` mid-run). Never real
				// source, and transient by construction, so walking one would make
				// this script's totality depend on another lane's test timing.
				if (name.startsWith('__')) continue;
				walk(abs);
				continue;
			}
			if (!EXT_RE.test(name) || TEST_RE.test(name)) continue;
			out.push(rel);
		}
	};
	walk(join(ROOT, 'src'));
	walk(join(ROOT, 'scripts'));
	return out.sort();
}

/**
 * Classify every file `listSourceFiles()` finds.
 *
 * @param {string[]} files
 * @returns {{ classified: Map<string, object>, unmatched: string[] }}
 */
export function classifyFiles(files) {
	const classified = new Map();
	const unmatched = [];
	for (const rel of files) {
		const entry = matchLayer(rel);
		if (entry) classified.set(rel, entry);
		else unmatched.push(rel);
	}
	return { classified, unmatched };
}

// -------------------------------------------------------------- import graph

// `import X from '...'`, `import '...'` (side effect), `export X from '...'`,
// `export * from '...'` — all share the "…from '<specifier>'" tail, except
// the bare side-effect form, which has no `from`.
const FROM_IMPORT_RE = /\b(?:import|export)\b[\s\S]*?\bfrom\s*(['"])((?:\\.|[^\\])*?)\1/g;
const BARE_IMPORT_RE = /\bimport\s*(['"])((?:\\.|[^\\])*?)\1\s*;/g;
// Literal dynamic import only — `import(SOME_VARIABLE)` cannot be resolved
// statically and is skipped, matching the brief's "literal dynamic import".
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"])((?:\\.|[^\\])*?)\1\s*\)/g;

/**
 * Every import/export-from specifier a file's source text names, with
 * comments blanked first (`blank-comments.mjs`) so a JSDoc `{import('...')}`
 * type reference or a specifier quoted in prose is never read as a real
 * dependency — the same discipline `node-role-guard.test.mjs` and
 * `node-identity-guard.test.mjs` already hold for this repo's other
 * source-reading guards.
 *
 * @param {string} src
 * @returns {string[]}
 */
export function extractSpecifiers(src) {
	const code = blankComments(src);
	const specifiers = [];
	for (const re of [FROM_IMPORT_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
		for (const m of code.matchAll(re)) specifiers.push(m[2]);
	}
	return specifiers;
}

/**
 * Resolve one specifier, written in `importerRel`, to another file this
 * script also walks — or `null` for an external module (doesn't start with
 * `.`) or a specifier that resolves to nothing on disk.
 *
 * TWO SHAPES, both measured from the real tree (see this file's header):
 *   - `src/**\/*.ts` importing a sibling source file names the file's BUILT
 *     name (`./foo.js`), because that is what Node resolves at runtime once
 *     `tsc` has run. `./foo.js` is tried as `./foo.ts` when the literal
 *     doesn't exist.
 *   - `scripts/**\/*.mjs` importing a TS module names the BUILT path under
 *     `dist/` (`../dist/x.js`, `../../dist/x.js` from `scripts/lib/`), since
 *     `dist/` mirrors `src/` 1:1. Whatever segment named `dist` is dropped
 *     and replaced with `src`, with the extension restored to `.ts`.
 *
 * @param {string} importerRel
 * @param {string} specifier
 * @returns {string | null}
 */
export function resolveSpecifier(importerRel, specifier) {
	if (!specifier.startsWith('.')) return null; // bare module: node:fs, express, @wolffm/*, …
	const importerAbs = join(ROOT, importerRel);
	const resolved = pathResolve(dirname(importerAbs), specifier);
	const segments = resolved.split(sep);
	const distIndex = segments.lastIndexOf('dist');
	if (distIndex !== -1) {
		const after = segments.slice(distIndex + 1).join('/');
		const tsCandidate = join(ROOT, 'src', after.replace(/\.js$/, '.ts'));
		return existsAsFile(tsCandidate) ? toRel(tsCandidate) : null;
	}
	const candidates = [
		resolved,
		resolved.replace(/\.js$/, '.ts'),
		`${resolved}.ts`,
		`${resolved}.mjs`,
		`${resolved}.js`,
		join(resolved, 'index.ts'),
		join(resolved, 'index.mjs'),
	];
	for (const c of candidates) if (existsAsFile(c)) return toRel(c);
	return null;
}

function existsAsFile(p) {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

function toRel(absPath) {
	return relative(ROOT, absPath).split(sep).join('/');
}

/**
 * Every internal edge BOTH of whose ends are in `classified` — an edge
 * reaching a test file, a `.sh`/`.py` sibling, or something this script
 * could not resolve is dropped (the latter is also logged to stderr, once
 * per distinct unresolved specifier, so a resolver gap is visible rather
 * than silently undercounting).
 *
 * @param {Map<string, object>} classified
 * @returns {{ edges: Array<{from: string, to: string}>, unresolved: Set<string> }}
 */
export function buildImportEdges(classified) {
	const edges = [];
	const seen = new Set();
	const unresolved = new Set();
	for (const rel of classified.keys()) {
		const src = readFileSync(join(ROOT, rel), 'utf8');
		for (const specifier of extractSpecifiers(src)) {
			if (!specifier.startsWith('.')) continue;
			const toRelPath = resolveSpecifier(rel, specifier);
			if (!toRelPath) {
				unresolved.add(`${rel} -> ${specifier}`);
				continue;
			}
			if (!classified.has(toRelPath)) continue; // test file, or otherwise unmapped
			if (toRelPath === rel) continue; // a file importing its own built output (none known, but harmless to skip)
			const key = `${rel}\u0000${toRelPath}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({ from: rel, to: toRelPath });
		}
	}
	return { edges, unresolved };
}

// --------------------------------------------------------------- the 4 cuts

/**
 * @typedef {{ kind: 'flat', layer: string } | { kind: 'domain', domains: string[] }} Stratum
 */

function domainStrata(domains) {
	return { kind: 'domain', domains };
}
function flat(layer) {
	return { kind: 'flat', layer };
}

/** @type {Array<{ id: string, name: string, foldTenancy: boolean, extractObservation: boolean }>} */
export const CUTS = [
	{ id: 'i', name: "the plan's cut", foldTenancy: false, extractObservation: false },
	{
		id: 'ii',
		name: 'tenancy folded into ci-scheduling',
		foldTenancy: true,
		extractObservation: false,
	},
	{
		id: 'iii',
		name: 'observation as a layer between automation and the domains',
		foldTenancy: false,
		extractObservation: true,
	},
	{ id: 'iv', name: 'ii + iii', foldTenancy: true, extractObservation: true },
];

function strataFor(cut) {
	const domains = DOMAINS.filter((d) => !(cut.foldTenancy && d === 'tenancy')).filter(
		(d) => !(cut.extractObservation && d === 'observation')
	);
	const strata = [flat('composition'), flat('surfaces'), domainStrata(domains)];
	if (cut.extractObservation) strata.push(flat('observation'));
	strata.push(flat('automation'), flat('state'), flat('access'), flat('config'));
	return strata;
}

/**
 * Where one classified entry sits for one cut: its stratum index (0 =
 * composition, highest = config) and its lateral group (the domain name,
 * for an entry placed in the domain stratum; `null` for every flat layer).
 *
 * @param {object} entry a `LAYER_MAP` entry (`{layer, domain?, part?}`)
 * @param {ReturnType<typeof strataFor>} strata
 * @param {{ foldTenancy: boolean, extractObservation: boolean }} cut
 */
function place(entry, strata, cut) {
	let layer = entry.layer;
	let domain = entry.domain;
	if (layer === 'domain') {
		if (cut.foldTenancy && domain === 'tenancy') domain = 'ci-scheduling';
		if (cut.extractObservation && domain === 'observation') {
			layer = 'observation';
			domain = undefined;
		}
	}
	for (let i = 0; i < strata.length; i++) {
		const st = strata[i];
		if (st.kind === 'flat' && st.layer === layer) return { index: i, group: null };
		if (st.kind === 'domain' && layer === 'domain' && st.domains.includes(domain)) {
			return { index: i, group: domain };
		}
	}
	throw new Error(
		`layer-map entry (layer=${entry.layer}, domain=${entry.domain}) has nowhere to go`
	);
}

/**
 * Every edge that violates "imports point down; a domain never imports
 * another domain" for one cut.
 *
 * @param {Array<{from: string, to: string}>} edges
 * @param {Map<string, object>} classified
 * @param {typeof CUTS[number]} cut
 * @returns {Array<{from: string, to: string}>}
 */
export function violationsForCut(edges, classified, cut) {
	const strata = strataFor(cut);
	const violations = [];
	for (const { from, to } of edges) {
		const pf = place(classified.get(from), strata, cut);
		const pt = place(classified.get(to), strata, cut);
		const upward = pf.index > pt.index;
		const lateral = pf.index === pt.index && pf.group !== null && pf.group !== pt.group;
		if (upward || lateral) violations.push({ from, to });
	}
	return violations;
}

/**
 * Group violations by their `from` file, since a file that keeps showing up
 * as the IMPORTER in violating edges is the one the plan's own language
 * points at ("where violations cluster shows a wrong cut or a missing shared
 * record") — not the individual edge. Sorted by count desc, then `from`.
 *
 * @param {Array<{from: string, to: string}>} violations
 * @param {number} [n]
 */
export function topClusters(violations, n = 10) {
	const byFrom = new Map();
	for (const v of violations) {
		if (!byFrom.has(v.from)) byFrom.set(v.from, []);
		byFrom.get(v.from).push(v.to);
	}
	return [...byFrom.entries()]
		.map(([from, to]) => ({ from, count: to.length, to: to.sort() }))
		.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from))
		.slice(0, n);
}

// -------------------------------------------------------------------- report

function measureAll() {
	const files = listSourceFiles();
	const { classified, unmatched } = classifyFiles(files);
	if (unmatched.length) {
		throw new Error(
			`layer-map.mjs does not classify ${unmatched.length} file(s):\n  ${unmatched.join('\n  ')}`
		);
	}
	const { edges, unresolved } = buildImportEdges(classified);
	const cuts = CUTS.map((cut) => {
		const violations = violationsForCut(edges, classified, cut);
		return {
			id: cut.id,
			name: cut.name,
			violationCount: violations.length,
			topClusters: topClusters(violations),
			violations,
		};
	});
	return {
		fileCount: files.length,
		edgeCount: edges.length,
		unresolved: [...unresolved].sort(),
		cuts,
	};
}

/** Plan §3.5's table, regenerated from `LAYER_MAP` so the doc cannot drift. */
function renderTable() {
	const files = listSourceFiles();
	const { classified, unmatched } = classifyFiles(files);
	if (unmatched.length) {
		throw new Error(`layer-map.mjs does not classify:\n  ${unmatched.join('\n  ')}`);
	}
	const rows = [];
	for (const layer of LAYERS) {
		if (layer === 'domain') {
			for (const domain of DOMAINS) {
				const here = [...classified.entries()]
					.filter(([, e]) => e.layer === 'domain' && e.domain === domain)
					.map(([rel]) => rel)
					.sort();
				rows.push([`domain: ${domain}`, here]);
			}
		} else {
			const here = [...classified.entries()]
				.filter(([, e]) => e.layer === layer)
				.map(([rel]) => rel)
				.sort();
			rows.push([layer, here]);
		}
	}
	const lines = ['| layer / domain | files (today, generated) |', '|---|---|'];
	for (const [label, here] of rows) {
		lines.push(`| ${label} | ${here.length} file(s): ${here.map((f) => `\`${f}\``).join(', ')} |`);
	}
	return lines.join('\n');
}

// ------------------------------------------------------------------------ CLI

function main() {
	const argv = process.argv.slice(2);
	if (argv.includes('--table')) {
		keepStdoutWhole();
		console.log(renderTable());
		return;
	}
	const report = measureAll();
	const out = createEmitter({ argv: process.argv, json: argv.includes('--json') });
	if (out.json) {
		out.emit(report);
		return;
	}
	console.log(`${report.fileCount} files, ${report.edgeCount} internal import edges`);
	if (report.unresolved.length) {
		console.log(`${report.unresolved.length} unresolved specifier(s) (see stderr for the list)`);
		for (const u of report.unresolved) console.error(`  unresolved: ${u}`);
	}
	for (const cut of report.cuts) {
		console.log(`\ncut ${cut.id} — ${cut.name}: ${cut.violationCount} violation(s)`);
		for (const c of cut.topClusters.slice(0, 10)) {
			console.log(`  ${c.from} -> ${c.count} file(s): ${c.to.join(', ')}`);
		}
	}
}

if (import.meta.url === `file://${process.argv[1]}`) main();
