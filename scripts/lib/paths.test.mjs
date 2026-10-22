/**
 * `siteRoot()` must resolve the checkout you are STANDING IN.
 *
 * This is not a preference. `reposDir()` deliberately resolves the MAIN
 * checkout even from a worktree — correct for finding siblings, because a
 * worktree's parent is `.claude/worktrees/`. Deriving the site root from it
 * meant `fleet reconcile --write-coverage`, run inside a worktree, read and
 * WROTE the shared main checkout: another agent's working tree, silently.
 * That happened during the 2026-08-30 cutover.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

import { cleanGitEnv } from './test-git-identity.mjs';

/**
 * The ambient environment with every `GIT_*` variable REMOVED.
 *
 * `git` reads GIT_DIR and GIT_INDEX_FILE from the environment and they OVERRIDE
 * `cwd`. A git hook exports them to its children, and `.husky/pre-push` runs the
 * full `pnpm run check` — so without this, the `git init` below reinitialises
 * THE REAL REPOSITORY instead of the throwaway directory it names.
 *
 * That is not theoretical: on 2026-09-08 the same omission in
 * version-bump.test.mjs put two commits authored `t <t@t>` onto a live branch,
 * truncated its tree to two files, and wrote `core.bare = true` into the shared
 * config, which made every other worktree report the primary checkout as bare.
 * `scripts/lib/hook-safe-tests.test.mjs` is the guard, and it fails without this.
 *
 * IT ALSO CARRIES THE IDENTITY. `fakeCheckout` used to say `git config
 * user.email t@t`, which is a WRITE to a config file — and 21 commits on
 * `origin/main` between 09-07 and 09-15 are authored `t <t@t>`. `cleanGitEnv`
 * passes it in `GIT_AUTHOR_*` / `GIT_COMMITTER_*`, which dies with the child.
 */
const FIXTURE_ENV = cleanGitEnv();
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const { siteRoot, manifestDir } = await import('./paths.mjs');

/** A throwaway git repo shaped like a hadoku_site checkout. */
function fakeCheckout() {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-paths-'));
	mkdirSync(join(dir, 'scripts', 'admin'), { recursive: true });
	writeFileSync(join(dir, 'scripts', 'admin', 'fleet-runner-manifest.json'), '{}');
	const git = (...a) => execFileSync('git', a, { cwd: dir, env: FIXTURE_ENV, stdio: 'ignore' });
	git('init', '-q');
	git('add', '-A');
	git('commit', '-qm', 'init');
	return dir;
}

test('siteRoot resolves the checkout cwd is inside, not a canonical one', () => {
	const dir = fakeCheckout();
	const prevCwd = process.cwd();
	const prevEnv = process.env.HADOKU_SITE_ROOT;
	delete process.env.HADOKU_SITE_ROOT;
	try {
		process.chdir(dir);
		// realpath: macOS/tmp symlinks would otherwise fail a string compare.
		assert.equal(resolve(siteRoot()), resolve(dir));
		assert.equal(resolve(manifestDir()), resolve(dir, 'scripts', 'admin'));
	} finally {
		process.chdir(prevCwd);
		if (prevEnv === undefined) delete process.env.HADOKU_SITE_ROOT;
		else process.env.HADOKU_SITE_ROOT = prevEnv;
		rmSync(dir, { recursive: true, force: true });
	}
});

test('HADOKU_SITE_ROOT still wins over the working directory', () => {
	const dir = fakeCheckout();
	const other = fakeCheckout();
	const prevCwd = process.cwd();
	const prevEnv = process.env.HADOKU_SITE_ROOT;
	try {
		process.chdir(dir);
		process.env.HADOKU_SITE_ROOT = other;
		assert.equal(resolve(siteRoot()), resolve(other));
	} finally {
		process.chdir(prevCwd);
		if (prevEnv === undefined) delete process.env.HADOKU_SITE_ROOT;
		else process.env.HADOKU_SITE_ROOT = prevEnv;
		rmSync(dir, { recursive: true, force: true });
		rmSync(other, { recursive: true, force: true });
	}
});

test('a directory that is not a site checkout does not masquerade as one', () => {
	// A bare temp dir under git but WITHOUT scripts/admin must NOT be accepted —
	// otherwise running the CLI from any random repo would point the manifests
	// at that repo.
	const dir = mkdtempSync(join(tmpdir(), 'fleet-notsite-'));
	execFileSync('git', ['init', '-q'], { cwd: dir, env: FIXTURE_ENV, stdio: 'ignore' });
	const prevCwd = process.cwd();
	const prevEnv = process.env.HADOKU_SITE_ROOT;
	delete process.env.HADOKU_SITE_ROOT;
	try {
		process.chdir(dir);
		// It REFUSES rather than returning a wrong path. From here reposDir() is
		// /tmp, so the canonical candidate /tmp/hadoku_site does not exist — and
		// `must()` throws naming it. Guessing would be the failure mode: every
		// manifest read behind this resolves to empty, which renders as a clean
		// audit of a fleet with nothing in it.
		assert.throws(() => siteRoot(), /hadoku_site checkout does not exist/);
	} finally {
		process.chdir(prevCwd);
		if (prevEnv !== undefined) process.env.HADOKU_SITE_ROOT = prevEnv;
		rmSync(dir, { recursive: true, force: true });
	}
});
