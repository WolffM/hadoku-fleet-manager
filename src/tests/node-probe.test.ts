import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { chmodSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmpdir.js';
import {
	probeNode,
	probeFleet,
	__parseProbeForTesting,
	__PROBE_CMD_FOR_TESTING,
} from '../lib/node-probe.js';

test('probe parsing: an idle node reports 0 workers, not an unreadable box', () => {
	// This test used to declare its own `parse` and assert against that copy, so
	// it passed no matter what parseProbe did — deleting the real parser outright
	// would not have failed it, while its name claimed to pin the regression
	// below. It drives the real one now.
	const idle = __parseProbeForTesting('0 8 0 ');
	assert.equal(idle?.workers, 0, 'idle box must read as 0 workers');
	assert.equal(idle?.cores, 8, 'of 8 cores');
	const busy = __parseProbeForTesting('3 8 0 ');
	assert.equal(busy?.workers, 3);
	assert.equal(busy?.cores, 8);
	// The old buggy output — must still be rejected rather than silently misread.
	assert.equal(__parseProbeForTesting('0\n0 8'), null, 'the double-zero form is garbage');
	assert.equal(__parseProbeForTesting(''), null);
});

// ── probing THIS node ────────────────────────────────────────────────────

test('probeNode: the local host is probed WITHOUT ssh', async () => {
	// Regression for a silent, months-long capacity loss. mgmt-api runs on hokon,
	// and hokon refuses ssh to itself (sshd is not on loopback), so probeNode
	// returned null for its own host on every tick, and an unreachable node
	// contributes nothing: hokon's slots never counted once.
	//
	// Asserting a real result here rather than mocking execFile is the point —
	// the bug was that the ssh path cannot work for the local host, and only
	// actually running it proves the local path does.
	const me = await probeNode(hostname());
	assert.notEqual(me, null, 'probing our own hostname must not fail');
	assert.ok((me?.cores ?? 0) > 0, `cores should be positive, got ${me?.cores}`);
	assert.ok((me?.workers ?? -1) >= 0, 'worker count must be a non-negative number');
});

test('probe parses the tagged OS field and still finds the repo list after it', () => {
	const p = __parseProbeForTesting('2 8 0 g=1 o=13.6,6.12.94+deb13-amd64 WolffM/a,WolffM/b,');
	assert.deepEqual(p?.os, { release: '13.6', kernel: '6.12.94+deb13-amd64' });
	assert.equal(p?.githubDns, true);
	assert.deepEqual(
		[...(p?.busyRepos ?? [])],
		[
			['WolffM/a', 1],
			['WolffM/b', 1],
		]
	);
	assert.deepEqual(__parseProbeForTesting('0 8 0 g=1 o=-,6.12.94')?.os, {
		release: null,
		kernel: '6.12.94',
	});
	assert.equal(__parseProbeForTesting('0 8 0 g=1 ')?.os, undefined, 'absent claims nothing');
});

test('probe runs here and reports this host’s real OS', async () => {
	const me = await probeNode(hostname());
	assert.match(me?.os?.release ?? '', /^\d+(\.\d+)*$|^[a-z]+\/sid$/, `got ${me?.os?.release}`);
	assert.ok(me?.os?.kernel, 'uname -r is always readable');
});

test('probe counts SPAWNED workers only, never a process merely named Runner.Worker', () => {
	// 2026-10-25: claw-6 read `busy 7 / 2` holding two real jobs. The extra five
	// were ci-throttle.test.mjs fixtures — bash copied to `Runner.Worker` — from
	// this repo's own suite running on the node, and the dispatcher charged them
	// as standing work and refused the node as at capacity. A stub `pgrep` makes
	// the census deterministic: one real job, one fixture.
	const bin = tempDir('probe-pgrep-');
	writeFileSync(
		join(bin, 'pgrep'),
		'#!/bin/sh\n' +
			'echo "101 /home/u/.hadoku/jit/slot0/bin.2.338.0/Runner.Worker spawnclient 149 152"\n' +
			'echo "102 /tmp/ci-throttle-1-node-x/Runner.Worker -c sleep 60"\n'
	);
	chmodSync(join(bin, 'pgrep'), 0o755);
	const out = execFileSync('bash', ['-c', __PROBE_CMD_FOR_TESTING], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		encoding: 'utf8',
	});
	assert.equal(__parseProbeForTesting(out)?.workers, 1);
});

test('probeFleet: the local host reports reachable, not down', async () => {
	// The dashboard consequence of the same bug: hokon rendered red "unreachable"
	// on a node that was up and serving CI.
	const out = await probeFleet([hostname()], {});
	assert.equal(out.get(hostname())?.reachable, true);
});

// --- probe field ORDER ------------------------------------------------------
//
// The repo field is VARIABLE LENGTH and empty on an idle node, so anything
// printed after it lands in its position. It must stay last. This mattered
// when a fifth field existed (the runners.slice OOM counters, removed
// 2026-08-29 as unconsumed) and it will matter again for the next one.

test('probe: an IDLE node invents no repo from a trailing field', () => {
	const p = __parseProbeForTesting('0 8 0 ');
	assert.equal(p?.workers, 0);
	assert.equal(p?.busyRepos?.size, 0, 'no repo may be invented from an empty tail');
});

test('probe: a busy node reports its repos', () => {
	const p = __parseProbeForTesting('2 8 0 WolffM/hadoku_site,WolffM/hadoku-rally');
	assert.equal(p?.busyRepos?.get('WolffM/hadoku_site'), 1);
	assert.equal(p?.busyRepos?.get('WolffM/hadoku-rally'), 1);
});

// --- the GitHub-DNS field (2026-10-16) ------------------------------------
//
// claw-9 answered ssh for two hours while MagicDNS SERVFAILed every public
// name, read `mintable` throughout, and took a mint whose listener never
// connected. The field is TAGGED so it cannot be confused with the repo list.

test('probe: g=1 resolves, g=0 does not, and the repo list after it still parses', () => {
	const ok = __parseProbeForTesting('2 8 0 g=1 WolffM/hadoku_site,');
	assert.equal(ok?.githubDns, true);
	assert.equal(ok?.busyRepos?.get('WolffM/hadoku_site'), 1);
	const blind = __parseProbeForTesting('0 8 0 g=0 ');
	assert.equal(blind?.githubDns, false);
	assert.equal(blind?.busyRepos?.size, 0, 'the tag is not a repo');
});

test('probe: an untagged probe claims nothing about DNS and keeps its repo field', () => {
	const p = __parseProbeForTesting('1 8 0 WolffM/hadoku_site');
	assert.equal(p?.githubDns, undefined);
	assert.equal(p?.busyRepos?.get('WolffM/hadoku_site'), 1);
});

test('probeFleet: a node that answers ssh but cannot resolve GitHub is UNREACHABLE, with the reason', async () => {
	const out = await probeFleet(['claw-9', 'claw-8'], { 'claw-9': 4, 'claw-8': 4 }, async (n) =>
		n === 'claw-9'
			? { workers: 1, cores: 8, sick: false, githubDns: false, busyRepos: new Map() }
			: { workers: 1, cores: 8, sick: false, githubDns: true, busyRepos: new Map() }
	);
	const blind = out.get('claw-9');
	assert.equal(blind?.reachable, false, 'every reader of `reachable` must stop counting it');
	assert.equal(blind?.free, 0);
	assert.match(
		blind?.unreachableWhy ?? '',
		/cannot resolve broker\.actions\.githubusercontent\.com/
	);
	assert.equal(out.get('claw-8')?.reachable, true);
	assert.equal(out.get('claw-8')?.free, 3);
	assert.equal(out.get('claw-8')?.unreachableWhy, undefined);
});
