/**
 * `capability-probe.sh`'s IDLE-ONLY half, EXECUTED against stubs (2026-10-10).
 *
 * `cargo-bevy` is an all-core compile benchmark, and a benchmark taken beside
 * a running CI job measures the job: claw-4 2281 idle vs 1169 busy, claw-6
 * 1529 vs 1024. The probe therefore says HOW BUSY the node was while it
 * measured (`LOAD cargo-bevy <most live Runner.Worker seen>`), and runs in
 * halves so bootcamp can re-take the measurement on a drained node.
 *
 * WHAT RUNS. The real script, under `/bin/bash`, with a PATH that is ONLY a
 * fixture bin: stub `rustc`, `nproc` and `pgrep`, plus symlinks to the handful
 * of coreutils the measured half needs. HOME and TMPDIR are fixture dirs. So
 * nothing here can read the host's real Runner.Workers (`pgrep` is a stub —
 * the trap `fixture-home-is-not-isolation` records), and if a mutation broke
 * the phase guard the rest of the probe would find no ffmpeg, node, npm or
 * pm2 to run: every other block answers `no absent` instead of touching the
 * box.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROBE = join(dirname(fileURLToPath(import.meta.url)), 'capability-probe.sh');

/** Absolute path of a host utility, found WITHOUT a shell. */
function which(u) {
	for (const d of ['/usr/bin', '/bin', '/usr/local/bin']) {
		if (existsSync(join(d, u))) return join(d, u);
	}
	throw new Error(`${u} not found on this host`);
}

/**
 * @param {object} o
 * @param {string} o.rustcBody  shell run by the stub rustc after it has parsed `-o`
 * @param {string|null} o.workers  the stub pgrep's starting count; null = no pgrep
 */
function harness({ rustcBody = '', workers = '0' } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-probe-load-'));
	const bin = join(root, 'bin');
	const tmp = join(root, 'tmp');
	const home = join(root, 'home');
	for (const d of [bin, tmp, home]) mkdirSync(d, { recursive: true });
	for (const u of ['date', 'mktemp', 'rm', 'sleep', 'cat', 'hostname', 'chmod']) {
		symlinkSync(which(u), join(bin, u));
	}
	const counter = join(root, 'workers');
	const stub = (name, body) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub('nproc', 'printf 2');
	stub(
		'rustc',
		[
			'while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done',
			rustcBody,
			'printf "#!/bin/sh\\n" >"$out"',
			'chmod +x "$out"',
		].join('\n')
	);
	if (workers !== null) {
		writeFileSync(counter, `${workers}\n`);
		// Real pgrep -c prints the count and exits 1 when it is zero.
		stub('pgrep', `n=$(cat ${JSON.stringify(counter)})\necho "$n"\n[ "$n" -gt 0 ]`);
	}
	const run = (phase) =>
		execFileSync('/bin/bash', [PROBE], {
			encoding: 'utf8',
			cwd: root,
			timeout: 60_000,
			env: { PATH: bin, HOME: home, TMPDIR: tmp, CAP_PROBE_PHASE: phase },
		});
	return { root, tmp, counter, run };
}

const lines = (out, tag) => out.split('\n').filter((l) => l.startsWith(`${tag} `));

test('an idle node: the measurement and LOAD 0, and the measured phase runs NOTHING else', () => {
	const h = harness();
	try {
		const out = h.run('measured');
		assert.match(out, /^CAP cargo-bevy ok \d+$/m);
		assert.deepEqual(lines(out, 'LOAD'), ['LOAD cargo-bevy 0']);
		// THE PHASE GUARD. Only the idle-only capabilities, then the end marker —
		// a drained node is held out of service for the measurement, not for the
		// whole probe.
		assert.deepEqual(
			lines(out, 'CAP').map((l) => l.split(' ')[1]),
			['cargo-bevy'],
			`the measured phase ran more than the idle-only set:\n${out}`
		);
		assert.match(out, /^PROBE-END /m);
		assert.deepEqual(readdirSync(h.tmp), [], 'the sample file and the build dir are removed');
	} finally {
		rmSync(h.root, { recursive: true, force: true });
	}
});

test('a busy node: LOAD carries the live Runner.Worker count', () => {
	const h = harness({ workers: '2' });
	try {
		assert.deepEqual(lines(h.run('measured'), 'LOAD'), ['LOAD cargo-bevy 2']);
	} finally {
		rmSync(h.root, { recursive: true, force: true });
	}
});

test('a job that starts AND finishes inside the batch is still seen — LOAD is the MOST, sampled throughout', () => {
	// Idle before the batch and idle after it, busy for two seconds in the
	// middle. Sampling only at the ends would print 0 and the measurement would
	// be judged as idle while it shared every core with a job.
	const h = harness({});
	try {
		const flip = (n) => `echo ${n} >${JSON.stringify(h.counter)}`;
		writeFileSync(
			join(h.root, 'bin', 'rustc'),
			[
				'#!/bin/sh',
				'while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done',
				flip(1),
				'sleep 2.5',
				flip(0),
				'printf "#!/bin/sh\\n" >"$out"',
				'chmod +x "$out"',
				'',
			].join('\n')
		);
		assert.deepEqual(lines(h.run('measured'), 'LOAD'), ['LOAD cargo-bevy 1']);
	} finally {
		rmSync(h.root, { recursive: true, force: true });
	}
});

test('no pgrep: LOAD is "unknown", never a zero', () => {
	const h = harness({ workers: null });
	try {
		assert.deepEqual(lines(h.run('measured'), 'LOAD'), ['LOAD cargo-bevy unknown']);
	} finally {
		rmSync(h.root, { recursive: true, force: true });
	}
});

test('the presence phase skips the idle-only measurement entirely — no CAP, no LOAD', () => {
	const h = harness();
	try {
		const out = h.run('presence');
		assert.ok(!/^CAP cargo-bevy /m.test(out), `presence ran the benchmark:\n${out}`);
		assert.deepEqual(lines(out, 'LOAD'), []);
		// And it IS the rest of the probe, which this PATH answers `no` to.
		assert.match(out, /^CAP ffmpeg no absent$/m);
		assert.match(out, /^PROBE-END /m);
	} finally {
		rmSync(h.root, { recursive: true, force: true });
	}
});

test('the default phase is the whole probe, measurement and LOAD included — every other caller is unchanged', () => {
	const h = harness({ workers: '1' });
	try {
		const out = execFileSync('/bin/bash', [PROBE], {
			encoding: 'utf8',
			cwd: h.root,
			timeout: 60_000,
			env: { PATH: join(h.root, 'bin'), HOME: join(h.root, 'home'), TMPDIR: h.tmp },
		});
		assert.match(out, /^CAP cargo-bevy ok \d+$/m);
		assert.deepEqual(lines(out, 'LOAD'), ['LOAD cargo-bevy 1']);
		assert.match(out, /^CAP ffmpeg no absent$/m);
	} finally {
		rmSync(h.root, { recursive: true, force: true });
	}
});
