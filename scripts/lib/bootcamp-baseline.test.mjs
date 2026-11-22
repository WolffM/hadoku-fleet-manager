import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeBootcamp, judgeBootcamp } from './bootcamp-baseline.mjs';
import { learnReading } from './node-baselines.mjs';

const AT = new Date().toISOString();
// cargo-bevy's bar as the registry declares it (atLeast 1200), and an atMost one.
const CAPS = {
	'cargo-bevy': { measure: { unit: ' monomorphisations/s', atLeast: 1200 } },
	'slow-thing': { measure: { unit: ' s', atMost: 7 } },
};
const capability = (id) => CAPS[id];

void test("claw-1's cargo-bevy figure on an empty store is learning, shown with its weak points", () => {
	const j = judgeBootcamp({
		node: 'claw-1',
		measured: {
			'cargo-bevy': { value: 807, earned: false },
			absent: { value: null, earned: false },
		},
		capability,
		quantities: {},
		weakPoints: { 'disk-sync-writes': { reason: 'p99 150 > 80', since: AT, lastSeen: AT } },
	});
	assert.deepEqual(
		j.judged.map((x) => [x.quantity, x.value, x.verdict]),
		[['bootcamp.cargo-bevy', 807, 'learning']]
	);
	assert.deepEqual(j.window.readings[0].spec.worse, 'lower');
	assert.equal(
		describeBootcamp(j),
		'claw-1: weak points: disk-sync-writes; bootcamp.cargo-bevy = 807: learning'
	);
});

void test('a figure that fell outside its own range is drift; an atMost bar is worse when higher', () => {
	const spec = { unit: 'monomorphisations/s', worse: 'lower', rel: 0.2, abs: 0 };
	const quantities = { 'bootcamp.cargo-bevy': learnReading(undefined, 1500, spec, AT, false) };
	const j = judgeBootcamp({
		node: 'claw-6',
		measured: { 'cargo-bevy': { value: 1000, earned: false } },
		capability,
		quantities,
		weakPoints: {},
	});
	assert.equal(j.judged[0].verdict, 'drift');
	assert.equal(j.judged[0].direction, 'worse');
	const k = judgeBootcamp({
		node: 'claw-6',
		measured: { 'slow-thing': { value: 3, earned: true } },
		capability,
		quantities: {},
		weakPoints: {},
	});
	assert.equal(k.window.readings[0].spec.worse, 'higher');
});

void test('nothing measured and no weak points: nothing to say', () => {
	const j = judgeBootcamp({
		node: 'claw-4',
		measured: {},
		capability,
		quantities: {},
		weakPoints: undefined,
	});
	assert.equal(describeBootcamp(j), null);
});
