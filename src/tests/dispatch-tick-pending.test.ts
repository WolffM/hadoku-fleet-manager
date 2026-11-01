import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDispatchTick } from '../runners/dispatch-tick.js';
import { __resetPollStateForTesting } from '../runners/dispatch-tick.js';
import { PENDING_INTERVAL_MS } from '../runners/dispatch-tick.js';
import { MAX_PENDING_PROBES } from '../runners/dispatch-tick.js';
import { MIN_QUEUED_MS, ZOMBIE_MS } from '../runners/queue-discovery.js';
import {
	base,
	harness,
	NOW,
	queued,
	recordingHost,
	installDispatchTickRig,
} from './helpers/dispatch-tick-rig.js';

installDispatchTickRig();

// ---------------------------------------------------------------------------
// fleet-manager#11: runs GitHub lists `pending` with jobs queued
// ---------------------------------------------------------------------------
//
// hadoku-cardtable run 40285146065 (2026-10-26): created 07:19:58Z, held by its
// concurrency group with NO jobs until 08:12:03Z, then `pending` with `changes`
// queued on fleet labels for 55 minutes. The queued listing never showed it.

/** A run GitHub lists `pending`, created `runAgoMs` before NOW. */
const pendingRun = (id: number, runAgoMs = 52 * 60_000) => ({
	...queued(id, runAgoMs),
	status: 'pending',
});
/** A queued job on the fleet labels, created `agoMs` before NOW. */
const job = (id: number, agoMs: number) => ({
	id,
	name: `job-${id}`,
	status: 'queued',
	created_at: new Date(NOW - agoMs).toISOString(),
	labels: ['self-hosted', 'hadoku-builder'],
});

/** The queued listing is EMPTY; only the pending listing holds anything. */
function pendingHarness(runs: unknown[], jobs: unknown[]) {
	const h = harness([], jobs);
	const gh = {
		...h.gh,
		get: async (path: string, token?: string, repo?: string) => {
			if (path.includes('status=pending')) {
				h.gh.reads.push(path);
				h.gh.calls.push(path);
				return { workflow_runs: runs };
			}
			return h.gh.get(path, token, repo);
		},
	};
	return { ...h, gh };
}
const listings = (calls: string[]) => calls.filter((c) => c.includes('status=pending')).length;
const probes = (calls: string[]) => calls.filter((c) => c.endsWith('/jobs')).length;

test('#11: a PENDING run with a job queued on fleet labels is minted for', async () => {
	const h = pendingHarness([pendingRun(1)], [job(1, 2 * 60_000)]);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 1, 'the job the queued listing cannot see gets a runner');
	assert.ok(h.calls.some((c) => c.includes('generate-jitconfig')));
});

test('#11: a pending run with NO jobs is held by its own group and never minted for', async () => {
	// hadoku_site 40122856716 spent five minutes `pending` with zero jobs while
	// the deploy before it ran. A runner minted for it would idle out its TTL.
	const rec = recordingHost();
	const h = pendingHarness([pendingRun(1)], []);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 0);
	assert.equal(probes(h.calls), 1, 'the jobs probe is what tells held from invisible');
	assert.ok(
		!rec.infos.some((i) => i.includes('have no job waiting')),
		'a held pending run is normal; it is not a blocked queued run'
	);
});

test("#11: a pending job is aged from its OWN creation, not the run's", async () => {
	// The cardtable shape: the run is 52 minutes old because its group held it,
	// and the job has existed for 30 seconds. The run's age is not a wait.
	const young = pendingHarness([pendingRun(1)], [job(1, 30_000)]);
	assert.equal((await runDispatchTick(base(), 'tok', young.gh, young.sh, NOW)).minted, 0);

	__resetPollStateForTesting();
	const due = pendingHarness([pendingRun(1)], [job(1, MIN_QUEUED_MS)]);
	assert.equal((await runDispatchTick(base(), 'tok', due.gh, due.sh, NOW)).minted, 1);

	// Past the zombie band nothing is minted, for the queued listing's reason.
	__resetPollStateForTesting();
	const old = pendingRun(1, 2 * ZOMBIE_MS);
	const zombie = pendingHarness([old], [job(1, ZOMBIE_MS + 60_000)]);
	assert.equal((await runDispatchTick(base(), 'tok', zombie.gh, zombie.sh, NOW)).minted, 0);
});

test('#11: the pending listing runs on its OWN clock, not the 15s tick', async () => {
	// 27 repos at the tick would be 6,480 calls/hr, more than the whole budget.
	const h = pendingHarness([pendingRun(1)], []);
	const repos = ['WolffM/a', 'WolffM/b', 'WolffM/c'];
	await runDispatchTick(base({ repos }), 'tok', h.gh, h.sh, NOW);
	assert.equal(listings(h.calls), 3, 'every repo once on the first tick');
	for (let t = 15_000; t < PENDING_INTERVAL_MS; t += 15_000) {
		await runDispatchTick(base({ repos }), 'tok', h.gh, h.sh, NOW + t);
	}
	assert.equal(listings(h.calls), 3, 'no pending listing inside the interval');
	assert.equal(probes(h.calls), 3, 'and no probe of a pending run either');
	await runDispatchTick(base({ repos }), 'tok', h.gh, h.sh, NOW + PENDING_INTERVAL_MS);
	assert.equal(listings(h.calls), 6, 'due again once the interval has passed');
});

test('#11: a pending pass probes at most MAX_PENDING_PROBES runs fleet-wide', async () => {
	const runs = Array.from({ length: MAX_PENDING_PROBES + 5 }, (_, i) => pendingRun(i + 1));
	const h = pendingHarness(runs, []);
	await runDispatchTick(base({ repos: ['WolffM/a', 'WolffM/b'] }), 'tok', h.gh, h.sh, NOW);
	assert.equal(probes(h.calls), MAX_PENDING_PROBES);
});

test('#11: an unreadable pending listing mints nothing from it and leaves the queued path alone', async () => {
	const h = harness([queued(1)]);
	const gh = {
		...h.gh,
		get: async (path: string, token?: string, repo?: string) => {
			if (path.includes('status=pending')) throw new Error('502');
			return h.gh.get(path, token, repo);
		},
	};
	const r = await runDispatchTick(base(), 'tok', gh, h.sh, NOW);
	assert.equal(r.minted, 1, 'the queued run is still served');
});

test("#11: a pending run's jobs ETag survives the ticks between pending polls", async () => {
	// Pruned on every tick it was not a candidate, each pending probe would be a
	// full read, and a held run's unchanging empty listing would never be a 304.
	const sent: (string | null)[] = [];
	const h = harness([]);
	const gh = {
		...h.gh,
		getConditional: async <T>(path: string, _t: string, _r: string, etag: string | null) => {
			if (path.endsWith('/jobs')) {
				sent.push(etag);
				return etag
					? ({ status: 'unchanged' } as const)
					: { status: 'ok' as const, body: { jobs: [] } as T, etag: 'W/"held"' };
			}
			const runs = path.includes('status=pending') ? [pendingRun(1)] : [];
			return { status: 'ok' as const, body: { workflow_runs: runs } as T, etag: null };
		},
	};
	for (let t = 0; t <= PENDING_INTERVAL_MS; t += 15_000) {
		await runDispatchTick(base(), 'tok', gh, h.sh, NOW + t);
	}
	assert.deepEqual(sent, [null, 'W/"held"'], 'probed twice, the second conditional');
});
