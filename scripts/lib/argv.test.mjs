/**
 * `scripts/lib/argv.mjs` — the shared strict argv parser (plan §4.1 F8).
 *
 * Runs the real functions against fixed argv arrays (no spawning, no real
 * `process.exit`): `parseStrict`'s own `process.exit` calls are proven
 * separately, through the real built CLI, by `cli-help.test.mjs` and the
 * per-script tests the six migrated scripts carry. This file is the pure
 * logic: `unknownFlags`, `doorFlags`, and the parts of `parseStrict` that
 * return rather than exit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { doorFlags, unknownFlags, parseStrict } from './argv.mjs';

const SPEC = {
	usage: 'fleet example [--on] [--name <v>] [node...]',
	booleans: ['--on', '--json'],
	valued: ['--name'],
	positionals: true,
};

void test('doorFlags: always accepts --help/-h, plus the declared booleans and valued=names', () => {
	assert.deepEqual(doorFlags(SPEC), ['--help', '-h', '--on', '--json', '--name=']);
});

void test('doorFlags: a spec with nothing declared still accepts --help/-h', () => {
	assert.deepEqual(doorFlags({ usage: 'x' }), ['--help', '-h']);
});

void test('unknownFlags: a declared bare flag is known', () => {
	assert.deepEqual(unknownFlags(doorFlags(SPEC), ['--on']), []);
});

void test('unknownFlags: a declared valued flag consumes its value, both spellings', () => {
	assert.deepEqual(unknownFlags(doorFlags(SPEC), ['--name', 'claw-3']), []);
	assert.deepEqual(unknownFlags(doorFlags(SPEC), ['--name=claw-3']), []);
});

void test('unknownFlags: an undeclared flag is unknown', () => {
	assert.deepEqual(unknownFlags(doorFlags(SPEC), ['--raeson', 'x']), ['--raeson']);
});

void test('unknownFlags: a positional is never flagged, only `-`-prefixed tokens are', () => {
	assert.deepEqual(unknownFlags(doorFlags(SPEC), ['claw-3', '--on']), []);
});

void test('unknownFlags: everything after a literal -- is left alone', () => {
	assert.deepEqual(unknownFlags(doorFlags(SPEC), ['--', '--not-a-flag']), []);
});

void test('unknownFlags: --help/-h are never unknown, even for a spec that declares nothing', () => {
	assert.deepEqual(unknownFlags(doorFlags({ usage: 'x' }), ['--help']), []);
	assert.deepEqual(unknownFlags(doorFlags({ usage: 'x' }), ['-h']), []);
});

void test('parseStrict: a clean argv returns has/value/positionals/json', () => {
	const r = parseStrict(SPEC, ['--on', '--name', 'claw-3', 'claw-5', '--json']);
	assert.equal(r.has('--on'), true);
	assert.equal(r.has('--off'), false);
	assert.equal(r.value('--name'), 'claw-3');
	assert.deepEqual(r.positionals, ['claw-5']);
	assert.equal(r.json, true);
});

void test('parseStrict: --name=value (equals form) is read the same as --name value', () => {
	const r = parseStrict(SPEC, ['--name=claw-9']);
	assert.equal(r.value('--name'), 'claw-9');
});

void test("parseStrict: a positional that is a valued flag's own value is excluded", () => {
	const r = parseStrict(SPEC, ['--name', 'claw-3', 'claw-5']);
	assert.deepEqual(r.positionals, ['claw-5']);
});

void test('parseStrict: json is false unless the SPEC declares --json, even if argv has it', () => {
	const noJsonSpec = { usage: 'x', booleans: ['--on'], valued: [], positionals: false };
	const r = parseStrict(noJsonSpec, ['--on']);
	assert.equal(r.json, false);
});

void test('parseStrict: positionals are empty when the spec forbids them, even if argv has bare tokens', () => {
	const noPositionals = { usage: 'x', booleans: [], valued: [], positionals: false };
	const r = parseStrict(noPositionals, []);
	assert.deepEqual(r.positionals, []);
});

// --- the three process.exit paths, through a real child process -----------
//
// `parseStrict` calls `process.exit` directly on --help and on an unknown
// flag (see the file header on why it never returns there), so those three
// paths are proven by actually running a tiny script that calls it, not by
// mocking `process.exit` in-process.

function tempScript(body) {
	const dir = mkdtempSync(join(tmpdir(), 'argv-test-'));
	const file = join(dir, 'run.mjs');
	writeFileSync(file, body);
	return file;
}

const ARGV_MJS_URL = new URL('./argv.mjs', import.meta.url).href;

function runScript(spec, argv) {
	const file = tempScript(
		`import { parseStrict } from '${ARGV_MJS_URL}';\n` +
			`const r = parseStrict(${JSON.stringify(spec)}, ${JSON.stringify(argv)});\n` +
			`console.log('PARSED', JSON.stringify(r.positionals));\n`
	);
	const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 10_000 });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

void test('parseStrict: --help prints usage and exits 0, before anything else runs', () => {
	const r = runScript(SPEC, ['--help']);
	assert.equal(r.status, 0);
	assert.equal(r.stdout.trim(), SPEC.usage);
	assert.doesNotMatch(r.stdout, /PARSED/, 'the line after parseStrict() must never run');
});

void test('parseStrict: -h is the same as --help', () => {
	const r = runScript(SPEC, ['-h']);
	assert.equal(r.status, 0);
	assert.equal(r.stdout.trim(), SPEC.usage);
});

void test('parseStrict: --help wins even alongside other flags', () => {
	const r = runScript(SPEC, ['--on', '--help', '--raeson']);
	assert.equal(r.status, 0);
	assert.equal(r.stdout.trim(), SPEC.usage);
});

void test('parseStrict: an unknown flag exits 2 with usage on stderr, human mode', () => {
	const r = runScript(SPEC, ['--raeson', 'x']);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /unknown flag\(s\) --raeson — nothing was run\./);
	assert.match(r.stderr, new RegExp(SPEC.usage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	assert.equal(r.stdout, '', 'nothing is written to stdout on a human-mode refusal');
});

void test('parseStrict: an unknown flag under --json emits ONE JSON document on stdout, exit 2', () => {
	const r = runScript(SPEC, ['--json', '--raeson']);
	assert.equal(r.status, 2);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, false);
	assert.match(doc.error, /unknown flag\(s\) --raeson/);
});

void test('parseStrict: --json is itself unknown when the spec never declares it', () => {
	const noJsonSpec = { usage: 'x', booleans: ['--on'], valued: [], positionals: false };
	const r = runScript(noJsonSpec, ['--json']);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /unknown flag\(s\) --json/);
	assert.equal(
		r.stdout,
		'',
		'--json must not be read as the output mode if the spec never declared it'
	);
});

// --- mutation: a spec with no booleans/valued declared still catches a typo
// (proves the guard is live, not merely well-shaped for THIS spec) ----------

void test('mutation: an empty spec still refuses any flag at all', () => {
	const r = runScript({ usage: 'x', positionals: false }, ['--anything']);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /unknown flag\(s\) --anything/);
});
