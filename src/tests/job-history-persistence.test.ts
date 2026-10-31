/**
 * Persistence, the whole point: mgmt-api redeploys on every push to its own
 * tree and restarts many times a day, so an in-memory window that resets on
 * every restart makes a median meaningless and "how often does hokon step
 * in" unanswerable. These pin that records, dedupe and derived numbers all
 * survive a restart, that a truncated final line costs one record rather
 * than the file, and that the record-count safety budget (a loud net under
 * the time-based retention) trims the oldest in-window records and warns
 * when it does. Split out of job-history.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/job-history-rig.ts` for the shared `job`/`seed`/
 * `restart` fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JobRecord } from '../job-history-store.js';
import { MAX_RECORDS } from '../job-history-store.js';
import { historyCompleteSinceMs } from '../job-history-store.js';
import { __setRecordBudgetForTesting } from '../job-history-store.js';
import { __resetJobHistoryForTesting } from '../job-history-store.js';
import { __setHistoryPathForTesting } from '../job-history-store.js';
import { RETENTION_DAYS } from '../job-history-store.js';
import { historyFile } from '../job-history-store.js';
import { compactHistory } from '../job-history-store.js';
import { loadHistory } from '../job-history-store.js';
import { jobRecords } from '../job-history-store.js';
import { ingestRuns } from '../job-history-ingest.js';
import { summarise } from '../job-history-stats.js';
import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';
import { job, seed, restart, tmp, installJobHistoryRig } from './helpers/job-history-rig.js';

installJobHistoryRig();

const NODES = ['claw-1', 'claw-2', 'claw-3', 'hokon'];

// ── persistence: the whole point ────────────────────────────────────────────
// mgmt-api redeploys on every push to its own tree, so it restarts many times a
// day. An in-memory window resets several times an hour, which makes a median
// meaningless and "how often does hokon step in" unanswerable — the panel showed
// `total: 0` most times anyone opened it. These pin that a restart no longer
// costs the history.

test('persistence: records SURVIVE a restart', async () => {
	await seed([job({ runner_name: 'claw-2' }), job({ runner_name: 'hokon' })]);
	assert.equal(jobRecords().length, 2);

	restart();
	assert.equal(jobRecords().length, 2, 'a restart must not empty the window');
	const s = summarise(NODES);
	assert.equal(s.total, 2);
	assert.equal(s.backstopJobs, 1, 'and the derived numbers survive too');
});

test('persistence: a seen run is STILL seen after a restart', async () => {
	// Otherwise the tick after every deploy re-fetches every run it already had,
	// defeating the dedupe that keeps this cheap.
	let calls = 0;
	const fetch = () => {
		calls++;
		return Promise.resolve({ jobs: [job()] });
	};
	await ingestRuns('WolffM/x', [{ id: 77, status: 'completed' }], fetch);
	assert.equal(calls, 1);

	restart();
	await ingestRuns('WolffM/x', [{ id: 77, status: 'completed' }], fetch);
	assert.equal(calls, 1, 'the run must not be re-fetched after a restart');
	assert.equal(jobRecords().length, 1, 'and must not be double-counted');
});

test('persistence: a truncated final line costs ONE record, not the file', async () => {
	// The file is append-only, so a process killed mid-write leaves a partial
	// line. Losing the whole history to that would be the worst possible
	// interaction with the restart frequency this exists to survive.
	await seed([job({ runner_name: 'claw-1' }), job({ runner_name: 'claw-2' })]);
	appendFileSync(historyFile(), '{"repo":"WolffM/x","runId":9,"jobI');
	restart();
	assert.equal(jobRecords().length, 2, 'the good records still load');
});

test('persistence: records older than retention are dropped on load', async () => {
	await seed([job({ runner_name: 'claw-1' })]);
	// Write an ancient record directly; loading must age it out.
	appendFileSync(
		historyFile(),
		JSON.stringify({
			repo: 'WolffM/x',
			runId: 555,
			jobId: 555,
			name: 'ancient',
			runner: 'claw-1',
			labels: [],
			startedAt: '2020-01-01T00:00:00Z',
			durationSec: 5,
			conclusion: 'success',
		}) + '\n'
	);
	restart();
	assert.equal(jobRecords().length, 1, 'the 2020 record is outside retention');
	assert.ok(!jobRecords().some((r) => r.name === 'ancient'));
});

// ── retention is by TIME; the record budget is a loud safety net ───────────

test('retention: the safety budget is sized for 14 days at 4x the 2026-10-28 peak', () => {
	// ~3,500 jobs/day measured on 2026-10-28. The old 20,000 cap held ~7 days
	// at that rate and silently shortened every "14-day" figure.
	assert.ok(MAX_RECORDS >= RETENTION_DAYS * 3_500 * 4, `MAX_RECORDS ${MAX_RECORDS}`);
});

const D_MS = 86_400_000;
const diskRecord = (jobId: number, startedAt: string) =>
	JSON.stringify({
		repo: 'WolffM/hadoku_site',
		runId: jobId,
		jobId,
		name: 'lint',
		runner: `jit-claw-8-hadoku_site-j${jobId}-r${jobId}-1792101627`,
		labels: ['self-hosted', 'hadoku-builder'],
		startedAt,
		durationSec: 40,
		conclusion: 'success',
	}) + '\n';

test('retention: a budget trim of IN-WINDOW records is logged with the days actually kept', () => {
	const warns: string[] = [];
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn: (m: string) => warns.push(m), error() {} },
	});
	try {
		const now = Date.now();
		// Five records, 5..1 days old — all inside the 14-day window.
		for (let d = 5; d >= 1; d--) {
			appendFileSync(historyFile(), diskRecord(700 + d, new Date(now - d * D_MS).toISOString()));
		}
		__setRecordBudgetForTesting(3);
		loadHistory(now);
		assert.equal(jobRecords().length, 3, 'the budget held');
		assert.deepEqual(
			jobRecords().map((r) => r.jobId),
			[703, 702, 701],
			'the OLDEST went, by startedAt'
		);
		const w = warns.find((m) => m.includes('safety budget'));
		assert.ok(w, `a trim must warn; got ${JSON.stringify(warns)}`);
		assert.match(w, /trimmed 2 record\(s\)/);
		assert.match(w, /holds 3\.0 day\(s\)/);
		assert.match(w, new RegExp(`not ${RETENTION_DAYS}`));
		// And the evidence boundary moved with it: nothing before the oldest kept
		// record may be treated as a whole day.
		assert.equal(historyCompleteSinceMs(now), Date.parse(jobRecords()[0].startedAt));
	} finally {
		__setHostForTesting(testHost);
	}
});

test('retention: within the budget nothing is trimmed and nothing warns', () => {
	const warns: string[] = [];
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn: (m: string) => warns.push(m), error() {} },
	});
	try {
		const now = Date.now();
		appendFileSync(historyFile(), diskRecord(801, new Date(now - D_MS).toISOString()));
		appendFileSync(historyFile(), diskRecord(802, new Date(now - 2 * D_MS).toISOString()));
		__setRecordBudgetForTesting(2);
		loadHistory(now);
		assert.equal(jobRecords().length, 2);
		assert.deepEqual(warns, []);
	} finally {
		__setHostForTesting(testHost);
	}
});

test('historyCompleteSinceMs: the retention cutoff when history reaches past it; null when empty', () => {
	const now = Date.now();
	assert.equal(historyCompleteSinceMs(now), null, 'an empty ledger proves nothing');
	__resetJobHistoryForTesting();
	appendFileSync(
		historyFile(),
		diskRecord(901, new Date(now - (RETENTION_DAYS - 1) * D_MS).toISOString())
	);
	assert.equal(historyCompleteSinceMs(now), now - (RETENTION_DAYS - 1) * D_MS);
});

test('persistence: a rewrite is atomic — it replaces the file and leaves no temp file', () => {
	const now = Date.now();
	appendFileSync(historyFile(), diskRecord(951, new Date(now - D_MS).toISOString()));
	appendFileSync(historyFile(), diskRecord(952, new Date(now - 10 * D_MS).toISOString()));
	loadHistory(now);
	// Five days on, the 10-day-old record is past retention, which forces a real rewrite.
	assert.equal(compactHistory(now + 5 * D_MS), true);
	assert.deepEqual(
		readdirSync(tmp).filter((f) => f.endsWith('.tmp')),
		[],
		'the temp file was renamed over the target'
	);
	const lines = readFileSync(historyFile(), 'utf8').trim().split('\n');
	assert.equal(lines.length, 1);
	assert.equal((JSON.parse(lines[0]) as JobRecord).jobId, 951);
});

test('persistence: a missing file is normal, not an error', () => {
	// First run on a fresh host. It must load an empty window quietly.
	__resetJobHistoryForTesting();
	__setHistoryPathForTesting(join(tmp, 'does-not-exist.jsonl'));
	loadHistory();
	assert.equal(jobRecords().length, 0);
});

test('persistence: compaction rewrites the file without losing live records', async () => {
	await seed([job({ runner_name: 'claw-1' }), job({ runner_name: 'claw-2' })]);
	compactHistory();
	restart();
	assert.equal(jobRecords().length, 2, 'compaction must not drop live records');
});
