/**
 * job-rollups-fleet.ts: the class rule, the waits bucket, and the pure day
 * aggregate builder. No disk, no clock — every input is a fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { JobRecord } from '../job-history-store.js';
import type { DecisionRecord } from '../runners/decision-log-types.js';
import type { CapacitySampleRow } from '../capacity-sample-store.js';
import {
	buildFleetDayAggregate,
	classifyJob,
	repoShortName,
	waitBucket,
} from '../job-rollups-fleet.js';

const NODES = ['claw-1', 'claw-5', 'hokon'];

let seq = 0;
function rec(o: Partial<JobRecord> = {}): JobRecord {
	seq++;
	return {
		repo: 'WolffM/hadoku-cardtable',
		runId: 1000 + seq,
		jobId: 2000 + seq,
		name: 'forge-jvm',
		runner: 'claw-1',
		labels: ['self-hosted', 'hadoku-builder'],
		startedAt: new Date(Date.parse('2026-11-05T00:00:00Z') + seq * 1000).toISOString(),
		durationSec: 100,
		queueSec: 10,
		conclusion: 'success',
		...o,
	};
}

function decision(o: Partial<DecisionRecord> = {}): DecisionRecord {
	return {
		v: 1,
		at: '2026-11-05T01:00:00.000Z',
		path: 'jit',
		kind: 'unplaceable',
		repo: 'WolffM/hadoku-cardtable',
		runId: 1,
		jobId: 1,
		jobName: 'forge-jvm',
		labels: [],
		event: null,
		queuedSec: null,
		heavy: null,
		order: [],
		candidates: [],
		refused: [],
		winner: null,
		rule: null,
		outcome: null,
		runner: null,
		error: null,
		reason: null,
		action: null,
		capacity: [],
		fingerprint: null,
		...o,
	};
}

function sample(o: Partial<CapacitySampleRow> & { node: string }): CapacitySampleRow {
	return {
		at: '2026-11-05T01:00:00.000Z',
		maxConcurrent: 1,
		admissionCapacity: 1,
		admissionFree: 0,
		admissionBasis: 'dispatcher',
		state: 'busy',
		drained: false,
		refusalReason: null,
		unmeasured: false,
		...o,
	};
}

// ── repoShortName / classifyJob ─────────────────────────────────────────────

void test('repoShortName strips the owner', () => {
	assert.equal(repoShortName('WolffM/hadoku-cardtable'), 'hadoku-cardtable');
	assert.equal(repoShortName('bare-name'), 'bare-name');
});

void test('classifyJob: jdk21 label wins regardless of repo share', () => {
	const repoCounts = new Map([['WolffM/tiny', 1]]);
	assert.equal(classifyJob(['jdk21'], 'WolffM/tiny', repoCounts, 100), 'jdk21');
});

void test('classifyJob: a repo at or above 10% of the day earns its own class', () => {
	const repoCounts = new Map([['WolffM/hadoku-cardtable', 10]]);
	assert.equal(classifyJob([], 'WolffM/hadoku-cardtable', repoCounts, 100), 'hadoku-cardtable');
});

void test('classifyJob: under 10% falls to other', () => {
	const repoCounts = new Map([['WolffM/hadoku-cardtable', 9]]);
	assert.equal(classifyJob([], 'WolffM/hadoku-cardtable', repoCounts, 100), 'other');
});

void test('classifyJob: zero jobs in the day never divides by zero', () => {
	assert.equal(classifyJob([], 'WolffM/x', new Map(), 0), 'other');
});

// ── waitBucket ───────────────────────────────────────────────────────────────

void test('waitBucket: capacity beats everything else present on the same row', () => {
	assert.equal(waitBucket(['at capacity: 1/1 in flight', 'drained: maintenance']), 'capacity');
	assert.equal(waitBucket(['memory: 200MB free, need 1024MB']), 'capacity');
});

void test('waitBucket: held — slow tier/kind, reserved, drained, heavy hold', () => {
	assert.equal(waitBucket(['slow tier: queued 10s < 60s']), 'held');
	assert.equal(waitBucket(['reserved for hadoku-cardtable']), 'held');
	assert.equal(waitBucket(['drained: held out of service for maintenance']), 'held');
	assert.equal(waitBucket(['heavy hold: one heavy job already running']), 'held');
});

void test('waitBucket: constraints — exclusion, placement floor, label', () => {
	assert.equal(waitBucket(['repo excluded here: policy']), 'constraints');
	assert.equal(waitBucket(['placement: this repo’s known floor is 6000MB']), 'constraints');
	assert.equal(waitBucket(['does not carry hadoku-builder']), 'constraints');
});

void test('waitBucket: an unrecognised shape is other, never silently dropped', () => {
	assert.equal(waitBucket(['something nothing here has seen']), 'other');
	assert.equal(waitBucket([]), 'other');
});

// ── buildFleetDayAggregate ───────────────────────────────────────────────────

void test('jobs/runnerHours/cancelled/failures fold the organic records', () => {
	const records = [
		rec({ runner: 'claw-1', durationSec: 3600, conclusion: 'success' }),
		rec({ runner: 'claw-1', durationSec: 1800, conclusion: 'failure', failedStep: 'Tests' }),
		rec({ runner: 'claw-5', durationSec: 60, conclusion: 'cancelled' }),
		rec({
			runner: 'claw-5',
			durationSec: 30,
			conclusion: 'failure',
			failedStep: 'Set up runner',
		}),
	];
	const agg = buildFleetDayAggregate(records, NODES);
	assert.equal(agg.jobs, 4);
	assert.equal(agg.runnerHours, (3600 + 1800 + 60 + 30) / 3600);
	assert.equal(agg.cancelled, 1);
	// content (Tests) -> code; runner-zone (Set up runner) -> fleet.
	assert.deepEqual(agg.failures, { code: 1, setup: 0, fleet: 1 });
});

void test('queue.all and queue.byClass: jdk21, a 10%+ repo, and other', () => {
	const records = [
		// 1 jdk21 job (jdk21 wins over its own repo's share, always).
		rec({ labels: ['jdk21'], queueSec: 500 }),
		// 2 more jobs from the SAME repo (hadoku-cardtable), none jdk21 — 3 of
		// 13 total (23%) clears the 10% floor on its own repo share.
		rec({ queueSec: 20 }),
		rec({ queueSec: 30 }),
		// 10 jobs from small repos, each 1 of 13 (7.7%) — under 10% -> other.
		...Array.from({ length: 10 }, (_, i) => rec({ repo: `WolffM/tiny-${i}`, queueSec: 5 + i })),
	];
	const agg = buildFleetDayAggregate(records, NODES);
	assert.equal(agg.jobs, 13);
	assert.equal(agg.queue.all.n, 13);
	assert.ok(agg.queue.byClass.jdk21);
	assert.equal(agg.queue.byClass.jdk21.n, 1);
	assert.equal(agg.queue.byClass.jdk21.p50, 500);
	assert.ok(agg.queue.byClass['hadoku-cardtable']);
	assert.equal(agg.queue.byClass['hadoku-cardtable'].n, 2);
	assert.ok(agg.queue.byClass.other);
	assert.equal(agg.queue.byClass.other.n, 10);
});

void test('an empty day: n 0, every percentile null, never 0s', () => {
	const agg = buildFleetDayAggregate([], NODES);
	assert.equal(agg.jobs, 0);
	assert.deepEqual(agg.queue.all, { n: 0, p50: null, p80: null, p95: null });
	assert.deepEqual(agg.queue.byClass, {});
	assert.deepEqual(agg.nodes, []);
});

void test('runnerHours prefers runSec (the run phase alone) over durationSec (total wall time) when both are present', () => {
	// Cross-checked 2026-11-08 against the tracker's own `jobs_daily.json`
	// (docs/handoff/snapshot): durationSec overran the tracker's `runner_hours`
	// by 4-12% on every one of 3 live days; runSec matched it exactly.
	const records = [
		rec({ runner: 'claw-1', durationSec: 3600, runSec: 3000 }),
		rec({ runner: 'claw-1', durationSec: 120, runSec: undefined }), // falls back to durationSec
	];
	const agg = buildFleetDayAggregate(records, NODES);
	assert.equal(agg.runnerHours, (3000 + 120) / 3600);
	const claw1 = agg.nodes.find((n) => n.node === 'claw-1');
	assert.equal(claw1?.runnerHours, (3000 + 120) / 3600);
});

void test('nodes: per-node jobs/runnerHours/failRate — cancelled does not count as a failure', () => {
	const records = [
		rec({ runner: 'claw-1', durationSec: 3600, conclusion: 'success' }),
		rec({ runner: 'claw-1', durationSec: 3600, conclusion: 'failure' }),
		rec({ runner: 'claw-1', durationSec: 60, conclusion: 'cancelled' }),
	];
	const agg = buildFleetDayAggregate(records, NODES);
	const claw1 = agg.nodes.find((n) => n.node === 'claw-1');
	assert.ok(claw1);
	assert.equal(claw1.jobs, 3);
	assert.equal(claw1.failRate, 1 / 3);
});

void test('waits and availability are null when the caller never looked (no inputs)', () => {
	const agg = buildFleetDayAggregate([rec({})], NODES);
	assert.equal(agg.waits, null);
	assert.equal(agg.availability, null);
	assert.equal(agg.nodes[0].fullShare, null);
	assert.equal(agg.nodes[0].unavailableShare, null);
});

void test('waits: an EMPTY decisions array (the caller looked and found none) is a real zero', () => {
	const agg = buildFleetDayAggregate([rec({})], NODES, { decisions: [] });
	assert.deepEqual(agg.waits, { capacity: 0, constraints: 0, held: 0, other: 0 });
});

void test('waits: buckets a mix of unplaceable/held rows by their refused reasons', () => {
	const decisions: DecisionRecord[] = [
		decision({
			kind: 'unplaceable',
			refused: [{ node: 'claw-1', reason: 'at capacity: 1/1 in flight' }],
		}),
		decision({ kind: 'held', refused: [{ node: 'claw-5', reason: 'drained: maintenance' }] }),
		decision({
			kind: 'unplaceable',
			refused: [{ node: 'hokon', reason: 'does not carry hadoku-builder' }],
		}),
		decision({ kind: 'unplaceable', refused: [{ node: 'claw-1', reason: 'unmatched shape' }] }),
		// A non-wait kind must not be counted at all.
		decision({ kind: 'placed', refused: [] }),
	];
	const agg = buildFleetDayAggregate([rec({})], NODES, { decisions });
	assert.deepEqual(agg.waits, { capacity: 1, constraints: 1, held: 1, other: 1 });
});

void test('availability: null nodes/fullShare when the capacity-sample input is null', () => {
	const agg = buildFleetDayAggregate([rec({ runner: 'claw-1' })], NODES, { capacitySamples: null });
	assert.equal(agg.availability, null);
	assert.equal(agg.nodes[0].fullShare, null);
});

void test('availability: an EMPTY capacity-sample array is still null — zero samples is "could not look", never zero claws', () => {
	const agg = buildFleetDayAggregate([rec({ runner: 'claw-1' })], NODES, { capacitySamples: [] });
	assert.equal(agg.availability, null);
	assert.equal(agg.nodes[0].fullShare, null);
	assert.equal(agg.nodes[0].unavailableShare, null);
});

void test('availability: the fleet-wide SHARE of samples available (0..1); demoted counts as available, offline does not', () => {
	const samples: CapacitySampleRow[] = [
		sample({ node: 'claw-1', at: 't1', state: 'busy' }),
		sample({ node: 'claw-5', at: 't1', state: 'demoted' }),
		sample({ node: 'hokon', at: 't1', state: 'offline' }),
		// Second tick: only two nodes sampled, both available.
		sample({ node: 'claw-1', at: 't2', state: 'free' }),
		sample({ node: 'claw-5', at: 't2', state: 'free' }),
	];
	const agg = buildFleetDayAggregate([rec({ runner: 'claw-1' })], NODES, {
		capacitySamples: samples,
	});
	assert.ok(agg.availability);
	// 4 of 5 samples available (every one except the offline hokon row).
	assert.equal(agg.availability!.claws, 4 / 5);
});

void test('fullShare: the refusal-reason share of a node’s own samples; unavailableShare from drained/state', () => {
	const samples: CapacitySampleRow[] = [
		sample({ node: 'claw-1', refusalReason: 'at capacity: 1/1 in flight' }),
		sample({ node: 'claw-1', refusalReason: null }),
		sample({ node: 'claw-1', drained: true, state: 'demoted' }),
		sample({ node: 'claw-1', state: 'offline' }),
	];
	const agg = buildFleetDayAggregate([rec({ runner: 'claw-1' })], NODES, {
		capacitySamples: samples,
	});
	const claw1 = agg.nodes.find((n) => n.node === 'claw-1');
	assert.ok(claw1);
	assert.equal(claw1.fullShare, 1 / 4);
	// drained (regardless of state) + the offline row = 2/4.
	assert.equal(claw1.unavailableShare, 2 / 4);
});
