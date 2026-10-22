/**
 * THE IDENTITY GATE MUST REFUSE A REAL COMMIT, NOT JUST RETURN 1 IN A UNIT.
 *
 * `.husky/pre-commit` runs `check-commit-identity.mjs` for every commit made in
 * this repo — including every agent worktree — so two things have to hold and
 * only one of them is about refusing:
 *
 *   - a commit under a FIXTURE identity is refused, and the refusal survives
 *     the route it actually arrives by (`git -c user.email=…`, whose value
 *     reaches the hook through `GIT_CONFIG_PARAMETERS`, not through any file);
 *   - a commit under a NORMAL identity is made. A gate that blocks everything
 *     is not a stricter gate, it is an outage — and this one sits in front of
 *     every other lane's commit.
 *
 * Every case runs in a throwaway repo with `GIT_CONFIG_GLOBAL` and
 * `GIT_CONFIG_SYSTEM` pointed at fixture files, so "the global identity" is
 * something these tests state rather than something they inherit from the
 * operator's box. Nothing here reads or writes this repository, and nothing
 * here runs `git config user.email` without `--file`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-commit-identity.mjs');

const made = [];
process.on('exit', () => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

const REAL = 'operator@example.com';

/**
 * A throwaway git repo whose GLOBAL and SYSTEM config are fixture files.
 *
 * `globalEmail: null` leaves the global file empty — the "I could not look"
 * case, which the gate must treat as a failure rather than a pass.
 */
function scratch({ globalEmail = REAL, localEmail = null } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-identity-gate-'));
	made.push(dir);
	const repo = join(dir, 'repo');
	const globalCfg = join(dir, 'gitconfig-global');
	const systemCfg = join(dir, 'gitconfig-system');
	mkdirSync(repo);
	writeFileSync(globalCfg, '');
	writeFileSync(systemCfg, '');

	// Every GIT_* the ambient shell might carry is dropped, then exactly the
	// three this fixture means are put back. A leaked GIT_DIR here would aim the
	// commit below at the real repository — the 2026-09-08 failure.
	const env = {};
	for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
	env.GIT_CONFIG_GLOBAL = globalCfg;
	env.GIT_CONFIG_SYSTEM = systemCfg;
	env.HOME = dir;

	if (globalEmail) {
		// `--file`: a config WRITE aimed at a named path, which is the form the
		// guard in hook-safe-tests.test.mjs permits and the reason it permits it.
		execFileSync('git', ['config', '--file', globalCfg, 'user.email', globalEmail], { env });
		execFileSync('git', ['config', '--file', globalCfg, 'user.name', 'Operator'], { env });
	}
	execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
	if (localEmail) {
		const local = join(repo, '.git', 'config');
		execFileSync('git', ['config', '--file', local, 'user.email', localEmail], { env });
		execFileSync('git', ['config', '--file', local, 'user.name', 'local fixture'], { env });
	}
	return { dir, repo, env, globalCfg };
}

/** The gate, run the way the hook runs it. */
function gate(repo, env, extraEnv = {}) {
	const r = spawnSync(process.execPath, [SCRIPT], {
		cwd: repo,
		env: { ...env, ...extraEnv },
		encoding: 'utf8',
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Install the gate as this scratch repo's ONLY pre-commit hook. */
function installHook(repo, env) {
	const hooks = join(repo, '.githooks');
	mkdirSync(hooks, { recursive: true });
	const hook = join(hooks, 'pre-commit');
	writeFileSync(
		hook,
		`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)}\n`
	);
	chmodSync(hook, 0o755);
	execFileSync('git', ['config', '--file', join(repo, '.git', 'config'), 'core.hooksPath', hooks], {
		env,
	});
}

test('a normal identity passes — the gate is not an outage', () => {
	const { repo, env } = scratch();
	const r = gate(repo, env);
	assert.equal(r.status, 0, r.out);
});

test('an @invalid author is refused, and the message says where it came from', () => {
	const { repo, env } = scratch({ localEmail: 'fleet-test@invalid' });
	const r = gate(repo, env);
	assert.equal(r.status, 1);
	assert.match(r.out, /fleet-test@invalid/);
	assert.match(r.out, /TEST FIXTURE/);
	// "what it resolved and from where" — a refusal with no file path leaves the
	// operator guessing between three config files and an environment variable.
	assert.match(r.out, /resolved from:.*\.git\/config/);
});

test('the literal t@t fixture is refused', () => {
	const { repo, env } = scratch({ localEmail: 't@t' });
	const r = gate(repo, env);
	assert.equal(r.status, 1);
	assert.match(r.out, /<t@t> is a TEST FIXTURE/);
});

test('an author that merely DIFFERS from the global identity is refused', () => {
	// Not a fixture, not @invalid — a plain repo-local override. It is refused
	// because a repo-local user.email is the SHAPE of the leak, whatever it says.
	const { repo, env } = scratch({ localEmail: 'someone.else@example.com' });
	const r = gate(repo, env);
	assert.equal(r.status, 1);
	assert.match(r.out, /is not your global identity/);
});

test('NO global identity fails — "I could not look" is not "nothing is wrong"', () => {
	const { repo, env } = scratch({ globalEmail: null, localEmail: REAL });
	const r = gate(repo, env);
	assert.equal(r.status, 1);
	assert.match(r.out, /no global user\.email is set/);
});

test('GIT_AUTHOR_EMAIL beats every config file, and the gate reads it', () => {
	// The env route exists: a fixture that exports GIT_AUTHOR_EMAIL would sail
	// past a gate that only read config files.
	const { repo, env } = scratch();
	const r = gate(repo, env, { GIT_AUTHOR_EMAIL: 'fleet-fixture@invalid', GIT_AUTHOR_NAME: 'x' });
	assert.equal(r.status, 1);
	assert.match(r.out, /GIT_AUTHOR_EMAIL environment variable/);
});

test('a REAL commit under `-c user.email=t@t` is refused by the hook', () => {
	// The end-to-end case, and the one a unit cannot stand in for: `-c` writes no
	// file at all. git passes it to children in GIT_CONFIG_PARAMETERS, so a gate
	// that read `.git/config` would see the operator's identity and wave it
	// through while the commit landed as `t <t@t>`.
	const { repo, env } = scratch();
	installHook(repo, env);
	writeFileSync(join(repo, 'f.txt'), 'x\n');
	execFileSync('git', ['add', '-A'], { cwd: repo, env });

	const bad = spawnSync(
		'git',
		['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'nope'],
		{
			cwd: repo,
			env,
			encoding: 'utf8',
		}
	);
	assert.equal(bad.status !== 0, true, `the commit was NOT refused:\n${bad.stdout}${bad.stderr}`);
	assert.match(`${bad.stdout}${bad.stderr}`, /TEST FIXTURE/);
	assert.equal(
		spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: repo, env }).status !== 0,
		true,
		'a refused commit still landed'
	);

	// Positive control, same repo and same hook: the good identity commits.
	const good = spawnSync('git', ['commit', '-m', 'yes'], { cwd: repo, env, encoding: 'utf8' });
	assert.equal(good.status, 0, `${good.stdout}${good.stderr}`);
	assert.equal(
		execFileSync('git', ['log', '-1', '--format=%ae'], { cwd: repo, env, encoding: 'utf8' }).trim(),
		REAL
	);
});

test('.husky/pre-commit actually runs the gate — a guard nothing invokes is a note', () => {
	// The whole value of this script is that it fires without anyone choosing to
	// run it. Deleting the hook line would leave every test above green while the
	// gate stopped existing, which is the shape of failure this repo keeps
	// finding: a manual subcommand mistaken for an automated one.
	const hook = readFileSync(join(HERE, '..', '.husky', 'pre-commit'), 'utf8');
	assert.match(hook, /check-commit-identity\.mjs/);
	const lines = hook.split('\n');
	const gate = lines.findIndex((l) => l.includes('check-commit-identity.mjs'));
	const lint = lines.findIndex((l) => l.includes('lint:fix'));
	assert.ok(
		gate >= 0 && (lint < 0 || gate < lint),
		'the identity gate must run before the ' +
			'expensive gates — there is no point linting a commit that must not be made'
	);
});
