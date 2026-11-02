/**
 * check-header-fleet's RULES (scripts/check-header-fleet.mjs, wave 5m lane D
 * split #13 — pure move): every per-repo and per-template check the CLI's
 * fleet loop and templates sweep call into, plus the shared `findings` /
 * `advisories` arrays and `report`/`reportAdvisory` they are built from — the
 * CLI's own main loop pushes directly into those same arrays for the
 * findings that are not any one rule's (`no-checkout`, `unreadable`,
 * `not-in-fleet`, …), so they live here rather than split a second way. See
 * the CLI's own header for what each rule means.
 */
import { execFileSync } from 'node:child_process';

import { readFile, readBlanked, openRepo } from './header-source.mjs';
import { stripYamlComments } from './yaml-comments.mjs';
import { readChildApps } from './site-docs.mjs';
import { READ_ATTEMPTS } from './read-retry-policy.mjs';
import { fleetOwner, hubRepo, qualifyRepo } from '../../dist/lib/fleet-config.js';
import { tryShipped } from './fleet-source.mjs';

export const REGISTRY = 'https://npm.pkg.github.com';

/** The @wolffm peerDependencies of one manifest, as `{ name, r }`. */
export function wolffmPeers(pkg) {
	return Object.entries(pkg.peerDependencies || {})
		.filter(([name]) => name.startsWith('@wolffm/'))
		.map(([name, range]) => ({ name, r: String(range) }));
}

/** A peer range that cannot rot: a floor, a workspace link, or no claim at all. */
export function peerRangeIsSound(r) {
	return r.startsWith('workspace:') || r === '*' || r.startsWith('>=');
}

export const findings = [];
/**
 * `meta` is optional structured data for consumers that must not parse the
 * prose. ci:header-fleet needs exactly one thing from it — whether a
 * `stale-package` gap crosses a MAJOR — because that decides whether the finding
 * self-heals. Scraping "declares ^4.7.3, latest is 4.8.1" out of the sentence
 * would put a regex on a human-facing string, which is the coupling that makes
 * a message impossible to reword later.
 */
export function report(repo, rule, detail, meta) {
	findings.push({ repo, rule, detail, key: `${repo}:${rule}`, ...(meta ? { meta } : {}) });
}

/**
 * Advisory findings — reported, but never counted toward the exit code or the
 * allowlist pass (a grace is automatic; it is not something to exempt).
 *
 * Kept as a SEPARATE array from `findings` rather than a flag on one, so the
 * `--json` shape stays additive the way #95's blast-radius note promises: a
 * consumer written against the pre-#95 contract (`repos`, `findings`,
 * `staleExemptions`, `registry`) reads exactly what it always read — the new
 * field is one it has never heard of and will never see unless it looks.
 */
export const advisories = [];
export function reportAdvisory(repo, rule, detail, meta) {
	advisories.push({ repo, rule, detail, key: `${repo}:${rule}`, ...(meta ? { meta } : {}) });
}

/**
 * `npm-auth-form` — every repo authenticates @wolffm installs the SAME way, with
 * the install-only token.
 *
 * Three different forms were in use across this fleet before 2026-08-19: an
 * inline `${{ secrets.… }}`, a shell `${VAR}` fed by vault-fetch, and an env
 * export consumed by a committed .npmrc. Some repos commit an .npmrc, others
 * write one in CI. Nothing described a canonical shape, so migrating the
 * credential took three passes and a per-repo reading of every workflow instead
 * of one mechanical change.
 *
 * The rule is narrow on purpose: it does not dictate WHERE the .npmrc comes from
 * (a monorepo with several packages legitimately differs), only that whatever
 * authenticates against npm.pkg.github.com presents HADOKU_NPM_READ_TOKEN.
 * HADOKU_SITE_TOKEN in that position is the finding — it carries repo + workflow,
 * so a leak of it from an install step is an account compromise, which is the
 * whole reason the split exists.
 */
export function checkNpmAuthForm(repo, source, files) {
	const NPM_AUTH = /NODE_AUTH_TOKEN\s*:|_authToken\s*=/;
	// EVERY place a credential is presented, not the two this started with.
	// It read the repo-root `.npmrc` and `.github/workflows/` only, so a monorepo
	// whose `frontend/.npmrc` carried the wrong token — tenhands and pygmalion
	// keep their workspace there — and a composite action under
	// `.github/actions/<name>/action.yml`, which is where a shared setup step
	// authenticates once for every workflow, both passed unread.
	const candidates = files.filter(
		(f) =>
			!f.includes('node_modules/') &&
			((f.startsWith('.github/workflows/') && /\.ya?ml$/.test(f)) ||
				(f.startsWith('.github/actions/') && /(^|\/)action\.ya?ml$/.test(f)) ||
				f === '.npmrc' ||
				f.endsWith('/.npmrc'))
	);

	for (const f of candidates) {
		const raw = readFile(source, f);
		if (!raw) continue;
		// blankComments strips JS comments; these files are YAML and .npmrc, where
		// prose starts with `#`. Without this the rule fires on documentation —
		// tenhands' taskauto.yml explains the tokenless-.npmrc scheme in a comment
		// and reported as a violation on the first run.
		//
		// The YAML stripper, not the JS one: `blankComments` reads `//` as a
		// comment opener, and the canonical auth line in an unquoted `run: |`
		// step is `echo //npm.pkg.github.com/:_authToken=…` — it ate exactly the
		// line this rule exists to read.
		const src = f.endsWith('.npmrc') ? raw : stripYamlComments(raw);
		src.split('\n').forEach((line, i) => {
			if (line.trim().startsWith('#')) return;
			if (!NPM_AUTH.test(line)) return;
			if (!line.includes('HADOKU_SITE_TOKEN')) return;
			report(
				repo,
				'npm-auth-form',
				`${f}:${i + 1} authenticates npm with HADOKU_SITE_TOKEN (repo+workflow). ` +
					`Use HADOKU_NPM_READ_TOKEN — it is seeded on every fleet repo.`
			);
		});
	}
}

/**
 * `release-age-cooldown` — can this repo install a @wolffm package on the day
 * it is published?
 *
 * pnpm 11.5 DEFAULTS `minimum-release-age` to 24h and verifies the entire
 * lockfile against it on every install. That default is the whole trap: the
 * rule cannot be found by grepping for repos that switched the cooldown ON,
 * because the exposed ones are exactly those that say nothing. A repo with no
 * `minimumReleaseAge` line and no exclude list looks unconfigured and is in
 * fact gated.
 *
 * Which collides head-on with always-latest: the auto-update commit installs a
 * version minutes old. So every @wolffm consumer must either exempt the scope
 * or disable the cooldown outright.
 *
 * The exemption MUST be the scope glob `@wolffm/*`. A pinned `name@version`
 * entry silently never matches — tenhands proved it on 2026-08-05 when the
 * commit that added `@wolffm/themes@4.0.0` to the list failed verification on
 * that exact version, twice. So a non-empty exclude list is not evidence of
 * anything; only the glob is.
 *
 * Found on 2026-08-26: hadoku-filetransfer had neither, and its deploy died on
 * `@wolffm/themes@5.7.9 could not be checked against minimumReleaseAge`.
 * Nothing in the fleet could have reported it beforehand.
 */
/**
 * The scope globs a workspace's `@wolffm/*` dependencies are installed UNDER.
 * pnpm judges the release age of an npm alias by its REAL name, so
 * `"@wolffm/x": "npm:@hadoku/x@1.2.3"` is exempted by `@hadoku/*`, and
 * `@wolffm/*` exempts nothing (cardtable since 359b5647, fleet-manager#19).
 * A plain range is installed as itself. A manifest that names `@wolffm/` only
 * outside its dependency maps, or does not parse, keeps the old demand.
 */
export function cooldownScopes(manifestTexts) {
	const scopes = new Set();
	for (const text of manifestTexts) {
		let pkg;
		try {
			pkg = JSON.parse(text);
		} catch {
			scopes.add('@wolffm/*');
			continue;
		}
		for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
			for (const [name, spec] of Object.entries(pkg?.[key] ?? {})) {
				if (!name.startsWith('@wolffm/')) continue;
				const alias = /^npm:(@[^/]+)\//.exec(String(spec));
				scopes.add(alias ? `${alias[1]}/*` : '@wolffm/*');
			}
		}
	}
	if (!scopes.size) scopes.add('@wolffm/*');
	return [...scopes].sort();
}

/**
 * The text of one YAML key's value — its inline remainder plus every line that
 * belongs to it — or `null` when the key is absent. `src` must already be
 * comment-blanked.
 *
 * Indentation-scoped, not parsed: a following line belongs to the key while it
 * is blank, indented deeper than the key, or a `- ` item at the key's own
 * indentation (YAML allows a block sequence flush with its parent key). The
 * first line back at or above the key's level that is not such an item ends
 * the value.
 */
export function yamlKeyBlock(src, key) {
	const lines = src.split('\n');
	const head = new RegExp(`^(\\s*)${key}\\s*:(.*)$`);
	for (let i = 0; i < lines.length; i++) {
		const m = head.exec(lines[i]);
		if (!m) continue;
		const indent = m[1].length;
		const out = [m[2]];
		for (let j = i + 1; j < lines.length; j++) {
			const l = lines[j];
			if (!l.trim()) {
				out.push(l);
				continue;
			}
			const lead = l.length - l.trimStart().length;
			if (lead > indent || (lead === indent && l.trimStart().startsWith('-'))) out.push(l);
			else break;
		}
		return out.join('\n');
	}
	return null;
}

export function checkReleaseAgeCooldown(repo, source, files) {
	// The workspace root is NOT always the repo root. tenhands and pygmalion
	// keep theirs at `frontend/`, and a rule that only reads the repo root
	// reported both as having no config at all — a false finding, which is the
	// fastest way to get a gate ignored. Find every workspace file instead.
	const wsFiles = files.filter(
		(f) =>
			(f === 'pnpm-workspace.yaml' || f.endsWith('/pnpm-workspace.yaml')) &&
			!f.includes('node_modules/')
	);
	if (wsFiles.length === 0) {
		report(
			repo,
			'release-age-cooldown',
			'consumes @wolffm/* but has no pnpm-workspace.yaml anywhere, so nothing can exempt ' +
				"them from pnpm 11.5's DEFAULT 24h release-age cooldown — a freshly published " +
				'version fails install with ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION.'
		);
		return;
	}

	for (const ws of wsFiles) {
		const prefix = ws.slice(0, ws.length - 'pnpm-workspace.yaml'.length);
		// Only workspaces that actually resolve @wolffm/* are gated by this. A
		// repo may carry a second workspace (a POC, a vendored sample) with no
		// first-party dependency at all, and demanding an exemption there would
		// be noise.
		const manifests = files.filter(
			(f) =>
				f.startsWith(prefix) &&
				f.endsWith('package.json') &&
				!f.includes('node_modules/') &&
				/"@wolffm\//.test(readFile(source, f) || '')
		);
		if (!manifests.length) continue;
		const scopes = cooldownScopes(manifests.map((f) => readFile(source, f) || ''));

		const raw = readFile(source, ws);
		if (raw === null) continue;
		// blankComments is for JS; this is YAML, where prose starts with `#`.
		// Every repo that gets this right explains WHY in a comment naming both
		// the key and the glob, so reading the raw text would let the
		// explanation satisfy the rule while the setting itself is absent — the
		// gate would pass on documentation. Strip from an unquoted `#` to EOL.
		const src = raw.replace(/(^|\s)#[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

		// `minimumReleaseAge: 0` disables the check outright — a legitimate
		// opt-out (registry, task-mobile), and the verification step then never
		// runs at all.
		if (/^\s*minimumReleaseAge:\s*0\s*$/m.test(src)) continue;

		// The exclude list, being YAML, may be a block or a flow sequence. The
		// glob must sit INSIDE that key's own value. This used to accept
		// `@wolffm/*` anywhere after the key, on the theory that the glob appears
		// nowhere else — but `onlyBuiltDependencies`, `overrides` and
		// `catalog` all take package globs, and any of them following an exclude
		// list that lacks the scope satisfied the rule while pnpm still gated it.
		const block = yamlKeyBlock(src, 'minimumReleaseAgeExclude');
		const missing = scopes.filter((g) => block === null || !block.includes(g));
		if (!missing.length) continue;

		report(
			repo,
			'release-age-cooldown',
			`${ws} resolves @wolffm/* through ${scopes.join(', ')} but ` +
				(block !== null
					? `its minimumReleaseAgeExclude does not contain ${missing.join(', ')}, `
					: 'declares no minimumReleaseAgeExclude, ') +
				"so pnpm 11.5's DEFAULT 24h release-age cooldown gates them — a freshly " +
				'published version fails install with ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION. ' +
				`Add to ${ws}:  minimumReleaseAgeExclude: [${missing.map((g) => `'${g}'`).join(', ')}]  ` +
				'(the SCOPE GLOB — a pinned name@version entry never matches).'
		);
	}
}

/** Leading integer of a semver-ish range (`^4.7.3` -> 4). null when unparseable. */
export function majorOf(v) {
	const m = /(\d+)/.exec(String(v ?? ''));
	return m ? Number(m[1]) : null;
}

const latestCache = new Map();
/**
 * Packages whose latest version could not be read. A `null` from here is
 * indistinguishable at the call site from "nothing to compare", and the
 * staleness rules skip on it — so an unauthenticated run (no NODE_AUTH_TOKEN
 * for npm.pkg.github.com) silently disables `stale-package` and `stale-peer`
 * and the audit still prints OK. Recording the misses is what lets `--json`
 * say so, and the cron fail on it.
 */
export const registryMisses = new Set();
export function latestVersion(pkg, { noRegistry } = {}) {
	if (noRegistry) return null;
	if (latestCache.has(pkg)) return latestCache.get(pkg);
	let v = null;
	try {
		v = execFileSync('npm', ['view', pkg, 'version', '--registry', REGISTRY], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		v = null;
	}
	if (!v) registryMisses.add(pkg);
	latestCache.set(pkg, v);
	return v;
}

/**
 * `types-entry` — does `exports["."].types` name the declaration the build
 * actually emits?
 *
 * These packages build their lib with vite from `src/entry.tsx` and force the
 * output filename to `index.js`, while `tsc` emits declarations mirroring
 * `src/`. So the JS is `dist/index.js` and the types are `dist/entry.d.ts` —
 * two different basenames, which is the whole trap. Six of nine repos declared
 * `./dist/index.d.ts`, a file no step produces, and three declared the correct
 * path. Nothing could see the split: the types entry is only resolved by a
 * CONSUMER importing the package, so the owning repo builds, lints, typechecks
 * and publishes green forever while shipping types that resolve to nothing.
 *
 * Checked from committed source alone (no dist/, which is gitignored): compare
 * the basename in `exports["."].types` against the basename of vite's lib
 * entry. Repos with no lib entry (workers, apps that serve their own UI) have
 * no such contract and are skipped.
 */
export function checkTypesEntry(repo, source) {
	const rawPkg = readFile(source, 'package.json');
	if (!rawPkg) return;
	let pkg;
	try {
		pkg = JSON.parse(rawPkg);
	} catch {
		return;
	}
	const dot = pkg.exports?.['.'];
	const types = dot && typeof dot === 'object' ? dot.types : null;
	if (!types) return;

	const viteCfg = readFile(source, 'vite.config.ts');
	if (!viteCfg) return;
	// `lib: { entry: 'src/entry.tsx', ... }` — the declaration tsc emits for it
	// keeps that basename.
	const m = viteCfg.match(/entry:\s*['"]([^'"]+)['"]/);
	if (!m) return;
	const stem = m[1].replace(/^.*\//, '').replace(/\.[jt]sx?$/, '');
	const expected = `./dist/${stem}.d.ts`;
	if (types !== expected) {
		report(
			repo,
			'types-entry',
			`exports["."].types is ${types}, but vite's lib entry is ${m[1]} so tsc emits ${expected} — the declared path resolves to nothing for consumers`
		);
	}
}

/**
 * THE CATALOGUE — what hadoku.me calls each app, and which repo builds it.
 *
 * `spec/categories.json` in hadoku_site is the single source of an app's
 * display name: it renders the homepage tiles AND, through `spec/app-labels.ts`,
 * titles the browser tab on every /<app>/ route. `scripts/child-apps.json` is
 * the only place that says which repo an app id belongs to.
 *
 * Read through `openRepo`, so the catalogue comes from the SAME ref as every
 * child repo this compares it against — the shipped default branch by default,
 * the working copy under --worktree. Reading the site's working tree directly
 * instead looks harmless and is not: `~/repos/hadoku_site` only fast-forwards on
 * an ecosystem reload or the daily repos:main-sync, so it routinely lags main by days.
 * The first draft of this rule did exactly that and reported four apps as having
 * "no catalogue entry" — they had been added to categories.json a week earlier
 * and the checkout had simply not caught up.
 */
let catalogueCache = null;
export function catalogue() {
	if (catalogueCache) return catalogueCache;
	const site = openRepo(hubRepo());
	const labels = new Map();
	const repoToId = new Map();
	let readable = !site.unreadable;
	try {
		const cats = JSON.parse(readFile(site, 'spec/categories.json'));
		for (const c of cats.categories ?? []) for (const a of c.apps ?? []) labels.set(a.id, a.label);
		// F7 (plan §4.1): `read` replaces path resolution entirely — `site` is a
		// ref-pinned handle (the hub's shipped branch, or the working copy under
		// --worktree), never a plain siteRoot() directory; see this function's
		// own header for why that ref has to match the child repos being audited.
		const kids = readChildApps({ read: (file) => readFile(site, file) });
		if (!kids.ok) throw new Error(kids.why);
		// A repo may own SEVERAL ids — a PPE twin, a worker, a tunnel — and only
		// one of them need have a tile. Last-wins kept whichever row came last:
		// hadoku-cardtable's cardtable-ppe row (2026-10-23) shadowed cardtable
		// and reported the repo uncatalogued every night (fleet-manager#4).
		for (const a of kids.doc.apps ?? []) {
			if (!a.repoName) continue;
			if (!repoToId.has(a.repoName)) repoToId.set(a.repoName, []);
			repoToId.get(a.repoName).push(a.id);
		}
	} catch {
		readable = false;
	}
	catalogueCache = { labels, repoToId, readable: readable && labels.size > 0 && repoToId.size > 0 };
	return catalogueCache;
}

/**
 * The `title` a JSX element passes to <AppHeader>, as source text.
 *
 * Two shapes are legal per AppHeaderProps: a string, which is wrapped in an
 * <h1>, and a node, for a clickable title. So this returns `{kind, text}` —
 * 'string' when the prop is a literal, 'node' with the node's own source when
 * it is an expression, and null when there is no title at all.
 *
 * Brace-matched rather than regexed to the first `>`: a node title contains its
 * own tags (`title={<button ...><h1>Data Platform</h1></button>}`), so the first
 * `>` after `title=` belongs to the BUTTON, not to <AppHeader>. Scanning to it
 * silently truncates the one shape this has to read.
 */
export function appHeaderTitle(src) {
	const at = src.indexOf('<AppHeader');
	if (at < 0) return null;
	const t = src.indexOf('title=', at);
	if (t < 0) return null;
	let i = t + 'title='.length;
	while (i < src.length && /\s/.test(src[i])) i++;
	if (src[i] === '"' || src[i] === "'") {
		const q = src[i];
		const end = src.indexOf(q, i + 1);
		if (end < 0) return null;
		return { kind: 'string', text: src.slice(i + 1, end) };
	}
	if (src[i] !== '{') return null;
	let depth = 0;
	for (let j = i; j < src.length; j++) {
		if (src[j] === '{') depth++;
		else if (src[j] === '}' && --depth === 0) {
			return { kind: 'node', text: src.slice(i + 1, j) };
		}
	}
	return null;
}

/**
 * `header-name` — the header calls the app something the catalogue does not.
 *
 * The tab and the header are two renderings of ONE name, and until 2026-09-09
 * nothing held them together: hadoku_site titled the tab from the catalogue
 * while each child repo hard-coded its own string literal, so the two could
 * disagree indefinitely and did. /craft/ shipped a tab reading "Craft" over a
 * header reading "Hadoku Craft"; /aggregator/ ran three names at once ("OSS
 * Issues" in the tab, "OSS Recon Dashboard" in the header, "OSS Issue
 * Aggregator" in the dev shell). `no-app-header` above could not see any of it —
 * it asks only whether <AppHeader> is PRESENT, so it reported "no drift" across
 * fifteen repos the whole time.
 *
 * Blind spots are findings, not skips, for the reason this script already
 * applies to an unreachable npm registry: "I could not look" must never render
 * as "nothing is wrong".
 *   - `header-name-unverified` — a title this cannot read (an expression with no
 *     <h1> in it, or a name the catalogue has no entry for).
 *   - `catalogue-unreadable` — reported once, against hadoku_site itself, by
 *     `reportCatalogueBlindness` after the fleet loop. The comment promising
 *     that sat over a bare `return` for a month with nothing outside the loop
 *     to keep it, so an unreadable catalogue silenced both rules fleet-wide.
 */
export const catalogueBlindFor = [];
export function checkHeaderName(repo, source, appRoots) {
	const { labels, repoToId, readable } = catalogue();
	if (!readable) {
		if (appRoots.length) catalogueBlindFor.push(repo);
		return;
	}
	for (const f of appRoots) {
		const src = readBlanked(source, f);
		if (!src) continue;
		const title = appHeaderTitle(src);
		if (!title) continue; // no <AppHeader> at all — `no-app-header` owns that

		const appId = (repoToId.get(repo) ?? []).find((id) => labels.has(id));
		if (!appId) {
			report(
				repo,
				'header-name-unverified',
				`${f} — no catalogue entry for this repo, so the header name cannot be checked. ` +
					`Give the app a spec/categories.json entry in ${hubRepo()} (and a scripts/child-apps.json repoName), ` +
					`which is also what stops labelFor() falling back to capitalising the route slug.`
			);
			continue;
		}
		const want = labels.get(appId);

		// DERIVED is the pass condition, not "matches the catalogue".
		//
		// Until 2026-09-10 this rule compared a hard-coded literal against the
		// catalogue and passed when they were equal. That is a weaker property
		// than it looks: two copies of a name held equal by a nightly check still
		// drift for a day, and every new app was BORN with a literal because the
		// scaffolder substituted one. @wolffm/catalogue removed the reason to
		// write one down — a child app takes `appName` from the host at runtime
		// and `__HADOKU_APP_NAME__` (vite `define`, filled from the catalogue at
		// config time) when it runs standalone — so a literal is now a REGRESSION
		// rather than a thing to check, and is reported even when it happens to
		// read correctly.
		const DERIVED = /__HADOKU_APP_NAME__|\bappName\b/;

		if (title.kind === 'string') {
			report(
				repo,
				'header-name-hardcoded',
				`${f} — <AppHeader title="${title.text}"> writes the app's name into this repo. ` +
					`The catalogue says "${want}"; take it from there instead: ` +
					`title={appName ?? __HADOKU_APP_NAME__}, with @wolffm/catalogue wired in ` +
					`vite.config.ts. See templates/ui-app in ${hubRepo()}.`
			);
			continue;
		}

		// A node title. Derived if the expression names either source anywhere in
		// it — that covers the clickable-title shape, where the name sits inside
		// an <h1> nested in a <button>.
		if (DERIVED.test(title.text)) continue;

		// `title={title}` over a same-file `const title = …` is the same
		// expression one indirection away, and pygmalion writes it that way
		// deliberately, to comment on why the name is constant across screens.
		// Following it is the difference between a rule that reads code and one
		// that pushes repos to inline an expression purely to satisfy the audit.
		const ident = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(title.text);
		if (ident) {
			const decl = new RegExp(
				`\\b(?:const|let|var)\\s+${ident[1]}\\s*(?::[^=]+)?=\\s*([^\\n]+)`
			).exec(src);
			if (decl) {
				if (DERIVED.test(decl[1])) continue;
				const lit = /^\s*['"`]([^'"`]*)['"`]/.exec(decl[1]);
				if (lit) {
					report(
						repo,
						'header-name-hardcoded',
						`${f} — \`const ${ident[1]} = ${lit[0].trim()}\` writes the app's name into ` +
							`this repo, and <AppHeader title={${ident[1]}}> renders it. The catalogue ` +
							`says "${want}"; assign the derived name instead.`
					);
					continue;
				}
			}
		}

		const h1 = /<h1[^>]*>([^<{]+)<\/h1>/.exec(title.text);
		if (h1) {
			report(
				repo,
				'header-name-hardcoded',
				`${f} — the header's <h1> writes the literal "${h1[1].trim()}". ` +
					`The catalogue says "${want}"; render the derived name inside the node instead.`
			);
			continue;
		}

		report(
			repo,
			'header-name-unverified',
			`${f} — <AppHeader title={…}> names neither \`appName\` nor \`__HADOKU_APP_NAME__\`, ` +
				`and has no readable <h1>, so this cannot tell whether the name is derived. ` +
				`The catalogue says "${want}".`
		);
	}
}

/**
 * `no-favicon` — an entry shell that declares no icon.
 *
 * A page with no <link rel="icon"> does not inherit one: the browser asks for
 * /favicon.ico, that 404s on hadoku.me, and the tab renders the generic globe.
 * Three apps shipped that way (promptsmith, merchant, filetransfer) and a fourth
 * pointed at /watchparty/favicon.png, which returns the SPA shell as text/html —
 * a declared icon that is not an image fails exactly like none.
 *
 * SCOPED TO THE VITE ENTRY, meaning an index.html sitting beside a vite.config.
 * That is what "the app's shell" actually means, and nothing looser works: a
 * bare "any index.html" draft flagged a test fixture, a dev icon gallery, a
 * WASM asset mount and two backend static dirs — five findings, none of them a
 * surface with a tab. A rule whose output has to be filtered by hand is one
 * nobody reads.
 */
export function checkFavicon(repo, source, files) {
	const viteDirs = new Set(
		files
			.filter((f) => /(^|\/)vite\.config\.[cm]?[jt]s$/.test(f))
			.map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''))
	);
	const shells = files.filter((f) => {
		if (!/(^|\/)index\.html$/.test(f)) return false;
		const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
		return viteDirs.has(dir);
	});
	for (const f of shells) {
		const src = readFile(source, f);
		if (!src) continue;
		// HTML comments out first: `<!-- <link rel="icon" …> -->` is an icon
		// somebody switched off, and the tab renders the globe exactly as if the
		// line were gone.
		if (!/rel=["']icon["']/i.test(src.replace(/<!--[\s\S]*?-->/g, ''))) {
			report(
				repo,
				'no-favicon',
				`${f} — the vite entry shell declares no <link rel="icon">, so the tab falls back ` +
					`to /favicon.ico, which 404s on hadoku.me. Add: ` +
					`<link rel="icon" type="image/svg+xml" href="/favicon.svg">`
			);
		}
	}
}

/**
 * The repo's age in hours, measured from the FIRST commit reachable from its
 * shipped default branch — a read-only proxy for "when was this repo created"
 * that needs no GitHub REST call. Read from the fleet-source mirror, which is a
 * full-history (blobless, never shallow) fetch, so the earliest commit it holds
 * is the repo's real first commit.
 *
 * `null` whenever that date cannot be trusted or read at all. The call site
 * treats `null` as "could not look", which fails the grace exactly as it fails
 * everywhere else in this script — never silently passes.
 */
export function repoAgeHours(name, { noFetch } = {}) {
	const source = tryShipped(qualifyRepo(name), { fetch: !noFetch });
	if ('unreadable' in source) return null;
	const epochSec = source.firstCommitSec();
	return epochSec === null ? null : (Date.now() - epochSec * 1000) / 3_600_000;
}

/**
 * The owner's own (non-fork), non-archived, non-empty repos, by bare name — the universe the
 * `not-in-fleet` check compares the roster against. `{ names }`, or `{ reason }`
 * when the listing failed every attempt. It used to be "every directory under
 * REPOS_DIR", which is the operator's checkouts, not the account: a cron host
 * with no `~/repos` read an empty universe and reported a complete roster.
 */
export function ownerRepos() {
	let last = '';
	for (let i = 0; i < READ_ATTEMPTS; i++) {
		try {
			const out = execFileSync(
				'gh',
				[
					'repo',
					'list',
					fleetOwner(),
					'--limit',
					'1000',
					'--no-archived',
					'--json',
					'nameWithOwner,isEmpty,isFork',
				],
				{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }
			);
			// NOT FORKS. The account forks upstream projects (microsoft-vscode,
			// nodejs-node, 34 of them on 2026-10-24) that are other people's code
			// and no @wolffm consumer; mirroring them cost 1.2 GB and 7 minutes cold.
			const names = JSON.parse(out)
				.filter((r) => !r.isEmpty && !r.isFork)
				.map((r) => r.nameWithOwner.split('/')[1]);
			if (!names.length) return { reason: `gh repo list ${fleetOwner()} returned ZERO repos` };
			return { names };
		} catch (err) {
			last = String(err?.stderr || err?.message || err)
				.trim()
				.split('\n')
				.pop();
		}
	}
	return { reason: last || 'gh repo list failed' };
}
