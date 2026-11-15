import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { runDispatchTick } from '../runners/dispatch-tick.js';
import {
	HINT_TTL_MS,
	__resetHintsForTesting,
	hintStats,
	liveHints,
	recordWorkflowJobHint,
} from '../runners/dispatch-hint.js';
import {
	__resetDispatchInputForTesting,
	__setDispatchInputForTesting,
	dispatchBetweenTicks,
} from '../fleet-loop.js';
import {
	base,
	harness,
	NOW,
	queued,
	recordingHost,
	installDispatchTickRig,
} from './helpers/dispatch-tick-rig.js';
import { __resetPollStateForTesting } from '../runners/dispatch-tick-reset.js';

installDispatchTickRig();
beforeEach(() => __resetHintsForTesting());

const REPO = 'WolffM/hadoku-rally';

/** A `workflow_job` delivery body, as GitHub sends it. */
const delivery = (
	over: {
		action?: string;
		repo?: string;
		runId?: number;
		jobId?: number;
		agoMs?: number;
		labels?: string[];
	} = {}
) => ({
	action: over.action ?? 'queued',
	repository: { full_name: over.repo ?? REPO },
	workflow_job: {
		id: over.jobId ?? 11,
		run_id: over.runId ?? 1,
		status: 'queued',
		created_at: new Date(NOW - (over.agoMs ?? 1_000)).toISOString(),
		labels: over.labels ?? ['self-hosted', 'hadoku-builder'],
	},
});

/**
 * The rig's harness, plus `GET /actions/runs/<id>` answering from `runs` — the
 * read a hinted run gets when the listing does not show it yet.
 */
function hinted(listing: unknown[], runs: Record<number, unknown>, jobs?: unknown[]) {
	const h = harness(listing, jobs);
	const gh = {
		...h.gh,
		get: async (path: string, token?: string, repo?: string) => {
			const m = /^\/actions\/runs\/(\d+)$/.exec(path);
			if (m) {
				h.gh.reads.push(path);
				h.gh.calls.push(path);
				return runs[Number(m[1])] ?? null;
			}
			return h.gh.get(path, token, repo);
		},
	};
	return { ...h, gh };
}

const listingReads = (calls: string[]) => calls.filter((c) => c.includes('status=queued'));
const jobsProbes = (calls: string[]) => calls.filter((c) => c.endsWith('/jobs'));

// ---------------------------------------------------------------------------
// The delivery filter
// ---------------------------------------------------------------------------

test('only a QUEUED job on SELF-HOSTED labels is a hint', () => {
	assert.equal(recordWorkflowJobHint(delivery({ action: 'completed' }), NOW).accepted, false);
	assert.equal(recordWorkflowJobHint(delivery({ action: 'in_progress' }), NOW).accepted, false);
	assert.equal(recordWorkflowJobHint(delivery({ labels: ['ubuntu-latest'] }), NOW).accepted, false);
	assert.equal(recordWorkflowJobHint({ action: 'queued' }, NOW).accepted, false);
	assert.equal(recordWorkflowJobHint(null, NOW).accepted, false);
	assert.equal(recordWorkflowJobHint(delivery(), NOW).accepted, true);
	const s = hintStats(NOW);
	assert.equal(s.received, 6);
	assert.equal(s.accepted, 1);
	assert.equal(s.ignored['action:completed'], 1);
	assert.equal(s.ignored['not-self-hosted'], 1);
	assert.equal(s.lastDeliveryLagSec, 1);
});

test("one run's jobs share a hint aged from its OLDEST job", () => {
	recordWorkflowJobHint(delivery({ jobId: 11, agoMs: 5_000 }), NOW);
	recordWorkflowJobHint(delivery({ jobId: 12, agoMs: 1_000 }), NOW);
	const live = liveHints(NOW);
	assert.equal(live.length, 1);
	assert.equal(live[0].createdAtMs, NOW - 5_000);
});

test('a hint expires after HINT_TTL_MS, leaving its run to the poll', () => {
	recordWorkflowJobHint(delivery(), NOW);
	assert.equal(liveHints(NOW + HINT_TTL_MS).length, 1);
	assert.equal(liveHints(NOW + HINT_TTL_MS + 1).length, 0);
});

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

test('a hinted run the listing does not show YET is probed and minted for', async () => {
	// The listing trails a new run by ~2 s; that lag is most of what a hint saves.
	recordWorkflowJobHint(delivery({ runId: 7 }), NOW);
	const h = hinted([], { 7: queued(7, 1_000) });
	const r = await runDispatchTick(
		base({ minQueuedMs: 0, triggered: true }),
		'tok',
		h.gh,
		h.sh,
		NOW
	);
	assert.equal(r.minted, 1);
	assert.ok(h.calls.includes('/actions/runs/7'), 'the run itself is read');
	assert.ok(
		jobsProbes(h.calls).some((c) => c.includes('/runs/7/jobs')),
		'the jobs read decides, not the hint'
	);
});

test("a hint never vouches for a run's identity: a FORK run read back is refused", async () => {
	// This repo is public. The delivery carries no head repository, so fork
	// safety must judge the run GitHub serves, never one built from the hint.
	recordWorkflowJobHint(delivery({ runId: 7 }), NOW);
	const fork = {
		...queued(7, 1_000),
		event: 'pull_request',
		head_repository: { full_name: 'stranger/hadoku-rally', fork: true },
	};
	const h = hinted([], { 7: fork });
	const r = await runDispatchTick(
		base({ minQueuedMs: 0, triggered: true }),
		'tok',
		h.gh,
		h.sh,
		NOW
	);
	assert.equal(r.minted, 0);
	assert.ok(!h.calls.some((c) => c.includes('generate-jitconfig')));
});

test('a hinted run GitHub cannot serve, or reports completed, mints nothing', async () => {
	recordWorkflowJobHint(delivery({ runId: 7 }), NOW);
	const gone = hinted([], {});
	assert.equal(
		(await runDispatchTick(base({ minQueuedMs: 0, triggered: true }), 'tok', gone.gh, gone.sh, NOW))
			.minted,
		0
	);
	assert.equal(liveHints(NOW).length, 1, 'an unread run keeps its hint for the poll');

	__resetPollStateForTesting();
	const done = hinted([], { 7: { ...queued(7, 1_000), status: 'completed' } });
	await runDispatchTick(base({ minQueuedMs: 0, triggered: true }), 'tok', done.gh, done.sh, NOW);
	assert.equal(liveHints(NOW).length, 0, 'a finished run is done with');
});

test('a hinted run is still held to the age gate, aged from its job', async () => {
	recordWorkflowJobHint(delivery({ agoMs: 5_000 }), NOW);
	const h = hinted([], { 1: queued(1, 5_000) });
	const r = await runDispatchTick(
		base({ minQueuedMs: 30_000, triggered: true }),
		'tok',
		h.gh,
		h.sh,
		NOW
	);
	assert.equal(r.minted, 0);
	assert.equal(liveHints(NOW).length, 1, 'kept for the pass that finds it old enough');
});

test('a hinted run with NOTHING waiting mints nothing, is not called blocked, and is dropped', async () => {
	// Served between the delivery and the read — or a replayed delivery.
	const rec = recordingHost();
	recordWorkflowJobHint(delivery(), NOW);
	const h = hinted([], { 1: queued(1, 1_000) }, [
		{ id: 11, status: 'in_progress', labels: ['self-hosted'] },
	]);
	const r = await runDispatchTick(
		base({ minQueuedMs: 0, triggered: true }),
		'tok',
		h.gh,
		h.sh,
		NOW
	);
	assert.equal(r.minted, 0);
	assert.equal(liveHints(NOW).length, 0);
	assert.ok(!rec.infos.some((i) => i.includes('have no job waiting')));
});

test('once the listing shows the hinted run, the hint is dropped and the run is not probed twice', async () => {
	recordWorkflowJobHint(delivery({ runId: 1 }), NOW);
	const h = harness([queued(1)]);
	const r = await runDispatchTick(base({ minQueuedMs: 0 }), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 1);
	assert.equal(jobsProbes(h.calls).length, 1);
	assert.equal(liveHints(NOW).length, 0);
});

test('a TRIGGERED pass polls only the hinted repos; a full pass polls every due repo', async () => {
	const repos = ['WolffM/a', REPO, 'WolffM/c'];
	recordWorkflowJobHint(delivery(), NOW);
	const h = hinted([], {});
	await runDispatchTick(base({ repos, minQueuedMs: 0, triggered: true }), 'tok', h.gh, h.sh, NOW);
	assert.equal(listingReads(h.calls).length, 1, 'one listing, the hinted repo');

	__resetHintsForTesting();
	__resetPollStateForTesting();
	const full = harness([]);
	await runDispatchTick(base({ repos, minQueuedMs: 0 }), 'tok', full.gh, full.sh, NOW);
	assert.equal(listingReads(full.calls).length, 3);
});

test('a hint for a repo the fleet does not serve is never polled', async () => {
	recordWorkflowJobHint(delivery({ repo: 'WolffM/elsewhere' }), NOW);
	const h = hinted([], {});
	await runDispatchTick(base({ minQueuedMs: 0, triggered: true }), 'tok', h.gh, h.sh, NOW);
	assert.equal(listingReads(h.calls).length, 0);
	assert.ok(!h.calls.some((c) => c.startsWith('/actions/runs')));
});

test('a triggered pass does NOT reap, and leaves the reap due for the next full pass', async () => {
	// The reap releases a unit whose job is not in this pass's queued set. A
	// pass that polled one repo would read every other repo's jobs as gone.
	const runnerListings = (calls: string[]) =>
		calls.filter((c) => c.startsWith('/actions/runners?') || c === '/actions/runners');
	recordWorkflowJobHint(delivery(), NOW);
	const t = hinted([], {});
	await runDispatchTick(base({ minQueuedMs: 0, triggered: true }), 'tok', t.gh, t.sh, NOW);
	assert.equal(runnerListings(t.calls).length, 0);

	const f = harness([]);
	await runDispatchTick(base({ minQueuedMs: 0 }), 'tok', f.gh, f.sh, NOW + 1_000);
	assert.ok(runnerListings(f.calls).length > 0, 'the full pass still sweeps');
});

// ---------------------------------------------------------------------------
// fleet-loop: a pass asked for while one is running
// ---------------------------------------------------------------------------

test('a pass requested mid-pass runs right after, and FULL outranks triggered', async () => {
	__setDispatchInputForTesting({} as never);
	const modes: (boolean | undefined)[] = [];
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let calls = 0;
	const dispatch = (async (input: { triggered?: boolean }) => {
		modes.push(input.triggered);
		if (calls++ === 0) await gate;
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	}) as never;
	const gh = {} as never;
	const first = dispatchBetweenTicks('tok', gh, dispatch, 'triggered');
	assert.equal(await dispatchBetweenTicks('tok', gh, dispatch, 'triggered'), 'busy');
	assert.equal(await dispatchBetweenTicks('tok', gh, dispatch, 'full'), 'busy');
	assert.equal(await dispatchBetweenTicks('tok', gh, dispatch, 'triggered'), 'busy');
	release();
	await first;
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(modes, [true, undefined], 'one rerun, and it is the full one');
	__resetDispatchInputForTesting();
});
