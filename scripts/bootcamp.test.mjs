/**
 * `fleet bootcamp` — WHO IT REACHES, run for real.
 *
 * The file had no test. What it needed one for is not the earned/unearned
 * arithmetic — `capabilities.test.ts` covers the registry and
 * `bootcamp-required.test.mjs` covers the lib — but the SELECTION, because until
 * 2026-09-15 the guest rule lived here as a comment saying bootcamp "must not be
 * pointed at a guest in the first place" with nothing enforcing it. CLAUDE.md
 * records four separate times a COMMENT has been read as evidence in this
 * codebase. This is the guard behind the fifth.
 *
 * WHY A GUEST MUST NOT BE BOOTCAMPED, in one line each:
 *   - it is the fleet chain at full stretch on a box that is none of its
 *     business (operator, 2026-09-14), and `--write` records a verdict about it;
 *   - and since 2026-09-26 `pm2-capable` proves a supervisor by PROVISIONING
 *     one — an npm install, a started process, a killed and resurrected daemon.
 *     41 MB and five seconds on a claw; on the production host, a second pm2
 *     beside the one supervising mgmt-api, the tunnel and the other production services.
 *
 * The third reason this file used to give has EXPIRED and is recorded rather
 * than quietly dropped: "the verdict would be WRONG — a guest's labels stay
 * DECLARED, so since #6 made `pm2-host` probe-verified the run reports UNEARNED
 * against the one label the six infra workflows route on". Wave 3o narrowed that
 * probe to "is a pm2 daemon alive here supervising something", which the
 * production host passes, so the false finding is gone. The RULE is unaffected:
 * the fleet is not entitled to probe a guest, whatever the answer would be.
 *
 * NO REAL NODE IS REACHED. Every fixture machine resolves nowhere (`.invalid`),
 * so `isLocalNode` is false and nothing in this file can contact a box.
 *
 * THE WRITER IS EXERCISED SINCE 2026-09-24, AGAINST A FIXTURE AND NEVER A REAL
 * MANIFEST (issue #59). The selection tests below still pass no `--write`; the
 * idempotence tests at the bottom do, against a throwaway git repo of their own
 * with a canned probe answer. That is the only way to observe the property that
 * matters — `bootcamp --write` lands a COMMIT, and the question is whether a
 * run that found nothing new makes one.
 *
 * TWO THINGS MAKE THAT SAFE, and both are load-bearing:
 *   - `ssh` is SHIMMED onto PATH, so the probe's answer is a fixture rather
 *     than a box. `runOn` spawns `ssh` by name, which is what makes this
 *     possible without a hook into the transport layer.
 *   - `--no-push` stops at the commit, in a repo with no remote, under the
 *     fixture identity from `lib/test-git-identity.mjs` — stated with
 *     `git config --file`, naming the target file, because a bare
 *     `git config user.email` is a write whose destination `cwd` does not
 *     decide, and that is how 59 commits on main came to be authored by a
 *     fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeProof, proofPath } from './lib/job-proof-record.mjs';
import { cleanGitEnv, FIXTURE_IDENTITY } from './lib/test-git-identity.mjs';
import { SEED_DISK_FLOOR_MB } from './lib/capability-seeds.mjs';
import { writeProof } from '../dist/lib/measured.js';

/**
 * Every fixture claw is asked for the JDK (toolchain-floor.mjs `jdk21` applies
 * to every claw since 2026-10-24) and answers as a node that already carries
 * one: present, never installed, never logged, so each call log stays about
 * the tool its test is testing. Matched on `javac -d "$d"`, text only the
 * REPAIRS detect contains — capability-probe.sh compiles the same class under
 * other variable names, and a broader match would answer the probe itself.
 */
const JDK_PRESENT_CASE = `  *'javac -d "$d"'*) echo OK; exit 0 ;;`;

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

/** Names that resolve NOWHERE, and are not this box. */
const CLAW = 'fixture-claw-1.invalid';
const GUEST = 'fixture-guest.invalid';

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fleet-bootcamp-'));
	const manifestDir = join(root, 'manifests');
	const stateDir = join(root, 'state');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	const manifestPath = join(manifestDir, 'fleet-runner-manifest.json');
	writeFileSync(
		manifestPath,
		JSON.stringify(
			{
				toolchain: { capabilities: [] },
				machines: {
					[CLAW]: { role: 'claw', labels: [], maxConcurrent: 2, minFreeMb: 1024 },
					// Declares pm2-host and does NOT carry it in any record — exactly the
					// shape that becomes a false UNEARNED finding if the guest is probed.
					[GUEST]: { role: 'guest', labels: ['pm2-host', 'taskauto'], minFreeMb: 8192 },
				},
			},
			null,
			2
		)
	);
	return {
		root,
		manifestPath,
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: manifestDir,
			HADOKU_STATE_DIR: stateDir,
			HADOKU_SITE_ROOT: root,
		},
	};
}

/** `{code, out, err}` — stdout and stderr kept APART: `--json` is stdout's. */
function run(args, env) {
	try {
		return {
			code: 0,
			out: execFileSync(process.execPath, [join(SCRIPTS, 'bootcamp.mjs'), ...args], {
				encoding: 'utf8',
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 120_000,
			}),
			err: '',
		};
	} catch (e) {
		return { code: e.status ?? 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
	}
}

test('NAMED, the guest-role node is bootcamped CHECK-ONLY: probed, and nothing installed (operator, 2026-10-09)', () => {
	// "totally fine to bootcamp hokon. but i would say dont do all the regular
	// automation. i want to hand approve when new capabilities are install on
	// hokon." The fixture node does not resolve, so the probe's attempt shows up
	// as unreachable — proof it was TRIED — while no tool install was attempted.
	const f = fixture();
	try {
		const r = run(['--machine', GUEST, '--json'], f.env);
		const report = JSON.parse(r.out);
		assert.ok(report.unreachable.includes(GUEST), 'it was probed, not refused');
		assert.deepEqual(report.tools[GUEST], [], 'and nothing was installed — installs are by hand');
		assert.ok(!(GUEST in report.roleDeclared), 'not reported as "not probed"');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a fleet-wide run skips the guest, SAYS SO, and never folds it into the pass', () => {
	const f = fixture();
	try {
		const r = run(['--json'], f.env);
		const report = JSON.parse(r.out);

		assert.ok(!(GUEST in report.report), 'a guest must produce no bootcamp verdict');
		assert.ok(
			!report.unreachable.includes(GUEST),
			'and it can never be "unreachable" — nothing tried to reach it'
		);
		// NOT DROPPED. "I was not entitled to look" is a third answer, and a
		// machine that vanishes from a report is one nobody can tell was
		// considered — which is how this rule went unenforced for as long as it
		// did.
		assert.deepEqual(report.roleDeclared[GUEST], ['pm2-host', 'taskauto']);
		assert.ok(!(CLAW in report.roleDeclared), 'a claw earns its labels, it does not declare them');

		// The claw WAS attempted, so the run is not vacuously clean, and the
		// skipped guest did not buy a pass.
		assert.deepEqual(report.unreachable, [CLAW]);
		assert.equal(report.ok, false);
		assert.equal(r.code, 1);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('the guest is not contacted at all, which is what makes UNEARNED unreachable', () => {
	// THE ASSERTION IS THE CONTACT, and it outlived the finding it was written
	// for. `pm2-host` has been `verify: 'probe'` since #6, and until wave 3o the
	// unearned/unclaimed loop WOULD have reported the guest's declared label as
	// "work routes here and fails" — about the machine that genuinely runs PM2.
	// That probe is narrower now and the guest would pass it; what has not
	// changed is that nothing may REACH the box, which is what this asserts and
	// what `pm2-capable`'s provisioning install makes sharper than ever.
	//
	// WHAT THIS CAN AND CANNOT PROVE, because the first draft got it wrong and the
	// mutation caught it. It cannot produce the UNEARNED finding itself: a fixture
	// host resolves nowhere, so a guest with the role filter removed comes back
	// UNREACHABLE rather than probed, and asserting "no UNEARNED" alone passed
	// with the guard deleted. A test that cannot fail is worse than no test.
	//
	// So the assertion is the CONTACT, which is the precondition for the finding
	// and is observable here: the guest must appear in neither the probe results
	// nor the "could not probe" line — absent from both means nothing tried. The
	// no-UNEARNED check stays as the statement of intent, second.
	const f = fixture();
	try {
		const r = run([], f.env);
		const all = r.out + r.err;
		assert.ok(
			!new RegExp(`could not probe:.*${GUEST.replace(/\./g, '\\.')}`).test(all),
			`nothing may try to reach a guest, got:\n${all}`
		);
		assert.ok(!/UNEARNED/.test(all), `no UNEARNED finding expected, got:\n${all}`);
		assert.match(r.out, /GUEST — not probed, not written/);
		assert.match(r.out, /pm2-host, taskauto/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a run of only guests still FAILS LOUDLY rather than passing on zero nodes', () => {
	// Zero probed yields zero findings, which is byte-identical to a healthy
	// fleet — the shape `check-capability-schema` already refuses for a manifest
	// of no machines.
	const f = fixture();
	try {
		const doc = JSON.parse(readFileSync(f.manifestPath, 'utf8'));
		delete doc.machines[CLAW];
		writeFileSync(f.manifestPath, JSON.stringify(doc, null, 2));
		const r = run(['--json'], f.env);
		assert.equal(r.code, 1);
		assert.equal(r.out.trim(), '', 'no clean report from a run that probed nobody');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a run without --write leaves the manifest byte-identical', () => {
	// The refusal path runs before every other guard in the script, so this is
	// belt and braces on the fixture as much as on the reporting path.
	const f = fixture();
	try {
		const before = readFileSync(f.manifestPath, 'utf8');
		run(['--json'], f.env);
		run(['--machine', GUEST, '--json'], f.env);
		assert.equal(readFileSync(f.manifestPath, 'utf8'), before, 'byte-identical');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ── `--write` IS IDEMPOTENT (issue #59) ─────────────────────────────────────
//
// `$capabilities.at` was stamped fresh on every pass, so a node whose probe
// returned exactly what it returned last time still produced a changed file —
// and this writer lands its writes as COMMITS on hadoku_site, whose
// `redeploy-mgmt-api.yml` filters on that path. Every no-op bootcamp therefore
// restarted the production API. claw-9, 2026-09-23: `538c9d00` and `3faeb8fe`,
// eleven minutes apart, one changed line each, and the line was `at`.
//
// THE ASSERTION IS THE COMMIT COUNT, not the diff. "The diff looked small" is
// what let this run for months; a commit is what the redeploy filter actually
// sees, so a commit is what this counts.

/** A fixture whose manifest lives in a throwaway git repo this test may commit to. */
function writableFixture(
	probeAnswer,
	{
		labels = [],
		claudePresent = false,
		failInstall = false,
		// THE RELEASE LOOKUP, CANNED (issue #70). `ensureTools` now resolves
		// claude's install target through `resolveInstallTarget` before it will
		// install anything, and this suite runs offline — it must not depend on
		// reaching npm to stay deterministic. Defaults to a known, debounce-cleared
		// release so every existing install scenario is unaffected; pass
		// `npmUnknown` to exercise the "could not look" refusal instead.
		npmVersion = '9.9.9',
		npmUnknown = null,
	} = {}
) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-bootcamp-write-'));
	const manifestDir = join(root, 'manifests');
	const stateDir = join(root, 'state');
	const bin = join(root, 'bin');
	for (const d of [manifestDir, stateDir, bin]) mkdirSync(d, { recursive: true });

	const releaseLookupFile = join(root, 'release-lookup.json');
	writeFileSync(
		releaseLookupFile,
		JSON.stringify(
			npmUnknown
				? { status: 'unknown', reason: npmUnknown }
				: { status: 'known', version: npmVersion, publishedAt: new Date(0).toISOString() }
		)
	);

	const manifestPath = join(manifestDir, 'fleet-runner-manifest.json');
	writeFileSync(
		manifestPath,
		JSON.stringify(
			{
				toolchain: { capabilities: ['ffmpeg'] },
				machines: { [CLAW]: { role: 'claw', labels, maxConcurrent: 2, minFreeMb: 1024 } },
			},
			null,
			2
		) + '\n'
	);

	// THE PROBE'S ANSWER, CANNED. `runOn` spawns `ssh` by name, so a shim on
	// PATH is the whole hook — no transport-layer seam, and nothing here can
	// reach a real box even if the name resolved.
	const answerFile = join(root, 'probe-answer.txt');
	writeFileSync(answerFile, probeAnswer);
	const sshShim = join(bin, 'ssh');
	// THE FIXTURE NODE. It classifies the script it is handed by content and keeps
	// a call log, so ORDER is observable: DETECT / INSTALL / PROBE. The `claude`
	// tool is a flag file — present from the start, or created by an INSTALL.
	const calls = join(root, 'calls.log');
	const flag = join(root, 'claude-installed');
	// THE INSTALL SCRIPT, CAPTURED VERBATIM — so a test can assert what version
	// it was pinned to (`TARGET_VERSION=...`) rather than only that an install
	// was attempted.
	const installScriptLog = join(root, 'install-script.txt');
	if (claudePresent) writeFileSync(flag, '');
	writeFileSync(
		sshShim,
		[
			'#!/bin/sh',
			'# fixture ssh — classify the script on stdin, answer like a node would',
			'script="$(cat)"',
			`case "$script" in`,
			JDK_PRESENT_CASE,
			`  *claude.ai/install.sh*)`,
			`    echo INSTALL >>${JSON.stringify(calls)}`,
			`    printf '%s' "$script" >${JSON.stringify(installScriptLog)}`,
			failInstall
				? `    echo 'curl: (6) Could not resolve host: claude.ai' >&2; exit 6 ;;`
				: `    : >${JSON.stringify(flag)}; exit 0 ;;`,
			`  *"claude --version"*)`,
			`    echo DETECT >>${JSON.stringify(calls)}`,
			`    [ -e ${JSON.stringify(flag)} ] && echo OK; exit 0 ;;`,
			`  *)`,
			`    echo PROBE >>${JSON.stringify(calls)}`,
			`    exec cat ${JSON.stringify(answerFile)} ;;`,
			`esac`,
			'',
		].join('\n')
	);
	chmodSync(sshShim, 0o755);

	const env = cleanGitEnv({
		FLEET_MANIFEST_DIR: manifestDir,
		HADOKU_STATE_DIR: stateDir,
		HADOKU_SITE_ROOT: root,
		PATH: `${bin}:${process.env.PATH}`,
		FLEET_TEST_RELEASE_LOOKUP: releaseLookupFile,
	});
	const git = (...a) => execFileSync('git', a, { cwd: root, env, encoding: 'utf8' });
	git('init', '-q', '-b', 'main');
	// NAMED WITH `--file`, never a bare `git config user.email`: the destination
	// of a bare one is decided by GIT_DIR / GIT_CONFIG* / a worktree's shared
	// common dir, not by cwd. `landWrite` strips every GIT_* from the
	// environment it hands git (it has to — a hook's GIT_DIR would otherwise
	// redirect the commit), so the identity cannot ride in on the environment
	// here the way it does everywhere else in this suite.
	const cfg = join(root, '.git', 'config');
	git('config', '--file', cfg, 'user.name', FIXTURE_IDENTITY.name);
	git('config', '--file', cfg, 'user.email', FIXTURE_IDENTITY.email);
	git('add', '-A');
	git('commit', '-q', '-m', 'base');

	return {
		root,
		manifestPath,
		env,
		answer: (text) => writeFileSync(answerFile, text),
		calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
		installScript: () =>
			existsSync(installScriptLog) ? readFileSync(installScriptLog, 'utf8') : null,
		commits: () => Number(git('rev-list', '--count', 'HEAD').trim()),
		record: () =>
			JSON.parse(readFileSync(manifestPath, 'utf8')).machines[CLAW].$capabilities ?? null,
	};
}

const PROBE_ANSWER = (ffmpegDetail) =>
	['CAP ffmpeg ok ' + ffmpegDetail, 'PROBE-END', ''].join('\n');

test('two consecutive --write runs on an unchanged node produce ONE commit, not two', () => {
	const f = writableFixture(PROBE_ANSWER('7.1.5-0+deb13u1'));
	try {
		const base = f.commits();

		const first = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.equal(first.code, 0, `first run failed:\n${first.out}\n${first.err}`);
		assert.equal(f.commits(), base + 1, 'the first run must record the finding');
		const recorded = f.record();
		assert.ok(recorded, 'no $capabilities written');
		assert.deepEqual(recorded.earned, ['ffmpeg']);

		// THE WHOLE ISSUE. Same node, same answer, nothing to say.
		const second = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.equal(second.code, 0, `second run failed:\n${second.out}\n${second.err}`);
		assert.equal(
			f.commits(),
			base + 1,
			'a re-probe that found nothing new committed anyway — every such commit ' +
				"redeploys mgmt-api through hadoku_site's path filter (#59)"
		);
		assert.equal(f.record().at, recorded.at, '`at` moved with no change behind it');
		assert.match(second.out, /re-probed and UNCHANGED/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('`at` still advances, and a commit is still made, when the finding really changes', () => {
	// The other half, and the one a naive "stop rewriting the record" fix loses.
	const f = writableFixture(PROBE_ANSWER('7.1.5-0+deb13u1'));
	try {
		const base = f.commits();
		assert.equal(run(['--machine', CLAW, '--write', '--no-push'], f.env).code, 0);
		const before = f.record();

		f.answer(PROBE_ANSWER('7.2.0-1'));
		const r = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.equal(f.commits(), base + 2, 'a changed finding must land');
		const after = f.record();
		assert.deepEqual(after.prereqs, [{ id: 'ffmpeg', detail: '7.2.0-1' }]);
		assert.ok(
			Date.parse(after.at) > Date.parse(before.at),
			`at did not advance on a real change: ${before.at} -> ${after.at}`
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ── `pm2-capable` is EARNED, and `pm2-host` is not earned by being able to ──
//
// Wave 3o, lane C. The two questions were one id until 2026-09-26 and merging
// them routes a production deploy onto the wrong box: six workflows carry
// `runs-on: [self-hosted, pm2-host]`, and `nodeOffer` puts every earned identity
// LABEL onto a node's registrations and JIT mints. These run the real
// `bootcamp.mjs` against a canned probe answer, so what is asserted is what the
// writer actually records.

/** A probe answer carrying both pm2 verdicts, as a real claw returns them. */
const PM2_ANSWER = (hostVerdict, capableVerdict) =>
	[
		'CAP ffmpeg ok 7.1.5-0+deb13u1',
		`CAP pm2-host ${hostVerdict}`,
		`CAP pm2-capable ${capableVerdict}`,
		'PROBE-END',
		'',
	].join('\n');

test('a claw that proves pm2-capable earns it, and does NOT earn pm2-host', () => {
	// claw-9's real answer, 2026-09-26: the supervisor installed, supervised,
	// survived a daemon kill/resurrect and was removed; no pm2 daemon runs there,
	// so `pm2-host` is `no absent`.
	const f = writableFixture(PM2_ANSWER('no absent', 'ok 32003'));
	try {
		assert.equal(run(['--machine', CLAW, '--write', '--no-push'], f.env).code, 0);
		const rec = f.record();
		assert.ok(rec.earned.includes('pm2-capable'), `pm2-capable not earned: ${rec.earned}`);
		// THE ONE THAT MATTERS. Being ABLE to host must never make a claw the
		// host — `$capabilities.earned` is what `nodeOffer` derives a node's
		// GitHub label set from.
		assert.ok(
			!rec.earned.includes('pm2-host'),
			`a claw that can host must not be routed the six infra workflows: ${rec.earned}`
		);
		assert.deepEqual(rec.unclaimed, [], 'pm2-capable is implicit — it is not a label to claim');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('below the declared bar, pm2-capable is NOT earned and the run says the number', () => {
	// claw-6's real answer, 2026-09-26: 7,849 MiB installed against a role
	// measured at 9,784 MiB steady. The supervisor worked perfectly — `ok` means
	// "I measured it", and the registry's bar is what refuses it.
	const f = writableFixture(PM2_ANSWER('no absent', 'ok 7849'));
	try {
		const r = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.ok(!f.record().earned.includes('pm2-capable'));
		// AND THE REASON IS IN THE REPORT. An absence with no reason behind it is
		// the "I could not look renders as nothing is wrong" shape, one level
		// down: a firewall, a dead dump file and 8 GB of RAM are three different
		// jobs and this is the only line that tells them apart.
		assert.match(r.out, /not earned: pm2-capable — installed memory 7849MiB < 9784MiB required/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a pm2-capable probe that could not run reports its reason, not a small box', () => {
	const f = writableFixture(PM2_ANSWER('no absent', 'no supervisor-install-failed'));
	try {
		const r = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.ok(!f.record().earned.includes('pm2-capable'));
		assert.match(r.out, /not earned: pm2-capable — supervisor-install-failed/);
		assert.ok(!/not earned: pm2-capable — installed memory/.test(r.out));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a second --write on an unchanged pm2-capable node still commits nothing (#59)', () => {
	// The property #59 bought, asserted against the capability this lane added —
	// because the reason a re-probe stays silent is that nothing PER-RUN reaches
	// the record, and a MEASURED capability is exactly the kind of thing that
	// would break it. `pm2-capable`'s measurement is installed memory, which does
	// not move; its `meetsBar` reason, which does not move either, stays on
	// stdout and out of the record on purpose.
	const f = writableFixture(PM2_ANSWER('no absent', 'ok 32003'));
	try {
		const base = f.commits();
		assert.equal(run(['--machine', CLAW, '--write', '--no-push'], f.env).code, 0);
		assert.equal(f.commits(), base + 1);
		const first = f.record();

		const second = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.equal(second.code, 0, `${second.out}\n${second.err}`);
		assert.equal(
			f.commits(),
			base + 1,
			'an idempotent re-probe committed, which redeploys mgmt-api'
		);
		assert.equal(f.record().at, first.at);
		assert.match(second.out, /re-probed and UNCHANGED/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ── INSTALL ON ASSIGNMENT (#69, wave 3q lane D) ─────────────────────────────
//
// `taskauto` is ROLE-assigned: bootcamp cannot earn it, so "assigned" is read
// from the same `nodeOffer` derivation the mint uses (via `applicableRepairs`).
// The fixture node logs every script it is handed as DETECT / INSTALL / PROBE.

const FFMPEG_ONLY = PROBE_ANSWER('7.1.5-0+deb13u1');
const args = ['--machine', CLAW, '--write', '--no-push'];

test('an assigned node missing claude gets it installed BEFORE the probe', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'] });
	try {
		const r = run(args, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		// detect (absent) -> install -> detect again (verifies) -> probe.
		assert.deepEqual(f.calls(), ['DETECT', 'INSTALL', 'DETECT', 'PROBE']);
		assert.match(r.out, /installed: claude/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

/**
 * THE MUTATION SIGNAL FOR #70. Pre-fix, `ensureTools` called
 * `installScript(id)` with no version at all, so the node's script never
 * pinned anything and the vendor's `install.sh` ran with no `$TARGET_VERSION`
 * — vendor-latest, bypassing the debounce on exactly this path. The resolved,
 * debounce-cleared release (`npmVersion` on the fixture) must appear in the
 * script actually handed to the node.
 */
test('the install is PINNED to the debounced release the lookup resolved, never bare', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'], npmVersion: '2.1.283' });
	try {
		const r = run(args, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.match(
			f.installScript(),
			/TARGET_VERSION='2\.1\.283'/,
			'the resolved release must be pinned into the script, not left to vendor-latest'
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

/**
 * "COULD NOT LOOK" REFUSES, IT NEVER FALLS BACK (issue #70). A registry that
 * cannot say what the debounced release is must not be read as "nothing to
 * pin" and fall through to a bare, vendor-latest install — the exact bypass
 * this lane exists to close. The install must never even be ATTEMPTED.
 */
test('a lookup that cannot resolve the debounce is a FAILURE, and the install never runs', () => {
	const f = writableFixture(FFMPEG_ONLY, {
		labels: ['taskauto'],
		npmUnknown: 'registry answered HTTP 429',
	});
	try {
		const r = run([...args, '--json'], f.env);
		assert.equal(r.code, 1, 'an unresolved debounce must fail the run');
		const doc = JSON.parse(r.out);
		assert.equal(doc.ok, false);
		const t = doc.tools[CLAW].find((x) => x.id === 'claude');
		assert.equal(t.action, 'failed');
		assert.match(t.detail, /could not determine the debounced release/);
		assert.match(t.detail, /429/, 'the reason upstream gave must be carried, not swallowed');
		// detect (absent) -> PROBE. No INSTALL: the bare vendor-latest install
		// never ran, and nothing was ever handed to the node to run it.
		assert.deepEqual(f.calls(), ['DETECT', 'PROBE']);
		assert.equal(f.installScript(), null, 'no install script reached the node at all');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a node that is NOT assigned taskauto gets nothing installed and is not asked', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: [] });
	try {
		const r = run(args, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.deepEqual(f.calls(), ['PROBE'], 'a tool for a capability the node lacks was touched');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a node that already carries claude is detected and left alone — no install, no write', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'], claudePresent: true });
	try {
		const base = f.commits();
		assert.equal(run(args, f.env).code, 0);
		assert.deepEqual(f.calls(), ['DETECT', 'PROBE']);
		const after = f.commits();
		// The one write is the first capability record; the install path added none.
		assert.equal(after, base + 1);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a failed install is a FAILURE carrying its reason, never a silent earned', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'], failInstall: true });
	try {
		const r = run([...args, '--json'], f.env);
		assert.equal(r.code, 1, 'an install that failed must fail the run');
		const doc = JSON.parse(r.out);
		assert.equal(doc.ok, false);
		const t = doc.tools[CLAW].find((x) => x.id === 'claude');
		assert.equal(t.action, 'failed');
		assert.match(t.detail, /Could not resolve host: claude\.ai/);
		// install ran once and was NOT retried into a verdict.
		assert.deepEqual(f.calls(), ['DETECT', 'INSTALL', 'PROBE']);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('installing on assignment keeps --write idempotent: the second run installs and commits nothing (#59)', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'] });
	try {
		const base = f.commits();
		assert.equal(run(args, f.env).code, 0);
		assert.equal(f.commits(), base + 1);
		const first = f.record();

		const second = run(args, f.env);
		assert.equal(second.code, 0, `${second.out}\n${second.err}`);
		assert.equal(f.commits(), base + 1, 'a re-run committed — that redeploys mgmt-api (#59)');
		assert.equal(f.record().at, first.at);
		assert.equal(
			f.calls().filter((c) => c === 'INSTALL').length,
			1,
			'the tool was installed twice'
		);
		assert.match(second.out, /re-probed and UNCHANGED/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ── JOB PROOFS ARE REPORTED, NEVER WRITTEN OR REQUIRED (wave 3q lane E) ──────
//
// `fleet prove-job` records into the STATE directory; bootcamp only reads it.
// A proof in the manifest would be a commit and a commit restarts mgmt-api (#59).

const PROOF_RESULT = {
	capability: 'taskauto',
	repo: 'WolffM/hadoku-tenhands',
	workflow: 'test.yml',
	job: 'backend pytest',
	verdict: 'pass',
	ok: true,
	runId: 4242,
	jobId: 1,
	runnerName: 'jit-fixture-proof-hadoku-tenhands-j0-r0-1',
	jobConclusion: 'success',
	ranOnTarget: true,
	evidence: ['claude resolved'],
	finishedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
};

const writeLedger = (f, result) =>
	writeFileSync(
		proofPath(f.env.HADOKU_STATE_DIR),
		JSON.stringify(mergeProof({}, CLAW, result), null, 2)
	);

test('a node that carries taskauto reports its last job-proof and its age — and it is not a finding', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'], claudePresent: true });
	try {
		writeLedger(f, PROOF_RESULT);
		const r = run([...args, '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const row = JSON.parse(r.out).report[CLAW].jobProofs.find((p) => p.id === 'taskauto');
		assert.equal(row.state, 'pass');
		assert.match(row.line, /PASSED .*\(3\.0 h ago\), run 4242 on jit-fixture-proof/);
		const human = run(args, f.env);
		assert.match(human.out, /job-proof: taskauto — PASSED/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('no proof on record is said plainly, with the command — and never fails the run', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'], claudePresent: true });
	try {
		const r = run(args, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.match(
			r.out,
			/job-proof: taskauto — never proved by a job here \(fleet prove-job --node/
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a node that does not carry a job-proofed capability says nothing about it', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: [] });
	try {
		writeLedger(f, PROOF_RESULT);
		const r = run([...args, '--json'], f.env);
		assert.deepEqual(JSON.parse(r.out).report[CLAW].jobProofs, []);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a proof on record does not reach the manifest: --write stays idempotent (#59)', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'], claudePresent: true });
	try {
		const base = f.commits();
		assert.equal(run(args, f.env).code, 0);
		assert.equal(f.commits(), base + 1);
		const first = f.record();
		writeLedger(f, PROOF_RESULT);
		const second = run(args, f.env);
		assert.equal(second.code, 0, `${second.out}\n${second.err}`);
		assert.equal(f.commits(), base + 1, 'a proof made a manifest commit, which redeploys mgmt-api');
		assert.deepEqual(f.record(), first);
		assert.equal(
			JSON.stringify(f.record()).includes('4242'),
			false,
			'the proof leaked into $capabilities'
		);
		assert.match(second.out, /re-probed and UNCHANGED/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('an unreadable proof ledger is SAID, not read as "no proofs"', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'], claudePresent: true });
	try {
		writeFileSync(proofPath(f.env.HADOKU_STATE_DIR), '{ broken');
		const r = run([...args, '--json'], f.env);
		assert.equal(r.code, 0, 'the node is not at fault');
		const doc = JSON.parse(r.out);
		assert.match(doc.jobProofLedgerError, /job-proofs\.json/);
		assert.deepEqual(doc.report[CLAW].jobProofs, []);
		assert.match(run(args, f.env).out, /job-proof ledger unreadable/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ── EARNED CAPABILITIES COME WITH THEIR ARTIFACTS (#102, wave 4c lane E) ─────
//
// bootcamp runs the real `fleet-manager` process, so this is the end-to-end
// proof `capability-seeds.test.mjs`'s pure fakes cannot give: the SAME ssh
// shim already carrying DETECT/INSTALL/PROBE gains three more branches, and a
// NEW `gh` shim on PATH stands in for the controller's own `gh` — resolving
// the seed's repo, pin and script text. Nothing here reaches a real host or a
// real GitHub repo.

const FORGE_REPO = 'WolffM/hadoku-cardtable';
const FORGE_PIN = 'deadbeef00112233445566778899aabbccddeeff';

/**
 * `writableFixture` plus a manifest `$seeds` entry and two extra shims: `ssh`
 * gains branches for the busy check, the disk check and the seed run itself
 * (classified the same way the existing shim classifies DETECT/INSTALL/PROBE —
 * by the shape of the script it is handed); `gh` is new, resolving the
 * repo/pin/script the controller would fetch for real.
 *
 * `busy`/`freeKb` control the two live checks' answers; `seedOutcome` controls
 * what the seed run itself reports: `'hit'` (the default), `'silent'` (exits 0
 * but proves nothing — the "neither HIT nor BUILD" finding), or `'fail'`
 * (non-zero, carrying a reason).
 */
function seedingFixture({
	busy = false,
	freeKb = (SEED_DISK_FLOOR_MB + 1024) * 1024,
	seedOutcome = 'hit',
} = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-bootcamp-seed-'));
	const manifestDir = join(root, 'manifests');
	const stateDir = join(root, 'state');
	const bin = join(root, 'bin');
	for (const d of [manifestDir, stateDir, bin]) mkdirSync(d, { recursive: true });

	const releaseLookupFile = join(root, 'release-lookup.json');
	writeFileSync(
		releaseLookupFile,
		JSON.stringify({ status: 'known', version: '9.9.9', publishedAt: new Date(0).toISOString() })
	);

	const manifestPath = join(manifestDir, 'fleet-runner-manifest.json');
	writeFileSync(
		manifestPath,
		JSON.stringify(
			{
				toolchain: { capabilities: ['ffmpeg'] },
				machines: { [CLAW]: { role: 'claw', labels: [], maxConcurrent: 2, minFreeMb: 1024 } },
				$seeds: {
					jdk21: {
						repo: FORGE_REPO,
						script: 'scripts/forge-bundle.sh',
						argument: { kind: 'submodule-pin', submodule: 'forge', ref: 'default' },
						cache: '~/.cache/cardtable-forge',
					},
				},
			},
			null,
			2
		) + '\n'
	);

	const calls = join(root, 'calls.log');
	const answerFile = join(root, 'probe-answer.txt');

	// THE SHIM DOES NOT EXECUTE THE PIPED SCRIPT — it classifies it by substring
	// and echoes a CANNED answer, exactly like the existing DETECT/INSTALL/PROBE
	// branches. So the canned HIT line embeds the pin as a JS-side LITERAL
	// (`FORGE_PIN`), never a shell `$CARDTABLE_FORGE_PIN` reference: that
	// variable was only ever set inside the piped script's own text, which this
	// shim never runs, so referencing it here would expand to empty and the
	// pin field never found by the proof's regex. Caught by running this fixture
	// once and reading its OWN output back before trusting it.
	const sshShim = join(bin, 'ssh');
	const seedRunBody = (() => {
		if (seedOutcome === 'fail')
			return 'echo "forge-bundle: mvn build failed for forge pin" >&2; exit 1';
		if (seedOutcome === 'silent') return 'exit 0';
		return [
			`echo "forge-bundle: HIT: pin ${FORGE_PIN} already cached at /fixture/cache" >&2`,
			'echo "CARDTABLE_FORGE_JAR=/fixture/cache/forge.jar"',
			'echo "CARDTABLE_FORGE_RES=/fixture/cache/res"',
		].join('\n');
	})();
	writeFileSync(
		sshShim,
		[
			'#!/bin/sh',
			'script="$(cat)"',
			'case "$script" in',
			JDK_PRESENT_CASE,
			'  *claude.ai/install.sh*)',
			`    echo INSTALL >>${JSON.stringify(calls)}; exit 0 ;;`,
			'  *"claude --version"*)',
			`    echo DETECT >>${JSON.stringify(calls)}; exit 0 ;;`,
			'  *"pgrep -x Runner.Worker"*)',
			`    echo BUSY-CHECK >>${JSON.stringify(calls)}`,
			busy ? '    echo BUSY; exit 0 ;;' : '    echo IDLE; exit 0 ;;',
			'  *"df -Pk"*)',
			`    echo DISK-CHECK >>${JSON.stringify(calls)}`,
			`    printf '%s\\n' ${freeKb}; exit 0 ;;`,
			'  *CARDTABLE_FORGE_PIN*)',
			`    echo SEED-RUN >>${JSON.stringify(calls)}`,
			`    ${seedRunBody}`,
			'    ;;',
			'  *)',
			`    echo PROBE >>${JSON.stringify(calls)}`,
			`    exec cat ${JSON.stringify(answerFile)} ;;`,
			'esac',
			'',
		].join('\n')
	);
	chmodSync(sshShim, 0o755);

	// THE CONTROLLER'S OWN `gh`, SHIMMED. Three calls, matched on the exact path
	// `resolveSeed` builds: repo info (default branch), the submodule's pinned
	// commit, the script's base64 content. Anything else is a hard failure —
	// nothing here should ask `gh` for a fourth thing.
	const ghShim = join(bin, 'gh');
	const scriptB64 = Buffer.from(
		'#!/usr/bin/env bash\necho fixture-forge-bundle\n',
		'utf8'
	).toString('base64');
	writeFileSync(
		ghShim,
		[
			'#!/bin/sh',
			'path="$2"',
			'case "$path" in',
			`  "repos/${FORGE_REPO}")`,
			'    echo \'{"default_branch":"main"}\'; exit 0 ;;',
			`  "repos/${FORGE_REPO}/contents/forge?ref=main")`,
			`    echo '{"type":"submodule","sha":"${FORGE_PIN}"}'; exit 0 ;;`,
			`  "repos/${FORGE_REPO}/contents/scripts/forge-bundle.sh?ref=main")`,
			`    echo '{"encoding":"base64","content":"${scriptB64}"}'; exit 0 ;;`,
			'  *)',
			'    echo "fixture gh: unexpected call: $*" >&2; exit 1 ;;',
			'esac',
			'',
		].join('\n')
	);
	chmodSync(ghShim, 0o755);

	const env = {
		...process.env,
		FLEET_MANIFEST_DIR: manifestDir,
		HADOKU_STATE_DIR: stateDir,
		HADOKU_SITE_ROOT: root,
		PATH: `${bin}:${process.env.PATH}`,
		FLEET_TEST_RELEASE_LOOKUP: releaseLookupFile,
	};

	return {
		root,
		manifestPath,
		env,
		answer: (text) => writeFileSync(answerFile, text),
		calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
	};
}

const JDK21_ANSWER = ['CAP ffmpeg ok 7.1.5-0+deb13u1', 'CAP jdk21 ok 21.0.1', 'PROBE-END', ''].join(
	'\n'
);
const NO_JDK21_ANSWER = ['CAP ffmpeg ok 7.1.5-0+deb13u1', 'PROBE-END', ''].join('\n');

test('a node that just earned the seeded capability is seeded, through real ssh/gh shims', () => {
	const f = seedingFixture();
	try {
		f.answer(JDK21_ANSWER);
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		// PROBE comes first: bootcamp probes the node BEFORE it knows what the
		// node earned, and seeding is decided from that fresh `earned` set.
		assert.deepEqual(f.calls(), ['PROBE', 'BUSY-CHECK', 'DISK-CHECK', 'SEED-RUN']);
		const seedRow = doc.seeds[CLAW].find((s) => s.id === 'jdk21');
		assert.equal(seedRow.status, 'seeded');
		assert.equal(seedRow.proof, 'HIT');
		assert.equal(seedRow.pin, FORGE_PIN);
		assert.match(run(['--machine', CLAW, '--no-push'], f.env).out, /seeded:\s+jdk21 — HIT/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a node that did NOT earn the seeded capability costs zero busy/disk/seed calls', () => {
	const f = seedingFixture();
	try {
		f.answer(NO_JDK21_ANSWER);
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.deepEqual(f.calls(), ['PROBE'], 'no busy check, no disk check, no seed run');
		const doc = JSON.parse(r.out);
		assert.deepEqual(doc.seeds[CLAW], [{ id: 'jdk21', status: 'not-earned' }]);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a busy node is skipped before the disk check or the seed run ever run', () => {
	const f = seedingFixture({ busy: true });
	try {
		f.answer(JDK21_ANSWER);
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.deepEqual(f.calls(), ['PROBE', 'BUSY-CHECK']);
		const doc = JSON.parse(r.out);
		assert.deepEqual(doc.seeds[CLAW], [{ id: 'jdk21', status: 'busy' }]);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('under the disk floor is refused, counted as a finding, and fails the run', () => {
	const f = seedingFixture({ freeKb: (SEED_DISK_FLOOR_MB - 100) * 1024 });
	try {
		f.answer(JDK21_ANSWER);
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 1, 'a refused seed must fail the run');
		const doc = JSON.parse(r.out);
		assert.equal(doc.ok, false);
		const seedRow = doc.seeds[CLAW].find((s) => s.id === 'jdk21');
		assert.equal(seedRow.status, 'refused');
		assert.match(seedRow.reason, /below the \d+ MiB floor/);
		assert.match(run(['--machine', CLAW, '--no-push'], f.env).out, /SEED FAILED: jdk21/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a seed script that proves nothing (no HIT/BUILD line) is a FAILED finding, not a silent pass', () => {
	const f = seedingFixture({ seedOutcome: 'silent' });
	try {
		f.answer(JDK21_ANSWER);
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 1);
		const seedRow = JSON.parse(r.out).seeds[CLAW].find((s) => s.id === 'jdk21');
		assert.equal(seedRow.status, 'failed');
		assert.match(seedRow.reason, /neither a HIT nor a BUILD/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a seed script that fails (non-zero exit) is a FAILED finding carrying its reason', () => {
	const f = seedingFixture({ seedOutcome: 'fail' });
	try {
		f.answer(JDK21_ANSWER);
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 1);
		const seedRow = JSON.parse(r.out).seeds[CLAW].find((s) => s.id === 'jdk21');
		assert.equal(seedRow.status, 'failed');
		assert.match(seedRow.reason, /mvn build failed/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('hokon (a guest) is never seeded even when $seeds is declared — guarded a second time, inside seedNode itself', () => {
	const f = seedingFixture();
	try {
		const doc = JSON.parse(readFileSync(f.manifestPath, 'utf8'));
		doc.machines[GUEST] = { role: 'guest', labels: ['pm2-host', 'taskauto'], minFreeMb: 8192 };
		writeFileSync(f.manifestPath, JSON.stringify(doc, null, 2));
		f.answer(JDK21_ANSWER);
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.ok(
			!(GUEST in JSON.parse(r.out).seeds),
			'a guest selected by nobody gets no seed verdict at all'
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// `--prove` (wave 4e, #102) — the CPU pre-filter and the `--due` freshness
// skip, the two gates that fire BEFORE bootcamp would ever drain a node or
// shell out to `fleet prove-job`. The canary-dispatch path itself is already
// proven end to end in `prove-job.test.mjs`/`prove-job.test.ts`; re-driving a
// real drain + a real prove-job subprocess from inside THIS fixture would
// mean standing up a second, parallel copy of that machinery, so this stays
// at the boundary: does bootcamp correctly SKIP, naming why, without ever
// reaching for the node a second time.
//
// RAM IS KEPT BELOW `JDK21_MIN_INSTALLED_MB` DELIBERATELY: `maven`'s REPAIRS
// entry installs on any node whose declared RAM clears that floor, regardless
// of whether it has earned the label yet (the two are independent — see
// `toolchain-floor.mjs`). A low-RAM fixture node never triggers that install
// attempt; the JDK itself applies to every claw and the shim answers its
// detect as present, so the probe is the only thing these two tests are about.
function proveFixture({ cores = 8 } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-bootcamp-prove-'));
	const manifestDir = join(root, 'manifests');
	const stateDir = join(root, 'state');
	const bin = join(root, 'bin');
	for (const d of [manifestDir, stateDir, bin]) mkdirSync(d, { recursive: true });
	const manifestPath = join(manifestDir, 'fleet-runner-manifest.json');
	writeFileSync(
		manifestPath,
		JSON.stringify(
			{
				toolchain: { capabilities: [] },
				machines: {
					[CLAW]: {
						role: 'claw',
						labels: [],
						maxConcurrent: 2,
						minFreeMb: 1024,
						cores,
						ramGb: 8, // below JDK21_MIN_INSTALLED_MB (12 GiB) — no install attempt
					},
				},
			},
			null,
			2
		)
	);
	const calls = join(root, 'calls.log');
	const sshShim = join(bin, 'ssh');
	writeFileSync(
		sshShim,
		[
			'#!/bin/sh',
			'script="$(cat)"',
			'case "$script" in',
			JDK_PRESENT_CASE,
			'  *)',
			`    echo PROBE >>${JSON.stringify(calls)}`,
			"    printf 'CAP jdk21 ok 21.0.1\\nPROBE-END\\n' ;;",
			'esac',
			'',
		].join('\n')
	);
	chmodSync(sshShim, 0o755);
	return {
		root,
		manifestPath,
		stateDir,
		calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: manifestDir,
			HADOKU_STATE_DIR: stateDir,
			HADOKU_SITE_ROOT: root,
			PATH: `${bin}:${process.env.PATH}`,
		},
	};
}

test('--prove is OFF by default — no CPU check, no $proof read, no canary, byte-identical to before this wave', () => {
	const f = proveFixture({ cores: 4 });
	try {
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		assert.ok(!('prove' in doc), 'the prove key is absent entirely without the flag');
		assert.deepEqual(f.calls(), ['PROBE'], 'exactly the existing probe, nothing more');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("--prove skips an undersized node's canary on the CPU floor — one probe, never a drain", () => {
	const f = proveFixture({ cores: 4 }); // claw-3-shaped: below JDK21_CANARY_MIN_THREADS (6)
	try {
		const r = run(['--machine', CLAW, '--no-push', '--prove', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		assert.deepEqual(doc.prove, [
			{
				node: CLAW,
				capability: 'jdk21',
				status: 'skipped',
				reason: 'CPU floor not met for the canary (cores=4)',
			},
		]);
		assert.deepEqual(
			f.calls(),
			['PROBE'],
			'the pre-filter decided without ever draining the node or shelling out to prove-job'
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('--prove --due <n> skips a node with an existing FRESH pass — "not due yet", no canary attempted', () => {
	const f = proveFixture({ cores: 8 }); // clears the CPU floor
	try {
		writeProof(
			{
				node: CLAW,
				capability: 'jdk21',
				runId: 1,
				runner: 'jit-fixture-claw-1-proof-hadoku-cardtable-j0-r0-1',
				conclusion: 'success',
				durationSec: 300,
				evidenceMatched: true,
				budgetSec: null,
				verdict: 'pass',
				why: 'pass (budget unbootstrapped: 0/2 proven node(s))',
				at: new Date(Date.now() - 1 * 86_400_000).toISOString(),
			},
			{ dir: f.stateDir }
		);
		const r = run(['--machine', CLAW, '--no-push', '--prove', '--due', '30', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		assert.equal(doc.prove.length, 1);
		assert.equal(doc.prove[0].status, 'not-due');
		assert.match(doc.prove[0].reason, /last pass .* \(1\.0\/30d\)/);
		assert.deepEqual(f.calls(), ['PROBE'], 'an existing fresh pass never triggers a new canary');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// IDLE-ONLY MEASUREMENTS ARE TAKEN IDLE, OR NOT AT ALL (2026-10-10).
//
// claw-4 scored 2281 on cargo-bevy idle and 1169 beside CI; claw-6 1529 and
// 1024. `--write` re-takes a busy measurement on a node it DRAINS and waits
// out; a node that never goes quiet keeps its previous verdict; a guest is
// never drained. Driven for real: the real `drain-node.mjs` writes the
// fixture state dir's `fleet-drain.json`, and the ssh shim answers the probe
// by phase and the busy count from a file the test controls.
// ---------------------------------------------------------------------------

const CLAW2 = 'fixture-claw-2.invalid';
const ALL_ANSWER = (bevy, load) =>
	[
		'CAP ffmpeg ok 7.1.5',
		`CAP cargo-bevy ${bevy}`,
		`LOAD cargo-bevy ${load}`,
		'PROBE-END',
		'',
	].join('\n');
const PRESENCE_ANSWER = ['CAP ffmpeg ok 7.1.5', 'PROBE-END', ''].join('\n');
const MEASURED_ANSWER = (bevy, load) =>
	[`CAP cargo-bevy ${bevy}`, `LOAD cargo-bevy ${load}`, 'PROBE-END', ''].join('\n');

/**
 * Two claws (so the real `drain-node` capacity guard lets one go) and a guest,
 * in a throwaway git repo. `prevEarned` seeds each node's `$capabilities` —
 * the record an unjudged measurement must keep.
 */
function idleFixture({
	all = ALL_ANSWER('ok 1024', 2),
	measured = MEASURED_ANSWER('ok 2281', 0),
	busy = 0,
	prevEarned = {},
	soleClaw = false,
	drains = null,
	labels = [],
} = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-bootcamp-idle-'));
	const manifestDir = join(root, 'manifests');
	const stateDir = join(root, 'state');
	const bin = join(root, 'bin');
	for (const d of [manifestDir, stateDir, bin]) mkdirSync(d, { recursive: true });
	const rec = (name) =>
		prevEarned[name]
			? {
					$capabilities: {
						at: new Date(Date.now() - 26 * 86_400_000).toISOString(),
						by: 'fleet bootcamp',
						declared: [],
						earned: prevEarned[name],
						unclaimed: [],
						unearned: [],
						blocked: [],
						prereqs: [{ id: 'ffmpeg', detail: '7.1.5' }],
						unprobed: [],
					},
				}
			: {};
	const machines = {
		[CLAW]: { role: 'claw', labels, maxConcurrent: 2, minFreeMb: 1024, ...rec(CLAW) },
		...(soleClaw
			? {}
			: { [CLAW2]: { role: 'claw', labels: [], maxConcurrent: 2, minFreeMb: 1024 } }),
		[GUEST]: { role: 'guest', labels: [], minFreeMb: 8192, ...rec(GUEST) },
	};
	const manifestPath = join(manifestDir, 'fleet-runner-manifest.json');
	writeFileSync(
		manifestPath,
		JSON.stringify({ toolchain: { capabilities: ['ffmpeg'] }, machines }, null, 2) + '\n'
	);
	if (drains) {
		writeFileSync(join(stateDir, 'fleet-drain.json'), JSON.stringify({ nodes: drains }, null, 2));
	}
	const files = {
		all: join(root, 'all.txt'),
		presence: join(root, 'presence.txt'),
		measured: join(root, 'measured.txt'),
		busy: join(root, 'busy.txt'),
		calls: join(root, 'calls.log'),
		drainAtMeasure: join(root, 'drain-at-measure.json'),
	};
	writeFileSync(files.all, all);
	writeFileSync(files.presence, PRESENCE_ANSWER);
	writeFileSync(files.measured, measured);
	writeFileSync(files.busy, `${busy}\n`);
	const drainFile = join(stateDir, 'fleet-drain.json');
	const q = JSON.stringify;
	writeFileSync(
		join(bin, 'ssh'),
		[
			'#!/bin/sh',
			// drain-node's own busy count passes its command as an ARGUMENT (ssh -n).
			`case "$*" in *pgrep*) cat ${q(files.busy)}; exit 0 ;; esac`,
			'script="$(cat)"',
			'case "$script" in',
			JDK_PRESENT_CASE,
			'  *"export CAP_PROBE_PHASE=measured"*)',
			`    echo MEASURED >>${q(files.calls)}`,
			// What the drain file said AT THE MOMENT of the measurement.
			`    cat ${q(drainFile)} >${q(files.drainAtMeasure)} 2>/dev/null`,
			// A node that drops off mid-run: no PROBE-END, and ssh's own exit 255.
			`    cat ${q(files.measured)}; grep -q PROBE-END ${q(files.measured)} || exit 255; exit 0 ;;`,
			'  *"export CAP_PROBE_PHASE=presence"*)',
			`    echo PRESENCE >>${q(files.calls)}`,
			`    exec cat ${q(files.presence)} ;;`,
			'  *"capability-probe — EXECUTE"*)',
			`    echo PROBE >>${q(files.calls)}`,
			`    exec cat ${q(files.all)} ;;`,
			'  *"[R]unner"*)',
			`    echo BUSY >>${q(files.calls)}`,
			`    exec cat ${q(files.busy)} ;;`,
			'esac',
			'',
		].join('\n')
	);
	chmodSync(join(bin, 'ssh'), 0o755);
	const env = cleanGitEnv({
		FLEET_MANIFEST_DIR: manifestDir,
		HADOKU_STATE_DIR: stateDir,
		HADOKU_SITE_ROOT: root,
		PATH: `${bin}:${process.env.PATH}`,
		FLEET_TEST_IDLE_TIMING: JSON.stringify({ pollMs: 20, settleMs: 0, timeoutMs: 400 }),
	});
	const git = (...a) => execFileSync('git', a, { cwd: root, env, encoding: 'utf8' });
	git('init', '-q', '-b', 'main');
	const cfg = join(root, '.git', 'config');
	git('config', '--file', cfg, 'user.name', FIXTURE_IDENTITY.name);
	git('config', '--file', cfg, 'user.email', FIXTURE_IDENTITY.email);
	git('add', '-A');
	git('commit', '-q', '-m', 'base');
	const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
	return {
		root,
		env,
		manifestPath,
		drainFile,
		calls: () => (read(files.calls) ?? '').trim().split('\n').filter(Boolean),
		drains: () => (read(drainFile) ? JSON.parse(read(drainFile)).nodes : {}),
		drainAtMeasure: () =>
			read(files.drainAtMeasure) ? JSON.parse(read(files.drainAtMeasure)).nodes : null,
		commits: () => Number(git('rev-list', '--count', 'HEAD').trim()),
		record: (name = CLAW) =>
			JSON.parse(readFileSync(manifestPath, 'utf8')).machines[name].$capabilities ?? null,
		answer: (which, text) => writeFileSync(files[which], text),
	};
}

const writeArgs = ['--machine', CLAW, '--write', '--no-push', '--json'];

test('busy in the first pass: --write DRAINS, waits out, re-measures idle, UNDRAINS — and earns on the idle number', () => {
	// claw-4's shape: 1024 beside a job, 2281 alone.
	const f = idleFixture();
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		assert.deepEqual(
			f.calls().filter((c) => c !== 'BUSY'),
			['PROBE', 'MEASURED']
		);
		// THE HOLD WAS REAL: the measurement ran under bootcamp's own drain row…
		const atMeasure = f.drainAtMeasure();
		assert.ok(atMeasure?.[CLAW], 'the idle measurement ran on an UNDRAINED node');
		assert.equal(atMeasure[CLAW].kind, 'training');
		assert.match(atMeasure[CLAW].reason, /^fleet bootcamp: idle measurement: cargo-bevy/);
		// …and it is gone afterwards.
		assert.deepEqual(f.drains(), {}, 'bootcamp left its drain behind');
		assert.equal(doc.report[CLAW].idleHold.status, 'measured');
		assert.equal(doc.report[CLAW].idleHold.heldBy, 'bootcamp');
		const rec = f.record();
		assert.ok(rec.earned.includes('cargo-bevy'), `the idle 2281 must earn: ${rec.earned}`);
		assert.deepEqual(
			{ ...rec.measurements['cargo-bevy'], at: 'x' },
			{ value: 2281, idle: true, earned: true, at: 'x' }
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a node that never goes quiet is INCONCLUSIVE: the previous EARN stands, nothing measured, drain lifted, run fails loudly', () => {
	// claw-6's shape: earned 1529 on 2026-09-14, reads 1024 beside CI today.
	const f = idleFixture({ busy: 1, prevEarned: { [CLAW]: ['cargo-bevy', 'ffmpeg'] } });
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 1, 'an asked-for measurement that could not be taken is a finding');
		const doc = JSON.parse(r.out);
		assert.ok(!f.calls().includes('MEASURED'), 'busy must never become a reading');
		assert.deepEqual(f.drains(), {}, 'the drain is lifted on the timeout path too');
		const inc = doc.report[CLAW].inconclusive;
		assert.equal(inc.length, 1);
		assert.equal(inc[0].id, 'cargo-bevy');
		assert.equal(inc[0].kept, 'earned');
		assert.match(inc[0].reason, /never went quiet/);
		assert.ok(f.record().earned.includes('cargo-bevy'), 'a busy 1024 stripped an idle 1529');
		assert.equal(f.record().measurements, undefined, 'nothing new is written for it');
		const human = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.match(human.out, /INCONCLUSIVE: cargo-bevy — .*previous record kept \(earned\)/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('…and in the other direction: a busy HIGH reading never earns a node that had not', () => {
	const f = idleFixture({
		all: ALL_ANSWER('ok 2900', 1),
		busy: 1,
		prevEarned: { [CLAW]: ['ffmpeg'] },
	});
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 1);
		const report = JSON.parse(r.out).report[CLAW];
		assert.equal(report.inconclusive[0].kept, 'not earned');
		assert.ok(!f.record().earned.includes('cargo-bevy'), 'earned on a reading taken beside a job');
		// Said ONCE, as inconclusive — not also as a "not earned" reason, which
		// would read as a verdict the run never reached.
		assert.ok(
			!report.notEarned.some((n) => n.id === 'cargo-bevy'),
			JSON.stringify(report.notEarned)
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('IDLE in the first pass: judged on the spot — below the bar STRIPS, and nothing is drained', () => {
	const f = idleFixture({
		all: ALL_ANSWER('ok 1024', 0),
		prevEarned: { [CLAW]: ['cargo-bevy', 'ffmpeg'] },
	});
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.deepEqual(f.calls(), ['PROBE'], 'a quiet measurement needs no drain');
		assert.ok(!existsSync(f.drainFile), 'no drain was ever written');
		const rec = f.record();
		assert.ok(!rec.earned.includes('cargo-bevy'), 'an IDLE 1024 is a verdict');
		assert.equal(rec.measurements['cargo-bevy'].earned, false);
		assert.equal(rec.measurements['cargo-bevy'].value, 1024);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('without --write nothing is drained: a busy measurement is "not judged", carried, and not a finding', () => {
	const f = idleFixture({ prevEarned: { [CLAW]: ['cargo-bevy', 'ffmpeg'] } });
	try {
		const before = readFileSync(f.manifestPath, 'utf8');
		const r = run(['--machine', CLAW, '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		assert.deepEqual(f.calls(), ['PROBE'], 'a read-only run must not take a node out of service');
		assert.ok(doc.report[CLAW].earned.includes('cargo-bevy'));
		assert.equal(doc.report[CLAW].inconclusive[0].kept, 'earned');
		assert.equal(readFileSync(f.manifestPath, 'utf8'), before);
		const human = run(['--machine', CLAW], f.env);
		assert.match(
			human.out,
			/not judged: cargo-bevy — measured under load \(2 live Runner\.Worker\)/
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('an unjudged measurement never makes a DECLARED label UNEARNED — it is not a verdict', () => {
	const f = idleFixture({ labels: ['cargo-bevy'] });
	try {
		const r = run(['--machine', CLAW, '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const report = JSON.parse(r.out).report[CLAW];
		assert.deepEqual(report.unearned, []);
		assert.equal(report.inconclusive[0].id, 'cargo-bevy');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('killed mid-wait, bootcamp lifts its own drain on the way out', async () => {
	// A drain nobody lifts is an outage by accident. The busy node never goes
	// quiet; the test waits until bootcamp's drain row lands, then SIGTERMs it.
	const f = idleFixture({ busy: 1 });
	try {
		const env = {
			...f.env,
			FLEET_TEST_IDLE_TIMING: JSON.stringify({ pollMs: 50, settleMs: 0, timeoutMs: 60_000 }),
		};
		const child = spawn(process.execPath, [join(SCRIPTS, 'bootcamp.mjs'), ...writeArgs], {
			env,
			stdio: 'ignore',
		});
		const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
		const deadline = Date.now() + 30_000;
		while (!f.drains()[CLAW]) {
			assert.ok(Date.now() < deadline, 'bootcamp never drained the busy node');
			await new Promise((r) => setTimeout(r, 25));
		}
		child.kill('SIGTERM');
		assert.equal(await exited, 143);
		assert.deepEqual(f.drains(), {}, 'a killed bootcamp left the node drained');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("someone else's drain is measured UNDER, never rewritten and never lifted", () => {
	const theirs = {
		since: new Date().toISOString(),
		kind: 'training',
		reason: 'toolchain refresh (automated); returns after re-probe',
		by: 'fixture',
	};
	const f = idleFixture({ drains: { [CLAW]: theirs } });
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.ok(f.calls().includes('MEASURED'));
		assert.deepEqual(f.drains(), { [CLAW]: theirs }, 'their hold must survive, byte-for-byte');
		assert.equal(JSON.parse(r.out).report[CLAW].idleHold.heldBy, 'someone-else');
		assert.ok(f.record().earned.includes('cargo-bevy'));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a drain the capacity guard REFUSES is inconclusive — nothing measured, nothing left drained', () => {
	// One claw: draining it would leave the fleet nobody, which `drain-node` refuses.
	const f = idleFixture({ soleClaw: true, prevEarned: { [CLAW]: ['cargo-bevy', 'ffmpeg'] } });
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 1);
		assert.ok(!f.calls().includes('MEASURED'));
		assert.deepEqual(f.drains(), {});
		assert.match(
			JSON.parse(r.out).report[CLAW].inconclusive[0].reason,
			/drain (refused|failed): .*would leave NO node/
		);
		assert.ok(f.record().earned.includes('cargo-bevy'));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a node that drops off during the idle re-measure is inconclusive, and still undrained', () => {
	const f = idleFixture({ measured: 'ssh: connect to host: Connection timed out\n' });
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 1);
		assert.deepEqual(f.drains(), {});
		assert.match(
			JSON.parse(r.out).report[CLAW].inconclusive[0].reason,
			/unreachable during the idle re-measurement/
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a GUEST is never drained: probed WITHOUT the measurement, and its idle-only verdict is kept', () => {
	// hokon carries cargo-bevy in `earned` today. `drain-node` refuses a guest, and
	// a drain would not make it idle: its deploys and backstop runners take work
	// a drain does not stop.
	const f = idleFixture({ prevEarned: { [GUEST]: ['cargo-bevy', 'ffmpeg'] } });
	try {
		const r = run(['--machine', GUEST, '--write', '--no-push', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.deepEqual(f.calls(), ['PRESENCE'], 'only the presence half runs on a guest');
		assert.ok(!existsSync(f.drainFile), 'a guest was drained');
		const inc = JSON.parse(r.out).report[GUEST].inconclusive;
		assert.deepEqual(
			inc.map((i) => [i.id, i.guest, i.kept]),
			[['cargo-bevy', true, 'earned']]
		);
		assert.ok(f.record(GUEST).earned.includes('cargo-bevy'), 'the guest lost its earned verdict');
		const human = run(['--machine', GUEST], f.env);
		assert.match(human.out, /kept \(guest\): cargo-bevy — GUEST: not re-measured/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('the idle measurement entry moves only with the VERDICT: a second idle run at a new number commits nothing (#59)', () => {
	const f = idleFixture({ all: ALL_ANSWER('ok 2281', 0) });
	try {
		const base = f.commits();
		assert.equal(run(writeArgs, f.env).code, 0);
		assert.equal(f.commits(), base + 1);
		const first = f.record();
		f.answer('all', ALL_ANSWER('ok 2310', 0)); // same verdict, fresh figure
		const second = run(writeArgs, f.env);
		assert.equal(second.code, 0, `${second.out}\n${second.err}`);
		assert.equal(f.commits(), base + 1, 'a re-measure that changed no verdict redeployed mgmt-api');
		assert.deepEqual(f.record(), first);
		// A verdict that DOES move rewrites the entry, with the deciding number.
		f.answer('all', ALL_ANSWER('ok 1100', 0));
		assert.equal(run(writeArgs, f.env).code, 0);
		assert.equal(f.commits(), base + 2);
		assert.equal(f.record().measurements['cargo-bevy'].value, 1100);
		assert.equal(f.record().measurements['cargo-bevy'].earned, false);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
