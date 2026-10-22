/**
 * THE ROUND TRIP IS THE WHOLE POINT (#12).
 *
 * `fleet benchmark --write` writes into hadoku_site, and the only question that
 * matters is whether the file it leaves behind survives HADOKU_SITE'S OWN
 * `prettier --check`. So that is what is asserted: format a document through
 * `renderJson`, then run the OWNING TREE's prettier over the result and require
 * it to change nothing. A test that re-implemented prettier's rules and
 * compared against them would pass while the real gate failed — the verifier
 * reading its own writer's artifact, which is the failure this repo keeps
 * paying for.
 *
 * TWO POPULATIONS, AND THE SECOND IS WHY THIS FILE RUNS IN CI AT ALL
 * ------------------------------------------------------------------
 * A CI runner checks out THIS repo and nothing else, so `paths.mjs` cannot
 * resolve a hadoku_site checkout and — correctly — THROWS rather than reporting
 * a missing tree as an empty one. This file used to resolve that path at module
 * scope, so the throw took the whole suite down: CI run 34416392183, which took
 * `check` and Publish with it.
 *
 * The fix is not to make the real-manifest assertion conditional and leave CI
 * with nothing. It is two populations:
 *
 *   - A FIXTURE tree in a temp dir, carrying its own `.prettierrc` with the JSON
 *     options hadoku_site's config actually resolves to. It reproduces #12's
 *     exact diff hunk, it needs nothing outside this repo, and it ALWAYS RUNS —
 *     so the regression stays guarded on a runner.
 *   - The REAL manifest, which is the stronger evidence (1,500 lines, deeply
 *     nested, written by the thing under test) and runs wherever a hadoku_site
 *     checkout exists. Where it cannot run it SKIPS WITH THE REASON, naming the
 *     path that was missing. A silently-green test here would be the exact
 *     failure this file exists to catch.
 *
 * The manifest is READ ONLY. Nothing in this file writes into hadoku_site.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { manifest } from './paths.mjs';
import { loadPrettier, renderJson } from './prettier-json.mjs';

/**
 * hadoku_site's manifest, or `null` with the reason it could not be reached.
 *
 * `manifest()` THROWS on a missing tree, deliberately — see `fleet-paths.ts`.
 * That is right for a gate and wrong for a test that has something useful to
 * say either way, so the throw is caught HERE, once, and turned into a skip
 * reason that names the path. Caught nowhere else: every other reader of this
 * value gets a real path or a stated skip.
 */
function resolveSiteManifest() {
	try {
		const path = manifest('fleet-runner-manifest.json');
		return existsSync(path) ? { path, why: null } : { path: null, why: `no file at ${path}` };
	} catch (err) {
		return { path: null, why: String(err.message ?? err).split('\n')[0] };
	}
}

const site = resolveSiteManifest();
/** `false` when the real-manifest tests can run; otherwise the reason they cannot. */
const SKIP_SITE = site.path
	? false
	: `${site.why} — the FIXTURE round-trip below covers the same regression and always runs`;

/**
 * A throwaway repo that formats JSON the way hadoku_site does.
 *
 * These are hadoku_site's `.prettierrc` values for `*.json` — its `overrides`
 * block sets `useTabs: false` and `tabWidth: 2` for JSON, over a root
 * `printWidth: 100`. `printWidth` is the one that matters and it is the one
 * #12 is about: at prettier's default 80 the `capabilities` array below breaks
 * across lines, at 100 it stays inline, so a fixture that resolved the wrong
 * config would fail rather than quietly assert something else.
 *
 * `plugins` is deliberately absent: hadoku_site declares `prettier-plugin-astro`
 * and this package cannot load it, which is exactly why `renderJson` drops the
 * key. A fixture carrying it would test a path production never takes.
 */
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'prettier-json-'));
writeFileSync(
	join(FIXTURE_ROOT, '.prettierrc'),
	JSON.stringify({ useTabs: false, tabWidth: 2, printWidth: 100 }, null, 2)
);
const FIXTURE = join(FIXTURE_ROOT, 'fleet-runner-manifest.json');

after(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

/** #12's diff hunk, reduced, plus the array that discriminates 100 from 80. */
const FIXTURE_DOC = {
	toolchain: {
		toolCache: { Python: ['3.11', '3.12'] },
		capabilities: ['ffmpeg', 'python-venv', 'python-toolcache', 'playwright', 'gh'],
	},
	machines: { 'claw-1': { cores: 8, labels: ['hadoku-builder'] } },
};

/** `prettier --check`, run by the tree that OWNS `filePath`. */
async function checkedByOwningTree(text, filePath) {
	const loaded = await loadPrettier(filePath);
	assert.ok(loaded, `no prettier resolvable from ${filePath}'s tree or from this package`);
	const config = (await loaded.api.resolveConfig(filePath)) ?? {};
	// Dropped for the reason renderJson gives — the json parser takes no plugin.
	delete config.plugins;
	return loaded.api.check(text, { ...config, filepath: filePath, parser: 'json' });
}

test('renderJson: a short array stays inline, which JSON.stringify never does', async () => {
	const doc = { toolchain: { toolCache: { Python: ['3.11', '3.12'] } } };
	const { text, formatter } = await renderJson(doc, FIXTURE);
	assert.ok(formatter, 'no prettier resolvable from either tree — see loadPrettier');
	assert.match(text, /"Python": \["3\.11", "3\.12"\]/);
	assert.doesNotMatch(
		`${JSON.stringify(doc, null, 2)}\n`,
		/"Python": \["3\.11", "3\.12"\]/,
		'fixture no longer demonstrates the bug — the assertion above would be vacuous'
	);
});

test('renderJson: output ends in exactly one newline, like every other file the fleet writes', async () => {
	const { text } = await renderJson({ a: 1 }, FIXTURE);
	assert.ok(text.endsWith('\n'));
	assert.ok(!text.endsWith('\n\n'));
});

test('renderJson: the result still parses back to the same document', async () => {
	// Formatting must never be able to lose a measurement.
	const { text } = await renderJson(FIXTURE_DOC, FIXTURE);
	assert.deepEqual(JSON.parse(text), FIXTURE_DOC);
});

test("renderJson's output round-trips through the OWNING tree's prettier unchanged", async () => {
	// THE CI-SIDE GUARD FOR #12, and it needs nothing but this repo. The owning
	// tree here is the temp fixture and its `.prettierrc`; on a box with a
	// hadoku_site checkout the test below asserts the same thing against the
	// real file and the real config.
	const { text, formatter } = await renderJson(FIXTURE_DOC, FIXTURE);
	assert.ok(formatter, 'no prettier resolvable — see loadPrettier');
	assert.equal(await checkedByOwningTree(text, FIXTURE), true);
	// AND the config really is the one being resolved: at printWidth 80 this
	// array breaks, so an ignored `.prettierrc` fails here rather than silently
	// asserting prettier's defaults.
	assert.match(
		text,
		/"capabilities": \["ffmpeg", "python-venv", "python-toolcache", "playwright", "gh"\]/
	);
});

test('the plain JSON.stringify the writer used to emit FAILS that same check', async () => {
	// The regression this guards. If this ever passes, the bug has gone away for
	// some other reason and the round-trip test above has stopped proving
	// anything — which is worth knowing.
	const plain = `${JSON.stringify(FIXTURE_DOC, null, 2)}\n`;
	assert.equal(
		await checkedByOwningTree(plain, FIXTURE),
		false,
		'JSON.stringify output is now prettier-clean — #12 no longer bites'
	);
});

test(
	"the REAL manifest round-trips through hadoku_site's own prettier unchanged",
	{ skip: SKIP_SITE },
	async () => {
		// The stronger evidence: 1,500 lines of the actual file `fleet benchmark
		// --write` rewrites, formatted by the prettier resolved from hadoku_site's
		// own node_modules under hadoku_site's own .prettierrc.
		const doc = JSON.parse(readFileSync(site.path, 'utf8'));
		const { text, formatter } = await renderJson(doc, site.path);
		assert.ok(formatter, 'no prettier resolvable from either tree — see loadPrettier');
		assert.equal(
			await checkedByOwningTree(text, site.path),
			true,
			`${site.path} written by renderJson would fail prettier --check`
		);
		// Formatting a file this size must not lose a single measurement.
		assert.deepEqual(JSON.parse(text), doc);
	}
);

test(
	'the plain JSON.stringify output FAILS on the real manifest too',
	{ skip: SKIP_SITE },
	async () => {
		const doc = JSON.parse(readFileSync(site.path, 'utf8'));
		const plain = `${JSON.stringify(doc, null, 2)}\n`;
		assert.equal(
			await checkedByOwningTree(plain, site.path),
			false,
			'JSON.stringify output is now prettier-clean — #12 no longer bites'
		);
	}
);

test('renderJson never throws, and the degraded answer is still exactly the document', async () => {
	// A formatting problem must not lose a measurement, so the answer for a path
	// in a tree with no `node_modules` is asserted by EQUALITY rather than by a
	// shape check that could not fail. Both branches agree on this document and
	// that is why it is the fixture: `{ "a": 1 }` is already expanded, so plain
	// `JSON.stringify` output is a fixed point of prettier's json parser — the
	// test therefore does not have to know whether the package fallback resolved
	// or whether it degraded, only that neither branch may alter the content.
	const doc = { a: 1 };
	const plain = `${JSON.stringify(doc, null, 2)}\n`;
	const { text, formatter } = await renderJson(doc, '/nonexistent/tree/x.json');
	assert.equal(text, plain);
	assert.deepEqual(JSON.parse(text), doc);
	// `formatter` is the contract's honesty flag. `null` means "this was NOT
	// formatted" — which benchmark-fleet turns into a finding rather than
	// silently shipping — and anything else must name a prettier that really is
	// on disk, not a placeholder standing in for one.
	if (formatter === null) return;
	assert.ok(existsSync(formatter), `renderJson named ${formatter}, which does not exist`);
	assert.match(formatter, /prettier/);
});

test('benchmark-fleet.mjs writes no manifest tree, so it has nothing left to format', () => {
	// Since Wave 3h `$benchmark` lives in the state dir (`writeFacet`, in
	// src/lib/measured.ts) and the ledger append is gone, so this script no
	// longer writes a hadoku_site file at all. The guard it used to need — both
	// writes routed through renderJson — becomes this one: if a manifest write
	// comes back here it must come back through manifest-target and renderJson,
	// and this test is the place that forces the question.
	const src = readFileSync(new URL('../benchmark-fleet.mjs', import.meta.url), 'utf8');
	assert.doesNotMatch(src, /from '\.\/lib\/manifest-target\.mjs'/);
	assert.doesNotMatch(src, /from '\.\/lib\/prettier-json\.mjs'/);
	assert.doesNotMatch(
		src,
		/writeFileSync\([^)]*JSON\.stringify\(/,
		'a raw JSON.stringify write is back — that is exactly what #12 was'
	);
	assert.match(src, /writeFacet\('benchmark'/, 'the benchmark record must go through writeFacet');
});
