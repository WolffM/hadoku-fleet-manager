/**
 * The placement record, read (fleet-manager#16): every state, every way the
 * record can be unreadable, and what hadoku_site's deploy reads off it
 * (`placement.nodes[0]`, `epoch`, `target`). Pure: no node, no file.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { validateHostingRequest } from './hosting-request.mjs';
import {
	HOSTING_PLACEMENT_CONTRACT,
	appRecords,
	placementDocument,
	placementOf,
	sliceRow,
} from './hosting-placement-view.mjs';

const NOW = Date.now();
const iso = (ms) => new Date(NOW + ms).toISOString();

const CARDTABLE = validateHostingRequest(
	JSON.parse(readFileSync(new URL('fixtures/hosting-cardtable.json', import.meta.url), 'utf8'))
).request;
/** watchparty's registered shape: a singleton service on port 8079. */
const WATCHPARTY = {
	...CARDTABLE,
	app: 'watchparty',
	kind: 'service',
	slices: { ...CARDTABLE.slices, min: 1, max: 1 },
	availability: { ...CARDTABLE.availability, singleton: true, stateful: true },
	network: { ...CARDTABLE.network, ports: [8079] },
};

const shared = (tenant, over = {}) => ({
	tenant,
	memoryMb: 1536,
	cores: 2,
	port: 8079,
	since: iso(-86_400_000),
	by: 't',
	reason: 'r',
	...over,
});
const noDrains = { nodes: {}, planned: [] };
const recordsOf = (app, nodes, drains = noDrains) => appRecords(app, drains, { nodes }, NOW);

const answered = (state = 'guaranteed', findings = []) => ({
	answered: true,
	observedAt: iso(0),
	row: { state, findings, observed: { agent: 'active', memoryInUseMb: 300 } },
});
const silent = () => ({
	answered: false,
	observedAt: iso(0),
	row: {
		state: 'not-guaranteed',
		findings: [
			{
				class: 'blocking',
				category: 'hosting-unobserved',
				why: 'the node did not finish answering (ssh: timeout)',
			},
		],
		observed: null,
	},
});

function doc(over) {
	return placementDocument({
		app: 'watchparty',
		request: WATCHPARTY,
		records: [],
		appRec: undefined,
		probes: new Map(),
		notices: [],
		demand: null,
		last: null,
		problems: [],
		now: NOW,
		...over,
	});
}

test('placed: one slice serving, nodes[0] is its node, epoch from the counter', () => {
	const records = recordsOf('watchparty', { 'claw-6': [shared('watchparty', { epoch: 4 })] });
	const d = doc({ records, appRec: { epoch: 4 }, probes: new Map([['claw-6', answered()]]) });
	assert.equal(d.contract, HOSTING_PLACEMENT_CONTRACT);
	assert.equal(d.ok, true);
	assert.equal(d.error, undefined);
	assert.deepEqual(d.placement, { state: 'placed', epoch: 4, nodes: ['claw-6'], target: null });
	assert.equal(d.placement.nodes[0], 'claw-6');
	assert.equal(d.slices[0].state, 'guaranteed');
	assert.equal(d.slices[0].reachable, true);
	assert.equal(d.slices[0].why, null);
	assert.equal(d.slices[0].declared.port, 8079);
	assert.equal(d.tenant.singleton, true);
	assert.equal(d.tenant.port, 8079);
});

test('a record from before epochs reads as epoch 0, never as missing', () => {
	const records = recordsOf('watchparty', { 'claw-6': [shared('watchparty')] });
	const d = doc({ records, probes: new Map([['claw-6', answered()]]) });
	assert.deepEqual(d.placement, { state: 'placed', epoch: 0, nodes: ['claw-6'], target: null });
	assert.equal(d.slices[0].epoch, null);
});

test('moving: nodes stays the node it leaves, target the new one, epoch already the new one', () => {
	const records = recordsOf('watchparty', {
		'claw-6': [shared('watchparty', { epoch: 4 })],
		'claw-4': [shared('watchparty', { epoch: 5, since: iso(-60_000) })],
	});
	const appRec = {
		epoch: 5,
		move: { from: 'claw-6', to: 'claw-4', epoch: 5, openedAt: iso(-60_000), by: 't' },
	};
	const probes = new Map([
		['claw-6', answered()],
		['claw-4', answered()],
	]);
	const d = doc({ records, appRec, probes });
	assert.equal(d.ok, true);
	assert.deepEqual(d.placement, { state: 'moving', epoch: 5, nodes: ['claw-6'], target: 'claw-4' });
});

test('committed: the old slice ending leaves nodes = [target], with the move in lastMove', () => {
	const records = recordsOf('watchparty', {
		'claw-6': [shared('watchparty', { epoch: 4, until: iso(15 * 60_000) })],
		'claw-4': [shared('watchparty', { epoch: 5 })],
	});
	const lastMove = {
		from: 'claw-6',
		to: 'claw-4',
		epoch: 5,
		openedAt: iso(-60_000),
		by: 't',
		closedAt: iso(0),
		outcome: 'committed',
	};
	const d = doc({
		records,
		appRec: { epoch: 5, lastMove },
		probes: new Map([
			['claw-6', answered()],
			['claw-4', answered()],
		]),
	});
	assert.deepEqual(d.placement, { state: 'placed', epoch: 5, nodes: ['claw-4'], target: null });
	assert.deepEqual(d.lastMove, lastMove);
	assert.equal(d.slices.find((s) => s.node === 'claw-6').until, iso(15 * 60_000));
});

test('A to B and back to A: the node matches again, the epoch does not', () => {
	const records = recordsOf('watchparty', { 'claw-6': [shared('watchparty', { epoch: 6 })] });
	const d = doc({ records, appRec: { epoch: 6 }, probes: new Map([['claw-6', answered()]]) });
	assert.deepEqual(d.placement.nodes, ['claw-6']);
	assert.equal(d.placement.epoch, 6);
});

test('unplaced is said only about a record that was read and is empty', () => {
	const d = doc({ records: [], appRec: { epoch: 3 } });
	assert.equal(d.ok, true);
	assert.deepEqual(d.placement, { state: 'unplaced', epoch: 3, nodes: [], target: null });
	// The ledger could not be read: no placement at all, and why.
	const blind = doc({
		records: null,
		problems: ['the hosting record (fleet-hosting.json) is unreadable: Unexpected token'],
	});
	assert.equal(blind.ok, false);
	assert.equal(blind.placement, null);
	assert.match(blind.error, /fleet-hosting\.json\) is unreadable/);
	assert.deepEqual(blind.slices, []);
});

test('a slice whose node did not answer is unknown, never guaranteed, and fails the document', () => {
	const records = recordsOf('watchparty', { 'claw-6': [shared('watchparty', { epoch: 1 })] });
	const d = doc({ records, appRec: { epoch: 1 }, probes: new Map([['claw-6', silent()]]) });
	assert.equal(d.ok, false);
	assert.equal(d.slices[0].state, 'unknown');
	assert.equal(d.slices[0].reachable, false);
	assert.equal(d.slices[0].observed, null);
	assert.match(d.slices[0].why, /ssh: timeout/);
	assert.match(d.error, /claw-6 did not answer/);
	// The record itself was read, so the placement is still said.
	assert.deepEqual(d.placement.nodes, ['claw-6']);
	// Not probed at all is the same: never left out, never guaranteed.
	const unprobed = doc({ records, appRec: { epoch: 1 } });
	assert.equal(unprobed.ok, false);
	assert.equal(unprobed.slices[0].state, 'unknown');
	assert.equal(unprobed.slices[0].why, 'the node was not probed');
});

test('a node that answered with a broken slice is a finding, not could-not-look', () => {
	const records = recordsOf('watchparty', { 'claw-6': [shared('watchparty', { epoch: 1 })] });
	const finding = { class: 'blocking', category: 'hosting-agent', why: 'nothing listens on 8079' };
	const d = doc({
		records,
		appRec: { epoch: 1 },
		probes: new Map([['claw-6', answered('not-guaranteed', [finding])]]),
	});
	assert.equal(d.ok, true);
	assert.equal(d.slices[0].state, 'not-guaranteed');
	assert.equal(d.slices[0].why, 'nothing listens on 8079');
});

test('a record that cannot be read as one placement fails, naming why', () => {
	// A singleton held twice with no move open: which one serves is not knowable.
	const twice = recordsOf('watchparty', {
		'claw-6': [shared('watchparty', { epoch: 1 })],
		'claw-4': [shared('watchparty', { epoch: 2 })],
	});
	const both = new Map([
		['claw-6', answered()],
		['claw-4', answered()],
	]);
	const d = doc({ records: twice, appRec: { epoch: 2 }, probes: both });
	assert.equal(d.ok, false);
	assert.equal(d.placement, null);
	assert.match(d.error, /singleton holds claw-6, claw-4 with no move open/);
	// An open move naming a node that holds nothing.
	const one = recordsOf('watchparty', { 'claw-6': [shared('watchparty', { epoch: 1 })] });
	const stale = doc({
		records: one,
		appRec: { epoch: 2, move: { from: 'claw-6', to: 'claw-4', epoch: 2 } },
		probes: new Map([['claw-6', answered()]]),
	});
	assert.equal(stale.ok, false);
	assert.match(stale.error, /names claw-4, which holds no slice/);
	// A move on a tenant that is not a singleton.
	assert.match(
		placementOf({
			singleton: false,
			records: one,
			appRec: { epoch: 1, move: { from: 'a', to: 'b' } },
		}).error,
		/not a singleton/
	);
});

test('a singleton whose only slice is ending still serves there until its end', () => {
	const records = recordsOf('watchparty', {
		'claw-6': [shared('watchparty', { epoch: 2, until: iso(600_000) })],
	});
	const d = doc({ records, appRec: { epoch: 2 }, probes: new Map([['claw-6', answered()]]) });
	assert.deepEqual(d.placement.nodes, ['claw-6']);
});

test('several slices: every serving one, in the release order, ending ones only if nothing else', () => {
	const nodes = {
		'claw-8': [shared('cardtable', { port: 7621, since: iso(-3 * 3_600_000) })],
		'claw-9': [shared('cardtable', { port: 7621, since: iso(-2 * 3_600_000) })],
		'claw-5': [shared('cardtable', { port: 7621, since: iso(-3_600_000), until: iso(600_000) })],
	};
	const { placement } = placementOf({
		singleton: false,
		records: recordsOf('cardtable', nodes),
		appRec: { epoch: 3 },
		releaseOrder: ['claw-9'],
	});
	assert.deepEqual(placement, {
		state: 'placed',
		epoch: 3,
		nodes: ['claw-9', 'claw-8'],
		target: null,
	});
	const onlyEnding = placementOf({
		singleton: false,
		records: recordsOf('cardtable', { 'claw-5': nodes['claw-5'] }),
		appRec: { epoch: 3 },
	});
	assert.deepEqual(onlyEnding.placement.nodes, ['claw-5']);
});

test('a slice past its end reads ended, unprobed, until --remove drops it; ended[] keeps a day', () => {
	const records = recordsOf('cardtable', {
		'claw-5': [shared('cardtable', { port: 7621, until: iso(-60_000) })],
	});
	const row = sliceRow(records[0], undefined);
	assert.equal(row.state, 'ended');
	assert.equal(row.reachable, null);
	const d = placementDocument({
		app: 'cardtable',
		request: CARDTABLE,
		records,
		appRec: {
			epoch: 2,
			ended: [
				{ node: 'claw-9', until: iso(-3_600_000), removedAt: iso(-3_000_000), epoch: 1 },
				{ node: 'claw-3', removedAt: iso(-2 * 86_400_000) },
			],
		},
		probes: new Map(),
		notices: [],
		demand: null,
		last: null,
		problems: [],
		now: NOW,
	});
	assert.equal(d.ok, true, 'an ended slice is not a slice that could not be looked at');
	assert.equal(d.placement.state, 'unplaced');
	assert.deepEqual(d.ended, [
		{
			node: 'claw-9',
			until: iso(-3_600_000),
			removedAt: iso(-3_000_000),
			role: 'primary',
			epoch: 1,
		},
	]);
});

test('a standby is listed as one and never counted where the primary is', () => {
	const records = recordsOf('watchparty', {
		'claw-6': [shared('watchparty', { epoch: 1 })],
		'claw-4': [shared('watchparty', { role: 'standby' })],
	});
	const d = doc({
		records,
		appRec: { epoch: 1 },
		probes: new Map([
			['claw-6', answered()],
			['claw-4', answered()],
		]),
	});
	assert.deepEqual(d.placement.nodes, ['claw-6']);
	assert.equal(d.slices.find((s) => s.node === 'claw-4').role, 'standby');
});

test('whole-box hosting is read from the drain record', () => {
	const drains = {
		nodes: {
			'claw-8': {
				since: iso(-3_600_000),
				reason: 'r',
				by: 't',
				kind: 'hosting',
				hosting: { tenant: 'cardtable', memoryMb: 12288, cores: 6, port: 7621, epoch: 2 },
			},
		},
		planned: [],
	};
	const [rec] = appRecords('cardtable', drains, { nodes: {} }, NOW);
	assert.equal(rec.mode, 'whole');
	assert.equal(rec.epoch, 2);
	assert.deepEqual(rec.declared, { memoryMb: 12288, cores: 6, port: 7621 });
});

test('a slice serving a port its registration does not name is said', () => {
	const records = recordsOf('watchparty', { 'claw-6': [shared('watchparty', { port: 9000 })] });
	const d = doc({ records, probes: new Map([['claw-6', answered()]]) });
	assert.equal(d.slices[0].declared.port, 9000);
	assert.ok(d.slices[0].findings.some((f) => f.category === 'hosting-port-drift'));
	assert.equal(d.slices[0].state, 'guaranteed', 'advisory: the drift gate is the row check');
});

test("notices, demand, the converger's last pass and its offers ride along", () => {
	const records = recordsOf('watchparty', { 'claw-6': [shared('watchparty', { epoch: 1 })] });
	const last = {
		at: iso(-120_000),
		dryRun: false,
		tenants: {
			watchparty: {
				live: true,
				desired: 1,
				serving: ['claw-6'],
				actions: [],
				blocked: [{ node: 'claw-4', why: 'w', soft: true }],
				unplaceable: [],
				results: [],
				offers: { ranked: [{ node: 'claw-4', ciJobs: { before: 2, after: 1 } }], refused: [] },
			},
		},
	};
	const d = doc({
		records,
		appRec: { epoch: 1 },
		probes: new Map([['claw-6', answered()]]),
		notices: [
			{ node: 'claw-6', event: 'starts', at: iso(3_600_000), kind: 'reboot' },
			{ node: 'claw-9', event: 'starts', at: iso(3_600_000), kind: 'reboot' },
		],
		demand: { slices: 1, releaseOrder: [] },
		last,
	});
	assert.deepEqual(d.slices[0].notices, [{ event: 'starts', at: iso(3_600_000), kind: 'reboot' }]);
	assert.deepEqual(d.demand, { slices: 1, releaseOrder: [] });
	assert.equal(d.converger.live, true);
	assert.deepEqual(d.converger.blocked, [{ node: 'claw-4', why: 'w', soft: true }]);
	assert.equal(d.offers.at, last.at);
	assert.equal(d.offers.ranked[0].node, 'claw-4');
	assert.equal(doc({ records: [] }).converger, null);
	assert.equal(doc({ records: [] }).offers, null);
});

test('ci rides on each slice and each ranked offer, null where the node is unmeasured or the slice ended', () => {
	const records = recordsOf('watchparty', {
		'claw-6': [shared('watchparty', { epoch: 1 })],
		'claw-4': [shared('watchparty', { epoch: 0, until: iso(-60_000) })],
	});
	const pressure = { jobs: 1, heavyJobs: 1, max: 2, load1: null, cores: 8, at: iso(-30_000) };
	const last = {
		at: iso(-120_000),
		tenants: {
			watchparty: {
				live: true,
				offers: {
					ranked: [
						{ node: 'claw-9', ciJobs: { before: 1, after: 1 } },
						{ node: 'claw-3', ciJobs: { before: 0, after: 0 } },
					],
					refused: [],
				},
			},
		},
	};
	const d = doc({
		records,
		appRec: { epoch: 1 },
		probes: new Map([['claw-6', answered()]]),
		ci: new Map([
			['claw-6', pressure],
			['claw-4', pressure],
			['claw-9', pressure],
		]),
		last,
	});
	const row = (n) => d.slices.find((s) => s.node === n);
	assert.deepEqual(row('claw-6').ci, pressure);
	assert.equal(row('claw-4').state, 'ended');
	assert.equal(row('claw-4').ci, null, 'an ended slice is not looked at');
	assert.deepEqual(d.offers.ranked[0].ci, pressure);
	assert.equal(d.offers.ranked[1].ci, null, 'unmeasured, never idle');
	// No ci map at all: every slice reads null.
	assert.equal(doc({ records, probes: new Map([['claw-6', answered()]]) }).slices[0].ci, null);
});
