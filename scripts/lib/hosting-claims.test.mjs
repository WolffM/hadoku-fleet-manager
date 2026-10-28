import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { CLAIMS, claimPm2Units } from './hosting-claims.mjs';
import { RUNTIMES } from './hosting-runtimes.mjs';

const ARCHIVEBOT = {
	app: 'archive-bot',
	runtime: 'pm2',
	service: RUNTIMES.pm2.names('archive-bot').service,
};
const CARDTABLE = {
	app: 'cardtable',
	runtime: 'agent',
	service: RUNTIMES.agent.names('cardtable').service,
};
const APP_LAYER = { unit: 'pm2-hadoku.service', host: true };

const claim = (units, over = {}) =>
	claimPm2Units({
		units,
		tenants: [ARCHIVEBOT, CARDTABLE],
		declaredHere: [],
		appLayer: APP_LAYER,
		...over,
	});

test("a service tenant's manager is claimed only where the tenant is declared", () => {
	const unit = { unit: 'pm2-archive-bot-svc.service', bounded: true };
	assert.equal(claim([unit], { declaredHere: ['archive-bot'] })[0].claim, 'tenant');
	const [r] = claim([unit]);
	assert.equal(r.claim, 'tenant-undeclared');
	assert.equal(r.severity, 'fail');
	assert.equal(r.by, 'archive-bot');
});

test('an agent tenant never claims a pm2 unit', () => {
	assert.equal(claim([{ unit: 'pm2-cardtable-svc.service', bounded: true }])[0].claim, 'unclaimed');
});

test('the app layer claims its admin manager on a declared host, and an empty unbounded one is advisory', () => {
	assert.equal(
		claim([{ unit: 'pm2-hadoku.service', bounded: false, apps: 3 }])[0].claim,
		'app-layer'
	);
	const [idle] = claim([{ unit: 'pm2-hadoku.service', bounded: false, apps: 0 }]);
	assert.equal(idle.claim, 'app-layer-idle');
	assert.equal(idle.severity, 'advisory');
	assert.equal(
		claim([{ unit: 'pm2-hadoku.service', bounded: true, apps: 0 }])[0].claim,
		'app-layer'
	);
});

test('an unmeasured app count is never read as idle', () => {
	for (const apps of [null, undefined]) {
		assert.equal(
			claim([{ unit: 'pm2-hadoku.service', bounded: false, apps }])[0].claim,
			'app-layer'
		);
	}
});

test("the app layer's manager on a node it does not declare fails, and an unreadable host list is not a pass", () => {
	const unit = { unit: 'pm2-hadoku.service', bounded: false, apps: 2 };
	assert.equal(
		claim([unit], { appLayer: { ...APP_LAYER, host: false } })[0].claim,
		'app-layer-undeclared'
	);
	const [r] = claim([unit], { appLayer: { ...APP_LAYER, host: null } });
	assert.equal(r.claim, 'unknown');
	assert.equal(r.severity, 'fail');
});

test('a manager no record names is unclaimed', () => {
	const [r] = claim([{ unit: 'pm2-someone.service', bounded: true }]);
	assert.equal(r.claim, 'unclaimed');
	assert.equal(r.by, null);
});

test('every claim has a severity', () => {
	for (const [k, v] of Object.entries(CLAIMS)) assert.ok(['ok', 'advisory', 'fail'].includes(v), k);
});

test('unreadable tenant records make every manager unknown, never claimed or unclaimed', () => {
	const rows = claim(
		[
			{ unit: 'pm2-hadoku.service', bounded: false, apps: 0 },
			{ unit: 'pm2-someone.service', bounded: true },
		],
		{ unreadable: 'the hosting records are unreadable: bad json' }
	);
	assert.deepEqual(
		rows.map((r) => [r.claim, r.severity]),
		[
			['unknown', 'fail'],
			['unknown', 'fail'],
		]
	);
});
