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

import { namesWith } from './lib/fleet-roster.mjs';
import { siteRoot } from './lib/paths.mjs';
import { createEmitter } from './lib/emit.mjs';
import { git, openRepo, resetFileCache } from './lib/header-source.mjs';
import { loadAllowlist } from './lib/header-allowlist.mjs';
import { REGISTRY, registryMisses, findings, advisories } from './lib/header-rules.mjs';
import { auditFleetRepos } from './lib/header-fleet-audit.mjs';
import { auditRosterCompleteness } from './lib/header-roster-completeness.mjs';
import { auditTemplates } from './lib/header-template-audit.mjs';

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
 * silently skipped it. See scripts/lib/fleet-roster.mjs.
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

const allowlist = loadAllowlist({ json: JSON_OUT, emitter, repoCount: FLEET.length });
const matchedExemptions = new Set();

// ---- the FLEET pass: package staleness, update/landing path, private ----
// ---- theme copies, the shared header, the favicon, the provider ---------
// Moved to `lib/header-fleet-audit.mjs` (wave shrink-1 lane D, pure move);
// see this file's own header for the rule catalogue.
auditFleetRepos(FLEET, {
	useWorktree: USE_WORKTREE,
	noFetch: NO_FETCH,
	noRegistry: NO_REGISTRY,
	openRepo,
	resetFileCache,
});

// ---- is the FLEET list itself complete? ---------------------------------
// Moved to `lib/header-roster-completeness.mjs` (wave shrink-1 lane D, pure
// move); see that file for why this reads the owner's whole account rather
// than trusting the derived FLEET/KNOWN_CONSUMERS lists.
auditRosterCompleteness(KNOWN_CONSUMERS, {
	useWorktree: USE_WORKTREE,
	noFetch: NO_FETCH,
	ref: REF,
});

// ---- hadoku_site's own scaffolding --------------------------------------
// Moved to `lib/header-template-audit.mjs` (wave shrink-1 lane D, pure
// move); see that file for why only real source templates belong in its list.
auditTemplates(REPO_ROOT, git);

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
