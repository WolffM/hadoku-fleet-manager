/**
 * `writeSshConfig` — F3 characterization (wave clean-1 lane A). No test
 * covered this write before: it moved off a hand-rolled `writeFileSync(cfg,
 * ..., { mode: 0o600 })` onto the shared `writeFileAtomic` + an explicit
 * `chmodSync`, because a rename always lands a freshly created inode, so the
 * 0600 this file's security depends on can no longer ride a create-only
 * `mode` option the way the old in-place write did.
 *
 * `$HOME` is pointed at a throwaway directory for the whole call — never the
 * operator's real `~/.ssh/config`. The node name is fictitious and the
 * address is in the TEST-NET-1 range (RFC 5737, 192.0.2.0/24), so every name
 * probe (`ssh -o BatchMode=yes ...`) fails fast on name resolution; nothing
 * here reaches a real network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeSshConfig } from './enroll-ssh.mjs';

function withHome(fn) {
	const home = mkdtempSync(join(tmpdir(), 'enroll-ssh-home-'));
	mkdirSync(join(home, '.ssh'), { recursive: true });
	const saved = process.env.HOME;
	process.env.HOME = home;
	try {
		return fn(home);
	} finally {
		process.env.HOME = saved;
		rmSync(home, { recursive: true, force: true });
	}
}

test('writeSshConfig appends its block atomically, backs up existing content, and the result is 0600', () => {
	withHome((home) => {
		const cfg = join(home, '.ssh', 'config');
		writeFileSync(cfg, 'Host existing\n    HostName 1.2.3.4\n');

		const result = writeSshConfig('fixture-node', '192.0.2.50');
		assert.equal(result.state, 'written', JSON.stringify(result));

		const text = readFileSync(cfg, 'utf8');
		assert.match(text, /Host existing/, 'the pre-existing block is kept, never rewritten');
		assert.match(text, /fleet enroll: fixture-node/);
		assert.match(text, /HostName 192\.0\.2\.50/);

		assert.ok(existsSync(`${cfg}.bak-fleet-enroll`), 'the existing file was backed up first');
		assert.equal(
			readFileSync(`${cfg}.bak-fleet-enroll`, 'utf8'),
			'Host existing\n    HostName 1.2.3.4\n',
			'the backup holds exactly the pre-write content'
		);

		assert.equal(statSync(cfg).mode & 0o777, 0o600, 'the live config is 0600 after the write');
	});
});

test('writeSshConfig creates ~/.ssh/config from nothing when it does not exist yet, still at 0600', () => {
	withHome((home) => {
		const cfg = join(home, '.ssh', 'config');
		const result = writeSshConfig('fixture-node-2', '192.0.2.51');
		assert.equal(result.state, 'written', JSON.stringify(result));
		assert.ok(existsSync(cfg));
		assert.equal(
			existsSync(`${cfg}.bak-fleet-enroll`),
			false,
			'nothing to back up on a fresh file'
		);
		assert.equal(statSync(cfg).mode & 0o777, 0o600);
	});
});

test('writeSshConfig is a no-op (no write at all) when no address is given', () => {
	withHome((home) => {
		const cfg = join(home, '.ssh', 'config');
		const result = writeSshConfig('fixture-node-3', null);
		assert.equal(result.state, 'no-address');
		assert.equal(existsSync(cfg), false);
	});
});
