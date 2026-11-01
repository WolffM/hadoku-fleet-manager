/**
 * `dispatchEphemeral` and its own fixtures — split out of
 * `src/tests/ephemeral.test.ts` (wave 5r lane D, body-extraction, whole
 * blocks over a rig) so that file falls under the 1,000-line test ceiling.
 * `BASE` (the admission fixture one test here shares with
 * `src/tests/ephemeral.test.ts`) moved to `src/tests/helpers/ephemeral-rig.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JOB_RESERVE_DEFAULT_MB } from '../runners/ephemeral.js';
import { admitMint } from '../runners/ephemeral.js';
import { unitMemoryMaxMb } from '../runners/ephemeral.js';
import { dispatchEphemeral } from '../runners/ephemeral-tick.js';
import { jobReserve, loadRepoReserves, withoutBackstops } from '../runners/ephemeral-shared.js';
import { setBackstopHold } from '../runners/backstop-hold.js';
import { SATURATED_QUEUED_MS } from '../runners/queue-discovery.js';
import { BASE } from './helpers/ephemeral-rig.js';

// --- the dispatcher's return contract (2026-09-01) --------------------------
//
// This function returned `void`. Its caller does `recordDispatch(res, ...)`, and
// a missing result is scored there as attempted-and-all-failed — so a fleet with
// nothing to dispatch, and a fleet minting perfectly, and a fleet that could not
// be reached at all, were reported identically as a dispatcher that had been
// failing since the last restart.

test('nothing declared ephemeral is a ZEROED pass, never a missing one', async () => {
	const res = await dispatchEphemeral(
		{
			fleetProbe: new Map(),
			ephemeral: new Set(),
			nodes: {},
			isSick: () => false,
			repos: [],
		},
		'tok',
		{ get: async () => null, write: async () => ({ ok: true, status: 200 }) } as never
	);
	assert.deepEqual(
		res,
		{ minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 },
		'"looked, nothing to do" must be distinguishable from "could not look"'
	);
});

// --- the ladder -> dispatcher seam (2026-09-01) ----------------------------
//
// Asserted through the real function, not around it. The dispatch RESULT was
// dropped on this exact hand-off for three days with green unit tests on both
// sides, so the gate this function chooses is verified where it is CHOSEN.

function tickRig() {
	const seen: { minQueuedMs?: number }[] = [];
	const input = {
		fleetProbe: new Map([['claw-3', { reachable: true, busyRepos: new Map() }]]),
		ephemeral: new Set(['claw-3']),
		nodes: { 'claw-3': { labels: ['hadoku-builder'], maxConcurrent: 3, minFreeMb: 1536 } },
		isSick: () => false,
		repos: ['WolffM/hadoku_site'],
	};
	// `$7 $2`: available AND installed, off one `free -m` line. The tick refuses to
	// mint on a node whose total it cannot read, because the per-unit cap is now
	// derived from it (MemTotal - minFreeMb) and a silent fallback would be the
	// tight 4 GiB cap of #26 coming back through the "I could not look" door.
	const sh = async (_n: string, cmd: string) => (cmd.includes('$7, $2') ? '9000 16000' : '9000');
	const run = async (i: { minQueuedMs?: number }) => {
		seen.push({ minQueuedMs: i.minQueuedMs });
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	};
	return { input, sh, run, seen };
}

test('seam: with a standing runner eligible, the dispatcher gate is SATURATED_QUEUED_MS', async () => {
	// Every claw is ephemeral, so every standing slot (a promoted reserve) sits
	// below them: "the standing fleet above is full" held on every tick the
	// retired ladder ever computed it, and 30s was always the live gate.
	const r = tickRig();
	await dispatchEphemeral(
		{ ...r.input, standingEligible: new Set(['hokon']) } as never,
		'tok',
		{} as never,
		r.sh as never,
		r.run as never
	);
	assert.equal(r.seen.length, 1, 'the tick must actually run');
	assert.equal(r.seen[0].minQueuedMs, SATURATED_QUEUED_MS);
});

test('seam: with NOTHING standing, the gate is removed — there is no runner to wait for', async () => {
	const r = tickRig();
	await dispatchEphemeral(
		{ ...r.input, standingEligible: new Set() } as never,
		'tok',
		{} as never,
		r.sh as never,
		r.run as never
	);
	assert.equal(r.seen[0].minQueuedMs, 0);
});

test('seam: an unreadable free-memory figure still declines to mint', async () => {
	// The pre-existing guard, re-asserted through the new seam: a node that
	// cannot report its memory is skipped, and with no node left the pass is
	// COULD NOT LOOK rather than a quiet zero.
	const r = tickRig();
	const res = await dispatchEphemeral(
		r.input as never,
		'tok',
		{} as never,
		(async () => null) as never,
		r.run as never
	);
	assert.equal(res, null, 'no probeable node is "could not look"');
	assert.equal(r.seen.length, 0, 'and nothing is dispatched');
});

/**
 * ISSUE #26 — the flat 4 GiB per-unit cap killed real work.
 *
 * brave-quartet's `wasm-size` job of run 34543150470 was OOM-killed on claw-2:
 * `oom-kill:constraint=CONSTRAINT_MEMCG` against the unit's own 4 GiB, eight
 * parallel `rustc` processes resident, the largest ~830 MB RSS. GitHub recorded
 * the step as CANCELLED rather than failed — the shape you get when the runner
 * is killed out from under the job — so nothing in CI said "out of memory"
 * either. The node had 13.8 GB of CI budget unspent at the time.
 *
 * The operator's rule, 2026-09-12: no hard per-job memory cap; a floor keeps the
 * claw alive. The floor is `minFreeMb` and it is already expressed — the slice
 * ceiling IS `MemTotal − minFreeMb` — so a unit allowed to reach the ceiling can
 * take everything CI is permitted and nothing the box needs to stay reachable.
 *
 * SAFE ONLY BECAUSE `Slice=` SHIPPED FIRST. The slice bounds the SUM; this
 * bounds ONE. Relaxing the per-unit cap on units sitting in `app.slice` would
 * have been the 2026-08-04 outage with extra steps.
 */
test('no per-unit cap below the slice ceiling — a declared value may only WIDEN', () => {
	// claw-3 measured: 15,919 MB installed, 2,048 MB floor, 13,870 MB ceiling —
	// the exact number in its own runners.slice unit file.
	const ceiling = 13_870;
	assert.equal(
		unitMemoryMaxMb({ requestedMb: 4096, sliceCeilingMb: ceiling }),
		ceiling,
		"the manifest's 4096 is #26 exactly; it must not be able to narrow the cap"
	);
	for (const requestedMb of [undefined, null, 0, -1, 1, 3072, 4096, ceiling - 1]) {
		assert.equal(
			unitMemoryMaxMb({ requestedMb, sliceCeilingMb: ceiling }),
			ceiling,
			`requestedMb=${JSON.stringify(requestedMb)} must not produce a cap below the ceiling`
		);
	}
	// It is a FLOOR, not a pin — same contract as JIT_UNIT_MAX_SEC. An operator
	// raising the number above the ceiling is asking for something the slice will
	// refuse anyway, and clamping would make the field a lie.
	assert.equal(unitMemoryMaxMb({ requestedMb: ceiling + 5000, sliceCeilingMb: ceiling }), 18_870);
});

test('an unusable ceiling falls back to the request rather than to zero', () => {
	// TOTAL over its inputs. This runs after the registration exists, so a throw
	// or a `MemoryMax=0M` would leak a black-hole runner. The caller refuses to
	// mint on a node whose memory it could not read, so production never reaches
	// these — but the function must still be safe for every one of them.
	for (const sliceCeilingMb of [undefined, null, 0, -1, NaN, Infinity]) {
		assert.equal(unitMemoryMaxMb({ requestedMb: 4096, sliceCeilingMb }), 4096);
		assert.equal(
			unitMemoryMaxMb({ sliceCeilingMb }),
			JOB_RESERVE_DEFAULT_MB,
			'and with no request either, the documented default — never 0'
		);
	}
});

// --- admission's ESTIMATE vs the unit's HARD CAP (2026-09-01) ----------------
//
// `requiredMb` is what admission RESERVES against observed free memory;
// `MemoryMax` is what the unit is actually capped at. Both read `unitMaxMb`
// until this date, so every mint reserved the worst case: claw-1 admitted ONE
// concurrent job at 10GB free, and 13 jobs sat queued while dispatch logged
// "no node can take this job right now". Measured from systemd's own per-unit
// accounting that evening: p95 2970MB against a 4096MB cap (claw-1 n=41,
// claw-3 n=227).

function nodeRig(node: Record<string, unknown>, repos: string[] = ['WolffM/hadoku_site']) {
	const seen: {
		nodes?: { requiredMb: number; requiredMbByRepo?: ReadonlyMap<string, unknown> }[];
		cap?: number;
	}[] = [];
	const input = {
		fleetProbe: new Map([['claw-3', { reachable: true, busyRepos: new Map() }]]),
		ephemeral: new Set(['claw-3']),
		nodes: { 'claw-3': node },
		isSick: () => false,
		repos,
	};
	// `$7 $2`: available AND installed, off one `free -m` line. The tick refuses to
	// mint on a node whose total it cannot read, because the per-unit cap is now
	// derived from it (MemTotal - minFreeMb) and a silent fallback would be the
	// tight 4 GiB cap of #26 coming back through the "I could not look" door.
	const sh = async (_n: string, cmd: string) => (cmd.includes('$7, $2') ? '9000 16000' : '9000');
	const run = async (i: {
		nodes: { requiredMb: number; requiredMbByRepo?: ReadonlyMap<string, unknown> }[];
		memoryMaxMbFor: (r: string) => number;
	}) => {
		seen.push({ nodes: i.nodes, cap: i.memoryMaxMbFor(repos[0]) });
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	};
	return { input, sh, run, seen };
}

const GH = { get: async () => null, write: async () => ({ ok: true, status: 200 }) } as never;

test('admission reserves the MEASURED p95, not the per-unit cap', async () => {
	const r = nodeRig({
		labels: ['hadoku-builder'],
		maxConcurrent: 3,
		minFreeMb: 2048,
		slice: { unitMaxMb: 4096 },
		jobP95Mb: 2970,
	});
	await dispatchEphemeral(r.input as never, 'tok', GH, r.sh as never, r.run as never);
	assert.equal(r.seen[0].nodes?.[0].requiredMb, 2970, 'the estimate is what admission reserves');
	// THE HARD CAP IS THE SLICE CEILING NOW (issue #26), not `unitMaxMb`. The rig's
	// node measures 16,000 MB installed with a 2,048 MB floor, so CI may have
	// 13,952 MB of it and one unit may reach all of that — the slice still bounds
	// the SUM. It read 4096 until 2026-09-14, and brave-quartet's `wasm-size` was
	// OOM-killed against exactly that on claw-2 with 13.8 GB of budget unspent.
	assert.equal(r.seen[0].cap, 16_000 - 2048, 'the HARD CAP is MemTotal − minFreeMb');
});

test('an unmeasured job reserves the default, NOT the slice ceiling', async () => {
	// The fallback and the cap were one number — `jobP95Mb ?? unitMaxMb` — and
	// that read as harmless only while the cap was 4096. Reserving the ceiling
	// for an unmeasured job would admit ONE mint per node and queue the rest:
	// the 2026-09-01 shape, 13 jobs queued while dispatch logged "no node can
	// take this job right now". Raising the cap must not raise the reservation.
	const r = nodeRig({
		labels: ['hadoku-builder'],
		maxConcurrent: 3,
		minFreeMb: 2048,
		slice: { unitMaxMb: 4096 },
	});
	await dispatchEphemeral(r.input as never, 'tok', GH, r.sh as never, r.run as never);
	assert.equal(
		r.seen[0].nodes?.[0].requiredMb,
		JOB_RESERVE_DEFAULT_MB,
		'over-conservative beats over-admitting, but the ceiling is not an estimate'
	);
	assert.ok(
		(r.seen[0].nodes?.[0].requiredMb ?? 0) < (r.seen[0].cap ?? 0),
		'the reservation must stay well under the cap, or admission refuses everything'
	);
});

test('a node whose INSTALLED memory cannot be read is skipped, not capped tight', async () => {
	// The cap is derived from MemTotal, so an unreadable total must decline the
	// node — exactly as an unreadable FREE figure already does. Falling back to
	// the old flat 4096 would be #26 arriving silently through the "I could not
	// look" door, which CLAUDE.md forbids by name.
	const r = nodeRig({
		labels: ['hadoku-builder'],
		maxConcurrent: 3,
		minFreeMb: 2048,
		slice: { unitMaxMb: 4096 },
	});
	const res = await dispatchEphemeral(
		r.input as never,
		'tok',
		GH,
		(async () => '9000') as never, // free only; no total column
		r.run as never
	);
	assert.equal(res, null, 'no usable node is "could not look", never a quiet zero');
	assert.equal(r.seen.length, 0, 'and nothing is dispatched at a guessed ceiling');
});

test('the estimate can never silently exceed the cap it is reserving against', async () => {
	// A p95 above MemoryMax would admit jobs the unit will then OOM-kill. The
	// manifest is operator-edited, so this is a real way to be wrong.
	const r = nodeRig({
		labels: ['hadoku-builder'],
		maxConcurrent: 3,
		minFreeMb: 2048,
		slice: { unitMaxMb: 4096 },
		jobP95Mb: 9000,
	});
	await dispatchEphemeral(r.input as never, 'tok', GH, r.sh as never, r.run as never);
	const req = r.seen[0].nodes?.[0].requiredMb ?? 0;
	assert.ok(req <= (r.seen[0].cap ?? 0), `estimate ${req} must not exceed cap ${r.seen[0].cap}`);
});

// --- the reserve is per REPO (Wave 3g J2) -----------------------------------
//
// The memory axis is the repo: 3d J measured a 35 % cross-node spread against
// 423 % across repos on one node. The node's hand-set `jobP95Mb` was 3,400 on
// claw-1/2/3 for every job, while the measured per-repo p95 ran from 423 MB
// (hadoku-registry) to 6,313 MB (brave-quartet) on 2026-09-18.

const CAP = 13_952;
const PYGMALION = { mb: 975, basis: 'measured', runs: 156 } as const;

test("the queued run's REPO figure answers first, and says so", () => {
	assert.deepEqual(jobReserve({ repoReserve: PYGMALION, nodeJobP95Mb: 3400, capMb: CAP }), {
		mb: 975,
		from: 'repo',
		lowerBound: false,
	});
});

test('a repo on the fleet p95 is still the repo answer — the node value does not override it', () => {
	const r = jobReserve({
		repoReserve: { mb: 3145, basis: 'fleet-p95', runs: 2 },
		nodeJobP95Mb: 3400,
		capMb: CAP,
	});
	assert.deepEqual(r, { mb: 3145, from: 'repo', lowerBound: false });
});

test("no repo figure: the node's hand-set value, then the default", () => {
	assert.deepEqual(jobReserve({ nodeJobP95Mb: 3400, capMb: CAP }), {
		mb: 3400,
		from: 'node',
		lowerBound: false,
	});
	assert.deepEqual(jobReserve({ repoReserve: null, capMb: CAP }), {
		mb: JOB_RESERVE_DEFAULT_MB,
		from: 'default',
		lowerBound: false,
	});
	// A figure that is not a positive number is not an answer. A zero reserve
	// would admit without limit on a node the count cap alone does not protect.
	assert.deepEqual(jobReserve({ repoReserve: { mb: 0, basis: 'measured', runs: 9 }, capMb: CAP }), {
		mb: JOB_RESERVE_DEFAULT_MB,
		from: 'default',
		lowerBound: false,
	});
});

test('the clamp holds whichever answer won, and does not rewrite `from`', () => {
	const r = jobReserve({
		repoReserve: { mb: 6313, basis: 'measured', runs: 8 },
		nodeJobP95Mb: 3400,
		capMb: 6000,
	});
	assert.deepEqual(r, { mb: 6000, from: 'repo', lowerBound: false });
});

// --- #76: a lower-bound reserve is passed through UNCLAMPED ----------------

test('#76: a lower-bound repo reserve is NOT clamped to the cap — the whole point is to see it exceed one', () => {
	const r = jobReserve({
		repoReserve: { mb: 6313, basis: 'fleet-p95', runs: 3, lowerBound: true },
		nodeJobP95Mb: 3400,
		capMb: 4096, // a smaller node's cap — clamping would hide the mismatch
	});
	assert.deepEqual(r, { mb: 6313, from: 'repo', lowerBound: true });
});

test('#76: an ordinary (non-lower-bound) reserve is still clamped exactly as before', () => {
	const r = jobReserve({
		repoReserve: { mb: 6313, basis: 'measured', runs: 40 },
		nodeJobP95Mb: 3400,
		capMb: 4096,
	});
	assert.deepEqual(r, { mb: 4096, from: 'repo', lowerBound: false });
});

test('ADMISSION reads the repo figure: a light repo fits where the node value refuses', () => {
	// The PRIMITIVES, not the wiring: `jobReserve`'s answer, handed to `admitMint`
	// directly. 4,000 MB free against a 1,536 MB floor: the node's 3,400 leaves
	// 600 and is refused, pygmalion's measured 975 leaves 3,025 and is admitted.
	// Drop the repo branch from `jobReserve` and the first assertion fails —
	// that is this lane's mutation.
	const node = { ...BASE, freeMb: 4000, minFreeMb: 1536 };
	const light = jobReserve({ repoReserve: PYGMALION, nodeJobP95Mb: 3400, capMb: CAP });
	assert.equal(admitMint({ ...node, requiredMb: light.mb }).ok, true, 'the repo figure admits');
	const byNode = jobReserve({ nodeJobP95Mb: 3400, capMb: CAP });
	assert.equal(admitMint({ ...node, requiredMb: byNode.mb }).ok, false, 'the node value refuses');
	// And the other direction: a HEAVY repo reserves more than the node's value,
	// so a node with room for 3,400 no longer takes it — IF production actually
	// hands admission that heavier number. (It does, in `dispatchEphemeral`'s
	// wiring, ONLY when the repo's reserve is `lowerBound: true` — see the
	// `requiredMbByRepo` tests below and in placement.test.ts. An ORDINARY
	// measured repo, however heavy, does not reach this path — this is still the
	// admitMint PRIMITIVE's behaviour given a number, not a claim about which
	// repos get one in production.)
	const heavy = jobReserve({
		repoReserve: { mb: 6313, basis: 'measured', runs: 8 },
		nodeJobP95Mb: 3400,
		capMb: CAP,
	});
	assert.equal(admitMint({ ...BASE, freeMb: 7000, requiredMb: byNode.mb }).ok, true);
	assert.equal(admitMint({ ...BASE, freeMb: 7000, requiredMb: heavy.mb }).ok, false);
});

// --- requiredMbByRepo is built ONLY from PROVEN lower bounds (#76, scoped) --

test('dispatchEphemeral: an ORDINARY repo reserve never enters requiredMbByRepo at all', async () => {
	const r = nodeRig(
		{ labels: ['hadoku-builder'], maxConcurrent: 3, minFreeMb: 2048, jobP95Mb: 2970 },
		['WolffM/measured-heavy', 'WolffM/measured-light']
	);
	await dispatchEphemeral(
		r.input as never,
		'tok',
		GH,
		r.sh as never,
		r.run as never,
		new Map([
			['WolffM/measured-heavy', { mb: 9000, basis: 'measured', runs: 40, lowerBound: false }],
			['WolffM/measured-light', { mb: 100, basis: 'measured', runs: 40, lowerBound: false }],
		])
	);
	const byRepo = r.seen[0].nodes?.[0].requiredMbByRepo;
	assert.equal(
		byRepo?.has('WolffM/measured-heavy'),
		false,
		'above the node figure, still no entry'
	);
	assert.equal(
		byRepo?.has('WolffM/measured-light'),
		false,
		'below the node figure, still no entry'
	);
});

test('dispatchEphemeral: a LOWER-BOUND repo reserve DOES enter requiredMbByRepo, as the raw floor', async () => {
	const r = nodeRig(
		{ labels: ['hadoku-builder'], maxConcurrent: 3, minFreeMb: 2048, jobP95Mb: 2970 },
		['WolffM/brave-quartet']
	);
	await dispatchEphemeral(
		r.input as never,
		'tok',
		GH,
		r.sh as never,
		r.run as never,
		new Map([['WolffM/brave-quartet', { mb: 6313, basis: 'fleet-p95', runs: 3, lowerBound: true }]])
	);
	const entry = r.seen[0].nodes?.[0].requiredMbByRepo?.get('WolffM/brave-quartet');
	assert.deepEqual(entry, { mb: 6313, lowerBound: true });
});

test('loadRepoReserves reads facets[repo].jobP95Mb and nothing else', () => {
	const dir = mkdtempSync(join(tmpdir(), 'reserves-'));
	try {
		const path = join(dir, 'fleet-runner-coverage.json');
		writeFileSync(
			path,
			JSON.stringify({
				repos: ['WolffM/a', 'WolffM/b', 'WolffM/c'],
				facets: {
					'WolffM/a': { uiApp: true, jobP95Mb: { mb: 975, basis: 'measured', runs: 156 } },
					'WolffM/b': { jobP95Mb: { mb: 3145, basis: 'fleet-p95', runs: 2 } },
					'WolffM/c': { uiApp: true },
				},
			})
		);
		const m = loadRepoReserves(path);
		assert.deepEqual(m.get('WolffM/a'), {
			mb: 975,
			basis: 'measured',
			runs: 156,
			lowerBound: false,
		});
		assert.deepEqual(m.get('WolffM/b'), {
			mb: 3145,
			basis: 'fleet-p95',
			runs: 2,
			lowerBound: false,
		});
		assert.equal(m.has('WolffM/c'), false, 'no figure is no entry — the node answers for it');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('an unreadable roster is an EMPTY map — every job falls to the node, none to zero', () => {
	const m = loadRepoReserves(join(tmpdir(), 'no-such-dir-j2', 'fleet-runner-coverage.json'));
	assert.equal(m.size, 0);
});

test('#76: loadRepoReserves reads lowerBound, and false is explicit rather than merely absent', () => {
	const dir = mkdtempSync(join(tmpdir(), 'reserves-lb-'));
	try {
		const path = join(dir, 'fleet-runner-coverage.json');
		writeFileSync(
			path,
			JSON.stringify({
				repos: ['WolffM/brave-quartet', 'WolffM/plain'],
				facets: {
					'WolffM/brave-quartet': {
						jobP95Mb: { mb: 6313, basis: 'fleet-p95', runs: 3, lowerBound: true },
					},
					'WolffM/plain': { jobP95Mb: { mb: 1000, basis: 'measured', runs: 40 } },
				},
			})
		);
		const m = loadRepoReserves(path);
		assert.equal(m.get('WolffM/brave-quartet')?.lowerBound, true);
		assert.equal(
			m.get('WolffM/plain')?.lowerBound,
			false,
			'absent in the file reads as false, not undefined'
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- a mint never targets a backstop (Wave 3g J2) --------------------------------

test('withoutBackstops drops a backstop the manifest marked ephemeral, and nothing else', () => {
	const input = {
		fleetProbe: new Map(),
		ephemeral: new Set(['claw-3', 'hokon']),
		nodes: { 'claw-3': { role: 'claw' }, hokon: { role: 'backstop' } },
		isSick: () => false,
		repos: [],
	};
	assert.deepEqual([...withoutBackstops(input).ephemeral], ['claw-3']);
	const clean = { ...input, ephemeral: new Set(['claw-3']) };
	assert.equal(withoutBackstops(clean), clean, 'no backstop, no copy');
});

test('a backstop marked ephemeral is never probed or minted on', async () => {
	// The whole tick, not the helper: a backstop in the ephemeral set must not see
	// even the `free -m` ssh. hokon is not `ephemeral: true` today — this is the
	// manifest edit that would otherwise have minted on the production host.
	const r = nodeRig({ labels: ['hadoku-builder'], maxConcurrent: 3, minFreeMb: 2048 });
	const input = {
		...r.input,
		fleetProbe: new Map([
			['claw-3', { reachable: true, busyRepos: new Map() }],
			['hokon', { reachable: true, busyRepos: new Map() }],
		]),
		ephemeral: new Set(['claw-3', 'hokon']),
		nodes: { ...r.input.nodes, hokon: { role: 'backstop', labels: ['hadoku-builder'] } },
	};
	const touched: string[] = [];
	const sh = async (n: string, cmd: string) => {
		touched.push(n);
		return r.sh(n, cmd);
	};
	await dispatchEphemeral(input as never, 'tok', GH, sh as never, r.run as never);
	assert.equal(touched.includes('hokon'), false, 'no ssh reaches the backstop');
	assert.deepEqual(
		r.seen[0].nodes?.map((n) => (n as unknown as { name: string }).name),
		['claw-3'],
		'and it is not a placement candidate'
	);
});

// --- an ON-DEMAND backstop is minted for, last and gated (#120) -----------------
//
// Operator, 2026-10-19: "the runners get brought online the same way the JIT
// process does. not having standing runners squatting on ram." The backstop is
// still never general capacity — it stays out of `ephemeral`, out of the warm
// cache, and out of the census — but it is a mint TARGET: for the work only its
// labels fit, and for `hadoku-builder` while the backstop holds it.

const HOKON_ON_DEMAND = {
	role: 'backstop',
	mint: 'on-demand',
	labels: ['pm2-host', 'taskauto'],
	maxConcurrent: 4,
	minFreeMb: 8192,
	slice: { name: 'ci-runner.slice', maxMb: 16384, unitMaxMb: 8192 },
};

function backstopRig() {
	const r = nodeRig({ labels: ['hadoku-builder'], maxConcurrent: 3, minFreeMb: 2048 });
	const input = {
		...r.input,
		fleetProbe: new Map([
			['claw-3', { reachable: true, busyRepos: new Map() }],
			['hokon', { reachable: true, busyRepos: new Map() }],
		]),
		nodes: { ...r.input.nodes, hokon: HOKON_ON_DEMAND },
	};
	const calls: {
		order: string[];
		labelsFor: (n: string) => string[];
		cap: number;
		slice: unknown;
	}[] = [];
	const run = async (i: {
		order: string[];
		labelsFor: (n: string) => string[];
		memoryMaxMbFor: (r: string, n: string) => number;
		sliceNameFor?: (n: string) => string | null | undefined;
	}) => {
		calls.push({
			order: i.order,
			labelsFor: i.labelsFor,
			cap: i.memoryMaxMbFor('WolffM/hadoku_site', 'hokon'),
			slice: i.sliceNameFor?.('hokon'),
		});
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	};
	// hokon: 40 GB available of 61 GB installed — far more than its allowance.
	const sh = async (n: string, cmd: string) =>
		n === 'hokon' ? (cmd.includes('$7, $2') ? '40000 61000' : '40000') : r.sh(n, cmd);
	return { input, run, sh, calls, claw: r };
}

test('#120: an on-demand backstop is a mint target, placed AFTER every claw — even a BUSY one', async () => {
	const g = backstopRig();
	// claw-3 running two jobs, hokon idle: a load-ranked order puts hokon FIRST,
	// which is the inverse of a backstop. The backstop must still come last.
	g.input.fleetProbe = new Map([
		['claw-3', { reachable: true, busyRepos: new Map([['WolffM/hadoku_site', 2]]), workers: 2 }],
		['hokon', { reachable: true, busyRepos: new Map() }],
	]);
	setBackstopHold([]);
	await dispatchEphemeral(g.input as never, 'tok', GH, g.sh as never, g.run as never);
	assert.deepEqual(
		g.calls[0]?.order,
		['claw-3', 'hokon'],
		'the production host is the last resort'
	);
});

test('#120: the backstop offers hadoku-builder ONLY while the backstop holds it', async () => {
	const g = backstopRig();
	try {
		setBackstopHold([]);
		await dispatchEphemeral(g.input as never, 'tok', GH, g.sh as never, g.run as never);
		const unheld = g.calls[0]!.labelsFor('hokon');
		assert.ok(unheld.includes('taskauto'), 'its own work is always minted for');
		assert.equal(unheld.includes('hadoku-builder'), false, "general CI is the backstop's to grant");
		assert.ok(g.calls[0]!.labelsFor('claw-3').includes('hadoku-builder'), 'a claw is unaffected');

		setBackstopHold(['hokon']);
		await dispatchEphemeral(g.input as never, 'tok', GH, g.sh as never, g.run as never);
		assert.ok(g.calls[1]!.labelsFor('hokon').includes('hadoku-builder'), 'promoted = offered');
	} finally {
		setBackstopHold([]);
	}
});

test('#15: placement is told which node is the on-demand backstop — the reserve is not inert', async () => {
	const g = backstopRig();
	let seen: { name: string; onDemandBackstop?: boolean }[] = [];
	const run = async (i: { nodes: { name: string; onDemandBackstop?: boolean }[] }) => {
		seen = i.nodes;
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	};
	setBackstopHold([]);
	await dispatchEphemeral(g.input as never, 'tok', GH, g.sh as never, run as never);
	assert.deepEqual(
		seen.map((n) => [n.name, n.onDemandBackstop]),
		[
			['claw-3', false],
			['hokon', true],
		]
	);
});

test('a backstop demotion MID-TICK cannot strip a label from a mint placement already chose (2026-10-23)', async () => {
	const g = backstopRig();
	let placed: string[] = [];
	let minted: string[] = [];
	const run = async (i: {
		nodes: { name: string; labels?: string[] }[];
		labelsFor: (n: string) => string[];
	}) => {
		placed = i.nodes.find((n) => n.name === 'hokon')?.labels ?? [];
		// runner-health's demote lands between placement and the mint.
		setBackstopHold([]);
		minted = i.labelsFor('hokon');
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	};
	try {
		setBackstopHold(['hokon']);
		await dispatchEphemeral(g.input as never, 'tok', GH, g.sh as never, run as never);
		assert.ok(placed.includes('hadoku-builder'), 'placement saw the promoted offer');
		assert.deepEqual(minted, placed, 'the mint registers exactly what placement matched on');
	} finally {
		setBackstopHold([]);
	}
});

test('#120: a backstop unit is capped at its OWN unitMaxMb inside its allowance, in its OWN slice', async () => {
	const g = backstopRig();
	await dispatchEphemeral(g.input as never, 'tok', GH, g.sh as never, g.run as never);
	// The claw rule (MemTotal − minFreeMb) would read 61000 − 8192 here and hand
	// one job ~52 GB of the production host.
	assert.equal(g.calls[0]?.cap, 8192);
	assert.equal(g.calls[0]?.slice, 'ci-runner.slice');
});

test('#120: a backstop WITHOUT mint: on-demand is still never minted on', async () => {
	const g = backstopRig();
	g.input.nodes = { ...g.input.nodes, hokon: { ...HOKON_ON_DEMAND, mint: 'always' } };
	const touched: string[] = [];
	const sh = async (n: string, cmd: string) => {
		touched.push(n);
		return g.sh(n, cmd);
	};
	await dispatchEphemeral(g.input as never, 'tok', GH, sh as never, g.run as never);
	assert.equal(touched.includes('hokon'), false, 'only the exact value opts a backstop in');
	assert.deepEqual(g.calls[0]?.order, ['claw-3']);
});
