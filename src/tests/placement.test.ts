import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	choosePlacement,
	isForkSafe,
	HEAVY_HOLD_SEC,
	SPILL_FLOOR_SEC,
	type NodeState,
} from '../runners/placement.js';
import type { SpeedModel, SpeedTier } from '../runners/speed-tier.js';
import type { HeavyModel } from '../runners/traffic.js';
import { planTick, type PendingRun } from '../runners/dispatcher.js';
import {
	__resetSpeedModelForTesting,
	__resetHeavyModelForTesting,
	__resetWarmCacheClockForTesting,
	__resetWarmReposForTesting,
	__resetWarmBackoffForTesting,
	dispatchEphemeral,
	dispatchWarmCache,
	warmReposForPlacement,
	type EphemeralTickInput,
} from '../runners/ephemeral-tick.js';
import {
	runDispatchPass,
	__resetReapClockForTesting,
	__markHeavyForTesting,
	__resetHeavyMarksForTesting,
} from '../runners/dispatch-pass.js';
import { warmRunnerName, TMP_FREE_FLOOR_MB, WORK_FREE_FLOOR_MB } from '../runners/ephemeral.js';
import { __resetTarballCacheForTesting } from '../runners/ephemeral-exec.js';
import { __resetJobHistoryForTesting, __setHistoryPathForTesting } from '../job-history.js';
import { fakeGh, fakeShell } from './helpers/fleet-fakes.js';

// --- B8: fork safety --------------------------------------------------------

test('a same-repo branch push is first-party', () => {
	assert.equal(
		isForkSafe({
			repository: { full_name: 'WolffM/hadoku_site' },
			head_repository: { full_name: 'WolffM/hadoku_site', fork: false },
			event: 'push',
		}).ok,
		true
	);
});

test('a fork PR is refused even when the fork flag is absent', () => {
	// Two independent signals, because relying on `fork` alone trusts one field
	// on a payload we did not generate.
	const r = isForkSafe({
		repository: { full_name: 'WolffM/hadoku_site' },
		head_repository: { full_name: 'someone/hadoku_site' },
		event: 'pull_request',
	});
	assert.equal(r.ok, false);
	assert.match(r.reason ?? '', /not WolffM\/hadoku_site/);
});

test('the fork flag alone is enough to refuse', () => {
	const r = isForkSafe({
		repository: { full_name: 'WolffM/x' },
		head_repository: { full_name: 'WolffM/x', fork: true },
	});
	assert.equal(r.ok, false);
	assert.match(r.reason ?? '', /is a fork/);
});

test('pull_request_target is refused outright', () => {
	const r = isForkSafe({
		repository: { full_name: 'WolffM/x' },
		head_repository: { full_name: 'WolffM/x' },
		event: 'pull_request_target',
	});
	assert.equal(r.ok, false);
});

test('a cron or dispatch run has no head repository and is first-party', () => {
	// Only someone with write access can trigger these, so absence of a head repo
	// is not absence of proof.
	assert.equal(isForkSafe({ repository: { full_name: 'WolffM/x' }, event: 'schedule' }).ok, true);
});

test('FAILS CLOSED on an unrecognisable run', () => {
	// The opposite polarity to every other guard here. A false skip costs work; a
	// false allow runs a stranger's code on a box holding vault credentials.
	assert.equal(isForkSafe({}).ok, false);
	assert.equal(isForkSafe({ head_repository: { full_name: 'x/y' } }).ok, false);
});

// --- B10: placement order ---------------------------------------------------

const m = (name: string, over: Partial<NodeState> = {}): NodeState => ({
	name,
	healthy: true,
	eligible: true,
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 3,
	freeMb: 8000,
	requiredMb: 900,
	minFreeMb: 1536,
	...over,
});
const ORDER = ['claw-2', 'claw-1', 'claw-3', 'hokon'];

test('placement takes the first node in the order that can serve', () => {
	const p = choosePlacement(ORDER, [m('claw-2'), m('claw-1'), m('claw-3'), m('hokon')]);
	assert.equal(p.node, 'claw-2');
	assert.deepEqual(p.passed, []);
});

test('a full node falls through to the next one, and says why', () => {
	// All four EQUALLY busy (#102: busy outranks nothing else here, so this
	// keeps the walk in the order's own position, same as before busy was
	// ranked at all) — claw-1's own cap is raised so the tie does not ALSO
	// refuse it.
	const p = choosePlacement(ORDER, [
		m('claw-2', { liveUnits: 3 }),
		m('claw-1', { liveUnits: 3, maxConcurrent: 4 }),
		m('claw-3', { liveUnits: 3 }),
		m('hokon', { liveUnits: 3 }),
	]);
	assert.equal(p.node, 'claw-1');
	assert.equal(p.passed.length, 1);
	assert.match(p.passed[0].reason, /at capacity/);
});

test('the production host is reached only when everything above it is full', () => {
	// All four EQUALLY busy, for the same reason as the test above — hokon's
	// own cap is raised so the tie does not ALSO refuse the one node meant to
	// succeed.
	const p = choosePlacement(ORDER, [
		m('claw-2', { liveUnits: 3 }),
		m('claw-1', { liveUnits: 3, healthy: false }),
		m('claw-3', { liveUnits: 3, eligible: false }),
		m('hokon', { liveUnits: 3, maxConcurrent: 4 }),
	]);
	assert.equal(p.node, 'hokon');
	assert.deepEqual(
		p.passed.map((x) => x.node),
		['claw-2', 'claw-1', 'claw-3']
	);
});

test('memory pressure alone can push a job to the next node', () => {
	// The count cap would allow this; 3 GB of unreclaimable would not fit.
	const p = choosePlacement(ORDER, [
		m('claw-2', { freeMb: 3000, requiredMb: 2900 }),
		m('claw-1', { freeMb: 9000, requiredMb: 2900 }),
	]);
	assert.equal(p.node, 'claw-1');
	assert.match(p.passed[0].reason, /memory/);
});

// --- requiredMbByRepo: the repo's own (possibly lower-bound) reserve (#76) --

test('requiredMbByRepo overrides the node-level requiredMb for the repo it names', () => {
	// claw-2's node-level requiredMb (900) would admit; brave-quartet's own
	// known floor (6,313 MB, flagged a lower bound) does not fit claw-2's
	// 6,313 MB slice even alone — PLACEMENT, not the node-level number.
	const node = m('claw-2', {
		freeMb: 6313 + 1536,
		sliceCeilingMb: 6313,
		requiredMbByRepo: new Map([['WolffM/brave-quartet', { mb: 6313, lowerBound: true }]]),
	});
	const other = m('claw-1', { freeMb: 9000 });
	assert.equal(
		choosePlacement(ORDER, [node, other], [], 'WolffM/brave-quartet').node,
		'claw-1',
		'claw-2 is refused on the repo figure; a cheap job for claw-2 still works'
	);
	assert.equal(
		choosePlacement(ORDER, [node, other], [], 'WolffM/other-repo').node,
		'claw-2',
		'a repo absent from the map falls through to the node-level requiredMb, unchanged'
	);
});

test('requiredMbByRepo does nothing when no `repo` is supplied to choosePlacement', () => {
	const node = m('claw-2', {
		freeMb: 6313 + 1536,
		sliceCeilingMb: 6313,
		requiredMbByRepo: new Map([['WolffM/brave-quartet', { mb: 6313, lowerBound: true }]]),
	});
	assert.equal(
		choosePlacement(ORDER, [node]).node,
		'claw-2',
		'no repo means no lookup — today’s walk, unchanged'
	);
});

test('requiredMbByRepo is NEVER consulted for an ordinary (non-lowerBound) repo, above the node figure', () => {
	// A repo MEASURED above the node's hand-set requiredMb must NOT newly refuse
	// a node it fits on today — only a PROVEN lower bound may move anything
	// (manager scope correction, 2026-10-02). claw-2's node-level requiredMb is
	// 900 (the `m()` default); a repo whose own figure is 5,000 and NOT a lower
	// bound must still admit here exactly as it does with no map at all.
	const node = m('claw-2', {
		freeMb: 2600, // 900 fits (after 1536 >= minFreeMb); 5,000 would not
		requiredMbByRepo: new Map([['WolffM/measured-heavy', { mb: 5000, lowerBound: false }]]),
	});
	assert.equal(
		choosePlacement(ORDER, [node], [], 'WolffM/measured-heavy').node,
		'claw-2',
		'an ordinary repo above the node figure must not be refused on its own number'
	);
});

test('requiredMbByRepo is NEVER consulted for an ordinary (non-lowerBound) repo, below the node figure', () => {
	// The other direction: a repo measured BELOW the node figure must not pack
	// tighter than today either. claw-2 at 2,435 MB free clears 900 (leaving
	// 1,535, just under minFreeMb 1536 — refused on the NODE figure) but would
	// easily clear an (unconsulted) 200 MB repo figure if it were read.
	const node = m('claw-2', {
		freeMb: 2435,
		requiredMbByRepo: new Map([['WolffM/measured-light', { mb: 200, lowerBound: false }]]),
	});
	const p = choosePlacement(ORDER, [node], [], 'WolffM/measured-light');
	assert.equal(
		p.node,
		undefined,
		'refused on the NODE figure (900), not admitted on the repo one (200)'
	);
	assert.match(p.passed[0].reason, /memory/);
});

// --- Placement.requiredMb: the reserve admission actually used (#77) -------

test('a lower-bound placement carries the reserve ADMISSION ACTUALLY USED, not the node figure', () => {
	// claw-2's flat requiredMb is 900; brave-quartet's proven floor raises what
	// admission checks to max(900, 6313) = 6313. A caller decrementing freeMb by
	// the node figure instead of this would under-charge the tick by 5,413 MB —
	// exactly the double-book this issue is about.
	const node = m('claw-2', {
		freeMb: 6313 + 1536,
		sliceCeilingMb: 6313 + 1536,
		requiredMbByRepo: new Map([['WolffM/brave-quartet', { mb: 6313, lowerBound: true }]]),
	});
	const p = choosePlacement(ORDER, [node], [], 'WolffM/brave-quartet');
	assert.equal(p.node, 'claw-2');
	assert.equal(p.requiredMb, 6313, 'the reserve actually checked, not the node-level 900');
});

test('an ordinary repo leaves Placement.requiredMb undefined — the caller falls back to the node figure', () => {
	// No entry in the map at all.
	assert.equal(
		choosePlacement(ORDER, [m('claw-2')], [], 'WolffM/plain-repo').requiredMb,
		undefined
	);
	// An entry that exists but is not a lower bound — never consulted, same as
	// the refusal tests above.
	const node = m('claw-2', {
		requiredMbByRepo: new Map([['WolffM/measured-heavy', { mb: 5000, lowerBound: false }]]),
	});
	assert.equal(
		choosePlacement(ORDER, [node], [], 'WolffM/measured-heavy').requiredMb,
		undefined,
		'a non-lower-bound figure must not surface as the reserve used either'
	);
	// No repo supplied at all.
	assert.equal(choosePlacement(ORDER, [m('claw-2')]).requiredMb, undefined);
});

test('a lower-bound reserve below the node figure still surfaces the RAISED number, never a smaller one', () => {
	// max(node.requiredMb, own.mb): the override can only raise, so a floor
	// smaller than the node's own figure must report the node figure back, not
	// its own (smaller) number — the same invariant `refusalFor` enforces for
	// admission, now visible to the caller that reads it off Placement.
	const node = m('claw-2', {
		requiredMb: 4000,
		requiredMbByRepo: new Map([['WolffM/small-but-capped', { mb: 1000, lowerBound: true }]]),
	});
	assert.equal(choosePlacement(ORDER, [node], [], 'WolffM/small-but-capped').requiredMb, 4000);
});

test('a full fleet QUEUES rather than forcing a mint', () => {
	// Forcing here is the OOM this workstream exists to prevent.
	const p = choosePlacement(
		ORDER,
		ORDER.map((n) => m(n, { liveUnits: 3 }))
	);
	assert.equal(p.node, undefined);
	assert.match(p.reason ?? '', /no node/);
	assert.equal(p.passed.length, 4, 'every node is accounted for, not silently skipped');
});

test('a node in the order but absent from the fleet is reported, not crashed on', () => {
	// `claw-1` refuses too (unhealthy), so the walk actually REACHES `ghost`
	// rather than stopping before it — #102's re-rank tries every PLACEABLE,
	// KNOWN node before a name the fleet never heard of (see `choosePlacement`'s
	// own doc on why `unknown` sorts last), so a `ghost` the walk never reaches
	// is simply never reported, which is correct, not silently dropped.
	const p = choosePlacement(['ghost', 'claw-1'], [m('claw-1', { healthy: false })]);
	assert.equal(p.node, undefined);
	assert.match(p.passed[0].reason, /unhealthy/);
	assert.match(p.passed[1].reason, /not in the fleet/);
});

test('a node with no `repo` supplied never carries affinity', () => {
	// Every call site written before this parameter existed. Omitting it must
	// reproduce today's ordering bit for bit — nothing here is a breaking
	// change to a caller that has not been wired up yet.
	const p = choosePlacement(ORDER, [m('claw-2'), m('claw-1', { warmRepo: 'WolffM/hadoku_site' })]);
	assert.equal(p.node, 'claw-2');
	assert.equal(p.viaAffinity, false);
});

// --- P5.1: warm affinity ------------------------------------------------

test('a live listener for the JOB repo wins over least-loaded', () => {
	// claw-3 is last in the order but holds the warm listener this job wants.
	const p = choosePlacement(
		ORDER,
		[m('claw-2'), m('claw-1'), m('claw-3', { warmRepo: 'WolffM/hadoku_site' }), m('hokon')],
		[],
		'WolffM/hadoku_site'
	);
	assert.equal(p.node, 'claw-3');
	assert.equal(p.viaAffinity, true);
	// Everyone the affinity node jumped ahead of is still reported, in order —
	// "why did this land on claw-3" stays answerable.
	assert.deepEqual(
		p.passed.map((x) => x.node),
		[]
	);
});

test('affinity is REPO-SCOPED — a listener warm for a different repo is worth nothing here', () => {
	const p = choosePlacement(
		ORDER,
		[m('claw-2'), m('claw-1'), m('claw-3', { warmRepo: 'WolffM/hadoku-pygmalion' }), m('hokon')],
		[],
		'WolffM/hadoku_site'
	);
	assert.equal(p.node, 'claw-2', 'the base order is untouched — nothing here matches this repo');
	assert.equal(p.viaAffinity, false);
});

test('degrades to plain ordering when no listener is live anywhere — "rotate otherwise"', () => {
	const p = choosePlacement(
		ORDER,
		[m('claw-2'), m('claw-1'), m('claw-3'), m('hokon')],
		[],
		'WolffM/hadoku_site'
	);
	assert.equal(p.node, 'claw-2');
	assert.equal(p.viaAffinity, false);
});

test('a STALE record — a node warm for the wrong repo it USED to serve — degrades the same as absent', () => {
	// The caller is expected to source `warmRepo` from the GitHub listing, not
	// a cache write; this asserts placement.ts's own half of that contract:
	// it never treats "warm for something else" as "warm enough".
	const p = choosePlacement(
		ORDER,
		[m('claw-2'), m('claw-1', { warmRepo: 'WolffM/some-other-repo' })],
		[],
		'WolffM/hadoku_site'
	);
	assert.equal(p.node, 'claw-2');
	assert.equal(p.viaAffinity, false);
});

test('an UNVERIFIABLE listener — the node reporting it is unhealthy — falls through, never forced', () => {
	// A listener that "exists" on a node the health check has already refused
	// is exactly the #17 shape: a record saying warm while the node is not
	// really there. Affinity tries it first, same as any other candidate, and
	// the SAME unhealthy check refuses it — no special case needed.
	const p = choosePlacement(
		ORDER,
		[m('claw-2', { warmRepo: 'WolffM/hadoku_site', healthy: false }), m('claw-1')],
		[],
		'WolffM/hadoku_site'
	);
	assert.equal(p.node, 'claw-1');
	assert.equal(p.viaAffinity, false);
	assert.match(p.passed[0].reason, /unhealthy/);
});

test('affinity still refuses on capacity — a warm node at capacity is not force-minted', () => {
	// Both EQUALLY busy (#102: busy outranks affinity, so a genuine tie is
	// what lets affinity promote claw-1 here at all) — claw-2's OWN cap is
	// raised to 4 so the tie does not ALSO refuse it; claw-1 stays at the
	// default cap of 3 and is still refused on capacity, so the walk falls
	// through to claw-2.
	const p = choosePlacement(
		ORDER,
		[
			m('claw-2', { liveUnits: 3, maxConcurrent: 4 }),
			m('claw-1', { warmRepo: 'WolffM/hadoku_site', liveUnits: 3 }),
		],
		[],
		'WolffM/hadoku_site'
	);
	assert.equal(p.node, 'claw-2');
	assert.equal(p.viaAffinity, false);
	assert.match(p.passed[0].reason, /at capacity/);
});

test('a full fleet still QUEUES under affinity, exactly as it does without it', () => {
	const p = choosePlacement(
		ORDER,
		ORDER.map((n) => m(n, { liveUnits: 3, warmRepo: 'WolffM/hadoku_site' })),
		[],
		'WolffM/hadoku_site'
	);
	assert.equal(p.node, undefined);
	assert.equal(p.viaAffinity, false);
	assert.equal(p.passed.length, 4);
});

test('two nodes warm for the SAME repo still rotate between themselves by the base order', () => {
	// Affinity is a stable partition, not a fixed pick: within the affinity
	// group the underlying order still decides, so a burst
	// against one warm node overflows to the OTHER warm node before it ever
	// reaches a cold one.
	const p = choosePlacement(
		ORDER,
		[
			m('claw-2', { warmRepo: 'WolffM/hadoku_site', liveUnits: 3 }), // warm, full
			m('claw-1'), // cold, has room
			m('claw-3', { warmRepo: 'WolffM/hadoku_site' }), // warm, has room
			m('hokon'),
		],
		[],
		'WolffM/hadoku_site'
	);
	assert.equal(p.node, 'claw-3', 'the second warm node, not the cold one ahead of it in the order');
	assert.equal(p.viaAffinity, true);
});

test('no cold node is starved: a burst against a warm pair overflows to the rest, and the rate is a number', () => {
	// Fleet-size simulation, mirroring `planTick`'s own capacity-consumption
	// pattern (state copied and decremented per placement within one burst) —
	// 6 claws, 2 of them warm for the repo a 12-job burst all wants, each
	// capped at 2 concurrent (claw-3/4/5's real measured slot count from
	// warm-listener-cache-2026-09-05.md). Answering "how often is a warm claw
	// deliberately skipped to keep others measured" (P5.3) with a NUMBER,
	// scoped to what this lane can prove: capacity, not a probabilistic skip —
	// deliberate rate-limiting of a repo with room to spare is P5.3's, tracked
	// separately and fed by lane G's forced-placement harness instead.
	const REPO = 'WolffM/hadoku_site';
	const nodes = [
		m('claw-2', { warmRepo: REPO, maxConcurrent: 2 }),
		m('claw-4', { warmRepo: REPO, maxConcurrent: 2 }),
		m('claw-1', { maxConcurrent: 2 }),
		m('claw-5', { maxConcurrent: 2 }),
		m('claw-6', { maxConcurrent: 2 }),
		m('claw-3', { maxConcurrent: 2 }),
	];
	const order = nodes.map((n) => n.name);
	const state = new Map(nodes.map((n) => [n.name, { ...n }]));
	const landedOn: string[] = [];
	for (let i = 0; i < 12; i++) {
		const p = choosePlacement(order, [...state.values()], [], REPO);
		assert.ok(p.node, `job ${i} must place somewhere — the burst is 12 against 12 total slots`);
		state.get(p.node!)!.liveUnits += 1;
		landedOn.push(p.node!);
	}
	const warm = landedOn.filter((n) => n === 'claw-2' || n === 'claw-4').length;
	const cold = landedOn.length - warm;
	// The two warm nodes hold 4 of the burst's 12 slots between them; the
	// other 8 MUST land on a cold node once those fill — not an adjective, the
	// exact count a 2-slot-per-node cap forces.
	assert.equal(
		warm,
		4,
		'both warm nodes fill and stop winning — affinity never force-mints past capacity'
	);
	assert.equal(
		cold,
		8,
		'every cold node in a 6-node fleet gets real traffic once the warm pair saturates'
	);
	assert.equal(
		new Set(landedOn.filter((n) => n !== 'claw-2' && n !== 'claw-4')).size,
		4,
		'all 4 cold nodes drew work, not just one'
	);
});

// ---------------------------------------------------------------------------
// #102: heavy kinds want an empty claw
// ---------------------------------------------------------------------------

const HEAVY_REPO = 'WolffM/hadoku-cardtable';

/** A minimal `HeavyModel` fixture — `isHeavy` by exact (repo, job) kind when
 *  named, `isHeavyRepo` as the repo-level fallback `choosePlacement` itself
 *  never calls directly (that fallback is only ever exercised through
 *  `ephemeral-tick.ts`'s `NodeState.runningHeavy`, set from THIS repo-level
 *  method against a RUNNING worker whose job name the probe cannot see). */
function fakeHeavyModel(heavyKinds: Set<string>, heavyRepos: Set<string>): HeavyModel {
	return {
		isHeavy: (repo, jobName) =>
			jobName !== undefined ? heavyKinds.has(`${repo}\u0000${jobName}`) : heavyRepos.has(repo),
		isHeavyRepo: (repo) => heavyRepos.has(repo),
	};
}

test('#102.4: a LIGHT job ranks a node running a heavy job last, among equally busy nodes', () => {
	const heavyModel = fakeHeavyModel(
		new Set([`${HEAVY_REPO}\u0000forge-e2e`]),
		new Set([HEAVY_REPO])
	);
	// Both idle (busy 0) — the ONLY thing distinguishing them is that claw-2 is
	// ALREADY running a heavy-kind job. The order lists the heavy-busy node
	// FIRST, so this fails under plain position/name tie-break too.
	const runningHeavy = m('claw-2', { runningHeavy: true, heavyModel });
	const quiet = m('claw-1', { heavyModel });
	const p = choosePlacement(['claw-2', 'claw-1'], [runningHeavy, quiet], [], 'WolffM/hadoku_site', {
		jobName: 'build',
	});
	assert.equal(p.node, 'claw-1');
	assert.equal(p.heavy, false, 'the QUEUED job itself — a plain hadoku_site build — is not heavy');
});

test('#102.4: a HEAVY job is unaffected by the heavy-avoidance term — it still competes on busy alone', () => {
	// The avoidance term exists so a LIGHT job does not land beside a heavy
	// one; a heavy job does not need protecting from itself, and must still
	// place on the node already running one when nothing else exists.
	const heavyModel = fakeHeavyModel(
		new Set([`${HEAVY_REPO}\u0000forge-e2e`]),
		new Set([HEAVY_REPO])
	);
	const node = m('claw-9', { runningHeavy: true, heavyModel });
	const p = choosePlacement(['claw-9'], [node], [], HEAVY_REPO, { jobName: 'forge-e2e' });
	assert.equal(p.node, 'claw-9', 'a heavy job still places — never queues forever (#102.4)');
	assert.equal(p.heavy, true);
});

test('#102.4: a heavy job skips a busy node when an idle one exists, and the busy node is never even tried', () => {
	const heavyModel = fakeHeavyModel(
		new Set([`${HEAVY_REPO}\u0000forge-e2e`]),
		new Set([HEAVY_REPO])
	);
	const busy = m('claw-2', { liveUnits: 1, maxConcurrent: 4, heavyModel });
	const idle = m('claw-1', { heavyModel });
	const p = choosePlacement(ORDER, [busy, idle], [], HEAVY_REPO, { jobName: 'forge-e2e' });
	assert.equal(p.node, 'claw-1');
	assert.deepEqual(
		p.passed,
		[],
		'the busier node is ranked after the idle one, not tried and refused'
	);
});

test('#102: `Placement.heavy` is `false` whenever no node carries a `heavyModel` — every caller before this wave', () => {
	const p = choosePlacement(ORDER, [m('claw-2'), m('claw-1')], [], HEAVY_REPO, {
		jobName: 'forge-e2e',
	});
	assert.equal(p.heavy, false);
});

// --- #102: a heavy job holds out for a node with no heavy job --------------

const FORGE = fakeHeavyModel(
	new Set([`${HEAVY_REPO}\u0000forge-e2e`, `${HEAVY_REPO}\u0000forge-jvm`]),
	new Set([HEAVY_REPO])
);

test('#102 heavy hold: a heavy job refuses a node running a heavy job inside the hold, and says why', () => {
	const p = choosePlacement(
		['claw-4'],
		[m('claw-4', { heavyJobs: 1, heavyModel: FORGE })],
		[],
		HEAVY_REPO,
		{
			jobName: 'forge-e2e',
			queuedSec: 30,
		}
	);
	assert.equal(p.node, undefined, 'held, not doubled');
	assert.deepEqual(p.passed, [
		{
			node: 'claw-4',
			reason: `heavy hold: already running 1 heavy job(s) (queued 30s < ${HEAVY_HOLD_SEC}s)`,
			// A clock lifts this one, so it says when (#117's probe backoff reads it).
			holdSec: HEAVY_HOLD_SEC,
		},
	]);
});

test('#102 heavy hold: an unknown queue age holds — it is never "waited long enough"', () => {
	const p = choosePlacement(
		['claw-4'],
		[m('claw-4', { heavyJobs: 1, heavyModel: FORGE })],
		[],
		HEAVY_REPO,
		{
			jobName: 'forge-e2e',
		}
	);
	assert.equal(p.node, undefined);
	assert.match(p.passed[0].reason, /queued unknown/);
});

test('#102 heavy hold: past HEAVY_HOLD_SEC the job places doubled rather than queue forever', () => {
	const p = choosePlacement(
		['claw-4'],
		[m('claw-4', { heavyJobs: 1, heavyModel: FORGE })],
		[],
		HEAVY_REPO,
		{
			jobName: 'forge-e2e',
			queuedSec: HEAVY_HOLD_SEC,
		}
	);
	assert.equal(p.node, 'claw-4');
});

test('#102 heavy hold: a LIGHT job is never held by heavyJobs — only ranked by runningHeavy', () => {
	const p = choosePlacement(
		['claw-4'],
		[m('claw-4', { heavyJobs: 2, runningHeavy: true, heavyModel: FORGE })],
		[],
		HEAVY_REPO,
		{
			jobName: 'check',
			queuedSec: 0,
		}
	);
	assert.equal(p.node, 'claw-4');
});

test('#102 heavy hold: repo-level runningHeavy alone does not hold — a light cardtable check is not a Forge shard', () => {
	// claw-8 at 22:08Z: running cardtable `check`, which reads runningHeavy
	// (repo-level) but is not a heavy KIND. Holding on that would have kept a
	// shard off the one jdk21 node doing nothing heavy.
	const p = choosePlacement(
		['claw-8'],
		[m('claw-8', { standingBusy: 1, runningHeavy: true, heavyModel: FORGE })],
		[],
		HEAVY_REPO,
		{
			jobName: 'forge-e2e',
			queuedSec: 0,
		}
	);
	assert.equal(p.node, 'claw-8');
});

test('#102 heavy hold: a heavy job ranks fewest heavy jobs ahead of fewest busy, once the hold has expired', () => {
	// claw-4: one Forge shard. claw-8: two light jobs. Busy alone picks claw-4.
	const p = choosePlacement(
		['claw-4', 'claw-8'],
		[
			m('claw-4', { standingBusy: 1, heavyJobs: 1, heavyModel: FORGE }),
			m('claw-8', { standingBusy: 2, maxConcurrent: 4, heavyModel: FORGE }),
		],
		[],
		HEAVY_REPO,
		{ jobName: 'forge-jvm', queuedSec: HEAVY_HOLD_SEC + 1 }
	);
	assert.equal(p.node, 'claw-8');
	assert.deepEqual(p.passed, [], 'ranked past, not tried and refused');
});

test('#102.1 PRODUCTION SHAPE: `dispatchEphemeral`’s OWN probe-to-NodeState seam reads busy as jobs, not distinct repos', async () => {
	// Every other #102 test here hand-builds a `NodeState` with `standingBusy`
	// already set — none of them exercise the ACTUAL seam that computes it
	// from the fleet probe (`ephemeral-tick.ts`'s `standingBusy: p.workers ?? …`).
	// This one goes through the real `dispatchEphemeral`, so a regression there
	// — e.g. reverting to the pre-#102 `[...busyRepos.values()].filter(n>0).length`
	// — fails THIS test even though every `choosePlacement`-level test above
	// still passes (they all construct `NodeState.standingBusy` directly).
	//
	// claw-1: THREE running cardtable workers, in ONE repo — the exact #102
	// incident ("three Forge jobs stacked on one claw"). Pre-fix: one busy
	// repo with n>0 reads `standingBusy: 1`. Fixed: `p.workers` reads 3.
	//
	// claw-9: ONE running worker, attributed across TWO repo keys in
	// `busyRepos` (one of them idle) — proves the fix is not ALSO still
	// secretly keyed on the repo map's shape: whatever `busyRepos` looks like,
	// `workers` is the number that counts.
	//
	// NAMED SO THE PRE-FIX TIE PICKS THE WRONG ONE: both nodes read
	// `standingBusy: 1` under the REVERTED formula (one non-idle repo each),
	// and `orderCandidates`'s own tie-break is the node NAME — 'claw-1' sorts
	// before 'claw-9', so a reverted fix would (wrongly) prefer the node
	// actually running THREE jobs. The fix tells them apart on the real count
	// (3 vs 1) before name ever matters, and picks claw-9.
	const input: EphemeralTickInput = {
		fleetProbe: new Map([
			['claw-1', { reachable: true, workers: 3, busyRepos: new Map([[HEAVY_REPO, 3]]) }],
			[
				'claw-9',
				{
					reachable: true,
					workers: 1,
					busyRepos: new Map([
						['WolffM/some-other-repo', 1],
						['WolffM/yet-another-repo', 0],
					]),
				},
			],
		]),
		ephemeral: new Set(['claw-1', 'claw-9']),
		nodes: { 'claw-1': WIRE_NODE, 'claw-9': WIRE_NODE },
		isSick: () => false,
		repos: ['WolffM/hadoku_site'],
		standingEligible: new Set(),
	};
	const sh = simShell({});
	const gh = fakeGh({});
	const queuedRun: PendingRun = {
		id: 1,
		jobId: 1,
		repo: 'WolffM/hadoku_site',
		labels: [],
		repository: { full_name: 'WolffM/hadoku_site' },
		head_repository: { full_name: 'WolffM/hadoku_site', fork: false },
		event: 'push',
	};
	const res = await dispatchEphemeral(input, 'tok', gh, sh, async (inp, token, g, s) =>
		runDispatchPass({ ...inp, pending: [queuedRun], tarballUrl: null }, token, g, s)
	);
	assert.equal(res?.minted, 1, 'the one queued job places somewhere');
	assert.deepEqual(
		mintedOn,
		['claw-9'],
		'claw-9 (really 1 worker) is chosen over claw-1 (really 3) — busy is jobs, not repos'
	);
});

// ---------------------------------------------------------------------------
// WS-W: the affinity term is WIRED — the two arguments nothing supplied
// ---------------------------------------------------------------------------
//
// Every test above this line calls `choosePlacement` directly and passes `repo`
// itself, so all twelve of them passed for five days and ~2,000 jobs while the
// feature was dead in production: `a6a19a4` shipped the term as an optional
// parameter, `dispatcher.ts` never passed it, and nothing anywhere assigned
// `NodeState.warmRepo` (`warm-affinity-measured-2026-09-14.md` §3, falsified in
// source AND in the deployed 0.22.108, five exit-1 greps).
//
// A unit test of a pure function cannot catch that, by construction — the thing
// that was missing was the CALL, not the callee. So these tests run the real
// call chain and assert on where a job actually lands:
//
//   dispatchEphemeral -> runDispatchPass -> planTick -> choosePlacement
//
// with only GitHub and the shell faked, at the seams the rest of this
// workstream fakes. Remove either half of the wiring and they go red; that is
// the whole reason they exist, and the mutation counts are recorded in
// `docs/planning/warm-affinity-measured-2-2026-09-15.md` §4.

const WIRE_REPO = 'WolffM/hadoku_site';
const OTHER_REPO = 'WolffM/hadoku-pygmalion';
const FLEET_LABELS = ['self-hosted', 'hadoku-builder'];

/**
 * A first-party queued job, the shape `planTick` admits past `isForkSafe`.
 *
 * `labels: []` by default so the label filter is out of the way: these tests
 * are about the affinity ORDER, and the bare `m()` node above carries no
 * declared labels. The end-to-end tests pass `FLEET_LABELS` explicitly, where
 * the node offer is derived from a manifest that does carry them.
 */
const pending = (over: Partial<PendingRun> & { repo: string }): PendingRun => ({
	id: 9001,
	jobId: 77,
	labels: [],
	repository: { full_name: over.repo },
	head_repository: { full_name: over.repo, fork: false },
	event: 'push',
	...over,
});

const NO_INFLIGHT = { jobIds: new Set<number>(), runIds: new Set<number>() };

test('WIRING: the live mint path supplies the queued run’s repo to the affinity term', () => {
	// THE MUTATION TARGET FOR `dispatcher.ts`. claw-3 is LAST in the walk and
	// holds the warm listener this job wants; claw-2 is first and has room, so
	// it is what an unwired `choosePlacement(order, eligible, labels)` picks —
	// which is exactly what the fleet did on every dispatch until 2026-09-15.
	const nodes = [m('claw-2'), m('claw-1'), m('claw-3', { warmRepo: WIRE_REPO }), m('hokon')];
	const plan = planTick([pending({ repo: WIRE_REPO })], nodes, ORDER, NO_INFLIGHT, 1_700_000_000);
	assert.equal(plan.mint.length, 1);
	assert.equal(
		plan.mint[0].node,
		'claw-3',
		'drop the 4th argument in dispatcher.ts and this is claw-2 — the inert behaviour'
	);
	assert.deepEqual(plan.skipped, []);
});

test('WIRING: affinity is resolved PER RUN, not once per tick', () => {
	// One tick, two repos, two different warm nodes. A wiring that hoisted the
	// repo out of the loop (or took it from the first run) would land both on
	// the same node and still pass the single-run test above.
	const nodes = [
		m('claw-2'),
		m('claw-1', { warmRepo: OTHER_REPO }),
		m('claw-3', { warmRepo: WIRE_REPO }),
	];
	const plan = planTick(
		[pending({ id: 1, jobId: 1, repo: WIRE_REPO }), pending({ id: 2, jobId: 2, repo: OTHER_REPO })],
		nodes,
		ORDER,
		NO_INFLIGHT,
		1_700_000_000
	);
	assert.deepEqual(
		plan.mint.map((x) => `${x.repo}->${x.node}`),
		[`${WIRE_REPO}->claw-3`, `${OTHER_REPO}->claw-1`]
	);
});

test('WIRING: a repo no node is warm for is placed exactly as it was before P5.1', () => {
	// The other half of "purely additive". Supplying `repo` must not perturb a
	// fleet where nothing is warm — the burst that regressed here would be
	// invisible in the affinity tests, which all have a warm node by design.
	const nodes = ORDER.map((n) => m(n));
	const plan = planTick([pending({ repo: WIRE_REPO })], nodes, ORDER, NO_INFLIGHT, 1_700_000_000);
	assert.equal(plan.mint[0].node, 'claw-2');
});

// --- the fleet half: NodeState.warmRepo, sourced from GitHub's listing -------

const WIRE_NODE = {
	labels: ['hadoku-builder'],
	maxConcurrent: 3,
	minFreeMb: 2048,
	slice: { unitMaxMb: 4096 },
	jobP95Mb: 900,
};

interface NodeSim {
	/** `"<repo> <epochSec>"`, as `$HOME/.hadoku/warm/repo` holds it. */
	marker: string | null;
	/** Units `systemctl --user is-active` answers `active` for. */
	active: Set<string>;
}

/** #101: free MB this fixture answers for the `df -Pm` tail of the space
 * probe — comfortably clear of `TMP_FREE_FLOOR_MB`/`WORK_FREE_FLOOR_MB` so
 * none of this file's placement assertions have to think about space. */
const SPACE_FREE_MB = Math.max(TMP_FREE_FLOOR_MB, WORK_FREE_FLOOR_MB) * 4;

/** Nodes that received a JIT provisioning step this pass — i.e. were minted on. */
let mintedOn: string[] = [];

/**
 * The fleet's shell, as a stateful fake.
 *
 * Only the two commands `currentWarmSlot` issues are modelled here; everything
 * else defers to the shared `fakeShell`, so this cannot drift from the fixture
 * the rest of the workstream asserts against.
 */
function simShell(sims: Record<string, NodeSim>) {
	const base = fakeShell();
	return async (node: string, cmd: string): Promise<string | null> => {
		const s = (sims[node] ??= { marker: null, active: new Set() });
		if (/SLOT=\d+/.test(cmd)) mintedOn.push(node);
		// A 16 GB-class claw. The shared `fakeShell` answers 9000 MB installed,
		// which is one 4GB-class slot once `minFreeMb` is set aside — i.e. NOT
		// warm-cache eligible (`warmEligibleSlots`), so every warm assertion below
		// would pass vacuously against a node the tick never reaches. Two columns
		// for the dispatch tick (`$7, $2` — available AND installed), one for the
		// warm tick (`$2` alone).
		if (cmd.includes('free -m')) {
			const freeLine = cmd.includes('$7, $2') ? '9000 16000' : '16000';
			// #101: BOTH shapes piggyback the same `df -Pm` tail (shared
			// `SPACE_PROBE_DF_CMD`), so this fixture must answer it too.
			// #101: trailing newline, the way `execFile`'s real stdout always has
			// one.
			return cmd.includes('df -Pm')
				? `${freeLine}\n${SPACE_FREE_MB}\n${SPACE_FREE_MB}\n`
				: freeLine;
		}
		if (cmd.includes('warm/repo')) return s.marker ?? '';
		if (cmd.includes('is-active')) {
			const unit = /is-active\s+(\S+)/.exec(cmd)?.[1];
			return unit && s.active.has(unit) ? 'active' : 'inactive';
		}
		// The warm MINT's own two steps (`mintWarmListener`) — added for the
		// warm-path #82/#83 tests below, which are the first in this file to
		// exercise a listener actually being minted rather than only observed.
		// Mirrors warm-cache.test.ts's own fake for the same two commands.
		if (cmd.includes('warm-provision.sh')) {
			const repo = /REPO='([^']*)'/.exec(cmd)?.[1] ?? '';
			s.marker = `${repo} 1000`;
			return 'WARM-READY /home/hadoku/.hadoku/warm/listener 2.336.0';
		}
		if (cmd.includes('systemd-run')) {
			const unit = /--unit=(\S+)/.exec(cmd)?.[1];
			if (unit) s.active.add(unit);
			return 'Running as unit: x.service';
		}
		return base(node, cmd);
	};
}

/** claw-3 holds a warm listener for `repo`; claw-2 holds nothing. */
function fleetWithWarmClaw3(repo: string): Record<string, NodeSim> {
	return {
		'claw-2': { marker: null, active: new Set() },
		'claw-3': { marker: `${repo} 1000`, active: new Set([warmRunnerName('claw-3', repo)]) },
	};
}

function wireInput(): EphemeralTickInput {
	return {
		fleetProbe: new Map([
			['claw-2', { reachable: true, busyRepos: null }],
			['claw-3', { reachable: true, busyRepos: null }],
		]),
		// Equal load and no job history, so the order falls back to the node
		// NAME: claw-2 is tried first and claw-3 only by affinity.
		ephemeral: new Set(['claw-2', 'claw-3']),
		nodes: { 'claw-2': WIRE_NODE, 'claw-3': WIRE_NODE },
		isSick: () => false,
		repos: [WIRE_REPO],
		// Nothing standing can take the job — the all-JIT fleet's normal state,
		// and it removes the age gate so the pass does not depend on wall-clock.
		standingEligible: new Set(),
	};
}

let wireTmp: string;
beforeEach(() => {
	wireTmp = mkdtempSync(join(tmpdir(), 'placement-wire-'));
	__setHistoryPathForTesting(join(wireTmp, 'job-history.jsonl'));
	__resetJobHistoryForTesting();
	__setHistoryPathForTesting(join(wireTmp, 'job-history.jsonl'));
	__resetWarmCacheClockForTesting();
	__resetWarmReposForTesting();
	__resetWarmBackoffForTesting();
	__resetTarballCacheForTesting();
	__resetReapClockForTesting();
	// #83: the speed model is cached across calls on its own 10-minute clock
	// (SPEED_MODEL_REBUILD_INTERVAL_MS) — correct for production, but this
	// file's WIRING tests call `dispatchWarmCache`/`dispatchEphemeral` many
	// times each with its own job-history fixture, so each test must see its
	// OWN history, not whichever one built the model first.
	__resetSpeedModelForTesting();
	// #102: same reason as the speed model just above — one real job-history
	// fixture per test.
	__resetHeavyModelForTesting();
	mintedOn = [];
});
afterEach(() => {
	rmSync(wireTmp, { recursive: true, force: true });
	__setHistoryPathForTesting(null);
	__resetWarmReposForTesting();
});

test('WIRING: the warm tick publishes a slot GitHub reports ONLINE', async () => {
	const sims = fleetWithWarmClaw3(WIRE_REPO);
	const gh = fakeGh({
		runners: [{ id: 1, name: warmRunnerName('claw-3', WIRE_REPO), status: 'online', busy: false }],
	});
	await dispatchWarmCache(wireInput(), 'tok', gh, simShell(sims));
	assert.deepEqual([...warmReposForPlacement()], [['claw-3', WIRE_REPO]]);
});

test('WIRING: an OFFLINE registration publishes nothing — issue #17, from the listing', async () => {
	// The marker names the repo and systemd says the unit is active, so BOTH of
	// the node-local facts agree. GitHub says the registration is offline, and
	// that is the one that decides: a listener GitHub will not assign to is not
	// warm, whatever the box believes about itself.
	const sims = fleetWithWarmClaw3(WIRE_REPO);
	const gh = fakeGh({
		runners: [{ id: 1, name: warmRunnerName('claw-3', WIRE_REPO), status: 'offline', busy: false }],
	});
	await dispatchWarmCache(wireInput(), 'tok', gh, simShell(sims));
	assert.equal(warmReposForPlacement().size, 0);
});

test('WIRING: a registration absent from the listing publishes nothing', async () => {
	// "I could not look" and "it is gone" are the same answer here, and it is
	// the fall-through one: no affinity, never a refusal.
	const sims = fleetWithWarmClaw3(WIRE_REPO);
	await dispatchWarmCache(wireInput(), 'tok', fakeGh({}), simShell(sims));
	assert.equal(warmReposForPlacement().size, 0);
});

test('WIRING: the observation is replaced WHOLESALE — a node that loses its listener stops winning', async () => {
	const sims = fleetWithWarmClaw3(WIRE_REPO);
	const unit = warmRunnerName('claw-3', WIRE_REPO);
	const sh = simShell(sims);
	await dispatchWarmCache(wireInput(), 'tok', fakeGh({ runners: [{ id: 1, name: unit }] }), sh);
	assert.equal(warmReposForPlacement().get('claw-3'), WIRE_REPO);

	// The listener dies. Same marker, same everything the node writes down.
	sims['claw-3'].active.delete(unit);
	__resetWarmCacheClockForTesting();
	await dispatchWarmCache(wireInput(), 'tok', fakeGh({ runners: [{ id: 1, name: unit }] }), sh);
	assert.equal(warmReposForPlacement().size, 0, 'the previous pass must not survive this one');
});

test('WIRING: end to end — a job lands on the warm claw, through production’s own glue', async () => {
	// THE PROOF, AND THE MUTATION TARGET FOR BOTH HALVES. Nothing between
	// `dispatchEphemeral` and the mint is substituted except GitHub and the
	// shell: the real warm tick sources `warmRepo` off the real listing, the
	// real `runDispatchPass` calls the real `planTick`, and the real
	// `choosePlacement` decides. claw-2 is first in the walk and has room —
	// which is where this job went on every dispatch the fleet made between
	// 2026-09-09 and this change.
	const sims = fleetWithWarmClaw3(WIRE_REPO);
	const gh = fakeGh({
		runners: [{ id: 1, name: warmRunnerName('claw-3', WIRE_REPO), status: 'online', busy: false }],
	});
	const res = await dispatchEphemeral(
		wireInput(),
		'tok',
		gh,
		simShell(sims),
		async (inp, token, g, s) =>
			runDispatchPass(
				{ ...inp, pending: [pending({ repo: WIRE_REPO, labels: FLEET_LABELS })], tarballUrl: null },
				token,
				g,
				s
			)
	);
	assert.equal(res?.minted, 1, 'one queued job, one mint');
	assert.equal(res?.skipped, 0);
	assert.deepEqual(mintedOn, ['claw-3'], 'the warm claw, not the first node in the walk');
});

test('WIRING: end to end — the SAME fleet with no warm listener mints on the first node', async () => {
	// The control arm. Identical input but for the marker, so a failure of the
	// test above cannot be waved off as "the fixture only ever picks claw-3".
	const sims: Record<string, NodeSim> = {
		'claw-2': { marker: null, active: new Set() },
		'claw-3': { marker: null, active: new Set() },
	};
	const res = await dispatchEphemeral(
		wireInput(),
		'tok',
		fakeGh({}),
		simShell(sims),
		async (inp, token, g, s) =>
			runDispatchPass(
				{ ...inp, pending: [pending({ repo: WIRE_REPO, labels: FLEET_LABELS })], tarballUrl: null },
				token,
				g,
				s
			)
	);
	assert.equal(res?.minted, 1);
	assert.deepEqual(mintedOn, ['claw-2']);
});

test('WIRING: the manifest’s excludeRepos refuses the JIT mint path too, not just the reconciler (#82)', async () => {
	// claw-3 is warm for WIRE_REPO — the exact fixture the test above proves
	// mints there WITHOUT an exclusion. Adding `excludeRepos` for the SAME repo
	// on the SAME node is the only difference; if the mint path ignored it (as
	// it did before this wave — `ephemeral-tick.ts` hardcoded `eligible: true`),
	// this would still land on claw-3.
	const sims = fleetWithWarmClaw3(WIRE_REPO);
	const gh = fakeGh({
		runners: [{ id: 1, name: warmRunnerName('claw-3', WIRE_REPO), status: 'online', busy: false }],
	});
	const input: EphemeralTickInput = {
		...wireInput(),
		nodes: {
			'claw-2': WIRE_NODE,
			'claw-3': { ...WIRE_NODE, excludeRepos: { [WIRE_REPO]: 'wave 3w test: excluded on claw-3' } },
		},
	};
	const res = await dispatchEphemeral(input, 'tok', gh, simShell(sims), async (inp, token, g, s) =>
		runDispatchPass(
			{ ...inp, pending: [pending({ repo: WIRE_REPO, labels: FLEET_LABELS })], tarballUrl: null },
			token,
			g,
			s
		)
	);
	assert.equal(
		res?.minted,
		1,
		'the job still places somewhere — an exclusion is not a universal refusal'
	);
	assert.deepEqual(
		mintedOn,
		['claw-2'],
		'claw-3 is warm for this repo and would otherwise win the walk — the manifest exclusion is what pushes it to claw-2'
	);
});

test('WIRING: the SAME exclusion leaves a DIFFERENT repo on that node unaffected', async () => {
	// The inverse fixture: claw-3 is warm for OTHER_REPO this time, and its
	// manifest entry excludes WIRE_REPO only. OTHER_REPO must still land on
	// claw-3 via its own warm listener — the exclusion naming WIRE_REPO must
	// not leak onto a repo it never mentioned.
	const sims = fleetWithWarmClaw3(OTHER_REPO);
	const gh = fakeGh({
		runners: [{ id: 1, name: warmRunnerName('claw-3', OTHER_REPO), status: 'online', busy: false }],
	});
	const input: EphemeralTickInput = {
		...wireInput(),
		repos: [OTHER_REPO],
		nodes: {
			'claw-2': WIRE_NODE,
			'claw-3': { ...WIRE_NODE, excludeRepos: { [WIRE_REPO]: 'excluded here only' } },
		},
	};
	const res = await dispatchEphemeral(input, 'tok', gh, simShell(sims), async (inp, token, g, s) =>
		runDispatchPass(
			{ ...inp, pending: [pending({ repo: OTHER_REPO, labels: FLEET_LABELS })], tarballUrl: null },
			token,
			g,
			s
		)
	);
	assert.equal(res?.minted, 1);
	assert.deepEqual(
		mintedOn,
		['claw-3'],
		'claw-3 excludes WIRE_REPO only — OTHER_REPO still lands here through its own warm listener'
	);
});

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
// All within WARM_HISTORY_WINDOW_MS (6h) of each other and of SPEED_NOW, and
// within WINDOW_DAYS (30d) of SPEED_NOW for the speed model — both windows
// are real-calendar, ISO-string based, so an opaque small `nowMs` (the shape
// every other WIRING test in this file uses) would silently fall outside
// both. ANCHORED TO Date.now(), not a literal calendar date — a fixed date
// ages out of both windows on its own as real time passes (the fixture-clock
// guard fails this suite 400 days ahead otherwise), the same fix
// `warm-cache.test.ts`'s own `HIST_T0` already uses.
const SPEED_BASE_MS = Date.now() - 2 * 24 * 3600_000;
const SPEED_DEMAND_AT = new Date(SPEED_BASE_MS + 60_000).toISOString();
const SPEED_NOW = SPEED_BASE_MS + 3_600_000; // 1h after the fixture, well clear of WARM_ASSIGN_WINDOW_MS too

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
		'planWarmFleet wanted to fill this repo here — the exclusion withheld it'
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
