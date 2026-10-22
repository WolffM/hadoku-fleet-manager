/**
 * Blank out JS/TS comments while preserving every line and column.
 *
 * Two audit gates match regex rules against source text, and both of them
 * describe the very anti-patterns they look for in their own prose. Without
 * blanking, each reports its own documentation as a violation. Offsets are
 * preserved (a comment becomes the same number of spaces, newlines survive) so
 * a finding's line:column still points at real code.
 *
 * STRINGS ARE DELIBERATELY KEPT. An SQL literal is a string, and several rules
 * live inside them. This blanks comments, not content.
 *
 * WHY A CHARACTER SCANNER AND NOT A REGEX
 * ---------------------------------------
 * check-header-fleet.mjs used `src.replace(/(^|[^:])\/\/.*$/gm, '$1')` until
 * 2026-08-29. That guard rescues `https://` only by the accident of the
 * preceding colon, so any `//` inside a string not preceded by one ate the rest
 * of its line. The case it hid:
 *
 *     echo "//npm.pkg.github.com/:_authToken=${{ secrets.SOME_TOKEN }}" >> .npmrc
 *
 * blanked down to `echo "`, so the npm-auth rule never saw the token. A
 * protocol-relative `//host/` is the only npm-auth shape containing a `//`, so
 * the rule was structurally unable to report the raw-token-into-.npmrc form —
 * the one form CLAUDE.md says is never permissible — while looking like it
 * worked. Fleet-wide the two implementations disagree on 98 of 1496 sources.
 *
 * REGEX LITERALS
 * --------------
 * A quote inside a regex — `/we\s+don'?t\s+accept/i` — is not a string
 * delimiter, and treating it as one inverts the parity for the REST OF THE FILE,
 * leaving real comments visible. 22 of 1496 fleet sources contain one. The
 * direction is safe (a surviving comment can only cause a false positive, never
 * a dropped finding), but it is still wrong, so this scanner tracks regex
 * literals as their own mode.
 *
 * Telling a regex from division needs the previous significant token: after a
 * value (identifier, number, `)`, `]`) a `/` divides; after an operator, a
 * punctuator, or a keyword like `return`, it opens a regex.
 *
 * TEMPLATE INTERPOLATION
 * ----------------------
 * `${…}` inside a template literal is CODE, and it may hold anything code
 * holds — including another template. Scanned as flat string content, the
 * first nested backtick closes the outer template, the real closing backtick
 * then OPENS one, and every comment below it survives until the next backtick
 * in the file. runner-health.ts carried exactly that — `${xs.map((n) =>
 * `\`${n}\``)}` — and four `hokon` in the comments beneath it were scored as
 * code by the ecosystem-literals gate until 2026-09-18. So `${` pushes the
 * brace depth, and the `}` that returns to it resumes the template.
 *
 * SHELL GLOBS
 * -----------
 * This scanner is JavaScript's, but workflow YAML goes through it too (the
 * npm-auth rule in check-header-fleet), and YAML `run:` blocks are shell. A
 * glob — `dist/*`, `"$dir"/*`, `${path%/*}` — is an ordinary expansion there and
 * an OPEN BLOCK COMMENT here, blanking everything to the next star-slash: a
 * cron `*\/15` a hundred lines down, or nothing, i.e. the rest of the file. In
 * a glob the slash always abuts the path before it; formatted JS never writes
 * a block comment glued to a word, a quote, or a `}` (prettier spaces it). So a
 * slash-star preceded by one of those is emitted as code, not opened as a
 * comment. The price is a hand-written `a/*x*\/` staying visible, which is the
 * safe direction the header already documents.
 *
 * WHY opensRegex() NEVER RE-READS THE ACCUMULATED OUTPUT (#72)
 * --------------------------------------------------------------
 * Two regexes used to decide whether a `/` opens a regex or divides, both run
 * on EVERY `/` in the file, against the whole string emitted so far:
 *
 *   - `emitted.replace(/\s+$/, '')` to trim trailing whitespace (blanked
 *     comments leave long whitespace runs).
 *   - `/[A-Za-z_$][A-Za-z0-9_$]*$/.exec(trimmed)` to pull out the trailing
 *     identifier for the keyword check.
 *
 * Both are unanchored at the front, so each must attempt a match starting at
 * every earlier index before reaching the tail: O(length so far) per call
 * instead of O(the thing actually being measured), and file-length calls made
 * the whole scan O(n^2) — 82s on one 112KB file.
 *
 * A backward walk from the end — bounded by the whitespace run or the
 * identifier, not the whole string — looks linear in isolation, but it is
 * NOT safely O(1) per character here: `out` is a single string built by
 * thousands of small `+=` appends, and indexed reads (`out[i]`) into a string
 * built that way can cost more than O(1) depending on the engine's internal
 * representation and how much further concatenation happened since the last
 * read. Measured: a file with a large comment-heavy prefix followed by a
 * dense run of `ident / ident` sites took ~20x longer than the SAME division
 * section measured alone, even with the backward walk in place — a real,
 * reproducible cliff, not a one-off.
 *
 * So this never indexes into `out` at all. `emit()` updates `lastNonWs` (the
 * last non-whitespace character appended) and `wordRun` (the contiguous
 * identifier run ending there, if any) from the small chunk it is just now
 * appending — never from the accumulated string. Every emit costs
 * O(chunk length), and chunk lengths sum to exactly `src.length` over the
 * whole scan, so the total is O(n) regardless of how the string engine
 * represents `out` internally.
 */

/** A character a shell glob's slash abuts: the end of a path, a quote, a `${…}`. */
const GLOB_PRECEDER = /[A-Za-z0-9_$.~%"'}*-]/;

/** A character `blankComments` considers part of an identifier or number. */
const WORD_CHAR = /[A-Za-z0-9_$]/;

/** Keywords after which a `/` opens a regex rather than dividing. */
const REGEX_PRECEDING_KEYWORDS = new Set([
	'return',
	'typeof',
	'instanceof',
	'in',
	'of',
	'new',
	'delete',
	'void',
	'throw',
	'case',
	'do',
	'else',
	'yield',
	'await',
]);

/**
 * Append `text` (the next chunk of blanked or verbatim output) to `out`,
 * updating `state` from `text` alone. See the module header for why this
 * never reads back from `out`.
 */
function emit(out, state, text) {
	for (let k = 0; k < text.length; k += 1) {
		const c = text[k];
		if (WORD_CHAR.test(c)) {
			state.wordRun = state.wordRunActive ? state.wordRun + c : c;
			state.wordRunActive = true;
			state.lastNonWs = c;
		} else if (/\s/.test(c)) {
			// Whitespace breaks identifier contiguity going forward, but a
			// trailing run of it must not erase what `lastNonWs`/`wordRun`
			// already hold — that is exactly what the old trailing-whitespace
			// trim was skipping past.
			state.wordRunActive = false;
		} else {
			state.wordRun = '';
			state.wordRunActive = false;
			state.lastNonWs = c;
		}
	}
	return out + text;
}

/**
 * Does a `/` at this point open a regex literal, given `state` as tracked by
 * every `emit()` call so far?
 */
function opensRegex(state) {
	if (state.lastNonWs === undefined) return true; // start of file
	// After a value, `/` is division.
	if (state.lastNonWs === ')' || state.lastNonWs === ']') return false;
	if (WORD_CHAR.test(state.lastNonWs)) {
		// ...unless that identifier is a keyword that cannot end an expression.
		//
		// `/[A-Za-z_$][A-Za-z0-9_$]*$/.exec(trimmed)` found the LEFTMOST start
		// index whose [A-Za-z_$] first char is followed only by word chars to
		// the end — which, since a match can only start inside the contiguous
		// word-char run (anything outside it breaks the `*$` requirement), is
		// just the first non-digit character in that run.
		// `a1` → the run is "a1", first char is already non-digit → "a1".
		// `1a` → the run is "1a", the leading digit is skipped → "a".
		const run = state.wordRun;
		let idx = 0;
		while (idx < run.length && /[0-9]/.test(run[idx])) idx += 1;
		if (idx === run.length) return false; // the whole run is digits — not an identifier
		return REGEX_PRECEDING_KEYWORDS.has(run.slice(idx));
	}
	return true;
}

export function blankComments(src) {
	let out = '';
	let i = 0;
	let mode = 'code';
	let quote = '';
	// Brace depth in code, and the depth each open `${` returns to.
	let depth = 0;
	const interpolations = [];
	// What `opensRegex` needs, maintained incrementally by `emit` — see the
	// module header for why this is never read back out of `out` itself.
	const state = { lastNonWs: undefined, wordRun: '', wordRunActive: false };
	while (i < src.length) {
		const ch = src[i];
		const next = src[i + 1];
		if (mode === 'code') {
			if (ch === '/' && next === '/') {
				mode = 'line';
				out = emit(out, state, '  ');
				i += 2;
				continue;
			}
			if (ch === '/' && next === '*') {
				if (GLOB_PRECEDER.test(src[i - 1] ?? '')) {
					// A glob, and not a regex either: emit both characters as code.
					out = emit(out, state, '/*');
				} else {
					mode = 'block';
					out = emit(out, state, '  ');
				}
				i += 2;
				continue;
			}
			if (ch === '/' && opensRegex(state)) {
				mode = 'regex';
				out = emit(out, state, ch);
				i += 1;
				continue;
			}
			if (ch === '{') depth += 1;
			if (ch === '}') {
				if (interpolations.length && depth === interpolations[interpolations.length - 1]) {
					interpolations.pop();
					mode = 'string';
					quote = '`';
					out = emit(out, state, ch);
					i += 1;
					continue;
				}
				depth -= 1;
			}
			if (ch === '"' || ch === "'" || ch === '`') {
				mode = 'string';
				quote = ch;
				out = emit(out, state, ch);
				i += 1;
				continue;
			}
			out = emit(out, state, ch);
			i += 1;
			continue;
		}
		if (mode === 'line') {
			if (ch === '\n') {
				mode = 'code';
				out = emit(out, state, ch);
			} else out = emit(out, state, ' ');
			i += 1;
			continue;
		}
		if (mode === 'block') {
			if (ch === '*' && next === '/') {
				mode = 'code';
				out = emit(out, state, '  ');
				i += 2;
				continue;
			}
			out = emit(out, state, ch === '\n' ? '\n' : ' ');
			i += 1;
			continue;
		}
		if (mode === 'regex') {
			// An unterminated regex cannot span a line — that means we misread a
			// division. Fall back to code so one bad guess costs one line, not the
			// parity of the rest of the file.
			if (ch === '\n') {
				mode = 'code';
				out = emit(out, state, ch);
				i += 1;
				continue;
			}
			if (ch === '\\') {
				out = emit(out, state, src.slice(i, i + 2));
				i += 2;
				continue;
			}
			if (ch === '[') {
				// A character class may contain an unescaped `/`.
				const close = src.indexOf(']', i);
				const nl = src.indexOf('\n', i);
				if (close !== -1 && (nl === -1 || close < nl)) {
					out = emit(out, state, src.slice(i, close + 1));
					i = close + 1;
					continue;
				}
			}
			if (ch === '/') mode = 'code';
			out = emit(out, state, ch);
			i += 1;
			continue;
		}
		// string
		if (ch === '\\') {
			out = emit(out, state, src.slice(i, i + 2));
			i += 2;
			continue;
		}
		if (quote === '`' && ch === '$' && next === '{') {
			interpolations.push(depth);
			mode = 'code';
			out = emit(out, state, '${');
			i += 2;
			continue;
		}
		if (ch === quote) mode = 'code';
		out = emit(out, state, ch);
		i += 1;
	}
	return out;
}
