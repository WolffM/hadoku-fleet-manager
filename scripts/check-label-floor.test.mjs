/**
 * #80 — the resident backstop's one `gh api` read retries before could-not-look.
 *
 * `check-label-floor.mjs`'s resident-floor section (`listRunners`) made a
 * single unretried `gh api repos/<repo>/actions/runners --paginate` call per
 * resident repo. `ci:audit-gates` runs this as `check:label-floor` with a 120s
 * wrapper timeout (audit-gates.ts), and a one-shot timeout there used to read
 * straight through to "resident backstop floor: 1 problem(s)" — paging on a
 * blip rather than the two-holder floor actually breaking. It is now retried
 * per `READ_ATTEMPTS`, the same shape `check-fleet-preflight.mjs` and
 * `reconcile-runner-identity.mjs` already carry for their own `gh` reads.
 *
 * `scripts/lib/label-floor.test.mjs` already covers this gate's dependency
 * and derivation logic with a fixture that declares no `residentRepos` (so no
 * `gh` call happens at all). This file is additive and narrow: it declares
 * TWO resident holders — the minimum the floor requires — and shims `gh` on
 * PATH with failure injection, the same shape `check-fleet-preflight.test.mjs`
 * uses (a counter FILE, because each invocation is a fresh process).
 *
 * The repos are fixture REMOTES (lib/fleet-source-fixture.mjs), whose git
 * children run with every GIT_* stripped. See lib/hook-safe-tests.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { READ_ATTEMPTS } from './lib/queue-health.mjs';
import { fixtureRemotes } from './lib/fleet-source-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'check-label-floor.mjs');

const REPO = 'WolffM/fixture-resident';
const HOLDER_A = 'fixture-claw-a';
const HOLDER_B = 'fixture-claw-b';

/**
 * A bootcamp finding that passes, so nothing here fails on an unrelated
 * check. ANCHORED TO NOW, never a literal date — see
 * lib/fixture-clock-guard.test.mjs. This gate never ages an `at` stamp
 * against the real clock (it compares transitions to EACH OTHER, per
 * `scripts/lib/label-floor.test.mjs`'s own DECLARED entry), but a literal
 * date here is still a bomb for the NEXT reader who copies this shape
 * somewhere that does read it as an age.
 */
const PASSES = {
	at: new Date(Date.now() - 60 * 60_000).toISOString(),
	by: 'fleet bootcamp',
	declared: [],
	earned: ['ffmpeg'],
	blocked: [],
	unprobed: [],
	prereqs: [{ id: 'ffmpeg', detail: '7.1.5' }],
};

/**
 * A `gh` that logs every call and answers the resident floor's ONE read with
 * two online holders carrying `hadoku-builder` — the minimum the floor needs
 * to report clean — and can be told to fail it a fixed number of times first.
 */
const GH_SHIM = `#!/usr/bin/env bash
argv="$*"
printf '%s\\n' "$argv" >> "$GH_LOG"

case "$argv" in
	*"actions/runners --paginate"*)
		n=0
		[ -f "$GH_COUNT_FILE" ] && n=$(cat "$GH_COUNT_FILE")
		n=$((n + 1))
		echo "$n" > "$GH_COUNT_FILE"
		if [ "$n" -le "\${GH_FAIL_TIMES:-0}" ]; then
			# A real \`gh api\` failure (404/422) prints the body naming WHY to
			# STDOUT, with only a generic line on stderr — the shape that proved
			# the shared listRunners (plan §4.1 F2b) over this file's own former
			# copy, which read \`err.stderr\` alone and lost it.
			if [ -n "\${GH_FAIL_STDOUT_MSG:-}" ]; then
				echo "gh: command failed" >&2
				echo "$GH_FAIL_STDOUT_MSG"
			else
				echo "gh: ETIMEDOUT waiting for api.github.com" >&2
			fi
			exit 1
		fi
		cat "$GH_RUNNERS"
		;;
	*) echo '{}' ;;
esac
`;

function fixture() {
	const remotes = fixtureRemotes('label-floor-resident-');
	const root = remotes.root;
	const manifestDir = join(root, 'admin');
	const siteRoot = join(root, 'site');
	const stateDir = join(root, 'state');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(siteRoot, { recursive: true });
	mkdirSync(stateDir, { recursive: true });

	writeFileSync(
		join(manifestDir, 'fleet-runner-manifest.json'),
		JSON.stringify(
			{
				machines: {
					[HOLDER_A]: { residentRepos: [REPO], $capabilities: PASSES },
					[HOLDER_B]: { residentRepos: [REPO], $capabilities: PASSES },
				},
			},
			null,
			2
		)
	);
	// One covered repo and one observed job: an empty roster and an empty job
	// history each FAIL the gate on their own (#98), ahead of the resident floor.
	// The covered repo is a REMOTE, read through fleet-source like GitHub.
	const reposDir = join(root, 'repos');
	mkdirSync(reposDir, { recursive: true });
	remotes.push(REPO, {
		'.github/workflows/ci.yml': 'jobs:\n  check:\n    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}\n',
	});
	writeFileSync(join(manifestDir, 'fleet-runner-coverage.json'), JSON.stringify({ repos: [REPO] }));
	writeFileSync(
		join(stateDir, 'job-history.jsonl'),
		JSON.stringify({
			repo: REPO,
			runner: HOLDER_A,
			labels: ['self-hosted', 'hadoku-builder'],
			startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
		}) + '\n'
	);
	remotes.push('WolffM/hadoku_site', {
		'.github/workflows/ci.yml': "jobs:\n  build:\n    runs-on: ['self-hosted', 'hadoku-builder']\n",
	});
	writeFileSync(
		join(stateDir, 'demand-ledger.jsonl'),
		JSON.stringify({
			class: 'ci',
			repo: 'WolffM/fixture',
			job: 'check',
			fleetForm: true,
			selfHosted: true,
			hosted: false,
			capabilities: ['ffmpeg'],
		}) + '\n'
	);

	const bin = join(root, 'bin');
	mkdirSync(bin, { recursive: true });
	const ghBin = join(bin, 'gh');
	writeFileSync(ghBin, GH_SHIM);
	chmodSync(ghBin, 0o755);

	const runners = join(root, 'runners.json');
	writeFileSync(
		runners,
		JSON.stringify({
			runners: [
				{
					id: 1,
					name: HOLDER_A,
					status: 'online',
					busy: false,
					labels: [{ name: 'hadoku-builder' }],
				},
				{
					id: 2,
					name: HOLDER_B,
					status: 'online',
					busy: false,
					labels: [{ name: 'hadoku-builder' }],
				},
			],
		})
	);

	return {
		root,
		remotes,
		bin,
		manifestDir,
		siteRoot,
		stateDir,
		reposDir,
		runners,
		ghLog: join(root, 'gh.log'),
		countFile: join(root, 'gh.count'),
	};
}

function cleanup(fx) {
	rmSync(fx.root, { recursive: true, force: true });
}

/** One gate run, `--json`. Returns the exit code and the parsed report — never throws. */
function run(fx, { failTimes = 0, failStdoutMsg = '' } = {}) {
	const env = {
		...process.env,
		...fx.remotes.env,
		PATH: `${fx.bin}:${process.env.PATH}`,
		FLEET_MANIFEST_DIR: fx.manifestDir,
		HADOKU_SITE_ROOT: fx.siteRoot,
		HADOKU_STATE_DIR: fx.stateDir,
		REPOS_DIR: fx.reposDir,
		GH_LOG: fx.ghLog,
		GH_COUNT_FILE: fx.countFile,
		GH_FAIL_TIMES: String(failTimes),
		GH_FAIL_STDOUT_MSG: failStdoutMsg,
		GH_RUNNERS: fx.runners,
	};
	try {
		const stdout = execFileSync(process.execPath, [GATE, '--json'], {
			env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, report: JSON.parse(stdout) };
	} catch (err) {
		const out = err.stdout ?? '';
		return {
			code: err.status ?? 1,
			report: out.trim().startsWith('{') ? JSON.parse(out) : null,
			stderr: err.stderr ?? '',
		};
	}
}

/** How many logged `gh` calls matched the resident-floor's runner listing. */
function attempts(logPath) {
	if (!existsSync(logPath)) return 0;
	return readFileSync(logPath, 'utf8')
		.split('\n')
		.filter((l) => l.includes('actions/runners --paginate')).length;
}

// ── the floor: two online holders must pass, costing one attempt ──────────

test('two online resident holders exit 0, and nothing is retried on the success path', () => {
	const fx = fixture();
	try {
		const { code, report } = run(fx);
		assert.equal(
			code,
			0,
			`expected a clean resident floor, got ${code}: ${JSON.stringify(report)}`
		);
		assert.equal(attempts(fx.ghLog), 1, 'the retry must cost nothing when nothing fails');
	} finally {
		cleanup(fx);
	}
});

// ── (a) a one-shot failure that recovers must not fail the gate ───────────

test('the resident-floor read times out once and recovers: no finding, exit 0', () => {
	const fx = fixture();
	try {
		const { code, report } = run(fx, { failTimes: 1 });
		assert.equal(
			code,
			0,
			`a transient blip that recovered must not fail the gate: ${JSON.stringify(report)}`
		);
		assert.equal(attempts(fx.ghLog), 2, 'must have been retried exactly once');
		assert.notEqual(report?.verdict, 'resident-backstop');
	} finally {
		cleanup(fx);
	}
});

// ── (b) retrying is NOT tolerating: every attempt failing still fails ─────

test('a resident-floor read that never recovers fails the gate after READ_ATTEMPTS, naming why', () => {
	const fx = fixture();
	try {
		const { code, report, stderr } = run(fx, { failTimes: 999 });
		assert.equal(code, 1, 'a read that never recovers must fail the gate');
		assert.equal(
			attempts(fx.ghLog),
			READ_ATTEMPTS,
			`must be tried exactly ${READ_ATTEMPTS} times before it is called could-not-look`
		);
		assert.ok(report, 'a failing gate must still emit parseable JSON');
		assert.equal(report.verdict, 'resident-backstop');
		assert.equal(report.residentFailures.length, 1);
		assert.match(
			report.residentFailures[0],
			/ETIMEDOUT/,
			'the finding must carry WHY the read failed'
		);
		assert.match(
			report.residentFailures[0],
			/attempt 2\/2/,
			'the finding must say the failure survived the retry'
		);
		assert.match(stderr, /resident backstop floor/);
	} finally {
		cleanup(fx);
	}
});

// ── (c) a `gh api` failure body on STDOUT ONLY is still carried (plan §4.1 F2b) ─

/**
 * `gh api` prints a 404/422's explanatory body to STDOUT, with stderr often
 * carrying only a generic "gh: command failed" line. This file's own former
 * `listRunners` passed the raw `execFileSync` error straight to
 * `describeReadFailure`, which reads `err.stderr` alone — so that body was
 * lost here, exactly the gap `reconcile-fleet-runners.mjs`'s sibling copy had
 * already fixed for itself by joining both streams. Moving onto the shared
 * `scripts/lib/gh-runners.mjs` (which does join them) picks up that fix.
 */
test('a resident-floor read whose gh-api body is on STDOUT ONLY still carries that body', () => {
	const fx = fixture();
	try {
		const { code, report } = run(fx, {
			failTimes: 999,
			failStdoutMsg: '{"message":"Resource not accessible by integration"}',
		});
		assert.equal(code, 1);
		assert.equal(report.residentFailures.length, 1);
		assert.match(
			report.residentFailures[0],
			/Resource not accessible by integration/,
			'the STDOUT-only body must reach the finding, not just the generic stderr line'
		);
	} finally {
		cleanup(fx);
	}
});

// ── historical demand: nothing offers the label, and nothing asks any more ─

/** Jobs that ran on `label` `hoursAgo`, as job history records them. */
function observedJobs(fx, label, hoursAgo, n) {
	const rows = Array.from({ length: n }, () =>
		JSON.stringify({
			repo: REPO,
			runner: HOLDER_A,
			labels: ['self-hosted', label],
			startedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
		})
	);
	writeFileSync(
		join(fx.stateDir, 'job-history.jsonl'),
		readFileSync(join(fx.stateDir, 'job-history.jsonl'), 'utf8') + rows.join('\n') + '\n'
	);
}

test('a label only past jobs asked for, that nothing offers, is historical: reported, not failed (#29)', () => {
	const fx = fixture();
	try {
		observedJobs(fx, 'watchparty-media', 30, 4);
		const { code, report } = run(fx);
		assert.equal(code, 0, `historical demand must not fail the gate: ${JSON.stringify(report)}`);
		assert.deepEqual(report.unoffered, []);
		assert.equal(report.historical.length, 1);
		assert.equal(report.historical[0].label, 'watchparty-media');
		assert.equal(report.historical[0].observed, 4);
		assert.match(report.historical[0].lastObserved, /^\d{4}-\d\d-\d\dT/);
	} finally {
		cleanup(fx);
	}
});

test('the same label still fails while a shipped workflow asks for it', () => {
	const fx = fixture();
	try {
		observedJobs(fx, 'watchparty-media', 30, 4);
		fx.remotes.push(REPO, {
			'.github/workflows/ci.yml': 'jobs:\n  check:\n    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}\n',
			'.github/workflows/ingest.yml':
				"jobs:\n  ingest:\n    runs-on: ['self-hosted', 'watchparty-media']\n",
		});
		const { code, report } = run(fx);
		assert.equal(code, 1);
		assert.equal(report.verdict, 'unoffered');
		assert.deepEqual(report.unoffered, ['watchparty-media']);
		assert.deepEqual(report.historical, []);
	} finally {
		cleanup(fx);
	}
});
