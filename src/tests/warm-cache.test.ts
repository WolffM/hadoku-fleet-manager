/**
 * The warm cache of one — P4.1 (docs/planning/warm-listener-cache-2026-09-05.md)
 * and the P4.2 burst test it calls for.
 *
 * Three layers, tested the way the rest of this workstream is: pure decisions
 * in ephemeral.ts need no mock at all, the I/O in ephemeral-exec.ts is tested
 * through injected `gh`/`sh` exactly like `mintEphemeralRunner`, and the
 * orchestration in ephemeral-tick.ts is tested end to end with a small
 * STATEFUL fake node — because "fill, then keep, then lock, then rotate" is a
 * sequence, and a fresh stateless mock per call cannot show that the second
 * tick sees what the first one did.
 */
import {
	__resetCapacityLedgerForTesting,
	recordCapacityLedger,
} from '../runners/capacity-ledger.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';

import {
	WARM_ASSIGN_WINDOW_MS,
	WARM_PREFIX,
	admitMint,
	buildWarmSpawnPlan,
	planWarmCache,
	planWarmFleet,
	WARM_INCUMBENT_RATIO,
	warmUnitValues,
	mintBudget,
	warmCacheEligible,
	warmConcurrencySlots,
	warmEligibleSlots,
	warmListenersHeld,
	warmListenerSlots,
	warmRunnerName,
	warmSlotDir,
	warmSlotLocked,
} from '../runners/ephemeral.js';
import {
	currentWarmSlot,
	evictWarmListener,
	readWarmMarker,
	isRunnerBusy,
	mintWarmListener,
	__resetTarballCacheForTesting,
} from '../runners/ephemeral-exec.js';
import {
	admissionVerdictsForReport,
	__resetAdmissionVerdictsForTesting,
	__setAdmissionVerdictsForTesting,
	__resetSpeedModelForTesting,
	__resetWarmBackoffForTesting,
	__resetWarmCacheClockForTesting,
	__resetWarmReposForTesting,
	__restartWarmBackoffForTesting,
	__resetWorkloadGateCorruptionLogForTesting,
	__setWorkloadGateContextForTesting,
	dispatchEphemeral,
	dispatchWarmCache,
	fleetServedJobs,
	parseSpaceProbe,
	SPACE_PROBE_DF_CMD,
	warmReposForPlacement,
	WARM_CACHE_INTERVAL_MS,
	type EphemeralTickInput,
} from '../runners/ephemeral-tick.js';
import { ephemeralOnlyLabels, workloadGateContext } from '../capabilities.js';
import type { ProofRecord } from '../lib/measured.js';
import { nodeOf } from '../runners/census.js';
import { writeDrain } from '../runners/drain.js';
import {
	__resetJobHistoryForTesting,
	__setHistoryPathForTesting,
	historyFile,
} from '../job-history.js';
import { fakeGh } from './helpers/fleet-fakes.js';

// --- naming, eligibility, the lock, the decision table -----------------------

test('a warm name carries no run id or epoch — cache of one needs no aging', () => {
	const n = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	// The slug charset keeps `_`, same as jitRunnerName's — only what systemd
	// cannot admit gets replaced.
	assert.equal(n, 'warm-claw-1-hadoku_site');
	assert.ok(n.startsWith(WARM_PREFIX));
	// systemd's charset, same bound as the JIT name.
	assert.match(n, /^[A-Za-z0-9:_.-]+$/);
});

test('a warm name still fits 64 characters against a long node+repo', () => {
	const n = warmRunnerName(
		'a-very-long-node-name-indeed',
		'WolffM/a-very-long-repository-name-too'
	);
	assert.ok(n.length <= 64, `${n.length}: ${n}`);
});

test('census.nodeOf resolves a warm-prefixed name the same way it resolves a JIT one', () => {
	const nodes = ['claw-1', 'claw-2'];
	assert.equal(nodeOf(warmRunnerName('claw-1', 'WolffM/hadoku_site'), nodes), 'claw-1');
});

test('#101: SPACE_PROBE_DF_CMD is still the exact text that runs on a node, after jitRoot deduplicated the literal', () => {
	// `jitRoot('~')` now supplies the jit directory and its derived parent for
	// this command, instead of two more copies of the literal — this pins the
	// rendered command byte-for-byte so that refactor could not have changed
	// what actually runs over ssh.
	assert.equal(
		SPACE_PROBE_DF_CMD,
		"df -Pm /tmp | awk 'NR==2{print $4, $2}'; " +
			"(df -Pm ~/.hadoku/jit 2>/dev/null || df -Pm ~/.hadoku 2>/dev/null || df -Pm ~) | awk 'NR==2{print $4}'"
	);
});

test('the warm slot lives at a fixed path — no index, unlike a JIT slot', () => {
	assert.equal(warmSlotDir('/home/hadoku'), '/home/hadoku/.hadoku/warm/listener');
});

// --- eligibility: the mint reserve in mint units, the listener sized busy ----

/** `free -m` totals measured on every manifest node, 2026-09-20. */
const MEASURED = {
	'claw-1': { installedMb: 11_885, minFreeMb: 2048, jobMb: 3400 },
	'claw-2': { installedMb: 7872, minFreeMb: 1536, jobMb: 3400 },
	'claw-3': { installedMb: 15_918, minFreeMb: 2048, jobMb: 3400 },
	'claw-4': { installedMb: 15_936, minFreeMb: 2048, jobMb: 4096 },
	'claw-5': { installedMb: 15_877, minFreeMb: 2048, jobMb: 4096 },
	'claw-6': { installedMb: 7849, minFreeMb: 1536, jobMb: 4096 },
	'claw-8': { installedMb: 15_915, minFreeMb: 2048, jobMb: 4096 },
	'claw-9': { installedMb: 32_003, minFreeMb: 4096, jobMb: 4096 },
} as const;
const HOKON = { installedMb: 63_402, minFreeMb: 8192, jobMb: 4096, role: 'guest' };

test('eligibility over the measured fleet: how many busy listeners fit beside the 50% mint reserve', () => {
	const got = Object.fromEntries(
		Object.entries(MEASURED).map(([n, m]) => [n, warmEligibleSlots({ ...m, role: 'claw' })])
	);
	assert.deepEqual(got, {
		'claw-1': 1, // usable 9837: JIT half 4919, warm half 4918 / 3400
		'claw-2': 0, // usable 6336: JIT half 3168 holds less than one 3400 MB mint
		'claw-3': 2, // usable 13870: warm half 6935 / 3400
		'claw-4': 1, // usable 13888: 6944 / 4096
		'claw-5': 1,
		'claw-6': 0, // usable 6313: JIT half 3157 against a 4096 MB mint
		'claw-8': 1,
		'claw-9': 3, // usable 27907: 13953 / 4096 — not the 6 four-GB slots it has
	});
});

test('eligibility: the 8 GB claws hold none — a busy listener there would spend the mint reserve', () => {
	// Sized at the 44 MB idle rent, claw-2 would pass with ~72 listeners to
	// spare. Busy, its one listener (p95 3337 MB) plus one cold mint (3400 MB)
	// is 6737 MB against 6336 usable.
	assert.equal(warmCacheEligible(warmEligibleSlots(MEASURED['claw-2'])), false);
	assert.equal(warmCacheEligible(warmEligibleSlots(MEASURED['claw-6'])), false);
	assert.equal(warmCacheEligible(warmEligibleSlots(MEASURED['claw-1'])), true);
});

test('SAFETY eligibility: hokon holds none BY ROLE, though its memory would pass any test', () => {
	assert.equal(warmEligibleSlots(HOKON), 0);
	assert.equal(warmCacheEligible(warmEligibleSlots(HOKON)), false);
	// The same box as a claw: memory alone admits it, so memory is not what
	// keeps it out.
	assert.equal(warmEligibleSlots({ ...HOKON, role: 'claw' }), 6);
});

test('eligibility is in the unit a MINT uses: a 3400 MB node clears a bar a 4096 MB node does not', () => {
	// usable 7000: one four-GB slot under the old rule, which said no. Its JIT
	// half (3500) holds a full 3400 MB mint and so does its warm half.
	assert.equal(warmEligibleSlots({ installedMb: 9048, minFreeMb: 2048, jobMb: 3400 }), 1);
	assert.equal(warmEligibleSlots({ installedMb: 9048, minFreeMb: 2048, jobMb: 4096 }), 0);
	// And the other way: a node whose jobs reserve 5000 MB may not hold one on
	// claw-1's box, where the old rule counted two slots and said yes.
	assert.equal(warmEligibleSlots({ ...MEASURED['claw-1'], jobMb: 5000 }), 0);
});

test('SAFETY eligibility never spends the mint reserve, at any shape', () => {
	for (let installedMb = 0; installedMb <= 70_000; installedMb += 97) {
		for (const minFreeMb of [1024, 1536, 2048, 4096, 8192]) {
			for (const jobMb of [927, 2048, 3337, 3400, 4096, 6000]) {
				const slots = warmEligibleSlots({ installedMb, minFreeMb, jobMb });
				if (slots === 0) continue;
				const usable = installedMb - minFreeMb;
				const left = usable - slots * jobMb;
				const shape = `${installedMb}/${minFreeMb}/${jobMb} -> ${slots}`;
				assert.ok(left >= usable / 2, `${shape}: every listener busy leaves the JIT half intact`);
				assert.ok(left >= jobMb, `${shape}: and that half still holds a whole mint`);
			}
		}
	}
});

test('eligibility is total: an unmeasured figure is zero listeners, never room', () => {
	assert.equal(warmEligibleSlots({ installedMb: 1000, minFreeMb: 1536, jobMb: 3400 }), 0);
	assert.equal(warmEligibleSlots({ installedMb: Number.NaN, minFreeMb: 1536, jobMb: 3400 }), 0);
	assert.equal(warmEligibleSlots({ installedMb: 16_000, minFreeMb: 2048, jobMb: 0 }), 0);
	assert.equal(warmEligibleSlots({ installedMb: 16_000, minFreeMb: 2048, jobMb: Number.NaN }), 0);
	assert.equal(warmCacheEligible(0), false);
});

test('the lock: busy alone is enough', () => {
	assert.equal(warmSlotLocked({ busy: true, mintedOrRefreshedAtMs: 0, nowMs: 10_000_000 }), true);
});

test('the lock: not busy, but inside the assign window', () => {
	const now = 1_000_000;
	assert.equal(
		warmSlotLocked({ busy: false, mintedOrRefreshedAtMs: now - 5_000, nowMs: now }),
		true,
		'5s after mint is well inside the ~20s assign window'
	);
});

test('the lock: not busy, past the assign window — safe to evict', () => {
	const now = 1_000_000;
	assert.equal(
		warmSlotLocked({
			busy: false,
			mintedOrRefreshedAtMs: now - WARM_ASSIGN_WINDOW_MS - 1,
			nowMs: now,
		}),
		false
	);
});

test('planWarmCache: nothing observed yet stays idle, never guesses', () => {
	assert.deepEqual(planWarmCache({ current: null, served: [], nowMs: 0 }), {
		action: 'idle',
	});
});

test('planWarmCache: no slot yet, something to warm — fill', () => {
	const d = planWarmCache({
		current: null,
		served: [{ repo: 'WolffM/hadoku_site', startedAtMs: 0 }],
		nowMs: 0,
	});
	assert.deepEqual(d, { action: 'fill', repo: 'WolffM/hadoku_site' });
});

test('planWarmCache: already warm for the right repo — keep, never re-mint', () => {
	const d = planWarmCache({
		current: { repo: 'WolffM/hadoku_site', busy: false, mintedOrRefreshedAtMs: -1_000_000 },
		served: [{ repo: 'WolffM/hadoku_site', startedAtMs: 0 }],
		nowMs: 0,
	});
	assert.deepEqual(d, { action: 'keep' });
});

test('planWarmCache: wrong repo but the busy lock holds — locked, not rotate', () => {
	const d = planWarmCache({
		current: { repo: 'WolffM/hadoku_site', busy: true, mintedOrRefreshedAtMs: 0 },
		served: [{ repo: 'WolffM/hadoku-rally', startedAtMs: 0 }],
		nowMs: 1000,
	});
	assert.deepEqual(d, { action: 'locked' });
});

test('planWarmCache: wrong repo, safe to evict — rotate', () => {
	const nowMs = 1_000_000;
	const d = planWarmCache({
		current: { repo: 'WolffM/hadoku_site', busy: false, mintedOrRefreshedAtMs: 0 },
		served: [{ repo: 'WolffM/hadoku-rally', startedAtMs: 0 }],
		nowMs,
	});
	assert.deepEqual(d, { action: 'rotate', from: 'WolffM/hadoku_site', to: 'WolffM/hadoku-rally' });
});

// --- planWarmFleet: the joint allocation (wave 3k §B) ------------------------
//
// Every fixture puts its jobs at ONE instant, so each job weighs exactly 1 and a
// repo's score is its job count — the arithmetic in each assertion is then the
// arithmetic a reader can do in their head.

const SITE = 'WolffM/hadoku_site';
const MEET = 'WolffM/hadoku-rally';
const CARD = 'WolffM/hadoku-cardtable';
const TEN = 'WolffM/hadoku-tenhands';
const FLEET_NOW = 50_000_000;

/** `n` jobs of `repo`, all a minute before FLEET_NOW. */
function jobsOf(repo: string, n: number) {
	return Array.from({ length: n }, () => ({ repo, startedAtMs: FLEET_NOW - 60_000 }));
}
/** A slot that is unlocked on both counts: not busy, and long past the window. */
const idleSlot = (repo: string) => ({ repo, busy: false, mintedOrRefreshedAtMs: 0 });
const busySlot = (repo: string) => ({ repo, busy: true, mintedOrRefreshedAtMs: 0 });

test('planWarmFleet: the Nth node takes the Nth most valuable UNCOVERED repo, not the same one', () => {
	const served = [...jobsOf(SITE, 10), ...jobsOf(MEET, 5), ...jobsOf(CARD, 2)];
	const nodes = ['claw-1', 'claw-2', 'claw-3'].map((node) => ({ node, current: null }));
	const d = planWarmFleet({ nodes, served, nowMs: FLEET_NOW });
	assert.deepEqual(Object.fromEntries(d), {
		'claw-1': { action: 'fill', repo: SITE },
		'claw-2': { action: 'fill', repo: MEET },
		'claw-3': { action: 'fill', repo: CARD },
	});
	// The bug this replaces, stated as the contrast: every node asked on its own
	// answers with the same argmax.
	assert.deepEqual(planWarmCache({ current: null, served, nowMs: FLEET_NOW }), {
		action: 'fill',
		repo: SITE,
	});
});

/** `pairs` pairs of `repo` jobs, each pair started together and running a
 *  minute — so the second of each pair finds the first still running. */
function overlappingPairs(repo: string, pairs: number) {
	return Array.from({ length: pairs * 2 }, (_, k) => ({
		repo,
		startedAtMs: FLEET_NOW - 3600_000 + Math.floor(k / 2) * 120_000,
		durationMs: 60_000,
	}));
}

test('warmUnitValues: the kth listener is worth the jobs that found k-1 others running', () => {
	const served = [...overlappingPairs(SITE, 3), ...jobsOf(MEET, 2)];
	const v = warmUnitValues(served, FLEET_NOW, 3, { halfLifeMs: Number.POSITIVE_INFINITY });
	// halfLife infinite = every job weighs 1, so these are plain counts.
	assert.deepEqual(v.get(SITE), [3, 3, 0]);
	// No duration: nothing overlaps, everything is the first listener's.
	assert.deepEqual(v.get(MEET), [2, 0, 0]);
});

test('planWarmFleet: a repo whose jobs OVERLAP earns a second listener over a smaller serial repo', () => {
	// SITE's second listener would serve 5 jobs (the second of each pair); a
	// MEET listener would serve 2. One listener serves one job at a time, so
	// ranking by volume alone — SITE then MEET — would count the paired jobs
	// as warm when the only SITE listener is already busy with their twin.
	const served = [...overlappingPairs(SITE, 5), ...jobsOf(MEET, 2)];
	const nodes = ['claw-1', 'claw-2'].map((node) => ({ node, current: null }));
	assert.deepEqual(Object.fromEntries(planWarmFleet({ nodes, served, nowMs: FLEET_NOW })), {
		'claw-1': { action: 'fill', repo: SITE },
		'claw-2': { action: 'fill', repo: SITE },
	});
	// The same volumes with the overlap taken away: one of each.
	const serial = served.map(({ repo, startedAtMs }) => ({ repo, startedAtMs }));
	assert.deepEqual(Object.fromEntries(planWarmFleet({ nodes, served: serial, nowMs: FLEET_NOW })), {
		'claw-1': { action: 'fill', repo: SITE },
		'claw-2': { action: 'fill', repo: MEET },
	});
});

test('planWarmFleet: a duplicate of the head repo rotates onto the next uncovered one', () => {
	const served = [...jobsOf(SITE, 10), ...jobsOf(MEET, 5)];
	const d = planWarmFleet({
		nodes: [
			{ node: 'claw-1', current: idleSlot(SITE) },
			{ node: 'claw-2', current: idleSlot(SITE) },
		],
		served,
		nowMs: FLEET_NOW,
	});
	assert.deepEqual(d.get('claw-1'), { action: 'keep' });
	assert.deepEqual(d.get('claw-2'), { action: 'rotate', from: SITE, to: MEET });
});

test('SAFETY planWarmFleet: a BUSY node keeps its repo, and that repo counts as covered for the others', () => {
	// claw-1 holds the least valuable repo and is mid-job. The unlocked
	// allocation would move it (two nodes, and CARD is third of three); the lock
	// must hold it, and claw-2 must then take the head repo — not CARD a second
	// time, and not leave SITE uncovered because claw-1 "should" have had it.
	const served = [...jobsOf(SITE, 10), ...jobsOf(MEET, 5), ...jobsOf(CARD, 1)];
	const d = planWarmFleet({
		nodes: [
			{ node: 'claw-1', current: busySlot(CARD) },
			{ node: 'claw-2', current: null },
		],
		served,
		nowMs: FLEET_NOW,
	});
	assert.deepEqual(d.get('claw-1'), { action: 'locked' });
	assert.deepEqual(d.get('claw-2'), { action: 'fill', repo: SITE });
});

test('SAFETY planWarmFleet: a locked node covers its repo — a second node is moved OFF it, not onto it', () => {
	const served = [...jobsOf(SITE, 10), ...jobsOf(MEET, 5)];
	const d = planWarmFleet({
		nodes: [
			// claw-2 sorts after claw-1, so without the lock claw-1 would be the
			// SITE incumbent and claw-2 the duplicate. Busy on claw-2 flips that.
			{ node: 'claw-1', current: idleSlot(SITE) },
			{ node: 'claw-2', current: busySlot(SITE) },
		],
		served,
		nowMs: FLEET_NOW,
	});
	assert.deepEqual(d.get('claw-2'), { action: 'keep' }, 'the busy holder is never rotated');
	assert.deepEqual(d.get('claw-1'), { action: 'rotate', from: SITE, to: MEET });
});

test('SAFETY planWarmFleet: the assign window locks exactly like busy does', () => {
	const served = [...jobsOf(SITE, 10), ...jobsOf(MEET, 5), ...jobsOf(CARD, 1)];
	const nodes = [
		{
			node: 'claw-1',
			current: {
				repo: CARD,
				busy: false,
				mintedOrRefreshedAtMs: FLEET_NOW - WARM_ASSIGN_WINDOW_MS + 1,
			},
		},
		{ node: 'claw-2', current: null },
	];
	const d = planWarmFleet({ nodes, served, nowMs: FLEET_NOW });
	assert.deepEqual(d.get('claw-1'), { action: 'locked' });
	assert.deepEqual(d.get('claw-2'), { action: 'fill', repo: SITE });
	// One millisecond past the window the same slot is fair game — the lock is
	// what held it, not some other preference.
	const later = planWarmFleet({ nodes, served, nowMs: FLEET_NOW + WARM_ASSIGN_WINDOW_MS });
	assert.equal(later.get('claw-1')?.action, 'rotate');
});

test('planWarmFleet: a slight volume swap in the tail does NOT churn the fleet', () => {
	const nodes = [
		{ node: 'claw-1', current: idleSlot(SITE) },
		{ node: 'claw-2', current: idleSlot(MEET) },
		{ node: 'claw-3', current: idleSlot(CARD) },
	];
	const base = [...jobsOf(SITE, 20), ...jobsOf(MEET, 6), ...jobsOf(CARD, 3)];
	const allKeep = {
		'claw-1': { action: 'keep' },
		'claw-2': { action: 'keep' },
		'claw-3': { action: 'keep' },
	};
	assert.deepEqual(
		Object.fromEntries(
			planWarmFleet({ nodes, served: [...base, ...jobsOf(TEN, 3)], nowMs: FLEET_NOW })
		),
		allKeep
	);
	// TEN now outranks CARD by one job. That is a rank swap at the boundary,
	// and paying a DELETE + token POST + provisioning ssh for it is the churn
	// the damping exists to refuse.
	const perturbed = [...base, ...jobsOf(TEN, 4)];
	assert.deepEqual(
		Object.fromEntries(planWarmFleet({ nodes, served: perturbed, nowMs: FLEET_NOW })),
		allKeep
	);
	// Not vacuous: with the damping removed the same swap DOES rotate.
	assert.deepEqual(
		planWarmFleet({ nodes, served: perturbed, nowMs: FLEET_NOW, incumbentRatio: 1 }).get('claw-3'),
		{ action: 'rotate', from: CARD, to: TEN }
	);
});

test('planWarmFleet: damping is not pinning — a challenger past the ratio takes the slot', () => {
	const nodes = [
		{ node: 'claw-1', current: idleSlot(SITE) },
		{ node: 'claw-2', current: idleSlot(CARD) },
	];
	const served = [
		...jobsOf(SITE, 20),
		...jobsOf(CARD, 3),
		...jobsOf(TEN, 3 * WARM_INCUMBENT_RATIO + 1),
	];
	assert.deepEqual(planWarmFleet({ nodes, served, nowMs: FLEET_NOW }).get('claw-2'), {
		action: 'rotate',
		from: CARD,
		to: TEN,
	});
	// And a repo that left the window entirely is protected by no ratio at all.
	const gone = planWarmFleet({
		nodes,
		served: [...jobsOf(SITE, 20), ...jobsOf(TEN, 1)],
		nowMs: FLEET_NOW,
	});
	assert.deepEqual(gone.get('claw-2'), { action: 'rotate', from: CARD, to: TEN });
});

test('SAFETY planWarmFleet: could not look is idle everywhere — never an eviction', () => {
	const nodes = [
		{ node: 'claw-1', current: idleSlot(SITE) },
		{ node: 'claw-2', current: null },
	];
	for (const served of [null, []]) {
		assert.deepEqual(Object.fromEntries(planWarmFleet({ nodes, served, nowMs: FLEET_NOW })), {
			'claw-1': { action: 'idle' },
			'claw-2': { action: 'idle' },
		});
	}
});

test('planWarmFleet: more nodes than repos worth warming — the spare nodes keep what they hold', () => {
	const d = planWarmFleet({
		nodes: [
			{ node: 'claw-1', current: idleSlot(SITE) },
			{ node: 'claw-2', current: idleSlot(SITE) },
			{ node: 'claw-3', current: null },
		],
		served: jobsOf(SITE, 5),
		nowMs: FLEET_NOW,
	});
	// A second SITE listener still serves overflow; evicting it for NOTHING is
	// pure cost. An empty slot with nothing uncovered to hold stays empty.
	assert.deepEqual(Object.fromEntries(d), {
		'claw-1': { action: 'keep' },
		'claw-2': { action: 'keep' },
		'claw-3': { action: 'idle' },
	});
});

test('planWarmFleet: assigns ONLY the nodes it is given, whatever order they arrive in', () => {
	const served = [...jobsOf(SITE, 10), ...jobsOf(MEET, 5), ...jobsOf(CARD, 2), ...jobsOf(TEN, 1)];
	const nodes = [
		{ node: 'claw-5', current: null },
		{ node: 'claw-1', current: null },
	];
	const a = planWarmFleet({ nodes, served, nowMs: FLEET_NOW });
	const b = planWarmFleet({ nodes: [...nodes].reverse(), served, nowMs: FLEET_NOW });
	assert.deepEqual([...a.keys()].sort(), ['claw-1', 'claw-5']);
	assert.deepEqual(Object.fromEntries(a), Object.fromEntries(b));
	assert.deepEqual(Object.fromEntries(a), {
		'claw-1': { action: 'fill', repo: SITE },
		'claw-5': { action: 'fill', repo: MEET },
	});
});

test('the warm spawn plan has no RuntimeMaxSec and no jitconfig — it must outlive one job', () => {
	const plan = buildWarmSpawnPlan({
		unit: 'warm-claw-1-x',
		slot: '/h/.hadoku/warm/listener',
		memoryMaxMb: 3000,
	});
	assert.equal(plan.configPath, undefined);
	assert.equal(plan.configContent, undefined);
	assert.ok(!plan.argv.some((a) => a.includes('RuntimeMaxSec')));
	assert.ok(plan.argv.some((a) => a.includes('MemoryMax=3000M')));
	assert.ok(plan.argv.some((a) => a.includes('MemorySwapMax=0')));
	assert.ok(plan.argv.at(-2)?.endsWith('Runner.Listener'));
	assert.equal(plan.argv.at(-1), 'run');
});

// --- the construction path (I/O) --------------------------------------------

function warmHarness(over: { prov?: string | null; spawn?: string | null; regOk?: boolean } = {}) {
	const calls: string[] = [];
	const sh = async (_node: string, cmd: string): Promise<string | null> => {
		if (cmd.includes('warm-provision.sh')) {
			calls.push('provision');
			return over.prov === undefined
				? 'WARM-READY /home/hadoku/.hadoku/warm/listener 2.336.0'
				: over.prov;
		}
		if (cmd.includes('systemctl --user stop')) {
			calls.push('stop');
			return '';
		}
		calls.push('spawn');
		return over.spawn === undefined ? 'Running as unit: x.service' : over.spawn;
	};
	const gh = fakeGh({
		registrationTokenOk: over.regOk,
		runners: [{ id: 42, name: warmRunnerName('claw-1', 'WolffM/hadoku_site') }],
	});
	return { calls, sh, gh };
}

const WARM_REQ = {
	node: 'claw-1',
	repo: 'WolffM/hadoku_site',
	runnerName: warmRunnerName('claw-1', 'WolffM/hadoku_site'),
	labels: ['hadoku-builder'],
	homeDir: '/home/hadoku',
	memoryMaxMb: 4096,
};

test('mintWarmListener: registration token first, provision second, spawn third', async () => {
	const { calls, sh, gh } = warmHarness();
	const res = await mintWarmListener(WARM_REQ, 'tok', gh, sh);
	assert.equal(res.ok, true);
	assert.ok(gh.writes.some((p) => p.includes('registration-token')));
	assert.deepEqual(calls, ['provision', 'spawn']);
});

test('mintWarmListener: a failed registration-token call mints nothing', async () => {
	const { sh, gh } = warmHarness({ regOk: false });
	const res = await mintWarmListener(WARM_REQ, 'tok', gh, sh);
	assert.equal(res.ok, false);
	assert.match(res.reason ?? '', /registration-token/);
});

test('mintWarmListener: a failed provisioning step never reaches spawn', async () => {
	const { calls, sh, gh } = warmHarness({ prov: 'WARM-FAIL disk full' });
	const res = await mintWarmListener(WARM_REQ, 'tok', gh, sh);
	assert.equal(res.ok, false);
	assert.match(res.reason ?? '', /disk full/);
	assert.deepEqual(calls, ['provision']);
});

test('mintWarmListener: a node with no standing.env FAILS the fill rather than minting an unthrottled listener', async () => {
	// §A's fail-closed half, from the dispatcher's side. warm-provision.sh
	// refuses when `fleet throttle --confirm` has never rendered
	// ~/.hadoku/standing.env there, because a warm listener built without it is
	// a STANDING runner with no job-started hook — the node's declared cap,
	// bypassed, on the one runner shape this package mints for itself. The
	// dispatcher must see that as a failed fill (which the per-node backoff then
	// slows) and must carry the reason, not a bare "warm slot failed": a missing
	// deploy and a full disk are two different jobs.
	const { calls, sh, gh } = warmHarness({
		prov:
			'WARM-FAIL no /home/hadoku/.hadoku/standing.env — a standing listener would run with ' +
			'no throttle hook and no RUNNER_TOOL_CACHE. Run: fleet throttle --confirm --machine claw-1',
	});
	const res = await mintWarmListener(WARM_REQ, 'tok', gh, sh);
	assert.equal(res.ok, false);
	assert.match(res.reason ?? '', /standing\.env/);
	assert.match(res.reason ?? '', /fleet throttle --confirm/);
	assert.deepEqual(calls, ['provision'], 'nothing may be spawned against an unwired slot');
});

test('mintWarmListener: labels are self-hosted plus what the node EARNED — never a mint-only label', async () => {
	// A warm listener is STANDING, so it must not carry a label meaning "only a
	// fresh mint can serve this". `jit-canary` is exactly that, and the warm
	// cache carried it for two days: five consecutive site:jit-canary failures
	// on 2026-09-08/09, every one served by warm-claw-3-hadoku_site, failing the
	// step named "prove this ran on a minted runner".
	//
	// The forbidden set is DERIVED from the capability registry rather than
	// spelled here, so a mint-only capability added tomorrow is covered without
	// this test being edited — and a registry that went empty would make the
	// assertion vacuous, which is why it is asserted non-empty first.
	const forbidden = ephemeralOnlyLabels();
	assert.ok(forbidden.length > 0, 'no ephemeral-only labels exist, so this test proves nothing');

	const { sh, gh } = warmHarness();
	const seen: string[] = [];
	const spy = async (n: string, cmd: string) => {
		seen.push(cmd);
		return sh(n, cmd);
	};
	// The node's raw manifest labels, mint-only ones included — the exact input
	// that produced the canary failures.
	await mintWarmListener({ ...WARM_REQ, labels: ['hadoku-builder', ...forbidden] }, 'tok', gh, spy);
	const labels =
		/LABELS='([^']*)'/.exec(seen.find((c) => c.includes('warm-provision.sh')) ?? '')?.[1] ?? '';
	const sent = labels.split(',');
	assert.ok(sent.includes('self-hosted'), `self-hosted is missing: ${labels}`);
	assert.ok(sent.includes('hadoku-builder'), `the earned consumer label is missing: ${labels}`);
	for (const f of forbidden) {
		assert.ok(!sent.includes(f), `a standing listener must not carry ${f}: ${labels}`);
	}
});

test('mintWarmListener: a failed spawn cleans up the registration it just created', async () => {
	const { sh, gh } = warmHarness({ spawn: null });
	const res = await mintWarmListener(WARM_REQ, 'tok', gh, sh);
	assert.equal(res.ok, false);
	assert.ok(
		gh.writes.some((p) => p.includes('/actions/runners/42')),
		'DELETE by id after lookup'
	);
});

test('mintWarmListener never puts the registration token or repo url unescaped where a shell metacharacter could break out', async () => {
	const { sh, gh } = warmHarness();
	const seenCmds: string[] = [];
	const spy = async (n: string, cmd: string) => {
		seenCmds.push(cmd);
		return sh(n, cmd);
	};
	await mintWarmListener({ ...WARM_REQ, repo: "WolffM/it's-fine" }, 'tok', gh, spy);
	// shellSingleQuote turns `'` into `'\''` — assert the raw apostrophe never
	// sits inside an open single-quoted span unescaped, on the ONE command
	// (provisioning) that ever embeds the repo name.
	assert.ok(seenCmds.some((c) => c.includes(`'\\''`)));
});

test('evictWarmListener deletes the registration BEFORE stopping the unit', async () => {
	const order: string[] = [];
	const sh = async (_n: string, cmd: string) => {
		if (cmd.includes('systemctl --user stop')) order.push('stop');
		return '';
	};
	const gh = fakeGh({ runners: [{ id: 7, name: WARM_REQ.runnerName }] });
	const origWrite = gh.write;
	gh.write = async (m, p, t, b, r) => {
		if (m === 'DELETE') order.push('delete');
		return origWrite(m, p, t, b, r);
	};
	const ok = await evictWarmListener('claw-1', WARM_REQ.repo, WARM_REQ.runnerName, 'tok', gh, sh);
	assert.equal(ok, true);
	assert.deepEqual(order, ['delete', 'stop']);
});

test('evictWarmListener stops NOTHING when GitHub refuses the delete — the listener won the race to a job (CI run 37859515259)', async () => {
	const cmds: string[] = [];
	const sh = async (_n: string, cmd: string) => {
		cmds.push(cmd);
		return '';
	};
	const gh = fakeGh({ runners: [{ id: 7, name: WARM_REQ.runnerName }] });
	gh.write = async () => ({ ok: false, status: 422 });
	const ok = await evictWarmListener('claw-1', WARM_REQ.repo, WARM_REQ.runnerName, 'tok', gh, sh);
	assert.equal(ok, false);
	assert.deepEqual(cmds, [], 'neither the unit nor the marker was touched');
});

test('currentWarmSlot: no marker means no slot', async () => {
	const sh = async () => '';
	assert.equal(await currentWarmSlot('claw-1', sh), null);
});

test('currentWarmSlot: a marker with no live unit behind it is STALE, not a slot for the wrong repo', async () => {
	const sh = async (_n: string, cmd: string) => {
		if (cmd.includes('is-active')) return 'inactive';
		return 'WolffM/hadoku_site 1000';
	};
	assert.equal(await currentWarmSlot('claw-1', sh), null);
});

test('currentWarmSlot: a live marker resolves the repo and the unit name', async () => {
	const sh = async (_n: string, cmd: string) => {
		if (cmd.includes('is-active')) return 'active';
		return 'WolffM/hadoku_site 1000';
	};
	const slot = await currentWarmSlot('claw-1', sh);
	assert.deepEqual(slot, {
		repo: 'WolffM/hadoku_site',
		unit: warmRunnerName('claw-1', 'WolffM/hadoku_site'),
		markerAtMs: 1_000_000,
	});
});

test('readWarmMarker: dead is FALSE, unreadable is NULL — and currentWarmSlot collapses both', async () => {
	// The distinction #61 turns on. `currentWarmSlot` is allowed to answer "no
	// slot" for both, because the fill/rotate decision is the same either way.
	// A DELETE decision is not: it may act on the first and never on the second.
	const shDead = async (_n: string, cmd: string) =>
		cmd.includes('is-active') ? 'inactive' : 'WolffM/hadoku-tenhands 1000';
	const dead = await readWarmMarker('claw-1', shDead);
	assert.equal(dead?.active, false);
	assert.equal(dead?.repo, 'WolffM/hadoku-tenhands');
	assert.equal(dead?.unit, warmRunnerName('claw-1', 'WolffM/hadoku-tenhands'));
	assert.equal(await currentWarmSlot('claw-1', shDead), null);

	// The ssh failed. `|| true` means the node itself always exits 0, so a
	// `null` here can only be the transport — never systemd's answer.
	const shUnreadable = async (_n: string, cmd: string) =>
		cmd.includes('is-active') ? null : 'WolffM/hadoku-tenhands 1000';
	assert.equal((await readWarmMarker('claw-1', shUnreadable))?.active, null);
	assert.equal(await currentWarmSlot('claw-1', shUnreadable), null);

	// An EMPTY answer is equally unreadable — is-active prints a word when it
	// ran at all, so nothing at all is not "not active".
	const shEmpty = async (_n: string, cmd: string) =>
		cmd.includes('is-active') ? '' : 'WolffM/hadoku-tenhands 1000';
	assert.equal((await readWarmMarker('claw-1', shEmpty))?.active, null);

	// No marker: nothing to say, and no second ssh spent asking.
	assert.equal(await readWarmMarker('claw-1', async () => ''), null);
});

test('isRunnerBusy: null when the listing does not include it — cannot vouch for it', async () => {
	const gh = fakeGh({ runners: [] });
	assert.equal(
		await isRunnerBusy('WolffM/hadoku_site', 'warm-claw-1-hadoku-site', 'tok', gh),
		null
	);
});

test('isRunnerBusy: reads the busy field when the registration is found', async () => {
	const gh = fakeGh({ runners: [{ id: 1, name: 'warm-claw-1-hadoku-site', busy: true }] });
	assert.equal(
		await isRunnerBusy('WolffM/hadoku_site', 'warm-claw-1-hadoku-site', 'tok', gh),
		true
	);
});

// --- fleetServedJobs ---------------------------------------------------------

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), 'warmcache-'));
	__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
	__resetJobHistoryForTesting();
	__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
	__resetWarmCacheClockForTesting();
	__resetWarmBackoffForTesting();
	// Module-global and memoised for a DAY, so one test resolving it would
	// otherwise decide what every later test in this file sees.
	__resetTarballCacheForTesting();
	// The speed model (#83/wave 3z) rebuilds only every 10 minutes
	// (`SPEED_MODEL_REBUILD_INTERVAL_MS`) off a module-global cache keyed by
	// wall-clock `Date.now()` — not this file's fake tick clocks — so without
	// this reset, whichever test runs first in the process decides what every
	// later test's placement order sees.
	__resetSpeedModelForTesting();
	// Wave 4a (#100): the generic admission verdict snapshot is module-level,
	// same leak class as every other reset in this block.
	__resetAdmissionVerdictsForTesting();
	// Wave 4e follow-up (#102): module-level, same leak class as every other
	// reset in this block — a test that forgot to clear it would leak its
	// fixture `$proof` context into every test that runs after it.
	__setWorkloadGateContextForTesting(null);
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	__setHistoryPathForTesting(null);
	__setWorkloadGateContextForTesting(null);
	__resetWorkloadGateCorruptionLogForTesting();
	__setHostForTesting(testHost);
});

/**
 * History fixture timestamps are RELATIVE, and that is not a style preference.
 *
 * `servedJobsByNode` reads through `jobRecords()`, which drops every record
 * older than the ROLLING `RETENTION_DAYS = 14` window. A fixture pinned to an
 * absolute date therefore carries an expiry date: these were written at
 * `2026-09-01T00:00:00Z`, the cutoff reached them on 2026-09-15, and thirteen
 * tests went red on a file nobody had touched — issue #27, the same class
 * 473dfdb fixed for `job-history.test.ts` a week earlier. CI was green only
 * because it had last run the day before.
 *
 * Two days back, for the same reasons 473dfdb chose it: far enough inside the
 * window that a slow suite cannot drift out of it, recent enough to be
 * obviously live.
 *
 * `HIST_T0` is deliberately NOT `T0` below. `T0` is the fake dispatch tick
 * clock handed to `dispatchWarmCache` as its `now`, an arbitrary monotonic
 * millisecond count that must stay far from the module's `0` sentinel; this one
 * is wall-clock time that the retention cutoff compares against. Collapsing the
 * two would tie the tick clock to the calendar and put the sentinel collision
 * back in play.
 */
const HIST_T0 = Date.now() - 2 * 24 * 3600_000;
/** `HIST_T0` plus `sec`, as the ISO string the Actions API would return. */
const histAt = (sec: number) => new Date(HIST_T0 + sec * 1000).toISOString();

function writeRecord(r: Partial<Record<string, unknown>>) {
	appendFileSync(
		historyFile(),
		JSON.stringify({
			repo: 'WolffM/hadoku_site',
			runId: 1,
			jobId: Math.floor(Math.random() * 1e9),
			name: 'typecheck',
			runner: 'claw-1',
			labels: ['self-hosted'],
			startedAt: histAt(0),
			durationSec: 60,
			conclusion: 'success',
			...r,
		}) + '\n'
	);
}

test('fleetServedJobs: every job in the fleet, whichever runner served it', () => {
	// The joint allocation values a repo by the FLEET's demand: a warm listener
	// takes its repo's next job wherever GitHub would otherwise have sent it, so
	// hokon's jobs and an ineligible node's jobs are demand too.
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	writeRecord({ runner: 'hokon', repo: 'WolffM/hadoku-rally', startedAt: histAt(60) });
	writeRecord({
		runner: 'jit-claw-2-hadoku-site-j1-r1-1700000000',
		repo: 'WolffM/hadoku_site',
		startedAt: histAt(120),
	});
	// writeRecord's default durationSec is 60: the duration rides along, because
	// it is what tells overlapping jobs from serial ones (warmUnitValues).
	assert.deepEqual(fleetServedJobs(), [
		{ repo: 'WolffM/hadoku_site', startedAtMs: Date.parse(histAt(0)), durationMs: 60_000 },
		{ repo: 'WolffM/hadoku-rally', startedAtMs: Date.parse(histAt(60)), durationMs: 60_000 },
		{ repo: 'WolffM/hadoku_site', startedAtMs: Date.parse(histAt(120)), durationMs: 60_000 },
	]);
});

test('fleetServedJobs: a missing history is empty, not a throw — and empty holds every slot', () => {
	__setHistoryPathForTesting(join(tmp, 'does-not-exist-either', 'job-history.jsonl'));
	__resetJobHistoryForTesting();
	const served = fleetServedJobs();
	assert.deepEqual(served, []);
	assert.deepEqual(
		planWarmFleet({
			nodes: [{ node: 'claw-1', current: idleSlot(SITE) }],
			served,
			nowMs: Date.now(),
		}).get('claw-1'),
		{ action: 'idle' }
	);
});

// --- parseSpaceProbe ----------------------------------------------------------
//
// #101 lane A5: `shellOnNode`'s real stdout (`execFile`'s `stdout`) ends in a
// trailing newline. The prior parser split on `\n` and read the LAST TWO
// elements of that array, so on a trailing newline it read [tmp, work, '']
// and shifted — tmp became WORK's figure, work became "unreadable". Every
// case below uses REALISTIC strings (with the newline real output has)
// rather than the no-trailing-newline shape every other fixture in this
// suite used to answer with.

test('parseSpaceProbe: the exact claw-4 capture (#101) reads tmp and work correctly', () => {
	const out = '12111 15936\n4824\n826946\n';
	const r = parseSpaceProbe(out);
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, 4824);
	assert.equal(r.workFreeMb, 826946);
});

test('parseSpaceProbe #132: the /tmp line carries free THEN size; free alone reads a null size', () => {
	const r = parseSpaceProbe('12111 15936\n3900 3994\n826946\n');
	assert.equal(r.tmpFreeMb, 3900);
	assert.equal(r.tmpSizeMb, 3994);
	assert.equal(r.workFreeMb, 826946);
	assert.equal(parseSpaceProbe('12111 15936\n4824\n826946\n').tmpSizeMb, null);
	const bad = parseSpaceProbe('12111 15936\n3900 -1\n826946\n');
	assert.equal(bad.tmpFreeMb, null, 'a malformed size makes the whole line unreadable');
	assert.equal(bad.tmpSizeMb, null);
});

test('parseSpaceProbe: the warm-tick shape (single-column first line), trailing newline', () => {
	const r = parseSpaceProbe('15936\n4824\n826946\n');
	assert.equal(r.first, '15936');
	assert.equal(r.tmpFreeMb, 4824);
	assert.equal(r.workFreeMb, 826946);
});

test('parseSpaceProbe: same shape with NO trailing newline still reads correctly', () => {
	const r = parseSpaceProbe('12111 15936\n4824\n826946');
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, 4824);
	assert.equal(r.workFreeMb, 826946);
});

test('parseSpaceProbe: CRLF line endings are stripped, not read as part of the figure', () => {
	const r = parseSpaceProbe('12111 15936\r\n4824\r\n826946\r\n');
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, 4824);
	assert.equal(r.workFreeMb, 826946);
});

test('parseSpaceProbe: a blank line in the middle is dropped, not counted', () => {
	const r = parseSpaceProbe('12111 15936\n\n4824\n826946\n');
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, 4824);
	assert.equal(r.workFreeMb, 826946);
});

test('parseSpaceProbe: only the first line present — both unreadable, never shifted', () => {
	const r = parseSpaceProbe('12111 15936\n');
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, null);
	assert.equal(r.workFreeMb, null);
});

test('parseSpaceProbe: two lines (missing the jit figure) — both unreadable, not read as tmp+work', () => {
	const r = parseSpaceProbe('12111 15936\n4824\n');
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, null);
	assert.equal(r.workFreeMb, null);
});

test('parseSpaceProbe: four lines (an extra one) — both unreadable, a shifted line is never read as the other', () => {
	const r = parseSpaceProbe('12111 15936\n4824\n826946\nextra\n');
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, null);
	assert.equal(r.workFreeMb, null);
});

test('parseSpaceProbe: garbage on the tmp line — tmp unreadable, work still read (line count is right)', () => {
	const r = parseSpaceProbe('12111 15936\ndf: /tmp: No such file or directory\n826946\n');
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, null);
	assert.equal(r.workFreeMb, 826946);
});

test('parseSpaceProbe: null input — unreachable, both unreadable, first is empty', () => {
	const r = parseSpaceProbe(null);
	assert.equal(r.first, '');
	assert.equal(r.tmpFreeMb, null);
	assert.equal(r.workFreeMb, null);
});

test('parseSpaceProbe: empty string input — both unreadable, first is empty', () => {
	const r = parseSpaceProbe('');
	assert.equal(r.first, '');
	assert.equal(r.tmpFreeMb, null);
	assert.equal(r.workFreeMb, null);
});

// --- dispatchWarmCache end to end --------------------------------------------

interface NodeSim {
	marker: string | null; // "repo epochSec"
	activeUnits: Set<string>;
	/** Installed MB `free -m` reports for this node. Default is comfortably
	 * eligible (16 GB-class) so tests that are not exercising eligibility
	 * itself do not have to think about it. */
	installedMb?: number;
	/** When set, every `warm-provision.sh` fill on this node fails with this
	 * reason instead of succeeding — for the backoff tests. */
	provisionFails?: string;
	/** #101: free MB this sim reports for `/tmp` and for `~/.hadoku/jit`, off
	 * the SAME combined `sh` call the dispatch tick's `free -m` probe now
	 * carries `df -Pm` on. Default is comfortably clear of
	 * `TMP_FREE_FLOOR_MB`/`WORK_FREE_FLOOR_MB` so a test not exercising the
	 * space clause itself does not have to think about it. */
	tmpFreeMb?: number;
	workFreeMb?: number;
	/** #101: when set, the `df` line(s) named come back unreadable (garbage,
	 *  not a bare integer) instead of a number — same effect as a `df` that
	 *  fails or prints an error on a live node. */
	dfUnreadable?: 'tmp' | 'work' | 'both';
}

const DEFAULT_INSTALLED_MB = 16_000;
const DEFAULT_SPACE_FREE_MB = 8_000;

function simShell(sims: Record<string, NodeSim>) {
	return async (node: string, cmd: string): Promise<string | null> => {
		const s = (sims[node] ??= { marker: null, activeUnits: new Set() });
		// TWO COLUMNS for the dispatch tick (`$7, $2` — available AND installed),
		// one for the warm tick (`$2` alone). Both halves of the warm placement
		// decision are measured off this same line, which is the point: the tick
		// that PLACES a listener and the tick that holds a slot back for it must
		// not be reading two different numbers.
		if (cmd.includes('free -m')) {
			const total = String(s.installedMb ?? DEFAULT_INSTALLED_MB);
			// #101: BOTH shapes — the dispatch tick's `$7, $2` and the warm
			// tick's `$2` alone — piggyback the SAME `df -Pm` tail (shared
			// `SPACE_PROBE_DF_CMD`), so this mock must answer it for either,
			// never just the shape it happened to be written against first.
			const freeLine = cmd.includes('$7, $2')
				? `${Math.floor(Number(total) * 0.8)} ${total}`
				: total;
			if (!cmd.includes('df -Pm')) return freeLine;
			const tmp =
				s.dfUnreadable === 'tmp' || s.dfUnreadable === 'both'
					? 'df: /tmp: No such file or directory'
					: String(s.tmpFreeMb ?? DEFAULT_SPACE_FREE_MB);
			const work =
				s.dfUnreadable === 'work' || s.dfUnreadable === 'both'
					? 'df: /home: No such file or directory'
					: String(s.workFreeMb ?? DEFAULT_SPACE_FREE_MB);
			// #101: a trailing newline, the way `execFile`'s real stdout always
			// has one — the bug this models split on `\n` and read the LAST two
			// elements, which with this newline present is `[tmp, work, '']`.
			return `${freeLine}\n${tmp}\n${work}\n`;
		}
		if (cmd.includes('warm-provision.sh')) {
			if (s.provisionFails) return `WARM-FAIL ${s.provisionFails}`;
			const repo = /REPO='([^']*)'/.exec(cmd)?.[1] ?? '';
			s.marker = `${repo} 1000`;
			return 'WARM-READY /home/hadoku/.hadoku/warm/listener 2.336.0';
		}
		if (cmd.includes('systemd-run')) {
			const unit = /--unit=(\S+)/.exec(cmd)?.[1];
			if (unit) s.activeUnits.add(unit);
			return 'Running as unit: x.service';
		}
		if (cmd.startsWith('rm -f')) {
			s.marker = null;
			return '';
		}
		if (cmd.startsWith('touch')) {
			if (s.marker) s.marker = `${s.marker.split(' ')[0]} 999999`;
			return '';
		}
		if (cmd.includes('systemctl --user stop')) {
			const unit = /stop\s+(\S+)/.exec(cmd)?.[1];
			if (unit) s.activeUnits.delete(unit);
			return '';
		}
		if (cmd.includes('is-active')) {
			const unit = /is-active\s+(\S+)/.exec(cmd)?.[1];
			return unit && s.activeUnits.has(unit) ? 'active' : 'inactive';
		}
		if (cmd.includes('warm/repo')) return s.marker ?? '';
		return '';
	};
}

const NODE_ELIGIBLE = {
	labels: ['hadoku-builder'],
	maxConcurrent: 3,
	minFreeMb: 2048,
	slice: { unitMaxMb: 4096 },
};
// issue #7's exact shape: claw-2 DECLARES `maxConcurrent: 2` for job-scheduling
// purposes — which the old code fed straight to warmCacheEligible and got a
// false "yes" — while its measured installed RAM (set on the sim below) leaves
// a JIT half too small for even one mint. Eligibility must be measured, not
// read off maxConcurrent, or this fixture would wrongly pass.
const NODE_INELIGIBLE = { labels: ['hadoku-builder'], maxConcurrent: 2, minFreeMb: 1536 };
/** usable 4464: a 2232 MB JIT half against a 4096 MB mint -> no listener. */
const INELIGIBLE_INSTALLED_MB = 6000;

function baseInput(over: Partial<EphemeralTickInput> = {}): EphemeralTickInput {
	return {
		fleetProbe: new Map([['claw-1', { reachable: true, busyRepos: null }]]),
		ephemeral: new Set(['claw-1']),
		nodes: { 'claw-1': NODE_ELIGIBLE },
		isSick: () => false,
		repos: ['WolffM/hadoku_site'],
		...over,
	};
}

// A clock nowhere near the module's `lastWarmCacheMs` reset value (0) — using
// a literal 0 for "the first tick" would collide with that sentinel and the
// gate would (correctly, for real traffic where Date.now() is never 0) treat
// it as "already ran this interval".
const T0 = 10_000_000;

test('dispatchWarmCache: fills an idle eligible node from what it has served', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {};
	const sh = simShell(sims);
	const gh = fakeGh({});
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
	assert.equal(res.filled, 1);
	assert.equal(sims['claw-1'].marker, 'WolffM/hadoku_site 1000');
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

/** `NODE_ELIGIBLE`, but it also EARNED jdk21's tool proof. */
const NODE_ELIGIBLE_JDK21 = {
	...NODE_ELIGIBLE,
	$capabilities: { earned: ['jdk21'], prereqs: [] },
};

const proofRec = (over: Partial<ProofRecord> = {}): ProofRecord => ({
	node: 'claw-1',
	capability: 'jdk21',
	runId: 1,
	runner: 'jit-claw-1-proof-hadoku-cardtable-j0-r0-1',
	conclusion: 'success',
	durationSec: 300,
	evidenceMatched: true,
	budgetSec: null,
	verdict: 'pass',
	why: 'pass (budget unbootstrapped: 0/2 proven node(s))',
	at: new Date().toISOString(),
	...over,
});

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

test('SAFETY dispatchWarmCache: a guest marked ephemeral is never probed, at 62 GB', async () => {
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
				hokon: { ...NODE_ELIGIBLE, minFreeMb: 8192, role: 'guest' },
			},
		}),
		'tok',
		fakeGh({}),
		sh,
		T0
	);
	assert.equal(touched.includes('hokon'), false, 'no ssh reaches the guest');
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

// --- issue #7: the drain check, the kill switch, and the backoff ------------

test('dispatchWarmCache: a drained node with no existing listener is never filled', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	// Nothing age-filters a drain `since` today — it only reaches the eligibility
	// reason string. Anchored anyway: "nothing filters on it yet" is exactly the
	// assumption that rotted here, and it leaves this file with no absolute date
	// at all, so the rule needs no per-line exception.
	writeDrain({ 'claw-1': { since: histAt(0), reason: 'DRAM fault', by: 'hadoku' } });
	try {
		let shCalls = 0;
		const inner = simShell({});
		const sh = async (n: string, c: string) => {
			shCalls++;
			return inner(n, c);
		};
		const gh = fakeGh({});
		const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
		assert.deepEqual(res, {
			filled: 0,
			rotated: 0,
			kept: 0,
			locked: 0,
			evicted: 0,
			reaped: 0,
			failed: 0,
		});
		// #90: the node is now OBSERVED (memory read, marker read) — the same
		// pipeline the slow tier already goes through — because a drained node
		// with an EXISTING listener must still be found and evicted (see the
		// next test). What stays true from before this wave is the end state: no
		// fill, and no GitHub call at all when there was nothing to evict.
		assert.ok(shCalls > 0, 'the node is observed, not skipped outright');
		assert.equal(gh.calls.length, 0, 'nothing to evict means nothing to ask GitHub about');
	} finally {
		writeDrain({});
	}
});

test('dispatchWarmCache: a drained node holding a warm listener has it evicted, never re-filled (#90)', async () => {
	// claw-5 was drained 2026-10-03 20:05Z and still served 23 jobs through
	// `warm-claw-5-hadoku_site` before the listener was evicted the next day —
	// the warm half of #90. This reproduces it: a drained node whose warm
	// listener is otherwise perfectly healthy (not busy, well past the assign
	// window) must lose it on the very next warm-cache tick, exactly the way
	// the slow tier already loses its own (#83) — same lock, same per-node
	// try/catch, same `evictWarmListener` call.
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	// Past WARM_ASSIGN_WINDOW_MS, same as the "rotates" test above — otherwise
	// the assign-window lock alone would explain a refusal to evict and this
	// test would not isolate the drain rule at all.
	const nowMs = 1_000_000 + WARM_ASSIGN_WINDOW_MS + 1;
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku_site 1000', activeUnits: new Set([unit]) },
	};
	const sh = simShell(sims);
	const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: false }] });
	writeDrain({ 'claw-1': { since: histAt(0), reason: 'semi-annual stress test', by: 'hadoku' } });
	try {
		const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, nowMs);
		assert.equal(res.evicted, 1, 'the listener GitHub could still assign to must be removed');
		assert.equal(
			res.filled,
			0,
			'a drained node is never re-filled, even onto the repo it just lost'
		);
		assert.ok(!sims['claw-1'].activeUnits.has(unit), 'the systemd unit must be stopped');
		assert.equal(sims['claw-1'].marker, null, 'the marker must be cleared, not left stale');
		assert.ok(
			gh.writes.some((w) => w.includes('/actions/runners/1')),
			`the registration must reach GitHub as a DELETE: ${gh.writes.join(' ')}`
		);
	} finally {
		writeDrain({});
	}
});

test('dispatchWarmCache: a drained node whose warm listener is BUSY stops being assigned at once', async () => {
	// 2026-10-25: claw-9 was drained at 04:57; its warm listener was busy at
	// every look, so the eviction stayed locked, the delete it finally tried
	// got 422, and it started 13 jobs after the drain, the last at 05:12. The
	// running job must finish, but GitHub must not hand it another.
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const nowMs = 1_000_000 + WARM_ASSIGN_WINDOW_MS + 1;
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku_site 1000', activeUnits: new Set([unit]) },
	};
	const gh = fakeGh({
		runners: [
			{
				id: 1,
				name: unit,
				busy: true,
				labels: ['hadoku-builder'],
			},
		],
	});
	writeDrain({ 'claw-1': { since: histAt(0), reason: 'stress lease', by: 'hadoku' } });
	try {
		const res = await dispatchWarmCache(baseInput(), 'tok', gh, simShell(sims), nowMs);
		assert.ok(
			gh.writes.some((w) => w.endsWith('/actions/runners/1/labels')),
			`its custom labels must be removed: ${gh.writes.join(' ')}`
		);
		assert.equal(res.evicted, 0, 'a busy registration is not deleted under its job');
		assert.ok(sims['claw-1'].activeUnits.has(unit), 'the running job keeps its unit');
	} finally {
		writeDrain({});
	}
});

test('SAFETY dispatchWarmCache: a warm listener killed outside this code path is reaped, not leaked (#61)', async () => {
	// claw-9's 2026-09-22/23 migration reboots, reproduced. A warm unit is
	// transient, so the reboot takes it; `$HOME/.hadoku/warm/repo` is a file in
	// $HOME, so the reboot does not. The next tick read "no live slot", took the
	// FILL branch rather than rotate, and `RESET=1` overwrote the marker with the
	// new repo — after which nothing in the fleet held the old repo's name.
	// `warm-claw-9-hadoku-tenhands` sat registered and offline with carriers []
	// until it was deleted by hand.
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const ghost = warmRunnerName('claw-1', 'WolffM/hadoku-tenhands');
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku-tenhands 1000', activeUnits: new Set() },
	};
	const gh = fakeGh({ runners: [{ id: 159, name: ghost, status: 'offline', busy: false }] });
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, simShell(sims), T0);

	assert.equal(res.reaped, 1, 'the dead registration was removed');
	assert.ok(
		gh.writes.includes('/actions/runners/159'),
		`the ghost's id reached GitHub as a DELETE: ${gh.writes.join(' ')}`
	);
	// Counted apart from an eviction: this tick never got to DECIDE about that
	// slot, it found one already dead.
	assert.equal(res.evicted, 0);
	// And the tick still did the job it came to do, on the same pass.
	assert.equal(res.filled, 1);
	assert.equal(sims['claw-1'].marker, 'WolffM/hadoku_site 1000');
});

test('SAFETY dispatchWarmCache: "could not look" never reaps — an unreadable is-active is not a death', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const ghost = warmRunnerName('claw-1', 'WolffM/hadoku-tenhands');
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku-tenhands 1000', activeUnits: new Set() },
	};
	const inner = simShell(sims);
	// Only the liveness probe fails. Everything else on the node answers, so
	// this is the transport losing ONE question, not an unreachable node.
	const sh = async (n: string, c: string) => (c.includes('is-active') ? null : inner(n, c));
	const gh = fakeGh({ runners: [{ id: 159, name: ghost, status: 'offline', busy: false }] });
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);

	assert.equal(res.reaped, 0);
	assert.equal(
		gh.writes.includes('/actions/runners/159'),
		false,
		`nothing was deleted: ${gh.writes.join(' ')}`
	);
});

test('SAFETY dispatchWarmCache: a stale marker whose registration still answers is never reaped', async () => {
	// Three facts must agree. Here systemd says the unit is dead and GitHub says
	// the registration is online (or busy) — something IS answering for it, and
	// deleting it would cancel whatever it is running. The marker is stale; the
	// registration is not.
	const ghost = warmRunnerName('claw-1', 'WolffM/hadoku-tenhands');
	const run = async (reg: { status?: string; busy?: boolean }) => {
		__resetWarmCacheClockForTesting();
		writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
		const sims: Record<string, NodeSim> = {
			'claw-1': { marker: 'WolffM/hadoku-tenhands 1000', activeUnits: new Set() },
		};
		const gh = fakeGh({ runners: [{ id: 159, name: ghost, ...reg }] });
		const res = await dispatchWarmCache(baseInput(), 'tok', gh, simShell(sims), T0);
		return { res, gh };
	};

	const online = await run({ status: 'online', busy: false });
	assert.equal(online.res.reaped, 0);
	assert.equal(online.gh.writes.includes('/actions/runners/159'), false);

	const busy = await run({ status: 'offline', busy: true });
	assert.equal(busy.res.reaped, 0);
	assert.equal(busy.gh.writes.includes('/actions/runners/159'), false);

	// And the case where the listing simply does not carry it: already gone, or
	// the listing could not be read. `warmRegistration` cannot tell those apart,
	// so neither may this.
	__resetWarmCacheClockForTesting();
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku-tenhands 1000', activeUnits: new Set() },
	};
	const gh = fakeGh({ runners: [] });
	const absent = await dispatchWarmCache(baseInput(), 'tok', gh, simShell(sims), T0);
	assert.equal(absent.reaped, 0);
	// A DELETE is `/actions/runners/<id>`. The fill on this same pass legitimately
	// POSTs `/actions/runners/registration-token`, so the prefix alone is not the
	// assertion.
	assert.equal(
		gh.writes.some((w) => /^\/actions\/runners\/\d+$/.test(w)),
		false
	);
});

test('SAFETY dispatchWarmCache: an unreachable node has nothing of its reaped', async () => {
	// §12.8's direction, on the reap's own path: a node we cannot reach cannot
	// be vouched for, so its registrations are not ours to delete this tick.
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const ghost = warmRunnerName('claw-1', 'WolffM/hadoku-tenhands');
	const gh = fakeGh({ runners: [{ id: 159, name: ghost, status: 'offline', busy: false }] });
	const res = await dispatchWarmCache(
		baseInput({ fleetProbe: new Map([['claw-1', { reachable: false, busyRepos: null }]]) }),
		'tok',
		gh,
		simShell({ 'claw-1': { marker: 'WolffM/hadoku-tenhands 1000', activeUnits: new Set() } }),
		T0
	);
	assert.equal(res.reaped, 0);
	assert.equal(gh.writes.length, 0);
});

test('dispatchWarmCache: WARM_CACHE_DISABLED=1 is a total kill switch — no I/O at all', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const prev = process.env.WARM_CACHE_DISABLED;
	process.env.WARM_CACHE_DISABLED = '1';
	try {
		let shCalls = 0;
		const inner = simShell({});
		const sh = async (n: string, c: string) => {
			shCalls++;
			return inner(n, c);
		};
		const gh = fakeGh({});
		const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
		assert.deepEqual(res, {
			filled: 0,
			rotated: 0,
			kept: 0,
			locked: 0,
			evicted: 0,
			reaped: 0,
			failed: 0,
		});
		assert.equal(shCalls, 0);
		assert.equal(gh.calls.length, 0);
	} finally {
		if (prev === undefined) delete process.env.WARM_CACHE_DISABLED;
		else process.env.WARM_CACHE_DISABLED = prev;
	}
});

test('dispatchWarmCache: the kill switch does not consume the tick clock', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {};
	const sh = simShell(sims);
	const gh = fakeGh({});
	process.env.WARM_CACHE_DISABLED = '1';
	const disabled = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
	assert.deepEqual(disabled, {
		filled: 0,
		rotated: 0,
		kept: 0,
		locked: 0,
		evicted: 0,
		reaped: 0,
		failed: 0,
	});
	delete process.env.WARM_CACHE_DISABLED;
	// Same instant. If disabling had touched `lastWarmCacheMs`, re-enabling
	// would read this as "still inside the interval" and also do nothing.
	const enabled = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
	assert.equal(enabled.filled, 1);
});

test('dispatchWarmCache: repeated fill failures back off instead of retrying every tick', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: null, activeUnits: new Set(), provisionFails: 'disk full' },
	};
	const sh = simShell(sims);
	const gh = fakeGh({});

	const t1 = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
	assert.equal(t1.failed, 1);
	const callsAfterT1 = gh.calls.length;
	assert.ok(callsAfterT1 > 0, 'the first failure really did call GitHub');

	// One failure's delay is exactly one tick (60s), so the very next tick is
	// not yet backed off and gets a second, genuine, attempt.
	const t2 = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0 + WARM_CACHE_INTERVAL_MS);
	assert.equal(t2.failed, 1);
	const callsAfterT2 = gh.calls.length;
	assert.ok(callsAfterT2 > callsAfterT1);

	// Two consecutive failures double the delay to 120s against a 60s tick —
	// the next tick must be SILENTLY skipped: no GitHub call, no `failed`.
	const t3 = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0 + 2 * WARM_CACHE_INTERVAL_MS);
	assert.equal(t3.failed, 0, 'backed off — not a fresh, uncounted failure');
	assert.equal(gh.calls.length, callsAfterT2, 'no GitHub call while backed off');

	// Past the 120s delay, it tries again.
	const t4 = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0 + 3 * WARM_CACHE_INTERVAL_MS);
	assert.equal(t4.failed, 1);
	assert.ok(gh.calls.length > callsAfterT2);
});

test('dispatchWarmCache: the backoff caps at 1 hour, however long the failure streak', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: null, activeUnits: new Set(), provisionFails: 'disk full' },
	};
	const sh = simShell(sims);
	const gh = fakeGh({});
	const ONE_HOUR_MS = 60 * WARM_CACHE_INTERVAL_MS;

	// Drive enough consecutive failures that uncapped doubling would exceed an
	// hour (2^9 * 60s ≈ 8.5h): step `now` forward by exactly the delay the
	// production formula computes, so every attempt lands just past its own
	// backoff and is never accidentally suppressed by this loop itself.
	let now = T0;
	let delay = WARM_CACHE_INTERVAL_MS;
	for (let i = 0; i < 10; i++) {
		const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, now);
		assert.equal(res.failed, 1, `attempt ${i} at ${now} should not be suppressed`);
		now += delay;
		delay = Math.min(delay * 2, ONE_HOUR_MS);
	}

	const failedAt = now;
	const capped = await dispatchWarmCache(baseInput(), 'tok', gh, sh, now);
	assert.equal(capped.failed, 1);

	// Nowhere near the cap yet (two ticks on), but well past the doubling this
	// loop would have produced with no ceiling — still suppressed.
	const stillWaiting = await dispatchWarmCache(
		baseInput(),
		'tok',
		gh,
		sh,
		failedAt + 2 * WARM_CACHE_INTERVAL_MS
	);
	assert.equal(stillWaiting.failed, 0, 'the cap holds the delay well short of another doubling');

	// Exactly at the cap, tried again — never longer than the 1h ceiling.
	const atCap = await dispatchWarmCache(baseInput(), 'tok', gh, sh, failedAt + ONE_HOUR_MS);
	assert.equal(atCap.failed, 1, 'exactly at the 1h cap, tried again — never longer than the cap');
});

test('dispatchWarmCache: a successful mint clears the backoff', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: null, activeUnits: new Set(), provisionFails: 'disk full' },
	};
	const sh = simShell(sims);
	const gh = fakeGh({});

	const t1 = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
	assert.equal(t1.failed, 1);

	// The fault clears; the very next tick (still only one failure's worth of
	// delay behind) succeeds and must reset the streak.
	sims['claw-1'].provisionFails = undefined;
	const t2 = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0 + WARM_CACHE_INTERVAL_MS);
	assert.equal(t2.filled, 1);

	// Break it again immediately. If the earlier failure streak had survived
	// the success, this fresh failure would read as still-backed-off and be
	// silently skipped instead of counted.
	sims['claw-1'].marker = null;
	sims['claw-1'].activeUnits.clear();
	sims['claw-1'].provisionFails = 'disk full';
	const t3 = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0 + 2 * WARM_CACHE_INTERVAL_MS);
	assert.equal(t3.failed, 1, 'a fresh failure right after a success must not be silently skipped');
});

test('dispatchWarmCache: the backoff SURVIVES a restart — it is on disk, not in memory', async () => {
	// The observed production failure, reproduced. Deployed 0.22.49 retried
	// claw-1/3/5 every 60-90s forever and read as a backoff that was not
	// wrapping this path at all; it was, and mgmt-api restarting (17 times on
	// 2026-09-08, four of them inside the eleven minutes those retries span)
	// put `failures` back to 0 before the doubling could ever outrun the tick.
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: null, activeUnits: new Set(), provisionFails: 'disk full' },
	};
	const sh = simShell(sims);
	const gh = fakeGh({});

	// Two failures: the delay is now 120s against a 60s tick.
	assert.equal((await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0)).failed, 1);
	assert.equal(
		(await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0 + WARM_CACHE_INTERVAL_MS)).failed,
		1
	);
	const callsBefore = gh.calls.length;

	// mgmt-api restarts. Module state is gone; the streak must not be.
	__restartWarmBackoffForTesting();
	__resetWarmCacheClockForTesting();

	const afterRestart = await dispatchWarmCache(
		baseInput(),
		'tok',
		gh,
		sh,
		T0 + 2 * WARM_CACHE_INTERVAL_MS
	);
	assert.equal(afterRestart.failed, 0, 'a restart must not reset the failure streak');
	assert.equal(gh.calls.length, callsBefore, 'no GitHub call while backed off across a restart');

	// And it still expires on schedule rather than sticking forever.
	__resetWarmCacheClockForTesting();
	const past = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0 + 3 * WARM_CACHE_INTERVAL_MS);
	assert.equal(past.failed, 1);
});

test('dispatchWarmCache: a success clears the streak on disk too, not only in memory', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: null, activeUnits: new Set(), provisionFails: 'disk full' },
	};
	const sh = simShell(sims);
	const gh = fakeGh({});
	const tick = WARM_CACHE_INTERVAL_MS;

	// Three failures: 60s, then 120s, then 240s. Stepping `now` by the delay
	// the production formula computes keeps every attempt just past its own
	// backoff rather than accidentally suppressed by this loop.
	assert.equal((await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0)).failed, 1);
	assert.equal((await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0 + tick)).failed, 1);
	assert.equal((await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0 + 3 * tick)).failed, 1);

	// The fault clears.
	sims['claw-1'].provisionFails = undefined;
	assert.equal((await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0 + 7 * tick)).filled, 1);

	// mgmt-api restarts, and the node breaks again. A streak left behind on
	// disk would make this fresh failure the FOURTH — a 480s delay — and the
	// tick two minutes later would be silently skipped instead of retried.
	// That is the mirror of the bug this file is fixing: state that outlives
	// what it describes is as wrong as state that does not outlive it.
	__restartWarmBackoffForTesting();
	sims['claw-1'] = { marker: null, activeUnits: new Set(), provisionFails: 'disk full' };
	assert.equal((await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0 + 8 * tick)).failed, 1);

	__restartWarmBackoffForTesting();
	const fresh = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0 + 10 * tick);
	assert.equal(fresh.failed, 1, 'the post-success failure must back off as a FIRST failure');
});

// --- the payload source: RUNNER_TARBALL_URL reaches the node -----------------

/** `fakeGh` with a real `/actions/runners/downloads` listing behind it. */
function ghWithDownloads(over: Parameters<typeof fakeGh>[0] = {}) {
	const gh = fakeGh(over);
	const inner = gh.get;
	return Object.assign(gh, {
		get: async (path: string, token: string, repo?: string) => {
			if (path.includes('/actions/runners/downloads')) {
				gh.calls.push(path);
				return [
					{ os: 'osx', architecture: 'arm64', download_url: 'https://x/osx.tar.gz' },
					{ os: 'linux', architecture: 'x64', download_url: 'https://x/linux-x64.tar.gz' },
				];
			}
			return inner(path, token, repo);
		},
	});
}

test('a warm fill carries RUNNER_TARBALL_URL — the fallback was hard-coded null before', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {};
	const seen: string[] = [];
	const inner = simShell(sims);
	const sh = async (n: string, c: string) => {
		seen.push(c);
		return inner(n, c);
	};
	const gh = ghWithDownloads({});
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
	assert.equal(res.filled, 1);
	const prov = seen.find((c) => c.includes('warm-provision.sh'));
	assert.ok(prov, 'nothing provisioned');
	// linux/x64, not whatever came first — an osx-arm64 tarball unpacks fine
	// and then fails at `Runner.Listener --version`.
	assert.match(prov, /RUNNER_TARBALL_URL='https:\/\/x\/linux-x64\.tar\.gz'/);
});

test('the tarball URL is resolved LAZILY — an all-kept tick spends no API call on it', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: 'WolffM/hadoku_site 1000', activeUnits: new Set([unit]) },
	};
	const sh = simShell(sims);
	const gh = ghWithDownloads({ runners: [{ id: 1, name: unit, busy: false }] });
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, T0);
	assert.equal(res.kept, 1);
	assert.deepEqual(
		gh.calls.filter((c) => c.includes('downloads')),
		[],
		'a tick that mints nothing must not spend a call resolving a payload source'
	);
});

// --- P4.2: the scripted burst scenario ---------------------------------------
//
// "Several cold repos at once" against a node holding a warm listener,
// asserting admitMint keeps a free slot for JIT work. This needs no new
// admission code — the whole point of routing a warm listener's activity
// through `standingBusy` (see EphemeralTickInput's build in dispatchEphemeral)
// is that admission already answers this question for any standing
// registration, warm or otherwise. The test exists to prove that reuse is
// actually sufficient, not to add a mechanism.

test('P4.2 burst: a busy warm listener plus a burst of cold repos never exceeds the node cap', () => {
	// claw-3/4/5-shaped node: 3 concurrent slots, one already spent on a warm
	// listener mid-job for a repo none of the burst below asks for.
	const maxConcurrent = 3;
	const base = {
		liveUnits: 0,
		standingBusy: 1, // the warm listener, busy
		maxConcurrent,
		freeMb: 9000,
		requiredMb: 900,
		minFreeMb: 2048,
	};

	const coldRepos = ['a', 'b', 'c', 'd', 'e']; // five DIFFERENT cold repos at once
	let liveUnits = 0;
	let admitted = 0;
	let refused = 0;
	for (const repo of coldRepos) {
		void repo; // only the count matters — the point is that they are DIFFERENT
		const r = admitMint({ ...base, liveUnits });
		if (r.ok) {
			admitted++;
			liveUnits++; // this mint now occupies a slot for the REST of the burst
		} else {
			refused++;
		}
	}

	// 3 total slots, 1 already spent on the busy warm listener -> exactly 2
	// left for the burst, however many cold repos show up wanting one.
	assert.equal(admitted, 2);
	assert.equal(refused, coldRepos.length - 2);
	// The invariant the design doc asks for: warm + JIT together never exceed
	// the node's cap, i.e. a free slot was never handed out twice.
	assert.ok(base.standingBusy + liveUnits <= maxConcurrent);
});

test('P4.2 burst: an 8GB single-slot node never has a warm listener to burst against', () => {
	// claw-2's measured shape holds no listener — see the eligibility tests
	// above — so dispatchWarmCache never mints one here, and standingBusy from
	// warm work is always 0 on this class of node. The single slot is only ever
	// spent by the burst itself.
	assert.equal(warmCacheEligible(warmEligibleSlots(MEASURED['claw-2'])), false);
	const r1 = admitMint({
		liveUnits: 0,
		standingBusy: 0,
		maxConcurrent: 1,
		freeMb: 5000,
		requiredMb: 900,
		minFreeMb: 1536,
	});
	assert.equal(r1.ok, true);
	const r2 = admitMint({
		liveUnits: 1,
		standingBusy: 0,
		maxConcurrent: 1,
		freeMb: 5000,
		requiredMb: 900,
		minFreeMb: 1536,
	});
	assert.equal(
		r2.ok,
		false,
		'a second cold repo in the same burst must queue, not double-book the slot'
	);
});

// --- #57: the cap counts the listener, or the listener does not land ---------
//
// MEASURED on claw-3 over the 14 days to 2026-09-22T22:06Z (n=927 job starts
// attributed to that node; `docs/planning/failures-by-node-2026-09-21.md` §3):
//
//   max concurrent JIT units .................. 3   — the cap held EXACTLY
//   max concurrent including the warm listener  4   — at 48 job starts (5.2%)
//
// Every one of those is the warm listener taking a hadoku_site job straight
// from GitHub while three JIT units ran. `maxConcurrent: 3` went on claw-3 on
// 2026-08-17 after two thermal-crash reboots; it measures 96-99 °C under load
// against a 100 °C trip, and since the tier ladder was retired on 2026-09-21 it
// is the ONLY thermal control there.
//
// WHY THE P4.2 BURST TEST ABOVE DID NOT CATCH THIS. It hands admission
// `standingBusy: 1` — the listener already busy AND already observed. That is
// the case where the cap works. The 48 starts are the other one: the listener
// is idle when the mint is admitted and is handed a job afterwards, so the
// count admission saw was right when it was read and wrong a moment later. A
// test that supplies the observation it is checking for cannot fail.

/** claw-3 as measured: `free -m` total 15918, minFreeMb 2048, cap 3. */
const CLAW3 = {
	usableMb: MEASURED['claw-3'].installedMb - MEASURED['claw-3'].minFreeMb,
	jobMb: MEASURED['claw-3'].jobMb,
	role: 'claw',
	maxConcurrent: 3,
} as const;

/** Every node's declared cap, from `manifests/fleet-runner-manifest.json` as
 *  deployed 2026-09-24 — the other half of the MEASURED table above. */
const CAPS: Record<keyof typeof MEASURED, number> = {
	'claw-1': 3,
	'claw-2': 2,
	'claw-3': 3,
	'claw-4': 3,
	'claw-5': 3,
	'claw-6': 2,
	'claw-8': 3,
	'claw-9': 4,
};

test('SAFETY a held listener SPENDS a slot of maxConcurrent — the ceiling is unchanged', () => {
	// Unchanged for every caller that predates the reservation, `routes/fleet`
	// included: the panel reports the node's ceiling, which is still the true
	// bound on concurrent work there.
	assert.deepEqual(mintBudget({ maxConcurrent: 3 }), { slots: 3, basis: 'declared' });
	// One listener held -> one slot of the three is not the dispatcher's to mint.
	assert.deepEqual(mintBudget({ maxConcurrent: 3, warmListeners: 1 }), {
		slots: 2,
		basis: 'declared',
	});
	// Never negative, and never a silent guess: an unmeasured count spends
	// nothing, exactly like every other "nobody looked" answer in this module.
	assert.equal(mintBudget({ maxConcurrent: 3, warmListeners: 9 }).slots, 0);
	assert.equal(mintBudget({ maxConcurrent: 3, warmListeners: Number.NaN }).slots, 3);
	assert.equal(mintBudget({ maxConcurrent: 3, warmListeners: -2 }).slots, 3);
	// The undeclared node still mints one at a time — and holds no listener, so
	// the reservation never reaches it in production.
	assert.deepEqual(mintBudget({}), { slots: 1, basis: 'default' });
});

test('warmConcurrencySlots: a cap holds a listener only with a whole JIT slot left beside it', () => {
	assert.equal(warmConcurrencySlots({ maxConcurrent: 4 }), 3);
	assert.equal(warmConcurrencySlots({ maxConcurrent: 3 }), 2);
	assert.equal(warmConcurrencySlots({ maxConcurrent: 2 }), 1);
	// A node capped at one that held a listener would have nothing left to mint
	// with: the dispatcher would skip it forever while every check read green.
	assert.equal(warmConcurrencySlots({ maxConcurrent: 1 }), 0);
	assert.equal(warmConcurrencySlots({ maxConcurrent: 0 }), 0);
	// Undeclared is `mintBudget`'s one-slot default — which the listener would
	// take whole, so a freshly enrolled node carries none until an operator
	// chooses its ceiling.
	assert.equal(warmConcurrencySlots({}), 0);
	assert.equal(warmConcurrencySlots({ maxConcurrent: null }), 0);
});

test('SAFETY warmListenerSlots: adding the cap half takes NO node off the warm fleet', () => {
	// Done-when 2 of wave 3m §A, as a fact rather than a claim: the fix must not
	// empty the cache. Every claw declares a cap of 2 or more, so the cap half
	// refuses none of them — what changes is how many JIT slots each has left
	// beside the listener it keeps.
	const memoryOnly = Object.keys(MEASURED).filter((n) =>
		warmCacheEligible(warmEligibleSlots({ ...MEASURED[n as keyof typeof MEASURED], role: 'claw' }))
	);
	const both = Object.keys(MEASURED).filter((n) => {
		const m = MEASURED[n as keyof typeof MEASURED];
		return warmCacheEligible(
			warmListenerSlots({
				usableMb: m.installedMb - m.minFreeMb,
				jobMb: m.jobMb,
				role: 'claw',
				maxConcurrent: CAPS[n as keyof typeof MEASURED],
			})
		);
	});
	assert.deepEqual(both, ['claw-1', 'claw-3', 'claw-4', 'claw-5', 'claw-8', 'claw-9']);
	// And the two rules agree on today's fleet — which is what keeps
	// `scripts/lib/warm-canary.mjs` (memory-only, by design: its question is
	// whether a node has ROOM for the listener it is missing) from failing a
	// node this one declines. A node enrolled WITHOUT a cap would break that
	// agreement; this assertion is where that shows up.
	assert.deepEqual(both, memoryOnly);
});

test('SAFETY warmListenerSlots: memory and the cap are each necessary on their own', () => {
	// 16 GB of room, one slot of ceiling: no listener, though memory says yes.
	assert.equal(warmListenerSlots({ ...CLAW3, maxConcurrent: 1 }), 0);
	// Eight cores' worth of ceiling on claw-2's memory: no listener, though the
	// cap says yes — its JIT half holds less than one mint.
	assert.equal(
		warmListenerSlots({
			usableMb: MEASURED['claw-2'].installedMb - MEASURED['claw-2'].minFreeMb,
			jobMb: MEASURED['claw-2'].jobMb,
			role: 'claw',
			maxConcurrent: 8,
		}),
		0
	);
	// A guest holds none by role, at any memory and any cap.
	assert.equal(
		warmListenerSlots({ usableMb: 55_210, jobMb: 4096, role: 'guest', maxConcurrent: 4 }),
		0
	);
	// claw-3's memory admits TWO listeners at its 3400 MB job figure and its cap
	// admits two — but the cache is of one, so one is what it holds and one is
	// what the dispatcher holds back. Reserving the allowance would leave the
	// fleet's second-busiest node a single JIT slot to protect a listener that
	// is never minted.
	assert.equal(warmListenerSlots(CLAW3), 2);
	assert.equal(warmListenersHeld(CLAW3), 1);
});

test('#57 claw-3: three JIT jobs, a warm listener on hadoku_site, and a fourth job arriving', () => {
	// The measured shape, built from the node's own figures. The listener is
	// IDLE at every instant admission runs — that is what makes this the 48
	// starts and not the P4.2 burst above: `standingBusy` was 0 when each mint
	// was admitted, and GitHub handed the listener its job afterwards.
	const held = warmListenersHeld(CLAW3);
	assert.equal(held, 1, 'claw-3 holds one warm listener — the cache is NOT disabled here');

	const admitWalk = (warmListeners: number) => {
		const slots = mintBudget({ maxConcurrent: CLAW3.maxConcurrent, warmListeners }).slots;
		let liveUnits = 0;
		const refusals: string[] = [];
		// Four hadoku_site jobs arrive in one fan-out — the repo whose jobs
		// account for every one of the 48 overlaps.
		for (let i = 0; i < 4; i++) {
			const r = admitMint({
				liveUnits,
				standingBusy: 0, // the listener is idle AND unobserved: the real shape
				maxConcurrent: slots,
				freeMb: CLAW3.usableMb,
				requiredMb: CLAW3.jobMb,
				minFreeMb: MEASURED['claw-3'].minFreeMb,
			});
			if (r.ok) liveUnits++;
			else refusals.push(r.reason ?? '');
		}
		// The listener takes one of the fan-out's jobs the moment it is free.
		return { liveUnits, concurrent: liveUnits + warmListeners, refusals };
	};

	const fixed = admitWalk(held);
	assert.equal(fixed.liveUnits, 2, 'two JIT units, not three');
	assert.equal(
		fixed.concurrent,
		3,
		'two JIT units plus the warm listener is exactly the thermal cap'
	);
	assert.ok(fixed.concurrent <= CLAW3.maxConcurrent);
	// Say WHY: a refusal that does not name the capacity it hit is unactionable.
	assert.match(fixed.refusals[0] ?? '', /at capacity: 2\/2 in flight/);

	// THE MEASUREMENT, as arithmetic: with no slot held for the listener — the
	// behaviour in production until 2026-09-24 — the same walk admits three JIT
	// units and the listener makes four. That is the 4 in the table, at 48 job
	// starts on a node whose watchdog tripped twice at this concurrency.
	const before = admitWalk(0);
	assert.equal(before.liveUnits, 3);
	assert.equal(before.concurrent + 1, 4, 'the listener that does not ask makes it four');
});

test('SAFETY the cap can never be exceeded, at any shape a node can have', () => {
	// The invariant itself, over every node shape in reach: whatever the memory,
	// the job size and the ceiling, the listeners a node may hold plus the JIT
	// units it may be minted is never more than the ceiling — and a node is
	// never left with a ceiling it cannot mint into.
	for (let usableMb = 0; usableMb <= 60_000; usableMb += 617) {
		for (const jobMb of [900, 3400, 4096, 6000]) {
			for (const maxConcurrent of [1, 2, 3, 4, 8]) {
				const listeners = warmListenersHeld({ usableMb, jobMb, role: 'claw', maxConcurrent });
				const slots = mintBudget({ maxConcurrent, warmListeners: listeners }).slots;
				const shape = `${usableMb}/${jobMb}/${maxConcurrent} -> ${listeners}+${slots}`;
				assert.ok(listeners + slots <= maxConcurrent, `${shape}: over the cap`);
				assert.ok(slots >= 1, `${shape}: a node the dispatcher can never mint on`);
			}
		}
	}
});

test('dispatchWarmCache: a node whose CAP leaves no slot beside a listener is never touched', async () => {
	// 16 GB-class memory — eligible by every memory test — capped at one job.
	// The listener would be the only work the box could do, and the dispatcher
	// would skip it forever.
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {};
	const gh = fakeGh({});
	const res = await dispatchWarmCache(
		baseInput({ nodes: { 'claw-1': { ...NODE_ELIGIBLE, maxConcurrent: 1 } } }),
		'tok',
		gh,
		simShell(sims),
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
	assert.equal(sims['claw-1']?.marker ?? null, null);
	// Not one registration-token call spent on a node that may not hold one.
	assert.equal(gh.calls.length, 0);
});

test("dispatchWarmCache: claw-3's own shape still fills — the cache is not what got turned off", async () => {
	writeRecord({ runner: 'claw-3', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-3': {
			marker: null,
			activeUnits: new Set(),
			installedMb: MEASURED['claw-3'].installedMb,
		},
	};
	const res = await dispatchWarmCache(
		baseInput({
			fleetProbe: new Map([['claw-3', { reachable: true, busyRepos: null }]]),
			ephemeral: new Set(['claw-3']),
			nodes: { 'claw-3': { ...NODE_ELIGIBLE, minFreeMb: MEASURED['claw-3'].minFreeMb } },
		}),
		'tok',
		fakeGh({}),
		simShell(sims),
		T0
	);
	assert.equal(res.filled, 1);
	assert.equal(sims['claw-3'].marker, 'WolffM/hadoku_site 1000');
});

// --- the wiring: does the reservation reach admission at all? -----------------
//
// THE FAILURE THIS FILE KEEPS PAYING FOR. P5.1's affinity term shipped and was
// inert for five days and ~2,000 jobs because nothing ever assigned
// `NodeState.warmRepo`; both sides typechecked and every unit test on either
// side of the seam stayed green. A reservation computed in `ephemeral.ts` and
// never handed to `admitMint` would fail in exactly the same way and look
// exactly as correct. So this asserts the NUMBER the dispatch pass is actually
// given, through the `run` seam `dispatchEphemeral` exists to expose.

/** `dispatchEphemeral` with the dispatch pass stubbed — returns what admission
 *  would have been handed for each node. */
async function budgetsFrom(
	input: EphemeralTickInput,
	sims: Record<string, NodeSim> = {}
): Promise<Map<string, number>> {
	const seen = new Map<string, number>();
	const run = (async (passInput: { nodes: { name: string; maxConcurrent: number }[] }) => {
		for (const n of passInput.nodes) seen.set(n.name, n.maxConcurrent);
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: null };
	}) as unknown as Parameters<typeof dispatchEphemeral>[4];
	await dispatchEphemeral(
		input,
		'tok',
		fakeGh({}) as unknown as Parameters<typeof dispatchEphemeral>[2],
		simShell(sims),
		run
	);
	return seen;
}

test('WIRING: the dispatch pass is handed the RESERVED budget, not the declared cap', async () => {
	writeRecord({ runner: 'claw-3', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const budgets = await budgetsFrom(
		baseInput({
			fleetProbe: new Map([
				['claw-3', { reachable: true, busyRepos: null }],
				['claw-2', { reachable: true, busyRepos: null }],
			]),
			ephemeral: new Set(['claw-3', 'claw-2']),
			nodes: {
				'claw-3': { ...NODE_ELIGIBLE, minFreeMb: MEASURED['claw-3'].minFreeMb },
				'claw-2': NODE_INELIGIBLE,
			},
		}),
		{
			'claw-3': {
				marker: null,
				activeUnits: new Set(),
				installedMb: MEASURED['claw-3'].installedMb,
			},
			'claw-2': {
				marker: null,
				activeUnits: new Set(),
				installedMb: INELIGIBLE_INSTALLED_MB,
			},
		}
	);
	// claw-3 may hold a listener, so one of its three slots is not the
	// dispatcher's to spend. This is the whole fix, at the only place it can be
	// inert.
	assert.equal(budgets.get('claw-3'), 2);
	// claw-2 may not hold one, so nothing is held back: a node that cannot carry
	// a listener must not pay for one. Its declared cap of 2 arrives untouched.
	assert.equal(budgets.get('claw-2'), 2);
});

// --- wave 4e follow-up (#102): dispatchEphemeral's OWN two sites ------------
//
// `offerFor` feeds THREE places: the warm mint (tested above, through
// `dispatchWarmCache`), placement's `NodeState.labels`, and the JIT mint's own
// `labelsFor` — both built inside `dispatchEphemeral`, captured here the same
// way `budgetsFrom` captures the reserved budget: stub `run` and read back
// what it was handed.

/** `dispatchEphemeral` with the dispatch pass stubbed — returns the per-node
 *  PLACEMENT labels and the JIT mint's `labelsFor`, both as `run` saw them. */
async function labelsFromDispatchEphemeral(
	input: EphemeralTickInput,
	sims: Record<string, NodeSim> = {}
): Promise<{
	placement: Map<string, readonly string[] | undefined>;
	labelsFor: (node: string) => string[];
}> {
	const placement = new Map<string, readonly string[] | undefined>();
	let capturedLabelsFor: ((node: string) => string[]) | null = null;
	const run = (async (passInput: {
		nodes: { name: string; labels?: readonly string[] }[];
		labelsFor: (node: string) => string[];
	}) => {
		for (const n of passInput.nodes) placement.set(n.name, n.labels);
		capturedLabelsFor = passInput.labelsFor;
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: null };
	}) as unknown as Parameters<typeof dispatchEphemeral>[4];
	await dispatchEphemeral(
		input,
		'tok',
		fakeGh({}) as unknown as Parameters<typeof dispatchEphemeral>[2],
		simShell(sims),
		run
	);
	return { placement, labelsFor: (node: string) => capturedLabelsFor!(node) };
}

test('dispatchEphemeral: placement NodeState.labels AND the JIT mint labelsFor both withhold a gated label', async () => {
	const ctx = workloadGateContext(['claw-1'], {});
	ctx.provenCounts.jdk21 = 2; // ACTIVE fleet-wide
	ctx.byNode['claw-1'].jdk21 = null; // this node has no record of its own
	__setWorkloadGateContextForTesting(ctx);
	const { placement, labelsFor } = await labelsFromDispatchEphemeral(
		baseInput({ nodes: { 'claw-1': NODE_ELIGIBLE_JDK21 } })
	);
	assert.ok(
		!(placement.get('claw-1') ?? []).includes('jdk21'),
		`placement labels must withhold jdk21: ${JSON.stringify(placement.get('claw-1'))}`
	);
	assert.ok(
		!labelsFor('claw-1').includes('jdk21'),
		`the JIT mint's labelsFor must withhold jdk21 too: ${labelsFor('claw-1').join(',')}`
	);
	// And the OTHER, non-gated label is unaffected on both paths.
	assert.ok((placement.get('claw-1') ?? []).includes('hadoku-builder'));
	assert.ok(labelsFor('claw-1').includes('hadoku-builder'));
});

test('dispatchEphemeral: with NO $proof at all (dormant), both label sites still offer jdk21 — unchanged from today', async () => {
	__setWorkloadGateContextForTesting(workloadGateContext(['claw-1'], {}));
	const { placement, labelsFor } = await labelsFromDispatchEphemeral(
		baseInput({ nodes: { 'claw-1': NODE_ELIGIBLE_JDK21 } })
	);
	assert.ok((placement.get('claw-1') ?? []).includes('jdk21'));
	assert.ok(labelsFor('claw-1').includes('jdk21'));
});

test('WIRING: the kill switch does not lift the reservation — it stops maintenance, not listeners', async () => {
	// WARM_CACHE_DISABLED stops the cache being MAINTAINED. It evicts nothing:
	// a listener already registered goes on long-polling and goes on being
	// handed jobs, so the slot it occupies is still occupied. Lifting the
	// reservation here would put the node back over its cap for as long as the
	// switch is on — which is the state an operator reaches for when something
	// is already wrong.
	writeRecord({ runner: 'claw-3', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const prev = process.env.WARM_CACHE_DISABLED;
	process.env.WARM_CACHE_DISABLED = '1';
	try {
		const budgets = await budgetsFrom(
			baseInput({
				fleetProbe: new Map([['claw-3', { reachable: true, busyRepos: null }]]),
				ephemeral: new Set(['claw-3']),
				nodes: { 'claw-3': { ...NODE_ELIGIBLE, minFreeMb: MEASURED['claw-3'].minFreeMb } },
			}),
			{
				'claw-3': {
					marker: null,
					activeUnits: new Set(),
					installedMb: MEASURED['claw-3'].installedMb,
				},
			}
		);
		assert.equal(budgets.get('claw-3'), 2);
	} finally {
		if (prev === undefined) delete process.env.WARM_CACHE_DISABLED;
		else process.env.WARM_CACHE_DISABLED = prev;
	}
});

test('WIRING: the reservation survives a restart — it is measured, not remembered', async () => {
	// `warmRepoByNode` (the affinity map) is empty for the first 60 s after each
	// of mgmt-api's ~5 daily restarts, and its own note says staleness there is
	// safe in ONE direction because affinity only ever PREFERS a node. A
	// reservation read from it would be unsafe in the other: a live listener
	// with no slot held for it, five times a day. This is that case — nothing
	// has been observed yet on this process — and the budget is still 2.
	writeRecord({ runner: 'claw-3', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	__resetWarmReposForTesting();
	const budgets = await budgetsFrom(
		baseInput({
			fleetProbe: new Map([['claw-3', { reachable: true, busyRepos: null }]]),
			ephemeral: new Set(['claw-3']),
			nodes: { 'claw-3': { ...NODE_ELIGIBLE, minFreeMb: MEASURED['claw-3'].minFreeMb } },
		}),
		{
			'claw-3': {
				marker: null,
				activeUnits: new Set(),
				installedMb: MEASURED['claw-3'].installedMb,
			},
		}
	);
	assert.equal(warmReposForPlacement().get('claw-3'), undefined);
	assert.equal(budgets.get('claw-3'), 2);
});

// --- the generic admission verdict (wave 4a §A.1, #100) ----------------------
//
// `dispatchEphemeral` builds each node's `admitMint` input to decide WHERE a
// job should mint; this is the SAME input, read back through
// `admissionVerdictsForReport` for a reader that never gets to ask `admitMint`
// itself — `runner-health.ts`'s starvation check and `routes/fleet.ts`'s panel
// field. claw-6 and claw-2 were refused by the memory clause on every tick for
// days and nothing recorded it; this is that record.

/** `dispatchEphemeral` with the dispatch pass stubbed, returning whatever the
 *  verdict snapshot looks like right after. */
async function verdictsFrom(
	input: EphemeralTickInput,
	sims: Record<string, NodeSim> = {}
): Promise<ReturnType<typeof admissionVerdictsForReport>> {
	const run = (async () => ({
		minted: 0,
		failed: 0,
		skipped: 0,
		inFlight: 0,
		reaped: 0,
	})) as unknown as Parameters<typeof dispatchEphemeral>[4];
	await dispatchEphemeral(
		input,
		'tok',
		fakeGh({}) as unknown as Parameters<typeof dispatchEphemeral>[2],
		simShell(sims),
		run
	);
	return admissionVerdictsForReport();
}

test('WIRING: the display verdict is charged like the dispatcher when its ledger is fresh (2026-10-25)', async () => {
	// claw-1/claw-9 read `at capacity` in GET /fleet while the dispatcher's own
	// ledger charged them under their budget. Same probe both times; only the
	// ledger differs, so this proves ephemeral-tick consults it.
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: null, activeUnits: new Set(), installedMb: 32000 },
	};
	const input = () =>
		baseInput({
			fleetProbe: new Map([['claw-1', { reachable: true, busyRepos: null, workers: 3 }]]),
		});
	__resetCapacityLedgerForTesting();
	const raw = (await verdictsFrom(input(), sims)).get('claw-1');
	assert.equal(raw?.ok, false, 'three workers against a cap of three is at capacity, read raw');
	if (raw && !raw.ok) assert.equal(raw.clause, 'concurrency');
	recordCapacityLedger([
		{
			node: 'claw-1',
			liveUnits: 0,
			probeWorkers: 3,
			standingBusy: 1,
			warmHeld: 0,
			budget: 3,
			inFlight: 1,
		},
	]);
	const charged = (await verdictsFrom(input(), sims)).get('claw-1');
	__resetCapacityLedgerForTesting();
	assert.deepEqual(charged, { ok: true }, 'charged 1 of 3 by the dispatcher, the panel must agree');
});

test('WIRING: a node whose free memory cannot clear its reserve records a MEMORY-refused verdict', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	// 5000 MB installed, minFreeMb 2048 (NODE_ELIGIBLE): `free -m`'s $7 column
	// (simShell's 80% rule) reads 4000 MB available. No `jobP95Mb` and no repo
	// reserve, so the generic check reserves JOB_RESERVE_DEFAULT_MB (4096): 4000
	// − 4096 leaves −96, under the 2048 MB floor. Same shape as claw-6/claw-2's
	// own numbers in the wave 4a writeup, not a copy of them.
	const sims: Record<string, NodeSim> = {
		'claw-6': { marker: null, activeUnits: new Set(), installedMb: 5000 },
	};
	const verdicts = await verdictsFrom(
		baseInput({
			fleetProbe: new Map([['claw-6', { reachable: true, busyRepos: null }]]),
			ephemeral: new Set(['claw-6']),
			nodes: { 'claw-6': NODE_ELIGIBLE },
		}),
		sims
	);
	assert.deepEqual(verdicts.get('claw-6'), {
		ok: false,
		clause: 'memory',
		availableMb: 4000,
		needMb: 4096,
		reserveBasis: 'default',
		reason:
			'memory: 4000MB free, this repo peaks at 4096MB, would leave -96MB against a 2048MB floor',
	});
});

test('WIRING: a node with room to spare records ok:true', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: null, activeUnits: new Set() }, // DEFAULT_INSTALLED_MB, 16 GB-class
	};
	const verdicts = await verdictsFrom(
		baseInput({
			fleetProbe: new Map([['claw-1', { reachable: true, busyRepos: null }]]),
			ephemeral: new Set(['claw-1']),
			nodes: { 'claw-1': NODE_ELIGIBLE },
		}),
		sims
	);
	assert.deepEqual(verdicts.get('claw-1'), { ok: true });
});

test('WIRING: the verdict snapshot is published WHOLESALE, even empty — a node unreachable this pass is absent, never stale', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-6': { marker: null, activeUnits: new Set(), installedMb: 5000 },
	};
	const first = await verdictsFrom(
		baseInput({
			fleetProbe: new Map([['claw-6', { reachable: true, busyRepos: null }]]),
			ephemeral: new Set(['claw-6']),
			nodes: { 'claw-6': NODE_ELIGIBLE },
		}),
		sims
	);
	assert.equal(first.get('claw-6')?.ok, false, 'sanity: the first pass did find a refusal');
	// Second pass: claw-6 is UNREACHABLE now. Nothing was learned about it —
	// this must read as absent ("could not look"), never as the stale refusal
	// from the pass before.
	const second = await verdictsFrom(
		baseInput({
			fleetProbe: new Map([['claw-6', { reachable: false, busyRepos: null }]]),
			ephemeral: new Set(['claw-6']),
			nodes: { 'claw-6': NODE_ELIGIBLE },
		}),
		sims
	);
	assert.equal(second.has('claw-6'), false);
});

// --- the live placement order: speed breaks ties, end to end (wave 3z) ------
//
// `budgetsFrom` above proves a NUMBER reaches admission; this proves the
// ORDER reaches it, through the exact seam the live call site
// (`ephemeral-tick.ts`'s `speedFactor: speedModel.factorOf?.(m2.name) ?? null`
// in the `trafficNodes` map) feeds `orderCandidates`. A unit test on
// `orderCandidates` alone cannot see that call site go dark — only a test that
// drives `dispatchEphemeral` end to end, through the real speed model built
// from real job history, can.

/** `dispatchEphemeral` with the dispatch pass stubbed — returns the placement
 *  ORDER the pass was actually handed (`passInput.order`, `orderCandidates`'s
 *  live output), the counterpart to `budgetsFrom`'s per-node numbers above. */
async function orderFrom(
	input: EphemeralTickInput,
	sims: Record<string, NodeSim> = {}
): Promise<string[]> {
	let order: string[] = [];
	const run = (async (passInput: { order: string[] }) => {
		order = passInput.order;
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: null };
	}) as unknown as Parameters<typeof dispatchEphemeral>[4];
	await dispatchEphemeral(
		input,
		'tok',
		fakeGh({}) as unknown as Parameters<typeof dispatchEphemeral>[2],
		simShell(sims),
		run
	);
	return order;
}

test('WIRING: the live placement order prefers the MEASURED faster node — equal busy, equal idle (wave 3z, #83 continuous sibling)', async () => {
	const FAST = 'claw-8';
	const SLOW = 'claw-3';
	const FAST_SEC = 60;
	const SLOW_SEC = 180; // 3x slower: clear of SLOW_P25 and of rounding noise.

	// MIN_KINDS (5) distinct (repo, job) kinds, MIN_SAMPLES (5) each side, so
	// neither node is 'unknown' — factorOf must read a real measured number for
	// both. Each kind's pair of records is timed so BOTH nodes' job in that
	// kind ends at the EXACT SAME instant: equal idleSeconds is the point of
	// this fixture, not an accident of whatever timings were convenient. With
	// busy and idle genuinely tied, only the speed step can decide the order.
	for (let kind = 0; kind < 5; kind++) {
		const baseSec = kind * 1000;
		for (let sample = 0; sample < 5; sample++) {
			writeRecord({
				runner: FAST,
				name: `kind-${kind}`,
				startedAt: histAt(baseSec),
				durationSec: FAST_SEC,
				runSec: FAST_SEC,
			});
			writeRecord({
				runner: SLOW,
				name: `kind-${kind}`,
				// Ends at baseSec + FAST_SEC, same instant as FAST's record above.
				startedAt: histAt(baseSec + FAST_SEC - SLOW_SEC),
				durationSec: SLOW_SEC,
				runSec: SLOW_SEC,
			});
		}
	}

	const sims: Record<string, NodeSim> = {
		[FAST]: { marker: null, activeUnits: new Set(), installedMb: MEASURED[FAST].installedMb },
		[SLOW]: { marker: null, activeUnits: new Set(), installedMb: MEASURED[SLOW].installedMb },
	};
	const order = await orderFrom(
		baseInput({
			fleetProbe: new Map([
				[FAST, { reachable: true, busyRepos: null }],
				[SLOW, { reachable: true, busyRepos: null }],
			]),
			ephemeral: new Set([FAST, SLOW]),
			nodes: {
				[FAST]: { ...NODE_ELIGIBLE, minFreeMb: MEASURED[FAST].minFreeMb },
				[SLOW]: { ...NODE_ELIGIBLE, minFreeMb: MEASURED[SLOW].minFreeMb },
			},
		}),
		sims
	);
	assert.deepEqual(
		order,
		[FAST, SLOW],
		`measured-faster ${FAST} must be placed ahead of measured-slower ${SLOW} when both are equally idle and equally busy`
	);
});

// --- #101: space admission on the warm path, from its OWN measurement ------

test('dispatchWarmCache (c1a): an idle warm listener on a node at 300MB /tmp free is evicted, never re-filled; a listener-less node at 300MB is never filled either', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	writeRecord({ runner: 'claw-2', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const nowMs = 1_000_000 + WARM_ASSIGN_WINDOW_MS + 1;
	const sims: Record<string, NodeSim> = {
		'claw-1': {
			marker: 'WolffM/hadoku_site 1000',
			activeUnits: new Set([unit]),
			tmpFreeMb: 300,
		},
		'claw-2': { marker: null, activeUnits: new Set(), tmpFreeMb: 300 },
	};
	const sh = simShell(sims);
	const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: false }] });
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, nowMs);
	assert.equal(res.evicted, 1, 'the out-of-/tmp node must lose its listener');
	assert.equal(sims['claw-1'].marker, null, 'and never be re-filled onto it the same pass');
	assert.equal(
		sims['claw-2'].marker,
		null,
		'a listener-less node at 300MB /tmp free is never filled'
	);

	// Second pass at the same free-space reading: still not re-filled.
	await dispatchWarmCache(baseInput(), 'tok', gh, sh, nowMs + WARM_CACHE_INTERVAL_MS);
	assert.equal(sims['claw-1'].marker, null, 'still refused a second pass while still at 300MB');
});

test('dispatchWarmCache (c1b): a listener-less node at 3000MB /tmp free does fill', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-1': { marker: null, activeUnits: new Set(), tmpFreeMb: 3000 },
	};
	const res = await dispatchWarmCache(baseInput(), 'tok', fakeGh({}), simShell(sims), T0);
	assert.equal(res.filled, 1);
	assert.equal(sims['claw-1'].marker, 'WolffM/hadoku_site 1000');
});

test("dispatchWarmCache (c2): a STALE non-space (or absent) dispatch-tick verdict must not mask this pass's OWN space measurement", async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const nowMs = 1_000_000 + WARM_ASSIGN_WINDOW_MS + 1;
	const sims: Record<string, NodeSim> = {
		'claw-1': {
			marker: 'WolffM/hadoku_site 1000',
			activeUnits: new Set([unit]),
			tmpFreeMb: 300,
		},
	};
	// Before this lane's fix, the warm path read THIS map instead of its own
	// probe — a `memory`-refused (or simply absent/ok) verdict here would have
	// masked the space refusal and left the listener in place. Injected
	// directly so the test cannot be satisfied by the warm pass happening to
	// agree with a verdict it was never supposed to consult.
	__setAdmissionVerdictsForTesting(
		new Map([
			[
				'claw-1',
				{
					ok: false,
					clause: 'memory',
					availableMb: 100,
					needMb: 4096,
					reserveBasis: 'default',
					reason:
						'memory: 100MB free, this repo peaks at 4096MB, would leave -3996MB against a 2048MB floor',
				},
			],
		])
	);
	try {
		const sh = simShell(sims);
		const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: false }] });
		const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, nowMs);
		assert.equal(
			res.evicted,
			1,
			"the warm pass's own 300MB /tmp measurement must evict regardless of the stale memory verdict"
		);
		assert.equal(sims['claw-1'].marker, null);
	} finally {
		__resetAdmissionVerdictsForTesting();
	}
});

test('dispatchWarmCache (c3): an unreadable /tmp df refuses exactly like below-floor — evicted, never filled', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	writeRecord({ runner: 'claw-2', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const nowMs = 1_000_000 + WARM_ASSIGN_WINDOW_MS + 1;
	const sims: Record<string, NodeSim> = {
		'claw-1': {
			marker: 'WolffM/hadoku_site 1000',
			activeUnits: new Set([unit]),
			dfUnreadable: 'tmp',
		},
		'claw-2': { marker: null, activeUnits: new Set(), dfUnreadable: 'tmp' },
	};
	const sh = simShell(sims);
	const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: false }] });
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, nowMs);
	assert.equal(res.evicted, 1, 'unreadable /tmp must refuse, never admit on a guess');
	assert.equal(sims['claw-1'].marker, null);
	assert.equal(
		sims['claw-2'].marker,
		null,
		'a listener-less node with unreadable /tmp is never filled'
	);
});

test('dispatchWarmCache (c4): an unreadable or below-floor ~/.hadoku/jit (_work) df refuses the same way', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	writeRecord({ runner: 'claw-2', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const unit = warmRunnerName('claw-1', 'WolffM/hadoku_site');
	const nowMs = 1_000_000 + WARM_ASSIGN_WINDOW_MS + 1;
	const sims: Record<string, NodeSim> = {
		'claw-1': {
			marker: 'WolffM/hadoku_site 1000',
			activeUnits: new Set([unit]),
			workFreeMb: 300,
		},
		'claw-2': { marker: null, activeUnits: new Set(), dfUnreadable: 'work' },
	};
	const sh = simShell(sims);
	const gh = fakeGh({ runners: [{ id: 1, name: unit, busy: false }] });
	const res = await dispatchWarmCache(baseInput(), 'tok', gh, sh, nowMs);
	assert.equal(res.evicted, 1, 'below-floor _work must refuse');
	assert.equal(sims['claw-1'].marker, null);
	assert.equal(
		sims['claw-2'].marker,
		null,
		'unreadable _work must also refuse a listener-less node'
	);
});

test('WIRING (b): a node whose /tmp df is unreadable records a SPACE/unreadable verdict and is not minted on while another node is', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = {
		'claw-6': { marker: null, activeUnits: new Set(), dfUnreadable: 'tmp' },
	};
	const verdicts = await verdictsFrom(
		baseInput({
			fleetProbe: new Map([['claw-6', { reachable: true, busyRepos: null }]]),
			ephemeral: new Set(['claw-6']),
			nodes: { 'claw-6': NODE_ELIGIBLE },
		}),
		sims
	);
	const v = verdicts.get('claw-6');
	assert.equal(v?.ok, false);
	if (v && !v.ok) {
		assert.equal(v.clause, 'space');
		assert.equal(v.unreadable, true);
		assert.match(v.reason, /could not read \/tmp free space/);
	}
});

test('WIRING pin: a sim returning ONLY the free -m line (no df lines at all) yields a space refusal, never an admit — the live tick must never leave the fields undefined', async () => {
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	const sims: Record<string, NodeSim> = { 'claw-6': { marker: null, activeUnits: new Set() } };
	const inner = simShell(sims);
	// A deliberately broken probe: answers `free -m` but strips every `df` line
	// off the reply, reproducing a node/transport that cannot run the combined
	// command — the exact shape this pin exists to guard against ever reading
	// as "admitted" rather than "could not look".
	const sh = async (n: string, c: string): Promise<string | null> => {
		const out = await inner(n, c);
		if (c.includes('free -m') && c.includes('df -Pm')) {
			return String(out ?? '').split('\n')[0] ?? null;
		}
		return out;
	};
	// `verdictsFrom` uses its own `simShell(sims)` internally and cannot take a
	// custom `sh` — call `dispatchEphemeral` directly so the stripped probe
	// actually reaches it.
	const run = (async () => ({
		minted: 0,
		failed: 0,
		skipped: 0,
		inFlight: 0,
		reaped: 0,
	})) as unknown as Parameters<typeof dispatchEphemeral>[4];
	await dispatchEphemeral(
		baseInput({
			fleetProbe: new Map([['claw-6', { reachable: true, busyRepos: null }]]),
			ephemeral: new Set(['claw-6']),
			nodes: { 'claw-6': NODE_ELIGIBLE },
		}),
		'tok',
		fakeGh({}) as unknown as Parameters<typeof dispatchEphemeral>[2],
		sh,
		run
	);
	const v = admissionVerdictsForReport().get('claw-6');
	assert.equal(v?.ok, false, 'a probe with no df lines must never be read as admitted');
	if (v && !v.ok) {
		assert.equal(v.clause, 'space');
		assert.equal(v.unreadable, true, 'a stripped df line is unreadable, not a measured zero');
	}
});
