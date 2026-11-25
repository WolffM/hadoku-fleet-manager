import assert from 'node:assert/strict';
import { test } from 'node:test';

import { downStreakOf, OUTAGE_MIN_SAMPLES, SAMPLE_MS } from './host-reliability.mjs';
import { decide } from './hosting-converge.mjs';

// The 2026-11-24 archivebot sequence: claw-9's proven standby missed one offer
// probe while CI saturated it, a second standby was declared on claw-8, and the
// pass after claw-9 answered again ended claw-9 rather than the new slice.

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
/** A standby held for thirteen days: the proven one. */
const PROVEN = iso(NOW - 13 * 86_400_000);
const offer = (node, over = {}) => ({
	node,
	reachable: true,
	link: 'wired',
	pm2: { unbounded: [] },
	pm2Peer: true,
	labels: ['service-host'],
	...over,
});
const fenced = {
	app: 'archivebot',
	kind: 'service',
	slices: { unit: { memoryMb: 1024, cores: 1 }, min: 1, max: 1 },
	availability: { noticeMin: 15, stateful: true, singleton: true, fence: 'data-lease', standby: 1 },
	placement: { require: ['wired'], prefer: [] },
};
const plan = (standby) => ({
	ranked: [],
	refused: [],
	standby: { ranked: standby.map((node) => ({ node, role: 'standby' })) },
});
const run = (over) =>
	decide({
		request: fenced,
		demand: null,
		plan: plan([]),
		offers: [],
		slices: [],
		removeDue: [],
		notices: [],
		now: NOW,
		...over,
	});

test('a standby that missed one probe is kept while the sampler has not seen an outage', () => {
	const d = run({
		plan: plan(['claw-fixture-b']),
		offers: [
			offer('claw-fixture-p'),
			offer('claw-fixture-a', { reachable: false, downStreak: 1 }),
			offer('claw-fixture-b'),
		],
		slices: [{ node: 'claw-fixture-p' }, { node: 'claw-fixture-a', role: 'standby' }],
	});
	assert.deepEqual(d.actions, [], 'no second standby is declared on one missed probe');
	assert.deepEqual(d.standby.serving, ['claw-fixture-a']);
	assert.deepEqual(d.standby.unplaceable, []);
	const note = d.blocked.find((b) => b.node === 'claw-fixture-a');
	assert.ok(note?.soft, 'the kept standby is reported, softly');
	assert.match(note.why, new RegExp(`down 1 of the ${OUTAGE_MIN_SAMPLES} ticks`));
});

test('a standby down for an outage, or with no sample evidence, is replaced as before', () => {
	for (const downStreak of [OUTAGE_MIN_SAMPLES, null, undefined]) {
		const d = run({
			plan: plan(['claw-fixture-b']),
			offers: [
				offer('claw-fixture-p'),
				offer('claw-fixture-a', { reachable: false, downStreak }),
				offer('claw-fixture-b'),
			],
			slices: [{ node: 'claw-fixture-p' }, { node: 'claw-fixture-a', role: 'standby' }],
		});
		assert.deepEqual(
			d.actions.map((a) => [a.op, a.node, a.role]),
			[['declare', 'claw-fixture-b', 'standby']],
			`downStreak ${downStreak}`
		);
		assert.equal(d.standby.unplaceable[0].node, 'claw-fixture-a');
	}
});

test('a reachable standby failing a rule is still replaced: only an unanswered probe waits', () => {
	const d = run({
		plan: plan(['claw-fixture-b']),
		offers: [
			offer('claw-fixture-p'),
			offer('claw-fixture-a', { link: 'wifi', downStreak: 0 }),
			offer('claw-fixture-b'),
		],
		slices: [{ node: 'claw-fixture-p' }, { node: 'claw-fixture-a', role: 'standby' }],
	});
	assert.deepEqual(
		d.actions.map((a) => [a.op, a.node]),
		[['declare', 'claw-fixture-b']]
	);
});

test('past the count, the OLDEST standby is kept, whatever the manifest order', () => {
	const d = run({
		offers: [offer('claw-fixture-p'), offer('claw-fixture-a'), offer('claw-fixture-b')],
		slices: [
			{ node: 'claw-fixture-p' },
			// Listed first, declared nine minutes ago: the slice that must go.
			{ node: 'claw-fixture-a', role: 'standby', since: iso(NOW - 9 * 60_000) },
			{ node: 'claw-fixture-b', role: 'standby', since: PROVEN },
		],
	});
	assert.deepEqual(
		d.actions.map((a) => [a.op, a.node, a.role, a.inMin]),
		[['end', 'claw-fixture-a', 'standby', 15]]
	);

	const undated = run({
		offers: [offer('claw-fixture-p'), offer('claw-fixture-a'), offer('claw-fixture-b')],
		slices: [
			{ node: 'claw-fixture-p' },
			{ node: 'claw-fixture-a', role: 'standby' },
			{ node: 'claw-fixture-b', role: 'standby', since: PROVEN },
		],
	});
	assert.deepEqual(
		undated.actions.map((a) => [a.op, a.node]),
		[['end', 'claw-fixture-a']],
		'an undated slice counts as the newest'
	);
});

test('downStreakOf: the trailing run of down samples now, drained or not; null when it cannot look', () => {
	const rows = (node, states, endMs = NOW) =>
		states.map((state, i) => ({
			node,
			at: iso(endMs - (states.length - 1 - i) * SAMPLE_MS),
			state,
			drained: state === 'unreachable-drained',
		}));
	const read = {
		exists: true,
		unreadableLines: 0,
		rows: [
			...rows('claw-fixture-a', ['mintable', 'mintable', 'unreachable']),
			...rows('claw-fixture-b', ['unreachable', 'mintable', 'unreachable', 'offline']),
			...rows('claw-fixture-c', ['mintable', 'mintable']),
			...rows('claw-fixture-d', ['unreachable', 'unreachable'], NOW - 30 * 60_000),
			...rows('claw-fixture-e', ['mintable', 'unreachable-drained']).map((r) =>
				r.drained ? { ...r, state: 'unreachable' } : r
			),
		],
	};
	const of = downStreakOf(read, NOW);
	assert.equal(of('claw-fixture-a'), 1);
	assert.equal(of('claw-fixture-b'), 2);
	assert.equal(of('claw-fixture-c'), 0);
	assert.equal(
		of('claw-fixture-d'),
		null,
		'a newest sample two ticks old: the sampler is not running'
	);
	assert.equal(of('claw-fixture-e'), 1, 'a drain explains a down node; it is still down');
	assert.equal(of('claw-fixture-x'), null, 'no samples for the node');
	assert.equal(downStreakOf({ error: 'EACCES' }, NOW)('claw-fixture-a'), null);
	assert.equal(downStreakOf({ rows: [], exists: false }, NOW)('claw-fixture-a'), null);
});
