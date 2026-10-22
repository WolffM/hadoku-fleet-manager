import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	summariseQueue,
	queueFindings,
	isSaturated,
	readQueuedWithRetry,
	describeReadFailure,
	FAIL_SECONDS,
} from './queue-health.mjs';
// The BUILT copy: the backstop's backlog threshold must be THIS gate's fail
// floor, so the line that pages and the line that promotes hokon never drift.
import { BACKLOG_QUEUE_SECONDS } from '../../dist/runners/backstop.js';

test('the backstop promotes hokon on a backlog at the SAME floor this gate pages at', () => {
	assert.equal(
		BACKLOG_QUEUE_SECONDS,
		FAIL_SECONDS,
		'2026-10-21: the gate that declares the fleet "not serving work" and the gate that ' +
			'brings hokon in regardless of load read one number. Change both or neither.'
	);
});

const NOW = Date.parse('2026-09-02T12:00:00Z');
const STUCK_MS = 3_600_000;
/** A run queued `sec` seconds ago. */
const run = (repo, sec) => ({ repo, createdAt: new Date(NOW - sec * 1000).toISOString() });
const sum = (runs) => summariseQueue(runs, { stuckMs: STUCK_MS, nowMs: NOW });

test('an empty queue is a PASS, not a missing answer', () => {
	const s = sum([]);
	assert.deepEqual([s.queued, s.p50, s.p95, s.oldest], [0, 0, 0, 0]);
	assert.deepEqual(queueFindings(s, []), []);
});

test('THE OUTAGE: thirteen jobs at 11-19 minutes fails', () => {
	// 2026-09-01, reproduced. Every other gate was green through this: the sweep
	// passed, the census read claws_online=4, and label-floor reported clean
	// because the change had moved hadoku-builder into ephemeralOnly.
	const runs = Array.from({ length: 13 }, (_, i) => run(`WolffM/repo-${i}`, 660 + i * 40));
	const s = sum(runs);
	assert.equal(s.queued, 13);
	assert.ok(s.p95 > FAIL_SECONDS, `p95 ${s.p95}s must exceed the ${FAIL_SECONDS}s floor`);
	assert.match(queueFindings(s, [])[0], /not serving work/);
});

test('a legitimate JIT serve does NOT fail', () => {
	// MIN_QUEUED_MS 90s + a 60s fast-loop tick + a ~9s mint is the worst honest case.
	// A gate that reddens on this would fire on every healthy ephemeral node.
	const s = sum([run('WolffM/a', 160), run('WolffM/b', 120), run('WolffM/c', 95)]);
	assert.deepEqual(queueFindings(s, []), []);
});

test('STUCK runs are separated, not counted — or the gate is red forever', () => {
	// Two runs on this fleet have been queued since 2026-08-18. Folding them into
	// the percentile pins this permanently red, and a gate that is always red is
	// one nobody reads.
	const s = sum([
		run('WolffM/zombie', 370 * 3600),
		run('WolffM/zombie2', 339 * 3600),
		run('WolffM/live', 30),
	]);
	assert.equal(s.stuck.length, 2);
	assert.equal(s.queued, 1, 'only the live run counts toward the queue');
	assert.equal(s.p95, 30);
	assert.deepEqual(queueFindings(s, []), [], 'zombies alone must not fail the fleet');
});

test('one slow job does not condemn a moving fleet', () => {
	// p95 is the fleet's answer. A single outlier with everything else moving is
	// a placement problem for ONE job, not the fleet failing to serve work.
	const runs = [
		run('WolffM/slow', 900),
		...Array.from({ length: 30 }, (_, i) => run(`WolffM/r${i}`, 20)),
	];
	const s = sum(runs);
	assert.equal(s.oldest, 900, 'the outlier is still visible');
	assert.deepEqual(queueFindings(s, []), []);
});

test('but a fleet where MOST work is slow does fail', () => {
	const runs = Array.from({ length: 20 }, (_, i) => run(`WolffM/r${i}`, 400 + i));
	assert.ok(queueFindings(sum(runs), []).length === 1);
});

test('an unreadable repo is a FINDING, never an omission', () => {
	// A token that expired mid-sweep must not render as "nothing is queued".
	const s = sum([]);
	const f = queueFindings(s, ['WolffM/a', 'WolffM/b']);
	assert.equal(f.length, 1);
	assert.match(f[0], /could not read the queue for 2 repo/);
});

test('unreadable repos fail even when the queue that WAS read looks perfect', () => {
	const s = sum([run('WolffM/fine', 5)]);
	assert.equal(queueFindings(s, ['WolffM/blind']).length, 1);
});

/**
 * THE INVERSION. Excluding stuck runs from the p95 is right — two runs queued
 * since 2026-08-17/19 would pin this gate red forever — but it made the gate
 * PASS harder the worse the outage got. Measured 2026-09-07: the fleet served
 * nothing from 01:56 to 04:08, sixteen runs stacked up, and the gate reported
 * `ok: true, queued: 0` for the back half of it.
 */
const HOUR = 3600;
const at = (nowMs, ageSec) => new Date(nowMs - ageSec * 1000).toISOString();

test('an outage that outlasts the stuck ceiling still FAILS', () => {
	const now = Date.parse('2026-09-07T04:00:00Z');
	// Exactly the 04:00 shape: everything queued ~2h ago, nothing inside the
	// percentile, so p95 is 0 and the old rule reported a healthy fleet.
	const runs = ['a', 'b', 'c', 'd'].map((r) => ({
		repo: `WolffM/${r}`,
		createdAt: at(now, 2 * HOUR),
	}));
	const q = summariseQueue(runs, { stuckMs: HOUR * 1000, nowMs: now });
	assert.equal(q.p95, 0, 'the percentile really is empty — that was never the bug');
	assert.equal(q.stuck.length, 4, 'and `stuck` is unchanged for mgmt-api');

	const findings = queueFindings(q, [], FAIL_SECONDS);
	assert.ok(findings.length > 0, 'a fleet serving nothing for two hours must not read green');
	assert.match(findings.join(' '), /casualties|stopped serving/);
});

test('the two permanent zombies do NOT fail the gate', () => {
	// The whole reason the exclusion exists. A deleted branch and a label nothing
	// carries, ~20 days queued and uncancellable — folding them back in would pin
	// the gate red forever and undo the fix by overcorrecting.
	const now = Date.parse('2026-09-07T04:00:00Z');
	const runs = [
		{ repo: 'WolffM/hadoku-tenhands', createdAt: at(now, 20 * 24 * HOUR) },
		{ repo: 'WolffM/hadoku_site', createdAt: at(now, 19 * 24 * HOUR) },
	];
	const q = summariseQueue(runs, { stuckMs: HOUR * 1000, nowMs: now });
	assert.equal(q.zombie.length, 2);
	assert.equal(q.stranded.length, 0);
	assert.deepEqual(queueFindings(q, [], FAIL_SECONDS), [], 'zombies are reported, not failed');
});

test('zombies and fresh casualties in the same queue: the casualties still fail', () => {
	// The real 04:00 state — the mix is the normal case during an outage, and a
	// rule that only worked on a clean queue would never have fired.
	const now = Date.parse('2026-09-07T04:00:00Z');
	const q = summariseQueue(
		[
			{ repo: 'WolffM/hadoku-tenhands', createdAt: at(now, 20 * 24 * HOUR) },
			{ repo: 'WolffM/hadoku-scraper', createdAt: at(now, 90 * 60) },
		],
		{ stuckMs: HOUR * 1000, nowMs: now }
	);
	assert.equal(q.zombie.length, 1);
	assert.equal(q.stranded.length, 1);
	const findings = queueFindings(q, [], FAIL_SECONDS);
	assert.equal(findings.length, 1);
	assert.match(findings[0], /hadoku-scraper/);
	assert.doesNotMatch(findings[0], /tenhands/, 'the zombie is not named as a casualty');
});

test('a run created during the sweep never produces a negative age', () => {
	// The 2026-09-07 defect. `now` was stamped before a serial sweep of 27 repos,
	// so a run created while it was in flight read as negative — and a negative
	// sorts to the front of the percentile array and drags p50 DOWN, reporting
	// the queue healthier than it is.
	const NOW = 1_787_797_008_000;
	const q = summariseQueue(
		[
			{ repo: 'a', createdAt: new Date(NOW + 9_000).toISOString() },
			{ repo: 'b', createdAt: new Date(NOW - 15_000).toISOString() },
		],
		{ stuckMs: 3_600_000, nowMs: NOW }
	);
	assert.ok(
		q.waiting.every((w) => w.ageSec >= 0),
		'no queue age may be negative'
	);
	assert.ok(q.p50 >= 0, `p50 must not go negative, got ${q.p50}`);
	assert.equal(q.oldest, 15, 'the real oldest is unaffected by the clamp');
	assert.deepEqual(q.skewed, [], 'nine seconds is a slow sweep, not a broken clock');
});

test('a run MINUTES ahead of the clock is a finding, not a silent clamp', () => {
	// Clamping is right for a stale read and wrong for real skew: if this box and
	// GitHub disagree by minutes then every age here is understated by that much,
	// which hides a queue rather than showing one.
	const NOW = 1_787_797_008_000;
	const q = summariseQueue([{ repo: 'a', createdAt: new Date(NOW + 600_000).toISOString() }], {
		stuckMs: 3_600_000,
		nowMs: NOW,
	});
	assert.equal(q.skewed.length, 1);
	assert.equal(q.skewed[0].aheadSec, 600);
	const findings = queueFindings(q, []);
	assert.ok(
		findings.some((f) => /ahead of this box's clock/.test(f)),
		`skew must surface as a finding, got ${JSON.stringify(findings)}`
	);
});

/**
 * THE RETRY AND THE REASON.
 *
 * Measured 2026-09-07: five `could not read` findings against ~3,900 calls
 * (0.13%), a different repo each time, every one recovering untouched on the
 * next 10-minute run. All five repos answered in ~0.45s against a 20s timeout,
 * none archived or renamed; 216 hand-run calls produced zero failures and 80
 * latency probes gave p50 0.344s / max 0.430s. A coin-flip, paging @here.
 *
 * And the old `catch { return null }` meant a finding could name the repo and
 * nothing else, so none of those five was diagnosable after the fact.
 */

test('a transient failure is retried and the read succeeds', () => {
	let calls = 0;
	const readOnce = () => {
		calls++;
		if (calls === 1) throw Object.assign(new Error('boom'), { status: 1, stderr: 'blip' });
		return ['2026-09-07T04:00:00Z'];
	};
	let slept = 0;
	const r = readQueuedWithRetry('WolffM/x', readOnce, { sleep: () => slept++ });
	assert.equal(r.ok, true, 'one blip must not fail the gate');
	assert.deepEqual(r.created, ['2026-09-07T04:00:00Z']);
	assert.equal(calls, 2);
	assert.equal(slept, 1, 'it waits before retrying — an instant retry hits the same blip');
});

test('a repo that fails EVERY attempt is still unreadable — the rule is not softened', () => {
	// The negative half. Retrying must not become tolerating: "I could not look"
	// still has to fail, or this trades a noisy gate for a blind one.
	const readOnce = () => {
		throw Object.assign(new Error('nope'), { status: 4, stderr: 'gh: Not Found' });
	};
	const r = readQueuedWithRetry('WolffM/gone', readOnce, { sleep: () => {} });
	assert.equal(r.ok, false);
	assert.match(r.reason, /Not Found/);
	assert.match(r.reason, /attempt 2\/2/, 'the reason says how hard we tried');
});

test('the reason distinguishes a timeout from an API error', () => {
	// A rate limit, a 20s timeout and a deleted repo are three different jobs for
	// whoever gets paged. Collapsing them to "could not read" is what made the
	// five real findings undiagnosable.
	const timedOut = describeReadFailure({ killed: true, signal: 'SIGTERM' }, 20_000);
	assert.match(timedOut, /timed out after 20s/);
	assert.doesNotMatch(timedOut, /exit/);

	const rateLimited = describeReadFailure(
		{ status: 1, stderr: 'gh: API rate limit exceeded for user ID 8714327.' },
		20_000
	);
	assert.match(rateLimited, /rate limit exceeded/);
	assert.match(rateLimited, /exit 1/);
});

test('the finding NAMES the reason, not just the repo', () => {
	const findings = queueFindings({ p95: 0 }, [{ repo: 'WolffM/x', reason: 'exit 1: rate limit' }]);
	assert.equal(findings.length, 1);
	assert.match(findings[0], /WolffM\/x/);
	assert.match(findings[0], /rate limit/, 'the repo alone is not actionable');
});

test('a bare repo name still renders — callers holding only names keep working', () => {
	const findings = queueFindings({ p95: 0 }, ['WolffM/x']);
	assert.equal(findings.length, 1);
	assert.match(findings[0], /WolffM\/x/);
});

// A run GitHub never expanded into jobs is not fleet work (2026-10-07): a
// scheduled hadoku_site run sat queued with zero jobs, refused cancel and
// force-cancel, and paged @here as "the fleet is not serving work" at 905 s.
test('a queued run with zero jobs is unscheduled, not fleet queue age', () => {
	const now = Date.parse('2026-10-07T17:10:00Z');
	const q = summariseQueue(
		[{ repo: 'WolffM/hadoku_site', createdAt: '2026-10-07T16:55:00Z', jobless: true }],
		{ stuckMs: 60 * 60 * 1000, nowMs: now }
	);
	assert.equal(q.queued, 0);
	assert.equal(q.p95, 0);
	assert.deepEqual(q.unscheduled, [{ repo: 'WolffM/hadoku_site', ageSec: 900 }]);
	assert.deepEqual(queueFindings(q), []);
});

test('a run whose jobs could not be read still counts as fleet work', () => {
	const now = Date.parse('2026-10-07T17:10:00Z');
	const q = summariseQueue(
		[{ repo: 'WolffM/hadoku_site', createdAt: '2026-10-07T16:55:00Z', jobless: undefined }],
		{ stuckMs: 60 * 60 * 1000, nowMs: now }
	);
	assert.equal(q.queued, 1);
	assert.equal(q.unscheduled.length, 0);
	assert.equal(queueFindings(q).length, 1);
});

// --- saturation: every runner that could take it is busy -------------------

const JDK = ['self-hosted', 'hadoku-builder', 'jdk21'];
const busy = (labels = JDK) => ({ status: 'online', busy: true, labels });
const idle = (labels = JDK) => ({ status: 'online', busy: false, labels });

test('isSaturated: every matching runner busy is saturation (2026-10-08: three jdk21 claws all running Forge)', () => {
	assert.equal(
		isSaturated(
			[{ labels: JDK }],
			[busy(), busy(), busy(), idle(['self-hosted', 'hadoku-builder'])]
		),
		true
	);
});

test('isSaturated: an IDLE matching runner is not saturation — that is the black hole, a stall', () => {
	assert.equal(isSaturated([{ labels: JDK }], [busy(), idle()]), false);
});

test('isSaturated: NO matching runner online is not saturation — nothing minted, or all offline', () => {
	assert.equal(isSaturated([{ labels: JDK }], [busy(['self-hosted', 'hadoku-builder'])]), false);
	assert.equal(
		isSaturated([{ labels: JDK }], [{ status: 'offline', busy: true, labels: JDK }]),
		false
	);
});

test('isSaturated: every queued job must be saturated, and an unread or empty input never is', () => {
	assert.equal(isSaturated([{ labels: JDK }, { labels: ['self-hosted', 'gpu'] }], [busy()]), false);
	assert.equal(isSaturated([], [busy()]), false, 'a run held by needs: has no queued job');
	assert.equal(isSaturated(undefined, [busy()]), false);
	assert.equal(isSaturated([{ labels: JDK }], undefined), false);
});

/**
 * #115. The 2026-10-15 22:40Z page, as GitHub listed cardtable's runners: the
 * three jdk21 claws busy on Forge, hokon promoted at 22:36:01 and idle with
 * every label, the job not offered to it until 22:48:42.
 */
const hokon = (b = false) => ({ name: 'hokon', status: 'online', busy: b, labels: JDK });
const claw = (n, b = true, labels = JDK) => ({
	name: `warm-claw-${n}-hadoku-cardtable`,
	status: 'online',
	busy: b,
	labels,
});
const BACKSTOP = { isBackstop: (name) => name === 'hokon' };

test('isSaturated: an idle BACKSTOP beside busy claws is a promotion in flight, not a stall (#115)', () => {
	const runners = [
		claw(4),
		claw(8),
		claw(9),
		claw(1, false, ['self-hosted', 'hadoku-builder']),
		hokon(),
	];
	assert.equal(isSaturated([{ labels: JDK }], runners, BACKSTOP), true);
	// MUTATION: without the predicate, hokon reads as the black hole it is not.
	assert.equal(isSaturated([{ labels: JDK }], runners), false);
});

test('isSaturated: an idle CLAW beside the backstop is still the black hole', () => {
	assert.equal(isSaturated([{ labels: JDK }], [claw(4), claw(8, false), hokon()], BACKSTOP), false);
});

test('isSaturated: the backstop alone is never saturation — no claw matching is an outage', () => {
	assert.equal(isSaturated([{ labels: JDK }], [hokon(false)], BACKSTOP), false);
	assert.equal(isSaturated([{ labels: JDK }], [hokon(true)], BACKSTOP), false);
	assert.equal(
		isSaturated([{ labels: JDK }], [claw(4, true, ['self-hosted']), hokon()], BACKSTOP),
		false,
		'busy claws that cannot run the job do not count'
	);
});

test('isSaturated: labels match case-insensitively, as GitHub does', () => {
	assert.equal(isSaturated([{ labels: ['Self-Hosted', 'JDK21'] }], [busy()]), true);
});

test('a saturated run leaves the p95 — the 21:10Z page (1609 s) does not fire', () => {
	const s = sum([
		{ ...run('WolffM/hadoku-cardtable', 1609), saturated: true },
		run('WolffM/hadoku-cardtable', 78),
	]);
	assert.deepEqual(queueFindings(s, []), []);
	assert.equal(s.saturated.length, 1);
	assert.equal(s.queued, 1);
});

test('a saturated run past the stuck ceiling is STRANDED and fails — busy runners wedged on hung jobs still page', () => {
	const s = sum([{ ...run('WolffM/hadoku-cardtable', STUCK_MS / 1000 + 60), saturated: true }]);
	assert.equal(s.saturated.length, 0);
	assert.equal(s.stranded.length, 1);
	assert.match(queueFindings(s, []).join(' '), /stopped serving/);
});

test('an unsaturated old run still fails exactly as before', () => {
	const s = sum([run('WolffM/hadoku-cardtable', 497)]);
	assert.match(queueFindings(s, [])[0], /not serving work/);
});

// ── what the run's jobs say over what the run listing says (2026-10-11) ──────

test('a run listed queued whose jobs have all started is not waiting — the 13:00:17Z page (1392 s)', () => {
	const now = Date.parse('2026-10-11T13:00:17Z');
	const q = summariseQueue(
		[{ repo: 'WolffM/hadoku-cardtable', createdAt: '2026-10-11T12:37:05Z', started: true }],
		{ stuckMs: 60 * 60 * 1000, nowMs: now }
	);
	assert.equal(q.queued, 0);
	assert.deepEqual(q.started, [{ repo: 'WolffM/hadoku-cardtable', ageSec: 1392 }]);
	assert.deepEqual(queueFindings(q), []);
});

test('age runs from the first QUEUED job, not run creation — run 38131197998 waited 40 min, not 66', () => {
	const now = Date.parse('2026-10-11T11:20:00Z');
	const q = summariseQueue(
		[
			{
				repo: 'WolffM/hadoku-cardtable',
				createdAt: '2026-10-11T10:13:48Z',
				queuedSince: '2026-10-11T10:40:32Z',
				saturated: true,
			},
		],
		{ stuckMs: 60 * 60 * 1000, nowMs: now }
	);
	assert.deepEqual(q.stranded, [], 'a job that did not exist yet could not have been placed');
	assert.deepEqual(q.saturated, [{ repo: 'WolffM/hadoku-cardtable', ageSec: 2368 }]);
});

test('an unread or unparseable queuedSince falls back to run creation — the strict direction', () => {
	const now = Date.parse('2026-10-11T11:20:00Z');
	for (const queuedSince of [undefined, 'not-a-date']) {
		const q = summariseQueue(
			[{ repo: 'WolffM/hadoku-cardtable', createdAt: '2026-10-11T10:13:48Z', queuedSince }],
			{ stuckMs: 60 * 60 * 1000, nowMs: now }
		);
		assert.deepEqual(q.stranded, [{ repo: 'WolffM/hadoku-cardtable', ageSec: 3972 }]);
	}
});
