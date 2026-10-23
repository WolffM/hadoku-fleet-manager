#!/usr/bin/env node
/**
 * check-site-token — HADOKU_SITE_TOKEN is held only by the repos that need it.
 *
 * The rules and the holder list are in `lib/site-token.mjs`. This file reads:
 *
 *   - every non-archived repo the owner has, for an Actions secret of that
 *     name — from the GitHub API, so the answer is what GitHub holds, not what
 *     we believe we pushed. `manage_github_token.py` writes it to every repo on
 *     its list unconditionally, so a stale list there is exactly how a deleted
 *     copy comes back;
 *   - every sibling checkout, for workflows and `.devvault.json` that ask for it.
 *
 * Detection only: it never deletes a secret. A repo it could not read is a
 * finding, and scanning zero repos is a failure, not a clean report.
 *
 *   fleet check-site-token [--json]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createEmitter } from './lib/emit.mjs';
import { reposDir } from './lib/sibling-repos.mjs';
import { fleetOwner } from '../dist/lib/fleet-config.js';
import { manifest } from './lib/paths.mjs';
import {
	devvaultRefs,
	holders,
	repoFindings,
	SITE_TOKEN,
	workflowRefs,
} from './lib/site-token.mjs';

const OWNER = fleetOwner();
const JSON_OUT = process.argv.includes('--json');
const emitter = createEmitter({ json: JSON_OUT });
const log = emitter.log;
const READ_TIMEOUT_MS = 20_000;

function gh(args) {
	return execFileSync('gh', args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: READ_TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
	});
}

/** Why a gh call failed, in one line — stderr when gh gave one. */
function reason(err) {
	const stderr = err?.stderr ? String(err.stderr).trim().split('\n').pop() : '';
	return stderr || (err instanceof Error ? err.message : String(err));
}

/** true/false, or a string saying why the list could not be read (one retry). */
function holdsSecret(repo) {
	let last = '';
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const names = gh([
				'api',
				'--paginate',
				`repos/${repo}/actions/secrets`,
				'--jq',
				'.secrets[].name',
			]);
			return names.split('\n').includes(SITE_TOKEN);
		} catch (err) {
			last = reason(err);
		}
	}
	return last;
}

function onDisk(dir) {
	const workflows = {};
	const wf = join(dir, '.github', 'workflows');
	if (existsSync(wf)) {
		for (const file of readdirSync(wf)) {
			if (!/\.ya?ml$/.test(file)) continue;
			workflows[file] = workflowRefs(readFileSync(join(wf, file), 'utf8'));
		}
	}
	let devvault = [];
	const dv = join(dir, '.devvault.json');
	if (existsSync(dv)) {
		try {
			devvault = devvaultRefs(readFileSync(dv, 'utf8'));
		} catch (err) {
			devvault = err instanceof Error ? err.message : String(err);
		}
	}
	return { workflows, devvault };
}

function main() {
	let repos;
	try {
		repos = JSON.parse(
			gh(['repo', 'list', OWNER, '--limit', '1000', '--no-archived', '--json', 'nameWithOwner'])
		).map((r) => r.nameWithOwner);
	} catch (err) {
		const msg = `check-site-token: could not list ${OWNER}'s repos: ${reason(err)}`;
		if (JSON_OUT) emitter.emit({ error: msg, examined: 0, findings: [] });
		else console.error(msg);
		process.exit(1);
	}

	// Holders beyond the hub are operator config. A missing manifest THROWS:
	// an unreadable allowlist must not read as "nobody else may hold it" any
	// more than as "everybody may".
	const policyFile = manifest('repo-policy-manifest.json');
	const allowed = holders(JSON.parse(readFileSync(policyFile, 'utf8')).siteTokenHolders);

	const REPOS = reposDir();
	const checkouts = new Map();
	if (existsSync(REPOS)) {
		for (const d of readdirSync(REPOS)) {
			if (existsSync(join(REPOS, d, '.git'))) checkouts.set(`${OWNER}/${d}`, join(REPOS, d));
		}
	}

	// The owner's list is the population. A checkout not on it is a third-party
	// clone or an archived repo, and holds nothing of ours.
	const findings = [];
	let read = 0;
	for (const repo of [...repos].sort()) {
		const dir = checkouts.get(repo);
		if (dir) read++;
		findings.push(
			...repoFindings(repo, { secret: holdsSecret(repo), ...(dir ? onDisk(dir) : {}) })
		);
	}

	const examined = { repos: repos.length, checkouts: read };
	if (examined.repos === 0) {
		const msg = `check-site-token: ${OWNER} listed ZERO repos. That is a broken read, not a clean account.`;
		if (JSON_OUT) emitter.emit({ error: msg, examined, findings: [] });
		else console.error(msg);
		process.exit(1);
	}

	const holderList = [...allowed].map(([repo, why]) => ({ repo, why }));
	if (JSON_OUT) {
		emitter.emit({ examined, holders: holderList, findings });
	} else {
		log(
			`Examined ${examined.repos} repo(s) on GitHub and ${examined.checkouts} checkout(s) under ${REPOS}.\n`
		);
		for (const f of findings)
			log(`  ${f.kind.toUpperCase().padEnd(10)} ${f.repo}\n    ${f.detail}`);
		if (!findings.length)
			log(`Only ${holderList.map((h) => h.repo).join(' and ')} hold ${SITE_TOKEN}.`);
	}
	process.exit(findings.length ? 1 : 0);
}

main();
