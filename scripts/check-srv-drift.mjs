#!/usr/bin/env node
/**
 * check-srv-drift — is the manifest the fleet is RUNNING the manifest main
 * holds, and is anything written on the deploy tree about to be erased?
 *
 * WHY THIS IS A CRON AND NOT A NOTE IN CLAUDE.md
 * ---------------------------------------------
 * `~/srv/hadoku_site` is a git checkout and every redeploy runs
 * `git reset --hard origin/main` on it. On 2026-09-14 five landings produced
 * five resets in 36 minutes and a `fleet bootcamp --write` was wiped 40 seconds
 * after it printed `✓ wrote` and read the file back true. `manifest-target.mjs`
 * now stops the four writers from targeting that tree at all — but a guard on
 * the writers can only see writes the writers make. A hand edit, a deployed
 * fleet-manager older than the guard, or anything run from `~/srv` because that
 * is where the CLI lives, all land there unobserved.
 *
 * So this reads the three documents git can produce and compares the `$`-facets
 * across them: the deploy tree's file, the commit that tree is checked out at,
 * and `origin/main`. `lib/srv-drift.mjs` holds the comparison and the reasoning
 * behind the two failure kinds; this file is the I/O and the refusals.
 *
 * "I COULD NOT LOOK" FAILS, AND SAYS WHY
 * -------------------------------------
 * Every way this run can learn nothing — a missing deploy tree, a tree that is
 * not a checkout, an unreadable or unparseable manifest, a failed fetch, a rev
 * that will not resolve to a commit, a missing `origin/main` blob, and a
 * manifest carrying ZERO `$`-facets — exits non-zero with its own `error`
 * string rather than an empty `findings` array. Count the `cannotLook` calls;
 * a number written here would go stale in the direction of reporting clean. A
 * gate that reports a clean fleet because it read nothing is the exact failure
 * CLAUDE.md names, and this gate's whole subject is a write that vanished
 * quietly.
 *
 * `--no-fetch` is for a box with no network and for the tests. It does NOT make
 * the gate pass more easily: without a fetch the `origin/main` ref is whatever
 * the last fetch left, so the run says `fetched: false` and the reader can weigh
 * it. Skipping the fetch silently is what would make it easier.
 *
 * `--json` is a contract. See `lib/json-contract.mjs`; the consumer is
 * `ci:srv-drift`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { createEmitter } from './lib/emit.mjs';
import { deploySiteRoot, runGit } from './lib/manifest-target.mjs';
// The hub repo's name is config, not a literal — `src/lib/fleet-config.ts`.
import { hubRepo } from '../dist/lib/fleet-config.js';
import { facets, srvDriftVerdict } from './lib/srv-drift.mjs';

const JSON_OUT = process.argv.includes('--json');
const NO_FETCH = process.argv.includes('--no-fetch');
const out = createEmitter({ json: JSON_OUT });
const log = out.log;

/** The manifest, relative to the hadoku_site checkout root. */
const MANIFEST_REL = 'scripts/admin/fleet-runner-manifest.json';

/**
 * How long a manifest commit on main may be un-deployed before it is a finding.
 *
 * 15 minutes against a redeploy that is normally ~2. Wide enough that a busy
 * Actions queue does not page, narrow enough that a redeploy workflow which has
 * actually stopped firing — the thing worth knowing — crosses it within two
 * ten-minute ticks of the commit.
 */
const GRACE_SECONDS = Number(process.env.SRV_DEPLOY_GRACE_SECONDS ?? 900);

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	log(
		'fleet srv-drift — the deployed manifest against the commit it came from, and against main\n\n' +
			'  --json       machine-readable findings (a contract; see lib/json-contract.mjs)\n' +
			'  --no-fetch   do not refresh origin/main first (reported as fetched:false)\n\n' +
			'Two failures, deliberately separate:\n' +
			'  unlanded-write  the deploy tree was written; the next publish erases it\n' +
			'  undeployed      the deploy is running an older manifest than main holds\n'
	);
	process.exit(0);
}

/** Every "I could not look" exit goes through here, so none of them can be silent. */
function cannotLook(error, extra = {}) {
	if (JSON_OUT) out.emit({ ok: false, error, findings: [], deferred: [], ...extra });
	else console.error(`✗ ${error}`);
	process.exit(1);
}

const root = deploySiteRoot();
if (!existsSync(root)) {
	cannotLook(
		`the deployed ${hubRepo()} checkout does not exist: ${root}. This gate reads the tree ` +
			'mgmt-api actually serves from; with no tree there is no evidence either way, which ' +
			'is a failure and not a clean fleet. Set FLEET_DEPLOY_SITE_ROOT if the deploy moved.'
	);
}

const top = runGit(['rev-parse', '--show-toplevel'], root);
if (top.status !== 0 || !top.stdout.trim()) {
	cannotLook(
		`${root} is not a git working tree (${top.stderr.trim() || 'no toplevel'}). The whole ` +
			'comparison is against git, so there is nothing to compare — and a deploy tree that ' +
			'stopped being a checkout is itself worth knowing about.'
	);
}

const file = join(root, MANIFEST_REL);
if (!existsSync(file)) cannotLook(`the deployed manifest is missing: ${file}`);

/**
 * WHERE THE FETCH PUTS MAIN, AND WHY IT IS NOT `FETCH_HEAD`.
 *
 * `FETCH_HEAD` IS ONE FILE PER REPOSITORY and this gate runs inside the SHARED
 * deploy clone — the tree every redeploy fetches and resets, which is the
 * entire reason the gate exists. Any other process fetching there overwrites
 * that file, and on 2026-09-19 06:30Z one did: a deploy's own fetch landed
 * between this gate's `git fetch origin main` and its reads, so "origin/main"
 * below resolved to whatever THAT fetch had asked for. The run went red, and
 * then self-healed on the next tick — a wrong answer that erases its own
 * evidence is the worst shape a wrong answer has.
 *
 * So the fetch names a DESTINATION nothing else in this clone writes. A
 * deploy's `git fetch origin main`, a `git fetch --prune` and a
 * `git reset --hard origin/main` all leave `refs/srv-drift/*` alone — prune
 * only removes refs under the remote's own refspec destination — and the ref
 * sits outside `refs/heads` and `refs/remotes`, so `git branch -a` does not
 * show it and no checkout can land on it. It costs one loose ref pointing at a
 * commit `refs/remotes/origin/main` already holds, so it keeps nothing alive
 * that gc would otherwise reclaim, and it is deliberately NOT deleted after
 * the run: deleting it would race two copies of this gate against each other
 * to buy back a ref file.
 *
 * THE REF IS THEN RESOLVED TO A SHA ONCE, and the sha is what every read below
 * is handed. This is a smaller claim than the ref and it is worth stating
 * exactly: three reads of a ref are three answers that merely usually agree,
 * three reads of a sha are one commit. `HEAD` gets the same treatment for the
 * same reason — the `headSha` this gate REPORTS and the blob it compared were
 * two independent lookups until now, so a reset landing between them published
 * a sha that was not the thing measured.
 *
 * What pinning does NOT buy is atomicity between the fetch and the pin; only
 * another copy of THIS gate can write that ref in that window, and it would be
 * writing main's tip, so either answer is an honest observation of main at some
 * instant. A deploy's fetch is the opposite case — it writes something that is
 * not main at all — and that one the ref removes outright.
 *
 * `--no-fetch` is unchanged and still reads `refs/remotes/origin/main`: git
 * updates that ref opportunistically on this refspec too (verified), so a
 * fetching run still leaves the non-fetching path something current to read.
 */
const MAIN_REF = 'refs/srv-drift/main';

/** What to CALL main in an error string. The sha is what gets read. */
const MAIN_LABEL = NO_FETCH ? 'origin/main' : MAIN_REF;

let fetched = false;
if (!NO_FETCH) {
	const r = runGit(['fetch', 'origin', `+refs/heads/main:${MAIN_REF}`], root);
	if (r.status !== 0) {
		cannotLook(
			`could not fetch origin/main into ${MAIN_REF} in ${root}: ` +
				`${r.stderr.trim() || 'unknown error'}. Without it \`origin/main\` is whatever the ` +
				'last fetch left, so "the deploy matches main" would be a claim about a ref of ' +
				'unknown age.'
		);
	}
	fetched = true;
}

/**
 * A rev pinned to the commit it names, ONCE, at a known instant.
 *
 * Unresolvable is a REFUSAL, not a `null` passed downstream: every comparison
 * this gate makes is against that commit, so not having it means the run
 * learned nothing — and a gate that reports nothing wrong because it could not
 * look is the failure CLAUDE.md names.
 */
function pin(rev, why) {
	const r = runGit(['rev-parse', '--verify', `${rev}^{commit}`], root);
	const sha = r.status === 0 ? r.stdout.trim() : '';
	if (!sha)
		cannotLook(`could not resolve ${rev} in ${root}: ${r.stderr.trim() || 'no commit'}. ${why}`);
	return sha;
}

const headSha = pin(
	'HEAD',
	'That is the commit the deploy tree is checked out at, and both halves of this gate are ' +
		'comparisons against it.'
);
const mainSha = pin(
	MAIN_LABEL,
	NO_FETCH
		? 'With --no-fetch there is nothing to compare the deploy against unless a previous fetch ' +
				'left the remote-tracking ref behind.'
		: 'The fetch reported success, so a ref that will not resolve straight after it is a fetch ' +
				'that wrote somewhere other than where it said.'
);

function show(sha, label) {
	const r = runGit(['show', `${sha}:${MANIFEST_REL}`], root);
	if (r.status !== 0) {
		cannotLook(
			`could not read ${MANIFEST_REL} at ${label} (${sha.slice(0, 8)}) in ${root}: ` +
				`${r.stderr.trim() || 'unknown error'}`
		);
	}
	return r.stdout;
}

function parse(text, label) {
	try {
		return JSON.parse(text);
	} catch (err) {
		cannotLook(`${label} is not valid JSON: ${err.message}`);
		return null;
	}
}

const working = parse(readFileSync(file, 'utf8'), `the deployed manifest (${file})`);
const head = parse(show(headSha, 'HEAD'), `the manifest at HEAD in ${root}`);
const origin = parse(show(mainSha, MAIN_LABEL), `the manifest at origin/main in ${root}`);

// ZERO FACETS IS A FAILURE. A manifest with no `$` block at all is a manifest
// this gate cannot say anything about, and every comparison below would come
// back empty — which renders as the cleanest possible fleet. CLAUDE.md: exit 0
// with no evidence is a failure, not a pass.
const facetCount = facets(working).size;
if (facetCount === 0) {
	cannotLook(
		`the deployed manifest carries ZERO \`$\` facets (${file}). Every comparison this gate ` +
			'makes is over those blocks, so an empty set is not a clean deploy — it is a manifest ' +
			'that is empty, truncated, or no longer shaped the way the four writers write it.',
		{ facetsCompared: 0 }
	);
}

/**
 * Age of main's newest commit TOUCHING THE MANIFEST, not of main's tip.
 *
 * The tip moves on every unrelated push, so its age would grant the deploy
 * grace to a manifest commit that has been sitting undeployed for hours. `null`
 * when it cannot be read, which denies the grace — see `srvDriftVerdict`.
 */
function mainManifestAgeSeconds() {
	const r = runGit(['log', '-1', '--format=%cI', mainSha, '--', MANIFEST_REL], root);
	const stamp = r.status === 0 ? r.stdout.trim() : '';
	if (!stamp) return null;
	const ms = Date.parse(stamp);
	return Number.isFinite(ms) ? Math.max(0, (Date.now() - ms) / 1000) : null;
}

const verdict = srvDriftVerdict({
	working,
	head,
	origin,
	mainAgeSeconds: mainManifestAgeSeconds(),
	graceSeconds: GRACE_SECONDS,
});

log(`deploy tree ${root}`);
log(`  HEAD ${headSha.slice(0, 8)}   origin/main ${mainSha.slice(0, 8)}   fetched=${fetched}`);
log(`  ${facetCount} \`$\` facet(s) compared`);
for (const d of verdict.deferred) log(`  · ${d.kind}: ${d.facet} — ${d.why}`);
for (const f of verdict.findings) log(`  ✗ ${f.kind}: ${f.facet}`);
if (verdict.ok) log('✓ the deployed manifest is exactly the one main holds');

if (JSON_OUT) {
	out.emit({
		ok: verdict.ok,
		error: null,
		deployRoot: root,
		manifest: MANIFEST_REL,
		headSha,
		mainSha,
		fetched,
		facetsCompared: facetCount,
		findings: verdict.findings,
		deferred: verdict.deferred,
	});
} else {
	for (const f of verdict.findings) console.error(`\n✗ ${f.kind}: ${f.why}`);
}

process.exit(verdict.ok ? 0 : 1);
