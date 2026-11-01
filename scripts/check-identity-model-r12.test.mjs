/**
 * G9 — R12: a person's data lives in prefs-api (fleet-manager#39).
 *
 * Every case is a mutation that must fail, or a legal shape that must pass;
 * each rule was mutation-tested (removing it fails a case here). Its own file
 * rather than a third half of check-identity-model.test.mjs, to stay under the
 * 1,000-line test ceiling; the harness is lib/identity-model-fixtures.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFiles, withSibling } from './lib/identity-model-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const G9_SCHEMA = 'workers/demo-api/migrations';

test('G9a: a table keyed by one person is a per-person store', () => {
	const r = runFiles({
		[`${G9_SCHEMA}/0001.sql`]:
			'CREATE TABLE tierlist_votes (owner_user_id TEXT, item_id TEXT NOT NULL, PRIMARY KEY (owner_user_id, item_id));\n',
	});
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /G9a/);
	assert.match(r.out, /tierlist_votes/);
});

test('G9a: a column-level PRIMARY KEY on the userId counts too', () => {
	const r = runFiles({
		[`${G9_SCHEMA}/0001.sql`]: 'CREATE TABLE prefs (user_id TEXT PRIMARY KEY, theme TEXT);\n',
	});
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /G9a/);
});

test('G9a: a shared queue naming its owner by userId, and a share between two people, are legal', () => {
	const r = runFiles({
		[`${G9_SCHEMA}/0001.sql`]: [
			'CREATE TABLE submissions (id INTEGER PRIMARY KEY, owner_user_id TEXT, url TEXT);',
			'CREATE TABLE board_shares (owner_user_id TEXT, grantee_user_id TEXT, PRIMARY KEY (owner_user_id, grantee_user_id));',
		].join('\n'),
	});
	assert.equal(r.code, 0, r.out);
});

test('G9a: a later migration that DROPS the per-person table clears it — the schema is replayed', () => {
	const r = runFiles({
		[`${G9_SCHEMA}/0001.sql`]: 'CREATE TABLE prefs (user_id TEXT PRIMARY KEY, theme TEXT);\n',
		[`${G9_SCHEMA}/0002.sql`]: 'DROP TABLE prefs;\n',
	});
	assert.equal(r.code, 0, r.out);
});

test('G9a: a credential column RENAMED to a userId becomes a per-person key', () => {
	// watchparty's shape: friend_key was the key, v6 renamed it owner_user_id.
	const r = runFiles({
		[`${G9_SCHEMA}/0001.sql`]: 'CREATE TABLE aggs (pid TEXT PRIMARY KEY, kills INTEGER);\n',
		[`${G9_SCHEMA}/0002.sql`]: 'ALTER TABLE aggs RENAME COLUMN pid TO owner_user_id;\n',
	});
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /G9a[\s\S]*aggs/);
});

test('G9a: prefs-api is where a person IS stored — its schema is exempt', () => {
	const r = runFiles({
		'workers/prefs-api/migrations/0001.sql':
			'CREATE TABLE prefs (user_id TEXT PRIMARY KEY, avatar_id TEXT);\n',
	});
	assert.equal(r.code, 0, r.out);
});

test('G9b: a display name or sprite stored beside a userId', () => {
	const r = runFiles({
		[`${G9_SCHEMA}/0001.sql`]:
			'CREATE TABLE match_players (match_id INTEGER, player_id INTEGER, owner_user_id TEXT, display_name TEXT, sprite TEXT, PRIMARY KEY (match_id, player_id));\n',
	});
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /G9b[\s\S]*display_name/);
	assert.match(r.out, /G9b[\s\S]*sprite/);
	assert.doesNotMatch(r.out, /G9a/, 'a match is shared state; only the name copy is wrong');
});

test("G9b: a bare `name` is the person's only when the row is keyed by the person alone", () => {
	const voter = runFiles({
		[`${G9_SCHEMA}/0001.sql`]:
			'CREATE TABLE voters (owner_user_id TEXT PRIMARY KEY, name TEXT NOT NULL);\n',
	});
	assert.match(voter.out, /G9b[\s\S]*`name`/);
	// A board's name is the board's, not its owner's — task-api's real shape,
	// keyed (user_id, id). The row is per person (G9a) but `name` is not theirs.
	const board = runFiles({
		[`${G9_SCHEMA}/0001.sql`]:
			'CREATE TABLE boards (id TEXT, user_id TEXT, name TEXT, PRIMARY KEY (user_id, id));\n',
	});
	assert.match(board.out, /G9a[\s\S]*boards/);
	assert.doesNotMatch(board.out, /G9b/, board.out);
});

test('G9b: an embedded schema in code is judged the same way', () => {
	const r = runFiles({
		'apps/server/src/db.ts':
			'db.exec(`\n  CREATE TABLE voters (\n    owner_user_id TEXT PRIMARY KEY,\n    avatar_url TEXT\n  );\n`);\n',
	});
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /G9a/);
	assert.match(r.out, /G9b[\s\S]*avatar_url/);
});

test('G9b: a file record holding a userId and a name, written through a const', () => {
	// cardtable's music-reviews.jsonl (hadoku-cardtable#25).
	const SRC = `
import { appendFile } from 'node:fs/promises';
export async function save(req, target) {
	const record = { at: Date.now(), userId: req.userId, name: req.userName, slots: {} };
	await appendFile(target, \`\${JSON.stringify(record)}\\n\`);
}
`;
	const r = runFiles({ 'apps/server/src/reviews.ts': SRC });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /G9b/);
	// The same record without the name copy is legal.
	const ok = runFiles({ 'apps/server/src/reviews.ts': SRC.replace('name: req.userName, ', '') });
	assert.equal(ok.code, 0, ok.out);
});

test('G9a: a file written to a path built from a userId is a per-person store', () => {
	const r = runFiles({
		'apps/server/src/store.ts':
			"import { writeFileSync } from 'node:fs';\nexport function put(dir, userId, v) { writeFileSync(`${dir}/${userId}.json`, JSON.stringify(v)); }\n",
	});
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /G9a[\s\S]*file store keyed by userId/);
});

test('G9c: a participant id derived from the X-User-Key credential', () => {
	// hadoku-cardtable#2: the credential wins over X-User-Id and is hashed into the id.
	const SRC = `
export function identityFromHeaders(headers, socketId) {
	return deriveParticipantId({ friendKey: headerValue(headers, 'x-user-key'), deviceId: headerValue(headers, 'x-user-id'), socketId });
}
`;
	const r = runFiles({ 'apps/server/src/identity.ts': SRC });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /G9c/);
});

test('G9c: a hash chain fed a friend key, and a digest helper fed one', () => {
	for (const src of [
		"import { createHash } from 'node:crypto';\nexport const id = (friendKey) => createHash('sha256')\n  .update(friendKey)\n  .digest('hex');\n",
		"export const id = (input) => digest('d', 'account', input.friendKey);\n",
	]) {
		const r = runFiles({ 'apps/server/src/id.ts': src });
		assert.equal(r.code, 1, `${src}\n${r.out}`);
		assert.match(r.out, /G9c/);
	}
});

test('G9c: hashing content, or an update() that is not a hash step, is not an identity', () => {
	const SRC = `
import { createHash } from 'node:crypto';
export const etag = (data) => createHash('sha1').update(data).digest('base64url');
export const save = (db, friendKey) => db.update(friendKey);
`;
	const r = runFiles({ 'apps/server/src/etag.ts': SRC });
	assert.doesNotMatch(r.out, /G9c/, r.out);
});

test('G9: a test file is never a store', () => {
	const r = runFiles({
		'apps/server/src/id.test.ts':
			"import { createHash } from 'node:crypto';\nconst id = createHash('sha256').update(friendKey).digest('hex');\n",
	});
	assert.equal(r.code, 0, r.out);
});

// The gate's own fixtures are deliberate violations. On 2026-10-31 a pure-move
// split put them under names the self-exclusion did not know, and the live
// fleet scan reported fleet-manager nine times that night (G1, G3, G4, G7).
// Shipping the REAL files as a sibling is the only way this can regress.
test('the gate does not report its own test files and fixtures, whatever they are called', () => {
	const own = [
		'scripts/check-identity-model.test.mjs',
		'scripts/check-identity-model-blindspots.test.mjs',
		'scripts/check-identity-model-r12.test.mjs',
		'scripts/lib/identity-model-fixtures.mjs',
	];
	const files = Object.fromEntries(
		own.map((rel) => [rel, readFileSync(join(HERE, '..', rel), 'utf8')])
	);
	withSibling('hadoku-fleet-manager', files, (repos) => {
		const r = runFiles(
			{},
			{
				extra: ['--fleet'],
				coverage: { repos: ['WolffM/hadoku-fleet-manager'], facets: {} },
				REPOS_DIR: repos,
			}
		);
		assert.equal(r.code, 0, r.out);
		assert.doesNotMatch(r.out, /hadoku-fleet-manager:/, r.out);
	});
});

test('erasableFrom maps a sibling by repoName and a site worker by workers/<id>-api/', async () => {
	const { erasableFrom } = await import('./lib/identity-r12.mjs');
	const e = erasableFrom({
		apps: [
			{ id: 'task', repoName: 'hadoku-task', erase: { path: '/api/_account/erase' } },
			{ id: 'study', repoName: 'hadoku-study' },
		],
	});
	assert.equal(e('hadoku-task', 'worker/migrations/0002.sql'), true);
	assert.equal(e(null, 'workers/task-api/migrations/0002.sql'), true);
	assert.equal(e('hadoku-study', 'x.sql'), false, 'no erase declared');
	assert.equal(e(null, 'workers/study-api/migrations/1.sql'), false);
	assert.equal(erasableFrom(null)('hadoku-task', 'x'), false, 'nothing readable, nothing erasable');
});

// R12 AS AMENDED 2026-11-01: a person's app data may stay in the app when the app
// declares an erase hook that account deletion calls. G9a is then not a finding;
// G9b (a stored name) still is.
const ERASABLE_DEMO = JSON.stringify({
	apps: [{ id: 'demo', repoName: 'hadoku-demo', erase: { path: '/api/_account/erase' } }],
});
const VOTES =
	'CREATE TABLE tierlist_votes (owner_user_id TEXT, item_id TEXT NOT NULL, PRIMARY KEY (owner_user_id, item_id));\n';

test('G9a: a per-person table in an app that declares an erase hook is not a finding', () => {
	const r = runFiles({
		'scripts/child-apps.json': ERASABLE_DEMO,
		[`${G9_SCHEMA}/0001.sql`]: VOTES,
	});
	assert.doesNotMatch(r.out, /G9a/, r.out);
});

test('G9a: the same table in an app with no erase hook still fails, and says how to fix it', () => {
	const other = JSON.stringify({
		apps: [{ id: 'other', repoName: 'hadoku-other', erase: { path: '/x' } }],
	});
	const r = runFiles({ 'scripts/child-apps.json': other, [`${G9_SCHEMA}/0001.sql`]: VOTES });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /G9a/);
	assert.match(r.out, /declares no erase hook/);
});

test('G9b: an erase hook does not excuse a stored name beside a userId', () => {
	const r = runFiles({
		'scripts/child-apps.json': ERASABLE_DEMO,
		[`${G9_SCHEMA}/0001.sql`]:
			'CREATE TABLE people_seen (room_id TEXT, user_id TEXT, display_name TEXT, PRIMARY KEY (room_id, user_id));\n',
	});
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /G9b/);
});

test('erasableFrom maps a sibling by repoName and a site worker by workers/<id>-api/', async () => {
	const { erasableFrom } = await import('./lib/identity-r12.mjs');
	const e = erasableFrom({
		apps: [
			{ id: 'task', repoName: 'hadoku-task', erase: { path: '/api/_account/erase' } },
			{ id: 'study', repoName: 'hadoku-study' },
		],
	});
	assert.equal(e('hadoku-task', 'worker/migrations/0002.sql'), true);
	assert.equal(e(null, 'workers/task-api/migrations/0002.sql'), true);
	assert.equal(e('hadoku-study', 'x.sql'), false, 'no erase declared');
	assert.equal(e(null, 'workers/study-api/migrations/1.sql'), false);
	assert.equal(erasableFrom(null)('hadoku-task', 'x'), false, 'nothing readable, nothing erasable');
});
