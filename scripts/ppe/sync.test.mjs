import { test } from 'node:test';
import assert from 'node:assert/strict';

import { actionEnv, commit, fakeApi, git, makeRepo, readFile, remoteSha } from './ppe-fixtures.mjs';
import { main } from './sync.mjs';

async function run(repo, state = {}) {
	state.checks ??= {};
	const api = await fakeApi(state);
	try {
		const a = actionEnv(repo, api.base);
		const code = await main(a.env);
		return { code, out: a.outputs(), state };
	} finally {
		await api.close();
	}
}

/** A bot commit straight onto main, beside whatever ppe holds. */
function botPush(repo, file, content) {
	git(repo.work, 'fetch', '-q', 'origin');
	git(repo.work, 'checkout', '-q', '--detach', 'origin/main');
	const sha = commit(repo.work, file, content, 'chore: update packages');
	git(repo.work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
	return sha;
}

test('no deploy key: refuses before touching anything', async () => {
	assert.equal(await main({ GITHUB_REPOSITORY: 'o/r' }), 1);
});

test('a bot push to main is merged into ppe, keeping both sides', async () => {
	const repo = makeRepo();
	const work = commit(repo.work, 'a.txt', 'feature\n', 'feature');
	git(repo.work, 'push', '-q', 'origin', 'HEAD:refs/heads/ppe');
	const bot = botPush(repo, 'deps.txt', 'bumped\n');

	const { code, out } = await run(repo);
	assert.equal(code, 0);
	assert.equal(out.action, 'merged');
	const ppe = remoteSha(repo.bare, 'ppe');
	assert.deepEqual(git(repo.bare, 'log', '-1', '--format=%P', ppe).split(' '), [work, bot]);
	assert.equal(readFile(repo.bare, 'ppe', 'a.txt'), 'feature');
	assert.equal(readFile(repo.bare, 'ppe', 'deps.txt'), 'bumped');
	assert.match(git(repo.bare, 'log', '-1', '--format=%B', ppe), /Session: sync-main-to-ppe/);
	assert.equal(remoteSha(repo.bare, 'main'), bot, 'main is never written by the sync');
});

test("a promotion's push to main is already in ppe: nothing to do", async () => {
	const repo = makeRepo();
	const a = commit(repo.work, 'a.txt', 'one\n', 'one');
	commit(repo.work, 'a.txt', 'two\n', 'two');
	git(repo.work, 'push', '-q', 'origin', 'HEAD:refs/heads/ppe', `${a}:refs/heads/main`);
	const ppe = remoteSha(repo.bare, 'ppe');

	const { code, out } = await run(repo);
	assert.equal(code, 0);
	assert.equal(out.action, 'none');
	assert.equal(remoteSha(repo.bare, 'ppe'), ppe);
});

test('a conflict is reported and never forced: ppe untouched, issue filed, job red', async () => {
	const repo = makeRepo();
	commit(repo.work, 'a.txt', 'ppe side\n', 'ppe edit');
	git(repo.work, 'push', '-q', 'origin', 'HEAD:refs/heads/ppe');
	const ppe = remoteSha(repo.bare, 'ppe');
	botPush(repo, 'a.txt', 'main side\n');

	const { code, out, state } = await run(repo);
	assert.equal(code, 1);
	assert.equal(out.action, 'conflict');
	assert.equal(remoteSha(repo.bare, 'ppe'), ppe);
	assert.equal(state.issues.length, 1);
	assert.match(state.issues[0].body, /`a\.txt`/);

	// A second run while it is still unresolved reuses the open issue.
	await run(repo, state);
	assert.equal(state.issues.length, 1);
});

test('could not look: a missing ppe branch merges nothing', async () => {
	const repo = makeRepo();
	git(repo.bare, 'update-ref', '-d', 'refs/heads/ppe');
	const { code, out } = await run(repo);
	assert.equal(code, 1);
	assert.equal(out.action, 'could-not-look');
});
