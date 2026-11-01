/**
 * Shared fixture for ci-throttle.test.mjs's split (wave 5p lane C, 3,252 ->
 * 1,993 lines moved into eight files of under 1,000): the one-door spawn
 * helper (`hookEnv`/`run`), the node-ancestry fixture (`nodeFixture` and its
 * worker spawners), and the two file-wide hooks every split file installs
 * at its top (`installCiThrottleRig`) and at its bottom
 * (`installLeakGate`) — see each for why the split matters to its ordering.
 *
 * `stubDf`, `reserveFixture`/`capFixture`, `manifestFixture`/`deploy`/`json`,
 * and `procCotenant`/`stubPgrep` are NOT here: each is read by exactly one
 * concern (prune, reserve-cap, deployer, host-load respectively), so it
 * stays beside the tests that use it rather than crossing into a shared
 * module nothing else reads.
 *
 * node:test scopes `afterEach`/`after` PER FILE, and (per wave 5o lane B)
 * applies a hook wherever it is declared even when that is inside an
 * imported module's exported function — which is what makes
 * `installCiThrottleRig()` work the same way `installPlacementRig()` does
 * for the TypeScript half.
 */
import { after, afterEach } from 'node:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	writeFileSync,
	rmSync,
} from 'node:fs';
import { join, dirname, resolve, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { spawnCapture } from './spawn-json.mjs';
import { tempDir, cleanupTempDirs } from './test-tmpdir.mjs';

/**
 * Every directory the ci-throttle family creates under os.tmpdir() starts
 * with this, and `installLeakGate()` fails the file that installs it if any
 * of ITS OWN survive (#129). The pid is what makes that check this
 * process's alone: other sessions run this suite concurrently against the
 * same /tmp, so a bare `ci-throttle-*` count would flake, and (since wave
 * 5p) each split file is its own `node --test` child process with its own
 * pid, so each gets its own prefix and checks only its own leaks. On the
 * claws and hokon /tmp is RAM, and this suite once left ~950 MB there; each
 * nodeFixture() holds a 1.3 MB copy of bash.
 */
export const FIXTURE_PREFIX = `ci-throttle-${process.pid}-`;

/** scripts/lib -> scripts, regardless of which file under scripts/ imports this. */
export const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
export const HOOK = join(SCRIPTS, 'ci-throttle.sh');

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
export function ambient() {
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
export function hookEnv(env) {
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
export function run({
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
export function swingMeminfo(meminfo, { fromMb, toMb, stepMb = 500, settleAfterS, settledMb }) {
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
export function nodeFixture({ maxConcurrent, maxWaitS, minFreeMb = 0, memAvailableMb = 999_999 }) {
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
 * A job, as the runner seats one: a `Runner.Worker` that runs the hook and then
 * STAYS ALIVE for `lingerS` seconds, the way a real worker goes on to run the
 * job it was just admitted for.
 */
export function spawnJob(fx, lingerS) {
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
export function spawnIdler(fx, seconds) {
	// `; :` defeats bash's exec optimisation, which would replace the process
	// image and with it the `Runner.Worker` comm this fixture depends on.
	const child = spawn(fx.worker, ['-c', `sleep ${seconds}; :`], { stdio: 'ignore' });
	child.done = new Promise((resolve) => child.on('close', resolve));
	return child;
}

/** Run the hook directly (no worker ancestry), returning its exit code. */
export function runHook(fx) {
	const started = Date.now();
	const r = spawnSync('bash', [HOOK], { encoding: 'utf8', env: hookEnv(fx.env), timeout: 60_000 });
	return {
		code: r.status ?? 1,
		out: (r.stdout ?? '') + (r.stderr ?? ''),
		elapsedMs: Date.now() - started,
	};
}

/** Wait until `pid` is gone from /proc, so "dead" means dead and not a zombie. */
export async function reaped(child) {
	await child.done;
	for (let i = 0; i < 100 && existsSync(`/proc/${child.pid}`); i++) {
		await new Promise((r) => setTimeout(r, 20));
	}
}

/**
 * Every split file calls this once, at its own top, exactly where the
 * original single file's inline `afterEach(cleanupTempDirs)` and
 * `defaultDfDir`'s own `after()` used to sit.
 *
 * Per-test fixtures (nodeFixture alone copies a 1.3 MB Runner.Worker) come
 * from tempDir() and are removed after every test, pass or fail. A file
 * with its own additional whole-file scratch dir (ci-throttle-prune's
 * PRUNE_SCRATCH) registers that dir's own `after()` separately and must
 * still call `installLeakGate()` (below) AFTER it, so the leak gate runs
 * last and never counts a scratch dir its own file is about to remove.
 */
export function installCiThrottleRig() {
	afterEach(cleanupTempDirs);
	after(() => {
		if (_defaultDfDir) rmSync(_defaultDfDir, { recursive: true, force: true });
	});
}

/**
 * THE LEAK GATE (#129), per split file. Call this LAST in every file — after
 * any file-specific whole-file scratch cleanup (e.g. PRUNE_SCRATCH's own
 * `after()`) — so a dir that file is about to remove itself is already gone
 * by the time this looks, the same ordering the original single file's
 * comment ("registered LAST, so it runs after every other after in this
 * file") relied on. Each split file is its own `node --test` child process
 * (its own pid, its own FIXTURE_PREFIX), so each one's gate only ever sees
 * leaks from its OWN tests — correct, since nothing else could have made
 * them.
 */
export function installLeakGate() {
	after(() => {
		const left = readdirSync(tmpdir()).filter((n) => n.startsWith(FIXTURE_PREFIX));
		for (const n of left) rmSync(join(tmpdir(), n), { recursive: true, force: true });
		assert.deepEqual(
			left,
			[],
			`a ci-throttle test file left ${left.length} fixture dir(s) in ${tmpdir()} (removed now, ` +
				'but a case is missing its cleanup — on the claws /tmp is RAM)'
		);
	});
}
