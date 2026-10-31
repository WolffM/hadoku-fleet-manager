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
 *   fleet header-audit             # audit each repo's shipped default branch, exit 1 on drift
 *   fleet header-audit --worktree  # audit the working copies under REPOS_DIR
 *   fleet header-audit --warn      # report, always exit 0
 *   fleet header-audit --no-fetch  # read the fleet-source mirrors as they stand (offline)
 *   fleet header-audit --no-registry  # skip npm view (offline)
 *   fleet header-audit --json      # machine-readable, for ci:header-fleet
 *   REPOS_DIR=/path fleet header-audit --worktree
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

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { namesWith } from './lib/fleet-roster.mjs';
import { tryShipped } from './lib/fleet-source.mjs';
import { blankComments } from './lib/blank-comments.mjs';
import { stripYamlComments } from './lib/yaml-comments.mjs';
import { siteRoot } from './lib/paths.mjs';
import { createEmitter } from './lib/emit.mjs';
import { fleetOwner, hubRepo, qualifyRepo } from '../dist/lib/fleet-config.js';
import {
	ROOT,
	git,
	openRepo,
	resetFileCache,
	readFile,
	readBlanked,
} from './lib/header-source.mjs';
import { loadAllowlist } from './lib/header-allowlist.mjs';
import {
	REGISTRY,
	registryMisses,
	findings,
	advisories,
	catalogueBlindFor,
	report,
	reportAdvisory,
	wolffmPeers,
	peerRangeIsSound,
	checkNpmAuthForm,
	checkReleaseAgeCooldown,
	checkTypesEntry,
	checkHeaderName,
	checkFavicon,
	ownerRepos,
	repoAgeHours,
	latestVersion,
	majorOf,
} from './lib/header-rules.mjs';

const REPO_ROOT = siteRoot();

/**
 * What a default run audits: each repo's SHIPPED default branch, read through
 * `lib/fleet-source.mjs` — never a sibling clone, which is only as current as
 * whoever last pulled it (fleet-manager#7). `--worktree` reads the working copy
 * under REPOS_DIR instead; it is an operator's flag, never the cron's.
 */
const REF = 'the shipped default branch';

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

const allowlist = loadAllowlist({ json: JSON_OUT, emitter, repoCount: FLEET.length });
const matchedExemptions = new Set();

for (const repo of FLEET) {
	resetFileCache();
	const source = openRepo(repo, { useWorktree: USE_WORKTREE, noFetch: NO_FETCH });
	if (source.missing) {
		// A finding, not a skip. Silently skipping every repo is how this script
		// printed "OK — no drift" while auditing nothing at all, which is worse
		// than no audit: it actively asserts the fleet is clean.
		report(repo, 'no-checkout', `${source.unreadable} — nothing was audited for this repo`);
		continue;
	}

	let files;
	try {
		if (source.unreadable) throw new Error(source.unreadable);
		files = source.files();
	} catch (err) {
		// A finding, not a stderr line. This used to log and `continue`, so a
		// repo whose files could not be listed ran ZERO rules while the summary
		// still said "no drift" — the `no-checkout` trap one step further in, and
		// invisible to ci:header-fleet, which reads stdout only.
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
	checkTypesEntry(repo, source);

	// ---- npm registry auth uses the canonical token ----------------------
	checkNpmAuthForm(repo, source, files);

	// ---- package manifests: staleness -----------------------------------
	const manifests = files.filter((f) => f.endsWith('package.json') && !f.includes('node_modules'));
	let consumesWolffm = false;

	for (const m of manifests) {
		const raw = readFile(source, m);
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
				const latest = latestVersion(name, { noRegistry: NO_REGISTRY });
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
	checkReleaseAgeCooldown(repo, source, files);

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
		const raw = readFile(source, f);
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
		const src = readBlanked(source, f);
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
		const src = readBlanked(source, f);
		if (!src) continue;
		// RENDERED, not named. A bare-identifier match passed an App.tsx that
		// imports AppHeader and never mounts it — an import left behind by a
		// refactor is exactly the shape a header quietly disappears in.
		if (!/<\s*AppHeader\b/.test(src)) {
			report(repo, 'no-app-header', `${f} — an app root that renders no <AppHeader>`);
		}
	}

	// ---- and it must call the app what the catalogue calls it -------------
	checkHeaderName(repo, source, appRoots);

	// ---- every entry shell declares an icon -------------------------------
	checkFavicon(repo, source, files);

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
		const src = readBlanked(source, f);
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
			`${USE_WORKTREE ? `the working copy of ${resolve(ROOT, hubRepo())}` : `${REF} of ${hubRepo()}`}, so ` +
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
// world, and the world is the owner's account on GitHub.
//
// Reality here is "consumes an @wolffm package". Any repo that does is part of
// the ecosystem and must appear in the roster, or carry an allowlist entry
// saying why not. (The fan-out half of that assertion was `not-in-fanout`,
// retired 2026-08-26 — see the header.)
{
	const universe = ownerRepos();
	if (universe.reason) {
		// A FAILED LISTING IS NOT AN EMPTY ACCOUNT. Every repo outside the roster
		// would go unexamined while the summary said the roster was complete.
		report(
			fleetOwner(),
			'unreadable',
			`could not list ${fleetOwner()}'s repos (${universe.reason}), so whether the fleet ` +
				'roster misses an @wolffm consumer was not checked'
		);
	}

	for (const repo of universe.names ?? []) {
		if (repo === hubRepo()) continue; // the parent, not a consumer
		// Shipped manifests, whatever --worktree says: whether a repo consumes
		// @wolffm is a fact about what it ships.
		const shipped = tryShipped(qualifyRepo(repo), { fetch: !NO_FETCH });
		if ('unreadable' in shipped) {
			report(
				repo,
				'unreadable',
				`cannot read ${REF} (${shipped.unreadable}), so whether it consumes @wolffm ` +
					'packages — and so belongs in the roster — is unknown'
			);
			continue;
		}

		// Cheap check: does any tracked manifest name an @wolffm dependency?
		let consumes = false;
		try {
			const manifests = shipped
				.list()
				// EVERY manifest. A `.slice(0, 8)` here read the first eight in path
				// order and stopped, so a monorepo whose @wolffm consumer sorted ninth
				// (`packages/ui/` behind seven `packages/a…` siblings) was never
				// admitted as a consumer — and therefore never reported missing.
				.filter((f) => f.endsWith('package.json') && !f.includes('node_modules'));
			shipped.readMany(manifests); // one fetch for all of them, not one per manifest
			for (const m of manifests) {
				const raw = shipped.read(m);
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
		} catch (err) {
			report(
				repo,
				'unreadable',
				`cannot read ${REF}'s manifests (${err.reason ?? err.message}), so whether it ` +
					'consumes @wolffm packages is unknown'
			);
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
			const ageHours = repoAgeHours(repo, { noFetch: NO_FETCH });
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
