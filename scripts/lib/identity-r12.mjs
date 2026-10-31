/**
 * G9 — R12: a person's data lives in prefs-api (fleet-manager#39).
 *
 * hadoku_site's IDENTITY_MODEL R12: a record that belongs to ONE person is a
 * prefs-api row; state SHARED by several people stays in its app and names a
 * person by their opaque userId only — no display name, no avatar or sprite
 * copy, nothing derived from a credential. The reason is deletion: an account
 * delete erases a person in one place (prefs-api `_account/erase`), and a
 * per-app copy is one it cannot see.
 *
 * Three checks, each statically decidable:
 *
 *   G9a · no per-person store    a table whose PRIMARY KEY includes ONE userId
 *                                column (two is a relationship, shared), or a
 *                                file written to a path built from a userId
 *   G9b · no names beside a userId  a persisted record holding a userId AND a
 *                                display name / sprite / avatar copy
 *   G9c · no credential-derived ids  a credential (friend key, X-User-Key)
 *                                fed to a hash, digest or id deriver
 *
 * A SCHEMA IS JUDGED BY WHAT IT HOLDS AT THE END, like G2: a migration set is
 * append-only, so the table that broke the rule stays in the tree after a
 * later migration drops or renames it away. Tables are replayed per directory
 * (CREATE, ALTER … RENAME TO, RENAME COLUMN, ADD, DROP COLUMN, DROP TABLE) and
 * only the surviving shape is reported.
 *
 * WHAT IT CANNOT SEE: a record whose name field is set in one module and
 * persisted from another through a typed state object (cardtable's room
 * members, hadoku-cardtable#25 item 3). File-store G9b only follows a literal
 * written in the same file, directly or through one `const` binding.
 *
 * CUSTODIANS: prefs-api (where a person's data belongs) and edge-router (the
 * key registry: where a person IS, erased by the same account delete). Only in
 * hadoku_site — a sibling repo with a directory of the same name is not one.
 */
import {
	lineOf,
	SQL_IDENT,
	SQL_IDENT_ANY,
	identName,
	splitTopLevel,
	matchingParen,
} from './identity-source-parse.mjs';

const CUSTODIANS = ['workers/prefs-api/', 'workers/edge-router/'];

/** Is `rel` (repo-relative, hadoku_site when `label` is null) an R12 custodian? */
export function isR12Custodian(label, rel) {
	return label === null && CUSTODIANS.some((c) => rel.startsWith(c));
}

/** A SQL column holding a person's userId: `user_id`, `owner_user_id`, `voter_user_id`, `userid`. */
const PERSON_COLUMN = /^(?:[a-z0-9]+_)*user_?id$/i;
/**
 * A copy of a person's display identity. `name` alone is NOT here: a board, a
 * deck and a form all have a name and a user_id (task-api's `boards`, keyed
 * `(user_id, id)`). It counts only in a row whose WHOLE key is the person (see
 * `personNameColumn`), where it can only be theirs.
 */
const PERSON_NAME_COLUMN =
	/^(?:display_?name|user_?name|nick_?name|player_?name|(?:[a-z0-9]+_)?sprite|avatar[a-z0-9_]*)$/i;

function personNameColumn(col, rowIsThePerson) {
	return PERSON_NAME_COLUMN.test(col) || (rowIsThePerson && col === 'name');
}

const strip = (sql) =>
	sql
		.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const bare = (raw) => {
	const last = raw.split('.').pop() ?? raw;
	return last.replace(/^["`[]|["`\]]$/g, '').toLowerCase();
};

const COL_ID = new RegExp(`^${SQL_IDENT}`);
const PK_LIST = /PRIMARY\s+KEY\s*\(([^)]*)\)/i;

/** One CREATE TABLE's columns and primary key, from its body. */
function parseBody(body) {
	const columns = [];
	const pk = new Set();
	for (const part of splitTopLevel(body)) {
		const text = part.text.trim();
		if (!text) continue;
		const tablePk = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\b/i.test(text)
			? PK_LIST.exec(text)
			: null;
		if (tablePk) {
			for (const c of tablePk[1].split(',')) pk.add(bare(c.trim().split(/\s+/)[0]));
			continue;
		}
		if (/^(?:CONSTRAINT|FOREIGN|UNIQUE|CHECK|KEY|INDEX|EXCLUDE|FULLTEXT)\b/i.test(text)) continue;
		const id = COL_ID.exec(text);
		if (!id) continue;
		const name = identName(id, 1);
		columns.push(name);
		if (/\bPRIMARY\s+KEY\b/i.test(text)) pk.add(name);
	}
	return { columns, pk };
}

/**
 * Every schema event in `sql`, in order, as `{at, apply(tables)}`. One regex
 * per statement shape; the caller sorts them by offset and replays.
 */
function events(sql, rel) {
	const out = [];
	const T = `((?:${SQL_IDENT_ANY}\\.)?${SQL_IDENT_ANY})`;
	const C = SQL_IDENT;
	const create = new RegExp(
		`\\bCREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${T}\\s*\\(`,
		'gi'
	);
	for (const m of sql.matchAll(create)) {
		const open = m.index + m[0].length - 1;
		const close = matchingParen(sql, open);
		const { columns, pk } = parseBody(close < 0 ? sql.slice(open + 1) : sql.slice(open + 1, close));
		const table = bare(m[1]);
		const line = lineOf(sql, m.index);
		out.push({
			at: m.index,
			apply: (tables) => {
				// IF NOT EXISTS on a table already modelled changes nothing.
				if (/IF\s+NOT\s+EXISTS/i.test(m[0]) && tables.has(table)) return;
				tables.set(table, { columns: new Set(columns), pk, rel, line, table });
			},
		});
	}
	const renameTable = new RegExp(`\\bALTER\\s+TABLE\\s+${T}\\s+RENAME\\s+TO\\s+${T}`, 'gi');
	for (const m of sql.matchAll(renameTable)) {
		const [from, to] = [bare(m[1]), bare(m[2])];
		out.push({
			at: m.index,
			apply: (tables) => {
				const t = tables.get(from);
				if (!t) return;
				tables.delete(from);
				tables.set(to, { ...t, table: to });
			},
		});
	}
	const renameCol = new RegExp(
		`\\bALTER\\s+TABLE\\s+${T}\\s+RENAME\\s+(?:COLUMN\\s+)?(?!TO\\b)${C}\\s+TO\\s+${C}`,
		'gi'
	);
	for (const m of sql.matchAll(renameCol)) {
		const table = bare(m[1]);
		const [from, to] = [identName(m, 2), identName(m, 6)];
		out.push({
			at: m.index,
			apply: (tables) => {
				const t = tables.get(table);
				if (!t || !t.columns.has(from)) return;
				t.columns.delete(from);
				t.columns.add(to);
				if (t.pk.has(from)) {
					t.pk.delete(from);
					t.pk.add(to);
				}
			},
		});
	}
	const addCol = new RegExp(
		`\\bALTER\\s+TABLE\\s+${T}\\s+ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?!CONSTRAINT\\b|PRIMARY\\b|UNIQUE\\b|FOREIGN\\b|CHECK\\b)${C}`,
		'gi'
	);
	for (const m of sql.matchAll(addCol)) {
		const [table, col] = [bare(m[1]), identName(m, 2)];
		out.push({ at: m.index, apply: (tables) => tables.get(table)?.columns.add(col) });
	}
	const dropCol = new RegExp(
		`\\bALTER\\s+TABLE\\s+${T}\\s+DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?${C}`,
		'gi'
	);
	for (const m of sql.matchAll(dropCol)) {
		const [table, col] = [bare(m[1]), identName(m, 2)];
		out.push({
			at: m.index,
			apply: (tables) => {
				const t = tables.get(table);
				t?.columns.delete(col);
				t?.pk.delete(col);
			},
		});
	}
	const dropTable = new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${T}`, 'gi');
	for (const m of sql.matchAll(dropTable)) {
		const table = bare(m[1]);
		out.push({ at: m.index, apply: (tables) => tables.delete(table) });
	}
	return out.sort((a, b) => a.at - b.at);
}

/**
 * G9a + G9b over a group of schema sources (`[{rel, sql}]`, replayed in
 * order) — a migrations directory, or one file with an embedded schema.
 */
export function checkG9Schemas(files, label, add) {
	const tables = new Map();
	for (const { rel, sql } of files) {
		for (const e of events(strip(sql), rel)) e.apply(tables);
	}
	for (const t of tables.values()) {
		if (isR12Custodian(label, t.rel)) continue;
		const people = [...t.columns].filter((c) => PERSON_COLUMN.test(c));
		if (!people.length) continue;
		const keyedBy = [...t.pk].filter((c) => PERSON_COLUMN.test(c));
		// TWO people in the key is a relationship between them (a share, a
		// grant): shared state, which R12 keeps in the app by userId.
		if (keyedBy.length === 1) {
			add(
				'G9a',
				t.rel,
				t.line,
				`table \`${t.table}\` is keyed per person (PRIMARY KEY includes \`${keyedBy.join('`, `')}\`) — a person's data lives in prefs-api (R12)`
			);
		}
		for (const col of t.columns) {
			if (!personNameColumn(col, t.pk.size > 0 && keyedBy.length === t.pk.size)) continue;
			add(
				'G9b',
				t.rel,
				t.line,
				`table \`${t.table}\` stores \`${col}\` beside \`${people[0]}\` — name a person by userId only and look the rest up when shown (R12)`
			);
		}
	}
}

// ── code: file stores and derived ids ──────────────────────────────────────

const WRITE_CALL =
	/\b(?:appendFile|appendFileSync|writeFile|writeFileSync|writeFileAtomic|atomicWriteJson|writeJson|writeJsonSync|outputJson|outputJsonSync)\s*\(/g;
const PERSON_KEY = /(?:^|[{,\s(])(?:userId|user_id|ownerUserId|owner_user_id)\s*(?=[:,}])/;
const PERSON_REF = /\b(?:userId|user_id|ownerUserId|owner_user_id)\b/;
const NAME_KEY =
	/(?:^|[{,\s(])(?:name|displayName|display_name|userName|username|nickname|playerName|sprite|avatar\w*)\s*(?=[:,}])/;

/** The argument text of the call whose `(` is at `open`, split at top level. */
function callArgs(src, open) {
	const close = matchingParen(src, open);
	const body = close < 0 ? src.slice(open + 1) : src.slice(open + 1, close);
	return splitTopLevel(body).map((p) => p.text);
}

/** The `{…}` literal bound to `name` in `src` (`const name = {`, `name: T = {`), or null. */
function literalBoundTo(src, name) {
	const m = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b\\s*(?::[^=;]+)?=\\s*\\{`).exec(src);
	if (!m) return null;
	const open = m.index + m[0].length - 1;
	let depth = 0;
	for (let i = open; i < src.length; i += 1) {
		if (src[i] === '{') depth += 1;
		else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
	}
	return null;
}

const holdsPersonAndName = (text) => PERSON_KEY.test(text) && NAME_KEY.test(text);

/**
 * G9a/G9b over one code file's FILE writes. `src` has comments blanked.
 *
 * G9a: the PATH argument is built from a userId — one file per person.
 * G9b: the payload is (or stringifies a `const` bound to) a literal holding a
 * userId and a name/sprite/avatar.
 */
export function checkG9Files(rel, src, label, add) {
	if (isR12Custodian(label, rel)) return;
	for (const m of src.matchAll(WRITE_CALL)) {
		const args = callArgs(src, m.index + m[0].length - 1);
		const line = lineOf(src, m.index);
		if (args[0] && PERSON_REF.test(args[0])) {
			add(
				'G9a',
				rel,
				line,
				`a file store keyed by userId — a person's data lives in prefs-api (R12)`
			);
		}
		const payload = args.slice(1).join(',');
		let hit = holdsPersonAndName(payload);
		if (!hit) {
			for (const ref of payload.matchAll(
				/\bJSON\.stringify\(\s*([A-Za-z_$][\w$]*)|^\s*([A-Za-z_$][\w$]*)\s*$/g
			)) {
				const lit = literalBoundTo(src, ref[1] ?? ref[2]);
				if (lit && holdsPersonAndName(lit)) hit = true;
			}
		}
		if (hit) {
			add(
				'G9b',
				rel,
				line,
				'a persisted record stores a name/sprite/avatar beside a userId — name a person by userId only (R12)'
			);
		}
	}
}

/** A credential as code reads it: a friend/user key, or the header carrying one. */
const CRED_TOKEN = /\bfriend_?key\b|\buser_?key\b|['"`]x-user-key['"`]/i;
/** A call that turns its input into an identity: a hash, a digest, a deriver. */
const DERIVING_CALL =
	/\b(?:\w*(?:[Hh]ash|[Dd]igest|[Dd]erive)\w*|derive|digest)\s*\(|\.update\s*\(/g;

/**
 * G9c over one code file. `src` has comments blanked. A credential reaching a
 * hash, digest or deriver as an argument is an id derived from a key — it
 * detaches on rotation however it is masked (R7, hadoku-cardtable#2).
 */
export function checkG9Derived(rel, src, label, add) {
	if (isR12Custodian(label, rel)) return;
	for (const m of src.matchAll(DERIVING_CALL)) {
		// `.update(` only as a hash chain step, never `db.update(` or a setState.
		if (
			m[0].startsWith('.update') &&
			!/createHash\([^)]*\)\s*$/.test(src.slice(Math.max(0, m.index - 80), m.index))
		)
			continue;
		const args = callArgs(src, m.index + m[0].length - 1).join(',');
		if (!CRED_TOKEN.test(args)) continue;
		add(
			'G9c',
			rel,
			lineOf(src, m.index),
			'an identity is derived from a credential — key it by the registry userId; a hashed key still detaches on rotation (R7, R12)'
		);
	}
}
