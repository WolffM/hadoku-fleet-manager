/**
 * `ingestRuns`'s cost and fairness contract: this rides on a runs listing
 * someone else already paid for, so it must never re-fetch a run it has
 * seen, must respect its per-tick budget, and must skip a job with no
 * runner or no timing rather than guess. Loss under sustained load (issue
 * shape measured 2026-09-04) and the across-repo half of the same
 * starvation (issue #21) pin that the budget is spent OLDEST-at-risk first,
 * not in listing order and not first-come across repos. Split out of
 * job-history.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/job-history-rig.ts` for the shared `job`/`at` fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { jobRecords } from '../job-history-store.js';
import { ingestRuns } from '../job-history-ingest.js';
import { FetchBudget } from '../job-history-ingest.js';
import { MAX_FETCH_PER_TICK } from '../job-history-ingest.js';
import { job, at, installJobHistoryRig } from './helpers/job-history-rig.js';

installJobHistoryRig();

// ── ingest cost ─────────────────────────────────────────────────────────────

test('ingestRuns: an IN-PROGRESS run is not recorded', async () => {
	// Its jobs have no completion time; recording one would freeze a partial
	// duration that never gets corrected.
	let calls = 0;
	await ingestRuns('WolffM/x', [{ id: 1, status: 'in_progress' }], () => {
		calls++;
		return Promise.resolve({ jobs: [job()] });
	});
	assert.equal(calls, 0);
	assert.equal(jobRecords().length, 0);
});

test('ingestRuns: a run is fetched ONCE, ever', async () => {
	let calls = 0;
	const fetch = () => {
		calls++;
		return Promise.resolve({ jobs: [job()] });
	};
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], fetch);
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], fetch);
	assert.equal(calls, 1, 'the second tick must not re-fetch a seen run');
	assert.equal(jobRecords().length, 1, 'and must not double-count its jobs');
});

test('ingestRuns: the per-tick budget is respected', async () => {
	let calls = 0;
	const runs = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, status: 'completed' }));
	await ingestRuns(
		'WolffM/x',
		runs,
		() => {
			calls++;
			return Promise.resolve({ jobs: [job()] });
		},
		3
	);
	assert.equal(calls, 3, 'a burst degrades to catching up next tick, not a stall');
});

test('ingestRuns: a job with no runner or no timing is skipped, not guessed', async () => {
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], () =>
		Promise.resolve({
			jobs: [
				job({ runner_name: null }),
				job({ started_at: null }),
				job({ completed_at: null }),
				job({ started_at: at(300), completed_at: at(0) }),
				job(),
			],
		})
	);
	assert.equal(jobRecords().length, 1, 'only the well-formed job is recorded');
	assert.equal(jobRecords()[0]?.durationSec, 100);
});

test('ingestRuns: head_sha is carried onto the record, additively', async () => {
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], () =>
		Promise.resolve({ jobs: [job({ head_sha: 'abc123' })] })
	);
	assert.equal(jobRecords()[0]?.headSha, 'abc123');
});

test('ingestRuns: a job with no head_sha gets no headSha key at all', async () => {
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], () =>
		Promise.resolve({ jobs: [job()] })
	);
	assert.equal('headSha' in jobRecords()[0]!, false, 'absent, never an explicit undefined');
});

// ── Loss under sustained load ───────────────────────────────────────────────
//
// Measured 2026-09-04: 38 of 95 completed hadoku_site runs had no record at
// all. Not a cost problem — a FAIRNESS one. The listing is newest-first, so
// spending the budget in listing order always defers the oldest runs, and they
// are the ones nearest to falling out of the `per_page=30` window. Next tick
// brings newer runs that outrank them again. They are never caught up.

test('ingestRuns: the budget is spent OLDEST first, not listing order', async () => {
	const seen: number[] = [];
	// Listing order is newest-first, as the API returns it.
	const runs = [{ id: 50 }, { id: 40 }, { id: 30 }, { id: 20 }, { id: 10 }].map((r) => ({
		...r,
		status: 'completed',
	}));
	await ingestRuns(
		'WolffM/x',
		runs,
		(_repo, id) => {
			seen.push(id);
			return Promise.resolve({ jobs: [job()] });
		},
		2
	);
	assert.deepEqual(
		seen,
		[10, 20],
		'the two OLDEST unseen runs must be fetched — they are the ones about to scroll out'
	);
});

test('ingestRuns: a deferred run is caught on a later tick, even as newer runs arrive', async () => {
	// The starvation case, end to end. Budget 2, three ticks, newer runs landing
	// each time: with listing-order spending the oldest are never reached.
	const seen: number[] = [];
	const fetch = (_repo: string, id: number) => {
		seen.push(id);
		return Promise.resolve({ jobs: [job()] });
	};
	const mk = (ids: number[]) => ids.map((id) => ({ id, status: 'completed' }));
	await ingestRuns('WolffM/x', mk([30, 20, 10]), fetch, 2);
	await ingestRuns('WolffM/x', mk([50, 40, 30, 20, 10]), fetch, 2);
	await ingestRuns('WolffM/x', mk([70, 60, 50, 40, 30]), fetch, 2);
	assert.ok(seen.includes(10), 'run 10 must not be starved by newer arrivals');
	assert.ok(seen.includes(20), 'run 20 must not be starved either');
	assert.equal(new Set(seen).size, seen.length, 'and nothing may be fetched twice');
});

test('ingestRuns: a FAILED fetch is retried, not retired forever', async () => {
	// `remember` must happen before the await (the budget is shared), so a null
	// body would otherwise retire the run permanently on one transient 5xx.
	let calls = 0;
	const fetch = () => {
		calls++;
		return Promise.resolve(calls === 1 ? null : { jobs: [job()] });
	};
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], fetch);
	assert.equal(jobRecords().length, 0, 'a failed fetch records nothing');
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], fetch);
	assert.equal(calls, 2, 'the next tick must try again');
	assert.equal(jobRecords().length, 1, 'and the run is recovered');
});

test('ingestRuns: ancient runs do not eat the budget ahead of todays', async () => {
	// The regression oldest-first introduced, observed in production within half
	// an hour: a quiet repo's 30-run listing spans weeks, so "oldest unseen"
	// reached back nine days and spent the shared budget there while the runs
	// every panel figure is computed from waited.
	const seen: number[] = [];
	const old = new Date(Date.now() - 9 * 24 * 3600_000).toISOString();
	const now = new Date(Date.now() - 3600_000).toISOString();
	const runs = [
		{ id: 900, status: 'completed', updated_at: now },
		{ id: 800, status: 'completed', updated_at: now },
		{ id: 5, status: 'completed', updated_at: old },
		{ id: 4, status: 'completed', updated_at: old },
	];
	await ingestRuns(
		'WolffM/x',
		runs,
		(_r, id) => {
			seen.push(id);
			return Promise.resolve({ jobs: [job()] });
		},
		2
	);
	assert.deepEqual(seen, [800, 900], 'the budget belongs to recent runs, oldest of those first');
});

test('ingestRuns: an undated run is still ingested, never silently dropped', async () => {
	// Unknown age must not become a reason to lose a run.
	const seen: number[] = [];
	await ingestRuns(
		'WolffM/x',
		[{ id: 7, status: 'completed' }],
		(_r, id) => {
			seen.push(id);
			return Promise.resolve({ jobs: [job()] });
		},
		2
	);
	assert.deepEqual(seen, [7]);
});

// ── the ACROSS-repo half of the same starvation (issue #21) ────────────────
//
// Oldest-first fixed starvation within one repo. Across repos the shared budget
// was still first-come: runner-health sweeps the roster in order, and the
// busiest repo on the fleet is #26 of 27, so a repo swept early could spend
// every slot on runs in no danger and leave nothing for a repo whose oldest runs
// were about to scroll out of `per_page=30`. Same mistake one level up — ranking
// by arrival rather than by risk of loss.
//
// Measured 2026-09-14 across the full 14-day window, the fix is a GUARD rather
// than a repair: 0 of 547 eligible runs were missing in 10-minute ticks with >=15
// fleet completions, and the busiest tick ever recorded (45 completions against a
// 30-slot budget) lost nothing. The fleet is not near this cliff. It costs no
// extra API call to stay off it — the reserve redistributes the same 30 slots.

/** What runner-health asks GitHub for: `/actions/runs?per_page=30`. */
const LISTING = 30;

/**
 * The pre-fix budget: one shared counter, first-come, blind to risk.
 *
 * A subclass rather than a copy of the class, so this control cannot silently
 * stop being the thing it claims to be a control for — it inherits every other
 * property of the real budget and overrides exactly the rule under test.
 */
class FirstComeBudget extends FetchBudget {
	override take(): boolean {
		if (this.remaining <= 0) return false;
		this.remaining--;
		return true;
	}
}

/**
 * A two-repo sweep driven tick by tick, with ONE shared budget, in roster order.
 *
 * `busy` is swept first and is deliberately over the whole fleet's capacity — 30
 * new runs per tick against a 30-slot budget. That is the only way to contend the
 * budget at all, and it means `busy` loses runs by ARITHMETIC no allocation can
 * fix. `modest` is the repo under test: 4 runs a tick, comfortably inside the
 * fleet's capacity, and it must not lose one.
 *
 * A run is LOST, not merely deferred, once it has scrolled out of the newest
 * `LISTING` entries of its own repo without ever having been fetched.
 */
async function sweep(makeBudget: (n: number) => FetchBudget, ticks = 12) {
	const produced: Record<string, number[]> = { busy: [], modest: [] };
	const fetchedIds = new Set<number>();
	// Monotonic across both repos, so it is monotonic within each — which is what
	// ascending-id-is-ascending-age relies on.
	let nextId = 1_000;
	const fetch = (_repo: string, id: number) => {
		fetchedIds.add(id);
		return Promise.resolve({ jobs: [job()] });
	};
	// Every run is inside FRESH_HORIZON_H, so the horizon filter never fires and
	// the only thing deciding anything here is the budget.
	const listing = (ids: number[]) =>
		ids
			.slice(-LISTING)
			.reverse() // the API returns newest-first
			.map((id) => ({ id, status: 'completed', updated_at: new Date().toISOString() }));

	for (let tick = 0; tick < ticks; tick++) {
		for (let i = 0; i < 30; i++) produced.busy.push(nextId++);
		for (let i = 0; i < 4; i++) produced.modest.push(nextId++);
		const budget = makeBudget(MAX_FETCH_PER_TICK);
		// Roster order: the busy repo is swept first and gets first refusal.
		await ingestRuns('WolffM/busy', listing(produced.busy), fetch, budget);
		await ingestRuns('WolffM/modest', listing(produced.modest), fetch, budget);
	}

	const lost = (repo: 'busy' | 'modest') => {
		const stillVisible = new Set(produced[repo].slice(-LISTING));
		return produced[repo].filter((id) => !stillVisible.has(id) && !fetchedIds.has(id));
	};
	return { lost, produced, fetchedIds };
}

test('ingestRuns: a repo swept LAST is not starved by one swept first', async () => {
	const { lost, produced } = await sweep((n) => new FetchBudget(n));
	assert.ok(produced.modest.length > LISTING, 'the fixture must outlive one listing');
	assert.deepEqual(
		lost('modest'),
		[],
		'a repo inside the fleet capacity must lose nothing to a repo outside it'
	);
});

test('ingestRuns: the SAME fixture loses runs against a first-come budget', async () => {
	// The control. Without it the test above could be passing because the fixture
	// is too gentle to have blown the old budget either — a green that proves
	// nothing. This is the pre-fix code, on the identical fixture.
	const { lost } = await sweep((n) => new FirstComeBudget(n));
	assert.ok(
		lost('modest').length > 0,
		'first-come must starve the repo swept last — otherwise the fixture proves nothing'
	);
});

test('FetchBudget: the reserve is a third, and only at-risk runs may touch it', () => {
	const b = new FetchBudget(MAX_FETCH_PER_TICK);
	assert.equal(b.reserve, 10, 'a third of 30, floored');
	// Spend down to the reserve on SAFE runs.
	for (let i = 0; i < 20; i++) assert.equal(b.take(false), true, `safe take ${i}`);
	assert.equal(b.remaining, 10);
	assert.equal(b.take(false), false, 'a safe run may not eat the reserve');
	assert.equal(b.take(true), true, 'an at-risk run may');
	// And the reserve is not a second allowance: the total is still the total.
	let more = 0;
	while (b.take(true)) more++;
	assert.equal(20 + 1 + more, MAX_FETCH_PER_TICK, 'the tick still spends exactly its budget');
});

test('FetchBudget: a small allowance reserves nothing, so a fixture budget is unchanged', () => {
	// floor(2/3) === 0. Every existing test hands ingestRuns a budget of 2 or 3
	// and must keep meaning exactly what it meant before the reserve existed.
	const b = new FetchBudget(2);
	assert.equal(b.reserve, 0);
	assert.equal(b.take(false), true);
	assert.equal(b.take(false), true);
	assert.equal(b.take(false), false);
});
