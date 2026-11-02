/**
 * Tests for the WARM path as a SECOND assignment path (#82, #83, #102.4): a
 * warm listener is a STANDING registration GitHub hands work to directly —
 * `choosePlacement` never sees it — so these prove `dispatchWarmCache`
 * itself enforces the slow-tier spill gate, the per-repo exclusion and the
 * heavy-busy withholding, live against the real `buildSpeedModel` (no fake —
 * the tier has to come from the same job history the model reads in
 * production). Split out of placement.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/placement-rig.ts` for the shared `WIRE_NODE`/`NodeSim`/
 * `simShell`/`wireTmp`/speed-history-clock fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EphemeralTickInput } from '../runners/ephemeral-shared.js';
import { dispatchWarmCache } from '../runners/dispatch-warm-cache.js';
import {
	__markHeavyForTesting,
	__resetHeavyMarksForTesting,
} from '../runners/dispatch-pass-state.js';
import { warmRunnerName } from '../lib/jit-naming.js';
import { fakeGh } from './helpers/fleet-fakes.js';
import {
	WIRE_NODE,
	type NodeSim,
	simShell,
	wireTmp,
	SPEED_BASE_MS,
	SPEED_DEMAND_AT,
	SPEED_NOW,
	installPlacementRig,
} from './helpers/placement-rig.js';

installPlacementRig();

// ---------------------------------------------------------------------------
// SEND-BACK: the WARM path is a SECOND assignment path (#82, #83)
//
// A warm listener is a STANDING registration GitHub hands work to directly —
// `choosePlacement` never sees it. Everything above this line proves the JIT
// mint path enforces exclusions and the spill gate; these prove
// `dispatchWarmCache` does too, live, against the real `buildSpeedModel` (no
// fake — the tier has to come from the same job history the model reads in
// production).
// ---------------------------------------------------------------------------

/**
 * Seeds enough job history for `buildSpeedModel` to call `slowNode` 'slow'
 * against `fastNode`: `MIN_KINDS` (5) distinct job names, each with
 * `MIN_SAMPLES` (5) runs on both nodes, `slowNode` always `ratioX` times
 * `fastNode`'s duration — comfortably past `SLOW_P25` (1.8) at `ratioX: 2`.
 *
 * Written with `appendFileSync`, the same mechanism `job-history.ts` itself
 * reads back with `readFileSync` — no second parser, just the test's own
 * fixture data.
 */
function seedSpeedHistory(
	path: string,
	slowNode: string,
	fastNode: string,
	baseMs: number,
	ratioX = 2
): void {
	const startedAt = new Date(baseMs);
	for (let kind = 0; kind < 5; kind++) {
		const name = `job-kind-${kind}`;
		for (let i = 0; i < 5; i++) {
			startedAt.setSeconds(startedAt.getSeconds() + 1);
			appendFileSync(
				path,
				JSON.stringify({
					repo: 'WolffM/speed-fixture',
					runId: 9_000_000 + kind * 10 + i,
					jobId: 9_000_000 + kind * 10 + i,
					name,
					runner: fastNode,
					labels: [],
					startedAt: startedAt.toISOString(),
					durationSec: 100,
					runSec: 100,
					conclusion: 'success',
				}) + '\n'
			);
			startedAt.setSeconds(startedAt.getSeconds() + 1);
			appendFileSync(
				path,
				JSON.stringify({
					repo: 'WolffM/speed-fixture',
					runId: 9_100_000 + kind * 10 + i,
					jobId: 9_100_000 + kind * 10 + i,
					name,
					runner: slowNode,
					labels: [],
					startedAt: startedAt.toISOString(),
					durationSec: 100 * ratioX,
					runSec: 100 * ratioX,
					conclusion: 'success',
				}) + '\n'
			);
		}
	}
}

/** One served job, for `fleetServedJobs()`'s demand signal — attributed to a
 *  node OUTSIDE the fixture under test so it cannot move that node's own
 *  speed tier, only `planWarmFleet`'s valuation of the repo. */
function seedDemand(path: string, repo: string, atIso: string): void {
	appendFileSync(
		path,
		JSON.stringify({
			repo,
			runId: 1,
			jobId: 1,
			name: 'check',
			runner: 'hokon',
			labels: [],
			startedAt: atIso,
			durationSec: 60,
			runSec: 60,
			conclusion: 'success',
		}) + '\n'
	);
}

const SPEED_WARM_REPO = 'WolffM/hadoku_site';

test('WARM PATH, #83: a slow-tier node holding a listener is evicted, and never filled again', async () => {
	const historyPath = join(wireTmp, 'job-history.jsonl');
	seedSpeedHistory(historyPath, 'claw-5', 'claw-1', SPEED_BASE_MS);
	seedDemand(historyPath, SPEED_WARM_REPO, SPEED_DEMAND_AT);
	const unit = warmRunnerName('claw-5', SPEED_WARM_REPO);
	const sims: Record<string, NodeSim> = {
		'claw-5': { marker: `${SPEED_WARM_REPO} 1000`, active: new Set([unit]) },
	};
	const gh = fakeGh({ runners: [{ id: 1, name: unit, status: 'online', busy: false }] });
	const input: EphemeralTickInput = {
		fleetProbe: new Map([['claw-5', { reachable: true, busyRepos: null }]]),
		ephemeral: new Set(['claw-5']),
		nodes: { 'claw-5': WIRE_NODE },
		isSick: () => false,
		repos: [SPEED_WARM_REPO],
		standingEligible: new Set(),
	};
	const res = await dispatchWarmCache(input, 'tok', gh, simShell(sims), SPEED_NOW);
	assert.equal(res.evicted, 1, 'the slow node’s existing listener is evicted');
	assert.equal(
		res.filled,
		0,
		'and never refilled — a slow node is excluded from the allocation entirely'
	);
	assert.equal(res.kept, 0);
});

test('WARM PATH: one node’s eviction throwing does not take down the rest of the pass', async () => {
	// claw-5 (slow tier, holding a listener) throws partway through its own
	// eviction — `evictWarmListener`'s `sh` call, `systemctl --user stop`,
	// which this test makes reject. Before the pre-pass had its own
	// try/catch, this exception propagated out of the whole pre-pass loop:
	// claw-2's fill below never ran, `setWarmRepos` never published, and the
	// SAME throw would recur every WARM_CACHE_INTERVAL_MS tick forever.
	const historyPath = join(wireTmp, 'job-history.jsonl');
	seedSpeedHistory(historyPath, 'claw-5', 'claw-1', SPEED_BASE_MS);
	seedDemand(historyPath, SPEED_WARM_REPO, SPEED_DEMAND_AT);
	const unit = warmRunnerName('claw-5', SPEED_WARM_REPO);
	const sims: Record<string, NodeSim> = {
		'claw-5': { marker: `${SPEED_WARM_REPO} 1000`, active: new Set([unit]) },
		'claw-2': { marker: null, active: new Set() },
	};
	const baseSh = simShell(sims);
	const throwingSh = async (node: string, cmd: string): Promise<string | null> => {
		if (node === 'claw-5' && cmd.includes('systemctl --user stop')) {
			throw new Error('ssh: connection reset by peer');
		}
		return baseSh(node, cmd);
	};
	const gh = fakeGh({ runners: [{ id: 1, name: unit, status: 'online', busy: false }] });
	const input: EphemeralTickInput = {
		fleetProbe: new Map([
			['claw-5', { reachable: true, busyRepos: null }],
			['claw-2', { reachable: true, busyRepos: null }],
		]),
		ephemeral: new Set(['claw-5', 'claw-2']),
		nodes: { 'claw-5': WIRE_NODE, 'claw-2': WIRE_NODE },
		isSick: () => false,
		repos: [SPEED_WARM_REPO],
		standingEligible: new Set(),
	};
	const res = await dispatchWarmCache(input, 'tok', gh, throwingSh, SPEED_NOW);
	assert.equal(res.failed, 1, 'claw-5’s thrown eviction is counted, not silently lost');
	assert.equal(
		res.filled,
		1,
		'claw-2 still gets its fill — one node’s throw does not reject the pass'
	);
	assert.equal(sims['claw-2'].marker, `${SPEED_WARM_REPO} 1000`);
});

test('WARM PATH, #82: a node whose CURRENT warm repo is excluded there is evicted', async () => {
	const historyPath = join(wireTmp, 'job-history.jsonl');
	const unit = warmRunnerName('claw-2', SPEED_WARM_REPO);
	const sims: Record<string, NodeSim> = {
		'claw-2': { marker: `${SPEED_WARM_REPO} 1000`, active: new Set([unit]) },
	};
	const gh = fakeGh({ runners: [{ id: 1, name: unit, status: 'online', busy: false }] });
	const input: EphemeralTickInput = {
		fleetProbe: new Map([['claw-2', { reachable: true, busyRepos: null }]]),
		ephemeral: new Set(['claw-2']),
		nodes: {
			'claw-2': {
				...WIRE_NODE,
				excludeRepos: { [SPEED_WARM_REPO]: 'wave 3w test: excluded here' },
			},
		},
		isSick: () => false,
		repos: [SPEED_WARM_REPO],
		standingEligible: new Set(),
	};
	const res = await dispatchWarmCache(input, 'tok', gh, simShell(sims), SPEED_NOW);
	// No `seedDemand` in this test: with no OTHER repo's demand recorded,
	// `planWarmFleet` has nothing to refill the freshly-emptied slot with
	// (served history is empty, which it reads as "idle everywhere, never an
	// eviction" on its OWN turn — so the only eviction here is wave 3w's).
	void historyPath;
	assert.equal(res.evicted, 1, 'the excluded repo is evicted off this node');
	assert.equal(res.filled, 0);
});

test('WARM PATH, #82: planWarmFleet filling an excluded repo onto an empty node is withheld, never minted', async () => {
	const historyPath = join(wireTmp, 'job-history.jsonl');
	seedDemand(historyPath, SPEED_WARM_REPO, SPEED_DEMAND_AT);
	const sims: Record<string, NodeSim> = { 'claw-2': { marker: null, active: new Set() } };
	const gh = fakeGh({});
	const input: EphemeralTickInput = {
		fleetProbe: new Map([['claw-2', { reachable: true, busyRepos: null }]]),
		ephemeral: new Set(['claw-2']),
		nodes: {
			'claw-2': {
				...WIRE_NODE,
				excludeRepos: { [SPEED_WARM_REPO]: 'wave 3w test: excluded here' },
			},
		},
		isSick: () => false,
		repos: [SPEED_WARM_REPO],
		standingEligible: new Set(),
	};
	const res = await dispatchWarmCache(input, 'tok', gh, simShell(sims), SPEED_NOW);
	assert.equal(
		res.filled,
		0,
		'the only repo worth a listener is excluded here, so nothing is filled'
	);
	assert.equal(sims['claw-2'].marker, null, 'no mint ever reached the node');
	assert.equal(
		gh.calls.some((c) => c.includes('registration-token')),
		false,
		'not one registration-token call spent on a fill this lane withholds'
	);
});

/** Enough real history for `getHeavyModel` to classify `(repo, 'forge-e2e')`
 *  heavy on its own — `MIN_HEAVY_SAMPLES` (5) runs over `HEAVY_P75_SEC` (420). */
function seedHeavyHistory(path: string, repo: string, node: string, baseMs: number): void {
	const startedAt = new Date(baseMs);
	for (let i = 0; i < 6; i++) {
		startedAt.setSeconds(startedAt.getSeconds() + 1);
		appendFileSync(
			path,
			JSON.stringify({
				repo,
				runId: 9_200_000 + i,
				jobId: 9_200_000 + i,
				name: 'forge-e2e',
				runner: node,
				labels: [],
				startedAt: startedAt.toISOString(),
				durationSec: 500,
				runSec: 500,
				conclusion: 'success',
			}) + '\n'
		);
	}
}

test('WARM PATH, #102.4: planWarmFleet filling onto a node running a heavy job is withheld', async () => {
	// claw-9 is currently running `hadoku-cardtable`'s `forge-e2e` — real
	// history makes that kind heavy on its own (no injected model) — and
	// `planWarmFleet` wants to fill its empty slot with `SPEED_WARM_REPO`'s
	// demand. The heavy-busy node must never be GIVEN that slot, same as a
	// slow-tier or excluded one.
	const historyPath = join(wireTmp, 'job-history.jsonl');
	const HEAVY_REPO = 'WolffM/hadoku-cardtable';
	seedHeavyHistory(historyPath, HEAVY_REPO, 'claw-9', SPEED_BASE_MS);
	seedDemand(historyPath, SPEED_WARM_REPO, SPEED_DEMAND_AT);
	const sims: Record<string, NodeSim> = { 'claw-9': { marker: null, active: new Set() } };
	const gh = fakeGh({});
	const input: EphemeralTickInput = {
		fleetProbe: new Map([['claw-9', { reachable: true, busyRepos: new Map([[HEAVY_REPO, 1]]) }]]),
		ephemeral: new Set(['claw-9']),
		nodes: { 'claw-9': WIRE_NODE },
		isSick: () => false,
		repos: [SPEED_WARM_REPO, HEAVY_REPO],
		standingEligible: new Set(),
	};
	const res = await dispatchWarmCache(input, 'tok', gh, simShell(sims), SPEED_NOW);
	assert.equal(
		res.filled,
		0,
		'a node running a heavy-kind job is never (re)filled with a warm listener'
	);
	assert.equal(sims['claw-9'].marker, null, 'no mint ever reached the node');
});

test('WARM PATH, #102: a node the dispatcher just gave a heavy job is not refilled, though the probe has not seen it yet', async () => {
	// 2026-10-08 23:10Z: the probe lags the dispatcher by up to a fast-loop
	// tick. Without the dispatcher's mark, this tick would refill the slot the
	// dispatch pass just evicted, and GitHub would hand it the next shard.
	const historyPath = join(wireTmp, 'job-history.jsonl');
	seedDemand(historyPath, SPEED_WARM_REPO, SPEED_DEMAND_AT);
	__markHeavyForTesting('claw-2', SPEED_NOW - 30_000);
	const sims: Record<string, NodeSim> = { 'claw-2': { marker: null, active: new Set() } };
	const gh = fakeGh({});
	const input: EphemeralTickInput = {
		fleetProbe: new Map([['claw-2', { reachable: true, busyRepos: null }]]),
		ephemeral: new Set(['claw-2']),
		nodes: { 'claw-2': WIRE_NODE },
		isSick: () => false,
		repos: [SPEED_WARM_REPO],
		standingEligible: new Set(),
	};
	const res = await dispatchWarmCache(input, 'tok', gh, simShell(sims), SPEED_NOW);
	assert.equal(res.filled, 0);
	assert.equal(sims['claw-2'].marker, null);
	__resetHeavyMarksForTesting();
});

test('WARM PATH: a normal-tier, non-excluded node fills and keeps exactly as before this wave', async () => {
	const historyPath = join(wireTmp, 'job-history.jsonl');
	seedDemand(historyPath, SPEED_WARM_REPO, SPEED_DEMAND_AT);
	const sims: Record<string, NodeSim> = { 'claw-2': { marker: null, active: new Set() } };
	const gh = fakeGh({});
	const input: EphemeralTickInput = {
		fleetProbe: new Map([['claw-2', { reachable: true, busyRepos: null }]]),
		ephemeral: new Set(['claw-2']),
		nodes: { 'claw-2': WIRE_NODE },
		isSick: () => false,
		repos: [SPEED_WARM_REPO],
		standingEligible: new Set(),
	};
	const res = await dispatchWarmCache(input, 'tok', gh, simShell(sims), SPEED_NOW);
	assert.equal(
		res.filled,
		1,
		'no exclusion, no slow tier — the ordinary fill happens exactly as before'
	);
	assert.equal(sims['claw-2'].marker, `${SPEED_WARM_REPO} 1000`);
});
