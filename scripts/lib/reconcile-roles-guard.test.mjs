/**
 * Every node command reconcile runs names the role it acts as, and the runner's
 * own steps act as `ci`. On 2026-11-04 `fleet reconcile --confirm` registered
 * WolffM/hadoku-fleet-manager on claw-10 under the ADMIN user: its ssh() was
 * hard-wired to `as: 'admin'` and the register script installs under $HOME.
 * The runner then sat outside the CI user's manager, slice and throttle, and
 * node-status blocked claw-10 on ci-user-drift.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const exec = read('./reconcile-exec.mjs');
const cli = read('../reconcile-fleet-runners.mjs');

/** Each `await ssh(` call in reconcile-exec, with the text up to its closing paren. */
const calls = [...exec.matchAll(/await ssh\(([\s\S]*?)\);/g)].map((m) =>
	m[1].replace(/\s+/g, ' ').trim()
);

test("reconcile's ssh takes the role as a required argument; no default reaches admin", () => {
	assert.match(cli, /async function ssh\(claw, script, role\) \{/);
	assert.match(cli, /if \(role !== 'admin' && role !== 'ci'\) throw/);
	assert.doesNotMatch(cli, /async function ssh\([^)]*\)\s*\{[^}]*as: 'admin'/);
});

test('register and start act as ci; every ssh call names a role', () => {
	assert.ok(calls.length >= 5, `found ${calls.length} ssh calls`);
	for (const c of calls) assert.match(c, /, ('ci'|'admin'|as) ?,?$/, `no role: ssh(${c})`);
	assert.ok(
		calls.some((c) => /registerScript\(/.test(c) && /'ci',?$/.test(c)),
		'register as ci'
	);
	assert.ok(
		calls.some((c) => /startScript\(/.test(c) && /'ci',?$/.test(c)),
		'start as ci'
	);
});

test('remove looks in the CI user first, and falls back to admin only on NOT_OURS', () => {
	assert.match(
		exec,
		/let as = 'ci';\s+let res = await ssh\(claw, removeScript\(\{[^}]*\}\), as\);/
	);
	assert.match(exec, /if \(!res\.ok && res\.stderr\.includes\('NOT_OURS'\)\) \{\s+as = 'admin';/);
});
