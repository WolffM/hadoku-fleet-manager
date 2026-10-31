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
import { matchLayer } from './layer-map.mjs';
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

// --- lazy CLI domain (wave 5c §D step 2) ------------------------------------
//
// Until 2026-10-30 `src/cli.ts` resolved every COMMANDS entry's domain EAGERLY
// at import time and THREW on the first one neither `layer-map.mjs` nor its
// `UNMEASURED_DOMAIN` fallback named — so one missing mapping broke every
// subcommand, mgmt-api's crons included, none of which ever render `--help`.
// The invariant itself ("every command resolves a domain") still has to hold
// somewhere; it moved HERE, so CI catches a missing mapping and production
// never pays for the check on every invocation.

/**
 * `src/cli.ts`'s own fallback table for scripts `layer-map.mjs` does not
 * cover (`.sh`/`.py` onboarding scripts outside its import-graph scope).
 * Parsed from SOURCE, like `parseCliCommands` above, rather than imported:
 * `cli.ts` runs `process.argv` at module scope, so importing it would
 * execute the real CLI.
 */
function parseUnmeasuredDomain(blankedSource) {
	const start = blankedSource.indexOf('const UNMEASURED_DOMAIN');
	const end = blankedSource.indexOf('\n};', start);
	const body = blankedSource.slice(start, end);
	const out = {};
	for (const m of body.matchAll(/'([^']+)':\s*'([^']+)'/g)) out[m[1]] = m[2];
	return out;
}

test('every COMMANDS entry resolves a domain — layer-map.mjs or UNMEASURED_DOMAIN names one', () => {
	const src = blankComments(readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8'));
	const fallback = parseUnmeasuredDomain(src);
	const missing = [];
	for (const [sub, script] of commands) {
		const entry = matchLayer(`scripts/${script}`);
		const resolved = entry ? (entry.domain ?? entry.layer) : fallback[script];
		if (!resolved) missing.push(`${sub} (scripts/${script})`);
	}
	assert.deepEqual(
		missing,
		[],
		`no domain for: ${missing.join(', ')} — add scripts/${missing} to layer-map.mjs ` +
			`(plan §3.1/§3.2) or to UNMEASURED_DOMAIN in src/cli.ts`
	);
});

test('domainFor is called only from inside domainOf — never eagerly, at module scope', () => {
	// The exact shape of the 2026-10-30 bug: a top-level `for (const cmd of
	// Object.values(COMMANDS)) { cmd.domain = domainFor(cmd.script); ... }`
	// ran at IMPORT time, before any subcommand was even looked up, and threw
	// on the first unmapped script — breaking every subcommand (crons
	// included) on one missing mapping. A scan restricted to "after the
	// dispatch marker" would miss that: the eager loop ran BEFORE it too.
	// So this strips `domainOf`'s own function body (its one legitimate call
	// site) out of the source entirely, then asserts no `domainFor(` CALL
	// remains anywhere else — top-level loop or otherwise. `(?<!function )`
	// excludes the declaration line itself (`function domainFor(...)`).
	const src = blankComments(readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8'));
	const domainOfStart = src.indexOf('function domainOf(');
	assert.ok(domainOfStart !== -1, 'domainOf not found — did cli.ts change shape?');
	const domainOfEnd = src.indexOf('\n}', domainOfStart);
	assert.ok(domainOfEnd !== -1, "domainOf's closing brace not found");
	const withoutDomainOf = src.slice(0, domainOfStart) + src.slice(domainOfEnd + '\n}'.length);
	assert.doesNotMatch(
		withoutDomainOf,
		/(?<!function )\bdomainFor\(/,
		'domainFor is called from somewhere other than domainOf — an eager/top-level call would ' +
			'throw for every subcommand on one missing mapping, exactly the 2026-10-30 bug'
	);
});

test('usage() is the only caller of domainOf', () => {
	// The other half of the same guarantee: domainOf's own fallback (catching
	// domainFor's throw) is pointless if something calls it OUTSIDE usage(),
	// since that caller would need its own fallback too. `usage()`'s body
	// closes at the next `\n}` after its signature, same heuristic as above.
	const src = blankComments(readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8'));
	const usageStart = src.indexOf('function usage(): void {');
	assert.ok(usageStart !== -1, 'usage() not found — did cli.ts change shape?');
	const usageEnd = src.indexOf('\n}', usageStart);
	assert.ok(usageEnd !== -1, "usage()'s closing brace not found");
	const usageBody = src.slice(usageStart, usageEnd);
	assert.match(usageBody, /\bdomainOf\(/, 'usage() no longer calls domainOf — did the fix move?');
	const outsideUsage = src.slice(0, usageStart) + src.slice(usageEnd + '\n}'.length);
	// domainOf's OWN definition (`function domainOf(c: Command): string {`)
	// contains the identifier too; exclude just the declaration line.
	assert.doesNotMatch(
		outsideUsage,
		/(?<!function )\bdomainOf\(/,
		'domainOf is called from somewhere other than usage()'
	);
});

test('an unmapped command still dispatches: domain resolution is unreachable from the dispatch path', () => {
	// Combines the two guarantees above with where dispatch actually lives:
	// everything from `const [name, ...rest] = process.argv.slice(2);` to the
	// end of the file is the dispatch path for a RECOGNIZED subcommand (the
	// no-name/`--help`/unknown-name branches call `usage()` and exit before
	// a script ever runs — see the lines right after the marker). Neither
	// `domainFor(` nor a bare `domainOf(` call appears there outside of those
	// `usage()` calls, so a command missing from both registries would still
	// reach and run its script; only `fleet --help`'s rendering — and the two
	// source tests above, in CI — would ever learn it has no domain.
	const src = blankComments(readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8'));
	const dispatchStart = src.indexOf('const [name, ...rest] = process.argv.slice(2);');
	assert.ok(dispatchStart !== -1, 'dispatch marker line not found — did cli.ts change shape?');
	const dispatch = src.slice(dispatchStart).replace(/\busage\(\)/g, '');
	assert.doesNotMatch(dispatch, /\bdomainFor\(/, 'domainFor is reachable from dispatch');
	assert.doesNotMatch(dispatch, /\bdomainOf\(/, 'domainOf is called from dispatch outside usage()');
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
	// The real, built CLI's own fallback, exercised end to end: `usage()`
	// groups an unresolved domain under `(unmapped)` rather than throwing.
	// It must never actually have to, today — this is the behavioural half
	// of the two domain tests above (those are source-level).
	assert.ok(
		!lines.includes('(unmapped)'),
		`a command rendered under "(unmapped)" in \`fleet --help\`:\n${r.out}`
	);
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
