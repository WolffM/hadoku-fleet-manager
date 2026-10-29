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
import { JSON_CONTRACT, parseCliCommands } from './json-contract.mjs';
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
	return {
		status: r.status,
		out: r.stdout + r.stderr,
		stdout: r.stdout,
		stderr: r.stderr,
		touched,
	};
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

// --- fleet-manager#27: the door's own flags-refusal is --json-aware ---------
//
// `src/cli.ts`'s generic `cmd.flags` unknown-flag check (shared by every
// hand-kept `flags:` entry AND, since F8 step 2, every migrated script's
// derived one) used to print stderr prose and leave stdout EMPTY — so a
// caller that spawns the door, passes `--json`, and reads stdout for a
// document (exactly what `json-contract-behaviour.test.mjs` proved
// `converge-toolchain`'s KNOWN_BROKEN row did) saw nothing to parse. Fixed:
// the refusal now checks for `--json` in the CHILD's own argv and emits
// `{ok:false, error}` on stdout instead, before the script is ever spawned.

test('fleet-manager#27: an unknown flag under --json is ONE JSON document on stdout, exit 2', () => {
	// `converge-toolchain` already carries a hand-kept `flags:` list (debt,
	// not yet F8-migrated) — this is the ORIGINAL KNOWN_BROKEN case.
	const r = door('converge-toolchain', '--refresh', '--json', '--zz-typo');
	assert.equal(r.status, 2, r.out);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, false);
	assert.match(doc.error, /unknown flag\(s\) --zz-typo — nothing was run\./);
	assert.equal(r.stderr, '', 'nothing else is written once the door answers under --json');
});

test('fleet-manager#27: the same refusal, for an F8-migrated command (door-derived flags)', () => {
	// `toolpack.mjs` carries no hand-kept `flags:` in `COMMANDS` at all — its
	// door-side list is DERIVED from `scripts/lib/argv-specs.mjs`, the same
	// spec the script parses its own argv with (F8 step 2). Refused at the
	// door, before `toolpack.mjs` is even spawned.
	const r = door('toolpack', '--json', '--zz-typo');
	assert.equal(r.status, 2, r.out);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, false);
	assert.match(doc.error, /unknown flag\(s\) --zz-typo — nothing was run\./);
	assert.equal(r.touched, '', 'refused before anything ran');
});

test('fleet-manager#27: without --json, the refusal stays human-readable prose on stderr', () => {
	const r = door('converge-toolchain', '--refresh', '--zz-typo');
	assert.equal(r.status, 2, r.out);
	assert.equal(r.stdout, '', 'no JSON is emitted when the caller never asked for it');
	assert.match(r.stderr, /unknown flag\(s\) --zz-typo — nothing was run\./);
});

// --- `kind` + grouped help (wave 5b §D step 4) ------------------------------

const KNOWN_KINDS = [
	'gate',
	'converger',
	'recorder',
	'mutator',
	'operator',
	'onboarding',
	'node-side',
];

test('every COMMANDS entry declares a kind from the fixed vocabulary', () => {
	const src = blankComments(readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8'));
	const start = src.indexOf('const COMMANDS');
	const end = src.indexOf('\n};', start);
	const body = src.slice(start, end);
	const kinds = [...body.matchAll(/\bkind: '([\w-]+)'/g)].map((m) => m[1]);
	assert.equal(
		kinds.length,
		commands.size,
		`found ${kinds.length} "kind:" field(s) for ${commands.size} COMMANDS entries — every entry must carry one`
	);
	for (const k of kinds) {
		assert.ok(
			KNOWN_KINDS.includes(k),
			`"${k}" is not in the fixed Kind vocabulary (${KNOWN_KINDS.join(', ')})`
		);
	}
});

test('fleet --help (no subcommand) lists every command exactly once, grouped', () => {
	const r = door();
	const lines = r.out.split('\n').map((l) => l.trim());
	for (const sub of commands.keys()) {
		const occurrences = lines.filter((l) => l === sub || l.startsWith(`${sub} `)).length;
		assert.equal(
			occurrences,
			1,
			`"${sub}" appears ${occurrences} time(s) in \`fleet --help\`:\n${r.out}`
		);
	}
});

test('no contracted subcommand name changed, adding `kind`/`domain` touched nothing else', () => {
	// `parseCliCommands`/`JSON_CONTRACT` both read SOURCE, never execute it, so
	// this catches a renamed key independently of json-contract.test.mjs's own
	// equivalent check. Plus the two tenant-contract subcommands the wave file
	// names explicitly (cardtable: `node-status --json --max-age`,
	// `hosting-demand --slices --json --release-order`) and the six migrated
	// in this wave, which carry no `--json` contract but DO carry callers
	// outside this repo (`src/claw-reboot.ts` spawns `reboot-claws.mjs`
	// directly; see this lane's closing note for the rest).
	for (const sub of JSON_CONTRACT.map((e) => e.sub)) {
		assert.ok(commands.has(sub), `"${sub}" is in JSON_CONTRACT but missing from the door table`);
	}
	for (const sub of [
		'node-status',
		'hosting-demand',
		'reboot-claws',
		'drain',
		'backstop',
		'toolpack',
		'traffic',
		'job-rollups',
	]) {
		assert.ok(
			commands.has(sub),
			`"${sub}" is missing from the door table — a contracted name changed`
		);
	}
});
