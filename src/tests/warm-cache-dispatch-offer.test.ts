/**
 * The warm cache of one — `dispatchWarmCache` end to end: the plain
 * idle-fill case, the decision log, and `offerFor`'s workload-gate
 * consultation (wave 4e follow-up #102) — the ONE choke point for the mint,
 * both warm-listener label sites, and placement. Split out of
 * warm-cache.test.ts (wave 5p lane C) — see `helpers/warm-cache-rig.ts` for
 * the shared `NodeSim`/`simShell`/`baseInput`/`NODE_ELIGIBLE` family,
 * `NODE_ELIGIBLE_JDK21`/`proofRec`, and the file-wide
 * `beforeEach`/`afterEach` every split file installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';
import {
	__resetDecisionLogForTesting,
	__restoreDecisionSinkForTesting,
	__setDecisionSinkForTesting,
	type DecisionRecord,
} from '../runners/decision-log.js';
import { __resetWarmCacheClockForTesting } from '../runners/dispatch-warm-cache.js';
import { WARM_CACHE_INTERVAL_MS } from '../runners/warm-backoff.js';
import { dispatchWarmCache } from '../runners/dispatch-warm-cache.js';
import { __setWorkloadGateContextForTesting } from '../runners/ephemeral-shared.js';
import { workloadGateContext } from '../lib/workload-gate.js';
import { fakeGh } from './helpers/fleet-fakes.js';
import {
	NODE_ELIGIBLE_JDK21,
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

// --- dispatchWarmCache end to end --------------------------------------------

test('dispatchWarmCache: fills an idle eligible node from what it has served', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {};
	const sh = simShell(sims);
	const gh = fakeGh({});
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
	assert.equal(res.filled, 1);
	assert.equal(sims['claw-1'].marker, 'WolffM/hadoku_site 1000');
});

test('dispatchWarmCache: the decision log gets the fill, and the tick does the same with it off', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const run = async () => {
		const sims: Record<string, NodeSim> = {};
		const gh = fakeGh({});
		const res = await dispatchWarmCache(baseInput(), 'tok', gh, simShell(sims), T0);
		return { res, marker: sims['claw-1']?.marker, calls: [...gh.calls] };
	};
	try {
		__setDecisionSinkForTesting(null);
		const off = await run();
		__resetWarmCacheClockForTesting();
		__resetDecisionLogForTesting();
		const rows: DecisionRecord[] = [];
		__setDecisionSinkForTesting((rs) => rows.push(...rs));
		const on = await run();
		assert.deepEqual(on, off);
		assert.deepEqual(
			rows.map((r) => [r.path, r.kind, r.winner, r.action, r.repo]),
			[['warm', 'warm-listener', 'claw-1', 'fill', 'WolffM/hadoku_site']]
		);
	} finally {
		__restoreDecisionSinkForTesting();
	}
});

// ---------------------------------------------------------------------------
// wave 4e follow-up (#102) — the defect the manager's verification caught
// before landing: `offerFor` (the ONE choke point for the mint, both
// warm-listener label sites, and placement) must actually consult the
// workload gate, not merely be capable of it. These drive it through the
// REAL `dispatchWarmCache`/`offerFor`, never `nodeOffer` directly, via
// `__setWorkloadGateContextForTesting` — the test seam that stands in for a
// real `$proof` read without touching the shared test-host state dir (see
// that function's own doc for why a real fixture there would leak across
// every other test in this process).
// ---------------------------------------------------------------------------

/** Runs `dispatchWarmCache` and returns the LABELS the warm registration actually sent. */
async function fillAndReadLabels(
	gateCtx: ReturnType<typeof workloadGateContext>
): Promise<string[]> {
	__setWorkloadGateContextForTesting(gateCtx);
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {};
	const inner = simShell(sims);
	const seen: string[] = [];
	const sh = async (n: string, cmd: string) => {
		seen.push(cmd);
		return inner(n, cmd);
	};
	const gh = fakeGh({});
	const res = await dispatchWarmCache(
		baseInput({ nodes: { 'claw-1': NODE_ELIGIBLE_JDK21 } }),
		'tok',
		gh,
		sh,
		T0
	);
	assert.equal(
		res.filled,
		1,
		'the fixture itself is only meaningful if the fill actually happened'
	);
	const labels =
		/LABELS='([^']*)'/.exec(seen.find((c) => c.includes('warm-provision.sh')) ?? '')?.[1] ?? '';
	return labels.split(',').filter(Boolean);
}

test('offerFor: NO $proof at all (dormant, nothing has looked) is byte-identical to today — jdk21 still fills', async () => {
	const ctx = workloadGateContext(['claw-1'], {});
	const labels = await fillAndReadLabels(ctx);
	assert.ok(labels.includes('jdk21'), `jdk21 missing: ${labels.join(',')}`);
});

test('offerFor: gate ACTIVE (2 fresh passes elsewhere) + claw-3-shaped node with NO record withholds jdk21', async () => {
	const ctx = workloadGateContext(['claw-1'], {}, { corrupt: false });
	ctx.provenCounts.jdk21 = 2; // two OTHER nodes already proven, fleet-wide
	ctx.byNode['claw-1'].jdk21 = null; // this node has never been canaried
	const labels = await fillAndReadLabels(ctx);
	assert.ok(!labels.includes('jdk21'), `jdk21 must be withheld: ${labels.join(',')}`);
	assert.ok(labels.includes('hadoku-builder'), 'nothing else about the offer should change');
});

test('offerFor: a FAIL record withholds jdk21 even while the gate is DORMANT (0 proven elsewhere)', async () => {
	const ctx = workloadGateContext(['claw-1'], {});
	ctx.byNode['claw-1'].jdk21 = proofRec({
		verdict: 'fail',
		why: 'claw-3-shaped: 0/5 specs passed',
	});
	const labels = await fillAndReadLabels(ctx);
	assert.ok(
		!labels.includes('jdk21'),
		`a FAIL must withdraw the label even dormant: ${labels.join(',')}`
	);
});

test('offerFor: a STALE record (lane B node-regression) withholds jdk21 too', async () => {
	const ctx = workloadGateContext(['claw-1'], {});
	ctx.provenCounts.jdk21 = 2;
	ctx.byNode['claw-1'].jdk21 = proofRec({
		verdict: 'stale',
		why: '5 jdk21 run(s) failed on claw-1 while the same commit passed elsewhere within the hour',
	});
	const labels = await fillAndReadLabels(ctx);
	assert.ok(!labels.includes('jdk21'), `a STALE mark must withdraw the label: ${labels.join(',')}`);
});

test('loadWorkloadGateContext logs a corrupt $proof file ONCE, not once per 15s tick', async () => {
	// NOT `__setWorkloadGateContextForTesting` here — that seam bypasses the
	// real loader (and its corruption check) entirely. This drives the REAL
	// read, against a REAL malformed file, through a swapped-in host so the
	// shared test-host state dir is never touched.
	const dir = mkdtempSync(join(tmpdir(), 'warmcache-corrupt-proof-'));
	writeFileSync(join(dir, 'proof.json'), '{ not json');
	const errors: string[] = [];
	__setHostForTesting({
		...testHost,
		stateDir: dir,
		logger: { info: () => undefined, warn: () => undefined, error: (m) => void errors.push(m) },
	});
	try {
		const sh = simShell({});
		const gh = fakeGh({});
		const input = baseInput();
		// Three ticks, each past the warm-cache's own 60s cadence, so the real
		// read genuinely runs three times — never short-circuited by the clock
		// gate, which would prove nothing about the LOG dedup this test is for.
		await dispatchWarmCache(input, 'tok', gh, sh, T0);
		await dispatchWarmCache(input, 'tok', gh, sh, T0 + WARM_CACHE_INTERVAL_MS + 1);
		await dispatchWarmCache(input, 'tok', gh, sh, T0 + 2 * (WARM_CACHE_INTERVAL_MS + 1));
		assert.equal(
			errors.length,
			1,
			`expected exactly one log line across 3 corrupt ticks, got: ${JSON.stringify(errors)}`
		);
		assert.match(errors[0], /\$proof is malformed/);
	} finally {
		__setHostForTesting(testHost);
		rmSync(dir, { recursive: true, force: true });
	}
});
