/**
 * `fleet drain --kind reboot`: the reboot cycle's own drain kind.
 *
 * Runs the real script against a fixture manifest and an empty state dir.
 * Setting a drain sshes to the node afterwards to count running jobs, so `ssh`
 * is a stand-in on PATH that fails — the script's "could not reach" path, and
 * never a real claw.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, cleanupTempDirs } from './lib/test-tmpdir.mjs';

afterEach(cleanupTempDirs);

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'drain-node.mjs');

function run(...args) {
	const dir = tempDir('drain-node-');
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nexit 255\n');
	chmodSync(join(bin, 'ssh'), 0o755);
	writeFileSync(
		join(dir, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: {
				'claw-5': { role: 'claw', maxConcurrent: 2 },
				'claw-6': { role: 'claw', maxConcurrent: 2 },
			},
		})
	);
	const r = spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FLEET_MANIFEST_DIR: dir,
			HADOKU_STATE_DIR: dir,
		},
	});
	const file = join(dir, 'fleet-drain.json');
	return {
		status: r.status,
		out: r.stdout + r.stderr,
		doc: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null,
	};
}

test('a reboot drain is accepted, and recorded as kind `reboot` with its end', () => {
	const r = run('claw-6', '--kind', 'reboot', '--for', '2h', '--reason', 'automated reboot: x');
	assert.equal(r.status, 0, r.out);
	const rec = r.doc?.nodes?.['claw-6'];
	assert.equal(rec?.kind, 'reboot');
	assert.equal(rec?.reason, 'automated reboot: x');
	assert.ok(Date.parse(rec?.until) > Date.now(), `until must be in the future: ${rec?.until}`);
});

test('a reboot drain with no end is refused — a reboot that never returns must lapse', () => {
	const r = run('claw-6', '--kind', 'reboot', '--reason', 'automated reboot: x');
	assert.equal(r.status, 1, r.out);
	assert.match(r.out, /a reboot needs an end/);
	assert.equal(r.doc?.nodes?.['claw-6'], undefined);
});
