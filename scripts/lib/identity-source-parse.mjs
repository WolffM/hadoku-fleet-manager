/**
 * Generic, domain-agnostic SOURCE PARSING primitives for the identity-model
 * gate (scripts/check-identity-model.mjs, split #8 — pure move).
 *
 * Nothing here knows about G1..G8, identity, credentials or workers: every
 * export takes already-read text (JS/TS source, SQL, TOML) and returns a
 * structural reading of it — a destructure's fields, a SQL table's columns, a
 * wrangler.toml's top-level bindings, an import's local names. The domain
 * rules that READ these structures live in identity-rules.mjs, which imports
 * from here; nothing in this file imports from there, on purpose, so the
 * dependency only ever runs one way.
 *
 * HERE walks up one directory from scripts/lib to resolve nothing here —
 * there is no HERE constant in this file, since every function takes its
 * input as a parameter rather than reading the filesystem itself (the one
 * exception, `resolveLocal`, resolves a RELATIVE IMPORT SPECIFIER against the
 * importing file's own absolute path, which is passed in, not derived).
 */

import { dirname, resolve } from 'node:path';
import { statSync } from 'node:fs';

/**
 * Is this path a TEST FILE by name?
 *
 * `[cm]?` is the whole point. The pattern was `[jt]sx?`, which does not match
 * `.mjs` — so `scripts/check-identity-model.test.mjs` was scanned as production
 * code, and this gate flagged G7 against line 26 of its OWN regression test,
 * which is a template-literal fixture:
 *
 *     const RESOLVER = `
 *     export async function handler(c) {
 *       const out = await resolveGrantee(c.env, { name: c.req.query('name') });
 *
 * A fixture is not evidence. That is the fourth time this repo has read one as
 * evidence, and it broke `ci:identity-model` for a day against a repo that
 * deploys no worker at all — `find . -name wrangler.toml` returns nothing here,
 * so the SIBLING_WORKERS entry the message asks for would have been a false
 * claim about a deployment that does not exist.
 *
 * Stated ONCE and used at all three call sites. It was three copies of one
 * regex, which is why widening two of them would have left the class alive.
 */
export function isTestFile(pathOrName) {
	return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(pathOrName);
}

/**
 * Every `const { a, b: c } = <rhs>` destructure, as `{field, binding}` pairs
 * with the right-hand side and where it sits. Quoted keys are unquoted, rest
 * elements unprefixed. One level only: a nested pattern's inner names are not
 * yielded, and its outer key is.
 */
export function* destructures(src) {
	const re = /(?:const|let|var)\s*\{([^}]*)\}\s*(?::[^=]*)?=\s*(?:await\s+)?([^;\n]*)/g;
	let m;
	while ((m = re.exec(src))) {
		const pairs = [];
		for (const raw of m[1].split(',')) {
			const [key, bind] = raw.split(':').map((s) => s?.trim());
			const field = (key ?? '').replace(/^\.\.\./, '').replace(/^(['"])(.*)\1$/, '$2');
			if (!field) continue;
			const binding = (bind ?? field).split('=')[0].trim();
			pairs.push({ field, binding: /^[A-Za-z_$][\w$]*$/.test(binding) ? binding : null });
		}
		yield { pairs, rhs: m[2], index: m.index };
	}
}

export const IDENT = '[A-Za-z_$][\\w$]*';

/** `a`, `a as b`, `type A` → `[exported/imported name, local name]`, types dropped. */
export function specifiers(list) {
	const out = [];
	for (const raw of list.split(',')) {
		const spec = raw.trim();
		if (!spec || /^type\s/.test(spec)) continue;
		const m = new RegExp(`^(${IDENT})(?:\\s+as\\s+(${IDENT}))?$`).exec(spec);
		if (m) out.push([m[1], m[2] ?? m[1]]);
	}
	return out;
}

/**
 * The file a RELATIVE specifier names, or null. TypeScript sources import
 * `./x.js` meaning `./x.ts`, and a bare `./x` may be a directory index.
 */
export function resolveLocal(fromAbs, spec) {
	if (!spec.startsWith('.')) return null;
	const base = resolve(dirname(fromAbs), spec);
	const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
	for (const cand of [
		base,
		...['.ts', '.tsx', '.mts', '.js', '.mjs'].map((e) => stem + e),
		...['index.ts', 'index.js'].map((i) => resolve(base, i)),
	]) {
		try {
			if (statSync(cand).isFile()) return cand;
		} catch {
			// not this candidate — the loop tries the next spelling
		}
	}
	return null;
}

/**
 * TOML comments are `#`, and they MUST be stripped before either test below:
 * `wrangler.toml` files here carry commented-out example bindings verbatim
 * (study-api has a `# binding = "STUDY_KV"` pair), so a naive match reads a
 * suggestion as a deployment.
 *
 * NOT `blankComments` — that one strips `//` and is for JS. Handed a TOML file
 * it eats the rest of the document at the first `"` it cannot pair, which
 * silently reported prefs-api as unbound when its binding is right there on
 * line 44. Found by running the gate, not by reading it.
 */
export function stripTomlComments(src) {
	return src
		.split('\n')
		.map((line) => {
			let quoted = false;
			for (let i = 0; i < line.length; i += 1) {
				const ch = line[i];
				if (ch === '"' || ch === "'") quoted = !quoted;
				else if (ch === '#' && !quoted) return line.slice(0, i);
			}
			return line;
		})
		.join('\n');
}

/**
 * The TOP-LEVEL bindings a wrangler.toml declares, by table name.
 *
 * Section-aware, because a bare `binding = "SESSIONS_KV"` anywhere in the file
 * used to count: under `[[env.staging.kv_namespaces]]` it binds only in an
 * environment the default deploy never uses, and under `[[d1_databases]]` it is
 * a database, not the registry (mutation-tested 2026-10-10, #98). Only
 * `[[kv_namespaces]]` / `[[services]]` at the root count, plus the inline
 * `kv_namespaces = [{ … }]` form written before any table header.
 *
 * Input must already be through `stripTomlComments`.
 */
export function topLevelBindings(toml) {
	/** table name -> the text of every entry under it */
	const out = { kv_namespaces: [], services: [] };
	let section = null; // null = the root table
	let inline = null; // { key, depth, text } while inside a root `key = [ … ]`
	for (const line of toml.split('\n')) {
		if (inline) {
			inline.text += `\n${line}`;
			inline.depth += (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
			if (inline.depth <= 0) {
				out[inline.key].push(inline.text);
				inline = null;
			}
			continue;
		}
		const header = /^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?\s*$/.exec(line);
		if (header) {
			// Only an ARRAY-of-tables header names a binding list; `[vars]`,
			// `[env.production]` and the like end the previous entry and bind nothing.
			section = header[1] === '[[' ? header[2] : `[${header[2]}]`;
			if (Object.hasOwn(out, section)) out[section].push('');
			continue;
		}
		if (section === null) {
			const arr = /^\s*(kv_namespaces|services)\s*=\s*(\[.*)$/.exec(line);
			if (arr) {
				const depth = (arr[2].match(/\[/g) ?? []).length - (arr[2].match(/\]/g) ?? []).length;
				if (depth <= 0) out[arr[1]].push(arr[2]);
				else inline = { key: arr[1], depth, text: arr[2] };
			}
			continue;
		}
		if (Object.hasOwn(out, section)) out[section][out[section].length - 1] += `\n${line}`;
	}
	return out;
}

export const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/**
 * What may sit between a type's NAME and its opening brace: generics,
 * `extends A, B<T>`, or `= Base & Other<T> & ` / `= Readonly<`.
 *
 * The pattern required the brace straight after the name (or after `=`), so
 * `interface X<T>`, `interface X extends Base`, and `type X = Base & {…}` —
 * the natural ways to copy the registry row onto a base type — all walked past
 * (mutation-tested 2026-10-10, #98). No `(`, `:` or quote is admitted, and an
 * alias's right-hand side must END in an operator that opens the brace, so a
 * brace-less alias (`type A = B`) cannot reach forward into the next
 * declaration's body. Procedural rather than one regex: the nested-quantifier
 * form backtracks exponentially on a long header that does not match.
 */
function typeHeaderOk(header) {
	if (/[^\w$.<>,\s&|=]/.test(header)) return false;
	const eq = header.lastIndexOf('=');
	if (eq < 0) return true; // `interface X<T> extends A, B<T>`
	const rhs = header.slice(eq + 1).trim();
	return rhs === '' || /[&|<]$/.test(rhs);
}

/** Every `interface X … { … }` / `type X = … { … }` block, with its body. */
export function* typeBlocks(src) {
	const re = /\b(?:interface|type)\s+([A-Za-z_$][\w$]*)/g;
	let m;
	while ((m = re.exec(src))) {
		const from = m.index + m[0].length;
		const brace = src.indexOf('{', from);
		if (brace < 0) continue;
		const semi = src.indexOf(';', from);
		if (semi >= 0 && semi < brace) continue;
		if (!typeHeaderOk(src.slice(from, brace))) continue;
		let depth = 1;
		let i = brace + 1;
		while (i < src.length && depth > 0) {
			if (src[i] === '{') depth += 1;
			else if (src[i] === '}') depth -= 1;
			i += 1;
		}
		yield { name: m[1], body: src.slice(m.index, i), line: lineOf(src, m.index) };
	}
}

/**
 * A SQL identifier in any quoting SQLite/Postgres/MySQL accept — `"x"`, `` `x` ``,
 * `[x]`, or bare. Exactly one of the four groups is set; `identName` reads it.
 */
export const SQL_IDENT = '(?:"([^"]+)"|`([^`]+)`|\\[([^\\]]+)\\]|([A-Za-z_][\\w$]*))';

/** The same, capturing nothing — for a table name, which is only ever printed. */
const SQL_IDENT_ANY = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
export const identName = (m, at) =>
	(m[at] ?? m[at + 1] ?? m[at + 2] ?? m[at + 3] ?? '').toLowerCase();

/** A table-level constraint clause: no column is declared by it. */
const SQL_CONSTRAINT = /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|KEY|INDEX|EXCLUDE|FULLTEXT)\b/i;

/**
 * Split `s` on commas at paren depth 0 and outside quotes, keeping each part's
 * offset into `s`.
 */
function splitTopLevel(s) {
	const parts = [];
	let depth = 0;
	let quote = null;
	let start = 0;
	for (let i = 0; i < s.length; i += 1) {
		const ch = s[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') quote = ch;
		else if (ch === '(') depth += 1;
		else if (ch === ')') depth -= 1;
		else if (ch === ',' && depth === 0) {
			parts.push({ text: s.slice(start, i), offset: start });
			start = i + 1;
		}
	}
	parts.push({ text: s.slice(start), offset: start });
	return parts;
}

/** Index of the paren closing the one at `open`, or -1 if it never closes. */
function matchingParen(s, open) {
	let depth = 0;
	let quote = null;
	for (let i = open; i < s.length; i += 1) {
		const ch = s[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') quote = ch;
		else if (ch === '(') depth += 1;
		else if (ch === ')') {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * The columns of every `CREATE TABLE`, in order, as `{name, index}` (index into
 * `sql`) — plus every table that parsed to NOTHING, which is reported.
 *
 * STRUCTURAL, not a line-and-type pattern. The old reader took one column per
 * LINE and only when followed by TEXT/INTEGER/REAL/BLOB/NUMERIC, and needed a
 * trailing `);` — so a one-line CREATE TABLE, a VARCHAR/UUID/BOOLEAN column, a
 * backtick- or bracket-quoted name, and a statement without its semicolon each
 * declared a column G2 never saw (mutation-tested 2026-10-10, #98). The body now
 * ends at its MATCHING paren and splits on top-level commas; the first
 * identifier of each non-constraint clause is the column, whatever its type.
 *
 * The self-check is the point: a table that yields zero columns is a schema
 * this reader could not see, and "I could not look" must not read as clean.
 */
export function createTableColumns(sql) {
	const columns = [];
	const blind = [];
	const re = new RegExp(
		`\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?((?:${SQL_IDENT_ANY}\\.)?${SQL_IDENT_ANY})\\s*\\(`,
		'gi'
	);
	for (const m of sql.matchAll(re)) {
		const open = m.index + m[0].length - 1;
		const close = matchingParen(sql, open);
		const body = close < 0 ? sql.slice(open + 1) : sql.slice(open + 1, close);
		let found = 0;
		for (const part of splitTopLevel(body)) {
			const text = part.text.trimStart();
			if (!text.trim() || SQL_CONSTRAINT.test(text)) continue;
			const id = new RegExp(`^${SQL_IDENT}`).exec(text);
			if (!id) continue;
			found += 1;
			columns.push({
				name: identName(id, 1),
				index: open + 1 + part.offset + (part.text.length - text.length),
			});
		}
		if (!found) blind.push({ table: m[1], index: m.index });
	}
	return { columns, blind };
}

/** An identifier, escaped for use inside a RegExp (`$` is legal in both). */
export const reIdent = (name) => name.replace(/\$/g, '\\$');

/**
 * Every top-level argument of every `.bind(...)` call, with its line.
 *
 * Top-level: a nested call's own arguments are NOT yielded, which is the whole
 * point — `ownerOf(p.friendKey)` binds a resolved id, and only the outer
 * expression is what lands in the column.
 */
export function* bindArguments(src) {
	const re = /\.bind\s*\(/g;
	let m;
	while ((m = re.exec(src))) {
		let depth = 1;
		let i = m.index + m[0].length;
		let arg = '';
		const argLine = () => lineOf(src, i);
		while (i < src.length && depth > 0) {
			const ch = src[i];
			if (ch === '(' || ch === '[' || ch === '{') depth += 1;
			else if (ch === ')' || ch === ']' || ch === '}') {
				depth -= 1;
				if (depth === 0) break;
			}
			if (ch === ',' && depth === 1) {
				if (arg.trim()) yield [arg.trim(), argLine()];
				arg = '';
			} else arg += ch;
			i += 1;
		}
		if (arg.trim()) yield [arg.trim(), argLine()];
	}
}

/**
 * Every `proxyRequest(c, { … })` config in edge-router, keyed by its baseUrl
 * env var, with whether EVERY config for that base opts into userId injection.
 */
export function edgeProxyConfigs(src) {
	const out = new Map();
	const re = /proxyRequest\(\s*c\s*,\s*\{/g;
	let m;
	while ((m = re.exec(src))) {
		let depth = 1;
		let i = m.index + m[0].length;
		while (i < src.length && depth > 0) {
			if (src[i] === '{') depth += 1;
			else if (src[i] === '}') depth -= 1;
			i += 1;
		}
		const block = src.slice(m.index, i);
		const base = block.match(/baseUrl:\s*c\.env\.([A-Z0-9_]+)/)?.[1];
		// AND across every config for one base, never last-wins: a worker mounted
		// on two routes is only safe if BOTH stamp the header, and a `Map.set`
		// let the second route's `injectUserId: true` hide the first's absence.
		if (base) out.set(base, (out.get(base) ?? true) && /injectUserId:\s*true/.test(block));
	}
	return out;
}
