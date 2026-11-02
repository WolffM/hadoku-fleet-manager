/**
 * `decideCiAlert`'s pure state machine — the first-break/recovery transitions
 * and the #20 re-page policy — split out of `ci-alerts.test.ts` (wave 5r
 * lane C) over `helpers/ci-alerts-rig.ts`. `decideCiAlert` is pure, so the
 * whole policy is exercised without GitHub, disk or Discord. What matters
 * operationally is not "a failure alerts" — it is the restraint around it.
 * Both staleness guards were written against real incidents (a two-week-old
 * deploy failure replaying as a fresh "recovered"), so a suite that only
 * proved the happy path would assert away everything they buy and still
 * pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideCiAlert, STALE_RUN_MS, STALE_STATE_MS } from '../ci-alerts-decide.js';
import { DAY_MS as REPAGE_INTERVAL_MS } from '../lib/job-runner.js';
import { NOW, ghRun, poll, run, state } from './helpers/ci-alerts-rig.js';

test('announces a fresh break', () => {
	const d = decideCiAlert(state(), run('failure'), NOW);
	assert.equal(d.action, 'broken');
	assert.ok(d.next, 'an announced break must persist state');
	assert.equal(d.next.lastAlertedRunId, 42);
});

test('announces a recovery it witnessed', () => {
	const d = decideCiAlert(state({ lastConclusion: 'failure' }), run('success'), NOW);
	assert.equal(d.action, 'recovered');
});

test('announces a recovery that arrives by re-run, on the very run id that was paged', () => {
	// `gh run rerun --failed` keeps the id: the break was paged on run 42 and
	// run 42 is now green. That is the transition the ✅ is for, and the
	// "already announced" guard is about repeating a PAGE, not about this.
	const paged = state({ lastConclusion: 'failure', lastRunId: 42, lastAlertedRunId: 42 });
	const d = decideCiAlert(paged, run('success'), NOW);
	assert.equal(d.action, 'recovered');
	assert.equal(d.next?.lastAlertedRunId, 42);
});

test('says nothing when the conclusion has not moved', () => {
	const d = decideCiAlert(state({ lastConclusion: 'success', lastRunId: 42 }), run('success'), NOW);
	assert.equal(d.action, 'none');
});

test('never announces the same run twice, however often the tick re-evaluates it', () => {
	// Duplicate ticks, a restart that re-reads state, a resync — all recompute
	// the same transition, and none of them is new information.
	const prev = state({ lastConclusion: 'success', lastAlertedRunId: 42 });
	const d = decideCiAlert(prev, run('failure'), NOW);
	assert.equal(d.action, 'suppressed');
	assert.match(d.reason ?? '', /already announced/);
});

test('does not resurrect a day-old red as a live incident', () => {
	// The durable guard: survives state loss, which is exactly when a cold
	// resync would otherwise replay ancient history as news.
	const old = run('failure', { created_at: new Date(NOW - STALE_RUN_MS - 1000).toISOString() });
	const d = decideCiAlert(state(), old, NOW);
	assert.equal(d.action, 'suppressed');
	assert.match(d.reason ?? '', /older than the freshness gate/);
});

test('stays quiet on a recovery computed across a blind gap', () => {
	// Blind for longer than STALE_STATE_MS: the "recovery" spans the gap rather
	// than describing an event, and the break it refers to was likely never
	// announced. Resync silently instead of crying wolf.
	const blind = state({
		lastConclusion: 'failure',
		lastSeen: new Date(NOW - STALE_STATE_MS - 1000).toISOString(),
	});
	const d = decideCiAlert(blind, run('success'), NOW);
	assert.equal(d.action, 'suppressed');
	assert.match(d.reason ?? '', /cold resync/);
});

test('a break IS announced after a blind gap, unlike a recovery', () => {
	// Deliberately asymmetric: a current failure is worth saying even after a
	// gap, as long as the failing run itself is recent. Only the recovery side
	// needs to have witnessed the break.
	const blind = state({ lastSeen: new Date(NOW - STALE_STATE_MS - 1000).toISOString() });
	const d = decideCiAlert(blind, run('failure'), NOW);
	assert.equal(d.action, 'broken');
});

test('a cancelled run is not a failure and does not clear a live break', () => {
	const broken = state({ lastConclusion: 'failure' });
	const d = decideCiAlert(broken, run('cancelled'), NOW);
	assert.equal(d.action, 'ignored');
	// null is "write nothing". Persisting anything here would end the streak.
	assert.equal(d.next, null);
});

test('a skipped run is likewise inert', () => {
	const broken = state({ lastConclusion: 'failure' });
	const d = decideCiAlert(broken, run('skipped'), NOW);
	assert.equal(d.action, 'ignored');
	assert.equal(d.next, null);
});

test('a FIRST-SIGHTING cancelled run persists nothing at all', () => {
	// The bug production found within one tick of shipping. With no prior state
	// there was nothing to fall back to, so `cancelled` was stored as the last
	// conclusion; every later tick read that back as "not null and not success"
	// — a live failure — and the next green run would have announced a recovery
	// from a break that never happened.
	const d = decideCiAlert(null, run('cancelled'), NOW);
	assert.equal(d.action, 'ignored');
	assert.equal(d.next, null);
});

test('a cancelled run cannot manufacture a recovery on the following tick', () => {
	// End-to-end on the actual regression: green -> cancelled -> green must be
	// silent throughout. If the cancelled tick stored anything, the third call
	// would announce "recovered".
	const healthy = state({ lastConclusion: 'success' });
	const ignored = decideCiAlert(healthy, run('cancelled', { id: 43 }), NOW);
	assert.equal(ignored.next, null);
	// State is unchanged, so the next green run is a no-op, not a recovery.
	const after = decideCiAlert(healthy, run('success', { id: 44 }), NOW);
	assert.equal(after.action, 'none');
});

test('first sighting of a broken workflow alerts, with no prior state at all', () => {
	const d = decideCiAlert(null, run('failure'), NOW);
	assert.equal(d.action, 'broken');
});

test('first sighting of a healthy workflow says nothing', () => {
	const d = decideCiAlert(null, run('success'), NOW);
	assert.equal(d.action, 'none');
});

test('a non-success conclusion that is not "failure" still counts as broken', () => {
	// timed_out / startup_failure are red too; only `success` is green.
	const d = decideCiAlert(state(), run('timed_out'), NOW);
	assert.equal(d.action, 'broken');
});

/*
 * ---------------------------------------------------------------------------
 * RE-PAGING A TARGET THAT IS ALREADY RED (#20).
 *
 * Everything below drives REAL runs off the watch list — ids, conclusions and
 * both timestamps as GitHub recorded them — because the whole question is a
 * question about timing, and a hand-picked interval proves only that the
 * constant equals itself. The two directions pull against each other and both
 * are alerting safety controls:
 *
 *   must page      #20: brave-quartet/ci, red since 2026-09-09, and a NEW
 *                  commit's failure on 09-10 swallowed as "no transition".
 *   must NOT page  a push storm inside one debugging session. Re-paging each of
 *                  those is the double-paging the ci-alerts / job-alerts
 *                  handoff was built to end (56 of 62 watched workflows
 *                  double-paged the emergency channel before 2026-09-08), and
 *                  reintroducing it from this side would be worse than #20.
 * ---------------------------------------------------------------------------
 */

test('#20: a new commit that fails on an already-red target re-pages', () => {
	// brave-quartet/ci, exactly as it happened. Run 34391097443 paged on 09-09.
	// The repo never went green, so the 09-10 push — a different commit
	// (b2ad33e9), a different run — was read as "red is still red, nothing to
	// say". It reached the operator 23 h later through the daily digest.
	const { actions, decisions } = poll([
		ghRun(33476511278, 'success', '2026-09-01T06:10:58Z', '2026-09-01T06:21:52Z'),
		ghRun(34391097443, 'failure', '2026-09-09T18:46:47Z', '2026-09-09T19:37:27Z'),
		// Both jobs died to a runner shutdown; a cancelled run is inert and must
		// not disturb the streak, so the re-page still measures from 09-09.
		ghRun(34538720673, 'cancelled', '2026-09-10T22:41:58Z', '2026-09-10T23:42:30Z'),
		ghRun(34543150470, 'failure', '2026-09-10T23:39:54Z', '2026-09-11T00:40:16Z'),
	]);
	assert.deepEqual(actions, ['none', 'broken', 'ignored', 'broken']);
	// 29.0 h since the previous page — past the window, and it says it is a
	// repeat rather than reporting a fresh break.
	assert.equal(decisions[3].repage, true);
	assert.equal(decisions[1].repage, undefined);
});

test('a push storm on a red target pages ONCE — the double-page stays shut', () => {
	// hadoku-dataplatform/ci, 2026-08-26: six failing runs on six commits inside
	// 1 h 46 m, one debugging session, then green. This is the common shape —
	// 27 of the 33 re-page candidates in the last 60 days landed within six
	// hours of the previous page. A rule that pages each of them is worse than
	// the bug it fixes.
	const { actions, decisions } = poll([
		ghRun(32971859073, 'success', '2026-08-26T13:02:16Z', '2026-08-26T13:14:03Z'),
		ghRun(33000685568, 'failure', '2026-08-26T18:37:16Z', '2026-08-26T18:44:01Z'),
		ghRun(33001626562, 'failure', '2026-08-26T18:47:26Z', '2026-08-26T18:54:35Z'),
		ghRun(33002479614, 'failure', '2026-08-26T18:56:42Z', '2026-08-26T19:02:52Z'),
		ghRun(33003494579, 'cancelled', '2026-08-26T19:07:45Z', '2026-08-26T19:12:14Z'),
		ghRun(33003863903, 'failure', '2026-08-26T19:11:53Z', '2026-08-26T19:18:57Z'),
		ghRun(33005968376, 'failure', '2026-08-26T19:35:34Z', '2026-08-26T19:43:03Z'),
		ghRun(33010116396, 'failure', '2026-08-26T20:23:02Z', '2026-08-26T20:29:52Z'),
		ghRun(33011202138, 'success', '2026-08-26T20:35:51Z', '2026-08-26T20:42:26Z'),
	]);
	assert.equal(
		actions.filter((a) => a === 'broken').length,
		1,
		`six failing runs in under two hours must produce ONE page, got ${actions.join(',')}`
	);
	assert.deepEqual(actions, [
		'none',
		'broken',
		'suppressed',
		'suppressed',
		'ignored',
		'suppressed',
		'suppressed',
		'suppressed',
		'recovered',
	]);
	for (const d of decisions.filter((x) => x.action === 'suppressed')) {
		assert.match(d.reason ?? '', /re-page window has not elapsed/);
	}
});

test('the re-page window is measured from the last PAGE, not the last failing run', () => {
	// ArchiveBot/deploy, 2026-01-20: eight failing runs in 50 minutes. If a
	// suppressed run advanced the throttle, a repo pushing faster than the
	// window would never be re-paged at all — the streak would silence itself
	// indefinitely. So the ninth failure, 24 h after the FIRST page rather than
	// after the eighth run, still pages.
	const storm = [
		ghRun(21156195150, 'failure', '2026-01-20T01:18:05Z', '2026-01-20T01:18:12Z'),
		ghRun(21156226122, 'failure', '2026-01-20T01:19:58Z', '2026-01-20T01:20:05Z'),
		ghRun(21156591086, 'failure', '2026-01-20T01:41:23Z', '2026-01-20T01:41:29Z'),
		ghRun(21156724354, 'failure', '2026-01-20T01:49:28Z', '2026-01-20T01:49:36Z'),
		ghRun(21156745451, 'failure', '2026-01-20T01:50:44Z', '2026-01-20T01:50:52Z'),
		ghRun(21156832188, 'failure', '2026-01-20T01:55:49Z', '2026-01-20T01:55:56Z'),
		ghRun(21156886808, 'failure', '2026-01-20T01:59:06Z', '2026-01-20T01:59:12Z'),
		ghRun(21157057613, 'failure', '2026-01-20T02:08:39Z', '2026-01-20T02:08:44Z'),
	];
	const { actions, state: after } = poll(storm);
	assert.equal(actions.filter((a) => a === 'broken').length, 1);
	assert.ok(after, 'the storm must have written state');
	// The stamp is still the first page's, 50 minutes before the last run.
	assert.equal(after.lastAlertedAt, '2026-01-20T01:23:12.000Z');

	// A ninth failure, 24 h after that first page.
	const firstPage = Date.parse('2026-01-20T01:23:12.000Z');
	const dueAt = firstPage + REPAGE_INTERVAL_MS;
	const ninth = ghRun(
		21157057614,
		'failure',
		new Date(dueAt - 60_000).toISOString(),
		new Date(dueAt).toISOString()
	);
	const due = decideCiAlert(
		{ ...after, lastSeen: new Date(dueAt - 60_000).toISOString() },
		ninth,
		dueAt
	);
	assert.equal(due.action, 'broken');
	assert.equal(due.repage, true);
});

test('one millisecond under the window is silence, and the window itself is a page', () => {
	// Both sides of the same boundary, so neither can be asserted away alone.
	const pagedAt = NOW - REPAGE_INTERVAL_MS;
	const red = state({
		lastConclusion: 'failure',
		lastRunId: 100,
		lastAlertedRunId: 100,
		lastAlertedAt: new Date(pagedAt).toISOString(),
	});
	const fresh = (id: number) =>
		ghRun(
			id,
			'failure',
			new Date(NOW - 120_000).toISOString(),
			new Date(NOW - 60_000).toISOString()
		);

	assert.equal(decideCiAlert(red, fresh(101), NOW).action, 'broken');
	const early = decideCiAlert(
		{ ...red, lastAlertedAt: new Date(pagedAt + 1).toISOString() },
		fresh(101),
		NOW
	);
	assert.equal(early.action, 'suppressed');
	assert.match(early.reason ?? '', /re-page window has not elapsed/);
});

test('an elapsed window never beats the freshness gate', () => {
	// The restraint that must survive the new rule. A red target whose newest
	// completed run finished days ago is history resurfacing — a lost state
	// file, a blind gap — and the window having elapsed is not evidence of an
	// incident. Reversing this order would page for every stale red at once,
	// which is precisely the mass double-page being kept shut.
	const red = state({
		lastConclusion: 'failure',
		lastRunId: 100,
		lastAlertedRunId: 100,
		lastAlertedAt: new Date(NOW - 10 * REPAGE_INTERVAL_MS).toISOString(),
	});
	const old = ghRun(
		101,
		'failure',
		new Date(NOW - STALE_RUN_MS - 7200_000).toISOString(),
		new Date(NOW - STALE_RUN_MS - 1000).toISOString()
	);
	const d = decideCiAlert(red, old, NOW);
	assert.equal(d.action, 'suppressed');
	assert.match(d.reason ?? '', /older than the freshness gate/);
});

test('re-evaluating the SAME failing run never re-pages, however long it stays latest', () => {
	// A red target with no new pushes sits on one run for days. The window
	// elapsing must not turn that into a page: nothing happened.
	const red = state({
		lastConclusion: 'failure',
		lastRunId: 101,
		lastAlertedRunId: 101,
		lastAlertedAt: new Date(NOW - 3 * REPAGE_INTERVAL_MS).toISOString(),
	});
	const created = new Date(NOW - 60_000).toISOString();
	const ended = new Date(NOW - 30_000).toISOString();
	assert.equal(decideCiAlert(red, ghRun(101, 'failure', created, ended), NOW).action, 'none');
	// And re-reported under a different conclusion it is still that same run,
	// caught by the idempotency guard rather than by the window.
	const requalified = decideCiAlert(red, ghRun(101, 'timed_out', created, ended), NOW);
	assert.equal(requalified.action, 'suppressed');
	assert.match(requalified.reason ?? '', /already announced/);
});

test('the throttle does not silence a genuinely NEW break', () => {
	// break -> recover -> break inside one hour. The second break is news, not a
	// repeat, so the window must not apply to it. Otherwise the rule that made
	// the alerter louder would have made it quieter.
	const { actions } = poll([
		ghRun(1, 'failure', '2026-09-08T10:00:00Z', '2026-09-08T10:05:00Z'),
		ghRun(2, 'success', '2026-09-08T10:20:00Z', '2026-09-08T10:25:00Z'),
		ghRun(3, 'failure', '2026-09-08T10:40:00Z', '2026-09-08T10:45:00Z'),
	]);
	assert.deepEqual(actions, ['broken', 'recovered', 'broken']);
});

test('the freshness gate measures when a run ENDED, not when it was queued', () => {
	// hadoku-filetransfer/redeploy run 32099697973: queued 04:35:21Z on
	// 2026-08-18, failed 13:30:32Z — 8 h 55 m, because the fleet's queue had
	// stalled. Against `created_at` that run was past the six-hour gate the
	// instant it appeared, so it could never be announced: the gate got EASIER
	// to pass the longer the job was stuck, and being stuck is the symptom.
	// Ten failing runs in the 90-day history are in that class.
	const stalled = ghRun(32099697973, 'failure', '2026-08-18T04:35:21Z', '2026-08-18T13:30:32Z');
	const seenAt = Date.parse('2026-08-18T13:35:00Z');
	assert.equal(decideCiAlert(null, stalled, seenAt).action, 'broken');

	// The gate still closes on the thing it was built for: the same run, met
	// seven hours after it finished, is history.
	const late = decideCiAlert(null, stalled, Date.parse('2026-08-18T20:31:00Z'));
	assert.equal(late.action, 'suppressed');
	assert.match(late.reason ?? '', /older than the freshness gate/);
});
