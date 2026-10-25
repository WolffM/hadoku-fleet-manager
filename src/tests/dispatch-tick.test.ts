import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	runDispatchTick,
	resetRecoveryClock,
	STUCK_ANNOUNCED_FILE,
	__resetPollStateForTesting,
	__restartAnnouncedStuckForTesting,
	PROBE_BACKOFF_MS,
	getDispatchQueueSnapshot,
	type DispatchTickInput,
} from '../runners/dispatch-tick.js';
import type { NodeState } from '../runners/placement.js';
import { fakeGh, fakeShell } from './helpers/fleet-fakes.js';
import { SATURATED_QUEUED_MS } from '../runners/queue-discovery.js';
import { __setHostForTesting } from '../host.js';
import { testHost, testStateDir } from './install-test-host.js';

const node = (name: string, over: Partial<NodeState> = {}): NodeState => ({
	name,
	healthy: true,
	eligible: true,
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 3,
	freeMb: 9000,
	requiredMb: 900,
	minFreeMb: 1536,
	...over,
});

const base = (over: Partial<DispatchTickInput> = {}): DispatchTickInput => ({
	order: ['claw-3'],
	nodes: [node('claw-3', { labels: ['hadoku-builder'] })],
	repos: ['WolffM/hadoku-meet'],
	recentJobCounts: new Map(),
	labelsFor: () => [],
	memoryMaxMbFor: () => 3000,
	homeDir: '/home/hadoku',
	ttlSeconds: 3600,
	...over,
});

function harness(
	runs: unknown[],
	jobs: unknown[] = [{ id: 1, status: 'queued', labels: ['self-hosted', 'hadoku-builder'] }]
) {
	const gh = fakeGh({ workflowRuns: runs, jobs });
	return {
		get calls() {
			return gh.calls;
		},
		sh: fakeShell(),
		gh,
	};
}

const NOW = 1_787_797_008_000;
/** Queued long enough to count as starved — the standing fleet did not take it. */
const queued = (id: number, agoMs = 120_000) => ({
	id,
	status: 'queued',
	created_at: new Date(NOW - agoMs).toISOString(),
	repository: { full_name: 'WolffM/hadoku-meet' },
	head_repository: { full_name: 'WolffM/hadoku-meet', fork: false },
	event: 'push',
});

beforeEach(() => {
	__resetPollStateForTesting();
	resetRecoveryClock();
});

afterEach(() => {
	// The recording host below replaces the preloaded one. Put it back, or one
	// test's log capture silently swallows the next test's output.
	__setHostForTesting(testHost);
});

/**
 * A host whose logger RECORDS, because the no-op one cannot fail a log assertion.
 *
 * The test this replaces built a `warned` array and an `origWarn`, `void`ed them
 * both and asserted nothing about either. It passed for the entire life of the
 * bug it claimed to cover.
 */
function recordingHost() {
	const warns: string[] = [];
	const infos: string[] = [];
	__setHostForTesting({
		...testHost,
		logger: {
			info: (m: string) => {
				infos.push(m);
			},
			warn: (m: string) => {
				warns.push(m);
			},
			error: () => undefined,
		},
	});
	return {
		warns,
		infos,
		/** Only the stuck-ceiling warning; the tick emits others. */
		stuck: () => warns.filter((w) => w.includes('queued past the stuck ceiling')),
		cleared: () => infos.filter((i) => i.includes('are gone from the queue')),
	};
}

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
	const q = getDispatchQueueSnapshot(['WolffM/hadoku-meet', 'WolffM/never-read'], NOW + 60_000);
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
			{ id: 2, status: 'in_progress', name: 'lint', runner_name: 'warm-claw-3-hadoku-meet' },
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
	assert.match(log.stuck()[0], /WolffM\/hadoku-meet#1/);
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
	assert.deepEqual(Object.keys(book), ['WolffM/hadoku-meet#1']);
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
	assert.match(log.cleared()[0], /WolffM\/hadoku-meet#1/);
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
		'WolffM/hadoku-meet#1',
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

// ---------------------------------------------------------------------------
// #89: PendingRun.jobName reaches the live path
// ---------------------------------------------------------------------------
//
// `SpeedModel.expectedExtraSec` takes a `jobName` so the slow-tier spill gate
// (#83) can look up a (repo, job) estimate instead of always falling back to
// the coarser repo-level one. `dispatcher.ts` already wires `run.jobName`
// through to `choosePlacement`'s spill context (`placement.test.ts`'s
// warm-affinity precedent: that half shipped and was NEVER inert, because
// `PendingRun.jobName` was declared and documented but `dispatch-tick.ts`'s
// own `pending.push` never set it — the producer, not the consumer, was the
// missing wire). A unit test of `placement.ts` alone cannot catch that, by
// construction: the thing that was missing was the PRODUCER'S assignment, not
// the callee. So this runs the real call chain —
//
//   runDispatchTick -> runDispatchPass -> planTick -> dispatcher -> choosePlacement
//
// — with only GitHub and the shell faked, and asserts on whether the job
// actually minted. Remove `jobName: j.name` from `dispatch-tick.ts`'s
// `pending.push` and this goes red.
test('#89: the live path supplies jobName, which the slow-tier spill gate reads', async () => {
	// claw-3 is the ONLY node, and it is in the slow tier — a fake SpeedModel,
	// not real job history, so the test is about THIS wire and nothing else.
	// Its `expectedExtraSec` answers differently depending on whether it was
	// handed a job name at all: 1s for the job this run actually asks for
	// (small enough to clear the spill floor immediately), 500s when `jobName`
	// is `undefined` (the coarser repo-level fallback `expectedExtraSec`'s own
	// doc says a caller gets when it cannot name the job).
	const speedModel = {
		tierOf: () => 'slow' as const,
		expectedExtraSec: (_node: string, _repo: string, jobName: string | undefined) =>
			jobName === 'quick-job' ? 1 : 500,
		describe: () => ({ tier: 'slow' as const, p25: 5, p50: 1, kinds: 9 }),
	};
	const fleetInput = base({
		nodes: [node('claw-3', { labels: ['hadoku-builder'], speedModel })],
	});
	// The file's fixed `NOW`: since #92 the pass reads the injected clock for
	// queue age too, so the 200s/100s/500s arithmetic below is exact.
	const now = NOW;
	const run = {
		id: 1,
		status: 'queued',
		created_at: new Date(now - 200_000).toISOString(),
		repository: { full_name: 'WolffM/hadoku-meet' },
		head_repository: { full_name: 'WolffM/hadoku-meet', fork: false },
		event: 'push',
	};
	// Queued 200s ago: clears a ~100s threshold (job-named extra of 1s) but not
	// a ~500s one (the nameless fallback) — see SPILL_FLOOR_SEC in placement.ts.
	const h = harness(
		[run],
		[{ id: 1, status: 'queued', name: 'quick-job', labels: ['self-hosted', 'hadoku-builder'] }]
	);
	const r = await runDispatchTick(fleetInput, 'tok', h.gh, h.sh, now);
	assert.equal(
		r.minted,
		1,
		'the job-named estimate must be what the slow-tier gate actually consulted'
	);
	assert.ok(h.calls.some((c) => c.includes('generate-jitconfig')));
});

// #92: the pass must read the INJECTED clock for queue age, not its own
// `Date.now()`. The injected clock here is set AHEAD of the wall clock: by it,
// the job has waited 200s, past the 100s spill floor, so the slow-only fleet
// mints. A pass that re-reads `Date.now()` sees a NEGATIVE age and holds it.
// (A clock set in the past cannot tell the two apart: the wall clock then makes
// the run weeks old, and the zombie band drops it either way.)
test('#92: queue age comes from the injected clock, not the wall clock', async () => {
	const speedModel = {
		tierOf: () => 'slow' as const,
		expectedExtraSec: () => 1,
		describe: () => ({ tier: 'slow' as const, p25: 5, p50: 3, kinds: 9 }),
	};
	const fleetInput = base({
		nodes: [node('claw-3', { labels: ['hadoku-builder'], speedModel })],
	});
	const ahead = Date.now() + 10 * 24 * 3600 * 1000;
	const run = {
		id: 1,
		status: 'queued',
		created_at: new Date(ahead - 200_000).toISOString(),
		repository: { full_name: 'WolffM/hadoku-meet' },
		head_repository: { full_name: 'WolffM/hadoku-meet', fork: false },
		event: 'push',
	};
	const h = harness(
		[run],
		[{ id: 1, status: 'queued', name: 'quick-job', labels: ['self-hosted', 'hadoku-builder'] }]
	);
	const r = await runDispatchTick(fleetInput, 'tok', h.gh, h.sh, ahead);
	assert.equal(r.minted, 1, 'queued 200s by the injected clock: past the spill floor, so minted');
});

// #96: the spill gate's clock is the JOB's own creation. A dependent job
// (`needs:`) appears only when its dependencies finish, so inside a run that
// started ten minutes ago it is still only seconds old, and a slow-only fleet
// must hold it. The same job, once it has truly waited 200s, spills.
for (const [label, jobAgeMs, expected] of [
	['a dependent job seconds old inside an old run is held', 10_000, 0],
	['the same job after a real 200s wait spills', 200_000, 1],
] as const) {
	test(`#96: ${label}`, async () => {
		const speedModel = {
			tierOf: () => 'slow' as const,
			expectedExtraSec: () => 1,
			describe: () => ({ tier: 'slow' as const, p25: 5, p50: 3, kinds: 9 }),
		};
		const fleetInput = base({
			nodes: [node('claw-3', { labels: ['hadoku-builder'], speedModel })],
		});
		const run = {
			id: 1,
			// A run returns to `queued` while one of its jobs waits for a runner,
			// which is the only status discovery lists (`?status=queued`).
			status: 'queued',
			created_at: new Date(NOW - 600_000).toISOString(),
			run_started_at: new Date(NOW - 600_000).toISOString(),
			repository: { full_name: 'WolffM/hadoku-meet' },
			head_repository: { full_name: 'WolffM/hadoku-meet', fork: false },
			event: 'push',
		};
		const h = harness(
			[run],
			[
				{
					id: 1,
					status: 'queued',
					name: 'dispatch-redeploy',
					labels: ['self-hosted', 'hadoku-builder'],
					created_at: new Date(NOW - jobAgeMs).toISOString(),
				},
			]
		);
		const r = await runDispatchTick(fleetInput, 'tok', h.gh, h.sh, NOW);
		assert.equal(r.minted, expected);
	});
}

// --- #117: the jobs probe for a run no node can take ---------------------

/**
 * On 2026-10-16 hadoku-cardtable run 38948244350 needed `jdk21`; the three
 * nodes carrying it were full, and the dispatcher probed `/runs/{id}/jobs` and
 * skipped it 65 times in 17 minutes — 240 calls an hour for one run, in the
 * window that ended in that day's blackout.
 */
const iso = (ms: number) => new Date(ms).toISOString();

function stuckRunHarness(jobLabels: string[]) {
	const clock = { now: NOW };
	const probes: number[] = [];
	const inner = fakeGh();
	const runs = () => [{ ...queued(1), created_at: iso(clock.now - 300_000) }];
	const defaultJobs = () => [
		{
			id: 11,
			name: 'forge-e2e (2)',
			status: 'queued',
			labels: ['self-hosted', ...jobLabels],
			created_at: iso(clock.now - 300_000),
		},
	];
	const self = {
		jobs: defaultJobs as () => unknown[],
	};
	const gh = {
		write: inner.write,
		get writes() {
			return inner.writes;
		},
		get: async (path: string, token?: string, repo?: string) => {
			if (path.startsWith('/actions/runs?')) return { workflow_runs: runs() };
			if (/\/actions\/runs\/\d+\/jobs$/.test(path)) {
				probes.push(clock.now);
				return { jobs: self.jobs() };
			}
			return inner.get(path, token, repo);
		},
	};
	// `jobs` READS THROUGH `self`, so a test that reassigns it changes what the
	// fake answers — a closure over a local would keep serving the default.
	return Object.assign(self, { gh, clock, probes, runs, sh: fakeShell() });
}

const hot = new Map([['WolffM/hadoku-meet', 100]]);
const builder = (name: string, over: Partial<NodeState> = {}) =>
	node(name, { labels: ['self-hosted', 'hadoku-builder'], ...over });

for (const tickMs of [15_000, 5_000]) {
	test(`a run no node can take costs a bounded number of probes an hour (${tickMs / 1000}s ticks)`, async () => {
		__resetPollStateForTesting();
		const h = stuckRunHarness(['jdk21']);
		const input = base({ order: ['claw-3'], nodes: [builder('claw-3')], recentJobCounts: hot });
		const HOUR = 3_600_000;
		for (let t = NOW; t < NOW + HOUR; t += tickMs) {
			h.clock.now = t;
			await runDispatchTick(input, 'tok', h.gh, h.sh, t);
		}
		const bound = HOUR / PROBE_BACKOFF_MS + 1;
		assert.ok(
			h.probes.length <= bound,
			`${h.probes.length} probes an hour; the bound is ${bound} whatever the tick rate`
		);
		assert.ok(
			h.probes.length >= HOUR / PROBE_BACKOFF_MS,
			'bounded, not abandoned — it is re-asked'
		);
		assert.equal(h.gh.writes.filter((w) => w.includes('generate-jitconfig')).length, 0);
	});
}

test('a node GAINING the label lifts the backoff on the very next tick', async () => {
	const h = stuckRunHarness(['jdk21']);
	const nodes = [builder('claw-3')];
	const input = base({ order: ['claw-3'], nodes, recentJobCounts: hot });
	await runDispatchTick(input, 'tok', h.gh, h.sh, NOW);
	await runDispatchTick(input, 'tok', h.gh, h.sh, NOW + 15_000);
	assert.equal(h.probes.length, 1, 'backed off');
	nodes[0] = builder('claw-3', { labels: ['self-hosted', 'hadoku-builder', 'jdk21'] });
	const r = await runDispatchTick(input, 'tok', h.gh, h.sh, NOW + 30_000);
	assert.equal(h.probes.length, 2, 're-probed the tick the answer could change');
	assert.equal(r.minted, 1);
});

test('a freed slot on a node that COULD take it lifts the backoff; churn elsewhere does not', async () => {
	const h = stuckRunHarness(['jdk21']);
	const jdk = (busy: number) =>
		builder('claw-4', { labels: ['self-hosted', 'hadoku-builder', 'jdk21'], standingBusy: busy });
	const nodes = [jdk(3), builder('claw-1', { standingBusy: 0 })];
	const input = base({ order: ['claw-4', 'claw-1'], nodes, recentJobCounts: hot });
	await runDispatchTick(input, 'tok', h.gh, h.sh, NOW);
	assert.equal(h.probes.length, 1);
	// claw-1 cannot carry jdk21: its load is not an input to this job's answer.
	nodes[1] = builder('claw-1', { standingBusy: 2 });
	await runDispatchTick(input, 'tok', h.gh, h.sh, NOW + 15_000);
	assert.equal(h.probes.length, 1, 'an irrelevant node changing must not cost a probe');
	nodes[0] = jdk(2);
	const r = await runDispatchTick(input, 'tok', h.gh, h.sh, NOW + 30_000);
	assert.equal(h.probes.length, 2, 'the freed jdk21 slot is seen on the next tick');
	assert.equal(r.minted, 1);
});

test('a TIME-based hold is re-asked when it releases, not a full backoff later', async () => {
	// A slow claw holds a job until it has queued 100s (SPILL_FLOOR_SEC x p50 1).
	const h = stuckRunHarness([]);
	const slow = {
		tierOf: () => 'slow',
		expectedExtraSec: () => null,
		describe: () => ({ p25: 2, p50: 1 }),
	} as unknown as NonNullable<NodeState['speedModel']>;
	const input = base({
		order: ['claw-5'],
		nodes: [builder('claw-5', { speedModel: slow })],
		recentJobCounts: hot,
	});
	// The job has queued 40s at the first tick; the hold releases at 100s.
	const jobAt = NOW - 40_000;
	h.jobs = () => [
		{ id: 11, name: 'build', status: 'queued', labels: ['self-hosted'], created_at: iso(jobAt) },
	];
	const ticks: number[] = [];
	let mintedAt = 0;
	for (let t = NOW; t <= NOW + PROBE_BACKOFF_MS; t += 15_000) {
		h.clock.now = t;
		const r = await runDispatchTick(input, 'tok', h.gh, h.sh, t);
		ticks.push(t);
		if (r.minted && !mintedAt) mintedAt = t;
	}
	assert.ok(mintedAt, 'minted');
	assert.ok(
		mintedAt - jobAt <= 100_000 + 15_000,
		`minted ${(mintedAt - jobAt) / 1000}s after the job queued — one tick past its release`
	);
	// Asked when first seen, then at the release — nothing in between. (After the
	// mint the run is IN FLIGHT and probed as before; that is not this test.)
	assert.deepEqual(
		h.probes.filter((t) => t <= mintedAt).map((t) => (t - NOW) / 1000),
		[0, 60],
		'backed off between the first ask and the hold releasing'
	);
});

test('the jobs probe is CONDITIONAL — a 304 reuses the body it vouches for', async () => {
	const h = stuckRunHarness(['jdk21']);
	const sent: (string | null)[] = [];
	const body = { jobs: h.jobs() };
	const gh = {
		...h.gh,
		getConditional: async <T>(path: string, _t: string, _r: string, etag: string | null) => {
			if (/\/jobs$/.test(path)) {
				sent.push(etag);
				return etag
					? ({ status: 'unchanged' } as const)
					: { status: 'ok' as const, body: body as T, etag: 'W/"j1"' };
			}
			return { status: 'ok' as const, body: { workflow_runs: h.runs() } as T, etag: null };
		},
	};
	const input = base({ order: ['claw-3'], nodes: [builder('claw-3')], recentJobCounts: hot });
	await runDispatchTick(input, 'tok', gh, h.sh, NOW);
	await runDispatchTick(input, 'tok', gh, h.sh, NOW + PROBE_BACKOFF_MS);
	assert.deepEqual(sent, [null, 'W/"j1"'], 'the second probe sends the ETag the first received');
	// And the 304's body is what was planned on: the run is still unplaceable, so
	// it backs off again rather than reading as "no jobs waiting".
	await runDispatchTick(input, 'tok', gh, h.sh, NOW + PROBE_BACKOFF_MS + 15_000);
	assert.equal(sent.length, 2, 'backed off again off the cached body');
});
