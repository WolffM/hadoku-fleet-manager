/**
 * The population half of the egress-slices gate (fleet-manager#106): a
 * declared direct-egress cgroup that holds nothing is a finding, unless its
 * entry records it idle on purpose, and an idle cgroup that fills is a finding
 * again. Pure function, real manifest shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slicePopulationFindings } from './egress-slice-population.mjs';
import { spec } from './egress-slices-fixtures.mjs';

const IDLE = { since: '2026-11-16', why: 'stopped on purpose, kept for a later move' };
const specOf = (...entries) => ({ directEgress: entries });
const statuses = (r) => r.findings.map((f) => `${f.status} ${f.cgroup}`);

void test('an empty declared cgroup with no idle record is still a finding', () => {
	const r = slicePopulationFindings(specOf({ cgroup: '/a.slice' }), new Map([['/a.slice', 0]]));
	assert.deepEqual(statuses(r), ['empty-slice /a.slice']);
	assert.match(r.findings[0].why, /idle: \{ since, why \}/, 'the finding names the way out');
});

void test('an empty cgroup recorded idle is reported, not failed', () => {
	const r = slicePopulationFindings(
		specOf({ cgroup: '/a.slice', idle: IDLE }),
		new Map([['/a.slice', 0]])
	);
	assert.deepEqual(r.findings, []);
	assert.deepEqual(r.idle, [{ cgroup: '/a.slice', ...IDLE }]);
});

void test('the day a process appears in an idle cgroup, it is a finding again', () => {
	const r = slicePopulationFindings(
		specOf({ cgroup: '/a.slice', idle: IDLE }),
		new Map([['/a.slice', 3]])
	);
	assert.deepEqual(statuses(r), ['idle-slice-populated /a.slice']);
	assert.match(r.findings[0].why, /holds 3 process/);
	assert.deepEqual(r.idle, []);
});

void test('idle covers emptiness only: a missing cgroup is still missing', () => {
	const r = slicePopulationFindings(
		specOf({ cgroup: '/a.slice', idle: IDLE }),
		new Map([['/a.slice', null]])
	);
	assert.deepEqual(statuses(r), ['missing-slice /a.slice']);
});

void test('an idle record without a date or a reason is malformed, and excuses nothing', () => {
	for (const idle of [{ why: 'x' }, { since: '2026-11-16' }, { since: 'soon', why: 'x' }, true]) {
		const r = slicePopulationFindings(
			specOf({ cgroup: '/a.slice', idle }),
			new Map([['/a.slice', 0]])
		);
		assert.deepEqual(statuses(r), ['idle-malformed /a.slice'], JSON.stringify(idle));
	}
});

void test('a populated cgroup with no idle record passes', () => {
	const r = slicePopulationFindings(specOf({ cgroup: '/a.slice' }), new Map([['/a.slice', 5]]));
	assert.deepEqual(r, { findings: [], idle: [], onDemand: [] });
});

const ON_DEMAND = { why: 'desktop apps the operator opens and closes' };

void test('an empty cgroup occupied on demand is reported, not failed', () => {
	const r = slicePopulationFindings(
		specOf({ cgroup: '/a.slice', onDemand: ON_DEMAND }),
		new Map([['/a.slice', 0]])
	);
	assert.deepEqual(r.findings, []);
	assert.deepEqual(r.onDemand, [{ cgroup: '/a.slice', ...ON_DEMAND }]);
});

void test('a populated on-demand cgroup passes, and is not reported empty', () => {
	const r = slicePopulationFindings(
		specOf({ cgroup: '/a.slice', onDemand: ON_DEMAND }),
		new Map([['/a.slice', 7]])
	);
	assert.deepEqual(r, { findings: [], idle: [], onDemand: [] });
});

void test('onDemand covers emptiness only: a missing cgroup is still missing', () => {
	const r = slicePopulationFindings(
		specOf({ cgroup: '/a.slice', onDemand: ON_DEMAND }),
		new Map([['/a.slice', null]])
	);
	assert.deepEqual(statuses(r), ['missing-slice /a.slice']);
});

void test('an onDemand record without a reason, or beside idle, is malformed and excuses nothing', () => {
	for (const extra of [
		{ onDemand: {} },
		{ onDemand: { why: ' ' } },
		{ onDemand: true },
		{ onDemand: ON_DEMAND, idle: IDLE },
	]) {
		const r = slicePopulationFindings(
			specOf({ cgroup: '/a.slice', ...extra }),
			new Map([['/a.slice', 0]])
		);
		assert.deepEqual(statuses(r), ['on-demand-malformed /a.slice'], JSON.stringify(extra));
	}
});

void test('the live taxonomy: vpnbypass.slice is the only on-demand entry, and it is well formed', () => {
	const demand = spec.directEgress.filter((d) => d.onDemand !== undefined).map((d) => d.cgroup);
	assert.deepEqual(demand, ['/user.slice/user-1000.slice/user@1000.service/vpnbypass.slice']);
	const empty = new Map(spec.directEgress.map((d) => [d.cgroup, 0]));
	const r = slicePopulationFindings(spec, empty);
	assert.deepEqual(
		r.onDemand.map((i) => i.cgroup),
		demand
	);
	assert.ok(!statuses(r).some((s) => s.includes('vpnbypass')));
});

void test('the live taxonomy: gameservers.slice is the only idle entry, and it is well formed', () => {
	const idle = spec.directEgress.filter((d) => d.idle !== undefined).map((d) => d.cgroup);
	assert.deepEqual(idle, ['/gameservers.slice']);
	const empty = new Map(spec.directEgress.map((d) => [d.cgroup, 0]));
	const r = slicePopulationFindings(spec, empty);
	assert.deepEqual(
		r.idle.map((i) => i.cgroup),
		['/gameservers.slice']
	);
	assert.ok(!statuses(r).some((s) => s.includes('gameservers')));
});
