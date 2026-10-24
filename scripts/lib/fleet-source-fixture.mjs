/**
 * Fixture REMOTES for tests of anything that reads through `fleet-source.mjs`.
 *
 * Real bare repos on local disk, served over `file://`, not a mock of the
 * reader: the blobless fetch, the batched blob fetch and the CRLF
 * normalisation all run exactly as they do against GitHub. `uploadpack.*` is
 * set so the filter is honoured and blobs really are fetched lazily.
 *
 * Every git child has `GIT_*` stripped and its identity in the ENVIRONMENT —
 * lib/hook-safe-tests.test.mjs and lib/test-git-identity.mjs say why.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fixtureIdentityEnv } from './test-git-identity.mjs';

const ENV = {
	...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
	...fixtureIdentityEnv(),
};
const run = (cwd, ...args) =>
	execFileSync('git', args, { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

/**
 * A directory of fixture remotes, plus the env that points the reader at them.
 *
 * `push(repo, files)` commits `files` ({ path: content }, content written as
 * given — CRLF stays CRLF) on top of the repo's default branch, creating the
 * remote on first use. `env` is `{ FLEET_SOURCE_URL, FLEET_SOURCE_CACHE,
 * FLEET_SOURCE_MAX_AGE_S: '0' }`, so every read fetches and a test sees its
 * latest push.
 */
export function fixtureRemotes(prefix = 'fleet-source-') {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const remotes = join(root, 'remotes');
	const work = join(root, 'work');
	const env = {
		FLEET_SOURCE_URL: `file://${remotes}/{repo}.git`,
		FLEET_SOURCE_CACHE: join(root, 'cache'),
		FLEET_SOURCE_MAX_AGE_S: '0',
	};
	return {
		root,
		env,
		/** The bare remote's path for `repo`. */
		remote: (repo) => join(remotes, `${repo}.git`),
		/**
		 * @param {string} repo `owner/name`
		 * @param {Record<string, string | null>} files a null content deletes the path
		 * @param {string} [message]
		 * @param {{ ageSec?: number }} [opts] date the commit `ageSec` in the past
		 */
		push(repo, files, message = 'fixture', { ageSec } = {}) {
			const bare = join(remotes, `${repo}.git`);
			const tree = join(work, repo);
			mkdirSync(dirname(bare), { recursive: true });
			try {
				run(bare, 'rev-parse', '--git-dir');
			} catch {
				mkdirSync(bare, { recursive: true });
				run(bare, 'init', '-q', '--bare', '-b', 'main');
				run(bare, 'config', 'uploadpack.allowFilter', 'true');
				run(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
				mkdirSync(tree, { recursive: true });
				run(tree, 'init', '-q', '-b', 'main');
				run(tree, 'config', 'core.autocrlf', 'false');
				run(tree, 'remote', 'add', 'origin', bare);
			}
			for (const [path, content] of Object.entries(files)) {
				const abs = join(tree, path);
				if (content === null) rmSync(abs, { force: true });
				else {
					mkdirSync(dirname(abs), { recursive: true });
					writeFileSync(abs, content);
				}
			}
			run(tree, 'add', '-A');
			if (ageSec === undefined) run(tree, 'commit', '-q', '--allow-empty', '-m', message);
			else {
				const when = `@${Math.floor(Date.now() / 1000) - ageSec} +0000`;
				execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], {
					cwd: tree,
					env: { ...ENV, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
					stdio: ['ignore', 'pipe', 'pipe'],
				});
			}
			run(tree, 'push', '-q', 'origin', 'HEAD:main');
			return run(tree, 'rev-parse', 'HEAD').trim();
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/**
 * A LOCAL CLONE THAT LIES: a checkout of `repo` under `reposDir` holding what
 * the remote held at `files`, then each poison applied — `crlf` rewrites every
 * text file with CRLF endings, `edit` overwrites paths in the working tree
 * without committing. The remote moves on separately; the clone is "behind" by
 * construction. Every migrated gate is tested against one of these to prove
 * nothing it holds can change the verdict.
 *
 * @param {string} reposDir
 * @param {string} repo
 * @param {Record<string, string>} files
 * @param {{ crlf?: boolean, edit?: Record<string, string> }} [poison]
 */
export function poisonedClone(reposDir, repo, files, poison = {}) {
	const dir = join(reposDir, repo.split('/').pop());
	mkdirSync(dir, { recursive: true });
	run(dir, 'init', '-q', '-b', 'main');
	for (const [path, content] of Object.entries(files)) {
		const abs = join(dir, path);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	}
	run(dir, 'add', '-A');
	run(dir, 'commit', '-q', '--allow-empty', '-m', 'stale');
	// A ref that LOOKS like a fetched origin/main, so a gate reading the clone's
	// origin/main reads the stale commit too.
	run(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
	for (const [path, content] of Object.entries(files)) {
		if (poison.crlf) writeFileSync(join(dir, path), content.replace(/\r?\n/g, '\r\n'));
	}
	for (const [path, content] of Object.entries(poison.edit ?? {})) {
		const abs = join(dir, path);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	}
	return dir;
}
