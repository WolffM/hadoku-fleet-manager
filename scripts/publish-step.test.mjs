/**
 * publish.yml's Publish step, run for real against a stand-in `npm`.
 *
 * The step's shell is EXTRACTED from the workflow on every run, never retyped:
 * a copy here would keep passing after the workflow changed under it. The
 * stand-in answers `npm view <pkg>@<v> version|gitHead` from the env and
 * records whether `npm publish` was called, so the three outcomes the step
 * decides between are asserted directly.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, cleanupTempDirs } from './lib/test-tmpdir.mjs';

afterEach(cleanupTempDirs);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'publish.yml');

/** The `run: |` block of the step named `name`, dedented. Line-based: a YAML
 *  literal block is exactly "every line indented past the `run:` key". */
function stepRun(yamlText, name) {
	const lines = yamlText.split('\n');
	const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
	assert.notEqual(at, -1, `no step named "${name}" in publish.yml`);
	const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
	assert.notEqual(runAt, -1, `step "${name}" has no run: | block`);
	const keyIndent = lines[runAt].search(/\S/);
	const body = [];
	for (const l of lines.slice(runAt + 1)) {
		if (l.trim() && l.search(/\S/) <= keyIndent) break;
		body.push(l);
	}
	const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
	const text = body.map((l) => l.slice(indent)).join('\n');
	// Expressions belong in `env:`. One in the body would be substituted by the
	// runner and not by this harness, so the two would run different code.
	assert.doesNotMatch(text, /\$\{\{/, 'an expression in the run body is untestable here');
	return text;
}

const SHA = 'eb7f1412e00a473a9bbf625c472ec180c9be3d17';

/** Run the Publish step with `npm` answering per `registry`. */
function runPublish({ published, gitHead, sha = SHA }) {
	const dir = tempDir('publish-step-');
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.34.64' }));
	writeFileSync(join(dir, 'step.sh'), stepRun(readFileSync(WORKFLOW, 'utf8'), 'Publish'));
	const npm = join(bin, 'npm');
	writeFileSync(
		npm,
		[
			'#!/usr/bin/env bash',
			'case "$1 $3" in',
			'  "view version") [ "$FAKE_PUBLISHED" = yes ] && echo 0.34.64 && exit 0; exit 1 ;;',
			'  "view gitHead") [ -n "$FAKE_GITHEAD" ] && echo "$FAKE_GITHEAD" && exit 0; exit 1 ;;',
			'esac',
			'[ "$1" = publish ] && touch "$PUBLISHED_MARK" && exit 0',
			'echo "fake npm: unexpected $*" >&2; exit 2',
			'',
		].join('\n')
	);
	chmodSync(npm, 0o755);
	const mark = join(dir, 'published');
	const r = spawnSync('bash', ['-e', '-o', 'pipefail', join(dir, 'step.sh')], {
		cwd: dir,
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			GITHUB_SHA: sha,
			FAKE_PUBLISHED: published ? 'yes' : 'no',
			FAKE_GITHEAD: gitHead ?? '',
			PUBLISHED_MARK: mark,
		},
	});
	return { status: r.status, out: r.stdout + r.stderr, didPublish: existsSync(mark) };
}

test('a new version is published', () => {
	const r = runPublish({ published: false });
	assert.equal(r.status, 0, r.out);
	assert.equal(r.didPublish, true);
});

test('a RE-RUN of the commit that published it skips to the dispatch (2026-10-25, 0.34.64)', () => {
	const r = runPublish({ published: true, gitHead: SHA });
	assert.equal(r.status, 0, r.out);
	assert.equal(r.didPublish, false, 'must not try to publish the same version twice');
	assert.match(r.out, /published by this commit/);
});

test('a version published by ANOTHER commit is still a missed bump, and fails', () => {
	const r = runPublish({ published: true, gitHead: 'c435d199364905fe51193ba591cad3cc9189ef09' });
	assert.equal(r.status, 1, r.out);
	assert.equal(r.didPublish, false);
	assert.match(r.out, /already published/);
});

test('an unreadable gitHead is not taken as "this commit" — it fails, the strict direction', () => {
	const r = runPublish({ published: true, gitHead: '' });
	assert.equal(r.status, 1, r.out);
	assert.match(r.out, /already published/);
});
