/**
 * `split-check.mjs` against a FIXTURE repo built fresh in a temp dir by this
 * test — never against fleet-manager's own history. Every git call below
 * drops any inherited `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE` and passes
 * its own `cwd`, and every commit is authored via `-c user.name=`/
 * `-c user.email=` flags rather than a `git config` write, per the worktree
 * rule in this wave's brief (also: memory `tests-rewrote-the-repo` — `GIT_DIR`
 * beats `cwd` inside a hook, and this repo has paid for that once already).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkSplit } from './split-check.mjs';

function git(cwd, args) {
	const env = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_INDEX_FILE;
	delete env.GIT_WORK_TREE;
	return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

function commit(cwd, message) {
	git(cwd, [
		'-c',
		'user.name=split-check fixture',
		'-c',
		'user.email=fixture@example.invalid',
		'commit',
		'-m',
		message,
		'--no-gpg-sign',
	]);
}

/**
 * A fresh fixture repo with one commit, returned as `{ dir, base }` where
 * `base` is that commit's SHA. A SHA, not a tag: this host's git has
 * `tag.gpgSign=true`, which turns a plain `git tag` into a signed/annotated
 * one that then wants a message or a key — neither of which this fixture
 * needs, since `git rev-parse HEAD` already names the commit exactly.
 */
function makeFixture() {
	const dir = mkdtempSync(join(tmpdir(), 'split-check-fixture-'));
	git(dir, ['init', '--quiet', '--initial-branch=main']);
	writeFileSync(
		join(dir, 'a.mjs'),
		['export function helper(x) {', '\treturn x + 1;', '}', ''].join('\n')
	);
	git(dir, ['add', 'a.mjs']);
	commit(dir, 'base');
	const base = git(dir, ['rev-parse', 'HEAD']).trim();
	return { dir, base };
}

void test('split-check: a pure move (same lines, different file) passes', () => {
	const { dir, base } = makeFixture();
	try {
		// Move `helper`'s body out of a.mjs into a new b.mjs, re-exported from a.mjs.
		writeFileSync(
			join(dir, 'b.mjs'),
			['export function helper(x) {', '\treturn x + 1;', '}', ''].join('\n')
		);
		writeFileSync(join(dir, 'a.mjs'), ["export { helper } from './b.mjs';", ''].join('\n'));
		git(dir, ['add', '-A']);
		commit(dir, 'split helper into b.mjs');

		const result = checkSplit(`${base}..HEAD`, { cwd: dir });
		assert.equal(
			result.ok,
			true,
			`expected a clean pure move; findings: ${result.findings.join('; ')}`
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

void test('split-check: exporting the moved function for the first time still passes', () => {
	// A DIFFERENT fixture: `helper` starts un-exported (private to a.mjs) and
	// is called locally. The split exports it from a new b.mjs and a.mjs
	// imports it back — so the moved declaration line gains an `export `
	// prefix it did not carry before. A straight line-COUNT comparison
	// already treats this correctly: the old line is one removed line, the
	// new (export-prefixed) line is one added line, 1-for-1, with no special
	// normalization required.
	const dir = mkdtempSync(join(tmpdir(), 'split-check-fixture-'));
	try {
		git(dir, ['init', '--quiet', '--initial-branch=main']);
		writeFileSync(
			join(dir, 'a.mjs'),
			['function helper(x) {', '\treturn x + 1;', '}', 'helper(1);', ''].join('\n')
		);
		git(dir, ['add', 'a.mjs']);
		commit(dir, 'base');
		const base = git(dir, ['rev-parse', 'HEAD']).trim();

		writeFileSync(
			join(dir, 'b.mjs'),
			['export function helper(x) {', '\treturn x + 1;', '}', ''].join('\n')
		);
		writeFileSync(
			join(dir, 'a.mjs'),
			["import { helper } from './b.mjs';", 'helper(1);', ''].join('\n')
		);
		git(dir, ['add', '-A']);
		commit(dir, 'split helper into b.mjs, now exported');

		const result = checkSplit(`${base}..HEAD`, { cwd: dir });
		assert.equal(result.ok, true, `expected pass; findings: ${result.findings.join('; ')}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

void test('split-check: a diff that drops a line fails, and names the mismatch', () => {
	const { dir, base } = makeFixture();
	try {
		// The move loses the return statement — not a pure move.
		writeFileSync(join(dir, 'b.mjs'), ['export function helper(x) {', '}', ''].join('\n'));
		writeFileSync(join(dir, 'a.mjs'), ["export { helper } from './b.mjs';", ''].join('\n'));
		git(dir, ['add', '-A']);
		commit(dir, 'lossy split');

		const result = checkSplit(`${base}..HEAD`, { cwd: dir });
		assert.equal(result.ok, false);
		assert.match(result.findings.join('\n'), /line conservation/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

void test('split-check: removing a test without re-adding it fails the test-count check', () => {
	const { dir } = makeFixture();
	try {
		writeFileSync(
			join(dir, 'a.test.mjs'),
			[
				"import { test } from 'node:test';",
				"void test('one', () => {});",
				"void test('two', () => {});",
				'',
			].join('\n')
		);
		git(dir, ['add', '-A']);
		commit(dir, 'add tests');
		const base = git(dir, ['rev-parse', 'HEAD']).trim();

		writeFileSync(
			join(dir, 'a.test.mjs'),
			["import { test } from 'node:test';", "void test('one', () => {});", ''].join('\n')
		);
		git(dir, ['add', '-A']);
		commit(dir, 'drop a test');

		const result = checkSplit(`${base}..HEAD`, { cwd: dir });
		assert.equal(result.ok, false);
		assert.match(result.findings.join('\n'), /test-count delta/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

void test('split-check: a re-export shim line is a free addition, not a mismatch', () => {
	const { dir, base } = makeFixture();
	try {
		// b.mjs is new content (a genuine addition), AND a.mjs gains a bare
		// `export { helper };` shim with nothing removed to balance it —
		// SHIM_LINE must exclude that line from the added count, or this
		// would wrongly fail a legitimate "re-export shim at every published
		// subpath that moves" (plan §10).
		writeFileSync(
			join(dir, 'a.mjs'),
			['export function helper(x) {', '\treturn x + 1;', '}', 'export { helper };', ''].join('\n')
		);
		git(dir, ['add', '-A']);
		commit(dir, 'add a shim line with nothing removed');

		const result = checkSplit(`${base}..HEAD`, { cwd: dir });
		assert.equal(
			result.ok,
			true,
			`expected the shim line to be free; findings: ${result.findings.join('; ')}`
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
