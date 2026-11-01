/**
 * WHOSE OFFLINE ROW FAILS THE RUN — #60.
 *
 * Every node's: a claw's and the backstop's alike. (Until 2026-10-31 the
 * backstop's rows were reported and did not fail the run, while it was a
 * `guest` the fleet did not repair.)
 *
 * The file header once said the opposite of the code ("Offline runners and
 * unmanaged runners never fail the run — they are reported") while the exit
 * predicate counted `offline.length`. That is the fourth time in this repo that
 * a comment has been read as evidence, so the last test here holds the header
 * to the code.
 *
 * The reconciler is a CLI over `gh` and `ssh`, so it is exercised as one, the
 * same way `reconcile-runner-identity.test.mjs` does it: a throwaway manifest
 * directory, shims first on PATH, and the EXIT CODE read directly rather than
 * grepped out of the output.
 *
 * NOTHING HERE SPAWNS git — the reconciler does not, and the environment below
 * strips GIT_* anyway. See lib/hook-safe-tests.test.mjs for why that matters.
 *
 * SPLIT OFF `reconcile-fleet-runners.test.mjs` (wave 5q lane B, whole-block
 * split by concern over the shared rig in `lib/reconcile-fleet-runners-rig.mjs`):
 * this half is the "core" reconcile tests — offline/retry/mint/header, over
 * the fixture() rig below. `reconcile-fleet-runners-coverage.test.mjs` is the
 * other half, over its own `--write-coverage`/`--check-coverage` fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeNode } from './lib/fake-node.mjs';
import { READ_ATTEMPTS } from './lib/queue-health.mjs';
import { SCRIPT, NO_GIT_ENV } from './lib/reconcile-fleet-runners-rig.mjs';

const CLAW = 'fixture-claw';
const BACKSTOP = 'fixture-backstop';
const REPO = 'WolffM/fixture-alpha';

/**
 * A `gh` that answers every call the dry run makes, reading the runner listing
 * from a file so each case can restate it without rewriting the shim.
 *
 * EVERY CALL IS LOGGED, when `GH_LOG` is set — unset for the original fixtures
 * below (`[ -n ... ]` makes the line a no-op for them), set by the #80 retry
 * fixture that needs to COUNT attempts. The two new `-X POST` branches sit
 * ABOVE the generic `*"actions/runners"*` read: `registration-token` and
 * `remove-token` both contain the substring "actions/runners" too, so without
 * this ordering a mint call would be swallowed by the read branch and this
 * shim could never prove a write happens exactly once (#80).
 */
const GH_SHIM = `#!/usr/bin/env bash
argv="$*"
[ -n "\${GH_LOG:-}" ] && printf '%s\\n' "$argv" >> "$GH_LOG"

case "$argv" in
  "repo list"*)
    n=0
    if [ "\${GH_FAIL_WHAT:-}" = "repo-list" ]; then
      [ -f "$GH_COUNT_FILE" ] && n=$(cat "$GH_COUNT_FILE")
      n=$((n + 1))
      echo "$n" > "$GH_COUNT_FILE"
      if [ "$n" -le "\${GH_FAIL_TIMES:-0}" ]; then
        echo "gh: ETIMEDOUT waiting for api.github.com" >&2
        exit 1
      fi
    fi
    echo '[{"nameWithOwner":"${REPO}","isFork":false,"isArchived":false,"pushedAt":"'"$GH_PUSHED_AT"'"}]' ;;
  *"-X POST"*"registration-token"*)
    n=0
    if [ "\${GH_FAIL_WHAT:-}" = "mint" ]; then
      [ -f "$GH_COUNT_FILE" ] && n=$(cat "$GH_COUNT_FILE")
      n=$((n + 1))
      echo "$n" > "$GH_COUNT_FILE"
      if [ "$n" -le "\${GH_FAIL_TIMES:-0}" ]; then
        echo "gh: 422 Validation Failed" >&2
        exit 1
      fi
    fi
    echo "fixture-token" ;;
  *"-X POST"*"remove-token"*) echo "fixture-token" ;;
  *"-X POST"*"/labels") echo '{}' ;;
  *"actions/runners"*)
    n=0
    if [ "\${GH_FAIL_WHAT:-}" = "runners-read" ]; then
      [ -f "$GH_COUNT_FILE" ] && n=$(cat "$GH_COUNT_FILE")
      n=$((n + 1))
      echo "$n" > "$GH_COUNT_FILE"
      if [ "$n" -le "\${GH_FAIL_TIMES:-0}" ]; then
        echo "gh: ETIMEDOUT waiting for api.github.com" >&2
        exit 1
      fi
    fi
    # The real gh api shape this mode stands in for: a 404/422 body is JSON
    # on STDOUT, and stderr carries nothing diagnostic at all - not even a
    # generic "gh: ..." line. Always fails, every attempt; the point of this
    # mode is proving the reason still carries the STDOUT body after retrying.
    if [ "\${GH_FAIL_WHAT:-}" = "runners-read-stdout-body" ]; then
      echo '{"message":"Resource not accessible by integration"}'
      exit 1
    fi
    cat "$GH_RUNNERS" ;;
  *"releases/latest"*) echo 'v2.337.0' ;;
  *"/contents/.github/workflows") echo '[{"name":"ci.yml","path":".github/workflows/ci.yml"}]' ;;
  *"/contents/.github/workflows/"*)
    printf '{"content":"%s"}\\n' "$(printf 'jobs:\\n  check:\\n    runs-on: \${{ fromJSON(vars.CI_RUNNER) }}\\n' | base64 -w0)" ;;
  *"trees/HEAD"*) echo '{"tree":[]}' ;;
  *) echo '{}' ;;
esac
`;

/**
 * An `ssh` that answers a clean probe. argv is fixed by `fleet-exec`'s
 * `scriptCommand` (`<user>@<node>`), so the node is $5 after its `@`; stdin is drained first or the driver gets an
 * EPIPE instead of the result under test.
 */
const SSH_SHIM = `#!/usr/bin/env bash
cat > /dev/null
echo "PROBE-END \${5##*@} 0 0"
`;

/** A throwaway manifest dir, state dir and PATH shim dir, all in one. */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'reconcile-offline-'));
	writeFileSync(
		join(root, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: {
				[CLAW]: { labels: ['hadoku-builder'], maxConcurrent: 2 },
				// Declared exactly as the claw is, differing ONLY in `role`.
				[BACKSTOP]: { role: 'backstop', labels: ['hadoku-builder'], maxConcurrent: 2 },
			},
		})
	);
	writeFileSync(join(root, 'fleet-runner-coverage.json'), JSON.stringify({ repos: [REPO] }));
	const bin = join(root, 'bin');
	mkdirSync(bin, { recursive: true });
	for (const [name, src] of [
		['gh', GH_SHIM],
		['ssh', SSH_SHIM],
	]) {
		const p = join(bin, name);
		writeFileSync(p, src);
		chmodSync(p, 0o755);
	}
	return {
		root,
		bin,
		runners: join(root, 'runners.json'),
		ghLog: join(root, 'gh.log'),
		countFile: join(root, 'gh.count'),
	};
}

/** One runner as GitHub's listing sends it — labels are `{name}` objects. */
const runner = (id, name, status) => ({
	id,
	name,
	status,
	busy: false,
	labels: [{ name: 'hadoku-builder' }],
});

/**
 * One reconcile dry run. Returns the exit code and the output — never throws.
 *
 * Stdout goes to a FILE, not a pipe: this host loses everything past 8 KB when
 * a script prints and then calls `process.exit` into a pipe, and `--json` is a
 * contract whose consumer parses the whole document.
 */
function run(fx, runners, argv = [], extraEnv = {}) {
	writeFileSync(fx.runners, JSON.stringify({ total_count: runners.length, runners }));
	const outPath = join(fx.root, 'out.txt');
	const fd = openSync(outPath, 'w');
	let code = 0;
	let stderr = '';
	try {
		execFileSync('node', [SCRIPT, ...argv], {
			env: {
				...NO_GIT_ENV,
				PATH: `${fx.bin}:${process.env.PATH}`,
				// A token the host may not supply: never the App's pool, never a real mint (#9).
				GH_TOKEN: 'fixture',
				FLEET_MANIFEST_DIR: fx.root,
				HADOKU_STATE_DIR: fx.root,
				GH_RUNNERS: fx.runners,
				// ANCHORED TO NOW, never a literal date. `pushedAt` feeds roster
				// eligibility, which drops a repo that has gone quiet for long
				// enough — so a hard-coded date turns into a different fixture the
				// day it crosses that window, and the failure looks like a code
				// change nobody made. `fixture-clock-guard` fails the build on one.
				GH_PUSHED_AT: new Date().toISOString(),
				// #80's retry fixtures: logged and counted only when the caller asks
				// (`GH_LOG`/`GH_COUNT_FILE`/`GH_FAIL_WHAT`/`GH_FAIL_TIMES` below) — a
				// no-op for every pre-existing call site, which passes none of them.
				GH_LOG: fx.ghLog,
				GH_COUNT_FILE: fx.countFile,
				...extraEnv,
			},
			stdio: ['ignore', fd, 'pipe'],
		});
	} catch (e) {
		code = e.status ?? -1;
		// Only read on a crash — a script that THROWS uncaught (#80: a roster read
		// that never recovers) reports why on stderr, never stdout, and the #80
		// tests below are the first callers that need it.
		stderr = String(e.stderr ?? '');
	} finally {
		closeSync(fd);
	}
	return { code, out: readFileSync(outPath, 'utf8'), bytes: statSync(outPath).size, stderr };
}

/** How many logged `gh` calls matched this substring. */
function attempts(logPath, substr) {
	if (!existsSync(logPath)) return 0;
	return readFileSync(logPath, 'utf8')
		.split('\n')
		.filter((l) => l.includes(substr)).length;
}

function cleanup(fx) {
	rmSync(fx.root, { recursive: true, force: true });
}

// ── the floor: a fixture with nothing wrong must pass ──────────────────────

test('a fully covered, all-online fleet exits 0 — without this every case below is vacuous', () => {
	const fx = fixture();
	try {
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, BACKSTOP, 'online')]);
		assert.equal(r.code, 0, `a clean fleet must pass, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /MISSING COVERAGE: none/);
	} finally {
		cleanup(fx);
	}
});

// ── #60: whose offline row fails ───────────────────────────────────────────

test("the backstop's offline registration fails the run like a claw's", () => {
	const fx = fixture();
	try {
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, BACKSTOP, 'offline')]);
		assert.equal(r.code, 1, `an offline row is an incident, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /OFFLINE \(1\)/);
	} finally {
		cleanup(fx);
	}
});

test("a CLAW's offline registration fails the run", () => {
	const fx = fixture();
	try {
		const r = run(fx, [runner(1, CLAW, 'offline'), runner(2, BACKSTOP, 'online')]);
		assert.equal(r.code, 1, `a claw's offline row is an incident, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /OFFLINE \(1\)/);
	} finally {
		cleanup(fx);
	}
});

// ── the --json contract ────────────────────────────────────────────────────

test('--json carries EVERY offline row under `offline`', () => {
	// `offline` is in JSON_CONTRACT and mgmt-api's fleet-coverage-check.ts reads
	// it by name, as `{repo, claw, runner}`.
	const fx = fixture();
	try {
		const r = run(fx, [runner(1, CLAW, 'offline'), runner(2, BACKSTOP, 'offline')], ['--json']);
		assert.equal(r.code, 1);
		assert.ok(r.bytes > 0, 'the report reached the file');
		const report = JSON.parse(r.out);
		assert.deepEqual(
			report.offline.map((o) => ({ ...o })).sort((a, b) => a.claw.localeCompare(b.claw)),
			[
				{ repo: REPO, runner: BACKSTOP, claw: BACKSTOP },
				{ repo: REPO, runner: CLAW, claw: CLAW },
			]
		);
	} finally {
		cleanup(fx);
	}
});

// ── the header must not say the opposite of the code ───────────────────────

test('the EXIT STATUS header describes the predicate the code actually uses', () => {
	// The sentence this replaces — "Offline runners and unmanaged runners never
	// fail the run — they are reported" — was false for the whole offline half
	// and cost a diagnosis. A comment is not evidence; this is the cheapest way
	// to keep it from becoming counter-evidence again.
	const header = readFileSync(SCRIPT, 'utf8').split('EXIT STATUS')[1]?.split('*/')[0] ?? '';
	assert.match(header, /offline registration on any node, the backstop included, fails the run/);
});

// ── #80: the last one-shot `gh` reads retry before could-not-look ──────────
//
// `listRunners` (the runner-listing read `ci:fleet-coverage` depends on, via
// `--json`'s `unreadable` field) and the repo roster read (`gh repo list`,
// which used to crash the whole reconciler uncaught on a single failure) are
// now retried per `READ_ATTEMPTS` before either is reported. The write paths
// — `registration-token`, `remove-token`, the capability `/labels` POST — are
// NEVER retried; the last test below proves a mint is invoked exactly once
// even when it fails every time.

test('a runner-listing read times out once and recovers: no finding in `unreadable`', () => {
	const fx = fixture();
	try {
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, BACKSTOP, 'online')], ['--json'], {
			GH_FAIL_WHAT: 'runners-read',
			GH_FAIL_TIMES: '1',
		});
		assert.equal(r.code, 0, `a transient blip that recovered must not fail the run:\n${r.out}`);
		assert.equal(
			attempts(fx.ghLog, 'actions/runners --paginate'),
			2,
			'the runner-listing read must have been retried exactly once'
		);
		const report = JSON.parse(r.out);
		assert.deepEqual(report.unreadable, []);
	} finally {
		cleanup(fx);
	}
});

test('a runner-listing read that never recovers is reported unreadable, carrying the reason and attempt N/M', () => {
	const fx = fixture();
	try {
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, BACKSTOP, 'online')], ['--json'], {
			GH_FAIL_WHAT: 'runners-read',
			GH_FAIL_TIMES: '999',
		});
		assert.equal(
			attempts(fx.ghLog, 'actions/runners --paginate'),
			READ_ATTEMPTS,
			`must be tried exactly ${READ_ATTEMPTS} times before it is reported unreadable`
		);
		const report = JSON.parse(r.out);
		// ci:fleet-coverage (fleet-coverage-check.ts:160) is what FAILS on this
		// field — the bare reconciler's own exit code does not count `unreadable`
		// at all (see the EXIT STATUS header), so the assertion that matters here
		// is the report's content, not this process's exit code.
		assert.equal(report.unreadable.length, 1);
		assert.equal(report.unreadable[0].repo, REPO);
		assert.match(report.unreadable[0].error, /ETIMEDOUT/, 'the reason must say WHY');
		assert.match(report.unreadable[0].error, /attempt 2\/2/, 'and that it survived the retry');
	} finally {
		cleanup(fx);
	}
});

// ── regression: the reason must carry STDOUT too, not stderr alone ─────────
//
// The sync `listRunners` this replaced joined `[err.stderr, err.stdout]` —
// "the body that names the rejected field is on STDOUT, so the reason was
// still half-missing" otherwise. The async rewrite's first version passed
// `stderr` alone into `describeReadFailure` and silently reopened that gap.
// This shim answers exactly that shape: the API's JSON error body on stdout,
// nothing diagnostic on stderr at all, failing every attempt.

test('an unreadable runner listing whose API body is on STDOUT ONLY still carries that body, with attempt N/M', () => {
	const fx = fixture();
	try {
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, BACKSTOP, 'online')], ['--json'], {
			GH_FAIL_WHAT: 'runners-read-stdout-body',
		});
		assert.equal(
			attempts(fx.ghLog, 'actions/runners --paginate'),
			READ_ATTEMPTS,
			`must still be tried exactly ${READ_ATTEMPTS} times`
		);
		const report = JSON.parse(r.out);
		assert.equal(report.unreadable.length, 1);
		assert.equal(report.unreadable[0].repo, REPO);
		assert.match(
			report.unreadable[0].error,
			/Resource not accessible by integration/,
			'the STDOUT body is the only place this reason lives — losing it leaves an unnamed failure'
		);
		assert.match(report.unreadable[0].error, /attempt 2\/2/);
	} finally {
		cleanup(fx);
	}
});

test('the repo roster read (`gh repo list`) times out once and recovers', () => {
	const fx = fixture();
	try {
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, BACKSTOP, 'online')], ['--json'], {
			GH_FAIL_WHAT: 'repo-list',
			GH_FAIL_TIMES: '1',
		});
		assert.equal(r.code, 0, `a transient blip that recovered must not fail the run:\n${r.out}`);
		assert.equal(attempts(fx.ghLog, 'repo list'), 2, 'must have been retried exactly once');
	} finally {
		cleanup(fx);
	}
});

test('a repo roster read that never recovers crashes loudly, naming why — never a silent empty roster', () => {
	const fx = fixture();
	try {
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, BACKSTOP, 'online')], ['--json'], {
			GH_FAIL_WHAT: 'repo-list',
			GH_FAIL_TIMES: '999',
		});
		assert.notEqual(r.code, 0, 'a roster that never resolves must not report a clean fleet');
		assert.equal(attempts(fx.ghLog, 'repo list'), READ_ATTEMPTS);
		assert.match(r.stderr, /ETIMEDOUT/);
		assert.match(r.stderr, /attempt 2\/2/);
	} finally {
		cleanup(fx);
	}
});

// ── (c) NEVER retry a write — a mint is invoked exactly once, even failing ──

test('a --confirm run with a missing pair calls the registration-token POST exactly once, even when it fails every time', () => {
	const fx = fixture();
	try {
		// ONE declared machine, not the shared fixture's CLAW+BACKSTOP pair — two
		// eligible placements would mint two SEPARATE tokens for two separate
		// pairs, which is not a retry and would make the count ambiguous. This
		// fixture asks a narrower question: for ONE missing pair, is the mint
		// invoked once.
		writeFileSync(
			join(fx.root, 'fleet-runner-manifest.json'),
			JSON.stringify({ machines: { [CLAW]: { labels: ['hadoku-builder'], maxConcurrent: 2 } } })
		);
		// Zero runners registered: CLAW is missing, so `mintToken('register')` is
		// reached for exactly that one pair.
		const r = run(fx, [], ['--json', '--confirm'], {
			GH_FAIL_WHAT: 'mint',
			GH_FAIL_TIMES: '999',
		});
		assert.notEqual(r.code, 0, 'a mint that fails every time must not report success');
		assert.equal(
			attempts(fx.ghLog, 'registration-token'),
			1,
			'a non-idempotent write must be invoked EXACTLY ONCE, never retried — a second call ' +
				'could register the pair twice or race the first'
		);
	} finally {
		cleanup(fx);
	}
});

// A new registration carries no `hadoku-builder` until the fast loop grants
// it. On 2026-10-22 that gap read as a bug and the label was written by hand.
// Registered on a fake node, because since #1 a claw's unit is started only
// after its slice and throttle provisioning have really run there.
test('a --confirm run that registers says when the builder label arrives, from the loop constants', () => {
	const fx = fixture();
	const node = createFakeNode({ runnerVersion: '2.337.0' });
	try {
		writeFileSync(
			join(fx.root, 'fleet-runner-manifest.json'),
			JSON.stringify({
				machines: {
					[CLAW]: {
						labels: ['hadoku-builder'],
						maxConcurrent: 2,
						minFreeMb: 1024,
						slice: {},
					},
				},
			})
		);
		const r = run(fx, [], ['--confirm'], {
			...node.env,
			PATH: `${node.callerBin}:${fx.bin}:${process.env.PATH}`,
			// A token the host may not supply: never the App's pool, never a real mint (#9).
			GH_TOKEN: 'fixture',
			HADOKU_SITE_ROOT: '/nonexistent',
			FLEET_NO_BANNER: '1',
		});
		assert.match(r.out, /Done: 1 registered/, r.out + r.stderr);
		assert.match(
			r.out,
			/fast loop grants hadoku-builder: within ~10 minutes\. Do not add it by hand\./
		);
	} finally {
		node.cleanup();
		cleanup(fx);
	}
});
