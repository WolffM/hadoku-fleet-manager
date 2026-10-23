import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { foreignRoots } from './check-public-history.mjs';
import { cleanGitEnv } from './lib/test-git-identity.mjs';

const ENV = cleanGitEnv();
const ZERO = '0'.repeat(40);

/**
 * The cut in miniature: `old` is the private history, `root` the squashed
 * public root grafted onto it the way attach-private.sh does.
 */
function cutRepo() {
	const dir = mkdtempSync(join(tmpdir(), 'public-history-'));
	const git = (...a) => execFileSync('git', a, { cwd: dir, env: ENV, encoding: 'utf8' }).trim();
	const commit = (msg) => {
		writeFileSync(join(dir, 'f'), msg);
		git('add', 'f');
		git('commit', '-qm', msg);
		return git('rev-parse', 'HEAD');
	};
	git('init', '-q', '-b', 'old');
	const oldRoot = commit('private root');
	const oldTip = commit('private tip');
	git('checkout', '-q', '--orphan', 'main');
	const root = commit('public root');
	git('replace', '--graft', root, oldTip);
	git('checkout', '-q', '-b', 'feature', oldTip);
	const feature = commit('work begun before the cut');
	git('checkout', '-q', 'main');
	const clean = commit('public work');
	return { dir, git, root, oldRoot, feature, clean };
}

const line = (sha) => `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`;

test('a public commit reaches only the public root, graft and all', () => {
	const r = cutRepo();
	try {
		// The graft is live: with it, git sees ONE history running to the private root.
		assert.equal(r.git('rev-list', '--max-parents=0', r.clean), r.oldRoot);
		assert.deepEqual(foreignRoots(line(r.clean), { root: r.root, cwd: r.dir, env: ENV }), []);
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

test('a merge with a pre-cut branch is refused, naming the private root', () => {
	const r = cutRepo();
	try {
		r.git('merge', '-q', '--no-edit', '-X', 'theirs', 'feature');
		const merged = r.git('rev-parse', 'HEAD');
		assert.deepEqual(foreignRoots(line(merged), { root: r.root, cwd: r.dir, env: ENV }), [
			{ ref: 'refs/heads/main', sha: merged, roots: [r.oldRoot] },
		]);
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

test('a rebase of the same branch passes, and a deletion is not inspected', () => {
	const r = cutRepo();
	try {
		r.git('checkout', '-q', 'feature');
		r.git('rebase', '-q', '-X', 'theirs', 'main');
		const rebased = r.git('rev-parse', 'HEAD');
		const input = line(rebased) + `(delete) ${ZERO} refs/heads/gone ${r.feature}\n`;
		assert.deepEqual(foreignRoots(input, { root: r.root, cwd: r.dir, env: ENV }), []);
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});
