/**
 * `removeScript` never asks a GUEST for sudo — Wave 3g J2, 3f's leftover.
 *
 * `reconcile-fleet-runners.mjs` keeps the guest IN scope (`INCLUDE_GUESTS`):
 * its backstop registrations are what that file maintains, so a retired repo's
 * registration on the guest is a removal target. The system-unit branch used
 * to try `sudo -n` wherever it ran, which on a guest is the fleet asking the
 * production host for root — the thing the 2026-09-14 decision rules out.
 *
 * Generated the way `src/tests/generated-scripts.test.ts` generates it: the
 * function is lifted out of the module source and run, because importing the
 * CLI would execute it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

// removeScript's own definition moved to lib/reconcile-scripts.mjs (wave 5g
// lane C, pure move); this test file is already in scripts/lib, so it is a
// sibling now. Its CALL SITES and `removeRegistration` (the #123 by-id
// fallback) stayed in the CLI, reconcile-fleet-runners.mjs, so CLI_SRC below
// reads that file for the tests that check those.
const SRC = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), 'reconcile-scripts.mjs'),
	'utf8'
);
const CLI_SRC = readFileSync(
	join(dirname(dirname(fileURLToPath(import.meta.url))), 'reconcile-fleet-runners.mjs'),
	'utf8'
);

function removeScript(args) {
	const start = SRC.indexOf('function removeScript');
	assert.notEqual(start, -1, 'removeScript not found');
	const end = SRC.indexOf('\n}', SRC.indexOf('return', start)) + 2;
	const make = new Function('repoSuffix', `return ${SRC.slice(start, end)}`);
	return make((r) => r.split('/').pop().toLowerCase())(args);
}

/** Executable lines only — an `echo` that SAYS sudo invokes nothing. */
const commands = (s) =>
	s
		.split('\n')
		.filter((l) => {
			const t = l.trim();
			return t && !t.startsWith('#') && !t.startsWith('echo');
		})
		.join('\n');

test('on a GUEST the system path invokes no sudo at all, and stops at NEEDS_ROOT', () => {
	const s = removeScript({ repo: 'WolffM/x', token: 'tok', guest: true });
	assert.doesNotMatch(commands(s), /\bsudo\b/, 'a guest is never asked for root');
	assert.match(s, /NEEDS_ROOT: .*GUEST/, 'and the operator is told why nothing happened');
	assert.match(s, /systemctl --user disable --now/, 'the user-unit path is unchanged');
	assert.match(s, /config\.sh remove/, 'and a user-unit registration is still deregistered');
});

test('on a claw the system path still uses non-prompting sudo', () => {
	// The other half of the mutation: flip the branch and this fails.
	const s = removeScript({ repo: 'WolffM/x', token: 'tok', guest: false });
	assert.match(commands(s), /sudo -n \.\/svc\.sh stop/);
	assert.doesNotMatch(s, /on a GUEST/);
});

test('every removal call site decides the guest question by ROLE', () => {
	// A call site that forgot the argument would fall back to `guest = false`
	// and take the sudo path on the guest again, silently.
	//
	// Since #123 both paths go through removeRegistration, which decides the
	// role ONCE (`const guest = isGuestNode(...)`) and passes it to both of its
	// removeScript calls; a call site may carry that `guest` or decide inline.
	const calls = [...CLI_SRC.matchAll(/(?<!function )removeScript\(\{([^}]*)\}\)/g)].map(
		(m) => m[1]
	);
	assert.ok(calls.length >= 2, 'the first attempt and the by-id cleanup both remove');
	const decidedOnce = /const guest = isGuestNode\(manifest\.machines\?\.\[claw\]\)/.test(CLI_SRC);
	for (const c of calls) {
		const inline = /guest: isGuestNode\(/.test(c);
		const shared = decidedOnce && /(^|[\s,])guest([\s,]|$)/.test(c);
		assert.ok(inline || shared, `call site without a role: ${c}`);
	}
});

/**
 * #126: removing a user unit takes its drop-in dir with it. EXECUTED against a
 * fixture HOME with `systemctl` and `config.sh` stubbed first on PATH — the
 * unit file and the drop-in are real files, and the assertion reads the disk.
 * MUTATION: delete the drop-in `rm` from removeScript and this fails.
 */
test('a removed user unit leaves no drop-in dir behind (#126)', () => {
	const home = mkdtempSync(join(tmpdir(), 'remove-dropin-'));
	try {
		const bin = join(home, 'stub-bin');
		const units = join(home, '.config/systemd/user');
		const dir = join(home, 'runners/actions-runner-x');
		mkdirSync(bin, { recursive: true });
		mkdirSync(join(units, 'actions-runner-x.service.d'), { recursive: true });
		mkdirSync(join(units, 'actions-runner-y.service.d'), { recursive: true });
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(units, 'actions-runner-x.service'), '[Service]\n');
		writeFileSync(join(units, 'actions-runner-x.service.d/10-runners-slice.conf'), '[Service]\n');
		writeFileSync(join(units, 'actions-runner-y.service.d/10-runners-slice.conf'), '[Service]\n');
		// `--user cat` succeeds (the unit is user-installed); `list-units` prints
		// nothing (no system unit). Every other call is a no-op.
		writeFileSync(
			join(bin, 'systemctl'),
			'#!/bin/sh\nfor a; do [ "$a" = cat ] && exit 0; done\nexit 0\n'
		);
		writeFileSync(join(dir, 'config.sh'), '#!/bin/sh\nrm -f .runner\nexit 0\n');
		chmodSync(join(bin, 'systemctl'), 0o755);
		chmodSync(join(dir, 'config.sh'), 0o755);

		const out = execFileSync('bash', ['-c', removeScript({ repo: 'WolffM/x', token: 'tok' })], {
			env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
			encoding: 'utf8',
		});
		assert.match(out, /removed .*actions-runner-x \(user:actions-runner-x\.service\)/);
		assert.equal(existsSync(join(units, 'actions-runner-x.service')), false);
		assert.equal(
			existsSync(join(units, 'actions-runner-x.service.d')),
			false,
			'the drop-in dir is removed with its unit'
		);
		assert.equal(
			existsSync(join(units, 'actions-runner-y.service.d')),
			true,
			"another runner's drop-in is untouched"
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

/**
 * A fixture HOME with stubbed `systemctl` (user units only) and the installs
 * named in `dirs`: `{ dirName: { agentId, configExit } }`. Runs removeScript's
 * output there and returns `{ code, out, err, home, units }`; the caller removes
 * `home`.
 */
function runInFixture(dirs, args) {
	const home = mkdtempSync(join(tmpdir(), 'remove-rename-'));
	const bin = join(home, 'stub-bin');
	const units = join(home, '.config/systemd/user');
	mkdirSync(bin, { recursive: true });
	mkdirSync(units, { recursive: true });
	writeFileSync(
		join(bin, 'systemctl'),
		'#!/bin/sh\nfor a; do [ "$a" = cat ] && exit 0; done\nexit 0\n'
	);
	chmodSync(join(bin, 'systemctl'), 0o755);
	for (const [name, { agentId, configExit = 0 }] of Object.entries(dirs)) {
		const d = join(home, 'runners', name);
		mkdirSync(d, { recursive: true });
		// The real file's shape: pretty-printed JSON, gitHubUrl naming the OLD repo.
		writeFileSync(
			join(d, '.runner'),
			`{\n  "agentId": ${agentId},\n  "agentName": "hokon",\n  "gitHubUrl": "https://github.com/WolffM/old-name"\n}\n`
		);
		writeFileSync(join(d, 'config.sh'), `#!/bin/sh\nexit ${configExit}\n`);
		chmodSync(join(d, 'config.sh'), 0o755);
		writeFileSync(join(units, `${name}.service`), '[Service]\n');
		mkdirSync(join(units, `${name}.service.d`), { recursive: true });
	}
	try {
		const out = execFileSync('bash', ['-c', removeScript(args)], {
			env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, out, err: '', home, units };
	} catch (e) {
		return { code: e.status, out: String(e.stdout), err: String(e.stderr), home, units };
	}
}

/**
 * #123: hadoku-printTool was renamed to hadoku-craft. The install stayed at
 * actions-runner-hadoku-printtool, and removing by the CURRENT name found
 * nothing. MUTATION: drop the agentId scan and this reports NOT_OURS.
 */
test("#123: a renamed repo's install is found by its registration id, unit and drop-in included", () => {
	const r = runInFixture(
		{
			// 240 sorts FIRST and contains "24": the match must be exact.
			'actions-runner-aaa-other': { agentId: 240 },
			'actions-runner-hadoku-printtool': { agentId: 24 },
		},
		{ repo: 'WolffM/hadoku-craft', token: 'tok', runnerId: 24 }
	);
	try {
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /found registration 24 at .*actions-runner-hadoku-printtool/);
		assert.match(r.out, /\(user:actions-runner-hadoku-printtool\.service\)/);
		assert.equal(existsSync(join(r.home, 'runners/actions-runner-hadoku-printtool')), false);
		assert.equal(existsSync(join(r.units, 'actions-runner-hadoku-printtool.service')), false);
		assert.equal(existsSync(join(r.units, 'actions-runner-hadoku-printtool.service.d')), false);
		assert.equal(
			existsSync(join(r.home, 'runners/actions-runner-aaa-other')),
			true,
			'id 240 is not 24'
		);
	} finally {
		rmSync(r.home, { recursive: true, force: true });
	}
});

test('#123: no install under either name is NOT_OURS — and nothing is touched', () => {
	const r = runInFixture(
		{ 'actions-runner-aaa-other': { agentId: 240 } },
		{ repo: 'WolffM/hadoku-craft', token: 'tok', runnerId: 24 }
	);
	try {
		assert.equal(r.code, 4);
		assert.match(r.err, /NOT_OURS: no install of this registration .*agentId 24/);
		assert.equal(existsSync(join(r.home, 'runners/actions-runner-aaa-other')), true);
	} finally {
		rmSync(r.home, { recursive: true, force: true });
	}
});

test('#123: a config.sh remove that fails leaves the install; the by-id cleanup then skips it', () => {
	// First attempt: the rename 404 — the directory must stay (removeScript's header).
	const first = runInFixture(
		{ 'actions-runner-hadoku-printtool': { agentId: 24, configExit: 1 } },
		{ repo: 'WolffM/hadoku-craft', token: 'tok', runnerId: 24 }
	);
	try {
		assert.equal(first.code, 6);
		assert.match(first.err, /DEREGISTER_FAILED/);
		assert.equal(existsSync(join(first.home, 'runners/actions-runner-hadoku-printtool')), true);
	} finally {
		rmSync(first.home, { recursive: true, force: true });
	}
	// After DELETE by id: same failing config.sh, but it is not called.
	const second = runInFixture(
		{ 'actions-runner-hadoku-printtool': { agentId: 24, configExit: 1 } },
		{ repo: 'WolffM/hadoku-craft', token: 'tok', runnerId: 24, deregistered: true }
	);
	try {
		assert.equal(second.code, 0, second.err);
		assert.equal(existsSync(join(second.home, 'runners/actions-runner-hadoku-printtool')), false);
	} finally {
		rmSync(second.home, { recursive: true, force: true });
	}
});

test('#123: the controller falls back to DELETE by id only after a FOUND install refused to deregister', () => {
	const SRC_FALLBACK = CLI_SRC.slice(CLI_SRC.indexOf('const removeRegistration'));
	assert.match(
		SRC_FALLBACK,
		/DEREGISTER_FAILED[\s\S]{0,120}runnerId !== null[\s\S]{0,200}ghWrite\('DELETE', `\/repos\/\$\{repo\}\/actions\/runners\/\$\{runnerId\}`/
	);
	assert.match(SRC_FALLBACK, /deregistered: true/);
	// The NOT_OURS hint no longer reaches for sudo: there is no directory to run svc.sh in.
	const hint = SRC_FALLBACK.slice(
		SRC_FALLBACK.indexOf('/NOT_OURS/'),
		SRC_FALLBACK.indexOf('/NEEDS_ROOT/')
	);
	assert.doesNotMatch(hint, /sudo/);
});
