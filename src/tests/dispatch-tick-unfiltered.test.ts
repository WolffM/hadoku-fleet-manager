import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runDispatchTick } from '../runners/dispatch-tick.js';
import {
	noteUnfilteredListing,
	omittedByFilter,
	UNFILTERED_FRESH_MS,
	__resetUnfilteredQueueForTesting,
} from '../runners/unfiltered-queue.js';
import {
	__setDecisionSinkForTesting,
	__restoreDecisionSinkForTesting,
} from '../runners/decision-log.js';
import type { DecisionRecord } from '../runners/decision-log-types.js';
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
// GitHub's `?status=queued` filter omitting a queued run
// ---------------------------------------------------------------------------
//
// hadoku-tenhands 42971351168 (2026-11-11): `drain the board` on
// [self-hosted, pm2-host, taskauto], created 06:17:09Z, started 17:37:22Z on a
// JIT runner minted for a different run. runner-health's unfiltered listing
// called it QUEUED at 06:35, 06:45 and 06:55; the dispatcher wrote no decision
// row for it and queue-health reported waiting=0 for the whole eleven hours.
// The same shape: hadoku-rally 41449963520 (11-02), hadoku-task 41694912563
// (11-03).

const REPO = 'WolffM/hadoku-rally';
let rows: DecisionRecord[] = [];

beforeEach(() => {
	__resetUnfilteredQueueForTesting();
	rows = [];
	__setDecisionSinkForTesting((rs) => {
		rows.push(...rs);
	});
});
afterEach(() => {
	__restoreDecisionSinkForTesting();
	__resetUnfilteredQueueForTesting();
});

const probes = (calls: string[]) => calls.filter((c) => c.endsWith('/jobs')).length;
const mints = (calls: string[]) => calls.filter((c) => c.includes('generate-jitconfig')).length;

test('a queued run the status filter omits, seen by the unfiltered listing, is minted for', async () => {
	const rec = recordingHost();
	// Both filtered listings are empty: the filter left the run out.
	const h = harness([]);
	noteUnfilteredListing(REPO, [queued(42)], NOW - 60_000);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 1, 'the run GitHub would not list under status=queued gets a runner');
	assert.equal(mints(h.calls), 1);
	const gap = rows.filter((x) => x.kind === 'listing-gap');
	assert.equal(gap.length, 1, 'the discovery is a decision row, never silent');
	assert.equal(gap[0].runId, 42);
	assert.equal(gap[0].jobId, 1);
	assert.equal(gap[0].repo, REPO);
	assert.match(gap[0].reason ?? '', /status=queued/);
	assert.ok(
		rows.some((x) => x.kind === 'placed' && x.runId === 42),
		'and the placement that follows is the ordinary one'
	);
	assert.ok(
		rec.warns.some((w) => w.includes('omitted') && w.includes(`${REPO}#42`)),
		'said in the log, naming the run'
	);
});

test('a run both listings show is one candidate, with no listing-gap row', async () => {
	const h = harness([queued(42)]);
	noteUnfilteredListing(REPO, [queued(42)], NOW - 60_000);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 1);
	assert.equal(probes(h.calls), 1, 'probed once, not once per listing');
	assert.equal(rows.filter((x) => x.kind === 'listing-gap').length, 0);
});

test('a fork PR found only in the unfiltered listing is still refused by fork safety', async () => {
	// The run objects are kept whole so this check reads the same fields it
	// reads off the filtered listing; a stripped copy would read as unprovable.
	const h = harness([]);
	const fork = {
		...queued(42),
		event: 'pull_request',
		head_repository: { full_name: 'stranger/hadoku-rally', fork: true },
	};
	noteUnfilteredListing(REPO, [fork], NOW - 60_000);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 0);
	assert.ok(rows.some((x) => x.kind === 'fork' && x.runId === 42));
});

test('a stale unfiltered read is not acted on', async () => {
	const h = harness([]);
	noteUnfilteredListing(REPO, [queued(42)], NOW - UNFILTERED_FRESH_MS - 1);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 0);
	assert.equal(probes(h.calls), 0, 'not even probed');
});

test('an omitted run younger than the age gate waits like any queued run', async () => {
	const h = harness([]);
	noteUnfilteredListing(REPO, [queued(42, 10_000)], NOW);
	const r = await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(r.minted, 0);
});

test('an omitted run with nothing waiting is probed once and then forgotten', async () => {
	// runner-health's read is up to a tick old: the run may have started since.
	// Its probe answers that, and the run must not be re-probed every 10 s for
	// the rest of the read's life, nor reported as a run held by its group.
	const rec = recordingHost();
	const h = harness([], [{ id: 1, status: 'in_progress', labels: ['self-hosted'] }]);
	noteUnfilteredListing(REPO, [queued(42)], NOW - 60_000);
	await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW);
	assert.equal(probes(h.calls), 1);
	await runDispatchTick(base(), 'tok', h.gh, h.sh, NOW + 15_000);
	assert.equal(probes(h.calls), 1, 'forgotten after the probe that found nothing waiting');
	assert.ok(
		!rec.infos.some((i) => i.includes('have no job waiting')),
		'a stale unfiltered read is not a blocked queued run'
	);
	assert.equal(rows.filter((x) => x.kind === 'listing-gap').length, 0);
});

test('only waiting statuses are kept, and the filtered listing subtracts', () => {
	noteUnfilteredListing(
		REPO,
		[
			queued(1),
			{ ...queued(2), status: 'pending' },
			{ ...queued(3), status: 'in_progress' },
			{ ...queued(4), status: 'completed' },
		],
		NOW
	);
	assert.deepEqual(
		omittedByFilter(REPO, 'queued', [], NOW).runs.map((r) => r.id),
		[1]
	);
	assert.deepEqual(
		omittedByFilter(REPO, 'pending', [], NOW).runs.map((r) => r.id),
		[2]
	);
	assert.deepEqual(omittedByFilter(REPO, 'queued', [queued(1)], NOW).runs, []);
	assert.deepEqual(omittedByFilter('WolffM/other', 'queued', [], NOW).runs, []);
});
