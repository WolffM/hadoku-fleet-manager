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
 *      must EQUAL the count of added lines, after dropping import/re-export
 *      lines (single- or multi-line/prettier-wrapped STATEMENTS, not lines —
 *      see `countableLines`), blank lines, and bare re-export SHIM lines
 *      (`export { x };` with no `from` — plan §10's "re-export shims at
 *      every published subpath that moves" are an expected free addition,
 *      not new content). STRICT equality, not just "nothing was dropped":
 *      catching genuinely NEW code riding along with a move is half of this
 *      check's job (plan §10 — a move is separate from a behaviour change,
 *      and a split PR that quietly does both is exactly what this exists to
 *      surface). 594fd65 (the fixture below) is the proof this has to stay
 *      strict: it reads as "a pure move" in its own title, but its body adds
 *      three small accessor functions that are NOT moved from anywhere —
 *      equal counts would have hidden that.
 *
 *      ON A MISMATCH, the finding lists the UNMATCHED lines on each side —
 *      every countable line removed with no identical countable line added
 *      back, and vice versa (an exact-text multiset match, see `diffLines`)
 *      — so a reviewer sees which lines are the real addition/loss, not just
 *      a line count. Reflowing a declaration (`function f` -> `export
 *      function f`) still shows as one unmatched pair on each side: this is
 *      a report for a human to read, not a semantic diff, and a one-line
 *      change is cheap to recognise by eye.
 *   2. TEST-COUNT DELTA: among files whose path contains `.test.`, the
 *      number of `test(`/`it(` call sites removed must not exceed the
 *      number added — moving code must not quietly drop coverage for it.
 *
 * Exits 0 and prints nothing on a clean split; exits 1 and lists the
 * mismatch otherwise.
 */
import { execFileSync } from 'node:child_process';

const IMPORT_LINE =
	/^\s*(?:import\b|export\s*\*\s*from\b|export\s*(?:type\s+)?\{[^}]*\}\s*from\b|\}\s*from\s*['"`])/;
const SHIM_LINE = /^\s*export\s*\{[^}]*\}\s*;?\s*$/;
/**
 * The opening line of a prettier-wrapped, multi-line import/export-from
 * statement, or a multi-line bare re-export shim — `import {`, `export {`,
 * `import type {` or `export type {`, with nothing else on the line. Prettier
 * always puts the brace alone when it wraps a name list, so this never
 * matches a real block/object opener (`export const x = {`, `export function
 * f() {`): those have another keyword between `export` and `{`, which this
 * pattern requires NOT to be there (only `type` is allowed).
 */
const IMPORT_BLOCK_OPEN = /^\s*(?:import|export)(?:\s+type)?\s*\{\s*$/;
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

/**
 * Filters a file's removed (or added) lines down to the ones that count as
 * real content — excluding blanks, single-line import/export-from/shim
 * statements, and every line of a multi-line (prettier-wrapped) one, name
 * list and closing brace included. The closing line is whatever line, once
 * inside the block, next contains `}` — the `} from '…';` of an import/
 * export-from, or the bare `};`/`}` of a re-export shim. A STATEMENT is
 * excluded as a whole, never counted line by line, so a prettier-wrapped
 * import that moves verbatim never shows as a mismatch.
 */
function countableLines(lines) {
	const out = [];
	let inBlock = false;
	for (const line of lines) {
		if (inBlock) {
			if (line.includes('}')) inBlock = false;
			continue;
		}
		if (line.trim() === '') continue;
		if (IMPORT_BLOCK_OPEN.test(line)) {
			inBlock = true;
			continue;
		}
		if (IMPORT_LINE.test(line) || SHIM_LINE.test(line)) continue;
		out.push(line);
	}
	return out;
}

function countTestCalls(lines) {
	let n = 0;
	for (const l of lines) n += [...l.matchAll(TEST_CALL)].length;
	return n;
}

/**
 * Matches `removed` against `added` by EXACT line text, one-for-one (a
 * multiset match, not a set match: two identical removed lines need two
 * identical added lines to both be accounted for). Returns what is left
 * over on each side — the lines a straight count can only total, never
 * name. `entries` carry `{ rel, line }` so a finding can say which file.
 */
function diffLines(removedEntries, addedEntries) {
	const remainingAdded = new Map(); // line text -> entries not yet matched
	for (const e of addedEntries) {
		if (!remainingAdded.has(e.line)) remainingAdded.set(e.line, []);
		remainingAdded.get(e.line).push(e);
	}
	const removedOnly = [];
	for (const e of removedEntries) {
		const bucket = remainingAdded.get(e.line);
		if (bucket && bucket.length)
			bucket.pop(); // consumes one twin, never reported
		else removedOnly.push(e);
	}
	const addedOnly = [];
	for (const bucket of remainingAdded.values()) addedOnly.push(...bucket);
	return { removedOnly, addedOnly };
}

/** Renders `diffLines`' leftovers as the finding's actionable detail. */
function renderUnmatched(removedOnly, addedOnly) {
	const out = [];
	if (addedOnly.length) {
		out.push(`  added, no removed twin (${addedOnly.length}):`);
		for (const e of addedOnly) out.push(`    + ${e.rel}: ${e.line.trim()}`);
	}
	if (removedOnly.length) {
		out.push(`  removed, no added twin (${removedOnly.length}):`);
		for (const e of removedOnly) out.push(`    - ${e.rel}: ${e.line.trim()}`);
	}
	return out.join('\n');
}

export function checkSplit(range, { cwd } = {}) {
	const files = parseDiff(gitDiff(range, cwd));

	const removedEntries = files.flatMap((f) =>
		countableLines(f.removed).map((line) => ({ rel: f.path, line }))
	);
	const addedEntries = files.flatMap((f) =>
		countableLines(f.added).map((line) => ({ rel: f.path, line }))
	);
	const removedCountable = removedEntries.map((e) => e.line);
	const addedCountable = addedEntries.map((e) => e.line);

	const findings = [];

	if (removedCountable.length !== addedCountable.length) {
		const { removedOnly, addedOnly } = diffLines(removedEntries, addedEntries);
		findings.push(
			`line conservation: ${removedCountable.length} non-import line(s) removed, ` +
				`${addedCountable.length} added (import lines, blank lines and bare re-export shims ` +
				'excluded from both). A pure move keeps these equal.\n' +
				renderUnmatched(removedOnly, addedOnly)
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
