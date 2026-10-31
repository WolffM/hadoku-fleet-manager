/**
 * gh-budget-history-store (T5): the JSONL store alone. See `gh-budget.test.ts`
 * for the `closeWindow` hook that calls `append` with a real `BudgetWindow`.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	GH_BUDGET_HISTORY_RETENTION_DAYS,
	ghBudgetHistoryStore,
	type GhBudgetHistoryRow,
} from '../gh-budget-history-store.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-31T12:00:00Z');

function row(
	windowEndMs: number,
	token = 'HADOKU_SITE_TOKEN (sha256:aaaaaaaa)'
): GhBudgetHistoryRow {
	return {
		windowEnd: new Date(windowEndMs).toISOString(),
		token,
		resource: 'core',
		limit: 5000,
		usedAtEnd: 1200,
		remainingAtEnd: 3800,
		byCaller: [{ caller: 'cron:ci:queue-health', charged: 12, notModified: 3 }],
		restarts: 0,
	};
}

let tmp: string;
let path: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), 'gh-budget-history-'));
	path = join(tmp, 'gh-budget-history.jsonl');
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

void test('no file yet: exists is false and read is empty', () => {
	const store = ghBudgetHistoryStore(path);
	const read = store.read();
	assert.equal(read.exists, false);
	assert.deepEqual(read.rows, []);
});

void test('append then read: one row per ended window, byCaller intact', () => {
	const store = ghBudgetHistoryStore(path);
	store.append([row(NOW)], NOW);
	const read = store.read();
	assert.equal(read.rows.length, 1);
	assert.equal(read.rows[0].limit, 5000);
	assert.deepEqual(read.rows[0].byCaller, [
		{ caller: 'cron:ci:queue-health', charged: 12, notModified: 3 },
	]);
});

void test('one append call per window end: calling append twice for the SAME window writes two rows, never one merged', () => {
	// This store does not dedupe by (token, resource, windowEnd) — that
	// decision belongs to the caller, which only ever calls it once per
	// `closeWindow` (see gh-budget.test.ts). Pinning the store's own
	// behaviour here keeps that contract explicit.
	const store = ghBudgetHistoryStore(path);
	store.append([row(NOW)], NOW);
	store.append([row(NOW)], NOW);
	assert.equal(store.read().rows.length, 2);
});

void test('retention trims rows older than 90 days, and only those', () => {
	const store = ghBudgetHistoryStore(path);
	const old = NOW - (GH_BUDGET_HISTORY_RETENTION_DAYS + 1) * DAY;
	store.append([row(old)], old);
	store.append([row(NOW)], NOW);
	assert.equal(store.read().rows.length, 1);
	assert.equal(store.read().rows[0].windowEnd, new Date(NOW).toISOString());
});

void test('retention never trims a row still inside the 90-day window', () => {
	const store = ghBudgetHistoryStore(path);
	const justInside = NOW - (GH_BUDGET_HISTORY_RETENTION_DAYS * DAY - 60_000);
	store.append([row(justInside)], justInside);
	store.append([row(NOW)], NOW);
	assert.equal(store.read().rows.length, 2);
});

void test('a corrupt line is counted, not thrown, and does not hide the good rows', () => {
	writeFileSync(path, `${JSON.stringify(row(NOW))}\n{broken\n{"limit":5000}\n`);
	const store = ghBudgetHistoryStore(path);
	const read = store.read();
	assert.equal(read.rows.length, 1);
	assert.equal(read.unreadableLines, 2);
});

void test('a failed write throws from append — the caller (gh-budget.ts) decides, this store never swallows it', () => {
	const blocker = join(tmp, 'blocked');
	writeFileSync(blocker, 'not a directory');
	const badPath = join(blocker, 'nested', 'gh-budget-history.jsonl');
	const store = ghBudgetHistoryStore(badPath);
	assert.throws(() => store.append([row(NOW)], NOW));
});

void test('read of a genuinely unreadable file (a directory, not a file) throws rather than reading as empty', () => {
	const dirPath = join(tmp, 'gh-budget-history.jsonl');
	mkdirSync(dirPath);
	const store = ghBudgetHistoryStore(dirPath);
	assert.throws(() => store.read());
});
