/**
 * THE HELPER MUST MAKE A COMMIT WITHOUT WRITING A CONFIG FILE.
 *
 * Both halves are load-bearing and neither implies the other:
 *
 *   1. The commit LANDS with the fixture identity even though no `user.*` is
 *      set in the throwaway repo — otherwise the four conversions in this wave
 *      trade a config leak for a suite that cannot commit on a claw.
 *   2. NOTHING is written to any config — not the throwaway's, and above all
 *      not this repository's, which is the leak that put 59 commits on main
 *      under a fixture's name.
 *
 * The second is asserted against THIS repo's own config too, not just the
 * fixture's. A helper that leaked here would look perfect from inside a temp
 * directory, and "the fixture is clean" is precisely the evidence that was
 * available while main was being authored by `fleet test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_IDENTITY, cleanGitEnv, fixtureIdentityEnv } from './test-git-identity.mjs';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** `git config --local --get <key>` in `dir`, or null when it is not set. */
function localConfig(dir, key) {
	const r = execFileSync('git', ['-C', dir, 'config', '--local', '--get', key], {
		encoding: 'utf8',
		env: cleanGitEnv(),
		stdio: ['ignore', 'pipe', 'ignore'],
	}).trim();
	return r === '' ? null : r;
}

/** Same, but exit 1 (key absent) is an answer rather than a throw. */
function localConfigOrNull(dir, key) {
	try {
		return localConfig(dir, key);
	} catch (e) {
		if (e.status === 1) return null;
		throw e;
	}
}

test('fixtureIdentityEnv names the author AND the committer', () => {
	const env = fixtureIdentityEnv();
	assert.deepEqual(env, {
		GIT_AUTHOR_NAME: FIXTURE_IDENTITY.name,
		GIT_AUTHOR_EMAIL: FIXTURE_IDENTITY.email,
		GIT_COMMITTER_NAME: FIXTURE_IDENTITY.name,
		GIT_COMMITTER_EMAIL: FIXTURE_IDENTITY.email,
	});
});

test('cleanGitEnv strips an inherited GIT_DIR but keeps the identity', () => {
	// A hook hands its children GIT_DIR and GIT_INDEX_FILE, and they override
	// `cwd` for every git invocation. The identity travels in variables with the
	// same prefix, so the strip has to happen BEFORE the identity is added —
	// this is the assertion that catches the order being flipped.
	const prev = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE };
	process.env.GIT_DIR = '/nonexistent/hookish/.git';
	process.env.GIT_INDEX_FILE = '/nonexistent/hookish/.git/index';
	try {
		const env = cleanGitEnv();
		assert.equal(env.GIT_DIR, undefined);
		assert.equal(env.GIT_INDEX_FILE, undefined);
		assert.equal(env.GIT_AUTHOR_EMAIL, FIXTURE_IDENTITY.email);
		assert.equal(env.GIT_COMMITTER_EMAIL, FIXTURE_IDENTITY.email);
		assert.ok(env.PATH, 'the rest of the ambient environment survives');
	} finally {
		if (prev.dir === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = prev.dir;
		if (prev.index === undefined) delete process.env.GIT_INDEX_FILE;
		else process.env.GIT_INDEX_FILE = prev.index;
	}
});

test('cleanGitEnv merges extras over the identity, not under it', () => {
	const env = cleanGitEnv({ FLEET_NO_BANNER: '1', GIT_AUTHOR_NAME: 'override' });
	assert.equal(env.FLEET_NO_BANNER, '1');
	assert.equal(env.GIT_AUTHOR_NAME, 'override');
	assert.equal(env.GIT_AUTHOR_EMAIL, FIXTURE_IDENTITY.email);
});

test('a commit under the helper carries the fixture identity and writes no config', () => {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-identity-'));
	try {
		const env = cleanGitEnv();
		const git = (...a) =>
			execFileSync('git', a, {
				cwd: dir,
				env,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		git('init', '-q', '-b', 'main');
		writeFileSync(join(dir, 'f.txt'), 'x\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'base');

		assert.equal(git('log', '-1', '--format=%ae').trim(), FIXTURE_IDENTITY.email);
		assert.equal(git('log', '-1', '--format=%an').trim(), FIXTURE_IDENTITY.name);
		assert.equal(git('log', '-1', '--format=%ce').trim(), FIXTURE_IDENTITY.email);
		assert.equal(git('log', '-1', '--format=%cn').trim(), FIXTURE_IDENTITY.name);

		assert.equal(
			localConfigOrNull(dir, 'user.email'),
			null,
			'the fixture set an identity in its own config — the helper exists to avoid exactly that'
		);
		assert.equal(localConfigOrNull(dir, 'user.name'), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('this repository has no fixture identity in its own config', () => {
	// The leak, stated as an assertion. `--local` is the file every worktree of
	// this checkout shares (it lives in the common git dir), so a fixture write
	// from any worktree shows up right here.
	for (const key of ['user.email', 'user.name']) {
		const v = localConfigOrNull(REPO, key);
		assert.equal(
			v,
			null,
			`${key} is set repo-locally to ${JSON.stringify(v)} — a fixture identity leaked into ` +
				'the shared config; unset it with `git config --local --unset ' +
				`${key}\` and find what wrote it`
		);
	}
});
