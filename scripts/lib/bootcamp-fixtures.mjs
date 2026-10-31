/**
 * `fleet bootcamp` — WHO IT REACHES, run for real.
 *
 * Every managed node, the backstop included: it is installed on, probed,
 * drained for an idle measurement and recorded exactly like a claw (it was
 * skipped as a `guest` until 2026-10-31).
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
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { cleanGitEnv, FIXTURE_IDENTITY } from './test-git-identity.mjs';

/**
 * Every fixture claw is asked for the JDK (toolchain-floor.mjs `jdk21` applies
 * to every claw since 2026-10-24) and answers as a node that already carries
 * one: present, never installed, never logged, so each call log stays about
 * the tool its test is testing. Matched on `javac -d "$d"`, text only the
 * REPAIRS detect contains — capability-probe.sh compiles the same class under
 * other variable names, and a broader match would answer the probe itself.
 */
export const JDK_PRESENT_CASE = `  *'javac -d "$d"'*) echo OK; exit 0 ;;`;

/**
 * The same for docker (toolchain-floor.mjs `docker`, scoped since 2026-10-27
 * to every node whose CI is still admin, which every fixture claw is). Matched
 * on the REPAIRS detect's `&& echo OK`, which capability-probe.sh's docker
 * probe does not contain.
 */
export const DOCKER_PRESENT_CASE = `  *'docker info >/dev/null 2>&1 && echo OK'*) echo OK; exit 0 ;;`;

export const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * The discard port on loopback: `data-peer`'s probe runs and is refused there,
 * so no fixture reaches the real data endpoint, and none goes INCONCLUSIVE for
 * want of a `pm2-hosts.json` it has no reason to carry.
 */
export const NO_DATA_ENDPOINT = 'http://127.0.0.1:9';

/** Names that resolve NOWHERE, and are not this box. */
export const CLAW = 'fixture-claw-1.invalid';
export const BACKSTOP = 'fixture-backstop.invalid';

export const PROBE_ANSWER = (ffmpegDetail) =>
	['CAP ffmpeg ok ' + ffmpegDetail, 'PROBE-END', ''].join('\n');

export const FFMPEG_ONLY = PROBE_ANSWER('7.1.5-0+deb13u1');
export const args = ['--machine', CLAW, '--write', '--no-push'];

export function fixture() {
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
					[BACKSTOP]: { role: 'backstop', labels: ['pm2-host', 'taskauto'], minFreeMb: 8192 },
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
			FLEET_DATA_URL: NO_DATA_ENDPOINT,
		},
	};
}

/** `{code, out, err}` — stdout and stderr kept APART: `--json` is stdout's. */
export function run(args, env) {
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
export function writableFixture(
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
			DOCKER_PRESENT_CASE,
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
		FLEET_DATA_URL: NO_DATA_ENDPOINT,
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
		stateDir,
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
