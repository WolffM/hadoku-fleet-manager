import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmpdir.js';
import {
	__resetSickForTesting,
	markNodeSick,
	nodeIsSick,
	sickNodeNames,
} from '../lib/sick-node.js';
import { repairSickNode, doctorCommand, runDoctor } from '../runners/node-repair.js';
import { DEFAULT_ADMIN_USER } from '../lib/node-users.js';

test('sick: a successful repair releases the node', async () => {
	__resetSickForTesting();
	markNodeSick('claw-1');
	const calls: string[][] = [];
	const ok = await repairSickNode('claw-1', async (node, args) => {
		calls.push([node, ...args]);
		return true;
	});
	assert.equal(ok, true);
	assert.equal(nodeIsSick('claw-1'), false, 'a repaired node returns to service');
	const stores = calls.filter((c) => c.includes('--store')).map((c) => c[2]);
	assert.ok(
		stores.some((v) => v.includes('.local/share/pnpm/store')) &&
			stores.some((v) => v.includes('/opt/hostedtoolcache/pnpm-store')),
		`both stores must be repaired — workflows do not all use the same one, got ${JSON.stringify(stores)}`
	);
	assert.ok(
		calls.every((c) => c.includes('--fix') || c.includes('--clear-marker')),
		'repair must actually fix, not merely report'
	);
	assert.ok(
		calls.at(-1)?.includes('--clear-marker'),
		'the marker is cleared LAST, after the doctor succeeded'
	);
});

test('sick: a FAILED repair keeps the node retired', async () => {
	__resetSickForTesting();
	markNodeSick('claw-1');
	const ok = await repairSickNode('claw-1', async () => false);
	assert.equal(ok, false);
	assert.ok(nodeIsSick('claw-1'), 'a node we could not fix must not come back');
	assert.deepEqual(sickNodeNames(), ['claw-1']);
});

test('sick: a repair that fixes the store but cannot clear the marker stays retired', async () => {
	// The bug this pins: doing the repair and the marker-clear in ONE command made
	// release depend on whether `rm` worked rather than on whether the store was
	// fixed. Inverted here — the doctor succeeds, the clear fails — because a
	// node whose marker survives will just be re-reported sick next tick, and
	// releasing it produces a flap instead of a fix.
	__resetSickForTesting();
	markNodeSick('claw-1');
	const ok = await repairSickNode('claw-1', async (_h, args) => !args.includes('--clear-marker'));
	assert.equal(ok, false);
	assert.ok(nodeIsSick('claw-1'), 'no release without a cleared marker');
});

// ── the repair must reach the node mgmt-api runs on ─────────────────────────
// `ssh hokon` from hokon is refused, so an ssh-only repair left a quarantined
// hokon retired for two days on 2026-09-19..21 with both stores clean.

test('repair: the LOCAL node runs through a local shell, never ssh-to-self', () => {
	const [cmd, args] = doctorCommand('hokon', 'bash -s -- --fix', 'hokon');
	assert.equal(cmd, 'bash');
	assert.deepEqual(args, ['-c', 'bash -s -- --fix']);
});

test('repair: a REMOTE node still goes over ssh, with the same command string', () => {
	const [cmd, args] = doctorCommand('claw-2', 'bash -s -- --fix', 'hokon');
	assert.equal(cmd, 'ssh');
	// As the ci role: claw-2's fixture names no users, so ci is the admin default.
	assert.equal(args.at(-2), `${DEFAULT_ADMIN_USER}@claw-2`);
	assert.equal(args.at(-1), 'bash -s -- --fix');
});

test('repair: the local path EXPANDS $HOME in the store path, as the remote shell does', async () => {
	// A bare spawn('bash', ['-s', ...]) would hand the doctor a literal "$HOME"
	// and fail exactly as silently as the ssh-to-self did.
	const out = join(tempDir('doctor-'), 'seen');
	const ok = await runDoctor('hokon', ['--store', '$HOME/.local/share/pnpm/store'], {
		self: 'hokon',
		script: `printf %s "$2" > ${JSON.stringify(out)}`,
	});
	assert.equal(ok, true);
	assert.equal(readFileSync(out, 'utf8'), `${homedir()}/.local/share/pnpm/store`);
});

test('repair: a failing doctor reports FAILURE, not a released node', async () => {
	assert.equal(await runDoctor('hokon', ['--fix'], { self: 'hokon', script: 'exit 3' }), false);
});
