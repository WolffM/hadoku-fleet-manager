/**
 * The invocation log, through the REAL door (dist/cli.js).
 *
 * Four promises the log makes to every caller of `fleet`, each checked by
 * running the built CLI:
 *   1. the record carries the exit code the caller actually got;
 *   2. a flag VALUE never reaches the file, only its name;
 *   3. stdout is byte-identical with the log on and off — `--json` is a
 *      contract, and the log is the newest thing that could break it;
 *   4. a write that fails changes neither the exit code nor stdout, and says
 *      so on stderr once.
 *
 * Every run names its own FLEET_USAGE_DIR (or `off`), and HADOKU_STATE_DIR
 * points into the fixture, so nothing here can reach `~/.hadoku-mgmt`.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, cleanupTempDirs } from './test-tmpdir.mjs';

after(cleanupTempDirs);

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI = join(ROOT, 'dist', 'cli.js');
const SECRET = 'ghp_DO_NOT_LOG_THIS_VALUE';

function door(args, usageDir, extraEnv = {}) {
	const fx = tempDir('usage-door-');
	const r = spawnSync(process.execPath, [CLI, ...args], {
		encoding: 'buffer',
		timeout: 30_000,
		env: {
			...process.env,
			HADOKU_STATE_DIR: join(fx, 'state'),
			FLEET_MANIFEST_DIR: join(ROOT, 'manifests'),
			HADOKU_SITE_ROOT: '/nonexistent-fleet-site',
			REPOS_DIR: '/nonexistent-fleet-repos',
			FLEET_NO_BANNER: '1',
			FLEET_USAGE_DIR: usageDir,
			...extraEnv,
		},
	});
	return { status: r.status, stdout: r.stdout, stderr: r.stderr.toString('utf8') };
}

function records(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((f) =>
		readFileSync(join(dir, f), 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l))
	);
}

test('the CLI is built, so the runs below are not vacuous', () => {
	assert.ok(existsSync(CLI), 'dist/cli.js is missing — run `pnpm run build` first');
});

test('each record carries the exit code the caller got, and how the door disposed of it', () => {
	const dir = join(tempDir('usage-log-'), 'log');
	const cases = [
		{ args: ['capability-schema', '--json'], status: 0, outcome: 'ran' },
		{
			args: ['capability-schema', '--json'],
			env: { FLEET_MANIFEST_DIR: '/nonexistent' },
			status: 1,
			outcome: 'ran',
		},
		{ args: ['bootcamp', '--dryrun'], status: 2, outcome: 'refused-flags' },
		{ args: ['no-such-door'], status: 1, outcome: 'unknown-subcommand' },
		{ args: ['register', '--help'], status: 0, outcome: 'door-help' },
		{ args: ['--help'], status: 0, outcome: 'usage' },
		{ args: [], status: 1, outcome: 'usage' },
	];
	for (const c of cases) {
		const r = door(c.args, dir, c.env);
		assert.equal(r.status, c.status, `fleet ${c.args.join(' ')}: ${r.stderr}`);
	}
	const got = records(dir);
	assert.equal(got.length, cases.length, 'one record per invocation');
	cases.forEach((c, i) => {
		assert.equal(got[i].exit, c.status, `record ${i} (${c.args.join(' ')}) exit`);
		assert.equal(got[i].outcome, c.outcome, `record ${i} (${c.args.join(' ')}) outcome`);
		assert.equal(got[i].kind, 'cli');
		assert.equal(got[i].v, 1);
		assert.equal(typeof got[i].ms, 'number');
		assert.equal(typeof got[i].host, 'string');
		assert.match(got[i].version, /^\d+\.\d+\.\d+/);
	});
	assert.equal(got[0].sub, 'capability-schema');
	assert.equal(got[0].known, true);
	assert.equal(got[3].known, false);
	assert.equal(got[6].sub, null);
});

test('a flag VALUE never reaches the log, in either spelling', () => {
	const dir = join(tempDir('usage-log-'), 'log');
	door(['capability-schema', `--token=${SECRET}`, '--machine', SECRET, SECRET], dir);
	const raw = readdirSync(dir)
		.map((f) => readFileSync(join(dir, f), 'utf8'))
		.join('');
	assert.ok(raw.length > 0, 'nothing was logged, so nothing was proved');
	assert.ok(!raw.includes(SECRET), `the log holds a value: ${raw}`);
	assert.deepEqual(records(dir)[0].flags, ['--token', '--machine']);
});

test('stdout is byte-identical with the log on and off', () => {
	for (const args of [['capability-schema', '--json'], ['--help'], ['register', '--help']]) {
		const off = door(args, 'off');
		const on = door(args, join(tempDir('usage-log-'), 'log'));
		assert.ok(off.stdout.length > 0, `fleet ${args.join(' ')} printed nothing to compare`);
		assert.ok(
			Buffer.compare(off.stdout, on.stdout) === 0,
			`fleet ${args.join(' ')} stdout differs`
		);
		assert.equal(on.status, off.status);
		assert.equal(on.stderr, off.stderr, 'a successful log write is silent on stderr too');
	}
});

test('a write that fails changes neither the exit code nor stdout, and says so once on stderr', () => {
	const fx = tempDir('usage-log-');
	const blocker = join(fx, 'a-file');
	writeFileSync(blocker, 'not a directory');
	const unwritable = join(blocker, 'log'); // ENOTDIR on mkdir
	for (const [args, status] of [
		[['capability-schema', '--json'], 0],
		[['bootcamp', '--dryrun'], 2],
	]) {
		const off = door(args, 'off');
		const bad = door(args, unwritable, { FLEET_NO_BANNER: '0' });
		assert.equal(bad.status, status);
		assert.equal(off.status, status);
		assert.ok(Buffer.compare(off.stdout, bad.stdout) === 0, 'stdout changed on a failed write');
		const warnings = bad.stderr.split('\n').filter((l) => l.includes('invocation log not written'));
		assert.equal(warnings.length, 1, bad.stderr);
	}
	// And FLEET_NO_BANNER=1 keeps fd 2 byte-identical even then.
	const quiet = door(['capability-schema', '--json'], unwritable);
	assert.ok(!quiet.stderr.includes('invocation log'), quiet.stderr);
});

test('`fleet usage` reads it back: counts, exit mix, and the doors nobody opened', () => {
	const dir = join(tempDir('usage-log-'), 'log');
	door(['capability-schema', '--json'], dir);
	door(['capability-schema', '--json'], dir, { FLEET_MANIFEST_DIR: '/nonexistent' });
	const r = door(['usage', '--since', '1d', '--json'], dir);
	assert.equal(r.status, 0, r.stderr);
	const doc = JSON.parse(r.stdout.toString('utf8'));
	assert.equal(doc.ok, true);
	const cs = doc.commands.find((c) => c.sub === 'capability-schema');
	assert.equal(cs.count, 2);
	assert.deepEqual(cs.exits, { 0: 1, 1: 1 });
	assert.ok(doc.unusedCommands.includes('register'));
	assert.ok(!doc.unusedCommands.includes('capability-schema'));
	assert.deepEqual(doc.unusedRoutes.length, 3);
});

test('`fleet usage` with no log FAILS — "I could not look" is not "nobody ran anything"', () => {
	const r = door(['usage', '--json'], join(tempDir('usage-log-'), 'never-written'));
	// Its own invocation is logged AFTER it reads, so the dir is still empty when it looks.
	assert.equal(r.status, 1);
	const doc = JSON.parse(r.stdout.toString('utf8'));
	assert.equal(doc.ok, false);
	assert.match(doc.why, /no invocation log/);
});

test('`fleet usage` outside the door refuses rather than guessing the table', () => {
	const dir = join(tempDir('usage-log-'), 'log');
	door(['capability-schema', '--json'], dir);
	const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'fleet-usage.mjs'), '--json'], {
		encoding: 'utf8',
		env: { ...process.env, FLEET_USAGE_DIR: dir, FLEET_DOOR_COMMANDS: '' },
	});
	assert.equal(r.status, 1);
	assert.match(JSON.parse(r.stdout).why, /FLEET_DOOR_COMMANDS/);
});
