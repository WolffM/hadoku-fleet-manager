/**
 * Shared test rig for the identity-model gate's CLI tests (split of
 * scripts/check-identity-model.test.mjs, wave 5q lane C, pure move, over the
 * `-fixtures.mjs` pattern wave 5k lane A used for doctor's split): every
 * helper and fixture constant that more than one of the split test files
 * needs — a throwaway site root, a bare git remote, the gate run as a
 * subprocess, the data-table test shapes. Nothing here is a test; this
 * module exists only to be imported BY tests (`FIXTURE_FILES` in
 * `scripts/lib/f-guards/lib.mjs`, and the `-fixtures.mjs` exemption in
 * `ecosystem-literals.test.mjs`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanGitEnv } from './test-git-identity.mjs';
import { fixtureRemotes } from './fleet-source-fixture.mjs';

/**
 * Run `fn(repos, remotes)` with the gate's reader pointed at fresh fixture
 * remotes (lib/fleet-source-fixture.mjs) and `repos` an EMPTY REPOS_DIR: a
 * sibling is its SHIPPED tree, never a checkout (fleet-manager#7). `run()`
 * spreads process.env, so the FLEET_SOURCE_* variables reach the gate.
 */
export function withRemotes(fn) {
	const remotes = fixtureRemotes('idm-remotes-');
	const repos = join(remotes.root, 'repos');
	mkdirSync(repos, { recursive: true });
	const saved = {};
	for (const [k, v] of Object.entries(remotes.env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	try {
		return fn(repos, remotes);
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		remotes.cleanup();
	}
}

export const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-identity-model.mjs');

/** Any real .git directory, to stand in for the one a hook would export. */
export const REPO_GIT_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), '..', '.git');

export const RESOLVER = `
import { resolveGrantee, isIdentityError } from '@wolffm/worker-utils/identity';
export async function handler(c) {
	const out = await resolveGrantee(c.env, { name: c.req.query('name') });
	return isIdentityError(out) ? null : out.userId;
}
`;

export const VIA_EDGE = `
import { resolveGranteeVia, isIdentityError } from '@wolffm/worker-utils/identity';
export async function handler(c) {
	const out = await resolveGranteeVia(c.env.EDGE, { serviceKey: c.env.K, name: 'x' });
	return isIdentityError(out) ? null : out.userId;
}
`;

export const KV_BINDING = '[[kv_namespaces]]\nbinding = "SESSIONS_KV"\nid = "abc"\n';
export const EDGE_BINDING = '[[services]]\nbinding = "EDGE"\nservice = "edge-router"\n';

/** A site root holding one worker: its source, and its wrangler.toml. */
export function siteWith(source, toml) {
	const root = mkdtempSync(join(tmpdir(), 'idmodel-'));
	mkdirSync(join(root, 'scripts', 'admin'), { recursive: true });
	writeFileSync(join(root, 'scripts', 'admin', 'identity-model-allowlist.json'), '{"allowed":[]}');
	// No app declares an erase hook unless a test writes its own (R12 as amended).
	writeFileSync(join(root, 'scripts', 'child-apps.json'), '{"apps":[]}');
	mkdirSync(join(root, 'workers', 'demo-api', 'src'), { recursive: true });
	writeFileSync(join(root, 'workers', 'demo-api', 'src', 'routes.ts'), source);
	writeFileSync(join(root, 'workers', 'demo-api', 'wrangler.toml'), `name = "demo-api"\n${toml}`);
	return root;
}

/**
 * Run git against a throwaway repo, with every inherited GIT_* variable cleared.
 *
 * `-C <dir>` DOES NOT OVERRIDE `GIT_DIR`. Git hooks export GIT_DIR (and often
 * GIT_INDEX_FILE), so a `git add` in a test that inherits the parent env runs
 * against THE REAL REPOSITORY no matter what `-C` says — and since its cwd holds
 * none of the repo's files, it stages a deletion of every one of them.
 *
 * That is not hypothetical: the first cut of the ignored-artifact test below
 * staged 306 deletions in this repo the moment it ran under the pre-push hook.
 * `pnpm run check` passed standalone (no GIT_DIR in the env) and failed from the
 * hook, which reads as a flaky suite rather than as a test corrupting the index.
 */
export function gitIn(dir, args) {
	// `cleanGitEnv()` is the fleet's one answer here: every GIT_* variable removed
	// (so an inherited GIT_DIR cannot redirect this at the real repo) AND the
	// fixture identity supplied through GIT_AUTHOR_*/GIT_COMMITTER_*. Never
	// `git config user.email` — that is a WRITE to a config file whose location
	// `cwd` does not decide, and it is how 59 commits on main came to be authored
	// by a fixture. `hook-safe-tests` fails the build on it.
	execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: cleanGitEnv(), cwd: dir });
}

/**
 * A minimal site root holding nothing but the manifest dir the gate boots
 * against. `siteWith` also plants a demo worker; these cases are about WHERE the
 * walk looks, so they need an empty repo to put one file into.
 */
export function bareSite() {
	const root = mkdtempSync(join(tmpdir(), 'idm-reach-'));
	mkdirSync(join(root, 'scripts', 'admin'), { recursive: true });
	writeFileSync(join(root, 'scripts', 'admin', 'identity-model-allowlist.json'), '{"allowed":[]}');
	// No app declares an erase hook unless a test writes its own (R12 as amended).
	writeFileSync(join(root, 'scripts', 'child-apps.json'), '{"apps":[]}');
	return root;
}

/** `bareSite` + cleanup, mirroring `withSite`. */
export function withBareSite(fn) {
	const root = bareSite();
	try {
		fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** Exit code + output of one gate run against `root`. */
export function run(root, { REPOS_DIR, extra = [] } = {}) {
	try {
		// BOTH streams, on BOTH paths. Warnings that do not fail the run — a stale
		// checkout, a missing sibling — go to stderr, so capturing stdout only on
		// success made them invisible to any test asserting on an exit-0 run, which
		// is exactly the class of output most in need of one.
		const res = spawnSync('node', [GATE, ...extra], {
			env: { ...process.env, HADOKU_SITE_ROOT: root, ...(REPOS_DIR ? { REPOS_DIR } : {}) },
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		if (res.error) throw res.error;
		return { code: res.status ?? 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
	} catch (err) {
		return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
	}
}

export function withSite(source, toml, fn) {
	const root = siteWith(source, toml);
	try {
		fn(run(root));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** A site root wired to a local bare remote, with one commit pushed to main. */
export function siteWithRemote() {
	const remote = mkdtempSync(join(tmpdir(), 'idm-remote-'));
	gitIn(remote, ['init', '--bare', '-q', '--initial-branch=main']);
	const root = bareSite();
	gitIn(root, ['init', '-q', '--initial-branch=main']);
	gitIn(root, ['add', '-A']);
	gitIn(root, ['commit', '-qm', 'base']);
	gitIn(root, ['remote', 'add', 'origin', remote]);
	gitIn(root, ['push', '-q', 'origin', 'HEAD:main']);
	return { root, remote };
}

/** Land one more commit on the remote, so `root` falls behind. */
export function advanceRemote(remote) {
	const other = mkdtempSync(join(tmpdir(), 'idm-clone-'));
	gitIn(other, ['clone', '-q', remote, '.']);
	writeFileSync(join(other, 'later.txt'), 'newer\n');
	gitIn(other, ['add', '-A']);
	gitIn(other, ['commit', '-qm', 'later']);
	gitIn(other, ['push', '-q', 'origin', 'HEAD:main']);
	rmSync(other, { recursive: true, force: true });
}

/** A bare site holding `files` ({relPath: content}), run once. */
export function runFiles(
	files,
	{ extra = [], allow = null, nonWaivable = null, coverage = null, REPOS_DIR } = {}
) {
	const root = bareSite();
	try {
		for (const [rel, body] of Object.entries(files)) {
			mkdirSync(join(root, dirname(rel)), { recursive: true });
			writeFileSync(join(root, rel), body);
		}
		if (allow || nonWaivable) {
			writeFileSync(
				join(root, 'scripts', 'admin', 'identity-model-allowlist.json'),
				JSON.stringify({ allowed: allow ?? [], ...(nonWaivable ? { nonWaivable } : {}) })
			);
		}
		if (coverage) {
			writeFileSync(
				join(root, 'scripts', 'admin', 'fleet-runner-coverage.json'),
				JSON.stringify(coverage)
			);
		}
		return run(root, { extra, REPOS_DIR });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/**
 * Why a run is NOT a `check` finding matching `pattern`, or null when it is.
 * Returned rather than asserted so each test's own `assert` is visible to the
 * vacuity guard.
 */
export function missedCheck(r, check, pattern) {
	if (r.code !== 1) return `expected a ${check} finding, got exit ${r.code}:\n${r.out}`;
	if (!new RegExp(`\\b${check}\\b`).test(r.out)) return `no ${check} in:\n${r.out}`;
	if (pattern && !pattern.test(r.out)) return `no finding matching ${pattern}:\n${r.out}`;
	return null;
}

/** The JSON document a `--json` run printed. stderr follows it in `out`. */
export function jsonDoc(r) {
	return JSON.parse(r.out.slice(0, r.out.indexOf('\n}') + 2));
}

export const handler = (body) => `export async function handler(c) {\n${body}\n}\n`;

/** A sibling repo shipping `files`, with an EMPTY REPOS_DIR beside it. */
export function withSibling(name, files, fn) {
	withRemotes((repos, remotes) => {
		remotes.push(`WolffM/${name}`, files);
		fn(repos);
	});
}
