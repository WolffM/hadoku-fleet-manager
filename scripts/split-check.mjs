#!/usr/bin/env node
/**
 * Split-check (plan §4.1 step 1, §10): the mechanical half of "every split PR
 * carries two checks" — line conservation and test-count delta. A reviewer
 * can read a 2,000-line diff and believe it is a pure move; this script
 * counts instead of believing.
 *
 * Usage: `node scripts/split-check.mjs <base>..<head>` (or `<base> <head>` as
 * two argv entries), run from inside the repo whose history is being
 * checked — the caller's `cwd`, not a fixed path, so the fixture test below
 * can point it at a throwaway repo instead of this one.
 *
 *   1. LINE CONSERVATION: across the WHOLE diff, the count of removed lines
 *      must equal the count of added lines, after dropping import/re-export
 *      lines, blank lines, and bare re-export SHIM lines (`export { x };`
 *      with no `from` — plan §10's "re-export shims at every published
 *      subpath that moves" are an expected free addition, not new content).
 *      A pure move relocates lines; it does not change how many non-import
 *      lines exist.
 *   2. TEST-COUNT DELTA: among files whose path contains `.test.`, the
 *      number of `test(`/`it(` call sites removed must not exceed the
 *      number added — moving code must not quietly drop coverage for it.
 *
 * Exits 0 and prints nothing on a clean split; exits 1 and lists the
 * mismatch otherwise.
 */
import { execFileSync } from 'node:child_process';

const IMPORT_LINE =
	/^\s*(?:import\b|export\s*\*\s*from\b|export\s*\{[^}]*\}\s*from\b|\}\s*from\s*['"`])/;
const SHIM_LINE = /^\s*export\s*\{[^}]*\}\s*;?\s*$/;
const TEST_CALL = /\b(?:test|it)\s*\(/g;

/**
 * `cwd` defaults to the process's own — but a caller checking a FIXTURE repo
 * (the test below) must pass its own, and the env must drop any inherited
 * `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE`: those beat `cwd` inside git, so
 * a leaked one would point this check at the wrong repository entirely (the
 * same trap `tests-rewrote-the-repo` names for a pre-push hook).
 */
function gitDiff(range, cwd) {
	const env = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_INDEX_FILE;
	delete env.GIT_WORK_TREE;
	return execFileSync('git', ['diff', '--no-color', '--no-ext-diff', range], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		cwd,
		env,
	});
}

/** One entry per changed file: `{ path, removed: string[], added: string[] }`. */
function parseDiff(text) {
	const files = [];
	let current = null;
	for (const line of text.split('\n')) {
		if (line.startsWith('diff --git ')) {
			current = { path: line.replace(/^diff --git a\/.* b\//, ''), removed: [], added: [] };
			files.push(current);
			continue;
		}
		if (!current) continue;
		if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('@@')) continue;
		if (line.startsWith('---') || line.startsWith('+++')) continue;
		if (line.startsWith('-')) current.removed.push(line.slice(1));
		else if (line.startsWith('+')) current.added.push(line.slice(1));
	}
	return files;
}

function countableLines(lines) {
	return lines.filter((l) => l.trim() !== '' && !IMPORT_LINE.test(l) && !SHIM_LINE.test(l));
}

function countTestCalls(lines) {
	let n = 0;
	for (const l of lines) n += [...l.matchAll(TEST_CALL)].length;
	return n;
}

export function checkSplit(range, { cwd } = {}) {
	const files = parseDiff(gitDiff(range, cwd));

	const removedCountable = files.flatMap((f) => countableLines(f.removed));
	const addedCountable = files.flatMap((f) => countableLines(f.added));

	const findings = [];

	if (removedCountable.length !== addedCountable.length) {
		findings.push(
			`line conservation: ${removedCountable.length} non-import line(s) removed, ` +
				`${addedCountable.length} added (import lines, blank lines and bare re-export shims ` +
				'excluded from both). A pure move keeps these equal.'
		);
	}

	const testFiles = files.filter((f) => f.path.includes('.test.'));
	const removedTestCalls = testFiles.reduce((n, f) => n + countTestCalls(f.removed), 0);
	const addedTestCalls = testFiles.reduce((n, f) => n + countTestCalls(f.added), 0);
	if (addedTestCalls < removedTestCalls) {
		findings.push(
			`test-count delta: ${removedTestCalls} test(/it( call(s) removed from test files, only ` +
				`${addedTestCalls} added back. Coverage for the moved code dropped.`
		);
	}

	return { ok: findings.length === 0, findings, removedCountable, addedCountable };
}

function main() {
	const range =
		process.argv[2] === undefined
			? null
			: process.argv[3] === undefined
				? process.argv[2]
				: `${process.argv[2]}..${process.argv[3]}`;
	if (!range) {
		process.stderr.write('usage: split-check.mjs <base>..<head>  (or <base> <head>)\n');
		process.exit(2);
	}
	const result = checkSplit(range);
	if (result.ok) {
		process.exit(0);
	}
	for (const f of result.findings) process.stderr.write(`split-check: ${f}\n`);
	process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
