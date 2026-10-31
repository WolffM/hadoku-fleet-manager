/**
 * Fleet panel data contract: an ephemeral node's `state`/`os`/on-demand
 * backstop reading always comes from the FRESH probe, never the 10-minute
 * census copy of it, while a STANDING node's `state` still comes from the
 * census because only the runner listing can tell `demoted` from `absent`;
 * and `admissionRefusal`/`starved` (wave 4a, #100), where a key's PRESENCE
 * is the signal — "could not look" must never render as "admitted". Split
 * out of fleet-report.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/fleet-report-rig.ts` for the shared `NO_JOBS`/`health`/
 * `upProbe`/`EPHEMERAL_MANIFEST` fixture and the admission-verdict reset.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { FleetReport } from '../fleet-report-types.js';
import { buildFleetReport } from '../routes/fleet.js';
import { __setAdmissionVerdictsForTesting } from '../runners/ephemeral-tick.js';
import { setBackstopHold } from '../runners/backstop-hold.js';
import {
	NO_JOBS,
	health,
	upProbe,
	EPHEMERAL_MANIFEST,
	installFleetReportRig,
} from './helpers/fleet-report-rig.js';

installFleetReportRig();

// ── ephemeral nodes ─────────────────────────────────────────────────────────

test('ephemeral state comes from the FRESH probe, not the census copy of it', async () => {
	// The bug this pins, observed live on 2026-09-02: claw-1 rendered
	// `state: 'unreachable'` in the Scheduling column while the same row
	// reported `reachable: true, workers: 2`. Not two measurements disagreeing —
	// one measurement beside a ten-minute-old photograph of itself, because an
	// ephemeral node's state is a pure function of the probe and runner-health
	// stored its own answer on a 10-minute tick.
	const r = buildFleetReport(
		health({ at: 'stale', claw_state: { 'claw-3': 'unreachable' } }),
		{ at: 'fresh', nodes: { 'claw-3': upProbe({ workers: 2, free: 1 }) } },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	const claw = r.machines.find((m) => m.name === 'claw-3')!;
	assert.equal(claw.reachable, true);
	assert.equal(claw.state, 'mintable', 'the fresh probe wins for an ephemeral node');
	assert.equal(claw.ephemeral, true);
});

test('a STANDING node still takes its state from the census', async () => {
	// Only the listing can tell `demoted` from `absent`, and the probe cannot
	// see either. So this half must NOT move.
	const r = buildFleetReport(
		health({ claw_state: { hokon: 'demoted' } }),
		{ at: 'now', nodes: { hokon: upProbe() } },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	const hokon = r.machines.find((m) => m.name === 'hokon')!;
	assert.equal(hokon.state, 'demoted');
	assert.equal(hokon.ephemeral, false);
});

const BACKSTOP_MANIFEST = {
	...EPHEMERAL_MANIFEST,
	hokon: { ...EPHEMERAL_MANIFEST.hokon, role: 'backstop', mint: 'on-demand' },
};

test('os comes from the live probe, so a node enrollment never measured still has one', () => {
	// claw-1..3 predate enrollment, so `$measured` is empty and the inventory
	// showed no OS for them; the rest showed the release they joined with.
	const r = buildFleetReport(
		health(),
		{
			at: 'now',
			nodes: { 'claw-3': upProbe({ os: { release: '13.3', kernel: '6.18.7-surface-1' } }) },
		},
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	assert.deepEqual(r.machines.find((m) => m.name === 'claw-3')!.os, {
		release: '13.3',
		kernel: '6.18.7-surface-1',
	});
	assert.equal(r.machines.find((m) => m.name === 'hokon')!.os, null, 'unprobed is null');
});

test('a HELD on-demand backstop reads mintable, not the census demoted', async () => {
	// 2026-10-25: hokon showed `demoted` beside 13 queued jobs while the
	// dispatcher minted onto it. Its one standing registration is a deploy runner
	// the backstop never labels, so the census says `demoted` held or not; the
	// hold is the record of the promotion. Both halves of the payload must agree.
	setBackstopHold(['hokon']);
	try {
		const r = buildFleetReport(
			health({ claw_state: { hokon: 'demoted' } }),
			{ at: 'now', nodes: { hokon: upProbe() } },
			BACKSTOP_MANIFEST,
			NO_JOBS
		);
		assert.equal(r.machines.find((m) => m.name === 'hokon')!.state, 'mintable');
		assert.equal(r.fleet.clawState?.hokon, 'mintable');
	} finally {
		setBackstopHold([]);
	}
});

test('an UNHELD on-demand backstop keeps the census word', async () => {
	setBackstopHold([]);
	const r = buildFleetReport(
		health({ claw_state: { hokon: 'demoted' } }),
		{ at: 'now', nodes: { hokon: upProbe() } },
		BACKSTOP_MANIFEST,
		NO_JOBS
	);
	assert.equal(r.machines.find((m) => m.name === 'hokon')!.state, 'demoted');
	assert.equal(r.fleet.clawState?.hokon, 'demoted');
});

test('a held backstop with no probe is UNKNOWN, never the stale census word', async () => {
	setBackstopHold(['hokon']);
	try {
		const r = buildFleetReport(
			health({ claw_state: { hokon: 'demoted' } }),
			{ at: 'now', nodes: {} },
			BACKSTOP_MANIFEST,
			NO_JOBS
		);
		assert.equal(r.machines.find((m) => m.name === 'hokon')!.state, null);
		assert.ok(!('hokon' in (r.fleet.clawState ?? {})), 'omitted, as the census omits unknowns');
	} finally {
		setBackstopHold([]);
	}
});

test('an ephemeral node the probe has not reached is UNKNOWN, not unreachable', async () => {
	// The other half of the same discipline (see claw-state.ts): an absent probe
	// is "not looked at yet", never a verdict. Here it also has to BEAT a stale
	// census entry that does carry one — the census is exactly where a verdict
	// invented in the boot race would still be sitting.
	const r = buildFleetReport(
		health({ claw_state: { 'claw-3': 'mintable' } }),
		{ at: 'now', nodes: {} },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	assert.equal(r.machines.find((m) => m.name === 'claw-3')!.state, null);
});

test('a probed-and-DOWN ephemeral node still says unreachable', async () => {
	// The omission above must not widen into hiding a genuine outage.
	const r = buildFleetReport(
		null,
		{ at: 'now', nodes: { 'claw-3': upProbe({ reachable: false, workers: 0, free: 0 }) } },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	assert.equal(r.machines.find((m) => m.name === 'claw-3')!.state, 'unreachable');
});

test('with NO probe snapshot an ephemeral node is null — we have not looked', async () => {
	const r = buildFleetReport(null, null, EPHEMERAL_MANIFEST, NO_JOBS);
	assert.equal(r.machines.find((m) => m.name === 'claw-3')!.state, null);
});

// ── admissionRefusal / starved (wave 4a, #100) ───────────────────────────────

test('admissionRefusal carries the numbers for a memory-refused EPHEMERAL node', () => {
	__setAdmissionVerdictsForTesting(
		new Map([
			[
				'claw-3',
				{
					ok: false,
					clause: 'memory',
					availableMb: 4813,
					needMb: 5632,
					reserveBasis: 'node',
					reason:
						'memory: 4813MB free, this repo peaks at 5632MB, would leave -819MB against a 1536MB floor',
				},
			],
		])
	);
	const r = buildFleetReport(
		health(),
		{ at: 'now', nodes: { 'claw-3': upProbe() } },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	const claw = r.machines.find((m) => m.name === 'claw-3')!;
	assert.deepEqual(claw.admissionRefusal, {
		clause: 'memory',
		availableMb: 4813,
		needMb: 5632,
		reserveBasis: 'node',
		reason:
			'memory: 4813MB free, this repo peaks at 5632MB, would leave -819MB against a 1536MB floor',
	});
	// `admissionFree` keeps its OWN meaning beside it — see its own doc comment.
	// This panel field is additive, not a replacement.
	assert.notEqual(claw.admissionFree, undefined);
});

test('(e1) admissionRefusal carries `filesystem` for a space-refused EPHEMERAL node (#101)', () => {
	__setAdmissionVerdictsForTesting(
		new Map([
			[
				'claw-3',
				{
					ok: false,
					clause: 'space',
					availableMb: 300,
					needMb: 2048,
					filesystem: 'tmp',
					reserveBasis: 'default',
					reason: 'space: /tmp has 300MB free, under the 2048MB floor',
				},
			],
		])
	);
	const r = buildFleetReport(
		health(),
		{ at: 'now', nodes: { 'claw-3': upProbe() } },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	const claw = r.machines.find((m) => m.name === 'claw-3')!;
	assert.deepEqual(claw.admissionRefusal, {
		clause: 'space',
		availableMb: 300,
		needMb: 2048,
		filesystem: 'tmp',
		reserveBasis: 'default',
		reason: 'space: /tmp has 300MB free, under the 2048MB floor',
	});
});

test('(e4) a space verdict with unreadable:true carries unreadable:true on the wire', () => {
	__setAdmissionVerdictsForTesting(
		new Map([
			[
				'claw-3',
				{
					ok: false,
					clause: 'space',
					availableMb: 0,
					needMb: 2048,
					filesystem: 'tmp',
					unreadable: true,
					reserveBasis: 'default',
					reason: 'space: could not read /tmp free space',
				},
			],
		])
	);
	const r = buildFleetReport(
		health(),
		{ at: 'now', nodes: { 'claw-3': upProbe() } },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	const claw = r.machines.find((m) => m.name === 'claw-3')!;
	assert.equal(claw.admissionRefusal?.unreadable, true);
	assert.equal(claw.admissionRefusal?.filesystem, 'tmp');
});

test('(e2) a memory refusal carries NO `filesystem` key and NO `unreadable` key', () => {
	__setAdmissionVerdictsForTesting(
		new Map([
			[
				'claw-3',
				{
					ok: false,
					clause: 'memory',
					availableMb: 4813,
					needMb: 5632,
					reserveBasis: 'node',
					reason:
						'memory: 4813MB free, this repo peaks at 5632MB, would leave -819MB against a 1536MB floor',
				},
			],
		])
	);
	const r = buildFleetReport(
		health(),
		{ at: 'now', nodes: { 'claw-3': upProbe() } },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	const claw = r.machines.find((m) => m.name === 'claw-3')!;
	assert.equal(Object.hasOwn(claw.admissionRefusal ?? {}, 'filesystem'), false);
	assert.equal(Object.hasOwn(claw.admissionRefusal ?? {}, 'unreadable'), false);
});

test('(e3) the report vocabulary includes a `space` entry in `admissionClauses`', () => {
	const r = buildFleetReport(health(), { at: 'now', nodes: {} }, EPHEMERAL_MANIFEST, NO_JOBS);
	assert.ok(Object.hasOwn(r.vocabulary.admissionClauses, 'space'), 'admissionClauses names space');
});

/**
 * The key's PRESENCE is the signal, not its value — "could not look" must
 * never render as "admitted" (CLAUDE.md), and a `null` value is what the
 * deployed `fleet traffic` reader (lane B, `scripts/traffic-status.mjs`)
 * already reads as "admitted". So this asserts through a JSON round-trip:
 * `'admissionRefusal' in obj` is still `true` for an object that was merely
 * assigned `{ admissionRefusal: undefined }`, which is exactly the collapse
 * this field exists to avoid — only `JSON.parse(JSON.stringify(...))`, the
 * actual wire shape, proves the key was OMITTED.
 */
function machineJson(r: Pick<FleetReport, 'machines'>, name: string): Record<string, unknown> {
	const m = r.machines.find((mm) => mm.name === name);
	assert.ok(m, `fixture lost ${name}`);
	return JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
}

test('admissionRefusal: KEY ABSENT for an ephemeral node this process has not looked at yet', () => {
	const r = buildFleetReport(
		health(),
		{ at: 'now', nodes: { 'claw-3': upProbe() } },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	assert.equal('admissionRefusal' in machineJson(r, 'claw-3'), false);
});

test('admissionRefusal: null, PRESENT, for an ephemeral node the tick currently admits', () => {
	__setAdmissionVerdictsForTesting(new Map([['claw-3', { ok: true }]]));
	const r = buildFleetReport(
		health(),
		{ at: 'now', nodes: { 'claw-3': upProbe() } },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	const json = machineJson(r, 'claw-3');
	assert.equal('admissionRefusal' in json, true);
	assert.equal(json.admissionRefusal, null);
});

test('admissionRefusal: KEY ABSENT on a STANDING node even if a verdict leaked in for its name', () => {
	// `admitMint` is JIT-only — a verdict for a standing node's name would be a
	// bug elsewhere, and this field must not surface it as though it were real.
	__setAdmissionVerdictsForTesting(
		new Map([
			[
				'hokon',
				{
					ok: false,
					clause: 'memory',
					availableMb: 1,
					needMb: 2,
					reserveBasis: 'default',
					reason: 'x',
				},
			],
		])
	);
	const r = buildFleetReport(
		health(),
		{ at: 'now', nodes: { hokon: upProbe() } },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	assert.equal('admissionRefusal' in machineJson(r, 'hokon'), false);
});

test("starved reads from runner-health's own finding, keyed by node", () => {
	const r = buildFleetReport(
		health({ starved: { 'claw-3': true } }),
		{ at: 'now', nodes: { 'claw-3': upProbe() } },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	assert.equal(r.machines.find((m) => m.name === 'claw-3')!.starved, true);
	assert.equal(r.machines.find((m) => m.name === 'hokon')!.starved, false);
});

test('starved is false, never undefined, when runner-health has not named this node', () => {
	const r = buildFleetReport(
		health(),
		{ at: 'now', nodes: { 'claw-3': upProbe() } },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	assert.equal(r.machines.find((m) => m.name === 'claw-3')!.starved, false);
});
