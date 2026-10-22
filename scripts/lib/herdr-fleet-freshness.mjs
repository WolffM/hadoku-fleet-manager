/**
 * Is the code a hadoku.fleet pane is about to judge with the code on disk?
 *
 * The plugin is linked from a checkout and imports its thresholds from that
 * checkout's `dist/`. `dist/` is gitignored and records nothing about what it
 * was built from, so a pull without a build leaves the panes judging with old
 * constants — found on hokon 2026-10-20, where the main checkout's `dist/` was
 * a week old and did not contain `gh-budget.js` at all. That is the
 * deployed-not-published trap one level down, and it gets the same answer:
 * say so, in red.
 *
 * Deliberately imports nothing from `dist/`, so it still runs when the build
 * is the thing that is broken.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/**
 * Every module the plugin loads, found by walking relative imports — static and
 * `await import()` — from its two entry points. Read as TEXT, never imported, so this still runs when the build
 * is what is broken. A hand-kept list went stale the first time the classifier
 * reached `dist/` through a helper (fleet-exec -> lib/node-identity).
 */
const ENTRIES = [
	join('herdr', 'hadoku-fleet', 'watch.mjs'),
	join('herdr', 'hadoku-fleet', 'open.mjs'),
];
const IMPORT = /(?:^\s*import\s[^'"]*|\bimport\(\s*)['"](\.{1,2}\/[^'"]+)['"]/gm;
export function importGraph(repoRoot) {
	const mjs = new Set();
	const dist = new Set();
	const missing = new Set();
	const visit = (rel) => {
		if (mjs.has(rel) || missing.has(rel)) return;
		let src;
		try {
			src = readFileSync(join(repoRoot, rel), 'utf8');
		} catch (err) {
			if (err?.code !== 'ENOENT') throw err;
			missing.add(rel);
			return;
		}
		mjs.add(rel);
		for (const [, spec] of src.matchAll(IMPORT)) {
			const target = normalize(join(dirname(rel), spec));
			const built = target.match(/^dist\/(.+)\.js$/);
			if (built) dist.add(built[1]);
			else if (target.endsWith('.mjs')) visit(target);
		}
	};
	for (const entry of ENTRIES) visit(entry);
	return { mjs: [...mjs].sort(), dist: [...dist].sort(), missing: [...missing].sort() };
}

/** Exit code a watcher uses to ask its supervisor for an immediate, quiet restart. */
export const RELOAD_EXIT = 75;

const mtime = (path) => {
	try {
		return statSync(path).mtimeMs;
	} catch (err) {
		if (err?.code === 'ENOENT') return null;
		throw err;
	}
};

/**
 * Modules whose build is missing or older than their source. A checkout or a
 * pull rewrites a changed `src/*.ts`, so a source newer than its output is a
 * build that has not caught up. It checks the modules the plugin imports
 * directly, not what THOSE import inside dist/ — an argument from where the
 * constants live, not a proof.
 */
export function staleBuild(repoRoot) {
	const graph = importGraph(repoRoot);
	const stale = graph.missing.map((f) => `${f} (missing)`);
	for (const m of graph.dist) {
		const built = mtime(join(repoRoot, 'dist', `${m}.js`));
		const source = mtime(join(repoRoot, 'src', `${m}.ts`));
		if (built === null) stale.push(`${m} (not built)`);
		else if (source !== null && source > built) stale.push(`${m} (src newer than dist)`);
	}
	return stale;
}

/** The files a running watcher has loaded. Any change means it is judging with old code. */
export function codeFiles(repoRoot) {
	const { mjs, dist } = importGraph(repoRoot);
	return [
		...dist.map((m) => join(repoRoot, 'dist', `${m}.js`)),
		...mjs.map((f) => join(repoRoot, f)),
	];
}

export const fingerprint = (files) => files.map((f) => `${f}:${mtime(f)}`).join('\n');
