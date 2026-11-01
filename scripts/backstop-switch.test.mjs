/**
 * `fleet backstop` strict argv, run DIRECTLY (bypassing the door) — one of
 * the per-script tests wave 5b left open (plan §4.1 F8).
 *
 * `backstop --force <node>` writes a time-boxed state record that holds a
 * node ELIGIBLE for CI work regardless of saturation — the green light, per
 * the file's own header. An unknown flag reaching this script by some path
 * other than the door must still be refused — exit 2, nothing run — before
 * the switch file is ever read or written. Modelled on
 * `scripts/lib/cli-help.test.mjs`'s sandbox: every external tool the script
 * could touch is a stand-in on PATH that fails and records the attempt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'backstop-switch.mjs');

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
	const dir = mkdtempSync(join(tmpdir(), 'backstop-switch-strict-argv-'));
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

function run(args, sb) {
	return spawnSync(process.execPath, [SCRIPT, ...args], {
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
}

test('fleet-manager#F8: backstop-switch.mjs run DIRECTLY with an unknown flag exits 2 and touches nothing', () => {
	const sb = sandbox();
	const r = run(['--force', 'claw-3', '--not-a-real-flag'], sb);
	const touched = existsSync(sb.log) ? readFileSync(sb.log, 'utf8').trim() : '';
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.match(r.stdout + r.stderr, /unknown flag\(s\) --not-a-real-flag/);
	assert.equal(touched, '', `backstop-switch.mjs called external tools:\n${touched}`);
});

test('fleet-manager#F8: --help still answers, even in the same sandbox', () => {
	const sb = sandbox();
	const r = run(['--help'], sb);
	const touched = existsSync(sb.log) ? readFileSync(sb.log, 'utf8').trim() : '';
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(touched, '', `backstop-switch.mjs --help called external tools:\n${touched}`);
});

/**
 * `--force`/`--off`/`--status` all call `readDrain()`, which validates that
 * `FLEET_MANIFEST_DIR` EXISTS even when no drain file sits inside it
 * (`fleet-paths.ts`'s `must()`) — unlike the pure-argv tests above, which
 * deliberately leave the sandbox's manifest dir absent to prove nothing here
 * touches it. These round-trip tests need it to actually exist.
 */
function realManifestDir(sb) {
	mkdirSync(join(sb.dir, 'no-manifests'), { recursive: true });
}

// ── the round trip: --force, --status, --off, against a temp state dir ────
//
// Everything above only proved argv handling; nothing here exercised the
// switch file at all. `sandbox()`/`run()` already point HADOKU_STATE_DIR at
// a throwaway temp dir (never `~/.hadoku-mgmt`, the live path
// `src/lib/fleet-paths.ts`'s `stateDir()` falls back to with no override),
// so the real CLI is safe to drive end to end here.

test('#2026-11-01: --force writes a time-boxed record --status reads back, and --off clears it', () => {
	const sb = sandbox();
	realManifestDir(sb);

	const forced = run(['--force', 'claw-3', '--for', '30m', '--reason', 'queue backed up'], sb);
	assert.equal(forced.status, 0, forced.stdout + forced.stderr);
	assert.match(forced.stdout, /claw-3/);

	const statusAfterForce = json(run(['--status', '--json'], sb));
	assert.equal(statusAfterForce.ok, true, JSON.stringify(statusAfterForce));
	assert.equal(statusAfterForce.switch.length, 1, JSON.stringify(statusAfterForce.switch));
	const rec = statusAfterForce.switch[0];
	assert.equal(rec.node, 'claw-3');
	assert.equal(rec.reason, 'queue backed up');
	// 30 minutes, give or take the second this run itself takes.
	assert.ok(
		rec.remainingMin >= 28 && rec.remainingMin <= 30,
		`expected ~30 remaining minutes, got ${rec.remainingMin}`
	);

	const off = run(['--off', 'claw-3'], sb);
	assert.equal(off.status, 0, off.stdout + off.stderr);
	assert.match(off.stdout, /force cleared/);

	const statusAfterOff = json(run(['--status', '--json'], sb));
	assert.equal(statusAfterOff.ok, true, JSON.stringify(statusAfterOff));
	assert.deepEqual(statusAfterOff.switch, []);
});

test('#2026-11-01: --off on a node that was never forced says so and still exits 0', () => {
	const sb = sandbox();
	const r = run(['--off', 'claw-9'], sb);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /was not forced/);
});

test('#2026-11-01: --force on a node already DRAINED is refused — the red light beats the green one', () => {
	const sb = sandbox();
	realManifestDir(sb);
	writeFileSync(
		join(sb.dir, 'state', 'fleet-drain.json'),
		JSON.stringify({
			nodes: { 'claw-5': { since: new Date().toISOString(), kind: 'maintenance', reason: 'x' } },
			planned: [],
		})
	);
	const r = run(['--force', 'claw-5', '--for', '30m'], sb);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout + r.stderr, /DRAINED/);

	const status = json(run(['--status', '--json'], sb));
	assert.deepEqual(status.switch, [], 'the refused force must not have been written at all');
});

test('#2026-11-01: --force rejects a duration past the ceiling, and writes nothing', () => {
	const sb = sandbox();
	realManifestDir(sb);
	const r = run(['--force', 'claw-3', '--for', '700h'], sb);
	assert.notEqual(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout + r.stderr, /ceiling/);

	const status = json(run(['--status', '--json'], sb));
	assert.deepEqual(status.switch, []);
});

/** The script's `--status --json` document, parsed. */
function json(r) {
	assert.ok(r.stdout.trim(), `no stdout to parse:\n${r.stdout}\n${r.stderr}`);
	try {
		return JSON.parse(r.stdout);
	} catch (err) {
		throw new Error(`stdout is not JSON (${err.message}):\n${r.stdout}`);
	}
}
