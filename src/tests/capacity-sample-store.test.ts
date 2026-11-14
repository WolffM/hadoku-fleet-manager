/**
 * capacity-sample-store (T4): the JSONL store alone, no host and no fleet
 * report — see `capacity-sample.test.ts` for the sampler that reads
 * `buildFleetReport()`/`isDraining()` into rows this store holds.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	CAPACITY_SAMPLE_RETENTION_DAYS,
	COMPACT_STALE_FRACTION,
	capacitySampleStore,
	type CapacitySampleRow,
} from '../capacity-sample-store.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-31T12:00:00Z');

function row(at: number, node = 'claw-1'): CapacitySampleRow {
	return {
		at: new Date(at).toISOString(),
		node,
		maxConcurrent: 4,
		admissionCapacity: 4,
		admissionFree: 2,
		admissionBasis: 'dispatcher',
		state: 'busy',
		drained: false,
		refusalReason: null,
		unmeasured: false,
	};
}

let tmp: string;
let path: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), 'capacity-sample-'));
	path = join(tmp, 'capacity-samples.jsonl');
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

void test('no file yet: exists is false and read is empty', () => {
	const store = capacitySampleStore(path);
	const read = store.read();
	assert.equal(read.exists, false);
	assert.deepEqual(read.rows, []);
	assert.equal(read.unreadableLines, 0);
});

void test('append then read: the row round-trips exactly', () => {
	const store = capacitySampleStore(path);
	store.append([row(NOW, 'claw-1'), row(NOW, 'hokon')], NOW);
	const read = store.read();
	assert.equal(read.exists, true);
	assert.equal(read.rows.length, 2);
	assert.deepEqual(read.rows.map((r) => r.node).sort(), ['claw-1', 'hokon']);
	assert.equal(read.rows[0].maxConcurrent, 4);
	assert.equal(read.rows[0].drained, false);
});

void test('two ticks: both batches are held, nothing silently overwritten', () => {
	const store = capacitySampleStore(path);
	store.append([row(NOW - 5 * 60_000)], NOW - 5 * 60_000);
	store.append([row(NOW)], NOW);
	const read = store.read();
	assert.equal(read.rows.length, 2);
});

void test('retention trims rows older than the window, and ONLY those', () => {
	const store = capacitySampleStore(path);
	const old = NOW - (CAPACITY_SAMPLE_RETENTION_DAYS + 1) * DAY;
	const recent = NOW - (CAPACITY_SAMPLE_RETENTION_DAYS - 1) * DAY;
	store.append([row(old, 'claw-old')], old);
	// A later append carries `nowMs` forward, which is what prunes the first
	// row — a real sampler ticks every 5 minutes and will cross this boundary
	// on some later call, never on the write that is itself still in-window.
	store.append([row(recent, 'claw-recent')], NOW);
	const read = store.read();
	assert.deepEqual(
		read.rows.map((r) => r.node),
		['claw-recent']
	);
});

void test('retention never trims a row still inside the window', () => {
	const store = capacitySampleStore(path);
	const justInside = NOW - (CAPACITY_SAMPLE_RETENTION_DAYS * DAY - 60_000);
	store.append([row(justInside, 'claw-edge')], justInside);
	store.append([row(NOW, 'claw-now')], NOW);
	const read = store.read();
	assert.deepEqual(read.rows.map((r) => r.node).sort(), ['claw-edge', 'claw-now']);
});

void test('a corrupt line is counted, not thrown, and does not hide the good rows', () => {
	writeFileSync(path, `${JSON.stringify(row(NOW))}\nnot json\n{"missing":"fields"}\n`);
	const store = capacitySampleStore(path);
	const read = store.read();
	assert.equal(read.rows.length, 1);
	assert.equal(read.unreadableLines, 2);
});

void test('a tick with nothing stale appends in place: the file grows, it is never rewritten', () => {
	// fleet-manager#86: the whole-file rewrite on every tick was a 205 ms stretch
	// on the leader at 38,000 rows.
	const store = capacitySampleStore(path);
	store.append([row(NOW)], NOW);
	const before = readFileSync(path, 'utf8');
	const ino = statSync(path).ino;
	store.append([row(NOW + 60_000)], NOW + 60_000);
	const after = readFileSync(path, 'utf8');
	assert.equal(statSync(path).ino, ino, 'same file: appended, not replaced');
	assert.ok(after.startsWith(before), 'the first row survives the second append');
	assert.equal(store.read().rows.length, 2);
});

/** `n` in-window rows and `old` rows past retention, written as another writer would. */
function seedFile(n: number, old: number): void {
	const rows = [
		...Array.from({ length: old }, (_, i) =>
			row(NOW - (CAPACITY_SAMPLE_RETENTION_DAYS + 1) * DAY + i, 'claw-old')
		),
		...Array.from({ length: n }, (_, i) => row(NOW - DAY + i * 1000)),
	];
	writeFileSync(path, rows.map((r) => JSON.stringify(r) + '\n').join(''));
}

void test('stale rows under the compaction share are left on disk; the tick appends', () => {
	seedFile(100, 5);
	const ino = statSync(path).ino;
	capacitySampleStore(path).append([row(NOW)], NOW);
	assert.equal(statSync(path).ino, ino);
	assert.equal(capacitySampleStore(path).read().rows.length, 106);
});

void test('once stale rows reach the compaction share, the tick rewrites without them', () => {
	seedFile(100, 11);
	const ino = statSync(path).ino;
	capacitySampleStore(path).append([row(NOW)], NOW);
	assert.notEqual(statSync(path).ino, ino, 'rewritten atomically, through a temp file');
	const read = capacitySampleStore(path).read();
	assert.equal(read.rows.length, 101);
	assert.ok(!read.rows.some((r) => r.node === 'claw-old'));
	assert.ok(11 >= 101 * COMPACT_STALE_FRACTION, 'the fixture is over the line it claims to be');
});

void test('a torn last line costs only itself: the next append starts on a fresh line', () => {
	// 30 good rows keep one torn line under the compaction share, so this is
	// the APPEND path: a compaction would drop the torn line and prove nothing.
	seedFile(30, 0);
	writeFileSync(path, readFileSync(path, 'utf8') + '{"at":"2026-10-31T11:5');
	const ino = statSync(path).ino;
	capacitySampleStore(path).append([row(NOW, 'hokon')], NOW);
	assert.equal(statSync(path).ino, ino, 'appended, not compacted');
	const read = capacitySampleStore(path).read();
	assert.equal(read.rows.length, 31);
	assert.equal(read.rows.at(-1)?.node, 'hokon', 'the new row parsed: it did not join the torn one');
	assert.equal(read.unreadableLines, 1);
});

void test('a file another writer changed is re-read before deciding, not judged by our own count', () => {
	const store = capacitySampleStore(path);
	store.append([row(NOW - 60_000)], NOW - 60_000);
	// A standby that took leadership wrote the file meanwhile, with stale rows
	// this process never saw. Our own tally says nothing is stale.
	seedFile(100, 20);
	store.append([row(NOW)], NOW);
	assert.ok(
		!store.read().rows.some((r) => r.node === 'claw-old'),
		'the stale rows another writer left are compacted on this tick'
	);
});

void test('a failed write throws from append — the caller decides, this store never swallows it', () => {
	// Point the state dir's PARENT at an existing FILE, not a directory, so
	// `mkdirSync(dirname(path), { recursive: true })` inside writeFileAtomic
	// fails with ENOTDIR — a real, hermetic write failure, no mock.
	const blocker = join(tmp, 'blocked');
	writeFileSync(blocker, 'not a directory');
	const badPath = join(blocker, 'nested', 'capacity-samples.jsonl');
	const store = capacitySampleStore(badPath);
	assert.throws(() => store.append([row(NOW)], NOW));
});

void test('read of a genuinely unreadable file (a directory, not a file) throws rather than reading as empty', () => {
	const dirPath = join(tmp, 'capacity-samples.jsonl');
	mkdirSync(dirPath);
	const store = capacitySampleStore(dirPath);
	assert.throws(() => store.read());
});
