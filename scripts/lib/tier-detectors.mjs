/**
 * Tier-drift detectors, shared by the in-repo gate and the fleet audit.
 *
 * `check-tier-gating.mjs` enforces these inside hadoku_site (CI + pre-commit).
 * `check-tier-fleet.mjs` runs the same rules across every sibling child repo,
 * which no CI reaches. Two callers, ONE implementation — a second copy of a
 * tier rule is precisely the class of bug these rules exist to catch, and
 * writing one here would have been funny in the wrong way.
 */

/**
 * The tiers a KEY may hold, LOW to HIGH. `public` is excluded: it is the
 * absence of a credential, so a list of ASSIGNABLE tiers legitimately omits it.
 */
const ASSIGNABLE_TIERS = ['friend', 'service', 'wife', 'admin'];

/** The top of the ladder. Nothing outranks it — see `findNonTopTierEquality`. */
const TOP_TIER = 'admin';

/**
 * A tier name as a STRING LITERAL or an object key — `'admin'`, `"wife"`,
 * `admin:`, `wife =`. Deliberately not a bare word: prose that mentions a tier
 * inside a string ("requires admin tier") must not read as a declaration.
 */
const RE_TIER_TOKEN = new RegExp(
	`(?:['"\`](${ASSIGNABLE_TIERS.join('|')})['"\`])|(?:\\b(${ASSIGNABLE_TIERS.join('|')})\\s*:)`,
	'g'
);

/**
 * "Vocabulary glue" — what may sit BETWEEN two tier names for them to count as
 * one declaration. Collection punctuation, union bars, object-literal colons,
 * numeric values, quotes, brackets, whitespace. Nothing else.
 *
 * This is the whole precision of the vocabulary rule. A proximity-only version
 * flagged 28 sites in hadoku_site, most of them CORRECT code — three adjacent
 * `requireMinTier('admin'|'service'|'friend')` gates read as a stale
 * vocabulary. An identifier between two tier names means they are being USED
 * (passed, compared, called), not ENUMERATED, and only enumerations go stale.
 */
const RE_VOCAB_GLUE = /^[\s,|:;\d'"`[\]{}()=>?.-]*$/;

/**
 * How many DISTINCT tiers a run must name before it counts as a vocabulary.
 *
 * Three, not two. A two-tier run is overwhelmingly a comparison rather than a
 * declaration — `tierAtLeast({ userType: 'admin' }, 'friend')` is separated by
 * pure glue and is indistinguishable from a two-element list by syntax alone.
 *
 * The cost of that choice is real and was paid: watchparty's browser-side
 * `isPrivileged` read `=== 'service' || === 'admin'` and this rule could not
 * see it. That is exactly why `findNonTopTierEquality` exists below — the two
 * rules cover each other's blind spot.
 */
const VOCAB_MIN_TIERS = 3;

/**
 * Strip whole-line comments so prose describing an anti-pattern doesn't trip a
 * rule. Lines are BLANKED rather than removed so reported line numbers stay
 * true. Covers `//`, `*`, `/*` and `#` (Python).
 *
 * PYTHON DOCSTRINGS need `{ python: true }`, and the rule cannot see them
 * otherwise. A JS block comment prefixes its continuation lines with `*`, so the
 * line test catches every one; a `"""…"""` docstring is bare prose, and the
 * most useful prose a tier module can contain is a description of the tier bug
 * it already fixed.
 *
 * That is not hypothetical. `hadoku-pygmalion/pygmalion/tiers.py` opens with a
 * docstring whose entire purpose is to record that `tier in ("admin",
 * "service")` excluded `wife` and was FIXED — and check-tier-fleet reported
 * that sentence as a live violation. A gate that reports its own documentation
 * is a gate people learn to wave through, which is worse than one that misses.
 * Same class as the coupling checker whose naive stripper ate the `//` in a URL.
 *
 * Gated on the flag rather than applied everywhere because an unbalanced `"""`
 * inside a TS string literal would otherwise blank the rest of that file and
 * hide REAL findings — trading a false positive for a false negative, which is
 * the worse direction.
 *
 * ONLY WHAT IS BETWEEN THE DELIMITERS. This used to blank every line that HELD
 * a `"""`, so `if user.tier in ("service",): log("""denied""")` lost its gate
 * along with its string, and any code before an opening `"""` or after a
 * closing one went with it. Docstring characters are now replaced by spaces,
 * delimiter to delimiter, so columns and line numbers both stay true. A
 * closing delimiter must MATCH the opening one: `'''` inside a `"""` block is
 * prose, not an end.
 */
export function blankComments(text, { python = false } = {}) {
	const src = python ? blankDocstrings(text) : text;
	return src
		.split('\n')
		.map((l) => (/^\s*(\/\/|\*|\/\*|#)/.test(l) ? '' : l))
		.join('\n');
}

/** Every `"""…"""` / `'''…'''` span replaced by spaces, newlines kept. */
function blankDocstrings(text) {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const open = text.slice(i, i + 3);
		if (open !== '"""' && open !== "'''") {
			out += text[i++];
			continue;
		}
		const close = text.indexOf(open, i + 3);
		const end = close < 0 ? text.length : close + 3;
		out += text.slice(i, end).replace(/[^\n]/g, ' ');
		i = end;
	}
	return out;
}

/** 1-indexed line number of `index` within `text`. */
function lineOf(text, index) {
	return text.slice(0, index).split('\n').length;
}

/**
 * Incomplete tier vocabularies: a local list naming 3+ tiers that omits one.
 *
 * Such a list does not throw on the missing tier — it fails CLOSED and
 * SILENTLY, rewriting the value to `public` or ranking it -1, so the caller
 * authenticates at the edge and then receives public data with no 401, no 403
 * and no log line.
 *
 * Returns `[{ line, found, missing }]`.
 */
export function findStaleVocabularies(text) {
	const hits = [];
	for (const m of text.matchAll(RE_TIER_TOKEN)) {
		hits.push({ start: m.index, end: m.index + m[0].length, tier: m[1] ?? m[2] });
	}
	const out = [];
	let i = 0;
	while (i < hits.length) {
		let j = i;
		while (j + 1 < hits.length && RE_VOCAB_GLUE.test(text.slice(hits[j].end, hits[j + 1].start))) {
			j++;
		}
		const run = hits.slice(i, j + 1);
		const found = new Set(run.map((h) => h.tier));
		if (found.size >= VOCAB_MIN_TIERS) {
			const missing = ASSIGNABLE_TIERS.filter((t) => !found.has(t));
			if (missing.length)
				out.push({ line: lineOf(text, run[0].start), found: [...found], missing });
		}
		i = j + 1;
	}
	return out;
}

/**
 * An equality comparison against a NON-TOP tier — `x === 'service'`,
 * `tier != "friend"`, `not in ("service", ...)`, `in {"service", ...}`, and
 * — when the list or the labels leave a tier out — `[...].includes(tier)` and
 * `switch (tier) { case 'service': ... }`.
 *
 * Why non-top only. `=== 'admin'` is an exact match against the CEILING, so it
 * admits exactly the right set and cannot lock anyone out; there are a dozen
 * such sites across the fleet and flagging them would be noise that gets the
 * whole check ignored. A comparison against friend/service/wife is different in
 * kind: every tier ABOVE the named one is silently excluded, which is the bug
 * the rank model exists to prevent.
 *
 * This is the rule that catches two-tier allowlists, which the vocabulary rule
 * deliberately cannot see.
 *
 * Returns `[{ line, text }]`.
 */
export function findNonTopTierEquality(text) {
	const nonTop = ASSIGNABLE_TIERS.filter((t) => t !== TOP_TIER).join('|');
	// The operand must NAME a caller's tier. Without this the rule fires on
	// `requires == "friend"` (dataplatform compares a route's REQUIRED tier —
	// correct code) and on coincidental string equality inside minified vendor
	// bundles. Matching `userType` / `user_type` / `…tier` covers every shape in
	// the fleet: `auth.userType`, `_state.userType`, `ctx.tier`, `ident.tier`.
	const SUBJ = `(?:[A-Za-z_$][\\w$]*\\.)*(?:userType|user_type|[Tt]ier)`;
	// `in` takes a tuple, a list OR a set literal — `tier in {"service",
	// "admin"}` is the same two-tier allowlist, and a `[([]` class read the
	// set form as clean.
	const re = new RegExp(
		`(?:\\b${SUBJ}\\s*[=!]==?\\s*['"\`](${nonTop})['"\`])` +
			`|(?:['"\`](${nonTop})['"\`]\\s*[=!]==?\\s*\\b${SUBJ})` +
			`|(?:\\b${SUBJ}\\s+(?:not\\s+)?in\\s*[([{]\\s*['"\`](?:${nonTop}|${TOP_TIER})['"\`])`,
		'g'
	);
	// The JS spelling of the same allowlist: `['service', 'admin'].includes(
	// auth.userType)`. Gated on the list being INCOMPLETE — naming every
	// assignable tier admits everyone with a credential, which is not drift.
	const includes = new RegExp(`\\[([^\\]]*)\\]\\s*\\.includes\\(\\s*${SUBJ}\\s*\\)`, 'g');
	const out = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		// Minified bundles are one enormous line; nothing hand-written looks like
		// that, and scanning them only ever produces coincidences.
		if (lines[i].length > 400) continue;
		re.lastIndex = 0;
		includes.lastIndex = 0;
		const hit =
			re.test(lines[i]) ||
			[...lines[i].matchAll(includes)].some((m) => isPartialTierList(tiersNamed(m[1])));
		if (hit) out.push({ line: i + 1, text: lines[i].trim() });
	}
	for (const s of findPartialTierSwitches(text, SUBJ)) {
		if (!out.some((o) => o.line === s.line)) out.push(s);
	}
	return out.sort((a, b) => a.line - b.line);
}

/** The distinct assignable tiers a stretch of source names as string literals. */
function tiersNamed(src) {
	const re = new RegExp(`['"\`](${ASSIGNABLE_TIERS.join('|')})['"\`]`, 'g');
	return new Set([...src.matchAll(re)].map((m) => m[1]));
}

/** Names a non-top tier, and leaves at least one assignable tier out. */
function isPartialTierList(found) {
	return [...found].some((t) => t !== TOP_TIER) && ASSIGNABLE_TIERS.some((t) => !found.has(t));
}

/**
 * `switch (auth.userType) { case 'service': case 'admin': … }` — an equality
 * test spread over `case` labels, one per line, which no per-line pattern can
 * see. The same allowlist shape as `===`: every tier without a label falls
 * through to `default`. A switch whose labels name EVERY assignable tier is a
 * complete mapping and is left alone. Reported at the `switch` line.
 */
function findPartialTierSwitches(text, SUBJ) {
	const out = [];
	const head = new RegExp(`\\bswitch\\s*\\(\\s*${SUBJ}\\s*\\)\\s*\\{`, 'g');
	for (const m of text.matchAll(head)) {
		const start = m.index + m[0].length;
		let depth = 1;
		let j = start;
		while (j < text.length && depth > 0) {
			if (text[j] === '{') depth++;
			else if (text[j] === '}') depth--;
			j++;
		}
		const body = text.slice(start, j);
		const labels = tiersNamed(
			[...body.matchAll(/\bcase\s+(['"`][^'"`]*['"`])\s*:/g)].map((c) => c[1]).join(' ')
		);
		if (isPartialTierList(labels)) {
			const line = lineOf(text, m.index);
			out.push({ line, text: text.split('\n')[line - 1].trim() });
		}
	}
	return out;
}
