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
	kind: 'agent',
	slices: { unit: { memoryMb: 4096, cores: 4 }, min: 1, max: 4 },
	availability: { noticeMin: 15, stateful: false, singleton: false },
	placement: { require: ['wired'], prefer: [] },
};
const service = {
	app: 'watchparty',
	kind: 'service',
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
		offers: [offer('claw-9'), offer('claw-6')],
		slices: [{ node: 'claw-6' }, { node: 'claw-9', until: at(20) }],
		removeDue: ['claw-8'],
		pastEnd: ['claw-8'],
	});
	assert.deepEqual(
		d.actions.map((a) => [a.op, a.node]),
		[['remove', 'claw-8']]
	);
	assert.deepEqual(d.serving, ['claw-6']);
	assert.deepEqual(d.ending, [{ node: 'claw-9', until: at(20) }]);
});

test('demand that comes back keeps its own ending slice rather than declaring a new one', () => {
	// 2026-10-28: 2 -> 1 -> 2 in 14 min; claw-9 was removed 36 s past its end
	// and claw-5 declared to make up the count.
	const order = ['claw-9', 'claw-8'];
	const offers = [offer('claw-8'), offer('claw-9')];
	const ahead = run({
		demand: { slices: 2, releaseOrder: order },
		plan: plan('claw-5'),
		offers,
		slices: [{ node: 'claw-8' }, { node: 'claw-9', until: at(3) }],
	});
	assert.deepEqual(
		ahead.actions.map((a) => [a.op, a.node]),
		[['keep', 'claw-9']]
	);
	assert.deepEqual(ahead.serving, ['claw-8', 'claw-9']);
	assert.deepEqual(ahead.ending, []);

	const passed = run({
		demand: { slices: 2, releaseOrder: order },
		plan: plan('claw-5'),
		offers,
		slices: [{ node: 'claw-8' }],
		removeDue: ['claw-9'],
		pastEnd: ['claw-9'],
	});
	assert.deepEqual(
		passed.actions.map((a) => [a.op, a.node]),
		[['keep', 'claw-9']],
		'past its end with the units still there is kept, not removed and replaced'
	);
	assert.deepEqual(doorArgs(agent, passed.actions[0]), ['claw-9', '--keep']);
});

test('only as many ending slices are kept as demand is short, latest in the release order first', () => {
	const d = run({
		demand: { slices: 2, releaseOrder: ['claw-9', 'claw-8', 'claw-6'] },
		plan: plan('claw-5'),
		offers: ['claw-3', 'claw-6', 'claw-8', 'claw-9'].map((n) => offer(n)),
		slices: [
			{ node: 'claw-3' },
			{ node: 'claw-9', until: at(5) },
			{ node: 'claw-8', until: at(5) },
		],
		removeDue: ['claw-6'],
		pastEnd: ['claw-6'],
	});
	assert.deepEqual(
		d.actions.map((a) => [a.op, a.node]),
		[['keep', 'claw-6']],
		'one short: the slice the tenant would release last is the one kept'
	);
	assert.deepEqual(
		d.ending.map((e) => e.node),
		['claw-9', 'claw-8']
	);
});

test('an ending slice that can no longer serve is not kept; a standby past its end is never kept', () => {
	const d = run({
		demand: { slices: 2, releaseOrder: ['claw-9'] },
		plan: plan('claw-5'),
		offers: [offer('claw-8'), offer('claw-9', { reachable: false })],
		slices: [{ node: 'claw-8' }, { node: 'claw-9', until: at(5) }],
		removeDue: ['claw-6'],
		pastEnd: [],
	});
	assert.deepEqual(
		d.actions.map((a) => [a.op, a.node]),
		[
			['remove', 'claw-6'],
			['declare', 'claw-5'],
		]
	);
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
			['claw-5', 'would declare and install the agent'],
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
		{ ...agent, kind: 'service' },
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

test('a service the app layer already runs is never declared beside itself: its first slice is a move', () => {
	const args = { request: service, plan: plan('claw-6') };
	const running = run({ ...args, appLayer: { node: 'hokon' } });
	assert.deepEqual(running.actions, []);
	assert.match(
		running.blocked[0].why,
		/runs on hokon under the app layer.*a move.*plan's node is claw-6/
	);
	assert.equal(running.blocked[0].node, 'hokon');

	const blind = run({ ...args, appLayer: { unreadable: 'ENOENT child-apps.json' } });
	assert.deepEqual(blind.actions, []);
	assert.match(blind.blocked[0].why, /could not be read \(ENOENT child-apps.json\)/);

	const fresh = run({ ...args, appLayer: { node: null } });
	assert.deepEqual(
		fresh.actions.map((a) => [a.op, a.node]),
		[['declare', 'claw-6']],
		'an app the app layer does not run yet gets its first slice'
	);
});

// availability.standby (docs/service-state.md): hot standbys of a data-lease singleton.
const fenced = {
	...service,
	availability: { ...service.availability, fence: 'data-lease', standby: 1 },
};
const withStandby = (ranked, standbyRanked) => ({
	...plan(...ranked),
	standby: { ranked: standbyRanked.map((node) => ({ node, role: 'standby' })) },
});

test('a standby is met beside a held primary, from the plan’s standby entry, and never counts as serving', () => {
	const d = run({
		request: fenced,
		plan: withStandby([], ['claw-6']),
		offers: [offer('claw-4'), offer('claw-6')],
		slices: [{ node: 'claw-4' }],
	});
	assert.deepEqual(d.serving, ['claw-4']);
	assert.deepEqual(
		d.actions.map((a) => [a.op, a.node, a.role]),
		[['declare', 'claw-6', 'standby']]
	);
	assert.deepEqual(d.standby, { wanted: 1, serving: [], ending: [], unplaceable: [] });
	assert.deepEqual(doorArgs(fenced, d.actions[0]).slice(-4, -2), ['--role', 'standby']);

	const met = run({
		request: fenced,
		plan: withStandby([], ['claw-8']),
		offers: [offer('claw-4'), offer('claw-6')],
		slices: [{ node: 'claw-4' }, { node: 'claw-6', role: 'standby' }],
	});
	assert.deepEqual(met.actions, [], 'a held standby is enough, and is not a second primary');
	assert.deepEqual(met.serving, ['claw-4']);
	assert.deepEqual(met.standby.serving, ['claw-6']);
});

test('no standby without a primary in the layer, so an app-layer service never gets a second instance', () => {
	const d = run({
		request: fenced,
		plan: withStandby(['claw-6'], ['claw-8']),
		offers: [offer('claw-6'), offer('claw-8')],
		appLayer: { node: 'claw-4' },
	});
	assert.ok(!d.actions.some((a) => a.role === 'standby'));
	assert.ok(d.blocked.some((b) => /no primary slice in the hosting layer/.test(b.why) && b.soft));
});

test('an unplaceable standby is replaced, not ended; a standby past the count is ended with notice', () => {
	const lost = run({
		request: fenced,
		plan: withStandby([], ['claw-8']),
		offers: [offer('claw-4'), offer('claw-6', { reachable: false }), offer('claw-8')],
		slices: [{ node: 'claw-4' }, { node: 'claw-6', role: 'standby' }],
	});
	assert.deepEqual(
		lost.actions.map((a) => [a.op, a.node]),
		[['declare', 'claw-8']]
	);
	assert.equal(lost.standby.unplaceable[0].node, 'claw-6');

	const extra = run({
		request: fenced,
		offers: [offer('claw-4'), offer('claw-6'), offer('claw-8')],
		slices: [
			{ node: 'claw-4' },
			{ node: 'claw-6', role: 'standby' },
			{ node: 'claw-8', role: 'standby' },
		],
	});
	assert.deepEqual(
		extra.actions.map((a) => [a.op, a.node, a.inMin]),
		[['end', 'claw-8', 15]]
	);
});

test('a shortfall of standby nodes is a hard block with the plan’s reasons', () => {
	const d = run({
		request: fenced,
		plan: {
			...withStandby([], []),
			refused: [{ node: 'claw-6', reasons: ['yt-dlp does not run'] }],
		},
		offers: [offer('claw-4')],
		slices: [{ node: 'claw-4' }],
	});
	const b = d.blocked.find((x) => /standby wanted/.test(x.why));
	assert.ok(b && !b.soft, JSON.stringify(d.blocked));
	assert.match(b.why, /claw-6: yt-dlp does not run/);
});

test('a request without a standby decides byte-for-byte as before', () => {
	const d = run({ request: service, offers: [offer('claw-4')], slices: [{ node: 'claw-4' }] });
	assert.ok(!('standby' in d));
});

test('an agent slice the fleet declares gets the kept agent through the same door', async () => {
	const calls = [];
	const door = async (args) => {
		calls.push(args);
		return args[1] === '--install'
			? { doc: { ok: true, state: 'installed' }, why: '' }
			: { doc: { ok: false, state: 'not-guaranteed', reason: 'agent not running' }, why: '' };
	};
	const sha = 'a'.repeat(64);
	const { rows } = await act(
		agent,
		{ actions: [{ op: 'declare', node: 'claw-5', why: 'w' }], blocked: [] },
		{ live: true, door, artifact: { ok: true, path: '/state/run', sha256: sha } }
	);
	assert.deepEqual(calls[1], ['claw-5', '--install', '/state/run', '--sha256', sha]);
	assert.deepEqual(
		rows.converged.map((r) => [r.node, r.changed]),
		[['claw-5', 'declared, agent aaaaaaaaaaaa installed']]
	);
	assert.deepEqual(rows.deferred, [], 'not-guaranteed only meant "no agent yet"');
});

test('no kept agent waits (deferred, with the command); an unverifiable or refused one pages', async () => {
	const declared = async (args) =>
		args[1] === '--install'
			? { doc: { ok: false, state: 'refused', reason: 'sha mismatch on node' }, why: '' }
			: { doc: { ok: true, state: 'guaranteed' }, why: '' };
	const one = { actions: [{ op: 'declare', node: 'claw-5', why: 'w' }], blocked: [] };

	const none = await act(agent, one, { live: true, door: declared, artifact: null });
	assert.match(none.rows.deferred[0].why, /no agent artifact kept.*fleet hosting <node> --install/);

	const bad = await act(agent, one, {
		live: true,
		door: declared,
		artifact: { ok: false, why: 'hashes to x' },
	});
	assert.match(bad.rows.unconverged[0].why, /the kept agent artifact: hashes to x/);

	const refused = await act(agent, one, {
		live: true,
		door: declared,
		artifact: { ok: true, path: '/p', sha256: 'b'.repeat(64) },
	});
	assert.match(refused.rows.unconverged[0].why, /installing the agent: sha mismatch on node/);
});

test('a dry run says the agent would be installed, and a service is never installed', async () => {
	const one = { actions: [{ op: 'declare', node: 'claw-5', why: 'w' }], blocked: [] };
	const dry = await act(agent, one, { live: false, door: () => assert.fail() });
	assert.equal(dry.rows.planned[0].changed, 'would declare and install the agent');
	const calls = [];
	await act({ ...agent, kind: 'service' }, one, {
		live: true,
		door: async (args) => {
			calls.push(args);
			return { doc: { ok: true, state: 'guaranteed' }, why: '' };
		},
		artifact: { ok: true, path: '/p', sha256: 'c'.repeat(64) },
	});
	assert.equal(calls.length, 1, 'a service is deployed by its app layer');
});
