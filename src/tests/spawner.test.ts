/**
 * The spawner (fleet-manager#86), against a REAL helper process and real
 * commands: no fake child_process. These pin the contract callers rely on.
 * Output comes back intact, a failure is `ok: false` with its reason, a dead
 * helper fails its calls instead of hanging them and is replaced on the next
 * call, and an idle helper never keeps a process alive.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
	execFileOffLoop,
	spawnerPid,
	__setSpawnerForTesting,
	__stopSpawnerForTesting,
} from '../lib/spawner.js';

afterEach(() => {
	__stopSpawnerForTesting();
	__setSpawnerForTesting(null);
});

test('through the helper: stdout comes back whole, from a process other than this one', async () => {
	__setSpawnerForTesting(true);
	const r = await execFileOffLoop('sh', ['-c', 'echo "$PPID"; printf "a\\nb\\n"'], {
		timeout: 5_000,
	});
	assert.equal(r.ok, true, r.error);
	const [ppid, ...rest] = r.stdout.split('\n');
	assert.equal(Number(ppid), spawnerPid(), 'the helper, not this process, spawned it');
	assert.notEqual(Number(ppid), process.pid);
	assert.deepEqual(rest, ['a', 'b', '']);
});

test('through the helper: a non-zero exit and a timeout are failures that say why', async () => {
	__setSpawnerForTesting(true);
	const bad = await execFileOffLoop('sh', ['-c', 'echo oops >&2; exit 3'], { timeout: 5_000 });
	assert.equal(bad.ok, false);
	assert.match(bad.error ?? '', /Command failed/);
	assert.match(bad.stderr, /oops/);
	const slow = await execFileOffLoop('sleep', ['5'], { timeout: 200 });
	assert.equal(slow.ok, false, 'a timed-out command is not a success');
	assert.equal(slow.code, null, 'it never exited on its own');
	assert.equal(slow.error, 'timed out after 0.2 s');
	assert.equal(bad.code, 3, 'a non-zero exit carries its code');
});

test('a helper that dies fails the calls it held, and the next call gets a new one', async () => {
	__setSpawnerForTesting(true);
	const first =
		spawnerPid() ?? (await execFileOffLoop('true', [], { timeout: 5_000 }), spawnerPid());
	assert.ok(first);
	const held = execFileOffLoop('sleep', ['30'], { timeout: 60_000 });
	process.kill(first, 'SIGKILL');
	const r = await held;
	assert.equal(r.ok, false, 'a dead helper is a failed call, never a hang');
	assert.match(r.error ?? '', /spawner helper exited/);
	const again = await execFileOffLoop('sh', ['-c', 'echo back'], { timeout: 5_000 });
	assert.equal(again.ok, true, again.error);
	assert.equal(again.stdout, 'back\n');
	assert.notEqual(spawnerPid(), first);
});

test('below the RSS threshold, or with FLEET_SPAWNER=off, it spawns directly', async () => {
	const r = await execFileOffLoop('sh', ['-c', 'echo "$PPID"'], { timeout: 5_000 });
	// This test process is far below the threshold.
	assert.equal(Number(r.stdout.trim()), process.pid);
	assert.equal(spawnerPid(), null, 'no helper was started for it');
});

test('a process whose last call has returned exits: the helper never keeps it alive', () => {
	const mod = fileURLToPath(new URL('../lib/spawner.js', import.meta.url));
	const script =
		`const s = await import(${JSON.stringify(mod)});` +
		`const r = await s.execFileOffLoop('true', [], { timeout: 5000 });` +
		`if (!r.ok || !s.spawnerPid()) process.exit(2);`;
	const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
		env: { ...process.env, FLEET_SPAWNER: 'on' },
		timeout: 15_000,
		encoding: 'utf8',
	});
	assert.equal(run.error, undefined, 'it exited on its own, not by the 15 s timeout');
	assert.equal(run.status, 0, run.stderr);
});

test('stdin input reaches the command, through the helper and directly', async () => {
	for (const helper of [true, false]) {
		__setSpawnerForTesting(helper);
		const r = await execFileOffLoop('sh', ['-c', 'cat; echo " via $1"', 'sh', String(helper)], {
			timeout: 5_000,
			input: 'piped',
		});
		assert.equal(r.ok, true, r.error);
		assert.equal(r.code, 0);
		assert.equal(r.stdout, `piped via ${helper}\n`);
		__stopSpawnerForTesting();
	}
});
