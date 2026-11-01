// End to end against a real bare remote and a stand-in GitHub API: what the
// promoter PUSHES, not only what it decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { actionEnv, commit, fakeApi, git, makeRepo, readFile, remoteSha } from './ppe-fixtures.mjs';
import { main } from './promote.mjs';

const NOW = Date.now();
const MIN = 60_000;
/** Cadence satisfied: main untouched for an hour. */
const idle = { 'refs/heads/main': NOW - 60 * MIN, 'refs/heads/ppe': NOW - 1 * MIN };

async function run(repo, state, extra = {}) {
	const api = await fakeApi(state);
	try {
		const a = actionEnv(repo, api.base, { PPE_NOW_MS: String(NOW), ...extra });
		const code = await main(a.env);
		return { code, out: a.outputs() };
	} finally {
		await api.close();
	}
}

test('no deploy key: refuses before touching anything', async () => {
	const code = await main({ GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'x' });
	assert.equal(code, 1);
});

test('fast-forwards main to the newest green ppe commit, past a pending tip', async () => {
	const repo = makeRepo();
	const g1 = commit(repo.work, 'a.txt', 'one\n', 'one\n\nSession: lane-a');
	const g2 = commit(repo.work, 'a.txt', 'two\n', 'two\n\nSession: lane-b');
	const tip = commit(repo.work, 'a.txt', 'three\n', 'three\n\nSession: lane-c');
	git(repo.work, 'push', '-q', 'origin', 'HEAD:refs/heads/ppe');
	const state = {
		checks: { [g1]: 'success', [g2]: 'success', [tip]: 'in_progress' },
		activity: idle,
	};

	const { code, out } = await run(repo, state);
	assert.equal(code, 0);
	assert.equal(out.action, 'promoted');
	assert.equal(remoteSha(repo.bare, 'main'), g2);
	assert.equal(remoteSha(repo.bare, 'ppe'), tip, 'ppe is never rewritten by a promotion');
	assert.deepEqual(state.issues, []);
});

test('inside the cadence nothing moves; force moves it', async () => {
	const repo = makeRepo();
	const before = remoteSha(repo.bare, 'main');
	const g = commit(repo.work, 'a.txt', 'one\n', 'one');
	git(repo.work, 'push', '-q', 'origin', 'HEAD:refs/heads/ppe');
	const busy = { 'refs/heads/main': NOW - 5 * MIN, 'refs/heads/ppe': NOW - 2 * MIN };

	const waited = await run(repo, { checks: { [g]: 'success' }, activity: busy });
	assert.equal(waited.code, 0);
	assert.equal(waited.out.action, 'none');
	assert.equal(remoteSha(repo.bare, 'main'), before);

	const forced = await run(
		repo,
		{ checks: { [g]: 'success' }, activity: busy },
		{ PPE_FORCE: 'true' }
	);
	assert.equal(forced.out.action, 'promoted');
	assert.equal(remoteSha(repo.bare, 'main'), g);
});

test('a red push is reverted on ppe, attributed, and the green below it still promotes', async () => {
	const repo = makeRepo();
	const g = commit(repo.work, 'a.txt', 'good\n', 'good\n\nSession: lane-good');
	const u = commit(repo.work, 'b.txt', 'half\n', 'half of the bad push\n\nSession: lane-bad');
	const r = commit(repo.work, 'c.txt', 'bad\n', 'the bad push\n\nSession: lane-bad');
	git(repo.work, 'push', '-q', 'origin', 'HEAD:refs/heads/ppe');
	const state = { checks: { [g]: 'success', [r]: 'failure' }, activity: idle };

	const { code, out } = await run(repo, state);
	assert.equal(code, 0);
	assert.equal(out.action, 'promoted+reverted');
	assert.equal(remoteSha(repo.bare, 'main'), g);

	const ppe = remoteSha(repo.bare, 'ppe');
	assert.equal(
		git(repo.bare, 'rev-parse', `${ppe}^`),
		r,
		'the revert sits on top of the red push: no rewrite'
	);
	assert.equal(
		git(repo.bare, 'diff', '--stat', g, ppe),
		'',
		'the revert undoes the whole push, both commits'
	);
	const msg = git(repo.bare, 'log', '-1', '--format=%B', ppe);
	assert.match(msg, new RegExp(`Reverts-Push: ${r}`));
	assert.match(msg, new RegExp(`${u.slice(0, 7)} half of the bad push \\(Session: lane-bad\\)`));

	assert.equal(state.issues.length, 1);
	assert.match(state.issues[0].title, new RegExp(r.slice(0, 7)));
	assert.match(state.issues[0].body, /`lane-bad`/);
	assert.doesNotMatch(state.issues[0].body, /lane-good/);
});

test('the run after a revert does not revert the same push again', async () => {
	const repo = makeRepo();
	const g = commit(repo.work, 'a.txt', 'good\n', 'good');
	const r = commit(repo.work, 'c.txt', 'bad\n', 'bad');
	git(repo.work, 'push', '-q', 'origin', 'HEAD:refs/heads/ppe');
	const state = { checks: { [g]: 'success', [r]: 'failure' }, activity: idle };
	await run(repo, state);
	const afterFirst = remoteSha(repo.bare, 'ppe');

	// The revert's own CI has not reported yet.
	const second = await run(repo, state);
	assert.equal(second.code, 0);
	assert.equal(remoteSha(repo.bare, 'ppe'), afterFirst);
	assert.equal(state.issues.length, 1);
});

test('could not look: a failed check read promotes nothing, reverts nothing, files nothing', async () => {
	const repo = makeRepo();
	const before = remoteSha(repo.bare, 'main');
	const g = commit(repo.work, 'a.txt', 'good\n', 'good');
	const r = commit(repo.work, 'c.txt', 'bad\n', 'bad');
	git(repo.work, 'push', '-q', 'origin', 'HEAD:refs/heads/ppe');
	const state = { checks: { [g]: 'success', [r]: 'failure' }, activity: idle, fail: /check-runs$/ };

	const { code, out } = await run(repo, state);
	assert.equal(code, 1);
	assert.equal(out.action, 'could-not-look');
	assert.equal(remoteSha(repo.bare, 'main'), before);
	assert.equal(remoteSha(repo.bare, 'ppe'), r);
	assert.deepEqual(state.issues, []);
});

test('could not look: no required checks anywhere means nothing is green', async () => {
	const repo = makeRepo();
	const before = remoteSha(repo.bare, 'main');
	const g = commit(repo.work, 'a.txt', 'good\n', 'good');
	git(repo.work, 'push', '-q', 'origin', 'HEAD:refs/heads/ppe');

	const { code, out } = await run(repo, {
		checks: { [g]: 'success' },
		activity: idle,
		ruleset: false,
	});
	assert.equal(code, 1);
	assert.equal(out.action, 'could-not-look');
	assert.equal(remoteSha(repo.bare, 'main'), before);
});

test('could not look: an unreadable push time does not promote', async () => {
	const repo = makeRepo();
	const before = remoteSha(repo.bare, 'main');
	const g = commit(repo.work, 'a.txt', 'good\n', 'good');
	git(repo.work, 'push', '-q', 'origin', 'HEAD:refs/heads/ppe');

	const { code } = await run(repo, {
		checks: { [g]: 'success' },
		activity: idle,
		fail: /activity$/,
	});
	assert.equal(code, 1);
	assert.equal(remoteSha(repo.bare, 'main'), before);
});

test('a revert that conflicts goes to a human: ppe untouched, issue filed, job red', async () => {
	const repo = makeRepo();
	const g = commit(repo.work, 'a.txt', 'good\n', 'good');
	const r = commit(repo.work, 'c.txt', 'bad\n', 'bad');
	// Pushed later, on top of the red one, rewriting the same line.
	const later = commit(repo.work, 'c.txt', 'built on bad\n', 'later');
	git(repo.work, 'push', '-q', 'origin', 'HEAD:refs/heads/ppe');
	const state = { checks: { [g]: 'success', [r]: 'failure', [later]: 'failure' }, activity: idle };

	const { code } = await run(repo, state);
	assert.equal(code, 1);
	assert.equal(remoteSha(repo.bare, 'ppe'), later);
	assert.equal(remoteSha(repo.bare, 'main'), g, 'the green below still promoted');
	assert.equal(state.issues.length, 1);
	assert.match(state.issues[0].title, /needs a human/);
	assert.equal(readFile(repo.bare, 'ppe', 'c.txt'), 'built on bad');
});

test('main moved by a bot and not yet synced: no fast-forward attempted', async () => {
	const repo = makeRepo();
	const g = commit(repo.work, 'a.txt', 'good\n', 'good');
	git(repo.work, 'push', '-q', 'origin', 'HEAD:refs/heads/ppe');
	git(repo.work, 'fetch', '-q', 'origin');
	git(repo.work, 'checkout', '-q', 'origin/main');
	const bot = commit(repo.work, 'd.txt', 'bump\n', 'chore: update packages');
	git(repo.work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');

	const { code, out } = await run(repo, { checks: { [g]: 'success' }, activity: idle });
	assert.equal(code, 0);
	assert.equal(out.action, 'none');
	assert.equal(remoteSha(repo.bare, 'main'), bot);
});
