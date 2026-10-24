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
 *   - every one of those repos' SHIPPED default branch, for workflows and
 *     `.devvault.json` that ask for it — through `lib/fleet-source.mjs`, never a
 *     sibling checkout (fleet-manager#7). A repo with no clone on this disk used
 *     to have its files silently not read.
 *
 * Detection only: it never deletes a secret. A repo it could not read is a
 * finding, and scanning zero repos is a failure, not a clean report.
 *
 *   fleet check-site-token [--json]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { createEmitter } from './lib/emit.mjs';
import { tryShipped, UnreadableRepo } from './lib/fleet-source.mjs';
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

/**
 * Workflows and `.devvault.json` as SHIPPED: the default branch, read through
 * fleet-source. A checkout's working tree is whatever someone last pulled, and
 * nobody pulls most of them, so it reported workflows that were fixed hours
 * earlier. An unreadable repo is a finding (`unreadable`), not a skip.
 */
function shipped(repo) {
	const out = { workflows: {}, devvault: [], unreadable: null };
	const source = tryShipped(repo);
	if ('unreadable' in source) {
		out.unreadable = source.unreadable;
		return out;
	}
	let devvault;
	try {
		for (const { file, text } of source.workflows()) out.workflows[file] = workflowRefs(text);
		devvault = source.read('.devvault.json');
	} catch (err) {
		// Blobs are fetched on first read, so the read itself can fail.
		if (!(err instanceof UnreadableRepo)) throw err;
		return { workflows: {}, devvault: [], unreadable: err.reason };
	}
	if (devvault !== null) {
		try {
			out.devvault = devvaultRefs(devvault);
		} catch (err) {
			out.devvault = err instanceof Error ? err.message : String(err);
		}
	}
	return out;
}

function main() {
	let repos;
	try {
		repos = JSON.parse(
			gh([
				'repo',
				'list',
				OWNER,
				'--limit',
				'1000',
				'--no-archived',
				'--json',
				'nameWithOwner,isFork,isEmpty',
			])
		);
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

	// The owner's list is the population, and every own, non-empty repo on it is read.
	const findings = [];
	let read = 0;
	for (const { nameWithOwner: repo, isFork, isEmpty } of repos.sort((a, b) =>
		a.nameWithOwner.localeCompare(b.nameWithOwner)
	)) {
		// A fork's tree is upstream's code (microsoft-vscode, nodejs-node), and an
		// empty repo has no tree: neither is mirrored. Both still get the secrets
		// check, which is the API's answer and covers what a fork could hold.
		if (isFork || isEmpty) {
			findings.push(...repoFindings(repo, { secret: holdsSecret(repo) }, allowed));
			continue;
		}
		const { unreadable, ...facts } = shipped(repo);
		if (unreadable === null) read++;
		else if (!allowed.has(repo)) {
			findings.push({
				repo,
				kind: 'unreadable',
				detail: `could not read the default branch's workflows or .devvault.json: ${unreadable}`,
			});
		}
		findings.push(...repoFindings(repo, { secret: holdsSecret(repo), ...facts }, allowed));
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
			`Examined ${examined.repos} repo(s) on GitHub and ${examined.checkouts} default branch(es).\n`
		);
		for (const f of findings)
			log(`  ${f.kind.toUpperCase().padEnd(10)} ${f.repo}\n    ${f.detail}`);
		if (!findings.length)
			log(`Only ${holderList.map((h) => h.repo).join(' and ')} hold ${SITE_TOKEN}.`);
	}
	process.exit(findings.length ? 1 : 0);
}

main();
