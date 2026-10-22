/**
 * claw-fix.sh is expected to GROW. Every new fault found on a node becomes a
 * check, and most become a repair. These two halves live ~200 lines apart, so
 * they will drift unless something holds them together.
 *
 * A check with no repair is the worse direction: it reports a fault, offers
 * nothing, and reads like the script simply failed to fix it. Some genuinely
 * cannot be fixed from software — no controller, no cable, an unnamed box — and
 * those are DECLARED in UNREPAIRABLE, so a deliberate omission is
 * distinguishable from a forgotten one.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'claw-fix.sh');
const RAW = readFileSync(SCRIPT, 'utf8');

/**
 * Comments cannot be evidence, and cannot trip the rule either. This repo has
 * read a COMMENT as proof of a rule three separate times; blanking them keeps
 * prose from both satisfying and breaking the gate.
 */
const SRC = RAW.split('\n')
	.map((l) => (/^\s*#/.test(l) ? '' : l))
	.join('\n');

/** The body of a top-level shell function, `name() {` to a `}` at column 0. */
function body(name) {
	const start = SRC.indexOf(`${name}() {`);
	assert.notEqual(start, -1, `${name}() not found — the script was restructured`);
	const end = SRC.indexOf('\n}', start);
	assert.notEqual(end, -1, `${name}() has no closing brace at column 0`);
	return SRC.slice(start, end);
}

const CHECKS = [
	...new Set([...body('diagnose').matchAll(/\brecord\s+([a-z0-9_]+)\s/g)].map((m) => m[1])),
];
const REPAIRS = [
	...new Set(
		[...body('repair').matchAll(/state_of\s+([a-z0-9_]+)\)"\s*=\s*FAIL/g)].map((m) => m[1])
	),
];
const UNREPAIRABLE = (SRC.match(/^UNREPAIRABLE="([^"]*)"/m)?.[1] ?? '')
	.split(/\s+/)
	.filter(Boolean);

test('the script actually declares checks — an empty parse asserts nothing', () => {
	assert.ok(CHECKS.length >= 10, `only ${CHECKS.length} checks parsed; the regex has drifted`);
	assert.ok(REPAIRS.length >= 5, `only ${REPAIRS.length} repairs parsed`);
	assert.ok(UNREPAIRABLE.length > 0, 'UNREPAIRABLE did not parse');
});

test('every check either has a repair or is declared unrepairable', () => {
	const orphans = CHECKS.filter((c) => !REPAIRS.includes(c) && !UNREPAIRABLE.includes(c));
	assert.deepEqual(
		orphans,
		[],
		`these checks report a fault and offer nothing: ${orphans.join(', ')}. ` +
			`Add a repair branch in repair(), or add the id to UNREPAIRABLE if it needs hands.`
	);
});

test('every repair belongs to a check that is actually recorded', () => {
	const orphans = REPAIRS.filter((r) => !CHECKS.includes(r));
	assert.deepEqual(
		orphans,
		[],
		`these repairs are guarded by a check id nobody records, so they can never run: ${orphans.join(', ')}`
	);
});

test('nothing is both repairable and declared unrepairable', () => {
	const both = UNREPAIRABLE.filter((u) => REPAIRS.includes(u));
	assert.deepEqual(
		both,
		[],
		`contradictory: ${both.join(', ')} has a repair AND is declared unfixable`
	);
});

test('UNREPAIRABLE names only ids that are really checked', () => {
	// A stale entry here silently excuses a check that no longer exists, and
	// would excuse a NEW check that happened to reuse the name.
	const stale = UNREPAIRABLE.filter((u) => !CHECKS.includes(u));
	assert.deepEqual(stale, [], `UNREPAIRABLE names ids that no check records: ${stale.join(', ')}`);
});

test('--check performs no writes', () => {
	// A check that mutates the box is not a check, and this one gets run on
	// healthy nodes to compare against a sick one. The earlier version called
	// `ip link set up` unconditionally.
	// The one mutation the diagnose phase would otherwise perform.
	const ipUp = SRC.split('\n').filter((l) => l.includes('ip link set'));
	assert.ok(ipUp.length > 0, 'the carrier check no longer brings interfaces up at all');
	for (const line of ipUp) {
		assert.match(
			line,
			/CHECK_ONLY" = 0/,
			`\`ip link set\` runs unguarded under --check: ${line.trim()}`
		);
	}
	assert.match(SRC, /--check: nothing was changed/, '--check never says it changed nothing');
	// The repair phase must be unreachable under --check.
	assert.match(SRC, /if \[ "\$CHECK_ONLY" = 1 \]; then/, '--check does not gate the repair phase');
});

test('every run writes a bundle, and says where', () => {
	assert.match(SRC, /collect before/, 'nothing is captured before the checks run');
	assert.match(SRC, /collect after/, 'nothing is captured after a repair');
	assert.match(SRC, /Diagnostics:/, 'the bundle location is never printed');
});

test('the script is valid POSIX sh', () => {
	// THE GATE THAT WAS MISSING. Every other test here parses the source as
	// text, so all seven stayed green on a script with an unclosed `if` that
	// would not run at all. A structural gate that cannot notice the file is
	// broken is checking the wrong thing.
	const r = spawnSync('sh', ['-n', SCRIPT], { encoding: 'utf8' });
	assert.equal(r.status, 0, `sh -n rejected the script:\n${r.stderr}`);
});

test('every fix script in this directory is valid for its shebang', () => {
	for (const f of readdirSync(dirname(SCRIPT))) {
		if (!f.endsWith('.sh')) continue;
		const path = join(dirname(SCRIPT), f);
		const shell = readFileSync(path, 'utf8').split('\n')[0].includes('bash') ? 'bash' : 'sh';
		const r = spawnSync(shell, ['-n', path], { encoding: 'utf8' });
		assert.equal(r.status, 0, `${shell} -n rejected ${f}:\n${r.stderr}`);
	}
});
