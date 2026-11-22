import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	__resetJobQueuedLogForTesting,
	appendJobQueued,
	jobQueuedDir,
	readJobQueued,
} from '../runners/job-queued-log.js';

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'job-queued-'));
	__resetJobQueuedLogForTesting();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const T = Date.parse('2026-11-22T14:39:43Z');

test('a missing directory is "nothing recorded yet", not an empty healthy record', () => {
	const r = readJobQueued(T, root);
	assert.equal(r.present, false);
	assert.equal(r.queuedAt.size, 0);
});

test('both HA processes append; the reader keeps the EARLIEST receipt per job', () => {
	appendJobQueued({ jobId: 7, repo: 'WolffM/a', receivedAtMs: T + 2_000 }, root);
	appendJobQueued({ jobId: 7, repo: 'WolffM/a', receivedAtMs: T }, root);
	appendJobQueued({ jobId: 8, repo: 'WolffM/b', receivedAtMs: T + 5_000 }, root);
	const r = readJobQueued(T + 10_000, root);
	assert.equal(r.present, true);
	assert.equal(r.queuedAt.get(7), T);
	assert.equal(r.queuedAt.get(8), T + 5_000);
	assert.equal(r.torn, 0);
});

test('a torn or malformed line is counted and skipped, the rest still read', () => {
	appendJobQueued({ jobId: 7, repo: 'WolffM/a', receivedAtMs: T }, root);
	const file = join(jobQueuedDir(root), 'queued-2026-11-22.jsonl');
	appendFileSync(file, '{"job":8,"repo":"WolffM/b","at":"2026-11-2\n{"job":"9","at":"x"}\n');
	const r = readJobQueued(T, root);
	assert.equal(r.queuedAt.get(7), T);
	assert.equal(r.queuedAt.size, 1);
	assert.equal(r.torn, 2);
});

test('yesterday is read across midnight; older days are pruned on the first append of a day', () => {
	const dir = jobQueuedDir(root);
	appendJobQueued(
		{ jobId: 1, repo: 'WolffM/a', receivedAtMs: Date.parse('2026-11-20T23:00:00Z') },
		root
	);
	appendJobQueued(
		{ jobId: 2, repo: 'WolffM/a', receivedAtMs: Date.parse('2026-11-21T23:59:00Z') },
		root
	);
	writeFileSync(join(dir, 'unrelated.json'), '{}');
	appendJobQueued(
		{ jobId: 3, repo: 'WolffM/a', receivedAtMs: Date.parse('2026-11-22T00:01:00Z') },
		root
	);
	assert.deepEqual(readdirSync(dir).sort(), [
		'queued-2026-11-21.jsonl',
		'queued-2026-11-22.jsonl',
		'unrelated.json',
	]);
	const r = readJobQueued(Date.parse('2026-11-22T00:02:00Z'), root);
	assert.deepEqual([...r.queuedAt.keys()].sort(), [2, 3]);
	assert.ok(existsSync(join(dir, 'unrelated.json')));
});
