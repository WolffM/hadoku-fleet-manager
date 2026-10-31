/**
 * THE FILE-SIZE CEILING GUARD'S OWN TESTS (wave 5n lane D).
 *
 * See `scripts/lib/file-size-guard.mjs` for the full design note. The short
 * version, because a reader of a RED build should not have to open a second
 * file to understand WHY the ceiling exists or how to fix it:
 *
 *   - CEILINGS (operator, 2026-10-31, `docs/planning/wave5n-2026-10-31.md`,
 *     settled — do not re-open): **800 lines for source, 1,000 for test
 *     files.** Six waves of pure-move splits stalled at 1,200-1,450 lines
 *     because nothing made a file's SIZE the target; this guard fixes that.
 *   - WHY: a split can satisfy every other gate and still leave a file too
 *     big to read in one sitting. This is the gate that catches that case.
 *   - THE LIST ONLY SHRINKS. `scripts/lib/file-size-debt.json` is
 *     `{ "<path>": <recorded line count> }`. A file over its ceiling must be
 *     on the list at EXACTLY its current size — smaller than recorded, or
 *     at/under the ceiling, or deleted, all FAIL until the entry is lowered
 *     or removed, same as `layer-debt.json`'s ratchet.
 *   - TO LOWER AN ENTRY: `node scripts/file-size-debt.mjs --write`. It only
 *     ever ratchets down or drops entries; raising one, or adding a new one,
 *     needs `--allow-growth <path>` and prints a warning when it does.
 *   - THE POST-WAVES REFACTOR PASS MUST EMPTY THIS LIST. A shrinking but
 *     non-empty list is working as designed mid-pass; an empty one is the
 *     exit criterion, not an optional bonus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	SOURCE_CEILING,
	TEST_CEILING,
	isTestFile,
	ceilingFor,
	lineCount,
	inScope,
	listTrackedCodeFiles,
	collectSizes,
	malformedEntries,
	evaluate,
	regenerate,
} from './file-size-guard.mjs';
import { cleanGitEnv } from './test-git-identity.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEBT_PATH = join(ROOT, 'scripts/lib/file-size-debt.json');

function readDebt() {
	const debt = JSON.parse(readFileSync(DEBT_PATH, 'utf8'));
	for (const [path, recorded] of Object.entries(debt)) {
		assert.equal(typeof path, 'string');
		assert.ok(Number.isInteger(recorded), `${path}: recorded size must be an integer`);
	}
	return debt;
}

// ============================================================ classification

void test('isTestFile / ceilingFor: every documented shape', () => {
	const cases = [
		['src/runner-health.ts', false],
		['scripts/check-header-fleet.mjs', false],
		['src/runner-health.test.ts', true],
		['scripts/bootcamp.test.mjs', true],
		['scripts/runner_mem_report_test.py', true],
		['scripts/lib/doctor-fixtures.mjs', true],
		['src/tests/capability-fixtures.ts', true],
		['src/tests/helpers/fleet-fakes.ts', true],
		['src/tests/install-test-host.ts', true],
		// src/tests/ paths that ALSO match *.test.* — both reasons agree.
		['src/tests/runner-health.test.ts', true],
	];
	for (const [path, expected] of cases) {
		assert.equal(isTestFile(path), expected, path);
		assert.equal(ceilingFor(path), expected ? TEST_CEILING : SOURCE_CEILING, `${path} ceiling`);
	}
});

void test('isTestFile does not fire on a plain source file that merely contains "test"', () => {
	// `scripts/lib/test-git-identity.mjs` is a real, non-test module this test
	// file itself imports. A classifier keying on "contains test" anywhere in
	// the path would wrongly promote it to the 1,000-line ceiling.
	assert.equal(isTestFile('scripts/lib/test-git-identity.mjs'), false);
	assert.equal(ceilingFor('scripts/lib/test-git-identity.mjs'), SOURCE_CEILING);
});

void test('inScope: directory and extension both required', () => {
	assert.equal(inScope('src/runner-health.ts'), true);
	assert.equal(inScope('scripts/foo.mjs'), true);
	assert.equal(inScope('herdr/hadoku-fleet/watch.mjs'), true);
	assert.equal(inScope('deploy/systemd/install.sh'), true);
	assert.equal(inScope('docs/planning/wave5n-2026-10-31.md'), false, 'wrong dir, wrong ext');
	assert.equal(inScope('src/runner-health.json'), false, 'right dir, wrong ext');
	assert.equal(inScope('manifests/node-profiles.json'), false, 'wrong dir entirely');
	assert.equal(inScope('srcnotreally/thing.ts'), false, 'prefix must include the slash');
});

// =================================================================== wc -l

void test('lineCount matches real `wc -l` for both trailing-newline shapes', () => {
	const dir = mkdtempSync(join(tmpdir(), 'file-size-guard-wc-'));
	try {
		const withNL = join(dir, 'with-nl.txt');
		const withoutNL = join(dir, 'without-nl.txt');
		writeFileSync(withNL, 'a\nb\nc\n');
		writeFileSync(withoutNL, 'a\nb\nc'); // no trailing newline: wc -l reads ONE LOWER

		const realWithNL = Number(
			execFileSync('wc', ['-l', withNL], { encoding: 'utf8' }).trim().split(/\s+/)[0]
		);
		const realWithoutNL = Number(
			execFileSync('wc', ['-l', withoutNL], { encoding: 'utf8' }).trim().split(/\s+/)[0]
		);

		assert.equal(realWithNL, 3);
		assert.equal(realWithoutNL, 2, 'sanity: real wc -l undercounts the unterminated final line');
		assert.equal(lineCount(readFileSync(withNL, 'utf8')), realWithNL);
		assert.equal(lineCount(readFileSync(withoutNL, 'utf8')), realWithoutNL);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

void test('lineCount: empty file is 0 lines', () => {
	assert.equal(lineCount(''), 0);
});

// ========================================================= evaluate (rules)

void test('rule (a): over ceiling, not listed -> unlisted', () => {
	const sizes = new Map([['src/x.ts', 900]]);
	const result = evaluate(sizes, {});
	assert.deepEqual(result.unlisted, [{ path: 'src/x.ts', lines: 900, ceiling: 800 }]);
	assert.deepEqual(result.grown, []);
	assert.deepEqual(result.stale, []);
	assert.deepEqual(result.listedAtOrUnderCeiling, []);
});

void test('rule (a): respects the test ceiling, not just the source one', () => {
	const sizes = new Map([['src/x.test.ts', 950]]); // over 800, under 1000
	assert.deepEqual(evaluate(sizes, {}).unlisted, [], 'under the TEST ceiling, not a violation');

	const sizesOver = new Map([['src/x.test.ts', 1050]]);
	assert.deepEqual(evaluate(sizesOver, {}).unlisted, [
		{ path: 'src/x.test.ts', lines: 1050, ceiling: 1000 },
	]);
});

void test('rule (b): listed but now larger than recorded -> grown, not unlisted', () => {
	const sizes = new Map([['src/x.ts', 900]]);
	const result = evaluate(sizes, { 'src/x.ts': 850 });
	assert.deepEqual(result.grown, [{ path: 'src/x.ts', lines: 900, recorded: 850, ceiling: 800 }]);
	assert.deepEqual(result.unlisted, []);
	assert.deepEqual(result.stale, []);
});

void test('rule (c): listed but now SMALLER than recorded -> stale (shrunk)', () => {
	const sizes = new Map([['src/x.ts', 820]]);
	const result = evaluate(sizes, { 'src/x.ts': 900 });
	assert.deepEqual(result.stale, [
		{ path: 'src/x.ts', reason: 'shrunk', lines: 820, recorded: 900, ceiling: 800 },
	]);
	assert.deepEqual(result.unlisted, []);
	assert.deepEqual(result.grown, []);
});

void test('rule (c): listed but now AT/UNDER the ceiling -> stale (under-ceiling)', () => {
	const sizes = new Map([['src/x.ts', 700]]);
	const result = evaluate(sizes, { 'src/x.ts': 900 });
	assert.deepEqual(result.stale, [
		{ path: 'src/x.ts', reason: 'under-ceiling', lines: 700, recorded: 900, ceiling: 800 },
	]);
});

void test('rule (c): listed but DELETED (absent from sizes) -> stale (deleted)', () => {
	const sizes = new Map(); // src/x.ts no longer exists/tracked
	const result = evaluate(sizes, { 'src/x.ts': 900 });
	assert.deepEqual(result.stale, [
		{ path: 'src/x.ts', reason: 'deleted', lines: null, recorded: 900, ceiling: 800 },
	]);
});

void test('rule (d): a debt entry recorded at/under its own ceiling is list hygiene debt', () => {
	// `lines` chosen to equal `recorded` and sit under the ceiling too, so this
	// case is isolated from rules (a)/(b)/(c) — see the next test for what
	// happens when the file's actual size ALSO disagrees.
	const sizes = new Map([['src/x.ts', 750]]);
	const result = evaluate(sizes, { 'src/x.ts': 750 });
	assert.deepEqual(result.listedAtOrUnderCeiling, [
		{ path: 'src/x.ts', recorded: 750, ceiling: 800 },
	]);
	assert.deepEqual(result.grown, []);
	assert.deepEqual(result.stale, []);
	assert.deepEqual(result.unlisted, []);
});

void test('rule (d) can fire ALONGSIDE rule (b): an under-ceiling entry whose file also grew past it', () => {
	// recorded (750) is under the ceiling (800) -- rule (d) -- AND the file is
	// now at 900 lines, past even that too-low recorded number -- rule (b).
	// Both are real, independent defects in the same entry, so both fire.
	const sizes = new Map([['src/x.ts', 900]]);
	const result = evaluate(sizes, { 'src/x.ts': 750 });
	assert.deepEqual(result.listedAtOrUnderCeiling, [
		{ path: 'src/x.ts', recorded: 750, ceiling: 800 },
	]);
	assert.deepEqual(result.grown, [{ path: 'src/x.ts', lines: 900, recorded: 750, ceiling: 800 }]);
});

void test('a debt entry that exactly matches the current size is clean: no findings at all', () => {
	const sizes = new Map([['src/x.ts', 900]]);
	const result = evaluate(sizes, { 'src/x.ts': 900 });
	assert.deepEqual(result, { unlisted: [], grown: [], stale: [], listedAtOrUnderCeiling: [] });
});

void test('a compliant, unlisted file produces no findings', () => {
	const sizes = new Map([['src/x.ts', 100]]);
	assert.deepEqual(evaluate(sizes, {}), {
		unlisted: [],
		grown: [],
		stale: [],
		listedAtOrUnderCeiling: [],
	});
});

// =================================================================== regenerate

void test('regenerate: ratchets a shrunk entry DOWN, no flag needed', () => {
	const { debt, warnings } = regenerate(new Map([['a.ts', 820]]), { 'a.ts': 900 });
	assert.deepEqual(debt, { 'a.ts': 820 });
	assert.deepEqual(warnings, []);
});

void test('regenerate: drops an entry whose file healed to at/under the ceiling', () => {
	const { debt } = regenerate(new Map([['a.ts', 700]]), { 'a.ts': 900 });
	assert.deepEqual(debt, {});
});

void test('regenerate: drops an entry whose file is gone (absent from sizes)', () => {
	const { debt } = regenerate(new Map(), { 'a.ts': 900 });
	assert.deepEqual(debt, {});
});

void test('regenerate: a no-op re-run of a matching list changes nothing', () => {
	const { debt, warnings } = regenerate(new Map([['a.ts', 900]]), { 'a.ts': 900 });
	assert.deepEqual(debt, { 'a.ts': 900 });
	assert.deepEqual(warnings, []);
});

void test('regenerate: growth on an EXISTING entry is refused without --allow-growth', () => {
	const { debt, warnings } = regenerate(new Map([['a.ts', 950]]), { 'a.ts': 900 });
	assert.deepEqual(
		debt,
		{ 'a.ts': 900 },
		'left at the old recorded size; evaluate() will flag it grown'
	);
	assert.deepEqual(warnings, []);
});

void test('regenerate: growth on an EXISTING entry is allowed, and warned about, with --allow-growth', () => {
	const { debt, warnings } = regenerate(
		new Map([['a.ts', 950]]),
		{ 'a.ts': 900 },
		new Set(['a.ts'])
	);
	assert.deepEqual(debt, { 'a.ts': 950 });
	assert.deepEqual(warnings, ['growth allowed: a.ts raised 900 -> 950']);
});

void test('regenerate: a brand-new violation is NOT silently added without --allow-growth', () => {
	const { debt, warnings } = regenerate(new Map([['b.ts', 850]]), {});
	assert.deepEqual(debt, {}, 'omitted; evaluate() will flag it unlisted, not silently absorbed');
	assert.deepEqual(warnings, []);
});

void test('regenerate: a brand-new violation IS added, with a warning, via --allow-growth', () => {
	const { debt, warnings } = regenerate(new Map([['b.ts', 850]]), {}, new Set(['b.ts']));
	assert.deepEqual(debt, { 'b.ts': 850 });
	assert.deepEqual(warnings, ['growth allowed: new debt entry b.ts = 850 (ceiling 800)']);
});

void test('regenerate: `allowGrowth === "all"` seeds every current violation at once (initial-list mode)', () => {
	const { debt, warnings } = regenerate(
		new Map([
			['a.ts', 900],
			['b.ts', 1200], // test file, over 1000
		]),
		{},
		'all'
	);
	assert.deepEqual(debt, { 'a.ts': 900, 'b.ts': 1200 });
	assert.equal(warnings.length, 2);
});

void test('regenerate: output is sorted by path, independent of input order', () => {
	const { debt } = regenerate(
		new Map([
			['z.ts', 900],
			['a.ts', 900],
			['m.ts', 900],
		]),
		{},
		'all'
	);
	assert.deepEqual(Object.keys(debt), ['a.ts', 'm.ts', 'z.ts']);
});

// =============================================================== malformedEntries

void test('malformedEntries rejects a non-integer or negative recorded size', () => {
	assert.deepEqual(malformedEntries({ 'a.ts': 900 }), []);
	const bad = malformedEntries({ 'a.ts': 900.5, 'b.ts': -1, 'c.ts': '900', 'd.ts': null });
	assert.equal(bad.length, 4);
});

// =========================================================== real temp-git corpus

/**
 * A real `git init`'d tree, so `collectSizes`/`listTrackedCodeFiles` are
 * proven against ACTUAL `git ls-files` output rather than a fixture that
 * merely asserts what we assume `git ls-files` does. Identity travels in the
 * environment only (`cleanGitEnv`) — see `test-git-identity.mjs`'s header for
 * why a repo-local `git config user.*` is never safe to run from inside a
 * worktree of this repo.
 */
function makeTempRepo() {
	const root = mkdtempSync(join(tmpdir(), 'file-size-guard-repo-'));
	const env = cleanGitEnv();
	const run = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
	run('init', '-q', '-b', 'main');
	return {
		root,
		write(relPath, content) {
			const abs = join(root, relPath);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, content);
		},
		add(relPath) {
			run('add', relPath);
		},
		commit() {
			run('commit', '-q', '-m', 'fixture');
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

void test('collectSizes: tracked + in-scope only — untracked, wrong-dir and wrong-ext are invisible', () => {
	const repo = makeTempRepo();
	try {
		repo.write('src/big.ts', Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n') + '\n');
		repo.write('scripts/small.mjs', 'const x = 1;\n');
		repo.write('scripts/untracked.mjs', 'x'.repeat(5000)); // never `git add`ed
		repo.write('docs/notes.ts', 'x'.repeat(5000)); // wrong dir: not under src/scripts/herdr/deploy
		repo.write('src/data.json', 'x'.repeat(5000)); // wrong extension
		repo.add('src/big.ts');
		repo.add('scripts/small.mjs');
		repo.add('docs/notes.ts');
		repo.add('src/data.json');
		// deliberately NOT adding scripts/untracked.mjs
		repo.commit();

		const files = listTrackedCodeFiles(repo.root);
		assert.deepEqual(files, ['scripts/small.mjs', 'src/big.ts']);

		const sizes = collectSizes(repo.root);
		assert.deepEqual([...sizes.entries()].sort(), [
			['scripts/small.mjs', 1],
			['src/big.ts', 900],
		]);
	} finally {
		repo.cleanup();
	}
});

void test('collectSizes + evaluate, end to end on a real tree: catches an unlisted violation and clears a compliant debt entry', () => {
	const repo = makeTempRepo();
	try {
		repo.write('src/over.ts', Array.from({ length: 850 }, () => 'x').join('\n') + '\n');
		repo.write('src/fine.ts', 'ok\n');
		repo.add('src/over.ts');
		repo.add('src/fine.ts');
		repo.commit();

		const sizes = collectSizes(repo.root);
		const result = evaluate(sizes, {});
		assert.deepEqual(result.unlisted, [{ path: 'src/over.ts', lines: 850, ceiling: 800 }]);

		const listed = evaluate(sizes, { 'src/over.ts': 850 });
		assert.deepEqual(listed.unlisted, []);
		assert.deepEqual(listed.grown, []);
		assert.deepEqual(listed.stale, []);
	} finally {
		repo.cleanup();
	}
});

void test('a deleted-and-recommitted file disappears from collectSizes, and evaluate reports it stale', () => {
	const repo = makeTempRepo();
	try {
		repo.write('src/gone.ts', Array.from({ length: 850 }, () => 'x').join('\n') + '\n');
		repo.add('src/gone.ts');
		repo.commit();
		const before = collectSizes(repo.root);
		assert.equal(before.get('src/gone.ts'), 850);

		execFileSync('git', ['rm', '-q', 'src/gone.ts'], { cwd: repo.root, env: cleanGitEnv() });
		execFileSync('git', ['commit', '-q', '-m', 'remove'], { cwd: repo.root, env: cleanGitEnv() });

		const after = collectSizes(repo.root);
		assert.equal(after.has('src/gone.ts'), false);

		const result = evaluate(after, { 'src/gone.ts': 850 });
		assert.deepEqual(result.stale, [
			{ path: 'src/gone.ts', reason: 'deleted', lines: null, recorded: 850, ceiling: 800 },
		]);
	} finally {
		repo.cleanup();
	}
});

// ================================================================== the real tree

void test('the corpus is real — a walker that found nothing would prove nothing', () => {
	const files = listTrackedCodeFiles(ROOT);
	assert.ok(
		files.length >= 400,
		`walked ${files.length} tracked, in-scope file(s); expected hundreds. The scan dirs ` +
			'moved or `git ls-files` returned something unexpected.'
	);
	assert.ok(files.some((f) => f.startsWith('src/')));
	assert.ok(files.some((f) => f.startsWith('scripts/')));
});

void test('scripts/lib/file-size-debt.json: every entry names a file this run actually scans', () => {
	const debt = readDebt();
	const sizes = collectSizes(ROOT);
	const dangling = Object.keys(debt).filter((p) => !sizes.has(p));
	assert.deepEqual(
		dangling,
		[],
		`these debt entries name a file this run does not find tracked and in scope ` +
			`(renamed, moved, or deleted) — fix the path or remove the entry:\n  ${dangling.join('\n  ')}`
	);
});

void test('scripts/lib/file-size-debt.json: every recorded size is a valid, well-typed entry', () => {
	assert.deepEqual(malformedEntries(readDebt()), []);
});

void test('REAL TREE — no file over its ceiling is missing from the debt list (rule a)', () => {
	const result = evaluate(collectSizes(ROOT), readDebt());
	const lines = result.unlisted.map((v) => `${v.path}: ${v.lines} lines (ceiling ${v.ceiling})`);
	assert.deepEqual(
		lines,
		[],
		`file(s) over their ceiling and not in scripts/lib/file-size-debt.json:\n  ${lines.join('\n  ')}\n\n` +
			'Either shrink the file under its ceiling, or add it with ' +
			'`node scripts/file-size-debt.mjs --write --allow-growth <path>`.'
	);
});

void test('REAL TREE — no listed file has grown past its recorded size (rule b)', () => {
	const result = evaluate(collectSizes(ROOT), readDebt());
	const lines = result.grown.map(
		(v) => `${v.path}: ${v.lines} lines now, recorded ${v.recorded} (ceiling ${v.ceiling})`
	);
	assert.deepEqual(
		lines,
		[],
		`file(s) grown past their recorded debt:\n  ${lines.join('\n  ')}\n\n` +
			'Shrink the file back, or raise its entry deliberately with ' +
			'`node scripts/file-size-debt.mjs --write --allow-growth <path>`.'
	);
});

void test('REAL TREE — no listed file has shrunk, healed, or vanished without its entry being fixed (rule c)', () => {
	const result = evaluate(collectSizes(ROOT), readDebt());
	const lines = result.stale.map((v) => {
		const now = v.reason === 'deleted' ? 'deleted' : `${v.lines} lines (${v.reason})`;
		return `${v.path}: recorded ${v.recorded}, now ${now} (ceiling ${v.ceiling})`;
	});
	assert.deepEqual(
		lines,
		[],
		`stale debt entr${lines.length === 1 ? 'y' : 'ies'} — lower or remove it with ` +
			`\`node scripts/file-size-debt.mjs --write\`:\n  ${lines.join('\n  ')}`
	);
});

void test('REAL TREE — no debt entry is recorded at/under its own ceiling (rule d)', () => {
	const result = evaluate(collectSizes(ROOT), readDebt());
	const lines = result.listedAtOrUnderCeiling.map(
		(v) => `${v.path}: recorded ${v.recorded} <= ceiling ${v.ceiling}`
	);
	assert.deepEqual(
		lines,
		[],
		`debt entr${lines.length === 1 ? 'y' : 'ies'} that never belonged on the list — remove ` +
			`${lines.length === 1 ? 'it' : 'them'}:\n  ${lines.join('\n  ')}`
	);
});

void test('REAL TREE — the generator is idempotent: regenerating the list from the tree changes nothing', () => {
	// This is the "one command" the coordination note promises: after a
	// rebase lowers or removes files, `node scripts/file-size-debt.mjs
	// --write` alone must reach the exact state the four rules above expect,
	// with no `--allow-growth` needed, because a rebase that only shrinks
	// files never raises or adds an entry.
	const sizes = collectSizes(ROOT);
	const existing = readDebt();
	const { debt, warnings } = regenerate(sizes, existing);
	assert.deepEqual(debt, existing, 'the debt list is not what the generator would currently write');
	assert.deepEqual(warnings, [], 'an up-to-date list should need no growth warnings to reproduce');
});
