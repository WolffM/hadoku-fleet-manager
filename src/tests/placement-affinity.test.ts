/**
 * Tests for `runners/placement.ts`'s P5.1 warm-affinity term: a live listener
 * for the queued job's repo wins over least-loaded, scoped per repo, and
 * degrading cleanly to plain ordering whenever no listener is live or the
 * listener is stale/unverifiable/at capacity. Split out of placement.test.ts
 * (wave 5o lane B) — see `src/tests/helpers/placement-rig.ts` for the shared
 * `m()`/`ORDER` fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { choosePlacement } from '../runners/placement.js';
import { m, ORDER, installPlacementRig } from './helpers/placement-rig.js';

installPlacementRig();

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
