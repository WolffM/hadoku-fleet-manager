import { test } from 'node:test';
import assert from 'node:assert/strict';

import { carryMeasurements, measuredValue, parseLoad } from './idle-measure.mjs';

test('parseLoad: a counted number, `unknown` as null, and a missing line ABSENT — never zero', () => {
	const out = [
		'CAP cargo-bevy ok 2281',
		'LOAD cargo-bevy 0',
		'LOAD other-cap unknown',
		'LOAD third 3',
		'PROBE-END claw-4',
	].join('\n');
	assert.deepEqual(parseLoad(out), { 'cargo-bevy': 0, 'other-cap': null, third: 3 });
	assert.deepEqual(parseLoad('CAP cargo-bevy ok 2281\nPROBE-END x\n'), {});
	assert.ok(!('cargo-bevy' in parseLoad('')), 'no line must not read as an idle zero');
});

test('carryMeasurements: a first idle verdict is recorded with its number and time', () => {
	assert.deepEqual(
		carryMeasurements(undefined, { 'cargo-bevy': { value: 2281, earned: true } }, 'T1'),
		{
			'cargo-bevy': { value: 2281, idle: true, earned: true, at: 'T1' },
		}
	);
});

test('carryMeasurements: the SAME verdict keeps the recorded entry byte-for-byte (#59)', () => {
	const prev = {
		measurements: { 'cargo-bevy': { value: 2281, idle: true, earned: true, at: 'T1' } },
	};
	assert.deepEqual(carryMeasurements(prev, { 'cargo-bevy': { value: 2310, earned: true } }, 'T2'), {
		'cargo-bevy': { value: 2281, idle: true, earned: true, at: 'T1' },
	});
});

test('carryMeasurements: a CHANGED verdict replaces the entry with the deciding measurement', () => {
	const prev = {
		measurements: { 'cargo-bevy': { value: 2281, idle: true, earned: true, at: 'T1' } },
	};
	assert.deepEqual(
		carryMeasurements(prev, { 'cargo-bevy': { value: 1100, earned: false } }, 'T2'),
		{
			'cargo-bevy': { value: 1100, idle: true, earned: false, at: 'T2' },
		}
	);
});

test('carryMeasurements: an entry that was not taken idle is replaced, even at the same verdict', () => {
	const prev = {
		measurements: { 'cargo-bevy': { value: 1300, idle: false, earned: true, at: 'T1' } },
	};
	assert.equal(
		carryMeasurements(prev, { 'cargo-bevy': { value: 2281, earned: true } }, 'T2')['cargo-bevy'].at,
		'T2'
	);
});

test('carryMeasurements: a capability NOT judged this run keeps its entry, or stays absent', () => {
	const prev = {
		measurements: { 'cargo-bevy': { value: 1529, idle: true, earned: true, at: 'T1' } },
	};
	assert.deepEqual(carryMeasurements(prev, {}, 'T2'), prev.measurements);
	assert.deepEqual(carryMeasurements(undefined, {}, 'T2'), {});
});

test('measuredValue: the first number, as meetsBar reads it; null when there is none', () => {
	assert.equal(measuredValue('2281'), 2281);
	assert.equal(measuredValue('compile-failed'), null);
	assert.equal(measuredValue(undefined), null);
});
