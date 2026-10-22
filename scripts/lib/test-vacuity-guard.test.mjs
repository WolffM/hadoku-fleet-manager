/**
 * A test that cannot fail is worse than no test: it occupies the slot where a
 * real one would go and reports green while doing it.
 *
 * This repo has shipped one. `runner-tiers.test.ts` used to assert
 * `assert.ok(!on.has('tier2') || true, ...)` — true for every possible input —
 * over a `decideTiers` whose hysteresis term was equally inert. The pair read as
 * protection while claw-1 flapped nine times in one morning at 24 label writes
 * a flip. Neither half could have caught the other.
 *
 * WHAT THIS DOES AND DOES NOT CATCH
 * ---------------------------------
 * Vacuity is not decidable from source, so this is deliberately narrow: shapes
 * that are ALWAYS vacuous regardless of context, plus test bodies with no
 * assertion at all. It is a floor, not a proof.
 *
 * It specifically does NOT flag `for (const x of derived()) { assert... }`,
 * which reads vacuous and usually is not — the suites here pin those
 * collections in a neighbouring test (`floorLabels()` at capabilities.test.ts,
 * `inferredFlags()` at onboarding-docs.test.mjs, `classify()` in
 * runner-supervision.test.ts). Vacuity has to be judged per FILE, not per test,
 * and a rule that cannot see the neighbour would cry wolf on all of them. The
 * real defence there is mutation: break the subject, watch the test go red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Every test source in the repo, from git so untracked scratch files are out. */
function testFiles() {
	return execFileSync('git', ['-C', REPO, 'ls-files', '*.test.ts', '*.test.mjs'], {
		encoding: 'utf8',
	})
		.split('\n')
		.filter(Boolean);
}

/**
 * Always-vacuous assertion shapes.
 *
 * Each is true for every input, so a match is a defect with no context needed.
 */
const TAUTOLOGIES = [
	['`|| true` short-circuits the assertion', /assert[^\n;]*\|\|\s*true/],
	['`&& false` can never hold', /assert[^\n;]*&&\s*false/],
	['`.length >= 0` is true of every array', /assert\.ok\([^)\n]*\.length\s*>=\s*0/],
	['`typeof x` is a non-empty string, always truthy', /assert\.ok\(\s*typeof [^)\n]*\)/],
	['asserts a literal, not a result', /assert\.ok\(\s*(['"`][^'"`]*['"`]|true|1)\s*[,)]/],
	[
		'compares a value to itself',
		/assert\.(equal|strictEqual|deepEqual)\(\s*([A-Za-z_$][\w$.]*)\s*,\s*\2\s*[,)]/,
	],
	['doesNotThrow over an empty body', /assert\.doesNotThrow\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/],
];

test('no test file contains an always-true assertion', () => {
	const found = [];
	for (const f of testFiles()) {
		// Comments blanked FIRST: this file names every pattern it forbids, and
		// several suites explain in prose the vacuous assertion they replaced.
		// Without blanking, the guard reports its own documentation.
		const src = blankComments(readFileSync(`${REPO}/${f}`, 'utf8'));
		src.split('\n').forEach((line, i) => {
			for (const [why, re] of TAUTOLOGIES) {
				if (re.test(line)) found.push(`${f}:${i + 1} — ${why}\n      ${line.trim().slice(0, 100)}`);
			}
		});
	}
	assert.deepEqual(found, [], `always-true assertion(s):\n  ${found.join('\n  ')}`);
});

test('every test body contains at least one assertion', () => {
	const found = [];
	for (const f of testFiles()) {
		const src = blankComments(readFileSync(`${REPO}/${f}`, 'utf8'));
		// Split on test( boundaries. Crude, and adequate: a body that loses its
		// assertions to a bad split would be reported, not hidden.
		for (const chunk of src.split(/\n(?=\s*test\()/).slice(1)) {
			const name = /test\(\s*(['"`])([\s\S]*?)\1/.exec(chunk);
			if (!name) continue;
			if (!/assert[.(]/.test(chunk))
				found.push(`${f} — ${name[2].replace(/\s+/g, ' ').slice(0, 70)}`);
		}
	}
	assert.deepEqual(found, [], `test(s) with no assertion:\n  ${found.join('\n  ')}`);
});

test('every compiled TS test is actually reachable by the runner glob', () => {
	// The quietest way to have a useless test: one that never executes. `pnpm
	// test` globs `dist/tests/**/*.test.js`, so a source file that does not end
	// in `.test.ts` compiles to a name the glob cannot see and runs never.
	const stray = testFiles().filter(
		(f) => f.startsWith('src/tests/') && !f.endsWith('.test.ts') && !f.endsWith('.test.mjs')
	);
	assert.deepEqual(stray, [], `test source(s) the runner glob will never match: ${stray}`);
});

test('the guard is actually reading files', () => {
	// The guard's own vacuity check. Every assertion above is `deepEqual([], [])`
	// when the file list is empty, so an ls-files that silently returned nothing
	// would make this entire suite pass while inspecting zero bytes — which is
	// the exact failure mode it exists to prevent.
	const files = testFiles();
	assert.ok(files.length > 20, `expected the repo's test suite, found ${files.length} file(s)`);
	assert.ok(
		files.some((f) => f.endsWith('.test.ts')) && files.some((f) => f.endsWith('.test.mjs')),
		'both halves of the suite must be in scope'
	);
	assert.ok(
		relative(REPO, `${REPO}/package.json`) === 'package.json',
		'REPO must point at the repository root'
	);
});
