/**
 * F7 (plan §4.1): no `site-docs` reader exists yet, so every caller resolves
 * and parses `pm2-hosts.json`/`child-apps.json` itself, each with its own
 * filter on top.
 *
 * THE PATTERN: a call that BUILDS A PATH to, or reads, one of the two files —
 * `join(siteRoot(), 'scripts', 'pm2-hosts.json')`, `read('pm2-hosts.json')`,
 * `readFileSync(resolve(..., 'scripts/child-apps.json'))` — as opposed to a
 * line that merely MENTIONS the filename in a comment or an error string. A
 * bare string mention is not a reader, so this only matches the filename as
 * the argument of a path/read-shaped call (`join`, `resolve`, `read`,
 * `readFile`, `readFileSync`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tsAndMjsSources, lineOf, enclosingSymbol, assertDebt, loadDebt } from './lib.mjs';

// `.*?` (not `[^)]*?`): the common shape is `join(siteRoot(), 'scripts', 'pm2-hosts.json')`,
// whose nested `siteRoot()` closes a `)` before the filename — a class that excludes `)`
// entirely can never cross it. These calls are single-line, so `.` not matching `\n` is fine.
const READ_CALL =
	/\b(?:join|resolve|readFileSync|readFile|read)\(.*?['"`](?:scripts\/)?(pm2-hosts|child-apps)\.json['"`]/g;

function find(name) {
	const out = [];
	for (const { rel, code } of tsAndMjsSources()) {
		let n = 0;
		for (const m of code.matchAll(READ_CALL)) {
			if (m[1] !== name) continue;
			n += 1;
			const sym = enclosingSymbol(code, m.index) ?? `line${lineOf(code, m.index)}`;
			out.push(`${rel}:${sym}#${n}`);
		}
	}
	return out;
}

void test('F7: pm2-hosts.json is resolved/read only where debt.json says so', () => {
	assertDebt(
		assert,
		loadDebt(),
		'F7-pm2-hosts',
		find('pm2-hosts'),
		'Read pm2-hosts.json through the shared `site-docs` reader (F7) instead of resolving ' +
			'siteRoot()/scripts/pm2-hosts.json and parsing it yourself.'
	);
});

void test('F7: child-apps.json is resolved/read only where debt.json says so', () => {
	assertDebt(
		assert,
		loadDebt(),
		'F7-child-apps',
		find('child-apps'),
		'Read child-apps.json through the shared `site-docs` reader (F7) instead of resolving ' +
			'siteRoot()/scripts/child-apps.json and parsing it yourself.'
	);
});

void test('F7: the guard reads a path-building call, not a bare mention', () => {
	assert.equal([...`join(siteRoot(), 'scripts', 'pm2-hosts.json')`.matchAll(READ_CALL)].length, 1);
	const errorMessage = 'pm2-hosts.json names tunnel "${declared}"';
	assert.equal([...errorMessage.matchAll(READ_CALL)].length, 0);
});
