import test from 'node:test';
import assert from 'node:assert/strict';
import { blankComments } from './blank-comments.mjs';

/** Blanking must never move a character: offsets are what findings point at. */
function assertSameShape(src) {
	const out = blankComments(src);
	assert.equal(out.length, src.length, 'length preserved');
	assert.equal(out.split('\n').length, src.split('\n').length, 'line count preserved');
}

test('a // inside a string survives — the npm-auth blind spot', () => {
	// The regex blanker this replaced cut this line down to `echo "`, so the
	// npm-auth rule could not see the token. That is the whole reason this
	// module exists.
	const src = 'echo "//npm.pkg.github.com/:_authToken=${TOKEN}" >> .npmrc';
	assert.equal(blankComments(src), src);
	assertSameShape(src);
});

test('an apostrophe inside a line comment does not invert parity for the rest of the file', () => {
	const src = ["// First, let's check", "const label = 'kept';", '// trailing'].join('\n');
	const out = blankComments(src);
	assert.match(out, /const label = 'kept';/, 'real code survives');
	assert.doesNotMatch(out, /First/, 'the comment is blanked');
	assert.doesNotMatch(out, /trailing/, 'and so is one AFTER the apostrophe');
	assertSameShape(src);
});

test('a regex containing an escaped protocol slash does not eat the line', () => {
	// `\/\/` reads as a line comment to a scanner with no regex mode.
	const src = 'const x = q.replace(/https?:\\/\\//, "").trim();';
	const out = blankComments(src);
	assert.match(out, /\.trim\(\)/, 'the tail of the line survives');
	assertSameShape(src);
});

test('a quote inside a regex does not open string mode', () => {
	const src = ["const re = /we\\s+don'?t\\s+accept/i;", '// this comment must still blank'].join(
		'\n'
	);
	const out = blankComments(src);
	assert.doesNotMatch(out, /this comment/, 'parity survived the apostrophe in the regex');
	assertSameShape(src);
});

test('division is not mistaken for a regex', () => {
	// The tell is the TRAILING COMMENT, not the division: reading `/ total` as a
	// regex leaves the scanner mid-literal, so the `//` that follows is emitted
	// verbatim instead of blanked. Asserting only that the division survives
	// passes either way, because regex mode also emits verbatim.
	const src = 'const half = (a + b) / 2; // gone\nconst n = count / total; // also gone';
	const out = blankComments(src);
	assert.match(out, /const half = \(a \+ b\) \/ 2;/);
	assert.match(out, /const n = count \/ total;/);
	assert.doesNotMatch(out, /gone/, 'both trailing comments blank');
	assertSameShape(src);
});

test('a regex after `return` is a regex, not division', () => {
	// The apostrophe is what makes this test able to fail. Read as division, the
	// `'` opens string mode and swallows the trailing comment; only a scanner
	// that knows `return` cannot end an expression gets this right.
	const src = "return /don't/.test(s); // gone";
	const out = blankComments(src);
	assert.match(out, /return \/don't\/\.test\(s\);/);
	assert.doesNotMatch(out, /gone/, 'the comment blanks, so the apostrophe stayed inside the regex');
});

test('a character class may hold an unescaped slash', () => {
	// `[^/]` is the case that actually distinguishes: without char-class
	// handling the inner slash closes the literal early, the scanner re-opens a
	// regex on the real closing slash, and the trailing comment never blanks.
	const src = 'const re = /[^/]+/; // gone';
	const out = blankComments(src);
	assert.match(out, /const re = \/\[\^\/\]\+\/;/, 'the literal survives intact');
	assert.doesNotMatch(out, /gone/, 'and the regex closed where it should');
	assertSameShape(src);
});

test('block comments blank but keep their newlines', () => {
	const src = 'const a = 1;\n/* one\n   two */\nconst b = 2;';
	const out = blankComments(src);
	assert.match(out, /const a = 1;/);
	assert.match(out, /const b = 2;/);
	assert.doesNotMatch(out, /one|two/);
	assertSameShape(src);
});

test('strings are KEPT — an SQL literal is a string and rules live inside them', () => {
	const src = `const q = "SELECT user_id FROM t"; // gone`;
	const out = blankComments(src);
	assert.match(out, /SELECT user_id FROM t/);
	assert.doesNotMatch(out, /gone/);
});

test('an escaped quote does not end a string', () => {
	const src = `const s = 'it\\'s fine'; // gone\nconst t = 1;`;
	const out = blankComments(src);
	assert.match(out, /const t = 1;/);
	assert.doesNotMatch(out, /gone/);
	assertSameShape(src);
});

test('a misread division recovers at the newline rather than poisoning the file', () => {
	// `i++ / 2` is a real misread: the previous significant char is `+`, so the
	// heuristic opens a regex that never closes. The damage must stop at the end
	// of that line rather than inverting parity for the rest of the file.
	const src = 'let z = i++ / 2;\n// this must still blank\nconst k = 1;';
	const out = blankComments(src);
	assert.doesNotMatch(out, /this must still blank/);
	assert.match(out, /const k = 1;/);
	assertSameShape(src);
});

test('template literals are strings too', () => {
	const src = 'const u = `${host}//path`; // gone';
	const out = blankComments(src);
	assert.match(out, /\/\/path/);
	assert.doesNotMatch(out, /gone/);
});

test('a template nested inside `${}` does not invert parity for the rest of the file', () => {
	// The shape runner-health.ts carries. Scanned flat, the inner backtick closes
	// the outer template, the outer closing backtick OPENS one, and the comment
	// below survives as code — the ecosystem-literals gate counted four `hokon`
	// out of exactly this.
	const src = [
		'const msg = `labels from ${demoted.map((n) => `\\`${n}\\``).join(", ")}.`;',
		'// hokon is prose, not code',
		'const after = 1;',
	].join('\n');
	const out = blankComments(src);
	assert.doesNotMatch(out, /hokon/, 'the comment after the nested template blanks');
	assert.match(out, /const after = 1;/, 'and the code after it survives');
	assert.match(out, /\.join\(", "\)/, 'the interpolation itself is kept');
	assertSameShape(src);
});

test('braces inside `${}` do not end the interpolation early', () => {
	// An object literal or arrow body inside the interpolation closes its own
	// brace first; only the `}` that returns to the `${` depth resumes the template.
	const src = 'const s = `${fn({ a: 1 }, () => { return "`"; })} // kept`; // gone';
	const out = blankComments(src);
	assert.match(out, /\/\/ kept`;/, 'the `//` inside the template text is string');
	assert.doesNotMatch(out, /gone/, 'the real trailing comment blanks');
	assertSameShape(src);
});

test('a shell glob is not an open block comment', () => {
	// runners-slice-install.sh:259 — `${ecg%/*}` — and a workflow `run:` block,
	// which check-header-fleet's npm-auth rule reads through this scanner. A
	// slash-star that opens a comment blanks to the next star-slash, here the cron
	// line, and the token line between them is never seen.
	const src = [
		'run: |',
		'  ecg=${ecg%/*}',
		'  for d in "$dir"/*; do rm -rf dist/*; done',
		'  echo "_authToken=${{ secrets.HADOKU_SITE_TOKEN }}" >> .npmrc',
		'on:',
		'  schedule:',
		"    - cron: '*/15 * * * *'",
	].join('\n');
	const out = blankComments(src);
	assert.match(out, /_authToken=\$\{\{ secrets\.HADOKU_SITE_TOKEN \}\}/, 'the token line survives');
	assert.match(out, /ecg=\$\{ecg%\/\*\}/, 'and so does the glob itself');
	assert.match(out, /"\$dir"\/\*; do rm -rf dist\/\*; done/);
	assertSameShape(src);
});

test('scanning stays linear on a large file with many comments and slashes (#72)', () => {
	// #72: `opensRegex` used to re-trim the WHOLE output accumulated so far on
	// every `/` in the file, via `emitted.replace(/\s+$/, '')` — an unanchored
	// regex that must attempt a match starting at every earlier index before it
	// reaches the tail. That made each call cost O(length so far) rather than
	// O(trailing whitespace), and across a file with many `/` characters the
	// total was O(n^2): 82s measured on one real 112KB file.
	//
	// A SECOND unanchored regex did the same thing for the keyword check —
	// `/[A-Za-z_$][A-Za-z0-9_$]*$/.exec(trimmed)` — and it fires on every `/`
	// that follows an identifier character, which is every ordinary division
	// (`a / b`). Fixing only the whitespace trim left this one quadratic on
	// its own. So the input below needs BOTH shapes: long block comments
	// (stresses the whitespace walk) AND a long, dense run of `ident / ident`
	// division sites with no comments between them (stresses the keyword
	// check specifically — comment padding between divisions, as in the first
	// section alone, under-stresses this path because blanked-comment bytes
	// fail a regex attempt in O(1) while identifier-dense code does not).
	//
	// This bound (2s) is generous enough never to flake on a correct, linear
	// implementation (measured ~70-140ms for this input) while still catching
	// either regression (measured: reinstating just the keyword regex, with
	// the whitespace walk kept, took ~7.7s on this exact input; the original
	// with both regexes reinstated does not finish in 25s).
	const block = `/* ${'x'.repeat(2000)} */\n`;
	const lines = [];
	for (let n = 0; n < 400; n += 1) {
		lines.push(block);
		lines.push(`const v${n} = total${n} / count${n}; // comment ${n}\n`);
	}
	// The dense division section: no comments, no whitespace runs — every `/`
	// sits directly after an identifier character, so every one of these
	// forces the keyword-regex branch with nothing else to pad it out.
	for (let n = 0; n < 2000; n += 1) {
		lines.push(`const result${n} = totalAmount${n} / itemCount${n} / factor${n};\n`);
	}
	const src = lines.join('');
	assert.ok(src.length > 900_000, 'synthetic input is large enough to expose quadratic cost');

	const t0 = performance.now();
	const out = blankComments(src);
	const elapsedMs = performance.now() - t0;

	assert.ok(
		elapsedMs < 2000,
		`blankComments took ${elapsedMs.toFixed(1)}ms on a ${src.length}-byte input; ` +
			'a quadratic opensRegex would take seconds here'
	);
	assert.doesNotMatch(out, /x{10}/, 'the block comments are blanked');
	assert.match(out, /const v0 = total0 \/ count0;/, 'the division survives');
	assert.doesNotMatch(out, /comment \d+/, 'the trailing line comments are blanked');
	assert.match(
		out,
		/const result0 = totalAmount0 \/ itemCount0 \/ factor0;/,
		'the dense division section survives'
	);
	assertSameShape(src);
});

test('a block comment that does not abut a path still blanks', () => {
	// The negative control for the glob rule: an argument comment, a comment
	// after an operator, and one at the start of a line are all real comments.
	const src = 'call(/* one */ a, b); x = /* two */ 1;\n/* three */ const y = 2;';
	const out = blankComments(src);
	assert.doesNotMatch(out, /one|two|three/);
	assert.match(out, /const y = 2;/);
	assertSameShape(src);
});
