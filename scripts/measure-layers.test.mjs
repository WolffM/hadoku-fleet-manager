/**
 * Unit tests for the measuring tool itself (wave 5a §A), as distinct from
 * `scripts/lib/layer-guard.test.mjs`, which is the GATE built on top of it.
 * This file proves the resolver, the totality check, and the four-cut
 * placement logic each do what the header of `measure-layers.mjs` claims —
 * on fixtures for the resolver and placement logic (so three other lanes
 * editing this worktree cannot change these answers), and on the real tree
 * for totality (which has no fixture: it is a claim about every file that
 * exists right now).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	listSourceFiles,
	classifyFiles,
	extractSpecifiers,
	resolveSpecifier,
	buildImportEdges,
	violationsForCut,
	topClusters,
	CUTS,
} from './measure-layers.mjs';

test('the layer map is TOTAL over every file this script walks', () => {
	const files = listSourceFiles();
	assert.ok(files.length > 100, 'sanity: the walk should find most of src/ and scripts/');
	const { unmatched } = classifyFiles(files);
	assert.deepEqual(
		unmatched,
		[],
		`layer-map.mjs has no entry for:\n  ${unmatched.join('\n  ')}\n\nAdd one before this test ` +
			"can pass — see scripts/lib/layer-map.mjs's own header for how a file is placed."
	);
});

test('listSourceFiles excludes tests, src/tests/, dist/, node_modules/, and __mut scratch', () => {
	const files = listSourceFiles();
	assert.ok(
		!files.some((f) => /\.test\.(ts|mjs)$/.test(f)),
		'a *.test.* file leaked into the walk'
	);
	assert.ok(!files.some((f) => f.startsWith('src/tests/')), 'src/tests/ leaked into the walk');
	assert.ok(!files.some((f) => f.includes('/dist/')), 'dist/ leaked into the walk');
	assert.ok(!files.some((f) => f.includes('__mut')), '__mut scratch leaked into the walk');
	// And it DOES find ordinary production files, so the exclusions above are
	// not accidentally excluding everything.
	assert.ok(files.includes('src/cli.ts'));
	assert.ok(files.includes('scripts/lib/fleet-exec.mjs'));
});

test('extractSpecifiers reads import/export-from and literal dynamic import, never a comment', () => {
	const src = [
		"import { a } from './a.js';",
		"import './side-effect.mjs';",
		"export { b } from './b.mjs';",
		"export * from './c.mjs';",
		"const x = await import('./dynamic.mjs');",
		'const y = await import(computedPath);', // not literal: must be skipped
		'/**',
		" * @param {import('../dist/d.js').D} d — a JSDoc type reference, in a comment",
		' */',
		"// import './commented-out.mjs';",
	].join('\n');
	assert.deepEqual(
		extractSpecifiers(src).sort(),
		['./a.js', './b.mjs', './c.mjs', './dynamic.mjs', './side-effect.mjs'].sort(),
		'must find exactly the five real imports, and nothing from a comment or a variable path'
	);
});

test('resolveSpecifier: a TS file importing a sibling by its BUILT .js name resolves to the .ts source', () => {
	// `resolveSpecifier` reads ROOT from this module's own location, so a
	// scratch tree would need the whole repo shape rebuilt inside it to be
	// useful; this proves the algorithm directly against the real tree, where
	// src/cli.ts importing src/lib/fleet-paths.ts is a stable, known fact.
	assert.equal(
		resolveSpecifier('src/cli.ts', './lib/fleet-paths.js'),
		'src/lib/fleet-paths.ts',
		'a relative .js specifier must resolve to the sibling .ts source'
	);
});

test('resolveSpecifier: a scripts/.mjs file importing ../dist/x.js resolves to src/x.ts', () => {
	assert.equal(
		resolveSpecifier('scripts/backstop-switch.mjs', '../dist/runners/backstop.js'),
		'src/runners/backstop.ts',
		'one dist/ hop up from scripts/ must resolve to src/runners/backstop.ts'
	);
});

test('resolveSpecifier: a scripts/lib/.mjs file importing ../../dist/x.js resolves to src/x.ts', () => {
	assert.equal(
		resolveSpecifier('scripts/lib/node-users-facet.mjs', '../../dist/lib/node-users.js'),
		'src/lib/node-users.ts',
		'two dist/ hops up from scripts/lib/ must resolve to src/lib/node-users.ts'
	);
});

test('resolveSpecifier: a bare module specifier is external and resolves to null', () => {
	assert.equal(resolveSpecifier('src/cli.ts', 'node:fs'), null);
	assert.equal(resolveSpecifier('src/cli.ts', 'express'), null);
	assert.equal(resolveSpecifier('src/cli.ts', '@wolffm/logger'), null);
});

test('resolveSpecifier: an unresolvable relative specifier is null, not a thrown error', () => {
	assert.equal(resolveSpecifier('src/cli.ts', './does-not-exist-anywhere.js'), null);
});

test('buildImportEdges only counts edges where BOTH ends are classified, deduped', () => {
	// `buildImportEdges` reads from disk, so this exercises it against two
	// real, stable files with a known import between them rather than a
	// synthetic in-memory fixture.
	const { classified } = classifyFiles(['src/cli.ts', 'src/lib/fleet-paths.ts']);
	const { edges } = buildImportEdges(classified);
	assert.ok(
		edges.some((e) => e.from === 'src/cli.ts' && e.to === 'src/lib/fleet-paths.ts'),
		'src/cli.ts is known to import src/lib/fleet-paths.ts'
	);
	// No duplicate edge for the same (from, to) pair even if cli.ts named
	// fleet-paths.ts's exports more than once across the file.
	const dupes = edges.filter((e) => e.from === 'src/cli.ts' && e.to === 'src/lib/fleet-paths.ts');
	assert.equal(
		dupes.length,
		1,
		'the same (from, to) pair must appear once, not once per import statement'
	);
});

test('violationsForCut: imports point down, and a domain never imports a sibling domain — cut (i)', () => {
	const cutI = CUTS.find((c) => c.id === 'i');
	const classified = new Map([
		['composition.ts', { layer: 'composition' }],
		['config.ts', { layer: 'config' }],
		['ci.ts', { layer: 'domain', domain: 'ci-scheduling', part: 'core' }],
		['tenancy.ts', { layer: 'domain', domain: 'tenancy', part: 'core' }],
	]);
	const edges = [
		{ from: 'composition.ts', to: 'config.ts' }, // down: fine
		{ from: 'config.ts', to: 'composition.ts' }, // up: violation
		{ from: 'ci.ts', to: 'tenancy.ts' }, // sideways, same stratum: violation
		{ from: 'ci.ts', to: 'config.ts' }, // down: fine
	];
	const violations = violationsForCut(edges, classified, cutI);
	assert.deepEqual(
		violations.sort((a, b) => a.from.localeCompare(b.from)),
		[
			{ from: 'ci.ts', to: 'tenancy.ts' },
			{ from: 'config.ts', to: 'composition.ts' },
		]
	);
});

test('violationsForCut: folding tenancy into ci-scheduling (cut ii) clears a ci<->tenancy violation', () => {
	const cutII = CUTS.find((c) => c.id === 'ii');
	const classified = new Map([
		['ci.ts', { layer: 'domain', domain: 'ci-scheduling', part: 'core' }],
		['tenancy.ts', { layer: 'domain', domain: 'tenancy', part: 'core' }],
	]);
	const edges = [{ from: 'ci.ts', to: 'tenancy.ts' }];
	assert.deepEqual(
		violationsForCut(
			edges,
			classified,
			CUTS.find((c) => c.id === 'i')
		),
		edges
	);
	assert.deepEqual(
		violationsForCut(edges, classified, cutII),
		[],
		'under cut (ii) tenancy is ci-scheduling, so this is a same-domain import'
	);
});

test('violationsForCut: extracting observation (cut iii) allows a domain to depend on it, not the reverse', () => {
	const cutI = CUTS.find((c) => c.id === 'i');
	const cutIII = CUTS.find((c) => c.id === 'iii');
	const classified = new Map([
		['obs.ts', { layer: 'domain', domain: 'observation', part: 'core' }],
		['ci.ts', { layer: 'domain', domain: 'ci-scheduling', part: 'core' }],
	]);
	// Cut (i): both sit in the SAME domain stratum under different domain
	// tags, so EITHER direction is the lateral "a domain imports a sibling
	// domain" violation.
	assert.deepEqual(violationsForCut([{ from: 'ci.ts', to: 'obs.ts' }], classified, cutI), [
		{ from: 'ci.ts', to: 'obs.ts' },
	]);
	assert.deepEqual(violationsForCut([{ from: 'obs.ts', to: 'ci.ts' }], classified, cutI), [
		{ from: 'obs.ts', to: 'ci.ts' },
	]);
	// Cut (iii) moves observation to its own stratum below the domains:
	// ci-scheduling -> observation becomes an ordinary DOWNWARD import, so it
	// is now ALLOWED — the opposite of cut (i)'s answer for the exact same
	// edge, which is the whole point of measuring the cut rather than
	// assuming it.
	assert.deepEqual(
		violationsForCut([{ from: 'ci.ts', to: 'obs.ts' }], classified, cutIII),
		[],
		'under cut (iii), a domain importing observation is downward, not lateral'
	);
	// But the reverse — observation reaching back UP into a domain — is still
	// forbidden; it just fails for a different reason now (upward, not
	// lateral).
	assert.deepEqual(
		violationsForCut([{ from: 'obs.ts', to: 'ci.ts' }], classified, cutIII),
		[{ from: 'obs.ts', to: 'ci.ts' }],
		'under cut (iii), observation importing a domain is upward'
	);
});

test('violationsForCut: automation -> observation stays forbidden under cut (iii), for a different reason', () => {
	const cutI = CUTS.find((c) => c.id === 'i');
	const cutIII = CUTS.find((c) => c.id === 'iii');
	const classified = new Map([
		['automation.ts', { layer: 'automation' }],
		['obs.ts', { layer: 'domain', domain: 'observation', part: 'core' }],
	]);
	// Cut (i): automation (index 3) is already below the domain stratum
	// (index 2), so automation -> observation-as-domain is upward.
	assert.deepEqual(violationsForCut([{ from: 'automation.ts', to: 'obs.ts' }], classified, cutI), [
		{ from: 'automation.ts', to: 'obs.ts' },
	]);
	// Cut (iii) inserts observation's own stratum BETWEEN the domains and
	// automation (plan: "observation as a layer between automation and the
	// domains"), so automation is still below observation — the edge is
	// still upward, just across a different, narrower gap.
	assert.deepEqual(
		violationsForCut([{ from: 'automation.ts', to: 'obs.ts' }], classified, cutIII),
		[{ from: 'automation.ts', to: 'obs.ts' }],
		'automation still sits below observation under cut (iii)'
	);
});

test('topClusters groups by the importing file, sorted by count desc then name', () => {
	const violations = [
		{ from: 'a.ts', to: 'x.ts' },
		{ from: 'a.ts', to: 'y.ts' },
		{ from: 'b.ts', to: 'z.ts' },
	];
	assert.deepEqual(topClusters(violations, 10), [
		{ from: 'a.ts', count: 2, to: ['x.ts', 'y.ts'] },
		{ from: 'b.ts', count: 1, to: ['z.ts'] },
	]);
});

test('topClusters respects the limit', () => {
	const violations = Array.from({ length: 15 }, (_, i) => ({ from: `f${i}.ts`, to: 't.ts' }));
	assert.equal(topClusters(violations, 10).length, 10);
});

test('the four cuts are exactly i, ii, iii, iv, in that order', () => {
	assert.deepEqual(
		CUTS.map((c) => c.id),
		['i', 'ii', 'iii', 'iv']
	);
});

test("REPRODUCIBILITY — `node scripts/measure-layers.mjs --json` is this module's own computation", async () => {
	// The closing note's four counts must be reproducible by the exact command
	// named in the brief, not just by importing this module in a test. This
	// proves the CLI path and the library path agree, once, rather than
	// re-asserting every count the guard and the fixture tests already pin.
	const { execFileSync } = await import('node:child_process');
	const { fileURLToPath } = await import('node:url');
	const { dirname, join: joinPath } = await import('node:path');
	const here = dirname(fileURLToPath(import.meta.url));
	const out = execFileSync(process.execPath, [joinPath(here, 'measure-layers.mjs'), '--json'], {
		encoding: 'utf8',
		maxBuffer: 1024 * 1024 * 16,
	});
	const viaCli = JSON.parse(out);

	const files = listSourceFiles();
	const { classified } = classifyFiles(files);
	const { edges } = buildImportEdges(classified);
	const viaLib = CUTS.map((cut) => ({
		id: cut.id,
		violationCount: violationsForCut(edges, classified, cut).length,
	}));

	assert.deepEqual(
		viaCli.cuts.map((c) => ({ id: c.id, violationCount: c.violationCount })),
		viaLib
	);
});
