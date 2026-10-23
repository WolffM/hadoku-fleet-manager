#!/usr/bin/env node
/**
 * Fleet-wide audit of the unified header + always-latest package policy.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two ecosystem rules are now enforced at compile time inside
 * @wolffm/task-ui-components 3.x — AppHeader renders the theme picker and the
 * settings gear itself, and the raw pickers are no longer exported, so an app
 * physically cannot substitute them. That enforcement only bites once a repo
 * is ON 3.x. A repo pinned to 2.x keeps its old private picker and compiles
 * happily forever.
 *
 * So the thing that actually needs auditing is not "does this app pass a
 * themePicker" (the type system answers that) but "is this app still on a
 * version where it could". Which makes staleness the primary check, and the
 * always-latest policy the thing that closes the loop.
 *
 * This is the same shape as check-tier-fleet.mjs and check-key-sync.mjs: a
 * hadoku_site script that audits sibling checkouts, because hadoku_site is the
 * only place that knows what the whole ecosystem is supposed to agree on.
 *
 * WHAT IT READS
 * -------------
 * `origin/main` of each repo, fetched first — what is SHIPPED, not what happens
 * to be on disk. Scanning working copies makes the result meaningless: a local
 * checkout may be behind origin (reporting drift already fixed) or dirty
 * (reporting drift nobody pushed). `--worktree` scans the working copies, which
 * is what you want while fixing things.
 *
 * WHAT IT CANNOT DO
 * -----------------
 * It is an AUDIT, not a gate. It cannot block a child repo's CI — only that
 * repo can. It reports; a human or a cron acts.
 *
 * THE RULES
 * ---------
 *   stale-package   a @wolffm/* dependency is not at the registry's latest.
 *                   Always-latest is the policy, majors included.
 *   stale-peer      a @wolffm/* peerDependency uses a caret/tilde/exact range.
 *                   pnpm update --latest never touches peers, so those ranges
 *                   rot when the fleet crosses a major (six repos sat on
 *                   ^3.0.0 while installing tuic 4.x). Peers must be floors
 *                   (`>=x.y.z`), which cannot go stale. Applies to templates
 *                   too — a caret peer there scaffolds apps pre-drifted.
 *   release-age-cooldown
 *                   the repo consumes @wolffm/* but does not exempt them
 *                   from pnpm's release-age cooldown. pnpm 11.5 DEFAULTS
 *                   minimum-release-age to 24h, so the exposed repos are
 *                   the ones that configure nothing — always-latest then
 *                   installs a version too young to pass, and the repo
 *                   fails ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION on the
 *                   next publish. The exemption must be the scope glob.
 *   no-update-flow  the repo consumes @wolffm/* but has no update-wolffm.yml.
 *                   pygmalion sat like this from creation: nothing ever updated
 *                   it, and nothing ever said so.
 *   no-landing-path the update workflow does not use the shared
 *                   `update-wolffm` action, the only thing that can land a bump
 *                   on a protected main without a PAT. A hand-rolled push is
 *                   rejected — but only when there is something to push, so
 *                   the repo sits green until the first real update, then
 *                   silently freezes.
 *   private-picker  a raw ThemePicker/ConnectedThemePicker import, or a local
 *                   hooks/useTheme.ts + prefs/themePrefs.ts copy. Impossible on
 *                   3.x, so finding one means the repo is stale in a way that
 *                   matters — it still has the drift the lockdown removed.
 *   no-app-header   a React app root that renders no <AppHeader>.
 *   header-name-hardcoded
 *                   the <AppHeader> title writes the app's NAME into the child
 *                   repo. Reported even when the literal happens to match the
 *                   catalogue: two copies held equal by a nightly check still
 *                   drift for a day, and that is exactly how /craft/ came to ship
 *                   a "Craft" tab over a "Hadoku Craft" header. @wolffm/catalogue
 *                   publishes spec/categories.json, so a child app can take
 *                   `appName` from the host at runtime and `__HADOKU_APP_NAME__`
 *                   (vite `define`) when standalone — there is no longer a reason
 *                   to write one down. `no-app-header` cannot see any of this: it
 *                   asks only whether the header is PRESENT, which is why it
 *                   reported "no drift" across fifteen repos the whole time.
 *   header-name-unverified
 *                   a title this could not READ — an expression with no <h1>, or
 *                   a repo the catalogue has no entry for. A blind spot is a
 *                   finding, never a skip; same principle as registry blindness
 *                   below.
 *   no-favicon      an index.html entry shell with no <link rel="icon">. Nothing
 *                   inherits one: the browser asks for /favicon.ico, that 404s on
 *                   hadoku.me, and the tab renders the generic globe.
 *
 * RETIRED: `not-in-fanout` (2026-08-26), and this is the only record of it —
 * it is still named as a rule in scripts/CLAUDE.md. It asked whether a repo was
 * a child-apps.json consumer (`repoName != null`) and said "publishes never
 * reach it". That stopped being true on 2026-08-23, when wolffm-fanout.ts moved
 * its derivation to fleet-runner-coverage.json's `wolffmConsumer` facet
 * precisely because `repoName` "answered the wrong question" (it includes tunnel
 * services shipping no JavaScript); that commit records ArchiveBot as GAINED.
 * So the rule outlived its premise and reported ArchiveBot — a declared
 * wolffmConsumer of @wolffm/logger the fan-out had been reaching for months — as
 * unreachable, every run. Repointing it at the facet was the obvious repair and
 * the wrong one: `not-in-fleet` already compares against exactly that facet, so
 * the repointed rule could only ever agree with it. Deleted rather than fixed —
 * a rule that cannot be wrong in a way its neighbour is not already wrong is not
 * coverage, and this one cost a false positive that blocked scheduling the audit.
 *
 * NOT A RULE: a file merely named *Settings*. craft's SettingsPanel is
 * print-job settings (sticker / duplex / tiling / calibration), nothing to do
 * with user settings, and keying on the word would flag it every run.
 *
 * USAGE
 *   fleet header-audit             # audit origin/main, exit 1 on drift
 *   fleet header-audit --worktree  # audit the working copies
 *   fleet header-audit --warn      # report, always exit 0
 *   fleet header-audit --no-fetch  # skip the fetch (offline)
 *   fleet header-audit --no-registry  # skip npm view (offline)
 *   fleet header-audit --json      # machine-readable, for ci:header-fleet
 *   REPOS_DIR=/path fleet header-audit
 *
 * `--json` exists so the cron can consume this without scraping the human
 * output, and it reports REGISTRY BLINDNESS as a first-class field. That is not
 * decoration: `latestVersion` swallows every npm failure into `null` and the
 * staleness rules then skip silently, so an unauthenticated run reports "no
 * drift" while two of the rules checked nothing at all. The job treats a
 * registry it could not reach as a failure, on the same principle
 * ci:fleet-toolchain applies to an unreachable node — "I could not look" must
 * never render as "nothing is wrong".
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { namesWith } from './lib/fleet-roster.mjs';
import { reposDir } from './lib/sibling-repos.mjs';
import { blankComments } from './lib/blank-comments.mjs';
import { stripYamlComments } from './lib/yaml-comments.mjs';
import { manifest as manifestFile, siteRoot } from './lib/paths.mjs';
import { createEmitter } from './lib/emit.mjs';
import { hubRepo } from '../dist/lib/fleet-config.js';

const REPO_ROOT = siteRoot();
const ALLOWLIST_JSON = manifestFile('header-fleet-allowlist.json');

const REGISTRY = 'https://npm.pkg.github.com';

/**
 * The one ref every read is taken at. `--worktree` does not audit a DIFFERENT
 * ref — it reads the working copy instead of a ref at all — so there has never
 * been a second value here, and threading it through six signatures only made
 * that harder to see.
 */
const REF = 'origin/main';

/**
 * Repos subject to the unified-header policy: those consuming
 * `@wolffm/task-ui-components`, which is what ships `AppHeader`.
 *
 * DERIVED from the one roster (`fleet-runner-coverage.json` facets), never
 * hand-listed. The array this replaces held 14 repos while the tier checker
 * held 15 and coverage held 24; `hadoku-filetransfer` consumes the package in
 * `packages/ui/package.json` and had never been added, so every rule below
 * silently skipped it. See scripts/admin/lib/fleet-roster.mjs.
 */
const FLEET = namesWith('uiApp');

/** Every covered repo that consumes any @wolffm package — the `not-in-fleet` yardstick. */
const KNOWN_CONSUMERS = namesWith('wolffmConsumer');

const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has('--json');
// One stdout discipline, shared — see lib/emit.mjs. Everything human goes
// through `log` and is held in --json mode; `emit` is the only stdout write.
// This file used `process.stdout.write` directly and was correct only by
// SOURCE ORDER: every console.log below sat under the JSON branch's exit.
const emitter = createEmitter({ json: JSON_OUT });
const log = emitter.log;
const USE_WORKTREE = args.has('--worktree');
const WARN_ONLY = args.has('--warn');
const NO_FETCH = args.has('--no-fetch');
const NO_REGISTRY = args.has('--no-registry');

/** Exemptions keyed `repo:rule` or `repo:path`. Every entry needs a `why`, and
 *  an entry that stops matching FAILS — an exemption must not outlive its
 *  reason. Mirrors tier-fleet-allowlist.json. */
function loadAllowlist() {
	let obj;
	try {
		obj = JSON.parse(readFileSync(ALLOWLIST_JSON, 'utf8'));
	} catch (err) {
		if (err.code === 'ENOENT') return new Map();
		throw err;
	}
	const map = new Map();
	for (const entry of obj.allowed || []) {
		if (!entry.key || !entry.why) {
			refuse(`allowlist entry missing "key" or "why": ${JSON.stringify(entry)}`);
		}
		map.set(entry.key, entry);
	}
	return map;
}

/**
 * Stop the run on a fault in this script's OWN inputs, keeping `--json`
 * parseable.
 *
 * A bare `console.error` + `exit(1)` printed nothing to stdout, and
 * ci:header-fleet reads stdout BEFORE the exit code — so a malformed allowlist
 * entry surfaced as "checker produced no JSON", i.e. "the checker broke",
 * rather than as the one-line config fault it is. The document carries the
 * fault as a finding as well as `error`, because the consumer fails a run with
 * zero `repos` before it reads anything else, and a finding is the field it
 * already turns into a readable page.
 */
function refuse(message) {
	if (JSON_OUT) {
		emitter.emit({
			error: message,
			repos: FLEET.length,
			findings: [{ repo: 'header-fleet-allowlist', rule: 'allowlist-invalid', detail: message }],
			advisory: [],
			staleExemptions: [],
		});
	} else {
		console.error(`✗ ${message}`);
	}
	process.exit(1);
}

function git(repoPath, argv) {
	return execFileSync('git', ['-C', repoPath, ...argv], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
	});
}

/** Files tracked on the ref being audited. */
function listFiles(repoPath) {
	const out = USE_WORKTREE
		? git(repoPath, ['ls-files'])
		: git(repoPath, ['ls-tree', '-r', '--name-only', REF]);
	return out.split('\n').filter(Boolean);
}

/** Read a path at a ref regardless of --worktree; the coverage pass always
 *  wants what is SHIPPED, since that is what the fan-out acts on. */
function readFileAt(repoPath, file) {
	try {
		return git(repoPath, ['show', `${REF}:${file}`]);
	} catch {
		return null;
	}
}

/**
 * One read per file per repo, not one per RULE.
 *
 * Three separate passes over the source list each called this on overlapping
 * sets, so every file was fetched from git two or three times and re-blanked
 * each time — roughly 900 `git show` subprocesses per run where 300 would do.
 * The rules are kept separate deliberately (each is its own finding with its own
 * rationale); it is the READ that should not be repeated.
 *
 * Cleared per repo in the fleet loop, so the cache is one repo's files at a
 * time rather than fifteen repos' worth held at once.
 */
const fileCache = new Map();
const blankCache = new Map();

function resetFileCache() {
	fileCache.clear();
	blankCache.clear();
}

function readFile(repoPath, file) {
	const key = `${repoPath}\u0000${file}`;
	if (fileCache.has(key)) return fileCache.get(key);
	let out;
	try {
		out = USE_WORKTREE
			? readFileSync(resolve(repoPath, file), 'utf8')
			: git(repoPath, ['show', `${REF}:${file}`]);
	} catch {
		out = null;
	}
	fileCache.set(key, out);
	return out;
}

/** `blankComments` over a cached read — the second half of the same waste. */
function readBlanked(repoPath, file) {
	const key = `${repoPath}\u0000${file}`;
	if (blankCache.has(key)) return blankCache.get(key);
	const raw = readFile(repoPath, file);
	const out = raw === null ? null : blankComments(raw);
	blankCache.set(key, out);
	return out;
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
const registryMisses = new Set();
function latestVersion(pkg) {
	if (NO_REGISTRY) return null;
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
 * The patterns and predicates the FLEET pass and the TEMPLATE pass both apply.
 *
 * Both halves genuinely run the same rules over different inputs — a fleet repo
 * has drifted, a template scaffolds every future app pre-drifted — so what they
 * share is the DEFINITION, not the finding: each half words its own message,
 * because "declares" and "scaffolds" are different claims about the world. Left
 * inline they were three verbatim copies apiece, which is exactly how one half
 * gets tightened and the other silently keeps passing.
 *
 * The picker-import pattern used to be spelt as two regexes on the fleet side
 * (`ConnectedThemePicker` and `ThemePicker` separately) and as this one on the
 * template side; `\b` before `ThemePicker` cannot match inside
 * `ConnectedThemePicker`, so the union of the two is exactly this language.
 */
const LOCAL_THEME_MODULE =
	/(^|\/)(hooks\/useTheme|prefs\/themePrefs|app\/themeConfig)\.(tsx?|jsx?)$/;
const RAW_PICKER_IMPORT =
	/\bimport\s*\{[^}]*\b(Connected)?ThemePicker\b[^}]*\}\s*from\s*['"]@wolffm\/task-ui-components['"]/;
const THEME_PICKER_PROP = /\bthemePicker\s*=\s*\{/;

/** The @wolffm peerDependencies of one manifest, as `{ name, r }`. */
function wolffmPeers(pkg) {
	return Object.entries(pkg.peerDependencies || {})
		.filter(([name]) => name.startsWith('@wolffm/'))
		.map(([name, range]) => ({ name, r: String(range) }));
}

/** A peer range that cannot rot: a floor, a workspace link, or no claim at all. */
function peerRangeIsSound(r) {
	return r.startsWith('workspace:') || r === '*' || r.startsWith('>=');
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
function checkNpmAuthForm(repo, repoPath, files) {
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
		const raw = readFile(repoPath, f);
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
function yamlKeyBlock(src, key) {
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

function checkReleaseAgeCooldown(repo, repoPath, files) {
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
		const consumes = files.some(
			(f) =>
				f.startsWith(prefix) &&
				f.endsWith('package.json') &&
				!f.includes('node_modules/') &&
				/"@wolffm\//.test(readFile(repoPath, f) || '')
		);
		if (!consumes) continue;

		const raw = readFile(repoPath, ws);
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
		if (block !== null && /@wolffm\/\*/.test(block)) continue;

		report(
			repo,
			'release-age-cooldown',
			`${ws} resolves @wolffm/* but ` +
				(block !== null
					? 'its minimumReleaseAgeExclude does not contain the scope glob, '
					: 'declares no minimumReleaseAgeExclude, ') +
				"so pnpm 11.5's DEFAULT 24h release-age cooldown gates them — a freshly " +
				'published version fails install with ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION. ' +
				`Add to ${ws}:  minimumReleaseAgeExclude: ['@wolffm/*']  ` +
				'(the SCOPE GLOB — a pinned name@version entry never matches).'
		);
	}
}

const findings = [];
/**
 * `meta` is optional structured data for consumers that must not parse the
 * prose. ci:header-fleet needs exactly one thing from it — whether a
 * `stale-package` gap crosses a MAJOR — because that decides whether the finding
 * self-heals. Scraping "declares ^4.7.3, latest is 4.8.1" out of the sentence
 * would put a regex on a human-facing string, which is the coupling that makes
 * a message impossible to reword later.
 */
function report(repo, rule, detail, meta) {
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
const advisories = [];
function reportAdvisory(repo, rule, detail, meta) {
	advisories.push({ repo, rule, detail, key: `${repo}:${rule}`, ...(meta ? { meta } : {}) });
}

/** Leading integer of a semver-ish range (`^4.7.3` -> 4). null when unparseable. */
function majorOf(v) {
	const m = /(\d+)/.exec(String(v ?? ''));
	return m ? Number(m[1]) : null;
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
function checkTypesEntry(repo, dir) {
	const rawPkg = readFile(dir, 'package.json');
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

	const viteCfg = readFile(dir, 'vite.config.ts');
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

const ROOT = reposDir();

/**
 * THE CATALOGUE — what hadoku.me calls each app, and which repo builds it.
 *
 * `spec/categories.json` in hadoku_site is the single source of an app's
 * display name: it renders the homepage tiles AND, through `spec/app-labels.ts`,
 * titles the browser tab on every /<app>/ route. `scripts/child-apps.json` is
 * the only place that says which repo an app id belongs to.
 *
 * Read through `readFile`, so the catalogue comes from the SAME ref as every
 * child repo this compares it against — origin/main by default, the working copy
 * under --worktree. Reading the site's working tree directly instead looks
 * harmless and is not: `~/repos/hadoku_site` only fast-forwards on an ecosystem
 * reload or the daily repos:main-sync, so it routinely lags origin/main by days.
 * The first draft of this rule did exactly that and reported four apps as having
 * "no catalogue entry" — they had been added to categories.json a week earlier
 * and the checkout had simply not caught up.
 */
let catalogueCache = null;
function catalogue() {
	if (catalogueCache) return catalogueCache;
	const site = resolve(ROOT, hubRepo());
	const labels = new Map();
	const repoToId = new Map();
	let readable = existsSync(site);
	try {
		const cats = JSON.parse(readFile(site, 'spec/categories.json'));
		for (const c of cats.categories ?? []) for (const a of c.apps ?? []) labels.set(a.id, a.label);
		const kids = JSON.parse(readFile(site, 'scripts/child-apps.json'));
		for (const a of kids.apps ?? []) if (a.repoName) repoToId.set(a.repoName, a.id);
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
function appHeaderTitle(src) {
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
const catalogueBlindFor = [];
function checkHeaderName(repo, repoPath, appRoots) {
	const { labels, repoToId, readable } = catalogue();
	if (!readable) {
		if (appRoots.length) catalogueBlindFor.push(repo);
		return;
	}
	for (const f of appRoots) {
		const src = readBlanked(repoPath, f);
		if (!src) continue;
		const title = appHeaderTitle(src);
		if (!title) continue; // no <AppHeader> at all — `no-app-header` owns that

		const appId = repoToId.get(repo);
		if (!appId || !labels.has(appId)) {
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
function checkFavicon(repo, repoPath, files) {
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
		const src = readFile(repoPath, f);
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

const allowlist = loadAllowlist();
const matchedExemptions = new Set();

for (const repo of FLEET) {
	resetFileCache();
	const repoPath = resolve(ROOT, repo);
	if (!existsSync(repoPath)) {
		// A finding, not a skip. Silently skipping every repo is how this script
		// printed "OK — no drift" while auditing nothing at all, which is worse
		// than no audit: it actively asserts the fleet is clean.
		report(repo, 'no-checkout', `no checkout at ${repoPath} — nothing was audited for this repo`);
		continue;
	}

	if (!NO_FETCH && !USE_WORKTREE) {
		try {
			execFileSync('git', ['-C', repoPath, 'fetch', 'origin', '--quiet'], { stdio: 'ignore' });
		} catch {
			console.error(`⚠ ${repo}: fetch failed — auditing the last known origin/main`);
		}
	}

	let files;
	try {
		files = listFiles(repoPath);
	} catch (err) {
		// A finding, not a stderr line. This used to log and `continue`, so a
		// checkout with no `origin/main` (a clone that never fetched, a default
		// branch renamed upstream) ran ZERO rules while the summary still said
		// "no drift" — the `no-checkout` trap one step further in, and invisible
		// to ci:header-fleet, which reads stdout only.
		report(
			repo,
			'unreadable',
			`cannot list ${USE_WORKTREE ? 'the working copy' : REF} (${String(err.message || err)
				.split('\n')[0]
				.slice(0, 160)}) — nothing was audited for this repo`
		);
		continue;
	}

	// ---- published types entry resolves ----------------------------------
	checkTypesEntry(repo, repoPath);

	// ---- npm registry auth uses the canonical token ----------------------
	checkNpmAuthForm(repo, repoPath, files);

	// ---- package manifests: staleness -----------------------------------
	const manifests = files.filter((f) => f.endsWith('package.json') && !f.includes('node_modules'));
	let consumesWolffm = false;

	for (const m of manifests) {
		const raw = readFile(repoPath, m);
		if (!raw) continue;
		let pkg;
		try {
			pkg = JSON.parse(raw);
		} catch {
			continue;
		}
		for (const field of ['dependencies', 'devDependencies']) {
			for (const [name, range] of Object.entries(pkg[field] || {})) {
				if (!name.startsWith('@wolffm/')) continue;
				consumesWolffm = true;
				const r = String(range);
				// `workspace:` and `*` are not version claims — nothing to compare.
				if (r.startsWith('workspace:') || r === '*') continue;
				const declared = (r.match(/(\d+\.\d+\.\d+)/) || [])[1];
				const latest = latestVersion(name);
				if (declared && latest && declared !== latest) {
					const dm = majorOf(r);
					const lm = majorOf(latest);
					report(repo, 'stale-package', `${name} in ${m}: declares ${r}, latest is ${latest}`, {
						pkg: name,
						manifest: m,
						declared: r,
						latest,
						// A caret range cannot cross a major, so a major gap does NOT
						// close on its own the way a minor one does — it waits for
						// `pnpm update --latest` and, failing that, forever.
						majorGap: dm !== null && lm !== null && lm > dm,
					});
				}
			}
		}

		// ---- peer ranges must be floors ---------------------------------
		// `pnpm update --latest` (every child's update-wolffm.yml) bumps
		// dependencies/devDependencies but never peerDependencies, so a
		// caret/tilde/exact @wolffm peer goes stale the moment the fleet
		// crosses a major, and every consumer install then trips peer
		// conflicts — six repos sat on peer ^3.0.0 while installing tuic 4.x
		// (found 2026-08-07). Fleet convention: peers declare a floor
		// (`>=x.y.z`), which cannot rot. The real compatibility gate is each
		// child's CI building against actual latest, not this range.
		for (const { name, r } of wolffmPeers(pkg)) {
			consumesWolffm = true;
			if (peerRangeIsSound(r)) continue;
			report(
				repo,
				'stale-peer',
				`${name} in ${m}: peer range '${r}' rots as majors advance — declare a floor ('>=${r.replace(/^[\^~]/, '')}')`
			);
		}
	}

	if (!consumesWolffm) continue;

	// ---- the release-age cooldown must not gate @wolffm/* -----------------
	checkReleaseAgeCooldown(repo, repoPath, files);

	// ---- an update path must exist --------------------------------------
	const updateFlows = files.filter((f) =>
		/^\.github\/workflows\/.*update.*wolffm.*\.ya?ml$/i.test(f)
	);
	if (updateFlows.length === 0) {
		report(
			repo,
			'no-update-flow',
			'consumes @wolffm/* but has no .github/workflows/update-wolffm.yml — nothing will ever update it'
		);
	}

	// ---- ...and it must be able to LAND its result -----------------------
	// The default branch is protected, and a fresh bump has run none of its
	// required checks, so a plain push is rejected — but only when there is
	// actually something to push; with nothing to update the job exits 0 early,
	// so a broken repo sits GREEN indefinitely and the freeze surfaces days
	// later, on the first real payload. Until 2026-10-23 the fix was a PAT
	// checkout that bypassed protection as an admin: HADOKU_SITE_TOKEN, repo +
	// workflow on the whole account, in every consumer. The landing path now
	// is the shared `update-wolffm` action, which pushes a bot branch with the
	// job's own token and has mgmt-api fast-forward main onto it; a repo that
	// still holds the PAT is check-site-token's finding, not this one's.
	for (const f of updateFlows) {
		const raw = readFile(repoPath, f);
		if (!raw) continue;
		// Comment-stripped: a commented-out `uses:` line is not a step that runs.
		if (!/uses:\s*\S+\/update-wolffm@\S+/.test(stripYamlComments(raw))) {
			report(
				repo,
				'no-landing-path',
				`${f} — does not use the shared update-wolffm action, so nothing can land its bump on a protected main; the run stays green until the first real update, then the repo silently freezes`
			);
		}
	}

	// ---- private theme/settings implementations -------------------------
	const sources = files.filter((f) => /\.(tsx?|jsx?)$/.test(f) && !f.includes('node_modules'));
	for (const f of sources) {
		if (LOCAL_THEME_MODULE.test(f)) {
			report(
				repo,
				'private-picker',
				`${f} — a local copy of a module that lives in @wolffm/themes`
			);
			continue;
		}
		const src = readBlanked(repoPath, f);
		if (!src) continue;
		if (RAW_PICKER_IMPORT.test(src)) {
			report(
				repo,
				'private-picker',
				`${f} — imports a raw picker; AppHeader owns it since tuic 3.0.0`
			);
		}
		if (THEME_PICKER_PROP.test(src)) {
			report(repo, 'private-picker', `${f} — passes a themePicker prop, removed in tuic 3.0.0`);
		}
		if (/\bshowSettings\s*=\s*\{/.test(src)) {
			report(repo, 'private-picker', `${f} — passes showSettings, removed in tuic 3.0.0`);
		}
	}

	// ---- an app root should mount the shared header ----------------------
	const appRoots = sources.filter((f) => /(^|\/)App\.(tsx|jsx)$/.test(f));
	for (const f of appRoots) {
		const src = readBlanked(repoPath, f);
		if (!src) continue;
		// RENDERED, not named. A bare-identifier match passed an App.tsx that
		// imports AppHeader and never mounts it — an import left behind by a
		// refactor is exactly the shape a header quietly disappears in.
		if (!/<\s*AppHeader\b/.test(src)) {
			report(repo, 'no-app-header', `${f} — an app root that renders no <AppHeader>`);
		}
	}

	// ---- and it must call the app what the catalogue calls it -------------
	checkHeaderName(repo, repoPath, appRoots);

	// ---- every entry shell declares an icon -------------------------------
	checkFavicon(repo, repoPath, files);

	// ---- the provider must exist wherever the controls are used ----------
	//
	// This rule exists because I shipped exactly this bug: hadoku-watchparty's chat
	// panel was switched to <HadokuThemePicker /> without adding
	// <HadokuThemeRoot> anywhere, so it would have thrown at mount. Nothing
	// caught it — the repo's tests never render that component, and both
	// typecheck and build pass happily, because a missing React context is a
	// runtime fact, not a type error.
	//
	// Repo-wide rather than per-file: the provider legitimately lives at the app
	// root while the consumer sits several components down.
	//
	// NOT the same rule as the templates' `no-provider` below, despite the name:
	// that one is per-FILE (an App.tsx must itself contain both), because a
	// template is a self-contained scaffold with nothing above its root to
	// inherit a provider from. Do not fold the two together — merging would
	// either blind this one to a provider-less app root or make that one accept
	// a provider sitting in some unrelated template file.
	const usesControls = [];
	let hasProvider = false;
	for (const f of sources) {
		const src = readBlanked(repoPath, f);
		if (!src) continue;
		// MOUNTED, not named — same reason as `no-app-header`: an import of the
		// provider that nothing renders provides nothing, and throws at mount
		// exactly as a missing one does.
		if (/<\s*HadokuThemeRoot\b/.test(src)) hasProvider = true;
		if (/<\s*(AppHeader|HadokuThemePicker)\b/.test(src) || /\buseHadokuTheme\s*\(/.test(src)) {
			usesControls.push(f);
		}
	}
	if (usesControls.length > 0 && !hasProvider) {
		report(
			repo,
			'no-provider',
			`uses the shared header/theme controls (${usesControls[0]}${usesControls.length > 1 ? ` +${usesControls.length - 1} more` : ''}) but mounts no <HadokuThemeRoot> — this throws at runtime`
		);
	}
}

// ---- the catalogue the header-name rules read -----------------------------
// Once, here, against the hub — see `checkHeaderName`. Only when some repo
// actually needed it: a fleet with no app roots asked the catalogue nothing.
if (catalogueBlindFor.length) {
	report(
		hubRepo(),
		'catalogue-unreadable',
		`spec/categories.json / scripts/child-apps.json unreadable at ` +
			`${USE_WORKTREE ? 'the working copy' : REF} of ${resolve(ROOT, hubRepo())}, so ` +
			`header-name-hardcoded and header-name-unverified did not run for ` +
			`${catalogueBlindFor.length} repo(s): ${catalogueBlindFor.join(', ')}`
	);
}

/**
 * `new-repo-grace` (#95) — hours a brand-new repo's `not-in-fleet` is advisory
 * rather than failing.
 *
 * hadoku_site's `reconcile-fleet-coverage.yml` is what actually admits a repo
 * into the roster (scheduled `30 12` / `0 14` UTC, observed to fire HOURS
 * late), and nothing else writes it. `ci:header-fleet` runs far more often
 * than that, so a repo created minutes before a run is reliably `not-in-fleet`
 * through no fault of its own — found 2026-10-05 when `hadoku-housemodel`,
 * created 21:04Z, paged `@here` at 06:11Z, hours before the regen could
 * possibly have run. 24h covers the observed worst-case lag with room to
 * spare; past it, an absent roster entry is a real gap again.
 */
const NEW_REPO_GRACE_HOURS = 24;

/**
 * Whether `repoPath`'s clone is too shallow to trust its earliest commit's
 * date as a stand-in for the repo's age.
 *
 * A depth-1 clone's only visible commit is the NEWEST one, not the oldest, so
 * reading "first commit" off one understates age rather than overstating it —
 * exactly backwards for a grace that must never fire on a bad read: it would
 * read a repo that has existed for months as brand new. A fixture proves the
 * shape — a 100-hour-old repo shallow-cloned at its tip reads as 1 hour old
 * unless this is checked first.
 */
function isShallowClone(repoPath) {
	try {
		return git(repoPath, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
	} catch {
		return true; // could not ask — never trust a clone this could not verify
	}
}

/**
 * The repo's age in hours, measured from the checkout's FIRST commit reachable
 * from `REF` — a local, read-only proxy for "when was this repo created" that
 * needs no GitHub call (its `created_at` is the alternative this deliberately
 * avoids; the checkout is already on disk for every other rule in this file).
 *
 * `null` whenever that date cannot be trusted or read at all: a shallow clone
 * (see `isShallowClone`), no commits reachable from `REF`, or a `git log` that
 * fails outright. The call site treats `null` as "could not look", which must
 * fail the grace exactly as it fails everywhere else in this script — never
 * silently pass.
 */
function repoAgeHours(repoPath) {
	if (isShallowClone(repoPath)) return null;
	let out;
	try {
		out = git(repoPath, ['log', REF, '--reverse', '--format=%ct']);
	} catch {
		return null;
	}
	const first = out.split('\n').find(Boolean);
	if (!first) return null;
	const epochSec = Number(first);
	if (!Number.isFinite(epochSec)) return null;
	return (Date.now() - epochSec * 1000) / 3_600_000;
}

// ---- is the FLEET list itself complete? ---------------------------------
//
// Every rule above only inspects repos named in FLEET, and FLEET is derived
// from the coverage manifest (`namesWith('uiApp')`) — so a child app missing
// from THAT is invisible to all of them. Deriving the list moved the problem;
// it did not remove it. That is not hypothetical: conjure was absent from the
// fan-out list until 2026-08-04 and sat on a stale task-ui-components for
// weeks, and pygmalion had NO update path at all from creation until
// 2026-08-05. Both were found by hand, twice, because nothing checked the list
// against reality. This block is that check — the manifest is a claim about the
// world, and the world is what is on disk.
//
// Reality here is "consumes an @wolffm package". Any repo that does is part of
// the ecosystem and must appear in the roster, or carry an allowlist entry
// saying why not. (The fan-out half of that assertion was `not-in-fanout`,
// retired 2026-08-26 — see the header.)
{
	let entries;
	try {
		entries = readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory());
	} catch {
		entries = [];
	}

	for (const e of entries) {
		const repo = e.name;
		if (repo === hubRepo()) continue; // the parent, not a consumer
		const dir = resolve(ROOT, repo);
		if (!existsSync(resolve(dir, '.git'))) continue;

		// Cheap check: does any tracked manifest name an @wolffm dependency?
		let consumes = false;
		try {
			const manifests = git(dir, ['ls-tree', '-r', '--name-only', REF])
				.split('\n')
				// EVERY manifest. A `.slice(0, 8)` here read the first eight in path
				// order and stopped, so a monorepo whose @wolffm consumer sorted ninth
				// (`packages/ui/` behind seven `packages/a…` siblings) was never
				// admitted as a consumer — and therefore never reported missing.
				.filter((f) => f.endsWith('package.json') && !f.includes('node_modules'));
			for (const m of manifests) {
				const raw = readFileAt(dir, m);
				if (!raw) continue;
				// DEPENDENCY FIELDS, not the raw text. `/"@wolffm\//` also matches a
				// manifest's own `"name": "@wolffm/…"`, so a repo that PUBLISHES an
				// @wolffm package and consumes none read as a consumer — and then as
				// `not-in-fleet`, because publishing earns no roster facet.
				// hadoku-fleet-manager tripped exactly that on its first nightly.
				// A malformed manifest is skipped rather than guessed at.
				let pkg;
				try {
					pkg = JSON.parse(raw);
				} catch {
					continue;
				}
				const deps = [
					pkg?.dependencies,
					pkg?.devDependencies,
					pkg?.peerDependencies,
					pkg?.optionalDependencies,
				];
				if (deps.some((d) => d && Object.keys(d).some((k) => k.startsWith('@wolffm/')))) {
					consumes = true;
					break;
				}
			}
		} catch {
			continue;
		}
		if (!consumes) continue;

		// Compared against the ROSTER's consumer facet, not against FLEET.
		// FLEET is the uiApp subset now, and a repo can legitimately consume
		// @wolffm without shipping the header — ArchiveBot and hadoku-merchant
		// take worker-utils only. Asserting FLEET membership here reported both
		// as drift the moment membership became facet-scoped. What the rule
		// actually means is "this consumer is unknown to the fleet", and the
		// roster is what knows.
		if (!KNOWN_CONSUMERS.includes(repo)) {
			const ageHours = repoAgeHours(dir);
			if (ageHours !== null && ageHours < NEW_REPO_GRACE_HOURS) {
				reportAdvisory(
					repo,
					'new-repo-grace',
					`consumes @wolffm packages but is in no fleet roster yet — ${ageHours.toFixed(1)}h old, ` +
						`under the ${NEW_REPO_GRACE_HOURS}h grace. The site repo's reconcile-fleet-coverage.yml ` +
						'(scheduled 30 12 / 0 14 UTC, observed to fire hours late) has not necessarily had a ' +
						`chance to admit it yet; past ${NEW_REPO_GRACE_HOURS}h this becomes a failing ` +
						'not-in-fleet finding. Regenerate early: fleet reconcile --write-coverage',
					{ ageHours, graceHours: NEW_REPO_GRACE_HOURS }
				);
			} else {
				report(
					repo,
					'not-in-fleet',
					'consumes @wolffm packages but is in no fleet roster — every rule above skips it. ' +
						'Regenerate: fleet reconcile --write-coverage'
				);
			}
		}
	}
}

// ---- hadoku_site's own scaffolding --------------------------------------
//
// The templates are the ONE place drift is born rather than found: a child app
// generated from a stale template starts pre-drifted, and every other rule here
// only sees repos that already exist. They sat on the pre-lockdown pattern for
// the whole migration precisely because nothing looked at them.
//
// Only real SOURCE templates belong in this list. `templates/conjure-tunnel`
// used to be here and was not one: hydrate-child-app.mjs writes its output to
// `templates/<appId>-tunnel`, so that directory was a hydrated COPY of
// tunnel-contained, and auditing it only re-checked what the line above already
// covers. Worse, listing it made it look maintained — four commits hand-edited
// the generated copy alongside its source. It was deleted 2026-08-17 (the same
// cleanup 2cb45404 did for templates/dataplatform-tunnel, and the one
// CHECKLIST_conjure.md's own Cleanup section asked for). If a future app leaves
// a `templates/<app>-tunnel` behind, delete it — do not add it here.
// Every real source template, not just the two that happened to be listed.
// `templates/worker` carried a caret `@wolffm/worker-utils` peer that this gate
// could not see, so the fleet-wide floor sweep of 2026-08-18 had to find it by
// hand — the same "the list itself is the blind spot" lesson as
// `not-in-fleet`. Only the peer-floor rule runs over templates, so widening the
// list cannot false-positive a non-UI template.
for (const tpl of [
	'templates/ui-app',
	'templates/tunnel-contained',
	'templates/tunnel',
	'templates/tunnel-proxy',
	'templates/tunnel-python',
	'templates/worker',
]) {
	const dir = resolve(REPO_ROOT, tpl);
	if (!existsSync(dir)) {
		report('templates', 'no-checkout', `${tpl} is missing — has the scaffolding moved?`);
		continue;
	}
	let files;
	try {
		files = git(REPO_ROOT, ['ls-files', tpl]).split('\n').filter(Boolean);
	} catch {
		continue;
	}

	// Template peers get the same floor rule as the fleet — a template with a
	// caret peer scaffolds every future app pre-drifted.
	for (const f of files.filter((x) => x.endsWith('package.json'))) {
		let pkg;
		try {
			pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, f), 'utf8'));
		} catch {
			continue;
		}
		for (const { name, r } of wolffmPeers(pkg)) {
			if (peerRangeIsSound(r)) continue;
			report(
				'templates',
				'stale-peer',
				`${name} in ${f}: scaffolds peer range '${r}' — declare a floor ('>=${r.replace(/^[\^~]/, '')}')`
			);
		}
	}

	for (const f of files) {
		if (LOCAL_THEME_MODULE.test(f)) {
			report(
				'templates',
				'private-picker',
				`${f} — scaffolds a copy of a module that lives in @wolffm/themes`
			);
			continue;
		}
		if (!/\.(tsx?|jsx?)$/.test(f)) continue;
		let raw;
		try {
			raw = readFileSync(resolve(REPO_ROOT, f), 'utf8');
		} catch {
			continue;
		}
		const src = blankComments(raw);
		if (RAW_PICKER_IMPORT.test(src)) {
			report(
				'templates',
				'private-picker',
				`${f} — scaffolds a raw picker import; AppHeader owns it`
			);
		}
		if (THEME_PICKER_PROP.test(src)) {
			report(
				'templates',
				'private-picker',
				`${f} — scaffolds a themePicker prop, removed in tuic 3.0.0`
			);
		}
	}

	// A template whose App renders AppHeader must also scaffold the provider.
	// Per-FILE on purpose — see the fleet's repo-wide `no-provider` above for why
	// the two look alike and must stay apart.
	const appFiles = files.filter((f) => /(^|\/)App\.(tsx|jsx)$/.test(f));
	for (const f of appFiles) {
		const raw = readFileSync(resolve(REPO_ROOT, f), 'utf8');
		const src = blankComments(raw);
		if (/<\s*AppHeader\b/.test(src) && !/\bHadokuThemeRoot\b/.test(src)) {
			report(
				'templates',
				'no-provider',
				`${f} — scaffolds <AppHeader> with no <HadokuThemeRoot>, so a generated app throws at mount`
			);
		}
	}
}

// ---- apply the allowlist ------------------------------------------------
const live = [];
for (const f of findings) {
	const hit = allowlist.get(f.key) || allowlist.get(`${f.repo}:${f.detail.split(' ')[0]}`);
	if (hit) {
		matchedExemptions.add(hit.key);
		continue;
	}
	live.push(f);
}

// A stale exemption is itself a failure — it must not outlive its reason.
const staleExemptions = [...allowlist.keys()].filter((k) => !matchedExemptions.has(k));

// A registry this could not read FAILS the run, exactly like a finding. It used
// to be reported in `--json` and nowhere in the exit code, so every caller but
// ci:header-fleet — which reads the field itself — got exit 0 from a run whose
// staleness rules checked nothing. `--no-registry` is the one exemption: a
// caller that ASKED not to look has not been misled about whether it looked.
const registryBlind = !NO_REGISTRY && registryMisses.size > 0;
const failed = live.length > 0 || staleExemptions.length > 0 || registryBlind;

if (JSON_OUT) {
	// `registry.blind` is the honest answer to "did the staleness rules actually
	// run", and it is deliberately true when --no-registry was passed: a caller
	// that opted out of the registry gets the same "I could not look" signal as
	// one whose token was missing, because the coverage consequence is identical.
	emitter.emit({
		repos: FLEET.length,
		findings: live.map((f) => ({
			repo: f.repo,
			rule: f.rule,
			detail: f.detail,
			...(f.meta ? { meta: f.meta } : {}),
		})),
		// Additive (#95): advisory findings, never counted toward the exit code.
		// A consumer written before this field existed never reads it and never
		// changes behaviour — see `reportAdvisory`.
		advisory: advisories.map((f) => ({
			repo: f.repo,
			rule: f.rule,
			detail: f.detail,
			...(f.meta ? { meta: f.meta } : {}),
		})),
		staleExemptions,
		registry: {
			blind: NO_REGISTRY || registryMisses.size > 0,
			skipped: NO_REGISTRY,
			unreadable: [...registryMisses].sort(),
		},
	});
	process.exit(WARN_ONLY || !failed ? 0 : 1);
}

if (!failed) {
	log(
		advisories.length === 0
			? `check-header-fleet: OK — ${FLEET.length} repos, no drift.`
			: `check-header-fleet: OK — ${FLEET.length} repos, no drift, ${advisories.length} advisory.`
	);
	for (const a of advisories) {
		log(`! ${a.repo} [${a.rule}] ${a.detail} (advisory — does not fail the run)`);
	}
	process.exit(0);
}

for (const f of live) {
	log(`✗ ${f.repo} [${f.rule}] ${f.detail}`);
}
for (const a of advisories) {
	log(`! ${a.repo} [${a.rule}] ${a.detail} (advisory — does not fail the run)`);
}
for (const k of staleExemptions) {
	log(`✗ allowlist entry no longer matches anything: ${k} — remove it`);
}
if (registryBlind) {
	log(
		`✗ registry blind: could not read ${[...registryMisses].sort().join(', ')} from ${REGISTRY}, ` +
			'so stale-package checked nothing for them. Is NODE_AUTH_TOKEN set?'
	);
}
log(
	`\n${live.length} finding(s), ${advisories.length} advisory, ${staleExemptions.length} stale exemption(s) across ${FLEET.length} repos.`
);

process.exit(WARN_ONLY ? 0 : 1);
