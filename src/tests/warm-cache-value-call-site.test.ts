/**
 * The warm cache of one — the scored repo signal AT THE DISPATCH CALL SITE
 * (wave 3k §A/§B): a pure allocator the tick does not call is inert, so
 * these drive `dispatchWarmCache` itself with histories on which the scored
 * signal and a last-served MRU DISAGREE, or on which the joint allocation
 * and a per-node argmax disagree. Split out of warm-cache.test.ts (wave 5p
 * lane C) — see `helpers/warm-cache-rig.ts` for the shared fixtures and the
 * file-wide `beforeEach`/`afterEach` every split file installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchWarmCache } from '../runners/dispatch-warm-cache.js';
import { warmRunnerName } from '../lib/jit-naming.js';
import { WARM_ASSIGN_WINDOW_MS } from '../runners/ephemeral-warm.js';
import type { EphemeralTickInput } from '../runners/ephemeral-shared.js';
import { WARM_CACHE_INTERVAL_MS } from '../runners/warm-backoff.js';
import { fakeGh } from './helpers/fleet-fakes.js';
import {
	NODE_ELIGIBLE,
	type NodeSim,
	T0,
	baseInput,
	histAt,
	installWarmCacheRig,
	simShell,
	writeRecord,
} from './helpers/warm-cache-rig.js';

installWarmCacheRig();

// --- issue #16 AT THE CALL SITE (wave 3k §A) ---------------------------------
//
// The scored signal was built and tested on 2026-09-09 as a PURE function, and
// the tick went on passing last-served MRU for twelve days, because both arms
// typechecked and every test above drives the tick with a single job — where
// MRU and the scored signal agree. These two drive it with a history on which
// they DISAGREE: five hadoku_site jobs, then one hadoku-rally job that is the
// newest thing on the node. MRU chases hadoku-rally; the scored signal holds
// hadoku_site. A tick that reduced the history to its newest job fails both.

function writeQuietRepoAfterBusyOne() {
	for (let i = 0; i < 5; i++) {
		writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(i * 60) });
	}
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku-rally', startedAt: histAt(600) });
}

test('dispatchWarmCache: one job from a quiet repo does not rotate the busy repo out (#16)', async () => {
	writeQuietRepoAfterBusyOne();
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	// Unlocked on both counts — not busy, and past the assign window — so the
	// ONLY thing standing between this slot and an eviction is the signal.
	const nowMs = 1_000_000 + WARM_ASSIGN_WINDOW_MS + 1;
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku_site 1000', activeUnits: new Set([unit]) },
	};
	const sh = simShell(sims);
	const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: false }] });
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, nowMs);
	assert.deepEqual(res, {
		filled: 0,
		rotated: 0,
		kept: 1,
		locked: 0,
		evicted: 0,
		reaped: 0,
		failed: 0,
	});
	assert.equal(sims['claw-1'].marker, 'WolffM/hadoku_site 1000');
	assert.ok(sims['claw-1'].activeUnits.has(unit), 'the hadoku_site listener must still be running');
	assert.equal(gh.writes.length, 0, 'nothing should be minted or deleted');
});

test('dispatchWarmCache: an empty slot fills with the scored repo, not the newest one (#16)', async () => {
	writeQuietRepoAfterBusyOne();
	const sims: Record<string, NodeSim> = {};
	const sh = simShell(sims);
	const gh = fakeGh({});
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
	assert.equal(res.filled, 1);
	assert.equal(sims['claw-1'].marker, 'WolffM/hadoku_site 1000');
});

// --- the joint allocation AT THE CALL SITE (wave 3k §B) ----------------------
//
// Same lesson as §A's block above: a pure allocator the tick does not call is
// inert. Each of these drives the tick over two eligible nodes with a history
// on which the joint allocation and a per-node argmax DISAGREE, so a tick that
// went back to asking each node on its own fails them.

function twoNodeInput(): EphemeralTickInput {
	return baseInput({
		fleetProbe: new Map([
			['claw-1', { reachable: true, busyRepos: null }],
			['claw-2', { reachable: true, busyRepos: null }],
		]),
		ephemeral: new Set(['claw-1', 'claw-2']),
		nodes: { 'claw-1': NODE_ELIGIBLE, 'claw-2': NODE_ELIGIBLE },
	});
}

/** Both nodes served mostly hadoku_site and a little hadoku-rally — the shape
 *  that put hadoku_site on every node. Every job is one second long and none
 *  overlaps another of its repo, so a second hadoku_site listener would have
 *  served nothing: the joint answer is one of each. */
function writeSkewedOnBothNodes() {
	for (const [node, offset] of [
		['claw-1', 0],
		['claw-2', 10],
	] as const) {
		for (let i = 0; i < 5; i++)
			writeRecord({
				runner: node,
				repo: 'WolffM/hadoku_site',
				startedAt: histAt(i * 60 + offset),
				durationSec: 1,
			});
		for (let i = 0; i < 2; i++)
			writeRecord({
				runner: node,
				repo: 'WolffM/hadoku-rally',
				startedAt: histAt(i * 60 + 30 + offset),
				durationSec: 1,
			});
	}
}

test('dispatchWarmCache: two empty eligible nodes fill two DIFFERENT repos (#54)', async () => {
	writeSkewedOnBothNodes();
	const sims: Record<string, NodeSim> = {};
	const res = await dispatchWarmCache(twoNodeInput(), 'tok', fakeGh({}), simShell(sims), T0);
	assert.equal(res.filled, 2);
	assert.deepEqual(
		[sims['claw-1'].marker, sims['claw-2'].marker].sort(),
		['WolffM/hadoku-rally 1000', 'WolffM/hadoku_site 1000'],
		'both nodes on hadoku_site is the per-node argmax this replaced'
	);
});

test('dispatchWarmCache: a BUSY holder keeps its repo and the idle duplicate moves to the next one (#54)', async () => {
	writeSkewedOnBothNodes();
	const u1 = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const u2 = warmRunnerName('claw-2', 'WolffM/hadoku_site');
	const nowMs = 1_000_000 + WARM_ASSIGN_WINDOW_MS + 1;
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku_site 1000', activeUnits: new Set([u1]) },
		'claw-2': { marker: 'WolffM/hadoku_site 1000', activeUnits: new Set([u2]) },
	};
	const gh = fakeGh({
		runners: [
			{ id: 1, name: u1, busy: true },
			{ id: 2, name: u2, busy: false },
		],
	});
	const res = await dispatchWarmCache(twoNodeInput(), 'tok', gh, simShell(sims), nowMs);
	assert.ok(sims['claw-1'].activeUnits.has(u1), 'the busy listener must still be running');
	assert.equal(sims['claw-1'].marker?.split(' ')[0], 'WolffM/hadoku_site');
	assert.equal(sims['claw-2'].marker, 'WolffM/hadoku-rally 1000');
	assert.ok(!sims['claw-2'].activeUnits.has(u2));
	assert.equal(res.rotated, 1);
	assert.equal(res.evicted, 1);
});

test("dispatchWarmCache: a repo's value is the FLEET's demand, not the node's own history", async () => {
	// Every job ran on hokon, which is never eligible. claw-1 served nothing
	// itself, and a warm hadoku-rally listener there would still have taken
	// every one of those jobs.
	for (let i = 0; i < 3; i++)
		writeRecord({ runner: 'hokon', repo: 'WolffM/hadoku-rally', startedAt: histAt(i * 60) });
	const sims: Record<string, NodeSim> = {};
	const res = await dispatchWarmCache(baseInput(), 'tok', fakeGh({}), simShell(sims), T0);
	assert.equal(res.filled, 1);
	assert.equal(sims['claw-1'].marker, 'WolffM/hadoku-rally 1000');
});

test('dispatchWarmCache: an unreadable busy check fails toward LOCKED, never toward eviction', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku-rally', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku_site 1000', activeUnits: new Set([unit]) },
	};
	const sh = simShell(sims);
	// The runners listing does not include this unit at all — gone or unreadable.
	const gh = fakeGh({ runners: [] });
	const res = await dispatchWarmCache(
		baseInput(),
		'tok',
		gh,
		sh,
		1_000_000 + WARM_ASSIGN_WINDOW_MS + 1
	);
	assert.equal(res.locked, 1);
	assert.ok(sims['claw-1'].activeUnits.has(unit));
});

test('dispatchWarmCache: its own clock — a second call inside the interval does nothing', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {};
	const sh = simShell(sims);
	const gh = fakeGh({});
	const first = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
	assert.equal(first.filled, 1);
	const callsAfterFirst = gh.calls.length;
	const second = await dispatchWarmCache(
		baseInput(),
		'tok',
		gh,
		sh,
		T0 + WARM_CACHE_INTERVAL_MS - 1
	);
	assert.deepEqual(second, {
		filled: 0,
		rotated: 0,
		kept: 0,
		locked: 0,
		evicted: 0,
		reaped: 0,
		failed: 0,
	});
	assert.equal(gh.calls.length, callsAfterFirst, 'the second call must not touch GitHub at all');
});
