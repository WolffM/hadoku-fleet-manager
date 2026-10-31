/**
 * F3 (plan §4.1): no shared `writeJsonAtomic`/`readJsonState` exists yet, so
 * two shapes of copy are both debt today:
 *
 *   1. WRITE-THEN-RENAME COPIES: a file that already does the right thing
 *      (write a temp path, then rename it over the real one) but hand-rolls
 *      it instead of calling a shared helper — `writeFileSync` and
 *      `renameSync` close enough together to be the same operation.
 *   2. NOT ATOMIC AT ALL: a `writeFileSync`/`appendFileSync` with no
 *      `renameSync` NEAR IT, so that call writes (or appends to) the real
 *      path directly. A restart mid-write there can leave a truncated file
 *      — plan §4.1 calls this out by name for runner-health's alerts/
 *      snapshot state and job-history.
 *
 *      PER-CALL, not per-file: `job-history.ts` is the reason. It has a
 *      proper `renameSync`-backed `writeFileAtomic` for one write AND a bare
 *      `appendFileSync` straight to the live history file for another — a
 *      file-wide "does this file rename anywhere?" check would clear the
 *      unprotected append just because the file's OTHER write is safe. Each
 *      write call is judged by what is near IT.
 *
 *      EXCEPT a DECLARED APPEND (wave 5c §D step 3): `appendFileSync` is not
 *      "a write with no rename" in the same sense `writeFileSync` is — a
 *      rewrite-in-place can leave a torn RECORD (the write replaces bytes a
 *      reader may be mid-read of), but an append under O_APPEND either lands
 *      a whole new line or it does not land at all; the WORST a crash does is
 *      leave a torn TAIL, which `job-history.ts`'s own reader already counts
 *      and skips (plan §4.1 names this explicitly: "a torn last line"). That
 *      is a different, already-handled failure mode, not the unhandled one
 *      this guard exists to catch — so an append call is exempted, never a
 *      `writeFileSync`, and only when BOTH hold:
 *        (a) it is the sole declared writer of a `.jsonl` file/pattern in
 *            `f3-one-writer.json` (shared with the F3 one-writer guard,
 *            never re-decided here) — a SECOND writer of the same file is
 *            still exactly the risk plan §3.2 rule 3 forbids, declared append
 *            or not; and
 *        (b) the appended VALUE is built from `JSON.stringify(...)` and ends
 *            in a literal `\n` — a whole JSON line, never a raw buffer or
 *            partial fragment a crash could split mid-record.
 *      `job-history.ts`'s `appendToDisk`, `usage-store.ts`'s `appendUsage`
 *      and `decision-log.ts`'s `appendToDayFile` are exactly this shape and
 *      are no longer debt (removed from `debt.json`, not merely exempted by
 *      a key the guard would otherwise still have to carry).
 *
 * Proximity (same ~400 chars) is a proxy for "same function", cheap and good
 * enough for a debt list — a false pair would still name a real write/rename
 * site worth looking at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tsAndMjsSources, lineOf, enclosingSymbol, assertDebt, loadDebt, ROOT } from './lib.mjs';

const WRITE = /\bwriteFileSync\(/g;
const APPEND = /\bappendFileSync\(/g;
const RENAME = /\brenameSync\(/;
const PROXIMITY = 400;
/** How far BEFORE an append call this guard looks for the value it appends being built — covers
 *  `decision-log.ts`'s shape, where `const text = …; appendFileSync(path, text);` builds the line
 *  on the statement before the call rather than inline in its argument. */
const APPEND_VALUE_LOOKBEHIND = 300;

function loadOneWriterData() {
	return JSON.parse(readFileSync(join(ROOT, 'scripts/lib/f-guards/f3-one-writer.json'), 'utf8'));
}

/**
 * Is `rel` the SOLE declared writer of a `.jsonl` file or per-period pattern
 * in `f3-one-writer.json`? Reads the same registry `f3-one-writer.test.mjs`
 * maintains — never a second copy of that judgment. Two or more declared
 * writers of one file is still debt (plan §3.2 rule 3), declared-append shape
 * or not, so this is deliberately `=== 1`, not `>= 1`.
 */
function isSoleJsonlWriter(rel, oneWriterData) {
	for (const [basename, writers] of Object.entries(oneWriterData.files)) {
		if (basename.endsWith('.jsonl') && writers.length === 1 && writers[0] === rel) return true;
	}
	for (const writers of Object.values(oneWriterData.patterns)) {
		if (writers.length === 1 && writers[0] === rel) return true;
	}
	return false;
}

/**
 * Does the value this `appendFileSync` call writes look like a whole JSON
 * line (or several, each newline-joined) rather than a raw/partial fragment?
 * Looks at the call's own argument text AND the `APPEND_VALUE_LOOKBEHIND`
 * chars before it, since the value is sometimes built one statement earlier
 * (`decision-log.ts`) and sometimes inline (`job-history.ts`, `usage-store.ts`).
 * Exported by closure only — see the two fixture tests below.
 */
function looksLikeWholeJsonLines(code, callIndex) {
	const windowStart = Math.max(0, callIndex - APPEND_VALUE_LOOKBEHIND);
	const window = code.slice(windowStart, Math.min(code.length, callIndex + PROXIMITY));
	return /\bJSON\.stringify\(/.test(window) && /\\n/.test(window);
}

/**
 * Is the `appendFileSync` call at `callIndex` in file `rel` a declared
 * append — exempt from F3-non-atomic because it is the one thing an append
 * (never a `writeFileSync`) can still be safe doing: landing a whole JSON
 * line, under a declared single writer, where a crash can only tear the
 * TAIL a reader already counts and skips. See the header comment for why
 * this is append-only and sole-writer-only.
 */
function isDeclaredAppend(rel, code, callIndex, oneWriterData) {
	return isSoleJsonlWriter(rel, oneWriterData) && looksLikeWholeJsonLines(code, callIndex);
}

function findWriteThenRename() {
	const out = [];
	for (const { rel, code } of tsAndMjsSources()) {
		let n = 0;
		for (const m of code.matchAll(WRITE)) {
			const windowEnd = Math.min(code.length, m.index + PROXIMITY);
			if (RENAME.test(code.slice(m.index, windowEnd))) {
				n += 1;
				const sym = enclosingSymbol(code, m.index) ?? `line${lineOf(code, m.index)}`;
				out.push(`${rel}:${sym}#${n}`);
			}
		}
	}
	return out;
}

function findNonAtomic(oneWriterData = loadOneWriterData(), sources = tsAndMjsSources()) {
	const out = [];
	for (const { rel, code } of sources) {
		let n = 0;
		for (const pattern of [WRITE, APPEND]) {
			for (const m of code.matchAll(pattern)) {
				const windowEnd = Math.min(code.length, m.index + PROXIMITY);
				if (RENAME.test(code.slice(m.index, windowEnd))) continue; // this CALL renames nearby
				if (pattern === APPEND && isDeclaredAppend(rel, code, m.index, oneWriterData)) continue;
				n += 1;
				const sym = enclosingSymbol(code, m.index) ?? `line${lineOf(code, m.index)}`;
				out.push(`${rel}:${sym}#${n}`);
			}
		}
	}
	return out;
}

void test('F3: write-then-rename is hand-rolled only where debt.json says so', () => {
	assertDebt(
		assert,
		loadDebt(),
		'F3-write-then-rename',
		findWriteThenRename(),
		'Call the shared `writeJsonAtomic` (F3) instead of writing a temp path and renaming it ' +
			'by hand — fsync-before-rename and fsync-the-directory-after belong in one place.'
	);
});

void test('F3: a file with no renameSync at all is only non-atomic where debt.json says so', () => {
	assertDebt(
		assert,
		loadDebt(),
		'F3-non-atomic',
		findNonAtomic(),
		'This writeFileSync has no rename anywhere in its file, so a restart mid-write can leave ' +
			'a truncated or empty file where this code reads it back whole. Route it through the ' +
			'shared `writeJsonAtomic` (F3) rather than adding a bespoke temp-and-rename.'
	);
});

void test('F3: the guard sees the shapes it forbids', () => {
	assert.ok(RENAME.test('x; renameSync(a, b);'));
	assert.ok(WRITE.test('writeFileSync(a, b);'));
});

// --- declared-append shape (wave 5c §D step 3) ------------------------------
//
// Against SYNTHETIC `{ rel, code }` sources and a synthetic one-writer map,
// never the real tree — so these cannot be confused with a live finding, and
// so each one isolates exactly one of the two conditions `isDeclaredAppend`
// requires (sole writer, whole-JSON-line shape).

const SOLE_WRITER = { files: { 'x.jsonl': ['src/owner.ts'] }, patterns: {} };
const TWO_WRITERS = { files: { 'x.jsonl': ['src/owner.ts', 'src/intruder.ts'] }, patterns: {} };
const SOLE_PATTERN_WRITER = { files: {}, patterns: { '^(\\d+)\\.jsonl$': ['src/owner.ts'] } };

const WHOLE_LINE_APPEND = [
	'function append(records) {',
	"\tconst text = records.map((r) => JSON.stringify(r)).join('\\n') + '\\n';",
	"\tappendFileSync(join(dir, 'x.jsonl'), text);",
	'}',
].join('\n');

void test('declared append: sole writer + whole-JSON-line value is exempt, not debt', () => {
	const found = findNonAtomic(SOLE_WRITER, [{ rel: 'src/owner.ts', code: WHOLE_LINE_APPEND }]);
	assert.deepEqual(
		found,
		[],
		`expected the declared append to be exempt; found: ${found.join(', ')}`
	);
});

void test('declared append: the SAME shape with a second, undeclared writer is still debt', () => {
	// Two writers of the same file is exactly what plan §3.2 rule 3 forbids —
	// a declared-append shape never overrides that, it only covers the crash
	// risk a SOLE append-only writer carries.
	const found = findNonAtomic(TWO_WRITERS, [{ rel: 'src/owner.ts', code: WHOLE_LINE_APPEND }]);
	assert.deepEqual(found, ['src/owner.ts:text#1']);
});

void test('declared append: a sole writer appending a RAW/partial value (no JSON.stringify) is still debt', () => {
	const rawAppend = [
		'function append(chunk) {',
		"\tappendFileSync(join(dir, 'x.jsonl'), chunk);",
		'}',
	].join('\n');
	const found = findNonAtomic(SOLE_WRITER, [{ rel: 'src/owner.ts', code: rawAppend }]);
	assert.deepEqual(
		found,
		['src/owner.ts:append#1'],
		'a raw/partial append must stay debt even under a sole-writer declaration — the exemption ' +
			'is for whole JSON lines specifically, not for every append a declared writer makes'
	);
});

void test('declared append: a sole writer appending JSON with no trailing newline is still debt', () => {
	// JSON.stringify alone is not the shape — without a line terminator a
	// concurrent append could still land two records back to back as one
	// unparseable line, which is exactly the crash-tolerance the exemption
	// relies on `\n`-terminated whole lines for.
	const noNewline = [
		'function append(record) {',
		"\tappendFileSync(join(dir, 'x.jsonl'), JSON.stringify(record));",
		'}',
	].join('\n');
	const found = findNonAtomic(SOLE_WRITER, [{ rel: 'src/owner.ts', code: noNewline }]);
	assert.deepEqual(found, ['src/owner.ts:append#1']);
});

void test('declared append: writeFileSync is NEVER exempt, even as a sole jsonl writer with the same value shape', () => {
	// The exemption is for appendFileSync's crash semantics specifically
	// (lands whole or not at all); writeFileSync REWRITES, so the same sole-
	// writer declaration must not launder a rewrite into "declared append".
	const wholeLineRewrite = [
		'function rewrite(records) {',
		"\tconst text = records.map((r) => JSON.stringify(r)).join('\\n') + '\\n';",
		"\twriteFileSync(join(dir, 'x.jsonl'), text);",
		'}',
	].join('\n');
	const found = findNonAtomic(SOLE_WRITER, [{ rel: 'src/owner.ts', code: wholeLineRewrite }]);
	assert.deepEqual(found, ['src/owner.ts:text#1']);
});

void test("declared append: the value built one statement BEFORE the call still counts (decision-log's shape)", () => {
	// Same as WHOLE_LINE_APPEND, already covering this — named explicitly so
	// a future change to the lookbehind window cannot silently stop covering
	// the one real file (decision-log.ts) that needs it.
	const found = findNonAtomic(SOLE_WRITER, [{ rel: 'src/owner.ts', code: WHOLE_LINE_APPEND }]);
	assert.deepEqual(found, []);
});

void test("declared append: a per-period PATTERN sole writer (usage-store/decision-log's shape) is also exempt", () => {
	const found = findNonAtomic(SOLE_PATTERN_WRITER, [
		{ rel: 'src/owner.ts', code: WHOLE_LINE_APPEND },
	]);
	assert.deepEqual(found, []);
});

void test('declared append MUTATION: removing the exemption check un-exempts a real declared append', () => {
	// Simulates reverting the fix at the comparison level (findNonAtomic
	// itself), the same way f3-one-writer.test.mjs's own mutation test does —
	// without the `isDeclaredAppend` check, the sole-writer whole-line append
	// goes back to being reported.
	function findNonAtomicWithoutExemption(sources) {
		const out = [];
		for (const { rel, code } of sources) {
			let n = 0;
			for (const pattern of [WRITE, APPEND]) {
				for (const m of code.matchAll(pattern)) {
					const windowEnd = Math.min(code.length, m.index + PROXIMITY);
					if (RENAME.test(code.slice(m.index, windowEnd))) continue;
					n += 1;
					const sym = enclosingSymbol(code, m.index) ?? `line${lineOf(code, m.index)}`;
					out.push(`${rel}:${sym}#${n}`);
				}
			}
		}
		return out;
	}
	const reverted = findNonAtomicWithoutExemption([
		{ rel: 'src/owner.ts', code: WHOLE_LINE_APPEND },
	]);
	assert.deepEqual(reverted, ['src/owner.ts:text#1'], 'REVERTED: must report the append again');
	const restored = findNonAtomic(SOLE_WRITER, [{ rel: 'src/owner.ts', code: WHOLE_LINE_APPEND }]);
	assert.deepEqual(restored, [], 'RESTORED: must be exempt again');
});
