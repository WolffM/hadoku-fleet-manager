/**
 * check-warm-canary, run for real against a fixture manifest and a stand-in
 * `ssh` — the GateDoc half (wave 5f lane B). `scripts/lib/warm-canary.test.mjs`
 * already proves `warmCanaryVerdict` itself at the unit level (including the
 * "warm" / eligible-but-not-warm distinction); this proves the SCRIPT wires
 * that verdict into a `GateDoc`, through the real I/O paths (manifest
 * selection, ssh, the additive legacy fields), not the decision logic again.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, cleanupTempDirs } from './lib/test-tmpdir.mjs';

afterEach(cleanupTempDirs);

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-warm-canary.mjs');

/**
 * `ssh` is shadowed on PATH and reads the piped script off its own stdin —
 * `runOnSync` always invokes `ssh <dest> bash -s` with the probe fed that way
 * (`scripts/lib/fleet-exec.mjs`'s `scriptCommand`) — so the stub can tell the
 * three probes `measure()` makes apart by substring, without caring about argv.
 *
 *   `reachable: false` — exit 255, ssh's own reserved "could not connect".
 *   `reachable: true, activeRepo` unset — answers memory and "is-active" but
 *     the warm marker file read comes back empty: eligible, never warm.
 */
function sshStub(bin, { reachable, activeRepo }) {
	const path = join(bin, 'ssh');
	if (!reachable) {
		writeFileSync(path, '#!/bin/sh\nexit 255\n');
	} else {
		writeFileSync(
			path,
			[
				'#!/bin/sh',
				'input="$(cat)"',
				'case "$input" in',
				'  *"free -m"*) echo 65536 ;;', // 64GB — comfortably eligible
				'  *"warm/repo"*)',
				activeRepo ? `    echo "${activeRepo}" ;;` : '    : ;;', // no marker: never warm
				'  *"systemctl --user is-active"*) echo active ;;',
				'  *) exit 1 ;;',
				'esac',
			].join('\n')
		);
	}
	chmodSync(path, 0o755);
}

function manifestWith(machines) {
	return JSON.stringify({ machines });
}

function run(machines, { reachable, activeRepo } = {}, extraArgv = []) {
	const dir = tempDir('warm-canary-');
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	sshStub(bin, { reachable: reachable ?? false, activeRepo });
	writeFileSync(join(dir, 'fleet-runner-manifest.json'), manifestWith(machines));
	const r = spawnSync(process.execPath, [SCRIPT, '--json', ...extraArgv], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FLEET_MANIFEST_DIR: dir,
			HADOKU_STATE_DIR: dir,
		},
	});
	return { ...r, doc: JSON.parse(r.stdout) };
}

void test('no ephemeral candidate at all: one whole-fleet finding, nothing unreadable', () => {
	const r = run({ 'fx-standing': { role: 'claw' } });
	assert.equal(r.status, 1, r.stderr);
	assert.equal(r.doc.ok, false);
	assert.deepEqual(r.doc.unreadable, []);
	assert.equal(r.doc.findings.length, 1);
	assert.equal(r.doc.findings[0].node, null);
	assert.equal(r.doc.findings[0].kind, 'warm-canary-refused');
	assert.match(r.doc.findings[0].reason, /no candidate node exists/);
	assert.ok(r.doc.why, 'a failing GateDoc must carry why');
});

void test('an unreachable ephemeral candidate: unreadable, never a finding', () => {
	const r = run({ 'fx-claw-1': { role: 'claw', ephemeral: true } }, { reachable: false });
	assert.equal(r.status, 1, r.stderr);
	assert.equal(r.doc.ok, false);
	assert.deepEqual(r.doc.findings, []);
	assert.equal(r.doc.unreadable.length, 1);
	assert.equal(r.doc.unreadable[0].node, 'fx-claw-1');
	assert.match(r.doc.unreadable[0].why, /could not reach/);
});

void test('an eligible, reachable candidate holding NO warm listener: one not-warm finding', () => {
	const r = run({ 'fx-claw-1': { role: 'claw', ephemeral: true } }, { reachable: true });
	assert.equal(r.status, 1, r.stderr);
	assert.equal(r.doc.ok, false);
	assert.deepEqual(r.doc.unreadable, []);
	assert.equal(r.doc.findings.length, 1);
	assert.equal(r.doc.findings[0].node, 'fx-claw-1');
	assert.equal(r.doc.findings[0].kind, 'not-warm');
	assert.match(r.doc.findings[0].reason, /eligible.*not holding one/);
	// The pre-existing legacy fields still travel, additively.
	assert.deepEqual(r.doc.eligible, ['fx-claw-1']);
	assert.deepEqual(r.doc.warm, []);
});

void test('human output is unaffected by the migration — same prose, same exit code', () => {
	const asJson = run({ 'fx-standing': { role: 'claw' } });
	// Re-run the identical fixture without --json.
	const dir = tempDir('warm-canary-human-');
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	sshStub(bin, { reachable: false });
	writeFileSync(
		join(dir, 'fleet-runner-manifest.json'),
		manifestWith({ 'fx-standing': { role: 'claw' } })
	);
	const human = spawnSync(process.execPath, [SCRIPT], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FLEET_MANIFEST_DIR: dir,
			HADOKU_STATE_DIR: dir,
		},
	});
	assert.equal(human.status, asJson.status, 'exit code must match between the two modes');
	assert.ok(!human.stdout.trim().startsWith('{'), 'human mode must not print JSON');
	assert.match(human.stderr, /✗ warm cache canary:/);
});
