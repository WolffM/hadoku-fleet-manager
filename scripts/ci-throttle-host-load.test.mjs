/**
 * ci-throttle's wave 4c #102 host-load snapshot: one line printed into the
 * job log at admission (1-minute load average, CPU pressure, other
 * `Runner.Worker` co-tenants and their repos), so an unattributable slow
 * red has something to read. Split out of ci-throttle.test.mjs (wave 5p
 * lane C) — see `lib/ci-throttle-fixtures.mjs` for the shared `run()` this
 * file drives the real `ci-throttle.sh` through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	FIXTURE_PREFIX,
	installCiThrottleRig,
	installLeakGate,
	run,
} from './lib/ci-throttle-fixtures.mjs';
import { tempDir } from './lib/test-tmpdir.mjs';

installCiThrottleRig();

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

installLeakGate();
