/**
 * The watermark the #32 fix rests on (`runsEndedSince`, a run superseded by a
 * green one before the next poll, a push storm that fits on one page) and the
 * per-tick summary (`formatCiTickSummary`) — split out of `ci-alerts.test.ts`
 * (wave 5r lane C) over `helpers/ci-alerts-rig.ts`. #32 was invisible for four
 * days because a target that was polled and said nothing and a target that
 * was never polled produced byte-identical output; both halves below are
 * about making that silence legible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stateKey } from '../ci-alerts.js';
import { formatCiTickSummary } from '../ci-alerts-summary.js';
import { runEndedAt, runsEndedSince, type CiState } from '../ci-alerts-decide.js';
import { BEFORE, ghRun, pollTicks, TICKS, WATCHPARTY } from './helpers/ci-alerts-rig.js';

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
		foreign: 0,
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
		foreign: 0,
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
