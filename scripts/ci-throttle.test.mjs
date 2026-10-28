/**
 * ci-throttle — the job-started hook must hold `maxConcurrent`, not just
 * smooth it.
 *
 * `MAX_WAIT_S=90` used to be a SMOOTHER: a job that waited the whole ceiling
 * started anyway, so a burst wider than the cap eventually got seated in full
 * — the exact shape that thrashed claw-1's memory on 2026-09-01 and OOM-killed
 * two jobs on claw-2 on 2026-08-24 (docs/planning/jit-rollout-retro-2026-09-01.md).
 * P3.4 makes the wait a real cap: a job still over the limit when the wait
 * ends is REFUSED (non-zero exit), not admitted.
 *
 * These drive the REAL script, same discipline as job-metrics-guard.test.mjs:
 * the property that matters is behavioural (what does it exit with, under
 * what config), not what the source text says it does. `CI_THROTTLE_TEST_OTHERS`
 * and `CI_THROTTLE_MEMINFO` are the only two test seams — see the script's own
 * comments on each; everything else here is a real, documented config knob
 * (`CI_THROTTLE_CONF`).
 */
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
	rmSync,
	utimesSync,
	symlinkSync,
	readdirSync,
} from 'node:fs';
import { join, dirname, resolve, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseJsonStdout, spawnCapture } from './lib/spawn-json.mjs';
import { tempDir, cleanupTempDirs } from './lib/test-tmpdir.mjs';

/**
 * Every directory this suite creates under os.tmpdir() starts with this, and
 * the LAST hook in the file fails if any survive (#129). The pid is what makes
 * that check this process's alone: other sessions run this suite concurrently
 * against the same /tmp, so a bare `ci-throttle-*` count would flake. On the
 * claws and hokon /tmp is RAM, and this suite once left ~950 MB there; each
 * nodeFixture() holds a 1.3 MB copy of bash.
 */
const FIXTURE_PREFIX = `ci-throttle-${process.pid}-`;

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const HOOK = join(SCRIPTS, 'ci-throttle.sh');
const DEPLOYER = join(SCRIPTS, 'deploy-ci-throttle.mjs');

/**
 * The ambient environment, with everything the hook reads REMOVED.
 *
 * `ci-throttle.sh` reads `GITHUB_WORKFLOW` and exits 0 immediately when it
 * matches `EXEMPT_WORKFLOWS` (`runner[ _-]?smoke|runner[ _-]?diag`). Every case
 * below spreads `process.env` into the child, so on a runner — where
 * `GITHUB_WORKFLOW` carries the workflow's DISPLAY NAME — an unlucky workflow
 * name would send every one of them down the exempt path. The refusals would go
 * red and the admits would pass for a reason that has nothing to do with the
 * cap. Naming a workflow is not supposed to be able to do that.
 *
 * The same applies to the two test seams: `CI_THROTTLE_TEST_OTHERS` inherited
 * from a harness pins the job count, and `CI_THROTTLE_MEMINFO` redirects the
 * memory read. A case that does not set them must not silently get them.
 *
 * So the only way any of these reaches the hook is for a case to pass it
 * EXPLICITLY, which is exactly what the exemption case below does.
 */
function ambient() {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			([k]) => !k.startsWith('GITHUB_') && !k.startsWith('CI_THROTTLE_')
		)
	);
}

/**
 * A default `df` stub reporting a huge, nearly-empty filesystem, so by
 * default `maybe_prune_tmp` never finds a reason to prune. Built once, lazily.
 */
let _defaultDfDir;
function defaultDfDir() {
	if (_defaultDfDir) return _defaultDfDir;
	const bin = mkdtempSync(join(tmpdir(), `${FIXTURE_PREFIX}hookenv-df-`));
	writeFileSync(
		join(bin, 'df'),
		'#!/bin/sh\necho "Filesystem 1M-blocks Used Available Use% Mounted"\necho "fixture 100000000 1 99999999 0% x"\n',
		{ mode: 0o755 }
	);
	_defaultDfDir = bin;
	return bin;
}
after(() => {
	if (_defaultDfDir) rmSync(_defaultDfDir, { recursive: true, force: true });
});

// Per-test fixtures (nodeFixture alone copies a 1.3 MB Runner.Worker) come from
// tempDir() and are removed after every test, pass or fail. The two dirs that
// live for the whole file — the default df stub above and PRUNE_SCRATCH below —
// are deliberately NOT registered there, and each has its own `after`.
afterEach(cleanupTempDirs);

/**
 * THE ONE DOOR. Every spawn of the real hook (`bash [HOOK]`) must pass its
 * env through this, with no other path to the child process. It throws
 * unless `CI_THROTTLE_PRUNE_ROOT` is set, resolves inside `os.tmpdir()`, and
 * is not `os.tmpdir()` itself — exactly the gap that let `run()` prune the
 * real host `/tmp` (no root set at all, real `df` on PATH). It also puts the
 * default `df` stub (above) on PATH, UNLESS the env already carries a
 * caller-built stub from `stubDf()` (detected by its `df-stub-` dirname) —
 * in which case the caller's stub is left ahead and the default is appended
 * after it, never overriding a case that deliberately drives real usage
 * numbers.
 */
function hookEnv(env) {
	const root = env.CI_THROTTLE_PRUNE_ROOT;
	if (!root) {
		throw new Error('hookEnv(): CI_THROTTLE_PRUNE_ROOT is not set — refusing to spawn the hook');
	}
	const resolvedRoot = resolve(root);
	const resolvedTmp = resolve(tmpdir());
	if (resolvedRoot === resolvedTmp) {
		throw new Error('hookEnv(): CI_THROTTLE_PRUNE_ROOT must not be os.tmpdir() itself');
	}
	if (!resolvedRoot.startsWith(resolvedTmp + sep)) {
		throw new Error(
			`hookEnv(): CI_THROTTLE_PRUNE_ROOT (${resolvedRoot}) must resolve inside os.tmpdir() (${resolvedTmp})`
		);
	}
	const existingPath = env.PATH ?? process.env.PATH ?? '';
	const hasCallerStub = existingPath.split(':').some((p) => basename(p).startsWith('df-stub-'));
	const dflt = defaultDfDir();
	return {
		...env,
		PATH: hasCallerStub ? `${existingPath}:${dflt}` : `${dflt}:${existingPath}`,
	};
}

/**
 * Run the hook against a fixture. `conf` is written as the node's
 * ci-throttle.conf; `others`/`memAvailableMb` are the two test-only seams the
 * script exposes for exactly this purpose. Never throws on a non-zero exit —
 * refusing IS the behaviour under test.
 */
function run({
	conf = {},
	others = 0,
	memAvailableMb = 999_999,
	memSwing,
	env = {},
	timeout = 15_000,
} = {}) {
	const dir = tempDir(`${FIXTURE_PREFIX}run-`);
	let writer;
	try {
		const confPath = join(dir, 'ci-throttle.conf');
		writeFileSync(
			confPath,
			Object.entries(conf)
				.map(([k, v]) => `${k}=${v}`)
				.join('\n') + '\n'
		);
		const meminfo = join(dir, 'meminfo');
		writeFileSync(meminfo, `MemAvailable:   ${memAvailableMb * 1024} kB\n`);
		if (memSwing) writer = swingMeminfo(meminfo, memSwing);
		// The host's real load and PSI only feed the "host load:" line, but a
		// fixture that reads them is not isolated (fleet-manager#13). Tests that
		// care about that line pass their own in `env`.
		const loadavg = join(dir, 'loadavg');
		writeFileSync(loadavg, '0.10 0.10 0.10 1/100 1\n');
		const pressure = join(dir, 'pressure-cpu');
		writeFileSync(pressure, 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
		// wave 4b: the hook's own prune root, inside THIS fixture's mkdtemp dir
		// — never the real host /tmp (the leak hookEnv() exists to seal).
		const pruneRoot = join(dir, 'prune-root');
		mkdirSync(pruneRoot, { recursive: true });

		// A KILLED hook is not a refusal. `execFileSync`'s catch used to flatten
		// `status ?? 1` over both, so a hook killed at the 15s ceiling arrived at
		// the assertions as exit 1 with empty output — byte-identical to the
		// enforcement these cases exist to prove. `spawnCapture` throws on a
		// signal instead, naming the ceiling (#45).
		return spawnCapture('bash', [HOOK], {
			timeout,
			label: 'ci-throttle.sh',
			env: hookEnv({
				...ambient(),
				HOME: dir,
				CI_THROTTLE_CONF: confPath,
				CI_THROTTLE_MEMINFO: meminfo,
				CI_THROTTLE_LOADAVG: loadavg,
				CI_THROTTLE_PRESSURE_CPU: pressure,
				CI_THROTTLE_TEST_OTHERS: String(others),
				CI_THROTTLE_PRUNE_ROOT: pruneRoot,
				...env,
			}),
		});
	} finally {
		writer?.kill('SIGKILL');
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * fleet-manager#12: a MemAvailable that MOVES while the hook waits. A separate
 * process ramps the fixture from `fromMb` toward `toMb` at `stepMb` per 0.3s
 * and then holds there; after `settleAfterS` (if given) it writes `settledMb`
 * and stops. A ramp, not a cycle: the hook samples every 1.5-3.5s, and a
 * cycling value can read the same at two samples by chance. The hook runs
 * under a synchronous spawn, so the writer has to be its own process. Each
 * write is a rename: a half-written meminfo reads as "no MemAvailable", which
 * the hook treats as unlimited and would admit on.
 *
 * Both the ramp and the settle are functions of WALL-CLOCK time since the
 * writer started, in milliseconds (fleet-manager#14). Counting loop
 * iterations let a loaded host starve the ramp, so the hook's first looks saw
 * flat memory; bash's `$SECONDS` is whole seconds from a whole-second start,
 * so a settle "at 4s" could land 3.0s in, ahead of the hook's first sample past
 * MAX_WAIT_S.
 */
function swingMeminfo(meminfo, { fromMb, toMb, stepMb = 500, settleAfterS, settledMb }) {
	const write = (mb) =>
		`printf 'MemAvailable:   %s kB\\n' $((${mb} * 1024)) >"$f.tmp" && mv "$f.tmp" "$f"`;
	// EPOCHREALTIME's separator follows the locale; strip it, keep microseconds.
	const nowMs = '$(( ${EPOCHREALTIME//[!0-9]/} / 1000 ))';
	const settle =
		settleAfterS === undefined
			? ''
			: `[ "$el" -ge ${settleAfterS * 1000} ] && { ${write(settledMb)}; exit 0; };`;
	const script = `f="$0"; t0=${nowMs}; while :; do el=$((${nowMs} - t0)); ${settle} mb=$((${fromMb} + el / 300 * ${stepMb})); [ "$mb" -gt ${toMb} ] && mb=${toMb}; ${write('mb')}; sleep 0.1; done`;
	return spawn('bash', ['-c', script, meminfo], { stdio: 'ignore' });
}

test('under the limit: admits immediately, exit 0', () => {
	const r = run({ conf: { MAX_CONCURRENT: 3, MIN_FREE_MB: 0, MAX_WAIT_S: 5 }, others: 1 });
	assert.equal(r.code, 0);
	assert.ok(r.elapsedMs < 3000, `should not have waited at all, took ${r.elapsedMs}ms`);
});

test('the N+1th job against maxConcurrent=N waits, then is REFUSED, not admitted', () => {
	// This is the enforcement P3.4 exists for: 2 other jobs already running,
	// MAX_CONCURRENT=2 leaves no slot for a third, and it never clears because
	// CI_THROTTLE_TEST_OTHERS pins the count for the whole run.
	const r = run({ conf: { MAX_CONCURRENT: 2, MIN_FREE_MB: 0, MAX_WAIT_S: 2 }, others: 2 });
	assert.notEqual(r.code, 0, 'a job still over the cap after the full wait must be refused');
	assert.match(r.out + r.err, /REFUS/i);
	assert.match(r.out + r.err, /::error::/, 'ADR 1751 annotation must be on the refusal');
});

// ── #73: THE "holding:" LINE MUST NOT DEPEND ON $SECONDS' GRANULARITY ──────
//
// `waited` is whole-second `$SECONDS` arithmetic, and the first loop
// iteration reads it after config parsing, the self-worker ancestry walk and
// a full `others()` pass have already run. If that real wall-clock gap
// happens to straddle a one-second boundary, `waited` is already >= 1 on the
// very first iteration — and every iteration after it is further still — so
// the old gate (`[ "$waited" -eq 0 ]`) never fires for that job at all. It
// failed one publish (wave 3s) while CI on the same commit passed, because
// whether the boundary is crossed depends on machine load at the instant the
// job happens to run, not on anything this test can pin without a seam.
//
// `CI_THROTTLE_TEST_FIRST_PASS_DELAY_S` sleeps, test-only, between `start`
// being captured and the loop's first read of it — a >=1s sleep guarantees at
// least one `$SECONDS` boundary is crossed before that first read, the exact
// shape of the bug, made to happen on every run instead of waited for.

test('#73: "holding:" still announces when the first pass already crosses a $SECONDS boundary', () => {
	const r = run({
		conf: { MAX_CONCURRENT: 1, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 5,
		env: { CI_THROTTLE_TEST_FIRST_PASS_DELAY_S: '1.2' },
	});
	assert.notEqual(r.code, 0, 'still over the cap after the full wait — refused as before');
	assert.match(
		r.out + r.err,
		/holding: \d+ other job/,
		`never announced holding, even though it waited: ${r.out}${r.err}`
	);
});

test('#73: the ordinary (undelayed) path still announces holding too — the fix did not narrow it', () => {
	const r = run({ conf: { MAX_CONCURRENT: 1, MIN_FREE_MB: 0, MAX_WAIT_S: 2 }, others: 5 });
	assert.notEqual(r.code, 0);
	assert.match(r.out + r.err, /holding: \d+ other job/, `${r.out}${r.err}`);
});

test('the wait actually elapses before refusing — it is a cap, not an instant no', () => {
	// MAX_WAIT_S is measured against bash's $SECONDS, whole-second resolution,
	// so the loop can legitimately fire anywhere from just over 1s to just
	// under 3s for a ceiling of 2 — this only has to tell "waited" apart from
	// "instant no" (the under-500ms baseline every non-waiting case above
	// measures at), not pin the exact second under shared CI load.
	const r = run({ conf: { MAX_CONCURRENT: 1, MIN_FREE_MB: 0, MAX_WAIT_S: 2 }, others: 5 });
	assert.notEqual(r.code, 0);
	assert.ok(r.elapsedMs >= 800, `refused too early to have waited at all: ${r.elapsedMs}ms`);
});

test('a slot that frees mid-wait still admits — the cap is not a permanent ban', () => {
	// Simulated by a wait long enough that MAX_WAIT_S alone would not refuse:
	// under the limit from the first check, so it must return immediately
	// rather than waiting out any part of MAX_WAIT_S.
	const r = run({ conf: { MAX_CONCURRENT: 5, MIN_FREE_MB: 0, MAX_WAIT_S: 10 }, others: 1 });
	assert.equal(r.code, 0);
});

test('the memory floor refuses too, independent of concurrency', () => {
	// Still a refusal, and that half is unchanged by #67 — what changed is the
	// DIAGNOSIS this now carries (see the #67 section below), not whether a
	// confirmed floor breach fails the job.
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 4096, MAX_WAIT_S: 2 },
		others: 0,
		memAvailableMb: 100,
	});
	assert.notEqual(r.code, 0);
	assert.match(r.out + r.err, /REFUS/i);
});

test('an exempt workflow is never refused, however far over the cap', () => {
	const r = run({
		conf: { MAX_CONCURRENT: 1, MIN_FREE_MB: 0, MAX_WAIT_S: 2 },
		others: 50,
		env: { GITHUB_WORKFLOW: 'Runner smoke test' },
	});
	assert.equal(r.code, 0, 'runner-smoke must start immediately regardless of contention');
});

test('an ambient GITHUB_WORKFLOW cannot exempt a case that did not ask for it', () => {
	// The other half of the case above. The exemption is real and must keep
	// working when a case ASKS for it; what it may not do is arrive by itself
	// from the environment the suite happens to run in. Poison the harness the
	// way a runner does and the cap must still hold.
	const saved = process.env.GITHUB_WORKFLOW;
	process.env.GITHUB_WORKFLOW = 'Runner smoke test';
	try {
		const r = run({ conf: { MAX_CONCURRENT: 1, MIN_FREE_MB: 0, MAX_WAIT_S: 2 }, others: 50 });
		assert.notEqual(r.code, 0, 'the cap must hold: no case here asked to be exempt');
		assert.match(r.out + r.err, /REFUS/i);
	} finally {
		if (saved === undefined) delete process.env.GITHUB_WORKFLOW;
		else process.env.GITHUB_WORKFLOW = saved;
	}
});

test('a broken config fails OPEN — uncertainty is never grounds for refusal', () => {
	const dir = tempDir(`${FIXTURE_PREFIX}badconf-`);
	try {
		const confPath = join(dir, 'ci-throttle.conf');
		writeFileSync(confPath, 'MAX_CONCURRENT=not-a-number\nMIN_FREE_MB=0\nMAX_WAIT_S=2\n');
		const meminfo = join(dir, 'meminfo');
		writeFileSync(meminfo, 'MemAvailable:   999999999 kB\n');
		const r = spawnSync('bash', [HOOK], {
			encoding: 'utf8',
			timeout: 15_000,
			env: hookEnv({
				...ambient(),
				HOME: dir,
				CI_THROTTLE_CONF: confPath,
				CI_THROTTLE_MEMINFO: meminfo,
				CI_THROTTLE_TEST_OTHERS: '50', // would refuse under any real cap
				CI_THROTTLE_PRUNE_ROOT: dir,
			}),
		});
		assert.equal(r.status, 0, 'a broken config must still admit the job');
		assert.match(r.stdout + r.stderr, /not a non-negative integer/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the default config (no conf file at all) is permissive, not enforcing', () => {
	// spawnSync, not execFileSync: a status assertion is the point of this test,
	// and `assert.ok(r.length >= 0)` on execFileSync's stdout — true of every
	// array, refusing or not — was the always-true assertion
	// test-vacuity-guard.test.mjs caught. The default MAX_CONCURRENT is 99, so
	// 50 "other" jobs must still admit; if the permissive default ever flipped
	// to enforcing, this would be the one test that catches it, so it has to
	// assert the exit code, not just "did not throw".
	const dir = tempDir(`${FIXTURE_PREFIX}noconf-`);
	try {
		const r = spawnSync('bash', [HOOK], {
			encoding: 'utf8',
			timeout: 15_000,
			env: hookEnv({
				...ambient(),
				HOME: dir,
				CI_THROTTLE_CONF: join(dir, 'does-not-exist.conf'),
				CI_THROTTLE_TEST_OTHERS: '50',
				CI_THROTTLE_PRUNE_ROOT: dir,
			}),
		});
		assert.equal(
			r.status,
			0,
			'a missing config must fall back to the permissive default, not refuse'
		);
		assert.doesNotMatch(
			r.stdout + r.stderr,
			/REFUS|::error::/,
			'the permissive default must never emit a refusal'
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── #36: A WAITER IS NOT LOAD ──────────────────────────────────────────────
//
// `others()` used to be `pgrep -x Runner.Worker` minus this job's own worker,
// and every job blocked in this very script has a Runner.Worker of its own. So
// a burst counted itself: four jobs arriving together on hokon each saw the
// other three, `4 < 4` was false for all four, and all four were refused at the
// 90s ceiling with 26GB free and a real load of one. It recurred 2026-09-17,
// -18 and -19 (pygmalion, resume-bot, study, task).
//
// The cases below drive the real accounting and therefore deliberately do NOT
// set `CI_THROTTLE_TEST_OTHERS` — pinning the count is exactly what would hide
// this bug. They seat real processes and real markers under a temp `$HOME`
// instead, so nothing they observe comes from the machine running the test.

/** Field 22 of /proc/<pid>/stat, read the way the hook reads it. */
function startTimeOf(pid) {
	const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
	// `comm` is parenthesised and may contain spaces, so skip past it entirely
	// rather than splitting on whitespace from the left.
	return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
}

const BASH = execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();

/**
 * One node's worth of fixture: a `$HOME` the hook will derive its marker
 * directory from, a rendered conf, a meminfo, and a copy of bash named
 * `Runner.Worker`.
 *
 * The rename is load-bearing twice over. `comm` is the EXECUTABLE's name, so it
 * is the only way to seat a process the hook's /proc ancestry walk recognises
 * as this job's worker — which is what makes the marker outlive the hook, the
 * property the whole fix rests on. It is also what the PREVIOUS implementation
 * counted, so the same fixture reproduces the deadlock against it.
 */
function nodeFixture({ maxConcurrent, maxWaitS, minFreeMb = 0, memAvailableMb = 999_999 }) {
	const home = tempDir(`${FIXTURE_PREFIX}node-`);
	const confPath = join(home, 'ci-throttle.conf');
	writeFileSync(
		confPath,
		`MAX_CONCURRENT=${maxConcurrent}\nMIN_FREE_MB=${minFreeMb}\nMAX_WAIT_S=${maxWaitS}\n`
	);
	const meminfo = join(home, 'meminfo');
	writeFileSync(meminfo, `MemAvailable:   ${memAvailableMb * 1024} kB\n`);
	const admitDir = join(home, '.hadoku', 'throttle', 'admitted');
	mkdirSync(admitDir, { recursive: true });
	const worker = join(home, 'Runner.Worker');
	copyFileSync(BASH, worker);
	// wave 4b: every spawn of the hook must point the prune at a fixture
	// directory, never the REAL /tmp of whatever machine runs this suite — a
	// stub `df` is put on PATH (see stubDf below) for the cases that care what
	// usage it reads; by default there is no stub, so df reads THIS directory's
	// real (tiny, never over threshold) usage, which is still never the host's
	// actual /tmp.
	const pruneRoot = join(home, 'prune-root');
	mkdirSync(pruneRoot, { recursive: true });
	const env = {
		...ambient(),
		HOME: home,
		CI_THROTTLE_CONF: confPath,
		CI_THROTTLE_MEMINFO: meminfo,
		CI_THROTTLE_PRUNE_ROOT: pruneRoot,
	};
	// `CI_THROTTLE_TEST_OTHERS` is deliberately absent — inherited, it would pin
	// the count and defeat every case in this section. `ambient()` is what keeps
	// it out.
	return { home, admitDir, worker, env, pruneRoot };
}

/**
 * A fake `df` on its own PATH entry, reporting a fixed total/used/avail (MB)
 * for any path it is asked about — the only way to drive `maybe_prune_tmp`'s
 * threshold arithmetic without a real tmpfs at a known fill level. Returns
 * the directory to prepend to PATH.
 */
function stubDf(scratchDir, { totalMb, usedMb, availMb, fail = false, headerOnly = false }) {
	const bin = mkdtempSync(join(scratchDir, 'df-stub-'));
	const script = fail
		? '#!/bin/sh\necho "df: cannot read" >&2\nexit 1\n'
		: headerOnly
			? '#!/bin/sh\necho "Filesystem 1M-blocks Used Available Use% Mounted"\n'
			: `#!/bin/sh\necho "Filesystem 1M-blocks Used Available Use% Mounted"\necho "fixture ${totalMb} ${usedMb} ${availMb} 0% x"\n`;
	writeFileSync(join(bin, 'df'), script, { mode: 0o755 });
	return bin;
}

/**
 * A job, as the runner seats one: a `Runner.Worker` that runs the hook and then
 * STAYS ALIVE for `lingerS` seconds, the way a real worker goes on to run the
 * job it was just admitted for.
 */
function spawnJob(fx, lingerS) {
	const child = spawn(fx.worker, ['-c', `bash "$0"; ec=$?; sleep ${lingerS}; exit $ec`, HOOK], {
		env: hookEnv(fx.env),
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const started = Date.now();
	let out = '';
	child.stdout.on('data', (d) => (out += d));
	child.stderr.on('data', (d) => (out += d));
	child.done = new Promise((resolve) =>
		child.on('close', (code) => resolve({ code, out, elapsedMs: Date.now() - started }))
	);
	return child;
}

/** A live process that is NOT running the hook — something to hang a marker on. */
function spawnIdler(fx, seconds) {
	// `; :` defeats bash's exec optimisation, which would replace the process
	// image and with it the `Runner.Worker` comm this fixture depends on.
	const child = spawn(fx.worker, ['-c', `sleep ${seconds}; :`], { stdio: 'ignore' });
	child.done = new Promise((resolve) => child.on('close', resolve));
	return child;
}

/** Run the hook directly (no worker ancestry), returning its exit code. */
function runHook(fx) {
	const started = Date.now();
	const r = spawnSync('bash', [HOOK], { encoding: 'utf8', env: hookEnv(fx.env), timeout: 60_000 });
	return {
		code: r.status ?? 1,
		out: (r.stdout ?? '') + (r.stderr ?? ''),
		elapsedMs: Date.now() - started,
	};
}

/** Wait until `pid` is gone from /proc, so "dead" means dead and not a zombie. */
async function reaped(child) {
	await child.done;
	for (let i = 0; i < 100 && existsSync(`/proc/${child.pid}`); i++) {
		await new Promise((r) => setTimeout(r, 20));
	}
}

test('four jobs arriving together are all admitted in turn — a waiter is not load (#36)', async () => {
	// The deadlock, exactly as hokon met it: MAX_CONCURRENT=4, one job genuinely
	// running, four more arriving in the same instant. Under the old accounting
	// each of the four counted the other three, every one of them read 4 and
	// none was ever admitted. Under admission markers a waiter holds nothing, so
	// the one that finds the node full waits for a real slot and gets it.
	const fx = nodeFixture({ maxConcurrent: 4, maxWaitS: 20 });
	const kids = [];
	try {
		const real = spawnIdler(fx, 60);
		kids.push(real);
		writeFileSync(
			join(fx.admitDir, `${real.pid}.${startTimeOf(real.pid)}`),
			'the job already running on this node\n'
		);

		const waiters = [0, 1, 2, 3].map(() => spawnJob(fx, 3));
		kids.push(...waiters);
		const results = await Promise.all(waiters.map((w) => w.done));

		for (const [i, r] of results.entries()) {
			assert.equal(r.code, 0, `waiter ${i} was refused (exit ${r.code}): ${r.out}`);
			assert.doesNotMatch(r.out, /REFUS|::error::/, `waiter ${i} emitted a refusal: ${r.out}`);
		}
		// IN TURN, not all at once. Four waiters against three free slots means
		// exactly one had to hold and then be let in — if none did, the cap
		// stopped being a cap and this test would be passing for the wrong
		// reason. Both halves of that sentence are asserted: a run where the
		// hold never happened and a run where it happened and never ended look
		// identical from the exit codes alone.
		const transcript = results.map((r) => r.out).join('|');
		assert.ok(
			results.some((r) => /holding: \d+ other job/.test(r.out)),
			`no waiter ever held, so the cap admitted all four at once: ${transcript}`
		);
		assert.ok(
			results.some((r) => /slot free after \d+s/.test(r.out)),
			`a waiter held but no admission was ever reported as a wait: ${transcript}`
		);
	} finally {
		for (const k of kids) k.kill('SIGKILL');
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test('a marker counts while its pid lives and stops the instant it dies — liveness, never age', async () => {
	const fx = nodeFixture({ maxConcurrent: 1, maxWaitS: 3 });
	const idler = spawnIdler(fx, 60);
	const marker = join(fx.admitDir, `${idler.pid}.${startTimeOf(idler.pid)}`);
	try {
		writeFileSync(marker, 'one admitted job\n');

		// Live: it is the one slot, so the next job is refused. Without this half
		// the second half would pass against a count that is always zero.
		const refused = runHook(fx);
		assert.notEqual(refused.code, 0, `a live marker must hold the only slot: ${refused.out}`);
		assert.match(refused.out, /REFUS/i);
		assert.ok(existsSync(marker), 'a live marker must not be reaped');

		// Dead: the SAME marker, still seconds old. Nothing about the file
		// changed, so no age rule can explain the difference — only the pid.
		idler.kill('SIGKILL');
		await reaped(idler);
		const admitted = runHook(fx);
		assert.equal(admitted.code, 0, `a dead pid's marker must not count: ${admitted.out}`);
		// "Did not wait" is read off the transcript, not the clock: the hook says
		// `holding:` the first time through its wait loop, unconditionally. A
		// wall-clock bound failed this case at 2495ms on a box at load 88 while
		// the hook had admitted on its first pass.
		assert.doesNotMatch(admitted.out, /holding:/, `should not have waited at all: ${admitted.out}`);
		assert.equal(existsSync(marker), false, 'the pass that read it must also unlink it');
	} finally {
		idler.kill('SIGKILL');
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test('a recycled pid is a different process — the start time, not the pid, is the identity', async () => {
	// pids wrap. A marker naming a pid that something unrelated now owns would
	// hold a slot forever against a process that never ran a job.
	const fx = nodeFixture({ maxConcurrent: 1, maxWaitS: 3 });
	const idler = spawnIdler(fx, 60);
	// A start time of 1 clock tick after boot, which nothing spawned just now
	// can have.
	const marker = join(fx.admitDir, `${idler.pid}.1`);
	try {
		writeFileSync(marker, 'a marker left by whatever held this pid before\n');
		const r = runHook(fx);
		assert.equal(r.code, 0, `a recycled pid must not hold a slot: ${r.out}`);
		assert.equal(existsSync(marker), false, 'a stale marker must be unlinked, not left to rot');
	} finally {
		idler.kill('SIGKILL');
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test('an unwritable marker directory fails OPEN, as the pgrep it replaced did', () => {
	// "I could not look" is uncertainty about the LIMIT, and this hook has never
	// refused on that — see its header. The directory is made unwritable rather
	// than deleted, because the hook creates a missing one.
	const fx = nodeFixture({ maxConcurrent: 1, maxWaitS: 3 });
	try {
		const idler = spawnIdler(fx, 30);
		writeFileSync(join(fx.admitDir, `${idler.pid}.${startTimeOf(idler.pid)}`), 'held\n');
		execFileSync('chmod', ['0000', fx.admitDir]);
		try {
			const r = runHook(fx);
			assert.equal(r.code, 0, `an unreadable marker dir must admit, not refuse: ${r.out}`);
			assert.doesNotMatch(r.out, /REFUS|::error::/);
		} finally {
			execFileSync('chmod', ['0755', fx.admitDir]);
			idler.kill('SIGKILL');
		}
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

// ── #67: CONTENTION AND PLACEMENT ARE TWO FINDINGS ─────────────────────────
//
// On 2026-09-26 21:18 hokon refused `hadoku-tenhands / Task automation` with:
//
//   ci-throttle: refused on hokon after 91s — 0 concurrent job(s), 7120MB
//   available (limit 4 job(s) / 8192MB free). Re-run once the node has a free
//   slot.
//
// Zero concurrent jobs, and a floor nothing of ours was going to free. The
// advice named a slot that was already free — all four were — so it could not
// be acted on, and re-running refused again.
//
// The discriminator is not "which test failed" but whether this gate saw
// ANOTHER ADMITTED JOB at any point in the wait. The pairs below are therefore
// A/B on one conf with only `others` differing: a lazy fix that simply stopped
// refusing on memory, or one that reworded every refusal, breaks the half where
// "try again later" is genuinely the right advice.

/** The exact shape of #67: hokon's conf, hokon's reading, nothing running. */
const HOKON_67 = {
	conf: { MAX_CONCURRENT: 4, MIN_FREE_MB: 8192, MAX_WAIT_S: 2 },
	memAvailableMb: 7120,
};

test('#67: a memory floor at ZERO admitted jobs refuses as PLACEMENT, not "wait for a slot"', () => {
	const r = run({ ...HOKON_67, others: 0 });
	const all = r.out + r.err;
	assert.notEqual(r.code, 0, `a confirmed floor breach must still fail the job: ${all}`);
	assert.match(all, /::error::ci-throttle: refused/, 'ADR 1751 annotation must survive');

	// The one thing the issue asks for: stop telling an operator to wait for a
	// slot that is already free. This is the assertion that fails with the fix
	// reverted.
	assert.doesNotMatch(
		all,
		/Re-run once the node has a free slot/,
		`at 0 concurrency there is no slot to wait for: ${all}`
	);
	assert.match(all, /cannot host this job/, all);
	assert.match(all, /placement problem, not a throttling one/, all);

	// The numbers, from the whole wait rather than the last sample: the
	// shortfall, the floor, the range MemAvailable held, and the slots that were
	// free throughout. All four are what makes the finding actionable.
	assert.match(all, /1072MB short of its 8192MB memory floor/, all);
	assert.match(all, /MemAvailable stayed 7120MB for the whole wait/, all);
	assert.match(all, /0 of 4 slot\(s\) were in use at any point in the wait/, all);
	// And what to actually do, naming the field and the redeploy.
	assert.match(all, /minFreeMb for this node in fleet-runner-manifest\.json/, all);
});

test('#67: the SAME conf with a job actually running STILL says try again later', () => {
	// The half a lazy fix breaks. Identical floor, identical reading, identical
	// breach — the only difference is that one admitted job is on the node, so
	// something WILL finish and waiting is the correct advice.
	const r = run({ ...HOKON_67, others: 1 });
	const all = r.out + r.err;
	assert.notEqual(r.code, 0, `memory pressure with a job running must still refuse: ${all}`);
	assert.match(all, /Re-run once the node has a free slot/, all);
	assert.doesNotMatch(
		all,
		/cannot host this job/,
		`one running job is contention, not size: ${all}`
	);
	assert.doesNotMatch(all, /placement problem/, all);
	assert.match(all, /1 concurrent job\(s\), peak 1/, all);
});

test('#67: a plain concurrency breach is untouched — it was always "try again later"', () => {
	const r = run({ conf: { MAX_CONCURRENT: 2, MIN_FREE_MB: 0, MAX_WAIT_S: 2 }, others: 2 });
	const all = r.out + r.err;
	assert.notEqual(r.code, 0);
	assert.match(all, /Re-run once the node has a free slot/, all);
	assert.doesNotMatch(all, /cannot host this job|placement problem/, all);
});

test('#67: the full wait still elapses before a placement refusal — one sample is not evidence', () => {
	// A JIT slot holds memory and no marker, so it is invisible to the admitted
	// count; only MemAvailable moving over time distinguishes one finishing in
	// 30s from a resident baseline. Refusing on the first pass would assert
	// "cannot" from a single reading.
	const r = run({ ...HOKON_67, others: 0 });
	assert.match(r.out + r.err, /cannot host this job/);
	assert.ok(r.elapsedMs >= 800, `refused too early to have measured anything: ${r.elapsedMs}ms`);
});

test('#67: a node that can admit NO job says so, rather than naming a free slot', () => {
	// maxConcurrent: 0 is not a configuration the fleet uses, but it reaches the
	// same rule from the other side: nothing was ever admitted, so there is
	// nothing to wait for. Left to the old message it would have read "limit 0
	// job(s) ... re-run once the node has a free slot".
	const r = run({
		conf: { MAX_CONCURRENT: 0, MIN_FREE_MB: 0, MAX_WAIT_S: 2 },
		others: 0,
		memAvailableMb: 999_999,
	});
	const all = r.out + r.err;
	assert.notEqual(r.code, 0, all);
	assert.match(all, /declared concurrency limit is 0, so no job can be admitted here at all/, all);
	assert.doesNotMatch(all, /Re-run once the node has a free slot/, all);
	assert.match(all, /Raise maxConcurrent/, all);
});

// ── fleet-manager#12: a MOVING floor is a transient, not a placement finding ──
//
// hokon refused bomberman's redeploy at 04:56 on 2026-10-27 with 0 of 4 slots
// in use and MemAvailable swinging 1732-7065MB across the 91s wait — every PM2
// service had restarted ~7 minutes earlier. It said "re-running will refuse
// again", and a re-run an hour later passed first time. The A/B below keeps
// the flat half: the SAME conf with memory that does not move still refuses at
// MAX_WAIT_S, fast, as placement.

const HOKON_12 = { MAX_CONCURRENT: 4, MIN_FREE_MB: 8192, MAX_WAIT_S: 2, MAX_HOLD_S: 6 };

test('#12: memory MOVING with free slots holds past MAX_WAIT_S and admits once it settles', () => {
	// The hook's sleep is seeded by its PID, so every pass sleeps the same
	// 1.5-3.5s and its first sample past MAX_WAIT_S lands by ~3.8s unloaded.
	// Settling at 8s leaves that sample 4s of slack on a busy host; it settled
	// at 4s until fleet-manager#13/#14, which left ~0.2s. The hold and the
	// spawn ceiling grow to cover the later admission. The ramp spans ~7.3s
	// rather than the default ~3.2s: at load 90 the hook's first sample landed
	// after the default ramp had gone flat, so it read no swing and refused.
	// At 220MB per 0.3s, any two samples the hook takes 1.5s apart before ~7.3s
	// differ by 1,100MB, over MEM_SWING_MB.
	const r = run({
		conf: { ...HOKON_12, MAX_HOLD_S: 20 },
		others: 0,
		memAvailableMb: 1732,
		memSwing: { fromMb: 1732, toMb: 7065, stepMb: 220, settleAfterS: 8, settledMb: 19_000 },
		timeout: 30_000,
	});
	const all = r.out + r.err;
	assert.equal(r.code, 0, `a settling transient must be admitted, not refused: ${all}`);
	assert.match(all, /a transient, not a baseline; holding up to 20s/, all);
	assert.match(all, /slot free after \d+s/, all);
	assert.ok(r.elapsedMs >= 7_500, `admitted before the swing could settle: ${r.elapsedMs}ms`);
});

test('#12: memory MOVING that never settles refuses at MAX_HOLD_S, and does NOT call it placement', () => {
	const r = run({
		conf: HOKON_12,
		others: 0,
		memAvailableMb: 1732,
		memSwing: { fromMb: 1732, toMb: 7065 },
	});
	const all = r.out + r.err;
	assert.notEqual(r.code, 0, `the floor was never met, so the job is still refused: ${all}`);
	assert.match(all, /::error::ci-throttle: refused/, all);
	// $SECONDS is whole seconds, so `waited >= 6` can read true ~5.0s in.
	assert.ok(r.elapsedMs >= 5_000, `refused before MAX_HOLD_S: ${r.elapsedMs}ms`);
	// The two claims #12 caught being false.
	assert.doesNotMatch(all, /re-running will refuse again/, all);
	assert.doesNotMatch(all, /placement problem|cannot host this job/, all);
	assert.match(all, /a transient, not a baseline/, all);
	assert.match(all, /Re-run once the node's memory settles/, all);
});

// "Refused at MAX_WAIT_S (2s), not held for MAX_HOLD_S (600s)". The output
// says which branch ran; the time bound only has to tell 2s from 600s. It was
// 5s, and at load 60-90 the 2s wait itself took 5.3s.
const FAST_REFUSAL_MS = 30_000;

test('#12: the SAME conf with FLAT memory still refuses fast, as placement', () => {
	const r = run({ conf: { ...HOKON_12, MAX_HOLD_S: 600 }, others: 0, memAvailableMb: 7120 });
	const all = r.out + r.err;
	assert.notEqual(r.code, 0, all);
	assert.ok(
		r.elapsedMs < FAST_REFUSAL_MS,
		`a flat floor breach must not take the long hold: ${r.elapsedMs}ms`
	);
	assert.match(all, /re-running will refuse again/, all);
	assert.match(all, /placement problem, not a throttling one/, all);
	assert.doesNotMatch(all, /holding up to/, all);
});

test('#12: a swing below MEM_SWING_MB is still flat', () => {
	const r = run({
		conf: { ...HOKON_12, MAX_HOLD_S: 600 },
		others: 0,
		memAvailableMb: 7120,
		memSwing: { fromMb: 7120, toMb: 7600, stepMb: 100 },
	});
	const all = r.out + r.err;
	assert.notEqual(r.code, 0, all);
	assert.ok(r.elapsedMs < FAST_REFUSAL_MS, `480MB of noise is not a transient: ${r.elapsedMs}ms`);
	assert.match(all, /placement problem/, all);
	assert.doesNotMatch(all, /holding up to/, all);
});

test('#12: moving memory with a job RUNNING is contention, refused at MAX_WAIT_S, not held longer', () => {
	const r = run({
		conf: { ...HOKON_12, MAX_HOLD_S: 600 },
		others: 1,
		memAvailableMb: 1732,
		memSwing: { fromMb: 1732, toMb: 7065 },
	});
	const all = r.out + r.err;
	assert.notEqual(r.code, 0, all);
	assert.ok(
		r.elapsedMs < FAST_REFUSAL_MS,
		`contention already has the right wait: ${r.elapsedMs}ms`
	);
	assert.match(all, /Re-run once the node has a free slot/, all);
	assert.doesNotMatch(all, /holding up to/, all);
});

test('#67: an UNREADABLE admitted-job count never becomes a placement finding', () => {
	// `others()` fails open to 0 when the marker directory cannot be read, and
	// that 0 means "could not look", not "nothing running". A placement finding
	// reasons FROM a zero, so it must refuse to be built on that one — reading
	// "I could not look" as "nothing is wrong" is the thing CLAUDE.md forbids
	// outright. The memory breach is still real (it comes from the kernel), so
	// the job is still refused; what changes is the diagnosis and the advice.
	const fx = nodeFixture({
		maxConcurrent: 4,
		maxWaitS: 2,
		minFreeMb: 8192,
		memAvailableMb: 7120,
	});
	const idler = spawnIdler(fx, 30);
	try {
		execFileSync('chmod', ['0000', fx.admitDir]);
		try {
			const r = runHook(fx);
			assert.notEqual(r.code, 0, `a kernel-confirmed floor breach must refuse: ${r.out}`);
			assert.match(r.out, /UNREADABLE admitted-job count/, r.out);
			assert.match(r.out, /could not look/, r.out);
			assert.doesNotMatch(
				r.out,
				/cannot host this job|placement problem/,
				`a count that could not be taken cannot prove the node is too small: ${r.out}`
			);
		} finally {
			execFileSync('chmod', ['0755', fx.admitDir]);
		}
	} finally {
		idler.kill('SIGKILL');
		rmSync(fx.home, { recursive: true, force: true });
	}
});

// ── #76's hokon half: KNOWN NEED VS THIS UNIT'S CAP, A STATIC FINDING ──────
//
// In an outage the backstop promotes hokon onto `hadoku-builder` and GitHub
// assigns jobs to it directly, bypassing `admitMint` entirely — this hook is
// the only gate those jobs pass through. `reserve_mb()` reads the SAME
// admission ledger `admitMint` reads (`facets[<repo>].jobP95Mb.mb`), and
// `unit_cap_mb()` reads this job's own cgroup `memory.max` the same way
// job-metrics.sh already does. Both are fixtured here rather than driven
// against the real ledger/cgroup, for the same reason MEMINFO is: a fixture
// is the only way to pin them for an assertion.

/** A temp `fleet-runner-coverage.json` holding exactly the facets given. */
function reserveFixture(facets) {
	const dir = tempDir(`${FIXTURE_PREFIX}reserve-`);
	const file = join(dir, 'fleet-runner-coverage.json');
	writeFileSync(file, JSON.stringify({ facets }));
	return file;
}

/** A temp file standing in for this job's cgroup `memory.max`. */
function capFixture(bytesOrMax) {
	const dir = tempDir(`${FIXTURE_PREFIX}cap-`);
	const file = join(dir, 'memory.max');
	writeFileSync(file, `${bytesOrMax}\n`);
	return file;
}

test("#76: a known need over this unit's cap refuses IMMEDIATELY, as PLACEMENT, no wait", () => {
	const reserveFile = reserveFixture({
		'WolffM/brave-quartet': { jobP95Mb: { mb: 6313, basis: 'fleet-p95', runs: 3 } },
	});
	const capFile = capFixture(4294967296); // 4096 MiB, hokon's measured per-unit cap
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 0, MAX_WAIT_S: 90 },
		others: 0,
		env: {
			GITHUB_REPOSITORY: 'WolffM/brave-quartet',
			CI_THROTTLE_RESERVE_FILE: reserveFile,
			CI_THROTTLE_CGROUP_MEMORY_MAX: capFile,
		},
	});
	assert.notEqual(r.code, 0, `a confirmed cap breach must refuse: ${r.out}${r.err}`);
	assert.match(r.out + r.err, /::error::/, 'ADR 1751 annotation must be on the refusal');
	assert.match(r.out + r.err, /cannot host this job/, r.out + r.err);
	assert.match(r.out + r.err, /placement problem, not a throttling one/, r.out + r.err);
	assert.match(r.out + r.err, /6313MB/, r.out + r.err);
	assert.match(r.out + r.err, /4096MB/, r.out + r.err);
	// STATIC — nothing a wait could learn changes either number, so this must
	// not pay any part of MAX_WAIT_S=90 to say so.
	assert.ok(
		r.elapsedMs < 3000,
		`a static cap breach must refuse before waiting, took ${r.elapsedMs}ms`
	);
});

test('#76: a known need AT OR UNDER the cap is not touched by this check', () => {
	const reserveFile = reserveFixture({
		'WolffM/hadoku-aggregator': { jobP95Mb: { mb: 1878, basis: 'measured', runs: 43 } },
	});
	const capFile = capFixture(4294967296);
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 0,
		env: {
			GITHUB_REPOSITORY: 'WolffM/hadoku-aggregator',
			CI_THROTTLE_RESERVE_FILE: reserveFile,
			CI_THROTTLE_CGROUP_MEMORY_MAX: capFile,
		},
	});
	assert.equal(r.code, 0, `well under the cap must admit normally: ${r.out}${r.err}`);
});

test('#76: no ledger on disk is uncertainty, not a breach — admits', () => {
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 0,
		env: {
			GITHUB_REPOSITORY: 'WolffM/brave-quartet',
			CI_THROTTLE_RESERVE_FILE: '/does/not/exist/fleet-runner-coverage.json',
			CI_THROTTLE_CGROUP_MEMORY_MAX: capFixture(4294967296),
		},
	});
	assert.equal(r.code, 0, `an absent ledger must fail open, not refuse: ${r.out}${r.err}`);
	assert.doesNotMatch(r.out + r.err, /cannot host this job|placement problem/);
});

test('#76: a repo the ledger has no entry for is uncertainty, not a breach — admits', () => {
	const reserveFile = reserveFixture({
		'WolffM/some-other-repo': { jobP95Mb: { mb: 9999, basis: 'measured', runs: 10 } },
	});
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 0,
		env: {
			GITHUB_REPOSITORY: 'WolffM/brave-quartet',
			CI_THROTTLE_RESERVE_FILE: reserveFile,
			CI_THROTTLE_CGROUP_MEMORY_MAX: capFixture(4294967296),
		},
	});
	assert.equal(r.code, 0, `an unlisted repo must fail open, not refuse: ${r.out}${r.err}`);
	assert.doesNotMatch(r.out + r.err, /cannot host this job|placement problem/);
});

test('#76: an UNCAPPED unit ("max") cannot be in breach of a cap it does not have', () => {
	const reserveFile = reserveFixture({
		'WolffM/brave-quartet': { jobP95Mb: { mb: 99999, basis: 'measured', runs: 10 } },
	});
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 0,
		env: {
			GITHUB_REPOSITORY: 'WolffM/brave-quartet',
			CI_THROTTLE_RESERVE_FILE: reserveFile,
			CI_THROTTLE_CGROUP_MEMORY_MAX: capFixture('max'),
		},
	});
	assert.equal(
		r.code,
		0,
		`an uncapped unit must admit regardless of the reserve: ${r.out}${r.err}`
	);
	assert.doesNotMatch(r.out + r.err, /cannot host this job|placement problem/);
});

test('#76: an unreadable cap file is uncertainty, not a breach — admits', () => {
	const reserveFile = reserveFixture({
		'WolffM/brave-quartet': { jobP95Mb: { mb: 99999, basis: 'measured', runs: 10 } },
	});
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 0,
		env: {
			GITHUB_REPOSITORY: 'WolffM/brave-quartet',
			CI_THROTTLE_RESERVE_FILE: reserveFile,
			CI_THROTTLE_CGROUP_MEMORY_MAX: '/does/not/exist/memory.max',
		},
	});
	assert.equal(r.code, 0, `an unreadable cap must fail open, not refuse: ${r.out}${r.err}`);
	assert.doesNotMatch(r.out + r.err, /cannot host this job|placement problem/);
});

test('#76: the lower-bound shape (jobP95Mb.mb raised off a capped run) is still used as a need', () => {
	// Exactly brave-quartet's real shape (wave 3t Lane C): three runs, two
	// capped at a 6.3GB slice. The hook does not need to know `lowerBound`
	// exists — `.mb` already carries "at least this much" whether or not that
	// field is present, which is why reserve_mb() reads nothing but `.mb`.
	const reserveFile = reserveFixture({
		'WolffM/brave-quartet': {
			jobP95Mb: { mb: 6313, basis: 'fleet-p95', runs: 3, lowerBound: true },
		},
	});
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 0,
		env: {
			GITHUB_REPOSITORY: 'WolffM/brave-quartet',
			CI_THROTTLE_RESERVE_FILE: reserveFile,
			CI_THROTTLE_CGROUP_MEMORY_MAX: capFixture(4294967296),
		},
	});
	assert.notEqual(r.code, 0, `a lower-bound need over the cap must still refuse: ${r.out}${r.err}`);
	assert.match(r.out + r.err, /cannot host this job/, r.out + r.err);
});

// ── the DEPLOYER: a guest is skipped by role ───────────────────────────────
//
// `deploy-ci-throttle.mjs` writes the hook above onto every node it selects.
// It selected a guest: `selectMachines` filters on `--machine` alone and the
// `bounded()` filter asks only about maxConcurrent/minFreeMb, both of which
// hokon declares — so a bare `--confirm` would have ssh'd the operator's
// production host. Wave 3d §K asserted the skip existed; it did not.
//
// EVERY CASE BELOW IS DRIVEN AGAINST A TEMP MANIFEST AND REACHES NO NODE. The
// fixture nodes are named under `.invalid`, which RFC 2606 reserves so it can
// never resolve, and each case is chosen so the script returns before its one
// `ssh` call site (the loop over `nodes`) — which is also what makes it safe to
// exercise `--confirm` here.

/** A temp manifest dir holding `machines`, plus the state dir the script wants. */
function manifestFixture(machines) {
	const root = tempDir(`${FIXTURE_PREFIX}role-`);
	const manifestDir = join(root, 'manifests');
	const stateDir = join(root, 'state');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(
		join(manifestDir, 'fleet-runner-manifest.json'),
		JSON.stringify({ toolchain: { capabilities: [] }, machines }, null, 2)
	);
	return {
		root,
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: manifestDir,
			HADOKU_STATE_DIR: stateDir,
			HADOKU_SITE_ROOT: root,
		},
	};
}

/**
 * Run the deployer. Never throws on a non-zero exit — refusing IS the behaviour
 * under test — but DOES throw if the child was killed or never started, which
 * is neither a refusal nor a report.
 */
function deploy(args, env) {
	return spawnCapture(process.execPath, [DEPLOYER, ...args], {
		env,
		timeout: 60_000,
		label: `deploy-ci-throttle ${args.join(' ')}`,
	});
}

/**
 * The deployer's `--json` report, or a failure naming the status, the signal,
 * the elapsed time and the child's stderr.
 *
 * This is the line #45 was reported at. Both spawned scripts import from
 * `../dist/`, `pnpm run build` opens with `rm -rf dist` and `pnpm run test`
 * with `rm -rf dist/tests`; a second `pnpm run check` running concurrently
 * therefore deletes the tree out from under this child, which exits 1 having
 * written ERR_MODULE_NOT_FOUND to stderr and nothing to stdout. Parsing that
 * blind reported "Unexpected end of JSON input" — the one place the fault was
 * not.
 */
function json(r) {
	return parseJsonStdout(r);
}

// ── #76: `resolveReserveFile()` / `renderConf()`, run as the REAL code ─────
//
// `deploy-ci-throttle.mjs` is a CLI entry point: importing it runs its whole
// argv-parsing-through-`process.exit` body as a side effect, so it cannot be
// `import`ed here to unit-test one function in isolation — and spawning it as
// a subprocess (the pattern every other deployer test above uses) can only
// observe `results`/exit code/stdout, never the CONTENT of the conf this
// script renders: that text is piped to `ssh`/local `bash` and never echoed
// back, by design.
//
// So these two functions are pulled out of the REAL, CURRENT file — not a
// hand-copied duplicate that could silently drift from it — by balanced-brace
// extraction (a non-greedy regex would stop at the first inner `}`, e.g. the
// `catch { }` block's own close, truncating the function), and run as their
// own tiny module via a `data:` URL import. `resolveReserveFile()`'s one real
// dependency (`manifest` from `./lib/paths.mjs`) is imported by its real
// absolute path, so the resolution under test is the production resolver
// (`manifestDir()` -> `FLEET_MANIFEST_DIR`/`siteRoot()`), not a stand-in.

/**
 * One top-level `function <name>(...) { … }` declaration's exact source text,
 * found by counting braces from its `{` to the matching `}` — safe here
 * because every `{`/`}` inside either function's body is either a template
 * expression's own matched pair (`${…}`) or absent; neither function's prose
 * comments contain a stray brace.
 */
function extractFunction(source, name) {
	const at = source.indexOf(`function ${name}(`);
	assert.ok(at >= 0, `function ${name} not found in ${DEPLOYER} — extraction is stale`);
	const bodyStart = source.indexOf('{', at);
	let depth = 0;
	let i = bodyStart;
	for (; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) break;
		}
	}
	assert.ok(depth === 0, `function ${name}: braces never balanced — extraction is stale`);
	return source.slice(at, i + 1);
}

/** Import `name` out of the real deploy-ci-throttle.mjs as its own module. */
async function loadRealFunction(name, { needsPaths = false } = {}) {
	const source = readFileSync(DEPLOYER, 'utf8');
	const fn = extractFunction(source, name);
	const pathsUrl = pathToFileURL(join(SCRIPTS, 'lib', 'paths.mjs')).href;
	// Aliased `manifest as manifestFile`, matching the REAL source's own import
	// (`import { manifest as manifestFile } from './lib/paths.mjs';`) — the
	// extracted function body calls it as `manifestFile(...)`, so an unaliased
	// import here would leave that name undefined and silently fall into the
	// function's own `catch`, returning `null` for every case alike.
	const moduleSrc =
		(needsPaths
			? `import { existsSync } from 'node:fs';\nimport { manifest as manifestFile } from '${pathsUrl}';\n`
			: '') + `export ${fn}`;
	const mod = await import(
		`data:text/javascript;base64,${Buffer.from(moduleSrc).toString('base64')}`
	);
	return mod[name];
}

test('#76: renderConf() includes RESERVE_FILE only when given a path, verbatim', async () => {
	const renderConf = await loadRealFunction('renderConf');
	const withoutReserve = renderConf(
		'claw-a',
		{ cores: 8, ramGb: 16, maxConcurrent: 2, minFreeMb: 1024 },
		null
	);
	assert.doesNotMatch(withoutReserve, /RESERVE_FILE/, withoutReserve);

	const withReserve = renderConf(
		'hokon',
		{ cores: 12, ramGb: 61, maxConcurrent: 4, minFreeMb: 8192 },
		'/some/resolved/fleet-runner-coverage.json'
	);
	assert.match(
		withReserve,
		/^RESERVE_FILE=\/some\/resolved\/fleet-runner-coverage\.json$/m,
		withReserve
	);
});

test('#76: resolveReserveFile() resolves through the REAL manifestDir(), and is null when nothing is there yet', async () => {
	const resolveReserveFile = await loadRealFunction('resolveReserveFile', { needsPaths: true });
	const f = manifestFixture({ 'claw-a.invalid': { cores: 4, labels: [], role: 'claw' } });
	const saved = { ...process.env };
	try {
		// Everything synchronous from here to the `finally` restore — no `await`
		// in between — so no other test in this file can observe the mutated env.
		Object.assign(process.env, f.env);

		// manifestDir() resolves (FLEET_MANIFEST_DIR points at the fixture), but
		// nothing has written a coverage file into it yet.
		assert.equal(resolveReserveFile(), null);

		// Write it at the EXACT path manifestFile() resolves — not a path this
		// test invents — and resolveReserveFile() must return that same path.
		const expected = join(f.env.FLEET_MANIFEST_DIR, 'fleet-runner-coverage.json');
		writeFileSync(expected, '{"facets":{}}');
		assert.equal(resolveReserveFile(), expected);
	} finally {
		process.env = saved;
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('#76: the per-node call site gates RESERVE_FILE on isLocalNode, never on CONFIRM/CHECK alone', () => {
	// The one line this follow-up exists for: `resolveReserveFile()` resolves a
	// path on the DEPLOYING box, and that path means nothing on a REMOTE node's
	// filesystem, so it must reach `renderConf` ONLY for the node that IS this
	// box. Behaviourally exercising `isLocalNode(name)` reading TRUE would mean
	// actually running this script's local-execution path against the real
	// node it happens to run on in this environment — out of scope for a test
	// (no writes of any kind to a guest, and no real local execution of the
	// install payload at all, read-only or not). `isLocalNode` itself is
	// already guarded elsewhere (`node-identity-guard.test.mjs`); what matters
	// here is only that THIS call site still asks it, rather than reading
	// `RESERVE_FILE` unconditionally or gating on something else — a structural
	// check, the same kind `node-identity-guard.test.mjs` already uses for the
	// same reason: a behavioural test cannot catch a line being deleted or
	// loosened, only a reader of the source can.
	const source = readFileSync(DEPLOYER, 'utf8');
	assert.match(
		source,
		/const reserveFile = isLocalNode\(name\) \? RESERVE_FILE : null;/,
		'the per-node RESERVE_FILE gate must read exactly isLocalNode(name) ? RESERVE_FILE : null — ' +
			'found something else, so a remote node may now be getting a path resolved on this box'
	);
	// And it must be the value renderConf is actually called with, not a
	// sibling variable nobody passes on.
	assert.match(
		source,
		/renderConf\(name, m, reserveFile\)/,
		'renderConf must be called with the gated reserveFile, not m/name alone or RESERVE_FILE directly'
	);
});

const GUEST_NODE = {
	cores: 12,
	labels: ['pm2-host'],
	maxConcurrent: 4,
	minFreeMb: 8192,
	role: 'guest',
};
const CLAW_NODE = { cores: 8, labels: [], maxConcurrent: 2, minFreeMb: 1024, role: 'claw' };

test('deployer: an explicit --machine <guest> REFUSES and names the role', () => {
	// Someone will type it. The refusal has to say "guest", not the generic
	// "no nodes to deploy to", which reads as "that name is not in the manifest"
	// and sends them hunting a typo that is not there.
	const f = manifestFixture({ 'guest-host.invalid': GUEST_NODE, 'claw-a.invalid': CLAW_NODE });
	try {
		const r = deploy(['--check', '--machine', 'guest-host.invalid'], f.env);
		assert.equal(r.code, 2, `expected a usage refusal, got ${r.code}: ${r.err}`);
		assert.match(r.err, /GUEST/);
		assert.match(r.err, /nothing was contacted/i);
		// It must point at the manifest key, not read as a hardcoded name.
		assert.match(r.err, /role/);
		assert.doesNotMatch(r.out + r.err, /SUMMARY/, 'no node may be contacted on this path');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('deployer: a guest is reported as skipped-by-role, under --check AND --confirm', () => {
	// The claw declares no maxConcurrent/minFreeMb, so nothing is left to deploy
	// to and the script returns before its ssh. That is what lets --confirm be
	// exercised here at all: the skip must be stated on an APPLY run too, since
	// a --confirm that quietly skipped a node is exactly as misleading as an
	// audit that did.
	for (const mode of ['--check', '--confirm']) {
		const f = manifestFixture({
			'guest-host.invalid': GUEST_NODE,
			'claw-unbounded.invalid': { cores: 4, labels: [], role: 'claw' },
		});
		try {
			const r = deploy([mode], f.env);
			assert.match(
				r.out,
				/guest-host\.invalid\s+\[skipped: guest\]/,
				`${mode}: the guest must be named as skipped, got: ${r.out}`
			);
			assert.match(r.out, /out of scope/i, `${mode}: the skip must say why`);
			assert.doesNotMatch(r.out + r.err, /SUMMARY/, `${mode}: no node may be contacted`);
			// Zero nodes deployed to is a FAILURE, never a clean pass.
			assert.equal(r.code, 1, `${mode}: zero nodes must fail loudly, got ${r.code}`);
			assert.match(r.err, /no nodes to deploy to/);
			assert.match(r.err, /guest\(s\) skipped by role/);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}
});

test('deployer: --json carries skippedGuests, and the guest is NOT in results', () => {
	// `log()` is suppressed under --json, so the human-readable skip line above
	// cannot be the only channel: anything parsing this output would otherwise
	// see a fleet with the guest silently missing and no way to tell it from a
	// node that was never declared.
	const f = manifestFixture({ 'guest-host.invalid': GUEST_NODE, 'claw-a.invalid': CLAW_NODE });
	try {
		const r = deploy(['--check', '--json'], f.env);
		const report = json(r);
		assert.deepEqual(report.skippedGuests, ['guest-host.invalid']);
		assert.deepEqual(
			report.results.map((x) => x.machine),
			['claw-a.invalid'],
			'a skipped guest must not appear as a node this run acted on'
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ── the DEPLOYER: the ONE door past the skip ───────────────────────────────
//
// #36 recurred on hokon three days running, and hokon is a guest — so the fix
// had to reach the one box the deployer refuses to touch. `--include-guests`
// (the spelling `guestGate` and `converge-toolchain` already use, not a new
// word) opens that door for ONE EXPLICITLY NAMED node and nothing else.
//
// The property these cases exist to hold is not "the flag works". It is that
// the flag CANNOT MAKE A GUEST REACHABLE BY ACCIDENT: every path where somebody
// did not type both `--machine <that guest>` and `--include-guests` must still
// refuse, with the same message and the same exit 2 as before the flag existed.
// The four cases above are the untouched half of that and stay exactly as they
// are; these are the other half.
//
// All of them run under `--check` against a temp manifest of `.invalid` nodes
// and reach no box, for the same reasons as the section above.

test('deployer: --include-guests without --machine REFUSES — it narrows, never widens', () => {
	// The dangerous shape, and the reason this is not just forwarded to
	// `guestGate`: that gate opens fleet-wide on this flag, which is right for a
	// command that reads and catastrophic for one that writes a hook, a conf and
	// three node-side scripts and then restarts listeners.
	const f = manifestFixture({
		'guest-one.invalid': GUEST_NODE,
		'guest-two.invalid': { ...GUEST_NODE },
		'claw-a.invalid': CLAW_NODE,
	});
	try {
		const r = deploy(['--check', '--include-guests'], f.env);
		assert.equal(r.code, 2, `a fleet-wide guest sweep must be refused, got ${r.code}: ${r.err}`);
		assert.match(r.err, /requires --machine/);
		assert.match(r.err, /nothing was contacted/i);
		// No guest may appear as a node this run acted on, under any reading.
		assert.doesNotMatch(r.out + r.err, /SUMMARY/, 'no node may be contacted on this path');
		assert.doesNotMatch(r.out, /guest-one\.invalid\s+\(/, 'a guest was selected for deploy');
		assert.doesNotMatch(r.out, /guest-two\.invalid\s+\(/, 'a guest was selected for deploy');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('deployer: --include-guests on a node that is NOT a guest REFUSES', () => {
	// An override typed for a guard that would not have fired means the operator
	// believes something false about this node. It also catches the typo case —
	// a name that is in no manifest is not a guest either — which would
	// otherwise fall through to "no nodes to deploy to" and read as a missing
	// node rather than a misunderstanding.
	const f = manifestFixture({ 'guest-host.invalid': GUEST_NODE, 'claw-a.invalid': CLAW_NODE });
	try {
		const r = deploy(['--check', '--machine', 'claw-a.invalid', '--include-guests'], f.env);
		assert.equal(r.code, 2, `expected a usage refusal, got ${r.code}: ${r.err}`);
		assert.match(r.err, /is not a guest/);
		assert.match(r.err, /nothing was contacted/i);
		assert.doesNotMatch(r.out + r.err, /SUMMARY/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('deployer: --machine <guest> --include-guests selects the guest, and says so loudly', () => {
	// The one path that opens. It is asserted on `--check` only — a --confirm
	// here would reach a real box, and `.invalid` plus a temp manifest is what
	// keeps every other case in this file safe.
	const f = manifestFixture({ 'guest-host.invalid': GUEST_NODE, 'claw-a.invalid': CLAW_NODE });
	try {
		const r = deploy(['--check', '--machine', 'guest-host.invalid', '--include-guests'], f.env);
		// It got past the refusal and tried to contact the node — which cannot
		// resolve, so the run fails. That failure IS the evidence: the previous
		// behaviour was exit 2 with nothing contacted.
		assert.notEqual(r.code, 2, `still refused by the role guard: ${r.err}`);
		assert.match(r.out, /guest-host\.invalid/, 'the guest must be selected for deploy');
		assert.doesNotMatch(
			r.out,
			/guest-host\.invalid\s+\[skipped: guest\]/,
			'the named guest must no longer be reported as skipped'
		);

		// LOUDLY. Every element the operator needs to read an overridden run
		// later: that it is a guest, the decision being overridden and its date,
		// and that this was explicit rather than a default.
		assert.match(r.err, /GUEST OVERRIDE/);
		assert.match(r.err, /2026-09-14/, 'the decision being overridden must be named');
		assert.match(r.err, /override of a deliberate decision/i);
		assert.match(r.err, /--include-guests/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('deployer: the SAME command line without --include-guests still refuses — the flag is what opens it', () => {
	// The A/B pair, on one fixture, differing by exactly one token. Everything
	// else in this section could pass while the flag was decorative and the
	// `--machine <guest>` above was doing the work — which is the one way this
	// change could make a guest reachable by accident. Asserted here rather than
	// left to the older `--machine <guest> REFUSES` case, because that one does
	// not know the flag exists and would not notice it becoming load-bearing in
	// the wrong direction.
	const f = manifestFixture({ 'guest-host.invalid': GUEST_NODE, 'claw-a.invalid': CLAW_NODE });
	try {
		const withFlag = deploy(
			['--check', '--json', '--machine', 'guest-host.invalid', '--include-guests'],
			f.env
		);
		assert.equal(json(withFlag).guestOverride, 'guest-host.invalid');

		const withoutFlag = deploy(['--check', '--json', '--machine', 'guest-host.invalid'], f.env);
		assert.equal(
			withoutFlag.code,
			2,
			`dropping the flag must restore the refusal: ${withoutFlag.err}`
		);
		assert.match(withoutFlag.err, /GUEST/);
		assert.equal(withoutFlag.out, '', 'a refused run emits no report at all');
		assert.doesNotMatch(withoutFlag.err, /GUEST OVERRIDE/, 'nothing was overridden');
		assert.doesNotMatch(withoutFlag.out + withoutFlag.err, /SUMMARY/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('deployer: the override is in --json too, as guestOverride, not only on stderr', () => {
	// `log()` is suppressed under --json, so the banner above cannot be the only
	// channel — the same argument `skippedGuests` was added for. A cron parsing
	// this must be able to tell an overridden run from an ordinary one.
	const f = manifestFixture({
		'guest-host.invalid': GUEST_NODE,
		'guest-other.invalid': { ...GUEST_NODE },
		'claw-a.invalid': CLAW_NODE,
	});
	try {
		const r = deploy(
			['--check', '--json', '--machine', 'guest-host.invalid', '--include-guests'],
			f.env
		);
		const report = json(r);
		assert.equal(report.guestOverride, 'guest-host.invalid');
		assert.deepEqual(
			report.results.map((x) => x.machine),
			['guest-host.invalid'],
			'the overridden guest is the only node --machine selected'
		);
		// The banner is on stderr precisely so --json cannot suppress it.
		assert.match(r.err, /GUEST OVERRIDE/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('deployer: an ordinary run still reports guestOverride: null', () => {
	// The other half of the field being load-bearing. If it were only ever
	// emitted on the overriding path, `report.guestOverride` would be undefined
	// on every normal run and a consumer could not tell "not overridden" from
	// "this deployer is too old to say".
	const f = manifestFixture({ 'guest-host.invalid': GUEST_NODE, 'claw-a.invalid': CLAW_NODE });
	try {
		const r = deploy(['--check', '--json'], f.env);
		const report = json(r);
		assert.equal(report.guestOverride, null);
		assert.deepEqual(report.skippedGuests, ['guest-host.invalid']);
		assert.doesNotMatch(r.err, /GUEST OVERRIDE/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('deployer: the override reaches ONLY the named guest — a second guest stays skipped', () => {
	// The blast radius, asserted rather than assumed. Two guests declared, one
	// named: the other must still be skipped by role and still be reported as
	// skipped, or the flag has quietly become the fleet-wide sweep the first
	// case in this section refuses.
	const f = manifestFixture({
		'guest-named.invalid': GUEST_NODE,
		'guest-bystander.invalid': { ...GUEST_NODE },
		'claw-a.invalid': CLAW_NODE,
	});
	try {
		const r = deploy(
			['--check', '--json', '--machine', 'guest-named.invalid', '--include-guests'],
			f.env
		);
		const report = json(r);
		assert.equal(report.guestOverride, 'guest-named.invalid');
		assert.deepEqual(
			report.results.map((x) => x.machine),
			['guest-named.invalid'],
			'no node but the named guest may be acted on'
		);
		// The bystander is filtered out by --machine before the role gate ever
		// sees it, so it is not in `skippedGuests` either — what matters is that
		// nothing reached it.
		assert.doesNotMatch(r.out, /guest-bystander/, 'a guest nobody named must not be touched');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('deployer: the skip reads the ROLE, not the capacity numbers or the name', () => {
	// Two nodes identical to the guest in every field EXCEPT role — one claw, one
	// guest. If the skip were ever re-derived from maxConcurrent/minFreeMb, or
	// from a hardcoded hostname, this pair becomes indistinguishable and the
	// assertion below fails.
	const f = manifestFixture({
		'twin-guest.invalid': { ...GUEST_NODE },
		'twin-claw.invalid': { ...GUEST_NODE, role: 'claw' },
	});
	try {
		const r = deploy(['--check', '--json'], f.env);
		const report = json(r);
		assert.deepEqual(report.skippedGuests, ['twin-guest.invalid']);
		assert.deepEqual(
			report.results.map((x) => x.machine),
			['twin-claw.invalid'],
			'identical capacity, different role — only the role may decide'
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// --- wave 4b #100/#101: the job-start /tmp prune ---------------------------
//
// Exercises maybe_prune_tmp() through the real admission path (not a copy of
// its arithmetic). CI_THROTTLE_PRUNE_ROOT points every spawn at a fixture
// directory (see nodeFixture/requirePruneRoot above), so these cases never
// touch the real host's /tmp. A stub `df` on PATH (stubDf) drives the
// threshold arithmetic deterministically.
const PRUNE_SCRATCH = mkdtempSync(join(tmpdir(), `${FIXTURE_PREFIX}prune-scratch-`));
after(() => rmSync(PRUNE_SCRATCH, { recursive: true, force: true }));
const EPHEMERAL_TS_SRC = readFileSync(
	join(SCRIPTS, '..', 'src', 'runners', 'ephemeral.ts'),
	'utf8'
);
const TMP_FREE_FLOOR_MB_MATCH = EPHEMERAL_TS_SRC.match(/TMP_FREE_FLOOR_MB\s*=\s*(\d+)/);

/** Make every file inside `dir` (recursively, dir included) look `minutesAgo` old. */
function ageAll(dir, minutesAgo) {
	const t = new Date(Date.now() - minutesAgo * 60_000);
	const walk = (p) => {
		utimesSync(p, t, t);
		for (const entry of readdirSync(p, { withFileTypes: true })) {
			const full = join(p, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) walk(full);
			else utimesSync(full, t, t);
		}
	};
	walk(dir);
}

function withPruneDf(fx, dfOpts) {
	const bin = stubDf(PRUNE_SCRATCH, dfOpts);
	fx.env.PATH = `${bin}:${fx.env.PATH || process.env.PATH}`;
}

test('below both thresholds: nothing removed, log says why', () => {
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242'; // a real job, so the df-threshold path is reached
	withPruneDf(fx, { totalMb: 8000, usedMb: 1000, availMb: 7000 }); // 12.5%, 7000MB free
	mkdirSync(join(fx.pruneRoot, 'game-bundle-old'), { recursive: true });
	ageAll(join(fx.pruneRoot, 'game-bundle-old'), 120);
	const r = runHook(fx);
	assert.equal(r.code, 0);
	assert.equal(
		existsSync(join(fx.pruneRoot, 'game-bundle-old')),
		true,
		'below threshold: nothing touched'
	);
	const log = readFileSync(join(fx.home, '.hadoku', 'throttle', 'prune.log'), 'utf8');
	assert.match(log, /below both, nothing to do/);
});

test('above the free-MB threshold: stale candidates of every pattern removed; fresh, exempt and unlisted survive', () => {
	// This is also wave 4b's "above-threshold fixture WITH GITHUB_RUN_ID set →
	// candidates removed" case: a real job id is required below for the prune
	// to run at all now that it is gated on one.
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 }); // under 3072MB free
	const root = fx.pruneRoot;
	for (const name of [
		'game-bundle-x',
		'vault-resp.1',
		'cardtable-e2e-web-y',
		'playwright-transform-cache-z',
	]) {
		mkdirSync(join(root, name, 'inner'), { recursive: true });
		writeFileSync(join(root, name, 'inner', 'f'), 'x');
		ageAll(join(root, name), 120);
	}
	// A candidate with ONE fresh file deep inside must be kept.
	mkdirSync(join(root, 'game-bundle-fresh-inside', 'deep'), { recursive: true });
	writeFileSync(join(root, 'game-bundle-fresh-inside', 'deep', 'f'), 'x');
	ageAll(join(root, 'game-bundle-fresh-inside'), 120);
	writeFileSync(join(root, 'game-bundle-fresh-inside', 'deep', 'newer'), 'x'); // now, fresh
	// node-compile-cache and an unlisted old dir must never be touched.
	mkdirSync(join(root, 'node-compile-cache'), { recursive: true });
	ageAll(join(root, 'node-compile-cache'), 120);
	mkdirSync(join(root, 'totally-unlisted-old'), { recursive: true });
	ageAll(join(root, 'totally-unlisted-old'), 120);
	// pytest-of-*/pytest-<N>: old N removed, pytest-current's target kept
	// however old, even though it is itself old.
	mkdirSync(join(root, 'pytest-of-ci', 'pytest-1'), { recursive: true });
	mkdirSync(join(root, 'pytest-of-ci', 'pytest-2'), { recursive: true });
	ageAll(join(root, 'pytest-of-ci'), 120);
	symlinkSync(join(root, 'pytest-of-ci', 'pytest-2'), join(root, 'pytest-of-ci', 'pytest-current'));
	// A symlink candidate pointing OUTSIDE the root: its target must survive.
	const outsideTarget = mkdtempSync(join(PRUNE_SCRATCH, 'outside-target-'));
	writeFileSync(join(outsideTarget, 'keepme'), 'x');
	ageAll(outsideTarget, 120);
	symlinkSync(outsideTarget, join(root, 'vault-resp.outside'));

	const r = runHook(fx);
	assert.equal(r.code, 0);
	assert.equal(existsSync(join(root, 'game-bundle-x')), false, 'stale game-bundle removed');
	assert.equal(existsSync(join(root, 'vault-resp.1')), false, 'stale vault-resp removed');
	assert.equal(existsSync(join(root, 'cardtable-e2e-web-y')), false, 'stale cardtable removed');
	assert.equal(
		existsSync(join(root, 'playwright-transform-cache-z')),
		false,
		'stale playwright cache removed'
	);
	assert.equal(
		existsSync(join(root, 'game-bundle-fresh-inside')),
		true,
		'one fresh file deep inside keeps the whole candidate'
	);
	assert.equal(
		existsSync(join(root, 'node-compile-cache')),
		true,
		'node-compile-cache is never a candidate'
	);
	assert.equal(
		existsSync(join(root, 'totally-unlisted-old')),
		true,
		'unlisted dirs are never touched'
	);
	assert.equal(existsSync(join(root, 'pytest-of-ci', 'pytest-1')), false, 'old pytest-N removed');
	assert.equal(
		existsSync(join(root, 'pytest-of-ci', 'pytest-2')),
		true,
		"pytest-current's target kept however old"
	);
	assert.equal(
		existsSync(join(outsideTarget, 'keepme')),
		true,
		'symlink pointing outside root: target survives'
	);
});

test('above threshold but NO GITHUB_RUN_ID: this is not a real job, nothing removed, reason logged', () => {
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 }); // well under the free-MB floor
	const root = fx.pruneRoot;
	for (const name of [
		'game-bundle-x',
		'vault-resp.1',
		'cardtable-e2e-web-y',
		'playwright-transform-cache-z',
	]) {
		mkdirSync(join(root, name), { recursive: true });
		ageAll(join(root, name), 120);
	}
	const r = runHook(fx);
	assert.equal(r.code, 0, 'a non-job invocation must never fail');
	for (const name of [
		'game-bundle-x',
		'vault-resp.1',
		'cardtable-e2e-web-y',
		'playwright-transform-cache-z',
	]) {
		assert.equal(existsSync(join(root, name)), true, `${name} must survive without GITHUB_RUN_ID`);
	}
	const log = readFileSync(join(fx.home, '.hadoku', 'throttle', 'prune.log'), 'utf8');
	assert.match(log, /skipped: no GITHUB_RUN_ID/);
});

test('GITHUB_RUN_ID set to the empty string is treated as absent: nothing removed', () => {
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '';
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 });
	mkdirSync(join(fx.pruneRoot, 'game-bundle-old'), { recursive: true });
	ageAll(join(fx.pruneRoot, 'game-bundle-old'), 120);
	const r = runHook(fx);
	assert.equal(r.code, 0);
	assert.equal(
		existsSync(join(fx.pruneRoot, 'game-bundle-old')),
		true,
		'empty GITHUB_RUN_ID must not count as present'
	);
	const log = readFileSync(join(fx.home, '.hadoku', 'throttle', 'prune.log'), 'utf8');
	assert.match(log, /skipped: no GITHUB_RUN_ID/);
});

test('a pytest-of-* directly under root that is ITSELF a symlink out: the inner glob must not escape through it', () => {
	// The gap the direct-symlink case above does not cover: `pytest-of-evil`
	// sits right under the prune root but IS a symlink to a directory outside
	// it. The outer `for base in "$root_real"/pytest-of-*` picks it up, and the
	// inner `for d in "$base"/pytest-*` walks THROUGH the link into the
	// outside tree — the `case "$real" in "$root_real"/*)` guard on `$d` is the
	// only thing standing between that walk and `rm -rf` on a real directory
	// this fixture does not own.
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 });
	const root = fx.pruneRoot;
	const outsideBase = mkdtempSync(join(PRUNE_SCRATCH, 'outside-pytest-'));
	mkdirSync(join(outsideBase, 'pytest-3', 'deep'), { recursive: true });
	writeFileSync(join(outsideBase, 'pytest-3', 'deep', 'f'), 'x');
	ageAll(outsideBase, 180);
	symlinkSync(outsideBase, join(root, 'pytest-of-evil'));

	const r = runHook(fx);
	assert.equal(r.code, 0);
	assert.equal(
		existsSync(join(outsideBase, 'pytest-3')),
		true,
		'the real outside pytest-3 directory must survive'
	);
	assert.equal(
		existsSync(join(outsideBase, 'pytest-3', 'deep', 'f')),
		true,
		'the file inside the real outside pytest-3 must survive'
	);
});

test('the PRUNE_BOUND_S deadline, not the per-call timeout, cuts a slow sweep short', () => {
	// Every per-call `timeout 5` on its own would let 8 candidates each
	// costing ~2s run to completion (~16s). Only the deadline check at the top
	// of the loop can stop it early, so a stub `find` that is merely SLOW
	// (not stuck) isolates the deadline's own arithmetic from the per-call cap
	// proven by the stuck-find case above.
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 });
	for (let i = 0; i < 8; i++) {
		mkdirSync(join(fx.pruneRoot, `game-bundle-${i}`), { recursive: true });
		ageAll(join(fx.pruneRoot, `game-bundle-${i}`), 120);
	}
	const slowBin = mkdtempSync(join(PRUNE_SCRATCH, 'slow-find-2s-'));
	writeFileSync(join(slowBin, 'find'), '#!/bin/sh\nsleep 2\n', { mode: 0o755 });
	fx.env.PATH = `${slowBin}:${fx.env.PATH}`;
	fx.env.PRUNE_BOUND_S = '3';
	const r = runHook(fx);
	assert.equal(r.code, 0, 'the deadline must never fail the job');
	assert.ok(
		r.elapsedMs < 12_000,
		`hook took ${r.elapsedMs}ms, expected the deadline to cut an unbounded (>=16s) sweep well short`
	);
	const remaining = Array.from({ length: 8 }, (_, i) =>
		existsSync(join(fx.pruneRoot, `game-bundle-${i}`))
	);
	assert.ok(
		remaining.some((exists) => exists),
		'the deadline must stop the loop before the end — at least one candidate left untouched'
	);
	assert.ok(
		remaining.some((exists) => !exists),
		'the prune must have actually run — at least one candidate removed'
	);
});

test('tripwire: a canary in a second fixture root is never touched by a prune of the first', () => {
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 });
	const secondRoot = mkdtempSync(join(PRUNE_SCRATCH, 'second-root-'));
	const canary = join(secondRoot, 'game-bundle-canary');
	mkdirSync(canary, { recursive: true });
	ageAll(canary, 120);
	const r = runHook(fx);
	assert.equal(r.code, 0);
	assert.equal(existsSync(canary), true, 'a second root is never reached by this prune');
});

test('unreadable df: nothing removed, logged, never fails the job', () => {
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { fail: true });
	mkdirSync(join(fx.pruneRoot, 'game-bundle-old'), { recursive: true });
	ageAll(join(fx.pruneRoot, 'game-bundle-old'), 120);
	const r = runHook(fx);
	assert.equal(r.code, 0);
	assert.equal(existsSync(join(fx.pruneRoot, 'game-bundle-old')), true);
	const log = readFileSync(join(fx.home, '.hadoku', 'throttle', 'prune.log'), 'utf8');
	assert.match(log, /could not read usage/);
});

test('df exits 0 but prints only the header line: hook still exits 0, prune.log says it could not read usage', () => {
	// A real `df` CAN do this (a transient mount race, a weird filesystem
	// driver). `set -- $(awk 'NR==2{...}')` then leaves $1/$2/$3 unset, and
	// under `set -u` an unguarded `total=$1` would abort the WHOLE hook with
	// "unbound variable" — a non-zero exit, which fails the job
	// (actions/runner ADR 1751). Proven by mutation below: removing the
	// `${1:-}` defaults (and the `(...) || true` isolation) together turns
	// this red.
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { headerOnly: true });
	mkdirSync(join(fx.pruneRoot, 'game-bundle-old'), { recursive: true });
	ageAll(join(fx.pruneRoot, 'game-bundle-old'), 120);
	const r = runHook(fx);
	assert.equal(r.code, 0, `header-only df must not fail the hook: ${r.out}`);
	assert.equal(existsSync(join(fx.pruneRoot, 'game-bundle-old')), true);
	const log = readFileSync(join(fx.home, '.hadoku', 'throttle', 'prune.log'), 'utf8');
	assert.match(log, /could not read usage/);
});

test('the prune is bounded even with a stuck find/rm, and still exits 0', () => {
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 });
	for (let i = 0; i < 3; i++) {
		mkdirSync(join(fx.pruneRoot, `game-bundle-${i}`), { recursive: true });
		ageAll(join(fx.pruneRoot, `game-bundle-${i}`), 120);
	}
	// A slow `find` ahead on PATH: each per-candidate `timeout 5 find …` absorbs
	// it, so the outer PRUNE_BOUND_S itself is proven by the overall elapsed
	// time staying within bound + a small margin even though every freshness
	// check is individually slow.
	const slowBin = mkdtempSync(join(PRUNE_SCRATCH, 'slow-find-'));
	writeFileSync(join(slowBin, 'find'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
	fx.env.PATH = `${slowBin}:${fx.env.PATH}`;
	fx.env.PRUNE_BOUND_S = '3';
	const r = runHook(fx);
	assert.equal(r.code, 0, 'a stuck prune step must never fail the job');
	assert.ok(
		r.elapsedMs < 20_000,
		`hook took ${r.elapsedMs}ms, expected to return well under the per-step timeout cap`
	);
});

test('a failing rm never fails the job', () => {
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 });
	mkdirSync(join(fx.pruneRoot, 'game-bundle-old'), { recursive: true });
	ageAll(join(fx.pruneRoot, 'game-bundle-old'), 120);
	const badRmBin = mkdtempSync(join(PRUNE_SCRATCH, 'bad-rm-'));
	writeFileSync(join(badRmBin, 'rm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
	fx.env.PATH = `${badRmBin}:${fx.env.PATH}`;
	const r = runHook(fx);
	assert.equal(r.code, 0, 'a failing rm must never fail the job');
});

test('PRUNE_FREE_MB default is strictly greater than TMP_FREE_FLOOR_MB', (t) => {
	if (!TMP_FREE_FLOOR_MB_MATCH) {
		t.skip('TMP_FREE_FLOOR_MB not found in src/runners/ephemeral.ts — lands in a sibling lane');
		return;
	}
	const floor = Number(TMP_FREE_FLOOR_MB_MATCH[1]);
	const src = readFileSync(HOOK, 'utf8');
	const m = src.match(/PRUNE_FREE_MB="\$\{PRUNE_FREE_MB:-(\d+)\}"/);
	assert.ok(m, 'PRUNE_FREE_MB default not found in ci-throttle.sh');
	assert.ok(
		Number(m[1]) > floor,
		`PRUNE_FREE_MB default (${m[1]}) must be > TMP_FREE_FLOOR_MB (${floor})`
	);
});

test('static: no /tmp literal in non-comment lines of the prune block, other than the one default', () => {
	const src = readFileSync(HOOK, 'utf8').split('\n');
	const startIdx = src.findIndex((l) =>
		l.includes('wave 4b #100/#101: a cheap, bounded /tmp prune')
	);
	const endIdx = src.findIndex(
		(l, i) => i > startIdx && l.trim() === '}' && src[i - 1]?.includes('return 0')
	);
	assert.ok(
		startIdx >= 0 && endIdx > startIdx,
		'could not locate the prune block in ci-throttle.sh'
	);
	const block = src.slice(startIdx, endIdx + 1);
	const literalLines = block.filter((l) => !l.trim().startsWith('#') && l.includes('/tmp'));
	assert.equal(
		literalLines.length,
		1,
		`expected exactly one /tmp literal, found: ${literalLines.join(' | ')}`
	);
	assert.match(
		literalLines[0],
		/CI_THROTTLE_PRUNE_ROOT:-\/tmp/,
		'the one literal must be the PRUNE_ROOT default'
	);
});

// ── wave 4b, lane C: the one door ───────────────────────────────────────────

test('static: every spawn of the hook passes through hookEnv() — no bypass', () => {
	// Reads THIS file's own source and counts, on code lines only (blank
	// comment-only lines first, so prose mentioning `[HOOK]` or `hookEnv(` —
	// including this test's own strings — cannot move either count):
	// (a) lines that spawn a child process with `[HOOK]` as the script
	// argument, i.e. an actual spawn SITE; (b) lines of the literal shape
	// `env: hookEnv(` — the one way this file passes an env into a spawn
	// options object through the door. A new spawn added later that builds
	// its env inline (`env: {...}` or `env: fx.env`) instead of going through
	// the door raises (a) without raising (b), and this goes red.
	const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
	const codeLines = self.split('\n').filter((l) => !/^\s*\*/.test(l) && !/^\s*\/\//.test(l));
	const spawnMarker = 'spawn';
	const doorMarker = ['env', ':', ' hookE', 'nv('].join('');
	const spawnSites = codeLines.filter(
		(l) => l.includes(spawnMarker) && /\(/.test(l) && /\bHOOK\b/.test(l)
	).length;
	const doorCalls = codeLines.filter((l) => l.includes(doorMarker)).length;
	assert.equal(
		spawnSites,
		doorCalls,
		`found ${spawnSites} hook-spawning line(s) but ${doorCalls} door call(s) — a spawn is bypassing hookEnv()`
	);
	assert.equal(
		spawnSites,
		5,
		'expected exactly the 5 known spawn sites (update this if one is added deliberately, through the door)'
	);
});

test('REAL-ROOT TRIPWIRE: the suite must never prune the real host /tmp', () => {
	// A canary under the REAL os.tmpdir(), aged 3h so it would be a candidate
	// if maybe_prune_tmp ever saw it, run through both the oldest spawn
	// helper (`run()`, the one that leaked) and the fixture-based path
	// (`nodeFixture`/`runHook`). If hookEnv() is ever bypassed or its root
	// check weakened, this is the test that goes red — and the only thing
	// the leak could have eaten here is this tripwire plus genuine debris.
	const tripwire = join(tmpdir(), `game-bundle-${Math.random().toString(36).slice(2)}-tripwire`);
	mkdirSync(tripwire, { recursive: true });
	const marker = join(tripwire, 'canary.txt');
	writeFileSync(marker, 'tripwire');
	const threeHoursAgo = (Date.now() - 3 * 60 * 60 * 1000) / 1000;
	utimesSync(tripwire, threeHoursAgo, threeHoursAgo);
	utimesSync(marker, threeHoursAgo, threeHoursAgo);
	try {
		const r1 = run({ conf: { MAX_CONCURRENT: 3, MIN_FREE_MB: 0, MAX_WAIT_S: 5 }, others: 1 });
		assert.equal(r1.code, 0);
		assert.ok(existsSync(tripwire), 'run(): real host /tmp tripwire must survive');

		const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 5 });
		const r2 = runHook(fx);
		assert.equal(r2.code, 0);
		assert.ok(existsSync(tripwire), 'runHook()/nodeFixture: real host /tmp tripwire must survive');

		// Same again, but with the prune actually ARMED — a real GITHUB_RUN_ID
		// and an above-threshold fixture df — so the tripwire also proves the
		// real root stays untouched once the gate this wave added lets the
		// prune run at all.
		const fx2 = nodeFixture({ maxConcurrent: 3, maxWaitS: 5 });
		fx2.env.GITHUB_RUN_ID = '424242';
		withPruneDf(fx2, { totalMb: 8000, usedMb: 5000, availMb: 2000 });
		const r3 = runHook(fx2);
		assert.equal(r3.code, 0);
		assert.ok(
			existsSync(tripwire),
			'runHook()/nodeFixture with GITHUB_RUN_ID set and the prune armed: real host /tmp tripwire must survive'
		);
	} finally {
		rmSync(tripwire, { recursive: true, force: true });
	}
});

test('pin: the hook and the cleaner share the same stale-debris pattern list', () => {
	const hookSrc = readFileSync(HOOK, 'utf8');
	const hookMatch = hookSrc.match(/^PRUNE_PATTERNS='([^']*)'/m);
	assert.ok(hookMatch, 'PRUNE_PATTERNS not found in ci-throttle.sh');
	const hookPatterns = hookMatch[1].trim().split(/\s+/).sort();

	const cleanerPath = join(SCRIPTS, 'clean-runner-debris.sh');
	const cleanerSrc = readFileSync(cleanerPath, 'utf8');
	const cleanerPatterns = [...cleanerSrc.matchAll(/sweep_glob\s+"\$TMP_ROOT"\s+'([^']*)'/g)]
		.map((m) => m[1])
		.sort();

	assert.deepEqual(
		hookPatterns,
		cleanerPatterns,
		`ci-throttle.sh PRUNE_PATTERNS ${JSON.stringify(hookPatterns)} must equal clean-runner-debris.sh's sweep_glob patterns ${JSON.stringify(cleanerPatterns)}`
	);
});

// ── wave 4c #102 lane C: host-load snapshot printed at job start ──────────
//
// ci-throttle.sh prints one line into the job log at admission: 1-minute
// load average, CPU pressure (avg10), and how many OTHER Runner.Worker
// processes are on the node, with their repos. Unattributable slow reds are
// the reason (wave4c-2026-10-07.md): nothing in a job's own log says what
// else the host was doing when it ran.
//
// `CI_THROTTLE_PROC_ROOT` is the test seam for a co-tenant's `/proc/<pid>/cwd`
// — a fixture pid is a directory of symlinks, never a live process. The
// `pgrep` on PATH is a fixture binary (the same pattern `stubDf` above uses
// for `df`), and it echoes `$SELF_PID`, the hook's own exported variable,
// rather than a predicted kernel pid — the hook exports it for exactly this
// (see the script's own comment beside `export SELF_PID`).

/** A fixture `/proc` entry whose `cwd` resolves under `_work/<repo>/<repo>`. */
function procCotenant(root, pid, repo) {
	const target = join(root, 'fake-cwd', repo, '_work', repo, repo);
	mkdirSync(target, { recursive: true });
	mkdirSync(join(root, String(pid)), { recursive: true });
	symlinkSync(target, join(root, String(pid), 'cwd'));
}

/** A fake `pgrep` on its own PATH entry, echoing exactly the given pids (plus
 * `$SELF_PID` unless told not to) — never the real process table. */
function stubPgrep(scratchDir, pids, { includeSelf = true } = {}) {
	const bin = mkdtempSync(join(scratchDir, 'pgrep-stub-'));
	const echoes = [...(includeSelf ? ['"$SELF_PID"'] : []), ...pids.map((p) => `"${p}"`)];
	writeFileSync(join(bin, 'pgrep'), `#!/bin/sh\n${echoes.map((e) => `echo ${e}`).join('\n')}\n`, {
		mode: 0o755,
	});
	return bin;
}

test('host load: the start line carries all four values against a fixture /proc', () => {
	const dir = tempDir(`${FIXTURE_PREFIX}hostload-`);
	try {
		const loadavg = join(dir, 'loadavg');
		writeFileSync(loadavg, '2.50 1.30 0.80 3/120 12345\n');
		const pressure = join(dir, 'pressure-cpu');
		writeFileSync(
			pressure,
			'some avg10=4.20 avg60=3.10 avg300=1.00 total=123456\n' +
				'full avg10=0.50 avg60=0.20 avg300=0.10 total=9999\n'
		);
		const procRoot = join(dir, 'proc');
		mkdirSync(procRoot, { recursive: true });
		procCotenant(procRoot, 9501, 'cardtable');
		procCotenant(procRoot, 9502, 'hadoku_site');
		const pgrepBin = stubPgrep(dir, [9501, 9502]);

		const r = run({
			conf: { MAX_CONCURRENT: 3, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
			others: 0,
			env: {
				CI_THROTTLE_LOADAVG: loadavg,
				CI_THROTTLE_PRESSURE_CPU: pressure,
				CI_THROTTLE_PROC_ROOT: procRoot,
				PATH: `${pgrepBin}:${process.env.PATH}`,
			},
		});
		assert.equal(r.code, 0);
		assert.match(
			r.out + r.err,
			/host load: 1m=2\.50 cpu_pressure_avg10=4\.20 co-tenants=2 repos=/,
			`${r.out}${r.err}`
		);
		assert.match(
			r.out + r.err,
			/repos=(cardtable,hadoku_site|hadoku_site,cardtable)\b/,
			`${r.out}${r.err}`
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('host load: an unreadable /proc/pressure/cpu reads "unreadable" and exits 0', () => {
	const r = run({
		conf: { MAX_CONCURRENT: 3, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 0,
		env: { CI_THROTTLE_PRESSURE_CPU: '/does/not/exist/pressure-cpu' },
	});
	assert.equal(r.code, 0, 'an unreadable PSI file must never fail the job (ADR 1751)');
	assert.match(r.out + r.err, /cpu_pressure_avg10=unreadable/);
});

test('host load: an unreadable /proc/loadavg reads "unreadable", not a guessed 0', () => {
	const r = run({
		conf: { MAX_CONCURRENT: 3, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 0,
		env: { CI_THROTTLE_LOADAVG: '/does/not/exist/loadavg' },
	});
	assert.equal(r.code, 0);
	assert.match(r.out + r.err, /1m=unreadable/);
});

test('host load: co-tenants are counted EXCLUDING the job itself', () => {
	const dir = tempDir(`${FIXTURE_PREFIX}hostload-self-`);
	try {
		const procRoot = join(dir, 'proc');
		mkdirSync(procRoot, { recursive: true });
		procCotenant(procRoot, 9601, 'cardtable');
		procCotenant(procRoot, 9602, 'cardtable');
		// Echoes $SELF_PID (the real value THIS run computed) alongside the two
		// fixture co-tenants. If self-exclusion regressed, the count would read
		// 3 and this hook's own cwd would leak in as a third "repo".
		const pgrepBin = stubPgrep(dir, [9601, 9602]);

		const r = run({
			conf: { MAX_CONCURRENT: 5, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
			others: 0,
			env: {
				CI_THROTTLE_PROC_ROOT: procRoot,
				PATH: `${pgrepBin}:${process.env.PATH}`,
			},
		});
		assert.equal(r.code, 0);
		assert.match(
			r.out + r.err,
			/co-tenants=2\b/,
			`expected exactly 2 (self excluded): ${r.out}${r.err}`
		);
		assert.doesNotMatch(r.out + r.err, /co-tenants=3/, 'self must not be counted as a co-tenant');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('host load: zero co-tenants reads as "repos=none", not an empty string', () => {
	const dir = tempDir(`${FIXTURE_PREFIX}hostload-zero-`);
	try {
		const pgrepBin = stubPgrep(dir, [], { includeSelf: false });
		const r = run({
			conf: { MAX_CONCURRENT: 3, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
			others: 0,
			env: { PATH: `${pgrepBin}:${process.env.PATH}` },
		});
		assert.equal(r.code, 0);
		assert.match(r.out + r.err, /co-tenants=0 repos=none/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('host load: no pgrep on PATH at all reads "unreadable", not zero', () => {
	const dir = tempDir(`${FIXTURE_PREFIX}hostload-nopgrep-`);
	try {
		// A PATH with nothing named pgrep on it — coreutils/bash essentials only.
		// A genuinely missing pgrep must read as "could not look", never as a
		// confident zero co-tenants.
		const bin = mkdtempSync(join(dir, 'minimal-bin-'));
		for (const tool of [
			'bash',
			'sh',
			'awk',
			'sed',
			'cat',
			'cut',
			'head',
			'date',
			'df',
			'mkdir',
			'rm',
			'tr',
			'readlink',
			'timeout',
			'find',
			'basename',
		]) {
			const real = join('/usr/bin', tool);
			if (existsSync(real)) symlinkSync(real, join(bin, tool));
		}
		const r = run({
			conf: { MAX_CONCURRENT: 3, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
			others: 0,
			env: { PATH: bin },
		});
		assert.equal(r.code, 0);
		assert.match(r.out + r.err, /co-tenants=unreadable repos=unreadable/, `${r.out}${r.err}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- THE LEAK GATE (#129). Registered LAST, so it runs after every other
// `after` in this file (the df stub's and PRUNE_SCRATCH's) and after the final
// afterEach cleanup. A fixture any case forgets to remove fails the suite here
// instead of accumulating in a RAM-backed /tmp.

test('static: every temp dir this suite creates under tmpdir() carries FIXTURE_PREFIX', () => {
	// Built, not written, so this case's own lines are not creation sites.
	const sites = ['tempDir' + '(', 'mkdtempSync(join(' + 'tmpdir()'];
	const creations = readFileSync(fileURLToPath(import.meta.url), 'utf8')
		.split('\n')
		.filter((l) => !/^\s*(\*|\/\/)/.test(l) && sites.some((s) => l.includes(s)));
	assert.ok(
		creations.length >= 10,
		`expected the suite's creation sites, found ${creations.length}`
	);
	assert.deepEqual(
		creations.filter((l) => !l.includes('${FIXTURE_PREFIX}')),
		[],
		'a temp dir without FIXTURE_PREFIX is invisible to the leak gate below'
	);
});

after(() => {
	const left = readdirSync(tmpdir()).filter((n) => n.startsWith(FIXTURE_PREFIX));
	for (const n of left) rmSync(join(tmpdir(), n), { recursive: true, force: true });
	assert.deepEqual(
		left,
		[],
		`ci-throttle.test.mjs left ${left.length} fixture dir(s) in ${tmpdir()} (removed now, but ` +
			'a case is missing its cleanup — on the claws /tmp is RAM)'
	);
});
