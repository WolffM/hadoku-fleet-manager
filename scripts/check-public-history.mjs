#!/usr/bin/env node
/**
 * Refuse to push a commit that reaches the PRIVATE history.
 *
 * This repo was cut public from one squashed commit, PUBLIC_ROOT below.
 * `attach-private.sh` grafts the 762 private commits under it with a
 * refs/replace ref, so `git log`, `merge-base` and `rebase` here all see one
 * continuous history. `git push` does NOT: pack-objects ignores replace refs
 * and sends what a commit's parents really are.
 *
 * So a MERGE with any branch begun before the cut (six worktrees held one on
 * 2026-10-23) makes a commit whose second parent is private, and pushing it
 * uploads the entire private history. Measured against a throwaway bare
 * remote: pushing main sent 6 commits; pushing main merged with one old branch
 * sent 783. The tip's tree was clean, so publish-safety-guard, which reads
 * tracked files, passed it. A rebase is safe: it replays only the branch's own
 * commits onto public parents.
 *
 * The test is the commit graph with grafts switched off: every root a pushed
 * commit can reach must be PUBLIC_ROOT. Anything else is either the private
 * history or an unrelated one, and neither belongs on this remote.
 *
 *   node scripts/check-public-history.mjs   # pre-push; reads git's ref lines on stdin
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readStdinWhole } from './lib/stdin.mjs';

export const PUBLIC_ROOT = '50a64a9ef82510cecce27f53e0e80acbada97a16';

const ZERO = /^0+$/;

/**
 * The roots each pushed commit reaches that are not `root`.
 *
 * @param {string} stdin  pre-push input: `<local ref> <local sha> <remote ref> <remote sha>` per line
 * @param {{ root?: string, cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ ref: string, sha: string, roots: string[] }[]}
 */
export function foreignRoots(stdin, { root = PUBLIC_ROOT, cwd, env } = {}) {
	const out = [];
	for (const line of stdin.split('\n')) {
		const [ref, sha] = line.trim().split(/\s+/);
		if (!sha || ZERO.test(sha)) continue; // a deletion pushes no objects
		const roots = execFileSync(
			'git',
			['--no-replace-objects', 'rev-list', '--max-parents=0', sha, '--'],
			{ cwd, env, encoding: 'utf8' }
		)
			.split('\n')
			.filter(Boolean)
			.filter((r) => r !== root);
		if (roots.length) out.push({ ref, sha, roots });
	}
	return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const bad = foreignRoots(readStdinWhole());
	if (bad.length) {
		console.error('❌ This push reaches history that is not this public repo:');
		for (const b of bad) {
			console.error(
				`   ${b.ref} ${b.sha.slice(0, 12)} → root(s) ${b.roots.map((r) => r.slice(0, 12)).join(', ')}`
			);
		}
		console.error('   Almost always a MERGE with a branch begun before the 2026-10-22 cut.');
		console.error('   Pushing it would publish the private history. Rebase instead:');
		console.error('     git reset --hard <your pre-merge commit> && git rebase main');
		process.exit(1);
	}
	console.log('✅ every pushed commit descends from the public root only.');
}
