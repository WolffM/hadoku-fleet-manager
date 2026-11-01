/**
 * #98: blind spots found by mutation-testing this gate.
 *
 * Every case below was a REAL violation that exited 0 on 2026-10-10. Each is
 * the minimal mutation that proved it; each must fail.
 *
 * Split of scripts/check-identity-model.test.mjs (wave 5q lane C, pure move)
 * to reach the 1,000-line test ceiling: this is the back half of that
 * suite, starting at this same divider; the shared harness (`runFiles`,
 * `withSite`, `GATE`, …) lives in `lib/identity-model-fixtures.mjs`, shared
 * with the front half.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { poisonedClone } from './lib/fleet-source-fixture.mjs';
import {
	GATE,
	RESOLVER,
	KV_BINDING,
	withRemotes,
	gitIn,
	bareSite,
	withBareSite,
	run,
	withSite,
	runFiles,
	missedCheck,
	jsonDoc,
	handler,
	withSibling,
} from './lib/identity-model-fixtures.mjs';

// ── G3 ──

test('G3: an owner DESTRUCTURED straight out of the body is reported — no tainted name needed', () => {
	// The destructure rule sat after `if (!tainted.size) return`, and a file
	// whose only body read was the destructure had no tainted name.
	assert.equal(
		missedCheck(
			runFiles({
				'src/a.ts': handler('\tconst { userId } = await c.req.json();\n\treturn userId;'),
			}),
			'G3',
			/`userId` is an owner destructured out of the request body/
		),
		null
	);
});

test('G3: an owner destructured out of a tainted NAME is reported', () => {
	assert.equal(
		missedCheck(
			runFiles({
				'src/a.ts': handler(
					'\tconst body = await c.req.json();\n\tconst { ownerId: who } = body;\n\treturn who;'
				),
			}),
			'G3',
			/`ownerId` is an owner destructured/
		),
		null
	);
});

test('G3: an ALIAS of the body carries the taint', () => {
	assert.equal(
		missedCheck(
			runFiles({
				'src/a.ts': handler(
					'\tconst body = await c.req.json();\n\tconst input = body;\n\treturn input.userId;'
				),
			}),
			'G3',
			/`input\.userId`/
		),
		null
	);
});

test('G3: a BRACKET read of the owner field is the same read', () => {
	assert.equal(
		missedCheck(
			runFiles({
				'src/a.ts': handler("\tconst body = await c.req.json();\n\treturn body['userId'];"),
			}),
			'G3',
			/`body\.userId`/
		),
		null
	);
});

test('G3: a FORM body (parseBody, formData) is a body too', () => {
	assert.equal(
		missedCheck(
			runFiles({
				'src/a.ts': handler('\tconst form = await c.req.parseBody();\n\treturn form.owner;'),
			}),
			'G3',
			/`form\.owner`/
		),
		null
	);
	assert.equal(
		missedCheck(
			runFiles({
				'src/a.ts': handler("\tconst fd = await c.req.formData();\n\treturn fd.get('userId');"),
			}),
			'G3',
			/`fd\.userId`/
		),
		null
	);
});

// ── G1 ──

for (const [shape, src] of [
	['generics', 'export interface Row<T> {\n\tkey: T;\n\tretiredAt?: number;\n}\n'],
	['extends', 'interface Row extends Base {\n\tretiredAt?: number;\n}\n'],
	['an intersection', 'type Row = Base & {\n\tretiredAt?: number;\n};\n'],
	['a quoted key', "interface Row {\n\t'retiredAt'?: number;\n}\n"],
]) {
	test(`G1: the registry row is found behind ${shape}`, () => {
		assert.equal(
			missedCheck(runFiles({ 'src/types.ts': src }), 'G1', /re-declares the key-registry row/),
			null
		);
	});
}

test('G1: a brace-less alias does not reach into the next declaration', () => {
	for (const src of [
		'type Id = string\nexport function f(x: Id) {\n\treturn { retiredAt: 1 };\n}\n',
		'type Id = string\nexport class Clock {\n\tretiredAt: number = 0;\n}\n',
	]) {
		const r = runFiles({ 'src/types.ts': src });
		assert.equal(r.code, 0, r.out);
	}
});

// ── G2 ──

for (const [shape, sql] of [
	['a one-line table', 'CREATE TABLE t (id TEXT PRIMARY KEY, voter_key TEXT NOT NULL);'],
	['a VARCHAR column', 'CREATE TABLE t (\n  id INTEGER,\n  voter_key VARCHAR(64)\n);'],
	['a UUID column', 'CREATE TABLE t (\n  id INTEGER,\n  voter_key UUID\n);'],
	['backtick quoting', 'CREATE TABLE `t` (\n  id INTEGER,\n  `voter_key` CHAR(36)\n);'],
	['bracket quoting', 'CREATE TABLE [t] (\n  id INTEGER,\n  [voter_key] TEXT\n);'],
	['no trailing semicolon', 'CREATE TABLE t (\n  id INTEGER,\n  voter_key BOOLEAN\n)'],
	['ADD without COLUMN', 'CREATE TABLE t (id INTEGER);\nALTER TABLE t ADD voter_key TEXT;'],
]) {
	test(`G2: a credential column is found in ${shape}`, () => {
		assert.equal(missedCheck(runFiles({ 'src/schema.sql': sql }), 'G2', /voter_key/), null);
	});
}

test('G2: a table that parses to ZERO columns is reported, not read as clean', () => {
	// The second shape is why constraint clauses are skipped: `PRIMARY KEY (id)`
	// counted as a column named PRIMARY would make an unreadable table look read.
	for (const sql of [
		'CREATE TABLE t (${COLUMNS});\n',
		'CREATE TABLE t (${COLUMNS}, PRIMARY KEY (id));\n',
	]) {
		assert.equal(
			missedCheck(runFiles({ 'src/schema.sql': sql }), 'G2', /parsed to ZERO columns/),
			null
		);
	}
});

test('G2: a constraint clause is not a column, and a rename still retires one', () => {
	const r = runFiles({
		'src/schema.sql':
			'CREATE TABLE t (id TEXT, voter_key TEXT, PRIMARY KEY (id), UNIQUE (voter_key));\n' +
			'ALTER TABLE t RENAME COLUMN voter_key TO voter_user_id;\n',
	});
	assert.equal(r.code, 0, r.out);
});

// ── allowlist ──

test('allowlist: without `count` an entry still exempts every finding in its file', () => {
	const r = runFiles(
		{ 'src/schema.sql': 'CREATE TABLE t (voter_key TEXT, viewer_key TEXT);' },
		{ allow: [{ check: 'G2', file: 'src/schema.sql', why: 'fixture' }] }
	);
	assert.equal(r.code, 0, r.out);
});

test('allowlist: a `count` is a ceiling — a NEW violation in the file surfaces', () => {
	const allow = [{ check: 'G2', file: 'src/schema.sql', why: 'fixture', count: 1 }];
	const one = runFiles({ 'src/schema.sql': 'CREATE TABLE t (voter_key TEXT);' }, { allow });
	assert.equal(one.code, 0, one.out);
	assert.equal(
		missedCheck(
			runFiles(
				{ 'src/schema.sql': 'CREATE TABLE t (voter_key TEXT, viewer_key TEXT);' },
				{ allow }
			),
			'G2',
			/allowlisted for 1, 2 found/
		),
		null
	);
});

test('allowlist: a malformed `count` is refused', () => {
	const r = runFiles(
		{ 'src/a.ts': 'export const x = 1;\n' },
		{ allow: [{ check: 'G2', file: 'src/a.ts', why: 'fixture', count: 'two' }] }
	);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /"count" must be a positive integer/);
});

test('allowlist: a SITE entry does not exempt the same path in a sibling, and goes stale', () => {
	// The unprefixed lookup let `G2 src/schema.sql` exempt `src/schema.sql` in
	// every sibling — and the sibling's hit kept the site entry looking live.
	withSibling('sib', { 'src/schema.sql': 'CREATE TABLE t (voter_key TEXT);' }, (repos) => {
		const r = runFiles(
			{ 'src/ok.ts': 'export const x = 1;\n' },
			{
				extra: ['--fleet', '--json', '--allow-stale'],
				allow: [{ check: 'G2', file: 'src/schema.sql', why: 'fixture' }],
				coverage: { repos: ['WolffM/sib'], facets: {} },
				REPOS_DIR: repos,
			}
		);
		assert.equal(r.code, 1, r.out);
		const doc = jsonDoc(r);
		assert.ok(
			doc.violations.some((v) => v.file === 'sib:src/schema.sql'),
			`the sibling's violation must be reported:\n${r.out}`
		);
		assert.deepEqual(doc.staleExemptions, ['G2 src/schema.sql']);
	});
});

test('allowlist: a `count` above what was found is stale on a complete scan', () => {
	withSibling('sib', { 'src/ok.ts': 'export const x = 1;\n' }, (repos) => {
		const r = runFiles(
			{ 'src/schema.sql': 'CREATE TABLE t (voter_key TEXT);' },
			{
				extra: ['--fleet', '--allow-stale'],
				allow: [{ check: 'G2', file: 'src/schema.sql', why: 'fixture', count: 3 }],
				coverage: { repos: ['WolffM/sib'], facets: {} },
				REPOS_DIR: repos,
			}
		);
		assert.equal(r.code, 1, r.out);
		assert.match(r.out, /count is 3 but only 1 found; lower it/);
	});
});

test('--json: a bad allowlist entry still emits a parseable document', () => {
	// It exited with a stderr line only, so the cron parsed nothing and read a
	// finding as "the checker broke" — the --json contract.
	const root = bareSite();
	try {
		writeFileSync(
			join(root, 'scripts', 'admin', 'identity-model-allowlist.json'),
			JSON.stringify({ allowed: [{ check: 'G2' }] })
		);
		const res = spawnSync('node', [GATE, '--json'], {
			env: { ...process.env, HADOKU_SITE_ROOT: root },
			encoding: 'utf8',
		});
		assert.equal(res.status, 1);
		const doc = JSON.parse(res.stdout);
		assert.deepEqual(doc.violations, []);
		assert.match(doc.error, /needs "check", "file" and "why"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── fleet reach ──

test('--fleet with an EMPTY roster fails — scanning only the site is not a fleet audit', () => {
	const r = runFiles(
		{ 'src/ok.ts': 'export const x = 1;\n' },
		{ extra: ['--fleet', '--json', '--allow-stale'], coverage: { repos: [], facets: {} } }
	);
	assert.equal(r.code, 1, r.out);
	assert.match(jsonDoc(r).rosterError, /EMPTY roster/);
});

test('a TRACKED build/ directory is scanned — git, not the denylist, says what is source', () => {
	withBareSite((root) => {
		gitIn(root, ['init', '-q']);
		mkdirSync(join(root, 'build'), { recursive: true });
		writeFileSync(join(root, 'build', 'schema.sql'), 'CREATE TABLE t (voter_key TEXT);\n');
		gitIn(root, ['add', '-A']);
		const r = run(root, { extra: ['--allow-stale'] });
		assert.equal(r.code, 1, `a tracked build/ file must be read, got:\n${r.out}`);
		assert.match(r.out, /voter_key/);
	});
});

// ── G4 ──

for (const [shape, src] of [
	['ownerId', "export const f = { ownerId: 'hadoku' };\n"],
	['a quoted key', "export const f = { 'userId': 'hadoku' };\n"],
]) {
	test(`G4: a display-name literal is found under ${shape}`, () => {
		assert.equal(
			missedCheck(runFiles({ 'src/f.ts': src }), 'G4', /`hadoku` is a display name/),
			null
		);
	});
}

test('G4: a bare `owner` literal (a repo owner, a seat side) is not an identity claim', () => {
	// Measured fleet-wide 2026-10-10: 63 `owner: '<word>'` literals, none an identity.
	const r = runFiles({
		'src/f.ts':
			"export const a = { owner: 'apache', repo: 'x' };\nexport const s = { owner: 'them' };\n",
	});
	assert.equal(r.code, 0, r.out);
});

// ── G5 ──

for (const [shape, src] of [
	['a header tuple', "export const h = new Headers([['X-User-Id', id]]);\n"],
	['a bracket assignment', "export function f(h, id) {\n\th['x-user-id'] = id;\n}\n"],
]) {
	test(`G5: ${shape} stamps the header`, () => {
		assert.equal(missedCheck(runFiles({ 'src/f.ts': src }), 'G5', /sets X-User-Id/i), null);
	});
}

// #109: an inbound sanitizer that degrades an unproven request to the floor.
// The shape is hadoku_site's templates/*/edge-auth.ts, verbatim where it counts.
const SANITIZER = `export function sanitizeHeaders(headers) {
	if (edgeVouched(headers)) return;
	headers['x-hadoku-tier'] = 'public';
	headers['x-hadoku-content-level'] = '1';
	delete headers['x-user-id'];
	delete headers['x-user-key'];
}
`;

test('G5: degrading an unproven request to x-hadoku-tier=public is not a stamp', () => {
	const r = runFiles({ 'src/edge-auth.ts': SANITIZER });
	assert.equal(r.code, 0, r.out);
});

for (const [shape, src] of [
	['a method call', 'h.set(\'X-Hadoku-Tier\', "public");\n'],
	['an object literal', "export const h = { 'X-Hadoku-Tier': 'public' };\n"],
	['a header tuple', "export const h = new Headers([['X-Hadoku-Tier', 'public']]);\n"],
]) {
	test(`G5: a public downgrade is not a stamp as ${shape}`, () => {
		const r = runFiles({ 'src/f.ts': src });
		assert.equal(r.code, 0, r.out);
	});
}

for (const [what, src] of [
	// The bare-local opt-out in the same templates: a computed tier is a GRANT.
	[
		'a computed tier',
		"export function f(headers) {\n\theaders['x-hadoku-tier'] = CONFIG.devTier;\n}\n",
	],
	['a non-public literal tier', "export const h = { 'X-Hadoku-Tier': 'admin' };\n"],
	[
		'a nullish-assigned user',
		"export function f(headers) {\n\theaders['x-user-id'] ??= 'local-dev';\n}\n",
	],
	['an or-assigned user name', "export function f(h) {\n\th['X-User-Name'] ||= name;\n}\n"],
	['an and-assigned tier', "export function f(h) {\n\th['x-hadoku-tier'] &&= t;\n}\n"],
	['a value that merely starts with public', "export const h = { 'X-Hadoku-Tier': publicTier };\n"],
	['a user id set to public', "export function f(h) {\n\th['x-user-id'] = 'public';\n}\n"],
	[
		'a user stamped beside a public tier',
		"export const h = { 'X-Hadoku-Tier': 'public', 'X-User-Id': uid };\n",
	],
	[
		'a comparison, not an assignment',
		"export const ok = (h) => h['x-hadoku-tier'] == 'public' || (h['x-hadoku-tier'] = t);\n",
	],
]) {
	test(`G5: ${what} is still a stamp`, () => {
		assert.equal(missedCheck(runFiles({ 'src/f.ts': src }), 'G5'), null);
	});
}

test('G5: a list of header NAMES (a strip-list) is not a stamp', () => {
	const r = runFiles({ 'src/f.ts': "export const STRIP = ['X-User-Id', 'X-Hadoku-Tier'];\n" });
	assert.equal(r.code, 0, r.out);
});

test("G5: the edge-router exemption is hadoku_site's path, not any sibling's", () => {
	withSibling(
		'sib',
		{ 'workers/edge-router/src/x.ts': "export const h = { 'X-User-Id': 'u-1' };\n" },
		(repos) => {
			const r = runFiles(
				{ 'src/ok.ts': 'export const x = 1;\n' },
				{
					extra: ['--fleet', '--allow-stale'],
					coverage: { repos: ['WolffM/sib'], facets: {} },
					REPOS_DIR: repos,
				}
			);
			assert.equal(missedCheck(r, 'G5', /sib:workers\/edge-router\/src\/x\.ts/), null);
		}
	);
});

// ── G6 ──

test('G6: a worker reading X-User-Id through headers.get() is a reader', () => {
	assert.equal(
		missedCheck(
			runFiles({
				'workers/edge-router/src/index.ts': 'export default {};\n',
				'workers/demo-api/src/a.ts': handler("\treturn c.req.raw.headers.get('X-User-Id');"),
			}),
			'G6',
			/demo-api reads X-User-Id but has no EDGE_MOUNTS entry/
		),
		null
	);
});

test('G6: a base mounted twice must inject on EVERY mount, not the last one read', () => {
	const EDGE =
		'app.get("/a", (c) => proxyRequest(c, { baseUrl: c.env.CDN_API_BASE }));\n' +
		'app.get("/b", (c) => proxyRequest(c, { baseUrl: c.env.CDN_API_BASE, injectUserId: true }));\n';
	assert.equal(
		missedCheck(
			runFiles({
				'workers/edge-router/src/index.ts': EDGE,
				'workers/cdn-api/src/a.ts': handler("\treturn c.req.header('X-User-Id');"),
			}),
			'G6',
			/cdn-api reads X-User-Id but c\.env\.CDN_API_BASE lacks injectUserId/
		),
		null
	);
});

// ── G7 ──

test('G7: an ALIASED resolver import is still a resolver', () => {
	const SRC =
		"import { resolveGrantee as rg } from '@wolffm/worker-utils/identity';\n" +
		handler("\treturn rg(c.env, { name: 'x' });");
	withSite(SRC, '', (r) =>
		assert.equal(missedCheck(r, 'G7', /binds neither SESSIONS_KV nor edge-router/), null)
	);
});

for (const [shape, toml] of [
	['an [env.*] kv table', '[[env.staging.kv_namespaces]]\nbinding = "SESSIONS_KV"\nid = "abc"\n'],
	['a d1 table', '[[d1_databases]]\nbinding = "SESSIONS_KV"\ndatabase_id = "abc"\n'],
	[
		'an [env.*] services table',
		'[[env.staging.services]]\nbinding = "EDGE"\nservice = "edge-router"\n',
	],
]) {
	test(`G7: a binding under ${shape} does not count`, () => {
		withSite(RESOLVER, toml, (r) => assert.equal(missedCheck(r, 'G7', /binds neither/), null));
	});
}

test('G7: an inline top-level kv_namespaces array binds the registry', () => {
	withSite(RESOLVER, 'kv_namespaces = [{ binding = "SESSIONS_KV", id = "abc" }]\n', (r) =>
		assert.equal(r.code, 0, r.out)
	);
	withSite(RESOLVER, 'kv_namespaces = [\n  { binding = "SESSIONS_KV", id = "abc" },\n]\n', (r) =>
		assert.equal(r.code, 0, r.out)
	);
});

/**
 * #113: G7 binds to the IMPORT, not the spelling. hadoku-watchparty defines its
 * own `resolveRegistryName` (a whoami wrapper, no registry anywhere near it)
 * and calls it from a route; matching the bare name reported both files and
 * kept `ci:identity-model` red for six days. A sibling with no SIBLING_WORKERS
 * entry is used on purpose: any call G7 counted there is a hard finding.
 * MUTATION: match `REGISTRY_READER_NAMES` by name again and this goes red.
 */
test('G7: a LOCAL function sharing a resolver name is not a resolver (#113)', () => {
	withSibling(
		'hadoku-watchparty',
		{
			'apps/server/src/middleware/adminAuth.ts':
				'export async function resolveRegistryName(req) {\n\treturn req.headers.get("x-user-name");\n}\n' +
				'export async function other(req) {\n\treturn resolveRegistryName(req);\n}\n',
			'apps/server/src/http/routes/tierlist.ts':
				"import { resolveRegistryName } from '../../middleware/adminAuth.js';\n" +
				handler('\treturn resolveRegistryName(c.req);'),
		},
		(repos) => {
			const r = runFiles(
				{ 'src/ok.ts': 'export const x = 1;\n' },
				{
					extra: ['--fleet', '--allow-stale'],
					coverage: { repos: ['WolffM/hadoku-watchparty'], facets: {} },
					REPOS_DIR: repos,
				}
			);
			assert.equal(r.code, 0, r.out);
			assert.doesNotMatch(r.out, /G7/);
		}
	);
});

/**
 * The other half, or #113's fix is a false NEGATIVE: hadoku-task re-exports the
 * readers from its own `share-registry.ts` so its call sites keep one import
 * path, and a call through that module is a real registry read that needs a
 * binding. Same no-entry sibling, so being SEEN is the finding.
 */
for (const [shape, registry, more = {}] of [
	[
		'a named re-export',
		"export { resolveRegistryName, isIdentityError } from '@wolffm/worker-utils/identity';\n",
	],
	['a star re-export', "export * from '@wolffm/worker-utils/identity';\n"],
	[
		'an import then export',
		"import { resolveRegistryName } from '@wolffm/worker-utils/identity';\nexport { resolveRegistryName };\n",
	],
	[
		'two hops',
		"export { resolveRegistryName } from './inner';\n",
		{
			'worker/src/routes/inner.ts':
				"export { resolveRegistryName } from '@wolffm/worker-utils/identity';\n",
		},
	],
]) {
	test(`G7: a resolver reached through ${shape} in a local module IS a resolver`, () => {
		withSibling(
			'sib',
			{
				...more,
				'worker/src/routes/share-registry.ts': registry,
				'worker/src/routes/share-grants.ts':
					"import { resolveRegistryName as who } from './share-registry';\n" +
					handler('\treturn who(c.env, c.req);'),
			},
			(repos) => {
				const r = runFiles(
					{ 'src/ok.ts': 'export const x = 1;\n' },
					{
						extra: ['--fleet', '--allow-stale'],
						coverage: { repos: ['WolffM/sib'], facets: {} },
						REPOS_DIR: repos,
					}
				);
				assert.equal(
					missedCheck(
						r,
						'G7',
						/sib:worker\/src\/routes\/share-grants\.ts:\d+.*no SIBLING_WORKERS entry/
					),
					null
				);
			}
		);
	});
}

test('G7: a NAMESPACE import of the identity module is still a resolver', () => {
	const SRC =
		"import * as identity from '@wolffm/worker-utils/identity';\n" +
		handler("\treturn identity.resolveGrantee(c.env, { name: 'x' });");
	withSite(SRC, '', (r) =>
		assert.equal(missedCheck(r, 'G7', /binds neither SESSIONS_KV nor edge-router/), null)
	);
});

// ── G8 ──

test('G8: a credential DESTRUCTURED out of its holder is tainted', () => {
	const SRC = `
export async function handler(c, db) {
	const { credential } = c.get('authContext');
	await db.prepare('INSERT INTO t (created_by) VALUES (?)').bind(credential).run();
}
`;
	withSite(SRC, KV_BINDING, (r) =>
		assert.equal(missedCheck(r, 'G8', /`credential` is read from a credential/), null)
	);
});

// e2e edge simulators stamp identity on purpose (2026-10-11): cardtable
// `e2e/edge.ts`, bomberman `e2e/edge-stub.mjs`. The directory exempts; a name
// that merely looks like a helper does not.
const E2E_STAMP = "export const h = { 'X-Hadoku-Tier': 'admin', 'X-User-Id': 'u1' };\n";

test('G5: an e2e/ edge simulator is a test, not a stamp', () => {
	for (const rel of ['e2e/edge.ts', 'e2e/edge-stub.mjs', 'apps/web/e2e/edge.ts']) {
		const r = runFiles({ [rel]: E2E_STAMP });
		assert.equal(r.code, 0, `${rel}:\n${r.out}`);
	}
});

test('G5: a file that only NAMES e2e is still shipped code', () => {
	for (const rel of ['src/e2e-helper.ts', 'src/edge.stub.ts']) {
		assert.equal(missedCheck(runFiles({ [rel]: E2E_STAMP }), 'G5'), null, rel);
	}
});

// ── fleet-manager#7: siblings are read SHIPPED, never off REPOS_DIR ──

test('#7: an unreadable roster repo is a missing checkout, with the reason', () => {
	withRemotes((repos, remotes) => {
		remotes.push('WolffM/sib', { 'src/ok.ts': 'export const x = 1;\n' });
		const r = runFiles(
			{ 'src/ok.ts': 'export const x = 1;\n' },
			{
				extra: ['--fleet', '--allow-stale'],
				coverage: { repos: ['WolffM/sib', 'WolffM/never-pushed'], facets: {} },
				REPOS_DIR: repos,
			}
		);
		assert.equal(r.code, 1, r.out);
		assert.match(r.out, /WolffM\/never-pushed: fetch from .* failed/);
	});
});

/**
 * A LOCAL CLONE CANNOT CHANGE THE VERDICT. The baseline holds a clone under
 * REPOS_DIR that matches the shipped branch, with that branch as its origin.
 * Then it is replaced by one that is CRLF, BEHIND (its last commit holds a
 * schema the remote never shipped) and DIRTY (an uncommitted G3 read). The
 * `--fleet` verdict must not move. Revert the gate to scanning REPOS_DIR and
 * the poisoned run reports the dirty file.
 */
test('#7: a CRLF, stale, dirty clone under REPOS_DIR does not change the verdict', () => {
	withRemotes((repos, remotes) => {
		const files = { 'src/ok.ts': 'export const x = 1;\n' };
		remotes.push('WolffM/sib', files);
		const runIt = () =>
			runFiles(
				{ 'src/ok.ts': 'export const x = 1;\n' },
				{
					extra: ['--fleet', '--json', '--allow-stale'],
					coverage: { repos: ['WolffM/sib'], facets: {} },
					REPOS_DIR: repos,
				}
			);
		const clone = poisonedClone(repos, 'WolffM/sib', files);
		gitIn(clone, ['remote', 'add', 'origin', remotes.remote('WolffM/sib')]);
		const baseline = runIt();
		assert.equal(baseline.code, 0, baseline.out);

		rmSync(clone, { recursive: true, force: true });
		poisonedClone(
			repos,
			'WolffM/sib',
			{ ...files, 'src/schema.sql': 'CREATE TABLE t (voter_key TEXT);' },
			{
				crlf: true,
				edit: {
					'src/wip.ts': handler('\tconst { userId } = await c.req.json();\n\treturn userId;'),
				},
			}
		);
		const poisoned = runIt();
		assert.equal(poisoned.code, baseline.code, poisoned.out);
		assert.deepEqual(jsonDoc(poisoned).violations, jsonDoc(baseline).violations);
		assert.equal(jsonDoc(poisoned).scanned, 2, 'the sibling must have been scanned');
	});
});
