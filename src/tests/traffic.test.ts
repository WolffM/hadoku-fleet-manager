import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { orderCandidates, type TrafficNode } from '../runners/traffic.js';

const n = (
	name: string,
	busy: number,
	idleSeconds: number | null = 0,
	speedFactor: number | null = null
): TrafficNode => ({
	name,
	busy,
	idleSeconds,
	speedFactor,
});

test('the least busy node goes first', () => {
	const out = orderCandidates(
		['claw-2', 'claw-4', 'claw-1', 'claw-5', 'claw-6', 'claw-3'],
		[n('claw-2', 4), n('claw-4', 2), n('claw-1', 0), n('claw-5', 1), n('claw-6', 0), n('claw-3', 3)]
	);
	assert.deepEqual(out, ['claw-1', 'claw-6', 'claw-5', 'claw-4', 'claw-3', 'claw-2']);
});

// The 2026-09-09 distribution: claw-1 took 47% of dispatcher-placed jobs
// because placement fell through to the fleet manifest's JSON key order, and
// claw-1 is the first key. An ordering must never depend on how a file or a Set
// happens to list the candidates.
test('the order does not depend on the order candidates are LISTED in', () => {
	const census = [n('claw-1', 0, 30), n('claw-2', 0, 30), n('claw-3', 0, 30)];
	const a = orderCandidates(['claw-1', 'claw-2', 'claw-3'], census);
	const b = orderCandidates(['claw-3', 'claw-1', 'claw-2'], census);
	assert.deepEqual(a, b);
});

test('a genuine tie falls back to the node NAME, so it is still deterministic', () => {
	assert.deepEqual(orderCandidates(['c', 'a', 'b'], [n('c', 0, 5), n('a', 0, 5), n('b', 0, 5)]), [
		'a',
		'b',
		'c',
	]);
});

test('equal busy rotates by longest idle, so sequential work spreads', () => {
	// 2026-09-02: ordering on `busy` alone sent every SEQUENTIAL job on an idle
	// fleet to the same node.
	const out = orderCandidates(
		['claw-2', 'claw-4', 'claw-1'],
		[n('claw-2', 0, 5), n('claw-4', 0, 120), n('claw-1', 0, 900)]
	);
	assert.deepEqual(out, ['claw-1', 'claw-4', 'claw-2']);
});

test('busy still outranks idle time — spreading load comes first', () => {
	assert.deepEqual(
		orderCandidates(['claw-2', 'claw-1'], [n('claw-2', 0, 1), n('claw-1', 2, 9000)]),
		['claw-2', 'claw-1']
	);
});

test('an UNMEASURED node sorts last among equals, never first', () => {
	// null idle means nobody looked. Treating that as "idle forever" is how a box
	// nobody has examined attracts the entire queue.
	assert.deepEqual(orderCandidates(['a', 'b'], [n('a', 0, null), n('b', 0, 5)]), ['b', 'a']);
});

test('a candidate with no observation at all goes to the back, not out', () => {
	// Not dropped (that would silently shrink the fleet), not promoted (nothing
	// vouches for it).
	assert.deepEqual(orderCandidates(['a', 'b', 'c'], [n('a', 3), n('c', 0)]), ['c', 'a', 'b']);
});

test('never invents a node the caller did not offer', () => {
	assert.deepEqual(orderCandidates(['a'], [n('a', 0), n('rogue', 0)]), ['a']);
});

test('an UNSCHEDULABLE node sorts last, even though it looks perfectly idle', () => {
	// 2026-09-02: claw-4 answered ssh with zero workers while all 26 of its
	// registrations were offline. "Fewest busy" ranks that node FIRST, so an
	// ordering that ignored schedulability would send the queue to the one box
	// that cannot take it.
	const out = orderCandidates(
		['broken', 'working'],
		[
			{ name: 'broken', busy: 0, idleSeconds: 9999, speedFactor: null, schedulable: false },
			{ name: 'working', busy: 3, idleSeconds: 0, speedFactor: null, schedulable: true },
		]
	);
	assert.deepEqual(out, ['working', 'broken']);
});

test('unschedulable is ranked last, not removed', () => {
	// Dropping it would silently shrink the fleet on a transient GitHub read.
	const out = orderCandidates(
		['a', 'b'],
		[
			{ name: 'a', busy: 0, idleSeconds: 0, speedFactor: null, schedulable: false },
			{ name: 'b', busy: 0, idleSeconds: 0, speedFactor: null, schedulable: false },
		]
	);
	assert.equal(out.length, 2);
});

test('absent schedulability is treated as schedulable', () => {
	// `undefined` means nobody looked; absent evidence must not remove a node.
	const out = orderCandidates(
		['a', 'b'],
		[
			{ name: 'a', busy: 0, idleSeconds: 0, speedFactor: null },
			{ name: 'b', busy: 1, idleSeconds: 0, speedFactor: null, schedulable: true },
		]
	);
	assert.deepEqual(out, ['a', 'b']);
});

// ---------------------------------------------------------------------------
// speedFactor — the TIE-BREAK after `busy`, ahead of idle time (wave 3z, #83's
// continuous sibling). Measured factors from the real fleet: claw-8 0.73,
// claw-3 1.42.
// ---------------------------------------------------------------------------

test('two idle nodes order the faster MEASURED node first (claw-8 0.73 vs claw-3 1.42)', () => {
	// Both idle the same length of time -- without the speed step this would be
	// a pure idle-time/name tie. Today's bug: a free claw-3 and a free claw-8
	// took work in rotation regardless of which was actually faster.
	const out = orderCandidates(
		['claw-3', 'claw-8'],
		[n('claw-3', 0, 100, 1.42), n('claw-8', 0, 100, 0.73)]
	);
	assert.deepEqual(out, ['claw-8', 'claw-3']);
});

test('a BUSIER fast node orders AFTER a less-busy slow node — speed is a tie-break, never a priority', () => {
	// claw-8 (0.73, fast) has one job in flight; claw-3 (1.42, slow) is idle.
	// `busy` is step 1 and must win regardless of how the speed step would
	// have ordered them.
	const out = orderCandidates(
		['claw-3', 'claw-8'],
		[n('claw-3', 0, 0, 1.42), n('claw-8', 1, 0, 0.73)]
	);
	assert.deepEqual(out, ['claw-3', 'claw-8']);
});

test('an unknown node (null factor) reads as 1.0 — between a 0.8 and a 1.2', () => {
	const out = orderCandidates(
		['slow', 'unknown', 'fast'],
		[n('slow', 0, 0, 1.2), n('unknown', 0, 0, null), n('fast', 0, 0, 0.8)]
	);
	assert.deepEqual(out, ['fast', 'unknown', 'slow']);
});

test('an EMPTY speed model (every factor null) reproduces the pre-#83 order exactly', () => {
	// Mirrors "equal busy rotates by longest idle" above, but states the
	// invariant explicitly: an unreadable/empty history must change NOTHING,
	// because every node's factor is null and null reads as the same 1.0 for
	// every node, so the speed step never fires.
	const out = orderCandidates(
		['claw-2', 'claw-4', 'claw-1'],
		[n('claw-2', 0, 5, null), n('claw-4', 0, 120, null), n('claw-1', 0, 900, null)]
	);
	assert.deepEqual(out, ['claw-1', 'claw-4', 'claw-2']);
});
