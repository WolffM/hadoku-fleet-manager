/**
 * `runFleetScript` had no test file of its own before this (F6, plan §4.1):
 * its two live callers (`converge-provisioning.mjs`, `reconcile-fleet-runners.mjs`)
 * only exercise the happy path, through a real driver script. These pin the
 * SHAPE this module promises on top of `spawn-json.mjs`'s `spawnJsonToFile` —
 * `{code, signal, json, why}`, a node-script default and a 4000-byte stderr
 * tail — so a change to the shared helper that silently narrowed this
 * adapter's contract would be caught here, not three call sites downstream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runFleetScript } from './run-fleet-script.mjs';

/** A throwaway `.mjs` script file, for a child that is really run by node. */
function scriptFile(src) {
	const dir = mkdtempSync(join(tmpdir(), 'run-fleet-script-'));
	const path = join(dir, 'child.mjs');
	writeFileSync(path, src);
	return { dir, path };
}

test('a clean run reports the parsed doc, code 0, and an empty why', async () => {
	const { dir, path } = scriptFile('console.log(JSON.stringify({ok:true})); process.exit(0);');
	try {
		const r = await runFleetScript(path, []);
		assert.equal(r.code, 0);
		assert.equal(r.signal, null);
		assert.deepEqual(r.json, { ok: true });
		assert.equal(r.why, '');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a non-zero exit with parseable stdout is a finding, not a crash — `--json` is a contract', async () => {
	const { dir, path } = scriptFile(
		'console.log(JSON.stringify({unreachable:["claw-9"]})); process.exit(1);'
	);
	try {
		const r = await runFleetScript(path, []);
		assert.equal(r.code, 1);
		assert.deepEqual(r.json, { unreachable: ['claw-9'] });
		assert.equal(r.why, '', 'the parsed finding wins over the exit code');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('argv is passed through to the child', async () => {
	const { dir, path } = scriptFile(
		'console.log(JSON.stringify({argv: process.argv.slice(2)})); process.exit(0);'
	);
	try {
		const r = await runFleetScript(path, ['--machine', 'claw-1', '--json']);
		assert.deepEqual(r.json.argv, ['--machine', 'claw-1', '--json']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('unparseable stdout carries the exit, the parse error and the stderr tail — never a bare null', async () => {
	const { dir, path } = scriptFile(
		'process.stderr.write("the real reason\\n"); process.stdout.write("not json"); process.exit(2);'
	);
	try {
		const r = await runFleetScript(path, []);
		assert.equal(r.json, null);
		assert.equal(r.code, 2);
		assert.match(r.why, /exit 2/);
		assert.match(r.why, /unparseable/);
		assert.match(r.why, /the real reason/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('env is passed through — a caller injecting FLEET_MANIFEST_DIR reaches the child', async () => {
	const { dir, path } = scriptFile(
		'console.log(JSON.stringify({manifestDir: process.env.FLEET_MANIFEST_DIR ?? null})); process.exit(0);'
	);
	try {
		const r = await runFleetScript(path, [], { env: { ...process.env, FLEET_MANIFEST_DIR: '/x' } });
		assert.equal(r.json.manifestDir, '/x');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a timeout past the ceiling is reported by signal, not left hanging', async () => {
	const { dir, path } = scriptFile('setTimeout(() => {}, 60_000);');
	try {
		const r = await runFleetScript(path, [], { timeoutMs: 300 });
		assert.equal(r.json, null);
		assert.match(r.why, /signal SIGTERM/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
