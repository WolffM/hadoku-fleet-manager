/**
 * The CI-red alert policy, moved here from monitoring-api's ci-check.
 *
 * `decideCiAlert` is pure, so the whole policy is exercised without GitHub,
 * disk or Discord. What matters operationally is not "a failure alerts" — it is
 * the restraint around it. Both staleness guards were written against real
 * incidents (a two-week-old deploy failure replaying as a fresh "recovered"),
 * so a suite that only proved the happy path would assert away everything they
 * buy and still pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmpdir.js';

import {
	ciAlertsBootPassDue,
	lastCleanCiAlertsPassMs,
	CI_ALERTS_BOOT_SKIP_MS,
	CI_ALERTS_PASS_FILE,
	decideCiAlert,
	formatCiTickSummary,
	runCiAlerts,
	runEndedAt,
	runsEndedSince,
	stateKey,
	REPAGE_INTERVAL_MS,
	RUN_PAGE_SIZE,
	STALE_RUN_MS,
	STALE_STATE_MS,
	type CiAction,
	type CiDecision,
	type CiRun,
	type CiState,
	type CiTickSummary,
} from '../ci-alerts.js';
import { __setHostForTesting, stateDir } from '../host.js';
import { testHost } from './install-test-host.js';

const NOW = Date.parse('2026-09-08T12:00:00.000Z');

function run(conclusion: string | null, over: Partial<CiRun> = {}): CiRun {
	return {
		id: 42,
		conclusion,
		status: 'completed',
		html_url: 'https://github.com/WolffM/hadoku-fleet-manager/actions/runs/42',
		created_at: new Date(NOW - 60_000).toISOString(), // a minute old: fresh
		...over,
	};
}

function state(over: Partial<CiState> = {}): CiState {
	return {
		lastConclusion: 'success',
		lastRunId: 41,
		lastSeen: new Date(NOW - 60_000).toISOString(),
		...over,
	};
}

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

/** A run exactly as the API returns it: queued at `created`, concluded at `ended`. */
function ghRun(id: number, conclusion: string | null, created: string, ended: string): CiRun {
	return {
		id,
		conclusion,
		status: 'completed',
		html_url: `https://github.com/WolffM/x/actions/runs/${id}`,
		created_at: created,
		updated_at: ended,
	};
}

/**
 * Replays a real run sequence the way the 10-minute poller meets it: each run
 * becomes the latest completed run shortly after it concludes, and the ticks in
 * between see nothing new and only refresh `lastSeen` (folded in, rather than
 * looped, so the fixtures stay the runs and not the clock).
 */
function poll(runs: CiRun[], start: CiState | null = null) {
	let state = start;
	const decisions: CiDecision[] = [];
	for (const r of runs) {
		const at = Date.parse(r.updated_at ?? r.created_at) + 5 * 60_000;
		const prev = state ? { ...state, lastSeen: new Date(at - 10 * 60_000).toISOString() } : null;
		const d = decideCiAlert(prev, r, at);
		decisions.push(d);
		if (d.next) state = d.next;
	}
	return { decisions, actions: decisions.map((d) => d.action), state };
}

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

test('a watched workflow with no state row is reported as null, not omitted', () => {
	// The ci-state endpoint drives its output from the TARGET list, not the
	// state file. A never-polled workflow must appear as `null` so the sitrep
	// can render "not yet polled" — dropping the row would let an unpolled
	// workflow read as green by absence, which is the failure this whole
	// alerter exists to prevent.
	const targets = [
		{ owner: 'WolffM', repo: 'a', workflow: 'ci.yml', label: 'a / ci' },
		{ owner: 'WolffM', repo: 'b', workflow: 'ci.yml', label: 'b / ci' },
	];
	const states: Record<string, CiState> = {
		'WolffM/a/ci.yml': { lastConclusion: 'failure', lastSeen: 'x' },
	};
	const rows = targets.map((t) => ({
		label: t.label,
		conclusion: states[stateKey(t)]?.lastConclusion ?? null,
	}));
	assert.deepEqual(rows, [
		{ label: 'a / ci', conclusion: 'failure' },
		{ label: 'b / ci', conclusion: null },
	]);
});

/*
 * ---------------------------------------------------------------------------
 * A FAILURE THAT WAS NEVER THE LATEST RUN BY THE TIME ANYONE LOOKED (#32).
 *
 * #20 is "red -> red was read as no transition". This is one level earlier and
 * strictly worse: the failing run never reached the state machine at all,
 * because `per_page=1` asks "what is the newest run" and the alerter's question
 * is "what has concluded since I last looked". A push landing on top of a
 * failure makes those two different answers, and then there is nothing in the
 * log either — no decision was taken, so no decision was recorded.
 *
 * Everything below drives the REAL hadoku-watchparty/ci payloads at the REAL
 * tick times taken from mgmt-api's log, because the whole question is a
 * question about seconds.
 * ---------------------------------------------------------------------------
 */

/** The tick, as `runCiAlerts` runs it: no GitHub, no disk, no Discord. */
function pollTicks(all: CiRun[], tickTimes: number[], start: CiState | null = null) {
	let row = start;
	const seen: Array<{ at: number; id: number; action: CiAction; reason?: string }> = [];
	for (const at of tickTimes) {
		// What GitHub returns: completed runs, newest `created_at` first, capped
		// at the page size. That ordering is the whole trap.
		const page = all
			.filter((r) => runEndedAt(r) <= at)
			.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
			.slice(0, RUN_PAGE_SIZE);
		if (!page.length) continue;
		const fresh = runsEndedSince(page, row);
		if (!fresh.length) continue;
		let watermark = row?.lastEndedAt ? Date.parse(row.lastEndedAt) : 0;
		for (const r of fresh) {
			const d = decideCiAlert(row, r, at);
			seen.push({ at, id: r.id, action: d.action, reason: d.reason });
			if (d.next) row = d.next;
			watermark = Math.max(watermark, runEndedAt(r));
		}
		if (row) row = { ...row, lastEndedAt: new Date(watermark).toISOString() };
	}
	return { seen, actions: seen.map((s) => s.action), state: row };
}

/** hadoku-watchparty / ci, exactly as the API records it. */
const WATCHPARTY = [
	ghRun(34898026676, 'cancelled', '2026-09-14T21:18:09Z', '2026-09-14T21:18:29Z'),
	ghRun(34898057754, 'success', '2026-09-14T21:18:27Z', '2026-09-14T21:20:17Z'),
	// The lint job. Nobody was told.
	ghRun(35021074573, 'failure', '2026-09-15T20:40:27Z', '2026-09-15T20:41:57Z'),
	// Pushed 2m53s later; GREEN 3m58s after the failure concluded, and created
	// AFTER it — so from this moment on it is what `per_page=1` returns.
	ghRun(35021360153, 'success', '2026-09-15T20:43:20Z', '2026-09-15T20:45:55Z'),
	ghRun(35023767551, 'success', '2026-09-15T21:07:32Z', '2026-09-15T21:09:38Z'),
];

/**
 * The real ticks. mgmt-api's runner-health summary lands at the END of a tick
 * and `runCiAlerts` is fired at its start, ~13s earlier (measured from the
 * 21:52:25 "monitor started" / 21:52:38 summary pair in the same log), so these
 * are the summary stamps minus 13s — the EARLIEST the poll can have happened.
 * The adversarial choice: at 20:45:58 the green run has been complete for three
 * seconds, so `per_page=1` is already answering with it.
 */
const TICKS = [
	Date.parse('2026-09-15T20:35:56Z'),
	Date.parse('2026-09-15T20:45:58Z'),
	Date.parse('2026-09-15T20:55:57Z'),
];

/** State as the poller held it at the 20:36 tick: green since 09-14. */
const BEFORE: CiState = {
	lastConclusion: 'success',
	lastRunId: 34898057754,
	lastSeen: '2026-09-15T20:25:55.000Z',
	lastAlertedRunId: 34683448906,
	lastEndedAt: '2026-09-14T21:20:17.000Z',
};

test('#32: a failure superseded by a green run before the next poll is STILL announced', () => {
	const { seen, actions } = pollTicks(WATCHPARTY, TICKS, BEFORE);

	const broken = seen.filter((s) => s.action === 'broken');
	assert.equal(
		broken.length,
		1,
		`the 20:40Z lint failure must page exactly once, got ${JSON.stringify(seen)}`
	);
	assert.equal(broken[0].id, 35021074573, 'and it must be THAT run, not the green one on top');
	// Both conclusions happened, so both are said, in the order they happened.
	assert.deepEqual(actions, ['broken', 'recovered']);
	assert.equal(seen[1].id, 35021360153);
});

test('#32: the run is evaluated even though it was never the newest run at a poll', () => {
	// The property under the fix, stated without the state machine. At 20:45:58
	// the page is [green(created 20:43), red(created 20:40)] — `runs[0]` is the
	// green one, and every poll from here on answers green.
	const at = Date.parse('2026-09-15T20:45:58Z');
	const page = WATCHPARTY.filter((r) => runEndedAt(r) <= at).sort(
		(a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
	);
	assert.equal(page[0].id, 35021360153, 'the newest run by created_at is the GREEN one');
	assert.deepEqual(
		runsEndedSince(page, BEFORE).map((r) => r.id),
		[35021074573, 35021360153],
		'both must be handed back, oldest conclusion first'
	);
});

test('a run is handed back once and only once, however long it stays on the page', () => {
	// The hazard the watermark exists for. Re-feeding a failure/recovery pair
	// re-derives the transition, and `lastAlertedRunId` remembers exactly one
	// run — so a lookback that re-reads the page would announce the SAME
	// recovery on every tick for as long as both runs stayed on it.
	const later = [...TICKS, Date.parse('2026-09-15T21:05:57Z'), Date.parse('2026-09-15T21:15:57Z')];
	const { actions, state } = pollTicks(WATCHPARTY, later, BEFORE);
	assert.equal(actions.filter((a) => a === 'recovered').length, 1, actions.join(','));
	assert.deepEqual(actions, ['broken', 'recovered', 'none']);
	// The third decision is the 21:07 run: genuinely new, green on green.
	assert.ok(state);
	assert.equal(state.lastRunId, 35023767551);
	assert.equal(state.lastEndedAt, '2026-09-15T21:09:38.000Z');

	// And the same page again, at a later tick, yields nothing at all.
	assert.deepEqual(runsEndedSince(WATCHPARTY, state), []);
});

test('a whole push storm fits on one page and still pages exactly once', () => {
	// ArchiveBot/deploy 2026-01-20 again, but met the way the poller meets it:
	// all eight runs concluded inside 50 minutes, so five of them landed between
	// two ticks and only the newest was ever the "latest run". Every one must be
	// evaluated; exactly one may page.
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
	const start: CiState = {
		lastConclusion: 'success',
		lastRunId: 21156195149,
		lastSeen: '2026-01-20T01:10:00.000Z',
		lastEndedAt: '2026-01-20T01:00:00.000Z',
	};
	const ticks = [
		Date.parse('2026-01-20T01:20:00Z'),
		Date.parse('2026-01-20T01:30:00Z'),
		Date.parse('2026-01-20T01:40:00Z'),
		Date.parse('2026-01-20T01:50:00Z'),
		Date.parse('2026-01-20T02:00:00Z'),
		Date.parse('2026-01-20T02:10:00Z'),
	];
	const { seen, actions } = pollTicks(storm, ticks, start);
	assert.equal(seen.length, storm.length, 'every run in the storm must reach the machine once');
	assert.deepEqual(
		seen.map((s) => s.id),
		storm.map((r) => r.id),
		'and in conclusion order'
	);
	assert.equal(actions.filter((a) => a === 'broken').length, 1, actions.join(','));
	assert.equal(actions.filter((a) => a === 'suppressed').length, storm.length - 1);
});

test('a page size of one is the bug, so the constant may not quietly go back to it', () => {
	// Measured over 90 days of the real watch list (67 workflows, 4,702 completed
	// runs, 248 failing, six tick phases each): 28.7% of failing runs are never
	// evaluated at all at per_page=1, 7.7% at 3, 5.8% at 10. The cliff is
	// between 1 and 2 and there is nothing to tune above 5.
	assert.ok(RUN_PAGE_SIZE >= 5, `page size ${RUN_PAGE_SIZE} is back inside the measured cliff`);
});

test('a state row from before the watermark existed replays no history', () => {
	// Migration. Every row in the operator's ci-alert-state.json on 2026-09-19
	// lacks `lastEndedAt`, and the first tick after the deploy must behave
	// exactly as the old poller did rather than page for a page of old reds.
	const legacy: CiState = { lastConclusion: 'success', lastRunId: 34898057754, lastSeen: 'x' };
	assert.deepEqual(
		runsEndedSince(WATCHPARTY, legacy).map((r) => r.id),
		[34898026676],
		'only the newest run by created_at, which is what per_page=1 returned'
	);
	// Same for a first sighting.
	assert.deepEqual(
		runsEndedSince(WATCHPARTY, null).map((r) => r.id),
		[34898026676]
	);
	assert.deepEqual(runsEndedSince([], BEFORE), []);
});

/*
 * ---------------------------------------------------------------------------
 * THE PER-TICK SUMMARY.
 *
 * #32 was invisible for four days because a target that was polled and said
 * nothing and a target that was never polled produced byte-identical output.
 * The summary is the repo's standing rule applied to this alerter: "I could not
 * look" must never render as "nothing is wrong".
 * ---------------------------------------------------------------------------
 */

test('the summary distinguishes every way of looking away, including the zeroes', () => {
	const line = formatCiTickSummary({
		targets: 67,
		unreadable: 0,
		noRuns: 0,
		nothingNew: 64,
		evaluated: 3,
		broken: 1,
		recovered: 1,
		suppressed: 1,
		ignored: 0,
		errors: 0,
		reasons: { 'already announced for this run': 1 },
	});
	assert.match(line, /polled 67 targets/);
	assert.match(line, /evaluated 3 runs/);
	assert.match(line, /announced 2 \(broken 1, recovered 1\)/);
	assert.match(line, /suppressed 1 \(already announced for this run x1\)/);
	// The zeroes are the point: printed, so a blind tick cannot look like a quiet
	// one. A summary that only listed non-zero counters would restate the bug.
	assert.match(line, /unreadable 0/);
	assert.match(line, /no-runs 0/);
	assert.match(line, /errors 0/);
});

test('the summary names the reason a transition was held back', () => {
	const line = formatCiTickSummary({
		targets: 2,
		unreadable: 1,
		noRuns: 0,
		nothingNew: 0,
		evaluated: 2,
		broken: 0,
		recovered: 0,
		suppressed: 2,
		ignored: 0,
		errors: 0,
		reasons: { 'run is older than the freshness gate': 1, 'state was stale — cold resync': 1 },
	});
	// A rate limit, a timeout and a deleted repo are three different jobs; so are
	// these two, and a bare count would make either undiagnosable after the fact.
	assert.match(line, /run is older than the freshness gate x1/);
	assert.match(line, /state was stale — cold resync x1/);
	assert.match(line, /unreadable 1/);
});

/**
 * A host whose manifests and state live in throwaway directories, and whose
 * logger keeps what it was told. The log is the deliverable here — a summary
 * that is computed and not written down is the same silence in a new place — so
 * the tests below read it rather than the return value alone.
 */
async function withTempHost<T>(
	fn: (manifests: string, log: { info: string[]; warn: string[] }) => Promise<T>
): Promise<T> {
	const manifests = tempDir('ci-alerts-manifests-');
	const state = tempDir('ci-alerts-state-');
	const log = { info: [] as string[], warn: [] as string[] };
	__setHostForTesting({
		...testHost,
		manifestDir: manifests,
		stateDir: state,
		logger: {
			info: (m: string) => log.info.push(m),
			warn: (m: string) => log.warn.push(m),
			error: () => undefined,
		},
	});
	try {
		return await fn(manifests, log);
	} finally {
		__setHostForTesting(testHost);
	}
}

test('a tick counts what it could not read, and does not call that health', async () => {
	// End to end through `runCiAlerts` with no announcement in it, deliberately:
	// this asserts on the accounting, and the alerter's real sink must not fire
	// from a test.
	const targets = [
		{ owner: 'WolffM', repo: 'unreachable', workflow: 'ci.yml', label: 'unreachable / ci' },
		{ owner: 'WolffM', repo: 'never-ran', workflow: 'ci.yml', label: 'never-ran / ci' },
		{ owner: 'WolffM', repo: 'quiet', workflow: 'ci.yml', label: 'quiet / ci' },
	];
	const lines: string[] = [];
	const summary: CiTickSummary = await withTempHost(async (manifests, log) => {
		writeFileSync(join(manifests, 'ci-watch.generated.json'), JSON.stringify({ targets }));
		const ghGet = async <T>(_p: string, _t: string, repo?: string): Promise<T | null> => {
			if (repo === 'WolffM/unreachable') return await Promise.resolve(null);
			const workflow_runs =
				repo === 'WolffM/never-ran'
					? []
					: [ghRun(1, 'success', '2026-09-19T10:00:00Z', '2026-09-19T10:05:00Z')];
			return await Promise.resolve({ workflow_runs } as T);
		};
		const s = await runCiAlerts('tok', ghGet);
		lines.push(...log.info, ...log.warn);
		return s;
	});

	assert.equal(summary.targets, 3);
	// Three targets, three different silences, three different counters. Before
	// 2026-09-19 all three produced the same output: none.
	assert.equal(summary.unreadable, 1, 'a target we could not read is a finding, not a pass');
	assert.equal(summary.noRuns, 1);
	assert.equal(summary.evaluated, 1);
	assert.equal(summary.broken + summary.recovered, 0, 'nothing may be announced by this test');

	// The tick WROTE the summary down, and at WARN, because it could not read one
	// of its three targets. An unreadable target is a finding.
	const summaryLines = lines.filter((l) => l.startsWith('[ci-alerts] polled '));
	assert.equal(summaryLines.length, 1, `exactly one summary per tick, got ${lines.join(' | ')}`);
	assert.equal(summaryLines[0], formatCiTickSummary(summary));
	assert.match(summaryLines[0], /polled 3 targets/);
	assert.match(summaryLines[0], /unreadable 1/);
});

test('a tick with an EMPTY watch list still reports, because it watched nothing', async () => {
	const warned: string[] = [];
	const summary = await withTempHost(async (manifests, log) => {
		writeFileSync(join(manifests, 'ci-watch.generated.json'), JSON.stringify({ targets: [] }));
		const ghGet = async <T>(): Promise<T | null> => await Promise.resolve(null);
		const s = await runCiAlerts('tok', ghGet);
		warned.push(...log.warn);
		// A watch list of zero is the shape of "resolution found nothing", and a
		// gate that reports a healthy fleet of zero machines is this repo's
		// oldest failure. It has to be loud.
		assert.equal(log.info.length, 0, 'an empty watch list is not an INFO');
		return s;
	});
	assert.equal(summary.targets, 0);
	assert.ok(
		warned.some((l) => l === formatCiTickSummary(summary)),
		`the empty tick must warn its summary, got ${warned.join(' | ')}`
	);
	assert.match(formatCiTickSummary(summary), /polled 0 targets/);
});

/**
 * #124: a `timeout-minutes` expiry concludes as `cancelled`, the same word a
 * concurrency supersede gets. The annotations below are the real ones, read
 * from hadoku-promptsmith run 39336748764 (timeout) and hadoku-fleet-manager
 * run 39517025915 (supersede) on 2026-10-20.
 */
const TIMEOUT_NOTES = [
	{ message: 'The job has exceeded the maximum execution time of 10m0s' },
	{ message: 'The operation was canceled.' },
];
const SUPERSEDE_NOTES = [
	{ message: 'Canceling since a higher priority waiting request for ci-refs/heads/main exists' },
	{ message: 'The operation was canceled.' },
];

async function tickOnCancelled(
	notes: { message: string }[] | null,
	prior?: CiState
): Promise<{ summary: CiTickSummary; posts: string[]; state: Record<string, CiState> }> {
	const target = {
		owner: 'WolffM',
		repo: 'promptsmith',
		workflow: 'ci.yml',
		label: 'promptsmith / ci',
	};
	const posts: string[] = [];
	const manifests = tempDir('ci-alerts-manifests-');
	const stateDir = tempDir('ci-alerts-state-');
	__setHostForTesting({
		...testHost,
		manifestDir: manifests,
		stateDir,
		alerts: {
			post: async (content: string) => {
				posts.push(content);
				return await Promise.resolve({ posted: true, sinkRecorded: true });
			},
			recordQuietly: () => undefined,
		},
	});
	try {
		writeFileSync(
			join(manifests, 'ci-watch.generated.json'),
			JSON.stringify({ targets: [target] })
		);
		if (prior)
			writeFileSync(
				join(stateDir, 'ci-alert-state.json'),
				JSON.stringify({ [stateKey(target)]: prior })
			);
		const ended = new Date(Date.now() - 60_000).toISOString();
		const ghGet = async <T>(path: string): Promise<T | null> => {
			if (path.startsWith('/actions/workflows/'))
				return await Promise.resolve({
					workflow_runs: [ghRun(7, 'cancelled', ended, ended)],
				} as T);
			if (path.startsWith('/actions/runs/7/jobs'))
				return await Promise.resolve({
					jobs: [
						{ id: 70, conclusion: 'success' },
						{ id: 71, conclusion: 'cancelled' },
					],
				} as T);
			if (path === '/check-runs/71/annotations') return await Promise.resolve(notes as T);
			throw new Error(`unexpected path ${path}`);
		};
		const summary = await runCiAlerts('tok', ghGet);
		const file = join(stateDir, 'ci-alert-state.json');
		const state = existsSync(file)
			? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, CiState>)
			: {};
		return { summary, posts, state };
	} finally {
		__setHostForTesting(testHost);
	}
}

test('#124: a cancel the annotations call a TIMEOUT pages as broken, and the row stores timed_out', async () => {
	const { summary, posts, state } = await tickOnCancelled(TIMEOUT_NOTES);
	assert.equal(summary.broken, 1);
	assert.equal(posts.length, 1);
	assert.match(posts[0], /CI broken/);
	assert.match(posts[0], /timed_out/);
	assert.equal(Object.values(state)[0]?.lastConclusion, 'timed_out');
});

test('#124: a SUPERSEDED cancel is still inert — nothing paged, nothing stored', async () => {
	// MUTATION: treat every cancelled job as a timeout and this pages.
	const { summary, posts, state } = await tickOnCancelled(SUPERSEDE_NOTES);
	assert.equal(summary.broken, 0);
	assert.equal(summary.ignored, 1);
	assert.deepEqual(posts, []);
	assert.deepEqual(state, {}, 'first sighting of an inert run persists nothing');
});

test('#124: unreadable annotations are "could not look" — no page, no watermark past the run', async () => {
	const prior: CiState = {
		lastConclusion: 'success',
		lastRunId: 6,
		lastSeen: new Date(Date.now() - 5 * 60_000).toISOString(),
		lastEndedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
	};
	const { summary, posts, state } = await tickOnCancelled(null, prior);
	assert.equal(summary.unreadable, 1);
	assert.equal(summary.evaluated, 0);
	assert.deepEqual(posts, []);
	// The run stays past the watermark, so the next tick asks about it again.
	const row = Object.values(state)[0];
	assert.ok(row === undefined || row.lastEndedAt === prior.lastEndedAt);
});

test('#124: a timeout after green is a fresh break; the next green recovers from it', () => {
	const prev: CiState = {
		lastConclusion: 'timed_out',
		lastRunId: 7,
		lastSeen: new Date(NOW - 5 * 60_000).toISOString(),
		lastAlertedRunId: 7,
	};
	const d = decideCiAlert(prev, run('success', { id: 8 }), NOW);
	assert.equal(d.action, 'recovered');
});

// 2026-10-25: 12 boots in two hours, each running a full 75-target pass a few
// minutes after its predecessor's. A boot now skips its pass when a CLEAN one
// is recent — and only a clean one, since a blind pass proves nothing.
test('a boot right after a clean pass skips its own; after a blind one it does not', async () => {
	const targets = [
		{ owner: 'WolffM', repo: 'a', workflow: 'ci.yml', label: 'a / ci' },
		{ owner: 'WolffM', repo: 'b', workflow: 'ci.yml', label: 'b / ci' },
	];
	await withTempHost(async (manifests) => {
		writeFileSync(join(manifests, 'ci-watch.generated.json'), JSON.stringify({ targets }));
		assert.equal(ciAlertsBootPassDue(), true, 'no pass on record: the boot runs one');

		let blind = false;
		const ghGet = async <T>(_p: string, _t: string, repo?: string): Promise<T | null> => {
			if (blind && repo === 'WolffM/b') return await Promise.resolve(null);
			return await Promise.resolve({
				workflow_runs: [ghRun(1, 'success', '2026-09-19T10:00:00Z', '2026-09-19T10:05:00Z')],
			} as T);
		};
		await runCiAlerts('tok', ghGet);
		assert.equal(ciAlertsBootPassDue(), false, 'a clean pass just finished');
		const clean = lastCleanCiAlertsPassMs();
		assert.ok(clean !== null, 'the clean pass is on record');
		assert.equal(ciAlertsBootPassDue(clean + CI_ALERTS_BOOT_SKIP_MS), true, 'and it ages out');

		// A blind pass is not recorded, so it cannot extend the skip. Judged from
		// the RECORD, never from a second Date.now(): on a loaded runner the blind
		// pass alone took over a second and aged the clean one out (2026-10-31).
		blind = true;
		await runCiAlerts('tok', ghGet);
		assert.equal(
			lastCleanCiAlertsPassMs(),
			clean,
			'still anchored on the clean pass, not the blind one'
		);
		assert.equal(ciAlertsBootPassDue(clean + CI_ALERTS_BOOT_SKIP_MS - 1000), false);
	});
});

test('an unreadable pass record runs the boot pass, and says why', async () => {
	await withTempHost((_m, log) => {
		writeFileSync(join(stateDir(), CI_ALERTS_PASS_FILE), '{not json');
		assert.equal(ciAlertsBootPassDue(), true);
		assert.ok(log.warn.some((w) => w.includes('not parseable')));
		return Promise.resolve();
	});
});
