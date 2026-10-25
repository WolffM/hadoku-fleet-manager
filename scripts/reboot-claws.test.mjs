/**
 * reboot-claws' argument guard: a flag it does not know must never fall through
 * to its default, which is a REAL reboot. On 2026-10-25 `--help` did exactly
 * that and rebooted claw-4.
 *
 * Every case runs against a manifest dir that does not exist and an empty state
 * dir. The guard runs before either is read, so reaching them would show up as
 * a manifest error or a written state file — never as a reboot.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, cleanupTempDirs } from './lib/test-tmpdir.mjs';

afterEach(cleanupTempDirs);

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'reboot-claws.mjs');

function run(...args) {
	const state = tempDir('reboot-claws-state-');
	const r = spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: 'utf8',
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: join(state, 'no-such-manifests'),
			HADOKU_STATE_DIR: state,
		},
	});
	return { ...r, out: r.stdout + r.stderr, wrote: readdirSync(state) };
}

test('--help prints usage and touches nothing', () => {
	const r = run('--help');
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /fleet reboot-claws \[--plan\]/);
	assert.doesNotMatch(r.out, /MODE:/);
	assert.deepEqual(r.wrote, []);
});

test('an unknown flag exits 2 and touches nothing', () => {
	for (const flag of ['--bogus', '--dry-run', '-n']) {
		const r = run(flag);
		assert.equal(r.status, 2, `${flag}: ${r.out}`);
		assert.match(r.out, /unknown flag\(s\)/);
		assert.match(r.out, /nothing was touched/);
		assert.deepEqual(r.wrote, []);
	}
});

test('the known flags pass the guard (and then need a manifest)', () => {
	const r = run('--plan', '--machine', 'claw-3', '--json');
	assert.doesNotMatch(r.out, /unknown flag/);
	assert.notEqual(r.status, 2);
	assert.equal(existsSync(join(r.wrote[0] ?? '', 'claw-reboot.json')), false);
});
