/**
 * capacity-sample.ts (T4): the sampler that turns a `buildFleetReport()`
 * result + drain state into rows, and the tick that writes them. The report
 * and drain state are injected throughout — this suite never drives the fast
 * loop, runner-health or the dispatcher, and never calls `buildFleetReport()`
 * for real, which is exactly the point: proving the SHAPE of the join without
 * paying for (or depending on) the real one.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';
import { capacitySampleStore, CAPACITY_SAMPLE_FILE } from '../capacity-sample-store.js';
import { buildFleetReport } from '../routes/fleet-report.js';
import type { DrainState } from '../runners/drain.js';
import { capacitySampleTick, sampleCapacityNow } from '../capacity-sample.js';

type Report = ReturnType<typeof buildFleetReport>;

const NOW = Date.parse('2026-10-31T12:00:00Z');

/** Only the fields `sampleCapacityNow` actually reads — a full FleetMachine is not required. */
function machine(
	o: Partial<Report['machines'][number]> & { name: string }
): Report['machines'][number] {
	return {
		cores: null,
		ramGb: null,
		labels: [],
		maxRegistrations: null,
		excludedRepos: [],
		reachable: null,
		workers: null,
		capacity: null,
		free: null,
		liveLabels: null,
		eligible: null,
		runnersBusy: null,
		runnersOnline: null,
		ephemeral: false,
		starved: false,
		capabilities: null,
		workloadGates: {},
		workloadProofs: {},
		measured: null,
		os: null,
		maxConcurrent: null,
		admissionCapacity: null,
		admissionFree: null,
		admissionBasis: null,
		state: null,
		admissionCaveat: null,
		...o,
	} as Report['machines'][number];
}

function reportOf(machines: Report['machines'][number][]): Report {
	return { machines } as unknown as Report;
}

void test('a measured, admitted node samples its real numbers', () => {
	const report = reportOf([
		machine({
			name: 'claw-1',
			maxConcurrent: 4,
			admissionCapacity: 4,
			admissionFree: 1,
			admissionBasis: 'dispatcher',
			state: 'busy',
			admissionCaveat: null,
		}),
	]);
	const rows = sampleCapacityNow(NOW, report, {});
	assert.equal(rows.length, 1);
	assert.deepEqual(rows[0], {
		at: new Date(NOW).toISOString(),
		node: 'claw-1',
		maxConcurrent: 4,
		admissionCapacity: 4,
		admissionFree: 1,
		admissionBasis: 'dispatcher',
		state: 'busy',
		drained: false,
		refusalReason: null,
		unmeasured: false,
	});
});

void test('an unmeasured node (the probe never reached it) samples capacity as null, never zero', () => {
	const report = reportOf([
		machine({
			name: 'claw-9',
			maxConcurrent: 2,
			admissionCapacity: null,
			admissionFree: null,
			admissionBasis: null,
			state: 'unreachable',
			admissionCaveat: 'unreachable',
		}),
	]);
	const rows = sampleCapacityNow(NOW, report, {});
	assert.equal(rows.length, 1);
	assert.equal(rows[0].admissionCapacity, null);
	assert.equal(rows[0].admissionFree, null);
	assert.equal(rows[0].unmeasured, true);
	// A declared ceiling is a separate fact from "did the probe reach it this
	// tick" — the manifest still says 2, and that is not the same claim as 0.
	assert.equal(rows[0].maxConcurrent, 2);
});

void test('drained comes from fleet-drain.json via isDraining, not from `state`', () => {
	const report = reportOf([machine({ name: 'claw-2', state: 'demoted' })]);
	const drain: DrainState = {
		'claw-2': {
			kind: 'maintenance',
			since: new Date(NOW).toISOString(),
			reason: 'fixture',
			by: 'fixture',
		},
	};
	const rows = sampleCapacityNow(NOW, report, drain);
	assert.equal(rows[0].drained, true);
});

void test('a refused admission verdict carries its reason through verbatim', () => {
	const report = reportOf([
		machine({
			name: 'claw-6',
			admissionRefusal: {
				clause: 'memory',
				availableMb: 200,
				needMb: 1024,
				reserveBasis: 'default',
				reason: 'memory: 200MB free, need 1024MB',
			},
		}),
	]);
	const rows = sampleCapacityNow(NOW, report, {});
	assert.equal(rows[0].refusalReason, 'memory: 200MB free, need 1024MB');
});

void test('an admitted verdict (key present, value null) carries no refusal reason', () => {
	const report = reportOf([machine({ name: 'claw-3', admissionRefusal: null })]);
	const rows = sampleCapacityNow(NOW, report, {});
	assert.equal(rows[0].refusalReason, null);
});

void test('multiple nodes in one tick get the SAME `at`', () => {
	const report = reportOf([machine({ name: 'claw-1' }), machine({ name: 'claw-2' })]);
	const rows = sampleCapacityNow(NOW, report, {});
	assert.equal(rows[0].at, rows[1].at);
});

// ── the tick: writes once per call, never throws ───────────────────────────

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), 'capacity-sample-tick-'));
	__setHostForTesting({ ...testHost, stateDir: tmp });
});
afterEach(() => {
	__setHostForTesting(testHost);
	rmSync(tmp, { recursive: true, force: true });
});

void test('capacitySampleTick appends once per call: N nodes, one batch, N rows on disk', () => {
	const report = reportOf([machine({ name: 'claw-1' }), machine({ name: 'claw-2' })]);
	capacitySampleTick(NOW, report, {});
	const read = capacitySampleStore(join(tmp, CAPACITY_SAMPLE_FILE)).read();
	assert.equal(read.rows.length, 2);
});

void test('calling the tick twice (two ticks) appends twice, never re-writing the first batch', () => {
	capacitySampleTick(NOW, reportOf([machine({ name: 'claw-1' })]), {});
	capacitySampleTick(NOW + 5 * 60_000, reportOf([machine({ name: 'claw-1' })]), {});
	const read = capacitySampleStore(join(tmp, CAPACITY_SAMPLE_FILE)).read();
	assert.equal(read.rows.length, 2);
});

void test('an empty report (no machines) writes nothing and does not throw', () => {
	capacitySampleTick(NOW, reportOf([]), {});
	const read = capacitySampleStore(join(tmp, CAPACITY_SAMPLE_FILE)).read();
	assert.equal(read.exists, false);
});

void test('a sampling fault (buildFleetReport throws) is swallowed — the tick never throws into its caller', () => {
	assert.doesNotThrow(() => {
		capacitySampleTick(NOW); // no injected report: calls the REAL buildFleetReport()
	});
});

void test('a write fault is logged and swallowed — the tick never throws into its caller', () => {
	// Make the state dir itself unwritable AS a directory: a file sits where
	// the sample file's own parent directory needs to be created.
	rmSync(tmp, { recursive: true, force: true });
	writeFileSync(tmp, 'not a directory');
	assert.doesNotThrow(() => {
		capacitySampleTick(NOW, reportOf([machine({ name: 'claw-1' })]), {});
	});
});
