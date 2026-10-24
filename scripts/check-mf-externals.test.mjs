/**
 * #85 — `fleet mf-externals` must not read its rule from a tracked file that
 * is about to stop carrying it.
 *
 * `check-mf-externals.mjs` decided which specifiers a child must externalise
 * by parsing the literal `<script type="importmap">` JSON out of
 * hadoku_site's `src/layouts/Base.astro`. hadoku_site wants to stop keeping
 * the content-hashed vendor paths in that tracked file — generating the
 * importmap from `public/mf/vendor/manifest.json` at build time instead —
 * and the moment it does, the OLD parser finds either no block at all
 * (`!block` — which at least failed loudly) or a block that still matches
 * but is now EMPTY, which it returned as `[]` with no error. The audit then
 * passes every repo trivially: "a gate that reads nothing reads as
 * coverage."
 *
 * The fix reads BOTH sources and unions them (the manifest's vendored,
 * hashed specifiers; Base.astro's literal importmap for the non-vendored
 * entries it still carries, e.g. `recharts` on esm.sh), and refuses outright
 * when the union is empty — never a silent pass.
 *
 * Every fixture carries ONE clean micro-frontend (`mf-clean`, importing only
 * `react`, which it externalizes) unless a test asks for none. Until #98 these
 * fixtures had no `microFrontend` facet at all — and an empty FLEET exited 0,
 * which is itself one of the blind spots #98 closes, so the import-map tests
 * now need a real repo to pass against.
 *
 * #98's per-repo cases (the second half of this file) exercise the audit
 * loop itself, which was previously covered by nothing but a live run.
 *
 * Exercised as a CLI, the same pattern `ci-watch.test.mjs` uses: a throwaway
 * manifest dir and site root, the EXIT CODE and output read directly.
 *
 * The fixture repos are REMOTES read through fleet-source
 * (lib/fleet-source-fixture.mjs), the way the gate reads GitHub, and REPOS_DIR
 * is an EMPTY directory unless a test puts a working copy there on purpose
 * (`--worktree`, or the fleet-manager#7 poisoned clone). Everything runs under
 * NO_GIT_ENV — see lib/hook-safe-tests.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureRemotes, poisonedClone } from './lib/fleet-source-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-mf-externals.mjs');

/** The ambient environment with every GIT_* variable removed — see
 *  lib/hook-safe-tests.test.mjs. */
const NO_GIT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

const CLEAN_MF = {
	'vite.config.ts':
		"export default { build: { lib: { entry: 'src/main.ts' }, rollupOptions: { external: ['react'] } } };\n",
	'src/main.ts': "import { createElement } from 'react';\nexport const el = createElement;\n",
};

/** Puts `name` on the roster as a mounted micro-frontend and pushes `files`
 *  to its remote — or, when `git` is false, writes them as plain files under
 *  REPOS_DIR for a `--worktree` run. */
function addMicroFrontend(fx, name, files, { git = true } = {}) {
	const cov = JSON.parse(readFileSync(fx.coverage, 'utf8'));
	cov.repos.push(`WolffM/${name}`);
	cov.facets[`WolffM/${name}`] = { microFrontend: { vite: 'vite.config.ts', src: 'src' } };
	writeFileSync(fx.coverage, JSON.stringify(cov));
	if (git) {
		fx.remotes.push(`WolffM/${name}`, files);
		return;
	}
	const repoPath = join(fx.reposDir, name);
	for (const [rel, body] of Object.entries(files)) {
		mkdirSync(dirname(join(repoPath, rel)), { recursive: true });
		writeFileSync(join(repoPath, rel), body);
	}
}

/** A throwaway manifest dir and site root, with one clean micro-frontend
 *  unless `mf: false` — see the file header. */
function fixture({ mf = true } = {}) {
	const remotes = fixtureRemotes('mf-externals-gate-');
	const root = remotes.root;
	const manifestDir = join(root, 'manifest');
	const siteRoot = join(root, 'site');
	const reposDir = join(root, 'repos');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(join(siteRoot, 'src', 'layouts'), { recursive: true });
	mkdirSync(reposDir, { recursive: true });

	const coverage = join(manifestDir, 'fleet-runner-coverage.json');
	writeFileSync(coverage, JSON.stringify({ repos: [], facets: {} }));
	if (mf) addMicroFrontend({ coverage, reposDir, remotes }, 'mf-clean', CLEAN_MF);

	return {
		coverage,
		remotes,
		root,
		manifestDir,
		siteRoot,
		reposDir,
		baseAstro: join(siteRoot, 'src', 'layouts', 'Base.astro'),
		vendorManifest: join(siteRoot, 'public', 'mf', 'vendor', 'manifest.json'),
	};
}

function writeBaseAstro(fx, body) {
	writeFileSync(fx.baseAstro, body);
}

function writeVendorManifest(fx, obj) {
	mkdirSync(dirname(fx.vendorManifest), { recursive: true });
	writeFileSync(fx.vendorManifest, JSON.stringify(obj));
}

/** For the malformed-JSON case, where an object would just get re-serialised
 *  correctly. */
function writeVendorManifestRaw(fx, text) {
	mkdirSync(dirname(fx.vendorManifest), { recursive: true });
	writeFileSync(fx.vendorManifest, text);
}

function run(fx, argv = []) {
	try {
		// --source-only: these fixtures have no site to serve bundles from. The
		// built half (#111) has its own tests at the bottom of this file.
		const out = execFileSync('node', [SCRIPT, '--source-only', ...argv], {
			env: {
				...NO_GIT_ENV,
				...fx.remotes.env,
				REPOS_DIR: fx.reposDir,
				FLEET_MANIFEST_DIR: fx.manifestDir,
				HADOKU_SITE_ROOT: fx.siteRoot,
			},
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, out, stderr: '' };
	} catch (e) {
		return { code: e.status ?? -1, out: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
	}
}

function cleanup(fx) {
	rmSync(fx.root, { recursive: true, force: true });
}

const LITERAL_IMPORTMAP = `---
---
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18",
    "recharts": "https://esm.sh/recharts@2"
  }
}
</script>
`;

const EMPTY_LITERAL_IMPORTMAP = `---
---
<script type="importmap">
{
  "imports": {}
}
</script>
`;

const NO_IMPORTMAP_AT_ALL = `---
---
<html>
  <body>the importmap is rendered from the manifest now, nothing literal here</body>
</html>
`;

// ── the floor: Base.astro alone, no manifest — the path every production
// checkout is on today ────────────────────────────────────────────────────

test("falls back to Base.astro's literal importmap when no vendor manifest exists", () => {
	const fx = fixture();
	try {
		writeBaseAstro(fx, LITERAL_IMPORTMAP);
		// Deliberately no writeVendorManifest(): the file does not exist.
		const r = run(fx);
		assert.equal(r.code, 0, `Base.astro alone must still pass: ${r.out}\n${r.stderr}`);
	} finally {
		cleanup(fx);
	}
});

// ── #85 ask 1: the manifest is read, and stands in when Base.astro has
// nothing literal to parse ─────────────────────────────────────────────────

test('reads specifiers from the vendor manifest when Base.astro carries no literal importmap', () => {
	const fx = fixture();
	try {
		writeBaseAstro(fx, NO_IMPORTMAP_AT_ALL);
		writeVendorManifest(fx, {
			imports: { '@wolffm/themes': '/mf/vendor/themes-abc123.mjs' },
			preload: [],
		});
		const r = run(fx);
		assert.equal(
			r.code,
			0,
			`the manifest must carry the rule once Base.astro has nothing literal: ${r.out}\n${r.stderr}`
		);
	} finally {
		cleanup(fx);
	}
});

// ── #85 ask 3: refuse loudly when BOTH sources are empty — the exact shape
// that let the old parser return [] and pass silently ──────────────────────

test("refuses with a named error when Base.astro's importmap is present but empty and no manifest exists", () => {
	const fx = fixture();
	try {
		writeBaseAstro(fx, EMPTY_LITERAL_IMPORTMAP);
		// No vendor manifest either — both sources read zero specifiers.
		const r = run(fx);
		assert.notEqual(r.code, 0, 'zero specifiers from both sources must never exit 0');
		assert.match(r.stderr, /ZERO import-map specifiers/i);
	} finally {
		cleanup(fx);
	}
});

test('refuses with a named error when Base.astro has no importmap at all and no manifest exists', () => {
	const fx = fixture();
	try {
		writeBaseAstro(fx, NO_IMPORTMAP_AT_ALL);
		const r = run(fx);
		assert.notEqual(r.code, 0, 'zero specifiers from both sources must never exit 0');
		assert.match(r.stderr, /ZERO import-map specifiers/i);
	} finally {
		cleanup(fx);
	}
});

test('refuses with a named error when the vendor manifest exists but is empty and Base.astro has nothing literal', () => {
	const fx = fixture();
	try {
		writeBaseAstro(fx, NO_IMPORTMAP_AT_ALL);
		writeVendorManifest(fx, { imports: {}, preload: [] });
		const r = run(fx);
		assert.notEqual(r.code, 0, 'an empty manifest union empty Base.astro must still refuse');
		assert.match(r.stderr, /ZERO import-map specifiers/i);
	} finally {
		cleanup(fx);
	}
});

// ── manager send-back: a manifest that EXISTS but is broken must not read
// as [] — that is "could not look" rendering as "nothing wrong", and it must
// fail even when Base.astro alone would otherwise be enough to pass ────────

test('refuses with a named error when the vendor manifest exists but is not valid JSON, even though Base.astro alone has specifiers', () => {
	const fx = fixture();
	try {
		// Base.astro carries real entries on its own — a BROKEN manifest must
		// still fail loudly rather than quietly falling back to these.
		writeBaseAstro(fx, LITERAL_IMPORTMAP);
		writeVendorManifestRaw(fx, '{ "imports": { not valid json');
		const r = run(fx);
		assert.notEqual(
			r.code,
			0,
			'a corrupt manifest must never read as [] and pass on Base.astro leftovers'
		);
		assert.match(r.stderr, /manifest\.json exists but could not be parsed/i);
	} finally {
		cleanup(fx);
	}
});

test('refuses with a named error when the manifest\'s "imports" key is present but not an object', () => {
	const fx = fixture();
	try {
		writeBaseAstro(fx, LITERAL_IMPORTMAP);
		writeVendorManifest(fx, { imports: ['not', 'a', 'map'], preload: [] });
		const r = run(fx);
		assert.notEqual(r.code, 0, 'a non-object "imports" must never be read as a specifier map');
		assert.match(r.stderr, /"imports" is present but is not an object/i);
	} finally {
		cleanup(fx);
	}
});

// ── #98: the per-repo audit loop ───────────────────────────────────────────

const SINGLETON_IMPORTMAP = `---
---
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18",
    "react/jsx-runtime": "https://esm.sh/react@18/jsx-runtime",
    "@wolffm/themes": "/mf/vendor/themes.mjs"
  }
}
</script>
`;

const ALL_EXTERNAL = "['react', 'react/jsx-runtime', '@wolffm/themes']";
const viteWith = (external) =>
	`export default { build: { lib: { entry: 'src/main.ts' }, rollupOptions: { external: ${external} } } };\n`;

/** One micro-frontend `mf-x` beside nothing else, against SINGLETON_IMPORTMAP. */
function runOne(files, { git = true, argv = [] } = {}) {
	const fx = fixture({ mf: false });
	try {
		writeBaseAstro(fx, SINGLETON_IMPORTMAP);
		addMicroFrontend(fx, 'mf-x', files, { git });
		return run(fx, argv);
	} finally {
		cleanup(fx);
	}
}

test('#98: a roster with ZERO micro-frontends fails — it printed "OK — 0 micro-frontends"', () => {
	const fx = fixture({ mf: false });
	try {
		writeBaseAstro(fx, LITERAL_IMPORTMAP);
		const r = run(fx);
		assert.equal(r.code, 1, r.out);
		assert.match(r.out, /ZERO micro-frontends/);
	} finally {
		cleanup(fx);
	}
});

test('#98 floor: every imported singleton external passes', () => {
	const r = runOne({
		'vite.config.ts': viteWith(ALL_EXTERNAL),
		'src/main.ts': "import { useTheme } from '@wolffm/themes';\nexport { useTheme };\n",
	});
	assert.equal(r.code, 0, r.out + r.stderr);
});

test('#98: an apostrophe in a comment inside `external` no longer eats the next specifier', () => {
	const r = runOne({
		'vite.config.ts': viteWith(
			"[\n  'react', // don't bundle a second React\n  '@wolffm/themes',\n]"
		),
		'src/main.ts': "import { useTheme } from '@wolffm/themes';\nexport { useTheme };\n",
	});
	assert.equal(r.code, 0, r.out + r.stderr);
});

test('#98: a specifier that is external only inside a comment is NOT external', () => {
	const r = runOne({
		'vite.config.ts': viteWith("['react', /* '@wolffm/themes' */]"),
		'src/main.ts': "import { useTheme } from '@wolffm/themes';\nexport { useTheme };\n",
	});
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /inlines @wolffm\/themes/);
});

test('#98: a mounted micro-frontend whose config has no `lib:` is a finding, not a skip', () => {
	const r = runOne({
		'vite.config.ts': 'export default { build: { outDir: "dist" } };\n',
		'src/main.ts': "import { useTheme } from '@wolffm/themes';\n",
	});
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /has no `lib:` build/);
});

test('#98: no sources under src/ is a finding — nothing read is nothing audited', () => {
	const r = runOne({ 'vite.config.ts': viteWith("['react']"), 'src/README.md': 'docs\n' });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /no \.ts\/\.tsx\/\.js\/\.jsx under src/);
});

test('#98: a src/ listing that FAILS is a finding naming the failure', () => {
	// --worktree reads the vite config off disk, then lists src/ with
	// `git ls-files` — which fails in a directory that is not a repo.
	const r = runOne(
		{ 'vite.config.ts': viteWith("['react']"), 'src/main.ts': "import 'react';\n" },
		{ git: false, argv: ['--worktree'] }
	);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /cannot list src/);
});

for (const [form, line] of [
	['bare side-effect', "import '@wolffm/themes';\n"],
	['dynamic', "export const load = () => import('@wolffm/themes');\n"],
]) {
	test(`#98: a ${form} import of a singleton counts as importing it`, () => {
		const r = runOne({ 'vite.config.ts': viteWith("['react']"), 'src/main.ts': line });
		assert.equal(r.code, 1, r.out);
		assert.match(r.out, /inlines @wolffm\/themes/);
	});
}

test('#98: any .tsx under src/ requires react/jsx-runtime — the compiler imports it, no file names it', () => {
	const r = runOne({
		'vite.config.ts': viteWith("['react', '@wolffm/themes']"),
		'src/App.tsx': 'export const App = () => <main />;\n',
	});
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /inlines react\/jsx-runtime/);
});

test('#98: an import that exists only in a comment is not an import', () => {
	const r = runOne({
		'vite.config.ts': viteWith("['react']"),
		'src/main.ts': "// import { useTheme } from '@wolffm/themes';\nexport const x = 1;\n",
	});
	assert.equal(r.code, 0, r.out + r.stderr);
});

test('#7: a roster micro-frontend whose shipped branch cannot be read is a finding', () => {
	const fx = fixture({ mf: false });
	try {
		writeBaseAstro(fx, SINGLETON_IMPORTMAP);
		const cov = JSON.parse(readFileSync(fx.coverage, 'utf8'));
		cov.repos.push('WolffM/mf-never-pushed');
		cov.facets['WolffM/mf-never-pushed'] = {
			microFrontend: { vite: 'vite.config.ts', src: 'src' },
		};
		writeFileSync(fx.coverage, JSON.stringify(cov));
		const r = run(fx);
		assert.equal(r.code, 1, r.out);
		assert.match(r.out, /mf-never-pushed: shipped branch unreadable: fetch from .* failed/);
	} finally {
		cleanup(fx);
	}
});

/**
 * fleet-manager#7: A LOCAL CLONE CANNOT CHANGE THE VERDICT.
 *
 * Baseline: a clone under REPOS_DIR that MATCHES the shipped branch, so a gate
 * reading it would pass too. Then it is replaced by one that lies — a stale
 * commit (its origin/main drops `@wolffm/themes` from `external`), CRLF, and an
 * uncommitted source file importing react-dom — and the verdict must not move.
 * Revert the gate to reading the clone and the poisoned run reports
 * "inlines @wolffm/themes".
 */
test('#7: a CRLF, stale, dirty clone under REPOS_DIR does not change the verdict', () => {
	const fx = fixture({ mf: false });
	const shipped = {
		'vite.config.ts': viteWith(ALL_EXTERNAL),
		'src/main.ts': "import { useTheme } from '@wolffm/themes';\nexport { useTheme };\n",
	};
	try {
		writeBaseAstro(fx, SINGLETON_IMPORTMAP);
		addMicroFrontend(fx, 'mf-x', shipped);
		poisonedClone(fx.reposDir, 'WolffM/mf-x', shipped);
		const baseline = run(fx);
		assert.equal(baseline.code, 0, baseline.out + baseline.stderr);

		rmSync(join(fx.reposDir, 'mf-x'), { recursive: true, force: true });
		poisonedClone(
			fx.reposDir,
			'WolffM/mf-x',
			{ ...shipped, 'vite.config.ts': viteWith("['react']") },
			{ crlf: true, edit: { 'src/local.ts': "import 'react-dom';\n" } }
		);
		const poisoned = run(fx);
		assert.equal(poisoned.code, baseline.code, poisoned.out);
		assert.equal(poisoned.out, baseline.out);
	} finally {
		cleanup(fx);
	}
});

// ── #111: the BUILT half, against a served site ─────────────────────────────
//
// A real HTTP server on loopback stands in for the live site: astro.config's
// `site:` points at it, and child-apps.json maps the roster repo to its id.
// `execFile` (async), not execFileSync — the server shares this event loop.

const CLEAN_ENTRY = 'import{jsx as e}from"react/jsx-runtime";import"./chunk.js";export{e};';
const INLINED_CHUNK = 'var k=Symbol.for("react.transitional.element");export{k};';

async function runBuilt({
	registry,
	files = {},
	childApps = [{ id: 'clean', repoName: 'mf-clean' }],
}) {
	const fx = fixture();
	const server = createServer((req, res) => {
		const path = req.url.replace(/\?.*$/, '');
		const body =
			path === '/mf/registry.json'
				? registry === undefined
					? undefined
					: JSON.stringify(registry)
				: files[path];
		if (body === undefined) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200);
		res.end(body);
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	try {
		writeBaseAstro(fx, SINGLETON_IMPORTMAP);
		writeFileSync(
			join(fx.siteRoot, 'astro.config.mjs'),
			`export default { site: 'http://127.0.0.1:${server.address().port}' };\n`
		);
		mkdirSync(join(fx.siteRoot, 'scripts'), { recursive: true });
		writeFileSync(
			join(fx.siteRoot, 'scripts', 'child-apps.json'),
			JSON.stringify({ apps: childApps })
		);
		return await new Promise((resolveRun) => {
			execFile(
				'node',
				[SCRIPT],
				{
					env: {
						...NO_GIT_ENV,
						...fx.remotes.env,
						REPOS_DIR: fx.reposDir,
						FLEET_MANIFEST_DIR: fx.manifestDir,
						HADOKU_SITE_ROOT: fx.siteRoot,
					},
					encoding: 'utf8',
				},
				(err, stdout, stderr) =>
					resolveRun({ code: err ? (err.code ?? -1) : 0, out: stdout, stderr })
			);
		});
	} finally {
		server.close();
		cleanup(fx);
	}
}

const CLEAN_REGISTRY = { clean: { url: '/mf/clean/index.js?v=1' } };

test('#111: a deployed bundle that externalizes the runtime passes both halves', async () => {
	const r = await runBuilt({
		registry: CLEAN_REGISTRY,
		files: { '/mf/clean/index.js': CLEAN_ENTRY, '/mf/clean/chunk.js': 'export{};' },
	});
	assert.equal(r.code, 0, r.out + r.stderr);
	assert.match(r.out, /in source and in the deployed bundle/);
});

test("#111: source green, deployed bundle inlines React's runtime — the watchparty shape fails", async () => {
	// The source half passes this app (react external, no .tsx); only the built
	// half can see the chunk. MUTATION: skip builtFindings and this exits 0.
	const r = await runBuilt({
		registry: CLEAN_REGISTRY,
		files: { '/mf/clean/index.js': 'import"./chunk.js";', '/mf/clean/chunk.js': INLINED_CHUNK },
	});
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /✗ mf-clean: the DEPLOYED bundle inlines React's element runtime/);
});

test('#111: an app the deployed registry does not list fails — a missing bundle is not a pass', async () => {
	const r = await runBuilt({ registry: {} });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /mf-clean: the deployed registry has no "clean" entry/);
});

test('#111: a chunk that 404s fails the app as not fully read', async () => {
	const r = await runBuilt({
		registry: CLEAN_REGISTRY,
		files: { '/mf/clean/index.js': CLEAN_ENTRY },
	});
	assert.equal(r.code, 1, r.out);
	assert.match(
		r.out,
		/mf-clean: deployed bundle not fully read: could not fetch .*chunk\.js: HTTP 404/
	);
});

test('#111: an unreadable registry fails the whole built half, by name', async () => {
	const r = await runBuilt({ registry: undefined });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /\(site\): could not read .*\/mf\/registry\.json \(HTTP 404/);
});

test('#111: a roster repo child-apps.json does not name fails rather than being skipped', async () => {
	const r = await runBuilt({ registry: CLEAN_REGISTRY, childApps: [] });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /mf-clean: child-apps\.json names no app for this repo/);
});
