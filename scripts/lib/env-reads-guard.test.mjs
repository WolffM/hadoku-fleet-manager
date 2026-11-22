/**
 * `ENV_READS` (src/env-reads.ts) is the whole list of environment variables
 * this package reads (fleet-manager#81). hadoku_site builds the CLI's child env
 * from it, so a read the list does not name is a nightly job that breaks the
 * day mgmt-api stops passing its whole env, and a name nothing reads is a
 * secret handed to a subprocess for nothing.
 *
 * Read shapes, all from the comment-blanked source of every non-test file
 * under src/ and scripts/:
 *   - literal: `process.env.X`, `process.env['X']`, `env.X`, `env['X']`
 *     (`env` is the `env = process.env` parameter many helpers take; any other
 *     object called `env` over-matches, which only ever asks for MORE names);
 *   - by constant: `const X_ENV = 'NAME'`, read through `fromEnv(X_ENV)` or
 *     `env[X_ENV]`: the constant's value is the name read;
 *   - computed from anything else: must be a site in COMPUTED below, with the
 *     names it can read, or the guard fails and says where.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENV_READS, envNamesForCaller } from '../../dist/env-reads.js';
import { tsAndMjsSources } from './f-guards/lib.mjs';

/**
 * Computed reads the patterns cannot resolve. Each site declares the names it
 * can read (`names`) or a pattern that extracts them from the file (`via`), so
 * a new name at the site is still caught.
 */
const COMPUTED = {
	// githubToken(): for (const k of ['HADOKU_SITE_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'])
	'scripts/lib/floor-probe-dispatch.mjs': {
		names: ['HADOKU_SITE_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'],
	},
	// fromEnv(name)'s own body; its callers are resolved through FROM_ENV.
	'src/lib/fleet-config.ts': { names: [] },
	// standaloneHost: const required = (name) => env[name]; required('X').
	'src/standalone.ts': { via: /\brequired\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g },
	// Copy the whole env minus GIT_*; no named value is read.
	'scripts/lib/identity-scan.mjs': { names: [] },
	'scripts/lib/test-git-identity.mjs': { names: [] },
	// `fleet node-users --dev <node>` reads the node's lease key, KEY_SERVICE_<NODE>_SESSIONS
	// (leaseKeyItem), and its GitHub token, <NODE>_SESSIONS_GH_TOKEN (ghTokenItem): names per
	// session node, so no fixed list. Only the operator's CLI run
	// under the site's dev-vault reads it; mgmt-api never runs --dev and must not pass it.
	'scripts/node-users-dev.mjs': { names: [] },
};

const LITERAL =
	/(?:\bprocess\.env|(?<![\w.$-])env)\??(?:\.([A-Za-z_][A-Za-z0-9_]*)|\.?\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;
const BRACKET = /(?:\bprocess\.env|(?<![\w.$-])env)(?:\?\.)?\[\s*([A-Za-z_$][\w$.]*)\s*\]/g;
const ENV_CONST = /\bconst\s+([A-Z][A-Z0-9_]*_ENV)\s*=\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
const FROM_ENV = /\bfromEnv\(\s*([A-Z][A-Z0-9_]*_ENV)\b/g;

function scan() {
	const sources = tsAndMjsSources().filter(({ rel }) => !rel.startsWith('src/tests/'));
	const consts = new Map();
	for (const { code } of sources) for (const m of code.matchAll(ENV_CONST)) consts.set(m[1], m[2]);
	const reads = new Map();
	const unresolved = [];
	const note = (name, rel) => {
		if (!reads.has(name)) reads.set(name, new Set());
		reads.get(name).add(rel);
	};
	for (const { rel, code } of sources) {
		for (const m of code.matchAll(LITERAL)) note(m[1] ?? m[2], rel);
		for (const m of code.matchAll(FROM_ENV)) {
			if (consts.has(m[1])) note(consts.get(m[1]), rel);
			else unresolved.push(`${rel}: fromEnv(${m[1]})`);
		}
		for (const m of code.matchAll(BRACKET)) {
			if (consts.has(m[1])) note(consts.get(m[1]), rel);
			else if (!COMPUTED[rel]) unresolved.push(`${rel}: env[${m[1]}]`);
		}
		const site = COMPUTED[rel];
		for (const n of site?.names ?? []) note(n, rel);
		if (site?.via) for (const m of code.matchAll(site.via)) note(m[1], rel);
	}
	return { reads, unresolved };
}

test('every env read in src/ and scripts/ is named in ENV_READS', () => {
	const { reads, unresolved } = scan();
	assert.deepEqual(
		unresolved,
		[],
		'a read by a computed name the guard cannot resolve: use a `const X_ENV = ` name, ' +
			'or list the site and its names in COMPUTED'
	);
	const listed = new Set(ENV_READS.map((r) => r.name));
	const missing = [...reads.keys()]
		.filter((n) => !listed.has(n))
		.map((n) => `${n} (read in ${[...reads.get(n)].join(', ')})`);
	assert.deepEqual(missing, [], 'add these to ENV_READS in src/env-reads.ts');
});

test('ENV_READS names nothing that is not read (base excepted: spawned tools read those)', () => {
	const { reads } = scan();
	const stale = ENV_READS.filter((r) => r.scope !== 'base' && !reads.has(r.name)).map(
		(r) => r.name
	);
	assert.deepEqual(stale, [], 'remove these from ENV_READS, or say where they are read');
});

test('ENV_READS has one row per name, and a caller is never told to pass a test seam', () => {
	const names = ENV_READS.map((r) => r.name);
	assert.equal(new Set(names).size, names.length);
	const seams = new Set(ENV_READS.filter((r) => r.scope === 'test').map((r) => r.name));
	assert.ok(envNamesForCaller().every((n) => !seams.has(n)));
	assert.ok(envNamesForCaller().includes('FLEET_GH_APP_KEY'));
	assert.ok(envNamesForCaller().includes('SSH_AUTH_SOCK'));
});

test('the guard sees each read shape it claims to', () => {
	const shapes = [
		'process.env.FOO_A; process.env[\'FOO_B\']; env.FOO_C; env["FOO_D"]; env?.FOO_F',
		"const FOO_E_ENV = 'FOO_E'; fromEnv(FOO_E_ENV); env?.[FOO_E_ENV]",
	].join('\n');
	const found = [...shapes.matchAll(LITERAL)].map((m) => m[1] ?? m[2]);
	assert.deepEqual(found, ['FOO_A', 'FOO_B', 'FOO_C', 'FOO_D', 'FOO_F']);
	assert.deepEqual(
		[...shapes.matchAll(ENV_CONST)].map((m) => m[2]),
		['FOO_E']
	);
	assert.deepEqual(
		[...shapes.matchAll(FROM_ENV)].map((m) => m[1]),
		['FOO_E_ENV']
	);
	assert.deepEqual(
		[...shapes.matchAll(BRACKET)].map((m) => m[1]),
		['FOO_E_ENV']
	);
});
