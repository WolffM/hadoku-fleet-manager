/**
 * check-header-fleet's uniform repo-reading layer (scripts/check-header-fleet.mjs,
 * wave 5m lane D split #13 — pure move): SHIPPED by default, or the working
 * copy under REPOS_DIR with `--worktree`, read through one per-repo cache so
 * the rules in header-rules.mjs never pay for the same fetch twice. See the
 * CLI's own header for the staleness/header-policy rules this reads for;
 * this module only opens and reads.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { reposDir } from './sibling-repos.mjs';
import { tryShipped, UnreadableRepo } from './fleet-source.mjs';
import { blankComments } from './blank-comments.mjs';
import { qualifyRepo } from '../../dist/lib/fleet-config.js';

export const ROOT = reposDir();

/**
 * `--worktree` / `--no-fetch`, LAST SET by whichever `openRepo` call most
 * recently carried a `flags` argument — never read back from
 * check-header-fleet.mjs as a reverse import. The CLI's own per-repo call
 * (`openRepo(repo, { useWorktree, noFetch })`) carries them explicitly on
 * every call; `catalogue()` below calls `openRepo(hubRepo())` with none, by
 * its own frozen zero-argument signature, and rides whatever the fleet loop
 * already set earlier in the SAME run — which is correct, since the flags
 * are constant for the run and the CLI always opens at least one repo with
 * them before `catalogue()` can ever be reached.
 */
let sourceFlags = { useWorktree: false, noFetch: false };

export function git(dir, argv) {
	return execFileSync('git', ['-C', dir, ...argv], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
	});
}

/**
 * One repo's files, as `{ name, files(), read(file) }`, or `{ name, unreadable,
 * missing? }` when they could not be looked at. Shipped by default; the
 * working copy under REPOS_DIR with `--worktree`.
 */
export function openRepo(name, flags) {
	if (flags) sourceFlags = flags;
	if (sourceFlags.useWorktree) {
		const dir = resolve(ROOT, name);
		if (!existsSync(dir)) return { name, unreadable: `no checkout at ${dir}`, missing: true };
		return {
			name,
			files: () => git(dir, ['ls-files']).split('\n').filter(Boolean),
			read: (file) => readFileSync(resolve(dir, file), 'utf8'),
		};
	}
	const h = tryShipped(qualifyRepo(name), { fetch: !sourceFlags.noFetch });
	if ('unreadable' in h) return { name, unreadable: h.unreadable };
	// The rules read file by file; without this each read is a network round trip.
	try {
		h.prefetch();
	} catch (err) {
		if (err instanceof UnreadableRepo) return { name, unreadable: err.reason };
		throw err;
	}
	return { name, files: () => h.list(), read: (file) => h.read(file) };
}

/**
 * One read per file per repo, not one per RULE.
 *
 * Three separate passes over the source list each called this on overlapping
 * sets, so every file was fetched two or three times and re-blanked each time.
 * The rules are kept separate deliberately (each is its own finding with its
 * own rationale); it is the READ that should not be repeated.
 *
 * Cleared per repo in the fleet loop, so the cache is one repo's files at a
 * time rather than fifteen repos' worth held at once.
 */
const fileCache = new Map();
const blankCache = new Map();

export function resetFileCache() {
	fileCache.clear();
	blankCache.clear();
}

export function readFile(source, file) {
	const key = `${source.name}\u0000${file}`;
	if (fileCache.has(key)) return fileCache.get(key);
	let out;
	try {
		out = source.read(file);
	} catch {
		out = null;
	}
	fileCache.set(key, out);
	return out;
}

/** `blankComments` over a cached read — the second half of the same waste. */
export function readBlanked(source, file) {
	const key = `${source.name}\u0000${file}`;
	if (blankCache.has(key)) return blankCache.get(key);
	const raw = readFile(source, file);
	const out = raw === null ? null : blankComments(raw);
	blankCache.set(key, out);
	return out;
}
