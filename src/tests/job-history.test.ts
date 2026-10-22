/**
 * The job-history window behind the Fleet panel's graphs.
 *
 * Two properties carry real weight. First, COST: this rides on a runs listing
 * someone else already paid for, and must never re-fetch a run it has seen or
 * exceed its per-tick budget — an unbounded version would spend a call per run
 * per repo per tick across 26 repos. Second, the backstop number must mean
 * "hokon had to step in", which requires excluding the pm2-host work that only
 * ever runs there by design.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	backfillFailedSteps,
	idleSecondsByNode,
	ingestRuns,
	FetchBudget,
	MAX_FETCH_PER_TICK,
	jobPhases,
	stepFailure,
	summarise,
	nodeOf,
	median,
	percentile,
	jobRecords,
	loadHistory,
	compactHistory,
	historyFile,
	probeLedgerFile,
	RETENTION_DAYS,
	probeOriginOf,
	__setHistoryPathForTesting,
	__resetJobHistoryForTesting,
	type JobRecord,
} from '../job-history.js';

const NODES = ['claw-1', 'claw-2', 'claw-3', 'hokon'];

// Every test gets its OWN file. Without this the suite reads and WRITES the
// real host history at ~/.hadoku-mgmt/job-history.jsonl — which it did on the
// first run of this change, putting fixture rows for a repo called 'WolffM/x'
// into production state.
let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), 'jobhist-'));
	__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
	__resetJobHistoryForTesting();
	__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	__setHistoryPathForTesting(null);
});

/**
 * Fixture timestamps are RELATIVE, and that is not a style preference.
 *
 * `ingestRuns` ends with `compactHistory()`, and both that and `loadHistory`
 * drop every record older than the ROLLING `RETENTION_DAYS` window. A fixture
 * pinned to an absolute date therefore has an expiry: these were written at
 * `2026-08-25T03:00:00Z`, the cutoff reached them at 03:00 on 2026-09-08, and
 * nineteen tests went red on a file nobody had touched. Some would have failed
 * VACUOUSLY instead of loudly — "a STANDING runner gets neither half" asserts
 * `undefined`, which is exactly what an aged-out record also returns.
 *
 * So every fixture that crosses retention is anchored here. Two days back: far
 * enough inside the window that a slow suite cannot drift out of it, recent
 * enough to be obviously live. The deliberate 2020 record in "records older
 * than retention are dropped on load" stays absolute — being ancient is its
 * whole point — and so do the real-response step timings below, which are read
 * by the pure `jobPhases`/`stepFailure` helpers and never see a cutoff.
 */
const T0 = Date.now() - 2 * 24 * 3600_000;
/** T0 plus `sec`, as the ISO string the Actions API would return. */
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const job = (o: Partial<Record<string, unknown>> = {}) => ({
	id: Math.floor(Math.random() * 1e9),
	name: 'typecheck',
	runner_name: 'claw-2',
	labels: ['self-hosted', 'hadoku-builder'],
	started_at: at(0),
	completed_at: at(100), // 100s
	conclusion: 'success',
	...o,
});

// ── statistics ──────────────────────────────────────────────────────────────

test('median / percentile: empty input is null, not 0', () => {
	assert.equal(median([]), null);
	assert.equal(percentile([], 95), null);
});

test('median: odd and even lengths', () => {
	assert.equal(median([5, 1, 3]), 3);
	assert.equal(median([4, 1, 3, 2]), 3); // (2+3)/2 rounded
});

test('percentile: nearest-rank, clamped at both ends', () => {
	const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
	assert.equal(percentile(xs, 95), 10);
	assert.equal(percentile(xs, 50), 5);
	assert.equal(percentile(xs, 0), 1);
});

// ── node attribution ─────────────────────────────────────────────────────

test('nodeOf: an instance suffix aggregates to its node', () => {
	assert.equal(nodeOf('hokon-tenhands', NODES), 'hokon');
	assert.equal(nodeOf('hokon', NODES), 'hokon');
	assert.equal(nodeOf('claw-1', NODES), 'claw-1');
});

test('nodeOf: longest prefix wins, and an unknown runner keeps its own name', () => {
	// 'claw-1' must not swallow a hypothetical 'claw-10'.
	assert.equal(nodeOf('claw-10', [...NODES, 'claw-10']), 'claw-10');
	assert.equal(nodeOf('mystery-box', NODES), 'mystery-box');
});

// ── ingest cost ─────────────────────────────────────────────────────────────

test('ingestRuns: an IN-PROGRESS run is not recorded', async () => {
	// Its jobs have no completion time; recording one would freeze a partial
	// duration that never gets corrected.
	let calls = 0;
	await ingestRuns('WolffM/x', [{ id: 1, status: 'in_progress' }], () => {
		calls++;
		return Promise.resolve({ jobs: [job()] });
	});
	assert.equal(calls, 0);
	assert.equal(jobRecords().length, 0);
});

test('ingestRuns: a run is fetched ONCE, ever', async () => {
	let calls = 0;
	const fetch = () => {
		calls++;
		return Promise.resolve({ jobs: [job()] });
	};
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], fetch);
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], fetch);
	assert.equal(calls, 1, 'the second tick must not re-fetch a seen run');
	assert.equal(jobRecords().length, 1, 'and must not double-count its jobs');
});

test('ingestRuns: the per-tick budget is respected', async () => {
	let calls = 0;
	const runs = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, status: 'completed' }));
	await ingestRuns(
		'WolffM/x',
		runs,
		() => {
			calls++;
			return Promise.resolve({ jobs: [job()] });
		},
		3
	);
	assert.equal(calls, 3, 'a burst degrades to catching up next tick, not a stall');
});

test('ingestRuns: a job with no runner or no timing is skipped, not guessed', async () => {
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], () =>
		Promise.resolve({
			jobs: [
				job({ runner_name: null }),
				job({ started_at: null }),
				job({ completed_at: null }),
				job({ started_at: at(300), completed_at: at(0) }),
				job(),
			],
		})
	);
	assert.equal(jobRecords().length, 1, 'only the well-formed job is recorded');
	assert.equal(jobRecords()[0]?.durationSec, 100);
});

test('ingestRuns: head_sha is carried onto the record, additively', async () => {
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], () =>
		Promise.resolve({ jobs: [job({ head_sha: 'abc123' })] })
	);
	assert.equal(jobRecords()[0]?.headSha, 'abc123');
});

test('ingestRuns: a job with no head_sha gets no headSha key at all', async () => {
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], () =>
		Promise.resolve({ jobs: [job()] })
	);
	assert.equal('headSha' in jobRecords()[0]!, false, 'absent, never an explicit undefined');
});

// ── the summary ─────────────────────────────────────────────────────────────

async function seed(jobs: ReturnType<typeof job>[]) {
	await ingestRuns('WolffM/x', [{ id: 42, status: 'completed' }], () => Promise.resolve({ jobs }));
}

test('summarise: per-node counts, medians and failures', async () => {
	await seed([
		job({ runner_name: 'claw-2', completed_at: at(10) }), // 10s
		job({ runner_name: 'claw-2', completed_at: at(30) }), // 30s
		job({ runner_name: 'claw-2', completed_at: at(50), conclusion: 'failure' }),
	]);
	const s = summarise(NODES);
	const claw2 = s.byMachine.find((m) => m.machine === 'claw-2')!;
	assert.equal(claw2.jobs, 3);
	assert.equal(claw2.failures, 1);
	assert.equal(claw2.medianSec, 30);
	assert.equal(s.total, 3);
});

test('summarise: pm2-host work is EXCLUDED from the backstop count', async () => {
	// redeploy/reload always run on hokon by design. Counting them as "hokon
	// stepped in" would report a permanent share and bury the real signal.
	await seed([
		job({ runner_name: 'hokon', labels: ['self-hosted', 'pm2-host'], name: 'redeploy' }),
		job({ runner_name: 'hokon', labels: ['self-hosted', 'pm2-host'], name: 'redeploy' }),
		job({ runner_name: 'claw-2' }),
	]);
	const s = summarise(NODES);
	assert.equal(s.backstopJobs, 0, 'pm2-host work is not stepping in');
	assert.equal(s.backstopShare, 0);
});

test('summarise: a BUILDER job on hokon is the "had to step in" signal', async () => {
	await seed([
		job({ runner_name: 'hokon' }), // builder work on the prod host
		job({ runner_name: 'claw-2' }),
		job({ runner_name: 'claw-3' }),
	]);
	const s = summarise(NODES);
	assert.equal(s.backstopJobs, 1);
	assert.ok(Math.abs(s.backstopShare - 1 / 3) < 1e-9);
});

test('summarise: hokon instance runners aggregate into hokon', async () => {
	await seed([job({ runner_name: 'hokon-tenhands' })]);
	const s = summarise(NODES);
	assert.equal(s.byMachine.find((m) => m.machine === 'hokon')?.jobs, 1);
	assert.equal(s.backstopJobs, 1);
});

// ── failuresByZone: whose half of the fence ─────────────────────────────────
//
// `failures` is one number and one number cannot say what to do about it. A node
// with 27 failures that are all the consumer's own test is a healthy box on a
// busy repo; a node with 3 that are all `Set up runner` cannot start a job.
// Issue #3 — "is claw-2 failing timing-sensitive jobs" — sat open partly because
// nothing on the wire told those apart.

/**
 * A JobRecord, handed straight to `summarise` rather than ingested.
 *
 * RELATIVE CLOCK, via `T0` above. These records cross `RETENTION_DAYS` the
 * moment they are pinned to a date, and this file has already gone red twice on
 * exactly that (2026-09-08, and `warm-cache.test.ts` on 2026-09-15).
 */
const zoneRec = (runner: string, o: Partial<JobRecord> = {}): JobRecord => ({
	repo: 'WolffM/hadoku-pygmalion',
	runId: 1,
	jobId: Math.floor(Math.random() * 1e9),
	name: 'test',
	runner,
	labels: ['self-hosted', 'hadoku-builder'],
	startedAt: new Date(T0).toISOString(),
	durationSec: 60,
	conclusion: 'success',
	...o,
});

test('summarise: failures are split into runner / seam / content / fleet / cancelled', () => {
	const s = summarise(NODES, 'hokon', [
		zoneRec('claw-2'),
		// GitHub's own synthetic step — the fleet's half by elimination.
		zoneRec('claw-2', { conclusion: 'failure', failedStep: 'Set up runner' }),
		// A step the workflow NAMED but did not write.
		zoneRec('claw-2', { conclusion: 'failure', failedStep: 'Install', failedPhase: 'run' }),
		// The consumer's own step.
		zoneRec('claw-2', { conclusion: 'failure', failedStep: 'Tests', failedPhase: 'run' }),
		// The #22 signature: a TTL-length job that failed in teardown.
		zoneRec('claw-2', {
			conclusion: 'failure',
			failedStep: 'Post Run actions/checkout@v4',
			durationSec: 3601,
		}),
		// A supersede. Counted, deliberately NOT classified.
		zoneRec('claw-2', { conclusion: 'cancelled', failedStep: 'Post Run actions/setup-node@v6' }),
	]);
	const claw2 = s.byMachine.find((m) => m.machine === 'claw-2')!;
	assert.deepEqual(claw2.failuresByZone, {
		runner: 1,
		seam: 1,
		content: 1,
		fleet: 1,
		cancelled: 1,
	});
});

test('summarise: the five zone buckets SUM to `failures`, on every node', () => {
	// Two counts computed in two places is how a payload stops adding up without
	// anyone reading it closely enough to notice.
	const s = summarise(NODES, 'hokon', [
		zoneRec('claw-1'),
		zoneRec('claw-1', { conclusion: 'failure', failedStep: 'Tests', failedPhase: 'run' }),
		zoneRec('claw-2', { conclusion: 'cancelled' }),
		zoneRec('claw-3', { conclusion: 'timed_out', failedStep: 'Set up job' }),
		zoneRec('hokon', { conclusion: 'failure' }),
	]);
	assert.ok(s.byMachine.length >= 4, 'every node that served something has a row');
	for (const m of s.byMachine) {
		const z = m.failuresByZone;
		assert.equal(
			z.runner + z.seam + z.content + z.fleet + z.cancelled,
			m.failures,
			`${m.machine}: the zones must account for every non-success record`
		);
	}
});

test('summarise: a clean node gets five explicit zeros, never a sparse object', () => {
	// A sparse map renders a node with no runner-zone failures and a node nobody
	// could look at identically. "I could not look" must never read as "nothing
	// is wrong".
	const s = summarise(NODES, 'hokon', [zoneRec('claw-3'), zoneRec('claw-3')]);
	const claw3 = s.byMachine.find((m) => m.machine === 'claw-3')!;
	assert.deepEqual(claw3.failuresByZone, {
		runner: 0,
		seam: 0,
		content: 0,
		fleet: 0,
		cancelled: 0,
	});
	assert.equal(claw3.failures, 0);
});

test('summarise: a job with NO step record is the fleet’s half, not `unknown`', () => {
	// The master doc's own zone table says so: a job that failed without GitHub
	// returning a usable step record generally never got far enough to run one.
	const s = summarise(NODES, 'hokon', [zoneRec('claw-1', { conclusion: 'failure' })]);
	assert.equal(s.byMachine.find((m) => m.machine === 'claw-1')!.failuresByZone.runner, 1);
});

test('summarise: a TTL-length job that SUCCEEDED is not a fleet kill', () => {
	// The unit outlived the job, so the TTL demonstrably did not fire. Counting
	// it would report the fleet killing work it did not kill.
	const s = summarise(NODES, 'hokon', [
		zoneRec('claw-1', { durationSec: 3600, failedStep: 'Post x' }),
	]);
	const one = s.byMachine.find((m) => m.machine === 'claw-1')!;
	assert.equal(one.failuresByZone.fleet, 0);
	assert.equal(one.failures, 0);
});

test('summarise: an empty window reports since=null, not a fake quiet fleet', () => {
	const s = summarise(NODES);
	assert.equal(s.since, null);
	assert.equal(s.total, 0);
	assert.deepEqual(s.byMachine, []);
});

// ── persistence: the whole point ────────────────────────────────────────────
// mgmt-api redeploys on every push to its own tree, so it restarts many times a
// day. An in-memory window resets several times an hour, which makes a median
// meaningless and "how often does hokon step in" unanswerable — the panel showed
// `total: 0` most times anyone opened it. These pin that a restart no longer
// costs the history.

/** Simulate a process restart: drop memory, keep the file. */
function restart() {
	const path = historyFile();
	__resetJobHistoryForTesting();
	__setHistoryPathForTesting(path);
}

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

// ── wave 4c #102 lane C: host-load fields are additive, never required ─────
//
// `ci-throttle.sh`/`job-metrics.sh` carry these four facts; job-history.ts
// does not populate them itself (see JobRecord's own doc comment) — these two
// prove only that the TYPE's shape survives loadHistory()'s JSON.parse
// unharmed in both directions: present and round-tripped, or absent and still
// parsing exactly as every record before this wave did.

test('persistence: a record carrying the wave 4c host-load fields round-trips', () => {
	appendFileSync(
		historyFile(),
		JSON.stringify({
			repo: 'WolffM/cardtable',
			runId: 601,
			jobId: 601,
			name: 'forge-e2e',
			runner: 'claw-9',
			labels: [],
			startedAt: at(0),
			durationSec: 90,
			conclusion: 'success',
			hostLoad1m: 2.5,
			hostCpuPressureAvg10: 4.2,
			hostCoTenants: 2,
			hostCoTenantRepos: ['cardtable', 'hadoku_site'],
		}) + '\n'
	);
	const rec = jobRecords().find((r) => r.jobId === 601);
	assert.ok(rec, 'the record must load at all');
	assert.equal(rec?.hostLoad1m, 2.5);
	assert.equal(rec?.hostCpuPressureAvg10, 4.2);
	assert.equal(rec?.hostCoTenants, 2);
	assert.deepEqual(rec?.hostCoTenantRepos, ['cardtable', 'hadoku_site']);
});

test('persistence: a record carrying "unreadable" (a hook that could not look) round-trips too', () => {
	// The sentinel BOTH hooks emit on a failed read — never null, never a
	// guessed number (see either script's header) — must survive exactly as
	// written, not get coerced into undefined or a number.
	appendFileSync(
		historyFile(),
		JSON.stringify({
			repo: 'WolffM/cardtable',
			runId: 603,
			jobId: 603,
			name: 'forge-e2e',
			runner: 'claw-5',
			labels: [],
			startedAt: at(0),
			durationSec: 90,
			conclusion: 'success',
			hostLoad1m: 'unreadable',
			hostCpuPressureAvg10: 'unreadable',
			hostCoTenants: 'unreadable',
			hostCoTenantRepos: 'unreadable',
		}) + '\n'
	);
	const rec = jobRecords().find((r) => r.jobId === 603);
	assert.ok(rec);
	assert.equal(rec?.hostLoad1m, 'unreadable');
	assert.equal(rec?.hostCoTenantRepos, 'unreadable');
});

test('persistence: an OLD record with none of the host-load fields still parses', () => {
	appendFileSync(
		historyFile(),
		JSON.stringify({
			repo: 'WolffM/x',
			runId: 602,
			jobId: 602,
			name: 'typecheck',
			runner: 'claw-2',
			labels: [],
			startedAt: at(0),
			durationSec: 40,
			conclusion: 'success',
		}) + '\n'
	);
	const rec = jobRecords().find((r) => r.jobId === 602);
	assert.ok(rec, 'a pre-wave-4c record must still load');
	assert.equal(rec?.hostLoad1m, undefined, 'absent, never a fabricated 0');
	assert.equal(rec?.hostCpuPressureAvg10, undefined);
	assert.equal(rec?.hostCoTenants, undefined);
	assert.equal(rec?.hostCoTenantRepos, undefined);
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

// ── phase breakdown ─────────────────────────────────────────────────────────
//
// Derived from steps `/actions/runs/{id}/jobs` already returns. The shapes below
// are copied from a real response (run 33653213284, 2026-09-02).

const step = (name: string, from: string, to: string, conclusion = 'success') => ({
	name,
	started_at: from,
	completed_at: to,
	conclusion,
});

test('jobPhases: setup contains the gap BEFORE the first step', () => {
	// On a JIT node that gap is the runner coming up — the mint — and no other
	// number in the payload exposes it. started_at 16:12:38, first step 16:12:40.
	const start = Date.parse('2026-09-02T16:12:38Z');
	const end = Date.parse('2026-09-02T16:12:47Z');
	const p = jobPhases(
		{
			steps: [
				step('Set up job', '2026-09-02T16:12:40Z', '2026-09-02T16:12:41Z'),
				step('Run actions/checkout@v6', '2026-09-02T16:12:41Z', '2026-09-02T16:12:43Z'),
				step('Post Run actions/checkout@v6', '2026-09-02T16:12:44Z', '2026-09-02T16:12:44Z'),
				step('Complete job', '2026-09-02T16:12:44Z', '2026-09-02T16:12:44Z'),
			],
		},
		start,
		end
	)!;
	assert.equal(p.setupSec, 3, '38 -> 41: the 2s runner gap plus the 1s Set up job');
	assert.equal(p.runSec, 3, '41 -> 44, up to the first Post step');
	assert.equal(p.cleanupSec, 3, '44 -> completed_at 47');
	assert.equal(p.setupSec + p.runSec + p.cleanupSec, Math.round((end - start) / 1000));
});

test('jobPhases: the phases always sum to the job duration', () => {
	// A bar whose segments do not sum to the whole is a bar that lies about
	// proportion, which is the only thing a stacked bar is for.
	const start = Date.parse('2026-09-02T16:12:53Z');
	const end = Date.parse('2026-09-02T16:14:33Z');
	const p = jobPhases(
		{
			steps: [
				step('Set up job', '2026-09-02T16:12:56Z', '2026-09-02T16:12:59Z'),
				step('Install dependencies', '2026-09-02T16:13:10Z', '2026-09-02T16:13:56Z'),
				step('Post Checkout code', '2026-09-02T16:14:29Z', '2026-09-02T16:14:30Z'),
				step('Complete job', '2026-09-02T16:14:30Z', '2026-09-02T16:14:30Z'),
			],
		},
		start,
		end
	)!;
	assert.equal(p.setupSec + p.runSec + p.cleanupSec, Math.round((end - start) / 1000));
	assert.equal(p.cleanupSec, 4, 'the EARLIEST teardown step opens cleanup, not "Complete job"');
});

test('jobPhases: no usable steps is undefined, never zeroes', () => {
	// Same rule as queueSec: a fabricated 0 renders as a phase that took no time
	// rather than one we could not measure, and drags every percentile down.
	const start = Date.parse('2026-09-02T16:12:53Z');
	const end = Date.parse('2026-09-02T16:14:33Z');
	assert.equal(jobPhases({}, start, end), undefined);
	assert.equal(jobPhases({ steps: [] }, start, end), undefined);
	assert.equal(
		jobPhases(
			{ steps: [{ name: 'Set up job', started_at: null, completed_at: null }] },
			start,
			end
		),
		undefined
	);
});

test('jobPhases: a step clock outside the job clock cannot make a negative segment', () => {
	// Clamped rather than trusted — a negative segment renders as a bar running
	// backwards over the ones beside it.
	const start = Date.parse('2026-09-02T16:00:00Z');
	const end = Date.parse('2026-09-02T16:01:00Z');
	const p = jobPhases(
		{
			steps: [
				step('Set up job', '2026-09-02T15:59:00Z', '2026-09-02T16:05:00Z'),
				step('Complete job', '2026-09-02T15:58:00Z', '2026-09-02T15:58:30Z'),
			],
		},
		start,
		end
	)!;
	assert.ok(p.setupSec >= 0 && p.runSec >= 0 && p.cleanupSec >= 0, 'no negative segment');
	assert.equal(p.setupSec + p.runSec + p.cleanupSec, 60, 'still sums to the duration');
});

// ── failed step (P2.1) ──────────────────────────────────────────────────────

test('stepFailure: a successful job never gets a failedStep, even with a failed step record', () => {
	// continue-on-error: the STEP failed, the JOB did not. That is not a
	// fleet-origin failure, and reporting one would be a fabrication.
	const start = Date.parse('2026-09-02T16:12:38Z');
	const end = Date.parse('2026-09-02T16:12:47Z');
	assert.equal(
		stepFailure(
			{ conclusion: 'success', steps: [step('Lint (allowed to fail)', '', '', 'failure')] },
			start,
			end
		),
		undefined
	);
});

test('stepFailure: no step record is undefined, never guessed', () => {
	const start = Date.parse('2026-09-02T16:12:38Z');
	const end = Date.parse('2026-09-02T16:12:47Z');
	assert.equal(stepFailure({ conclusion: 'failure' }, start, end), undefined);
	assert.equal(stepFailure({ conclusion: 'failure', steps: [] }, start, end), undefined);
	// Every step succeeded — GitHub can still report the job as failure/timed_out
	// with no step record naming why (a runner that vanished mid-job).
	assert.equal(
		stepFailure(
			{
				conclusion: 'failure',
				steps: [step('Set up job', '2026-09-02T16:12:38Z', '2026-09-02T16:12:39Z')],
			},
			start,
			end
		),
		undefined
	);
});

test('stepFailure: "Set up job" ITSELF failing lands in setup', () => {
	const start = Date.parse('2026-09-02T16:12:38Z');
	const end = Date.parse('2026-09-02T16:12:47Z');
	const r = stepFailure(
		{
			conclusion: 'failure',
			steps: [
				step('Set up job', '2026-09-02T16:12:38Z', '2026-09-02T16:12:39Z', 'failure'),
				step('Complete job', '2026-09-02T16:12:39Z', '2026-09-02T16:12:47Z'),
			],
		},
		start,
		end
	);
	assert.equal(r?.failedStep, 'Set up job');
	assert.equal(r?.failedPhase, 'setup');
});

test('stepFailure: a SEAM step (uses: after Set up job) lands in run, not setup', () => {
	// jobPhases' `setup` is ONLY "Set up job" itself — everything after it, up
	// to teardown, is `run`, including a `uses:` step the workflow named but
	// did not write. That is coarser than §5.5's runner/seam/content zone
	// table, which WOULD call this a seam step; failedPhase cannot make that
	// distinction alone (see the JobRecord.failedPhase doc comment) — only
	// failedStep's own name can. This pins the boundary so it is not
	// mis-described as "setup" again.
	const start = Date.parse('2026-09-02T16:12:38Z');
	const end = Date.parse('2026-09-02T16:12:47Z');
	const r = stepFailure(
		{
			conclusion: 'failure',
			steps: [
				step('Set up job', '2026-09-02T16:12:38Z', '2026-09-02T16:12:39Z'),
				step(
					'Run actions/setup-python@v5',
					'2026-09-02T16:12:39Z',
					'2026-09-02T16:12:40Z',
					'failure'
				),
				step('Complete job', '2026-09-02T16:12:40Z', '2026-09-02T16:12:47Z'),
			],
		},
		start,
		end
	);
	assert.equal(r?.failedStep, 'Run actions/setup-python@v5');
	assert.equal(r?.failedPhase, 'run');
});

test('stepFailure: a content step the consumer named lands in run', () => {
	const start = Date.parse('2026-09-02T16:12:38Z');
	const end = Date.parse('2026-09-02T16:12:47Z');
	const r = stepFailure(
		{
			conclusion: 'failure',
			steps: [
				step('Set up job', '2026-09-02T16:12:38Z', '2026-09-02T16:12:39Z'),
				step('Tests', '2026-09-02T16:12:39Z', '2026-09-02T16:12:45Z', 'failure'),
				step('Complete job', '2026-09-02T16:12:45Z', '2026-09-02T16:12:47Z'),
			],
		},
		start,
		end
	);
	assert.equal(r?.failedStep, 'Tests');
	assert.equal(r?.failedPhase, 'run');
});

test('stepFailure: a cancelled runner event with no usable phases still names the step', () => {
	// jobPhases returns undefined when steps are unusable; the failed step's
	// NAME must survive that even though its phase cannot.
	const start = Date.parse('2026-09-02T16:12:38Z');
	const end = Date.parse('2026-09-02T16:12:47Z');
	const r = stepFailure(
		{
			conclusion: 'cancelled',
			steps: [
				{ name: 'Set up runner', started_at: null, completed_at: null, conclusion: 'cancelled' },
			],
		},
		start,
		end
	);
	assert.equal(r?.failedStep, 'Set up runner');
	assert.equal(r?.failedPhase, undefined);
});

test('ingestRuns: a failed job records failedStep/failedPhase with zero extra fetches', async () => {
	let calls = 0;
	await ingestRuns(
		'WolffM/x',
		[{ id: 700, status: 'completed', updated_at: new Date().toISOString() }],
		async () => {
			calls++;
			return {
				jobs: [
					job({
						conclusion: 'failure',
						steps: [
							step('Set up job', at(0), at(1)),
							step('Tests', at(1), at(99), 'failure'),
							step('Complete job', at(99), at(100)),
						],
					}),
				],
			};
		},
		5
	);
	assert.equal(calls, 1, 'one call to fetch the jobs — nothing extra for the step data');
	const [r] = jobRecords();
	assert.equal(r.failedStep, 'Tests');
	assert.equal(r.failedPhase, 'run');
});

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

// ── Loss under sustained load ───────────────────────────────────────────────
//
// Measured 2026-09-04: 38 of 95 completed hadoku_site runs had no record at
// all. Not a cost problem — a FAIRNESS one. The listing is newest-first, so
// spending the budget in listing order always defers the oldest runs, and they
// are the ones nearest to falling out of the `per_page=30` window. Next tick
// brings newer runs that outrank them again. They are never caught up.

test('ingestRuns: the budget is spent OLDEST first, not listing order', async () => {
	const seen: number[] = [];
	// Listing order is newest-first, as the API returns it.
	const runs = [{ id: 50 }, { id: 40 }, { id: 30 }, { id: 20 }, { id: 10 }].map((r) => ({
		...r,
		status: 'completed',
	}));
	await ingestRuns(
		'WolffM/x',
		runs,
		(_repo, id) => {
			seen.push(id);
			return Promise.resolve({ jobs: [job()] });
		},
		2
	);
	assert.deepEqual(
		seen,
		[10, 20],
		'the two OLDEST unseen runs must be fetched — they are the ones about to scroll out'
	);
});

test('ingestRuns: a deferred run is caught on a later tick, even as newer runs arrive', async () => {
	// The starvation case, end to end. Budget 2, three ticks, newer runs landing
	// each time: with listing-order spending the oldest are never reached.
	const seen: number[] = [];
	const fetch = (_repo: string, id: number) => {
		seen.push(id);
		return Promise.resolve({ jobs: [job()] });
	};
	const mk = (ids: number[]) => ids.map((id) => ({ id, status: 'completed' }));
	await ingestRuns('WolffM/x', mk([30, 20, 10]), fetch, 2);
	await ingestRuns('WolffM/x', mk([50, 40, 30, 20, 10]), fetch, 2);
	await ingestRuns('WolffM/x', mk([70, 60, 50, 40, 30]), fetch, 2);
	assert.ok(seen.includes(10), 'run 10 must not be starved by newer arrivals');
	assert.ok(seen.includes(20), 'run 20 must not be starved either');
	assert.equal(new Set(seen).size, seen.length, 'and nothing may be fetched twice');
});

test('ingestRuns: a FAILED fetch is retried, not retired forever', async () => {
	// `remember` must happen before the await (the budget is shared), so a null
	// body would otherwise retire the run permanently on one transient 5xx.
	let calls = 0;
	const fetch = () => {
		calls++;
		return Promise.resolve(calls === 1 ? null : { jobs: [job()] });
	};
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], fetch);
	assert.equal(jobRecords().length, 0, 'a failed fetch records nothing');
	await ingestRuns('WolffM/x', [{ id: 1, status: 'completed' }], fetch);
	assert.equal(calls, 2, 'the next tick must try again');
	assert.equal(jobRecords().length, 1, 'and the run is recovered');
});

test('ingestRuns: ancient runs do not eat the budget ahead of todays', async () => {
	// The regression oldest-first introduced, observed in production within half
	// an hour: a quiet repo's 30-run listing spans weeks, so "oldest unseen"
	// reached back nine days and spent the shared budget there while the runs
	// every panel figure is computed from waited.
	const seen: number[] = [];
	const old = new Date(Date.now() - 9 * 24 * 3600_000).toISOString();
	const now = new Date(Date.now() - 3600_000).toISOString();
	const runs = [
		{ id: 900, status: 'completed', updated_at: now },
		{ id: 800, status: 'completed', updated_at: now },
		{ id: 5, status: 'completed', updated_at: old },
		{ id: 4, status: 'completed', updated_at: old },
	];
	await ingestRuns(
		'WolffM/x',
		runs,
		(_r, id) => {
			seen.push(id);
			return Promise.resolve({ jobs: [job()] });
		},
		2
	);
	assert.deepEqual(seen, [800, 900], 'the budget belongs to recent runs, oldest of those first');
});

test('ingestRuns: an undated run is still ingested, never silently dropped', async () => {
	// Unknown age must not become a reason to lose a run.
	const seen: number[] = [];
	await ingestRuns(
		'WolffM/x',
		[{ id: 7, status: 'completed' }],
		(_r, id) => {
			seen.push(id);
			return Promise.resolve({ jobs: [job()] });
		},
		2
	);
	assert.deepEqual(seen, [7]);
});

// ── the ACROSS-repo half of the same starvation (issue #21) ────────────────
//
// Oldest-first fixed starvation within one repo. Across repos the shared budget
// was still first-come: runner-health sweeps the roster in order, and the
// busiest repo on the fleet is #26 of 27, so a repo swept early could spend
// every slot on runs in no danger and leave nothing for a repo whose oldest runs
// were about to scroll out of `per_page=30`. Same mistake one level up — ranking
// by arrival rather than by risk of loss.
//
// Measured 2026-09-14 across the full 14-day window, the fix is a GUARD rather
// than a repair: 0 of 547 eligible runs were missing in 10-minute ticks with >=15
// fleet completions, and the busiest tick ever recorded (45 completions against a
// 30-slot budget) lost nothing. The fleet is not near this cliff. It costs no
// extra API call to stay off it — the reserve redistributes the same 30 slots.

/** What runner-health asks GitHub for: `/actions/runs?per_page=30`. */
const LISTING = 30;

/**
 * The pre-fix budget: one shared counter, first-come, blind to risk.
 *
 * A subclass rather than a copy of the class, so this control cannot silently
 * stop being the thing it claims to be a control for — it inherits every other
 * property of the real budget and overrides exactly the rule under test.
 */
class FirstComeBudget extends FetchBudget {
	override take(): boolean {
		if (this.remaining <= 0) return false;
		this.remaining--;
		return true;
	}
}

/**
 * A two-repo sweep driven tick by tick, with ONE shared budget, in roster order.
 *
 * `busy` is swept first and is deliberately over the whole fleet's capacity — 30
 * new runs per tick against a 30-slot budget. That is the only way to contend the
 * budget at all, and it means `busy` loses runs by ARITHMETIC no allocation can
 * fix. `modest` is the repo under test: 4 runs a tick, comfortably inside the
 * fleet's capacity, and it must not lose one.
 *
 * A run is LOST, not merely deferred, once it has scrolled out of the newest
 * `LISTING` entries of its own repo without ever having been fetched.
 */
async function sweep(makeBudget: (n: number) => FetchBudget, ticks = 12) {
	const produced: Record<string, number[]> = { busy: [], modest: [] };
	const fetchedIds = new Set<number>();
	// Monotonic across both repos, so it is monotonic within each — which is what
	// ascending-id-is-ascending-age relies on.
	let nextId = 1_000;
	const fetch = (_repo: string, id: number) => {
		fetchedIds.add(id);
		return Promise.resolve({ jobs: [job()] });
	};
	// Every run is inside FRESH_HORIZON_H, so the horizon filter never fires and
	// the only thing deciding anything here is the budget.
	const listing = (ids: number[]) =>
		ids
			.slice(-LISTING)
			.reverse() // the API returns newest-first
			.map((id) => ({ id, status: 'completed', updated_at: new Date().toISOString() }));

	for (let tick = 0; tick < ticks; tick++) {
		for (let i = 0; i < 30; i++) produced.busy.push(nextId++);
		for (let i = 0; i < 4; i++) produced.modest.push(nextId++);
		const budget = makeBudget(MAX_FETCH_PER_TICK);
		// Roster order: the busy repo is swept first and gets first refusal.
		await ingestRuns('WolffM/busy', listing(produced.busy), fetch, budget);
		await ingestRuns('WolffM/modest', listing(produced.modest), fetch, budget);
	}

	const lost = (repo: 'busy' | 'modest') => {
		const stillVisible = new Set(produced[repo].slice(-LISTING));
		return produced[repo].filter((id) => !stillVisible.has(id) && !fetchedIds.has(id));
	};
	return { lost, produced, fetchedIds };
}

test('ingestRuns: a repo swept LAST is not starved by one swept first', async () => {
	const { lost, produced } = await sweep((n) => new FetchBudget(n));
	assert.ok(produced.modest.length > LISTING, 'the fixture must outlive one listing');
	assert.deepEqual(
		lost('modest'),
		[],
		'a repo inside the fleet capacity must lose nothing to a repo outside it'
	);
});

test('ingestRuns: the SAME fixture loses runs against a first-come budget', async () => {
	// The control. Without it the test above could be passing because the fixture
	// is too gentle to have blown the old budget either — a green that proves
	// nothing. This is the pre-fix code, on the identical fixture.
	const { lost } = await sweep((n) => new FirstComeBudget(n));
	assert.ok(
		lost('modest').length > 0,
		'first-come must starve the repo swept last — otherwise the fixture proves nothing'
	);
});

test('FetchBudget: the reserve is a third, and only at-risk runs may touch it', () => {
	const b = new FetchBudget(MAX_FETCH_PER_TICK);
	assert.equal(b.reserve, 10, 'a third of 30, floored');
	// Spend down to the reserve on SAFE runs.
	for (let i = 0; i < 20; i++) assert.equal(b.take(false), true, `safe take ${i}`);
	assert.equal(b.remaining, 10);
	assert.equal(b.take(false), false, 'a safe run may not eat the reserve');
	assert.equal(b.take(true), true, 'an at-risk run may');
	// And the reserve is not a second allowance: the total is still the total.
	let more = 0;
	while (b.take(true)) more++;
	assert.equal(20 + 1 + more, MAX_FETCH_PER_TICK, 'the tick still spends exactly its budget');
});

test('FetchBudget: a small allowance reserves nothing, so a fixture budget is unchanged', () => {
	// floor(2/3) === 0. Every existing test hands ingestRuns a budget of 2 or 3
	// and must keep meaning exactly what it meant before the reserve existed.
	const b = new FetchBudget(2);
	assert.equal(b.reserve, 0);
	assert.equal(b.take(false), true);
	assert.equal(b.take(false), true);
	assert.equal(b.take(false), false);
});

// ── backfill: the 502 records that vanished ─────────────────────────────────
// P2.1's backfill patched 502 records into job-history.jsonl from a one-shot
// script, and mgmt-api's next compaction wrote its own in-memory window over
// every one of them. The script had guarded the race it could see (re-read
// immediately before writing, abort if the file moved) and that guard was
// irrelevant: the running process never re-reads the file, so its window had
// never heard of the patches. These tests pin the shape that survives.

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

// ── the probe ledger: manufactured samples, and the one hole in the dedupe ───
//
// P3.2's two prerequisites from `claw-floor-design-2026-09-07.md` §1.3 and §6.
// The forced-placement harness runs OUT OF PROCESS and cannot write this
// window (see `persistHistory`, and the 502 records lost on 2026-09-07), so it
// declares its probes in a ledger this module reads.

/** Write the ledger the harness would have written. */
function declareProbe(entries: { runId: number; repo: string; origin: string }[]): void {
	writeFileSync(
		probeLedgerFile(),
		entries.map((e) => JSON.stringify({ ...e, at: new Date().toISOString() })).join('\n') + '\n'
	);
}

afterEach(() => {
	rmSync(probeLedgerFile(), { force: true });
});

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

// --- byRepo / daily: the per-repo and over-time halves of GET /fleet ---------

const NOW_D = Date.parse('2026-10-09T12:00:00Z');
const rec = (o: Partial<JobRecord> & { startedAt: string }): JobRecord => ({
	repo: 'WolffM/a',
	runId: 1,
	jobId: Math.floor(Math.random() * 1e9),
	name: 'check',
	runner: 'jit-claw-1-a-j1-r1-1',
	labels: ['self-hosted', 'hadoku-builder'],
	durationSec: 100,
	conclusion: 'success',
	...o,
});

test('byRepo: per-repo counts, where it ran, and the queue split', () => {
	const s = summarise(
		['claw-1', 'claw-2'],
		'hokon',
		[
			rec({ startedAt: '2026-10-09T10:00:00Z', queueSec: 10, dispatchSec: 4, assignSec: 6 }),
			rec({
				startedAt: '2026-10-09T10:05:00Z',
				runner: 'warm-claw-2-a',
				queueSec: 30,
				conclusion: 'failure',
			}),
			rec({ repo: 'WolffM/b', startedAt: '2026-10-09T10:06:00Z' }),
		],
		NOW_D
	);
	const a = s.byRepo.find((r) => r.repo === 'WolffM/a')!;
	assert.equal(a.jobs, 2);
	assert.equal(a.failures, 1);
	assert.deepEqual(a.machines, [
		{ machine: 'claw-1', jobs: 1 },
		{ machine: 'claw-2', jobs: 1 },
	]);
	assert.equal(a.queueP95Sec, 30);
	assert.equal(a.dispatchP50Sec, 4);
	assert.equal(s.byRepo[0].repo, 'WolffM/a', 'most jobs first');
	assert.equal(
		s.byRepo.find((r) => r.repo === 'WolffM/b')!.queueP50Sec,
		null,
		'no record carries a queue → null, not 0'
	);
});

test('byRepo.slowest: shards fold into one kind, and a kind with too few runs is left out', () => {
	const runs = [
		...[1, 2, 3].map((n) =>
			rec({ name: `forge-e2e (${n})`, durationSec: 600, startedAt: '2026-10-09T09:00:00Z' })
		),
		...[1, 2].map(() =>
			rec({ name: 'rare', durationSec: 9000, startedAt: '2026-10-09T09:00:00Z' })
		),
		...[1, 2, 3].map(() =>
			rec({ name: 'check', durationSec: 100, startedAt: '2026-10-09T09:00:00Z' })
		),
	];
	const a = summarise(['claw-1'], 'hokon', runs, NOW_D).byRepo[0];
	assert.deepEqual(
		a.slowest.map((k) => k.name),
		['forge-e2e', 'check']
	);
});

test('daily: every day of the window, null BEFORE the history began, zero after, busySec per machine', () => {
	const s = summarise(
		['claw-1', 'hokon'],
		'hokon',
		[
			rec({ startedAt: '2026-10-07T03:00:00Z', durationSec: 50 }),
			rec({ startedAt: '2026-10-07T04:00:00Z', durationSec: 70 }),
			rec({ startedAt: '2026-10-09T05:00:00Z', runner: 'hokon', durationSec: 30 }),
		],
		NOW_D
	);
	assert.equal(s.daily.length, RETENTION_DAYS + 1);
	assert.equal(s.daily.at(-1)!.day, '2026-10-09', 'today included, last');
	const byDay = Object.fromEntries(s.daily.map((d) => [d.day, d]));
	assert.equal(byDay['2026-10-06'].jobs, null, 'before the first record nothing was looking');
	assert.equal(byDay['2026-10-06'].runMedianSec, null);
	assert.equal(byDay['2026-10-08'].jobs, 0, 'after it, an empty day is a real zero');
	assert.equal(byDay['2026-10-08'].runMedianSec, null);
	assert.deepEqual(byDay['2026-10-07'].byMachine, [{ machine: 'claw-1', jobs: 2, busySec: 120 }]);
	assert.equal(byDay['2026-10-09'].backstopJobs, 1);
});
