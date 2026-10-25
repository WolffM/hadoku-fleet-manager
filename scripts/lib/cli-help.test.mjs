/**
 * `fleet <sub> --help` must never DO anything, for every subcommand.
 *
 * On 2026-10-25 `fleet bootcamp --help` ran a real bootcamp fleet-wide and
 * installed the JDK on three claws, and `fleet reboot-claws --help` rebooted
 * claw-4. Each script parses its own argv, and most let a flag they do not know
 * fall through to their default action.
 *
 * So every subcommand in COMMANDS is run here through the real door
 * (dist/cli.js) with `--help`, in a sandbox: ssh, scp, rsync, gh, sudo, apt,
 * apt-get, systemctl, npm, pnpm and curl are stand-ins on PATH that fail and
 * record the attempt; HOME and the state dir are empty; the manifest dir, the
 * site checkout and mgmt-api do not exist. A subcommand passes when it exits 0,
 * prints something, and called none of the stand-ins. One the door answers for
 * passes trivially; one marked `help: true` must earn it.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';
import { parseCliCommands } from './json-contract.mjs';
import { tempDir, cleanupTempDirs } from './test-tmpdir.mjs';

after(cleanupTempDirs);

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI = join(ROOT, 'dist', 'cli.js');
const commands = parseCliCommands(blankComments(readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8')));

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

function sandbox() {
	const dir = tempDir('cli-help-');
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

test('the table parses, so the loop below is not vacuous', () => {
	assert.ok(commands.size >= 15, `parsed ${commands.size} subcommand(s)`);
	assert.ok(existsSync(CLI), `${CLI} is missing — build first`);
});

for (const sub of [...commands.keys()].sort()) {
	test(`fleet ${sub} --help does nothing`, () => {
		const sb = sandbox();
		const r = spawnSync(process.execPath, [CLI, sub, '--help'], {
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
		assert.equal(touched, '', `fleet ${sub} --help called external tools:\n${touched}`);
		assert.notEqual(r.signal, 'SIGTERM', `fleet ${sub} --help did not finish in 15s`);
		assert.equal(r.status, 0, `fleet ${sub} --help exited ${r.status}:\n${r.stdout}${r.stderr}`);
		assert.ok((r.stdout + r.stderr).trim().length > 0, `fleet ${sub} --help printed nothing`);
	});
}

// --- a subcommand that changes things by default refuses an unknown flag ----
//
// `fleet bootcamp --dryrun` used to install packages: the script ignores a
// flag it does not know and runs its default. These are the subcommands whose
// no-flag default changes state (the 2026-10-25 audit); the door holds each to
// its declared flags.

/** Run through the door in the sandbox; returns status, output, and what was touched. */
function door(...args) {
	const sb = sandbox();
	const r = spawnSync(process.execPath, [CLI, ...args], {
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
	return { status: r.status, out: r.stdout + r.stderr, touched };
}

const MUTATES_BY_DEFAULT = [
	'bootcamp',
	'provision',
	'converge-provisioning',
	'stress',
	'register',
	'refresh',
	'add-dvd',
	'mem-harvest',
];

for (const sub of MUTATES_BY_DEFAULT) {
	test(`fleet ${sub} --dryrun is refused at the door, and nothing runs`, () => {
		assert.ok(commands.has(sub), `${sub} is not a subcommand any more — update this list`);
		const r = door(sub, '--dryrun');
		assert.equal(r.status, 2, r.out);
		assert.match(r.out, /unknown flag\(s\) --dryrun — nothing was run/);
		assert.equal(r.touched, '', r.touched);
	});
}

test('converge-provisioning --check is refused: the flag it passes its children is not its own', () => {
	const r = door('converge-provisioning', '--check');
	assert.equal(r.status, 2, r.out);
	assert.match(r.out, /unknown flag\(s\) --check/);
});

test('converge-toolchain --refresh with a mistyped --plan is refused: the typo was the dry run', () => {
	const r = door('converge-toolchain', '--refresh', '--plna');
	assert.equal(r.status, 2, r.out);
	assert.match(r.out, /unknown flag\(s\) --plna — nothing was run/);
	assert.equal(r.touched, '', r.touched);
});

test('the declared flags pass the door, value flags in both spellings', () => {
	for (const args of [
		['bootcamp', '--write', '--json', '--due', '7d', '--machine', 'claw-x'],
		['bootcamp', '--machine=claw-x', '--idle-wait=30'],
		['provision', '--confirm', '--address', '192.0.2.9', '--machine', 'claw-x'],
		['converge-provisioning', '--dry-run', '--json'],
		['converge-toolchain', '--refresh', '--plan', '--budget-min', '30', '--machine=claw-x'],
	]) {
		const r = door(...args);
		assert.doesNotMatch(r.out, /unknown flag/, `${args.join(' ')}: ${r.out}`);
	}
});
