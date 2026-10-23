/**
 * WHOSE OFFLINE ROW FAILS THE RUN — #60.
 *
 * On 2026-09-26 a dry `fleet provision` of a claw exited 1 with `MISSING
 * COVERAGE: none`. The sole cause was `offline.length > 0`, and all 7 offline
 * rows were hokon's. hokon is a GUEST and a RESERVE: its stale registrations
 * are real drift, worth reporting, and not this fleet's to reinstall — so
 * failing on them made provisioning a DIFFERENT node impossible until someone
 * else's box was tidied.
 *
 * The file header said the opposite of the code ("Offline runners and unmanaged
 * runners never fail the run — they are reported") while the exit predicate
 * counted `offline.length`. That is the fourth time in this repo that a comment
 * has been read as evidence, so the last test here holds the header to the
 * code.
 *
 * NOT A WIDENING, and that is what the claw cases below exist to prove. A
 * CLAW's offline registration is an incident and still exits 1; a guest's row
 * beside it does not hide it either.
 *
 * The reconciler is a CLI over `gh` and `ssh`, so it is exercised as one, the
 * same way `reconcile-runner-identity.test.mjs` does it: a throwaway manifest
 * directory, shims first on PATH, and the EXIT CODE read directly rather than
 * grepped out of the output.
 *
 * NOTHING HERE SPAWNS git — the reconciler does not, and the environment below
 * strips GIT_* anyway. See lib/hook-safe-tests.test.mjs for why that matters.
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { READ_ATTEMPTS } from './lib/queue-health.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'reconcile-fleet-runners.mjs');

const CLAW = 'fixture-claw';
const GUEST = 'fixture-guest';
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
 * `sshArgv`, so the node is $5; stdin is drained first or the driver gets an
 * EPIPE instead of the result under test.
 */
const SSH_SHIM = `#!/usr/bin/env bash
cat > /dev/null
echo "PROBE-END \${5:-} 0 0"
`;

/** The ambient environment with every GIT_* variable removed. */
const NO_GIT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

/** A throwaway manifest dir, state dir and PATH shim dir, all in one. */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'reconcile-offline-'));
	writeFileSync(
		join(root, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: {
				[CLAW]: { labels: ['hadoku-builder'], maxConcurrent: 2 },
				// The whole point of the fixture: a guest that the manifest declares
				// exactly as it declares the claw, differing ONLY in `role`.
				[GUEST]: { role: 'guest', labels: ['hadoku-builder'], maxConcurrent: 2 },
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
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, GUEST, 'online')]);
		assert.equal(r.code, 0, `a clean fleet must pass, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /MISSING COVERAGE: none/);
	} finally {
		cleanup(fx);
	}
});

// ── #60: whose offline row fails ───────────────────────────────────────────

test("a GUEST's offline registration is reported and does NOT fail the run (#60)", () => {
	const fx = fixture();
	try {
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, GUEST, 'offline')]);
		assert.equal(
			r.code,
			0,
			`a guest's stale row must not fail a run provisioning a claw, got ${r.code}:\n${r.out}`
		);
		// Reported, though — "does not fail" is not "is not mentioned". The whole
		// contract here is that it stays visible while it stops being fatal.
		assert.match(r.out, /OFFLINE ON A GUEST \(1\)/);
		assert.match(r.out, new RegExp(GUEST));
	} finally {
		cleanup(fx);
	}
});

test("a CLAW's offline registration still fails the run — this is not a widening", () => {
	const fx = fixture();
	try {
		const r = run(fx, [runner(1, CLAW, 'offline'), runner(2, GUEST, 'online')]);
		assert.equal(r.code, 1, `a claw's offline row is an incident, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /OFFLINE \(1\)/);
		assert.doesNotMatch(r.out, /OFFLINE ON A GUEST/);
	} finally {
		cleanup(fx);
	}
});

test("a guest's offline row beside a claw's does not hide the claw's", () => {
	const fx = fixture();
	try {
		const r = run(fx, [runner(1, CLAW, 'offline'), runner(2, GUEST, 'offline')]);
		assert.equal(r.code, 1, `the claw still fails the run, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /OFFLINE \(1\)/);
		assert.match(r.out, /OFFLINE ON A GUEST \(1\)/);
	} finally {
		cleanup(fx);
	}
});

// ── the --json contract ────────────────────────────────────────────────────

test('--json still carries EVERY offline row under `offline`, guest ones marked', () => {
	// `offline` is in JSON_CONTRACT and mgmt-api's fleet-coverage-check.ts reads
	// it by name. The guest split must not shorten that array — it lives on the
	// ROW, so the consumer's `{repo, claw, runner}` shape is untouched and the
	// exit code and the report read the same fact from the same place.
	const fx = fixture();
	try {
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, GUEST, 'offline')], ['--json']);
		assert.equal(r.code, 0);
		assert.ok(r.bytes > 0, 'the report reached the file');
		const report = JSON.parse(r.out);
		assert.equal(report.offline.length, 1, 'the guest row is still in the contract field');
		assert.deepEqual(
			{ ...report.offline[0] },
			{ repo: REPO, runner: GUEST, claw: GUEST, guest: true }
		);

		const both = run(fx, [runner(1, CLAW, 'offline'), runner(2, GUEST, 'offline')], ['--json']);
		assert.equal(both.code, 1);
		const report2 = JSON.parse(both.out);
		assert.equal(report2.offline.length, 2);
		assert.deepEqual(
			report2.offline.map((o) => [o.claw, o.guest]).sort(),
			[
				[CLAW, false],
				[GUEST, true],
			].sort()
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
	assert.ok(header, 'the header still has an EXIT STATUS block');
	assert.doesNotMatch(
		header,
		/Offline runners and unmanaged runners never fail the run/,
		'the header must not claim offline never fails — a claw offline DOES fail'
	);
	assert.match(header, /CLAW/, 'it must say which offline rows fail');
	assert.match(header, /GUEST/, 'and which do not');
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
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, GUEST, 'online')], ['--json'], {
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
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, GUEST, 'online')], ['--json'], {
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
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, GUEST, 'online')], ['--json'], {
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
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, GUEST, 'online')], ['--json'], {
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
		const r = run(fx, [runner(1, CLAW, 'online'), runner(2, GUEST, 'online')], ['--json'], {
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
		// ONE declared machine, not the shared fixture's CLAW+GUEST pair — two
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

// ── --write-coverage / --check-coverage / --allow-shrink (#88, #86, #84 pt.2) ──
//
// A SEPARATE fixture from the one above: `--check-coverage` exits (0 or 1)
// before the runner-registration flow ever starts, and `--write-coverage`
// still reaches it afterward — these tests care about the coverage FILE and
// the exit/stdout `--check-coverage` produces, not registration state, so the
// `gh repo list` and job-metrics `ssh` shims are built fresh for a
// configurable repo list and a configurable set of job-metrics rows.

/** One job-metrics JIT row, already past the clock-differencing path. */
const metricsRow = (repo, peakMb, daysAgo = 1) =>
	JSON.stringify({
		repo,
		kind: 'jit',
		ts: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
		peakBytes: peakMb * 1048576,
	});

const GH_SHIM_COVERAGE = `#!/usr/bin/env bash
argv="$*"
case "$argv" in
  "repo list"*) cat "$GH_REPOS" ;;
  *"actions/runners"*) cat "$GH_RUNNERS" ;;
  *"-X POST"*"registration-token"*) echo "fixture-token" ;;
  *"-X POST"*"remove-token"*) echo "fixture-token" ;;
  *"-X POST"*"/labels") echo '{}' ;;
  *"releases/latest"*) echo 'v2.337.0' ;;
  *"trees/HEAD"*)
    # #84 part 2 send-back: a tree read that fails every READ_ATTEMPTS,
    # toggled per-test, so a refusal can be proven without touching the
    # happy-path branch every other coverage test relies on.
    if [ -n "\${GH_TREE_FAIL:-}" ]; then
      echo "gh: 403 API rate limit exceeded" >&2
      exit 1
    fi
    if [ -n "\${GH_TREE_TRUNCATED:-}" ]; then
      echo '{"tree":[],"truncated":true}'
    elif [ -n "\${GH_TREE_PKG_COUNT:-}" ]; then
      # #98: N manifests at p01/package.json ... pNN/package.json — a monorepo
      # past the old 12-read slice.
      printf '{"tree":['
      i=1
      while [ "$i" -le "$GH_TREE_PKG_COUNT" ]; do
        [ "$i" -gt 1 ] && printf ','
        printf '{"path":"p%02d/package.json","type":"blob"}' "$i"
        i=$((i + 1))
      done
      printf ']}\\n'
    elif [ -n "\${GH_TREE_MF:-}" ]; then
      # #98: a buildable micro-frontend layout — a vite config with a src/.
      echo '{"tree":[{"path":"vite.config.ts","type":"blob"},{"path":"src/main.ts","type":"blob"}]}'
    elif [ -n "\${GH_TREE_HAS_PKG:-}" ]; then
      echo '{"tree":[{"path":"package.json","type":"blob"}]}'
    else
      echo '{"tree":[]}'
    fi ;;
  *"contents/p"*"/package.json"*)
    # #98: the one manifest named by GH_PKG_UI_PATH declares the header
    # package; every other one declares nothing.
    if [ -n "\${GH_PKG_UI_PATH:-}" ] && [[ "$argv" == *"contents/$GH_PKG_UI_PATH"* ]]; then
      printf '{"content":"%s"}\\n' "$(printf '{"dependencies":{"@wolffm/task-ui-components":"^1.0.0"}}' | base64 -w0)"
    else
      printf '{"content":"%s"}\\n' "$(printf '{"dependencies":{}}' | base64 -w0)"
    fi ;;
  *"contents/package.json"*)
    # The package.json READ, separate from the tree listing above — same
    # failure toggle, same retry-every-attempt shape.
    if [ -n "\${GH_PKG_FAIL:-}" ]; then
      echo "gh: 500 Internal Server Error" >&2
      exit 1
    fi
    printf '{"content":"%s"}\\n' "$(printf '{"dependencies":{}}' | base64 -w0)" ;;
  "api repos/"*)
    # #135: a lookup of ONE repo by name. 404 unless GH_RENAMED ("old=new")
    # says GitHub redirects it; any deeper path keeps the generic answer.
    name="\${argv#api repos/}"
    if [[ "$name" != */*/* && "$name" != *" "* ]]; then
      renamed="\${GH_RENAMED:-}"
      if [ -n "$renamed" ] && [ "\${renamed%%=*}" = "$name" ]; then
        printf '{"full_name":"%s"}\\n' "\${renamed#*=}"
      else
        echo "gh: Not Found (HTTP 404)" >&2
        exit 1
      fi
    else
      echo '{}'
    fi ;;
  *) echo '{}' ;;
esac
`;

/**
 * Drains stdin (the script `runOnSync` sends), and answers the job-metrics
 * read specifically — every other ssh call (none of these tests make one
 * before CHECK_COVERAGE/WRITE_COVERAGE exits or writes) falls back to a
 * generic probe sentinel, matching the shared `SSH_SHIM` above.
 */
const SSH_SHIM_METRICS = `#!/usr/bin/env bash
script="$(cat)"
if [[ "$script" == *"job-metrics.jsonl"* ]]; then
  cat "$METRICS_ROWS" 2>/dev/null
  n=$(wc -l < "$METRICS_ROWS" 2>/dev/null | tr -d ' ')
  echo "#job-metrics-read-end kept=\${n:-0} older=0 files=1"
else
  echo "PROBE-END \${5:-} 0 0"
fi
`;

/**
 * `repos`: what `gh repo list` returns this run (becomes the LIVE roster,
 * given each also gets an explicit `manifest.repos` entry so resolution skips
 * autoInclude's own API calls entirely). `committedRepos`/`committedFacets`:
 * what is already on disk, the OTHER half of every comparison here.
 * `metricsRows`: raw job-metrics.jsonl lines every node's ssh read answers
 * with verbatim (one shared feed is enough — these tests are about the
 * roster/reserve LOGIC, not about telling nodes apart). `runners`: what
 * `actions/runners` answers for EVERY repo probed (one shared feed again) —
 * default empty, so a test that cares only about the coverage FILE need not
 * also satisfy the registration phase; a test that wants a clean exit code
 * passes one covering every (repo, claw) pair.
 */
function coverageFixture({
	repos,
	committedRepos,
	committedFacets,
	metricsRows,
	runners,
	skipRepos,
}) {
	const root = mkdtempSync(join(tmpdir(), 'reconcile-coverage-'));
	writeFileSync(
		join(root, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: { 'cov-claw-1': { labels: ['hadoku-builder'], maxConcurrent: 2 } },
			repos: Object.fromEntries([
				...(repos ?? []).map((r) => [r, {}]),
				...(skipRepos ?? []).map((r) => [r, { skip: true }]),
			]),
		})
	);
	writeFileSync(
		join(root, 'fleet-runner-coverage.json'),
		`${JSON.stringify({ repos: committedRepos ?? [], facets: committedFacets ?? {} }, null, 2)}\n`
	);
	const bin = join(root, 'bin');
	mkdirSync(bin, { recursive: true });
	for (const [name, src] of [
		['gh', GH_SHIM_COVERAGE],
		['ssh', SSH_SHIM_METRICS],
	]) {
		const p = join(bin, name);
		writeFileSync(p, src);
		chmodSync(p, 0o755);
	}
	const ghRepos = join(root, 'gh-repos.json');
	writeFileSync(
		ghRepos,
		JSON.stringify(
			(repos ?? []).map((r) => ({
				nameWithOwner: r,
				isFork: false,
				isArchived: false,
				pushedAt: new Date().toISOString(),
			}))
		)
	);
	const ghRunners = join(root, 'gh-runners.json');
	writeFileSync(
		ghRunners,
		JSON.stringify({ total_count: (runners ?? []).length, runners: runners ?? [] })
	);
	const metricsPath = join(root, 'metrics-rows.jsonl');
	writeFileSync(metricsPath, `${(metricsRows ?? []).join('\n')}\n`);
	// A HERMETIC site root, inside the fixture — `loadMountedApps()` reads
	// `scripts/child-apps.json` off `siteRoot()`, which falls back to the
	// AMBIENT box's own checkout when `HADOKU_SITE_ROOT` is unset (main-1db8a31:
	// every coverage test here silently read the real ~/repos/hadoku_site on a
	// dev box and broke in CI, which has no sibling checkout at all). Every test
	// gets this site root by default via `runCoverage`, so none of them can
	// depend on what happens to exist outside the fixture.
	const siteRoot = join(root, 'site');
	mkdirSync(join(siteRoot, 'scripts'), { recursive: true });
	writeFileSync(join(siteRoot, 'scripts', 'child-apps.json'), JSON.stringify({ apps: [] }));
	return {
		root,
		bin,
		ghRepos,
		ghRunners,
		metricsPath,
		siteRoot,
		coveragePath: join(root, 'fleet-runner-coverage.json'),
	};
}

function runCoverage(fx, argv, extraEnv = {}) {
	const outPath = join(fx.root, 'out.txt');
	const fd = openSync(outPath, 'w');
	let code = 0;
	let stderr = '';
	try {
		execFileSync('node', [SCRIPT, ...argv], {
			env: {
				...NO_GIT_ENV,
				PATH: `${fx.bin}:${process.env.PATH}`,
				FLEET_MANIFEST_DIR: fx.root,
				HADOKU_STATE_DIR: fx.root,
				GH_REPOS: fx.ghRepos,
				GH_RUNNERS: fx.ghRunners,
				METRICS_ROWS: fx.metricsPath,
				GH_PUSHED_AT: new Date().toISOString(),
				// HERMETIC by default — `loadMountedApps()` must read THIS fixture's
				// site root, never whatever happens to sit at the ambient box's own
				// `~/repos/hadoku_site` (or nothing, in CI). A test that specifically
				// wants the read to fail overrides one or both via `extraEnv` below.
				HADOKU_SITE_ROOT: fx.siteRoot,
				REPOS_DIR: fx.root,
				...extraEnv,
			},
			stdio: ['ignore', fd, 'pipe'],
			timeout: 60_000,
		});
	} catch (e) {
		code = e.status ?? -1;
		stderr = String(e.stderr ?? '');
	} finally {
		closeSync(fd);
	}
	return { code, out: readFileSync(outPath, 'utf8'), stderr };
}

test('--check-coverage: a repo leaving the live roster is STRUCTURAL and fails (#86 ask 1)', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha', 'WolffM/cov-beta'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
	});
	try {
		const r = runCoverage(fx, ['--check-coverage']);
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /fleet-runner-coverage\.json is stale/);
		assert.match(r.stderr, /cov-beta/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('--check-coverage: a measured repo whose jobP95Mb drifted is ADVISORY, not a failure (#86 ask 2)', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		committedFacets: {
			'WolffM/cov-alpha': { jobP95Mb: { mb: 1000, basis: 'measured', runs: 40 } },
		},
		// 5 rows meets RESERVE_MIN_RUNS (5), so this repo gets basis `measured`
		// again this run too — a REAL measured drift, not an under-the-floor one.
		metricsRows: [1, 2, 3, 4, 5].map(() => metricsRow('WolffM/cov-alpha', 5000)),
	});
	try {
		const r = runCoverage(fx, ['--check-coverage']);
		assert.equal(r.code, 0, r.out + r.stderr);
		assert.match(r.out, /stale-but-self-healing/);
		assert.match(r.out, /cov-alpha\.jobP95Mb: 1000MB/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test("--check-coverage: a quiet repo's basis moving from fleet-p95 to kept-last-measured is NOT drift (#86 ask 3, #88)", () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		// The exact production shape of brave-quartet's PRE-FIX committed entry:
		// basis `fleet-p95` (under min) but `lowerBound: true` — real evidence
		// from its own capped runs, which is what makes it "ever measured".
		committedFacets: {
			'WolffM/cov-alpha': {
				jobP95Mb: { mb: 6313, basis: 'fleet-p95', runs: 0, lowerBound: true },
			},
		},
		// cov-alpha itself has ZERO rows this run (quiet); the fleet p95 comes
		// entirely from an unrelated repo's rows, exactly as a real fleet's does.
		metricsRows: [1, 2, 3, 4, 5].map(() => metricsRow('WolffM/filler', 3215)),
	});
	try {
		const r = runCoverage(fx, ['--check-coverage']);
		assert.equal(r.code, 0, r.out + r.stderr);
		assert.doesNotMatch(r.out + r.stderr, /cov-alpha\.jobP95Mb/, 'no drift line for it at all');
		assert.match(r.out, /kept last measured 6313MB/, "#88's exact report line");
		assert.match(r.out, /0 runs in 14d/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test("--check-coverage: a NEVER-measured repo's moved fallback is not drift either (#86 ask 3 — vibecheck/games-host shape)", () => {
	// Distinct from the kept-last-measured case above: here the repo has NO
	// evidence of its own, ever (no lowerBound) — it stays on `fleet-p95` both
	// times, and the FLEET figure itself moved a lot (9000 -> 3215, 65%+). This
	// is the exact pre-#86 failure: vibecheck/games-host/task-mobile all read
	// as "stale" purely because the fallback they ride moved with the window.
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		committedFacets: {
			'WolffM/cov-alpha': { jobP95Mb: { mb: 9000, basis: 'fleet-p95', runs: 0 } },
		},
		metricsRows: [1, 2, 3, 4, 5].map(() => metricsRow('WolffM/filler', 3215)),
	});
	try {
		const r = runCoverage(fx, ['--check-coverage']);
		assert.equal(r.code, 0, r.out + r.stderr);
		assert.doesNotMatch(r.out + r.stderr, /cov-alpha\.jobP95Mb/, 'a moved fallback is not drift');
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('--write-coverage: a drastic roster shrink refuses the write, file left byte-identical (#84 part 2)', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-a', 'WolffM/cov-b', 'WolffM/cov-c', 'WolffM/cov-d'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
	});
	try {
		const before = readFileSync(fx.coveragePath, 'utf8');
		const r = runCoverage(fx, ['--write-coverage']);
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /refusing to write/);
		assert.match(r.stderr, /1 of 4 previous entries/);
		assert.equal(
			readFileSync(fx.coveragePath, 'utf8'),
			before,
			'a refused write must leave the file byte-identical, never degraded'
		);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('--write-coverage --allow-shrink lands the same drastic shrink on purpose', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-a', 'WolffM/cov-b', 'WolffM/cov-c', 'WolffM/cov-d'],
		// ON PURPOSE means answered: each dropped repo carries the manifest entry
		// a departure asks for. Without one they vanish unanswered (#135, below).
		skipRepos: ['WolffM/cov-a', 'WolffM/cov-b', 'WolffM/cov-c', 'WolffM/cov-d'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
		// Every (repo, claw) pair already registered and online, so the exit
		// code reflects the WRITE alone, never the unrelated registration phase
		// that runs after it.
		runners: [
			{
				id: 1,
				name: 'cov-claw-1',
				status: 'online',
				busy: false,
				labels: [{ name: 'hadoku-builder' }],
			},
		],
	});
	try {
		const r = runCoverage(fx, ['--write-coverage', '--allow-shrink']);
		assert.equal(r.code, 0, r.out + r.stderr);
		const onDisk = JSON.parse(readFileSync(fx.coveragePath, 'utf8'));
		assert.deepEqual(onDisk.repos, ['WolffM/cov-alpha']);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

// #135, the 2026-10-22 shape: a covered repo renamed away, with nothing yet
// under the old name and no manifest entry. It used to leave the roster in
// silence and the run exited 0, so the nightly workflow committed the drop.
test('#135: a covered repo renamed away is a departure that fails the run and names the new name', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha', 'WolffM/cov-renamed'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
		runners: [
			{
				id: 1,
				name: 'cov-claw-1',
				status: 'online',
				busy: false,
				labels: [{ name: 'hadoku-builder' }],
			},
		],
	});
	try {
		const r = runCoverage(fx, ['--write-coverage'], {
			GH_RENAMED: 'WolffM/cov-renamed=WolffM/cov-renamed-private',
		});
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.out, /LEFT THE ROSTER \(1\)/);
		assert.match(r.out, /WolffM\/cov-renamed +renamed on GitHub to WolffM\/cov-renamed-private/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

// ── facet reads must not degrade silently (#84 part 2 send-back, 2026-10-04) ──
//
// `repoTree`/`readJsonFile`/`loadMountedApps` used to swallow a failed read
// into `{}` / an empty Set, so a rate-limited or transient read WROTE a
// coverage file missing that repo's content facets — or, under
// `--check-coverage`, reported a FALSE structural-drift finding caused by this
// run's own read failure rather than anything that actually changed.

test('--write-coverage: a tree read that fails every attempt refuses the write, file byte-identical — and recovers once the read works again', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
	});
	try {
		const before = readFileSync(fx.coveragePath, 'utf8');
		const failed = runCoverage(fx, ['--write-coverage'], { GH_TREE_FAIL: '1' });
		assert.equal(failed.code, 1, failed.out + failed.stderr);
		assert.match(failed.stderr, /tree unreadable/);
		assert.match(failed.stderr, /WolffM\/cov-alpha/);
		assert.equal(
			readFileSync(fx.coveragePath, 'utf8'),
			before,
			'a refused write must leave the file byte-identical, never degraded'
		);

		// RESTORE: same fixture, same repo — the read works again, and the
		// write that was refused a moment ago now lands.
		runCoverage(fx, ['--write-coverage']);
		const onDisk = JSON.parse(readFileSync(fx.coveragePath, 'utf8'));
		assert.deepEqual(onDisk.repos, ['WolffM/cov-alpha']);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('--check-coverage: the same tree-read failure refuses too, and is never reported as structural drift', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
	});
	try {
		const r = runCoverage(fx, ['--check-coverage'], { GH_TREE_FAIL: '1' });
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /tree unreadable/);
		assert.doesNotMatch(
			r.stderr,
			/fleet-runner-coverage\.json is stale/,
			'a read failure is "I could not look", never drift'
		);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('--write-coverage: a package.json read that fails every attempt refuses the write too (readJsonFile)', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
	});
	try {
		const before = readFileSync(fx.coveragePath, 'utf8');
		const r = runCoverage(fx, ['--write-coverage'], { GH_TREE_HAS_PKG: '1', GH_PKG_FAIL: '1' });
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /package\.json unreadable/);
		assert.equal(readFileSync(fx.coveragePath, 'utf8'), before);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('--write-coverage: an unreadable child-apps.json is "could not look", not "no apps mounted" (loadMountedApps)', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
	});
	try {
		const before = readFileSync(fx.coveragePath, 'utf8');
		const r = runCoverage(fx, ['--write-coverage'], {
			// A site root that genuinely has no child-apps.json — hermetic,
			// regardless of what the ambient box's own ~/repos/hadoku_site holds.
			HADOKU_SITE_ROOT: fx.root,
		});
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /child-apps\.json unreadable/);
		assert.equal(readFileSync(fx.coveragePath, 'utf8'), before);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

// ── #98: facets come from EVERY manifest, and a partial tree is unreadable ──
//
// All three run `--check-coverage` against a committed roster whose cov-alpha
// has NO content facets, so the question each answers is whether the live
// derivation saw the thing that should change that.

const noFacetsFixture = () =>
	coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
	});

test('#98: a header dependency in the 13th package.json is seen — the old 12-read slice dropped it', () => {
	const fx = noFacetsFixture();
	try {
		const control = runCoverage(fx, ['--check-coverage'], { GH_TREE_PKG_COUNT: '13' });
		assert.equal(control.code, 0, `13 empty manifests must match no facets: ${control.stderr}`);

		const r = runCoverage(fx, ['--check-coverage'], {
			GH_TREE_PKG_COUNT: '13',
			GH_PKG_UI_PATH: 'p13/package.json',
		});
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /fleet-runner-coverage\.json is stale/);
		assert.match(r.stderr, /facets for WolffM\/cov-alpha/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('#98: a repo over the package.json read cap REFUSES rather than reading a subset', () => {
	const fx = noFacetsFixture();
	try {
		const r = runCoverage(fx, ['--check-coverage'], { GH_TREE_PKG_COUNT: '65' });
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /65 package\.json files, over the 64-read cap/);
		assert.doesNotMatch(r.stderr, /is stale/, 'could-not-look is never drift');
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('#98: a tree GitHub marked `truncated` is unreadable, not a repo with nothing in it', () => {
	const fx = noFacetsFixture();
	try {
		const r = runCoverage(fx, ['--check-coverage'], { GH_TREE_TRUNCATED: '1' });
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /tree unreadable — GitHub returned a truncated tree/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('#98: only an app IN the MF registry earns `microFrontend` — includeInRegistry:false is self-serving', () => {
	const fx = noFacetsFixture();
	const childApps = (entry) =>
		writeFileSync(
			join(fx.siteRoot, 'scripts', 'child-apps.json'),
			JSON.stringify({ apps: [{ id: 'alpha', repoName: 'cov-alpha', ...entry }] })
		);
	try {
		// Control: a registry app with a buildable layout gains the facet,
		// which the committed (facet-less) roster does not have.
		childApps({});
		const mounted = runCoverage(fx, ['--check-coverage'], { GH_TREE_MF: '1' });
		assert.equal(mounted.code, 1, mounted.out + mounted.stderr);
		assert.match(mounted.stderr, /facets for WolffM\/cov-alpha/);

		childApps({ includeInRegistry: false, tunnel: { serveOwnUI: true } });
		const own = runCoverage(fx, ['--check-coverage'], { GH_TREE_MF: '1' });
		assert.equal(own.code, 0, `a self-serving app must not be a micro-frontend: ${own.stderr}`);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});
