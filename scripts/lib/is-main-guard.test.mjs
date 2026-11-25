/**
 * fleet-manager#160: the entry-point check is `isMain(import.meta.url)`
 * (`scripts/lib/is-main.mjs`) and nothing else. Comparing `import.meta.url`
 * against `argv[1]` by hand is false through any symlink, and pnpm installs
 * every package behind one: eleven scripts exited 0 having done nothing when
 * run from a consumer's node_modules. Comments AND string contents are blanked
 * first, so a file may still describe or quote the broken form.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** `import.meta.url ===`/`!==` anything, either side. */
const RAW = /import\.meta\.url\s*[!=]==|[!=]==\s*import\.meta\.url/;

void test('no script hand-rolls the entry-point check', () => {
	const files = execFileSync('git', ['ls-files', 'src', 'scripts', 'herdr', 'deploy'], {
		cwd: ROOT,
		encoding: 'utf8',
	})
		.split('\n')
		.filter((f) => /\.(m?js|ts|mts)$/.test(f));
	assert.ok(files.length > 100, `read only ${files.length} files; the listing is broken`);

	const offenders = [];
	for (const f of files) {
		const src = blankComments(readFileSync(join(ROOT, f), 'utf8'), { strings: true });
		src.split('\n').forEach((line, i) => {
			if (RAW.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
		});
	}
	assert.deepEqual(offenders, [], 'use isMain(import.meta.url) from scripts/lib/is-main.mjs');
});

void test('the pattern catches both broken forms it replaced', () => {
	assert.ok(RAW.test("if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {"));
	assert.ok(RAW.test('if (import.meta.url === `file://${process.argv[1]}`) main();'));
	assert.ok(!RAW.test('if (isMain(import.meta.url)) main();'));
});
