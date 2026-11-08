/**
 * `fleet provision claw-4 --confirm` must not provision the entire fleet.
 *
 * THE BUG, measured 2026-08-30 against the real manifest:
 *
 *     ["claw-3","--confirm"]              -> only=null    claw-1, claw-2, claw-3, hokon
 *     ["--machine","claw-3","--confirm"]  -> only=claw-3   claw-3
 *     ["claw-4","--confirm"]              -> only=null    claw-1, claw-2, claw-3, hokon
 *
 * The third is the one an operator onboarding a node types. `claw-4` is not in
 * the manifest, so provision-fleet.mjs's "a node is provisioned BECAUSE it is
 * declared" guard — written for exactly that moment — never fires, because four
 * other nodes matched. A confirmed run then lands on the whole live fleet
 * including the production host, and reports success.
 *
 * WHY THESE SPAWN A PROCESS. The refusal's contract is an EXIT CODE and a
 * readable message, not a thrown object: the audience is an operator at a
 * terminal. Asserting on a throw would pass while the real command printed a
 * stack trace and exited 7. And they deliberately do NOT spawn provision-fleet
 * itself with `--confirm` — if the guard regressed, that test would carry out
 * the very fleet-wide apply it exists to prevent.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const {
	unconsumedArgs,
	manifestPath,
	selectMachines,
	runOn,
	runOnSync,
	sshDestination,
	rsyncEndpoint,
	remoteCommand,
	scriptExecCommand,
	runRsync,
	LOCAL,
	SYNC_MAX_BUFFER,
} = await import('./fleet-exec.mjs');
const { blankComments } = await import('./blank-comments.mjs');

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Call `machineArg` in a real child process and report what an operator sees. */
function machineArg(args, valueFlags = []) {
	const r = spawnSync(
		process.execPath,
		[
			'-e',
			`import('${HERE}fleet-exec.mjs').then((m) => {
				const only = m.machineArg(JSON.parse(process.env.ARGS), {
					valueFlags: JSON.parse(process.env.VALUE_FLAGS),
				});
				console.log(JSON.stringify(only));
			});`,
		],
		{
			encoding: 'utf8',
			env: {
				...process.env,
				ARGS: JSON.stringify(args),
				VALUE_FLAGS: JSON.stringify(valueFlags),
			},
		}
	);
	return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

// ── the refusal ─────────────────────────────────────────────────────────────

test('a bare positional is REFUSED, exit 1, with the reason', () => {
	const r = machineArg(['claw-4', '--confirm']);
	assert.equal(r.status, 1, 'the operator-facing contract is the exit code');
	assert.match(r.stderr, /unrecognised argument: claw-4/);
	assert.match(r.stderr, /never a bare positional/);
	assert.match(r.stderr, /Did you mean: {2}--machine claw-4/);
	assert.equal(r.stdout, '', 'nothing on stdout — five cron jobs parse it as JSON');
});

test('a positional is never treated as an implied --machine', () => {
	// Inferring it would make the safe spelling and the dangerous one differ only
	// in what the parser guessed, which is the ambiguity this repo refuses.
	const r = machineArg(['claw-3']);
	assert.equal(r.status, 1);
	assert.notEqual(r.stdout, '"claw-3"');
});

test('the exact reported command line — `claw-3 --confirm` — is refused', () => {
	assert.equal(machineArg(['claw-3', '--confirm']).status, 1);
});

test('--machine with no value is refused rather than scoping to nothing', () => {
	// `--machine --confirm` would otherwise scope to a node named "--confirm",
	// match zero nodes, and let a deployer report a clean pass over nothing.
	assert.equal(machineArg(['--machine']).status, 1);
	const r = machineArg(['--machine', '--confirm']);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /needs a machine name, got --confirm/);
});

// ── what must still work ────────────────────────────────────────────────────

test('the safe spelling still returns the node', () => {
	const r = machineArg(['--machine', 'claw-3', '--confirm']);
	assert.equal(r.status, 0);
	assert.equal(r.stdout, '"claw-3"');
});

test('no scoping at all is still null — a fleet-wide run is a legitimate ask', () => {
	const r = machineArg(['--confirm']);
	assert.equal(r.status, 0);
	assert.equal(r.stdout, 'null');
});

test('a declared value flag swallows its value, which is not a stray positional', () => {
	// clean-runner-debris passes --diag-keep-days 7. Without valueFlags the `7`
	// reads as a positional and the subcommand refuses its own documented usage.
	const r = machineArg(['--diag-keep-days', '7', '--json'], ['--diag-keep-days']);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, 'null');
	// And with the flag UNDECLARED it is correctly a stray — proving the list is
	// what does the work, rather than the check being inert.
	assert.equal(machineArg(['--diag-keep-days', '7']).status, 1);
});

test('everything after `--` is left alone', () => {
	const r = machineArg(['--machine', 'claw-3', '--', 'anything', 'at', 'all']);
	assert.equal(r.status, 0);
	assert.equal(r.stdout, '"claw-3"');
});

// ── the pure half ───────────────────────────────────────────────────────────

test('unconsumedArgs reports every stray, not just the first', () => {
	assert.deepEqual(unconsumedArgs(['claw-3', '--confirm', 'claw-4']), ['claw-3', 'claw-4']);
	assert.deepEqual(unconsumedArgs(['--machine', 'claw-3', '--confirm']), []);
});

test('an unknown boolean flag is deliberately NOT a stray', () => {
	// Refusing unknown flags would mean every caller declaring its whole flag set
	// here, and they do not agree on one — `--restart` exists in the slice
	// deployer alone. Pinned so the scope of this guard stays honest.
	assert.deepEqual(unconsumedArgs(['--restart', '--confirm']), []);
});

// ── importing must not require operator config ────────────────────

test('importing fleet-exec does not need a hadoku_site checkout on disk', () => {
	// THE REGRESSION. `MANIFEST_PATH` used to be a module-level const, so
	// `manifestDir() -> siteRoot()` ran at import and threw when no sibling
	// checkout existed. A CI runner has none, so THIS FILE died before a single
	// test ran and CI was red for 46 runs across ~10 hours (40b42ce, 2026-08-30)
	// while publish shipped twelve versions past it.
	//
	// Spawned with the runner's own environment, not asserted on a symbol: the
	// failure was an IMPORT, and nothing observable from inside a module that
	// already loaded can fail when the load is what breaks.
	const r = spawnSync(
		process.execPath,
		['-e', `import('${HERE}fleet-exec.mjs').then(() => console.log('imported'))`],
		{
			encoding: 'utf8',
			// REPOS_DIR is what the cron jobs set and what siteRoot() falls back to;
			// cwd is outside any checkout so gitToplevel() cannot rescue it either.
			cwd: tmpdir(),
			env: { ...process.env, REPOS_DIR: '/nonexistent', HADOKU_SITE_ROOT: '' },
		}
	);
	assert.equal(r.status, 0, `import threw without a site checkout:\n${r.stderr}`);
	assert.match(r.stdout, /imported/);
});

test('the manifest path stays a function — a const would re-freeze the coupling', () => {
	// Comments are not evidence (handoff §2), so this reads the EXPORT, not the
	// source: a getter or a const both fail here, and only a callable passes.
	assert.equal(typeof manifestPath, 'function', 'manifestPath must stay lazy');
});

test('a caller that actually needs the manifest still fails LOUDLY', () => {
	// Deferring the throw must not soften it. "I could not look" may never render
	// as "nothing is wrong" — an unresolvable manifest is a healthy fleet of zero
	// machines, which is the exact failure siteRoot() throws to prevent.
	const r = spawnSync(
		process.execPath,
		['-e', `import('${HERE}fleet-exec.mjs').then((m) => { m.loadManifest(); })`],
		{
			encoding: 'utf8',
			cwd: tmpdir(),
			env: { ...process.env, REPOS_DIR: '/nonexistent', HADOKU_SITE_ROOT: '' },
		}
	);
	assert.notEqual(r.status, 0, 'loadManifest() with no resolvable manifest must throw');
	assert.match(r.stderr, /hadoku_site checkout does not exist/);
});

// ── the call sites ──────────────────────────────────────────────────────────

test('every machine-scoped subcommand routes through machineArg', () => {
	// Comments are not evidence — this repo has been bitten three times by a grep
	// crediting prose (handoff §2). Blank them before looking, so the paragraph
	// ABOVE explaining the private copies cannot satisfy the rule that replaced
	// them.
	const scoped = [
		'provision-fleet.mjs',
		'deploy-runners-slice.mjs',
		'deploy-ci-throttle.mjs',
		'toolchain.mjs',
		'clean-runner-debris.mjs',
		'reconcile-runner-identity.mjs',
	];
	for (const file of scoped) {
		const src = blankComments(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
		assert.match(src, /machineArg\(/, `${file} must scope through machineArg`);
		assert.doesNotMatch(
			src,
			/indexOf\('--machine'\)/,
			`${file} still has a private --machine parser; it has the same silent-positional hole`
		);
	}
});

// ── selection: no role gate ────────────────────────────────────────────────

const ROLES = {
	machines: {
		'claw-1': { role: 'claw' },
		hokon: { role: 'backstop' },
		unclassified: {},
	},
};

test('selectMachines selects the backstop like any node, honouring `only` and `where`', () => {
	// hadoku_site's scripts/admin/check-boundary-contracts.mjs imports this by
	// name. There is no role filter in the transport: a script that must leave
	// the backstop out says so itself.
	assert.deepEqual(
		selectMachines(ROLES).map(([n]) => n),
		['claw-1', 'hokon', 'unclassified']
	);
	assert.deepEqual(
		selectMachines(ROLES, { only: 'hokon' }).map(([n]) => n),
		['hokon']
	);
	assert.deepEqual(
		selectMachines(ROLES, { where: (m, name) => name !== 'unclassified' }).map(([n]) => n),
		['claw-1', 'hokon']
	);
});

test('runOnSync runs on the backstop like any node', () => {
	// THIS BOX, by its own name, so the run is `bash -s` and no packet leaves the
	// machine.
	const r = runOnSync(LOCAL, 'echo reached', {
		manifest: { machines: { [LOCAL]: { role: 'backstop' } } },
	});
	assert.equal(r.ok, true, `it genuinely ran: ${r.error}`);
	assert.match(r.out, /reached/);
	assert.equal(r.skippedByRole, undefined);
});

// ── #37: the sync transport's buffer, and a failure that says what kind ──────

/** A manifest that names no users: every role is the admin default, and this box runs as-is. */
const BARE = { machines: {} };

test('runOnSync brings back 2 MiB by DEFAULT — the size that read claw-1 as unreachable', () => {
	// Node's own default is 1 MiB. claw-1's job-metrics.jsonl was 1,136,332
	// bytes on 2026-09-18 and `fleet job-metrics` reported the node as
	// `spawnSync ssh ENOBUFS`. No maxBuffer is passed here: the DEFAULT is the
	// thing under test, because that is what every caller gets.
	const bytes = 2 * 1024 * 1024;
	const r = runOnSync(LOCAL, `head -c ${bytes} /dev/zero | tr '\\0' x`, { manifest: BARE });
	assert.equal(r.ok, true, `${r.code}: ${r.error}`);
	assert.equal(r.out.length, bytes);
	assert.equal(SYNC_MAX_BUFFER, 64 * 1024 * 1024, 'sized for the fleet, not for one file');
});

test('a caller can still set its own ceiling, and overflowing it is ENOBUFS, not a message', () => {
	const r = runOnSync(LOCAL, "head -c 4096 /dev/zero | tr '\\0' x", {
		maxBuffer: 1024,
		manifest: BARE,
	});
	assert.equal(r.ok, false);
	assert.equal(r.code, 'ENOBUFS', 'the errno is a field a caller can branch on');
});

test('a script that exits non-zero reports its STATUS and no errno', () => {
	// The shape a caller needs to tell ssh's own 255 from a node-side failure.
	const r = runOnSync(LOCAL, 'echo partial; echo why >&2; exit 3', { manifest: BARE });
	assert.equal(r.ok, false);
	assert.equal(r.status, 3);
	assert.equal(r.code, null, 'nothing failed on this side of the pipe');
	assert.equal(r.out, 'partial\n', 'what did arrive is kept');
	assert.match(r.error, /why/);
	const ok = runOnSync(LOCAL, 'true', { manifest: BARE });
	assert.equal(ok.status, 0);
	assert.equal(ok.code, null);
});

// ── node users: every call acts as a ROLE (src/lib/node-users.ts) ───────────

test('a role this process cannot play locally is a failed RESULT, never a throw', () => {
	const r = runOnSync(LOCAL, 'echo reached', {
		as: 'ci',
		manifest: { machines: { [LOCAL]: { users: { ci: 'nobody-ci-fixture' } } } },
	});
	assert.equal(r.ok, false);
	assert.equal(r.out.includes('reached'), false, 'and it did not run as the wrong user');
	assert.match(r.error, /cannot act as the role: .*needs nobody-ci-fixture/);
});

test('a malformed user in the manifest refuses the call instead of falling back to admin', async () => {
	const r = await runOn(LOCAL, 'echo reached', {
		as: 'ci',
		manifest: { machines: { [LOCAL]: { users: { ci: 'Not A User' } } } },
	});
	assert.equal(r.ok, false);
	assert.match(r.error, /users\.ci/);
});

test('sshDestination logs in as the role the node names', () => {
	const manifest = { machines: { 'claw-5': { users: { ci: 'hadoku-ci' } } } };
	assert.equal(sshDestination('claw-5', 'ci', manifest), 'hadoku-ci@claw-5');
	assert.match(sshDestination('claw-5', 'admin', manifest), /^[a-z_][a-z0-9_-]*@claw-5$/);
});

test('rsyncEndpoint is user@node:path remotely and a plain local path on this box', () => {
	// hokon refuses ssh to itself: claw-10's seed died on `hadoku@hokon:` (2026-11-03).
	const manifest = { machines: { 'claw-5': { users: { ci: 'hadoku-ci' } } } };
	assert.equal(
		rsyncEndpoint('claw-5', 'ci', '.cache/ms-playwright', manifest),
		'hadoku-ci@claw-5:.cache/ms-playwright'
	);
	const me = userInfo().username;
	const local = { machines: { [LOCAL]: { users: { admin: me, ci: me } } } };
	assert.equal(
		rsyncEndpoint(LOCAL, 'ci', '.cache/ms-playwright', local),
		join(homedir(), '.cache/ms-playwright')
	);
	const other = { machines: { [LOCAL]: { users: { admin: me, ci: `${me}-ci` } } } };
	assert.throws(() => rsyncEndpoint(LOCAL, 'ci', 'x', other), /cannot act as it/);
});

test('a call killed at its timeout SAYS it timed out, not just "Command failed"', async () => {
	const r = await runOn(LOCAL, 'sleep 5', {
		as: 'admin',
		timeoutMs: 300,
		manifest: { machines: {} },
	});
	assert.equal(r.ok, false);
	assert.match(r.error, /^no answer within 0s \(killed by SIGTERM\)$/);
});

test("otherwise the far side's last words are the reason", async () => {
	const r = await runOn(
		LOCAL,
		'echo first >&2; echo "ssh: Could not resolve hostname x" >&2; exit 255',
		{
			as: 'admin',
			manifest: { machines: {} },
		}
	);
	assert.equal(r.error, 'ssh: Could not resolve hostname x');
});

test('the sync transport says so too, and keeps ETIMEDOUT as the branchable code', () => {
	const r = runOnSync(LOCAL, 'sleep 5', {
		as: 'admin',
		timeoutMs: 300,
		manifest: { machines: {} },
	});
	assert.equal(r.ok, false);
	assert.equal(r.code, 'ETIMEDOUT');
	assert.match(r.error, /^no answer within 0s/);
});

// ── F5: remoteCommand, scriptExecCommand, runRsync ───────────────────────────
//
// drain-node.mjs's `busyOn`, toolpack.mjs's `on`, seed-node-cache.mjs's
// writable-check and benchmark-fleet.mjs's capture each hand-rolled a
// `['ssh', [...]]`/`['bash', [...]]` tuple instead of going through this
// file. These three replace all four call sites (F5).

test('remoteCommand runs a one-liner locally through bash -c, no ssh involved', () => {
	const [cmd, argv] = remoteCommand(LOCAL, 'admin', 'echo reached', {
		manifest: { machines: {} },
	});
	assert.equal(cmd, 'bash');
	assert.deepEqual(argv, ['-c', 'echo reached']);
});

test('remoteCommand builds the exact ssh argv the four hand-rolled copies built', () => {
	// Byte-for-byte the shape `drain-node.mjs`/`toolpack.mjs` built directly:
	// BatchMode, a per-call ConnectTimeout, `-n` (no stdin), the role's
	// user@node, and the one-liner as the remote COMMAND, not stdin.
	// The node is `claw-fixture`, a name no box carries: these tests ran as
	// `claw-9` until CI landed on claw-9, where isLocalNode made it `bash`.
	const [cmd, argv] = remoteCommand('claw-fixture', 'admin', 'pgrep -c -f x', {
		connectTimeout: 6,
		manifest: { machines: { 'claw-fixture': {} } },
	});
	assert.equal(cmd, 'ssh');
	assert.deepEqual(argv.slice(0, 4), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6']);
	assert.ok(argv.includes('-n'), 'no caller here writes to stdin');
	assert.match(argv.at(-2), /^[a-z_][a-z0-9_-]*@claw-fixture$/);
	assert.equal(argv.at(-1), 'pgrep -c -f x');
});

test('remoteCommand actually reaches this box and brings back the answer', () => {
	const [cmd, argv] = remoteCommand(LOCAL, 'admin', 'echo one; echo two', {
		manifest: { machines: {} },
	});
	const out = execFileSync(cmd, argv, { encoding: 'utf8' });
	assert.equal(out, 'one\ntwo\n');
});

test('scriptExecCommand feeds the script over stdin, not as an ssh argument', () => {
	// The hard caller (benchmark-fleet.mjs): sudo + a non-bash interpreter +
	// positional args after `--`, joined into ONE command string — ssh joins
	// its own trailing argv with spaces before sending it either way, so this
	// is byte-identical to what the four hand-built argv elements sent.
	const [cmd, argv] = scriptExecCommand('claw-fixture', 'admin', {
		connectTimeout: 8,
		interpreter: 'sh',
		sudo: true,
		passthru: ['--quick'],
		manifest: { machines: { 'claw-fixture': {} } },
	});
	assert.equal(cmd, 'ssh');
	assert.deepEqual(argv.slice(0, 4), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']);
	assert.ok(!argv.includes('-n'), 'stdin carries the script; -n would break that');
	assert.equal(argv.at(-1), 'sudo sh -s -- --quick');
});

test('scriptExecCommand without sudo omits it, same interpreter and args', () => {
	const [, argv] = scriptExecCommand('claw-fixture', 'admin', {
		interpreter: 'sh',
		sudo: false,
		passthru: ['--quick'],
		manifest: { machines: { 'claw-fixture': {} } },
	});
	assert.equal(argv.at(-1), 'sh -s -- --quick');
});

test('scriptExecCommand actually runs the script and sees the passthru args', () => {
	const [cmd, argv] = scriptExecCommand(LOCAL, 'admin', {
		interpreter: 'sh',
		sudo: false,
		passthru: ['x', 'y'],
		manifest: { machines: {} },
	});
	const out = execFileSync(cmd, argv, { input: 'echo "$1 $2"', encoding: 'utf8' });
	assert.equal(out, 'x y\n');
});

test('runRsync spawns rsync with exactly the args given, no transport logic of its own', () => {
	const out = runRsync(['--version']).toString();
	assert.match(out, /^rsync\s+version/);
});

test('runRsync propagates a real failure rather than swallowing it', () => {
	assert.throws(() => runRsync(['--this-flag-does-not-exist']), /rsync/);
});
