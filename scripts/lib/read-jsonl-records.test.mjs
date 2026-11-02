/**
 * `readJsonlRecords` — wave shrink-1 lane A dedup. Pulled byte-for-byte out
 * of `collect-job-metrics.mjs` and `join-workload-benchmark.mjs`, which both
 * read `job-history.jsonl` into memory the same way. Neither script's own
 * test file exercised this read at all before this move — both stub the
 * state dir such that the file never exists, so only the empty-file path
 * ran implicitly, and never the parse-one-line-at-a-time behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readJsonlRecords } from './read-jsonl-records.mjs';

function withTmp(fn) {
	const dir = mkdtempSync(join(tmpdir(), 'read-jsonl-'));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('a missing file reads as an empty array, never a thrown error', () => {
	withTmp((dir) => {
		assert.deepEqual(readJsonlRecords(join(dir, 'nope.jsonl')), []);
	});
});

test('each line is parsed independently, in order', () => {
	withTmp((dir) => {
		const file = join(dir, 'h.jsonl');
		writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":3}\n');
		assert.deepEqual(readJsonlRecords(file), [{ a: 1 }, { a: 2 }, { a: 3 }]);
	});
});

test('blank lines are skipped without costing a record', () => {
	withTmp((dir) => {
		const file = join(dir, 'h.jsonl');
		writeFileSync(file, '{"a":1}\n\n   \n{"a":2}\n');
		assert.deepEqual(readJsonlRecords(file), [{ a: 1 }, { a: 2 }]);
	});
});

test('a truncated final line costs exactly that one record, by design of the writer', () => {
	withTmp((dir) => {
		const file = join(dir, 'h.jsonl');
		writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":3,"trunc', 'utf8');
		assert.deepEqual(readJsonlRecords(file), [{ a: 1 }, { a: 2 }]);
	});
});

test('a malformed line in the middle costs only itself — lines after it still parse', () => {
	withTmp((dir) => {
		const file = join(dir, 'h.jsonl');
		writeFileSync(file, '{"a":1}\nnot json at all\n{"a":3}\n');
		assert.deepEqual(readJsonlRecords(file), [{ a: 1 }, { a: 3 }]);
	});
});
