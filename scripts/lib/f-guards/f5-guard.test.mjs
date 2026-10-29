/**
 * F5 (plan §4.1): one node-exec helper per language. The JS/TS half already
 * has it — `runOn`/`runOnSync` in `scripts/lib/fleet-exec.mjs`, `nodeShell`
 * in `src/node-shell.ts` — but four ad hoc wrappers call `ssh`/`rsync`
 * directly instead.
 *
 * THE PATTERN: any call whose first argument is the literal `'ssh'` or
 * `'rsync'` (a direct `execFile(Sync)`/`spawn(Sync)`, OR a local wrapper
 * called the same way, which is how `benchmark-fleet.mjs` and `toolpack.mjs`
 * do it), outside the two canonical files. Two shapes are exempted, same as
 * `node-users-guard`'s ssh rule:
 *
 *   - `ssh -G <host>`: reads the LOCAL ssh config/resolver, reaches no node.
 *   - pre-enrolment ssh (`enroll-node.mjs`): the box is not in the manifest
 *     yet, so `sshDestination`/`runOn` have nothing to look it up by. F5's
 *     own notes call for an explicit `preEnrolment` mode rather than papering
 *     over this with an exemption forever.
 *
 * `runner-mem-report.py`, `net-survey.sh` and `node-usb-prep.sh` are three
 * more copies by the plan's count, but they are Python/shell: this guard
 * reads `.ts`/`.mjs` only, for the same reason F1's does — the helper it is
 * missing is a JS/TS import, so a shell or Python copy is out of this
 * guard's language, not out of scope for the refactor. Named in the closing
 * note instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tsAndMjsSources, lineOf, enclosingSymbol, assertDebt, loadDebt } from './lib.mjs';

const CANONICAL = new Set([
	'scripts/lib/fleet-exec.mjs',
	'src/node-shell.ts',
	// `nodeCommand` builds the `['ssh', [...]]` tuple BOTH of the above call —
	// it is the shared argv builder underneath runOn/nodeShell, not a copy.
	'src/lib/node-users.ts',
]);

/**
 * Any call (builtin or a local wrapper named the same way) whose first
 * argument is 'ssh'/'rsync', OR a `['ssh', [...]]`-shaped argv tuple built
 * once and applied via `argv[0]`/`argv[1]` later (`toolpack.mjs`'s `on()`).
 *
 * The quote backreference matters: `log("ssh's every node")` opens with `"`
 * and the apostrophe inside is also a quote CHARACTER, so a character-class
 * close (`['"` ``]`) alone matches it — a false hit this guard must not
 * carry (`check-warm-canary.mjs`'s log line is exactly this trap).
 */
const RAW_CALL = /\b[A-Za-z_$][\w$]*\(\s*(['"`])(ssh|rsync)\1|\[\s*(['"`])(ssh|rsync)\3\s*,\s*\[/g;

/** `-G` reads the local ssh config/resolver and reaches no node. */
const CONFIG_READ =
	/^(?:[A-Za-z_$][\w$]*\(\s*(['"`])ssh\1|\[\s*(['"`])ssh\2)\s*,\s*\[\s*(['"`])-G\3/;

/** Pre-enrolment: the box is not in the manifest yet (F5's own noted exception). */
const EXEMPT_FILES = new Set(['scripts/enroll-node.mjs']);

function find() {
	const out = [];
	for (const { rel, code } of tsAndMjsSources()) {
		if (CANONICAL.has(rel) || EXEMPT_FILES.has(rel)) continue;
		let n = 0;
		for (const m of code.matchAll(RAW_CALL)) {
			const tail = code.slice(m.index, m.index + 200);
			if (CONFIG_READ.test(tail)) continue;
			n += 1;
			const sym = enclosingSymbol(code, m.index) ?? `line${lineOf(code, m.index)}`;
			out.push(`${rel}:${sym}#${n}`);
		}
	}
	return out;
}

void test('F5: ssh/rsync is called directly only where debt.json says so', () => {
	assertDebt(
		assert,
		loadDebt(),
		'F5',
		find(),
		'Use runOn/runOnSync (scripts/lib/fleet-exec.mjs) or nodeShell (src/node-shell.ts) instead ' +
			'of spawning ssh/rsync by hand. A bare `ssh -G` config read is exempt; everything that ' +
			'reaches a node over the network is not.'
	);
});

void test('F5: both canonical exec helpers still exist', () => {
	const byRel = new Map(tsAndMjsSources().map((s) => [s.rel, s.code]));
	assert.match(byRel.get('scripts/lib/fleet-exec.mjs'), /export function runOn\(/);
	assert.match(byRel.get('src/node-shell.ts'), /export function nodeShell\(/);
});

void test('F5: the guard sees the shape it forbids and exempts a config read', () => {
	assert.ok([...`spawn('ssh', argv)`.matchAll(RAW_CALL)].length === 1);
	assert.ok(CONFIG_READ.test(`execFileSync('ssh', ['-G', node], {})`));
});
