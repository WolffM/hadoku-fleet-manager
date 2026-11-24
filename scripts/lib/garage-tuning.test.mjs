import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	GARAGE_DEFAULT_TUNING,
	applyTuning,
	observeTuning,
	parseWorkerVariables,
	planTuning,
	wantedTuning,
} from './garage-tuning.mjs';
import { recordTuning } from './garage-layout-state.mjs';

const declared = {
	zones: {
		'claw-1': { state: 'active', disks: [{ serial: null, root: true }] },
		'claw-9': { state: 'active', disks: [{ serial: 'A' }, { serial: 'B' }] },
		'claw-8': {
			state: 'active',
			disks: [{ serial: null, root: true }],
			tuning: { resyncTranquility: 7, scrubTranquility: 11, at: 'T-first' },
		},
		'claw-4': { state: 'drain', disks: [{ serial: 'C' }] },
	},
};
const check = (subject, status, tuning) => ({
	rule: 'admitted',
	status,
	subject,
	...(tuning ? { tuning } : {}),
});

void test('an admitted zone wants its soak tuning, the quietest over its disks, else the defaults', () => {
	const w = wantedTuning({
		declared,
		checks: [
			check('claw-1 root', 'ok'),
			check('claw-9 A', 'ok', { resyncTranquility: 5, scrubTranquility: 9 }),
			check('claw-9 B', 'ok', { resyncTranquility: 3, scrubTranquility: 19 }),
			check('claw-8 root', 'shadow'),
			check('claw-4 C', 'ok', { resyncTranquility: 99, scrubTranquility: 99 }),
		],
	});
	assert.deepEqual(w.get('claw-1').tuning, GARAGE_DEFAULT_TUNING);
	assert.deepEqual(w.get('claw-9').tuning, { resyncTranquility: 5, scrubTranquility: 19 });
	// Not admitted now: the recorded tuning holds, it is never dropped back to defaults.
	assert.deepEqual(w.get('claw-8'), {
		tuning: { resyncTranquility: 7, scrubTranquility: 11 },
		admitted: false,
		why: 'not admitted now; keeping the tuning recorded T-first',
	});
	assert.equal(w.has('claw-4'), false, 'a draining zone is not tuned');
	// One disk of two not admitted: the zone is not admitted, and nothing is recorded for it.
	const half = wantedTuning({
		declared,
		checks: [
			check('claw-9 A', 'ok', { resyncTranquility: 5, scrubTranquility: 9 }),
			check('claw-9 B', 'shadow'),
		],
	});
	assert.equal(half.has('claw-9'), false);
});

void test('the plan sets only what the node does not run with, and an unread node is a problem', () => {
	const wanted = new Map([
		['claw-1', { tuning: { resyncTranquility: 2, scrubTranquility: 4 }, why: 'w', admitted: true }],
		[
			'claw-9',
			{ tuning: { resyncTranquility: 5, scrubTranquility: 19 }, why: 'w', admitted: true },
		],
		[
			'claw-8',
			{ tuning: { resyncTranquility: 7, scrubTranquility: 11 }, why: 'w', admitted: false },
		],
	]);
	const observed = new Map([
		['claw-1', { vars: { 'resync-tranquility': '2', 'scrub-tranquility': '4' } }],
		['claw-9', { vars: { 'resync-tranquility': '2', 'scrub-tranquility': '19' } }],
		['claw-8', { error: 'ssh: timeout' }],
	]);
	const { ops, problems } = planTuning({ wanted, observed });
	assert.deepEqual(
		ops.map((o) => [o.node, o.variable, o.from, o.to]),
		[['claw-9', 'resync-tranquility', '2', 5]]
	);
	assert.deepEqual(problems, [{ node: 'claw-8', why: 'worker variables unread: ssh: timeout' }]);
});

void test('worker variables are read and set on the node itself, and a refusal throws', async () => {
	const calls = [];
	const adminFor = (node) => ({
		async call(method, endpoint, body) {
			calls.push([node, endpoint, body]);
			if (endpoint.startsWith('Get'))
				return node === 'bad'
					? { success: {}, error: { x: 'no such node' } }
					: { success: { id1: { 'resync-tranquility': '2' } }, error: {} };
			return body.value === '13'
				? { success: {}, error: { id1: 'invalid value' } }
				: { success: { id1: null }, error: {} };
		},
	});
	const seen = await observeTuning(adminFor, ['claw-1', 'bad']);
	assert.deepEqual(seen.get('claw-1'), { vars: { 'resync-tranquility': '2' } });
	assert.match(seen.get('bad').error, /answered for 0 node\(s\): no such node/);
	await applyTuning(adminFor, [
		{ node: 'claw-1', variable: 'resync-tranquility', from: '2', to: 5 },
	]);
	assert.deepEqual(calls.at(-1), [
		'claw-1',
		'SetWorkerVariable?node=self',
		{ variable: 'resync-tranquility', value: '5' },
	]);
	await assert.rejects(
		applyTuning(adminFor, [{ node: 'claw-1', variable: 'scrub-tranquility', from: '4', to: 13 }]),
		/claw-1 scrub-tranquility=13: invalid value/
	);
	assert.throws(() => parseWorkerVariables({ success: { a: {}, b: {} } }), /2 node/);
});

void test('the declaration records what --apply set', () => {
	const d = recordTuning(
		structuredClone(declared),
		'claw-1',
		{ resyncTranquility: 3, scrubTranquility: 9 },
		'T-later'
	);
	assert.deepEqual(d.zones['claw-1'].tuning, {
		resyncTranquility: 3,
		scrubTranquility: 9,
		at: 'T-later',
	});
	assert.equal(d.zones['claw-1'].state, 'active');
	assert.throws(
		() => recordTuning(structuredClone(declared), 'claw-5', GARAGE_DEFAULT_TUNING, 'T-later'),
		/not a declared zone/
	);
});
