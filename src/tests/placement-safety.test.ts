/**
 * Tests for `runners/placement.ts`: fork-safety (`isForkSafe`), the base
 * placement walk order, and the two reserve-admission issues over the
 * repo's own (possibly lower-bound) memory figure (#76, #77). Split out of
 * placement.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/placement-rig.ts` for the shared `m()`/`ORDER` fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { choosePlacement, isForkSafe } from '../runners/placement.js';
import { m, ORDER, installPlacementRig } from './helpers/placement-rig.js';

installPlacementRig();

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
