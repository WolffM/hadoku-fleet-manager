/**
 * The egress taxonomy must stay a TAXONOMY, and its gate must keep reading the
 * kernel.
 *
 * `manifests/egress-slices.json` is fleet-manager's half of the split tunnel
 * agreed with local-hawk on 2026-09-05: we say which cgroups carry fleet work,
 * local-hawk owns the routing policy that acts on it. That boundary is only
 * worth anything if it holds in the source, so this file guards the two ways it
 * would quietly stop holding.
 *
 * The first half of this file pins the SHAPE of the reader and the manifest, as
 * `node-identity-guard` and `slice-placement-guard` beside it do.
 *
 * THE SECOND HALF RUNS THE THING. That half was added for issue #23, and the
 * issue is the argument for it: this gate had a deferral written specifically to
 * absorb a mid-restart app, a comment above it explaining why, and a placement
 * that made it unreachable for exactly that case. Every source-shape assertion
 * above passed the whole time, because the deferral was THERE — it just could
 * never run. A regex over source cannot see an ordering bug, and this repo has
 * now read a comment as evidence four times.
 *
 * So the restart cases are driven through the real script, spawned as the CLI
 * spawns it, against a `pm2` stub on PATH that answers a fixture. No export from
 * the script, no entry-point guard (a guard that mis-fires makes the gate print
 * nothing and exit 0, which is the failure this package least wants), and no
 * test hook in the production path — the only knob the tests set is
 * `FLEET_EGRESS_SETTLE_MS`, which can make the gate stricter and not laxer.
 *
 * THE THIRD SECTION IS THE DEPLOY MARKER (issue #31), and it is the only input
 * this gate has that is not observed state: mgmt-api writes
 * `~/.hadoku-mgmt/deploys-in-flight.json` while it is deploying, and the gate
 * reads it because 9 seconds of settle cannot cover a 19-second deploy and
 * lengthening the settle is forbidden. Reading a file written by the party it
 * excuses is a hazard, so every test there is about a way the exemption could
 * become unbounded or become a PASS: a stale entry, an entry from the future, a
 * file asking for a longer window than this gate allows, a corrupt file, a
 * marker over an `errored` or flapping app, and a marker naming the whole box.
 * The second knob the tests set — `HADOKU_STATE_DIR` — is the same variable
 * mgmt-api's own `deployMarkerPath()` honours, and `runGate` points it at an
 * empty directory on EVERY case so no test here can silently read the dev box's
 * real markers and pass for the wrong reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK = join(ROOT, 'scripts', 'check-egress-slices.mjs');
const MANIFEST = join(ROOT, 'manifests', 'egress-slices.json');

const source = readFileSync(CHECK, 'utf8');
// Every claim below is about CODE. This repo has read a COMMENT as evidence
// three times, and this file's own header names the very paths it forbids.
const blanked = blankComments(source);
const spec = JSON.parse(readFileSync(MANIFEST, 'utf8'));

void test('the manifest declares both halves of the fleet population', () => {
	const paths = spec.directEgress.map((d) => d.cgroup);
	assert.ok(
		paths.some((p) => p.includes('pm2-hadoku.service')),
		'the PM2 services cgroup must be declared direct-egress, or every hosted site egresses through a consumer VPN'
	);
	assert.ok(
		paths.some((p) => p.includes('ci-runner.slice')),
		'the CI runner slice must be declared direct-egress. Runners are NOT under system.slice — they ' +
			'live under user.slice, the same top-level branch as the desktop, so a rule written for PM2 ' +
			'alone pushes every runner through the tunnel.'
	);
});

void test('every declared cgroup is a prefix, so new services and JIT runners need no edit', () => {
	for (const d of spec.directEgress) {
		assert.ok(d.cgroup.startsWith('/'), `${d.cgroup} must be an absolute cgroup path`);
		assert.ok(
			!d.cgroup.endsWith('/') && !d.cgroup.includes('*'),
			`${d.cgroup} must be a plain prefix — the matcher uses startsWith, not a glob`
		);
	}
});

void test('the gate matches the cgroup by prefix, never by equality', () => {
	// A JIT runner lands in `<ci-runner.slice>/actions-runner-<repo>.service`, a
	// PM2 app in `<pm2-hadoku.service>` itself. Equality matches the second and
	// misses every runner, which is exactly the population the taxonomy was
	// widened to cover.
	assert.match(
		blanked,
		/cgroup\.startsWith\(/,
		'membership in a direct-egress cgroup must be a prefix test'
	);
	assert.ok(
		!/cgroup\s*===\s*(?:p\b|prefix)/.test(blanked),
		'a direct-egress cgroup must never be matched by equality'
	);
});

void test('pm_cwd is matched by prefix too — mgmt-api runs a level below the root', () => {
	// Measured 2026-09-05: mgmt-api's pm_cwd is `srv/hadoku_site/services/mgmt-api`.
	// An equality test on the ecosystem root scores the most important service on
	// the box as unclassified and fails a clean fleet.
	assert.ok(
		!/pm_cwd\s*===\s*ecoRoot|cwd\s*===\s*ecoRoot/.test(blanked),
		'the ecosystem root must be a prefix of pm_cwd, not equal to it'
	);
	assert.match(
		blanked,
		/ecoRoot/,
		'the ecosystem root must come from the manifest, not be spelled inline'
	);
});

void test('the population of a cgroup is read from the kernel, not from PM2', () => {
	// The first draft counted PM2 processes per prefix and reported the runner
	// slice EMPTY — true of PM2, false of the box: the 27 runner units are systemd
	// services PM2 has never heard of. A "is this populated" question answered by
	// a source that structurally cannot see the population is a wrong gate, not a
	// weak one.
	//
	// ASSERT THE CALL, NOT THE SUBSTRING. The first version of this test matched
	// a bare `/sys/fs/cgroup` and passed against a build that read `/nope`,
	// because the path also appears inside the missing-slice MESSAGE — prose
	// satisfying a rule about code, which is the same trap as reading a comment
	// as evidence and survives comment-blanking precisely because it is a string
	// the operator sees.
	assert.match(
		blanked,
		/join\(\s*'\/sys\/fs\/cgroup'/,
		'the cgroup path must be CONSTRUCTED from /sys/fs/cgroup, not merely mentioned'
	);
	assert.match(
		blanked,
		/readFileSync\(\s*join\([^)]*'cgroup\.procs'/,
		'population must be READ from cgroup.procs'
	);
});

void test('an unreadable or empty scan fails instead of reporting a clean box', () => {
	// "I could not look" must never render as "nothing is wrong" (CLAUDE.md).
	assert.match(
		blanked,
		/apps === null \|\| apps\.length === 0/,
		'PM2 being unreachable and PM2 reporting nothing must both be failures'
	);
	assert.match(
		blanked,
		/status:\s*'(?:missing-slice|empty-slice)'/,
		'a declared cgroup that holds nothing must be a finding — a policy keyed on it routes nothing and still looks green'
	);
});

void test('this gate specifies, and never applies — routing belongs to local-hawk', () => {
	// The boundary from the 2026-09-05 handoff, in the one place it can be
	// enforced. local-hawk asked specifically that we send requirements rather
	// than edits, because these files are how it reads the box.
	for (const forbidden of ['suricata', 'nft ', 'nftables', 'iptables', 'ip rule', 'nordvpn']) {
		assert.ok(
			!blanked.toLowerCase().includes(forbidden),
			`check-egress-slices must not touch ${forbidden}: fleet-manager specifies the taxonomy, ` +
				'local-hawk owns the routing policy and the sensors'
		);
	}
});

void test('every hokon-local exception carries a class and a reason', () => {
	// The exception list is the accepted-leak register. An entry with no reason
	// ages into "someone must have had one", which is how a leak becomes
	// permanent.
	for (const h of spec.hokonLocal) {
		assert.ok(h.app, 'an exception must name its app');
		assert.ok(h.class, `${h.app} must state its class`);
		assert.ok(h.why && h.why.length > 20, `${h.app} must say WHY it is not an ecosystem service`);
	}
});

// ── behaviour: a restart is tolerated, an outage is not (issue #23) ──────────

/**
 * Run the real script with a stubbed `pm2` on PATH.
 *
 * `samples` is what successive `pm2 jlist` calls answer; the last one repeats,
 * so a two-element list means "first sample, then this forever". The stub counts
 * its calls, which is how the tests below prove that a crash loop is rejected
 * WITHOUT paying the settle wait — a cheap bound firing late is a slow gate, and
 * a cheap bound not firing at all is a wrong one, and the call count is the only
 * thing that tells those apart from outside.
 */
function runGate(samples, opts = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'egress-slices-'));
	try {
		// A STATE DIR PER RUN, ALWAYS — even for the tests that say nothing about
		// deploy markers. Without it every case below would read the DEV BOX's
		// `~/.hadoku-mgmt/deploys-in-flight.json`, so the suite's answer would
		// depend on whether mgmt-api happened to be deploying while it ran. An
		// empty directory is the `absent` case, which is what those tests mean.
		const state = join(dir, 'state');
		mkdirSync(state, { recursive: true });
		if (opts.marker !== undefined) {
			writeFileSync(
				join(state, 'deploys-in-flight.json'),
				typeof opts.marker === 'string' ? opts.marker : JSON.stringify(opts.marker)
			);
		}
		// A FIXTURE TAXONOMY WHEN THE CASE IS ABOUT THE TAXONOMY (issue #68).
		//
		// The cases above are about PM2 STATE and read the repo's real manifest on
		// purpose — `anchor` is a genuine entry in it. The class-exemption cases are
		// about the MANIFEST, and pinning them to operator config would make the
		// suite's answer depend on which apps somebody has classified this week:
		// the `platform`-is-not-exempt case needs an entry the real file may not
		// keep, and the "an ecosystem service named hokon-local is still ecosystem"
		// case needs one the real file must never have. So those write their own,
		// through the same `FLEET_MANIFEST_DIR` production resolves.
		let manifestDir = join(ROOT, 'manifests');
		if (opts.spec) {
			manifestDir = join(dir, 'manifests');
			mkdirSync(manifestDir, { recursive: true });
			writeFileSync(join(manifestDir, 'egress-slices.json'), JSON.stringify(opts.spec));
		}
		samples.forEach((s, i) => writeFileSync(join(dir, `sample-${i}.json`), JSON.stringify(s)));
		const last = samples.length - 1;
		const stub = join(dir, 'pm2');
		writeFileSync(
			stub,
			'#!/usr/bin/env bash\n' +
				`n=$(cat "${dir}/calls" 2>/dev/null || echo 0)\n` +
				`echo $((n + 1)) > "${dir}/calls"\n` +
				`i=$n\n` +
				`if [ "$i" -gt ${last} ]; then i=${last}; fi\n` +
				`cat "${dir}/sample-$i.json"\n`
		);
		chmodSync(stub, 0o755);

		let stdout = '';
		let code = 0;
		try {
			stdout = execFileSync(process.execPath, [CHECK, '--json'], {
				encoding: 'utf8',
				cwd: ROOT,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: {
					...process.env,
					PATH: `${dir}:${process.env.PATH ?? ''}`,
					FLEET_MANIFEST_DIR: manifestDir,
					// The same variable mgmt-api's `deployMarkerPath()` honours.
					HADOKU_STATE_DIR: state,
					// Milliseconds instead of seconds. The bound under test is "does it
					// come back within the window", not the window's width.
					FLEET_EGRESS_SETTLE_MS: '5',
				},
			});
		} catch (err) {
			stdout = typeof err.stdout === 'string' ? err.stdout : '';
			code = typeof err.status === 'number' ? err.status : -1;
			if (!stdout.trim().startsWith('{')) {
				throw new Error(`the gate produced no JSON (exit ${code}): ${err.stderr ?? err.message}`);
			}
		}
		const calls = Number(readFileSync(join(dir, 'calls'), 'utf8').trim());
		return { report: JSON.parse(stdout), code, calls };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * An app with a pid the kernel will never have, so its cgroup cannot be read and
 * the only thing under test is the PM2-status path. `observedCgroup` treats a
 * pid of 0 as unreadable, which is also what PM2 reports for a stopped app.
 */
function app(name, pm2_env) {
	return {
		name,
		pid: 0,
		pm2_env: {
			status: 'online',
			pm_cwd: `/home/hadoku/srv/hadoku_site/apps/${name}`,
			unstable_restarts: 0,
			restart_time: 6,
			pm_uptime: Date.parse('2026-09-12T13:07:00Z'),
			...pm2_env,
		},
	};
}

/**
 * ONE APP THAT PASSES CLEANLY, in every fixture below.
 *
 * Without it every app in the fixture defers and the run trips the
 * `nothing-observed` bound — which is that bound working, but it would mask the
 * per-app answer each test is actually about. `pm2-logrotate` is a real
 * hokonLocal entry, and giving it this process's pid means its cgroup reads for
 * real, so it is classified rather than deferred wherever the suite runs.
 */
const anchor = {
	name: 'pm2-logrotate',
	pid: process.pid,
	pm2_env: {
		status: 'online',
		pm_cwd: '/home/hadoku/.pm2/modules/pm2-logrotate',
		unstable_restarts: 0,
		restart_time: 0,
	},
};

/** Findings ABOUT AN APP. Slice-level findings depend on which box runs the suite. */
const appFindings = (report) => (report.findings ?? []).filter((f) => f.name);

void test('an app caught mid-restart at 13:07 is deferred, not reported as not-running', () => {
	// The observed shape from issue #23: `ci:egress-slices` failed on 09-11 and
	// 09-12, both at 13:07 UTC, both in the wave after the 13:00 repo-sync deploy,
	// both naming tenhands-temporal as `not-running` with PM2 status "stopped" —
	// while unstable_restarts was 0 and it was back online moments later.
	const { report } = runGate([
		[anchor, app('tenhands-temporal', { status: 'stopped' })],
		[anchor, app('tenhands-temporal', { status: 'online' })],
	]);

	assert.deepEqual(
		appFindings(report).map((f) => `${f.name} [${f.status}]`),
		[],
		'a deploy restart must not be a finding — failing on every deploy is what teaches an operator to ignore this job'
	);
	assert.ok(
		report.deferred.some((d) => d.name === 'tenhands-temporal'),
		'it must still be REPORTED: its egress was not cross-checked on this run and silence would say it was'
	);
	assert.match(
		report.deferred.find((d) => d.name === 'tenhands-temporal').why,
		/came back to online/,
		'the deferral must say WHY it was tolerated — a reason-free deferral is indistinguishable from a gate that stopped looking'
	);
	assert.equal(report.examined, 2);
});

void test('an app that never comes back is still a finding, and says what it was at both samples', () => {
	// The other half, and the one that makes the first half safe. A gate that
	// tolerates "not online" unconditionally has stopped being a gate.
	const stopped = [anchor, app('tenhands-temporal', { status: 'stopped' })];
	const { report } = runGate([stopped, stopped]);

	const f = appFindings(report).find((x) => x.name === 'tenhands-temporal');
	assert.ok(f, 'an app stopped through the whole settle window must be a finding');
	assert.equal(f.status, 'not-running');
	assert.equal(f.pm2Status, 'stopped');
	assert.equal(f.settledStatus, 'stopped');
	assert.match(f.why, /still "stopped"/, 'the finding must name what the later sample said');
	assert.ok(
		!report.deferred.some((d) => d.name === 'tenhands-temporal'),
		'it must not appear as deferred as well — that would report the same app as both tolerated and failed'
	);
});

void test('a crash loop cannot buy tolerance by manufacturing a transient state', () => {
	// The trap this deferral is one bad edit away from: a process dying on boot
	// cycles through `launching` indefinitely, so a gate that defers on the STATE
	// would get easier to pass the worse the fault got. PM2's own
	// unstable_restarts counter settles it, and it settles it for free.
	const looping = [anchor, app('scraper', { status: 'launching', unstable_restarts: 4 })];
	const { report, calls } = runGate([looping, [anchor, app('scraper', { status: 'online' })]]);

	const f = appFindings(report).find((x) => x.name === 'scraper');
	assert.ok(f, 'launching with unstable_restarts > 0 is a crash loop, not a deploy');
	assert.equal(f.status, 'not-running');
	assert.equal(f.unstableRestarts, 4);
	assert.equal(
		calls,
		1,
		'the flap counter must be read BEFORE the settle window is paid for — otherwise a box full of ' +
			'crash-looping apps makes the gate slowest exactly when it is needed fastest'
	);
});

void test('errored and waiting-restart are never on the path back to online', () => {
	// `waiting restart` is PM2's backoff BETWEEN crashes, and `errored` is PM2
	// having given up. Deferring either would be deferring the failure itself.
	for (const status of ['errored', 'waiting restart', 'one-launch-status']) {
		const { report, calls } = runGate([
			[anchor, app('watchparty', { status })],
			[anchor, app('watchparty', { status: 'online' })],
		]);
		const f = appFindings(report).find((x) => x.name === 'watchparty');
		assert.ok(f, `status "${status}" must be a finding`);
		assert.equal(f.status, 'not-running');
		assert.equal(f.pm2Status, status);
		assert.equal(calls, 1, `status "${status}" must not spend the settle window`);
	}
});

// ── behaviour: a DEPLOY is not an outage either, and the marker may only defer
//    (issue #31) ─────────────────────────────────────────────────────────────

/**
 * The file mgmt-api writes while it is deploying, as the reader expects it.
 *
 * `ageMs` is how long ago the deploy started — the one number every test below
 * varies, because the whole safety argument for reading a file written by the
 * excused party is that the entry expires whether or not anyone cleans it up.
 */
function marker(service, ageMs, extra = {}) {
	return {
		version: 1,
		staleAfterMs: 15 * 60_000,
		deploys: [
			{
				service,
				deployName: service,
				deployId: 'deploy-1',
				startedAt: new Date(Date.now() - ageMs).toISOString(),
			},
		],
		...extra,
	};
}

void test('a stopped service with a LIVE deploy marker is deferred, not a finding', () => {
	// The filed bug: `check-egress-slices` waits 9s and a deploy takes ~19, so an
	// ordinary successful pygmalion deploy paged @here on 2026-09-07. Raising the
	// wait is forbidden — the bound is what stops a crash loop buying tolerance —
	// so the gate reads the fact instead.
	const down = [anchor, app('pygmalion', { status: 'stopped' })];
	const { report } = runGate([down, down], { marker: marker('pygmalion', 12_000) });

	assert.deepEqual(
		appFindings(report).map((f) => `${f.name} [${f.status}]`),
		[],
		'a deploy in flight must not page'
	);
	const d = report.deferred.find((x) => x.name === 'pygmalion');
	assert.ok(d, 'it must still be REPORTED — a deferral is not a pass');
	assert.equal(d.deferral, 'deploy-in-flight', 'the two kinds of deferral must be tellable apart');
	assert.equal(d.pm2Status, 'stopped', 'the deferral must carry what PM2 actually said');
	assert.match(d.why, /deploying since/, 'the deferral must say WHY it was tolerated');
	assert.ok(d.deployingSince, 'and WHEN, so a stuck deploy is legible without another tool');
	// NOT `assert.equal(code, 0)`. The exit code is `findings.length ? 1 : 0`
	// over ALL findings, including the slice-level ones that name no app — and
	// those depend on which box runs the suite, exactly as `appFindings` says
	// above. Asserting 0 here passed on a workstation and went red on claw-4,
	// which has no fleet slices to observe. The claim this test makes is about
	// pygmalion, so it is asserted about pygmalion. The `notEqual(code, 0)` in
	// the sibling cases stays sound in the other direction: an extra host
	// finding can only keep the code non-zero, never make it zero.
	assert.equal(
		(report.findings ?? []).filter((f) => f.name === 'pygmalion').length,
		0,
		'a deploy in flight must produce no finding about the deferred app'
	);

	// AND IT MUST NOT BE GREEN. A deferred app never reaches `ok`, and the report
	// says the run was partial.
	assert.ok(
		!(report.ok ?? []).some((o) => o.name === 'pygmalion'),
		'the marker must never be able to put an app in `ok` — it excuses a service being DOWN, nothing else'
	);
	assert.equal(report.markerFile.status, 'ok');
	assert.equal(report.markerFile.entries, 1);
});

void test('a STALE deploy marker excuses nothing — the 9s rule is unchanged', () => {
	// THE ASSERTION THE WHOLE MECHANISM RESTS ON. A `finally` does not survive a
	// SIGKILL or a reboot, and mgmt-api restarts often, so a crashed executor WILL
	// leave entries behind. If a stale entry were honoured, one interrupted deploy
	// would switch this gate off for that service permanently.
	const down = [anchor, app('pygmalion', { status: 'stopped' })];
	const { report, code } = runGate([down, down], {
		marker: marker('pygmalion', 15 * 60_000 + 30_000),
	});

	const f = appFindings(report).find((x) => x.name === 'pygmalion');
	assert.ok(f, 'a stale entry must not stop this being a finding');
	assert.equal(f.status, 'not-running');
	assert.ok(
		!report.deferred.some((x) => x.name === 'pygmalion'),
		'and it must not be deferred as well — that would report it as tolerated and failed at once'
	);
	assert.notEqual(code, 0);
});

void test('the READER owns the ceiling: a file asking for a longer window does not get one', () => {
	// The marker is written by the party it excuses. If `staleAfterMs` were taken
	// at face value, a writer could ask for a day — and "tolerate anything for a
	// day" is the unbounded wait this gate refuses, arriving through the field
	// that was supposed to bound it.
	const down = [anchor, app('pygmalion', { status: 'stopped' })];
	const { report } = runGate([down, down], {
		marker: {
			...marker('pygmalion', 20 * 60_000),
			staleAfterMs: 24 * 60 * 60_000,
		},
	});

	const f = appFindings(report).find((x) => x.name === 'pygmalion');
	assert.ok(
		f,
		'a 20-minute-old entry is past the READER’s 15-minute ceiling whatever the file asks'
	);
	assert.equal(f.status, 'not-running');
	assert.equal(
		report.markerFile.staleAfterMs,
		15 * 60_000,
		'the honoured window must be clamped to this gate’s own bound'
	);
});

void test('a marker whose startedAt is in the FUTURE is ignored, not eternal', () => {
	// A clock that jumped forward writes an entry whose age is always negative —
	// never past the bound. That is a permanent exemption arriving through the
	// staleness field itself.
	const down = [anchor, app('pygmalion', { status: 'stopped' })];
	const { report } = runGate([down, down], { marker: marker('pygmalion', -3_600_000) });

	const f = appFindings(report).find((x) => x.name === 'pygmalion');
	assert.ok(f, 'a future startedAt must not excuse a stopped service');
	assert.equal(f.status, 'not-running');
});

void test('a MISSING marker file is "no deploy in flight", never an error', () => {
	// This is what makes the landing order safe: this half can ship before
	// mgmt-api writes its first marker, and mgmt-api can stop writing them, and
	// neither breaks the gate. A missing file that errored would turn every box
	// without mgmt-api into a red one.
	const down = [anchor, app('pygmalion', { status: 'stopped' })];
	const { report, code } = runGate([down, down]);

	assert.ok(!report.error, 'an absent marker file must not be reported as a broken scan');
	assert.equal(report.markerFile.status, 'absent');
	const f = appFindings(report).find((x) => x.name === 'pygmalion');
	assert.ok(f, 'and the existing rule must apply unchanged');
	assert.equal(f.status, 'not-running');
	assert.notEqual(code, 0);
});

void test('a CORRUPT marker file grants no exemption, is not an error, and says why', () => {
	// A half-written document is exactly what an atomic writer exists to prevent
	// and exactly what this reader must survive anyway. Empty is the STRICT
	// direction — the unmodified 9s rule — and the reason has to survive into the
	// report or a marker written to the wrong shape is indistinguishable from one
	// never written at all.
	for (const [body, expected] of [
		['{ "deploys": [ {"service": "half-writt', 'malformed'],
		['null', 'malformed'],
		[JSON.stringify({ version: 1, deploys: 'not-an-array' }), 'malformed'],
	]) {
		const down = [anchor, app('pygmalion', { status: 'stopped' })];
		const { report, code } = runGate([down, down], { marker: body });

		assert.ok(!report.error, `a ${expected} marker file must not read as a broken scan`);
		assert.equal(report.markerFile.status, expected);
		assert.ok(
			report.markerFile.reason,
			'and it must say WHY — a reason-free refusal is unactionable'
		);
		const f = appFindings(report).find((x) => x.name === 'pygmalion');
		assert.ok(f, `a ${expected} marker must not excuse a stopped service`);
		assert.equal(f.deployMarkers, expected, 'the finding must name what the marker file was');
		assert.notEqual(code, 0);
	}
});

void test('a marker cannot rescue an errored app, or one PM2 scores as flapping', () => {
	// THE POSITION OF THE READ IS THE SAFETY PROPERTY. The marker is consulted
	// only after the cheap observed-state bounds have already fired, so it can
	// downgrade a not-running finding to a deferral and can do nothing else. If
	// either case below ever defers, the marker has become a way to switch the
	// gate off from outside it.
	for (const pm2_env of [
		{ status: 'errored' },
		{ status: 'waiting restart' },
		{ status: 'stopped', unstable_restarts: 4 },
	]) {
		const down = [anchor, app('pygmalion', pm2_env)];
		const { report, code } = runGate([down, down], { marker: marker('pygmalion', 5_000) });

		const f = appFindings(report).find((x) => x.name === 'pygmalion');
		assert.ok(f, `status "${pm2_env.status}" must stay a finding even mid-deploy`);
		assert.equal(f.status, 'not-running');
		assert.ok(
			!report.deferred.some((x) => x.name === 'pygmalion'),
			`status "${pm2_env.status}" must not be deferred by a marker`
		);
		assert.notEqual(code, 0);
	}
});

void test('a marker naming every app is still a scan that observed nothing', () => {
	// The way this mechanism could be turned into an off switch: write a marker
	// for the whole box. It cannot be, because the aggregate bound counts
	// DEFERRALS and does not care which kind they are.
	const blind = [
		app('tenhands', { status: 'stopped' }),
		app('tenhands-temporal', { status: 'stopped' }),
	];
	const { report, code } = runGate([blind, blind], {
		marker: {
			version: 1,
			staleAfterMs: 15 * 60_000,
			deploys: ['tenhands', 'tenhands-temporal'].map((service) => ({
				service,
				deployId: `d-${service}`,
				startedAt: new Date().toISOString(),
			})),
		},
	});

	assert.equal(report.deferred.length, 2);
	assert.ok(
		report.findings.some((f) => f.status === 'nothing-observed'),
		'deferring the whole box is an unreadable box, however it was deferred'
	);
	assert.notEqual(code, 0, 'and it must fail the run');
});

void test('a marker for one service does not excuse another', () => {
	const down = [
		anchor,
		app('pygmalion', { status: 'stopped' }),
		app('watchparty', { status: 'stopped' }),
	];
	const { report } = runGate([down, down], { marker: marker('pygmalion', 5_000) });

	assert.deepEqual(
		appFindings(report).map((f) => f.name),
		['watchparty'],
		'only the service actually being deployed may be deferred'
	);
	assert.deepEqual(
		report.deferred.map((d) => d.name),
		['pygmalion']
	);
});

void test('deferring EVERY app is a scan that observed nothing, and fails', () => {
	// The aggregate bound. Each per-app deferral is sound because the rest of the
	// run still cross-checks the rest of the box; nothing in that reasoning covers
	// the run where no app is cross-checked at all — which is what a gate running
	// as a user that cannot read /proc looks like.
	const blind = [app('tenhands', {}), app('tenhands-temporal', {})];
	const { report, code } = runGate([blind, blind]);

	assert.equal(report.deferred.length, 2, 'both apps are online with an unreadable cgroup');
	assert.ok(
		report.findings.some((f) => f.status === 'nothing-observed'),
		'a run that compared not one observed cgroup against a declared class is an unreadable box, not a clean one'
	);
	assert.notEqual(code, 0, 'and it must fail the run, not merely mention it');
});

// ── behaviour: a class with no fleet role is DORMANT when it is not running,
//    and NOTHING else is (issue #68) ─────────────────────────────────────────

/**
 * A fixture taxonomy: the real direct-egress prefixes and ecosystem root, with a
 * `hokonLocal` register the case under test controls.
 *
 * The prefixes and the root come from the repo manifest because those are the
 * parts every case here wants to be REAL — the exemption's whole safety argument
 * is that `declaredOf` resolves the ecosystem PREFIX before it ever looks at the
 * register, and a made-up root would not test that. Only the register varies.
 */
function specWith(hokonLocal) {
	return {
		directEgress: spec.directEgress,
		ecosystemRoot: spec.ecosystemRoot,
		hokonLocal: [FIXTURE_ANCHOR_ENTRY, ...hokonLocal],
	};
}

/**
 * ONE ONLINE APP THAT CLASSIFIES CLEANLY under a fixture taxonomy, so the run
 * never trips `nothing-observed` and each case's own claim is what is under
 * test. Its pid is this process's, so its cgroup reads for real wherever the
 * suite runs. The `pm2-logrotate` anchor above cannot serve here: these cases
 * need the register's `platform` entry to be a controlled variable.
 */
const FIXTURE_ANCHOR_ENTRY = {
	app: 'fixture-anchor',
	class: 'hokon-local',
	why: 'the fixture anchor — an online hokon-local app, so the run observes at least one cgroup.',
};
const fixtureAnchor = {
	name: 'fixture-anchor',
	pid: process.pid,
	pm2_env: {
		status: 'online',
		pm_cwd: '/home/hadoku/fixture-anchor',
		unstable_restarts: 0,
		restart_time: 0,
	},
};

/** A non-ecosystem app, as `valheim` actually is on hokon: pid 0, its own root. */
function local(name, pm2_env) {
	return {
		name,
		pid: 0,
		pm2_env: {
			status: 'online',
			pm_cwd: '/mnt/games/valheim-server',
			unstable_restarts: 0,
			restart_time: 0,
			...pm2_env,
		},
	};
}

const REGISTER_WHY =
	'Valheim dedicated game server under /mnt/games/valheim-server — the operator’s game box, no fleet role.';
const valheimSpec = specWith([{ app: 'valheim', class: 'hokon-local', why: REGISTER_WHY }]);

void test('a stopped hokon-local app is dormant, not a finding, and costs no settle window', () => {
	// The filed bug, as observed: `ci:egress-slices` failed at 13:07:26Z on
	// 2026-09-28 naming `valheim` and `valheim-panel` [not-running], PM2 status
	// "stopped", after 9000ms and 3 re-reads. Both are `class: hokon-local`, which
	// the taxonomy header defines as apps that "run under PM2 but are NOT hadoku
	// ecosystem services" with "no fleet role" — and both documented escapes are
	// forbidden by that same header, so there was no operator workaround.
	const down = [fixtureAnchor, local('valheim', { status: 'stopped' })];
	const { report, calls } = runGate([down, down], { spec: valheimSpec });

	assert.deepEqual(
		appFindings(report).map((f) => `${f.name} [${f.status}]`),
		[],
		'an app the taxonomy says has no fleet role must not page for not running'
	);
	assert.equal(
		calls,
		1,
		'and it must not spend the settle window: none of those bounds is ABOUT this class, ' +
			'and the two stopped apps on hokon were burning 9s of a 60s cron budget every run'
	);

	const d = (report.dormant ?? []).find((x) => x.name === 'valheim');
	assert.ok(d, 'it must still be REPORTED — a dormant app is a third answer, not a pass');
	assert.equal(d.class, 'hokon-local');
	assert.equal(d.pm2Status, 'stopped', 'the report must carry what PM2 actually said');
	assert.match(
		d.why,
		/no fleet role|NO fleet role/,
		'and WHY it was exempt, not merely that it was'
	);

	// THE REGISTER MUST NOT QUIETLY SHRINK. `acceptedLeaks` lists what is leaking
	// NOW, so a stopped app correctly leaves it — and an operator reading
	// acceptedLeaks fall from 5 to 3 as "two leaks closed" is exactly how a named
	// decision ages into nobody noticing it.
	assert.ok(
		!(report.acceptedLeaks ?? []).some((l) => l.name === 'valheim'),
		'a stopped app is not leaking, so it must not be counted as a live accepted leak'
	);
	assert.equal(d.registeredAcceptedLeak, true, 'but it must say it is still ON the register');
	assert.equal(d.registeredWhy, REGISTER_WHY, 'carrying the reason the register gave it');

	// AND IT MUST NOT BE GREEN, OR A DEFERRAL.
	assert.ok(
		!(report.ok ?? []).some((o) => o.name === 'valheim'),
		'`ok` claims an observed cgroup, and there is no process to observe'
	);
	assert.ok(
		!(report.deferred ?? []).some((x) => x.name === 'valheim'),
		'`deferred` promises the next tick resolves it; a game server the operator turned off does not'
	);
});

void test('a stopped ECOSYSTEM service is STILL a finding — the half a lazy fix breaks', () => {
	// The load-bearing half. The reasoning the `not-running` branch gives — "a
	// service that is not running has no egress to classify, and an audit that
	// skipped it would report a clean box" — is exactly right here and must be
	// untouched. mgmt-api down is a fleet fact; valheim down is not.
	const down = [fixtureAnchor, app('mgmt-api', { status: 'stopped' })];
	const { report, code } = runGate([down, down], { spec: valheimSpec });

	const f = appFindings(report).find((x) => x.name === 'mgmt-api');
	assert.ok(f, 'a stopped ecosystem service must still fail the gate');
	assert.equal(f.status, 'not-running');
	assert.equal(f.settledStatus, 'stopped');
	assert.ok(
		!(report.dormant ?? []).some((x) => x.name === 'mgmt-api'),
		'and it must never be exempted as dormant'
	);
	assert.notEqual(code, 0);
});

void test('naming an ecosystem service in the register cannot buy it the exemption', () => {
	// A REAL FAILURE MUST NOT BE ABLE TO MANUFACTURE THIS CATEGORY. The obvious
	// route is a reclassification: put the most important service on the box in
	// the register as hokon-local and stop it. `declaredOf` resolves the ecosystem
	// PREFIX on pm_cwd BEFORE it consults the register, so the register cannot
	// demote an app that lives under the ecosystem root — and that ordering, not
	// anyone's good intentions, is what closes this.
	const down = [fixtureAnchor, app('mgmt-api', { status: 'stopped' })];
	const { report, code } = runGate([down, down], {
		spec: specWith([
			{ app: 'mgmt-api', class: 'hokon-local', why: 'a reclassification that must not work.' },
		]),
	});

	const f = appFindings(report).find((x) => x.name === 'mgmt-api');
	assert.ok(f, 'pm_cwd under the ecosystem root must win over a register entry');
	assert.equal(f.status, 'not-running');
	assert.ok(!(report.dormant ?? []).some((x) => x.name === 'mgmt-api'));
	assert.notEqual(code, 0);
});

void test('the exemption keys on the `class` field, never on membership of the register', () => {
	// THE WIDENED-EXEMPTION BUG, and the reason this test exists rather than a
	// comment saying not to write it: `hokonLocal` is the accepted-leak REGISTER
	// and is not uniformly hokon-local. `pm2-logrotate` sits in it under
	// `class: platform` — PM2's own module, maintaining the process manager — and
	// a fix that exempted everything in the array would exempt the process
	// manager going down. Membership means "somebody decided about this app"; the
	// class field is what they decided.
	const down = [
		fixtureAnchor,
		{
			name: 'pm2-logrotate',
			pid: 0,
			pm2_env: {
				status: 'stopped',
				pm_cwd: '/home/hadoku/.pm2/modules/pm2-logrotate',
				unstable_restarts: 0,
			},
		},
	];
	const { report, code } = runGate([down, down], {
		spec: specWith([
			{
				app: 'pm2-logrotate',
				class: 'platform',
				why: "PM2's own module. In the register, and NOT hokon-local.",
			},
		]),
	});

	const f = appFindings(report).find((x) => x.name === 'pm2-logrotate');
	assert.ok(f, 'a `platform` app in the register is not exempt — only `hokon-local` is');
	assert.equal(f.status, 'not-running');
	assert.ok(
		!(report.dormant ?? []).some((x) => x.name === 'pm2-logrotate'),
		'exempting the whole array is the widened-exemption bug this test exists to catch'
	);
	assert.notEqual(code, 0);
});

void test('a class that is missing, empty or misspelled is not exempt', () => {
	// The other way a fault reaches the category: not a reclassification but a
	// DAMAGED one. A register entry with no class, an empty one, or a typo must
	// all read as "nobody decided", which is stricter than hokon-local and not
	// laxer. Nothing here may be dormant.
	for (const entry of [
		{ app: 'valheim', why: 'an entry whose class key never got written.' },
		{ app: 'valheim', class: '', why: 'an entry whose class is an empty string.' },
		{ app: 'valheim', class: 'hokon_local', why: 'an underscore instead of a hyphen.' },
		{ app: 'valheim', class: 'HOKON-LOCAL', why: 'the right word in the wrong case.' },
	]) {
		const down = [fixtureAnchor, local('valheim', { status: 'stopped' })];
		const { report, code } = runGate([down, down], { spec: specWith([entry]) });

		assert.ok(
			!(report.dormant ?? []).some((x) => x.name === 'valheim'),
			`class ${JSON.stringify(entry.class)} must not open the exemption`
		);
		const f = appFindings(report).find((x) => x.name === 'valheim');
		assert.ok(f, `class ${JSON.stringify(entry.class)} must still be a finding`);
		assert.notEqual(code, 0);
	}
});

void test('a dormant app counts toward nothing-observed, so the exemption is no off switch', () => {
	// THE AGGREGATE BOUND, WHICH IS WHAT STOPS THIS BEING A WAY TO EMPTY THE RUN.
	// A PM2 list holding nothing but stopped hokon-local apps compares not one
	// observed cgroup against a declared class — and it is also a box that has
	// lost the entire ecosystem, so it is the least clean box there is. If
	// `nothing-observed` counted only `deferred`, it would report green.
	const blind = [
		local('valheim', { status: 'stopped' }),
		local('valheim-panel', { status: 'stopped' }),
	];
	const { report, code } = runGate([blind, blind], {
		spec: specWith([
			{ app: 'valheim', class: 'hokon-local', why: REGISTER_WHY },
			{
				app: 'valheim-panel',
				class: 'hokon-local',
				why: 'the admin panel beside it, no fleet role.',
			},
		]),
	});

	assert.equal((report.dormant ?? []).length, 2);
	assert.ok(
		report.findings.some((f) => f.status === 'nothing-observed'),
		'a run that cross-checked nothing is an unreadable box, however the apps were skipped'
	);
	assert.notEqual(code, 0, 'and it must fail the run');
});

void test('the exemption is flat across PM2 states, so it never widens as a fault deepens', () => {
	// The decision, written down where it can be checked. `stopped`, `errored`,
	// PM2's backoff and a crash loop are ALL exempt for this class, and that is
	// not "easier to pass the worse it gets": the rule forbids an exemption that
	// WIDENS with severity, and this one has the same width at every severity.
	// Walk the branches for `declared === 'hokon-local'` and `not-running` is the
	// only finding it can produce — `unclassified` cannot fire (it is classified),
	// `ecosystem-outside-direct` cannot (it is not ecosystem) and the cgroup
	// cross-check resolves to `ok` either way. So the exemption costs no coverage
	// at any severity, and an errored game server is as much none of this gate's
	// business as a cleanly stopped one.
	for (const pm2_env of [
		{ status: 'stopped' },
		{ status: 'errored' },
		{ status: 'waiting restart' },
		{ status: 'launching', unstable_restarts: 4 },
	]) {
		const down = [fixtureAnchor, local('valheim', pm2_env)];
		const { report, calls } = runGate([down, down], { spec: valheimSpec });

		const d = (report.dormant ?? []).find((x) => x.name === 'valheim');
		assert.ok(d, `status "${pm2_env.status}" must be dormant for a hokon-local app`);
		assert.equal(d.pm2Status, pm2_env.status, 'and must report the state it was actually in');
		assert.ok(
			!appFindings(report).some((f) => f.name === 'valheim'),
			`status "${pm2_env.status}" must not also be a finding`
		);
		assert.equal(calls, 1, `status "${pm2_env.status}" must not spend the settle window`);
	}
	// AND THE SAME STATES STAY FATAL FOR AN ECOSYSTEM SERVICE. Asserted in the
	// same test as the claim it bounds, so a future widening cannot delete half.
	for (const pm2_env of [{ status: 'errored' }, { status: 'launching', unstable_restarts: 4 }]) {
		const down = [fixtureAnchor, app('pygmalion', pm2_env)];
		const { report, code } = runGate([down, down], { spec: valheimSpec });
		const f = appFindings(report).find((x) => x.name === 'pygmalion');
		assert.ok(f, `an ecosystem service in "${pm2_env.status}" must still fail`);
		assert.equal(f.status, 'not-running');
		assert.notEqual(code, 0);
	}
});

void test('a deploy marker cannot make a dormant app green, and never needs to', () => {
	// The marker MAY ONLY DEFER, NEVER PASS, and the exemption must not have
	// opened a second door to `ok`. A hokon-local app is not something mgmt-api
	// deploys, but a marker naming one must still change nothing: dormant, not
	// `ok`, not `deferred`, and the deferral machinery untouched.
	const down = [fixtureAnchor, local('valheim', { status: 'stopped' })];
	const { report } = runGate([down, down], {
		spec: valheimSpec,
		marker: marker('valheim', 5_000),
	});

	assert.ok((report.dormant ?? []).some((x) => x.name === 'valheim'));
	assert.ok(
		!(report.ok ?? []).some((o) => o.name === 'valheim'),
		'nothing may put a not-running app in `ok`'
	);
	assert.ok(
		!(report.deferred ?? []).some((x) => x.name === 'valheim'),
		'the dormant branch fires first, so the marker is never even read for it'
	);
	assert.equal(
		report.markerFile.status,
		'unread',
		'and a dormant app must not open the marker file — a box with nothing moving does no file IO'
	);
});

void test('an app with no pm_cwd is unclassified, not dormant — the exemption needs a class', () => {
	// `no-cwd` fires BEFORE the not-running block, which is what guarantees the
	// exemption can never be reached by an app whose class could not be decided.
	// Ordering, again, rather than an assertion about intent.
	const down = [fixtureAnchor, { name: 'valheim', pid: 0, pm2_env: { status: 'stopped' } }];
	const { report, code } = runGate([down, down], { spec: valheimSpec });

	const f = appFindings(report).find((x) => x.name === 'valheim');
	assert.ok(
		f,
		'an app whose class cannot be decided must fail whatever its name is in the register'
	);
	assert.equal(f.status, 'no-cwd');
	assert.ok(!(report.dormant ?? []).some((x) => x.name === 'valheim'));
	assert.notEqual(code, 0);
});

void test('the dormant decision is a strict equality on one class, not a set or a lookup', () => {
	// A SOURCE GUARD, and the file's own header says why one is worth having next
	// to the behavioural tests above: they prove the gate rejects `platform`
	// TODAY, and this pins the SHAPE that keeps it rejecting a class nobody has
	// thought of yet. A `Set` or an `exceptions.has(name)` test would pass every
	// case above and still be the widened exemption.
	assert.match(
		blanked,
		/const DORMANT_EXEMPT_CLASS = 'hokon-local';/,
		'the exempt class must be one exact string in one place'
	);
	assert.match(
		blanked,
		/declared === DORMANT_EXEMPT_CLASS/,
		'the exemption must be a strict equality against that constant'
	);
	assert.ok(
		!/DORMANT_EXEMPT_CLASS\s*=\s*new Set|DORMANT_EXEMPT_CLASS\.(?:has|includes)\(/.test(blanked),
		'a family of exempt classes is the widened exemption — keep it one string'
	);
});
