/**
 * fleet-manager#160: a script reached through a symlink must still run main().
 * pnpm puts every installed package behind one, so this is the consumer's
 * normal path, not an edge case. Before the fix `io-cost-ab.mjs --help` run
 * through mgmt-api's node_modules exited 0 with zero bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMain } from './is-main.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** A pnpm-shaped layout: `node_modules/pkg` → `.pnpm/pkg@1/node_modules/pkg`. */
function withLinkedPackage(fn) {
	const dir = mkdtempSync(join(tmpdir(), 'is-main-'));
	try {
		const link = join(dir, 'node_modules', 'pkg');
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(ROOT, link, 'dir');
		return fn(link);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

void test('a shipped script run through a pnpm-style symlink runs main()', () => {
	const out = withLinkedPackage((pkg) =>
		execFileSync(process.execPath, [join(pkg, 'scripts', 'io-cost-ab.mjs'), '--help'], {
			encoding: 'utf8',
		})
	);
	assert.match(out, /io-cost-ab: does enforcing io\.weight keep the interactive desktop/);
});

void test('a symlinked FILE is main too, and an importer is not', () => {
	const dir = mkdtempSync(join(tmpdir(), 'is-main-'));
	try {
		const real = join(dir, 'real.mjs');
		writeFileSync(
			real,
			`import { isMain } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts/lib/is-main.mjs')).href)};\n` +
				`process.stdout.write(isMain(import.meta.url) ? 'main' : 'imported');\n`
		);
		const link = join(dir, 'link.mjs');
		symlinkSync(real, link);
		const run = (args) => execFileSync(process.execPath, args, { encoding: 'utf8' });
		assert.equal(run([link]), 'main');
		assert.equal(run([real]), 'main');
		assert.equal(
			run([
				'--input-type=module',
				'-e',
				`await import(${JSON.stringify(pathToFileURL(link).href)})`,
			]),
			'imported'
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

void test('no entry, or an entry that does not exist, is not main', () => {
	assert.equal(isMain(import.meta.url, ''), false);
	assert.equal(isMain(import.meta.url, '/nonexistent/is-main-160.mjs'), false);
	assert.equal(isMain(import.meta.url, fileURLToPath(import.meta.url)), true);
});
