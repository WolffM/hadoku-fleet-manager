import { test } from 'node:test';
import assert from 'node:assert/strict';

import { benchmarkPlan, benchmarkWeekday, WEEKDAYS } from './bootcamp-schedule.mjs';

const FLEET = [
	'hokon',
	'claw-1',
	'claw-2',
	'claw-3',
	'claw-4',
	'claw-5',
	'claw-6',
	'claw-8',
	'claw-9',
	'claw-10',
];
const MEASURED = {
	$capabilities: { measurements: { 'cargo-bevy': { value: 2000, earned: true } } },
};
// 2026-11-11 is a Wednesday (UTC day 3).
const WED = Date.parse('2026-11-11T12:00:00Z');

void test('every weekday carries one or two of ten nodes, never more and never none', () => {
	const perDay = Array(7).fill(0);
	for (const n of FLEET) perDay[benchmarkWeekday(n, FLEET)]++;
	assert.deepEqual(perDay.toSorted(), [1, 1, 1, 1, 2, 2, 2]);
});

void test("a node's weekday depends on the fleet, not on the order the manifest lists it", () => {
	for (const n of FLEET)
		assert.equal(benchmarkWeekday(n, FLEET), benchmarkWeekday(n, FLEET.toReversed()));
	assert.equal(benchmarkWeekday('claw-7', FLEET), null);
});

void test('a measured node off its weekday defers every idle-only id, with the next date', () => {
	const node = FLEET.find((n) => benchmarkWeekday(n, FLEET) === 4); // Thursday
	const plan = benchmarkPlan({
		node,
		machine: MEASURED,
		fleet: FLEET,
		idleOnly: ['cargo-bevy'],
		nowMs: WED,
	});
	assert.equal(plan.measure, false);
	assert.equal(plan.weekday, 'Thu');
	assert.deepEqual(plan.deferred, [{ id: 'cargo-bevy', nextOn: '2026-11-12' }]);
});

void test('on its own weekday the node is measured, and the next slot is a week out, not today', () => {
	const node = FLEET.find((n) => benchmarkWeekday(n, FLEET) === 3);
	const on = benchmarkPlan({
		node,
		machine: MEASURED,
		fleet: FLEET,
		idleOnly: ['cargo-bevy'],
		nowMs: WED,
	});
	assert.equal(on.measure, true);
	assert.deepEqual(on.deferred, []);
	const after = benchmarkPlan({
		node,
		machine: MEASURED,
		fleet: FLEET,
		idleOnly: ['cargo-bevy'],
		nowMs: WED + 86_400_000,
	});
	assert.deepEqual(after.deferred, [{ id: 'cargo-bevy', nextOn: '2026-11-18' }]);
});

void test('a node with no measurement on record is measured tonight, whatever the day', () => {
	const node = FLEET.find((n) => benchmarkWeekday(n, FLEET) === 4);
	const plan = benchmarkPlan({
		node,
		machine: {},
		fleet: FLEET,
		idleOnly: ['cargo-bevy'],
		nowMs: WED,
	});
	assert.equal(plan.measure, true);
	assert.match(plan.why, /no measurement on record: cargo-bevy/);
});

void test('--measure measures off the weekday', () => {
	const node = FLEET.find((n) => benchmarkWeekday(n, FLEET) === 4);
	const plan = benchmarkPlan({
		node,
		machine: MEASURED,
		fleet: FLEET,
		idleOnly: ['cargo-bevy'],
		nowMs: WED,
		force: true,
	});
	assert.equal(plan.measure, true);
});

void test('WEEKDAYS is indexed like Date#getUTCDay', () => {
	assert.equal(WEEKDAYS[new Date(WED).getUTCDay()], 'Wed');
});
