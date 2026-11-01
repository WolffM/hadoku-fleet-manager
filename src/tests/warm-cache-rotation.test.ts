/**
 * The warm cache of one — workload-gate ROTATION (wave 4e follow-up, #102):
 * a slot `planWarmFleet` would KEEP can still be advertising a
 * workload-gated label `offerFor` no longer offers this node, because
 * `case 'idle'/'keep'` never re-minted. These drive it through the REAL
 * `dispatchWarmCache`. Split out of warm-cache.test.ts (wave 5p lane C) —
 * see `helpers/warm-cache-rig.ts` for the shared fixtures and the
 * file-wide `beforeEach`/`afterEach` every split file installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchWarmCache } from '../runners/dispatch-warm-cache.js';
import { __resetWarmCacheClockForTesting } from '../runners/dispatch-warm-cache.js';
import { warmRunnerName } from '../runners/ephemeral.js';
import { WARM_ASSIGN_WINDOW_MS } from '../runners/ephemeral-warm.js';
import { __setWorkloadGateContextForTesting } from '../runners/ephemeral-shared.js';
import { workloadGateContext } from '../lib/workload-gate.js';
import { fakeGh } from './helpers/fleet-fakes.js';
import {
	INELIGIBLE_INSTALLED_MB,
	NODE_ELIGIBLE,
	NODE_ELIGIBLE_JDK21,
	NODE_INELIGIBLE,
	type NodeSim,
	T0,
	baseInput,
	histAt,
	installWarmCacheRig,
	proofRec,
	simShell,
	writeRecord,
} from './helpers/warm-cache-rig.js';

installWarmCacheRig();

// ---------------------------------------------------------------------------
// WORKLOAD-GATE ROTATION (wave 4e follow-up, #102) — the warm-listener gap
// found in manager verification: a slot `planWarmFleet` would KEEP can still
// be advertising a WORKLOAD-GATED label `offerFor` no longer offers this
// node, because `case 'idle'/'keep'` never re-minted. These drive it through
// the REAL `dispatchWarmCache`, never the decision switch in isolation.
// ---------------------------------------------------------------------------

test('dispatchWarmCache: an IDLE listener registered with jdk21 is ROTATED once the gate withholds it — new labels lack jdk21', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku_site 1000', activeUnits: new Set([unit]) },
	};
	const inner = simShell(sims);
	// `gh.mintedLabels` is the EPHEMERAL/JIT mint's own capture
	// (`generate-jitconfig`'s body) — a warm listener never calls that
	// endpoint at all, so the re-mint's labels can only be read the way
	// `fillAndReadLabels` above reads them: off the `warm-provision.sh`
	// shell command's own `LABELS='...'`.
	const seen: string[] = [];
	const sh = async (n: string, cmd: string) => {
		seen.push(cmd);
		return inner(n, cmd);
	};
	// THE EXISTING REGISTRATION already carries jdk21 — minted before claw-3's
	// canary failed, the exact shape this fix exists for.
	const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: false, labels: ['jdk21'] }] });
	const ctx = workloadGateContext(['claw-1'], {});
	ctx.byNode['claw-1'].jdk21 = proofRec({
		verdict: 'fail',
		why: 'claw-3-shaped: 0/5 specs passed',
	});
	__setWorkloadGateContextForTesting(ctx);
	const res = await dispatchWarmCache(
		baseInput({ nodes: { 'claw-1': NODE_ELIGIBLE_JDK21 } }),
		'tok',
		gh,
		sh,
		T0
	);
	assert.equal(res.evicted, 1, JSON.stringify(res));
	assert.equal(res.rotated, 1, JSON.stringify(res));
	assert.equal(res.kept, 0, JSON.stringify(res));
	const labels =
		/LABELS='([^']*)'/.exec(seen.find((c) => c.includes('warm-provision.sh')) ?? '')?.[1] ?? '';
	const sent = labels.split(',');
	assert.ok(!sent.includes('jdk21'), `re-mint must drop jdk21: ${labels}`);
	assert.ok(
		sent.includes('hadoku-builder'),
		`everything else about the offer is unaffected: ${labels}`
	);
});

test('dispatchWarmCache: the SAME slot, but BUSY, is kept this tick — never killed mid-job', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku_site 1000', activeUnits: new Set([unit]) },
	};
	const sh = simShell(sims);
	const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: true, labels: ['jdk21'] }] });
	const ctx = workloadGateContext(['claw-1'], {});
	ctx.byNode['claw-1'].jdk21 = proofRec({
		verdict: 'fail',
		why: 'claw-3-shaped: 0/5 specs passed',
	});
	__setWorkloadGateContextForTesting(ctx);
	const res = await dispatchWarmCache(
		baseInput({ nodes: { 'claw-1': NODE_ELIGIBLE_JDK21 } }),
		'tok',
		gh,
		sh,
		T0
	);
	assert.equal(res.kept, 1, JSON.stringify(res));
	assert.equal(res.evicted, 0, JSON.stringify(res));
	assert.equal(res.rotated, 0, JSON.stringify(res));
	assert.ok(sims['claw-1'].activeUnits.has(unit), 'a busy listener must still be running');
	assert.equal(gh.writes.length, 0, 'nothing minted or deleted while the job is running');
});

test('dispatchWarmCache: a listener whose labels already MATCH the offer is kept — no churn, gate dormant and no $proof file', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku_site 1000', activeUnits: new Set([unit]) },
	};
	const sh = simShell(sims);
	// Registered WITH jdk21, and the gate is DORMANT (no override set — the
	// real loader runs, finds no $proof file, and offers jdk21 same as today)
	// so the registration's labels match what offerFor currently returns.
	const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: false, labels: ['jdk21'] }] });
	const res = await dispatchWarmCache(
		baseInput({ nodes: { 'claw-1': NODE_ELIGIBLE_JDK21 } }),
		'tok',
		gh,
		sh,
		T0
	);
	assert.equal(res.kept, 1, JSON.stringify(res));
	assert.equal(res.evicted, 0, JSON.stringify(res));
	assert.equal(res.rotated, 0, JSON.stringify(res));
	assert.equal(gh.writes.length, 0, 'matching labels must never churn the slot');
});

test('dispatchWarmCache: an idle listener with NO gated label at all is kept — nothing to rotate', async () => {
	// Pins that this is scoped to GATED labels only: a plain, ungated node
	// (NODE_ELIGIBLE, no jdk21 anywhere) must never be rotated by this code
	// path, whatever the gate context says.
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku_site 1000', activeUnits: new Set([unit]) },
	};
	const sh = simShell(sims);
	const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: false }] });
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
	assert.equal(res.kept, 1);
	assert.equal(gh.writes.length, 0);
});

test('dispatchWarmCache: an ineligible (1-slot) node is never touched', async () => {
	// The issue #7 bug, reproduced: NODE_INELIGIBLE declares `maxConcurrent: 2`
	// (would have wrongly passed the old check), but its MEASURED installed
	// memory supports only one 4GB-class slot.
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: null, activeUnits: new Set(), installedMb: INELIGIBLE_INSTALLED_MB },
	};
	let shCalls = 0;
	const inner = simShell(sims);
	const sh = async (n: string, c: string) => {
		shCalls++;
		return inner(n, c);
	};
	const gh = fakeGh({});
	const res = await dispatchWarmCache(
		baseInput({ nodes: { 'claw-1': NODE_INELIGIBLE } }),
		'tok',
		gh,
		sh,
		T0
	);
	assert.deepEqual(res, {
		filled: 0,
		rotated: 0,
		kept: 0,
		locked: 0,
		evicted: 0,
		reaped: 0,
		failed: 0,
	});
	// Exactly the memory read that PROVES ineligibility, and nothing past it —
	// no marker read, no provisioning, no registration-token call.
	assert.equal(shCalls, 1);
	assert.equal(gh.calls.length, 0);
});

test('SAFETY dispatchWarmCache: a backstop marked ephemeral is never probed, at 62 GB', async () => {
	// hokon's measured shape, the manifest edit away from being in the set: a
	// 63402 MB box passes every memory test, so only its ROLE keeps it out —
	// and it must be kept out before the `free -m` ssh, not after.
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		hokon: { marker: null, activeUnits: new Set(), installedMb: 63_402 },
	};
	const touched: string[] = [];
	const inner = simShell(sims);
	const sh = async (n: string, c: string) => {
		touched.push(n);
		return inner(n, c);
	};
	const res = await dispatchWarmCache(
		baseInput({
			fleetProbe: new Map([
				['claw-1', { reachable: true, busyRepos: null }],
				['hokon', { reachable: true, busyRepos: null }],
			]),
			ephemeral: new Set(['claw-1', 'hokon']),
			nodes: {
				'claw-1': NODE_ELIGIBLE,
				hokon: { ...NODE_ELIGIBLE, minFreeMb: 8192, role: 'backstop' },
			},
		}),
		'tok',
		fakeGh({}),
		sh,
		T0
	);
	assert.equal(touched.includes('hokon'), false, 'no ssh reaches the backstop');
	assert.equal(sims.hokon.marker, null);
	assert.equal(res.filled, 1, 'and the claw beside it still fills');
});

test("dispatchWarmCache: eligibility reads the node's own job figure, the unit its mints reserve", async () => {
	// usable 7000. A node whose jobs measure 3400 MB holds a listener; the same
	// box reserving the 4096 MB default does not — so the tick must pass the
	// node's `jobP95Mb` through, not a constant.
	const run = async (jobP95Mb?: number) => {
		writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
		const sims: Record<string, NodeSim> = {
			'claw-1': { marker: null, activeUnits: new Set(), installedMb: 9048 },
		};
		return dispatchWarmCache(
			baseInput({ nodes: { 'claw-1': { ...NODE_ELIGIBLE, jobP95Mb } } }),
			'tok',
			fakeGh({}),
			simShell(sims),
			T0
		);
	};
	assert.equal((await run(3400)).filled, 1);
	__resetWarmCacheClockForTesting();
	assert.equal((await run(undefined)).filled, 0);
});

test('dispatchWarmCache: keeps a slot already warm for the right repo', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku_site 1000', activeUnits: new Set([unit]) },
	};
	const sh = simShell(sims);
	const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: false }] });
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
	assert.equal(res.kept, 1);
	assert.equal(gh.writes.length, 0, 'nothing should be minted or deleted');
});

test('dispatchWarmCache: a busy slot for the wrong repo stays locked, never evicted mid-job', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku-rally', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku_site 1000', activeUnits: new Set([unit]) },
	};
	const sh = simShell(sims);
	const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: true }] });
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
	assert.equal(res.locked, 1);
	assert.ok(sims['claw-1'].activeUnits.has(unit), 'the busy listener must still be running');
	assert.equal(gh.writes.length, 0);
});

test('dispatchWarmCache: rotates once the lock clears and traffic has moved on', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku-rally', startedAt: histAt(0) });
	const oldUnit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	// mintedOrRefreshedAtMs comes from the marker's epoch (1000s = 1_000_000ms).
	// nowMs is far enough past 1_000_000 + WARM_ASSIGN_WINDOW_MS to be unlocked.
	const nowMs = 1_000_000 + WARM_ASSIGN_WINDOW_MS + 1;
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku_site 1000', activeUnits: new Set([oldUnit]) },
	};
	const sh = simShell(sims);
	const gh = fakeGh({ runners: [{ id: 1, name: oldUnit, busy: false }] });
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, nowMs);
	assert.equal(res.evicted, 1);
	assert.equal(res.rotated, 1);
	assert.equal(sims['claw-1'].marker, 'WolffM/hadoku-rally 1000');
	assert.ok(!sims['claw-1'].activeUnits.has(oldUnit));
});
