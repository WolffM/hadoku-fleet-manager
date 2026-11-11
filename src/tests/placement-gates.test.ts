/**
 * Tests for the direct `choosePlacement`-level gates: per-repo exclusion
 * (#82), the slow-tier spill gate (#83), the per-KIND hold for a node that
 * is slow at only one job name (#8), and the backstop reserve that keeps
 * overflow from taking a sole carrier's last slot or its last job of memory
 * (#15). Each also has a WARM PATH counterpart proving `dispatchWarmCache`
 * enforces the same gate against the real `buildSpeedModel`. Split out of
 * placement.test.ts (wave 5o lane B) — see `src/tests/helpers/placement-rig.ts`
 * for the shared `m()`/`ORDER`/`WIRE_NODE`/`NodeSim`/`simShell`/`wireTmp`/
 * speed-history-clock fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { choosePlacement } from '../runners/placement.js';
import {
	BACKSTOP_SOLE_CARRIER_SLOTS,
	slowKind,
	slowReposOn,
	SPILL_FLOOR_SEC,
} from '../runners/placement-slow.js';
import { type NodeState } from '../runners/placement-node-state.js';
import { buildSpeedModel, type SpeedModel, type SpeedTier } from '../runners/speed-tier.js';
import type { EphemeralTickInput } from '../runners/ephemeral-shared.js';
import { dispatchWarmCache } from '../runners/dispatch-warm-cache.js';
import { warmRunnerName } from '../lib/jit-naming.js';
import { type JobRecord } from '../job-history-store.js';
import { fakeGh } from './helpers/fleet-fakes.js';
import {
	m,
	WIRE_NODE,
	type NodeSim,
	simShell,
	wireTmp,
	SPEED_DEMAND_AT,
	SPEED_NOW,
	installPlacementRig,
} from './helpers/placement-rig.js';

installPlacementRig();

// ---------------------------------------------------------------------------
// #82: per-repo exclusion — NodeState.excludedRepos
// ---------------------------------------------------------------------------

test('a per-repo exclusion refuses the named repo, with the manifest’s own reason', () => {
	const node = m('claw-5', {
		excludedRepos: new Map([['WolffM/hadoku-cardtable', '5s vitest timeouts, run 37109806015']]),
	});
	const other = m('claw-1');
	const p = choosePlacement(['claw-5', 'claw-1'], [node, other], [], 'WolffM/hadoku-cardtable');
	assert.equal(p.node, 'claw-1');
	assert.match(p.passed[0].reason, /repo excluded here: 5s vitest timeouts, run 37109806015/);
});

test('the SAME exclusion leaves a DIFFERENT repo on that node untouched', () => {
	const node = m('claw-5', {
		excludedRepos: new Map([['WolffM/hadoku-cardtable', 'too slow']]),
	});
	const p = choosePlacement(['claw-5'], [node], [], 'WolffM/some-other-repo');
	assert.equal(p.node, 'claw-5');
});

test('excludedRepos is never consulted when no `repo` is supplied — today’s walk, unchanged', () => {
	const node = m('claw-5', {
		excludedRepos: new Map([['WolffM/hadoku-cardtable', 'too slow']]),
	});
	assert.equal(choosePlacement(['claw-5'], [node]).node, 'claw-5');
});

test('a node with no excludedRepos map at all excludes nothing', () => {
	assert.equal(choosePlacement(['claw-5'], [m('claw-5')], [], 'WolffM/anything').node, 'claw-5');
});

// ---------------------------------------------------------------------------
// #83: the slow-tier spill gate
// ---------------------------------------------------------------------------

/**
 * A fake satisfying the FIXED B->A interface (`docs/planning/wave3w-2026-10-03.md`),
 * built structurally rather than imported from `speed-tier.ts` — these tests
 * assert placement's OWN gating logic, not lane B's tier thresholds, so a fake
 * with full per-node control is the right double, not a real model over a
 * fixture.
 */
function fakeSpeedModel(
	opts: {
		tierFor?: (node: string) => SpeedTier;
		extraSecFor?: (node: string, repo: string, jobName: string | undefined) => number | null;
		p25For?: (node: string) => number | null;
		p50For?: (node: string) => number | null;
	} = {}
): SpeedModel {
	const tierFor = opts.tierFor ?? (() => 'normal' as SpeedTier);
	return {
		tierOf: tierFor,
		expectedExtraSec: (node, repo, jobName) => opts.extraSecFor?.(node, repo, jobName) ?? null,
		describe: (node) => ({
			tier: tierFor(node),
			p25: opts.p25For?.(node) ?? null,
			p50: opts.p50For?.(node) ?? null,
			kinds: 5,
		}),
	};
}

const SLOW = (n: string) => n === 'claw-5';

test('slow tier: refused below its spill threshold, and a normal node with room takes it instead', () => {
	const speedModel = fakeSpeedModel({
		tierFor: (n) => (SLOW(n) ? 'slow' : 'normal'),
		extraSecFor: () => 170,
		p25For: (n) => (SLOW(n) ? 2.07 : null),
	});
	const slow = m('claw-5', { speedModel });
	const normal = m('claw-1', { speedModel });
	const p = choosePlacement(['claw-5', 'claw-1'], [slow, normal], [], 'WolffM/hadoku-cardtable', {
		queuedSec: 41,
		jobName: 'check',
	});
	assert.equal(p.node, 'claw-1');
	assert.match(
		p.passed[0].reason,
		/slow tier: holding for a faster node \(queued 41s < 170s; claw-5 p25 2\.07\)/
	);
});

test('slow tier: once every normal node is full, the slow node takes the job past its threshold', () => {
	const speedModel = fakeSpeedModel({
		tierFor: (n) => (SLOW(n) ? 'slow' : 'normal'),
		extraSecFor: () => 170,
		p25For: (n) => (SLOW(n) ? 2.07 : null),
	});
	const slow = m('claw-5', { speedModel });
	const full = m('claw-1', { speedModel, liveUnits: 3 });
	const order = ['claw-1', 'claw-5'];

	const below = choosePlacement(order, [full, slow], [], 'WolffM/hadoku-cardtable', {
		queuedSec: 41,
	});
	assert.equal(
		below.node,
		undefined,
		'the normal node is full and the slow one has not waited long enough'
	);

	const past = choosePlacement(order, [full, slow], [], 'WolffM/hadoku-cardtable', {
		queuedSec: 171,
	});
	assert.equal(past.node, 'claw-5', 'past the threshold, the slow node is the only room left');
});

test('a job whose queue age is UNKNOWN is never spilled onto a slow node', () => {
	const speedModel = fakeSpeedModel({
		tierFor: (n) => (SLOW(n) ? 'slow' : 'normal'),
		extraSecFor: () => 170,
		p25For: () => 2.07,
	});
	const slow = m('claw-5', { speedModel });
	// No `spill` argument at all — the same as a caller that never computed one.
	const p1 = choosePlacement(['claw-5'], [slow], [], 'WolffM/hadoku-cardtable');
	assert.equal(p1.node, undefined);
	assert.match(p1.passed[0].reason, /queued unknown/);
	// Explicit `undefined` must behave identically — never coerced into "waited
	// long enough" by an arithmetic comparison against `undefined`.
	const p2 = choosePlacement(['claw-5'], [slow], [], 'WolffM/hadoku-cardtable', {
		queuedSec: undefined,
	});
	assert.equal(p2.node, undefined);
});

test('a null expectedExtraSec falls back to the floor scaled by the node’s own p50 ratio, not zero', () => {
	const speedModel = fakeSpeedModel({
		tierFor: (n) => (SLOW(n) ? 'slow' : 'normal'),
		extraSecFor: () => null,
		p50For: () => 2,
	});
	const slow = m('claw-5', { speedModel });
	// threshold = SPILL_FLOOR_SEC (100) * p50 (2) = 200
	const below = choosePlacement(['claw-5'], [slow], [], 'WolffM/hadoku-cardtable', {
		queuedSec: 199,
	});
	assert.equal(below.node, undefined);
	const past = choosePlacement(['claw-5'], [slow], [], 'WolffM/hadoku-cardtable', {
		queuedSec: 201,
	});
	assert.equal(past.node, 'claw-5');
});

test('a null extra with no p50 either still floors at SPILL_FLOOR_SEC — never zero', () => {
	const speedModel = fakeSpeedModel({
		tierFor: (n) => (SLOW(n) ? 'slow' : 'normal'),
		extraSecFor: () => null,
	});
	const slow = m('claw-5', { speedModel });
	const justBelow = choosePlacement(['claw-5'], [slow], [], 'WolffM/x', {
		queuedSec: SPILL_FLOOR_SEC - 1,
	});
	assert.equal(justBelow.node, undefined);
	const justPast = choosePlacement(['claw-5'], [slow], [], 'WolffM/x', {
		queuedSec: SPILL_FLOOR_SEC + 1,
	});
	assert.equal(justPast.node, 'claw-5');
});

test('"unknown" tier is placed like "normal" — it is never held back, however long it has queued', () => {
	const speedModel = fakeSpeedModel({ tierFor: () => 'unknown' });
	const node = m('claw-7', { speedModel });
	const p = choosePlacement(['claw-7'], [node], [], 'WolffM/some-repo', { queuedSec: 0 });
	assert.equal(p.node, 'claw-7');
});

test('no speedModel attached at all means no spill gate — today’s walk, unchanged', () => {
	const p = choosePlacement(['claw-5'], [m('claw-5')], [], 'WolffM/x', { queuedSec: 0 });
	assert.equal(p.node, 'claw-5');
});

test('a slow node that is ALSO full refuses on capacity, not on the spill wait', () => {
	const speedModel = fakeSpeedModel({
		tierFor: (n) => (SLOW(n) ? 'slow' : 'normal'),
		extraSecFor: () => 170,
	});
	const node = m('claw-5', { speedModel, liveUnits: 3 });
	const p = choosePlacement(['claw-5'], [node], [], 'WolffM/x', { queuedSec: 500 });
	assert.equal(p.node, undefined);
	assert.match(p.passed[0].reason, /at capacity/);
});

// ---------------------------------------------------------------------------
// #8: a NORMAL node that is slow at ONE kind holds that kind, not the rest
// ---------------------------------------------------------------------------

const KIND_REPO = 'WolffM/hadoku-dataplatform';

/** History where claw-1 runs `e2e` at ~3x the others (a timeout and a long
 * failure) and `lint` at par; claw-2/claw-4 are the baseline. The REAL model:
 * the thresholds under test are placement's, over the model's own reading. */
function kindHistory(startedAt: string): JobRecord[] {
	let id = 1;
	const r = (name: string, runner: string, runSec: number, conclusion = 'success'): JobRecord => ({
		repo: KIND_REPO,
		runId: id,
		jobId: id++,
		name,
		runner,
		labels: [],
		startedAt,
		durationSec: runSec,
		runSec,
		conclusion,
	});
	const out: JobRecord[] = [];
	for (const node of ['claw-2', 'claw-4']) {
		for (let i = 0; i < 5; i++) out.push(r('e2e', node, 1500), r('lint', node, 60));
	}
	out.push(r('e2e', 'claw-1', 3600, 'cancelled'), r('e2e', 'claw-1', 4920, 'failure'));
	out.push(r('lint', 'claw-1', 61), r('lint', 'claw-1', 59));
	return out;
}

const KIND_NOW = Date.parse('2026-10-27T12:00:00Z');
const kindModel = () =>
	buildSpeedModel(kindHistory('2026-10-26T12:00:00Z'), {
		nowMs: KIND_NOW,
		nodes: ['claw-1', 'claw-2', 'claw-4'],
	});

test('#8: a normal-tier node holds the ONE kind it runs slowly, for as long as it would cost', () => {
	const speedModel = kindModel();
	assert.notEqual(speedModel.tierOf('claw-1'), 'slow', 'the tier gate is not what holds it');
	const claw1 = m('claw-1', { speedModel });
	const claw2 = m('claw-2', { speedModel });
	const p = choosePlacement(['claw-1', 'claw-2'], [claw1, claw2], [], KIND_REPO, {
		queuedSec: 30,
		jobName: 'e2e',
	});
	assert.equal(p.node, 'claw-2');
	assert.match(
		p.passed[0].reason,
		/slow kind: holding for a faster node \(queued 30s < 2760s; e2e runs 2\.84x here \(\+2760s, 2 run\(s\), 2 unfinished\)\)/
	);
	assert.equal(p.passed[0].holdSec, 2760);
});

test('#8: the same node takes the kinds it runs at par, and the slow kind once it has waited', () => {
	const speedModel = kindModel();
	const claw1 = m('claw-1', { speedModel });
	const lint = choosePlacement(['claw-1'], [claw1], [], KIND_REPO, {
		queuedSec: 0,
		jobName: 'lint',
	});
	assert.equal(lint.node, 'claw-1');
	const e2eLate = choosePlacement(['claw-1'], [claw1], [], KIND_REPO, {
		queuedSec: 2761,
		jobName: 'e2e',
	});
	assert.equal(
		e2eLate.node,
		'claw-1',
		'past what it costs here, waiting longer is the worse trade'
	);
});

test('#8: an unknown queue age never spills onto a slow kind', () => {
	const claw1 = m('claw-1', { speedModel: kindModel() });
	const p = choosePlacement(['claw-1'], [claw1], [], KIND_REPO, { jobName: 'e2e' });
	assert.equal(p.node, undefined);
	assert.match(p.passed[0].reason, /queued unknown/);
});

test('#8: a kind slow by less than SPILL_FLOOR_SEC is never held — the hold would cost more', () => {
	const speedModel = fakeSpeedModel();
	speedModel.kindSlowness = (_n, repo, job) => ({
		repo,
		job,
		ratio: 5,
		extraSec: SPILL_FLOOR_SEC - 1,
		samples: 5,
		lowerBounds: 0,
	});
	assert.equal(slowKind(speedModel, 'claw-1', KIND_REPO, 'lint'), null);
	speedModel.kindSlowness = (_n, repo, job) => ({
		repo,
		job,
		ratio: 1.7,
		extraSec: 600,
		samples: 5,
		lowerBounds: 0,
	});
	assert.equal(slowKind(speedModel, 'claw-1', KIND_REPO, 'lint'), null, 'below SLOW_P25');
});

test('#8: slowReposOn names the repo with its slow kind, and nothing for a node at par', () => {
	const model = kindModel();
	assert.deepEqual(
		[...slowReposOn(model, 'claw-1')],
		[[KIND_REPO, 'slow kind: e2e runs 2.84x here (+2760s, 2 run(s), 2 unfinished)']]
	);
	assert.equal(slowReposOn(model, 'claw-2').size, 0);
	assert.equal(slowReposOn(undefined, 'claw-1').size, 0);
});

/** `kindHistory` written where the warm path's `getSpeedModel` reads it. */
function seedKindHistory(path: string, startedAt: string): void {
	for (const r of kindHistory(startedAt)) appendFileSync(path, JSON.stringify(r) + '\n');
}

test('WARM PATH, #8: a listener for a repo with a slow kind on this node is evicted', async () => {
	seedKindHistory(join(wireTmp, 'job-history.jsonl'), SPEED_DEMAND_AT);
	const unit = warmRunnerName('claw-1', KIND_REPO);
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: `${KIND_REPO} 1000`, active: new Set([unit]) },
	};
	const gh = fakeGh({ runners: [{ id: 1, name: unit, status: 'online', busy: false }] });
	const input: EphemeralTickInput = {
		fleetProbe: new Map([['claw-1', { reachable: true, busyRepos: null }]]),
		ephemeral: new Set(['claw-1']),
		nodes: { 'claw-1': WIRE_NODE, 'claw-2': WIRE_NODE, 'claw-4': WIRE_NODE },
		isSick: () => false,
		repos: [KIND_REPO],
		standingEligible: new Set(),
	};
	const res = await dispatchWarmCache(input, 'tok', gh, simShell(sims), SPEED_NOW);
	assert.equal(res.evicted, 1, 'a zero-wait listener would take the e2e the mint path holds');
	assert.equal(res.filled, 0, 'and the same repo is not put straight back');
});

test('WARM PATH, #8: a node where the repo has a slow kind is never filled with it', async () => {
	seedKindHistory(join(wireTmp, 'job-history.jsonl'), SPEED_DEMAND_AT);
	const sims: Record<string, NodeSim> = { 'claw-1': { marker: null, active: new Set() } };
	const input: EphemeralTickInput = {
		fleetProbe: new Map([['claw-1', { reachable: true, busyRepos: null }]]),
		ephemeral: new Set(['claw-1']),
		nodes: { 'claw-1': WIRE_NODE, 'claw-2': WIRE_NODE, 'claw-4': WIRE_NODE },
		isSick: () => false,
		repos: [KIND_REPO],
		standingEligible: new Set(),
	};
	const res = await dispatchWarmCache(input, 'tok', fakeGh({}), simShell(sims), SPEED_NOW);
	assert.equal(res.filled, 0);
	// fleet-manager#36: the allocator is told the exclusion, so it never
	// proposes the fill at all; there is nothing for the act loop to withhold.
	assert.equal(res.locked, 0, 'the allocator never offered the excluded repo');
	assert.equal(sims['claw-1'].marker, null);
});

// ---------------------------------------------------------------------------
// #15: overflow may not take a backstop's last slot, or its last job of memory
// ---------------------------------------------------------------------------

/** hokon as the backstop holds it: offered `hadoku-builder` beside its own labels. */
const backstop = (over: Partial<NodeState> = {}): NodeState =>
	m('hokon', {
		onDemandBackstop: true,
		labels: ['self-hosted', 'hadoku-builder', 'jdk21', 'av1-nvenc', 'pm2-host'],
		maxConcurrent: 4,
		freeMb: 40_000,
		requiredMb: 4096,
		minFreeMb: 8192,
		...over,
	});
/** A claw with no room: full, but a home for `hadoku-builder` by its labels. */
const fullClaw = (over: Partial<NodeState> = {}): NodeState =>
	m('claw-8', { labels: ['self-hosted', 'hadoku-builder', 'jdk21'], liveUnits: 3, ...over });

test('#15: a backstop at 3/4 refuses overflow, and still admits the job only it can run', () => {
	assert.equal(BACKSTOP_SOLE_CARRIER_SLOTS, 1);
	const nodes = [fullClaw(), backstop({ liveUnits: 3 })];
	const order = ['claw-8', 'hokon'];

	const forge = choosePlacement(order, nodes, ['self-hosted', 'hadoku-builder', 'jdk21']);
	assert.equal(forge.node, undefined, 'claw-8 carries jdk21, so this is overflow');
	assert.equal(
		forge.passed.find((p) => p.node === 'hokon')?.reason,
		'reserved for work only hokon can run: overflow may hold 3 of 4 slot(s), 3 in flight, ' +
			"and another node offers this job's labels"
	);

	const gpu = choosePlacement(order, nodes, ['self-hosted', 'av1-nvenc']);
	assert.equal(gpu.node, 'hokon', 'no other node offers av1-nvenc');
});

test('#15: under 3/4, overflow still lands on the backstop — the backstop keeps working', () => {
	const p = choosePlacement(
		['claw-8', 'hokon'],
		[fullClaw(), backstop({ liveUnits: 2 })],
		['self-hosted', 'hadoku-builder']
	);
	assert.equal(p.node, 'hokon');
});

test('#15: overflow must leave one more job of memory above the backstop floor', () => {
	// The 10-27 shape: 9,120 MB free against an 8,192 MB floor.
	const tight = backstop({ liveUnits: 1, freeMb: 16_000 });
	const p = choosePlacement(['claw-8', 'hokon'], [fullClaw(), tight], ['hadoku-builder']);
	assert.equal(p.node, undefined);
	assert.equal(
		p.passed.find((x) => x.node === 'hokon')?.reason,
		'reserved for work only hokon can run: memory: 16000MB free, this job peaks at 4096MB ' +
			'and 4096MB stays free for one more, would leave 7808MB against a 8192MB floor'
	);
	const gpu = choosePlacement(['hokon'], [fullClaw(), tight], ['av1-nvenc']);
	assert.equal(gpu.node, 'hokon', 'the sole-carrier job gets the memory the reserve kept');
});

test('#15: a claw that is down or drained is no home — the job is the backstop’s alone, and admitted', () => {
	for (const claw of [fullClaw({ healthy: false }), fullClaw({ drained: true })]) {
		const p = choosePlacement(['claw-8', 'hokon'], [claw, backstop({ liveUnits: 3 })], ['jdk21']);
		assert.equal(p.node, 'hokon');
	}
});

test('#15: a claw is never reserved, and a single-slot backstop keeps nothing back', () => {
	const claw = m('claw-2', { labels: ['hadoku-builder'], liveUnits: 2, maxConcurrent: 3 });
	const other = fullClaw();
	assert.equal(choosePlacement(['claw-2'], [claw, other], ['hadoku-builder']).node, 'claw-2');
	const one = backstop({ maxConcurrent: 1 });
	assert.equal(choosePlacement(['hokon'], [other, one], ['hadoku-builder']).node, 'hokon');
});

test('tuning (simulator only): spillFloorSec replaces the slow-tier floor; unset, the constant holds', () => {
	const speedModel = fakeSpeedModel({
		tierFor: (n) => (SLOW(n) ? 'slow' : 'normal'),
		extraSecFor: () => null,
		p50For: () => 1,
	});
	const full = m('claw-1', { speedModel, liveUnits: 3 });
	const at = (queuedSec: number, spillFloorSec?: number) =>
		choosePlacement(
			['claw-1', 'claw-5'],
			[
				full,
				m('claw-5', {
					speedModel,
					...(spillFloorSec === undefined ? {} : { tuning: { spillFloorSec } }),
				}),
			],
			[],
			'WolffM/hadoku-cardtable',
			{ queuedSec }
		).node;
	assert.equal(at(SPILL_FLOOR_SEC - 1), undefined, 'constant: held one second short');
	assert.equal(at(30, 20), 'claw-5', 'a 20 s floor spills at 30 s');
	assert.equal(at(30, 60), undefined);
});
