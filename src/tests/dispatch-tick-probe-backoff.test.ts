import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDispatchTick } from '../runners/dispatch-tick.js';
import { __restartPollCacheForTesting } from '../runners/dispatch-tick.js';
import { __resetPollStateForTesting } from '../runners/dispatch-tick.js';
import { PROBE_BACKOFF_MS } from '../runners/probe-backoff.js';
import type { NodeState } from '../runners/placement.js';
import { jitRunnerName } from '../runners/ephemeral.js';
import { fakeGh, fakeShell } from './helpers/fleet-fakes.js';
import {
	node,
	base,
	harness,
	NOW,
	queued,
	installDispatchTickRig,
} from './helpers/dispatch-tick-rig.js';

installDispatchTickRig();

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
		repository: { full_name: 'WolffM/hadoku-rally' },
		head_repository: { full_name: 'WolffM/hadoku-rally', fork: false },
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
		repository: { full_name: 'WolffM/hadoku-rally' },
		head_repository: { full_name: 'WolffM/hadoku-rally', fork: false },
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
			repository: { full_name: 'WolffM/hadoku-rally' },
			head_repository: { full_name: 'WolffM/hadoku-rally', fork: false },
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

const hot = new Map([['WolffM/hadoku-rally', 100]]);
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

/**
 * 2026-10-25 05:27–06:14Z: a backed-off run is ABSENT from the pass, so a slot
 * that frees inside its backoff goes to whatever younger run was probed that
 * tick. The backoff lifts on the fast loop's probe, which a JIT job ending as
 * another starts on the same node does not move. hadoku-study 40165607402
 * (queued 05:27:37) was asked about once a minute or so for 47 minutes while
 * the 15s ticks between placed younger work.
 */
test("2026-10-25: a slot that frees inside an older run's backoff is held for it, not given to a younger run", async () => {
	const OLD = 1;
	const YOUNG = 2;
	const clock = { now: NOW };
	const minted: string[] = [];
	const probes: number[] = [];
	const inner = fakeGh();
	const oldRun = {
		...queued(OLD, 30 * 60_000),
		event: 'repository_dispatch',
	};
	const youngRun = { ...queued(YOUNG, 200_000), event: 'push' };
	const job = (id: number, agoMs: number) => ({
		id,
		name: 'update',
		status: 'queued',
		labels: ['self-hosted', 'hadoku-builder'],
		created_at: iso(NOW - agoMs),
	});
	const gh = {
		get writes() {
			return inner.writes;
		},
		write: async (
			method: 'POST' | 'DELETE',
			path: string,
			token: string,
			body?: unknown,
			repo?: string
		) => {
			if (path.includes('generate-jitconfig')) minted.push((body as { name: string }).name);
			return inner.write(method, path, token, body, repo);
		},
		get: async (path: string, token?: string, repo?: string) => {
			// The young run is not queued yet on the first tick.
			if (path.startsWith('/actions/runs?')) {
				return { workflow_runs: clock.now === NOW ? [oldRun] : [oldRun, youngRun] };
			}
			const m = /\/actions\/runs\/(\d+)\/jobs$/.exec(path);
			if (m) {
				const id = Number(m[1]);
				probes.push(id);
				return { jobs: [id === OLD ? job(11, 30 * 60_000) : job(22, 200_000)] };
			}
			return inner.get(path, token, repo);
		},
	};
	// One slot, held by some other repo's JIT job on the first tick only — the
	// unit listing sees it end, the fast loop's probe (`input.nodes`) does not.
	let units = [jitRunnerName('claw-3', 'WolffM/other', NOW - 60_000, 555, 999)];
	const plain = fakeShell();
	const sh = async (n: string, cmd: string) =>
		cmd.includes('list-units')
			? units.map((u) => `${u}.service loaded active running x`).join('\n')
			: plain(n, cmd);
	const input = base({
		order: ['claw-3'],
		nodes: [builder('claw-3', { maxConcurrent: 1 })],
		recentJobCounts: hot,
	});

	await runDispatchTick(input, 'tok', gh, sh, NOW);
	assert.deepEqual(minted, [], 'the one slot is taken');
	assert.deepEqual(probes, [OLD]);

	units = [];
	clock.now = NOW + 15_000;
	await runDispatchTick(input, 'tok', gh, sh, clock.now);
	assert.deepEqual(minted, [], 'the freed slot is NOT given to the younger run');
	assert.deepEqual(probes, [OLD, YOUNG], 'and the older run was not re-read to decide it');

	clock.now = NOW + 30_000;
	await runDispatchTick(input, 'tok', gh, sh, clock.now);
	assert.equal(minted.length, 1);
	assert.match(minted[0], /-j11-r1-/, 'the older run takes it, minted from a fresh read');
	assert.deepEqual(probes, [OLD, YOUNG, OLD], 'one probe for the slot it won');
});

test('a held run that cannot use the free slot does not keep it from a younger one', async () => {
	// The older run needs jdk21 and nothing free carries it: holding the
	// builder slot for it would waste capacity it can never use.
	const h = stuckRunHarness(['jdk21']);
	const minted: string[] = [];
	let tickNo = 0;
	const youngRun = { ...queued(2, 200_000), event: 'push' };
	const gh = {
		...h.gh,
		write: async (
			method: 'POST' | 'DELETE',
			path: string,
			token: string,
			body?: unknown,
			repo?: string
		) => {
			if (path.includes('generate-jitconfig')) minted.push((body as { name: string }).name);
			return h.gh.write(method, path, token, body, repo);
		},
		get: async (path: string, token?: string, repo?: string) => {
			if (path.startsWith('/actions/runs?')) {
				return { workflow_runs: tickNo === 0 ? h.runs() : [...h.runs(), youngRun] };
			}
			if (path === '/actions/runs/2/jobs') {
				return {
					jobs: [
						{
							id: 22,
							name: 'check',
							status: 'queued',
							labels: ['self-hosted', 'hadoku-builder'],
							created_at: iso(NOW - 200_000),
						},
					],
				};
			}
			return h.gh.get(path, token, repo);
		},
	};
	const input = base({ order: ['claw-3'], nodes: [builder('claw-3')], recentJobCounts: hot });
	await runDispatchTick(input, 'tok', gh, h.sh, NOW);
	tickNo = 1;
	await runDispatchTick(input, 'tok', gh, h.sh, NOW + 15_000);
	assert.equal(h.probes.length, 1, 'the jdk21 run stays backed off');
	assert.equal(minted.length, 1);
	assert.match(minted[0], /-j22-r2-/, 'the younger run it could never have used goes ahead');
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

// 2026-10-25: 12 restarts in two hours, and each one's first polls and probes
// were full-price listings of queues that had not changed. The ETags now
// outlive the process; a restored body is only ever read on a 304.
test('a restart keeps the poll ETag: the first poll after it is conditional, and a 304 serves the body', async () => {
	const h = harness([queued(1)]);
	const sent: (string | null)[] = [];
	let answer: 'ok' | 'unchanged' | 'error' = 'ok';
	const gh = {
		...h.gh,
		getConditional: async (path: string, _t: string, _r: string, etag: string | null) => {
			if (path.includes('/jobs'))
				return { status: 'ok', body: await h.gh.get(path), etag: null } as never;
			if (path.includes('status=pending'))
				return { status: 'ok', body: { workflow_runs: [] }, etag: null } as never;
			sent.push(etag);
			if (answer === 'ok')
				return { status: 'ok', body: { workflow_runs: [queued(1)] }, etag: 'W/"a"' } as const;
			return { status: answer } as const;
		},
	};
	await runDispatchTick(base(), 'tok', gh as never, h.sh, NOW);
	__restartPollCacheForTesting();
	answer = 'unchanged';
	const after = await runDispatchTick(base(), 'tok', gh as never, h.sh, NOW + 60_000);
	assert.deepEqual(sent, [null, 'W/"a"'], 'the restarted process sent the ETag it inherited');
	assert.ok(after.minted + after.skipped > 0, 'the 304 was answered from the persisted body');

	// "Could not look" after a restart is still not the cached body.
	__restartPollCacheForTesting();
	answer = 'error';
	const blind = await runDispatchTick(base(), 'tok', gh as never, h.sh, NOW + 120_000);
	assert.equal(blind.minted + blind.skipped, 0);
});

test('a restart keeps the jobs-probe ETag too', async () => {
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
	__restartPollCacheForTesting();
	await runDispatchTick(input, 'tok', gh, h.sh, NOW + 15_000);
	assert.deepEqual(sent, [null, 'W/"j1"'], 'the backoff is per process; the ETag is not');
});
