/**
 * classify() must agree with publish.yml's "Did the published surface
 * change?" step (package.json, src, scripts, deploy) — that is the whole
 * point of the file, see its docblock. The end-to-end tests run the real
 * script against a throwaway git repo so the failure path (a version field
 * the patch regex can't find) is exercised for real, never against this
 * repo's own package.json.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanGitEnv } from './lib/test-git-identity.mjs';

const { classify, nextVersion } = await import('./version-bump.mjs');

test('classify matches publish.yml surface: package.json, src/, scripts/, deploy/', () => {
	assert.equal(classify(['package.json']), true);
	assert.equal(classify(['src/index.ts']), true);
	assert.equal(classify(['scripts/lib/fleet-roster.mjs']), true);
	assert.equal(classify(['deploy/units/foo.service']), true);
	assert.equal(classify(['README.md', 'src/index.ts']), true);
});

test('classify ignores paths outside the published surface', () => {
	assert.equal(classify([]), false);
	assert.equal(classify(['README.md']), false);
	assert.equal(classify(['docs/plan.md', '.github/workflows/lint.yml']), false);
	assert.equal(classify(['manifests/fleet-runner-coverage.json']), false);
	assert.equal(classify(['tsconfig.json', 'tsconfig.build.json']), false);
});

test('nextVersion bumps the patch and rolls over to the next minor at .20', () => {
	assert.equal(nextVersion('0.9.1'), '0.9.2');
	assert.equal(nextVersion('1.2.20'), '1.3.0');
});

/**
 * The ambient environment with every `GIT_*` variable REMOVED.
 *
 * THIS IS NOT HYGIENE. Without it these tests REWRITE THE REPOSITORY THEY ARE
 * RUN FROM, and on 2026-09-08 they did.
 *
 * `git` reads `GIT_DIR` and `GIT_INDEX_FILE` from the environment, and those
 * OVERRIDE the process working directory. A hook's children inherit them --
 * that is how a hook is supposed to find the repo it was invoked for -- so when
 * `.husky/pre-push` runs `pnpm run check`, every `git` below inherits a GIT_DIR
 * pointing at the real repository. `cwd: dir` is then decoration: `git init`
 * reinitialises the REAL repo, `git add -A` stages the fixture's two files
 * against the REAL index, and `git commit` lands a commit authored `t <t@t>`
 * with the subject `init` on whatever branch the pusher was standing on.
 *
 * Observed, on branch ws-n: two `init` commits, one per fakeRepo() call, one
 * second apart, whose tree was reduced to the fixture's own package.json and
 * scripts/version-bump.mjs -- and `core.bare = true` written into the shared
 * config by the stray `git init`, which made every OTHER worktree report the
 * primary checkout as bare. The temp directory never even received a `.git`.
 *
 * It was invisible until d7e15a1 added a pre-push hook that runs the full
 * check. Run from a plain shell there are no GIT_* variables, `cwd` decides,
 * and everything passes -- so the suite was green for as long as nobody ran it
 * from inside a hook, which is precisely when it does damage.
 *
 * Applied to `node` too, not only to `git`: version-bump.mjs stages
 * package.json itself, so it is another git caller wearing a different name.
 *
 * IT ALSO CARRIES THE IDENTITY, which is the other half and a separate scar.
 * `fakeRepo` used to say `git config user.email t@t` — a WRITE to a config
 * file, and `cwd` does not decide which file. 21 commits on `origin/main`
 * between 09-07 and 09-15 are authored `t <t@t>`; that string came from here.
 * `cleanGitEnv` hands the identity to the child in `GIT_AUTHOR_*` /
 * `GIT_COMMITTER_*` instead, which no config file can outlive.
 */
const FIXTURE_ENV = cleanGitEnv();

/** A throwaway git repo with its own package.json, shaped like this one. */
function fakeRepo(version) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-version-bump-'));
	mkdirSync(join(dir, 'scripts'), { recursive: true });
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify({ name: '@wolffm/fleet-manager', version }, null, 2) + '\n'
	);
	writeFileSync(join(dir, 'scripts', 'version-bump.mjs'), readFileSync(SCRIPT, 'utf8'));
	const git = (...a) => execFileSync('git', a, { cwd: dir, env: FIXTURE_ENV, stdio: 'ignore' });
	git('init', '-q');
	git('add', '-A');
	git('commit', '-qm', 'init');
	return dir;
}

const SCRIPT = fileURLToPath(new URL('./version-bump.mjs', import.meta.url));

test('end-to-end: a staged src/ change bumps and re-stages package.json', () => {
	const dir = fakeRepo('0.9.1');
	try {
		writeFileSync(join(dir, 'src.placeholder'), 'x');
		execFileSync('git', ['add', 'src.placeholder'], { cwd: dir, env: FIXTURE_ENV });
		// version-bump.mjs classifies by NAME, not by what's staged in this repo's
		// index — reuse --files to simulate a src/ path without a real src/ dir.
		const out = execFileSync('node', ['scripts/version-bump.mjs', '--files', 'src/index.ts'], {
			cwd: dir,
			env: FIXTURE_ENV,
			encoding: 'utf8',
		});
		assert.match(out, /0\.9\.1 -> 0\.9\.2/);
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
		assert.equal(pkg.version, '0.9.2');
		const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
			cwd: dir,
			env: FIXTURE_ENV,
			encoding: 'utf8',
		});
		assert.match(staged, /package\.json/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('end-to-end: a docs-only change does not touch the version', () => {
	const dir = fakeRepo('0.9.1');
	try {
		execFileSync('node', ['scripts/version-bump.mjs', '--files', 'README.md'], {
			cwd: dir,
			env: FIXTURE_ENV,
			encoding: 'utf8',
		});
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
		assert.equal(pkg.version, '0.9.1');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// MUTATION CHECK (not a permanent test — see the report): a working-tree
// package.json whose "version" key the patch regex can't find in the RAW text
// must fail LOUDLY (exit 1), never silently leave the file unbumped. The key
// is unicode-escaped so JSON.parse still resolves it to `version` (parses to
// the same value as HEAD, so the "already moved" guard does not short-circuit
// first) while the literal substring `"version"` is absent from the source —
// exactly the case the regex-miss branch exists to catch. Exercised only
// against a throwaway repo, never against this repo's own package.json.
test('a version key the patch regex cannot find in the raw text fails loudly', () => {
	const dir = fakeRepo('0.9.1');
	try {
		writeFileSync(
			join(dir, 'package.json'),
			'{"name":"@wolffm/fleet-manager","versio\\u006e":"0.9.1"}'
		);
		assert.throws(() =>
			execFileSync('node', ['scripts/version-bump.mjs', '--files', 'src/index.ts'], {
				cwd: dir,
				env: FIXTURE_ENV,
				stdio: ['ignore', 'ignore', 'ignore'],
			})
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
