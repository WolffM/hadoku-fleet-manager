/**
 * runner-identity-probe.sh — a listener that is not an install is not reported
 * (#103 item 2b).
 *
 * `fleet identity` on hokon reported two UNCONFIGURED LISTENERS at
 * `/tmp/runner-drift-XXXXXX/actions-runner-x` on 2026-10-08: the fake listeners
 * `lib/runner-env-drift.test.mjs` spawns, caught by the probe's listener union
 * while CI happened to be running on the same box. The union exists to catch
 * an install whose directory the glob misses, so it must keep doing that — for
 * a path under the runner user's $HOME — and drop everything else.
 *
 * NODE-SIDE SCRIPT, FIXTURE HOME. `pgrep` and `systemctl` are stubs driven by
 * files under the fixture $HOME, so the probe never reads this machine's real
 * process table or user units; `HOME` and `TMPDIR` point inside one mkdtemp
 * root, removed after each test. Nothing here spawns git.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROBE = join(dirname(fileURLToPath(import.meta.url)), 'runner-identity-probe.sh');

/**
 * `pgrep -af` prints one line per listener in $HOME/.fake/listeners; `pgrep -f
 * ^<dir>/bin/Runner.Listener` succeeds when that dir is listed. Anything else
 * finds nothing — fail closed. `pgrep -ax Runner.Worker` prints
 * $HOME/.fake/workers verbatim, when a test wrote one.
 */
const PGREP = `#!/usr/bin/env bash
list="$HOME/.fake/listeners"
[ -f "$list" ] || exit 1
case "$1" in
-ax) w="$HOME/.fake/workers"; [ -f "$w" ] || exit 1; cat "$w"; exit 0 ;;
-af) i=100; while IFS= read -r p; do echo "$i $p/bin/Runner.Listener run"; i=$((i + 1)); done < "$list"; exit 0 ;;
-f) want="\${2#^}"; while IFS= read -r p; do [ "$p/bin/Runner.Listener" = "$want" ] && exit 0; done < "$list"; exit 1 ;;
esac
exit 1
`;

function fixture(listeners) {
	const root = mkdtempSync(join(tmpdir(), 'identity-probe-'));
	const home = join(root, 'home');
	// TMPDIR UNDER $HOME, on purpose: a claw whose /tmp is tmpfs may point it
	// there, and a fixture made with os.tmpdir() then sits inside $HOME.
	const tmp = join(home, 'tmp');
	const bin = join(root, 'bin');
	for (const d of [join(home, '.fake'), tmp, bin]) mkdirSync(d, { recursive: true });
	writeFileSync(join(bin, 'pgrep'), PGREP, { mode: 0o755 });
	writeFileSync(join(bin, 'systemctl'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
	const dirs = listeners({ root, home, tmp });
	for (const d of dirs) mkdirSync(join(d, 'bin'), { recursive: true });
	writeFileSync(join(home, '.fake', 'listeners'), dirs.join('\n') + '\n');
	return { root, home, tmp, bin, dirs };
}

/**
 * The probe's environment. `sshShell` models production: the probe runs in an
 * ssh shell that never sees the job's TMPDIR (it lives in the runner's .env),
 * so its own temp dir is the system one, OUTSIDE $HOME. That is /tmp on a
 * claw; here it is a sibling of the fixture home, because the fixture home is
 * itself under /tmp and unsetting TMPDIR would drop every path in it.
 */
function probeEnv(fx, { sshShell = false } = {}) {
	const env = { PATH: `${fx.bin}:/usr/bin:/bin`, HOME: fx.home };
	return { ...env, TMPDIR: sshShell ? join(fx.root, 'system-tmp') : fx.tmp };
}

function probe(fx, opts) {
	const out = execFileSync('bash', [PROBE], { env: probeEnv(fx, opts), encoding: 'utf8' });
	return out
		.split('\n')
		.filter((l) => l.startsWith('RUNNER '))
		.map((l) => l.split(' ')[1])
		.sort();
}

test('#103: a listener under $HOME that the glob misses is still reported — the union keeps its job', () => {
	const fx = fixture(({ home }) => [join(home, 'odd-place', 'runner')]);
	try {
		assert.deepEqual(probe(fx), [join(fx.home, 'odd-place', 'runner')]);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('#103: a listener outside $HOME, or in a temp dir, is NOT an install and is not reported', () => {
	const fx = fixture(({ root, home, tmp }) => [
		join(home, 'odd-place', 'runner'),
		// The 2026-10-08 shape: a test's fake listener outside the runner's home.
		join(root, 'runner-drift-abc', 'actions-runner-x'),
		// The same fixture where TMPDIR sits under $HOME.
		join(tmp, 'runner-drift-def', 'actions-runner-x'),
	]);
	try {
		assert.deepEqual(probe(fx), [join(fx.home, 'odd-place', 'runner')]);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test("fleet-manager#79: a fixture in a CI job's ~/runner-tmp is dropped even with no TMPDIR in the probe's shell", () => {
	// ci-throttle-install.sh gives every CI job TMPDIR=$HOME/runner-tmp, but the
	// probe's ssh shell has no TMPDIR, so the temp-dir rule alone saw only /tmp.
	const fx = fixture(({ home }) => [
		join(home, 'odd-place', 'runner'),
		join(home, 'runner-tmp', 'runner-drift-def', 'actions-runner-x'),
	]);
	try {
		assert.deepEqual(probe(fx, { sshShell: true }), [join(fx.home, 'odd-place', 'runner')]);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

/** The probe's raw `WORKER` rows, with the fixture $HOME cut off the directory. */
function workerRows(fx, lines, opts) {
	writeFileSync(join(fx.home, '.fake', 'workers'), lines.join('\n') + '\n');
	const out = execFileSync('bash', [PROBE], { env: probeEnv(fx, opts), encoding: 'utf8' });
	return out
		.split('\n')
		.filter((l) => l.startsWith('WORKER '))
		.map((l) => l.replace(`${fx.home}/`, '~/'));
}

test('private#138: a spawned worker is reported with its runner name, repo and pid, JIT slots included', () => {
	const fx = fixture(() => []);
	try {
		const slot = join(fx.home, '.hadoku', 'jit', 'slot0');
		const standing = join(fx.home, 'runners', 'actions-runner-x');
		for (const d of [slot, standing]) mkdirSync(d, { recursive: true });
		// A JIT listener writes the capitalised keys and no trailing newline.
		writeFileSync(
			join(slot, '.runner'),
			'{"AgentName":"jit-claw-fixture-a-1794792347","GitHubUrl":"https://github.com/WolffM/a"}'
		);
		writeFileSync(
			join(standing, '.runner'),
			'\uFEFF{"agentName":"claw-fixture","gitHubUrl":"https://github.com/WolffM/b"}\n'
		);
		const rows = workerRows(fx, [
			`4100 ${slot}/bin/Runner.Worker spawnclient 149 152`,
			// A worker runs from the versioned directory.
			`4200 ${standing}/bin.2.338.2/Runner.Worker spawnclient 156 159`,
		]);
		// No such pids exist, so the age is `?`: said, never guessed.
		assert.deepEqual(rows, [
			'WORKER ~/.hadoku/jit/slot0 WolffM/a jit-claw-fixture-a-1794792347 ? 4100',
			'WORKER ~/runners/actions-runner-x WolffM/b claw-fixture ? 4200',
		]);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('private#138: a test double named Runner.Worker, or one outside $HOME or in a temp dir, is not a worker', () => {
	const fx = fixture(() => []);
	try {
		const rows = workerRows(fx, [
			// ci-throttle.test.mjs's stand-in: the name, without `spawnclient`.
			`4300 ${fx.home}/runners/actions-runner-x/bin/Runner.Worker -c sleep`,
			`4400 ${fx.root}/elsewhere/bin/Runner.Worker spawnclient 1 2`,
			`4500 ${fx.tmp}/runner-drift-def/actions-runner-x/bin/Runner.Worker spawnclient 1 2`,
			// Under $HOME with no .runner: reported, so the driver can say it could not judge it.
			`4600 ${fx.home}/odd/bin/Runner.Worker spawnclient 1 2`,
		]);
		assert.deepEqual(rows, ['WORKER ~/odd ? ? ? 4600']);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test("fleet-manager#79: a job-shaped worker in a CI job's ~/runner-tmp is not a worker, with no TMPDIR in the probe's shell", () => {
	const fx = fixture(() => []);
	try {
		const rows = workerRows(
			fx,
			[
				`4700 ${fx.home}/runner-tmp/runner-drift-def/actions-runner-x/bin/Runner.Worker spawnclient 1 2`,
				`4800 ${fx.home}/odd/bin/Runner.Worker spawnclient 1 2`,
			],
			{ sshShell: true }
		);
		assert.deepEqual(rows, ['WORKER ~/odd ? ? ? 4800']);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});
