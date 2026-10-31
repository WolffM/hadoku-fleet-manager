/**
 * Queue-time and idle-time attribution, read straight off the stored
 * record rather than derived: `idleSecondsByNode` measures from the END of
 * a job, not its start (2026-09-03: a run sat 628s and ci:queue-health
 * reported "the fleet is not serving work" — the dispatcher had minted in
 * 19s, and the runner then idled ten minutes waiting for GitHub to hand it
 * the job, which `queueSec`'s dispatcher/GitHub split exists to tell
 * apart). Split out of job-history.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/job-history-rig.ts` for the shared `T0` fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

import { __resetJobHistoryForTesting } from '../job-history-store.js';
import { historyFile } from '../job-history-store.js';
import { jobRecords } from '../job-history-store.js';
import { idleSecondsByNode } from '../job-history-stats.js';
import { T0, at, installJobHistoryRig } from './helpers/job-history-rig.js';

installJobHistoryRig();

// Feeds `carousel`. Derived from what the fleet DID, never a counter — a cursor
// resets on restart and advances on jobs that never started.
test('idleSecondsByNode measures from the END of the last job, not its start', () => {
	// The rows hang off this `now`, but `idleSecondsByNode` reads them back
	// through the history loader, whose cutoff is the REAL clock — so an
	// absolute anchor here still expires. 473dfdb anchored the rest of this file
	// and left this one because it was passing; it was thirteen days from the
	// cutoff at the time and would have gone red on 2026-09-16.
	const now = T0;
	const row = (runner: string, agoMs: number, durationSec: number) =>
		JSON.stringify({
			repo: 'WolffM/x',
			runId: Math.floor(Math.random() * 1e9),
			jobId: Math.floor(Math.random() * 1e9),
			name: 'typecheck',
			runner,
			labels: ['self-hosted', 'hadoku-builder'],
			startedAt: new Date(now - agoMs).toISOString(),
			durationSec,
		}) + '\n';
	// claw-1 started 10 min ago and ran 9 min -> idle 60s.
	// claw-2 started 5 min ago and ran 10s   -> idle 290s.
	appendFileSync(historyFile(), row('claw-1', 600_000, 540) + row('claw-2', 300_000, 10));
	__resetJobHistoryForTesting();
	const idle = idleSecondsByNode(['claw-1', 'claw-2', 'claw-3'], now);
	assert.equal(idle.get('claw-1'), 60, 'a long job leaves the node busy until it ENDS');
	assert.equal(idle.get('claw-2'), 290);
	assert.equal(idle.has('claw-3'), false, 'no history is ABSENT, not zero');
});

// 2026-09-03: a run sat 628s and ci:queue-health reported "the fleet is not
// serving work". The dispatcher had minted in 19s; the runner then idled ten
// minutes waiting for GitHub to hand it the job. One number could not say which
// half was slow, so answering it took a subagent and a journal query.
test('queue time splits into the dispatcher half and the GitHub half', () => {
	// The real run's clock, kept as offsets: created 17:01:18, minted 17:01:36,
	// started 17:11:46 on 2026-09-03. Anchored to T0 so retention cannot age it out.
	const created = T0;
	const minted = created + 18_000; // 18s — ours
	const started = created + 628_000; // 610s later — GitHub's
	appendFileSync(
		historyFile(),
		JSON.stringify({
			repo: 'WolffM/hadoku_site',
			runId: 33782079633,
			jobId: 100737935236,
			name: 'update',
			// The mint epoch lives in the name, so nothing extra is stored.
			runner: `jit-claw-1-hadoku_site-j100737935236-r33782079633-${Math.floor(minted / 1000)}`,
			labels: ['self-hosted', 'hadoku-builder'],
			startedAt: new Date(started).toISOString(),
			durationSec: 74,
			queueSec: Math.round((started - created) / 1000),
			dispatchSec: Math.round((minted - created) / 1000),
			assignSec: Math.round((started - minted) / 1000),
		}) + '\n'
	);
	__resetJobHistoryForTesting();
	const r = jobRecords().find((x) => x.jobId === 100737935236);
	assert.equal(r?.queueSec, 628, 'the number the alert showed');
	assert.equal(r?.dispatchSec, 18, 'the dispatcher was not slow');
	assert.equal(r?.assignSec, 610, 'GitHub held a runner that was already online');
	assert.equal((r?.dispatchSec ?? 0) + (r?.assignSec ?? 0), r?.queueSec, 'the halves sum');
});

test('a STANDING runner gets neither half rather than a fabricated zero', () => {
	// There is no mint to measure. Reporting 0 would claim the dispatcher acted
	// instantly on a job it never touched.
	appendFileSync(
		historyFile(),
		JSON.stringify({
			repo: 'WolffM/x',
			runId: 5,
			jobId: 55,
			name: 'check',
			runner: 'claw-1',
			labels: [],
			startedAt: at(0),
			durationSec: 10,
			queueSec: 4,
		}) + '\n'
	);
	__resetJobHistoryForTesting();
	const r = jobRecords().find((x) => x.jobId === 55);
	assert.equal(r?.dispatchSec, undefined);
	assert.equal(r?.assignSec, undefined);
});

test('the halves always sum, even when the runner PREDATES the job', () => {
	// A JIT runner minted for one run can be handed a different run's job, so
	// `minted` can be earlier than `created`. Clamping each half on its own then
	// produced an assignSec larger than the whole queue — 3553s against a 2455s
	// max across 636 real jobs. dispatchSec 0 here is meaningful: a runner was
	// already waiting, so none of the wait was ours.
	const started = T0;
	const minted = started - 900_000; // minted 15 min before this job existed
	appendFileSync(
		historyFile(),
		JSON.stringify({
			repo: 'WolffM/x',
			runId: 7,
			jobId: 77,
			name: 'check',
			runner: `jit-claw-2-x-j77-r7-${Math.floor(minted / 1000)}`,
			labels: [],
			startedAt: new Date(started).toISOString(),
			durationSec: 5,
			queueSec: 30,
			dispatchSec: 0,
			assignSec: 30,
		}) + '\n'
	);
	__resetJobHistoryForTesting();
	const r = jobRecords().find((x) => x.jobId === 77);
	assert.equal(r?.dispatchSec, 0, 'a runner was already waiting');
	assert.equal(r?.assignSec, 30, 'so all of it is assignment');
	assert.equal((r?.dispatchSec ?? 0) + (r?.assignSec ?? 0), r?.queueSec);
});
