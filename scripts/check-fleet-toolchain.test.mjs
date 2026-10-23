/**
 * `fleet toolchain` — the DOCTOR half of issue #69.
 *
 * Reads the same REPAIRS declaration the cadence and bootcamp read, and fails a
 * node that lacks a tool, cannot reach it from a NON-LOGIN shell, or trails the
 * release that cleared the debounce by more than TOLERANCE_MINUTES. Every test
 * below exists because a specific wrong implementation would pass without it;
 * each one names the mutation that turns it red.
 *
 * NO REAL NODE IS REACHED. `runDoctor` takes `run` and `lookup`, so a fixture
 * node's "ssh" is a local `bash -s` with a throwaway HOME and the registry is a
 * stub. The additivity test spawns the real script against a manifest whose
 * nodes are this box (probed locally) and a name that resolves nowhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	NON_LOGIN,
	TOLERANCE_MINUTES,
	WORK_ADVISORY_MIN_MB,
	buildBackstop,
	computeDrift,
	judgeTool,
	runDoctor,
} from './check-fleet-toolchain.mjs';
import { isLocalNode } from './lib/fleet-exec.mjs';
import { createReleaseLookup } from './lib/tool-release.mjs';
import { REPAIRS } from './lib/toolchain-floor.mjs';
import { parseJsonStdout, spawnCapture } from './lib/spawn-json.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-fleet-toolchain.mjs');
const STOCK_PATH = '/usr/bin:/bin';
const MIN_AGE = 10080;

const CLAW = 'fixture-claw.invalid';
const TASKAUTO = 'fixture-taskauto.invalid';
const GUEST = 'fixture-guest.invalid';

function manifestOf(machines) {
	return { toolchain: { toolCache: {} }, machines };
}
const FLEET = manifestOf({
	[CLAW]: { role: 'claw', labels: ['hadoku-builder'] },
	[TASKAUTO]: { role: 'claw', labels: ['hadoku-builder', 'taskauto'] },
	[GUEST]: { role: 'guest', labels: ['pm2-host', 'taskauto'] },
});

/** A fake home: `claude` lives in ~/.local/bin, which ONLY a login shell puts on PATH. */
function fakeHome({ version = '2.1.285', onStockPath = false } = {}) {
	const home = mkdtempSync(join(tmpdir(), 'fleet-doctor-'));
	const bin = join(home, '.local', 'bin');
	mkdirSync(bin, { recursive: true });
	const claude = join(bin, 'claude');
	writeFileSync(claude, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
	chmodSync(claude, 0o755);
	const profile = `export PATH="${bin}:$PATH"\n`;
	writeFileSync(join(home, '.bash_profile'), profile);
	writeFileSync(join(home, '.profile'), profile);
	return { home, bin, path: onStockPath ? `${bin}:${STOCK_PATH}` : STOCK_PATH };
}

/**
 * The runner PATHs a fixture node reports (#127), through stub `systemctl` and
 * `pgrep` ahead of everything else on PATH, so the probe never reads the REAL
 * user manager or the real listeners of whatever box runs this suite. Anything
 * else either is asked passes through to the real binary, as before.
 *
 * `runnerPath` is the manager's PATH (default: the fixture's own stock PATH, so
 * a tool's runner verdict matches its non-login one); `null` = unreadable.
 * `listenerPid` is a live process the stub pgrep names as a Runner.Listener.
 */
function stubRunnerEnv(fh, { runnerPath = fh.path, listenerPid = null } = {}) {
	const dir = join(fh.home, 'stub-bin');
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, 'systemctl'),
		'#!/bin/sh\n' +
			'if [ "$1" = --user ] && [ "$2" = show-environment ]; then\n' +
			(runnerPath === null ? '  exit 1\n' : `  echo 'PATH=${runnerPath}'; exit 0\n`) +
			'fi\nexec /usr/bin/systemctl "$@"\n'
	);
	writeFileSync(
		join(dir, 'pgrep'),
		'#!/bin/sh\n' +
			'if [ "$1" = -x ] && [ "$2" = Runner.Listener ]; then\n' +
			(listenerPid ? `  echo ${listenerPid}; exit 0\n` : '  exit 1\n') +
			'fi\nexec /usr/bin/pgrep "$@"\n'
	);
	chmodSync(join(dir, 'systemctl'), 0o755);
	chmodSync(join(dir, 'pgrep'), 0o755);
	return dir;
}

/** "ssh" to a fixture node: run the real probe under bash with the fake home. */
function localRun(fh, runnerEnv = {}) {
	const stub = stubRunnerEnv(fh, runnerEnv);
	return (_node, script) => {
		try {
			const out = execFileSync('bash', ['--noprofile', '--norc', '-s'], {
				input: script,
				encoding: 'utf8',
				env: { PATH: `${stub}:${fh.path}`, HOME: fh.home },
			});
			return { ok: true, out, error: null };
		} catch (err) {
			return { ok: false, out: String(err.stdout ?? ''), error: String(err.message) };
		}
	};
}

const known = (version) => ({
	status: 'known',
	version,
	publishedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
});
const stubLookup = (result) => {
	const calls = [];
	const fn = async (source, opts) => {
		calls.push({ source, opts });
		return result;
	};
	fn.calls = calls;
	return fn;
};

const claudeOf = (report, node) =>
	report.find((m) => m.machine === node)?.tools?.find((t) => t.id === 'claude');

test('a detect that only a LOGIN shell can satisfy is NOT a pass', async () => {
	// claw-8, 2026-09-30: `bash -lc` found claude, `bash --noprofile --norc -c` did
	// not, and only the second is what a workflow step gets. MUTATION: set
	// NON_LOGIN to 'bash -lc' and this turns green-as-a-lie, so the assertion fails.
	const fh = fakeHome();
	try {
		const { report } = await runDoctor({
			manifest: FLEET,
			run: localRun(fh),
			lookup: stubLookup(known('2.1.285')),
			drains: {},
		});
		const claude = claudeOf(report, TASKAUTO);
		assert.equal(claude.status, 'absent');
		assert.equal(claude.finding, true);
		assert.match(
			claude.reason,
			/login shell/,
			'the finding says it IS installed, just not reachable'
		);
		assert.equal(report.find((m) => m.machine === TASKAUTO).drift, true);
		assert.match(NON_LOGIN, /--noprofile --norc/);
	} finally {
		rmSync(fh.home, { recursive: true, force: true });
	}
});

// --- The PATH a runner job gets (#127) ---
//
// hokon, 2026-10-13→15: hadoku_site's runner failed `spawnSync gh ENOENT` five
// times while a non-login shell over ssh found gh in ~/.local/bin. A runner's
// PATH comes from the process systemd started it from, not from ssh.

test('#127: on the ssh PATH but NOT on the manager PATH runners inherit is a finding, never a pass', async () => {
	// MUTATION: drop the `runner` line from toolProbeScript (or the check in
	// judgeTool) and claude reads ok — the bug, green.
	const fh = fakeHome({ onStockPath: true });
	try {
		const { report } = await runDoctor({
			manifest: FLEET,
			run: localRun(fh, { runnerPath: STOCK_PATH }),
			lookup: stubLookup(known('2.1.285')),
			drains: {},
		});
		const claude = claudeOf(report, TASKAUTO);
		assert.equal(claude.status, 'absent');
		assert.equal(claude.finding, true);
		assert.equal(claude.runnerPathOnly, true);
		assert.match(claude.reason, /not on the PATH runner jobs get — manager=\/usr\/bin:\/bin/);
		assert.equal(report.find((m) => m.machine === TASKAUTO).drift, true);
	} finally {
		rmSync(fh.home, { recursive: true, force: true });
	}
});

test("#127: a LIVE listener started with an older PATH is judged by its own PATH, not the manager's", async () => {
	// The hokon shape exactly: the manager's PATH has ~/.local/bin NOW, the
	// listener was started before it did. MUTATION: read only the manager.
	const fh = fakeHome({ onStockPath: true });
	const runnerDir = join(fh.home, 'runners', 'actions-runner-hadoku-site');
	mkdirSync(join(runnerDir, 'bin'), { recursive: true });
	const listener = join(runnerDir, 'bin', 'Runner.Listener');
	writeFileSync(listener, '#!/bin/sh\nsleep 30\n');
	chmodSync(listener, 0o755);
	const proc = spawn('/bin/sh', [listener], { env: { PATH: STOCK_PATH }, stdio: 'ignore' });
	try {
		const { report } = await runDoctor({
			manifest: FLEET,
			run: localRun(fh, { runnerPath: fh.path, listenerPid: proc.pid }),
			lookup: stubLookup(known('2.1.285')),
			drains: {},
		});
		const claude = claudeOf(report, TASKAUTO);
		assert.equal(claude.status, 'absent');
		assert.match(claude.reason, /listener:runners\/actions-runner-hadoku-site=\/usr\/bin:\/bin/);
		assert.doesNotMatch(
			claude.reason,
			/manager=/,
			'the manager PATH has the tool and is not named'
		);
	} finally {
		proc.kill();
		rmSync(fh.home, { recursive: true, force: true });
	}
});

test('#127: a listener whose .env sets PATH is judged by that PATH — the listener loads it after start', async () => {
	const fh = fakeHome({ onStockPath: true });
	const runnerDir = join(fh.home, 'runners', 'actions-runner-x');
	mkdirSync(join(runnerDir, 'bin'), { recursive: true });
	writeFileSync(join(runnerDir, '.env'), `LANG=C\nPATH=${STOCK_PATH}\n`);
	const listener = join(runnerDir, 'bin', 'Runner.Listener');
	writeFileSync(listener, '#!/bin/sh\nsleep 30\n');
	chmodSync(listener, 0o755);
	// Its environ HAS the tool; its .env, which wins, does not.
	const proc = spawn('/bin/sh', [listener], { env: { PATH: fh.path }, stdio: 'ignore' });
	try {
		const { report } = await runDoctor({
			manifest: FLEET,
			run: localRun(fh, { listenerPid: proc.pid }),
			lookup: stubLookup(known('2.1.285')),
			drains: {},
		});
		assert.match(
			claudeOf(report, TASKAUTO).reason,
			/listener:runners\/actions-runner-x=\/usr\/bin:\/bin/
		);
	} finally {
		proc.kill();
		rmSync(fh.home, { recursive: true, force: true });
	}
});

test('#127: no readable runner PATH at all is UNKNOWN, a finding — could not look is not ok', async () => {
	const fh = fakeHome({ onStockPath: true });
	try {
		const { report } = await runDoctor({
			manifest: FLEET,
			run: localRun(fh, { runnerPath: null }),
			lookup: stubLookup(known('2.1.285')),
			drains: {},
		});
		const claude = claudeOf(report, TASKAUTO);
		assert.equal(claude.status, 'unknown');
		assert.equal(claude.finding, true);
		assert.match(claude.reason, /could not read the PATH runner jobs get/);
	} finally {
		rmSync(fh.home, { recursive: true, force: true });
	}
});

test('the same tool ON the stock PATH passes (the control for the test above)', async () => {
	const fh = fakeHome({ onStockPath: true });
	try {
		const { report } = await runDoctor({
			manifest: FLEET,
			run: localRun(fh),
			lookup: stubLookup(known('2.1.285')),
			drains: {},
		});
		const claude = claudeOf(report, TASKAUTO);
		assert.equal(claude.status, 'ok');
		assert.equal(claude.installed, '2.1.285');
		assert.equal(claude.finding, false);
	} finally {
		rmSync(fh.home, { recursive: true, force: true });
	}
});

test('`when` scopes in BOTH directions, and a guest carries nothing', async () => {
	// MUTATION: ignore `when` (iterate Object.entries(REPAIRS) for every node) and
	// the plain claw gets a claude entry — a finding for lacking a tool it was
	// never meant to carry. Drop the scoping the other way and TASKAUTO loses it.
	const fh = fakeHome({ onStockPath: true });
	const scripts = {};
	const run = (node, script, o) => {
		scripts[node] = script;
		return localRun(fh)(node, script, o);
	};
	try {
		const { report, skippedByRole } = await runDoctor({
			manifest: FLEET,
			run,
			lookup: stubLookup(known('2.1.285')),
			drains: {},
		});
		assert.equal(claudeOf(report, CLAW), undefined, 'not offered taskauto: not checked');
		assert.ok(!/claude/.test(scripts[CLAW]), 'and not even probed');
		assert.equal(claudeOf(report, TASKAUTO)?.status, 'ok', 'offered taskauto: checked');
		// Unscoped tools apply to both.
		for (const n of [CLAW, TASKAUTO]) {
			const ids = report.find((m) => m.machine === n).tools.map((t) => t.id);
			for (const id of Object.keys(REPAIRS).filter((k) => !REPAIRS[k].when)) {
				assert.ok(ids.includes(id), `${n} carries unscoped ${id}`);
			}
		}
		// The guest offers taskauto too — and is neither probed nor a finding.
		assert.ok(!report.some((m) => m.machine === GUEST));
		assert.ok(skippedByRole.some((s) => s.node === GUEST));
		assert.ok(!(GUEST in scripts), 'a guest is never executed on');
	} finally {
		rmSync(fh.home, { recursive: true, force: true });
	}
});

/**
 * ISSUE #75. `fleet toolchain --machine hokon --include-guests` reported
 * `drift=false` with `tools: []` — `applicableRepairs` excluded a guest
 * unconditionally, so nothing was ever evaluated on it, which rendered as
 * "nothing is wrong" rather than "nothing was checked". `includeGuests: true`
 * is the one door that lifts it, and only for THIS caller: bootcamp,
 * converge-toolchain and the refresh cycle never pass it.
 *
 * MUTATION: drop `includeGuests: true` from the `applicableRepairs` call in
 * `runDoctor` and `claudeOf(report, GUEST)` goes back to `undefined` — the
 * exact regression this test exists to catch.
 */
test('includeGuests evaluates the guest for REAL, instead of reporting tools: []', async () => {
	const fh = fakeHome({ onStockPath: true });
	try {
		const { report, skippedByRole } = await runDoctor({
			manifest: FLEET,
			only: GUEST,
			includeGuests: true,
			run: localRun(fh),
			lookup: stubLookup(known('2.1.285')),
			drains: {},
		});
		assert.deepEqual(skippedByRole, [], 'explicitly included: not skipped');
		const m = report.find((r) => r.machine === GUEST);
		assert.ok(m, 'the guest is in the report');
		assert.equal(m.unreachable, false);
		// Never the empty-tools shape the bug shipped.
		assert.ok(m.tools.length > 0, 'tools: [] must never recur');
		const ids = m.tools.map((t) => t.id).sort();
		assert.deepEqual(
			ids,
			['claude', 'docker', 'ffmpeg', 'gh', 'rust', 'rust-wasm32'],
			'taskauto is declared'
		);
		assert.equal(claudeOf(report, GUEST)?.status, 'ok');
		// rust/docker are judged for real against this sandbox's stock PATH (not
		// asserted pass/fail here, same as the CLAW/TASKAUTO tests above — whether
		// they pass depends on what the box running the test suite has at
		// /usr/bin:/bin, which is not this test's business). What matters is that
		// they were EVALUATED at all: `m.tools` already proved that above.
		assert.ok(m.tools.every((t) => typeof t.finding === 'boolean'));
	} finally {
		rmSync(fh.home, { recursive: true, force: true });
	}
});

test('computeDrift: zero tools evaluated must NEVER print drift=false', () => {
	// The exact shape issue #75 shipped: everything else clean, nothing checked.
	assert.equal(
		computeDrift({
			missingCache: [],
			ensurepip: true,
			pnpmStoreAgrees: true,
			toolFindings: [],
			toolsEvaluated: 0,
		}),
		true,
		'"I could not look" must never render as "nothing is wrong"'
	);
	// The control: everything clean AND something was actually checked.
	assert.equal(
		computeDrift({
			missingCache: [],
			ensurepip: true,
			pnpmStoreAgrees: true,
			toolFindings: [],
			toolsEvaluated: 4,
		}),
		false
	);
	// Every pre-existing drift reason still fires on its own.
	assert.equal(
		computeDrift({
			missingCache: ['Python/3.11'],
			ensurepip: true,
			pnpmStoreAgrees: true,
			toolFindings: [],
			toolsEvaluated: 4,
		}),
		true,
		'missingCache'
	);
	assert.equal(
		computeDrift({
			missingCache: [],
			ensurepip: false,
			pnpmStoreAgrees: true,
			toolFindings: [],
			toolsEvaluated: 4,
		}),
		true,
		'ensurepip'
	);
	assert.equal(
		computeDrift({
			missingCache: [],
			ensurepip: true,
			pnpmStoreAgrees: false,
			toolFindings: [],
			toolsEvaluated: 4,
		}),
		true,
		'pnpmStoreAgrees'
	);
	assert.equal(
		computeDrift({
			missingCache: [],
			ensurepip: true,
			pnpmStoreAgrees: true,
			toolFindings: [{ id: 'claude', finding: true }],
			toolsEvaluated: 4,
		}),
		true,
		'toolFindings'
	);
});

/**
 * `buildBackstop` — pure, fixtured from the REAL shape `parseProbe` produces
 * (captured 2026-10-02 via `fleet toolchain --machine hokon --include-guests
 * --json` against the deployed tree: `unitMaxMb: [4096]`, `unitCount: 28`,
 * `harvesterBytes: 8823` against this package's `14983`, `sliceMaxMb: 16384`).
 * Never feeds `drift`.
 */
test('buildBackstop: the per-unit cap, available-memory floor and harvester drift, from real-shaped facts', () => {
	const facts = {
		unitMax: [
			{ unit: 'actions-runner-a.service', max: '4294967296' },
			{ unit: 'actions-runner-b.service', max: '4294967296' },
			{ unit: 'actions-runner-weird.service', max: 'max' }, // unlimited: excluded
		],
		bkAvailKb: 2_900_000, // ~2.8 GB
		bkTopHold: { rssMb: 39_000, cmd: 'invokeai-web' },
		bkHarvestBytes: 8823,
		bkHarvestSha: 'aaaa0000',
	};
	const b = buildBackstop(facts, {
		minFreeMb: 8192,
		repoHarvestBytes: 14983,
		repoHarvestSha: 'bbbb1111',
		sliceMaxMb: 16384,
	});
	assert.equal(b.advisory, true, 'never a finding, never pageable on its own');
	assert.deepEqual(b.unitMaxMb, [4096], 'a flat cap, and the unlimited unit is not folded in as 0');
	assert.equal(b.unitCount, 3);
	assert.equal(b.floorMb, 8192);
	assert.equal(b.availableMb, Math.round(2_900_000 / 1024));
	assert.equal(b.available, false, '"backstop available: no" — under the floor');
	assert.deepEqual(b.topHolder, { rssMb: 39_000, cmd: 'invokeai-web' });
	assert.equal(b.harvesterBytes, 8823);
	assert.equal(b.harvesterRepoBytes, 14983);
	assert.equal(b.harvesterSha, 'aaaa0000');
	assert.equal(b.harvesterRepoSha, 'bbbb1111');
	assert.equal(b.harvesterDrift, true, 'aaaa0000 != bbbb1111');
	// THE MISMATCH, REPORTED (manager follow-up on #75): the measured per-unit
	// cap against this node's OWN declared slice ceiling, cheap because the
	// manifest entry was already in hand — nothing is ssh'd for it.
	assert.equal(b.sliceMaxMb, 16384);
	assert.equal(
		b.unitCapReachesSlice,
		false,
		'4096 MB per unit does not reach the 16384 MB slice — the #26 mismatch'
	);
});

test('buildBackstop: a cap that DOES reach the slice says so, the control for the mismatch above', () => {
	const b = buildBackstop(
		{
			unitMax: [{ unit: 'actions-runner-a.service', max: (16384 * 1048576).toString() }],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestBytes: 14983,
			bkHarvestSha: 'same',
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'same', sliceMaxMb: 16384 }
	);
	assert.equal(b.unitCapReachesSlice, true);
});

test('buildBackstop: an unknown slice ceiling says so rather than guessing a mismatch', () => {
	const b = buildBackstop(
		{
			unitMax: [{ unit: 'actions-runner-a.service', max: '4294967296' }],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestBytes: 14983,
			bkHarvestSha: 'same',
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'same' } // sliceMaxMb omitted
	);
	assert.equal(b.sliceMaxMb, null);
	assert.equal(b.unitCapReachesSlice, null, 'no ceiling to compare against — not false, not true');
});

test('buildBackstop: available when above the floor, and current when the harvester matches BY CONTENT', () => {
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestBytes: 14983,
			bkHarvestSha: 'identical-sha',
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'identical-sha' }
	);
	assert.equal(b.available, true);
	assert.equal(b.harvesterDrift, false, 'sha-identical: not drifted');
	assert.equal(b.advisories.length, 0, 'no advisory when nothing has drifted');
	assert.equal(b.unitMaxMb.length, 0, 'no units found: an empty list, not a crash');
	assert.equal(b.unitCapReachesSlice, null, 'no units means nothing to contrast either');
});

test('buildBackstop: an absent harvester (-1, no sha) is drift, never a false match', () => {
	const b = buildBackstop(
		{ unitMax: [], bkAvailKb: 10_000_000, bkTopHold: null, bkHarvestBytes: -1 },
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'bbbb1111' }
	);
	assert.equal(b.harvesterBytes, null);
	assert.equal(b.harvesterSha, null);
	assert.equal(b.harvesterDrift, true, 'absent is not "matches nothing to compare against"');
	assert.equal(b.advisories.length, 1);
	assert.equal(b.advisories[0].id, 'harvester-drift');
	assert.match(b.advisories[0].message, /is not running/);
	assert.equal(b.advisories[0].fix, 'systemctl --user enable --now runner-mem-harvest.service');
});

/**
 * #114: the file judged is the one the RUNNING harvester executes. The doctor
 * hashed a hard-coded `~/.local/bin` path after the payload had moved hokon to
 * `~/.hadoku`, and reported drift on a harvester that was fine. MUTATION: put a
 * constant path back in the fix and the first assertion fails.
 */
test('buildBackstop: drift names, and reinstalls to, the path the running harvester executes', () => {
	const running = '/home/hadoku/.hadoku/runner-mem-harvest.py';
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestPath: running,
			bkHarvestBytes: 21761,
			bkHarvestSha: 'running-sha-aaaa',
		},
		{
			minFreeMb: 8192,
			repoHarvestBytes: 21761,
			repoHarvestSha: 'package-sha-bbbb',
			harvesterPkgPath: '/pkg/runner-mem-harvest.py',
		}
	);
	assert.equal(b.harvesterPath, running);
	assert.equal(
		b.advisories[0].fix,
		`install -m 755 /pkg/runner-mem-harvest.py ${running} && systemctl --user restart runner-mem-harvest.service`,
		'reinstall where it actually runs from, and restart — the script is read once at startup'
	);
	assert.ok(b.advisories[0].message.startsWith(running));
	assert.doesNotMatch(JSON.stringify(b), /\.local\/bin/);
});

test('buildBackstop: a running harvester whose script cannot be read is drift, said as such', () => {
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestPath: '/home/hadoku/.hadoku/runner-mem-harvest.py',
			bkHarvestBytes: -1,
		},
		{ minFreeMb: 8192, repoHarvestBytes: 21761, repoHarvestSha: 'package-sha-bbbb' }
	);
	assert.equal(b.harvesterDrift, true);
	assert.match(b.advisories[0].message, /unreadable/);
});

test('buildBackstop: the running harvester matching by content raises nothing', () => {
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestPath: '/home/hadoku/.hadoku/runner-mem-harvest.py',
			bkHarvestBytes: 21761,
			bkHarvestSha: 'same',
		},
		{ minFreeMb: 8192, repoHarvestBytes: 21761, repoHarvestSha: 'same' }
	);
	assert.equal(b.harvesterDrift, false);
	assert.equal(b.advisories.filter((a) => a.id === 'harvester-drift').length, 0);
});

/**
 * THE TRAP THIS LANE EXISTS TO CLOSE (#79): a byte count can coincide while
 * the content differs. `harvesterBytes` matches on both sides here; only the
 * sha differs. MUTATION: compare `harvesterBytes === repoHarvestBytes`
 * instead of the sha, and this goes green on a lie.
 */
test('buildBackstop: a sha mismatch with an EQUAL byte count is still caught', () => {
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestPath: '/home/hadoku/.hadoku/runner-mem-harvest.py',
			bkHarvestBytes: 14983,
			bkHarvestSha: 'installed-sha-aaaa',
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'package-sha-bbbb' }
	);
	assert.equal(b.harvesterBytes, b.harvesterRepoBytes, 'the byte counts agree');
	assert.notEqual(b.harvesterSha, b.harvesterRepoSha, 'the content does not');
	assert.equal(b.harvesterDrift, true, 'content wins over byte count');
	assert.equal(b.advisories.length, 1, 'exactly one advisory for this one drift');
	assert.equal(b.advisories[0].id, 'harvester-drift');
	assert.equal(b.advisories[0].blocking, false, 'advisory, never a page');
	assert.match(b.advisories[0].message, /CONTENT/);
	assert.match(b.advisories[0].fix, /^install -m 755 /, 'the exact reinstall command');
	assert.match(b.advisories[0].fix, /runner-mem-harvest\.py && systemctl --user restart /);
});

test('buildBackstop: a repo sha that was never read (I could not look) is still drift, not a silent pass', () => {
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestBytes: 14983,
			bkHarvestSha: 'x',
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983 } // repoHarvestSha omitted entirely
	);
	assert.equal(b.harvesterDrift, true, 'undefined === undefined must never read as a match');
});

test('buildBackstop: orphan systemd drop-in dirs produce exactly one advisory naming all of them', () => {
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestBytes: 14983,
			bkHarvestSha: 'same',
			dropins: [
				{ dir: '/home/hadoku/.config/systemd/user/hokon-runner-b.service.d', status: 'orphan' },
				{ dir: '/home/hadoku/.config/systemd/user/hokon-runner-c.service.d', status: 'orphan' },
				{ dir: '/home/hadoku/.config/systemd/user/hokon-runner-d.service.d', status: 'orphan' },
				{
					dir: '/home/hadoku/.config/systemd/user/runner-mem-harvest.service.d',
					status: 'present',
				},
				// NOT fleet-owned — the operator's own desktop session, also "orphan"
				// by the probe (an `@`-template drop-in normally has no unit FILE at
				// all), but this package has no business naming it. See
				// fleetDropinPattern. MUTATION: remove the pattern filter and this
				// dir joins the other three, which both of the assertions below catch.
				{ dir: '/home/hadoku/.config/systemd/user/app-invokeai@.service.d', status: 'orphan' },
			],
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'same', nodeName: 'hokon' }
	);
	assert.equal(
		b.advisories.length,
		1,
		'one advisory for the whole orphan category, not one per dir'
	);
	const adv = b.advisories[0];
	assert.equal(adv.id, 'orphan-dropins');
	assert.equal(adv.blocking, false);
	assert.match(adv.message, /3 fleet-owned systemd user drop-in/);
	assert.ok(!adv.message.includes('runner-mem-harvest.service.d'), 'the present one is not named');
	assert.ok(!adv.message.includes('app-invokeai'), 'the operator desktop unit is not named');
	assert.equal(
		adv.fix,
		'rm -r ' +
			"'/home/hadoku/.config/systemd/user/hokon-runner-b.service.d' " +
			"'/home/hadoku/.config/systemd/user/hokon-runner-c.service.d' " +
			"'/home/hadoku/.config/systemd/user/hokon-runner-d.service.d'",
		'one-line rm -r naming exactly the fleet-owned orphans, never the desktop one'
	);
});

test('buildBackstop: dropins all present produce no advisory', () => {
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestBytes: 14983,
			bkHarvestSha: 'same',
			dropins: [
				{
					dir: '/home/hadoku/.config/systemd/user/runner-mem-harvest.service.d',
					status: 'present',
				},
			],
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'same' }
	);
	assert.equal(b.advisories.length, 0);
});

/**
 * THE MANAGER'S CORRECTION, PINNED (#79): the live sweep on hokon found
 * `app-invokeai@.service.d` and `app-org.kde.dolphin@.service.d` reported
 * "orphan" by the probe — correctly, by systemd's own bookkeeping — but
 * those are the OPERATOR's desktop session's template units, not this
 * fleet's. An app-owned drop-in alone, with nothing fleet-owned orphaned
 * beside it, must produce ZERO advisories — never an `rm -r` suggestion
 * naming someone's desktop config. MUTATION: remove the fleetDropinPattern
 * filter and this goes red.
 */
test('buildBackstop: an app-owned drop-in with no unit is NOT an advisory', () => {
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestBytes: 14983,
			bkHarvestSha: 'same',
			dropins: [
				{ dir: '/home/hadoku/.config/systemd/user/app-invokeai@.service.d', status: 'orphan' },
				{
					dir: '/home/hadoku/.config/systemd/user/app-org.kde.dolphin@.service.d',
					status: 'orphan',
				},
			],
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'same', nodeName: 'hokon' }
	);
	assert.equal(
		b.advisories.length,
		0,
		"app-* drop-ins are the operator's desktop, never this fleet's advisory"
	);
});

/**
 * THE NODE NAME IS DERIVED, NEVER HARDCODED (manager correction #2,
 * 2026-10-03): `fleetDropinPattern` used to bake `hokon` directly into the
 * regex, which `scripts/lib/ecosystem-literals.test.mjs` correctly flagged —
 * a hostname baked into a published library. It now takes the probed node's
 * OWN name, so a DIFFERENT guest's legacy `<node>-runner-*` drop-in is caught
 * too, and `hokon`'s is caught only because `nodeName: 'hokon'` was passed
 * for hokon, not because the string is special-cased anywhere.
 */
test('buildBackstop: the legacy per-node runner prefix is derived from the PROBED node, not hardcoded', () => {
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestBytes: 14983,
			bkHarvestSha: 'same',
			dropins: [
				{ dir: '/home/hadoku/.config/systemd/user/claw-9-runner-b.service.d', status: 'orphan' },
				// A DIFFERENT node's legacy prefix must NOT match this probe's own
				// node — it is scoped to the node actually being probed.
				{ dir: '/home/hadoku/.config/systemd/user/hokon-runner-b.service.d', status: 'orphan' },
			],
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'same', nodeName: 'claw-9' }
	);
	assert.equal(b.advisories.length, 1);
	const adv = b.advisories[0];
	assert.match(adv.message, /1 fleet-owned systemd user drop-in/);
	assert.ok(adv.fix.includes('claw-9-runner-b.service.d'));
	assert.ok(
		!adv.fix.includes('hokon-runner-b.service.d'),
		"another node's legacy prefix is not this node's"
	);
});

test('buildBackstop: _work size over the floor on a tight disk is one advisory with a job-safe prune', () => {
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestBytes: 14983,
			bkHarvestSha: 'same',
			bkWorkKb: (WORK_ADVISORY_MIN_MB + 500) * 1024,
			bkRootFreeKb: 5 * 1024 * 1024,
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'same' }
	);
	assert.equal(b.advisories.length, 1);
	const adv = b.advisories[0];
	assert.equal(adv.id, 'backstop-work-size');
	assert.equal(adv.blocking, false);
	assert.match(adv.message, /root disk/);
	// SKIPS any runner with a job in progress — a pgrep on the WORKER process
	// gates the rm, so a runner mid-job is never touched. NOT Listener: the
	// Listener is the long-lived poller and runs on every registered runner
	// whether idle or not (manager correction, 2026-10-03, confirmed live via
	// `ps -eo args` on hokon) — gating on it would prune nothing, ever.
	assert.match(adv.fix, /pgrep -f "\$d\/bin\/Runner\.Worker"/);
	assert.match(adv.fix, /rm -rf "\$d"\/_work\/\*/);
});

/**
 * PINNED, SEPARATELY FROM THE TEST ABOVE (manager request, 2026-10-03): the
 * fix text must key on Runner.WORKER, never Runner.Listener. MUTATION: swap
 * the fix back to Listener and this fails on the negative assertion even if
 * someone narrows the positive regex above.
 */
test('buildBackstop: the _work prune fix keys on Runner.Worker, never Runner.Listener', () => {
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestBytes: 14983,
			bkHarvestSha: 'same',
			bkWorkKb: (WORK_ADVISORY_MIN_MB + 500) * 1024,
			bkRootFreeKb: 5 * 1024 * 1024,
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'same' }
	);
	const fix = b.advisories.find((a) => a.id === 'backstop-work-size').fix;
	assert.ok(fix.includes('Runner.Worker'), 'the job-in-progress signal is the Worker process');
	assert.ok(
		!fix.includes('Runner.Listener'),
		'the Listener runs whether idle or not — never the gate'
	);
});

test('buildBackstop: _work size alone, under a comfortable disk, is NOT an advisory', () => {
	// Churn from fresh job artifacts is normal; it is a finding only against
	// the disk pressure that makes it one (see WORK_ADVISORY_FREE_SHARE's doc).
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestBytes: 14983,
			bkHarvestSha: 'same',
			bkWorkKb: (WORK_ADVISORY_MIN_MB + 5000) * 1024,
			bkRootFreeKb: 500 * 1024 * 1024,
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'same' }
	);
	assert.equal(b.advisories.length, 0);
});

/**
 * #126, MEASURED: hokon on 2026-10-20 — 1.2 GB of `_work` on a 1.8 TB root at
 * 79% used, 387 GB free. The old percentage gate fired, the operator cleared
 * it, and the disk moved 0%. MUTATION: gate on percent used again and this
 * fixture (which a 79% disk satisfies) fires.
 */
test('buildBackstop: _work over the size floor on a BIG disk with room to spare is NOT an advisory (#126)', () => {
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestBytes: 14983,
			bkHarvestSha: 'same',
			bkWorkKb: 1200 * 1024,
			bkRootFreeKb: 387 * 1024 * 1024,
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'same' }
	);
	assert.equal(b.advisories.length, 0);
});

test('buildBackstop: an unreadable free-space figure fires nothing rather than guessing', () => {
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestBytes: 14983,
			bkHarvestSha: 'same',
			bkWorkKb: (WORK_ADVISORY_MIN_MB + 500) * 1024,
			bkRootFreeKb: null,
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'same' }
	);
	assert.equal(b.advisories.length, 0);
});

test('buildBackstop: a tight disk alone, with little _work, is NOT an advisory', () => {
	const b = buildBackstop(
		{
			unitMax: [],
			bkAvailKb: 20_000_000,
			bkTopHold: null,
			bkHarvestBytes: 14983,
			bkHarvestSha: 'same',
			bkWorkKb: 10 * 1024,
			bkRootFreeKb: 1024,
		},
		{ minFreeMb: 8192, repoHarvestBytes: 14983, repoHarvestSha: 'same' }
	);
	assert.equal(b.advisories.length, 0);
});

/**
 * THE CLEAN FIXTURE (#79 done-when): nothing drifted, so zero advisories —
 * and, separately, nothing in here is ever `blocking`. A fixture shaped like
 * a real, healthy `fleet toolchain --machine hokon --include-guests --json`
 * capture.
 */
test('buildBackstop: a clean fixture produces zero advisories, and none would ever block', () => {
	const b = buildBackstop(
		{
			unitMax: [{ unit: 'actions-runner-a.service', max: '4294967296' }],
			bkAvailKb: 3_200_000,
			bkTopHold: { rssMb: 512, cmd: 'node' },
			bkHarvestBytes: 14983,
			bkHarvestSha: 'identical-sha',
			dropins: [
				{
					dir: '/home/hadoku/.config/systemd/user/runner-mem-harvest.service.d',
					status: 'present',
				},
				// Present on hokon today and NOT this package's concern either way —
				// the operator's own desktop session, "orphan" or not.
				{ dir: '/home/hadoku/.config/systemd/user/app-invokeai@.service.d', status: 'orphan' },
			],
			bkWorkKb: 200 * 1024,
			bkRootFreeKb: 400 * 1024 * 1024,
		},
		{ minFreeMb: 2048, repoHarvestBytes: 14983, repoHarvestSha: 'identical-sha', sliceMaxMb: 16384 }
	);
	assert.deepEqual(b.advisories, []);
});

test('an UNKNOWN upstream is a finding that says why — never "current"', async () => {
	// MUTATION: map status 'unknown' to ok/current in judgeTool and this fails.
	const fh = fakeHome({ onStockPath: true });
	try {
		const { report } = await runDoctor({
			manifest: FLEET,
			run: localRun(fh),
			lookup: stubLookup({
				status: 'unknown',
				reason: 'rate limited (HTTP 429); gave up after 2 attempt(s)',
			}),
			drains: {},
		});
		const claude = claudeOf(report, TASKAUTO);
		assert.equal(claude.status, 'unknown');
		assert.equal(claude.finding, true);
		assert.match(claude.reason, /rate limited/);
		assert.equal(report.find((m) => m.machine === TASKAUTO).drift, true);
	} finally {
		rmSync(fh.home, { recursive: true, force: true });
	}
});

test('a registry that fails EVERY attempt is unknown through the real lookup', async () => {
	const fh = fakeHome({ onStockPath: true });
	let fetches = 0;
	const lookup = createReleaseLookup({
		attempts: 2,
		fetch: async () => {
			fetches++;
			throw new Error('ECONNRESET');
		},
	});
	try {
		const { report } = await runDoctor({
			manifest: FLEET,
			run: localRun(fh),
			lookup,
			drains: {},
		});
		const claude = claudeOf(report, TASKAUTO);
		assert.equal(claude.status, 'unknown');
		assert.match(claude.reason, /ECONNRESET/);
		assert.match(claude.reason, /gave up after 2/);
		assert.equal(fetches, 2, 'retried once, and asked once for the one tool');
	} finally {
		rmSync(fh.home, { recursive: true, force: true });
	}
});

test('an unreadable installed version is unknown, not current', () => {
	const tool = REPAIRS.claude;
	const j = judgeTool(
		'claude',
		tool,
		{ detect: 'OK', login: 'OK', runner: '', version: '' },
		known('2.1.285')
	);
	assert.equal(j.status, 'unknown');
	assert.equal(j.finding, true);
});

test('an apt-tracked tool on PATH that dpkg does not own is named as installed outside apt', () => {
	// hokon 2026-10-23: gh in ~/.local/bin, dpkg with no gh, Debian's 2.46 the
	// only candidate. apt answered — "could not say" sent the reader looking
	// for an apt fault. MUTATION: drop the branch and the reason assertion fails.
	const seen = { detect: 'OK', runner: '', apt: '|2.46.0-3|unknown' };
	const j = judgeTool('gh', REPAIRS.gh, seen);
	assert.equal(j.status, 'unknown');
	assert.equal(j.finding, true);
	assert.match(j.reason, /installed outside apt.*apt would install 2\.46\.0-3/);
	// An empty answer is still "could not say".
	const blind = judgeTool('gh', REPAIRS.gh, { ...seen, apt: '' });
	assert.match(blind.reason, /apt could not say/);
});

test('behind / current / ahead, judged against the release cleared minAge + tolerance ago', async () => {
	// MUTATION: look up at plain minAge (drop the tolerance) and the `minAge`
	// assertion fails. MUTATION: flag `ahead` and the third case fails.
	const cases = [
		['2.1.284', 'behind', true],
		['2.1.285', 'current', false],
		['2.1.286', 'ahead', false],
	];
	for (const [installed, want, finding] of cases) {
		const fh = fakeHome({ version: installed, onStockPath: true });
		const lookup = stubLookup(known('2.1.285'));
		try {
			const { report } = await runDoctor({
				manifest: FLEET,
				run: localRun(fh),
				lookup,
				drains: {},
			});
			const c = claudeOf(report, TASKAUTO);
			assert.equal(c.finding, finding, `${installed}`);
			assert.equal(c.status, want === 'current' ? 'ok' : want, `${installed}`);
			assert.equal(lookup.calls.length, 1, 'one lookup per tool per run');
			assert.equal(lookup.calls[0].opts.minAge, MIN_AGE + TOLERANCE_MINUTES);
			if (want === 'behind') assert.equal(c.target, '2.1.285');
		} finally {
			rmSync(fh.home, { recursive: true, force: true });
		}
	}
	assert.equal(TOLERANCE_MINUTES, 3 * 24 * 60);
});

test('upstream is asked once per tool however many nodes carry it', async () => {
	const fh = fakeHome({ onStockPath: true });
	const lookup = stubLookup(known('2.1.285'));
	const two = manifestOf({
		a: { role: 'claw', labels: ['taskauto'] },
		b: { role: 'claw', labels: ['taskauto'] },
	});
	try {
		await runDoctor({ manifest: two, run: localRun(fh), lookup, drains: {} });
		assert.equal(lookup.calls.length, 1);
	} finally {
		rmSync(fh.home, { recursive: true, force: true });
	}
});

test('an unreachable node stays unreachable (shape unchanged)', async () => {
	const { report } = await runDoctor({
		manifest: FLEET,
		run: () => ({ ok: false, out: '', error: 'ssh: Could not resolve hostname' }),
		lookup: stubLookup(known('2.1.285')),
		drains: {},
	});
	const m = report.find((r) => r.machine === CLAW);
	assert.equal(m.unreachable, true);
	assert.equal(m.error, 'ssh: Could not resolve hostname');
	assert.equal(m.tools, undefined);
});

// ---------------------------------------------------------------------------
// ADDITIVITY — `--json` is a contract. `ci:fleet-toolchain` parses it.
//
// The key lists below were CAPTURED from the script before lane C changed it
// (scripts/check-fleet-toolchain.mjs @ d2b80f8, `--json` against the real
// manifests). A field may be ADDED; one of these disappearing or changing type
// breaks the cron. MUTATION: rename or drop any of them in the script.
// ---------------------------------------------------------------------------
const TOP_KEYS = { toolCache: 'object', machines: 'object', skippedByRole: 'object' };
const REACHABLE_KEYS = {
	machine: 'string',
	unreachable: 'boolean',
	cache: 'object',
	os: 'string',
	python: 'string',
	ensurepip: 'boolean',
	toolCacheWritable: 'boolean',
	pnpm: 'string',
	pnpmBin: 'string',
	pnpmStoreAgrees: 'boolean',
	missingCache: 'object',
	pnpmDrift: 'boolean',
	drift: 'boolean',
};
const UNREACHABLE_KEYS = {
	machine: 'string',
	unreachable: 'boolean',
	expectedDown: 'boolean',
	error: 'string',
};

test('--json keeps every pre-existing field, same shape; new ones are additive', () => {
	const root = mkdtempSync(join(tmpdir(), 'fleet-doctor-json-'));
	try {
		const dir = join(root, 'manifests');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, 'fleet-runner-manifest.json'),
			JSON.stringify({
				toolchain: { toolCache: {} },
				machines: {
					[hostname()]: { role: 'claw', labels: ['hadoku-builder'] },
					[CLAW]: { role: 'claw', labels: ['hadoku-builder'] },
				},
			})
		);
		const r = spawnCapture(process.execPath, [SCRIPT, '--json'], {
			env: {
				...process.env,
				FLEET_MANIFEST_DIR: dir,
				HADOKU_STATE_DIR: join(root, 'state'),
				HADOKU_SITE_ROOT: root,
			},
			timeout: 120_000,
			label: 'fleet toolchain --json',
		});
		const report = parseJsonStdout(r);
		for (const [k, t] of Object.entries(TOP_KEYS))
			assert.equal(typeof report[k], t, `top-level ${k}`);
		const local = report.machines.find((m) => m.machine !== CLAW);
		const remote = report.machines.find((m) => m.machine === CLAW);
		for (const [k, t] of Object.entries(REACHABLE_KEYS)) {
			assert.equal(typeof local[k], t, `reachable machine field ${k}`);
		}
		for (const [k, t] of Object.entries(UNREACHABLE_KEYS)) {
			assert.equal(typeof remote[k], t, `unreachable machine field ${k}`);
		}
		// And the additions are there.
		assert.ok(Array.isArray(local.tools) && Array.isArray(local.toolFindings));
		assert.equal(typeof report.toolToleranceMinutes, 'number');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * `backstop`, spawned for REAL against this box with `--include-guests` — the
 * exact command CLAUDE.md names for issue #75. This box IS a real node
 * (`isLocalNode` matches its own hostname), so the probe runs with genuine
 * cgroup and /proc/meminfo reads rather than a stub: the only way to fixture
 * this from REAL `--json` output rather than a hand-written shape, per the
 * brief. Values fluctuate run to run (available memory, who holds the most
 * RSS), so this asserts SHAPE and invariants, not numbers — the same
 * discipline the additivity test above already uses for the rest of the
 * report.
 */
test('backstop: spawned for real with --include-guests, the shape --json actually produces', () => {
	const root = mkdtempSync(join(tmpdir(), 'fleet-doctor-backstop-'));
	try {
		const dir = join(root, 'manifests');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, 'fleet-runner-manifest.json'),
			JSON.stringify({
				toolchain: { toolCache: {} },
				machines: {
					[hostname()]: {
						role: 'guest',
						labels: [],
						minFreeMb: 8192,
						slice: { maxMb: 16384 },
					},
				},
			})
		);
		const r = spawnCapture(
			process.execPath,
			[SCRIPT, '--machine', hostname(), '--include-guests', '--json'],
			{
				env: {
					...process.env,
					FLEET_MANIFEST_DIR: dir,
					HADOKU_STATE_DIR: join(root, 'state'),
					HADOKU_SITE_ROOT: root,
				},
				timeout: 120_000,
				label: 'fleet toolchain --machine <self> --include-guests --json',
			}
		);
		const report = parseJsonStdout(r);
		assert.deepEqual(report.skippedByRole, [], 'explicitly named: reached, not skipped');
		// isLocalNode, not a raw `=== hostname()` compare — the guard
		// (node-identity-guard.test.mjs) refuses a sixth reimplementation of the
		// local rule, this file included.
		const m = report.machines.find((mm) => isLocalNode(mm.machine));
		assert.ok(m, 'the local box is in the report');
		assert.equal(m.unreachable, false);
		assert.ok(m.backstop, 'a guest carries a backstop block');
		const b = m.backstop;
		assert.equal(b.advisory, true);
		assert.ok(Array.isArray(b.unitMaxMb));
		assert.equal(typeof b.unitCount, 'number');
		assert.equal(b.floorMb, 8192, 'read from the manifest minFreeMb this test declared');
		assert.equal(b.sliceMaxMb, 16384, 'read from the manifest slice.maxMb this test declared');
		assert.ok([true, false, null].includes(b.unitCapReachesSlice));
		assert.ok(b.availableMb === null || typeof b.availableMb === 'number');
		assert.ok([true, false, null].includes(b.available));
		assert.ok(b.topHolder === null || typeof b.topHolder.cmd === 'string');
		assert.ok(b.harvesterBytes === null || typeof b.harvesterBytes === 'number');
		assert.equal(typeof b.harvesterRepoBytes, 'number', 'this package always ships the file');
		assert.ok(b.harvesterSha === null || typeof b.harvesterSha === 'string');
		assert.equal(
			typeof b.harvesterRepoSha,
			'string',
			'this package always ships the file, so its sha is always computed'
		);
		assert.equal(typeof b.harvesterDrift, 'boolean');
		// #79 hygiene — advisories are additive, shape-checked (their CONTENT is
		// environment-dependent: this CI box has no hand-installed harvester or
		// `actions-runner-*` cohort, so which ones fire varies), and NEVER
		// blocking.
		assert.ok(Array.isArray(b.advisories));
		for (const adv of b.advisories) {
			assert.equal(typeof adv.id, 'string');
			assert.equal(adv.blocking, false, 'a guest advisory is never a page');
			assert.equal(typeof adv.message, 'string');
			assert.equal(typeof adv.fix, 'string');
		}
		// NEVER a drift input. A real finding (if any) on this box's rust/docker/
		// claude must not hide in `backstop`, and `backstop` must not hide in drift.
		assert.ok(!('drift' in b));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// #98 — a run that probed nothing, and a cache version that matched another.
// ---------------------------------------------------------------------------

/** Spawn the real script against a fixture manifest. Nothing here is probed. */
function spawnDoctor(machines, args) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-doctor-none-'));
	try {
		const dir = join(root, 'manifests');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, 'fleet-runner-manifest.json'),
			JSON.stringify({ toolchain: { toolCache: {} }, machines })
		);
		return spawnCapture(process.execPath, [SCRIPT, '--json', ...args], {
			env: {
				...process.env,
				FLEET_MANIFEST_DIR: dir,
				HADOKU_STATE_DIR: join(root, 'state'),
				HADOKU_SITE_ROOT: root,
			},
			timeout: 120_000,
			label: `fleet toolchain ${args.join(' ')}`,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('#98: --machine naming nothing exits 1 and says why, in --json too', () => {
	const r = spawnDoctor({ [CLAW]: { role: 'claw', labels: [] } }, ['--machine', 'claw-typo']);
	assert.equal(r.code, 1);
	const report = parseJsonStdout(r);
	assert.deepEqual(report.machines, []);
	assert.match(report.noneProbed, /--machine claw-typo selected no probeable node/);
});

test('#98: a manifest whose every node is excluded exits 1', () => {
	const r = spawnDoctor({ [CLAW]: { role: 'claw', placement: 'excluded' } }, []);
	assert.equal(r.code, 1);
	assert.match(parseJsonStdout(r).noneProbed, /no node was probed/);
});

test('#98: a fleet of excluded claws and an UNNAMED guest probed nothing — exit 1, naming the guest', () => {
	// A guest named with --machine is REACHED (guestGate), so it never yields a
	// zero; one that was not named is skipped, and that skip explains nothing.
	const r = spawnDoctor(
		{ [CLAW]: { role: 'claw', placement: 'excluded' }, [GUEST]: { role: 'guest', labels: [] } },
		[]
	);
	const report = parseJsonStdout(r);
	assert.equal(r.code, 1);
	assert.match(report.noneProbed, new RegExp(`skipped by role \\(${GUEST.replace(/\./g, '\\.')};`));
});

test('#98: a declared cache version is matched exactly or at a dot — 3.1 is not 3.11', async () => {
	// The probe hard-codes /opt/hostedtoolcache; the stub run points that at a
	// throwaway tree holding ONLY Python 3.11.9, then runs the real probe text.
	const fake = mkdtempSync(join(tmpdir(), 'fleet-doctor-cache-'));
	const fh = fakeHome();
	try {
		const py = join(fake, 'Python', '3.11.9', 'x64', 'bin');
		mkdirSync(py, { recursive: true });
		writeFileSync(join(py, 'python3'), '#!/bin/sh\necho "Python 3.11.9"\n');
		chmodSync(join(py, 'python3'), 0o755);
		const inner = localRun(fh);
		const run = (node, script) => inner(node, script.replaceAll('/opt/hostedtoolcache', fake));
		const { report } = await runDoctor({
			manifest: {
				toolchain: { toolCache: { Python: ['3.1', '3.11', '3.11.9'] } },
				machines: { [CLAW]: { role: 'claw', labels: [] } },
			},
			run,
			lookup: stubLookup(known('2.1.285')),
			drains: {},
		});
		const m = report.find((r) => r.machine === CLAW);
		assert.deepEqual(m.cache, { 'Python/3.1': false, 'Python/3.11': true, 'Python/3.11.9': true });
		assert.deepEqual(m.missingCache, ['Python/3.1']);
	} finally {
		rmSync(fake, { recursive: true, force: true });
		rmSync(fh.home, { recursive: true, force: true });
	}
});
