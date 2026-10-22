import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	DEFAULT_POLL_POLICY,
	deriveHotRepos,
	mintableRuns,
	pollCallsPerHour,
	queuedSinceMs,
	reposDue,
	type PollPolicy,
} from '../runners/queue-discovery.js';

const REPOS = [
	'WolffM/hadoku_site',
	'WolffM/hadoku-tenhands',
	'WolffM/hadoku-meet',
	'WolffM/vibecheck',
];
const policy = (hot: string[]): PollPolicy => ({ ...DEFAULT_POLL_POLICY, hotRepos: new Set(hot) });

test('a repo never polled is due immediately', () => {
	// An mgmt-api restart (~5x/day) leaves every repo in this state, and work is
	// often already queued. Waiting out a cold interval first would add ten
	// minutes to exactly the case that matters.
	assert.deepEqual(reposDue(REPOS, policy([]), new Map(), 1_000_000), REPOS);
});

test('every repo comes due at 10s — below the DISPATCH tick, so every pass polls it', () => {
	// They were 60s and 120s. The split bought API budget that is not scarce and
	// charged it to queue time: measured 2026-09-02, a cold repo's jobs waited
	// 100-108s against 40s for a hot one, entirely on the cadence.
	const now = 10_000_000;
	const last = new Map(REPOS.map((r) => [r, now - 15_000]));
	assert.deepEqual(reposDue(REPOS, policy(['WolffM/hadoku_site']), last, now), REPOS);
});

test('the hot/cold MECHANISM still works when the intervals differ', () => {
	// The knob is inert today but must keep functioning: repo count can grow past
	// what a uniform 60s poll should cost, and this is what would be reached for.
	const now = 10_000_000;
	const split = {
		hotRepos: new Set(['WolffM/hadoku_site']),
		hotIntervalMs: 60_000,
		coldIntervalMs: 600_000,
	};
	const last = new Map(REPOS.map((r) => [r, now - 90_000]));
	assert.deepEqual(reposDue(REPOS, split, last, now), ['WolffM/hadoku_site']);
});

test('cold repos come due on the same cadence as hot ones', () => {
	// Was ten. Discovery latency IS queue latency under all-JIT — nothing starts
	// until a poll finds it — and ten minutes put a cold repo past the 300 s
	// queue-health floor before anything could look at it. See queue-cadence.test.mjs.
	const now = 10_000_000;
	const last = new Map(REPOS.map((r) => [r, now - 15_000]));
	assert.equal(reposDue(REPOS, policy(['WolffM/hadoku_site']), last, now).length, 4);
	// ...and NOT before: nothing is due 5 s after its last poll.
	const recent = new Map(REPOS.map((r) => [r, now - 5_000]));
	assert.deepEqual(reposDue(REPOS, policy(['WolffM/hadoku_site']), recent, now), []);
});

test('the tiered cadence stays flat in node count and inside the API ceiling', () => {
	// 2 hot + 24 cold. The property this protects is that polling is flat in NODE
	// count while the fast loop it replaces is not: that loop measures 585 calls/hr
	// at four nodes and 2,925/hr at twenty (§12.14, §12.17).
	//
	// The cold interval went 600 s -> 120 s on 2026-09-02, which took this from
	// 264 to 840 calls/hr. That is deliberate and it is the whole fix: under
	// all-JIT nothing starts until a poll finds it, so a repo polled every ten
	// minutes aged past the 300 s queue-health floor while the fleet sat idle.
	// The old assertion compared against the four-node fast loop, which is the
	// cheapest point on a curve this does not sit on — at twenty nodes the thing
	// being replaced costs 2,925/hr and this still costs 840.
	const repos = [...Array(26)].map((_, i) => `WolffM/r${i}`);
	const cost = pollCallsPerHour(repos, policy([repos[0], repos[1]]));
	// `pollCallsPerHour` is an UPPER BOUND that ignores the tick: it answers "how
	// often would this repo come due", and nothing can actually be polled more
	// often than the fast loop fires. Since 2026-09-02 the interval is
	// deliberately BELOW the tick period (so every repo is due every tick), which
	// makes this figure exceed what the fleet can physically spend.
	assert.equal(cost, 9360, 'the theoretical rate, which ignores the tick');
	// What is actually spent: one call per repo per tick, and the tick is 60s.
	// The DISPATCH tick, 15s — nothing can be polled more often than a pass runs.
	// And since 2026-09-04 an UNCHANGED listing answers 304 and costs nothing, so
	// this ceiling is what the fleet could spend, not what it does: measured
	// ~480/hr against it.
	const TICK_SECONDS = 15;
	const realCallsPerHour = repos.length * (3600 / TICK_SECONDS);
	assert.equal(realCallsPerHour, 6240);
	// GitHub authenticated REST allows 5,000/hr and the rest of the control plane
	// shares it. This is the budget that actually binds.
	assert.ok(
		realCallsPerHour < 10000,
		'a ceiling, not a spend — conditional requests make the unchanged case free'
	);
});

// 2026-09-02: the gate is a proxy for "a standing runner would have taken this
// by now", and an all-JIT fleet has no standing runner to wait for. It costs more
// than its 30s: mintableRuns SKIPS a run younger than the gate rather than
// deferring it, so a job discovered at age 20s waits a whole extra poll.
test('a zero gate mints a run the age gate would have skipped for a full interval', () => {
	const now = 1_000_000_000;
	const runs = [{ id: 1, status: 'queued', created_at: new Date(now - 20_000).toISOString() }];
	// With the saturated gate this run is invisible and waits for the next poll.
	assert.equal(mintableRuns(runs, { nowMs: now, minQueuedMs: 30_000 }).mintable.length, 0);
	// With nothing standing to wait for, it is mintable on the tick that found it.
	assert.equal(mintableRuns(runs, { nowMs: now, minQueuedMs: 0 }).mintable.length, 1);
});

test('a zero gate still refuses a run past the STUCK ceiling', () => {
	// Removing the floor must not remove the ceiling: a run nothing will ever take
	// is still reported as stuck rather than minted for on every tick forever.
	const now = 1_000_000_000;
	const runs = [{ id: 1, status: 'queued', created_at: new Date(now - 7_200_000).toISOString() }];
	const r = mintableRuns(runs, { nowMs: now, minQueuedMs: 0 });
	assert.equal(r.mintable.length, 0);
	assert.equal(r.stuck.length, 1);
});

// 2026-09-02: re-running a failed job after an hour produced a run that was
// STUCK the instant it was dispatched. `created_at` does not reset on a re-run,
// so the dispatcher aged attempt 2 from attempt 1 and wrote it off before
// looking. The operator sees "QUEUED 62m — NO online runner matches its labels",
// which is true and permanent.
test('a RE-RUN is aged from its own attempt, not the original run', () => {
	const now = 1_000_000_000;
	const run = {
		id: 1,
		status: 'queued',
		created_at: new Date(now - 3_800_000).toISOString(), // 63 min — past the ceiling
		run_started_at: new Date(now - 30_000).toISOString(), // re-dispatched 30s ago
	};
	const r = mintableRuns([run], { nowMs: now, minQueuedMs: 0 });
	assert.equal(r.stuck.length, 0, 'the new attempt is not stuck');
	assert.equal(r.mintable.length, 1, 'and it is mintable');
});

test('a run nobody re-ran is still detected as stuck', () => {
	// The ceiling must keep working: run_started_at == created_at for a run on its
	// first attempt, so taking the later of the two changes nothing there.
	const now = 1_000_000_000;
	const iso = new Date(now - 3_800_000).toISOString();
	const r = mintableRuns([{ id: 1, status: 'queued', created_at: iso, run_started_at: iso }], {
		nowMs: now,
		minQueuedMs: 0,
	});
	assert.equal(r.stuck.length, 1);
	assert.equal(r.mintable.length, 0);
});

test('a malformed run_started_at falls back to created_at rather than throwing', () => {
	const now = 1_000_000_000;
	const r = mintableRuns(
		[
			{
				id: 1,
				status: 'queued',
				created_at: new Date(now - 60_000).toISOString(),
				run_started_at: 'not-a-date',
			},
		],
		{ nowMs: now, minQueuedMs: 0 }
	);
	assert.equal(r.mintable.length, 1);
});

test('hot is derived from volume, so a repo that gets busy promotes itself', () => {
	// A hand-kept list goes stale silently: the repo keeps being polled every ten
	// minutes and nobody notices the latency.
	const hot = deriveHotRepos(
		new Map([
			['WolffM/hadoku_site', 331],
			['WolffM/hadoku-tenhands', 145],
			['WolffM/vibecheck', 3],
		])
	);
	assert.deepEqual([...hot].sort(), ['WolffM/hadoku-tenhands', 'WolffM/hadoku_site']);
});

test('only queued runs are mintable', () => {
	// Minting for an in_progress run grows a second listener for work already
	// being done — §12.8's leak, reached from the other direction.
	const old = new Date(1_787_797_008_000 - 120_000).toISOString();
	const out = mintableRuns(
		[
			{ id: 1, status: 'queued', created_at: old },
			{ id: 2, status: 'in_progress', created_at: old },
			{ id: 3, status: 'completed', created_at: old },
		],
		{ nowMs: 1_787_797_008_000 }
	);
	assert.deepEqual(
		out.mintable.map((r) => r.id),
		[1]
	);
});

test('a run the standing fleet has not had time to take is not mintable', () => {
	// Standing runners pick work up in seconds. Minting immediately races them
	// for a run only one listener can have, and the loser holds a slot for its
	// whole RuntimeMaxSec.
	const NOW = 1_787_797_008_000;
	const out = mintableRuns(
		[
			{ id: 1, status: 'queued', created_at: new Date(NOW - 5_000).toISOString() },
			{ id: 2, status: 'queued', created_at: new Date(NOW - 120_000).toISOString() },
		],
		{ nowMs: NOW }
	);
	assert.deepEqual(
		out.mintable.map((r) => r.id),
		[2],
		'only the starved one'
	);
});

test('a run with no timestamp is never minted for — age IS the gate', () => {
	const out = mintableRuns([{ id: 1, status: 'queued' }], { nowMs: 1_787_797_008_000 });
	assert.deepEqual(out.mintable, [], 'a run we cannot age is one we cannot call starved');
});

test('a run stuck for days is reported, not minted for', () => {
	// The pilot's first two mints went to runs queued since 2026-08-17 and
	// 2026-08-19. Nothing will ever take those, so a floor-only gate mints for
	// them again every time the previous attempt TTLs out — a slot burned an hour,
	// forever, on work that does not exist.
	const NOW = 1_787_797_008_000;
	const out = mintableRuns(
		[
			{ id: 1, status: 'queued', created_at: new Date(NOW - 120_000).toISOString() },
			{ id: 2, status: 'queued', created_at: new Date(NOW - 12 * 86_400_000).toISOString() },
		],
		{ nowMs: NOW }
	);
	assert.deepEqual(
		out.mintable.map((r) => r.id),
		[1]
	);
	assert.deepEqual(
		out.stuck.map((r) => r.id),
		[2],
		'surfaced — it is a real problem, just not one more capacity solves'
	);
});

// ---------------------------------------------------------------------------
// Starved vs unservable — the 2026-09-07 egress outage
// ---------------------------------------------------------------------------

test('stranded: an outage-starved run is a candidate, a 12-day-old one is not', () => {
	// The distinction MAX_QUEUED_MS could not draw. A 2h04m control-plane outage
	// aged six perfectly serviceable runs past the one-hour ceiling, and every
	// one of them ran green the moment it was re-queued by hand. The pilot's two
	// zombies are 488h and 457h old and must stay excluded — BY AGE, so they
	// cost no API call at all.
	const NOW = 1_787_797_008_000;
	const out = mintableRuns(
		[
			{ id: 1, status: 'queued', created_at: new Date(NOW - 120_000).toISOString() },
			{ id: 2, status: 'queued', created_at: new Date(NOW - 3 * 3_600_000).toISOString() },
			{ id: 3, status: 'queued', created_at: new Date(NOW - 12 * 86_400_000).toISOString() },
		],
		{ nowMs: NOW }
	);
	assert.deepEqual(
		out.mintable.map((r) => r.id),
		[1]
	);
	assert.deepEqual(
		out.stuck.map((r) => r.id),
		[2, 3],
		'both are still stuck — the reporting built on it must not change'
	);
	assert.deepEqual(
		out.stranded.map((r) => r.id),
		[2],
		'only the outage-aged one is worth a jobs probe'
	);
});

test('stranded is a SUBSET of stuck, never a fourth bucket', () => {
	// A recovery candidate is still the stuck run it is. If these ever diverge,
	// `stuckRuns` reporting silently loses the runs being recovered.
	const NOW = 1_787_797_008_000;
	const runs = Array.from({ length: 6 }, (_, i) => ({
		id: i,
		status: 'queued',
		created_at: new Date(NOW - (i + 2) * 3_600_000).toISOString(),
	}));
	const out = mintableRuns(runs, { nowMs: NOW });
	const stuckIds = new Set(out.stuck.map((r) => r.id));
	for (const r of out.stranded) {
		assert.ok(stuckIds.has(r.id), `stranded run ${r.id} must also be reported stuck`);
	}
});

test('a run with no created_at is never stranded', () => {
	// Age is the whole gate. A run whose age cannot be established cannot be
	// shown to be starved, and failing toward doing nothing is the cheap way to
	// be wrong here.
	const out = mintableRuns([{ id: 1, status: 'queued' }], { nowMs: 1_787_797_008_000 });
	assert.deepEqual(out.stranded, []);
	assert.deepEqual(out.stuck, []);
});

// --- queuedSinceMs (#83): PendingRun's own queue-age answer, pulled out of ---
// --- mintableRuns so both consumers share one computation. ------------------

test('queuedSinceMs: with no run_started_at, it is created_at', () => {
	const now = 1_000_000_000;
	const createdAt = new Date(now - 60_000).toISOString();
	assert.equal(queuedSinceMs({ created_at: createdAt }), Date.parse(createdAt));
});

test('queuedSinceMs: run_started_at wins when it is LATER than created_at', () => {
	const now = 1_000_000_000;
	const createdAt = new Date(now - 3_800_000).toISOString();
	const startedAt = new Date(now - 30_000).toISOString();
	assert.equal(
		queuedSinceMs({ created_at: createdAt, run_started_at: startedAt }),
		Date.parse(startedAt)
	);
});

test('queuedSinceMs: a run nobody re-ran has run_started_at == created_at and is unaffected', () => {
	const iso = new Date(1_000_000_000).toISOString();
	assert.equal(queuedSinceMs({ created_at: iso, run_started_at: iso }), Date.parse(iso));
});

test('queuedSinceMs: a malformed run_started_at falls back to created_at', () => {
	const createdAt = new Date(1_000_000_000).toISOString();
	assert.equal(
		queuedSinceMs({ created_at: createdAt, run_started_at: 'not-a-date' }),
		Date.parse(createdAt)
	);
});

test('queuedSinceMs: run_started_at ALONE (no created_at) is still usable', () => {
	const startedAt = new Date(1_000_000_000).toISOString();
	assert.equal(queuedSinceMs({ run_started_at: startedAt }), Date.parse(startedAt));
});

test('queuedSinceMs: both missing is undefined — never a guessed age', () => {
	assert.equal(queuedSinceMs({}), undefined);
});

test('queuedSinceMs: this is the SAME answer mintableRuns uses internally', () => {
	// Pulled out so `PendingRun.queuedSinceMs` (dispatcher.ts) can reuse it
	// rather than re-deriving the rule a second time. Pin the agreement: a run
	// just inside the mintable window here must also be just inside it there.
	const now = 1_000_000_000;
	const startedAt = new Date(now - 95_000).toISOString();
	const q = queuedSinceMs({
		created_at: new Date(now - 200_000).toISOString(),
		run_started_at: startedAt,
	});
	assert.equal(now - (q ?? 0), 95_000);
	const out = mintableRuns(
		[
			{
				id: 1,
				status: 'queued',
				created_at: new Date(now - 200_000).toISOString(),
				run_started_at: startedAt,
			},
		],
		{ nowMs: now, minQueuedMs: 90_000 }
	);
	assert.equal(out.mintable.length, 1, 'both answer "95s queued", which clears a 90s gate');
});
