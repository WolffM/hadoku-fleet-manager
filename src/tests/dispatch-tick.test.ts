import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runDispatchTick } from '../runners/dispatch-tick.js';
import { __restartAnnouncedStuckForTesting } from '../runners/dispatch-tick-reset.js';
import { getDispatchQueueSnapshot } from '../runners/dispatch-tick-poll.js';
import { STUCK_ANNOUNCED_FILE } from '../runners/stuck-runs.js';
import { SATURATED_QUEUED_MS } from '../runners/queue-discovery.js';
import { testStateDir } from './install-test-host.js';
import { fakeGh, fakeShell } from './helpers/fleet-fakes.js';
import {
	node,
	base,
	harness,
	NOW,
	queued,
	recordingHost,
	installDispatchTickRig,
} from './helpers/dispatch-tick-rig.js';

installDispatchTickRig();

/** Older than ZOMBIE_MS, so it is stuck and never a recovery candidate. */
const unclearable = (id: number) => queued(id, 12 * 86_400_000);
const TICK_MS = 60_000;
const bookPath = join(testStateDir, STUCK_ANNOUNCED_FILE);

test('no ephemeral nodes means no poll and no mint', async () => {
	// The inert case. It must not even ask GitHub what is queued.
	const h = harness([queued(1)]);
	const r = await runDispatchTick(base({ order: [] }), 'tok', h.gh, h.sh, NOW);
	assert.deepEqual(r, { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 });
	assert.deepEqual(h.calls, []);
});

test('the queue snapshot is the dispatcher listing, aged at READ time, zombies out, unread named', async () => {
	// 2026-10-25: the panel headline came from a 10-minute health tick. This is
	// the 15s listing; asked a minute later, the same run is a minute older.
	const h = harness([queued(1, 44 * 60_000), unclearable(2)]);
	await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	const q = getDispatchQueueSnapshot(['WolffM/hadoku-rally', 'WolffM/never-read'], NOW + 60_000);
	assert.equal(q.runs, 1, 'the zombie is not a wait');
	assert.equal(q.oldestQueuedMin, 45);
	assert.equal(q.unread, 1, 'a repo never read is unread, not empty');
	assert.equal(q.at, new Date(NOW).toISOString());
});

test('a queued run on an ephemeral node is minted for', async () => {
	const h = harness([queued(1)]);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 1);
	assert.ok(
		h.calls.some((c) => c.includes('generate-jitconfig')),
		'a mint must reach GitHub'
	);
});

test('#102: a sibling already running on a WARM listener counts against its node, though the probe has not seen it', async () => {
	// The probe says claw-3 is idle; the run's own job listing says its warm
	// listener took a sibling. At maxConcurrent 1 that is a full node.
	const h = harness(
		[queued(1)],
		[
			{ id: 1, status: 'queued', name: 'test', labels: ['self-hosted', 'hadoku-builder'] },
			{ id: 2, status: 'in_progress', name: 'lint', runner_name: 'warm-claw-3-hadoku-rally' },
		]
	);
	const r = await runDispatchTick(
		base({ nodes: [node('claw-3', { labels: ['hadoku-builder'], maxConcurrent: 1 })] }),
		'tok',
		h.gh,
		h.sh,
		NOW
	);
	assert.equal(r.minted, 0, 'claw-3 is full: one job, on its warm listener');
	// REVERTED (siblings not read): the probe's busy 0 stands and it mints.
});

test('a run that is no longer queued is not minted for', async () => {
	const h = harness([{ ...queued(1), status: 'in_progress' }]);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 0);
});

test('an unreadable queue listing mints NOTHING — it is not an empty queue', async () => {
	// The failure that must fail toward doing nothing. Reading an API error as
	// "no work" is survivable; reading it as "mint freely" is the OOM.
	const h = harness([]);
	const gh = {
		...h.gh,
		get: async (path: string) => {
			if (path.includes('status=queued')) throw new Error('502');
			return { runners: [] };
		},
	};
	const r = await runDispatchTick(base(), 'tok', gh, h.sh, NOW);
	assert.equal(r.minted, 0);
	assert.equal(r.failed, 0);
});

test('a cold repo is not polled every tick — the API budget is the constraint', async () => {
	const h = harness([]);
	await runDispatchTick(base(), 'tok', h.gh, h.sh, 1_000_000);
	const first = h.calls.filter((c) => c.includes('status=queued')).length;
	// Immediately again: a quiet repo is not due, so no second listing.
	await runDispatchTick(base(), 'tok', h.gh, h.sh, 1_000_000 + 5_000);
	const second = h.calls.filter((c) => c.includes('status=queued')).length;
	assert.equal(first, 1, 'polled once on the first tick — an unseen repo is always due');
	assert.equal(second, 1, 'and not again five seconds later');
});

test('a run queued only moments ago is left to the standing fleet', async () => {
	// The whole reason for the age gate: every repo still has standing runners
	// that take work within seconds. Racing them mints a runner for a run only
	// one listener can have, and the loser holds a slot for its full hour TTL.
	const h = harness([queued(1, 5_000)]);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 0);
});

test('a run whose jobs are all blocked is not minted for', async () => {
	// The concurrency case, which cost the pilot a whole idle hour: the RUN is
	// queued, no JOB is waiting for a runner, and no amount of capacity helps.
	const h = harness([queued(1)], [{ id: 1, status: 'waiting', labels: ['self-hosted'] }]);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 0);
});

test('a job wanting labels the node lacks is not minted for', async () => {
	// tenhands #33240394739 asked for pm2-host + taskauto. claw-3 has neither and
	// never will, so the runner it minted was one nothing could schedule onto.
	const h = harness(
		[queued(1)],
		[{ id: 1, status: 'queued', labels: ['self-hosted', 'pm2-host', 'taskauto'] }]
	);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 0);
	assert.equal(r.skipped, 1, 'and it is SAID to be skipped, not silently dropped');
});

test('implicit runner labels are not treated as requirements', async () => {
	// GitHub adds self-hosted/Linux/X64 at registration, so a job asking for them
	// is asking for nothing a node must declare. Treating them as required
	// would refuse every job on every node.
	const h = harness(
		[queued(1)],
		[{ id: 1, status: 'queued', labels: ['self-hosted', 'Linux', 'X64', 'hadoku-builder'] }]
	);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 1);
});

test('an unreadable jobs listing mints nothing', async () => {
	const h = harness([queued(1)]);
	const gh = {
		...h.gh,
		get: async (path: string) => {
			if (path.includes('/jobs')) throw new Error('502');
			if (path.includes('status=queued')) return { workflow_runs: [queued(1)] };
			return { runners: [] };
		},
	};
	const r = await runDispatchTick(base(), 'tok', gh, h.sh, NOW);
	assert.equal(r.minted, 0, 'unreadable is not "no jobs waiting"');
});

// ---------------------------------------------------------------------------
// Issue #25 — an unclearable run is announced once, and ONCE means once
// ---------------------------------------------------------------------------
//
// Six runs report `queued`, `total_count: 0` and `updated_at == created_at`;
// cancel, rerun and delete are all refused by GitHub, so nothing the fleet or an
// operator can do removes them. The in-process dedup was correct and was scoped
// to the wrong lifetime: mgmt-api restarts on every deploy, and the pm2 logs show
// the same two permanent zombies announced 32 times on 2026-09-08 and 23 times on
// 2026-09-09. Every test below runs the ticks for real and reads the LOG.

test('a stuck run is warned about ONCE across ten ticks', async () => {
	const log = recordingHost();
	const h = harness([unclearable(1)]);
	for (let i = 0; i < 10; i++) {
		const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW + i * TICK_MS);
		assert.equal(r.minted, 0, `tick ${i}: the gate must not soften`);
	}
	assert.equal(log.stuck().length, 1, 'ten ticks, one line');
	assert.match(log.stuck()[0], /WolffM\/hadoku-rally#1/);
});

test('ten ticks with a RESTART between every one still say it once', async () => {
	// THE ACTUAL BUG. A Set in a module is emptied by every deploy, and a deploy
	// is the most common event in this fleet's day. The book has to outlive the
	// process or "said ONCE per run" is a claim about nothing.
	const log = recordingHost();
	const h = harness([unclearable(1)]);
	for (let i = 0; i < 10; i++) {
		await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW + i * TICK_MS);
		__restartAnnouncedStuckForTesting();
	}
	assert.equal(log.stuck().length, 1, 'ten restarts, one line');
	assert.ok(existsSync(bookPath), 'the book is on disk, not in the process');
	const book = JSON.parse(readFileSync(bookPath, 'utf8')) as Record<string, string>;
	assert.deepEqual(Object.keys(book), ['WolffM/hadoku-rally#1']);
});

test('a NEW unclearable run is announced while the old ones stay suppressed', async () => {
	// No gate may get EASIER to pass the worse the failure gets. Suppression is
	// keyed on the run id, so a second zombie is a second key — and the line
	// carries the TOTAL, so a growing population is visible in the one line the
	// mechanism emits. This is how the 2026-09-13 GitHub incident showed up on our
	// side before the status page moved.
	const log = recordingHost();
	const runs: unknown[] = [unclearable(1)];
	const gh = {
		...fakeGh({ jobs: [] }),
		get: async (path: string) => {
			if (path.includes('status=queued')) return { workflow_runs: runs };
			if (path.includes('/jobs')) return { jobs: [] };
			return { runners: [] };
		},
	};
	const sh = fakeShell();
	await runDispatchTick(base(), 'tok', gh as never, sh, NOW);
	assert.equal(log.stuck().length, 1);
	assert.match(log.stuck()[0], /1 NEW run\(s\).*\(1 stuck in total\)/);

	runs.push(unclearable(2), unclearable(3));
	for (let i = 1; i < 10; i++) {
		await runDispatchTick(base(), 'tok', gh as never, sh, NOW + i * TICK_MS);
	}
	assert.equal(log.stuck().length, 2, 'the new pair got exactly one more line');
	const second = log.stuck()[1];
	assert.match(second, /2 NEW run\(s\).*\(3 stuck in total\)/, 'the total grew and says so');
	assert.match(second, /#2/);
	assert.match(second, /#3/);
	assert.doesNotMatch(second, /#1/, 'the already-announced one is not re-listed');
});

test('a run that LEAVES the queue is dropped from the book and re-announced if it returns', async () => {
	// "Only on change" has two halves. Without the drop the book would hold a run
	// GitHub eventually removed, and its return — a real finding — would be silent.
	const log = recordingHost();
	let runs: unknown[] = [unclearable(1)];
	const gh = {
		...fakeGh({ jobs: [] }),
		get: async (path: string) => {
			if (path.includes('status=queued')) return { workflow_runs: runs };
			if (path.includes('/jobs')) return { jobs: [] };
			return { runners: [] };
		},
	};
	const sh = fakeShell();
	await runDispatchTick(base(), 'tok', gh as never, sh, NOW);
	assert.equal(log.stuck().length, 1);

	runs = [];
	await runDispatchTick(base(), 'tok', gh as never, sh, NOW + TICK_MS);
	assert.equal(log.cleared().length, 1, 'the drop is said out loud');
	assert.match(log.cleared()[0], /WolffM\/hadoku-rally#1/);
	assert.deepEqual(
		JSON.parse(readFileSync(bookPath, 'utf8')),
		{},
		'the book emptied with the queue'
	);

	runs = [unclearable(1)];
	await runDispatchTick(base(), 'tok', gh as never, sh, NOW + 2 * TICK_MS);
	assert.equal(log.stuck().length, 2, 'a returning zombie is a finding again');
});

test('an UNREADABLE listing does not empty the book — "I could not look" is not "it is gone"', async () => {
	// The prune reads OBSERVED state or it does not prune. Dropping on absence
	// alone would make every API blip re-announce the whole zombie population the
	// moment it recovered, which is the bug back with extra steps.
	const log = recordingHost();
	let readable = true;
	const gh = {
		...fakeGh({ jobs: [] }),
		get: async (path: string) => {
			if (path.includes('status=queued')) {
				if (!readable) throw new Error('502');
				return { workflow_runs: [unclearable(1)] };
			}
			if (path.includes('/jobs')) return { jobs: [] };
			return { runners: [] };
		},
	};
	const sh = fakeShell();
	await runDispatchTick(base(), 'tok', gh as never, sh, NOW);
	assert.equal(log.stuck().length, 1);

	readable = false;
	for (let i = 1; i < 5; i++) {
		await runDispatchTick(base(), 'tok', gh as never, sh, NOW + i * TICK_MS);
	}
	assert.equal(log.cleared().length, 0, 'an unreadable repo clears nothing');
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(bookPath, 'utf8'))), [
		'WolffM/hadoku-rally#1',
	]);

	readable = true;
	for (let i = 5; i < 10; i++) {
		await runDispatchTick(base(), 'tok', gh as never, sh, NOW + i * TICK_MS);
	}
	assert.equal(log.stuck().length, 1, 'recovery is not a re-announcement');
});

// --- the shortened gate when saturation is OBSERVED (2026-09-01) -----------
//
// MIN_QUEUED_MS is a PROXY for "a standing runner would have taken this". The
// fast loop measures the same thing directly and the proxy costs 90 s on every
// JIT job — measured over the pilot, claw-3's queue medians ran 109-154 s
// against 6-95 s when it held standing runners, for identical execution times.

test('a 45s-queued run is NOT mintable under the default gate', async () => {
	const h = harness([queued(1, 45_000)]);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 0, '90s is the default and 45s has not reached it');
});

test('the same run IS mintable once the caller passes the saturated gate', async () => {
	const h = harness([queued(1, 45_000)]);
	const r = await runDispatchTick(
		base({ minQueuedMs: SATURATED_QUEUED_MS }),
		'tok',
		h.gh,
		h.sh,
		NOW
	);
	assert.equal(r.minted, 1, 'the shortened gate must actually reach mintableRuns');
	assert.ok(h.calls.some((c) => c.includes('generate-jitconfig')));
});

test('the shortened gate still has a floor — a 5s-old run is never urgent', async () => {
	// Saturation was observed up to 60 s ago and a slot can free in the meantime.
	// Zero would mint for work that a standing runner takes immediately: 54.5% of
	// standing pickups land within 10 s.
	const h = harness([queued(1, 5_000)]);
	const r = await runDispatchTick(
		base({ minQueuedMs: SATURATED_QUEUED_MS }),
		'tok',
		h.gh,
		h.sh,
		NOW
	);
	assert.equal(r.minted, 0);
});

// 2026-09-04: the token hit `remaining: 0` and 424 of 478 rate-limited calls were
// this ONE listing — 26 repos every tick. A 304 costs nothing (measured: 20
// conditional requests moved `used` by 0, 20 plain ones by 19).
test('an UNCHANGED listing re-evaluates the cached body, it does not skip the repo', async () => {
	// Runs AGE. A run too young for the gate on one tick is mintable on a later
	// one with byte-identical content, so 304 must not mean "nothing to do".
	const h = harness([queued(1)]);
	let conditional = 0;
	const gh = {
		...h.gh,
		getConditional: async (path: string) => {
			// The jobs probe is conditional too since #117; this test is about the
			// RUNS listing, so only that one is counted and answered from here.
			if (path.includes('/jobs'))
				return { status: 'ok', body: await h.gh.get(path), etag: null } as never;
			if (path.includes('status=pending'))
				return { status: 'ok', body: { workflow_runs: [] }, etag: null } as never;
			conditional++;
			return conditional === 1
				? ({ status: 'ok', body: { workflow_runs: [queued(1)] }, etag: 'W/"a"' } as const)
				: ({ status: 'unchanged' } as const);
		},
	};
	const first = await runDispatchTick(base(), 'tok', gh as never, h.sh, NOW);
	const second = await runDispatchTick(base(), 'tok', gh as never, h.sh, NOW + 60_000);
	assert.equal(conditional, 2, 'polled on both ticks');
	assert.equal(first.minted, 1, 'the fresh listing minted');
	// The 304 tick still saw the run. It is already in flight, so it is SKIPPED
	// rather than minted again — which only happens if the cached body was read.
	assert.equal(second.minted + second.skipped > 0, true, 'the cached body was evaluated');
});

test('an ERROR does not fall back to the cache — stale runs must not be re-minted', async () => {
	// "I could not look" is not "the same as last time". Reusing the cache while
	// the API is down would mint for runs that may already be served, every tick.
	const h = harness([queued(1)]);
	const gh = { ...h.gh, getConditional: async () => ({ status: 'error' }) as const };
	const r = await runDispatchTick(base(), 'tok', gh as never, h.sh, NOW);
	assert.deepEqual(r, { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 });
});

test('with no getConditional the plain path still works — every existing caller', async () => {
	const h = harness([queued(1)]);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 1);
});

// ---------------------------------------------------------------------------
// Starved vs unservable, end to end — the 2026-09-07 egress outage
// ---------------------------------------------------------------------------

test('a stuck run WITH a queued job is recovered, not written off', async () => {
	// The outage case. A 2h04m control-plane failure aged six serviceable runs
	// past MAX_QUEUED_MS; each ran green when re-queued by hand, so refusing them
	// forever was the bug. Three hours old: past the ceiling, inside the
	// recoverable window.
	const h = harness([queued(1, 3 * 3_600_000)]);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 1, 'starved work must re-enter the mint path');
	assert.ok(h.calls.some((c) => c.includes('generate-jitconfig')));
});

test('a stuck run with NO queued job is still never minted for', async () => {
	// THE TREADMILL GUARD, and the reason recovery reuses the jobs probe rather
	// than trusting age alone. Both runs MAX_QUEUED_MS was written for report
	// `total_count: 0` — nothing will ever pick them up, and minting burned a
	// slot an hour forever. Same age as the test above; only the jobs differ.
	const h = harness([queued(1, 3 * 3_600_000)], []);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 0, 'no job waiting means a runner would idle out its TTL');
	assert.ok(!h.calls.some((c) => c.includes('generate-jitconfig')));
});

test('recovery is gated on its own clock, not the dispatch tick', async () => {
	// A /jobs call per candidate is charged whenever the run's body moved, so
	// its ceiling is sized as its spend. Riding the 15s tick, one outage of debris would eat
	// the hourly budget — the 2026-09-05 reap regression exactly. The second tick
	// is 60s later, well inside RECOVERY_INTERVAL_MS, and must not probe again.
	const h = harness([queued(1, 3 * 3_600_000)], []);
	await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	const afterFirst = h.calls.filter((c) => c.includes('/jobs')).length;
	assert.equal(afterFirst, 1, 'the due tick probes once');
	await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW + 60_000);
	assert.equal(
		h.calls.filter((c) => c.includes('/jobs')).length,
		afterFirst,
		'a tick inside the interval must add no probe'
	);
});
