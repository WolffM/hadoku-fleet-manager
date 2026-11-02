/**
 * The `pm2-boot` floor entry against a fake node (lib/fake-node.mjs): the
 * detect reads the KERNEL's ceiling, and the repair bounds a running admin pm2
 * live, without restarting it. claw-4 and claw-6 ran theirs at `max`, idle,
 * until 2026-11-02, and hosting-claims reported `app-layer-idle` for both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createFakeNode } from './fake-node.mjs';
import { PM2_MEMORY_MAX_MB_DEFAULT } from './pm2-boot-floor.mjs';
import { REPAIRS, installScript, repairNeedsRoot } from './toolchain-floor.mjs';

const MIB = 1048576;
const USER = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
const UNIT = `pm2-${USER}.service`;

/** A node whose admin pm2 runs under its unit with no ceiling, holding `heldMb`, running `apps`. */
function nodeWithPm2({ apps = 0, heldMb = 40, ceiling = '' } = {}) {
	const node = createFakeNode({ runnerVersion: '2.337.0' });
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
		...node.env,
		PATH: `${node.callerBin}:${process.env.PATH}`,
	};
	const list = JSON.stringify(Array.from({ length: apps }, (_, i) => ({ name: `app${i}` })));
	writeFileSync(
		join(node.env.FAKE_NODE_BIN, 'pm2'),
		`#!/bin/sh\necho "pm2 $*" >> "$FAKE_STATE/pm2.log"\n[ "$1" = jlist ] && printf '%s' '${list}'\nexit 0\n`,
		{ mode: 0o755 }
	);
	const ssh = (script) =>
		spawnSync('ssh', ['fixture-claw'], { env, input: script, encoding: 'utf8' });
	const setup = ssh(`set -e
mkdir -p "$SYS_DIR"
printf '[Service]\\nType=forking\\nExecStart=/usr/bin/env pm2 resurrect\\n${ceiling}' > "$SYS_DIR/${UNIT}"
systemctl enable --now ${UNIT}
echo ${heldMb * MIB} > "$CGROUP_ROOT/system.slice/${UNIT}/memory.current"
`);
	assert.equal(setup.status, 0, setup.stderr);
	const cg = join(node.root, 'cgroup', 'system.slice', UNIT);
	return {
		node,
		ssh,
		detect: () => ssh(REPAIRS['pm2-boot'].detect).stdout.trim(),
		memoryMax: () => readFileSync(join(cg, 'memory.max'), 'utf8').trim(),
		dropIn: join(node.root, 'etc', 'systemd', 'system', `${UNIT}.d`, '10-ceiling.conf'),
		pm2Calls: () => {
			const p = join(node.env.FAKE_STATE, 'pm2.log');
			return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n') : [];
		},
	};
}

test('pm2-boot: an enabled, active pm2 at `max` is NOT on the floor; the repair bounds it live, once', (t) => {
	const n = nodeWithPm2();
	t.after(() => n.node.cleanup());
	assert.equal(n.memoryMax(), 'max');
	assert.equal(n.detect(), '', 'unbounded is drift, read from the cgroup');

	const r = n.ssh(installScript('pm2-boot'));
	assert.equal(r.status, 0, r.stderr);
	assert.equal(n.memoryMax(), String(PM2_MEMORY_MAX_MB_DEFAULT * MIB), 'the kernel ceiling, live');
	assert.equal(
		readFileSync(n.dropIn, 'utf8'),
		`[Service]\nMemoryMax=${PM2_MEMORY_MAX_MB_DEFAULT}M\n`,
		'and a drop-in for every later boot'
	);
	assert.equal(n.detect(), 'OK');
	// NEVER RESTARTED: one start (the setup's), no `pm2 startup`, no kill.
	assert.deepEqual(n.node.starts(), [`START ${UNIT} slice=system.slice`]);
	assert.deepEqual(
		n.pm2Calls().filter((c) => c !== 'pm2 jlist'),
		[],
		'an active unit is not re-provisioned'
	);
	assert.deepEqual(n.node.unhandled(), []);
});

test("pm2-boot: the manifest's pm2MemoryMaxMb is the ceiling, and may bound a pm2 that runs apps", (t) => {
	const n = nodeWithPm2({ apps: 3, heldMb: 900 });
	t.after(() => n.node.cleanup());
	const r = n.ssh(installScript('pm2-boot', undefined, { pm2MemoryMaxMb: 2048 }));
	assert.equal(r.status, 0, r.stderr);
	assert.equal(n.memoryMax(), String(2048 * MIB));
	assert.equal(n.detect(), 'OK');
});

test('pm2-boot: the default ceiling is refused for a pm2 that supervises apps', (t) => {
	// Its apps run in the same cgroup: 512 MB would bound them too.
	const n = nodeWithPm2({ apps: 2, heldMb: 100 });
	t.after(() => n.node.cleanup());
	const r = n.ssh(installScript('pm2-boot'));
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /supervises 2 app\(s\)[\s\S]*pm2MemoryMaxMb/);
	assert.equal(n.memoryMax(), 'max', 'nothing was written');
	assert.equal(existsSync(n.dropIn), false);
});

test('pm2-boot: a ceiling the unit already holds 80% of is refused, never an OOM kill', (t) => {
	const n = nodeWithPm2({ apps: 1, heldMb: 1700 });
	t.after(() => n.node.cleanup());
	const r = n.ssh(installScript('pm2-boot', undefined, { pm2MemoryMaxMb: 2048 }));
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /holds 1700M, at or above 80% of a 2048M ceiling/);
	assert.equal(n.memoryMax(), 'max');
});

test('pm2-boot: an existing finite ceiling passes and is never rewritten', (t) => {
	// hokon's admin pm2 carries 32 GiB by hand; the fleet has no sudo there.
	const n = nodeWithPm2({ ceiling: 'MemoryMax=32G\\n' });
	t.after(() => n.node.cleanup());
	assert.equal(n.detect(), 'OK');
	const r = n.ssh(installScript('pm2-boot', undefined, { pm2MemoryMaxMb: 1024 }));
	assert.equal(r.status, 0, r.stderr);
	assert.equal(n.memoryMax(), String(32 * 1024 * MIB));
	assert.equal(existsSync(n.dropIn), false);
});

test('pm2-boot: the repair needs root, so where the fleet has no sudo it is an advisory', () => {
	assert.equal(repairNeedsRoot('pm2-boot'), true);
	assert.doesNotMatch(REPAIRS['pm2-boot'].detect, /systemctl show[^|;&]*MemoryMax/);
});

test('installScript refuses a pm2MemoryMaxMb that is not a positive integer', () => {
	for (const bad of [0, -1, 1.5, '512', '512; rm -rf /'])
		assert.throws(() => installScript('pm2-boot', undefined, { pm2MemoryMaxMb: bad }));
	assert.match(
		installScript('pm2-boot', undefined, { pm2MemoryMaxMb: 768 }),
		/^PM2_MEMORY_MAX_MB='768'\nexport PM2_MEMORY_MAX_MB\n/
	);
});
