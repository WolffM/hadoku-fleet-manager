#!/usr/bin/env node
/**
 * Refuse to push a shipped change on a version someone else already published.
 *
 * THE FAILURE THIS CATCHES IS SILENT, WHICH IS WHY IT NEEDS A GATE.
 *
 * `version-bump.mjs` runs pre-commit and bumps when the published surface is
 * STAGED. A rebase stages nothing. So when two agents work the same checkout —
 * routine here — the sequence is:
 *
 *   A commits src, hook bumps 0.21.74 -> 0.21.75, pushes, publish ships 75
 *   B commits src, hook bumps 0.21.74 -> 0.21.75, rebases onto A, pushes
 *
 * B's rebase replays its src changes onto a tree whose package.json already
 * says 0.21.75. Nothing re-runs the hook, so B ships real code under a version
 * that is already on the registry. publish.yml's "Did the published surface
 * change?" step then fails as designed — AFTER the push, in CI, where it reads
 * as a flaky publish rather than a fix that never deployed.
 *
 * That is not hypothetical. It happened twice on 2026-09-02/03, and the first
 * time mgmt-api ran without the queue-latency fix for half an hour while the
 * commit sat green in git. Checking a version number instead of the shipped
 * code is exactly how it stayed invisible.
 *
 * The comparison is against origin/main, not the registry: origin/main's
 * version is what the last publish used, it needs no token, and it is the same
 * base the push is being made against.
 *
 *   node scripts/check-version-ahead.mjs            # pre-push
 *   node scripts/check-version-ahead.mjs --base X   # compare against another ref
 *
 * @guards scripts/**
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { classify } from './version-bump.mjs';

const args = process.argv.slice(2);
const baseArg = args.indexOf('--base');
const BASE = baseArg >= 0 ? args[baseArg + 1] : 'origin/main';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

/** Semver compare limited to x.y.z — this package has never used a prerelease. */
export function isAhead(mine, theirs) {
	const a = String(mine).split('.').map(Number);
	const b = String(theirs).split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		if (x !== y) return x > y;
	}
	return false;
}

function main() {
	// A base that cannot be resolved means "I could not look". Failing OPEN here
	// is deliberate and bounded: publish.yml still refuses a stale version, so the
	// cost is the old behaviour, while failing closed would block every push made
	// without a remote — including the first push of a new clone.
	let theirs;
	try {
		theirs = JSON.parse(git('show', `${BASE}:package.json`)).version;
	} catch {
		console.log(`check-version-ahead: ${BASE} not resolvable — skipping (publish still gates).`);
		return 0;
	}

	let changed;
	try {
		changed = git('diff', '--name-only', `${BASE}...HEAD`).split('\n').filter(Boolean);
	} catch {
		console.log(`check-version-ahead: cannot diff against ${BASE} — skipping.`);
		return 0;
	}

	// The SAME predicate version-bump and publish.yml use. Three copies of "what
	// ships" would drift, and the one that drifts is the one nobody reads.
	if (!classify(changed)) {
		console.log('check-version-ahead: nothing published changed. OK.');
		return 0;
	}

	const mine = JSON.parse(readFileSync('package.json', 'utf8')).version;
	if (isAhead(mine, theirs)) {
		console.log(`check-version-ahead: ${mine} is ahead of ${BASE} (${theirs}). OK.`);
		return 0;
	}

	console.error(
		`\ncheck-version-ahead: this push ships code at ${mine}, but ${BASE} is already ${theirs}.\n\n` +
			`  ${theirs} is published. Pushing ${mine} means publish.yml rejects it as stale and\n` +
			`  YOUR CHANGE NEVER DEPLOYS — silently, because the commit itself is fine.\n\n` +
			`  This is what a rebase does: version-bump.mjs runs pre-commit on STAGED files,\n` +
			`  and a rebase stages nothing, so the bump does not re-run on top of the new base.\n\n` +
			`  Fix: bump past ${theirs} and amend, e.g.\n` +
			`    sed -i 's/"version": "[^"]*"/"version": "<next>"/' package.json \\\n` +
			`      && git add package.json && git commit --amend --no-edit\n\n` +
			`  NOT \`npm pkg set version=\`: it also rewrites the express specifier to >=5.1.0,\n` +
			`  the lockfile stops matching, and CI and publish fail at install. That has\n` +
			`  happened twice (b9f13fd, 03f6bf5), the second time by following this hint.\n`
	);
	return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
