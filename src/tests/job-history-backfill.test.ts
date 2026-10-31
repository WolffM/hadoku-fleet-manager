/**
 * backfill: the 502 records that vanished. P2.1's backfill patched 502
 * records into job-history.jsonl from a one-shot script, and mgmt-api's
 * next compaction wrote its own in-memory window over every one of them.
 * The script had guarded the race it could see (re-read immediately
 * before writing, abort if the file moved) and that guard was irrelevant:
 * the running process never re-reads the file, so its window had never
 * heard of the patches. These tests pin the shape that survives. Split
 * out of job-history.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/job-history-rig.ts` for the shared `job`/`seed`/
 * `restart`/`at` fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { historyFile } from '../job-history-store.js';
import { compactHistory } from '../job-history-store.js';
import { jobRecords } from '../job-history-store.js';
import { backfillFailedSteps } from '../job-history-ingest.js';
import { job, at, seed, restart, installJobHistoryRig } from './helpers/job-history-rig.js';

installJobHistoryRig();

/**
 * A FAILED job as it looked before 0.22.24: no `steps[]`, so ingest records it
 * with no `failedStep`. This is the state on disk that the backfill exists for —
 * seeding with steps would have ingest compute the field and there would be
 * nothing to back-fill.
 */
const preUpgradeJob = (o: Partial<Record<string, unknown>> = {}) => ({
	...job({ conclusion: 'failure' }),
	...o,
});

/** The SAME job as GitHub serves it today, steps and all. */
const failingJob = (o: Partial<Record<string, unknown>> = {}) => ({
	...job({ conclusion: 'failure' }),
	steps: [
		{
			name: 'Set up job',
			conclusion: 'success',
			started_at: at(0),
			completed_at: at(5),
		},
		{
			name: 'Run tests',
			conclusion: 'failure',
			started_at: at(5),
			completed_at: at(90),
		},
	],
	...o,
});

const DAY = 24 * 3600_000;
/** An ISO stamp `days` before now, so a compaction can be forced deterministically. */
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/**
 * Make `compactHistory` actually REWRITE.
 *
 * It returns early — writing nothing — when no record ages out and the file is
 * not far larger than the window implies, which is the common case and was very
 * nearly the flaw in these tests: an early return would have let both the
 * positive and the negative assertion pass for the wrong reason. So the fixtures
 * carry one record old enough to age out at the `now` used here, which forces
 * the real path.
 */
const COMPACT_AT = Date.now() + 5 * DAY; // 10-day-old record is then 15 days old, past RETENTION_DAYS
/** A pre-0.22.24 failed record, aged so it survives load but not COMPACT_AT. */
const staleJob = () =>
	preUpgradeJob({ started_at: daysAgo(10), completed_at: daysAgo(10 - 100 / 86400) });
/** A pre-0.22.24 failed record recent enough to survive COMPACT_AT. */
const freshJob = () =>
	preUpgradeJob({ started_at: daysAgo(1), completed_at: daysAgo(1 - 100 / 86400) });

test('backfill: a patched record SURVIVES the next compaction', async () => {
	// THE regression. Without persisting through the live window, compactHistory
	// rewrites the file from `records` and the patch is gone with no error.
	await seed([staleJob(), freshJob()]);
	assert.equal(jobRecords().length, 2);
	assert.ok(
		jobRecords().every((r) => r.failedStep === undefined),
		'seeded without a failedStep, as a pre-0.22.24 record is'
	);

	const r = await backfillFailedSteps(() => Promise.resolve({ job: failingJob(), expired: false }));
	assert.equal(r.patched, 2);
	assert.equal(r.persisted, true, 'a patched pass must reach disk');

	// Force a full rewrite from the in-memory window — exactly what mgmt-api did
	// at 15:50 on 2026-09-07 — then reload from the file it produced.
	assert.equal(compactHistory(COMPACT_AT), true, 'the compaction must really have rewritten');
	restart();
	const kept = jobRecords();
	assert.equal(kept.length, 1, 'the aged-out record is gone, which is what forced the rewrite');
	assert.equal(
		kept[0]?.failedStep,
		'Run tests',
		'the backfilled step must survive a compaction, which is what the file-level backfill did not'
	);
	// failedPhase is deliberately NOT asserted here: these fixtures are aged
	// relative to now so a compaction can be forced, which puts the step
	// timestamps outside the record's own window. The phase is pinned by the
	// aligned test below, where the two frames match.
});

test('backfill: reaches disk WITHOUT waiting for a compaction', async () => {
	// The other half of the fix, and it needs its own test: the compaction test
	// above would pass even if the backfill never wrote anything, because
	// `compactHistory` writes the (correctly mutated) window itself. But a
	// compaction may not happen for days — `compactHistory` returns early unless
	// a record ages out or the file has outgrown the window — and mgmt-api
	// restarts many times a day. A pass that only lives in memory is lost to the
	// next restart, which is the same outcome, one step later.
	await seed([preUpgradeJob()]);
	const r = await backfillFailedSteps(() => Promise.resolve({ job: failingJob(), expired: false }));
	assert.equal(r.persisted, true);
	assert.match(readFileSync(historyFile(), 'utf8'), /Run tests/, 'written at the end of the pass');

	restart(); // no compaction in between
	assert.equal(
		jobRecords()[0]?.failedStep,
		'Run tests',
		'a restart before any compaction must not lose the pass'
	);
});

test('backfill: failedPhase is derived, not copied, when the frames align', async () => {
	// The fixed-time fixtures: record window and step timestamps describe the
	// same job, which is the only situation in which a phase means anything.
	await seed([preUpgradeJob()]);
	const r = await backfillFailedSteps(() => Promise.resolve({ job: failingJob(), expired: false }));
	assert.equal(r.patched, 1);
	assert.equal(jobRecords()[0]?.failedStep, 'Run tests');
	assert.equal(
		jobRecords()[0]?.failedPhase,
		'run',
		'a step that is neither the synthetic setup nor a Post/Complete step is run'
	);
});

test('backfill: a file-level patch is DESTROYED by the next compaction', async () => {
	// The negative half, and the reason the route exists. This is the old
	// script's approach reduced to its essentials: change the file, leave the
	// live window alone. It reads as a success and loses everything.
	await seed([staleJob(), freshJob()]);
	writeFileSync(
		historyFile(),
		jobRecords()
			.map((r) => JSON.stringify({ ...r, failedStep: 'Run tests' }))
			.join('\n') + '\n'
	);
	// The patch is genuinely on disk at this instant — the old script would have
	// reported success right here and exited 0.
	assert.match(readFileSync(historyFile(), 'utf8'), /Run tests/);

	assert.equal(compactHistory(COMPACT_AT), true);
	assert.doesNotMatch(
		readFileSync(historyFile(), 'utf8'),
		/Run tests/,
		'the live window overwrites a file-level patch — this is the bug, pinned'
	);
});

test('backfill: an aged-out job counts as EXPIRED, never as patched', async () => {
	// GitHub ages job records out daily. "Gone forever" and "the call failed"
	// are different jobs — one means stop asking, the other means try again.
	await seed([preUpgradeJob()]);
	const r = await backfillFailedSteps(() => Promise.resolve({ job: null, expired: true }));
	assert.equal(r.expired, 1);
	assert.equal(r.failed, 0);
	assert.equal(r.patched, 0);
	assert.equal(r.persisted, false, 'nothing was patched, so nothing is rewritten');
});

test('backfill: a transient failure is FAILED, not expired', async () => {
	await seed([preUpgradeJob()]);
	const r = await backfillFailedSteps(() => Promise.resolve({ job: null, expired: false }));
	assert.equal(r.failed, 1);
	assert.equal(r.expired, 0, 'a timeout must not be recorded as permanently gone');
});

test('backfill: a SUCCESSFUL record is never a candidate', async () => {
	await seed([job({ conclusion: 'success' })]);
	let calls = 0;
	const r = await backfillFailedSteps(() => {
		calls++;
		return Promise.resolve({ job: failingJob(), expired: false });
	});
	assert.equal(r.candidates, 0);
	assert.equal(calls, 0, 'a success has no failed step to find — do not spend a call on it');
});

test('backfill: is idempotent — a second pass costs nothing', async () => {
	await seed([preUpgradeJob()]);
	let calls = 0;
	const fetch = () => {
		calls++;
		return Promise.resolve({ job: failingJob(), expired: false });
	};
	await backfillFailedSteps(fetch);
	assert.equal(calls, 1);
	const second = await backfillFailedSteps(fetch);
	assert.equal(calls, 1, 'the record already has a failedStep — no second fetch');
	assert.equal(second.candidates, 0);
});

test('backfill: steps that do not explain the failure leave the record ALONE', async () => {
	// Never guessed, same rule queueSec and the phase fields follow.
	await seed([preUpgradeJob()]);
	const r = await backfillFailedSteps(() =>
		Promise.resolve({ job: { ...failingJob(), steps: [] }, expired: false })
	);
	assert.equal(r.patched, 0);
	assert.equal(jobRecords()[0]?.failedStep, undefined);
});

test('backfill: --max bounds the pass and reports what is LEFT', async () => {
	await seed([preUpgradeJob(), preUpgradeJob(), preUpgradeJob()]);
	const r = await backfillFailedSteps(
		() => Promise.resolve({ job: failingJob(), expired: false }),
		{
			max: 2,
		}
	);
	assert.equal(r.fetched, 2);
	assert.equal(r.remaining, 1, 'a bounded pass must say how much is still owed');
});

test("backfill: the record keeps its OWN conclusion, not the job's live one", async () => {
	// A rerun since ingest may have turned the job green. That is not what this
	// record described, and stepFailure returns undefined for a success — so
	// taking the live conclusion would silently patch nothing and look like an
	// aged-out job.
	await seed([preUpgradeJob()]);
	const r = await backfillFailedSteps(() =>
		Promise.resolve({ job: { ...failingJob(), conclusion: 'success' }, expired: false })
	);
	assert.equal(r.patched, 1, 'the stored conclusion frames the lookup');
	assert.equal(jobRecords()[0]?.failedStep, 'Run tests');
});
