/**
 * job-rollups — the durable daily fold of job-history (refactor plan §7.3 T2).
 *
 * Fixtures are shaped like real job-history rows (JIT and warm runner names as
 * the fleet mints them) and every date is RELATIVE to the real clock: the
 * closed-day rule is "ended SETTLE_HOURS before now", so an absolute date would
 * change which days are due as the calendar moves.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __setHostForTesting } from '../host.js';
import type { JobRecord } from '../job-history-store.js';
import { jsonlRollupStore } from '../job-rollup-store.js';
import {
	FLEET_NODE,
	ROLLUP_RETENTION_DAYS,
	SETTLE_HOURS,
	closableDays,
	rollupDay,
	runnerClass,
	utcDay,
	writeClosedDays,
	type DayRollup,
} from '../job-rollups.js';
import { testHost } from './install-test-host.js';

const NODES = ['claw-1', 'claw-5', 'claw-8', 'hokon'];
const DAY = 86_400_000;
const NOW = Date.now();
/** Midnight UTC, `n` days before today's. */
const midnight = (n: number) => Date.parse(`${utcDay(NOW)}T00:00:00Z`) - n * DAY;

let seq = 0;
function rec(o: Partial<JobRecord> & { at: number }): JobRecord {
	seq++;
	const { at, ...rest } = o;
	return {
		repo: 'WolffM/hadoku-cardtable',
		runId: 38_813_900_000 + seq,
		jobId: 116_694_180_000 + seq,
		name: 'forge-jvm',
		runner: `jit-claw-8-hadoku-cardtabl-j${116_694_180_000 + seq}-r${38_813_900_000 + seq}-1792101627`,
		labels: ['self-hosted', 'hadoku-builder', 'jdk21'],
		startedAt: new Date(at).toISOString(),
		durationSec: 233,
		queueSec: 11,
		dispatchSec: 4,
		assignSec: 7,
		setupSec: 3,
		runSec: 225,
		cleanupSec: 5,
		conclusion: 'success',
		headSha: 'c792fe7662fc45e1f318550d2ade4ade00a0e2a2',
		...rest,
	};
}

let tmp: string;
let warns: string[];
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), 'rollups-'));
	warns = [];
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn: (m: string) => warns.push(m), error() {} },
	});
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	__setHostForTesting(testHost);
});

const meta = { completeSinceMs: midnight(10), nowMs: NOW };

// ── the fold ────────────────────────────────────────────────────────────────

test('percentiles are nearest-rank over exactly the samples present', () => {
	const day = utcDay(midnight(5));
	// durations 1..20: nearest-rank p50 is the 10th value, p95 the 19th.
	const rs = Array.from({ length: 20 }, (_, i) =>
		rec({ at: midnight(5) + i * 60_000, durationSec: i + 1, queueSec: i % 2 ? undefined : i })
	);
	const r = rollupDay(day, rs, NODES, meta);
	const row = r.rows.find((x) => x.node === 'claw-8');
	assert.ok(row);
	assert.deepEqual(row.durationSec, { n: 20, p50: 10, p95: 19 });
	// queueSec only on the even ones (0,2,..,18): ten samples, absent never read as 0.
	assert.deepEqual(row.queueSec, { n: 10, p50: 8, p95: 18 });
});

test('an empty sample is null, never 0s', () => {
	const r = rollupDay(
		utcDay(midnight(5)),
		[
			rec({
				at: midnight(5),
				runner: 'warm-claw-1-hadoku-cardtable',
				dispatchSec: undefined,
				assignSec: undefined,
			}),
		],
		NODES,
		meta
	);
	const row = r.rows.find((x) => x.node === 'claw-1');
	assert.deepEqual(row?.dispatchSec, { n: 0, p50: null, p95: null });
});

test('one row per node AND a fleet row per repo+kind, so a node compares to the same work', () => {
	const t = midnight(5);
	const rs = [
		rec({ at: t, durationSec: 100 }),
		rec({ at: t + 1, durationSec: 300, runner: 'jit-claw-5-hadoku-cardtabl-j1-r1-1792101627' }),
		rec({
			at: t + 2,
			durationSec: 200,
			runner: 'warm-claw-5-hadoku-cardtable',
			conclusion: 'failure',
			failedStep: 'Run tests',
			failedPhase: 'run',
		}),
		// A matrix shard folds into its kind.
		rec({ at: t + 3, name: 'forge-jvm (2)', durationSec: 150 }),
		rec({ at: t + 4, repo: 'WolffM/hadoku_site', name: 'lint', runner: 'hokon' }),
	];
	const r = rollupDay(utcDay(t), rs, NODES, meta);
	const key = (x: { node: string; repo: string; kind: string }) => `${x.node}|${x.repo}|${x.kind}`;
	assert.deepEqual(
		r.rows.map(key),
		[
			'*|WolffM/hadoku_site|lint',
			'hokon|WolffM/hadoku_site|lint',
			'*|WolffM/hadoku-cardtable|forge-jvm',
			'claw-5|WolffM/hadoku-cardtable|forge-jvm',
			'claw-8|WolffM/hadoku-cardtable|forge-jvm',
		].sort((a, b) => {
			const [an, ar, ak] = a.split('|');
			const [bn, br, bk] = b.split('|');
			return ar.localeCompare(br) || ak.localeCompare(bk) || an.localeCompare(bn);
		})
	);
	const fleet = r.rows.find((x) => x.node === FLEET_NODE && x.kind === 'forge-jvm');
	const c5 = r.rows.find((x) => x.node === 'claw-5');
	assert.equal(fleet?.jobs, 4);
	assert.deepEqual(fleet?.conclusions, { success: 3, failure: 1 });
	assert.equal(fleet?.failuresByZone.content, 1, 'a named run: step is the content zone');
	assert.deepEqual(fleet?.durationSec, { n: 4, p50: 150, p95: 300 });
	assert.equal(c5?.jobs, 2);
	assert.equal(c5?.byClass.jit?.jobs, 1);
	assert.equal(c5?.byClass.warm?.jobs, 1);
	assert.equal(fleet?.byClass.jit?.jobs, 3);
	assert.equal(r.records, 5);
});

test('probe records are excluded from every row and counted on the day', () => {
	const t = midnight(5);
	const r = rollupDay(
		utcDay(t),
		[rec({ at: t }), rec({ at: t + 1, probe: 'forced-rerun', conclusion: 'failure' })],
		NODES,
		meta
	);
	assert.equal(r.records, 1);
	assert.equal(r.probesExcluded, 1);
	assert.equal(r.rows.find((x) => x.node === FLEET_NODE)?.jobs, 1);
});

test('runner class: jit, warm, hosted, standing', () => {
	assert.equal(runnerClass('jit-claw-8-x-j1-r1-1', NODES), 'jit');
	assert.equal(runnerClass('warm-claw-1-hadoku_site', NODES), 'warm');
	assert.equal(runnerClass('GitHub Actions 1000001234', NODES), 'hosted');
	assert.equal(runnerClass('hokon', NODES), 'standing');
});

// ── which days are due ──────────────────────────────────────────────────────

test('a day is due only once whole (after completeSince) and settled (SETTLE_HOURS after its end)', () => {
	// Evidence starts mid-day 6 days ago: that day is partial and never due.
	const since = midnight(6) + 5 * 3600_000;
	const due = closableDays(NOW, since);
	assert.equal(due[0], utcDay(midnight(5)), 'the partial first day is skipped');
	const lastEnd = Date.parse(`${due[due.length - 1]}T00:00:00Z`) + DAY;
	assert.ok(lastEnd <= NOW - SETTLE_HOURS * 3600_000, 'the newest due day has settled');
	assert.ok(lastEnd + DAY > NOW - SETTLE_HOURS * 3600_000, 'and the next one has not');
	// Evidence starting exactly at a midnight makes that day whole.
	assert.equal(closableDays(NOW, midnight(5))[0], utcDay(midnight(5)));
});

// ── the writer ──────────────────────────────────────────────────────────────

/** Eight days of history, the first one partial, like a ledger the cap trimmed. */
function eightDays(): JobRecord[] {
	const out: JobRecord[] = [];
	out.push(rec({ at: midnight(8) + 20 * 3600_000 })); // the partial day's tail
	for (let d = 7; d >= 0; d--) {
		for (let i = 0; i < 3; i++) out.push(rec({ at: midnight(d) + (i + 1) * 3600_000 }));
	}
	return out;
}

test('first run BACKFILLS every closed whole day; a second run writes nothing', () => {
	const file = join(tmp, 'job-rollups.jsonl');
	const records = eightDays();
	const since = Date.parse(records[0].startedAt);
	const expected = closableDays(NOW, since);
	assert.ok(expected.length >= 3, 'the fixture must leave several days due');

	const first = writeClosedDays({
		nodes: NODES,
		nowMs: NOW,
		records,
		completeSinceMs: since,
		store: jsonlRollupStore(file),
	});
	assert.deepEqual(first.written, expected);
	assert.ok(!first.written.includes(utcDay(midnight(8))), 'the partial day is never written');
	assert.equal(first.written[0], utcDay(midnight(7)));
	const bytes = readFileSync(file, 'utf8');
	const days = bytes
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as DayRollup);
	assert.deepEqual(
		days.map((d) => d.day),
		expected
	);
	assert.ok(days.every((d) => d.records === 3));

	// Same store: cached set. A NEW store is a restarted mgmt-api.
	assert.deepEqual(
		writeClosedDays({
			nodes: NODES,
			nowMs: NOW,
			records,
			completeSinceMs: since,
			store: jsonlRollupStore(file),
		}).written,
		[]
	);
	assert.equal(readFileSync(file, 'utf8'), bytes, 'idempotent: the file is untouched');
	assert.ok(!existsSync(`${file}.${process.pid}.tmp`), 'the atomic write left no temp file');
});

test('a day later in the week is added without rewriting the days already held', () => {
	const file = join(tmp, 'job-rollups.jsonl');
	const records = eightDays();
	const since = Date.parse(records[0].startedAt);
	const store = jsonlRollupStore(file);
	writeClosedDays({ nodes: NODES, nowMs: NOW - DAY, records, completeSinceMs: since, store });
	const before = store.read().days;
	const r = writeClosedDays({ nodes: NODES, nowMs: NOW, records, completeSinceMs: since, store });
	assert.equal(r.written.length, 1, 'exactly the one newly settled day');
	const after = store.read().days;
	assert.equal(after.length, before.length + 1);
	assert.deepEqual(after.slice(0, before.length), before, 'held days are byte-for-byte the same');
});

test('no node list: refuses loudly rather than writing raw runner names as nodes', () => {
	const file = join(tmp, 'job-rollups.jsonl');
	const records = eightDays();
	const r = writeClosedDays({
		nodes: [],
		nowMs: NOW,
		records,
		completeSinceMs: Date.parse(records[0].startedAt),
		store: jsonlRollupStore(file),
	});
	assert.deepEqual(r.written, []);
	assert.match(r.refused ?? '', /no node list/);
	assert.ok(warns.some((w) => w.includes('no node list')));
	assert.ok(!existsSync(file));
});

test('an empty ledger proves nothing: no day is written as a zero', () => {
	const file = join(tmp, 'job-rollups.jsonl');
	const r = writeClosedDays({
		nodes: NODES,
		nowMs: NOW,
		records: [],
		completeSinceMs: null,
		store: jsonlRollupStore(file),
	});
	assert.deepEqual(r, { written: [] });
	assert.ok(!existsSync(file));
});

test('a quiet day INSIDE the evidence is a real zero, written as records: 0', () => {
	const file = join(tmp, 'job-rollups.jsonl');
	const records = eightDays().filter((r) => !r.startedAt.startsWith(utcDay(midnight(4))));
	writeClosedDays({
		nodes: NODES,
		nowMs: NOW,
		records,
		completeSinceMs: Date.parse(records[0].startedAt),
		store: jsonlRollupStore(file),
	});
	const quiet = jsonlRollupStore(file)
		.read()
		.days.find((d) => d.day === utcDay(midnight(4)));
	assert.equal(quiet?.records, 0);
	assert.deepEqual(quiet?.rows, []);
});

test('a write failure is logged with its reason and never thrown into the tick', () => {
	// The store path's parent is a FILE, so mkdir fails.
	writeFileSync(join(tmp, 'blocker'), '');
	const records = eightDays();
	const r = writeClosedDays({
		nodes: NODES,
		nowMs: NOW,
		records,
		completeSinceMs: Date.parse(records[0].startedAt),
		store: jsonlRollupStore(join(tmp, 'blocker', 'job-rollups.jsonl')),
	});
	assert.deepEqual(r.written, []);
	assert.match(r.refused ?? '', /could not write rollups/);
	assert.ok(warns.some((w) => w.includes('could not write rollups')));
});

// ── the store ───────────────────────────────────────────────────────────────

test('store: an unparseable line is a MISSING day, counted, and rewritten while still in the ledger', () => {
	const file = join(tmp, 'job-rollups.jsonl');
	const records = eightDays();
	const since = Date.parse(records[0].startedAt);
	writeClosedDays({
		nodes: NODES,
		nowMs: NOW,
		records,
		completeSinceMs: since,
		store: jsonlRollupStore(file),
	});
	const lines = readFileSync(file, 'utf8').trim().split('\n');
	const lost = (JSON.parse(lines[1]) as DayRollup).day;
	lines[1] = lines[1].slice(0, 40); // a torn line
	writeFileSync(file, lines.join('\n') + '\n');
	const read = jsonlRollupStore(file).read();
	assert.equal(read.unreadableLines, 1);
	assert.ok(!read.days.some((d) => d.day === lost));
	const r = writeClosedDays({
		nodes: NODES,
		nowMs: NOW,
		records,
		completeSinceMs: since,
		store: jsonlRollupStore(file),
	});
	assert.deepEqual(r.written, [lost]);
	assert.equal(jsonlRollupStore(file).read().unreadableLines, 0);
});

test('store: days older than ROLLUP_RETENTION_DAYS are dropped on the next write, newer kept', () => {
	const file = join(tmp, 'job-rollups.jsonl');
	const store = jsonlRollupStore(file);
	const mk = (day: string): DayRollup => ({
		schema: 1,
		day,
		writtenAt: '',
		completeSince: '',
		records: 0,
		probesExcluded: 0,
		rows: [],
	});
	const old = utcDay(NOW - (ROLLUP_RETENTION_DAYS + 3) * DAY);
	const yearAgo = utcDay(NOW - 365 * DAY);
	store.put([mk(old), mk(yearAgo)], '0000-00-00');
	store.put([mk(utcDay(midnight(5)))], utcDay(NOW - ROLLUP_RETENTION_DAYS * DAY));
	assert.deepEqual(
		store.read().days.map((d) => d.day),
		[yearAgo, utcDay(midnight(5))]
	);
});

test('store: no file is exists:false, not an empty history', () => {
	const read = jsonlRollupStore(join(tmp, 'nope.jsonl')).read();
	assert.deepEqual(read, { days: [], unreadableLines: 0, exists: false });
});
