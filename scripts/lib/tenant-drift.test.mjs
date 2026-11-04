import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateHostingRequest } from './hosting-request.mjs';
import { changedFields, judgeTenantDrift, repoOfSource } from './tenant-drift.mjs';

const RAW = {
	app: 'demo',
	kind: 'service',
	slices: { unit: { memoryMb: 512, cores: 1 }, max: 1 },
	runtime: { manager: 'pm2', node: '>=22.0.0', tools: ['git'] },
	network: { ingress: 'tunnel', hostname: 'demo.hadoku.me', ports: [9100], egress: [] },
	disk: { stateGb: 1, growthGbPerMonth: 0.1 },
	availability: { noticeMin: 15, stateful: true, singleton: true, fence: 'data-lease' },
	placement: { require: ['label:data-peer'] },
};
const registered = (over = {}) => ({
	request: validateHostingRequest(RAW).request,
	source: 'WolffM/demo:hosting.json',
	...over,
});
const ship = (patch) => JSON.stringify({ ...RAW, ...patch });

test('the shipped request unchanged is `same`', () => {
	assert.ok(validateHostingRequest(RAW).ok, 'the fixture is a valid request');
	assert.deepEqual(judgeTenantDrift(registered(), JSON.stringify(RAW)), { verdict: 'same' });
});

test('a valid change in the app repo is `changed`, naming every field that moved', () => {
	const d = judgeTenantDrift(
		registered(),
		ship({
			availability: { ...RAW.availability, standby: 1 },
			placement: { ...RAW.placement, auto: true },
		})
	);
	assert.equal(d.verdict, 'changed');
	assert.deepEqual(d.fields, ['availability.standby', 'placement.auto']);
	assert.equal(d.request.availability.standby, 1, 'carries the request to register');
});

test('an invalid shipped request is `invalid`, and the last valid copy stands', () => {
	const d = judgeTenantDrift(
		registered(),
		ship({ slices: { unit: { memoryMb: -1, cores: 1 }, max: 1 } })
	);
	assert.equal(d.verdict, 'invalid');
	assert.match(d.why, /fails validation .*the last valid registration stands/);
	assert.equal(judgeTenantDrift(registered(), '{not json').verdict, 'invalid');
	assert.match(judgeTenantDrift(registered(), null).why, /not shipped any more/);
});

test('a registration from a local path has nothing to compare against, and says so', () => {
	assert.equal(repoOfSource('/tmp/hosting.json'), null);
	assert.equal(repoOfSource('WolffM/ArchiveBot:hosting.json'), 'WolffM/ArchiveBot');
	assert.equal(
		judgeTenantDrift(registered({ source: '/tmp/hosting.json' }), null).verdict,
		'unknown'
	);
});

test('changedFields walks objects and compares arrays whole', () => {
	assert.deepEqual(changedFields({ a: { b: 1, c: [1] } }, { a: { b: 1, c: [1, 2] }, d: 1 }), [
		'a.c',
		'd',
	]);
});
