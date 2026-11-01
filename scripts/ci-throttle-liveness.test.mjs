/**
 * ci-throttle's #36 liveness cases: an admission marker counts only while
 * the pid that wrote it still lives, never by age, and a recycled pid never
 * inherits the marker it left behind. Split out of ci-throttle.test.mjs
 * (wave 5p lane C) — see `lib/ci-throttle-fixtures.mjs` for the shared
 * `nodeFixture`/`spawnJob`/`spawnIdler`/`runHook`/`reaped` this file drives
 * real processes and real markers through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	installCiThrottleRig,
	installLeakGate,
	nodeFixture,
	reaped,
	runHook,
	spawnIdler,
	spawnJob,
} from './lib/ci-throttle-fixtures.mjs';

installCiThrottleRig();

// ── #36: A WAITER IS NOT LOAD ──────────────────────────────────────────────
//
// `others()` used to be `pgrep -x Runner.Worker` minus this job's own worker,
// and every job blocked in this very script has a Runner.Worker of its own. So
// a burst counted itself: four jobs arriving together on hokon each saw the
// other three, `4 < 4` was false for all four, and all four were refused at the
// 90s ceiling with 26GB free and a real load of one. It recurred 2026-09-17,
// -18 and -19 (pygmalion, resume-bot, study, task).
//
// The cases below drive the real accounting and therefore deliberately do NOT
// set `CI_THROTTLE_TEST_OTHERS` — pinning the count is exactly what would hide
// this bug. They seat real processes and real markers under a temp `$HOME`
// instead, so nothing they observe comes from the machine running the test.

/** Field 22 of /proc/<pid>/stat, read the way the hook reads it. */
function startTimeOf(pid) {
	const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
	// `comm` is parenthesised and may contain spaces, so skip past it entirely
	// rather than splitting on whitespace from the left.
	return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
}

test('four jobs arriving together are all admitted in turn — a waiter is not load (#36)', async () => {
	// The deadlock, exactly as hokon met it: MAX_CONCURRENT=4, one job genuinely
	// running, four more arriving in the same instant. Under the old accounting
	// each of the four counted the other three, every one of them read 4 and
	// none was ever admitted. Under admission markers a waiter holds nothing, so
	// the one that finds the node full waits for a real slot and gets it.
	const fx = nodeFixture({ maxConcurrent: 4, maxWaitS: 20 });
	const kids = [];
	try {
		const real = spawnIdler(fx, 60);
		kids.push(real);
		writeFileSync(
			join(fx.admitDir, `${real.pid}.${startTimeOf(real.pid)}`),
			'the job already running on this node\n'
		);

		const waiters = [0, 1, 2, 3].map(() => spawnJob(fx, 3));
		kids.push(...waiters);
		const results = await Promise.all(waiters.map((w) => w.done));

		for (const [i, r] of results.entries()) {
			assert.equal(r.code, 0, `waiter ${i} was refused (exit ${r.code}): ${r.out}`);
			assert.doesNotMatch(r.out, /REFUS|::error::/, `waiter ${i} emitted a refusal: ${r.out}`);
		}
		// IN TURN, not all at once. Four waiters against three free slots means
		// exactly one had to hold and then be let in — if none did, the cap
		// stopped being a cap and this test would be passing for the wrong
		// reason. Both halves of that sentence are asserted: a run where the
		// hold never happened and a run where it happened and never ended look
		// identical from the exit codes alone.
		const transcript = results.map((r) => r.out).join('|');
		assert.ok(
			results.some((r) => /holding: \d+ other job/.test(r.out)),
			`no waiter ever held, so the cap admitted all four at once: ${transcript}`
		);
		assert.ok(
			results.some((r) => /slot free after \d+s/.test(r.out)),
			`a waiter held but no admission was ever reported as a wait: ${transcript}`
		);
	} finally {
		for (const k of kids) k.kill('SIGKILL');
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test('a marker counts while its pid lives and stops the instant it dies — liveness, never age', async () => {
	const fx = nodeFixture({ maxConcurrent: 1, maxWaitS: 3 });
	const idler = spawnIdler(fx, 60);
	const marker = join(fx.admitDir, `${idler.pid}.${startTimeOf(idler.pid)}`);
	try {
		writeFileSync(marker, 'one admitted job\n');

		// Live: it is the one slot, so the next job is refused. Without this half
		// the second half would pass against a count that is always zero.
		const refused = runHook(fx);
		assert.notEqual(refused.code, 0, `a live marker must hold the only slot: ${refused.out}`);
		assert.match(refused.out, /REFUS/i);
		assert.ok(existsSync(marker), 'a live marker must not be reaped');

		// Dead: the SAME marker, still seconds old. Nothing about the file
		// changed, so no age rule can explain the difference — only the pid.
		idler.kill('SIGKILL');
		await reaped(idler);
		const admitted = runHook(fx);
		assert.equal(admitted.code, 0, `a dead pid's marker must not count: ${admitted.out}`);
		// "Did not wait" is read off the transcript, not the clock: the hook says
		// `holding:` the first time through its wait loop, unconditionally. A
		// wall-clock bound failed this case at 2495ms on a box at load 88 while
		// the hook had admitted on its first pass.
		assert.doesNotMatch(admitted.out, /holding:/, `should not have waited at all: ${admitted.out}`);
		assert.equal(existsSync(marker), false, 'the pass that read it must also unlink it');
	} finally {
		idler.kill('SIGKILL');
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test('a recycled pid is a different process — the start time, not the pid, is the identity', async () => {
	// pids wrap. A marker naming a pid that something unrelated now owns would
	// hold a slot forever against a process that never ran a job.
	const fx = nodeFixture({ maxConcurrent: 1, maxWaitS: 3 });
	const idler = spawnIdler(fx, 60);
	// A start time of 1 clock tick after boot, which nothing spawned just now
	// can have.
	const marker = join(fx.admitDir, `${idler.pid}.1`);
	try {
		writeFileSync(marker, 'a marker left by whatever held this pid before\n');
		const r = runHook(fx);
		assert.equal(r.code, 0, `a recycled pid must not hold a slot: ${r.out}`);
		assert.equal(existsSync(marker), false, 'a stale marker must be unlinked, not left to rot');
	} finally {
		idler.kill('SIGKILL');
		rmSync(fx.home, { recursive: true, force: true });
	}
});

test('an unwritable marker directory fails OPEN, as the pgrep it replaced did', () => {
	// "I could not look" is uncertainty about the LIMIT, and this hook has never
	// refused on that — see its header. The directory is made unwritable rather
	// than deleted, because the hook creates a missing one.
	const fx = nodeFixture({ maxConcurrent: 1, maxWaitS: 3 });
	try {
		const idler = spawnIdler(fx, 30);
		writeFileSync(join(fx.admitDir, `${idler.pid}.${startTimeOf(idler.pid)}`), 'held\n');
		execFileSync('chmod', ['0000', fx.admitDir]);
		try {
			const r = runHook(fx);
			assert.equal(r.code, 0, `an unreadable marker dir must admit, not refuse: ${r.out}`);
			assert.doesNotMatch(r.out, /REFUS|::error::/);
		} finally {
			execFileSync('chmod', ['0755', fx.admitDir]);
			idler.kill('SIGKILL');
		}
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
	}
});

installLeakGate();
