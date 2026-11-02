/**
 * The probe ledger: manufactured samples, and the one hole in the dedupe.
 * P3.2's two prerequisites from `claw-floor-design-2026-09-07.md` §1.3 and
 * §6. The forced-placement harness runs OUT OF PROCESS and cannot write
 * this window (see `persistHistory`, and the 502 records lost on
 * 2026-09-07), so it declares its probes in a ledger this module reads.
 * Split out of job-history.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/job-history-rig.ts` for the shared `job`/`installJobHistoryRig`
 * fixture, which also owns the probe-ledger-file cleanup this section's
 * original `afterEach` added (file-global in the combined file, so kept
 * file-global in the rig rather than only here).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import { loadProbeLedger, probeRuns, probeLedgerFile } from '../job-history-probe-ledger.js';
import { RETENTION_DAYS, jobRecords } from '../job-history-store.js';
import { ingestRuns } from '../job-history-ingest.js';
import { job, installJobHistoryRig } from './helpers/job-history-rig.js';

installJobHistoryRig();

/** Write the ledger the harness would have written. */
function declareProbe(entries: { runId: number; repo: string; origin: string }[]): void {
	writeFileSync(
		probeLedgerFile(),
		entries.map((e) => JSON.stringify({ ...e, at: new Date().toISOString() })).join('\n') + '\n'
	);
}

/** `job-history-ingest.ts`'s own read: load, then look up — no `probeOriginOf`
 *  wrapper exists in production (wave cruft-1 lane A dropped it; nothing
 *  called it outside this file), so the tests exercise the real two calls. */
function probeOriginOf(runId: number): string | undefined {
	loadProbeLedger();
	return probeRuns.get(runId);
}

test('probe ledger: an absent ledger changes nothing at all', async () => {
	let calls = 0;
	const fetch = () => {
		calls++;
		return Promise.resolve({ jobs: [job()] });
	};
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], fetch);
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], fetch);
	assert.equal(calls, 1, 'the dedupe holds when nothing has been manufactured');
	assert.equal(jobRecords()[0]?.probe, undefined, 'organic traffic carries no tag');
	assert.equal(probeOriginOf(1), undefined);
});

test('probe ledger: an ORDINARY re-poll never grows the fetch count, ledger or not', async () => {
	// THE GUARD AGAINST RE-OPENING THE HOLE. The skip below is lifted for forced
	// re-dispatches; a change that lifted it for anything else would turn the
	// poller loose on every run in every listing, forever, which is exactly what
	// `seenRuns` was added to stop.
	declareProbe([{ runId: 99, repo: 'WolffM/x', origin: 'forced-rerun' }]);
	let calls = 0;
	const fetch = () => {
		calls++;
		return Promise.resolve({ jobs: [job()] });
	};
	const listing = [
		{ id: 1, status: 'completed' },
		{ id: 2, status: 'completed' },
	];
	await ingestRuns('WolffM/x', listing, fetch);
	assert.equal(calls, 2);
	for (let tick = 0; tick < 5; tick++) await ingestRuns('WolffM/x', listing, fetch);
	assert.equal(calls, 2, 'a ledger entry for some OTHER run must not unlock these');
});

test('probe ledger: a forced re-dispatch IS re-fetched, and exactly once', async () => {
	// The record Control A needs and never had: `job-history.ts` skipped every
	// second attempt of an already-seen run, so attempt 1 of the only run ever
	// retried in the 14-day window is simply absent from the store.
	let calls = 0;
	const attempts = [
		{ jobs: [job({ id: 500, runner_name: 'claw-2', conclusion: 'failure' })] },
		{ jobs: [job({ id: 501, runner_name: 'claw-3', conclusion: 'success' })] },
	];
	const fetch = () => Promise.resolve(attempts[Math.min(calls++, attempts.length - 1)]!);

	await ingestRuns('WolffM/x', [{ id: 7, status: 'completed' }], fetch);
	assert.equal(calls, 1);

	declareProbe([{ runId: 7, repo: 'WolffM/x', origin: 'forced-rerun' }]);
	await ingestRuns('WolffM/x', [{ id: 7, status: 'completed' }], fetch);
	assert.equal(calls, 2, 'the skip is lifted for the forced case');

	// ONE lift, not a standing exemption. Leaving it open for as long as the
	// ledger entry exists would re-fetch this run every tick forever — the
	// unbounded re-poll the dedupe exists to prevent, reintroduced by the fix.
	for (let tick = 0; tick < 5; tick++) {
		await ingestRuns('WolffM/x', [{ id: 7, status: 'completed' }], fetch);
	}
	assert.equal(calls, 2, 'the lift is spent, not standing');

	const runners = jobRecords().map((r) => r.runner);
	assert.deepEqual(runners, ['claw-2', 'claw-3'], 'BOTH attempts are recorded — that is Control A');
});

test('probe ledger: records from a probe run carry the origin that made them', async () => {
	declareProbe([
		{ runId: 10, repo: 'WolffM/x', origin: 'shadow' },
		{ runId: 11, repo: 'WolffM/x', origin: 'forced-rerun' },
	]);
	await ingestRuns(
		'WolffM/x',
		[
			{ id: 10, status: 'completed' },
			{ id: 11, status: 'completed' },
			{ id: 12, status: 'completed' },
		],
		(_repo, id) => Promise.resolve({ jobs: [job({ id: id * 10 })] })
	);
	const byRun = new Map(jobRecords().map((r) => [r.runId, r.probe]));
	assert.equal(
		byRun.get(10),
		'shadow',
		'a shadow run is a NEW run id — it needs no lift, only a tag'
	);
	assert.equal(byRun.get(11), 'forced-rerun');
	assert.equal(byRun.get(12), undefined, 'and organic traffic in the same listing stays organic');
});

test('probe ledger: a forced re-fetch that returns the SAME attempt does not duplicate it', async () => {
	// A forced entry declared before GitHub has actually re-queued the run
	// answers with the jobs already recorded. Pushing them again would double
	// every duration that run contributes to a median — a fabricated sample, in
	// the file the ranking is built from.
	const same = { jobs: [job({ id: 900 })] };
	await ingestRuns('WolffM/x', [{ id: 8, status: 'completed' }], () => Promise.resolve(same));
	declareProbe([{ runId: 8, repo: 'WolffM/x', origin: 'forced-rerun' }]);
	await ingestRuns('WolffM/x', [{ id: 8, status: 'completed' }], () => Promise.resolve(same));
	assert.equal(jobRecords().length, 1);
});

test('probe ledger: it is re-read when it changes, not once per process', async () => {
	// mgmt-api is long-lived and the harness declares a probe SECONDS before the
	// run it names completes. A load-once reader would never see the entry that
	// matters.
	assert.equal(probeOriginOf(42), undefined);
	declareProbe([{ runId: 42, repo: 'WolffM/x', origin: 'shadow' }]);
	assert.equal(probeOriginOf(42), 'shadow');
});

test('probe ledger: a malformed line costs one entry, not the file', async () => {
	writeFileSync(
		probeLedgerFile(),
		'{not json\n' +
			JSON.stringify({ runId: 5, repo: 'WolffM/x', origin: 'shadow' }) +
			'\n' +
			JSON.stringify({ runId: 6, repo: 'WolffM/x', origin: 'not-a-probe-shape' }) +
			'\n'
	);
	assert.equal(probeOriginOf(5), 'shadow');
	assert.equal(probeOriginOf(6), undefined, 'an unrecognised origin is not a probe');
});

test('probe ledger: an entry older than the retention window is not held in memory', async () => {
	// Past RETENTION_DAYS the run has already aged out of `records`, so there is
	// nothing left for the tag to land on. Keeping the entry would grow the map
	// for the life of the process with no reader.
	const ancient = new Date(Date.now() - (RETENTION_DAYS + 1) * 24 * 3600_000).toISOString();
	writeFileSync(
		probeLedgerFile(),
		JSON.stringify({ runId: 1, repo: 'WolffM/x', origin: 'shadow', at: ancient }) +
			'\n' +
			// No `at` at all: unknown age must not silently drop a declaration, the
			// same rule ingestRuns applies to an undated run.
			JSON.stringify({ runId: 2, repo: 'WolffM/x', origin: 'shadow' }) +
			'\n'
	);
	assert.equal(probeOriginOf(1), undefined);
	assert.equal(probeOriginOf(2), 'shadow');
});
