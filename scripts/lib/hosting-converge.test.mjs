import assert from 'node:assert/strict';
import { test } from 'node:test';

import { act, decide, doorArgs } from './hosting-converge.mjs';

const NOW = Date.now();
/** An instant `min` minutes from NOW. */
const at = (min) => new Date(NOW + min * 60_000).toISOString();
const offer = (node, over = {}) => ({
	node,
	reachable: true,
	link: 'wired',
	pm2: { unbounded: [] },
	pm2Peer: true,
	labels: [],
	...over,
});
const agent = {
	app: 'cardtable',
	slices: { unit: { memoryMb: 4096, cores: 4 }, min: 1, max: 4 },
	availability: { noticeMin: 15, stateful: false, singleton: false },
	placement: { require: ['wired'], prefer: [] },
};
const service = {
	app: 'watchparty',
	slices: { unit: { memoryMb: 1024, cores: 1 }, min: 1, max: 1 },
	availability: { noticeMin: 15, stateful: true, singleton: true },
	placement: { require: ['wired'], prefer: [] },
};
const plan = (...ranked) => ({ ranked: ranked.map((node) => ({ node })), refused: [] });
const run = (over) =>
	decide({
		request: agent,
		demand: null,
		plan: plan(),
		offers: [],
		slices: [],
		removeDue: [],
		notices: [],
		now: NOW,
		...over,
	});

test('demand above what serves declares on the plan’s top picks, one per node, never past max', () => {
	const d = run({
		demand: { slices: 3 },
		plan: plan('claw-5', 'claw-6', 'claw-3'),
		offers: [offer('claw-9')],
		slices: [{ node: 'claw-9' }],
	});
	assert.deepEqual(
		d.actions.map((a) => [a.op, a.node]),
		[
			['declare', 'claw-5'],
			['declare', 'claw-6'],
		]
	);
	assert.deepEqual(d.blocked, []);

	const capped = run({
		demand: { slices: 4 },
		plan: plan('claw-5', 'claw-6'),
		offers: ['a', 'b', 'c'].map((n) => offer(n, { reachable: false })),
		slices: [{ node: 'a' }, { node: 'b' }, { node: 'c' }],
	});
	assert.equal(capped.actions.length, 1, 'three held + one is max; the unplaceable still count');
	assert.match(capped.blocked[0].why, /holds 3 of its 4 slices and 3 cannot serve/);
});

test('the same demand restated is no action', () => {
	const d = run({
		demand: { slices: 1 },
		plan: plan('claw-5'),
		offers: [offer('claw-9')],
		slices: [{ node: 'claw-9' }],
	});
	assert.deepEqual(d.actions, []);
	assert.deepEqual(d.blocked, []);
	assert.deepEqual(d.serving, ['claw-9']);
});

test('no demand means slices.min, and demand is clamped to min..max', () => {
	assert.equal(run({ plan: plan('claw-5') }).desired, 1);
	assert.equal(run({ demand: { slices: 9 } }).desired, 4);
	assert.equal(run({ demand: { slices: 0 } }).desired, 1);
});

test('too many ends ONLY from the head of the release order, with the tenant’s notice', () => {
	const held = ['claw-9', 'claw-8', 'claw-5'].map((node) => ({ node }));
	const offers = held.map((s) => offer(s.node));
	const d = run({
		demand: { slices: 1, releaseOrder: ['claw-5', 'claw-8'] },
		offers,
		slices: held,
	});
	assert.deepEqual(
		d.actions.map((a) => [a.op, a.node, a.inMin]),
		[
			['end', 'claw-5', 15],
			['end', 'claw-8', 15],
		]
	);

	const blind = run({ demand: { slices: 1 }, offers, slices: held });
	assert.deepEqual(blind.actions, [], 'with no order nothing is ended');
	assert.match(blind.blocked[0].why, /only cardtable knows/);
	assert.equal(blind.blocked[0].soft, true);
});

test('an ending slice is not serving, and a passed end is removed', () => {
	const d = run({
		demand: { slices: 1 },
		plan: plan('claw-5'),
		offers: [offer('claw-9')],
		slices: [{ node: 'claw-9', until: at(20) }],
		removeDue: ['claw-8'],
	});
	assert.deepEqual(
		d.actions.map((a) => [a.op, a.node]),
		[
			['remove', 'claw-8'],
			['declare', 'claw-5'],
		]
	);
	assert.deepEqual(d.ending, [{ node: 'claw-9', until: at(20) }]);
});

test('unplaceable: unreachable, a failed rule, a drain inside the horizon; a rule it cannot tell is not a fault', () => {
	const d = run({
		demand: { slices: 4 },
		offers: [
			offer('down', { reachable: false }),
			offer('wifi', { link: 'wifi' }),
			offer('soon'),
			offer('later'),
			offer('unknown', { link: null }),
		],
		slices: ['down', 'wifi', 'soon', 'later', 'unknown'].map((node) => ({ node })),
		notices: [
			{ node: 'soon', event: 'starts', kind: 'reboot', at: at(25) },
			{ node: 'later', event: 'starts', kind: 'reboot', at: at(120) },
		],
	});
	assert.deepEqual(
		d.unplaceable.map((u) => [u.node, u.why]),
		[
			['down', 'cannot be reached'],
			['wifi', 'fails "wired"'],
			['soon', `has a reboot drain starting ${at(25)}`],
		]
	);
	assert.deepEqual(d.serving, ['later', 'unknown']);
});

test('a singleton is never given a second slice: its move is the mover’s, with the target named', () => {
	const d = run({
		request: service,
		demand: { slices: 1 },
		plan: { ranked: [], refused: [] },
		movePlan: plan('claw-6'),
		offers: [offer('claw-4', { link: 'wifi' })],
		slices: [{ node: 'claw-4' }],
	});
	assert.deepEqual(d.actions, []);
	assert.match(d.blocked[0].why, /claw-4 fails "wired"; a singleton moves through the mover/);
	assert.match(d.blocked[0].why, /next node is claw-6/);
});

test('an unreachable singleton without a fence is never moved off; with a data lease it may be', () => {
	const args = {
		request: service,
		plan: { ranked: [], refused: [] },
		movePlan: plan('claw-6'),
		offers: [offer('claw-4', { reachable: false })],
		slices: [{ node: 'claw-4' }],
	};
	assert.match(run(args).blocked[0].why, /no fence: never moved off/);
	const fenced = run({
		...args,
		request: { ...service, availability: { ...service.availability, fence: 'data-lease' } },
	});
	assert.match(fenced.blocked[0].why, /moves through the mover/);
});

test('a singleton with no slice yet is declared like any tenant', () => {
	const d = run({ request: service, plan: plan('claw-6') });
	assert.deepEqual(
		d.actions.map((a) => [a.op, a.node]),
		[['declare', 'claw-6']]
	);
});

test('not live, every action and block is planned and the door is never called', async () => {
	const decision = {
		actions: [{ op: 'declare', node: 'claw-5', why: 'w' }],
		blocked: [{ node: '*', why: 'b' }],
	};
	const { rows } = await act(agent, decision, {
		live: false,
		door: () => assert.fail('a dry run called the door'),
	});
	assert.deepEqual(
		rows.planned.map((r) => [r.node, r.changed]),
		[
			['claw-5', 'would declare'],
			['*', 'blocked'],
		]
	);
	assert.deepEqual(rows.unconverged, []);
});

test('live: done is converged, accepted-not-guaranteed is deferred, refused is unconverged', async () => {
	const answers = {
		'claw-5': { doc: { ok: true, state: 'guaranteed' }, why: '' },
		'claw-6': { doc: { ok: false, state: 'not-guaranteed', reason: 'agent not running' }, why: '' },
		'claw-3': { doc: { ok: false, state: 'refused', reason: 'fails "wired"' }, why: '' },
		'claw-2': { doc: null, why: 'exit 1, no report' },
	};
	const calls = [];
	const { rows } = await act(
		agent,
		{
			actions: Object.keys(answers).map((node) => ({ op: 'declare', node, why: 'w' })),
			blocked: [
				{ node: '*', why: 'hard' },
				{ node: '*', why: 'soft', soft: true },
			],
		},
		{
			live: true,
			door: async (args) => {
				calls.push(args);
				return answers[args[0]];
			},
		}
	);
	assert.deepEqual(calls[0], [
		'claw-5',
		'--tenant',
		'cardtable',
		'--memory',
		'4096M',
		'--cores',
		'4',
		'--shared',
		'--reason',
		'hosting-converge: w',
	]);
	assert.deepEqual(
		rows.converged.map((r) => r.node),
		['claw-5']
	);
	assert.deepEqual(
		rows.deferred.map((r) => [r.node, r.why]),
		[['claw-6', 'agent not running']]
	);
	assert.deepEqual(
		rows.unconverged.map((r) => [r.node, r.why]),
		[
			['claw-3', 'fails "wired"'],
			['claw-2', 'exit 1, no report'],
			['*', 'hard'],
		]
	);
	assert.deepEqual(
		rows.planned.map((r) => r.why),
		['soft']
	);
});

test('an end goes through the door with the notice, a remove with nothing else', () => {
	assert.deepEqual(doorArgs(agent, { op: 'end', node: 'claw-8', inMin: 15, why: 'w' }), [
		'claw-8',
		'--end',
		'--in',
		'15m',
		'--reason',
		'hosting-converge: w',
	]);
	assert.deepEqual(doorArgs(agent, { op: 'remove', node: 'claw-8' }), ['claw-8', '--remove']);
});
