/**
 * `summarise()`'s own arithmetic: per-node counts/medians/failures, the
 * backstop signal (pm2-host work on hokon is excluded; builder work on
 * hokon is the "had to step in" signal; instance runners aggregate),
 * `failuresByZone` (whose half of the fence — runner/seam/content/fleet/
 * cancelled, and the five buckets must sum to `failures`), and the
 * per-repo (`byRepo`) and over-time (`daily`) halves of `GET /fleet`. Split
 * out of job-history.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/job-history-rig.ts` for the shared `job`/`seed` fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { JobRecord } from '../job-history-store.js';
import { RETENTION_DAYS } from '../job-history-store.js';
import { summarise } from '../job-history-stats.js';
import { job, seed, at, T0, installJobHistoryRig } from './helpers/job-history-rig.js';

installJobHistoryRig();

const NODES = ['claw-1', 'claw-2', 'claw-3', 'hokon'];

// ── the summary ─────────────────────────────────────────────────────────────

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
 * RELATIVE CLOCK, via `T0`. These records cross `RETENTION_DAYS` the moment
 * they are pinned to a date, and this suite has already gone red twice on
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
