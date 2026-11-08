/**
 * `ciRunnerVarCheck` (scripts/lib/reconcile-apply.mjs) — the piece of
 * `ci:runner-var` merged into `fleet reconcile --json` as the `runnerVar`
 * field (wave gates2 lane F1b, operator-approved). Split off the
 * `reconcile-fleet-runners*.test.mjs` family (same naming convention as
 * `-core`/`-coverage`) because this concern — a repo's shipped workflows vs
 * its `CI_RUNNER` GitHub Actions variable — shares neither fixture with
 * runner registration (`-core`) nor with the coverage file (`-coverage`).
 *
 * Calls the function DIRECTLY, in-process, with `gh` shimmed on PATH —
 * `ciRunnerVarCheck` is plain exported sync code, so there is no need to
 * spawn the whole `reconcile-fleet-runners.mjs` CLI just to prove its
 * `.github/workflows` listing/content reads and the `CI_RUNNER` variable
 * read behave. `scripts/lib/runner-var.test.mjs` already covers the PURE
 * verdict logic (`runnerVarForm`/`readRunnerVar`/`repoVerdict`) this file
 * reuses; this file is additive and covers only the `gh`-reading glue that
 * is new here (`ghJsonOr404`, `ciRunnerVarUses`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ciRunnerVarCheck } from './lib/reconcile-apply.mjs';
import { READ_ATTEMPTS } from './lib/read-retry-policy.mjs';

const REPO = 'WolffM/fixture-runner-var';

/**
 * A `gh` that answers `contents/.github/workflows` (a listing or a 404), each
 * file's content (base64), and the `CI_RUNNER` variable read — driven by env
 * vars so one shim serves every case below. Logs every call so a retry count
 * can be proven, the same shape `reconcile-fleet-runners-core.test.mjs` uses.
 */
const GH_SHIM = `#!/usr/bin/env bash
argv="$*"
[ -n "\${GH_LOG:-}" ] && printf '%s\\n' "$argv" >> "$GH_LOG"

fail_listing() {
	n=0
	[ -f "$COUNT_FILE.listing" ] && n=$(cat "$COUNT_FILE.listing")
	n=$((n + 1)); echo "$n" > "$COUNT_FILE.listing"
	[ "$n" -le "\${FAIL_LISTING_TIMES:-0}" ]
}

case "$argv" in
	*"contents/.github/workflows"*".yml"*)
		body="\${WORKFLOW_BODY:-}"
		if [ -z "$body" ]; then
			body='jobs:\\n  check:\\n    runs-on: \${{ fromJSON(vars.CI_RUNNER) }}\\n'
		fi
		printf '{"content":"%s"}\\n' "$(printf '%s' "$body" | base64 -w0)" ;;
	*"contents/.github/workflows"*)
		if [ -n "\${LISTING_404:-}" ]; then
			echo "gh: Not Found (HTTP 404)" >&2
			exit 1
		fi
		if fail_listing; then
			echo "gh: ETIMEDOUT waiting for api.github.com" >&2
			exit 1
		fi
		echo '[{"name":"ci.yml"}]' ;;
	*"actions/variables/CI_RUNNER"*)
		if [ -n "\${VAR_404:-}" ]; then
			echo "gh: Not Found (HTTP 404)" >&2
			exit 1
		fi
		echo "\${VAR_VALUE:-}" ;;
	*) echo '{}' ;;
esac
`;

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'runner-var-check-'));
	const bin = join(root, 'bin');
	mkdirSync(bin, { recursive: true });
	const ghBin = join(bin, 'gh');
	writeFileSync(ghBin, GH_SHIM);
	chmodSync(ghBin, 0o755);
	return { root, bin, logPath: join(root, 'gh.log'), countFile: join(root, 'count') };
}

function cleanup(fx) {
	rmSync(fx.root, { recursive: true, force: true });
}

/** Runs `fn` with `gh` shimmed on PATH and the given env overlaid. */
function withShimmedGh(fx, env, fn) {
	const prevPath = process.env.PATH;
	const prevEnv = { ...process.env };
	Object.assign(process.env, {
		PATH: `${fx.bin}:${prevPath}`,
		GH_LOG: fx.logPath,
		COUNT_FILE: fx.countFile,
		...env,
	});
	try {
		return fn();
	} finally {
		process.env.PATH = prevPath;
		for (const k of Object.keys(env)) delete process.env[k];
		Object.assign(process.env, prevEnv);
	}
}

test('a bare workflow with CI_RUNNER unset (404) is a finding — FAIL TO START', () => {
	const fx = fixture();
	try {
		const r = withShimmedGh(fx, { VAR_404: '1' }, () => ciRunnerVarCheck([REPO]));
		assert.equal(r.ok, false);
		assert.equal(r.findings.length, 1, JSON.stringify(r.findings));
		assert.equal(r.findings[0].repo, REPO);
		assert.match(r.findings[0].reason, /FAIL TO START/);
	} finally {
		cleanup(fx);
	}
});

test('a bare workflow with CI_RUNNER SET is clean — no finding', () => {
	const fx = fixture();
	try {
		const r = withShimmedGh(fx, { VAR_VALUE: '["self-hosted","hadoku-builder"]' }, () =>
			ciRunnerVarCheck([REPO])
		);
		assert.equal(r.ok, true);
		assert.deepEqual(r.findings, []);
	} finally {
		cleanup(fx);
	}
});

test('the fallback form with CI_RUNNER unset is NOT a finding — it still schedules', () => {
	const fx = fixture();
	try {
		const r = withShimmedGh(
			fx,
			{
				VAR_404: '1',
				// The fallback's own array contents never matter to runnerVarForm's
				// classification (only `fromJSON(vars.CI_RUNNER || ` does), so this
				// stays quote-free to dodge shell/JS escaping entirely.
				WORKFLOW_BODY: 'jobs:\\n  check:\\n    runs-on: ${{ fromJSON(vars.CI_RUNNER || cfg) }}\\n',
			},
			() => ciRunnerVarCheck([REPO])
		);
		assert.equal(r.ok, true, JSON.stringify(r.findings));
		assert.deepEqual(r.findings, []);
	} finally {
		cleanup(fx);
	}
});

test('a repo with NO .github/workflows directory (404 on the listing) draws no finding', () => {
	const fx = fixture();
	try {
		const r = withShimmedGh(fx, { LISTING_404: '1' }, () => ciRunnerVarCheck([REPO]));
		assert.equal(r.ok, true);
		assert.deepEqual(r.findings, []);
	} finally {
		cleanup(fx);
	}
});

test('a workflow-listing read that times out once and recovers draws no finding (retried)', () => {
	const fx = fixture();
	try {
		const r = withShimmedGh(
			fx,
			{ FAIL_LISTING_TIMES: '1', VAR_VALUE: '["self-hosted","hadoku-builder"]' },
			() => ciRunnerVarCheck([REPO])
		);
		assert.equal(r.ok, true, JSON.stringify(r.findings));
	} finally {
		cleanup(fx);
	}
});

test('a workflow-listing read that never recovers is a finding, not a silently clean repo', () => {
	const fx = fixture();
	try {
		const r = withShimmedGh(fx, { FAIL_LISTING_TIMES: String(READ_ATTEMPTS + 5) }, () =>
			ciRunnerVarCheck([REPO])
		);
		assert.equal(r.ok, false);
		assert.equal(r.findings.length, 1, JSON.stringify(r.findings));
		assert.equal(r.findings[0].repo, REPO);
		assert.match(r.findings[0].reason, /could not list \.github\/workflows/);
		assert.match(r.findings[0].reason, new RegExp(`attempt ${READ_ATTEMPTS}/${READ_ATTEMPTS}`));
	} finally {
		cleanup(fx);
	}
});

test('an empty population is ok:false with an error — scanning nothing is a broken scan', () => {
	const r = ciRunnerVarCheck([]);
	assert.equal(r.ok, false);
	assert.deepEqual(r.findings, []);
	assert.match(r.error, /empty population/);
});
