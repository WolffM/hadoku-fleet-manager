/**
 * The Fleet panel's inventory and history fields: `capabilities` (the
 * bootcamp record, null where bootcamp never ran), `measured` (trimmed to
 * the hardware/OS fields onboarding actually measured), `vocabulary.
 * capabilities` (every surface plus the bootcamp staleness line),
 * `workloadProofs` (the current canary per gated capability), and
 * `jobs.daily` (each day's dispatch counts, null before the history began).
 * Split out of fleet-report.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/fleet-report-rig.ts` for the shared `NO_JOBS`/`MANIFEST`
 * fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFleetReport } from '../routes/fleet.js';
import type { JobHistorySummary } from '../job-history-stats.js';
import { NO_JOBS, MANIFEST, installFleetReportRig } from './helpers/fleet-report-rig.js';

installFleetReportRig();

// --- the Fleet panel's inventory and history fields --------------------------

test('fleet report: capabilities is the bootcamp record, and NULL — never {} — where bootcamp never ran', () => {
	const facet = {
		at: '2026-10-06T00:00:00Z',
		by: 'bootcamp',
		earned: ['jdk21'],
		prereqs: [{ id: 'gh', detail: 'gh 2.101.0' }],
	};
	const r = buildFleetReport(
		null,
		null,
		{ ...MANIFEST, 'claw-1': { ...MANIFEST['claw-1'], $capabilities: facet } },
		NO_JOBS
	);
	assert.deepEqual(r.machines.find((m) => m.name === 'claw-1')!.capabilities, facet);
	assert.equal(r.machines.find((m) => m.name === 'hokon')!.capabilities, null);
});

test('fleet report: measured is trimmed to the hardware/OS fields, and null where onboarding never measured', () => {
	const r = buildFleetReport(
		null,
		null,
		{
			...MANIFEST,
			'claw-1': {
				...MANIFEST['claw-1'],
				$measured: {
					at: 'x',
					memTotalMb: 15000,
					kernel: '6.12',
					sshPort: 22,
					verified: true,
					diskFreeGb: 'oops',
				},
			},
		},
		NO_JOBS
	);
	assert.deepEqual(r.machines.find((m) => m.name === 'claw-1')!.measured, {
		at: 'x',
		memTotalMb: 15000,
		diskFreeGb: null,
		diskModel: null,
		kernel: '6.12',
		osCodename: null,
		verified: true,
	});
	assert.equal(r.machines.find((m) => m.name === 'hokon')!.measured, null);
});

test('fleet report: vocabulary.capabilities covers EVERY surface, and carries the bootcamp staleness line', () => {
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	const caps = r.vocabulary.capabilities;
	for (const id of ['hadoku-builder', 'jitconfig', 'python-venv', 'cuda', 'cargo-bevy', 'ffmpeg']) {
		assert.ok(caps[id], `${id} has no description on the wire`);
	}
	assert.equal(caps.jitconfig.surface, 'implicit');
	assert.equal(caps.ffmpeg.surface, 'toolchain');
	assert.equal(caps.jdk21.workloadGated, true);
	assert.equal(caps.ffmpeg.workloadGated, false);
	assert.equal(r.vocabulary.bootcampStaleDays, 30);
	assert.equal(caps.jdk21.label, 'Java 21 + Maven');
	for (const [id, c] of Object.entries(caps)) {
		assert.ok(c.label.split(/\s+/).length <= 6, `${id}'s label is prose, not a label: ${c.label}`);
	}
	const z = r.vocabulary.failureZones;
	assert.deepEqual(Object.keys(z).sort(), ['cancelled', 'content', 'fleet', 'runner', 'seam']);
	assert.deepEqual(
		['runner', 'seam', 'fleet', 'content', 'cancelled'].map((k) => z[k as keyof typeof z].group),
		['box', 'box', 'box', 'code', 'neither']
	);
	assert.equal(r.vocabulary.capabilitySurfaces.toolchain.label, 'Toolchain');
	assert.equal(r.vocabulary.capabilityVerifications.mint.label, 'Set at mint');
});

test('fleet report: workloadProofs carries the current canary per gated capability, null where there is none', () => {
	const proof = {
		node: 'claw-1',
		capability: 'jdk21',
		runId: 9,
		runner: 'jit-claw-1-proof',
		conclusion: 'success',
		durationSec: 196,
		evidenceMatched: true,
		budgetSec: 286,
		verdict: 'pass' as const,
		why: 'pass',
		at: '2026-10-08T19:59:14.103Z',
	};
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS, {
		proofsByCapability: { jdk21: [proof] },
		corrupt: false,
	});
	const wire: Record<string, unknown> = { ...proof };
	delete wire.node;
	delete wire.capability;
	assert.deepEqual(r.machines.find((m) => m.name === 'claw-1')!.workloadProofs.jdk21, wire);
	assert.equal(r.machines.find((m) => m.name === 'hokon')!.workloadProofs.jdk21, null);
});

test('fleet report: jobs.daily carries each day’s dispatch counts, null before the history began', () => {
	const jobs: JobHistorySummary = {
		...NO_JOBS,
		daily: ['2026-10-07', '2026-10-08', '2026-10-09'].map((day) => ({
			day,
			jobs: 0,
			failuresByZone: null,
			runMedianSec: null,
			runP95Sec: null,
			queueMedianSec: null,
			queueP95Sec: null,
			backstopJobs: 0,
			byMachine: [],
		})),
	};
	const r = buildFleetReport(
		null,
		null,
		MANIFEST,
		jobs,
		{ proofsByCapability: {}, corrupt: false },
		{
			since: '2026-10-08',
			days: { '2026-10-09': { minted: 4, failed: 1, mintedViaAffinity: 2 } },
		}
	);
	assert.deepEqual(
		r.jobs.daily.map((d) => d.dispatch),
		[
			null,
			{ minted: 0, failed: 0, mintedViaAffinity: 0 },
			{ minted: 4, failed: 1, mintedViaAffinity: 2 },
		]
	);
});
