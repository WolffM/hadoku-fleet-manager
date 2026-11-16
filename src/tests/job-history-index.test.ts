/**
 * The job-history index (fleet-manager#86) must answer exactly what a scan of
 * the window answers, after ANY sequence of the store's changes. The reference
 * is the scan itself: `idleSecondsFromRecords` for idle seconds, and the body
 * `recentJobsPerDay` had before the index, restated here, for jobs per day.
 *
 * Driven only through the store's own API (append, patch, trim to budget,
 * compact on retention, reset), over records shaped like the fleet's: JIT,
 * warm and bare runner names, GitHub-hosted ones, an unknown runner, and a
 * start that will not parse. More node lists than the index holds at once are
 * asked for, so a dropped list is rebuilt and checked too.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	__resetJobHistoryForTesting,
	__setHistoryPathForTesting,
	__setRecordBudgetForTesting,
	appendRecords,
	compactHistory,
	jobRecords,
	patchRecord,
	recordsStartedBetween,
	trimToBudget,
	type JobRecord,
} from '../job-history-store.js';
import {
	historyRowOf,
	idleSecondsByNode,
	jobsPerDayByRepo,
	lastStartByNode,
} from '../job-history-index.js';
import { jobKind } from '../lib/job-kind.js';
import { nodeOf } from '../runners/census.js';
import { idleSecondsFromRecords } from '../job-history-stats.js';
import { flushWrites } from '../lib/atomic-json.js';

const NOW = Date.now();
const DAY = 86_400_000;
const NODES = ['claw-1', 'claw-2', 'claw-10', 'hokon'];
/**
 * Three lists, fewer than the index holds at once: every ask after the first
 * reads a list the index has been MOVING with the store's changes, which is the
 * path production runs. Asking more lists than it holds would rebuild each one
 * on every ask and test nothing incremental — `CYCLING` does that on purpose.
 */
const RESIDENT = [NODES, ['claw-1', 'claw-2'], ['claw-10', 'hokon']];
/** More lists than the index holds, so each ask may rebuild one it dropped. */
const CYCLING = [
	...RESIDENT,
	['hokon', 'claw-1'],
	['claw-2', 'claw-10', 'hokon'],
	['claw-1', 'claw-10'],
];
const REPOS = ['WolffM/a', 'WolffM/b', 'WolffM/c'];

/** A seeded generator, so a failure names a sequence that can be replayed. */
function rng(seed: number): () => number {
	let x = seed >>> 0 || 1;
	return () => {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		return (x >>> 0) / 2 ** 32;
	};
}

let nextId = 1;
function record(rand: () => number): JobRecord {
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
	const node = pick(NODES);
	const runner = pick([
		node,
		`jit-${node}-hadoku-x-j${nextId}`,
		`warm-${node}-hadoku_site`,
		'GitHub Actions 12',
		'mystery-runner',
	]);
	const ageMs = rand() * 13 * DAY;
	const id = nextId++;
	return {
		repo: pick(REPOS),
		runId: id,
		jobId: id,
		name: 'build',
		runner,
		labels: [],
		startedAt: rand() < 0.02 ? 'not a date' : new Date(NOW - ageMs).toISOString(),
		durationSec: Math.floor(rand() * 3600),
		conclusion: rand() < 0.8 ? 'success' : 'failure',
	};
}

/** `recentJobsPerDay`'s body before the index, kept as the reference. */
function jobsPerDayByScan(
	records: readonly Readonly<JobRecord>[],
	now: number
): Map<string, number> {
	const out = new Map<string, number>();
	if (!records.length) return out;
	let oldest = Infinity;
	for (const r of records) {
		const t = Date.parse(r.startedAt);
		if (Number.isFinite(t)) oldest = Math.min(oldest, t);
	}
	const days = Math.max(1, (now - oldest) / DAY);
	const counts = new Map<string, number>();
	for (const r of records) counts.set(r.repo, (counts.get(r.repo) ?? 0) + 1);
	for (const [repo, n] of counts) out.set(repo, n / days);
	return out;
}

const sorted = (m: Map<string, number>): [string, number][] =>
	[...m].sort((a, b) => a[0].localeCompare(b[0]));

/** Every way the index disagrees with a scan right now, named by `step`. Empty when it agrees. */
function mismatches(step: string, lists: readonly (readonly string[])[]): string[] {
	const out: string[] = [];
	const same = (a: Map<string, number>, b: Map<string, number>): boolean =>
		JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
	for (const nodes of lists) {
		const index = idleSecondsByNode(nodes, NOW);
		const scan = idleSecondsFromRecords([...jobRecords()], nodes, NOW);
		if (!same(index, scan))
			out.push(
				`idle seconds over [${nodes.join(', ')}] after ${step}: ${JSON.stringify(sorted(index))} vs ${JSON.stringify(sorted(scan))}`
			);
	}
	// Every held row equals what a fresh derivation of its record gives now.
	for (const nodes of lists) {
		for (const r of jobRecords()) {
			const row = historyRowOf(r, nodes);
			// HELD, not derived on the spot: a missing row would be re-derived
			// fresh and look right, so identity is what proves it is kept.
			if (row !== historyRowOf(r, nodes))
				out.push(`row of ${r.jobId} over [${nodes.join(', ')}] is not held after ${step}`);
			const start = Date.parse(r.startedAt);
			const want = {
				node: nodeOf(r.runner, nodes),
				kind: jobKind(r.name),
				finished: start + (r.durationSec ?? 0) * 1000,
				day: Math.floor(start / DAY),
			};
			const got = { node: row.node, kind: row.kind, finished: row.finished, day: row.day };
			if (JSON.stringify(got) !== JSON.stringify(want))
				out.push(
					`row of ${r.jobId} over [${nodes.join(', ')}] after ${step}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`
				);
		}
	}
	// Starvation's question, the scan it used to run, per list.
	for (const nodes of lists) {
		const scan = new Map<string, number>();
		for (const r of jobRecords()) {
			const t = Date.parse(r.startedAt);
			if (!Number.isFinite(t)) continue;
			const node = nodeOf(r.runner, nodes);
			if (!scan.has(node) || t > (scan.get(node) as number)) scan.set(node, t);
		}
		if (!same(lastStartByNode(nodes), scan))
			out.push(`last start over [${nodes.join(', ')}] after ${step}`);
	}
	// The window in start order, and a span of it equal to filtering it.
	const window = jobRecords();
	for (let i = 1; i < window.length; i++)
		if (window[i - 1].startedAt > window[i].startedAt) {
			out.push(`window out of start order at ${i} after ${step}`);
			break;
		}
	for (const [fromDays, toDays] of [
		[13, 12],
		[5, 4.5],
		[1, 0],
		[3, -1],
	]) {
		const fromIso = new Date(NOW - fromDays * DAY).toISOString();
		const toIso = new Date(NOW - toDays * DAY).toISOString();
		const want = window.filter((r) => r.startedAt >= fromIso && r.startedAt < toIso);
		const got = recordsStartedBetween(fromIso, toIso);
		if (got.length !== want.length || got.some((r, i) => r !== want[i]))
			out.push(`span ${fromDays}..${toDays} days after ${step}: ${got.length} vs ${want.length}`);
	}
	const index = jobsPerDayByRepo(NOW);
	const scan = jobsPerDayByScan(jobRecords(), NOW);
	if (!same(index, scan))
		out.push(
			`jobs per day after ${step}: ${JSON.stringify(sorted(index))} vs ${JSON.stringify(sorted(scan))}`
		);
	return out;
}

let dir = '';
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'history-index-'));
	__setHistoryPathForTesting(join(dir, 'job-history.jsonl'));
	nextId = 1;
});
afterEach(async () => {
	await flushWrites();
	__resetJobHistoryForTesting();
	__setHistoryPathForTesting(null);
	rmSync(dir, { recursive: true, force: true });
});

test('an empty window: no idle node, no repo', () => {
	assert.deepEqual(sorted(idleSecondsByNode(NODES, NOW)), []);
	assert.deepEqual(sorted(jobsPerDayByRepo(NOW)), []);
});

/** A seeded run of the store's changes, checking the index against a scan after each. */
async function drive(seed: number, lists: readonly (readonly string[])[]): Promise<string[]> {
	const rand = rng(seed);
	const found = mismatches('the first ask', lists);
	for (let step = 0; step < 120; step++) {
		const roll = rand();
		let what: string;
		if (roll < 0.55) {
			const batch = Array.from({ length: 1 + Math.floor(rand() * 20) }, () => record(rand));
			appendRecords(batch);
			what = `append ${batch.length}`;
		} else if (roll < 0.75) {
			const window = jobRecords();
			if (!window.length) continue;
			const r = window[Math.floor(rand() * window.length)];
			// The fields the index reads, moved: a runner, a start, a duration.
			patchRecord(r, {
				runner: record(rand).runner,
				name: rand() < 0.5 ? 'e2e (2)' : r.name,
				durationSec: r.durationSec + 600,
				...(rand() < 0.3 ? { startedAt: new Date(NOW - rand() * 13 * DAY).toISOString() } : {}),
				conclusion: 'failure',
			});
			what = `patch ${r.jobId}`;
		} else if (roll < 0.85) {
			__setRecordBudgetForTesting(Math.max(1, Math.floor(jobRecords().length * 0.8)));
			trimToBudget(NOW);
			__setRecordBudgetForTesting(1_000_000);
			what = 'trim to budget';
		} else if (roll < 0.97) {
			// Retention measured from a later "now", so a slice of the window ages out.
			await compactHistory(NOW + rand() * 3 * DAY);
			what = 'compact';
		} else {
			await flushWrites();
			__resetJobHistoryForTesting();
			what = 'reset';
		}
		found.push(...mismatches(`step ${step} (${what})`, lists));
	}
	return found;
}

for (const seed of [1, 7, 42, 1234, 99991]) {
	test(`the index equals a scan after every change, lists held throughout (seed ${seed})`, async () => {
		assert.deepEqual(await drive(seed, RESIDENT), []);
	});
}

test('the index equals a scan when more lists are asked than it holds (each may be rebuilt)', async () => {
	assert.deepEqual(await drive(3, CYCLING), []);
});

test('a patch to a record that has left the window changes nothing and says so', async () => {
	const rand = rng(5);
	appendRecords(Array.from({ length: 30 }, () => record(rand)));
	const gone = [...jobRecords()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
	__setRecordBudgetForTesting(29);
	trimToBudget(NOW);
	assert.equal(patchRecord(gone, { runner: 'claw-1' }), false);
	assert.deepEqual(mismatches('a patch to an evicted record', RESIDENT), []);
	await flushWrites();
});
