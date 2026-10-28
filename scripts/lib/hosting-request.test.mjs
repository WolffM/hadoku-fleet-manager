import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import {
	ADVISORY_UNTIL_DEFAULT,
	NOTICE_FLOOR_MIN,
	validateHostingRequest,
} from './hosting-request.mjs';

const fixture = (name) =>
	JSON.parse(readFileSync(new URL(`./fixtures/hosting-${name}.json`, import.meta.url), 'utf8'));
const CARDTABLE = fixture('cardtable');
const ARCHIVEBOT = fixture('archivebot');
const paths = (raw) => validateHostingRequest(raw).problems.map((p) => p.path);
const without = (obj, path) => {
	const copy = structuredClone(obj);
	const keys = path.split('.');
	const last = keys.pop();
	delete keys.reduce((o, k) => o[k], copy)[last];
	return copy;
};

test("cardtable's request as it settled it (2026-10-27) is valid, normalized", () => {
	const { ok, request } = validateHostingRequest(CARDTABLE);
	assert.equal(ok, true);
	assert.deepEqual(request.slices, { unit: { memoryMb: 4096, cores: 4 }, min: 1, max: 4 });
	assert.equal(request.runtime.workersOutliveRestart, true);
	// App-side behaviour is carried, not enforced.
	assert.equal(request.runtime.holdOnCoordinatorLoss, true);
	assert.deepEqual(request.network, { ingress: 'controller', ports: [7621], egress: [] });
	assert.equal(request.isolation.ciMayRead, false);
});

test("archivebot's request (#136) is valid as a single-slice pm2 service", () => {
	const { ok, request } = validateHostingRequest(ARCHIVEBOT);
	assert.equal(ok, true);
	assert.equal(request.kind, 'service');
	assert.equal(request.availability.singleton, true);
	assert.equal(request.network.hostname, 'archivebot.hadoku.me');
});

test('a request that leaves out what it needs is refused, never guessed', () => {
	assert.ok(paths(without(CARDTABLE, 'slices.unit.memoryMb')).includes('slices.unit.memoryMb'));
	assert.ok(paths(without(CARDTABLE, 'disk.stateGb')).includes('disk.stateGb'));
	assert.ok(paths({ ...CARDTABLE, kind: 'vm' }).includes('kind'));
	assert.ok(paths({ ...CARDTABLE, app: 'Card Table' }).includes('app'));
	assert.deepEqual(validateHostingRequest('nope').ok, false);
});

test('contradictions are refused, each with its reason', () => {
	const t = structuredClone(CARDTABLE);
	t.slices.min = 5;
	assert.ok(paths(t).includes('slices.max'));
	// A service is one app; a singleton holds one slice.
	assert.ok(
		paths({ ...ARCHIVEBOT, slices: { ...ARCHIVEBOT.slices, max: 2 } }).includes('slices.max')
	);
	// The tunnel is the app layer's; an agent is reached by its controller.
	assert.ok(
		paths({
			...CARDTABLE,
			network: { ...CARDTABLE.network, ingress: 'tunnel', hostname: 'x' },
		}).includes('network.ingress')
	);
	assert.ok(
		paths({ ...ARCHIVEBOT, network: { ...ARCHIVEBOT.network, hostname: undefined } }).includes(
			'network.hostname'
		)
	);
	assert.ok(
		paths({ ...CARDTABLE, network: { ingress: 'controller', ports: [] } }).includes('network.ports')
	);
	assert.ok(
		paths({ ...CARDTABLE, network: { ingress: 'controller', ports: [80] } }).includes(
			'network.ports'
		)
	);
	assert.ok(paths({ ...ARCHIVEBOT, runtime: {} }).includes('runtime.manager'));
	assert.ok(paths({ ...CARDTABLE, runtime: { manager: 'pm2' } }).includes('runtime.manager'));
});

test('notice is never below the fleet floor; an unknown placement rule is refused, not ignored', () => {
	assert.ok(
		paths({ ...CARDTABLE, availability: { noticeMin: NOTICE_FLOOR_MIN - 1 } }).includes(
			'availability.noticeMin'
		)
	);
	assert.equal(
		validateHostingRequest({ ...CARDTABLE, availability: {} }).request.availability.noticeMin,
		NOTICE_FLOOR_MIN
	);
	assert.ok(
		paths({ ...CARDTABLE, placement: { require: ['fast'] } }).includes('placement.require')
	);
	assert.equal(
		validateHostingRequest({
			...CARDTABLE,
			placement: { require: ['gpu:nvenc-h264', 'label:jdk21', 'not-with:archivebot'] },
		}).ok,
		true
	);
	// A label argument that names no capability could never match: refused, with the rule named.
	for (const rule of ['label:jdk-21', 'gpu:nvenc'])
		assert.match(
			validateHostingRequest({ ...CARDTABLE, placement: { require: [rule] } }).problems[0].why,
			new RegExp(`"${rule}"`)
		);
});

test("isolation.advisoryUntil is the tenant's number; cardtable's ruling is the default", () => {
	assert.deepEqual(validateHostingRequest(CARDTABLE).request.isolation, {
		ciMayRead: false,
		advisoryUntil: ADVISORY_UNTIL_DEFAULT,
	});
	assert.equal(ADVISORY_UNTIL_DEFAULT, 3);
	assert.equal(
		validateHostingRequest({ ...ARCHIVEBOT, isolation: { ciMayRead: false, advisoryUntil: 0 } })
			.request.isolation.advisoryUntil,
		0
	);
	assert.ok(
		paths({ ...CARDTABLE, isolation: { ciMayRead: false, advisoryUntil: -1 } }).includes(
			'isolation.advisoryUntil'
		)
	);
	assert.ok(
		paths({ ...CARDTABLE, isolation: { ciMayRead: true, advisoryUntil: 0 } }).includes(
			'isolation.advisoryUntil'
		)
	);
});

test('CI may read a tenant only if the tenant SAYS so', () => {
	assert.equal(
		validateHostingRequest({ ...CARDTABLE, isolation: undefined }).request.isolation.ciMayRead,
		false
	);
});

test('placement.auto and availability.fence: absent normalizes byte-for-byte as before', () => {
	const before = validateHostingRequest(CARDTABLE).request;
	assert.ok(!('auto' in before.placement) && !('fence' in before.availability));
	const auto = validateHostingRequest({
		...CARDTABLE,
		placement: { ...CARDTABLE.placement, auto: true },
	}).request;
	assert.equal(auto.placement.auto, true);
	assert.ok(paths({ ...CARDTABLE, placement: { auto: 'yes' } }).includes('placement.auto'));
});

test('a fence is for a singleton, and only data-lease is one', () => {
	const fenced = validateHostingRequest({
		...ARCHIVEBOT,
		availability: { ...ARCHIVEBOT.availability, fence: 'data-lease' },
	}).request;
	assert.equal(fenced.availability.fence, 'data-lease');
	assert.ok(
		paths({ ...ARCHIVEBOT, availability: { ...ARCHIVEBOT.availability, fence: 'hope' } }).includes(
			'availability.fence'
		)
	);
	assert.ok(
		paths({
			...CARDTABLE,
			availability: { ...CARDTABLE.availability, fence: 'data-lease' },
		}).includes('availability.fence')
	);
});
