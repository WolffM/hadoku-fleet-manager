/**
 * The quarantine count's walk outlives its read (fleet-manager#166). Runs the
 * REAL script against a temporary data dir: no sudo (an empty prefix, or a
 * shim that slows `find` down), the config and the state dir pointed at the
 * fixture, so nothing on the host is read or written.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CORRUPTED_MAX_AGE_SEC, corruptedCountScript, parseCorrupted } from './garage-admin.mjs';
import { cleanupTempDirs, tempDir } from './test-tmpdir.mjs';

after(cleanupTempDirs);

function rig() {
	const root = tempDir('garage-corrupted-');
	const data = join(root, 'WD-X', 'garage');
	mkdirSync(join(data, 'ab', 'cd'), { recursive: true });
	writeFileSync(join(data, 'ab', 'cd', 'h1.zst'), '');
	writeFileSync(join(data, 'ab', 'cd', 'h2.zst.corrupted'), '');
	const config = join(root, 'garage.toml');
	writeFileSync(config, `data_dir = [ { path = "${data}", capacity = "1" } ]\n`);
	// A privilege prefix that sleeps before `find` only: the walk outlasts the wait.
	const slow = join(root, 'slow-sudo');
	writeFileSync(slow, '#!/bin/bash\n[ "$4" = find ] && sleep 3\nexec "$@"\n');
	chmodSync(slow, 0o755);
	return { root, data, config, slow, state: join(root, 'state') };
}

const run = (script) => {
	const r = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', timeout: 30_000 });
	return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
};

describe('the quarantine count (#166)', () => {
	it('a walk that finishes inside the wait is counted this run', () => {
		const x = rig();
		const v = parseCorrupted(
			run(corruptedCountScript({ config: x.config, sudo: '', stateDir: x.state, waitSec: 20 }))
		);
		assert.equal(v.corruptedWhy, null);
		assert.deepEqual(v.corrupted, [{ path: x.data, disk: 'WD-X', count: 1 }]);
		assert.ok(v.corruptedAgeSec >= 0 && v.corruptedAgeSec < 20, `age ${v.corruptedAgeSec}`);
	});

	it('a walk that outlasts the wait is not yet a count, and the next read gets it', () => {
		const x = rig();
		const script = corruptedCountScript({
			config: x.config,
			sudo: x.slow,
			stateDir: x.state,
			waitSec: 1,
		});
		const first = parseCorrupted(run(script));
		assert.equal(first.corrupted, null);
		assert.match(first.corruptedWhy, /no walk has completed yet/);
		// The detached walk finishes on its own; a later read, waiting long
		// enough for it, reads the count it left.
		const later = parseCorrupted(
			run(corruptedCountScript({ config: x.config, sudo: x.slow, stateDir: x.state, waitSec: 20 }))
		);
		assert.deepEqual(later.corrupted, [{ path: x.data, disk: 'WD-X', count: 1 }]);
	});

	it('a missing data dir is a failed walk, said, never a count of 0', () => {
		const x = rig();
		writeFileSync(
			x.config,
			`data_dir = [ { path = "${join(x.root, 'gone')}", capacity = "1" } ]\n`
		);
		const v = parseCorrupted(
			run(corruptedCountScript({ config: x.config, sudo: '', stateDir: x.state, waitSec: 20 }))
		);
		assert.equal(v.corrupted, null);
		assert.match(v.corruptedWhy, /no walk has completed; the last walk failed: find failed in /);
	});

	it('the newest completed count goes stale: past the ceiling it is "could not look"', () => {
		const fresh = parseCorrupted({
			ok: true,
			stdout: '3 /srv/storage/root/garage\nat 100\nnow 160\n',
		});
		assert.deepEqual(fresh, {
			corrupted: [{ path: '/srv/storage/root/garage', disk: 'root', count: 3 }],
			corruptedWhy: null,
			corruptedAgeSec: 60,
		});
		const old = parseCorrupted({
			ok: true,
			stdout: `3 /srv/storage/root/garage\nat 100\nerr find failed in /x\nnow ${100 + CORRUPTED_MAX_AGE_SEC + 1}\n`,
		});
		assert.equal(old.corrupted, null);
		assert.match(
			old.corruptedWhy,
			/6\.0 h old, over 6 h; the last walk failed: find failed in \/x/
		);
		assert.match(
			parseCorrupted({ ok: true, stdout: '3 /srv/storage/root/garage\nat 100\n' }).corruptedWhy,
			/no clock line/
		);
	});
});
