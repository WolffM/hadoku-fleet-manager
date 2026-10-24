/**
 * NO NEW CODE READS ANOTHER REPO'S SOURCE OFF `REPOS_DIR` (fleet-manager#7).
 *
 * Another repo's shipped files come from `lib/fleet-source.mjs`: its default
 * branch, fetched by the reader itself. `reposDir()` names the operator's
 * sibling checkouts, which exist on hokon only and are as stale as whoever last
 * pulled them; on 2026-10-24 one of them, CRLF and 1627 commits behind, made
 * `check:label-floor` report a parse failure in a file that was fine on GitHub.
 *
 * So `reposDir()` / `REPOS_DIR` in a non-test source is allowed only where this
 * file says why. A new caller fails the build until it either reads through the
 * reader or earns an entry here. Comments are blanked first, so prose about the
 * old behaviour cannot trip it and a commented-out call cannot satisfy it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** path -> why it may still name the sibling checkouts. */
const ALLOWED = {
	'scripts/check-header-fleet.mjs': '--worktree only: an operator auditing working copies',
	'scripts/check-tier-fleet.mjs': '--worktree only: an operator auditing working copies',
	'scripts/check-mf-externals.mjs': '--worktree only: an operator auditing working copies',
	'scripts/check-contract-consumers.mjs':
		'builds a banner SAMPLE string from the path; reads nothing there',
	'scripts/lib/refresh-cycle.mjs':
		'a WRITER: commits manifests through a worktree of the hub clone, which needs a clone',
	'src/lib/fleet-paths.ts': 'defines reposDir, and siteRoot() falls back to it',
	'src/cli.ts': '--help text naming the variable',
};

const PATTERN = /\breposDir\s*\(|\bREPOS_DIR\b/;

function sources() {
	const out = [];
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
			const abs = join(dir, e.name);
			if (e.isDirectory()) walk(abs);
			else if (/\.(mjs|ts)$/.test(e.name) && !/\.test\.(mjs|ts)$/.test(e.name)) out.push(abs);
		}
	};
	walk(join(ROOT, 'scripts'));
	walk(join(ROOT, 'src'));
	return out;
}

/** Sources whose CODE (comments blanked) names the sibling checkouts. */
function callers(files) {
	return files
		.filter((abs) => !abs.includes(`${join('src', 'tests')}`))
		.filter((abs) => PATTERN.test(blankComments(readFileSync(abs, 'utf8'))))
		.map((abs) => relative(ROOT, abs).split('\\').join('/'))
		.sort();
}

test('the walk found the sources it guards — an empty walk would pass vacuously', () => {
	assert.ok(sources().length > 100, `walked only ${sources().length} source files`);
});

test('only reviewed callers name REPOS_DIR / reposDir() — read another repo through fleet-source', () => {
	const found = callers(sources());
	const unexpected = found.filter((f) => !(f in ALLOWED));
	assert.deepEqual(
		unexpected,
		[],
		`these read the sibling checkouts under REPOS_DIR: ${unexpected.join(', ')}. Another repo's ` +
			'shipped files come from scripts/lib/fleet-source.mjs (shipped/tryShipped). If this one ' +
			'genuinely needs a local checkout, add it to ALLOWED with the reason.'
	);
	const stale = Object.keys(ALLOWED).filter((f) => !found.includes(f));
	assert.deepEqual(
		stale,
		[],
		`ALLOWED entries that no longer name REPOS_DIR — remove them: ${stale}`
	);
});

test('the detector fires on a call and on the variable, and not on prose', () => {
	assert.ok(PATTERN.test(blankComments("const d = join(reposDir(), 'x');\n")));
	assert.ok(PATTERN.test(blankComments('const d = process.env.REPOS_DIR;\n')));
	assert.ok(!PATTERN.test(blankComments('// we used to read REPOS_DIR here\nconst x = 1;\n')));
});
