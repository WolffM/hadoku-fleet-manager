/**
 * G1, G2, G3, G4, G5, G6 and G8 — the identity-model gate's per-file and
 * per-repo rule checks (split of scripts/lib/identity-rules.mjs, wave 5q
 * lane C, pure move). G7 (resolver binding) is its own module,
 * identity-resolver.mjs, because its machinery — following a re-export a
 * few hops deep — shares nothing with the regex-shaped rules here; the
 * owner/edge constants G1 and G6 read (`OWNER_MODULE`, `EDGE_MOUNTS`,
 * `READS_USER_ID`, `EDGE_INDEX`) live in identity-constants.mjs, next to
 * the rest of that small, domain-blind data. `scanRepo` (identity-rules.mjs)
 * calls every export here once per file (or, for G2 and G6, once per repo)
 * during its one walk.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { blankComments } from './blank-comments.mjs';
import { EDGE_MOUNTS, READS_USER_ID, EDGE_INDEX, OWNER_MODULE } from './identity-constants.mjs';
import {
	isTestFile,
	lineOf,
	destructures,
	bindArguments,
	reIdent,
	typeBlocks,
	createTableColumns,
	identName,
	SQL_IDENT,
	edgeProxyConfigs,
} from './identity-source-parse.mjs';

// ── G1 ───────────────────────────────────────────────────────────────────────
/**
 * The registry row's fingerprint. `retiredAt` is the giveaway: it exists on
 * nothing else in the ecosystem, so an interface carrying it IS a copy of the
 * registry record however it is named. That matters because the four copies
 * that existed were called `KeyRegistryRecord` twice and `KeyRow` twice, and a
 * name-based check would have missed half of them.
 *
 * Deliberately NOT anchored to a line start. It was, and a single-line
 * `interface X { …; retiredAt?: number }` walked straight past it — found by
 * mutation-testing this check rather than by it catching anything.
 */
const REGISTRY_ROW_FIELD = /(?:\bretiredAt|(['"])retiredAt\1)\??\s*:/;

// ── G2 ───────────────────────────────────────────────────────────────────────
/**
 * A column whose name says it holds a person AND ends in `_key`, i.e. holds
 * their CREDENTIAL. Credentials rotate; a rotation then orphans every row (R7).
 * `cache_key`, `idempotency_key`, `sort_key` and friends are not people and do
 * not match.
 */
const OWNERSHIP_PERSON =
	'friend|user|owner|account|player|member|grantee|winner|voter|viewer|author|creator|uploader|editor|sender|requester|reporter|assignee|holder|caller|actor|subscriber';
const OWNERSHIP_KEY_COLUMN = new RegExp(
	`\\b(?:${OWNERSHIP_PERSON})_[a-z_]*key\\b|\\b(?:${OWNERSHIP_PERSON})_key\\b`
);

// ── G3 ───────────────────────────────────────────────────────────────────────
/**
 * Expressions that produce a REQUEST BODY — untrusted, unresolved input.
 *
 * ONE pattern, used by every G3 rule. The seed, the reassignment and the
 * destructure rule each carried their own copy, and they had drifted:
 * `c.req.valid('json')` was in two of the three. A form body is the same claim
 * in a different encoding, so `parseBody`/`formData`/`valid('form')` are here.
 */
const BODY_SOURCE =
	/\bc\.req\.(?:json|parseBody|formData|valid\s*\(\s*['"](?:json|form)['"]\s*\))|\breq(?:uest)?\.(?:json|formData)\s*\(/;

/**
 * Fields that are ALREADY-RESOLVED owners. There is no way to re-resolve one,
 * so reading one off a request body is always wrong — it is a claim wearing the
 * costume of an answer. `{"userId": "hadoku"}` is the whole incident.
 *
 * ONE list, shared by G3 (read off a body) and G4 (a display-name literal). G4
 * kept its own copy without `owner`/`ownerId`, so `ownerId: 'hadoku'` passed.
 */
const OWNER_FIELDS = [
	'userId',
	'user_id',
	'ownerUserId',
	'owner_user_id',
	'granteeUserId',
	'grantee_user_id',
	'owner',
	'ownerId',
];
const RESOLVED_OWNER_FIELD = new RegExp(`^(?:${OWNER_FIELDS.join('|')})$`);

/**
 * Fields that are CREDENTIALS. Legal in a body — a server-to-server ingest
 * genuinely holds one — but only on its way into a resolver, never into storage.
 */
const CREDENTIAL_FIELD =
	/^(?:friendKey|friend_key|winnerFriendKey|winner_friend_key|userKey|user_key|apiKey|api_key)$/;

// ── G8 ───────────────────────────────────────────────────────────────────────
/**
 * Expressions that produce a CREDENTIAL — the raw key a caller presents, or the
 * session cookie it is resolved from. Reading one is legal (a worker may need to
 * forward it); letting it reach storage as an owner is R7, and detaches every
 * row it keys the next time rotation runs.
 *
 * G2 covers the case where the COLUMN is named for a credential. This covers the
 * one that actually happened twice: a column correctly named `user_id`, holding a
 * credential. A credential is a v4 UUID exactly like a userId, so no shape check
 * can tell them apart after the fact — the only decidable moment is the read.
 *
 * The SESSION COOKIE is deliberately absent. Only edge-router reads it, and
 * edge-router is a custodian below — so adding the cookie names would match
 * nothing outside the exemption while baking two ecosystem-specific literals
 * into a published package (`ecosystem-literals` rightly rejected them).
 */
const CREDENTIAL_SOURCE =
	/(?:\.header\s*\(\s*['"`]x-user-key['"`]|\.headers\.get\s*\(\s*['"`]x-user-key['"`]|\bX_USER_KEY\b|\?\?\.credential\b|\.credential\b)/i;

/**
 * Code that HOLDS credentials as its job, where a credential in storage is the
 * design rather than the bug:
 *
 *   - edge-router's registry — the KV key IS `key:{rawKey}`; that is the lookup.
 *   - mgmt-api's key lifecycle/rotation — mints, stores and retires key material.
 *   - the admin scripts that drive those.
 *
 * Narrower than IDENTITY_BOUNDARY (which G5 uses) because the boundary is about
 * STAMPING identity, and this is about STORING credentials — a different set of
 * files, and stating it separately is what keeps either from widening the other.
 */
const CREDENTIAL_CUSTODIANS = [
	'workers/edge-router/src/registry.ts',
	// The session store maps `session:{sessionId}` -> the raw key. That IS the
	// cookie mechanism: the browser holds an opaque session id, the edge trades it
	// for the credential and resolves the registry row. It is a credential store
	// on purpose, and it is not ownership of anything — no user row keys on it.
	'workers/edge-router/src/session.ts',
	'services/mgmt-api/src/lib/key-lifecycle.ts',
	'services/mgmt-api/src/lib/key-rotation.ts',
	'services/mgmt-api/src/lib/rotation-shards.ts',
	'services/mgmt-api/src/lib/devvault-keys.ts',
	'services/mgmt-api/src/lib/github-secrets.ts',
	'scripts/admin/',
];

/**
 * An ownership sink: a name that means "this is who owns — or made — the row".
 *
 * The `_by` / `By` family is here because provenance columns are the commonest
 * landing site for a credential that nobody thought of as ownership:
 * contact-ui writes `created_by`, `changed_by`, `blocked_by` and
 * `whitelisted_by`, all four fed from the caller's raw key, and its migrations
 * describe them as "Admin key or identifier". They are only reported when the
 * value is credential-TAINTED, so an honest `created_by: 'system'` is untouched.
 */
const OWNERSHIP_SINK = new RegExp(
	'\\b(?:userId|user_id|ownerUserId|owner_user_id|granteeUserId|grantee_user_id|ownerId' +
		'|(?:created|changed|updated|blocked|whitelisted|owned|uploaded|authored|revoked|approved)_by' +
		'|(?:created|changed|updated|blocked|whitelisted|owned|uploaded|authored|revoked|approved)By' +
		')\\b\\s*[:=]\\s*'
);

/**
 * A destructure that pulls a CREDENTIAL out of whatever holds it:
 * `const { credential } = c.get('authContext')`. The holder is not itself a
 * credential source (an auth context, a session record), so CREDENTIAL_SOURCE
 * never matched it and the file was skipped before any rule ran.
 */
const DESTRUCTURED_CREDENTIAL = /(?:const|let|var)\s*\{[^}]*\bcredential\b[^}]*\}\s*=/;

export function checkG8(rel, src, add) {
	if (CREDENTIAL_CUSTODIANS.some((c) => rel.startsWith(c) || rel.includes('/' + c))) return;
	if (!CREDENTIAL_SOURCE.test(src) && !DESTRUCTURED_CREDENTIAL.test(src)) return;

	// Identifiers holding a credential, each remembered WITH THE LINE IT WAS READ
	// ON. Same taint approach as G3, but the report is anchored at the read rather
	// than at the write, for two reasons: the read is the decidable moment (after
	// assignment a credential and a userId are both just v4 UUIDs), and the name a
	// credential gets laundered into is often `userId` itself — anchoring at the
	// write then matches every innocent `.bind(userId)` elsewhere in the file and
	// buries the one line that is wrong. Reported once per name.
	const tainted = new Map();
	const seed = new RegExp(
		`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]*)?=\\s*(?:await\\s+)?[^;\\n]*?${CREDENTIAL_SOURCE.source}`,
		'gi'
	);
	let m;
	while ((m = seed.exec(src))) if (!tainted.has(m[1])) tainted.set(m[1], lineOf(src, m.index));
	const reassign = new RegExp(
		`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?[^;\\n]*?${CREDENTIAL_SOURCE.source}`,
		'gi'
	);
	while ((m = reassign.exec(src))) if (!tainted.has(m[1])) tainted.set(m[1], lineOf(src, m.index));
	// Destructured: the `credential` field out of whatever holds it, or anything
	// at all out of a credential source.
	for (const d of destructures(src)) {
		const fromSource = CREDENTIAL_SOURCE.test(d.rhs);
		for (const { field, binding } of d.pairs) {
			if (!binding || tainted.has(binding)) continue;
			if (fromSource || field === 'credential') {
				tainted.set(binding, lineOf(src, d.index));
			}
		}
	}

	// (a) The credential read INLINE into an ownership sink, no name in between:
	// `const userId = c.req.header('X-User-Key')`. Already an owner at the read.
	const inline = new RegExp(`${OWNERSHIP_SINK.source}[^;\\n]*?${CREDENTIAL_SOURCE.source}`, 'gi');
	const reported = new Set();
	while ((m = inline.exec(src))) {
		const name =
			/\b(userId|user_id|ownerUserId|owner_user_id|granteeUserId|grantee_user_id|ownerId)\b/.exec(
				m[0]
			)?.[1];
		if (name) reported.add(name);
		add(
			'G8',
			rel,
			lineOf(src, m.index),
			'a credential is assigned to an ownership identifier — rotation will detach every row'
		);
	}

	for (const [name, seedLine] of tainted) {
		if (reported.has(name)) continue;
		// (b) assigned into an ownership sink, or (c) written to storage directly —
		// `.bind(name)`, `.put(name)`, or interpolated into a storage key.
		const sink = new RegExp(`${OWNERSHIP_SINK.source}\\s*${name}\\b`);
		// Only a STORAGE CALL counts. An earlier cut also treated any `${name}`
		// interpolation as a write, which reported `logger.warn(`… ${key.slice(0, 8)}…`)`
		// in mgmt-api's secrets-auth — a MASKED CREDENTIAL IN A LOG LINE, which is
		// the one place masking is correct and the opposite of storage. The scope is
		// the statement (`[^;\n]*?`) rather than the argument list, because the
		// masked-key case nests a call: `.put(`prefs:${raw.slice(0, 8)}`)`.
		// `set` is NOT in this list. It was, and it matched Hono's
		// `c.set('authContext', …)` — a request-scoped context write, not storage —
		// which reported contact-ui for the right violation by the wrong reasoning.
		// A rule that is accidentally right is a rule nobody can maintain.
		const store = new RegExp(`\\.(?:bind|put|prepare|insert|upsert)\\s*\\([^;\\n]*?\\b${name}\\b`);
		if (!sink.test(src) && !store.test(src)) continue;
		add(
			'G8',
			rel,
			seedLine,
			`\`${name}\` is read from a credential here and later reaches storage as an owner`
		);
		reported.add(name);
	}
}

// ── G4 ───────────────────────────────────────────────────────────────────────
/**
 * `userId: 'x'`, `userId = "x"`, `'owner_user_id': 'x'` — an identity LITERAL.
 * A QUOTED key is the same claim (a JSON-shaped fixture writes them all that
 * way), and the field list is G3's — `ownerId` was missing — LESS bare `owner`.
 *
 * `owner` is the one name G3 can afford and G4 cannot. G3 only reads it off a
 * request BODY, where it is a claim. G4 reads every literal in the fleet, and
 * there `owner` is mostly something else: a GitHub repo owner
 * (`owner: 'apache'`), a seat side (`owner: 'them'`), a git remote
 * (`let owner = "local"`). Measured 2026-10-10: 63 findings fleet-wide, none an
 * identity. A rule that reports that is a rule people stop reading.
 */
const G4_FIELDS = OWNER_FIELDS.filter((f) => f !== 'owner').join('|');
const USERID_LITERAL = new RegExp(
	`(?:\\b(?:${G4_FIELDS})\\b|(['"])(?:${G4_FIELDS})\\1)\\s*[:=]\\s*['"\`]([^'"\`]*)['"\`]`,
	'g'
);

/**
 * A DISPLAY NAME wearing a userId's clothes: a bare lowercase word, no
 * separator, long enough not to be a test stub like `u1`.
 *
 * The separator is what does the work. Real fixtures read `contrib-uid`,
 * `u-a`, `owner_2` — all obviously synthetic. `hadoku`, `anon`, `public`,
 * `unknown` do not, and every one of those is either the incident itself or an
 * R8 in-band sentinel.
 */
const DISPLAY_NAME_SHAPED = /^[a-z][a-z]{3,}$/;

// ── G5 ───────────────────────────────────────────────────────────────────────
/**
 * SETTING an edge-stamped header, in any of the four syntaxes below. Reading one
 * (`c.req.header('X-User-Id')`) is how every worker learns who is calling and
 * is not matched.
 *
 * `X-User-Name` joined the class on 2026-09-24 — the display half of the
 * identity stamp, injected beside X-User-Id from the same registry record. Same
 * trust perimeter, so same rule: only edge-router stamps it, and a client-
 * supplied copy is stripped before injection. A consumer may READ it freely; it
 * is the assertion "this request's caller is <name>" that must stay edge-only.
 */
/*
 * FOUR syntaxes, mutation-tested 2026-10-10 (#98) — the last two walked past:
 *   headers.set('X-User-Id', v)        a method call
 *   { 'X-User-Id': v }                 an object literal
 *   new Headers([['X-User-Id', v]])    a tuple — the second element must not be
 *                                      another header NAME, so a strip-list like
 *                                      ['X-User-Id', 'X-Hadoku-Tier'] is not one
 *   h['X-User-Id'] = v                 a bracket assignment (not `==`), and
 *                                      its logical forms `??=`, `||=`, `&&=` —
 *                                      `headers['x-user-id'] ??= 'local-dev'`
 *                                      stamped a user in two game servers
 *                                      unseen until 2026-10-11
 */
const STAMPED = 'X-User-Id|X-User-Name|X-Hadoku-Tier';
const SELF_STAMP = new RegExp(
	[
		`\\.(?:set|append)\\s*\\(\\s*['"\`](${STAMPED})['"\`]`,
		`['"\`](${STAMPED})['"\`]\\s*:`,
		`\\[\\s*['"\`](${STAMPED})['"\`]\\s*,\\s*(?!['"\`]X-)[^\\]\\s]`,
		`\\[\\s*['"\`](${STAMPED})['"\`]\\s*\\]\\s*(?:\\?\\?|\\|\\||&&)?=(?!=)`,
	].join('|'),
	'i'
);
const SELF_STAMP_ALL = new RegExp(SELF_STAMP.source, 'gi');

/*
 * A DOWNGRADE is not a stamp (#109). Writing the literal `public` into
 * X-Hadoku-Tier asserts the floor every unauthenticated caller already has, so
 * it cannot impersonate anyone and cannot raise a privilege — whichever request
 * it lands on. It is how an inbound sanitizer enforces R1: the three
 * `sanitizeHeaders` templates degrade a request whose X-Edge-Auth provenance is
 * unproven to public and delete x-user-id, and 0.30.5 read that as a self-stamp.
 *
 * Narrow on purpose: only the tier, only the literal. A computed value
 * (`= CONFIG.devTier`, `= tier`) can be anything and still fails, and so does
 * X-User-Id/X-User-Name with ANY value — there is no "floor" user. Read from the
 * text after the header NAME, so it covers all four syntaxes above:
 *   .set('X-Hadoku-Tier', 'public')   { 'X-Hadoku-Tier': 'public' }
 *   [['X-Hadoku-Tier', 'public']]     h['X-Hadoku-Tier'] = 'public'
 */
const STAMP_NAME = new RegExp(`['"\`](?:${STAMPED})['"\`]`, 'i');
const PUBLIC_DOWNGRADE = /^\s*(?:\]\s*=|:|,)\s*['"`]public['"`]/i;

/** The tier header, from STAMPED rather than spelled out again. */
const TIER_HEADER = STAMPED.split('|')
	.find((h) => /tier/i.test(h))
	.toLowerCase();

function isDowngrade(line, m) {
	if ((m.slice(1).find(Boolean) ?? '').toLowerCase() !== TIER_HEADER) return false;
	const from = line.slice(m.index);
	const name = from.match(STAMP_NAME);
	return name !== null && PUBLIC_DOWNGRADE.test(from.slice(name.index + name[0].length));
}

export function checkG1(rel, src, add) {
	if (rel === OWNER_MODULE) return;
	for (const block of typeBlocks(src)) {
		if (!REGISTRY_ROW_FIELD.test(block.body)) continue;
		add('G1', rel, block.line, `${block.name} re-declares the key-registry row`);
	}
}

/**
 * G2 over a whole migrations DIRECTORY, in order.
 *
 * A migration set is APPEND-ONLY: the statement that first created
 * `friend_key` stays in the tree forever, and a later migration renaming it
 * away is the only fix available. Judging each file in isolation therefore
 * makes the violation permanent and the gate unfixable — the failure mode that
 * teaches people to add an allowlist entry instead of fixing anything.
 *
 * So this replays the directory and reports what the schema HOLDS at the end.
 */
export function checkG2Dir(files, add) {
	/** column name -> {file, line} where it currently comes from */
	const live = new Map();
	const at = (rel, sql, index) => ({ rel, line: lineOf(sql, index) });
	for (const { rel, sql } of files) {
		const stripped = sql
			.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
			.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

		const { columns, blind } = createTableColumns(stripped);
		for (const c of columns) live.set(c.name, at(rel, sql, c.index));
		for (const b of blind) {
			add(
				'G2',
				rel,
				lineOf(sql, b.index),
				`CREATE TABLE ${b.table} parsed to ZERO columns — this schema is invisible to G2`
			);
		}
		// `ADD COLUMN x` anywhere, and the bare `ADD x` SQLite and Postgres both
		// accept — but the bare form only inside an ALTER TABLE statement, since an
		// embedded schema is scanned RAW and `add` is an English word in code.
		const ADD_COL = new RegExp(
			`\\bADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${SQL_IDENT}`,
			'gi'
		);
		for (const m of stripped.matchAll(ADD_COL)) live.set(identName(m, 1), at(rel, sql, m.index));
		const BARE_ADD = new RegExp(
			`\\bADD\\s+(?!COLUMN\\b|CONSTRAINT\\b|PRIMARY\\b|UNIQUE\\b|FOREIGN\\b|CHECK\\b|INDEX\\b|KEY\\b)${SQL_IDENT}`,
			'gi'
		);
		for (const stmt of stripped.matchAll(/\bALTER\s+TABLE\b[^;]*/gi)) {
			for (const m of stmt[0].matchAll(BARE_ADD)) {
				live.set(identName(m, 1), at(rel, sql, stmt.index + m.index));
			}
		}
		for (const m of stripped.matchAll(
			new RegExp(`\\bRENAME\\s+(?:COLUMN\\s+)?(?!TO\\b)${SQL_IDENT}\\s+TO\\s+${SQL_IDENT}`, 'gi')
		)) {
			live.delete(identName(m, 1));
			live.set(identName(m, 5), at(rel, sql, m.index));
		}
		for (const m of stripped.matchAll(
			new RegExp(`\\bDROP\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?${SQL_IDENT}`, 'gi')
		)) {
			live.delete(identName(m, 1));
		}
	}
	for (const [col, where] of live) {
		if (!OWNERSHIP_KEY_COLUMN.test(col)) continue;
		add('G2', where.rel, where.line, `column \`${col}\` holds a credential`);
	}
}

export function checkG3(rel, src, add) {
	if (!BODY_SOURCE.test(src)) return;
	const BODY = BODY_SOURCE.source;

	// Identifiers holding a request body, and identifiers derived from one.
	const tainted = new Set();
	const seed = new RegExp(
		`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]*)?=\\s*(?:await\\s+)?[^;\\n]*?(?:${BODY})`,
		'g'
	);
	let m;
	while ((m = seed.exec(src))) tainted.add(m[1]);
	// `payload = await c.req.json<T>()` — declared above, assigned in a try.
	const reassign = new RegExp(
		`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?[^;\\n]*?(?:${BODY})`,
		'g'
	);
	while ((m = reassign.exec(src))) tainted.add(m[1]);

	// To a fixpoint, because each step can feed the next:
	//   `const a = body` / `const a = body.data`   an alias of a tainted value
	//   `const { data } = body`                     a field destructured out of one
	//   `for (const p of payload.players)`          an element of a tainted collection
	// The alias step is new (#98): `const input = body; input.userId` read the
	// owner through a name the seed never saw.
	const destructs = [...destructures(src)];
	for (let grew = true; grew;) {
		const before = tainted.size;
		for (const name of [...tainted]) {
			const alias = new RegExp(
				`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]*)?=\\s*${reIdent(name)}\\b(?:\\??\\.[A-Za-z_$][\\w$]*)*\\s*(?:as\\b[^;\\n]*)?(?:;|\\n|$)`,
				'g'
			);
			while ((m = alias.exec(src))) tainted.add(m[1]);
			const iter = new RegExp(
				`for\\s*\\(\\s*(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+${reIdent(name)}\\b`,
				'g'
			);
			while ((m = iter.exec(src))) tainted.add(m[1]);
		}
		for (const d of destructs) {
			const from = /^([A-Za-z_$][\w$]*)\b(?:\??\.[A-Za-z_$][\w$]*)*\s*;?\s*$/.exec(d.rhs.trim());
			if (!(from && tainted.has(from[1])) && !new RegExp(BODY).test(d.rhs)) continue;
			for (const { field, binding } of d.pairs) {
				if (binding && !RESOLVED_OWNER_FIELD.test(field)) tainted.add(binding);
			}
		}
		grew = tainted.size > before;
	}

	// Destructured out of a body — `const { userId } = c.req.valid('json')` — or
	// out of anything holding one: `const { userId } = body`. BEFORE the early
	// return below, which it used to sit after: a file whose only read was a
	// direct destructure had no tainted NAME, returned first, and this rule never
	// ran (mutation-tested 2026-10-10, #98).
	for (const d of destructs) {
		const from = /^([A-Za-z_$][\w$]*)\b(?:\??\.[A-Za-z_$][\w$]*)*\s*;?\s*$/.exec(d.rhs.trim());
		if (!(from && tainted.has(from[1])) && !new RegExp(BODY).test(d.rhs)) continue;
		for (const { field } of d.pairs) {
			if (!RESOLVED_OWNER_FIELD.test(field)) continue;
			add(
				'G3',
				rel,
				lineOf(src, d.index),
				`\`${field}\` is an owner destructured out of the request body`
			);
		}
	}
	if (!tainted.size) return;

	// (a) An already-resolved owner read off the body. Never legal.
	for (const name of tainted) {
		// `?.` COUNTS. `body.userId` and `body?.userId` are the same read of the
		// same untrusted field, but the pattern anchored on a literal dot matched
		// only the first — so optional chaining silently exempted a call site from
		// the rule. Found 2026-09-03 in hadoku-jobplatform, which had all three
		// forms of one call: `body.owner` was flagged and `body?.owner`, four
		// hundred lines away in the same file, was not. Nothing about that is a
		// deliberate escape hatch; it is the rule failing to see, which reads as
		// coverage. `body['userId']` / `body?.['userId']` is the same read again,
		// and so is a FormData's `form.get('userId')`.
		const member = new RegExp(
			`(?<![\\w$])${reIdent(name)}(?:\\??\\.get\\(\\s*(['"\`])([A-Za-z_$][\\w$]*)\\1\\s*\\)|\\??\\.([A-Za-z_$][\\w$]*)|(?:\\?\\.)?\\[\\s*(['"\`])([A-Za-z_$][\\w$]*)\\4\\s*\\])`,
			'g'
		);
		while ((m = member.exec(src))) {
			const field = m[2] ?? m[3] ?? m[5];
			if (RESOLVED_OWNER_FIELD.test(field)) {
				add(
					'G3',
					rel,
					lineOf(src, m.index),
					`\`${name}.${field}\` is an owner taken from the request body`
				);
			}
		}
	}

	// (b) A credential may legally travel through a body — a server-to-server
	//     ingest genuinely holds one. What it may NOT do is reach a column. So
	//     the test is not "was it resolved somewhere" (unprovable across a file)
	//     but the property that actually matters: is the credential itself bound
	//     into a statement? `.bind(p.friendKey)` is the defect;
	//     `.bind(ownerOf(p.friendKey))` is the fix, and passing the credential to
	//     a lookup is exactly how the fix has to be written.
	const credentials = new Map();
	for (const name of tainted) {
		const member = new RegExp(
			// `?.` counts here too — see the note on rule (a)'s pattern.
			`\\b(?:(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*)?(?<![\\w$])${reIdent(name)}\\??\\.([A-Za-z_$][\\w$]*)`,
			'g'
		);
		while ((m = member.exec(src))) {
			if (!CREDENTIAL_FIELD.test(m[2])) continue;
			const alias = m[1] ?? `${name}.${m[2]}`;
			if (!credentials.has(alias)) credentials.set(alias, lineOf(src, m.index));
		}
	}
	for (const [expr, line] of bindArguments(src)) {
		const bare = expr.replace(/\s*(?:\?\?|\|\|)\s*null\s*$/, '').trim();
		if (credentials.has(bare)) {
			add('G3', rel, line, `credential \`${bare}\` is bound straight into a statement`);
		}
	}
}

/**
 * G6's input, taken from the walk `scanRepo` is already doing: the first line
 * in each `workers/<w>/src/**` file that READS `X-User-Id`, in walk order.
 *
 * This was a SECOND full traversal of `workers/`, re-reading and re-blanking
 * every file the main scan had just read and blanked. Its filters are a strict
 * subset of that loop's, so the two walks only ever saw the same files.
 *
 * edge-router is the identity boundary and `shared` is a library, so neither is
 * a consumer. Test files are excluded: a harness reading the header is how a
 * worker gets exercised at all, not a claim about how it is mounted.
 */
export function collectUserIdReader(rel, src, readers) {
	const m = /^workers\/([^/]+)\/src\//.exec(rel);
	if (!m) return;
	const worker = m[1];
	if (worker === 'edge-router' || worker === 'shared') return;
	if (readers.has(worker)) return; // first hit wins, exactly as the walk broke
	if (isTestFile(rel)) return;
	const line = src.split('\n').findIndex((l) => READS_USER_ID.test(l));
	if (line >= 0) readers.set(worker, { rel, line: line + 1 });
}

export function checkG6(root, readers, add) {
	const indexPath = resolve(root, EDGE_INDEX);
	if (!existsSync(indexPath)) return; // sibling repo; nothing to check
	const configs = edgeProxyConfigs(blankComments(readFileSync(indexPath, 'utf8')));

	for (const [worker, reads] of readers) {
		const base = EDGE_MOUNTS[worker];
		if (!base) {
			add('G6', reads.rel, reads.line, `${worker} reads X-User-Id but has no EDGE_MOUNTS entry`);
			continue;
		}
		if (!configs.has(base)) {
			add('G6', EDGE_INDEX, 1, `${worker}: no proxyRequest config uses c.env.${base}`);
			continue;
		}
		if (!configs.get(base)) {
			add('G6', EDGE_INDEX, 1, `${worker} reads X-User-Id but c.env.${base} lacks injectUserId`);
		}
	}
}

export function checkG4(rel, src, add) {
	let m;
	USERID_LITERAL.lastIndex = 0;
	while ((m = USERID_LITERAL.exec(src))) {
		if (!DISPLAY_NAME_SHAPED.test(m[2])) continue;
		add('G4', rel, lineOf(src, m.index), `\`${m[2]}\` is a display name, not a userId`);
	}
}

export function checkG5(rel, src, add) {
	for (const [i, line] of src.split('\n').entries()) {
		// Every match on the line, not the first: `{ 'X-Hadoku-Tier': 'public',
		// 'X-User-Id': uid }` downgrades the tier AND stamps a user.
		const stamp = [...line.matchAll(SELF_STAMP_ALL)].find((m) => !isDowngrade(line, m));
		if (stamp) add('G5', rel, i + 1, `sets ${stamp.slice(1).find(Boolean)} on a request`);
	}
}
