import assert from 'node:assert/strict';
import { test } from 'node:test';

import { judgeRedundancy } from './hosting-redundancy.mjs';

const NOW = Date.now();
const svc = (availability) => ({ request: { kind: 'service', availability } });
const fenced = (standby) =>
	svc({ singleton: true, fence: 'data-lease', ...(standby ? { standby } : {}) });
const row = (node, tenant, state = 'guaranteed') => ({ node, declared: { tenant }, state });

test('2026-11-03: a service with no standby is an advisory naming its one claw, and says whether it could have one', () => {
	const r = judgeRedundancy(
		{ pygmalion: fenced(0), archivebot: svc({ singleton: true }) },
		{ nodes: { 'claw-4': [{ tenant: 'pygmalion' }, { tenant: 'archivebot' }] } },
		[row('claw-4', 'pygmalion'), row('claw-4', 'archivebot')],
		NOW
	);
	assert.deepEqual(r.findings, []);
	assert.deepEqual(
		r.advisories.map((a) => [a.tenant, a.category]),
		[
			['pygmalion', 'single-claw'],
			['archivebot', 'single-claw'],
		]
	);
	assert.match(r.advisories[0].why, /only on claw-4.*`availability.standby: 1` is all it takes/);
	assert.match(r.advisories[1].why, /needs the data-lease fence first/);
});

test('asked for a standby: one guaranteed on another node passes; missing, unhealthy or same-node is a finding', () => {
	const tenants = { watchparty: fenced(1) };
	const ledger = (standbyNode) => ({
		nodes: {
			'claw-6': [{ tenant: 'watchparty' }],
			...(standbyNode ? { [standbyNode]: [{ tenant: 'watchparty', role: 'standby' }] } : {}),
		},
	});
	const ok = judgeRedundancy(
		tenants,
		ledger('claw-9'),
		[row('claw-6', 'watchparty'), row('claw-9', 'watchparty')],
		NOW
	);
	assert.deepEqual(ok, { advisories: [], findings: [] });

	const none = judgeRedundancy(tenants, ledger(null), [row('claw-6', 'watchparty')], NOW);
	assert.equal(none.findings[0].category, 'standby-missing');
	assert.match(
		none.findings[0].why,
		/asks for 1 standby\(s\) and has 0 .*a failure of claw-6 takes it down/
	);

	const sick = judgeRedundancy(
		tenants,
		ledger('claw-9'),
		[row('claw-6', 'watchparty'), row('claw-9', 'watchparty', 'degraded')],
		NOW
	);
	assert.equal(
		sick.findings.length,
		1,
		'a declared standby the check did not read as guaranteed does not count'
	);
});

test('an ended slice and a non-service tenant are not counted', () => {
	const r = judgeRedundancy(
		{ cardtable: { request: { kind: 'agent' } }, watchparty: fenced(1) },
		{
			nodes: {
				'claw-8': [{ tenant: 'cardtable' }],
				'claw-6': [{ tenant: 'watchparty' }],
				'claw-9': [
					{ tenant: 'watchparty', role: 'standby', until: new Date(NOW - 60_000).toISOString() },
				],
			},
		},
		[row('claw-8', 'cardtable'), row('claw-6', 'watchparty'), row('claw-9', 'watchparty')],
		NOW
	);
	assert.deepEqual(r.advisories, []);
	assert.deepEqual(
		r.findings.map((f) => f.tenant),
		['watchparty']
	);
});

test('a shrinking slice past its end still counts as a copy; a plain end does not', () => {
	const past = new Date(NOW - 60_000).toISOString();
	const judge = (rec) =>
		judgeRedundancy(
			{ pygmalion: fenced(1) },
			{
				nodes: {
					'claw-4': [{ tenant: 'pygmalion' }],
					'claw-9': [{ tenant: 'pygmalion', role: 'standby', ...rec }],
				},
			},
			[row('claw-4', 'pygmalion'), row('claw-9', 'pygmalion')],
			NOW
		).findings.length;
	assert.equal(judge({ until: past, shrinkTo: { memoryMb: 512, cores: 1 } }), 0);
	assert.ok(judge({ until: past }) > 0, 'the ended standby is missing');
});
