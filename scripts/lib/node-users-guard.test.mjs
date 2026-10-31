/**
 * Node users are a first-party concept (operator, 2026-10-27): every piece of
 * code that acts on a node names the ROLE it acts as, and only
 * `src/lib/node-users.ts` turns a role into a user. Three structural rules,
 * because a behaviour test cannot see the call site that forgot:
 *
 *   1. NO USER IN CODE. No user name, uid-1000 path or `/home/<name>`, and no
 *      `id -un`/`whoami` used to work out who a role is. Everything acted
 *      as "whoever logged in" until the cutover made that two people.
 *   2. EVERY runOn / runOnSync CALL NAMES ITS ROLE (`as:`). There is a
 *      default, `admin`, so that a forgotten role fails safe, but a call that
 *      relies on it is a decision nobody made.
 *   3. EVERY HAND-ROLLED ssh OR rsync GOES THROUGH `sshDestination`. A bare
 *      `node` argument logs in as whoever the ssh config says.
 *
 * COMMENTS ARE BLANKED FIRST (`blank-comments.mjs`), as in
 * node-identity-guard: the prose explaining the rule quotes what it forbids.
 * Shell files lose their `#` comments the same way.
 *
 * ALLOWED is keyed `rule:file`, every entry with its reason. A stale entry
 * FAILS: an exemption that matches nothing is a rule nobody is reading.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const ALLOWED = {
	'literal:src/lib/node-users.ts': 'the registry: the one place a name and a home are spelled',
	'literal:scripts/lib/fleet-source.mjs':
		"`.cache/hadoku/fleet-source` is a cache directory's name, not a user",
	'literal:scripts/check-identity-model.mjs':
		'a message about website user ids (the identity-model gate), not a node user',
	'literal:scripts/fixes/claw-admin-fix.sh':
		'a one-off repair from 2026-08-17, run by hand before the registry existed; kept as the record',
	'literal:scripts/runners-slice-install.sh':
		"the slice unit's Documentation= URL into the operator's checkout, not an identity",
	'literal:scripts/lib/toolchain-floor.mjs':
		"pm2-boot reads its own user with `id -un`: pm2 is admin's, and the entry must move to an admin-run check before a cutover (node-users plan P2)",
	'literal:scripts/lib/reconcile-scripts.mjs':
		'a log line printing who wrote the toolcache path; it decides nothing',
	'literal:scripts/add-dvd.sh':
		"the operator at hokon's own terminal (`SUDO_USER`), not a node role",
	'literal:scripts/node-usb-prep.sh':
		"the operator at hokon's own terminal (`SUDO_USER`), not a node role",
	'literal:scripts/onboarding.sh':
		"the operator at hokon's own terminal (`SUDO_USER`), not a node role",
	'literal:scripts/refresh-preseed.sh':
		"the operator at hokon's own terminal (`SUDO_USER`), not a node role",
	'ssh:scripts/enroll-node.mjs':
		'enrollment reaches a box BEFORE the manifest names it, at the address and user it booted with',
};

/** Rule 1: the shapes a user takes in code. */
const LITERAL =
	/\/home\/(?:hadoku|\$\{)|user@1000|\/run\/user\/1000|user-1000\.slice|['"`]hadoku['"`]|\bid -un\b|\bwhoami\b/;

function files(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (['node_modules', 'dist', 'planning', 'tests'].includes(entry)) continue;
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) files(p, out);
		else if (/\.(ts|mjs|sh)$/.test(entry) && !/\.test\./.test(entry)) out.push(p);
	}
	return out;
}

const blank = (path, src) =>
	path.endsWith('.sh')
		? src
				.split('\n')
				.map((l) => l.replace(/(^|\s)#.*$/, '$1'))
				.join('\n')
		: blankComments(src);

const SOURCES = ['src', 'scripts'].flatMap((d) => files(join(ROOT, d)));
const CODE = new Map(
	SOURCES.map((abs) => {
		const rel = relative(ROOT, abs);
		return [rel, blank(rel, readFileSync(abs, 'utf8'))];
	})
);

/** The text of the call starting at `open` (just past its `(`), to its matching `)`. */
function callText(code, open) {
	let depth = 1;
	let str = null;
	let i = open;
	for (; i < code.length && depth > 0; i++) {
		const c = code[i];
		if (str) {
			if (c === '\\') i++;
			else if (c === str) str = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') str = c;
		else if ('([{'.includes(c)) depth++;
		else if (')]}'.includes(c)) depth--;
	}
	return code.slice(open, i);
}

const hits = { literal: [], role: [], ssh: [] };
const exempt = new Set();
const flag = (rule, file, line, what) => {
	const key = `${rule}:${file}`;
	if (ALLOWED[key]) exempt.add(key);
	else hits[rule].push(`${file}:${line}  ${what}`);
};
const lineOf = (code, at) => code.slice(0, at).split('\n').length;

for (const [file, code] of CODE) {
	code.split('\n').forEach((l, i) => {
		if (LITERAL.test(l)) flag('literal', file, i + 1, l.trim().slice(0, 100));
	});
	if (file === 'scripts/lib/fleet-exec.mjs' || file.endsWith('.sh')) continue;
	for (const m of code.matchAll(/\brunOn(?:Sync)?\(/g)) {
		if (/function\s+$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
		const text = callText(code, m.index + m[0].length);
		if (!/\bas:\s*['"`]?\w/.test(text))
			flag('role', file, lineOf(code, m.index), text.split('\n')[0].trim().slice(0, 80));
	}
	if (file === 'src/lib/node-users.ts') continue;
	const spawns =
		/\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*['"`](?:ssh|rsync)['"`]|\[\s*['"`]ssh['"`],\s*\[/g;
	for (const m of code.matchAll(spawns)) {
		const open = m[0].startsWith('[') ? m.index + 1 : code.indexOf('(', m.index) + 1;
		const text = callText(code, open);
		if (/^\s*['"`]ssh['"`],\s*\[\s*['"`]-G['"`]/.test(text)) continue; // a config read reaches no node
		// An argv built just above the spawn (`spawn('ssh', argv)`) is checked where it was built.
		const near = /^\s*['"`]\w+['"`],\s*\w+\s*[,)]/.test(text)
			? code.slice(Math.max(0, m.index - 4000), m.index)
			: '';
		if (!/sshDestination\(/.test(text + near))
			flag('ssh', file, lineOf(code, m.index), text.split('\n')[0].trim().slice(0, 80));
	}
}

void test('no user appears in code: a role is answered by src/lib/node-users.ts alone', () => {
	assert.deepEqual(hits.literal, []);
});

void test('every runOn/runOnSync call names the role it acts as', () => {
	assert.deepEqual(hits.role, []);
});

void test('every hand-rolled ssh or rsync logs in through sshDestination', () => {
	assert.deepEqual(hits.ssh, []);
});

void test('every exemption still matches something', () => {
	assert.deepEqual(
		Object.keys(ALLOWED).filter((k) => !exempt.has(k)),
		[]
	);
});

void test('the guard itself sees the shapes it forbids', () => {
	assert.ok(LITERAL.test("const u = 'hadoku';"));
	assert.ok(LITERAL.test('cd /home/hadoku/x'));
	assert.ok(LITERAL.test('u=$(id -un)'));
	assert.ok(!LITERAL.test("nodeUser(m, 'ci')"));
	assert.equal(callText("(a, b, { as: 'ci', x: f(1) }) + 1", 1), "a, b, { as: 'ci', x: f(1) })");
});
