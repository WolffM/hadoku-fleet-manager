/**
 * The hosted tenant's backstop decision: a claw is usable on observed state
 * only, "could not look" is never usable, and hokon steps in only when no
 * claw is usable (being below `slices.min` is the converger's job, not hokon's).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeTenantBackstop, tenantUsableOn, type UsableNodeRow } from '../lib/tenant-usable.js';

const OPEN = { controller: { lan: 'open', tailnet4: 'open', tailnet6: 'filtered' } };

function row(
	node: string,
	over: Partial<UsableNodeRow> = {},
	slice: Record<string, unknown> = {}
): UsableNodeRow {
	return {
		node,
		reachable: true,
		drain: null,
		tenants: [
			{
				state: 'guaranteed',
				until: null,
				declared: { tenant: 'cardtable' },
				observed: { agent: 'listening', portReach: OPEN },
				...slice,
			},
		],
		...over,
	};
}

test('a guaranteed, listening slice with an open port is usable', () => {
	assert.equal(tenantUsableOn(row('claw-8'), 'cardtable')?.verdict, 'usable');
});

test('a node holding no slice of the tenant has no verdict', () => {
	assert.equal(tenantUsableOn(row('claw-8'), 'pygmalion'), null);
});

test('an unreachable node is unknown, never usable', () => {
	const v = tenantUsableOn(row('claw-8', { reachable: false }), 'cardtable');
	assert.equal(v?.verdict, 'unknown');
});

test('a slice that was not observed is unknown', () => {
	assert.equal(
		tenantUsableOn(row('claw-8', {}, { observed: null }), 'cardtable')?.verdict,
		'unknown'
	);
});

test('a port probe with no controller answer is unknown', () => {
	const v = tenantUsableOn(
		row('claw-8', {}, { observed: { agent: 'listening', portReach: { controller: null } } }),
		'cardtable'
	);
	assert.equal(v?.verdict, 'unknown');
});

test('each failed observation makes the claw unusable, with the reason', () => {
	const cases: Array<[Partial<UsableNodeRow>, Record<string, unknown>, RegExp]> = [
		[{ drain: { kind: 'reboot' } }, {}, /reboot drain/],
		[{ drain: { kind: 'maintenance' } }, {}, /maintenance drain/],
		[{}, { until: '2026-01-01T00:00:00Z' }, /being released/],
		[{}, { state: 'pending' }, /pending, not guaranteed/],
		[{}, { observed: { agent: 'stopped', portReach: OPEN } }, /stopped/],
		[
			{},
			{ observed: { agent: 'listening', portReach: { controller: { lan: 'filtered' } } } },
			/no connect/,
		],
	];
	for (const [over, slice, why] of cases) {
		const v = tenantUsableOn(row('claw-8', over, slice), 'cardtable');
		assert.equal(v?.verdict, 'unusable', JSON.stringify({ over, slice }));
		assert.match(v!.why, why);
	}
});

test("a tenant's own lease or hosting drain does not take the node out of service", () => {
	for (const kind of ['lease', 'hosting'])
		assert.equal(
			tenantUsableOn(row('claw-8', { drain: { kind } }), 'cardtable')?.verdict,
			'usable'
		);
});

test('a service slice without a port probe is judged on its process alone, and keeps its role', () => {
	const v = tenantUsableOn(
		row(
			'claw-9',
			{},
			{
				declared: { tenant: 'archivebot', role: 'standby' },
				observed: { agent: 'listening', portReach: null },
			}
		),
		'archivebot'
	);
	assert.deepEqual(v, {
		node: 'claw-9',
		verdict: 'usable',
		why: 'guaranteed, listening',
		role: 'standby',
	});
});

test('hokon is not promoted while one claw is usable, even below slices.min', () => {
	const b = judgeTenantBackstop(
		[
			row('claw-8'),
			row('claw-9', { reachable: false }),
			row('claw-10', { drain: { kind: 'reboot' } }),
		],
		'cardtable'
	);
	assert.equal(b.promote, false);
	assert.deepEqual(b.usable, ['claw-8']);
	assert.deepEqual(b.unknown, ['claw-9']);
});

test('hokon is promoted when no claw is usable, naming the ones it could not look at', () => {
	const b = judgeTenantBackstop(
		[row('claw-9', { reachable: false }), row('claw-10', { drain: { kind: 'reboot' } })],
		'cardtable'
	);
	assert.equal(b.promote, true);
	assert.match(b.why, /none of 2 claws usable; could not look at claw-9/);
});

test('hokon is promoted for a tenant no claw holds a slice of', () => {
	const b = judgeTenantBackstop([row('claw-8')], 'pygmalion');
	assert.equal(b.promote, true);
	assert.equal(b.why, 'no claw holds a slice of it');
});

test('an unreadable slice record decides nothing: promote is null, not true', () => {
	const b = judgeTenantBackstop([], 'cardtable', 'hosting.json: unexpected end');
	assert.equal(b.promote, null);
	assert.match(b.why, /could not look/);
});
