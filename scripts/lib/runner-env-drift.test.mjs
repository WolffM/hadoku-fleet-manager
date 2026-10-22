// runner-env-drift.test.mjs — #102 "drift heals itself": a runner whose
// correct env was written but never LOADED ("STALE" in ci-throttle-install.sh's
// own vocabulary) must not survive a `fleet throttle --confirm` run silently.
// A stale warm listener failed cardtable's `check` twice (runs 37582769530,
// 37584876674) and stopped cardtable deploying, and `--confirm` reported
// success the whole time because nothing gated its exit code on whether the
// stale listener was actually cleared.
//
// Host-independent, same discipline as runner-env.test.mjs: every fixture is
// its own mkdtemp'd $HOME, and `pgrep`/`awk`/`tail`/`systemctl`/`sudo` are ALL
// fully fake — none of them ever calls the real binary, none of them ever
// reads the real process table or the real cgroup tree. The only REAL
// processes a test ever touches are ones it spawned itself (a `sleep`
// relaunched with a faked argv[0] via `exec -a`, so /proc/<pid>/cmdline — a
// raw file read ci-throttle-install.sh makes directly and nothing here can
// stub — genuinely contains the runner-directory path the script looks for).
// Everything else that script would normally read from the real system
// (cgroup membership, a worker's parent pid, which pids pgrep would find) is
// answered from small files under $HOME/.fake that each test writes, so a
// node-side script that reaches for ANY of those five commands sees only
// what this file told it to, never the host's.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staleRemainingFindings, throttleSummaryDrift } from './runner-env-drift.mjs';
import { parseSummary } from './fleet-exec.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const INSTALL_SRC = join(ROOT, 'scripts', 'ci-throttle-install.sh');
const DEPLOY_SRC = join(ROOT, 'scripts', 'deploy-ci-throttle.mjs');
// Where the driver's per-node finding text lives since #98 moved it into a
// pure function. The source contract below reads both.
const DRIFT_SRC = join(ROOT, 'scripts', 'lib', 'runner-env-drift.mjs');

const cleanups = [];
const spawnedPids = [];
function take(home) {
	cleanups.push(home);
	return home;
}
test.after(() => {
	for (const pid of spawnedPids) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			/* already gone — fine, that is what we asked for */
		}
	}
	for (const h of cleanups) rmSync(h, { recursive: true, force: true });
});

const REAL_HOME = process.env.HOME;

// --- the five fully-fake commands -----------------------------------------
//
// One stub directory, shared by every test in this file: each stub's answer
// is driven entirely by files under the CALLER's $HOME/.fake (populated by
// the test before it runs the installer), not by anything baked in here. None
// of the five ever calls its real counterpart — "no match" / "refused" is the
// fail-closed default, same posture as runner-env.test.mjs's stub dir.
const STUB_DIR = take(mkdtempSync(join(tmpdir(), 'runner-drift-stubbin-')));
function writeStub(name, body) {
	writeFileSync(join(STUB_DIR, name), `#!/usr/bin/env bash\n${body}`, { mode: 0o755 });
}

writeStub(
	'pgrep',
	`mkdir -p "$HOME/.fake" 2>/dev/null
printf '%s\\n' "pgrep $*" >> "$HOME/.fake/pgrep.log" 2>/dev/null

mode=""
pattern=""
countmode=0
for a in "$@"; do
	case "$a" in
	-x) mode=x ;;
	-f) mode=f ;;
	-af) mode=af ;;
	-fc)
		mode=f
		countmode=1
		;;
	-*) ;;
	*) pattern="$a" ;;
	esac
done

listener_pid=""
[ -r "$HOME/.fake/listener-pid" ] && listener_pid=$(cat "$HOME/.fake/listener-pid")
listener_dir=""
[ -r "$HOME/.fake/listener-dir" ] && listener_dir=$(cat "$HOME/.fake/listener-dir")
worker_pid=""
[ -r "$HOME/.fake/worker-pid" ] && worker_pid=$(cat "$HOME/.fake/worker-pid")

case "$mode" in
x)
	if [ "$pattern" = "Runner.Worker" ] && [ -n "$worker_pid" ]; then
		echo "$worker_pid"
		exit 0
	fi
	exit 1
	;;
f)
	if [ -n "$listener_pid" ] && [ -n "$listener_dir" ]; then
		argv="$listener_dir/bin/Runner.Listener"
		if printf '%s\\n' "$argv" | grep -qE -- "$pattern"; then
			if [ "$countmode" = 1 ]; then
				echo 1
			else
				echo "$listener_pid"
			fi
			exit 0
		fi
	fi
	exit 1
	;;
af)
	# The union-enumeration backstop. Every test directory here is already
	# findable by runner_dirs()'s own glob, so answering empty (nothing
	# EXTRA to add) is faithful, not a gap.
	exit 1
	;;
esac
exit 1
`
);

writeStub(
	'awk',
	`# Intercepts ONLY ` +
		"`awk '{print \\$4}' /proc/<pid>/stat`" +
		` — the one call
# ci-throttle-install.sh makes, to resolve a worker's parent pid. Anything
# else refuses rather than guessing.
if [ "$1" = '{print $4}' ]; then
	case "$2" in
	/proc/*/stat)
		pid=$(printf '%s' "$2" | sed -E 's#^/proc/([0-9]+)/stat$#\\1#')
		f="$HOME/.fake/ppid-$pid"
		if [ -r "$f" ]; then
			cat "$f"
			exit 0
		fi
		;;
	esac
fi
exit 1
`
);

writeStub(
	'tail',
	`# Intercepts ONLY ` +
		'`tail -1 /proc/<pid>/cgroup`' +
		` — cgroup_of()'s one call.
# A fake cgroup string lets a test choose "claw" (systemctl --user, no sudo)
# vs "hokon-shaped" (a system unit, sudo required) without needing a REAL
# cgroup or a real systemd unit.
if [ "$1" = "-1" ]; then
	case "$2" in
	/proc/*/cgroup)
		pid=$(printf '%s' "$2" | sed -E 's#^/proc/([0-9]+)/cgroup$#\\1#')
		f="$HOME/.fake/cgroup-$pid"
		if [ -r "$f" ]; then
			cat "$f"
			exit 0
		fi
		;;
	esac
fi
exit 1
`
);

writeStub(
	'systemctl',
	`mkdir -p "$HOME/.fake" 2>/dev/null
printf '%s\\n' "systemctl $*" >> "$HOME/.fake/systemctl.log" 2>/dev/null
verb=""
for a in "$@"; do
	case "$a" in
	stop | start | kill) verb="$a" ;;
	esac
done
if [ "$verb" = "stop" ] && [ -r "$HOME/.fake/listener-pid" ]; then
	# The unit genuinely stopping: kill the currently-active fake listener for
	# real. It is ours to kill — this test spawned it.
	kill -9 "$(cat "$HOME/.fake/listener-pid")" 2>/dev/null || true
fi
if [ "$verb" = "start" ] && [ -r "$HOME/.fake/new-listener-pid" ]; then
	cp "$HOME/.fake/new-listener-pid" "$HOME/.fake/listener-pid"
fi
exit 0
`
);

writeStub(
	'sudo',
	`mkdir -p "$HOME/.fake" 2>/dev/null
printf '%s\\n' "sudo $*" >> "$HOME/.fake/sudo.log" 2>/dev/null
# Every fixture in this file is sudo-less, same as every real node this path
# applies to (a claw never reaches here at all — it has a "user@" cgroup and
# never leaves the systemctl --user branch; a guest is never reached by the
# driver in the first place). Refusing unconditionally is the faithful
# fixture for "NEEDS-OPERATOR", which is all this suite exercises.
exit 1
`
);

// The REAL stat binary, resolved ONCE by absolute path before STUB_DIR ever
// goes on PATH, so the stub below can delegate to it without ever risking
// recursing into itself.
const REAL_STAT = execFileSync('sh', ['-c', 'command -v stat'], { encoding: 'utf8' }).trim();

writeStub(
	'stat',
	`# Intercepts ONLY ` +
		'`stat -c %Y /proc/<pid>`' +
		` and reports a time FAR IN THE
# FUTURE for it — deterministically reproducing the CONDITION behind Publish
# run 37662120377 (an inode whose first lookup happens AFTER anything else
# runs, so its mtime reads newer than a .env written earlier) without needing
# the real timing race. This is exactly what the OLD \`stat -c %Y
# /proc/<pid>\` one-liner would misread as "loaded". With the fix in place
# this stub is never even reached for that path: proc_start_epoch() reads
# /proc/<pid>/stat directly and never calls \`stat -c %Y /proc/<pid>\` at
# all. Every other invocation (.env mtimes, etc.) delegates to the REAL stat
# by absolute path, found before this stub dir ever went on PATH.
if [ "$1" = "-c" ] && [ "$2" = "%Y" ]; then
	case "$3" in
	/proc/[0-9]*)
		echo 9999999999
		exit 0
		;;
	esac
fi
exec ${REAL_STAT} "$@"
`
);

/** The ONLY way any test spawns the node-side installer. */
function runHermetic(home, extraEnv = {}) {
	if (!home || home === REAL_HOME || !home.startsWith(tmpdir())) {
		throw new Error(
			`runHermetic refuses: HOME must be a mkdtemp fixture under tmpdir(), got ${home}`
		);
	}
	const path = `${STUB_DIR}:${process.env.PATH}`;
	if (!path.startsWith(STUB_DIR)) {
		throw new Error('runHermetic refuses: PATH must start with the stub dir');
	}
	return execFileSync('bash', [INSTALL_SRC], {
		encoding: 'utf8',
		env: {
			PATH: path,
			HOME: home,
			TOOLCACHE: '/opt/hostedtoolcache',
			APPLY: '1',
			RESTART: '1',
			HOOK_B64: Buffer.from('#!/usr/bin/env bash\nexit 0\n', 'utf8').toString('base64'),
			CONF_B64: Buffer.from('MAX_CONCURRENT=2\n', 'utf8').toString('base64'),
			...extraEnv,
		},
	});
}

/** A runner dir's `.env`, written exactly as the installer would (env_ok=1). */
function writeCorrectEnv(home, dir) {
	const lines = [
		`ACTIONS_RUNNER_HOOK_JOB_STARTED=${home}/.hadoku/ci-throttle.sh`,
		'RUNNER_TOOL_CACHE=/opt/hostedtoolcache',
		`ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${home}/.hadoku/job-metrics.sh`,
		`TMPDIR=${home}/runner-tmp`,
		`NODE_COMPILE_CACHE=${home}/.cache/node-compile-cache`,
		'',
	].join('\n');
	writeFileSync(join(dir, '.env'), lines);
}

/**
 * A REAL background process whose argv[0] (as `/proc/<pid>/cmdline` — a raw
 * file read nothing here can stub — genuinely reports it) is `argv0`. This is
 * the one place a test touches a real OS process; it is entirely of this
 * test's own making; it runs `sleep 600`, nothing else, under no privilege
 * this process did not already have.
 */
function spawnFakeListener(argv0) {
	const child = spawn('bash', ['-c', 'exec -a "$1" sleep 600', 'fake-listener', argv0], {
		stdio: 'ignore',
		detached: true,
	});
	child.unref();
	spawnedPids.push(child.pid);
	return child.pid;
}

/** A real, blocking sleep in the TEST process (not the installer under test). */
function sleepMs(ms) {
	execFileSync('sleep', [String(ms / 1000)]);
}

/**
 * The systemctl stub's call log, or '' if it was never invoked. The node-side
 * script always runs an unconditional `systemctl --user is-active --quiet
 * runner-mem-harvest.service` (#47's memory-harvester check) regardless of
 * what this suite is testing, so its presence alone proves nothing — the
 * assertion that matters is that no `stop`/`start` verb was ever logged,
 * i.e. the unit this test is about was never torn down or restarted.
 */
function systemctlLogOrEmpty(home) {
	const f = join(home, '.fake', 'systemctl.log');
	return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

function newRunnerDir(home, name = 'actions-runner-x') {
	const dir = join(home, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, '.runner'), '{}');
	return dir;
}

// --- proc_start_epoch(): the real fix behind #102's Publish-job regression -
//
// Publish run 37662120377 (hokon's standing runner for this repo, inside a
// systemd service) failed `check` on exactly the four shell-level tests
// below: the node script printed `stale=0` on a fixture built to be
// unambiguously stale. Root cause: the OLD stale check compared `.env`'s
// mtime against `stat -c %Y /proc/<pid>` and called that "the process start
// time" — it is not. It is the time the /proc/<pid> DIRECTORY ENTRY was
// instantiated, which is only guaranteed to equal the real start time when
// something ELSE has already touched that pid's /proc entry since it was
// created. A desktop with ambient /proc scanning keeps that coincidence true;
// a quiet standing-runner service does not, so the entry's first-ever lookup
// happens HERE, inside this script, by which point `.env` may already be
// older than that lookup — read backwards, so a genuinely stale listener
// reports loaded. This file could not force that exact kernel race locally
// (the dentry-mtime held steady across repeated/delayed reads in this
// sandbox — see the comment on the invariance test below) but the fix does
// not depend on reproducing it: it replaces the mtime PROXY with the
// kernel's own authoritative record (`/proc/<pid>/stat` field 22, starttime
// in clock ticks since boot, plus `/proc/stat`'s `btime`), which is recorded
// once at process creation and cannot drift with when anything looks at it.

/**
 * Extracts `proc_start_epoch()`'s CURRENT body straight out of
 * ci-throttle-install.sh (never a copy kept in this test file, which could
 * silently drift from what ships) and returns a path to a sourceable file
 * holding just that function. The function has no nested `{`/`}` blocks of
 * its own (only `case`/`esac` and `${...}` expansions), so "the first line
 * that is exactly `}`" IS its closing brace — verified by the assertion
 * below, which fails loudly rather than silently extracting a truncated or
 * runaway body if that ever stops being true.
 */
function extractProcStartEpoch() {
	const lines = readFileSync(INSTALL_SRC, 'utf8').split('\n');
	const start = lines.findIndex((l) => l.trim() === 'proc_start_epoch() {');
	assert.notEqual(start, -1, 'proc_start_epoch() not found in ci-throttle-install.sh');
	const end = lines.findIndex((l, i) => i > start && l.trim() === '}');
	assert.notEqual(end, -1, 'proc_start_epoch() has no matching closing brace on its own line');
	const home = take(mkdtempSync(join(tmpdir(), 'runner-drift-fn-')));
	const fnFile = join(home, 'proc_start_epoch.sh');
	writeFileSync(fnFile, lines.slice(start, end + 1).join('\n') + '\n');
	return fnFile;
}

/**
 * Calls the REAL, just-extracted `proc_start_epoch` against a real pid,
 * exactly the way ci-throttle-install.sh's own caller does: it captures
 * stdout and never looks at the exit code, so a failure (nothing printed) and
 * a success look the same to `execFileSync` here — both just mean "did it
 * print a number".
 */
function runProcStartEpoch(pid) {
	const fnFile = extractProcStartEpoch();
	const out = execFileSync(
		'bash',
		['-c', `. "$1"; proc_start_epoch "$2" || true`, '--', fnFile, String(pid)],
		{ encoding: 'utf8' }
	).trim();
	return out === '' ? null : Number(out);
}

void test('proc_start_epoch(): matches real wall-clock spawn time, not the moment it is queried', () => {
	const beforeSpawn = Math.floor(Date.now() / 1000);
	const pid = spawnFakeListener('/irrelevant/for/this/test');
	const epoch = runProcStartEpoch(pid);
	const afterSpawn = Math.floor(Date.now() / 1000);
	assert.notEqual(epoch, null, 'proc_start_epoch returned nothing for a live pid');
	// Generous tolerance for scheduler/clock-tick rounding, not for drift.
	assert.ok(
		epoch >= beforeSpawn - 2 && epoch <= afterSpawn + 2,
		`epoch ${epoch} is not within [${beforeSpawn - 2}, ${afterSpawn + 2}]`
	);
});

void test('proc_start_epoch(): the SAME process reports the SAME start time whether queried immediately or after a delay — the kernel field, unlike a dentry mtime, cannot drift with when anything looks', () => {
	const pid = spawnFakeListener('/irrelevant/for/this/test');
	const immediate = runProcStartEpoch(pid);
	sleepMs(3000);
	const delayed = runProcStartEpoch(pid);
	assert.notEqual(immediate, null);
	assert.equal(
		delayed,
		immediate,
		'proc_start_epoch drifted with query time — that is the exact bug this replaced'
	);
});

void test('proc_start_epoch(): unreadable input (a pid with no /proc entry) returns nothing rather than a false "not stale"', () => {
	// A pid astronomically unlikely to exist (Linux pid_max is 4194304 by
	// default and never this high) — /proc/<pid>/stat is absent, which must
	// fail rather than silently return some fabricated epoch.
	const epoch = runProcStartEpoch(99999999);
	assert.equal(epoch, null);
});

void test("VFS fact behind the regression: a directory's mtime is NOT its creation time — the class of bug `stat -c %Y /proc/<pid>` committed", () => {
	// Not a claim about THIS sandbox's procfs specifically (which held
	// steady across the invariance test above) — a plain demonstration that
	// "treat a directory's mtime as when it was created" is unsound in
	// general, which is why the fix reads the kernel's own recorded
	// starttime instead of asking the VFS to infer it from mtime.
	const home = take(mkdtempSync(join(tmpdir(), 'runner-drift-mtime-')));
	const dir = join(home, 'some-dir');
	mkdirSync(dir);
	const createdAt = Math.floor(Date.now() / 1000);
	sleepMs(1200);
	// A later, unrelated write into the directory bumps ITS mtime forward,
	// exactly as a later first-lookup can bump a /proc/<pid> entry's
	// instantiation time forward relative to the process's real start.
	writeFileSync(join(dir, 'touched'), 'x');
	const mtimeAfterTouch = Number(
		execFileSync('stat', ['-c', '%Y', dir], { encoding: 'utf8' }).trim()
	);
	assert.ok(
		mtimeAfterTouch > createdAt,
		`mtime (${mtimeAfterTouch}) should read LATER than creation (${createdAt}) once something touches the directory afterwards — proving mtime is not a safe proxy for "when was this created"`
	);
});

// --- shell-level: the three dispositions a stale listener can end a run in -

void test('idle stale listener (claw-shaped, systemctl --user): --confirm stops and restarts it, clearing stale_remaining', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-drift-')));
	const dir = newRunnerDir(home);

	const oldPid = spawnFakeListener(`${dir}/bin/Runner.Listener`);
	// /proc/<pid>'s own mtime (the process start time) is whole-second; the
	// .env must read as NEWER than it to be "stale" at all.
	sleepMs(1500);
	writeCorrectEnv(home, dir);
	const newPid = spawnFakeListener(`${dir}/bin/Runner.Listener`);

	mkdirSync(join(home, '.fake'), { recursive: true });
	writeFileSync(join(home, '.fake', 'listener-pid'), String(oldPid));
	writeFileSync(join(home, '.fake', 'listener-dir'), dir);
	writeFileSync(join(home, '.fake', 'new-listener-pid'), String(newPid));
	// A claw: the cgroup ends in `.service` (a real unit) and its ancestor
	// chain carries "user@" — ci-throttle-install.sh's `*user@*)` branch,
	// `systemctl --user`, no sudo.
	writeFileSync(
		join(home, '.fake', `cgroup-${oldPid}`),
		'0::/user.slice/user-1000.slice/user@1000.service/app.slice/actions.runner.x.service\n'
	);

	const out = runHermetic(home);
	assert.match(out, /\bstale=1\b/, out);
	assert.match(out, /\brestarted=1\b/, out);
	assert.match(out, /\bstale_remaining=0\b/, out);

	const systemctlLog = readFileSync(join(home, '.fake', 'systemctl.log'), 'utf8');
	assert.match(systemctlLog, /systemctl --user stop/);
	assert.match(systemctlLog, /systemctl --user start/);
	assert.equal(readFileSync(join(home, '.fake', 'listener-pid'), 'utf8').trim(), String(newPid));
});

void test('idle stale listener survives a /proc/<pid> inode mtime set to the FAR FUTURE — the deterministic reproduction of Publish run 37662120377', () => {
	// Same fixture as the test above, with ONE addition: the `stat` stub
	// reports `stat -c %Y /proc/<pid>` as a time far in the future for
	// EVERY pid, which is exactly what the OLD `stat -c %Y /proc/$lp`
	// one-liner would see on a box where this listener's /proc entry's
	// first-ever lookup happens after anything else runs (manager's
	// measurement on hokon: a bare `setsid sleep` showed mtime ~0.4s AFTER
	// its real start — this stub just pushes that gap to its extreme so
	// the test needs no timing luck at all). The FIX must not even notice:
	// proc_start_epoch() never calls `stat -c %Y /proc/<pid>`.
	const home = take(mkdtempSync(join(tmpdir(), 'runner-drift-')));
	const dir = newRunnerDir(home);

	const oldPid = spawnFakeListener(`${dir}/bin/Runner.Listener`);
	sleepMs(1500);
	writeCorrectEnv(home, dir);
	const newPid = spawnFakeListener(`${dir}/bin/Runner.Listener`);

	mkdirSync(join(home, '.fake'), { recursive: true });
	writeFileSync(join(home, '.fake', 'listener-pid'), String(oldPid));
	writeFileSync(join(home, '.fake', 'listener-dir'), dir);
	writeFileSync(join(home, '.fake', 'new-listener-pid'), String(newPid));
	writeFileSync(
		join(home, '.fake', `cgroup-${oldPid}`),
		'0::/user.slice/user-1000.slice/user@1000.service/app.slice/actions.runner.x.service\n'
	);

	const out = runHermetic(home);
	assert.match(out, /\bstale=1\b/, out);
	assert.match(out, /\brestarted=1\b/, out);
	assert.match(out, /\bstale_remaining=0\b/, out);
});

void test('busy stale listener: left alone, reported, stale_remaining stays 1, systemctl is never called', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-drift-')));
	const dir = newRunnerDir(home);

	const listenerPid = spawnFakeListener(`${dir}/bin/Runner.Listener`);
	sleepMs(1500);
	writeCorrectEnv(home, dir);

	mkdirSync(join(home, '.fake'), { recursive: true });
	writeFileSync(join(home, '.fake', 'listener-pid'), String(listenerPid));
	writeFileSync(join(home, '.fake', 'listener-dir'), dir);
	// A live Runner.Worker under this listener. The worker pid itself can be
	// any number — the busy_dirs loop only uses it to look up a PARENT pid
	// (via the stubbed awk), then reads /proc/<ppid>/cmdline FOR REAL, which
	// is why the listener above has to be a genuine process and the worker
	// does not.
	const fakeWorkerPid = 999999;
	writeFileSync(join(home, '.fake', 'worker-pid'), String(fakeWorkerPid));
	writeFileSync(join(home, '.fake', `ppid-${fakeWorkerPid}`), String(listenerPid));

	const out = runHermetic(home);
	assert.match(out, /\bstale=1\b/, out);
	assert.match(out, /\bbusy=1\b/, out);
	assert.match(out, /\brestarted=0\b/, out);
	assert.match(out, /\bstale_remaining=1\b/, out);
	assert.match(out, /^BUSY /m, out);

	// Never stopped: the idle check short-circuits before restart_dir is
	// ever reached, so the systemctl stub is never invoked at all.
	const systemctlLog = systemctlLogOrEmpty(home);
	assert.doesNotMatch(systemctlLog, /systemctl --user (stop|start) /);
});

void test('a node with no passwordless sudo (hokon-shaped unit): restart is refused, stale listener remains, nothing is torn down', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-drift-')));
	const dir = newRunnerDir(home);

	const listenerPid = spawnFakeListener(`${dir}/bin/Runner.Listener`);
	sleepMs(1500);
	writeCorrectEnv(home, dir);

	mkdirSync(join(home, '.fake'), { recursive: true });
	writeFileSync(join(home, '.fake', 'listener-pid'), String(listenerPid));
	writeFileSync(join(home, '.fake', 'listener-dir'), dir);
	// A SYSTEM unit, not a user session — no "user@" anywhere in the
	// cgroup path, which routes restart_dir to the sudo branch rather than
	// `systemctl --user` (hokon's own units, per this file's comments, are
	// real system units; the driver never reaches hokon at all because it
	// is a guest — this is the defense-in-depth behind that skip, proven
	// directly rather than assumed).
	writeFileSync(
		join(home, '.fake', `cgroup-${listenerPid}`),
		'0::/system.slice/actions.runner.x.service\n'
	);

	const out = runHermetic(home);
	assert.match(out, /\bstale=1\b/, out);
	assert.match(out, /\bstale_remaining=1\b/, out);
	assert.match(out, /^NEEDS-OPERATOR /m, out);
	assert.match(out, /^RESTART-FAILED /m, out);

	// Refused BEFORE ever calling systemctl — never torn down, and never a
	// call this node has no right to make.
	const systemctlLog = systemctlLogOrEmpty(home);
	assert.doesNotMatch(systemctlLog, /systemctl --user (stop|start) /);
	assert.equal(
		readFileSync(join(home, '.fake', 'listener-pid'), 'utf8').trim(),
		String(listenerPid)
	);
});

void test('a dry run (RESTART=0): a stale listener is detected but nothing is attempted, so it remains', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-drift-')));
	const dir = newRunnerDir(home);

	const listenerPid = spawnFakeListener(`${dir}/bin/Runner.Listener`);
	sleepMs(1500);
	writeCorrectEnv(home, dir);

	mkdirSync(join(home, '.fake'), { recursive: true });
	writeFileSync(join(home, '.fake', 'listener-pid'), String(listenerPid));
	writeFileSync(join(home, '.fake', 'listener-dir'), dir);

	const out = runHermetic(home, { RESTART: '0' });
	assert.match(out, /\bstale=1\b/, out);
	assert.match(out, /\bstale_remaining=1\b/, out);
	const systemctlLog = systemctlLogOrEmpty(home);
	assert.doesNotMatch(systemctlLog, /systemctl --user (stop|start) /);
});

void test('a correct .env with NO running listener at all is not silently read as loaded — reported, never counted "already wired"', () => {
	// A .env that is byte-for-byte correct is not proof anything is
	// listening — a crashed, never-started, or reaped-and-not-replaced
	// Runner.Listener leaves exactly this shape on disk. Deliberately NO
	// listener-pid/listener-dir fixture file: the fake pgrep stub then
	// reports no match for every `-f` pattern, exactly as a genuinely
	// absent listener would.
	const home = take(mkdtempSync(join(tmpdir(), 'runner-drift-')));
	const dir = newRunnerDir(home);
	writeCorrectEnv(home, dir);

	const out = runHermetic(home);
	assert.match(out, /\bwired=0\b/, out);
	// NOT "stale" — that label means a listener exists and has simply not
	// reloaded. There is no listener here at all.
	assert.match(out, /\bstale=0\b/, out);
	assert.match(out, /^NO-LIVE-LISTENER /m, out);
	// NOT folded into `changed`/`newly` — that is specifically what would
	// make deploy-ci-throttle.mjs's `wrong = newly - stale` report a FALSE
	// "N runner(s) have the wrong env on disk" for an env that is exactly
	// right, just for a deliberately-stopped or crashed runner.
	assert.match(out, /\bnewly=0\b/, out);
	assert.match(out, /\bnolistener=1\b/, out);
	// And nothing resurrects it: restart_dir() refuses at the first step
	// (no cgroup to resolve without a live pid) before ever reaching a
	// systemctl call, so `--confirm` (APPLY=1 RESTART=1, runHermetic's
	// default) must never invoke `systemctl ... start` for this directory.
	const systemctlLog = systemctlLogOrEmpty(home);
	assert.doesNotMatch(systemctlLog, /systemctl --user (stop|start) /);
});

// --- deploy-ci-throttle.mjs: the driver has no hermetic path (real ssh) ----
// so its text and its --confirm gate are proven as pure functions / a source
// contract, same pattern runnerEnvDrift already established.

void test('staleRemainingFindings: zero remaining is not a finding', () => {
	assert.deepEqual(staleRemainingFindings({ name: 'claw-1', staleRemaining: 0, notes: [] }), []);
});

void test('staleRemainingFindings: a busy remainder is named with its BUSY note', () => {
	const findings = staleRemainingFindings({
		name: 'claw-2',
		staleRemaining: 1,
		notes: ['BUSY /home/hadoku/actions-runner-cardtable'],
	});
	assert.equal(findings.length, 1);
	assert.match(findings[0], /claw-2: stale listener remains \(written but NOT LOADED\) — BUSY/);
});

void test('staleRemainingFindings: a restart-failed remainder is named with its note', () => {
	const findings = staleRemainingFindings({
		name: 'claw-3',
		staleRemaining: 1,
		notes: ['RESTART-FAILED /home/hadoku/actions-runner-x'],
	});
	assert.match(findings[0], /RESTART-FAILED/);
});

void test('staleRemainingFindings: a needs-operator remainder is named with its note', () => {
	const findings = staleRemainingFindings({
		name: 'hokon',
		staleRemaining: 1,
		notes: ['NEEDS-OPERATOR /home/hadoku/actions-runner-x (unit — no passwordless sudo on hokon)'],
	});
	assert.match(findings[0], /NEEDS-OPERATOR/);
});

void test('staleRemainingFindings: no disposition note at all still names the directory from its STALE line, not just a count', () => {
	const findings = staleRemainingFindings({
		name: 'claw-4',
		staleRemaining: 1,
		notes: ['STALE /home/hadoku/actions-runner-x'],
	});
	assert.match(findings[0], /not attempted/);
	assert.match(findings[0], /STALE \/home\/hadoku\/actions-runner-x/);
});

void test('staleRemainingFindings: no notes at all still reports a count rather than going silent — "I could not look" is never "fine"', () => {
	const findings = staleRemainingFindings({ name: 'claw-5', staleRemaining: 2, notes: [] });
	assert.equal(findings.length, 1);
	assert.match(findings[0], /claw-5: 2 runner\(s\) are still written but NOT LOADED/);
});

void test('staleRemainingFindings: multiple remaining directories on one node each get their own finding', () => {
	const findings = staleRemainingFindings({
		name: 'claw-6',
		staleRemaining: 2,
		notes: ['BUSY /a', 'BUSY /b'],
	});
	assert.equal(findings.length, 2);
});

void test('deploy-ci-throttle.mjs: the stale/NOT-LOADED text names --confirm for a claw, not the old blanket operator-must-restart claim', () => {
	const src = readFileSync(DEPLOY_SRC, 'utf8') + readFileSync(DRIFT_SRC, 'utf8');
	assert.doesNotMatch(
		src,
		/hokon has no passwordless sudo, so an operator must do it/,
		'the old blanket claim (every NOT-LOADED finding needs an operator) must be gone'
	);
	assert.doesNotMatch(
		src,
		/cannot restart a unit it has no sudo for/,
		'the old footer claiming --confirm can never clear this must be gone'
	);
	assert.match(
		src,
		/claw's systemctl --user units the fix IS fleet throttle --confirm/,
		'the fix text must name --confirm as the fix for a claw'
	);
});

// --- throttleSummaryDrift (#98): every rule requires the GOOD value --------
//
// The mutation pass found these rules testing for the BAD token (`/conf=0/`,
// `/harvest=0/`, `/jit=0/`), so a SUMMARY that lost a token passed, and the
// conf was judged by the PRESENCE of a MAX_CONCURRENT line, not its value.

const CLAW = { maxConcurrent: 3, minFreeMb: 2048, ephemeral: true };
const CONF_SHA = 'a'.repeat(64);
const HEALTHY =
	'SUMMARY conf=1 conf_max=3 conf_minfree=2048 confsha=' +
	CONF_SHA +
	' jit=1 payload=1 wired=4 newly=0 stale=0 stale_remaining=0 nolistener=0 harvest=1';

/** `HEALTHY` with one token replaced (`value === null` drops it entirely). */
function withToken(token, value, base = HEALTHY) {
	const toks = base.split(' ').filter((t) => !t.startsWith(`${token}=`));
	if (value !== null) toks.push(`${token}=${value}`);
	return toks.join(' ');
}
function summaryDrift(summary, m = CLAW) {
	return throttleSummaryDrift({
		name: 'claw-1',
		m,
		kv: parseSummary(summary),
		wantConfSha: CONF_SHA,
	});
}

void test('throttleSummaryDrift: a healthy SUMMARY is clean', () => {
	assert.deepEqual(summaryDrift(HEALTHY), []);
});

void test('throttleSummaryDrift: no SUMMARY at all is a finding, not a pass', () => {
	assert.match(summaryDrift('').join('\n'), /produced no SUMMARY line/);
});

for (const token of ['conf', 'harvest', 'jit', 'payload', 'newly', 'stale', 'nolistener']) {
	for (const value of [null, '', 'x']) {
		const shown = value === null ? '(absent)' : `'${value}'`;
		void test(`throttleSummaryDrift: ${token}=${shown} is "could not read", never clean`, () => {
			const f = summaryDrift(withToken(token, value));
			assert.equal(f.length, 1, f.join('\n'));
			assert.match(f[0], new RegExp(`could not read .* SUMMARY carried ${token}=`));
		});
	}
}

void test('throttleSummaryDrift: the bad values keep their own findings', () => {
	assert.match(summaryDrift(withToken('conf', '0')).join('\n'), /cannot load its config/);
	assert.match(summaryDrift(withToken('harvest', '0')).join('\n'), /harvester unit is not active/);
	assert.match(summaryDrift(withToken('jit', '0')).join('\n'), /no ~\/\.hadoku\/jit-provision\.sh/);
	assert.match(summaryDrift(withToken('payload', '0')).join('\n'), /NO JIT payload/);
});

void test('throttleSummaryDrift: jit/payload are not judged on a non-ephemeral node', () => {
	const m = { ...CLAW, ephemeral: false };
	assert.deepEqual(summaryDrift(withToken('jit', null), m), []);
	assert.deepEqual(summaryDrift(withToken('jit', '0'), m), []);
});

void test('throttleSummaryDrift: stale is judged even when the newly token is missing', () => {
	const f = summaryDrift(withToken('stale', '2', withToken('newly', null)));
	assert.ok(
		f.some((x) => /2 runner\(s\) have the correct env written but NOT LOADED/.test(x)),
		f.join('\n')
	);
	assert.ok(
		f.some((x) => /SUMMARY carried newly=/.test(x)),
		f.join('\n')
	);
});

void test('throttleSummaryDrift: wrong = newly - stale, and stale is reported beside it', () => {
	const f = summaryDrift(withToken('stale', '1', withToken('newly', '3')));
	assert.ok(
		f.some((x) => /2 runner\(s\) have the wrong env on disk/.test(x)),
		f.join('\n')
	);
	assert.ok(f.some((x) => /1 runner\(s\) have the correct env written but NOT LOADED/.test(x)));
});

void test('throttleSummaryDrift: a conf enforcing a limit the manifest does not declare is a "manifest moved" finding', () => {
	// What the hook does with `MAX_CONCURRENT=two`: falls back to 99, unlimited.
	const f = summaryDrift(withToken('conf_max', '99'));
	assert.equal(f.length, 1, f.join('\n'));
	assert.match(f[0], /enforces MAX_CONCURRENT=99 \(manifest: 3\)/);
	assert.match(f[0], /manifest moved and this node was not re-deployed/);
	// A missing MIN_FREE_MB is 0 to the hook.
	assert.match(
		summaryDrift(withToken('conf_minfree', '0')).join('\n'),
		/MIN_FREE_MB=0 \(manifest: 2048\)/
	);
});

void test('throttleSummaryDrift: a missing conf value token is "could not read", not a pass', () => {
	for (const token of ['conf_max', 'conf_minfree']) {
		for (const value of [null, '-', '']) {
			const f = summaryDrift(withToken(token, value));
			assert.equal(f.length, 1, `${token}=${value}: ${f.join('\n')}`);
			assert.match(f[0], new RegExp(`could not read .* SUMMARY carried ${token}=`));
		}
	}
});

void test('throttleSummaryDrift: matching limits but different conf bytes is ONE distinct finding', () => {
	const f = summaryDrift(withToken('confsha', 'b'.repeat(64)));
	assert.equal(f.length, 1, f.join('\n'));
	assert.match(f[0], /ci-throttle\.conf is not what the manifest renders/);
	// Wrong limits AND wrong bytes is still one conf-content finding, not two.
	assert.equal(
		summaryDrift(withToken('confsha', 'b'.repeat(64), withToken('conf_max', '99'))).length,
		1
	);
	for (const value of [null, 'absent', 'unreadable']) {
		assert.match(summaryDrift(withToken('confsha', value)).join('\n'), /SUMMARY carried confsha=/);
	}
});
