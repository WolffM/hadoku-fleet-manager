/**
 * `fleet toolpack` strict argv, run DIRECTLY (bypassing the door) — one of
 * the per-script tests wave 5b left open (plan §4.1 F8).
 *
 * `toolpack --confirm` runs `sudo -n apt-get install` on every node in the
 * fleet by default, so an unknown flag reaching this script by some path
 * other than the door (a cron, a hand-rolled spawn, a future caller) must
 * still be refused — exit 2, nothing run — before it ever reads the
 * manifest or reaches a node. Modelled on `scripts/lib/cli-help.test.mjs`'s
 * sandbox: every external tool the script could touch is a stand-in on PATH
 * that fails and records the attempt, with an empty HOME/state dir and no
 * manifest directory to read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'toolpack.mjs');

const STUBS = [
	'ssh',
	'scp',
	'rsync',
	'gh',
	'sudo',
	'apt',
	'apt-get',
	'systemctl',
	'npm',
	'pnpm',
	'curl',
];

const madeDirs = [];
test.after(() => {
	for (const d of madeDirs) rmSync(d, { recursive: true, force: true });
});

function sandbox() {
	const dir = mkdtempSync(join(tmpdir(), 'toolpack-strict-argv-'));
	madeDirs.push(dir);
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	mkdirSync(join(dir, 'home'));
	mkdirSync(join(dir, 'state'));
	const log = join(dir, 'touched.log');
	for (const s of STUBS) {
		writeFileSync(join(bin, s), `#!/bin/sh\necho "${s} $*" >> "${log}"\nexit 97\n`);
		chmodSync(join(bin, s), 0o755);
	}
	return { dir, bin, log };
}

test('fleet-manager#F8: toolpack.mjs run DIRECTLY with an unknown flag exits 2 and touches nothing', () => {
	const sb = sandbox();
	const r = spawnSync(process.execPath, [SCRIPT, '--not-a-real-flag'], {
		encoding: 'utf8',
		timeout: 15_000,
		env: {
			PATH: `${sb.bin}:${process.env.PATH}`,
			HOME: join(sb.dir, 'home'),
			HADOKU_STATE_DIR: join(sb.dir, 'state'),
			FLEET_MANIFEST_DIR: join(sb.dir, 'no-manifests'),
			HADOKU_SITE_ROOT: join(sb.dir, 'no-site'),
			REPOS_DIR: join(sb.dir, 'no-repos'),
			MGMT_API_URL: 'http://127.0.0.1:9',
			FLEET_NO_BANNER: '1',
		},
	});
	const touched = existsSync(sb.log) ? readFileSync(sb.log, 'utf8').trim() : '';
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.match(r.stdout + r.stderr, /unknown flag\(s\) --not-a-real-flag/);
	assert.equal(touched, '', `toolpack.mjs called external tools:\n${touched}`);
});

test('fleet-manager#F8: --help still answers, even in the same sandbox', () => {
	// The control: a passing refusal test on a script that ALSO refuses --help
	// would prove nothing. toolpack.mjs declares `help: true` in the door
	// table, so --help must print and exit 0 without touching anything either.
	const sb = sandbox();
	const r = spawnSync(process.execPath, [SCRIPT, '--help'], {
		encoding: 'utf8',
		timeout: 15_000,
		env: {
			PATH: `${sb.bin}:${process.env.PATH}`,
			HOME: join(sb.dir, 'home'),
			HADOKU_STATE_DIR: join(sb.dir, 'state'),
			FLEET_MANIFEST_DIR: join(sb.dir, 'no-manifests'),
			HADOKU_SITE_ROOT: join(sb.dir, 'no-site'),
			REPOS_DIR: join(sb.dir, 'no-repos'),
			MGMT_API_URL: 'http://127.0.0.1:9',
			FLEET_NO_BANNER: '1',
		},
	});
	const touched = existsSync(sb.log) ? readFileSync(sb.log, 'utf8').trim() : '';
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(touched, '', `toolpack.mjs --help called external tools:\n${touched}`);
});
