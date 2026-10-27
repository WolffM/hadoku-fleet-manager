/**
 * `fleet enroll` is the only command that lets a box describe itself, so it is
 * the only one that has to be suspicious of its input.
 *
 * The tests below pin the three properties that make it safe to run:
 *   - a clean proposal still EXITS 1, because a proposal is not an enrollment;
 *   - an already-declared node is never silently overwritten, because its
 *     capacity numbers and $why prose are human decisions;
 *   - --update touches only what was measured.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEnrollmentRecord } from './enrollment-record.mjs';

/**
 * The env a child gets, with every `GIT_*` REMOVED.
 *
 * `.husky/pre-push` runs the whole suite, and a hook exports `GIT_DIR` and
 * `GIT_INDEX_FILE` to its children — those OVERRIDE `cwd` for every git
 * invocation, so without this the writer under test would resolve its target
 * against THIS repository instead of the scratch one and commit into it. Same
 * reasoning as `src/lib/fleet-paths.ts` and `doctor-write.test.mjs`.
 *
 * IT ALSO CARRIES THE FIXTURE IDENTITY, so `gitInit` no longer writes one
 * into the fixture's config. `git config user.email fleet-test@invalid` used
 * to live there, and 38 commits on `origin/main` between 09-15 and 09-18 are
 * authored `fleet test <fleet-test@invalid>`.
 */
import { cleanGitEnv } from './test-git-identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'enroll-node.mjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const FIELDS = {
	recordedAt: '2026-09-01T00:00:00Z',
	hostname: 'claw-9',
	profile: 'desktop-debian-trixie',
	role: 'runner',
	cores: 8,
	memTotalKb: 16258756,
	diskModel: 'WDC WD10EZEX-08W',
	diskFreeGb: 842,
	osId: 'debian',
	osCodename: 'trixie',
	kernel: '6.12.94+deb13-amd64',
	fleetUser: 'hadoku',
	sshPort: 22,
	sudoNoPasswd: 'ok',
	sshKeyAuthLoopback: 'ok',
	sshFromControl: null,
	authMode: 'key',
	ready: 'ok',
};

function capture(over = {}, detailOver = {}) {
	return (
		'noise from apt\n' +
		formatEnrollmentRecord({
			fields: { ...FIELDS, ...over },
			// A null field needs a REASON beside it — the record refuses a bare
			// "unknown", because "unknown" alone tells an operator nothing about
			// whether to go and look.
			details: { sshFromControl: 'no inbound session at a console', ...detailOver },
			capabilities: [
				{ id: 'node20', ok: true, detail: 'v20.11.0' },
				{ id: 'docker', ok: false, detail: 'not installed' },
			],
		}) +
		'trailing noise\n'
	);
}

/**
 * A manifest dir holding a manifest with one existing, human-tuned node.
 *
 * IT IS A GIT REPOSITORY, and that is not decoration. Since 2026-09-15 `fleet
 * enroll --write` resolves its target through `lib/manifest-target.mjs` and
 * REFUSES a target it cannot land — a deploy tree, a non-checkout, or a file
 * that is already dirty — because a write that is not a commit on hadoku_site's
 * main is erased by the next redeploy and was, silently, on 2026-09-14. A
 * scratch directory that is not a checkout is exactly the `not-a-checkout`
 * refusal, so the fixture has to be the thing the writer now requires.
 *
 * The identity comes from `cleanGitEnv`, in `GIT_AUTHOR_*`/`GIT_COMMITTER_*`,
 * rather than from the ambient global config: CI runs this on a claw, and a
 * runner with no `user.email` would fail the commit for a reason that has
 * nothing to do with what is under test. It used to be a `git config
 * user.email fleet-test@invalid` here — a WRITE, and `cwd` does not decide
 * which config file receives it. 38 commits on `origin/main` between 09-15 and
 * 09-18 are authored `fleet test <fleet-test@invalid>`; the string came from
 * this file and its neighbours.
 */
function site() {
	const d = mkdtempSync(join(tmpdir(), 'fleet-enroll-'));
	made.push(d);
	gitInit(d);
	writeFileSync(
		join(d, 'fleet-runner-manifest.json'),
		JSON.stringify(
			{
				machines: {
					'claw-3': {
						cores: 4,
						ramGb: 15,
						labels: ['hadoku-builder', 'jit-canary'],
						maxConcurrent: 3,
						maxRegistrations: 16,
						$why: 'thermal demotion, hand written',
					},
				},
			},
			null,
			2
		)
	);
	git(d, ['add', '-A']);
	git(d, ['commit', '-q', '-m', 'base']);
	return d;
}

/** git in `dir`, with every `GIT_*` stripped — see {@link cleanGitEnv}. */
function git(dir, args) {
	const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: cleanGitEnv() });
	assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

function gitInit(dir) {
	git(dir, ['init', '-q', '-b', 'main']);
}

/**
 * `--no-push` ALWAYS. A test of a writer that pushes is a test that mutates a
 * real repository; the commit is what this suite proves, and `push: false` is
 * the writer's own documented door for exactly that.
 */
function run(dir, argv, stdin) {
	return spawnSync(process.execPath, [SCRIPT, ...argv, '--no-push'], {
		encoding: 'utf8',
		input: stdin,
		env: cleanGitEnv({ FLEET_MANIFEST_DIR: dir }),
	});
}
const readManifest = (d) => JSON.parse(readFileSync(join(d, 'fleet-runner-manifest.json'), 'utf8'));

test('a clean proposal writes NOTHING and exits 1', () => {
	const d = site();
	const r = run(d, ['--stdin', '--json'], capture());
	// EXIT 1 ON SUCCESS is the design: a proposal is not a completed enrollment,
	// and anything treating "it printed something" as success would silently
	// never declare a node.
	assert.equal(r.status, 1, r.stderr);
	const out = JSON.parse(r.stdout);
	assert.equal(out.ok, true);
	assert.equal(out.written, false);
	assert.equal(out.node, 'claw-9');
	assert.deepEqual(Object.keys(readManifest(d).machines), ['claw-3'], 'the manifest was touched');
});

test('the proposal carries measurement and DERIVED placement — and never `ephemeral`', () => {
	const r = run(site(), ['--stdin', '--json'], capture());
	const e = JSON.parse(r.stdout).entry;
	assert.equal(e.cores, 8);
	assert.equal(e.ramGb, 15); // floor(16258756 / 1024 / 1024)
	assert.equal(e.$measured.memTotalMb, 15877, 'the unrounded figure has to survive');
	assert.deepEqual(e.$measured.capabilities, ['node20']);
	assert.deepEqual(
		e.$measured.unproven,
		['docker'],
		'a probe that said no is not a probe that ran'
	);
	assert.equal(e.$measured.verified, false, 'nothing re-probed this, and it must say so');

	// PLACEMENT MOVED, DELIBERATELY, 2026-09-22. `labels`, `maxRegistrations`,
	// `role`, `slice` and `minFreeGb` were once left for a human, and claw-9's
	// onboarding paid for each absence with a refusal, a hand edit or an alarm
	// (#50, #52). Under all-JIT none of them is a decision: `labels: []` IS the
	// shape (the fast loop grants standing eligibility once the node is safe;
	// a JIT node's labels ride the mint call), and the rest are fleet constants.
	// reconcile refuses a node with no `labels` ARRAY — that refusal is what
	// forced the first claw-9 hand edit.
	assert.deepEqual(e.labels, []);
	assert.equal(e.role, 'claw');
	assert.equal(e.maxRegistrations, 32);
	assert.equal(e.minFreeGb, 25);
	assert.deepEqual(e.slice, { swapMb: 4096, unitMaxMb: 4096 });

	// `ephemeral` is the one flag with an ordering dependency, and it is still
	// NEVER proposed: it may only be set once bootcamp has EARNED jitconfig on a
	// seeded payload, and `fleet provision` (which owns that order) flips it.
	// Enrollment-time `ephemeral: true` is the known way to mint runners a node
	// cannot start.
	assert.ok(!('ephemeral' in e), 'ephemeral is provision’s to flip, after jitconfig is earned');

	// CAPACITY MOVED, DELIBERATELY, 2026-09-08 (operator: "4 runners at 4gb
	// floor should be the cap"), and the rule still never guesses:
	// derivedCapacity returns null/null when MemTotal could not be read, and the
	// writer omits the fields entirely rather than writing a zero.
	assert.equal(e.maxConcurrent, 3, 'derived from 15877MB: floor((15877-2048)/4096)');
	assert.equal(e.minFreeMb, 2048, 'derived: 15877/8 rounded to 512, clamped [1536,8192]');
});

test('capacity is omitted, not zeroed, when memory could not be measured', () => {
	// `undefined` in these fields is the state ci-throttle.sh turns into
	// MAX_CONCURRENT=99, MIN_FREE_MB=0 — no limit, silently. So an unmeasured
	// node must carry NEITHER field rather than a defaulted one.
	// `capture` already takes field overrides, and `null` is how the parser
	// represents "unknown <reason>" — the record's own three-valued form.
	const r = run(
		site(),
		['--stdin', '--json'],
		capture({ memTotalKb: null }, { memTotalKb: '/proc/meminfo unreadable' })
	);
	const e = JSON.parse(r.stdout).entry;
	assert.ok(!('maxConcurrent' in e), 'no capacity from an unmeasured box');
	assert.ok(!('minFreeMb' in e), 'and no floor either');
});

test('--write declares the node — placement INCLUDED — and leaves the existing one alone', () => {
	const d = site();
	const r = run(d, ['--stdin', '--write', '--json'], capture());
	assert.equal(r.status, 0, r.stderr);
	const m = readManifest(d);
	const e = m.machines['claw-9'];
	assert.ok(e, 'the node was not written');
	// The four claw-9 hand edits, landed by the declaration itself (#50, #52):
	// The site repo's claw-cleanup gate would have gone red on a missing
	// minFreeGb, and reconcile would have refused a missing labels array.
	assert.deepEqual(e.labels, []);
	assert.equal(e.role, 'claw');
	assert.equal(e.maxRegistrations, 32);
	assert.equal(e.minFreeGb, 25);
	assert.deepEqual(e.slice, { swapMb: 4096, unitMaxMb: 4096 });
	assert.ok(
		!('ephemeral' in e),
		'the declaration never flips ephemeral — that waits for jitconfig'
	);
	// The existing human-tuned node is untouched.
	assert.deepEqual(m.machines['claw-3'].labels, ['hadoku-builder', 'jit-canary']);
	assert.equal(m.machines['claw-3'].$why, 'thermal demotion, hand written');
});

test('an already-declared node is REFUSED, not overwritten', () => {
	const d = site();
	const r = run(d, ['--stdin', '--write', '--json'], capture({ hostname: 'claw-3' }));
	assert.equal(r.status, 1);
	assert.match(JSON.parse(r.stdout).error, /ALREADY in the manifest/);
	const m = readManifest(d);
	assert.equal(m.machines['claw-3'].cores, 4, 'the human cores value was clobbered');
	assert.equal(m.machines['claw-3'].maxConcurrent, 3);
});

test('--update refreshes ONLY what was measured', () => {
	const d = site();
	const r = run(d, ['--stdin', '--update', '--json'], capture({ hostname: 'claw-3' }));
	assert.equal(r.status, 0, r.stderr);
	const e = readManifest(d).machines['claw-3'];
	assert.equal(e.cores, 8, 'the measured value did not land');
	assert.equal(e.ramGb, 15);
	assert.ok(e.$measured, 'provenance missing');
	assert.equal(e.$measured.verified, false, 'a capture must not record itself as verified');
	// Everything a human decided survives, untouched.
	assert.deepEqual(e.labels, ['hadoku-builder', 'jit-canary']);
	assert.equal(e.maxConcurrent, 3);
	assert.equal(e.maxRegistrations, 16);
	assert.equal(e.$why, 'thermal demotion, hand written');
});

test('a truncated record is refused — half a box must not read as a whole one', () => {
	const text = capture().replace(/ENROLL-END.*\n/, '');
	const r = run(site(), ['--stdin', '--json'], text);
	assert.equal(r.status, 1);
	assert.match(JSON.parse(r.stdout).error, /TRUNCATED/);
});

test('a capture with no record at all is refused', () => {
	const r = run(site(), ['--stdin', '--json'], 'just some apt output\n');
	assert.equal(r.status, 1);
	assert.match(JSON.parse(r.stdout).error, /ENROLL-BEGIN/);
});

test('a page of MemTotal drift is not a different machine', () => {
	// claw-6, 2026-09-02: record 8038384, re-probe 8038388. Four kilobytes. The
	// exact comparison refused the node and told its operator the capture came
	// from a different machine — a false accusation, and the kind that trains
	// people to reach for --force.
	const d = site();
	const r = run(
		d,
		['--stdin', '--write', '--json'],
		capture({ memTotalKb: FIELDS.memTotalKb + 4 })
	);
	assert.equal(r.status, 0, `a 4kB drift was treated as a conflict: ${r.stderr}`);
});

test('but a DIFFERENT machine still fails on memory', () => {
	// The tolerance must not swallow what the check exists for. Half the RAM is
	// a spliced capture or the wrong ssh target, not a rounding page.
	const d = site();
	const r = run(d, ['--stdin', '--write', '--json'], capture({ memTotalKb: 4194304 }));
	// No re-probe happens from a capture, so drive the comparison directly:
	// with no probe there is nothing to disagree with, and the write proceeds.
	// The tolerance itself is asserted on the arithmetic below.
	assert.equal(r.status, 0, 'a capture with no probe cannot conflict — that is by design');
	const src = readFileSync(join(HERE, '..', 'enroll-node.mjs'), 'utf8');
	const tol = Number(src.match(/const MEM_TOLERANCE = ([\d.]+)/)?.[1]);
	assert.ok(tol > 0 && tol <= 0.05, `the tolerance is ${tol}, which is not a rounding allowance`);
	// 8GB vs 4GB must be far outside it.
	assert.ok(Math.abs(8038384 - 4194304) / 8038384 > tol, 'half the RAM falls inside the tolerance');
});

// ═══════════════════════════════════════════════════════════════════════════
// THE ssh CONFIG IT WRITES — issue #8, the write side of "targets are names"
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A HOME of its own and an `ssh` that is not ssh.
 *
 * This writer edits `~/.ssh/config`, which is the one file on the control host
 * that — written wrongly — locks the operator out of the whole fleet. So the
 * test gives it a throwaway HOME and a stub on PATH, and then asserts on the
 * bytes rather than on the intention. `nameAnswers` is the lever: it is the set
 * of candidate names the stub lets a session open on, which is what separates
 * "a name resolves" from "a name works" — the distinction that decides whether
 * the entry survives a new DHCP lease.
 */
function sshStubHome({ nameAnswers = [], existingConfig = null } = {}) {
	const home = mkdtempSync(join(tmpdir(), 'fleet-enroll-home-'));
	made.push(home);
	mkdirSync(join(home, '.ssh'), { recursive: true });
	if (existingConfig !== null) writeFileSync(join(home, '.ssh', 'config'), existingConfig);

	const bin = join(home, 'bin');
	mkdirSync(bin, { recursive: true });
	const stub = join(bin, 'ssh');
	writeFileSync(
		stub,
		`#!/bin/sh
# -G <host>: ssh's own config dump. \`writeSshConfig\` reads it twice — once to
# ask whether the node ALREADY resolves (an operator's entry wins over ours),
# and once against claw-1 to derive User/IdentityFile rather than invent them.
for a in "$@"; do
  if [ "$a" = "-G" ]; then G=1; fi
done
if [ -n "\${G:-}" ]; then
  for a in "$@"; do case "$a" in -*) ;; *) H="$a";; esac; done
  echo "hostname $H"
  echo "user hadoku"
  echo "identityfile ~/.ssh/id_ed25519_hokon"
  exit 0
fi
# The name probe: the last argument is the literal \`true\`.
for a in "$@"; do LAST="$a"; done
if [ "$LAST" = "true" ]; then
  for a in "$@"; do case "$a" in *.local|*.ts.net) N="$a";; esac; done
  case " ${nameAnswers.join(' ')} " in
    *" \${N:-none} "*) exit 0 ;;
  esac
  echo "ssh: Could not resolve hostname \${N:-?}: Name or service not known" >&2
  exit 255
fi
# Anything else is sshCapture fetching the bootstrap log. Answer EMPTY: the run
# then dies on "no bootstrap log", which is several steps AFTER the ssh config
# has been written, so the file under test is on disk to assert against.
exit 0
`
	);
	chmodSync(stub, 0o755);
	return { home, bin, cfg: join(home, '.ssh', 'config') };
}

function runEnroll(dir, argv, home) {
	return spawnSync(process.execPath, [SCRIPT, ...argv, '--no-push'], {
		encoding: 'utf8',
		env: cleanGitEnv({
			FLEET_MANIFEST_DIR: dir,
			HOME: home.home,
			PATH: `${home.bin}:${process.env.PATH}`,
		}),
	});
}

test('ssh config: with no name reachable it writes the ADDRESS and says it is a lease pin', () => {
	// The fleet as measured 2026-09-26. Every candidate name fails, so the entry
	// falls back to the lease — and the thing that must NOT happen is it doing so
	// quietly. An address pin that does not announce itself is the 2026-09-07
	// SSID rename set up to strand a node again.
	const h = sshStubHome({ nameAnswers: [] });
	runEnroll(site(), ['--machine', 'claw-9', '--address', '192.0.2.121'], h);

	const cfg = readFileSync(h.cfg, 'utf8');
	assert.match(cfg, /^Host claw9 claw-9$/m);
	assert.match(cfg, /^ {4}HostName 192\.0\.2\.121$/m);
	assert.match(cfg, /# HostName: .*PINNED TO A DHCP LEASE/);
	// The REASON each name failed is carried into the file, because "fix the
	// Tailscale ACL" and "nothing publishes mDNS" are different jobs.
	assert.match(cfg, /claw-9\.local \(ssh: Could not resolve hostname/);
	// No `-lan` alias: the primary already IS the address, and a duplicate entry
	// would be a second thing to keep in step.
	assert.doesNotMatch(cfg, /Host claw9-lan/);
});

test('ssh config: a name that ANSWERS becomes the HostName, with the lease kept as -lan', () => {
	// The day the blocker clears — a Tailscale ACL flipped to `accept`, or avahi
	// on the claws — this is what the same code writes, with no edit.
	const h = sshStubHome({ nameAnswers: ['claw-9.local'] });
	runEnroll(site(), ['--machine', 'claw-9', '--address', '192.0.2.121'], h);

	const cfg = readFileSync(h.cfg, 'utf8');
	assert.match(cfg, /^Host claw9 claw-9$/m);
	assert.match(cfg, /^ {4}HostName claw-9\.local$/m);
	assert.doesNotMatch(cfg, /# HostName: .*PINNED TO A DHCP LEASE/);
	// The lease is not thrown away, it is demoted to a reachable fallback: a name
	// that stops resolving should cost one retry, not a trip to the garage.
	assert.match(cfg, /^Host claw9-lan claw-9-lan$/m);
	assert.match(cfg, /^ {4}HostName 192\.0\.2\.121$/m);
});

test('ssh config: a name that RESOLVES and then HANGS is not written', () => {
	// Tailscale SSH check-mode, verified against claw-1 on 2026-09-26 by tailnet
	// IP and by MagicDNS name: the name resolves, TCP connects, the session
	// opens, tailscaled prints "Tailscale SSH requires an additional check" with
	// a login URL, and then it sits there. Nothing fails. A writer that took "it
	// resolved" — or even "it connected" — as proof would pin the whole fleet
	// onto a target that never returns, and `ConnectTimeout` would never fire,
	// because the handshake SUCCEEDS. Only the hard timeout catches it.
	//
	// This test costs the suite the real 15s wait. That is the point: shortening
	// it would leave the timeout that does the work unexercised.
	const h = sshStubHome({ nameAnswers: [] });
	writeFileSync(
		join(h.bin, 'ssh'),
		`#!/bin/sh
for a in "$@"; do [ "$a" = "-G" ] && G=1; done
if [ -n "\${G:-}" ]; then
  for a in "$@"; do case "$a" in -*) ;; *) H="$a";; esac; done
  echo "hostname $H"; echo "user hadoku"; echo "identityfile ~/.ssh/id_ed25519_hokon"; exit 0
fi
for a in "$@"; do LAST="$a"; done
if [ "$LAST" = "true" ]; then
  echo "# Tailscale SSH requires an additional check."
  echo "# To authenticate, visit: https://login.tailscale.com/a/deadbeef"
  sleep 60
  exit 0
fi
exit 0
`
	);
	chmodSync(join(h.bin, 'ssh'), 0o755);
	runEnroll(site(), ['--machine', 'claw-9', '--address', '192.0.2.121'], h);

	const cfg = readFileSync(h.cfg, 'utf8');
	assert.match(cfg, /^ {4}HostName 192\.0\.2\.121$/m);
	assert.doesNotMatch(cfg, /^ {4}HostName claw-9\.(local|taild)/m);
	// And it says WHY — an interception, not a refusal. They need different fixes.
	assert.match(cfg, /never returned within 15s/);
});

test('ssh config: an entry the operator already has is left ALONE', () => {
	// ~/.ssh/config is the operator's file. An existing entry is a decision, not
	// drift to correct, and this writer only ever appends.
	const existing = 'Host claw-9\n    HostName 203.0.113.9\n';
	const h = sshStubHome({ nameAnswers: ['claw-9.local'], existingConfig: existing });
	// `ssh -G` reports a hostname different from the node name, which is the
	// signal that something already resolves it.
	writeFileSync(
		join(h.bin, 'ssh'),
		'#!/bin/sh\nfor a in "$@"; do [ "$a" = "-G" ] && G=1; done\n' +
			'if [ -n "${G:-}" ]; then echo "hostname 203.0.113.9"; echo "user hadoku"; ' +
			'echo "identityfile ~/.ssh/id_ed25519_hokon"; exit 0; fi\nexit 0\n'
	);
	chmodSync(join(h.bin, 'ssh'), 0o755);
	runEnroll(site(), ['--machine', 'claw-9', '--address', '192.0.2.121'], h);
	assert.equal(readFileSync(h.cfg, 'utf8'), existing, '~/.ssh/config was rewritten');
});

test('--hardware-changed names what changed, with a reason, on --update only', () => {
	// claw-6, 2026-10-27: 8 -> 16 GB. `--update` refused it as "not the box that
	// was bootstrapped". The acknowledgement is by name, never a --force.
	const err = (argv) =>
		JSON.parse(run(site(), ['--stdin', '--json', ...argv], capture()).stdout).error;
	assert.match(err(['--hardware-changed', 'memTotalKb', '--reason', 'upgrade']), /pass --update/);
	assert.match(
		err(['--update', '--hardware-changed', 'hostname', '--reason', 'x']),
		/accepts memTotalKb, cores; not hostname/
	);
	assert.match(err(['--update', '--hardware-changed', 'memTotalKb']), /needs --reason/);
	// A valid acknowledgement does not get in the way of an ordinary update.
	const d = site();
	const r = run(
		d,
		[
			'--stdin',
			'--update',
			'--json',
			'--hardware-changed',
			'memTotalKb',
			'--reason',
			'RAM 8 -> 16 GB',
		],
		capture({ hostname: 'claw-3' })
	);
	assert.equal(r.status, 0, r.stderr);
});
