/**
 * ci-throttle's admission & config basics: the plain MAX_CONCURRENT/MAX_WAIT_S
 * cap (P3.4), the `$SECONDS`-boundary fix for the "holding:" announcement
 * (#73), the memory floor, and the two exempt-workflow cases. Split out of
 * ci-throttle.test.mjs (wave 5p lane C) — see `lib/ci-throttle-fixtures.mjs`
 * for the shared `run()`/`hookEnv()`/`ambient()` this file and its siblings
 * all drive the real `ci-throttle.sh` through.
 *
 * These drive the REAL script, same discipline as job-metrics-guard.test.mjs:
 * the property that matters is behavioural (what does it exit with, under
 * what config), not what the source text says it does. `CI_THROTTLE_TEST_OTHERS`
 * and `CI_THROTTLE_MEMINFO` are the only two test seams — see the script's own
 * comments on each; everything else here is a real, documented config knob
 * (`CI_THROTTLE_CONF`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	ambient,
	FIXTURE_PREFIX,
	HOOK,
	hookEnv,
	installCiThrottleRig,
	installLeakGate,
	run,
} from './lib/ci-throttle-fixtures.mjs';
import { tempDir } from './lib/test-tmpdir.mjs';

installCiThrottleRig();

test('under the limit: admits immediately, exit 0', () => {
	const r = run({ conf: { MAX_CONCURRENT: 3, MIN_FREE_MB: 0, MAX_WAIT_S: 5 }, others: 1 });
	assert.equal(r.code, 0);
	assert.ok(r.elapsedMs < 3000, `should not have waited at all, took ${r.elapsedMs}ms`);
});

test('the N+1th job against maxConcurrent=N waits, then is REFUSED, not admitted', () => {
	// This is the enforcement P3.4 exists for: 2 other jobs already running,
	// MAX_CONCURRENT=2 leaves no slot for a third, and it never clears because
	// CI_THROTTLE_TEST_OTHERS pins the count for the whole run.
	const r = run({ conf: { MAX_CONCURRENT: 2, MIN_FREE_MB: 0, MAX_WAIT_S: 2 }, others: 2 });
	assert.notEqual(r.code, 0, 'a job still over the cap after the full wait must be refused');
	assert.match(r.out + r.err, /REFUS/i);
	assert.match(r.out + r.err, /::error::/, 'ADR 1751 annotation must be on the refusal');
});

// ── #73: THE "holding:" LINE MUST NOT DEPEND ON $SECONDS' GRANULARITY ──────
//
// `waited` is whole-second `$SECONDS` arithmetic, and the first loop
// iteration reads it after config parsing, the self-worker ancestry walk and
// a full `others()` pass have already run. If that real wall-clock gap
// happens to straddle a one-second boundary, `waited` is already >= 1 on the
// very first iteration — and every iteration after it is further still — so
// the old gate (`[ "$waited" -eq 0 ]`) never fires for that job at all. It
// failed one publish (wave 3s) while CI on the same commit passed, because
// whether the boundary is crossed depends on machine load at the instant the
// job happens to run, not on anything this test can pin without a seam.
//
// `CI_THROTTLE_TEST_FIRST_PASS_DELAY_S` sleeps, test-only, between `start`
// being captured and the loop's first read of it — a >=1s sleep guarantees at
// least one `$SECONDS` boundary is crossed before that first read, the exact
// shape of the bug, made to happen on every run instead of waited for.

test('#73: "holding:" still announces when the first pass already crosses a $SECONDS boundary', () => {
	const r = run({
		conf: { MAX_CONCURRENT: 1, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 5,
		env: { CI_THROTTLE_TEST_FIRST_PASS_DELAY_S: '1.2' },
	});
	assert.notEqual(r.code, 0, 'still over the cap after the full wait — refused as before');
	assert.match(
		r.out + r.err,
		/holding: \d+ other job/,
		`never announced holding, even though it waited: ${r.out}${r.err}`
	);
});

test('#73: the ordinary (undelayed) path still announces holding too — the fix did not narrow it', () => {
	const r = run({ conf: { MAX_CONCURRENT: 1, MIN_FREE_MB: 0, MAX_WAIT_S: 2 }, others: 5 });
	assert.notEqual(r.code, 0);
	assert.match(r.out + r.err, /holding: \d+ other job/, `${r.out}${r.err}`);
});

test('the wait actually elapses before refusing — it is a cap, not an instant no', () => {
	// MAX_WAIT_S is measured against bash's $SECONDS, whole-second resolution,
	// so the loop can legitimately fire anywhere from just over 1s to just
	// under 3s for a ceiling of 2 — this only has to tell "waited" apart from
	// "instant no" (the under-500ms baseline every non-waiting case above
	// measures at), not pin the exact second under shared CI load.
	const r = run({ conf: { MAX_CONCURRENT: 1, MIN_FREE_MB: 0, MAX_WAIT_S: 2 }, others: 5 });
	assert.notEqual(r.code, 0);
	assert.ok(r.elapsedMs >= 800, `refused too early to have waited at all: ${r.elapsedMs}ms`);
});

// The test that used to sit here ('a slot that frees mid-wait still admits —
// the cap is not a permanent ban') used CI_THROTTLE_TEST_OTHERS, which PINS
// the count for the whole run (file header) — so its own fixture (others: 1
// against MAX_CONCURRENT: 5) was under the limit from the very first check
// and returned immediately, never waiting out any part of MAX_WAIT_S or
// observing a slot free at all. It was a weaker duplicate of "under the
// limit: admits immediately, exit 0" above, with a title that claimed the
// opposite of what it ran. The real version — real spawned jobs holding real
// markers, one of them exiting and freeing a slot a genuine waiter is then
// admitted into — is `ci-throttle-liveness.test.mjs`'s "four jobs arriving
// together are all admitted in turn" (#36), which asserts on the actual
// `slot free after \d+s` line this hook emits only on that real path.
// Deleted by the 2026-11-01 test audit (row 11).

test('the memory floor refuses too, independent of concurrency', () => {
	// Still a refusal, and that half is unchanged by #67 — what changed is the
	// DIAGNOSIS this now carries (see the #67 section below), not whether a
	// confirmed floor breach fails the job.
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 4096, MAX_WAIT_S: 2 },
		others: 0,
		memAvailableMb: 100,
	});
	assert.notEqual(r.code, 0);
	assert.match(r.out + r.err, /REFUS/i);
});

test('an exempt workflow is never refused, however far over the cap', () => {
	const r = run({
		conf: { MAX_CONCURRENT: 1, MIN_FREE_MB: 0, MAX_WAIT_S: 2 },
		others: 50,
		env: { GITHUB_WORKFLOW: 'Runner smoke test' },
	});
	assert.equal(r.code, 0, 'runner-smoke must start immediately regardless of contention');
});

test('an ambient GITHUB_WORKFLOW cannot exempt a case that did not ask for it', () => {
	// The other half of the case above. The exemption is real and must keep
	// working when a case ASKS for it; what it may not do is arrive by itself
	// from the environment the suite happens to run in. Poison the harness the
	// way a runner does and the cap must still hold.
	const saved = process.env.GITHUB_WORKFLOW;
	process.env.GITHUB_WORKFLOW = 'Runner smoke test';
	try {
		const r = run({ conf: { MAX_CONCURRENT: 1, MIN_FREE_MB: 0, MAX_WAIT_S: 2 }, others: 50 });
		assert.notEqual(r.code, 0, 'the cap must hold: no case here asked to be exempt');
		assert.match(r.out + r.err, /REFUS/i);
	} finally {
		if (saved === undefined) delete process.env.GITHUB_WORKFLOW;
		else process.env.GITHUB_WORKFLOW = saved;
	}
});

test('a broken config fails OPEN — uncertainty is never grounds for refusal', () => {
	const dir = tempDir(`${FIXTURE_PREFIX}badconf-`);
	try {
		const confPath = join(dir, 'ci-throttle.conf');
		writeFileSync(confPath, 'MAX_CONCURRENT=not-a-number\nMIN_FREE_MB=0\nMAX_WAIT_S=2\n');
		const meminfo = join(dir, 'meminfo');
		writeFileSync(meminfo, 'MemAvailable:   999999999 kB\n');
		const r = spawnSync('bash', [HOOK], {
			encoding: 'utf8',
			timeout: 15_000,
			env: hookEnv({
				...ambient(),
				HOME: dir,
				CI_THROTTLE_CONF: confPath,
				CI_THROTTLE_MEMINFO: meminfo,
				CI_THROTTLE_TEST_OTHERS: '50', // would refuse under any real cap
				CI_THROTTLE_PRUNE_ROOT: dir,
			}),
		});
		assert.equal(r.status, 0, 'a broken config must still admit the job');
		assert.match(r.stdout + r.stderr, /not a non-negative integer/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the default config (no conf file at all) is permissive, not enforcing', () => {
	// spawnSync, not execFileSync: a status assertion is the point of this test,
	// and `assert.ok(r.length >= 0)` on execFileSync's stdout — true of every
	// array, refusing or not — was the always-true assertion
	// test-vacuity-guard.test.mjs caught. The default MAX_CONCURRENT is 99, so
	// 50 "other" jobs must still admit; if the permissive default ever flipped
	// to enforcing, this would be the one test that catches it, so it has to
	// assert the exit code, not just "did not throw".
	const dir = tempDir(`${FIXTURE_PREFIX}noconf-`);
	try {
		const r = spawnSync('bash', [HOOK], {
			encoding: 'utf8',
			timeout: 15_000,
			env: hookEnv({
				...ambient(),
				HOME: dir,
				CI_THROTTLE_CONF: join(dir, 'does-not-exist.conf'),
				CI_THROTTLE_TEST_OTHERS: '50',
				CI_THROTTLE_PRUNE_ROOT: dir,
			}),
		});
		assert.equal(
			r.status,
			0,
			'a missing config must fall back to the permissive default, not refuse'
		);
		assert.doesNotMatch(
			r.stdout + r.stderr,
			/REFUS|::error::/,
			'the permissive default must never emit a refusal'
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

installLeakGate();
