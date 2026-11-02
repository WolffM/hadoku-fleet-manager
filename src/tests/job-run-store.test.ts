/**
 * job-run-store (T7, plan §6.2/§7.3): the row shape, the registry lookup, the
 * append/read round trip, retention, and the doc classifier `emit.mjs` uses
 * for the cron half. Every test here uses its own `tempDir()` — never the
 * global test state dir other suites share — so a write failure or a day
 * rollover in one test can never bleed into another.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	appendJobRun,
	buildRow,
	classifyEmittedDoc,
	JOB_RUN_RETENTION_DAYS,
	jobRunDir,
	pruneJobRunDir,
	readJobRuns,
	registryKindFor,
} from '../job-run-store.js';
import type { JobEntry } from '../lib/job-registry-types.js';
import { tempDir, cleanupTempDirs } from './tmpdir.js';

afterEach(() => cleanupTempDirs());

const DAY_MS = 86_400_000;
const FIXED_REGISTRY: JobEntry[] = [
	{
		name: 'ci:queue-health',
		sub: 'queue-health',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '1h',
		cadence: { cron: '*/10 * * * *' },
		contract: 'json',
		why: 'fixture',
	},
	{
		name: 'ci:audit-gates',
		args: [],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		contract: 'prose',
		why: 'fixture umbrella',
		coversSubs: [
			{ sub: 'tier-fleet', args: ['--json'], detectionBudget: '48h', why: 'fixture covered sub' },
		],
	},
	{
		name: 'fleet:hosting-converge',
		sub: 'hosting-converge',
		args: ['--json'],
		kind: 'converger',
		detectionBudget: '10m',
		cadence: { clockMs: 5 * 60_000 },
		contract: 'in-process',
		why: 'fixture converger',
	},
];

// ---------------------------------------------------------------- registryKindFor

void test('registryKindFor: a direct registry entry returns its own kind', () => {
	assert.equal(registryKindFor('ci:queue-health', FIXED_REGISTRY), 'gate');
	assert.equal(registryKindFor('fleet:hosting-converge', FIXED_REGISTRY), 'converger');
});

void test('registryKindFor: a covered sub returns the UMBRELLA kind it actually ran under', () => {
	assert.equal(registryKindFor('tier-fleet', FIXED_REGISTRY), 'gate');
});

void test('registryKindFor: an unknown caller is null, not a guess', () => {
	assert.equal(registryKindFor('not-a-real-job', FIXED_REGISTRY), null);
	assert.equal(registryKindFor('', FIXED_REGISTRY), null);
});

// ---------------------------------------------------------------- buildRow

void test('buildRow: fills every field, defaulting findings/why to null', () => {
	const row = buildRow({
		job: 'ci:queue-health',
		startedAtMs: 0,
		durationMs: 12.6,
		kind: 'gate',
		verdict: 'ok',
		host: 'test-host',
	});
	assert.deepEqual(row, {
		v: 1,
		job: 'ci:queue-health',
		startedAt: new Date(0).toISOString(),
		durationMs: 13,
		kind: 'gate',
		verdict: 'ok',
		findings: null,
		why: null,
		host: 'test-host',
	});
});

void test('buildRow: a negative duration (clock skew) clamps to zero, never negative', () => {
	const row = buildRow({
		job: 'x',
		startedAtMs: 0,
		durationMs: -5,
		kind: 'gate',
		verdict: 'ok',
		host: 'h',
	});
	assert.equal(row.durationMs, 0);
});

void test('buildRow: a long `why` is clamped so a row can never approach PIPE_BUF', () => {
	const row = buildRow({
		job: 'x',
		startedAtMs: 0,
		durationMs: 0,
		kind: 'gate',
		verdict: 'error',
		why: 'x'.repeat(5000),
		host: 'h',
	});
	assert.ok(row.why);
	assert.ok(row.why!.length <= 300);
	assert.ok(row.why!.endsWith('…'));
});

void test('buildRow: an empty `why` string is stored as null, not an empty string', () => {
	const row = buildRow({
		job: 'x',
		startedAtMs: 0,
		durationMs: 0,
		kind: 'gate',
		verdict: 'ok',
		why: '',
		host: 'h',
	});
	assert.equal(row.why, null);
});

// ---------------------------------------------------------------- append + read

void test('appendJobRun/readJobRuns: a round trip reads back the same row', () => {
	const dir = jobRunDir(tempDir('job-run-'));
	const row = buildRow({
		job: 'ci:queue-health',
		startedAtMs: Date.now(),
		durationMs: 42,
		kind: 'gate',
		verdict: 'ok',
		host: 'h',
	});
	const res = appendJobRun(row, dir);
	assert.deepEqual(res, { ok: true });
	const read = readJobRuns(dir);
	assert.equal(read.badLines, 0);
	assert.deepEqual(read.rows, [row]);
});

void test('readJobRuns: a missing directory reads as no rows yet, not a throw', () => {
	const dir = join(tempDir('job-run-'), 'never-created');
	assert.doesNotThrow(() => readJobRuns(dir));
	assert.deepEqual(readJobRuns(dir), { rows: [], badLines: 0, files: 0, unreadable: [] });
});

void test('readJobRuns: newest first, across several rows and filtered by job', () => {
	const dir = jobRunDir(tempDir('job-run-'));
	// Clock-relative, not a fixed calendar date: `appendJobRun` prunes against
	// the REAL `Date.now()` on every call, so a fixture pinned to a date far in
	// the past (relative to whenever this suite actually runs) would have its
	// OWN day file deleted by the next call's prune — the same fixture-clock
	// trap `fixture-clock-guard.test.mjs` exists to catch.
	const base = Date.now();
	const a = buildRow({
		job: 'ci:queue-health',
		startedAtMs: base,
		durationMs: 1,
		kind: 'gate',
		verdict: 'ok',
		host: 'h',
	});
	const b = buildRow({
		job: 'ci:srv-drift',
		startedAtMs: base + 1000,
		durationMs: 1,
		kind: 'gate',
		verdict: 'findings',
		findings: 2,
		host: 'h',
	});
	const c = buildRow({
		job: 'ci:queue-health',
		startedAtMs: base + 2000,
		durationMs: 1,
		kind: 'gate',
		verdict: 'ok',
		host: 'h',
	});
	appendJobRun(a, dir);
	appendJobRun(b, dir);
	appendJobRun(c, dir);

	const all = readJobRuns(dir);
	assert.deepEqual(
		all.rows.map((r) => r.startedAt),
		[c.startedAt, b.startedAt, a.startedAt]
	);

	const onlyQueueHealth = readJobRuns(dir, { job: 'ci:queue-health' });
	assert.equal(onlyQueueHealth.rows.length, 2);
	assert.ok(onlyQueueHealth.rows.every((r) => r.job === 'ci:queue-health'));

	const sinceB = readJobRuns(dir, { sinceMs: base + 1000 });
	assert.deepEqual(
		sinceB.rows.map((r) => r.startedAt),
		[c.startedAt, b.startedAt]
	);
});

void test('readJobRuns: a torn last line is counted, not fatal; good rows around it still read', () => {
	const dir = jobRunDir(tempDir('job-run-'));
	mkdirSync(dir, { recursive: true });
	const day = '2026-10-31';
	const good = buildRow({
		job: 'x',
		startedAtMs: Date.parse(`${day}T00:00:00.000Z`),
		durationMs: 1,
		kind: 'gate',
		verdict: 'ok',
		host: 'h',
	});
	writeFileSync(join(dir, `run-${day}.jsonl`), `${JSON.stringify(good)}\n{"v":1,"job":"y"`);
	const read = readJobRuns(dir);
	assert.equal(read.badLines, 1);
	assert.deepEqual(read.rows, [good]);
});

void test('appendJobRun: a write failure (unwritable parent) is reported, never thrown', () => {
	const parent = tempDir('job-run-');
	// A file where a directory is expected: mkdirSync inside appendJobRun fails.
	const blocker = join(parent, 'job-runs');
	writeFileSync(blocker, 'not a directory');
	const row = buildRow({
		job: 'x',
		startedAtMs: 0,
		durationMs: 0,
		kind: 'gate',
		verdict: 'ok',
		host: 'h',
	});
	let res: ReturnType<typeof appendJobRun> | undefined;
	assert.doesNotThrow(() => {
		res = appendJobRun(row, blocker);
	});
	assert.equal(res?.ok, false);
	assert.ok(res?.why);
});

// ---------------------------------------------------------------- retention

void test('pruneJobRunDir: drops day files past retention, keeps everything inside the window', () => {
	const dir = tempDir('job-run-');
	const now = Date.UTC(2026, 9, 31);
	const day = (agoDays: number) => new Date(now - agoDays * DAY_MS).toISOString().slice(0, 10);
	const expired = day(JOB_RUN_RETENTION_DAYS + 5);
	const kept = day(1);
	writeFileSync(join(dir, `run-${expired}.jsonl`), 'x\n');
	writeFileSync(join(dir, `run-${kept}.jsonl`), 'y\n');
	writeFileSync(join(dir, 'notes.txt'), 'not a run file, must be ignored');

	const removed = pruneJobRunDir(dir, now);
	assert.deepEqual(removed, [`run-${expired}.jsonl`]);
	assert.deepEqual(readdirSync(dir).sort(), ['notes.txt', `run-${kept}.jsonl`]);
});

void test('pruneJobRunDir: a file already removed by a racing process is not an error', () => {
	const dir = tempDir('job-run-');
	const now = Date.UTC(2026, 9, 31);
	const expiredDay = new Date(now - (JOB_RUN_RETENTION_DAYS + 1) * DAY_MS)
		.toISOString()
		.slice(0, 10);
	const path = join(dir, `run-${expiredDay}.jsonl`);
	writeFileSync(path, 'x\n');
	// Simulate another process's prune winning the race.
	unlinkSync(path);
	assert.doesNotThrow(() => pruneJobRunDir(dir, now));
	assert.deepEqual(pruneJobRunDir(dir, now), []);
});

void test('pruneJobRunDir: a missing directory is simply nothing to prune', () => {
	assert.deepEqual(pruneJobRunDir(join(tempDir('job-run-'), 'absent'), Date.now()), []);
});

void test('appendJobRun: prunes on its own write, so an expired day file does not survive a fresh append', () => {
	const dir = jobRunDir(tempDir('job-run-'));
	mkdirSync(dir, { recursive: true });
	const now = Date.now();
	const expiredDay = new Date(now - (JOB_RUN_RETENTION_DAYS + 5) * DAY_MS)
		.toISOString()
		.slice(0, 10);
	writeFileSync(join(dir, `run-${expiredDay}.jsonl`), 'x\n');
	const row = buildRow({
		job: 'x',
		startedAtMs: now,
		durationMs: 0,
		kind: 'gate',
		verdict: 'ok',
		host: 'h',
	});
	appendJobRun(row, dir);
	assert.ok(
		!existsSync(join(dir, `run-${expiredDay}.jsonl`)),
		'the expired day file should be gone'
	);
});

// ---------------------------------------------------------------- classifyEmittedDoc

void test('classifyEmittedDoc: a clean GateDoc is ok', () => {
	assert.deepEqual(classifyEmittedDoc({ ok: true, findings: [], unreadable: [] }), {
		verdict: 'ok',
		findings: 0,
		why: null,
	});
});

void test('classifyEmittedDoc: a GateDoc with findings reports the count and a reason', () => {
	const doc = {
		ok: false,
		findings: [{ node: 'claw-3', kind: 'x', reason: 'drained but serving jobs' }],
		unreadable: [],
	};
	assert.deepEqual(classifyEmittedDoc(doc), {
		verdict: 'findings',
		findings: 1,
		why: 'drained but serving jobs',
	});
});

void test('classifyEmittedDoc MUTATION: unreadable OUTRANKS findings — "could not look" never loses to a real finding', () => {
	const doc = {
		ok: false,
		findings: [{ node: 'claw-3', kind: 'x', reason: 'a real finding' }],
		unreadable: [{ node: 'claw-9', why: 'ssh timeout' }],
	};
	const result = classifyEmittedDoc(doc);
	assert.equal(result.verdict, 'could-not-look', 'unreadable must win the verdict');
	assert.equal(
		result.findings,
		1,
		'the findings count is still carried, even though it did not win the verdict'
	);
	assert.equal(result.why, 'ssh timeout');
});

void test('classifyEmittedDoc: a ConvergeDoc counts unconverged + deferred as its findings', () => {
	const doc = {
		ok: false,
		planned: [],
		converged: [],
		deferred: [{ node: 'claw-1', facet: 'throttle', why: 'waiting' }],
		unconverged: [{ node: 'claw-2', facet: 'throttle', why: 'did not converge' }],
		unreadable: [],
		changed: [],
	};
	// unconverged outranks deferred for the `why`: a repair that failed to
	// converge is a stronger signal than one still waiting its defer window.
	assert.deepEqual(classifyEmittedDoc(doc), {
		verdict: 'findings',
		findings: 2,
		why: 'did not converge',
	});
});

void test('classifyEmittedDoc: a RecordDoc with nothing unreadable is ok, carrying no findings concept', () => {
	assert.deepEqual(
		classifyEmittedDoc({ ok: true, recorded: [{ node: 'claw-1', facet: 'disk' }], unreadable: [] }),
		{
			verdict: 'ok',
			findings: null,
			why: null,
		}
	);
});

void test('classifyEmittedDoc: a RecordDoc that could not measure something is could-not-look', () => {
	const doc = {
		ok: false,
		recorded: [],
		unreadable: [{ node: 'claw-5', facet: 'disk', why: 'offline' }],
	};
	assert.deepEqual(classifyEmittedDoc(doc), {
		verdict: 'could-not-look',
		findings: null,
		why: 'offline',
	});
});

void test('classifyEmittedDoc: the json-exit-guard fallback ({ok:false,error}) is error, not could-not-look', () => {
	const doc = {
		ok: false,
		error: 'queue-health exited 1 before writing its --json document: boom',
		exit: 1,
	};
	assert.deepEqual(classifyEmittedDoc(doc), {
		verdict: 'error',
		findings: null,
		why: doc.error,
	});
});

void test('classifyEmittedDoc: a non-object payload is error, never a silent ok', () => {
	assert.equal(classifyEmittedDoc(null).verdict, 'error');
	assert.equal(classifyEmittedDoc('just a string').verdict, 'error');
	assert.equal(classifyEmittedDoc(42).verdict, 'error');
});

void test('classifyEmittedDoc: ok:false with no findings/unreadable/error still reports error, with a stated why', () => {
	const result = classifyEmittedDoc({ ok: false });
	assert.equal(result.verdict, 'error');
	assert.match(result.why ?? '', /ok:false with no findings/);
});

void test('classifyEmittedDoc: an unrecognised shape (no ok, no findings-like array) never invents a finding', () => {
	assert.deepEqual(classifyEmittedDoc({ someOtherField: 1 }), {
		verdict: 'ok',
		findings: null,
		why: null,
	});
});
