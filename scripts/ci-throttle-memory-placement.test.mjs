/**
 * ci-throttle's #67/#12 memory-placement cases: a confirmed memory-floor
 * breach must be diagnosed as PLACEMENT ("cannot host this job") only when
 * nothing else is admitted and MemAvailable held flat for the whole wait —
 * contention (another job running) or a MOVING reading (a transient) must
 * still read as "try again later", never as placement. Split out of
 * ci-throttle.test.mjs (wave 5p lane C) — see `lib/ci-throttle-fixtures.mjs`
 * for the shared `run()`/`nodeFixture()`/`spawnIdler()`/`runHook()` this
 * file drives the real `ci-throttle.sh` through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

import {
	installCiThrottleRig,
	installLeakGate,
	nodeFixture,
	run,
	runHook,
	spawnIdler,
} from './lib/ci-throttle-fixtures.mjs';

installCiThrottleRig();

// ── #67: CONTENTION AND PLACEMENT ARE TWO FINDINGS ─────────────────────────
//
// On 2026-09-26 21:18 hokon refused `hadoku-tenhands / Task automation` with:
//
//   ci-throttle: refused on hokon after 91s — 0 concurrent job(s), 7120MB
//   available (limit 4 job(s) / 8192MB free). Re-run once the node has a free
//   slot.
//
// Zero concurrent jobs, and a floor nothing of ours was going to free. The
// advice named a slot that was already free — all four were — so it could not
// be acted on, and re-running refused again.
//
// The discriminator is not "which test failed" but whether this gate saw
// ANOTHER ADMITTED JOB at any point in the wait. The pairs below are therefore
// A/B on one conf with only `others` differing: a lazy fix that simply stopped
// refusing on memory, or one that reworded every refusal, breaks the half where
// "try again later" is genuinely the right advice.

/** The exact shape of #67: hokon's conf, hokon's reading, nothing running. */
const HOKON_67 = {
	conf: { MAX_CONCURRENT: 4, MIN_FREE_MB: 8192, MAX_WAIT_S: 2 },
	memAvailableMb: 7120,
};

test('#67: a memory floor at ZERO admitted jobs refuses as PLACEMENT, not "wait for a slot"', () => {
	const r = run({ ...HOKON_67, others: 0 });
	const all = r.out + r.err;
	assert.notEqual(r.code, 0, `a confirmed floor breach must still fail the job: ${all}`);
	assert.match(all, /::error::ci-throttle: refused/, 'ADR 1751 annotation must survive');

	// The one thing the issue asks for: stop telling an operator to wait for a
	// slot that is already free. This is the assertion that fails with the fix
	// reverted.
	assert.doesNotMatch(
		all,
		/Re-run once the node has a free slot/,
		`at 0 concurrency there is no slot to wait for: ${all}`
	);
	assert.match(all, /cannot host this job/, all);
	assert.match(all, /placement problem, not a throttling one/, all);

	// The numbers, from the whole wait rather than the last sample: the
	// shortfall, the floor, the range MemAvailable held, and the slots that were
	// free throughout. All four are what makes the finding actionable.
	assert.match(all, /1072MB short of its 8192MB memory floor/, all);
	assert.match(all, /MemAvailable stayed 7120MB for the whole wait/, all);
	assert.match(all, /0 of 4 slot\(s\) were in use at any point in the wait/, all);
	// And what to actually do, naming the field and the redeploy.
	assert.match(all, /minFreeMb for this node in fleet-runner-manifest\.json/, all);
});

test('#67: the SAME conf with a job actually running STILL says try again later', () => {
	// The half a lazy fix breaks. Identical floor, identical reading, identical
	// breach — the only difference is that one admitted job is on the node, so
	// something WILL finish and waiting is the correct advice.
	const r = run({ ...HOKON_67, others: 1 });
	const all = r.out + r.err;
	assert.notEqual(r.code, 0, `memory pressure with a job running must still refuse: ${all}`);
	assert.match(all, /Re-run once the node has a free slot/, all);
	assert.doesNotMatch(
		all,
		/cannot host this job/,
		`one running job is contention, not size: ${all}`
	);
	assert.doesNotMatch(all, /placement problem/, all);
	assert.match(all, /1 concurrent job\(s\), peak 1/, all);
});

test('#67: a plain concurrency breach is untouched — it was always "try again later"', () => {
	const r = run({ conf: { MAX_CONCURRENT: 2, MIN_FREE_MB: 0, MAX_WAIT_S: 2 }, others: 2 });
	const all = r.out + r.err;
	assert.notEqual(r.code, 0);
	assert.match(all, /Re-run once the node has a free slot/, all);
	assert.doesNotMatch(all, /cannot host this job|placement problem/, all);
});

test('#67: the full wait still elapses before a placement refusal — one sample is not evidence', () => {
	// A JIT slot holds memory and no marker, so it is invisible to the admitted
	// count; only MemAvailable moving over time distinguishes one finishing in
	// 30s from a resident baseline. Refusing on the first pass would assert
	// "cannot" from a single reading.
	const r = run({ ...HOKON_67, others: 0 });
	assert.match(r.out + r.err, /cannot host this job/);
	assert.ok(r.elapsedMs >= 800, `refused too early to have measured anything: ${r.elapsedMs}ms`);
});

test('#67: a node that can admit NO job says so, rather than naming a free slot', () => {
	// maxConcurrent: 0 is not a configuration the fleet uses, but it reaches the
	// same rule from the other side: nothing was ever admitted, so there is
	// nothing to wait for. Left to the old message it would have read "limit 0
	// job(s) ... re-run once the node has a free slot".
	const r = run({
		conf: { MAX_CONCURRENT: 0, MIN_FREE_MB: 0, MAX_WAIT_S: 2 },
		others: 0,
		memAvailableMb: 999_999,
	});
	const all = r.out + r.err;
	assert.notEqual(r.code, 0, all);
	assert.match(all, /declared concurrency limit is 0, so no job can be admitted here at all/, all);
	assert.doesNotMatch(all, /Re-run once the node has a free slot/, all);
	assert.match(all, /Raise maxConcurrent/, all);
});

// ── fleet-manager#12: a MOVING floor is a transient, not a placement finding ──
//
// hokon refused bomberman's redeploy at 04:56 on 2026-10-27 with 0 of 4 slots
// in use and MemAvailable swinging 1732-7065MB across the 91s wait — every PM2
// service had restarted ~7 minutes earlier. It said "re-running will refuse
// again", and a re-run an hour later passed first time. The A/B below keeps
// the flat half: the SAME conf with memory that does not move still refuses at
// MAX_WAIT_S, fast, as placement.

const HOKON_12 = { MAX_CONCURRENT: 4, MIN_FREE_MB: 8192, MAX_WAIT_S: 2, MAX_HOLD_S: 6 };

test('#12: memory MOVING with free slots holds past MAX_WAIT_S and admits once it settles', () => {
	// The hook's sleep is seeded by its PID, so every pass sleeps the same
	// 1.5-3.5s and its first sample past MAX_WAIT_S lands by ~3.8s unloaded.
	// Settling at 8s leaves that sample 4s of slack on a busy host; it settled
	// at 4s until fleet-manager#13/#14, which left ~0.2s. The hold and the
	// spawn ceiling grow to cover the later admission. The ramp spans ~7.3s
	// rather than the default ~3.2s: at load 90 the hook's first sample landed
	// after the default ramp had gone flat, so it read no swing and refused.
	// At 220MB per 0.3s, any two samples the hook takes 1.5s apart before ~7.3s
	// differ by 1,100MB, over MEM_SWING_MB.
	const r = run({
		conf: { ...HOKON_12, MAX_HOLD_S: 20 },
		others: 0,
		memAvailableMb: 1732,
		memSwing: { fromMb: 1732, toMb: 7065, stepMb: 220, settleAfterS: 8, settledMb: 19_000 },
		timeout: 30_000,
	});
	const all = r.out + r.err;
	assert.equal(r.code, 0, `a settling transient must be admitted, not refused: ${all}`);
	assert.match(all, /a transient, not a baseline; holding up to 20s/, all);
	assert.match(all, /slot free after \d+s/, all);
	assert.ok(r.elapsedMs >= 7_500, `admitted before the swing could settle: ${r.elapsedMs}ms`);
});

test('#12: memory MOVING that never settles refuses at MAX_HOLD_S, and does NOT call it placement', () => {
	const r = run({
		conf: HOKON_12,
		others: 0,
		memAvailableMb: 1732,
		// The same ~7.3s ramp as the settling case above: the default ~3.2s one
		// had gone flat at 7065MB before a loaded hook's first sample (6.9s,
		// load 60, 2026-10-28), so "never settles" read as a flat baseline.
		memSwing: { fromMb: 1732, toMb: 7065, stepMb: 220 },
	});
	const all = r.out + r.err;
	assert.notEqual(r.code, 0, `the floor was never met, so the job is still refused: ${all}`);
	assert.match(all, /::error::ci-throttle: refused/, all);
	// $SECONDS is whole seconds, so `waited >= 6` can read true ~5.0s in.
	assert.ok(r.elapsedMs >= 5_000, `refused before MAX_HOLD_S: ${r.elapsedMs}ms`);
	// The two claims #12 caught being false.
	assert.doesNotMatch(all, /re-running will refuse again/, all);
	assert.doesNotMatch(all, /placement problem|cannot host this job/, all);
	assert.match(all, /a transient, not a baseline/, all);
	assert.match(all, /Re-run once the node's memory settles/, all);
});

// "Refused at MAX_WAIT_S (2s), not held for MAX_HOLD_S (600s)". The output
// says which branch ran; the time bound only has to tell 2s from 600s. It was
// 5s, and at load 60-90 the 2s wait itself took 5.3s.
const FAST_REFUSAL_MS = 30_000;

test('#12: the SAME conf with FLAT memory still refuses fast, as placement', () => {
	const r = run({ conf: { ...HOKON_12, MAX_HOLD_S: 600 }, others: 0, memAvailableMb: 7120 });
	const all = r.out + r.err;
	assert.notEqual(r.code, 0, all);
	assert.ok(
		r.elapsedMs < FAST_REFUSAL_MS,
		`a flat floor breach must not take the long hold: ${r.elapsedMs}ms`
	);
	assert.match(all, /re-running will refuse again/, all);
	assert.match(all, /placement problem, not a throttling one/, all);
	assert.doesNotMatch(all, /holding up to/, all);
});

test('#12: a swing below MEM_SWING_MB is still flat', () => {
	const r = run({
		conf: { ...HOKON_12, MAX_HOLD_S: 600 },
		others: 0,
		memAvailableMb: 7120,
		memSwing: { fromMb: 7120, toMb: 7600, stepMb: 100 },
	});
	const all = r.out + r.err;
	assert.notEqual(r.code, 0, all);
	assert.ok(r.elapsedMs < FAST_REFUSAL_MS, `480MB of noise is not a transient: ${r.elapsedMs}ms`);
	assert.match(all, /placement problem/, all);
	assert.doesNotMatch(all, /holding up to/, all);
});

test('#12: moving memory with a job RUNNING is contention, refused at MAX_WAIT_S, not held longer', () => {
	const r = run({
		conf: { ...HOKON_12, MAX_HOLD_S: 600 },
		others: 1,
		memAvailableMb: 1732,
		memSwing: { fromMb: 1732, toMb: 7065 },
	});
	const all = r.out + r.err;
	assert.notEqual(r.code, 0, all);
	assert.ok(
		r.elapsedMs < FAST_REFUSAL_MS,
		`contention already has the right wait: ${r.elapsedMs}ms`
	);
	assert.match(all, /Re-run once the node has a free slot/, all);
	assert.doesNotMatch(all, /holding up to/, all);
});

test('#67: an UNREADABLE admitted-job count never becomes a placement finding', () => {
	// `others()` fails open to 0 when the marker directory cannot be read, and
	// that 0 means "could not look", not "nothing running". A placement finding
	// reasons FROM a zero, so it must refuse to be built on that one — reading
	// "I could not look" as "nothing is wrong" is the thing CLAUDE.md forbids
	// outright. The memory breach is still real (it comes from the kernel), so
	// the job is still refused; what changes is the diagnosis and the advice.
	const fx = nodeFixture({
		maxConcurrent: 4,
		maxWaitS: 2,
		minFreeMb: 8192,
		memAvailableMb: 7120,
	});
	const idler = spawnIdler(fx, 30);
	try {
		execFileSync('chmod', ['0000', fx.admitDir]);
		try {
			const r = runHook(fx);
			assert.notEqual(r.code, 0, `a kernel-confirmed floor breach must refuse: ${r.out}`);
			assert.match(r.out, /UNREADABLE admitted-job count/, r.out);
			assert.match(r.out, /could not look/, r.out);
			assert.doesNotMatch(
				r.out,
				/cannot host this job|placement problem/,
				`a count that could not be taken cannot prove the node is too small: ${r.out}`
			);
		} finally {
			execFileSync('chmod', ['0755', fx.admitDir]);
		}
	} finally {
		idler.kill('SIGKILL');
		rmSync(fx.home, { recursive: true, force: true });
	}
});

installLeakGate();
