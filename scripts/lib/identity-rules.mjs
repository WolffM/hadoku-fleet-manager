/**
 * The identity-model gate's RULES — G1..G8 (scripts/check-identity-model.mjs,
 * split #8 — pure move). See that file's own header for what each check
 * means; this module is where they are decided.
 *
 * Also holds the repo/file discovery the rules run over — `walk`,
 * `trackedFiles`, `checkoutFreshness`, `siblingRepos`, `scanRepo` — because
 * `scanRepo` ties the walk directly to the checks (G6/G7 reason about a whole
 * repo, not a file, and need the same traversal the per-file checks use), and
 * splitting the walk into its own module would make `scanRepo` import back
 * from whatever held it — the exact circular edge this split avoids by
 * keeping repo-shape and rule-shape together here, with only the generic,
 * domain-blind TEXT parsing in `identity-source-parse.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, sep, basename } from 'node:path';

import { allRepos } from './fleet-roster.mjs';
import { tryShipped } from './fleet-source.mjs';
import { blankComments } from './blank-comments.mjs';
import { siteRoot } from './paths.mjs';
import {
	isTestFile,
	lineOf,
	destructures,
	bindArguments,
	reIdent,
	IDENT,
	specifiers,
	resolveLocal,
	typeBlocks,
	createTableColumns,
	identName,
	SQL_IDENT,
	edgeProxyConfigs,
	stripTomlComments,
	topLevelBindings,
} from './identity-source-parse.mjs';

export const REPO_ROOT = siteRoot();

/**
 * THE SCAN IS A DENYLIST, not a list of roots — and that inversion is the fix
 * for a whole class of miss rather than for three repos.
 *
 * It used to name its roots: `workers, services, src, scripts, templates, e2e,
 * worker`. Four repos keep their code somewhere else — hadoku-watchparty and
 * hadoku-cardtable under `apps/server/src`, hadoku-contact-ui under `api/`,
 * hadoku-dataplatform under `server/` — so all four were walked as ZERO FILES
 * and reported clean while holding live credential-keyed ownership. Surveyed
 * 2026-09-24, the fleet's twenty app repos use at least nine different top-level
 * layouts (`backend`, `frontend`, `engine`, `crates`, `pygmalion`,
 * `hadoku_scrape`, `tunnel`, `builder`, `web`), so any inclusion list is a list
 * that rots — and it rots SILENTLY, which is the whole problem.
 *
 * Inverting it inverts the failure mode: a new layout is covered by default, and
 * the cost of getting the denylist wrong is noise, which is loud, rather than
 * blindness, which is not. Extension filtering does most of the work (only
 * code and schema extensions are ever read), so artifact directories full of
 * images or logs cost a readdir and nothing more.
 */
const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
const SQL_EXT = ['.sql'];

/**
 * Files searched for an EMBEDDED schema — a `CREATE TABLE` inside a string
 * literal rather than in a `.sql` file. G2 is the only check that runs on these.
 *
 * Two live schemas are written this way, and both were invisible: hadoku-
 * watchparty's `stats.sqlite` is a TypeScript template literal
 * (`apps/server/src/stats/db.ts`) and hadoku-dataplatform's catalog is a Python
 * string constant (`catalog/_migrations.py`). Between them they declared twelve
 * credential-keyed ownership columns that G2 — the check written BECAUSE of
 * `friend_key` — walked straight past.
 *
 * `.py` appears HERE and deliberately not in `CODE_EXT`: the other checks match
 * JS/TS shapes (`c.req.json()`, `const x =`, `.bind(`), so running them over
 * Python would report nothing useful and risk noise. Teaching G1/G3/G5/G8 a
 * Python dialect is separate work; a schema is a schema in any host language.
 */
const SCHEMA_CODE_EXT = ['.ts', '.tsx', '.js', '.mjs', '.py'];

/** Every extension any check reads. Anything else is never opened. */
const SCANNED_EXT = [...new Set([...CODE_EXT, ...SQL_EXT, ...SCHEMA_CODE_EXT])];

/** Cheap pre-test so only files that declare tables are parsed as schema. */
const DECLARES_TABLE = /\bCREATE\s+TABLE\b/i;

const SKIP_DIRS = new Set([
	'node_modules',
	'dist',
	'build',
	'.astro',
	'.wrangler',
	'coverage',
	'.claude',
	'.git',
	'playwright-report',
	'test-results',
	// Added with the denylist walk. A Python virtualenv is the one that matters:
	// `.venv/lib/python3.x/site-packages` holds tens of thousands of .py files,
	// none of them ours, and several of them would match a rule.
	'.venv',
	'venv',
	'site-packages',
	'__pycache__',
	'.pytest_cache',
	'.mypy_cache',
	'.ruff_cache',
	'target',
	'vendor',
	'.next',
	'.svelte-kit',
	'htmlcov',
	'.turbo',
	'.cache',
]);

/** Generated Python metadata dirs — matched by suffix, not by exact name. */
const SKIP_DIR_SUFFIXES = ['.egg-info'];

/**
 * How far behind its remote is this checkout?
 *
 * THE TWIN OF `missingCheckouts`. That one answers "could I look?"; this answers
 * "did I look at TODAY'S code?". Both failures produce a confident verdict about
 * something other than the fleet's current state, and the second is the worse of
 * the two because it looks like a normal run.
 *
 * It bit on 2026-09-24: an ad-hoc fleet audit at 18:00 read `~/repos/hadoku_site`
 * as it stood after the 13:00 `repos:main-sync`, 30 commits back, and reported 16
 * violations — one of them in a file whose fix was already on origin/main. Stale
 * code lies in BOTH directions: a fix you cannot see, and a finding that is not
 * there any more.
 *
 * The nightly path is already correct — `repos:main-sync` runs first in the same
 * profile, precisely so the audits read fresh checkouts — so this is about the
 * ad-hoc run, which has no such guarantee and no way to notice.
 *
 * `ls-remote` is the authoritative comparison and the reason this does not read
 * the local `origin/main` ref: that ref is only as fresh as the last fetch, so a
 * repo nobody has fetched for a week reports "current" against a week-old idea of
 * the remote. Network failure returns `unknown`, which never fails a run — an
 * offline audit is degraded, not wrong, and saying so is the honest outcome.
 */
export function checkoutFreshness(dir) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
	const git = (args) =>
		execFileSync('git', ['-C', dir, ...args], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			env,
			cwd: dir,
			timeout: 20_000,
		}).trim();
	let head;
	try {
		head = git(['rev-parse', 'HEAD']);
	} catch {
		return { state: 'unknown', reason: 'HEAD unreadable' };
	}
	let remote;
	try {
		// The default branch by name, not `HEAD`: `ls-remote origin HEAD` answers
		// with the remote's own default, which a repo on a differently-named branch
		// would silently be measured against.
		const out = git(['ls-remote', 'origin', 'main', 'master']);
		remote = out.split('\n').filter(Boolean)[0]?.split('\t')[0];
	} catch {
		return { state: 'unknown', reason: 'ls-remote failed (offline?)' };
	}
	if (!remote) return { state: 'unknown', reason: 'no main/master on origin' };
	if (remote === head) return { state: 'current' };
	let behind;
	try {
		behind = Number(git(['rev-list', '--count', `HEAD..${remote}`]));
	} catch {
		// The remote commit is not in this object store, so it has never been
		// fetched — which is itself proof the checkout is behind.
		return { state: 'behind', behind: null, reason: 'remote commit not fetched' };
	}
	// Ahead-only (local commits not yet pushed) is NORMAL mid-work and is not
	// staleness: the files on disk are newer than the remote, not older.
	if (!behind) return { state: 'current' };
	return { state: 'behind', behind };
}

/**
 * The repo's own tracked-file list, or null when it cannot be read.
 *
 * GIT IS THE DENYLIST THAT MAINTAINS ITSELF. Walking whole repos immediately
 * found hadoku_site's `public/mf/**` bundles — contact-ui's worker and
 * watchparty's UI, COMPILED INTO THIS REPO — and reported five findings against
 * generated code that only exists because the source repos have the same bug.
 * Fixing the source would not clear them; rebuilding would move their line
 * numbers. A hand-kept list would have to learn every bundler output path in
 * the fleet, and would rot the same way the root list did.
 *
 * `.gitignore` already states exactly this, in every repo, maintained by the
 * people who added the build step. A file git does not track is not source.
 *
 * Unreadable (not a checkout, git missing) returns null and the walk falls back
 * to the SKIP_DIRS denylist — degraded but never blind, because an audit that
 * silently inspects nothing is the failure this whole change is about.
 */
export function trackedFiles(root) {
	try {
		// EVERY GIT_* VARIABLE MUST BE CLEARED, and `-C` is not enough: `-C` sets the
		// working directory, `GIT_DIR` names the repository, and GIT_DIR wins. Git
		// hooks export it — hadoku_site's own pre-commit runs this gate — so an
		// inherited GIT_DIR would make this ask HADOKU_SITE's index which of a
		// SIBLING repo's files are tracked. The answer is "none of them", every file
		// would be skipped, and each sibling would be scanned as zero files: the
		// precise blindness this whole change removed, reintroduced one layer down
		// and quieter, since a clean run is indistinguishable from a real one.
		// Caught by the suite failing 13 cases under a simulated hook env.
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
		const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'ignore'],
			env,
			cwd: root,
		});
		const set = new Set(out.split('\0').filter(Boolean));
		return set.size ? set : null;
	} catch {
		return null;
	}
}

/** The module that owns the model. Everything below is measured against it. */
export const OWNER_MODULE = 'workers/shared/identity.ts';
export const OWNER_IMPORT = '@wolffm/worker-utils/identity';

/**
 * THE identity boundary. edge-router resolves the credential and stamps
 * `X-User-Id` having first deleted any client-supplied copy — that is R1, and
 * it is the reason every other worker may treat the header's presence as proof.
 * So G5 does not apply inside it: stamping the header IS its job.
 *
 * A rule rather than an allowlist entry, because it is a DEFINITION. Four files
 * in there legitimately set the header today and an exemption list would need
 * touching every time a fifth appears, which teaches the wrong thing about why
 * they are allowed.
 */
const IDENTITY_BOUNDARY = 'workers/edge-router/src/';

/**
 * This checker's own source, BY BASENAME. Its patterns necessarily spell out
 * every construct it hunts, so scanning itself reports itself.
 *
 * It held the string `'fleet identity-model'` — the COMMAND name — and was
 * compared against a repo-relative path, so it never once matched and the
 * exclusion was decorative. Nothing noticed while the file lived in
 * `hadoku_site/scripts/admin` and no check happened to match its text; G7 does
 * match it, which is what surfaced the dead guard. A guard that cannot fire
 * reads as coverage, so this is a basename now and pinned by a test.
 */
const SELF = 'check-identity-model.mjs';
/**
 * This gate's own REGRESSION TEST, excluded for the same reason as SELF and
 * more so: it is built out of deliberate violations.
 *
 * Eleven fixtures live in it as template literals — `body.userId`,
 * `c.req.valid('json')`, resolvers with and without bindings — because that is
 * how you test a checker. Scanned as code they are indistinguishable from the
 * thing they exist to catch, so the gate reported its own test suite and
 * `ci:identity-model` stayed red for two days.
 *
 * It fired as G7 first. Widening the test-file pattern to `.mjs` silenced that
 * one, and G3 then reported the SAME FILE at a different line — because the
 * scan loop computes `isTest` and applies it to G5 alone. Excluding the file is
 * what closes the class; skipping G3 for every test in the fleet would have
 * blinded a real rule to fix one file.
 *
 * A fixture is not evidence. Fourth occurrence of that in this repo.
 */
const SELF_TEST = 'check-identity-model.test.mjs';

// ── G6 ───────────────────────────────────────────────────────────────────────
/**
 * Where edge-router mounts each worker that READS `X-User-Id`.
 *
 * R1 lets a worker treat the header's presence as proof of identity — but only
 * if the edge actually stamps it. `injectSessionKey` is not a substitute: that
 * stamps `X-User-Key`, a CREDENTIAL, and keying reads on one is the thing the
 * identity model exists to undo.
 *
 * This gate exists because the gap shipped. watchparty-stats-api's /me and
 * /matches were moved onto the edge identity on 2026-08-28 while their proxy
 * config still had only `injectSessionKey: true`, so the worker saw no
 * X-User-Id at all and 401'd every signed-in player. Nothing caught it —
 * `check:header-fleet` is about UI headers, not this.
 *
 * The env-var names are not derivable from the directory (`prompt-api` mounts
 * as PROMPT_WORKER_BASE), so the mapping is explicit — and a reader with NO
 * entry is a hard failure, which is what stops the table rotting: adding a
 * worker that reads the header forces you to say where it is mounted.
 */
const EDGE_MOUNTS = {
	'cdn-api': 'CDN_API_BASE',
	'prefs-api': 'PREFS_API_BASE',
	'watchparty-stats-api': 'WATCHPARTY_STATS_API_BASE',
};

/**
 * Reads the header (a consumer), as opposed to setting it (G5's business).
 * Hono's `c.req.header(...)` and the Fetch API's `headers.get(...)` — the
 * latter also as `c.req.raw.headers.get(...)` — are the same read, and a worker
 * written against plain `Request` used to be invisible here.
 */
const READS_USER_ID = /(?:\breq\.header|\bheaders\.get)\(\s*['"`]X-User-Id['"`]/i;

export const EDGE_INDEX = 'workers/edge-router/src/index.ts';

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

function checkG8(rel, src, add) {
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

// ── G7 ───────────────────────────────────────────────────────────────────────
/**
 * The functions that READ THE REGISTRY. Importing the module is not enough to
 * need a binding — `isIdentityError`, `NO_USER_ID` and `NO_REGISTRY` are pure —
 * so the check keys on the calls. But only calls of a name BOUND to the module:
 * matching the bare name flagged hadoku-watchparty's own `resolveRegistryName`,
 * a whoami wrapper in a PM2 service that shares the word and nothing else
 * (#113). See {@link resolverPatterns}.
 *
 * `resolveGranteeVia` is deliberately ABSENT: it is the service-binding form
 * and needs no registry at all. That asymmetry is the whole point of the gate —
 * it distinguishes the two ways of asking rather than counting imports.
 */
const REGISTRY_READER_NAMES = [
	'resolveGrantee',
	'readLiveRows',
	'registryNameMap',
	'liveRowsByName',
	'searchRegistryNames',
	'resolveRegistryName',
	'isRegistryNameTaken',
];

/** The service-binding form. Needs `[[services]] → edge-router`, not KV. */
const EDGE_RESOLVER_NAMES = ['resolveGranteeVia'];

/**
 * The one module the readers come from. worker-utils exports it as a SUBPATH
 * only, so every real import site spells exactly this.
 */
const IDENTITY_MODULE = '@wolffm/worker-utils/identity';

/** Which resolver family a canonical export name belongs to, or null. */
const familyOf = (name) =>
	REGISTRY_READER_NAMES.includes(name) ? 'kv' : EDGE_RESOLVER_NAMES.includes(name) ? 'edge' : null;

/**
 * A LOCAL module's resolver exports: exported name → `'kv' | 'edge'`.
 *
 * hadoku-task's `share-registry.ts` re-exports the readers so its call sites
 * keep one import path, and a call through it IS a registry read — dropping
 * that would trade #113's false positive for a false negative on a worker that
 * genuinely needs the binding. Followed a few hops, cycle-safe; a module that
 * defines its own function of the same name exports nothing here.
 */
const exportCache = new Map();

function resolverExports(abs, depth = 0) {
	if (exportCache.has(abs)) return exportCache.get(abs);
	const out = new Map();
	exportCache.set(abs, out); // a cycle reads as "nothing yet", never a loop
	if (depth > 4) return out;
	let src;
	try {
		src = blankComments(readFileSync(abs, 'utf8'));
	} catch {
		return out; // unreadable: it re-exports nothing this gate can see
	}
	const bound = importedResolvers(src, abs, depth + 1);
	const fromSpec = (spec) =>
		spec === IDENTITY_MODULE
			? 'identity'
			: (() => {
					const f = resolveLocal(abs, spec);
					return f ? resolverExports(f, depth + 1) : null;
				})();
	for (const m of src.matchAll(/\bexport\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
		const origin = fromSpec(m[2]);
		if (!origin) continue;
		for (const [orig, as] of specifiers(m[1])) {
			const fam = origin === 'identity' ? familyOf(orig) : (origin.get(orig) ?? null);
			if (fam) out.set(as, fam);
		}
	}
	for (const m of src.matchAll(/\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
		const origin = fromSpec(m[1]);
		if (origin === 'identity')
			for (const n of [...REGISTRY_READER_NAMES, ...EDGE_RESOLVER_NAMES]) out.set(n, familyOf(n));
		else if (origin) for (const [n, fam] of origin) out.set(n, fam);
	}
	// `import { x } from <identity>; export { x }` — re-export of a binding.
	for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g)) {
		for (const [local, as] of specifiers(m[1])) {
			const fam = bound.names.get(local);
			if (fam) out.set(as, fam);
		}
	}
	return out;
}

/**
 * The local names THIS FILE holds bound to a resolver: `names` (local → family)
 * and `namespaces` (an `import * as ns` of the module itself).
 *
 * An alias counts — `import { resolveGrantee as rg }` then `rg(...)` called the
 * registry with no name this gate knew (mutation-tested 2026-10-10, #98). A
 * name with no binding does not, whatever it is spelled (#113).
 */
function importedResolvers(src, abs, depth = 0) {
	const names = new Map();
	const namespaces = [];
	const re = new RegExp(
		`\\bimport\\s+(?!type\\b)(?:${IDENT}\\s*,\\s*)?(?:\\{([^}]*)\\}|\\*\\s*as\\s+(${IDENT}))\\s*from\\s*['"]([^'"]+)['"]`,
		'g'
	);
	for (const m of src.matchAll(re)) {
		const [, list, ns, spec] = m;
		if (spec === IDENTITY_MODULE) {
			if (ns) namespaces.push(ns);
			for (const [orig, local] of specifiers(list ?? '')) {
				const fam = familyOf(orig);
				if (fam) names.set(local, fam);
			}
			continue;
		}
		const file = list ? resolveLocal(abs, spec) : null;
		if (!file) continue;
		const exported = resolverExports(file, depth);
		for (const [orig, local] of specifiers(list)) {
			const fam = exported.get(orig);
			if (fam) names.set(local, fam);
		}
	}
	return { names, namespaces };
}

/** A call to any of `locals`, bare or through a namespace, or null for none. */
function callOf(locals, namespaces, canon) {
	const alts = [
		...locals.map((n) => `(?<![\\w$.])${n.replace(/\$/g, '\\$')}`),
		...namespaces.map(
			(ns) => `(?<![\\w$.])${ns.replace(/\$/g, '\\$')}\\s*\\.\\s*(?:${canon.join('|')})`
		),
	];
	return alts.length ? new RegExp(`(?:${alts.join('|')})\\s*\\(`) : null;
}

/** The resolver calls THIS FILE can make, as `{ kv, edge }` regexes (null = none). */
function resolverPatterns(src, abs) {
	const { names, namespaces } = importedResolvers(src, abs);
	const of = (fam) => [...names].filter(([, f]) => f === fam).map(([n]) => n);
	return {
		kv: callOf(of('kv'), namespaces, REGISTRY_READER_NAMES),
		edge: callOf(of('edge'), namespaces, EDGE_RESOLVER_NAMES),
	};
}

/**
 * Which hadoku_site worker a SIBLING repo's code is bundled into.
 *
 * Not derivable, and the mismatch is the reason: hadoku-study's resolver lives
 * in `hadoku-study/worker/src/routes/sets.ts` while the wrangler.toml that must
 * bind for it is `hadoku_site/workers/study-api/wrangler.toml` — a different
 * file in a different repo. A child repo cannot check this about itself, which
 * is exactly why it went unchecked until jobplatform hit it.
 *
 * A resolver with NO entry is a hard failure, the same way G6 treats a header
 * reader with no EDGE_MOUNTS entry. That is what keeps the table from rotting:
 * teaching a child app to resolve an owner forces you to say where it deploys.
 */
const SIBLING_WORKERS = {
	'hadoku-study': 'study-api',
	'hadoku-task': 'task-api',
	'hadoku-jobplatform': 'jobplatform-api',
};

/** `[[kv_namespaces]]` … `binding = "SESSIONS_KV"`, at the top level. */
const bindsRegistry = (toml) =>
	topLevelBindings(toml).kv_namespaces.some((e) => /\bbinding\s*=\s*["']SESSIONS_KV["']/.test(e));

/** `[[services]]` … `service = "edge-router"`, at the top level. */
const bindsEdge = (toml) =>
	topLevelBindings(toml).services.some((e) => /\bservice\s*=\s*["']edge-router["']/.test(e));

/**
 * G7 — a worker that resolves an identity must be WIRED to resolve one.
 *
 * `resolveGrantee` degrades rather than throws when `SESSIONS_KV` is absent, on
 * purpose: an annotation failure must not cost a caller the list it was
 * annotating. The cost of that kindness is that a missing binding is invisible
 * until a user tries to hand a row to someone — it typechecks, it deploys, it
 * passes every test, and then it answers a person by name with an outage.
 * jobplatform reached production that way.
 *
 * Statically decidable, so it is checked rather than remembered: the resolver
 * call is in the source, the binding is in the wrangler.toml, and one implies
 * the other.
 *
 * EITHER binding satisfies it. They are not equivalent and the gate does not
 * pretend they are — `SESSIONS_KV` is keyed `key:{rawKey}`, so it grants the
 * worker `list()` over every live credential, while the edge binding answers
 * one name. But both genuinely resolve, and a gate that demanded the broader
 * grant would push every new consumer toward the larger blast radius.
 */
function checkG7(resolvers, label, siteRoot, add) {
	for (const [worker, use] of resolvers) {
		const tomlRel = `workers/${worker}/wrangler.toml`;
		const tomlPath = resolve(siteRoot, tomlRel);
		if (!existsSync(tomlPath)) {
			add('G7', use.rel, use.line, `${worker} resolves an identity but ${tomlRel} does not exist`);
			continue;
		}
		const toml = stripTomlComments(readFileSync(tomlPath, 'utf8'));
		if (use.viaEdge && !use.viaKv) {
			if (!bindsEdge(toml)) {
				add(
					'G7',
					tomlRel,
					1,
					`${label ?? 'this repo'} calls resolveGranteeVia but ${worker} has no [[services]] binding to edge-router`
				);
			}
			continue;
		}
		if (!bindsRegistry(toml) && !bindsEdge(toml)) {
			add(
				'G7',
				use.rel,
				use.line,
				`resolves an identity, but ${worker} binds neither SESSIONS_KV nor edge-router — every resolve will report an outage`
			);
		}
	}
}

/**
 * G7's input, taken from the walk `scanRepo` is already doing.
 *
 * In hadoku_site the worker is the directory (`workers/<w>/src/**`). In a
 * sibling repo it comes from SIBLING_WORKERS, and a repo that resolves with no
 * entry there is reported rather than skipped — "I could not tell which worker"
 * must never render as "nothing is wrong".
 *
 * edge-router IS the registry and `shared` is the module itself, so neither is
 * a consumer. Tests are excluded: a stub registry is how the module gets
 * exercised, not a claim about a deployment.
 */
function collectResolver(rel, abs, src, label, resolvers, add) {
	if (isTestFile(rel) || /(^|\/)tests?\//.test(rel)) return;
	const calls = resolverPatterns(src, abs);
	const hit = (text) => Boolean(calls.kv?.test(text) || calls.edge?.test(text));
	const viaKv = Boolean(calls.kv?.test(src));
	const viaEdge = Boolean(calls.edge?.test(src));
	if (!viaKv && !viaEdge) return;
	const firstCall = () => Math.max(src.split('\n').findIndex(hit) + 1, 1);

	let worker;
	if (!label) {
		const m = /^workers\/([^/]+)\/src\//.exec(rel);
		if (!m) return;
		worker = m[1];
		if (worker === 'edge-router' || worker === 'shared') return;
	} else {
		worker = SIBLING_WORKERS[label];
		if (!worker) {
			add('G7', rel, firstCall(), `${label} resolves an identity but has no SIBLING_WORKERS entry`);
			return;
		}
	}

	const prev = resolvers.get(worker);
	resolvers.set(worker, {
		rel: prev?.rel ?? rel,
		line: prev?.line ?? firstCall(),
		viaKv: (prev?.viaKv ?? false) || viaKv,
		viaEdge: (prev?.viaEdge ?? false) || viaEdge,
	});
}

function* walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch (err) {
		if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return;
		throw err;
	}
	for (const name of entries) {
		if (SKIP_DIRS.has(name)) continue;
		if (SKIP_DIR_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
		const full = resolve(dir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) yield* walk(full);
		else yield full;
	}
}

function checkG1(rel, src, add) {
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
function checkG2Dir(files, add) {
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

function checkG3(rel, src, add) {
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
function collectUserIdReader(rel, src, readers) {
	const m = /^workers\/([^/]+)\/src\//.exec(rel);
	if (!m) return;
	const worker = m[1];
	if (worker === 'edge-router' || worker === 'shared') return;
	if (readers.has(worker)) return; // first hit wins, exactly as the walk broke
	if (isTestFile(rel)) return;
	const line = src.split('\n').findIndex((l) => READS_USER_ID.test(l));
	if (line >= 0) readers.set(worker, { rel, line: line + 1 });
}

function checkG6(root, readers, add) {
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

function checkG4(rel, src, add) {
	let m;
	USERID_LITERAL.lastIndex = 0;
	while ((m = USERID_LITERAL.exec(src))) {
		if (!DISPLAY_NAME_SHAPED.test(m[2])) continue;
		add('G4', rel, lineOf(src, m.index), `\`${m[2]}\` is a display name, not a userId`);
	}
}

function checkG5(rel, src, add) {
	for (const [i, line] of src.split('\n').entries()) {
		// Every match on the line, not the first: `{ 'X-Hadoku-Tier': 'public',
		// 'X-User-Id': uid }` downgrades the tier AND stamps a user.
		const stamp = [...line.matchAll(SELF_STAMP_ALL)].find((m) => !isDowngrade(line, m));
		if (stamp) add('G5', rel, i + 1, `sets ${stamp.slice(1).find(Boolean)} on a request`);
	}
}

/**
 * Scan one repo root. `label` prefixes findings from a sibling checkout.
 * Allowlisted findings go into `hits` (entry -> the violations it absorbed),
 * shared across every repo so the count and stale checks see the whole run.
 */
export function scanRepo(root, label, allow, violations, hits, tracked = trackedFiles(root)) {
	const sqlByDir = new Map();
	/** worker -> first `workers/<w>/src` file reading X-User-Id. G6's input. */
	const userIdReaders = new Map();
	/** worker -> where it resolves an identity, and by which of the two ways. G7's input. */
	const resolvers = new Map();
	const add = (check, file, line, message) => {
		const rel = label ? `${label}:${file}` : file;
		const violation = { check, file: rel, line, message };
		// The LABELLED path only. An unprefixed lookup also ran for siblings, so a
		// site entry for `src/x.ts` exempted `src/x.ts` in every sibling repo too —
		// and counted as a hit there, so the stale check could not see the site
		// entry had stopped matching (#98).
		const entry = allow.get(`${check}::${rel}`);
		if (entry) {
			hits.set(entry, [...(hits.get(entry) ?? []), violation]);
			return;
		}
		violations.push(violation);
	};

	{
		// GIT'S LIST WHEN THERE IS ONE, the denylist walk only when there is not.
		// Walking the directory and then filtering by the tracked set applied
		// SKIP_DIRS first, so a TRACKED `build/`, `vendor/` or `target/` — source
		// someone chose to commit under a name the denylist guesses is generated —
		// was never read (#98). The tracked set already says what is source.
		const files = tracked
			? [...tracked]
					.filter((rel) => SCANNED_EXT.some((e) => rel.endsWith(e)))
					.sort()
					.map((rel) => resolve(root, rel))
					.filter((full) => {
						try {
							return statSync(full).isFile();
						} catch {
							return false; // tracked but deleted in the working tree
						}
					})
			: walk(root);
		for (const full of files) {
			const rel = relative(root, full).split(sep).join('/');
			if (basename(rel) === SELF || basename(rel) === SELF_TEST) continue;
			// `e2e/` is a test tree too: cardtable's `e2e/edge.ts` and bomberman's
			// `e2e/edge-stub.mjs` stand in for edge-router under playwright, so
			// stamping identity headers is their whole job (G5 fired on both,
			// 2026-10-11). A directory, not a `*.stub.*` name: a stub under `src/`
			// can ship.
			const isTest = isTestFile(basename(full)) || /(^|\/)(tests?|e2e)\//.test(rel);
			if (SQL_EXT.some((e) => full.endsWith(e))) {
				// Collected, not judged: G2 replays a whole migrations directory
				// in order, because a rename in a later file is the only way to
				// retire a column an earlier one created.
				const dir = rel.slice(0, rel.lastIndexOf('/'));
				sqlByDir.set(dir, [...(sqlByDir.get(dir) ?? []), { rel, sql: readFileSync(full, 'utf8') }]);
				continue;
			}
			// An EMBEDDED schema is judged on its own, before the code checks, and
			// as its OWN group rather than joining a directory replay: the rename/
			// drop bookkeeping G2 does across a migrations dir is meaningful within
			// one such file and meaningless across unrelated code files.
			//
			// Read RAW, not through blankComments: the SQL lives inside a string
			// literal, and `--` inside it is a SQL comment that checkG2Dir strips
			// itself. A test file is skipped — a harness declaring a fixture table
			// is not a production schema.
			if (!isTest && SCHEMA_CODE_EXT.some((e) => full.endsWith(e))) {
				const raw = readFileSync(full, 'utf8');
				if (DECLARES_TABLE.test(raw)) checkG2Dir([{ rel, sql: raw }], add);
			}
			if (!CODE_EXT.some((e) => full.endsWith(e))) continue;
			const src = blankComments(readFileSync(full, 'utf8'));
			collectUserIdReader(rel, src, userIdReaders);
			collectResolver(rel, full, src, label, resolvers, add);
			checkG1(rel, src, add);
			checkG3(rel, src, add);
			checkG4(rel, src, add);
			// G8, like G5, exempts tests: a harness holds raw keys on purpose. It
			// carries its own custodian list rather than reusing IDENTITY_BOUNDARY,
			// because storing a credential is edge-router's registry's job but not
			// every edge-router file's job.
			if (!isTest) checkG8(rel, src, add);
			// G5 is about code OUTSIDE the boundary impersonating a user. A test
			// harness stamping the header is how a worker gets exercised at all,
			// and inside edge-router stamping it is the point. The boundary is a
			// path in HADOKU_SITE: a sibling repo that happens to have a
			// `workers/edge-router/src/` directory is not the edge, and was exempt.
			const atBoundary = label === null && rel.startsWith(IDENTITY_BOUNDARY);
			if (!isTest && !atBoundary) checkG5(rel, src, add);
		}
	}
	// G6 reasons about the WHOLE repo (a worker plus edge-router's config), so it
	// runs once per repo rather than per file.
	checkG6(root, userIdReaders, add);
	// G7 crosses repos: a sibling's resolver is deployed by a wrangler.toml in
	// hadoku_site, so it is always measured against the SITE root, never the
	// root currently being scanned.
	checkG7(resolvers, label, REPO_ROOT, add);
	for (const [, files] of sqlByDir) {
		files.sort((a, b) => a.rel.localeCompare(b.rel));
		checkG2Dir(files, add);
	}
}

/**
 * The sibling repos to scan, and the roster entries that could NOT be read.
 *
 * DERIVED from `fleet-runner-coverage.json` via lib/fleet-roster.mjs, never from
 * a directory listing. The filter used to be `name.startsWith('hadoku')`,
 * which is a naming convention doing the job of a membership list — and the
 * convention is not universal: `brave-quartet` and `ArchiveBot` are both in the
 * roster and neither would ever have been scanned. Nothing would have reported
 * that, because a repo the sweep never looks at produces no findings and no
 * findings reads as clean. Same defect class as check-header-fleet's
 * `not-in-fleet` rule, which exists for exactly this.
 *
 * EACH SIBLING IS ITS SHIPPED TREE, through lib/fleet-source.mjs: the default
 * branch, fetched by the reader itself and written out as a clean tree, never a
 * clone under REPOS_DIR (fleet-manager#7). A sibling checkout was whatever its
 * last pull left — 30 commits behind on 2026-09-24, reporting a violation whose
 * fix was already shipped. The tracked set comes from the shipped tree's own
 * listing, so git, not the denylist, still says what is source.
 *
 * UNREADABLE REPOS ARE RETURNED, NOT SKIPPED. A roster repo the reader could not
 * read is a repo this run did not audit, and "I could not look" must never
 * render as "nothing is wrong" — the `no-checkout` trap named in
 * scripts/CLAUDE.md. The caller decides what to do with them; the JSON report
 * carries them and the cron fails on them.
 */
export function siblingRepos() {
	const trees = [];
	const missing = [];
	/** slug -> why it could not be read. */
	const why = new Map();
	for (const slug of allRepos()) {
		const source = tryShipped(slug);
		if ('unreadable' in source) {
			missing.push(slug);
			why.set(slug, source.unreadable);
			continue;
		}
		try {
			const root = source.materialize({
				include: (p) => SCANNED_EXT.some((e) => p.endsWith(e)) || p === EDGE_INDEX,
			});
			trees.push({ root, label: slug.split('/')[1], tracked: new Set(source.list()) });
		} catch (err) {
			missing.push(slug);
			why.set(slug, err.reason ?? String(err));
		}
	}
	return { trees, missing, why };
}
