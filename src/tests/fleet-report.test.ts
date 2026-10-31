/**
 * Fleet panel data contract.
 *
 * The thing worth pinning here is NOT the arithmetic — it is that "we have not
 * looked yet" and "we looked and there is nothing left" stay distinguishable all
 * the way to the browser. They are different emergencies: one is a fleet that
 * just restarted, the other is a fleet with no capacity. Collapsing them into a
 * shared 0 is the classic dashboard lie, and it is a one-character `?? 0` away
 * at every level of this join.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildFleetReport, fetchJobForBackfill } from '../routes/fleet.js';
import type { RunnerHealthSnapshot } from '../runner-health.js';
import type { CapacityKind, FleetReport } from '../fleet-report-types.js';
import { probeFleet, type NodeProbe } from '../lib/node-probe.js';
import {
	__resetAdmissionVerdictsForTesting,
	__setAdmissionVerdictsForTesting,
} from '../runners/ephemeral-tick.js';
import { __resetJobHistoryForTesting } from '../job-history-store.js';
import { __setHistoryPathForTesting } from '../job-history-store.js';
import type { JobRecord } from '../job-history-store.js';
import type { JobHistorySummary } from '../job-history-stats.js';
import type { RecentJobRecord } from '../job-history-stats.js';
import { testStateDir, testHost } from './install-test-host.js';
import { __setHostForTesting } from '../host.js';
import { setBackstopHold } from '../runners/backstop-hold.js';

/**
 * An EMPTY job history, passed explicitly.
 *
 * buildFleetReport's fourth parameter defaults to `summarise(...)`, which reads
 * the real ~/.hadoku-mgmt/job-history.jsonl. Every call below left it defaulted,
 * so these tests' results moved with whatever the live fleet had been doing —
 * the same class of problem as the tickFleet suite SSHing the garage. The other
 * three snapshots were already injectable; this one was missed.
 */
/**
 * Read one capacity row out of the breakdown.
 *
 * The tests below asserted on `slot(r, 'mintable')` and friends until the
 * rollup became `byKind` rows. Kept as a helper rather than inlined so the
 * assertions still read as one line each — and so a row that stops being
 * emitted fails as `undefined` here rather than as a silent `?? 0` somewhere.
 */
function slot(r: Pick<FleetReport, 'fleet'>, kind: CapacityKind): number | null | undefined {
	return r.fleet.capacity.byKind.find((k) => k.kind === kind)?.free;
}

const NO_JOBS: JobHistorySummary = {
	since: null,
	total: 0,
	byMachine: [],
	byRepo: [],
	daily: [],
	backstopJobs: 0,
	backstopShare: 0,
	recent: [],
	recentSince: '2026-09-09T00:00:00.000Z',
	recentWindowSec: 3600,
};

/** A minimal runner-health snapshot — the three required fields plus overrides. */
const health = (m: Partial<RunnerHealthSnapshot> = {}): RunnerHealthSnapshot => ({
	at: 'now',
	runnersChecked: true,
	runsChecked: true,
	floorBreach: false,
	...m,
});

const MANIFEST = {
	'claw-1': { cores: 8, ramGb: 11, maxRegistrations: 32, maxConcurrent: 4, labels: [] },
	hokon: {
		cores: 12,
		ramGb: 61,
		maxRegistrations: 32,
		maxConcurrent: 4,
		labels: ['pm2-host', 'taskauto'],
		excludeRepos: { 'WolffM/x': 'why' },
	},
};

const upProbe = (m: Partial<NodeProbe> = {}): NodeProbe => ({
	workers: 1,
	cores: 8,
	capacity: 4,
	free: 3,
	sick: false,
	reachable: true,
	busyRepos: null,
	...m,
});

// ── probeFleet ──────────────────────────────────────────────────────────────

test('probeFleet: free = capacity - workers, against CONFIGURED capacity not cores', async () => {
	const out = await probeFleet(['claw-1'], { 'claw-1': 4 }, async () => ({
		workers: 3,
		cores: 8,
	}));
	assert.deepEqual(out.get('claw-1'), {
		workers: 3,
		cores: 8,
		capacity: 4,
		free: 1,
		reachable: true,
		sick: false,
		// A probe that does not report per-repo attribution is UNKNOWN, never
		// "nothing running" — the ladder falls back to the node number.
		busyRepos: null,
	});
});

test('probeFleet: more workers than capacity clamps to 0 free, never negative', async () => {
	const out = await probeFleet(['claw-1'], { 'claw-1': 2 }, async () => ({
		workers: 5,
		cores: 8,
	}));
	assert.equal(out.get('claw-1')?.free, 0);
});

test('probeFleet: an unreachable node is RECORDED as down, not omitted', async () => {
	// The tier maths drops it — tickFleet filters to `p.reachable && !sick`
	// before deriving free slots — but the dashboard must not, or a dead claw and
	// a claw merely absent from the tier manifest render identically.
	const out = await probeFleet(['claw-9'], {}, async () => null);
	assert.equal(out.get('claw-9')?.reachable, false);
	assert.equal(out.get('claw-9')?.free, 0);
});

// ── buildFleetReport ────────────────────────────────────────────────────────

test('fleet report: never probed → live fields are NULL, not 0', async () => {
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	const claw = r.machines.find((m) => m.name === 'claw-1')!;
	assert.equal(claw.reachable, null, 'unprobed is not "down"');
	assert.equal(claw.workers, null);
	assert.equal(claw.free, null, 'a fleet we have not looked at must not read as saturated');
	assert.equal(r.probedAt, null);
	// Static manifest facts survive with no probe at all — the panel is still
	// useful before the first tick.
	assert.equal(claw.cores, 8);
	assert.equal(claw.maxConcurrent, 4);
});

test('fleet report: probed but DOWN → reachable false, load figures still null', async () => {
	const r = buildFleetReport(
		null,
		{
			at: '2026-08-23T00:00:00Z',
			nodes: {
				'claw-1': {
					workers: 0,
					cores: 0,
					capacity: 4,
					free: 0,
					reachable: false,
					sick: false,
					busyRepos: null,
				},
			},
		},
		MANIFEST,
		NO_JOBS
	);
	const claw = r.machines.find((m) => m.name === 'claw-1')!;
	assert.equal(claw.reachable, false, 'down is distinct from unprobed');
	assert.equal(claw.free, null, 'we have no reading, so we report none');
});

test('fleet report: a healthy probe reports real load', async () => {
	const r = buildFleetReport(
		null,
		{ at: '2026-08-23T00:00:00Z', nodes: { 'claw-1': upProbe({ workers: 2, free: 2 }) } },
		MANIFEST,
		NO_JOBS
	);
	const claw = r.machines.find((m) => m.name === 'claw-1')!;
	assert.equal(claw.reachable, true);
	assert.equal(claw.workers, 2);
	assert.equal(claw.free, 2);
});

test('fleet report: node facts come from the manifest, including exclusions', async () => {
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	const hokon = r.machines.find((m) => m.name === 'hokon')!;
	assert.deepEqual(hokon.labels, ['pm2-host', 'taskauto']);
	assert.deepEqual(hokon.excludedRepos, ['WolffM/x']);
});

test('fleet report: a probed node absent from the manifest still appears', async () => {
	// Otherwise a node someone registered by hand is invisible in the one
	// view whose job is to show what is actually out there.
	const r = buildFleetReport(
		null,
		{ at: 'now', nodes: { 'claw-rogue': upProbe() } },
		MANIFEST,
		NO_JOBS
	);
	assert.ok(r.machines.some((m) => m.name === 'claw-rogue'));
});

test('fleet report: queue + backstop fields pass through from runner-health', async () => {
	const r = buildFleetReport(
		{
			at: 'now',
			runnersChecked: true,
			runsChecked: true,
			floorBreach: false,
			claws_free: 0,
			clawsOnline: 3,
			backstop_reason: 'saturation',
			queued_now: 5,
			oldest_queued_min: 7,
			running_now: 4,
			longest_running_min: 12,
			oomReruns: 1,
		},
		null,
		MANIFEST,
		NO_JOBS
	);
	assert.equal(r.fleet.capacity.free, 0);
	assert.equal(r.fleet.backstopReason, 'saturation');
	assert.equal(r.fleet.queuedNow, 5);
	assert.equal(r.fleet.oldestQueuedMin, 7);
	assert.equal(r.fleet.longestRunningMin, 12);
	assert.equal(r.fleet.oomReruns, 1);
});

test('fleet report: clawsFree 0 and clawsFree unknown are different values', async () => {
	// The whole null-vs-zero contract in one assertion: a saturated fleet reports
	// 0, a fleet with no health tick yet reports null, and the UI must be able to
	// tell them apart because only one of them is an incident.
	const saturated = buildFleetReport(
		{ at: 'now', runnersChecked: true, runsChecked: true, floorBreach: false, claws_free: 0 },
		null,
		MANIFEST,
		NO_JOBS
	);
	const unknown = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	assert.equal(saturated.fleet.capacity.free, 0);
	assert.equal(unknown.fleet.capacity.free, null);
	assert.notEqual(saturated.fleet.capacity.free, unknown.fleet.capacity.free);
});

/**
 * The INJECTED manifest must reach the job rollup, not just the node list.
 *
 * `jobs` defaulted to `summarise(Object.keys(loadManifestNodes()))` — a
 * second read of the file rather than a reference to the `manifest` parameter
 * declared one line above it. A caller that injected a manifest and left `jobs`
 * defaulted therefore got two halves of one report describing different fleets:
 * `machines` from what it passed in, `byMachine` from whatever is on disk.
 *
 * The observable is `nodeOf`, which folds a runner name onto a node using
 * the node LIST it is handed. `claw-9` is deliberately absent from the real
 * `manifests/fleet-runner-manifest.json`, so with the wrong list
 * `claw-9-hadoku_site` matches no prefix and becomes its own node — 36 rows
 * for a four-node fleet, the same failure the loader's own header describes.
 */
void test('buildFleetReport: an injected manifest reaches the job rollup too', (t) => {
	const historyPath = join(testStateDir, 'injected-manifest-history.jsonl');
	const record: JobRecord = {
		repo: 'WolffM/hadoku_site',
		runId: 1,
		jobId: 1,
		name: 'check',
		// A JIT-style registration name: `<node>-<repo>`, which only resolves
		// back to `claw-9` when `claw-9` is in the node list.
		runner: 'claw-9-hadoku_site',
		labels: ['hadoku-builder'],
		startedAt: new Date().toISOString(),
		durationSec: 42,
		conclusion: 'success',
	};
	writeFileSync(historyPath, `${JSON.stringify(record)}\n`);
	__setHistoryPathForTesting(historyPath);
	__resetJobHistoryForTesting();
	t.after(() => {
		__setHistoryPathForTesting(null);
		__resetJobHistoryForTesting();
	});

	const report = buildFleetReport(null, null, { 'claw-9': { cores: 4, maxConcurrent: 1 } });

	assert.equal(report.jobs.total, 1, 'the seeded history was not read at all');
	assert.deepEqual(
		report.jobs.byMachine.map((m) => m.machine),
		['claw-9'],
		'the rollup folded the runner against the on-disk manifest, not the injected one'
	);
	assert.deepEqual(
		report.machines.map((m) => m.name),
		['claw-9'],
		'both halves of the report must describe the same fleet'
	);
});

/**
 * The manifest must actually be READ in the packaged layout.
 *
 * `loadManifestNodes` kept two `__dirname`-relative candidates after the
 * 2026-08-30 extraction. From inside node_modules they resolve to
 * `.../node_modules/scripts/admin/…` — which does not exist — and the catch
 * returned `{}`. The route answered 200 the whole time while the command
 * station rendered em dashes in five of seven Machines columns, and
 * `summarise()` received an EMPTY node list, so `nodeOf` folded nothing
 * and 36 JIT names became 36 nodes.
 *
 * Asserting on the REPORT rather than on the loader is deliberate: the bug was
 * invisible precisely because every layer above it kept working.
 */
void test('buildFleetReport reads the real manifest, not an empty fallback', () => {
	const report = buildFleetReport(null, null);
	assert.ok(report.machines.length > 0, 'a report with no nodes means the manifest was not found');
	const named = report.machines.filter((m) => m.name);
	assert.ok(named.length >= 3, `expected the real fleet, got ${named.length} node(s)`);

	// The fields that come ONLY from the manifest. All null is the exact
	// signature of the soft failure — reachable, but describing nothing.
	const withCaps = report.machines.filter((m) => m.maxConcurrent !== null);
	assert.ok(
		withCaps.length > 0,
		'every node has a null maxConcurrent — the manifest read returned {} again'
	);
	const withRam = report.machines.filter((m) => m.ramGb !== null);
	assert.ok(withRam.length > 0, 'every node has a null ramGb — same soft failure');
});

/**
 * THE NARROWER CASE THE COMMENT ABOVE NAMED AND LEFT OPEN (wave 5c, fixed
 * here in wave 5d lane A): the directory resolves but the FILE does not read
 * or parse. `loadManifestNodes` used to turn that into `{}`, and the route
 * answered 200 describing a fleet of zero nodes — "I could not look" must
 * never render as "nothing is wrong" (AGENTS.md). `buildFleetReport()` with
 * no manifest injected (so its own default parameter, the one that reads the
 * manifest, actually runs) must now FAIL LOUDLY instead.
 */
void test('buildFleetReport throws when the manifest cannot be read — never a silent 0-node report', () => {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-report-unreadable-manifest-'));
	__setHostForTesting({ ...testHost, manifestDir: dir });
	try {
		assert.throws(() => buildFleetReport(), /cannot read the node manifest/);
	} finally {
		__setHostForTesting(testHost);
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── the vocabulary block ────────────────────────────────────────────────────
//
// The command station cannot import this package (express in a browser bundle),
// so every fleet word it needed it re-typed: two label names to colour a pill,
// the three implicit labels to subtract, `'hokon'` in five places, the ladder in
// a sentence, and `10` for the queued-stale threshold. These tests pin that the
// payload now CARRIES those words, derived, so the panel holds no opinion about
// what the fleet's labels are called.

test('vocabulary: label names come from the capability registry, not literals', async () => {
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	assert.equal(r.vocabulary.builderLabel, 'hadoku-builder');
	assert.equal(r.vocabulary.pm2HostLabel, 'pm2-host');
	assert.equal(r.vocabulary.backstopLabel, 'hokon-backstop');
	// Every LABEL capability is described, so a tooltip cannot say something
	// different from the gate that enforces the label.
	assert.ok(r.vocabulary.labels['hadoku-builder'].description.length > 20);
	assert.equal(r.vocabulary.labels['hadoku-builder'].kind, 'eligibility');
	assert.equal(r.vocabulary.labels['pm2-host'].kind, 'identity');
	// Toolchain and implicit capabilities are NOT labels and must not appear —
	// nothing routes on them, so a panel listing them would invent capabilities.
	assert.equal(r.vocabulary.labels['ffmpeg'], undefined);
	assert.equal(r.vocabulary.labels['jitconfig'], undefined);
});

test('vocabulary: the ladder is ordered highest rung first', async () => {
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	assert.deepEqual(r.vocabulary.ladder, ['pm2-host', 'hadoku-builder', 'taskauto']);
});

test('vocabulary: implicit labels are the ones GitHub adds by itself', async () => {
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	assert.deepEqual(r.vocabulary.implicitLabels, ['self-hosted', 'Linux', 'X64']);
});

test('vocabulary: the backstop node is DERIVED from who carries pm2-host', async () => {
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	assert.equal(r.vocabulary.backstopNode, 'hokon');

	// Move the label and the answer moves with it. This is the whole point: the
	// name was a literal in four places, and a fleet whose production host
	// changed would have gone on calling the old box "the backstop".
	const moved = {
		'claw-1': { ...MANIFEST['claw-1'], labels: ['pm2-host'] },
		hokon: { ...MANIFEST.hokon, labels: ['taskauto'] },
	};
	assert.equal(buildFleetReport(null, null, moved, NO_JOBS).vocabulary.backstopNode, 'claw-1');
});

test('vocabulary: no pm2-host in the manifest reports NO backstop, never a guess', async () => {
	// A fleet with no backstop is a real state. Falling back to a hardcoded
	// 'hokon' would have the panel claim a machine is standing by that is not.
	const none = { 'claw-1': { ...MANIFEST['claw-1'], labels: ['hadoku-builder'] } };
	assert.equal(buildFleetReport(null, null, none, NO_JOBS).vocabulary.backstopNode, null);
});

test('vocabulary: the queued-stale threshold travels with the count it describes', async () => {
	// The panel labelled a card "Queued past 10m" from its own literal while the
	// count came from this constant. They agreed by coincidence.
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	assert.equal(r.vocabulary.queuedWarnMinutes, 10);
	assert.equal(r.vocabulary.censusRepo, 'WolffM/hadoku_site');
});

// ── ephemeral nodes ─────────────────────────────────────────────────────────

const EPHEMERAL_MANIFEST = {
	'claw-3': { cores: 4, maxConcurrent: 3, labels: ['hadoku-builder'], ephemeral: true },
	hokon: { cores: 12, maxConcurrent: 4, labels: ['pm2-host'] },
};

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

const GUEST_MANIFEST = {
	...EPHEMERAL_MANIFEST,
	hokon: { ...EPHEMERAL_MANIFEST.hokon, role: 'guest', mint: 'on-demand' },
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

test('a HELD on-demand guest reads mintable, not the census demoted', async () => {
	// 2026-10-25: hokon showed `demoted` beside 13 queued jobs while the
	// dispatcher minted onto it. Its one standing registration is a deploy runner
	// the backstop never labels, so the census says `demoted` held or not; the
	// hold is the record of the promotion. Both halves of the payload must agree.
	setBackstopHold(['hokon']);
	try {
		const r = buildFleetReport(
			health({ claw_state: { hokon: 'demoted' } }),
			{ at: 'now', nodes: { hokon: upProbe() } },
			GUEST_MANIFEST,
			NO_JOBS
		);
		assert.equal(r.machines.find((m) => m.name === 'hokon')!.state, 'mintable');
		assert.equal(r.fleet.clawState?.hokon, 'mintable');
	} finally {
		setBackstopHold([]);
	}
});

test('an UNHELD on-demand guest keeps the census word', async () => {
	setBackstopHold([]);
	const r = buildFleetReport(
		health({ claw_state: { hokon: 'demoted' } }),
		{ at: 'now', nodes: { hokon: upProbe() } },
		GUEST_MANIFEST,
		NO_JOBS
	);
	assert.equal(r.machines.find((m) => m.name === 'hokon')!.state, 'demoted');
	assert.equal(r.fleet.clawState?.hokon, 'demoted');
});

test('a held guest with no probe is UNKNOWN, never the stale census word', async () => {
	setBackstopHold(['hokon']);
	try {
		const r = buildFleetReport(
			health({ claw_state: { hokon: 'demoted' } }),
			{ at: 'now', nodes: {} },
			GUEST_MANIFEST,
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

beforeEach(() => {
	__resetAdmissionVerdictsForTesting();
});

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

// ── the WIRE CONTRACT with hadoku_site ──────────────────────────────────────
//
// The tests above pin VALUES. Nothing pinned the KEY NAMES, so renaming a field
// here passes this whole suite and silently blanks a panel in another repo —
// exactly the cross-repo hazard `scripts/lib/json-contract.mjs` exists for on
// the `--json` subcommands, which this payload never got.
//
// THE LIST IS THE DECLARATION. It is written out rather than derived, because
// the consumer lives in a different repository and CI here cannot read it: a
// count, or a check against the TypeScript type, would agree with itself after a
// rename and prove nothing. Read from
// hadoku_site/src/components/ContactAdmin/System/FleetView.tsx and
// FleetCharts.tsx on 2026-09-02, after the panel stopped holding its own copy of
// the fleet's vocabulary and started reading `vocabulary` and `dispatch`.
//
// If you rename one of these, fix FleetView.tsx in the SAME pass.

const WIRE_TOP = [
	'probedAt',
	'healthAt',
	'machines',
	'fleet',
	'jobs',
	'reservation',
	// The panel's "Minting, last pass" section. It was in the contract and
	// rendered NOWHERE, which is what let a 409 name collision run at ~7% of
	// mints for the pilot's whole life — the very failure FleetDispatch's own
	// doc-comment was written about.
	'dispatch',
	// The fleet's words. Renaming this blanks a pill's colour, a legend, a
	// ladder and a threshold at once, and none of it would throw.
	'vocabulary',
];
const WIRE_MACHINE = [
	'name',
	'cores',
	'ramGb',
	'labels',
	'maxRegistrations',
	'maxConcurrent',
	'excludedRepos',
	'reachable',
	'workers',
	'capacity',
	'free',
	'liveLabels',
	'state',
	// The budget that actually admits work here — see FleetMachine.
	'admissionCapacity',
	'admissionFree',
	'admissionBasis',
	// Decides whether four legitimately-null columns read as "healthy JIT node"
	// or as "GitHub stopped listing this box". They are identical without it.
	'ephemeral',
	// `admissionRefusal` is DELIBERATELY NOT HERE. Wave 4a (#100): it is the
	// field that actually answers "can this node take a job right now" —
	// `admissionFree` above counts slots and never applies the memory clause
	// — but it is OPTIONAL on the wire (absent means "could not look", never
	// "admitted"; see its own doc comment), so this flat "every machine has
	// every key" sweep cannot guard it without producing a false failure on a
	// node this process has no verdict for. The dedicated check right after
	// this loop guards it instead — do not move it back here.
	//
	// `runner-health.ts`'s starvation finding, keyed onto the machine it is
	// about rather than left in a separate per-node map the panel has to join.
	'starved',
	// The OS as running, from the probe; `measured` is enrollment-time only.
	'os',
];

/**
 * The vocabulary block, which is the panel's ONLY source for these words.
 *
 * Losing one does not throw — it renders an undefined tone, an empty ladder, or
 * a legend that says "backstop" where a machine name belongs. Silent, on the
 * page opened when something is already wrong.
 */
const WIRE_VOCAB = [
	// The panel's last local copy of fleet semantics — see JobPhase.
	'jobPhases',
	'builderLabel',
	'pm2HostLabel',
	'implicitLabels',
	'ladder',
	'backstopNode',
	'labels',
	'queuedWarnMinutes',
	'censusRepo',
	// The report's own enums, described here rather than in the panel. See
	// telemetry-vocabulary.ts for why these are a wire field and not an import.
	'states',
	'backstopReasons',
	'admissionBases',
	'admissionCaveats',
	// Wave 4a (#100): what `FleetMachine.admissionRefusal.clause` means.
	'admissionClauses',
];

/** The JIT dispatch block behind "Minting, last pass". */
const WIRE_DISPATCH = [
	'at',
	'minted',
	'failed',
	'inFlight',
	'reaped',
	'error',
	'failingSince',
	'totals',
	'lastMintAt',
	'recent',
	'queue',
];
const WIRE_FLEET = [
	'clawsOnline',
	// ONE object where five scalars were. `clawsReady`, `clawsFree`,
	// `clawsFreeStanding`, `clawsFreeMintable` and `clawsPromotable` left the
	// contract on 2026-09-03: three of those names encoded a mechanism being
	// replaced, so growing a fourth kind of capacity was a cross-repo rename.
	'capacity',
	'queuedNow',
	'oldestQueuedMin',
	'runningNow',
	'longestRunningMin',
	'queuedStale',
	'hung',
	'failoverReruns',
	'oomReruns',
	'backstopReason',
];
const WIRE_JOBS = [
	'since',
	'total',
	'byMachine',
	'backstopJobs',
	'backstopShare',
	'recent',
	// The bounds of the trailing window `byMachine[].recent*` is cut over. Losing
	// either leaves the panel captioning an hour it has to assume — and the whole
	// reason the aggregate is cut server-side is that a consumer guessing its own
	// window is what issue #18 was about.
	'recentSince',
	'recentWindowSec',
];
/** The capacity block's own shape — a nested object hides its keys from the flat check. */
const WIRE_CAPACITY = ['ready', 'free', 'byKind', 'unmeasured'];
const WIRE_CAPACITY_SLICE = ['kind', 'free', 'caveats', 'available'];

test('wire contract: every key FleetView.tsx reads is still emitted', () => {
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	const missing: string[] = [];
	for (const k of WIRE_TOP) if (!(k in r)) missing.push(k);
	for (const k of WIRE_MACHINE) if (!(k in (r.machines[0] ?? {}))) missing.push(`machines[].${k}`);
	// `admissionRefusal` is OPTIONAL (wave 4a, #100: absent means "could not
	// look", never "admitted" — see its own doc comment) so the flat sweep
	// above cannot guard it without a false failure on a node this process has
	// no verdict for. Guarded here instead, against a report where a verdict
	// DOES exist, so the field disappearing from the codebase entirely still
	// fails this test loudly.
	__setAdmissionVerdictsForTesting(new Map([['claw-3', { ok: true }]]));
	const withVerdict = buildFleetReport(
		null,
		{ at: 'now', nodes: { 'claw-3': upProbe() } },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	__resetAdmissionVerdictsForTesting();
	if (!('admissionRefusal' in (withVerdict.machines.find((m) => m.name === 'claw-3') ?? {}))) {
		missing.push('machines[].admissionRefusal (present whenever ephemeral-tick has a verdict)');
	}
	for (const k of WIRE_FLEET) if (!(k in r.fleet)) missing.push(`fleet.${k}`);
	// Nested, so the flat sweep above cannot see inside it. Every row is checked
	// too: `byKind` being present and EMPTY would pass a shape check and render
	// as a fleet with no capacity of any kind.
	for (const k of WIRE_CAPACITY) if (!(k in r.fleet.capacity)) missing.push(`capacity.${k}`);
	if (!r.fleet.capacity.byKind.length) missing.push('capacity.byKind is empty');
	for (const row of r.fleet.capacity.byKind) {
		for (const k of WIRE_CAPACITY_SLICE) {
			if (!(k in row)) missing.push(`capacity.byKind[${row.kind}].${k}`);
		}
	}
	for (const k of WIRE_JOBS) if (!(k in r.jobs)) missing.push(`jobs.${k}`);
	for (const k of WIRE_VOCAB) if (!(k in r.vocabulary)) missing.push(`vocabulary.${k}`);
	for (const k of WIRE_DISPATCH) if (!(k in r.dispatch)) missing.push(`dispatch.${k}`);
	assert.deepEqual(
		missing,
		[],
		`removed/renamed wire key(s). Fix hadoku_site FleetView.tsx in the same pass:\n  ${missing.join('\n  ')}`
	);
});

/**
 * The nested rows FleetCharts.tsx draws. `jobs.recent` and `jobs.byMachine` were
 * pinned as KEYS, but their element shape — which is what the three charts
 * actually index into — was not, so renaming `durationSec` passed here and drew
 * an empty timeline there. Verified by mutation: a rename across the type, the
 * producer and this fixture still fails on the literals below.
 */
const WIRE_JOB_STAT = [
	'machine',
	'jobs',
	'failures',
	'medianSec',
	'p95Sec',
	// The trailing-hour figures the panel compares a recent job against. Renaming
	// one of these does not throw over there — it draws a comparison against
	// undefined, which is the exact shape of the gap issue #18 filed.
	'recentJobs',
	'recentMedianSec',
	'recentP95Sec',
	// `failures` split by whose half of the fence it fell on — §5.5's zones plus
	// the fleet's own TTL kills. Additive (0.22.130); a consumer that does not
	// read it is unaffected, and one that does cannot re-derive it, because
	// folding a step name into a zone needs a pattern table this package does
	// not publish to a browser bundle.
	'failuresByZone',
];
const WIRE_JOB_RECORD = [
	'repo',
	// The forge ids the panel links a row to. On the wire long before they were
	// declared; see FleetJobRecord.
	'runId',
	'jobId',
	'name',
	'runner',
	// The node that served it. `runner` is a per-job mint name on a JIT node and
	// cannot be folded downstream — see FleetJobRecord.machine. Without this key
	// the 40 rows of `recent` cannot be related to the rows of `byMachine` at all.
	'machine',
	'labels',
	'startedAt',
	'durationSec',
	'conclusion',
];

test('wire contract: the ROW shapes the charts index into are pinned too', () => {
	const record: RecentJobRecord = {
		runId: 1,
		jobId: 2,
		repo: 'WolffM/x',
		name: 'build',
		runner: 'claw-1',
		machine: 'claw-1',
		labels: ['hadoku-builder'],
		startedAt: '2026-09-02T00:00:00Z',
		durationSec: 30,
		conclusion: 'success',
	};
	const r = buildFleetReport(null, null, MANIFEST, {
		...NO_JOBS,
		total: 1,
		since: record.startedAt,
		byMachine: [
			{
				machine: 'claw-1',
				jobs: 1,
				failures: 0,
				failuresByZone: { runner: 0, seam: 0, content: 0, fleet: 0, cancelled: 0 },
				medianSec: 30,
				p95Sec: 30,
				repos: 1,
				recentJobs: 0,
				recentMedianSec: null,
				recentP95Sec: null,
			},
		],
		recent: [record],
	});
	const missing: string[] = [];
	for (const k of WIRE_JOB_STAT) if (!(k in r.jobs.byMachine[0])) missing.push(`byMachine[].${k}`);
	for (const k of WIRE_JOB_RECORD) if (!(k in r.jobs.recent[0])) missing.push(`recent[].${k}`);
	assert.deepEqual(missing, [], `removed/renamed wire key(s). Fix hadoku_site FleetCharts.tsx too`);
});

test('wire contract: the report has machines to check, so the guard is not vacuous', () => {
	// Every assertion above is `deepEqual([], [])` if machines is empty, which
	// would make the guard pass while checking nothing.
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	assert.ok(r.machines.length > 0, 'the fixture manifest must yield at least one machine');
});

test('wire contract: `state` may be null but the KEY must always be present', () => {
	// The 2026-09-02 fix made clawState omit unknown nodes, and the route turns a
	// missing entry into `state: null`. FleetView renders null as "unpolled" — but
	// only if the key exists to be read.
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	const m = r.machines[0]!;
	assert.ok('state' in m, 'the key is the contract; null is a legitimate value for it');
	assert.equal(m.state, null, 'and with no health snapshot it is null, never invented');
});

// ── the mintable half is re-based onto the FRESH probe ──────────────────────
//
// Every claw-capacity figure runner-health publishes is `standing + mintable`,
// and the mintable addend is a pure function of the ssh probe: the health tick
// reads it every 10 minutes, this route holds it at 60 seconds. Under all-JIT
// that addend is the WHOLE fleet, so serving the tick-time copy rendered a
// healthy garage as a dark one for ten minutes after every deploy.

const ALL_JIT = {
	'claw-1': { cores: 8, maxConcurrent: 3, labels: ['hadoku-builder'], ephemeral: true },
	'claw-2': { cores: 8, maxConcurrent: 2, labels: ['hadoku-builder'], ephemeral: true },
	hokon: { cores: 12, maxConcurrent: 4, labels: ['pm2-host'] },
};

test('a blind-window health tick does NOT render as a dark fleet', () => {
	// The exact shape measured on 2026-09-02: mgmt-api restarted at 15:34:00,
	// the health tick ran at 15:34:19 with no probe yet and published zeroes,
	// and the probe at 15:36:09 showed both claws up with three free mint slots.
	const r = buildFleetReport(
		health({
			clawsOnline: 0,
			claws_free: 0,
			claws_free_standing: 0,
			claws_free_mintable: 0,
			claws_mintable_online: 0,
			ephemeral_unknown: true,
		}),
		{
			at: 'fresh',
			nodes: {
				'claw-1': upProbe({ workers: 0, capacity: 2, free: 2 }),
				'claw-2': upProbe({ workers: 0, capacity: 1, free: 1 }),
			},
		},
		ALL_JIT,
		NO_JOBS
	);
	// 5, not the probes' `free` of 2+1: these are ephemeral nodes, so the figure
	// counts what the DISPATCHER will admit (maxConcurrent 3 and 2, no workers)
	// rather than what the tier ladder budgets. The assertion this test exists
	// for is that it is non-zero and came from the FRESH probe — the blind-window
	// tick published zeroes.
	assert.equal(slot(r, 'mintable'), 5, 'the fresh probe is what the panel shows');
	assert.ok(slot(r, 'mintable')! > 0, 'a measured fleet is not a dark one');
	assert.equal(r.fleet.clawsOnline, 2, 'two reachable JIT claws, not zero');
	assert.equal(r.fleet.capacity.free, 5, 'standing 0 + mintable 5');
	assert.equal(r.fleet.capacity.unmeasured, false, 'we DID look — this route had the probe');
});

test('the STANDING half is left to the census, not re-derived', () => {
	// It depends on the runner listing, which only the 10-minute loop holds.
	// A panel showing a fresh probe beside a stale listing is what the two
	// timestamps in the header are for.
	const r = buildFleetReport(
		health({
			clawsOnline: 5,
			claws_free: 4,
			claws_free_standing: 4,
			claws_free_mintable: 0,
			claws_mintable_online: 0,
		}),
		{ at: 'fresh', nodes: { 'claw-1': upProbe({ free: 2 }) } },
		ALL_JIT,
		NO_JOBS
	);
	assert.equal(slot(r, 'immediate'), 4, 'untouched');
	// claw-2 is declared ephemeral and absent from a snapshot that EXISTS, so it
	// counts down — guessing upward is how a real outage stays invisible.
	assert.equal(slot(r, 'mintable'), 2);
	assert.equal(r.fleet.clawsOnline, 5 - 0 + 1, 'standing 5 re-based with one live claw');
});

test('NO probe at all on an ephemeral fleet is UNMEASURED, not zero', () => {
	const r = buildFleetReport(
		health({ clawsOnline: 0, claws_free: 0, claws_free_standing: 0, claws_mintable_online: 0 }),
		null,
		ALL_JIT,
		NO_JOBS
	);
	assert.equal(r.fleet.capacity.unmeasured, true);
	assert.equal(slot(r, 'mintable'), null, 'null, never 0 — the panel must say so');
});

test('a fleet with no ephemeral nodes is always MEASURED, probe or not', () => {
	// `ephemeralUnknown` must not fire on a purely standing fleet, or the panel
	// would caveat every number forever on a fleet that has nothing to mint.
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	assert.equal(r.fleet.capacity.unmeasured, false);
});

// ── clawsReady: MACHINES, not slots ─────────────────────────────────────────
//
// The panel led with `clawsFree`, which counts SLOTS. On an all-JIT fleet that
// is routinely larger than the fleet itself — "0 standing · 10 mintable" over
// six machines — and reads as a bug rather than as capacity.

test('clawsReady counts MACHINES that can take a job, not their slots', () => {
	const r = buildFleetReport(
		health({
			claws_ready: 0,
			claws_ready_standing: 0,
			claws_free_standing: 0,
			claws_mintable_online: 0,
			clawsOnline: 0,
		}),
		{
			at: 'fresh',
			nodes: {
				// Three machines, six slots between them.
				'claw-1': upProbe({ workers: 0, capacity: 3, free: 3 }),
				'claw-2': upProbe({ workers: 0, capacity: 2, free: 2 }),
				'claw-3': upProbe({ workers: 0, capacity: 1, free: 1 }),
			},
		},
		{
			'claw-1': { maxConcurrent: 3, labels: [], ephemeral: true },
			'claw-2': { maxConcurrent: 2, labels: [], ephemeral: true },
			'claw-3': { maxConcurrent: 1, labels: [], ephemeral: true },
		},
		NO_JOBS
	);
	assert.equal(r.fleet.capacity.ready, 3, 'three machines');
	assert.equal(slot(r, 'mintable'), 6, 'six slots — a different question');
});

test('a machine with no free slot is ONLINE but not READY', () => {
	// The distinction the headline needs: a saturated fleet is fully online.
	const r = buildFleetReport(
		health({ claws_ready_standing: 0, claws_mintable_online: 0, clawsOnline: 0 }),
		{
			at: 'fresh',
			nodes: {
				'claw-1': upProbe({ workers: 2, capacity: 2, free: 0 }),
				'claw-2': upProbe({ workers: 0, capacity: 2, free: 2 }),
			},
		},
		{
			'claw-1': { maxConcurrent: 2, labels: [], ephemeral: true },
			'claw-2': { maxConcurrent: 2, labels: [], ephemeral: true },
		},
		NO_JOBS
	);
	assert.equal(r.fleet.clawsOnline, 2, 'both boxes are up');
	assert.equal(r.fleet.capacity.ready, 1, 'only one can take the next job');
});

test('clawsReady re-bases onto the fresh probe like every other mintable figure', () => {
	// The blind-window rule, applied to the headline number. A health tick taken
	// 20s after a restart publishes zeroes; the route holds a 60s-old probe.
	const r = buildFleetReport(
		health({ claws_ready: 0, claws_ready_standing: 0, claws_mintable_online: 0, clawsOnline: 0 }),
		{ at: 'fresh', nodes: { 'claw-1': upProbe({ workers: 0, capacity: 2, free: 2 }) } },
		{ 'claw-1': { maxConcurrent: 2, labels: [], ephemeral: true } },
		NO_JOBS
	);
	assert.equal(r.fleet.capacity.ready, 1, 'the fresh probe wins, as it does for state');
});

test('with NO probe, clawsReady falls back to the tick rather than inventing one', () => {
	const r = buildFleetReport(
		health({ claws_ready: 4, claws_ready_standing: 4, claws_mintable_online: 0 }),
		null,
		MANIFEST,
		NO_JOBS
	);
	assert.equal(r.fleet.capacity.ready, 4);
});

test('floorBreach is GONE from the wire', () => {
	// It was computed from ONLINE STANDING runners carrying each required label,
	// so on an all-JIT fleet — where nothing standing carries any label — it read
	// true permanently while work was being placed and completed normally. Its
	// only consumer was a red banner saying every job would queue, which was
	// false every time it rendered. `checkLabelFloor` is the real alert and is
	// untouched.
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	assert.equal('floorBreach' in r.fleet, false, 'a field both wrong and unread is not a contract');
});

// ── the budget that actually admits work ────────────────────────────────────
//
// `capacity`/`free` are the TIER LADDER's numbers. On an ephemeral node the
// ladder gates nothing — `ephemeral-tick` builds its candidate list from every
// ephemeral node and uses the ladder only as a preference order, and
// `admitMint` tests `maxConcurrent`. Showing the ladder's number as
// "schedulable" printed "full" on nodes with room to mint twice more.

const ADMISSION_MANIFEST = {
	// tierCapacity 1, but the dispatcher will run 3 at once.
	'claw-3': { cores: 4, maxConcurrent: 3, labels: [], ephemeral: true },
	// A standing node: the ladder's budget is the real one.
	hokon: { cores: 12, maxConcurrent: 4, labels: ['pm2-host'] },
};

test('an EPHEMERAL node is measured against the dispatcher budget', () => {
	const r = buildFleetReport(
		null,
		{
			at: 'now',
			nodes: { 'claw-3': upProbe({ workers: 1, capacity: 1, free: 0 }) },
		},
		ADMISSION_MANIFEST,
		NO_JOBS
	);
	const c = r.machines.find((m) => m.name === 'claw-3')!;
	assert.equal(c.free, 0, "the ladder's number is untouched");
	assert.equal(c.capacity, 1, 'and so is its denominator');
	assert.equal(c.admissionFree, 2, 'maxConcurrent 3 - 1 worker: two more mints fit');
	assert.equal(c.admissionCapacity, 3);
	assert.equal(c.admissionBasis, 'dispatcher');
});

test('a STANDING node is admitted against its probed budget, and says so', () => {
	const r = buildFleetReport(
		null,
		{ at: 'now', nodes: { hokon: upProbe({ workers: 1, capacity: 4, free: 3 }) } },
		ADMISSION_MANIFEST,
		NO_JOBS
	);
	const h = r.machines.find((m) => m.name === 'hokon')!;
	assert.equal(h.admissionFree, 3);
	assert.equal(h.admissionCapacity, 4);
	assert.equal(h.admissionBasis, 'standing');
});

test('admission is null when the node was not reached — never a guess', () => {
	const r = buildFleetReport(
		null,
		{ at: 'now', nodes: { 'claw-3': upProbe({ reachable: false }) } },
		ADMISSION_MANIFEST,
		NO_JOBS
	);
	const c = r.machines.find((m) => m.name === 'claw-3')!;
	assert.equal(c.admissionFree, null);
	assert.equal(c.admissionBasis, null);
});

test('more workers than the budget clamps to 0, never negative', () => {
	// A budget lowered while jobs were running. A negative free renders as a bar
	// running backwards over its neighbours.
	const r = buildFleetReport(
		null,
		{ at: 'now', nodes: { 'claw-3': upProbe({ workers: 9, capacity: 1, free: 0 }) } },
		ADMISSION_MANIFEST,
		NO_JOBS
	);
	assert.equal(r.machines.find((m) => m.name === 'claw-3')!.admissionFree, 0);
});

test('clawsFreeMintable counts what can actually START', () => {
	// The headline card's slot figure. Summing the ladder's numbers reported 7
	// where the dispatcher would take 12 (measured 2026-09-02, six JIT claws).
	const r = buildFleetReport(
		health({ claws_ready_standing: 0, claws_mintable_online: 0, clawsOnline: 0 }),
		{
			at: 'now',
			nodes: {
				'claw-3': upProbe({ workers: 1, capacity: 1, free: 0 }),
				'claw-9': upProbe({ workers: 0, capacity: 1, free: 1 }),
			},
		},
		{
			...ADMISSION_MANIFEST,
			'claw-9': { cores: 8, maxConcurrent: 2, labels: [], ephemeral: true },
		},
		NO_JOBS
	);
	// ladder would say 0 + 1 = 1; the dispatcher will take (3-1) + (2-0) = 4.
	assert.equal(slot(r, 'mintable'), 4);
});

test('the ladder inputs are NOT re-based — that would move the backstop', () => {
	// `capacity`/`free` feed worstRepoFreeSlots -> decideTiers, and the census's
	// own clawsFree gates isAtCapacity -> a saturation promote of the production
	// host. Re-basing them here would be a scheduling change dressed as a display
	// fix, so the probe's numbers must survive untouched.
	const probe = { at: 'now', nodes: { 'claw-3': upProbe({ workers: 1, capacity: 1, free: 0 }) } };
	const r = buildFleetReport(null, probe, ADMISSION_MANIFEST, NO_JOBS);
	assert.equal(probe.nodes['claw-3'].free, 0, 'the probe object itself is not mutated');
	assert.equal(r.machines.find((m) => m.name === 'claw-3')!.free, 0);
});

// ── job phases travel with the numbers ──────────────────────────────────────
//
// The panel carried its own table of four phases — id, label and meaning — and
// when queueSec gained a dispatch/assign split it did not fail to compile. It
// kept drawing one `queued` block over two numbers that name different people
// to go and fix.

test('vocabulary.jobPhases is ordered and every field is a real record field', () => {
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	const ids = r.vocabulary.jobPhases.map((p) => p.id);
	assert.deepEqual(ids, ['queue', 'setup', 'run', 'cleanup'], 'order is the fleet’s to state');
	// A phase naming a field the record does not carry renders an empty segment
	// forever, silently — the exact failure mode of a hand-kept table.
	const record: JobRecord = {
		runId: 1,
		jobId: 2,
		repo: 'WolffM/x',
		name: 'build',
		runner: 'claw-1',
		labels: [],
		startedAt: '2026-09-04T00:00:00Z',
		durationSec: 30,
		queueSec: 10,
		dispatchSec: 8,
		assignSec: 2,
		setupSec: 3,
		runSec: 25,
		cleanupSec: 2,
		conclusion: 'success',
	};
	const flat = r.vocabulary.jobPhases.flatMap((p) => [p, ...(p.detail ?? [])]);
	for (const p of flat) {
		assert.ok(p.field in record, `${p.id} names ${p.field}, which is not on FleetJobRecord`);
		assert.ok(p.description.length > 10, `${p.id} has no usable description`);
	}
});

test('queue declares its split as DETAIL, and the halves sum to it', () => {
	// A renderer draws detail INSTEAD of the parent, so if these did not sum the
	// bar would change length depending on which records happened to carry the
	// split.
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	const queue = r.vocabulary.jobPhases.find((p) => p.id === 'queue')!;
	assert.deepEqual(
		queue.detail?.map((d) => d.id),
		['dispatch', 'assign']
	);
	assert.deepEqual(
		queue.detail?.map((d) => d.field),
		['dispatchSec', 'assignSec']
	);
	// The one thing a reader must be able to tell apart: which half is ours.
	assert.match(queue.detail![0].description, /OURS/);
	assert.match(queue.detail![1].description, /GITHUB/);
});

test('the split reaches the WIRE, not just the store', () => {
	// It was derived and stored on 2026-09-03 and typed on 2026-09-04. In between
	// `jobs.recent` passed whole JobRecords through, so the values were on the
	// wire while the contract declared nothing — unreadable by a typed consumer
	// and unpinnable by the guard below.
	const record: RecentJobRecord = {
		runId: 1,
		jobId: 2,
		repo: 'WolffM/x',
		name: 'build',
		runner: 'jit-claw-1-x',
		machine: 'claw-1',
		labels: [],
		startedAt: '2026-09-04T00:00:00Z',
		durationSec: 30,
		queueSec: 10,
		dispatchSec: 8,
		assignSec: 2,
		conclusion: 'success',
	};
	const r = buildFleetReport(null, null, MANIFEST, {
		...NO_JOBS,
		total: 1,
		since: record.startedAt,
		recent: [record],
	});
	const out = r.jobs.recent[0];
	assert.equal(out.dispatchSec, 8);
	assert.equal(out.assignSec, 2);
	assert.equal(out.dispatchSec! + out.assignSec!, out.queueSec, 'the halves sum to the total');
});

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

// ---------------------------------------------------------------------------
// fetchJobForBackfill: moved onto github-client.ts's `ghFetchRaw` (plan §4.1
// F2b) — extracted to a named export so this behaviour (especially that a
// network failure never reports `expired: true`) can be pinned directly.
// This closure had NO test coverage at all before this wave: every existing
// `backfillFailedSteps` test injects its own fetch-like callback and never
// exercised the real one inline in the route.
// ---------------------------------------------------------------------------

test('fetchJobForBackfill: a successful read parses the job, expired: false', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ id: 1, conclusion: 'failure', steps: [] }), {
			status: 200,
		})) as typeof fetch;
	try {
		const r = await fetchJobForBackfill('WolffM/x', 1, 'tok');
		assert.deepEqual(r, { job: { id: 1, conclusion: 'failure', steps: [] }, expired: false });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('fetchJobForBackfill: a 404 is EXPIRED — the job aged out of GitHub, stop asking', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
	try {
		const r = await fetchJobForBackfill('WolffM/x', 1, 'tok');
		assert.deepEqual(r, { job: null, expired: true });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('fetchJobForBackfill: a non-404 failure is NOT expired — worth another pass', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch;
	try {
		const r = await fetchJobForBackfill('WolffM/x', 1, 'tok');
		assert.deepEqual(r, { job: null, expired: false });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('fetchJobForBackfill: a network failure never throws and is never reported expired', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw new Error('ECONNRESET');
	}) as typeof fetch;
	try {
		const r = await fetchJobForBackfill('WolffM/x', 1, 'tok');
		assert.deepEqual(r, { job: null, expired: false });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('fetchJobForBackfill: the User-Agent names THIS package, not the mgmt-api leftover', async () => {
	const originalFetch = globalThis.fetch;
	let seenUserAgent: string | undefined;
	globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
		seenUserAgent = (init?.headers as Record<string, string> | undefined)?.['User-Agent'];
		return new Response(JSON.stringify({ id: 1 }), { status: 200 });
	}) as typeof fetch;
	try {
		await fetchJobForBackfill('WolffM/x', 1, 'tok');
		assert.ok(seenUserAgent, 'a User-Agent header must be sent at all');
		assert.doesNotMatch(
			seenUserAgent!,
			/hadoku-mgmt-api/,
			'the pre-extraction literal must not survive this move'
		);
		assert.match(seenUserAgent!, /job-history-backfill/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
