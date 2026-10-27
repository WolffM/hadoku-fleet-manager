// runner-env.test.mjs — #100/#101: TMPDIR and NODE_COMPILE_CACHE move every
// runner's temp and compile caches off tmpfs and onto disk.
//
// Host-independent: every fixture is its own mkdtemp'd $HOME, never the real
// one, and nothing here reads a sibling checkout.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
	readdirSync,
	statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerEnvDrift } from './runner-env-drift.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const INSTALL_SRC = join(ROOT, 'scripts', 'ci-throttle-install.sh');
// The minter as production sends it (src/runners/node-script.ts): the payload
// library, then the script, run as `bash -c <text> jit-provision.sh`.
const { nodeScriptText } = await import('../../dist/runners/node-script.js');
const JIT_ARGV = ['-c', nodeScriptText('jit-provision.sh'), 'jit-provision.sh'];

const cleanups = [];
function take(home) {
	cleanups.push(home);
	return home;
}
test.after(() => {
	for (const h of cleanups) rmSync(h, { recursive: true, force: true });
});

const FAKE_HOOK = '#!/usr/bin/env bash\nexit 0\n';
const FAKE_CONF = 'MAX_CONCURRENT=2\n';

/**
 * The four exact lines the installer's runnerenv_keys_ok check greps for
 * (TCLINE/MLINE/TMPLINE/COMPLINE in ci-throttle-install.sh), for a given
 * fixture $HOME and the TOOLCACHE runInstall() always passes
 * (/opt/hostedtoolcache). Built independently of the installer so these
 * tests do not depend on the writer agreeing with the reader.
 */
function envLines(home) {
	return {
		tc: 'RUNNER_TOOL_CACHE=/opt/hostedtoolcache',
		m: `ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${home}/.hadoku/job-metrics.sh`,
		tmp: `TMPDIR=${home}/runner-tmp`,
		comp: `NODE_COMPILE_CACHE=${home}/.cache/node-compile-cache`,
	};
}

// --- THE INCIDENT, and the fix -------------------------------------------
//
// ci-throttle-install.sh's runner_dirs() enumerates runner directories by
// $HOME glob UNION every live `Runner.Listener`/`Runner.Worker` process on
// the HOST (pgrep, then /proc walks keyed off pgrep's output), and the
// installer forces XDG_RUNTIME_DIR=/run/user/$(id -u) so `systemctl --user`
// reaches the real user manager regardless of what $HOME is set to. A
// fixture HOME is therefore NOT isolation by itself — on a workstation with
// live runners, or a CI claw running its own job, the real pgrep/systemctl
// still see and can still mutate the real host.
//
// The fix: every spawn of a node-side script goes through runHermetic()
// below, which puts a stub bin dir FIRST on PATH. The stubs record their own
// invocation and then refuse to find/affect anything (pgrep: no match;
// systemctl/sudo/loginctl/systemd-run/ps: exit 1, no action). Since every
// /proc walk in the installer is downstream of a pgrep result, a pgrep stub
// that always reports "nothing running" closes those seams too — nothing in
// the installer reads /proc directly except by iterating pgrep's output.
const STUB_DIR = take(mkdtempSync(join(tmpdir(), 'runner-env-stubbin-')));
function writeStub(name) {
	// Each stub appends its invocation (name + argv) to a marker file inside
	// the CALLER's $HOME (inherited at runtime, not baked in here), so a test
	// can prove the stub — not the real binary — is what the script saw. It
	// prints nothing on stdout and exits 1, i.e. "found nothing" / "can't do
	// that here", which is what every one of these calls should see against a
	// fixture that has no real runners or systemd units.
	const body =
		'#!/usr/bin/env bash\n' +
		'mkdir -p "$HOME/.stub-markers" 2>/dev/null\n' +
		`printf '%s\\n' "${name} $*" >> "$HOME/.stub-markers/calls.log" 2>/dev/null\n` +
		'exit 1\n';
	writeFileSync(join(STUB_DIR, name), body, { mode: 0o755 });
}
for (const name of ['pgrep', 'systemctl', 'loginctl', 'sudo', 'systemd-run', 'ps']) {
	writeStub(name);
}

const REAL_HOME = process.env.HOME;

/**
 * The ONLY way any test spawns a node-side script. Refuses (throws) unless
 * `home` is a mkdtemp fixture distinct from the real $HOME, and builds PATH
 * with the stub dir first so pgrep/systemctl/sudo/loginctl/systemd-run/ps
 * cannot reach the real host no matter what the script does.
 */
/** `script` is a path, or the argv `bash` gets (see JIT_ARGV). */
function runHermetic(script, home, extraEnv = {}) {
	if (!home || home === REAL_HOME || !home.startsWith(tmpdir())) {
		throw new Error(
			`runHermetic refuses: HOME must be a mkdtemp fixture under tmpdir(), got ${home}`
		);
	}
	const path = `${STUB_DIR}:${process.env.PATH}`;
	if (!path.startsWith(STUB_DIR)) {
		throw new Error('runHermetic refuses: PATH must start with the stub dir');
	}
	return execFileSync('bash', Array.isArray(script) ? script : [script], {
		encoding: 'utf8',
		env: { PATH: path, HOME: home, ...extraEnv },
	});
}

/** The tripwire: the pgrep stub (not the real binary) was what the run saw. */
function assertPgrepStubInvoked(home) {
	const marker = join(home, '.stub-markers', 'calls.log');
	assert.equal(
		existsSync(marker),
		true,
		'pgrep stub was never invoked — the script may have reached the real host'
	);
	const log = readFileSync(marker, 'utf8');
	assert.match(log, /^pgrep /m, 'marker log has no pgrep invocation');
}

/**
 * The second tripwire: a fixture $HOME with no pre-existing runner dirs must
 * report wired=0 newly=0 restarted=0. Anything else means the walker reached
 * real runner directories the fixture does not own.
 */
function assertEmptyFixtureSummary(out) {
	assert.match(out, /\bwired=0 newly=0\b/, out);
	assert.match(out, /\brestarted=0\b/, out);
}

/** Run the real node-side installer against a fixture $HOME, APPLY=1 by default. */
function runInstall(home, { apply = 1, env = {} } = {}) {
	const out = runHermetic(INSTALL_SRC, home, {
		APPLY: String(apply),
		RESTART: '0',
		TOOLCACHE: '/opt/hostedtoolcache',
		HOOK_B64: Buffer.from(FAKE_HOOK, 'utf8').toString('base64'),
		CONF_B64: Buffer.from(FAKE_CONF, 'utf8').toString('base64'),
		...env,
	});
	assertPgrepStubInvoked(home);
	return out;
}

void test('install renders ~/.hadoku/runner.env with TMPDIR and NODE_COMPILE_CACHE pointing at disk', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	const out = runInstall(home, { env: { MINTS: '1' } });
	assertEmptyFixtureSummary(out);

	const envText = readFileSync(join(home, '.hadoku', 'runner.env'), 'utf8');
	assert.match(envText, new RegExp(`^TMPDIR=${home}/runner-tmp$`, 'm'));
	assert.match(
		envText,
		new RegExp(`^NODE_COMPILE_CACHE=${home}/\\.cache/node-compile-cache$`, 'm')
	);
	// Pointing at DISK means an absolute path under HOME's own .cache, not a
	// bare /dev/shm or /run — the tmpfs-sized cliffs #100/#101 is about (the
	// fixture $HOME itself lives under /tmp, which is fine: the claim is about
	// where TMPDIR/NODE_COMPILE_CACHE point, not about mkdtemp's own root).
	assert.doesNotMatch(envText, /=\/dev\/shm/);
	assert.doesNotMatch(envText, /=\/run\//);

	// No dot-directory below HOME in TMPDIR: express's `send` 404s any path with
	// a dot segment, and e2e harnesses serve their bundle out of tmpdir()
	// (cardtable f72a9ba). Judged on the part this installer chose, so the
	// fixture HOME's own location cannot pass or fail it.
	const tmpdirValue = envText.match(/^TMPDIR=(.*)$/m)?.[1] ?? '';
	assert.ok(tmpdirValue.startsWith(`${home}/`), `TMPDIR is under HOME: ${tmpdirValue}`);
	assert.doesNotMatch(
		tmpdirValue.slice(home.length),
		/\/\./,
		`TMPDIR must have no dot-directory below HOME: ${tmpdirValue}`
	);

	// The directory must exist before any job can reach it — a missing TMPDIR
	// makes mktemp fail outright.
	assert.equal(existsSync(join(home, 'runner-tmp')), true);
	assert.equal(existsSync(join(home, '.cache', 'node-compile-cache')), true);
});

void test('install deletes the jit-provision.sh earlier versions left on the node', () => {
	// The minter travels with each mint now (src/runners/node-script.ts). A copy
	// left on disk is a second source nothing updates, which is how hokon's fell
	// a release behind.
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	mkdirSync(join(home, '.hadoku'), { recursive: true });
	writeFileSync(join(home, '.hadoku', 'jit-provision.sh'), '#!/bin/sh\necho old\n', {
		mode: 0o755,
	});
	// --check sees it and deletes nothing: the converger reads this as drift.
	assert.match(runInstall(home, { apply: 0 }), /\bjitleft=1\b/);
	assert.equal(existsSync(join(home, '.hadoku', 'jit-provision.sh')), true);
	const out = runInstall(home, { env: { MINTS: '1' } });
	assertEmptyFixtureSummary(out);
	assert.match(out, /\bjitleft=0\b/);
	assert.equal(existsSync(join(home, '.hadoku', 'jit-provision.sh')), false);
});

void test('runner-tmp is created 0700; node-compile-cache has no such requirement', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	const out = runInstall(home, { env: { MINTS: '1' } });
	assertEmptyFixtureSummary(out);
	const mode = statSync(join(home, 'runner-tmp')).mode & 0o777;
	assert.equal(mode, 0o700);
});

void test('--check (APPLY=0) creates NOTHING — a verifier must not write what it then reads', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	runInstall(home, { apply: 0 });
	assert.equal(existsSync(join(home, '.cache')), false);
	assert.equal(existsSync(join(home, '.hadoku', 'runner.env')), false);
});

void test('a re-install REPLACES the old TMPDIR/NODE_COMPILE_CACHE lines, never duplicates them', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	runInstall(home, { env: { MINTS: '1' } });
	const out = runInstall(home, { env: { MINTS: '1' } }); // second install, same node
	assertEmptyFixtureSummary(out);

	const lines = readFileSync(join(home, '.hadoku', 'runner.env'), 'utf8')
		.trim()
		.split('\n');
	const tmpdirLines = lines.filter((l) => l.startsWith('TMPDIR='));
	const compileLines = lines.filter((l) => l.startsWith('NODE_COMPILE_CACHE='));
	assert.equal(tmpdirLines.length, 1);
	assert.equal(compileLines.length, 1);
});

void test('the SUMMARY reports runner.env presence and key-completeness as separate facts', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));

	// MINTS unset (a non-ephemeral node): runner.env is never written.
	let out = runInstall(home);
	assert.match(out, /runnerenv=0 runnerenvkeys=0/);

	// Install it: present and complete.
	out = runInstall(home, { env: { MINTS: '1' } });
	assert.match(out, /runnerenv=1 runnerenvkeys=1/);

	// Mutate: strip the new keys the way an OLDER package would have left them.
	writeFileSync(join(home, '.hadoku', 'runner.env'), 'RUNNER_TOOL_CACHE=/opt/hostedtoolcache\n');
	out = runInstall(home); // MINTS unset this run — must not overwrite the file
	assert.match(out, /runnerenv=1 runnerenvkeys=0/);
});

// --- runnerenv_keys_ok: the REAL-WORLD case, not the single-line strip -----
//
// Mutation-tested: deleting the installer's `grep -qxF "$TMPLINE" …` line
// left all existing tests green, because the only fixture that reaches
// runnerenv_keys_ok's four-grep chain was a single `RUNNER_TOOL_CACHE` line,
// which already fails on $MLINE — it can't tell TMPDIR/NODE_COMPILE_CACHE
// apart from the rest. Every claw on the fleet before #100/#101 carries
// exactly the OLD two lines (TCLINE, MLINE) and nothing else; that is the
// fixture these tests exercise.

void test('SUMMARY reads runnerenvkeys=0 for a node carrying only the two OLD lines (every claw before #100/#101)', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	const L = envLines(home);
	mkdirSync(join(home, '.hadoku'), { recursive: true });
	writeFileSync(join(home, '.hadoku', 'runner.env'), `${L.tc}\n${L.m}\n`);

	const out = runInstall(home); // MINTS unset — must not rewrite the file
	assert.match(out, /runnerenv=1 runnerenvkeys=0/);
});

void test('SUMMARY reads runnerenvkeys=0 when all four lines are present except TMPDIR', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	const L = envLines(home);
	mkdirSync(join(home, '.hadoku'), { recursive: true });
	writeFileSync(join(home, '.hadoku', 'runner.env'), `${L.tc}\n${L.m}\n${L.comp}\n`);

	const out = runInstall(home);
	assert.match(out, /runnerenv=1 runnerenvkeys=0/);
});

void test('SUMMARY reads runnerenvkeys=0 when all four lines are present except NODE_COMPILE_CACHE', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	const L = envLines(home);
	mkdirSync(join(home, '.hadoku'), { recursive: true });
	writeFileSync(join(home, '.hadoku', 'runner.env'), `${L.tc}\n${L.m}\n${L.tmp}\n`);

	const out = runInstall(home);
	assert.match(out, /runnerenv=1 runnerenvkeys=0/);
});

void test('SUMMARY reads runnerenvkeys=0 when TMPDIR is present but holds the wrong value — the check is an exact-line match', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	const L = envLines(home);
	mkdirSync(join(home, '.hadoku'), { recursive: true });
	writeFileSync(join(home, '.hadoku', 'runner.env'), `${L.tc}\n${L.m}\nTMPDIR=/tmp\n${L.comp}\n`);

	const out = runInstall(home);
	assert.match(out, /runnerenv=1 runnerenvkeys=0/);
});

void test('SUMMARY reads runnerenvkeys=1 when all four lines are present and correct, written by hand (not by the installer)', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	const L = envLines(home);
	mkdirSync(join(home, '.hadoku'), { recursive: true });
	writeFileSync(join(home, '.hadoku', 'runner.env'), `${L.tc}\n${L.m}\n${L.tmp}\n${L.comp}\n`);

	const out = runInstall(home);
	assert.match(out, /runnerenv=1 runnerenvkeys=1/);
});

void test('jit-provision.sh merges TMPDIR/NODE_COMPILE_CACHE into a slot .env exactly once across two merges', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	mkdirSync(join(home, '.hadoku'), { recursive: true });
	writeFileSync(
		join(home, '.hadoku', 'runner.env'),
		'RUNNER_TOOL_CACHE=/opt/hostedtoolcache\n' +
			'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/x/job-metrics.sh\n' +
			`TMPDIR=${home}/runner-tmp\n` +
			`NODE_COMPILE_CACHE=${home}/.cache/node-compile-cache\n`
	);
	// jit-provision.sh derives DIR itself as $HOME/.hadoku/jit/slot$SLOT, and
	// bootstraps a slot from $HOME/.hadoku/jit/payload (a standing install's
	// copy) — without a payload that actually EXECUTES `--version`, it
	// SLOT-FAILs before ever reaching the env merge.
	const FAKE_LISTENER =
		'#!/usr/bin/env bash\nif [ "${1:-}" = "--version" ]; then echo "2.336.0"; exit 0; fi\nexit 0\n';
	const payload = join(home, '.hadoku', 'jit', 'payload');
	mkdirSync(join(payload, 'bin'), { recursive: true });
	mkdirSync(join(payload, 'externals'), { recursive: true });
	writeFileSync(join(payload, 'bin', 'Runner.Listener'), FAKE_LISTENER, { mode: 0o755 });
	writeFileSync(join(payload, 'externals', 'node20'), 'x');

	const dir = join(home, '.hadoku', 'jit', 'slot1');
	mkdirSync(join(dir, 'bin'), { recursive: true });
	writeFileSync(join(dir, 'bin', 'Runner.Listener'), FAKE_LISTENER, { mode: 0o755 });
	// A slot that already carries a .env from a previous mint — the merge must
	// dedupe against this, not just append.
	writeFileSync(join(dir, '.env'), `TMPDIR=/tmp\nSOME_OTHER_KEY=v\n`);

	for (let i = 0; i < 2; i++) {
		runHermetic(JIT_ARGV, home, { SLOT: '1', RESET: '0' });
	}

	const lines = readFileSync(join(dir, '.env'), 'utf8').trim().split('\n');
	const tmpdirLines = lines.filter((l) => l.startsWith('TMPDIR='));
	const compileLines = lines.filter((l) => l.startsWith('NODE_COMPILE_CACHE='));
	assert.equal(tmpdirLines.length, 1, lines.join('|'));
	assert.equal(compileLines.length, 1, lines.join('|'));
	assert.equal(tmpdirLines[0], `TMPDIR=${home}/runner-tmp`);
	assert.equal(lines.filter((l) => l.startsWith('SOME_OTHER_KEY=')).length, 1);
	// The defensive mkdir: the merged TMPDIR must exist even though this test
	// never ran the installer on this $HOME.
	assert.equal(existsSync(join(home, 'runner-tmp')), true);
});

void test('the installer WALKER merges TMPDIR/NODE_COMPILE_CACHE into a standing runner dir it finds by glob, keeping unrelated keys', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	// A standing runner directory the glob in runner_dirs() must find: a
	// `.runner` file marks it as a real runner install, and its existing
	// `.env` holds the OLD tmpfs TMPDIR plus a key the walker must leave
	// alone. This is the standing-runner merge path — distinct from the
	// `~/.hadoku/runner.env` write covered above — and nothing exercised it
	// before this test.
	const runnerDir = join(home, 'actions-runner-x');
	mkdirSync(runnerDir, { recursive: true });
	writeFileSync(join(runnerDir, '.runner'), '{}');
	writeFileSync(join(runnerDir, '.env'), 'TMPDIR=/tmp\nUNRELATED_KEY=keep-me\n');

	runInstall(home); // MINTS unset — this is the standing-runner path, not JIT

	const lines = readFileSync(join(runnerDir, '.env'), 'utf8').trim().split('\n');
	const tmpdirLines = lines.filter((l) => l.startsWith('TMPDIR='));
	const compileLines = lines.filter((l) => l.startsWith('NODE_COMPILE_CACHE='));
	const unrelated = lines.filter((l) => l.startsWith('UNRELATED_KEY='));
	assert.equal(tmpdirLines.length, 1, lines.join('|'));
	assert.equal(compileLines.length, 1, lines.join('|'));
	assert.equal(tmpdirLines[0], `TMPDIR=${home}/runner-tmp`);
	assert.equal(unrelated.length, 1, 'the walker must not touch an unrelated key');
	assert.equal(unrelated[0], 'UNRELATED_KEY=keep-me');
});

// --- runnerEnvDrift(): the deploy-ci-throttle.mjs classifier, pulled into a
// pure function because the driver reaches real nodes over ssh and has no
// hermetic path to execute in a test. -------------------------------------

void test('runnerEnvDrift: healthy summary (runnerenv=1 runnerenvkeys=1) is not drift', () => {
	assert.equal(
		runnerEnvDrift({
			name: 'claw-1',
			ephemeral: true,
			summary: 'SUMMARY runnerenv=1 runnerenvkeys=1',
		}),
		null
	);
});

void test('runnerEnvDrift: ephemeral node with no runner.env is drift', () => {
	const finding = runnerEnvDrift({
		name: 'claw-1',
		ephemeral: true,
		summary: 'SUMMARY runnerenv=0 runnerenvkeys=0',
	});
	assert.match(finding, /claw-1: declares ephemeral but has no runner\.env/);
});

void test('runnerEnvDrift: a non-ephemeral node with no runner.env is NOT drift', () => {
	assert.equal(
		runnerEnvDrift({
			name: 'hokon',
			ephemeral: false,
			summary: 'SUMMARY runnerenv=0 runnerenvkeys=0',
		}),
		null
	);
});

void test('runnerEnvDrift: runner.env present but missing a key is drift regardless of ephemeral', () => {
	const finding = runnerEnvDrift({
		name: 'claw-2',
		ephemeral: true,
		summary: 'SUMMARY runnerenv=1 runnerenvkeys=0',
	});
	assert.match(finding, /claw-2: runner\.env exists but is missing a required key/);
});

void test('runnerEnvDrift: a SUMMARY with NO runnerenv=/runnerenvkeys= token at all is drift — "could not look" must not read as healthy', () => {
	const finding = runnerEnvDrift({
		name: 'claw-3',
		ephemeral: true,
		summary: 'SUMMARY conf=1 payload=1',
	});
	assert.match(finding, /claw-3: could not read runner\.env state/);

	// Also true for a non-ephemeral node — the absence is about the SUMMARY
	// line itself never reaching those tokens, not about the node's role.
	const finding2 = runnerEnvDrift({
		name: 'hokon',
		ephemeral: false,
		summary: 'SUMMARY conf=1',
	});
	assert.match(finding2, /hokon: could not read runner\.env state/);
});

// --- #98: the conf is reported by VALUE, the way the hook reads it ---------
//
// `conf=1` used to mean "a line starting MAX_CONCURRENT= exists". The hook
// replaces a non-integer with 99 and a missing MIN_FREE_MB with 0, so a conf
// that loaded to NO limit read as loaded. The node half now reports the
// effective values and the conf's sha256; the driver judges them.

function confSummary(home, conf) {
	const out = runInstall(home, {
		env: { CONF_B64: Buffer.from(conf, 'utf8').toString('base64') },
	});
	assertEmptyFixtureSummary(out);
	const line = out.split('\n').find((l) => l.startsWith('SUMMARY')) ?? '';
	return Object.fromEntries(
		line
			.split(/\s+/)
			.slice(1)
			.map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)])
	);
}

void test('#98: a well-formed conf reports its effective limits and its sha256', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	const conf = 'MAX_CONCURRENT=2\nMIN_FREE_MB=512\nMAX_WAIT_S=90\n';
	const kv = confSummary(home, conf);
	assert.equal(kv.conf, '1');
	assert.equal(kv.conf_max, '2');
	assert.equal(kv.conf_minfree, '512');
	// The same bytes the driver hashes from the conf it renders.
	assert.equal(kv.confsha, createHash('sha256').update(conf, 'utf8').digest('hex'));
});

void test('#98: a garbage MAX_CONCURRENT and a missing MIN_FREE_MB report what the hook ENFORCES — 99 and 0', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	const kv = confSummary(home, 'MAX_CONCURRENT=two\n');
	// Still "loads": the finding is the value, which the driver compares.
	assert.equal(kv.conf, '1');
	assert.equal(kv.conf_max, '99');
	assert.equal(kv.conf_minfree, '0');
});

void test('#98: a conf with no MAX_CONCURRENT line at all reports 99, not a pass', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	const kv = confSummary(home, 'MIN_FREE_MB=1024\n');
	assert.equal(kv.conf_max, '99');
	assert.equal(kv.conf_minfree, '1024');
});

void test('#98: no conf on disk is conf=0 with "-" values and an absent hash — never a number', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	const out = runInstall(home, { apply: 0 });
	assert.match(out, /\bconf=0 conf_max=- conf_minfree=- confsha=absent\b/, out);
});

void test('#98: the driver hashes the conf it RENDERS and hands it to throttleSummaryDrift', () => {
	const src = readFileSync(join(ROOT, 'scripts', 'deploy-ci-throttle.mjs'), 'utf8');
	assert.match(src, /CONF_B64=\$\{b64\(conf\)\}/, 'the payload ships the rendered `conf`');
	assert.match(
		src,
		/throttleSummaryDrift\(\{[^}]*wantConfSha: createHash\('sha256'\)\.update\(conf, 'utf8'\)/s,
		'the driver must judge the node against the sha256 of that same `conf`'
	);
});

// Since fleet-manager#1 the controller redeploys node-side scripts unattended,
// so a deploy must be safe while a job is running the hook. A changed file is
// RENAMED over (new inode; a reader keeps the one it opened), and identical
// bytes are not touched at all.
void test('node-side scripts are replaced by rename, never truncated in place, and left alone when unchanged', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	const hook = join(home, '.hadoku', 'ci-throttle.sh');
	runInstall(home);
	const first = statSync(hook).ino;
	runInstall(home);
	assert.equal(statSync(hook).ino, first, 'identical bytes: the same file, untouched');
	runInstall(home, {
		env: {
			HOOK_B64: Buffer.from('#!/usr/bin/env bash\n# v2\nexit 0\n', 'utf8').toString('base64'),
		},
	});
	assert.notEqual(statSync(hook).ino, first, 'changed bytes: a new file renamed over the old');
	assert.match(readFileSync(hook, 'utf8'), /# v2/);
	assert.equal(statSync(hook).mode & 0o777, 0o755);
	assert.ok(
		!readdirSync(join(home, '.hadoku')).some((f) => f.includes('.new.')),
		'no temp file is left behind'
	);
});

// --- WHAT A LIVE JOB SEES (2026-10-24) -------------------------------------
//
// The file checks above can all pass while a job writes its temp to RAM: the
// .env is right, and the thing that read it is not what the job inherited. So
// the node half reads each live Runner.Worker's own environ and asks findmnt
// what filesystem the effective temp dir is on. Here the workers are REAL
// processes (a copy of `sleep` named Runner.Worker, so /proc is genuinely
// read), found through a pgrep stub that names only them, and findmnt is a
// stub so the verdict does not depend on what this host's /tmp happens to be.
void test('--check reads each live job: one with TMPDIR on disk passes, one with none is JOBTMP-BAD', async () => {
	const { spawn } = await import('node:child_process');
	const { copyFileSync, chmodSync } = await import('node:fs');
	const home = take(mkdtempSync(join(tmpdir(), 'runner-env-')));
	const sleepBin = ['/usr/bin/sleep', '/bin/sleep'].find((p) => existsSync(p));
	const worker = (name, env) => {
		const bin = join(home, name, 'bin');
		mkdirSync(bin, { recursive: true });
		copyFileSync(sleepBin, join(bin, 'Runner.Worker'));
		chmodSync(join(bin, 'Runner.Worker'), 0o755);
		return spawn(join(bin, 'Runner.Worker'), ['30'], { env, stdio: 'ignore' });
	};
	const disk = join(home, 'disk');
	mkdirSync(join(disk, 'tmp'), { recursive: true });
	const good = worker('good', {
		TMPDIR: join(disk, 'tmp'),
		NODE_COMPILE_CACHE: join(disk, 'ncc'),
	});
	const bad = worker('bad', {});
	try {
		const stubs = join(home, 'observe-stubs');
		mkdirSync(stubs);
		writeFileSync(
			join(stubs, 'pgrep'),
			`#!/bin/sh\n[ "$1" = -x ] && [ "$2" = Runner.Worker ] && { echo ${good.pid}; echo ${bad.pid}; exit 0; }\nexit 1\n`,
			{ mode: 0o755 }
		);
		writeFileSync(
			join(stubs, 'findmnt'),
			`#!/bin/sh\ncase "$5" in ${disk}*) echo ext4 ;; *) echo tmpfs ;; esac\n`,
			{ mode: 0o755 }
		);
		// Wait until both are exec'd: /proc/<pid>/exe names the copy only then.
		const { readlinkSync } = await import('node:fs');
		for (const p of [good, bad]) {
			const deadline = Date.now() + 5_000;
			for (;;) {
				let exe = '';
				try {
					exe = readlinkSync(`/proc/${p.pid}/exe`);
				} catch (err) {
					if (err.code !== 'ENOENT') throw err;
				}
				if (exe.endsWith('/bin/Runner.Worker')) break;
				assert.ok(Date.now() < deadline, 'fake worker never started');
				await new Promise((r) => setTimeout(r, 20));
			}
		}
		const out = runHermetic(INSTALL_SRC, home, {
			APPLY: '0',
			RESTART: '0',
			TOOLCACHE: '/opt/hostedtoolcache',
			HOOK_B64: Buffer.from(FAKE_HOOK, 'utf8').toString('base64'),
			CONF_B64: Buffer.from(FAKE_CONF, 'utf8').toString('base64'),
			PATH: `${stubs}:${STUB_DIR}:${process.env.PATH}`,
		});
		assert.match(out, /\bjobtmpseen=2 jobtmpbad=1 jobtmpunread=0\b/, out);
		const lines = out.split('\n').filter((l) => l.startsWith('JOBTMP-BAD '));
		assert.equal(lines.length, 1, out);
		assert.ok(
			lines[0].startsWith(`JOBTMP-BAD ${join(home, 'bad')} pid=${bad.pid} TMPDIR=unset fs=tmpfs`),
			lines[0]
		);
	} finally {
		good.kill('SIGKILL');
		bad.kill('SIGKILL');
	}
});
