/**
 * The warm cache of one — the payload source (`RUNNER_TARBALL_URL` reaches
 * the node), the P4.2 scripted burst scenario, and #57: the cap counts the
 * listener, or the listener does not land (`warmConcurrencySlots`/
 * `warmListenerSlots`/`mintBudget`/`admitMint` against claw-3's measured
 * shape). Split out of warm-cache.test.ts (wave 5p lane C) — see
 * `helpers/warm-cache-rig.ts` for the shared `MEASURED`/`NODE_ELIGIBLE`
 * family and the file-wide `beforeEach`/`afterEach` every split file
 * installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { admitMint } from '../runners/ephemeral.js';
import { mintBudget } from '../runners/ephemeral.js';
import { warmCacheEligible } from '../runners/ephemeral.js';
import { warmEligibleSlots } from '../runners/ephemeral.js';
import { warmListenersHeld } from '../runners/ephemeral.js';
import { warmListenerSlots } from '../runners/ephemeral.js';
import { warmRunnerName } from '../runners/ephemeral.js';
import { warmConcurrencySlots } from '../runners/ephemeral.js';
import { dispatchWarmCache } from '../runners/dispatch-warm-cache.js';
import { fakeGh } from './helpers/fleet-fakes.js';
import {
	MEASURED,
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
	// A backstop holds none by role, at any memory and any cap.
	assert.equal(
		warmListenerSlots({ usableMb: 55_210, jobMb: 4096, role: 'backstop', maxConcurrent: 4 }),
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
