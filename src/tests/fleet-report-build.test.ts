/**
 * Fleet panel data contract: `probeFleet`'s own free-slot arithmetic,
 * `buildFleetReport`'s handling of an unprobed/down/healthy node and of a
 * manifest that fails to load or load correctly, and the vocabulary block
 * that lets the command station derive label names, the ladder and the
 * backstop node instead of holding its own copy. Split out of
 * fleet-report.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/fleet-report-rig.ts` for the shared `NO_JOBS`/`MANIFEST`/
 * `upProbe` fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildFleetReport } from '../routes/fleet-report.js';
import { probeFleet } from '../lib/node-probe.js';
import {
	__resetJobHistoryForTesting,
	__setHistoryPathForTesting,
	type JobRecord,
} from '../job-history-store.js';
import { testStateDir, testHost } from './install-test-host.js';
import { __setHostForTesting } from '../host.js';
import { NO_JOBS, MANIFEST, upProbe, installFleetReportRig } from './helpers/fleet-report-rig.js';

installFleetReportRig();

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
