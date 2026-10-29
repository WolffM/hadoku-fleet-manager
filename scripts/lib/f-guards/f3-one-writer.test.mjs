/**
 * F3 ONE-WRITER GUARD (plan §3.2 rule 3, §4.1 F3 step 4): every state file has
 * exactly one declared writer module. Debt-list mode, like every other
 * F-guard: today's multi-writer files are accepted debt
 * (`scripts/lib/f-guards/f3-one-writer.json`), and a NEW writer — one not
 * already in that file for the basename or pattern it writes — fails, naming
 * the writer(s) already declared for it.
 *
 * DETECTION, IN ONE SENTENCE: a basename literal (`'name.json'`/`'name.jsonl'`)
 * "reaches" a write call when it is the PATH argument's value, traced through
 * at most a few hops of local `const`/`function` definitions in the SAME
 * file — never across a file boundary, and never through the DATA being
 * written (only `writeFileSync`/`appendFileSync`/`writeJsonAtomic`/
 * `writeFileAtomic`'s first argument, or `renameSync`'s first two). Comments
 * and string-literal CONTENTS are excluded from identifier scanning, so a
 * basename that happens to contain a real local variable's name as a
 * substring (`'label-floor-holdings.json'` contains `holdings`) cannot chain
 * through an unrelated variable of that name used elsewhere in the write
 * call's DATA. This is file-scoped, not a real type-checker's scope
 * resolution: a same-named `const` in two different functions resolves to
 * whichever one is TEXTUALLY NEAREST BEFORE the use, which is right for this
 * codebase's actual shape (one name, one meaning, re-declared per function)
 * and is proven against that shape below.
 *
 * TWO SHAPES OF STATE FILE, TWO DETECTORS:
 *   - FIXED NAME: the common case — a basename literal assigned to a
 *     `*_FILE`/`FILE` constant, or inlined directly into a `join(stateDir(),
 *     …)` path-getter. Walks every write call's path argument (see above).
 *   - PER-PERIOD NAME: `decision-log.ts`'s `${day}.jsonl` and
 *     `usage-store.ts`'s `usage-${year}-${month}.jsonl` have no single
 *     literal to trace — their name is built at write time. These are
 *     declared by the exact regex SOURCE each module uses to recognise its
 *     OWN files on a later read (`DAY_FILE`, `FILE_RE`): a file matches a
 *     declared pattern when it contains that regex source verbatim AND an
 *     append-family write call anywhere in it. `job-history.ts` and
 *     `job-rollup-store.ts` also append/rewrite JSONL, but each already has a
 *     FIXED basename (`'job-history.jsonl'`, parameterised from a caller for
 *     the rollup store — see the note below) and so is covered, or
 *     deliberately not, by the first detector instead.
 *
 * `job-rollup-store.ts` is NOT covered by either detector, and that is a
 * known, accepted gap, not a bug: `jsonlRollupStore(path)` takes its file
 * PATH AS A PARAMETER from its one caller (`job-rollups.ts`, not in this
 * wave's row) rather than holding `ROLLUP_FILE` itself in a write call's
 * argument chain, so there is no local literal for this file-scoped detector
 * to trace. Declaring it by hand here would immediately fail the STALE check
 * below (a declared writer the detector cannot find), which is the guard
 * correctly refusing to assert something it did not verify.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, tsAndMjsSources, enclosingSymbol } from './lib.mjs';

const WRITE_CALL = /\b(writeFileSync|renameSync|appendFileSync|writeJsonAtomic|writeFileAtomic)\(/g;
const APPEND_CALL = /\bappendFileSync\(/;
const BASENAME_LITERAL = /['"]([A-Za-z0-9._-]+\.(?:jsonl?))['"]/g;
const IDENT = /[A-Za-z_$][\w$]*/g;
const MAX_HOPS = 4;

function loadOneWriterData() {
	return JSON.parse(readFileSync(join(ROOT, 'scripts/lib/f-guards/f3-one-writer.json'), 'utf8'));
}

/** Blank out string/template-literal CONTENTS so identifier scanning cannot pick up a fragment of a basename. */
function maskStringContents(text) {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === "'" || c === '"' || c === '`') {
			const quote = c;
			let j = i + 1;
			while (j < text.length && text[j] !== quote) {
				if (text[j] === '\\') j++;
				j++;
			}
			out += ' '.repeat(j - i + 1);
			i = j + 1;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/** Top-level comma-split of a call's argument text (nesting- and string-aware). */
function splitTopLevelArgs(text) {
	const parts = [];
	let depth = 0;
	let cur = '';
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '(' || c === '[' || c === '{') depth++;
		else if (c === ')' || c === ']' || c === '}') depth--;
		else if (c === "'" || c === '"' || c === '`') {
			const quote = c;
			let j = i + 1;
			while (j < text.length && text[j] !== quote) {
				if (text[j] === '\\') j++;
				j++;
			}
			cur += text.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		if (c === ',' && depth === 0) {
			parts.push(cur);
			cur = '';
		} else {
			cur += c;
		}
		i++;
	}
	if (cur.trim()) parts.push(cur);
	return parts;
}

/** The text of the call starting at `code[openParenIdx] === '('`, exclusive of the parens. */
function callArgsText(code, openParenIdx) {
	let depth = 1;
	let j = openParenIdx + 1;
	while (depth > 0 && j < code.length) {
		if (code[j] === '(') depth++;
		else if (code[j] === ')') depth--;
		j++;
	}
	return code.slice(openParenIdx + 1, j - 1);
}

/** Every basename literal filed under the symbol (`const`/`function` name) whose body contains it. */
function basenameLiteralsBySymbol(code) {
	const map = new Map();
	for (const m of code.matchAll(BASENAME_LITERAL)) {
		const sym = enclosingSymbol(code, m.index);
		if (!sym) continue;
		if (!map.has(sym)) map.set(sym, new Set());
		map.get(sym).add(m[1]);
	}
	return map;
}

/** The nearest `const`/`let`/`var`/`function` declaration of `name` strictly BEFORE `beforeIdx`. */
function nearestDeclaration(code, name, beforeIdx) {
	const re = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=|function\\s+${name}\\s*\\(`, 'g');
	let best = -1;
	for (const m of code.slice(0, beforeIdx).matchAll(re)) if (m.index > best) best = m.index;
	if (best < 0) return null;
	const semi = code.indexOf(';', best);
	const end = semi === -1 ? Math.min(code.length, best + 300) : Math.min(semi + 1, best + 300);
	return { text: code.slice(best, Math.max(end, best + 60)), at: best };
}

/** Basenames reachable from `text` (a path argument, or a hop into a declaration's own text). */
function resolveBasenames(code, text, atIdx, symbolMap, hop, seen) {
	const found = new Set();
	for (const m of text.matchAll(BASENAME_LITERAL)) found.add(m[1]);
	if (hop >= MAX_HOPS) return found;
	for (const id of new Set([...maskStringContents(text).matchAll(IDENT)].map((m) => m[0]))) {
		if (seen.has(id)) continue;
		seen.add(id);
		if (symbolMap.has(id)) for (const b of symbolMap.get(id)) found.add(b);
		const decl = nearestDeclaration(code, id, atIdx);
		if (decl)
			for (const b of resolveBasenames(code, decl.text, decl.at, symbolMap, hop + 1, seen))
				found.add(b);
	}
	return found;
}

/** basename -> Set(file) for every FIXED-name state file this detector can trace. */
function findFixedNameWriters() {
	const byBasename = new Map();
	for (const { rel, code } of tsAndMjsSources()) {
		const symbolMap = basenameLiteralsBySymbol(code);
		for (const m of code.matchAll(WRITE_CALL)) {
			const fn = m[1];
			const openParenIdx = m.index + m[0].length - 1;
			const argsText = callArgsText(code, openParenIdx);
			const parts = splitTopLevelArgs(argsText);
			// Only the PATH argument(s): the write/append-family's first, or
			// renameSync's first AND second (the destination is the live path).
			const pathParts = fn === 'renameSync' ? parts.slice(0, 2) : parts.slice(0, 1);
			const basenames = new Set();
			for (const p of pathParts) {
				for (const b of resolveBasenames(code, p, m.index, symbolMap, 0, new Set()))
					basenames.add(b);
			}
			for (const b of basenames) {
				if (!byBasename.has(b)) byBasename.set(b, new Set());
				byBasename.get(b).add(rel);
			}
		}
	}
	return byBasename;
}

/** pattern (regex source text) -> Set(file), for a PER-PERIOD name declared in f3-one-writer.json. */
function findPatternWriters(patterns) {
	const byPattern = new Map();
	for (const pattern of Object.keys(patterns)) byPattern.set(pattern, new Set());
	for (const { rel, code } of tsAndMjsSources()) {
		if (!APPEND_CALL.test(code)) continue;
		for (const pattern of Object.keys(patterns)) {
			if (code.includes(pattern)) byPattern.get(pattern).add(rel);
		}
	}
	return byPattern;
}

/**
 * The comparison both directions use (plan §4.1 step 1's debt-list shape,
 * specialised so the message NAMES the declared writer rather than only the
 * stray key). Exported-by-closure so the mutation test below can call it
 * directly against SYNTHETIC maps, never the real source tree.
 */
function checkOneWriter(assertLib, kindLabel, declared, found) {
	for (const [key, files] of found) {
		const expected = new Set(declared[key] ?? []);
		const extra = [...files].filter((f) => !expected.has(f));
		assertLib.deepEqual(
			extra,
			[],
			`${kindLabel} "${key}": NEW writer(s) not in scripts/lib/f-guards/f3-one-writer.json:\n  ${extra.join('\n  ')}\n\n` +
				(expected.size
					? `Already declared: ${[...expected].join(', ')}. A second writer of one state file is exactly ` +
						'what plan §3.2 rule 3 forbids — route this write through the declared module, or if this is ' +
						'a reviewed, genuine second writer, add it to f3-one-writer.json next to the others.'
					: 'No writer is declared for this one yet — add it to f3-one-writer.json.')
		);
	}
	for (const [key, declaredFiles] of Object.entries(declared)) {
		const foundFiles = found.get(key) ?? new Set();
		const stale = declaredFiles.filter((f) => !foundFiles.has(f));
		assertLib.deepEqual(
			stale,
			[],
			`${kindLabel} "${key}": f3-one-writer.json names a writer the detector no longer finds:\n  ${stale.join('\n  ')}\n\n` +
				'Remove it — the declared set must match what is actually detected, never drift ahead of it.'
		);
	}
}

void test('F3 one-writer: every FIXED-name state file is written only where f3-one-writer.json says so', () => {
	const data = loadOneWriterData();
	checkOneWriter(assert, 'file', data.files, findFixedNameWriters());
});

void test('F3 one-writer: every PER-PERIOD-name state file is written only where f3-one-writer.json says so', () => {
	const data = loadOneWriterData();
	checkOneWriter(assert, 'pattern', data.patterns, findPatternWriters(data.patterns));
});

/**
 * MUTATION PROOF (done-when, §C step 5): the comparison itself, not the real
 * source tree, so this cannot be confused with a live finding. Reverted
 * (declared knows only the old writer, found gains a second) fails; restored
 * (found matches declared again) passes.
 */
void test('F3 one-writer MUTATION: a fixture with a second, undeclared writer fails the guard, and naming it', () => {
	const declared = { 'example-state.json': ['src/owner.ts'] };

	// REVERTED: a second writer appears that nobody declared.
	const foundWithIntruder = new Map([
		['example-state.json', new Set(['src/owner.ts', 'src/intruder.ts'])],
	]);
	assert.throws(
		() => checkOneWriter(assert, 'file', declared, foundWithIntruder),
		(err) => {
			assert.match(err.message, /NEW writer\(s\)/);
			assert.match(err.message, /src\/intruder\.ts/);
			assert.match(err.message, /Already declared: src\/owner\.ts/);
			return true;
		},
		'REVERTED: an undeclared second writer must fail the guard and name the declared one'
	);

	// RESTORED: only the declared writer remains.
	const foundClean = new Map([['example-state.json', new Set(['src/owner.ts'])]]);
	assert.doesNotThrow(
		() => checkOneWriter(assert, 'file', declared, foundClean),
		'RESTORED: the declared writer alone must pass'
	);
});

void test('F3 one-writer MUTATION: a STALE declaration (the detector no longer finds it) also fails', () => {
	const declared = { 'example-state.json': ['src/owner.ts'] };
	const foundEmpty = new Map();
	assert.throws(
		() => checkOneWriter(assert, 'file', declared, foundEmpty),
		/no longer finds/,
		'a declared writer that vanished from the tree must be removed from f3-one-writer.json, not left behind'
	);
});
