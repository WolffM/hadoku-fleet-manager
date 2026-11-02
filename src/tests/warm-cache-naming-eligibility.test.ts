/**
 * The warm cache of one — naming, eligibility, the busy/assign-window lock,
 * `planWarmCache`/`planWarmFleet`'s pure decisions, and the warm spawn
 * plan's systemd argv (P4.1, docs/planning/warm-listener-cache-2026-09-05.md).
 * Split out of warm-cache.test.ts (wave 5p lane C) — see
 * `helpers/warm-cache-rig.ts` for the shared `MEASURED`/`HOKON`/`SITE`
 * family and the file-wide `beforeEach`/`afterEach` every split file
 * installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WARM_PREFIX, warmRunnerName } from '../lib/jit-naming.js';
import { warmCacheEligible, warmEligibleSlots } from '../lib/warm-eligibility.js';
import { warmSlotDir } from '../runners/ephemeral.js';
import { buildWarmSpawnPlan } from '../runners/ephemeral-mint.js';
import { WARM_ASSIGN_WINDOW_MS, planWarmCache, warmSlotLocked } from '../runners/ephemeral-warm.js';
import {
	planWarmFleet,
	WARM_INCUMBENT_RATIO,
	warmUnitValues,
} from '../runners/ephemeral-warm-fleet.js';
import { SPACE_PROBE_DF_CMD } from '../runners/ephemeral-shared.js';
import { nodeOf } from '../runners/census.js';
import {
	CARD,
	FLEET_NOW,
	HOKON,
	MEASURED,
	MEET,
	SITE,
	TEN,
	busySlot,
	idleSlot,
	installWarmCacheRig,
	jobsOf,
	overlappingPairs,
} from './helpers/warm-cache-rig.js';

installWarmCacheRig();

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

// fleet-manager#36: claw-1 was handed hadoku_site, withheld it (slow Static
// Analysis) and sat cold 62 times on 2026-10-31 while hadoku-cardtable, which it
// can hold, went unwarmed. The allocator is now told each node's exclusions.

test('planWarmFleet #36: a node excluding the top repo takes the next one, and another node takes the top', () => {
	const served = [...jobsOf(SITE, 10), ...jobsOf(CARD, 2)];
	const nodes = [
		{ node: 'claw-1', current: null, excluded: new Set([SITE]) },
		{ node: 'claw-3', current: null },
	];
	assert.deepEqual(Object.fromEntries(planWarmFleet({ nodes, served, nowMs: FLEET_NOW })), {
		'claw-1': { action: 'fill', repo: CARD },
		'claw-3': { action: 'fill', repo: SITE },
	});
});

test('planWarmFleet #36: the only node excluding the top repo still fills with one it may hold', () => {
	const served = [...jobsOf(SITE, 10), ...jobsOf(CARD, 2)];
	const d = planWarmFleet({
		nodes: [{ node: 'claw-1', current: null, excluded: new Set([SITE]) }],
		served,
		nowMs: FLEET_NOW,
	});
	assert.deepEqual(Object.fromEntries(d), { 'claw-1': { action: 'fill', repo: CARD } });
});

test('planWarmFleet #36: a node holding a repo it excludes rotates off it, never keeps it', () => {
	const served = [...jobsOf(SITE, 10), ...jobsOf(CARD, 2)];
	const d = planWarmFleet({
		nodes: [{ node: 'claw-1', current: idleSlot(SITE), excluded: new Set([SITE]) }],
		served,
		nowMs: FLEET_NOW,
	});
	assert.deepEqual(Object.fromEntries(d), {
		'claw-1': { action: 'rotate', from: SITE, to: CARD },
	});
});

test('planWarmFleet #36: every repo worth a listener excluded — the node stays idle, never fills one', () => {
	const d = planWarmFleet({
		nodes: [{ node: 'claw-1', current: null, excluded: new Set([SITE, CARD]) }],
		served: [...jobsOf(SITE, 10), ...jobsOf(CARD, 2)],
		nowMs: FLEET_NOW,
	});
	assert.deepEqual(Object.fromEntries(d), { 'claw-1': { action: 'idle' } });
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
