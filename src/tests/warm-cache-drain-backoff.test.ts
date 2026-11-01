/**
 * The warm cache of one — issue #7: the drain check, the kill switch, and
 * the per-node backoff after repeated fill failures (persisted across a
 * restart, not kept in memory). Split out of warm-cache.test.ts (wave 5p
 * lane C) — see `helpers/warm-cache-rig.ts` for the shared fixtures and
 * the file-wide `beforeEach`/`afterEach` every split file installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchWarmCache } from '../runners/dispatch-warm-cache.js';
import { __resetWarmCacheClockForTesting } from '../runners/dispatch-warm-cache.js';
import { warmRunnerName } from '../runners/ephemeral.js';
import { WARM_ASSIGN_WINDOW_MS } from '../runners/ephemeral-warm.js';
import { __restartWarmBackoffForTesting, WARM_CACHE_INTERVAL_MS } from '../runners/warm-backoff.js';
import { writeDrain } from '../runners/drain.js';
import { fakeGh } from './helpers/fleet-fakes.js';
import {
	type NodeSim,
	T0,
	baseInput,
	histAt,
	installWarmCacheRig,
	simShell,
	writeRecord,
} from './helpers/warm-cache-rig.js';

installWarmCacheRig();

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
