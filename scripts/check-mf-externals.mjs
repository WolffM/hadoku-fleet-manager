#!/usr/bin/env node
/**
 * Fleet audit: every micro-frontend must externalize what the parent provides.
 *
 * WHY THIS EXISTS
 * ---------------
 * A micro-frontend mounts into a page whose import map already supplies React,
 * @wolffm/themes, @wolffm/task-ui-components, the logger and the prefs client.
 * Those are SINGLETONS: React context matches on object identity, the prefs
 * client caches per module instance, the logger holds its own sink. If a child
 * bundle inlines one instead of importing it, the page ends up with two of
 * them — and the two do not talk to each other.
 *
 * That is not hypothetical. On 2026-08-05, hadoku-aggregator and
 * hadoku-craft both inlined @wolffm/task-ui-components while the theme
 * provider arrived from the parent's copy. Result: two React contexts, and
 * every user hit "No <HadokuThemeRoot> above this component" with the provider
 * plainly mounted. craft stayed broken for days after aggregator was fixed,
 * because nothing connected the two.
 *
 * The failure is invisible to every other gate. It typechecks, it lints, it
 * builds, its tests pass. It only appears in a browser, for everyone at once.
 *
 * THE RULE
 * --------
 * If the parent's import map provides a specifier AND the child imports it,
 * the child's lib build must list it in `rollupOptions.external`.
 *
 * The import map in src/layouts/Base.astro is the source of truth — this reads
 * it rather than hardcoding a list, so adding a mapped module automatically
 * extends the rule to every child.
 *
 * WHAT IS OUT OF SCOPE
 * --------------------
 * Apps that serve their own HTML (conjure, pygmalion, games-host) have no
 * parent import map, so they must inline everything. They carry
 * `includeInRegistry: false` in scripts/child-apps.json (or no entry at all),
 * so the roster gives them no `microFrontend` facet and they never reach this
 * loop. Everything that does reach it IS mounted — see the `lib:` check.
 *
 * USAGE
 *   fleet mf-externals             # audit each repo's shipped default branch
 *   fleet mf-externals --worktree  # audit the working copies under REPOS_DIR
 *   fleet mf-externals --warn      # report, exit 0
 *   fleet mf-externals --no-fetch  # read the fleet-source mirrors as they stand (offline)
 *   fleet mf-externals --source-only  # skip the deployed-bundle half, and say so
 *
 * TWO HALVES (#111). The SOURCE half below reads each repo's vite `external:`
 * list and its imports — fast, and the only half that names the line to fix.
 * The BUILT half (lib/mf-built.mjs) then reads the bundles the live site
 * actually serves, which is the ground truth the source half can only infer:
 * a `.tsx` proves react/jsx-runtime is imported, not that it was externalized.
 * Both report; either one failing fails the gate, and a bundle that could not
 * be read fails it too.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { reposWith } from './lib/fleet-roster.mjs';
import { reposDir } from './lib/sibling-repos.mjs';
import { siteRoot } from './lib/paths.mjs';
import { tryShipped } from './lib/fleet-source.mjs';
import { qualifyRepo } from '../dist/lib/fleet-config.js';
import { blankComments } from './lib/blank-comments.mjs';
import { crawlBundle, fetchText, judgeBuilt, siteOrigin } from './lib/mf-built.mjs';

const REPO_ROOT = siteRoot();

const args = new Set(process.argv.slice(2));
const USE_WORKTREE = args.has('--worktree');
const WARN_ONLY = args.has('--warn');
const NO_FETCH = args.has('--no-fetch');
const SOURCE_ONLY = args.has('--source-only');

/**
 * Micro-frontends the parent page MOUNTS, with the build paths read off each
 * repo's tree.
 *
 * DERIVED from the one roster, never hand-listed. The array this replaces held
 * 9 entries with hand-written paths; the derived set reproduces all nine
 * EXACTLY — `frontend/vite.config.ts` for tenhands, `apps/ui/vite.config.ts`
 * for watchparty — and adds six that had simply never been added.
 * See scripts/admin/lib/fleet-roster.mjs.
 */
const FLEET = reposWith('microFrontend').map(({ repo, vite, src }) => ({
	repo: repo.split('/')[1],
	vite,
	src,
}));

/**
 * Modules where a second copy forks LIVE STATE, not just bytes:
 *   react family     — hooks and context match on module identity
 *   themes           — owns HadokuThemeContext; two copies, two contexts
 *   task-ui-components — consumes that context
 *   logger/client    — holds its own sink and buffer
 *   prefs-client     — caches the resolved prefs blob per instance
 *
 * Inlining one of these is a correctness bug — it forks live state, and the
 * symptom is a blank app for everyone at once.
 *
 * Everything else in the import map (zod, recharts) is stateless, so inlining
 * it costs bundle size and a duplicate download rather than correctness. That
 * is why these are reported as NOTES and do not fail the audit.
 *
 * The notes used to add that externalizing a stateless module "trades those
 * bytes for a runtime fetch — a judgement call per app". For **zod** that is no
 * longer true, and measuring it is what showed why: `@wolffm/themes` imports
 * zod BARE from `themePrefs.js`, and every micro-frontend imports themes, so
 * the page fetches esm.sh/zod whether or not the child bundle also contains a
 * copy. Confirmed 2026-08-18 against the live site: `/task`, whose bundle
 * inlines zod, still issues the same 16 esm.sh/zod requests as `/study`, whose
 * bundle externalizes it. So there is no trade to weigh — inlining zod buys
 * nothing and costs ~100 kB (hadoku-study measured 131 kB -> 33 kB).
 *
 * Left as a note rather than promoted to a failure on purpose: it is not a
 * break, and turning it red would fail four repos' audits over a change their
 * owners have not made yet.
 */
const SINGLETONS = new Set([
	'react',
	'react-dom',
	'react-dom/client',
	'react/jsx-runtime',
	'@wolffm/themes',
	'@wolffm/task-ui-components',
	'@wolffm/logger/client',
	'@wolffm/prefs-client',
	'@wolffm/prefs-client/react',
]);

/**
 * Specifiers from Base.astro's literal `<script type="importmap">` block, or
 * `[]` once the hashes move out of that tracked file (#85) and it has no
 * literal JSON block left to parse — absence here is not an error on its own,
 * only `parentProvides()`'s union-of-both-sources-is-empty case is.
 */
function fromBaseAstro() {
	const file = resolve(REPO_ROOT, 'src/layouts/Base.astro');
	if (!existsSync(file)) return [];
	const base = readFileSync(file, 'utf8');
	const block = base.match(/"imports"\s*:\s*\{([\s\S]*?)\}/);
	if (!block) return [];
	return [...block[1].matchAll(/"([^"]+)"\s*:\s*"/g)].map((m) => m[1]);
}

/**
 * Specifiers from the vendor manifest's `imports` map, written by
 * hadoku_site's `vendor-esm.mjs` on every rebuild (#85). Absent in every
 * checkout until hadoku_site lands its side of #85 — `[]`, not a throw, so
 * the Base.astro parse above still carries the rule until then. Today's
 * production shape also has no `imports` KEY at all (`generatedAt` /
 * `versions` / `files` only) — that is the same "not written yet" case as
 * the whole file being absent, so it reads `[]` too.
 *
 * A manifest that EXISTS but cannot be parsed, or whose `imports` key is
 * present but is not an object, is a DIFFERENT case and must not read as
 * `[]`: once hadoku_site starts writing `imports`, a corrupt write would
 * silently drop every vendored specifier and this audit would pass on
 * whatever Base.astro still carries — "could not look" rendering as "nothing
 * wrong". Both exit loudly, naming the file and the reason.
 */
function fromVendorManifest() {
	const file = resolve(REPO_ROOT, 'public/mf/vendor/manifest.json');
	if (!existsSync(file)) return [];
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'));
	} catch (err) {
		console.error(`✗ ${file} exists but could not be parsed: ${err.message}`);
		process.exit(1);
	}
	if (parsed.imports === undefined) return []; // not written yet — today's production shape
	if (
		typeof parsed.imports !== 'object' ||
		parsed.imports === null ||
		Array.isArray(parsed.imports)
	) {
		console.error(
			`✗ ${file}'s "imports" is present but is not an object — refusing to read it as a specifier map`
		);
		process.exit(1);
	}
	return Object.keys(parsed.imports);
}

/**
 * Specifiers the parent supplies, read from TWO independent sources and
 * unioned (#85):
 *
 *   - `public/mf/vendor/manifest.json`'s `imports` map, when it exists —
 *     the vendored, content-hashed specifiers.
 *   - `src/layouts/Base.astro`'s literal importmap — still the only source
 *     for entries the manifest does not vendor, such as `recharts` on
 *     esm.sh, and the ONLY source in a checkout that predates the manifest.
 *
 * Either source may legitimately read empty on its own (an older checkout
 * has no manifest yet; a future checkout renders the importmap from the
 * manifest and leaves no literal JSON in Base.astro). What may NEVER happen
 * is both reading empty at once: that is the "a gate that reads nothing
 * reads as coverage" shape #85 exists to close, so it is the one case this
 * function refuses outright rather than returning a clean empty audit.
 */
function parentProvides() {
	const specifiers = new Set([...fromVendorManifest(), ...fromBaseAstro()]);
	if (specifiers.size === 0) {
		console.error(
			'✗ read ZERO import-map specifiers from public/mf/vendor/manifest.json or ' +
				'src/layouts/Base.astro — refusing to call that clean'
		);
		process.exit(1);
	}
	return [...specifiers];
}

function git(dir, argv) {
	return execFileSync('git', ['-C', dir, ...argv], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
	});
}

/**
 * One micro-frontend's files: `{ read(file), list(prefix) }`, or `{ unreadable }`.
 *
 * The SHIPPED default branch through `lib/fleet-source.mjs` by default — never a
 * sibling clone, which is only as current as whoever last pulled it
 * (fleet-manager#7). `--worktree` reads the working copy under REPOS_DIR.
 */
function openRepo(name) {
	if (USE_WORKTREE) {
		const dir = resolve(ROOT, name);
		if (!existsSync(dir)) return { unreadable: `no checkout at ${dir}` };
		return {
			read: (file) => readFileSync(resolve(dir, file), 'utf8'),
			list: (prefix) => git(dir, ['ls-files', prefix]).split('\n').filter(Boolean),
		};
	}
	const h = tryShipped(qualifyRepo(name), { fetch: !NO_FETCH });
	if ('unreadable' in h) return { unreadable: `shipped branch unreadable: ${h.unreadable}` };
	return { read: (file) => h.read(file), list: (prefix) => h.list(prefix) };
}

function readAt(source, file) {
	try {
		return source.read(file);
	} catch {
		return null;
	}
}

/**
 * `{ files }`, or `{ reason }` when the listing itself failed. That used to be
 * `[]` — indistinguishable from a src/ with no sources, and both read as "this
 * app imports nothing from the parent", i.e. clean.
 */
function listFiles(source, prefix) {
	try {
		return { files: source.list(prefix).filter((f) => /\.(tsx?|jsx?)$/.test(f)) };
	} catch (err) {
		return { reason: String(err.message || err).split('\n')[0] };
	}
}

/** The `external:` array from a vite config, as written. Regex rather than
 *  evaluation: the config is TypeScript with imports, and running it would mean
 *  installing each repo's toolchain. Takes COMMENT-BLANKED source: a quote
 *  inside a comment in the array — an apostrophe in `// don't inline zod` —
 *  paired with the next real quote and swallowed the specifier after it, which
 *  is how aggregator read as inlining a zod it externalizes. */
function externals(viteSrc) {
	const m = viteSrc.match(/external\s*:\s*\[([\s\S]*?)\]/);
	if (!m) return null;
	return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

/**
 * Does `src` import `spec`? Every import FORM, not just `from '…'`: a bare
 * side-effect `import '@wolffm/themes'` and a dynamic `import('react-dom')`
 * pull the module in exactly as a named import does, and both read as "not
 * imported" — therefore never inlined — before #98.
 */
function importsSpec(src, spec) {
	const s = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+)['"]${s}['"]`).test(src);
}

const provided = parentProvides();
const ROOT = reposDir();
const findings = [];
const notes = [];

// The roster resolving to no micro-frontends is not a fleet with nothing to
// inline. It printed "OK — 0 micro-frontends" and exited 0.
if (FLEET.length === 0) {
	findings.push({
		repo: '(fleet)',
		msg: 'the roster names ZERO micro-frontends — refusing to call that clean',
	});
}

for (const entry of FLEET) {
	const source = openRepo(entry.repo);
	if (source.unreadable) {
		findings.push({ repo: entry.repo, msg: `${source.unreadable} — not audited` });
		continue;
	}

	const viteRaw = readAt(source, entry.vite);
	if (viteRaw === null) {
		findings.push({ repo: entry.repo, msg: `${entry.vite} not found — has the layout moved?` });
		continue;
	}
	const vite = blankComments(viteRaw);

	// Only lib builds mount into the parent page — and every entry here IS
	// mounted (the `microFrontend` facet comes from child-apps.json). So a
	// config with no `lib:` is not out of scope: the facet and the build
	// disagree, and either the page mounts an app bundle that carries its own
	// React, or `vite` points at the wrong config. This used to `continue`,
	// which is the one outcome that cannot be right.
	if (!/\blib\s*:/.test(vite)) {
		findings.push({
			repo: entry.repo,
			msg:
				`${entry.vite} has no \`lib:\` build, but child-apps.json mounts this app — ` +
				'nothing here externalizes the parent singletons',
		});
		continue;
	}

	const ext = externals(vite);
	if (ext === null) {
		findings.push({
			repo: entry.repo,
			msg: `${entry.vite} is a lib build with no rollupOptions.external — it inlines everything`,
		});
		continue;
	}

	// What does this app actually import from the parent-provided set?
	const listing = listFiles(source, entry.src);
	if (listing.reason) {
		findings.push({ repo: entry.repo, msg: `cannot list ${entry.src} (${listing.reason})` });
		continue;
	}
	const { files } = listing;
	if (files.length === 0) {
		findings.push({
			repo: entry.repo,
			msg: `no .ts/.tsx/.js/.jsx under ${entry.src} — nothing was read, so nothing was audited`,
		});
		continue;
	}
	const imported = new Set();
	// The automatic JSX runtime imports `react/jsx-runtime` on the compiler's
	// behalf, so no source file ever names it — and it is a singleton.
	if (provided.includes('react/jsx-runtime') && files.some((f) => /\.[jt]sx$/.test(f))) {
		imported.add('react/jsx-runtime');
	}
	for (const f of files) {
		const raw = readAt(source, f);
		if (!raw) continue;
		// Comment-blanked: an import in a comment is not an import.
		const src = blankComments(raw);
		for (const spec of provided) {
			if (importsSpec(src, spec)) imported.add(spec);
		}
	}

	for (const spec of [...imported].sort()) {
		if (ext.includes(spec)) continue;
		if (SINGLETONS.has(spec)) {
			findings.push({
				repo: entry.repo,
				msg: `inlines ${spec} — the parent provides it, and a second copy forks its state`,
			});
		} else {
			notes.push({
				repo: entry.repo,
				msg:
					spec === 'zod'
						? `inlines ${spec} — free to externalize: @wolffm/themes already pulls zod from the import map on every page, so this copy is pure duplicate weight (~100 kB)`
						: `inlines ${spec} — stateless, so this is bundle size rather than a break`,
			});
		}
	}
}

/**
 * The built half (#111) — see lib/mf-built.mjs. Every app the roster mounts is
 * looked up in the DEPLOYED registry by its child-apps.json id and its bundle
 * judged; each way of failing to look is its own finding.
 */
async function builtFindings() {
	const out = [];
	const astro = resolve(REPO_ROOT, 'astro.config.mjs');
	const origin = existsSync(astro) ? siteOrigin(readFileSync(astro, 'utf8')) : null;
	if (!origin)
		return [
			{
				repo: '(site)',
				msg: `no \`site:\` in ${REPO_ROOT}/astro.config.mjs — the deployed bundles could not be located, so none was checked`,
			},
		];
	let idByRepo;
	try {
		const reg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'scripts/child-apps.json'), 'utf8'));
		idByRepo = new Map((reg.apps ?? []).filter((a) => a.repoName).map((a) => [a.repoName, a.id]));
	} catch (err) {
		return [
			{
				repo: '(site)',
				msg: `scripts/child-apps.json unreadable (${err.message}) — no deployed bundle was checked`,
			},
		];
	}
	const regUrl = `${origin}/mf/registry.json`;
	const regRead = await fetchText(regUrl, fetch);
	let registry;
	try {
		if (!regRead.ok) throw new Error(regRead.reason);
		registry = JSON.parse(regRead.text);
	} catch (err) {
		return [
			{
				repo: '(site)',
				msg: `could not read ${regUrl} (${err.message}) — no deployed bundle was checked`,
			},
		];
	}
	await Promise.all(
		FLEET.map(async (entry) => {
			const id = idByRepo.get(entry.repo);
			const url = id && registry[id]?.url;
			if (!url) {
				out.push({
					repo: entry.repo,
					msg: id
						? `the deployed registry has no "${id}" entry — its built bundle could not be checked`
						: 'child-apps.json names no app for this repo — its built bundle could not be located',
				});
				return;
			}
			const crawl = await crawlBundle(new URL(url, origin).href, fetch);
			if (crawl.reason) {
				out.push({ repo: entry.repo, msg: `deployed bundle not fully read: ${crawl.reason}` });
				return;
			}
			const verdict = judgeBuilt(crawl.files);
			if (verdict) out.push({ repo: entry.repo, msg: verdict });
		})
	);
	return out.sort((a, b) => (a.repo < b.repo ? -1 : 1));
}

if (SOURCE_ONLY) {
	console.log('· --source-only: the deployed bundles were NOT checked\n');
} else if (FLEET.length > 0) {
	findings.push(...(await builtFindings()));
}

for (const n of notes) console.log(`· ${n.repo}: ${n.msg}`);
if (notes.length > 0) console.log('');

if (findings.length === 0) {
	console.log(
		`check-mf-externals: OK — ${FLEET.length} micro-frontends, every parent-provided ` +
			`singleton is external` +
			(SOURCE_ONLY
				? ' in source (deployed bundles not checked).'
				: ' in source and in the deployed bundle.') +
			(notes.length > 0 ? ` ${notes.length} size-only note(s) above.` : '')
	);
	process.exit(0);
}

for (const f of findings) console.log(`✗ ${f.repo}: ${f.msg}`);
console.log(`\n${findings.length} finding(s), ${notes.length} size-only note(s).`);
process.exit(WARN_ONLY ? 0 : 1);
