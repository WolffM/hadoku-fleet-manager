import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
	HOSTING_ELIGIBILITY_CONTRACT,
	STALE_PASS_MS,
	eligibilityDocument,
	eligibilityFor,
	repoOf,
} from './hosting-eligibility.mjs';
import { planFor } from './hosting-plan.mjs';
import { validateHostingRequest } from './hosting-request.mjs';

const raw = (name) =>
	JSON.parse(readFileSync(new URL(`./fixtures/hosting-${name}.json`, import.meta.url), 'utf8'));
const request = (doc) => validateHostingRequest(doc).request;
const CARDTABLE = request(raw('cardtable'));
const ARCHIVEBOT = request(raw('archivebot'));
const AUTO_ARCHIVEBOT = request({
	...raw('archivebot'),
	placement: { require: ['wired', 'pm2-peer'], auto: true },
	runtime: { manager: 'pm2', node: '>=22.12', tools: ['yt-dlp'] },
});

/** An offer shaped like collectOffers'; 16 GB wired claw, 8 cores, nothing on it. */
const offer = (node, over = {}) => ({
	node,
	reachable: true,
	hostable: { memoryMb: 9000, cores: 7, diskFreeGb: 100 },
	measured: { memTotalMb: 16000, nproc: 8 },
	minFreeMb: 2048,
	link: 'wired',
	ci: { jobMb: 4096, keepJobs: 1, maxConcurrent: 3, cutOver: true },
	tenants: [],
	pm2: { present: false, unbounded: [], unboundedMb: 0 },
	pm2Peer: true,
	drain: null,
	labels: [],
	gpu: [],
	runtime: { node: '22.23.2', tools: { 'yt-dlp': true } },
	unknown: [],
	...over,
});
const forPlan = (req, offers) => eligibilityFor(req, offers, planFor(req, offers));

test('a drain, a full node and the slice it already holds do not make a node ineligible', () => {
	const offers = [
		offer('claw-8', {
			tenants: [{ tenant: 'cardtable', memoryMb: 4096, cores: 4 }],
			hostable: { memoryMb: 4000, cores: 3, diskFreeGb: 100 },
		}),
		offer('claw-9', {
			drain: { kind: 'lease', until: new Date(Date.now() + 86_400_000).toISOString() },
		}),
		offer('claw-5', {
			tenants: [{ tenant: 'watchparty', memoryMb: 8000, cores: 4 }],
			hostable: { memoryMb: 900, cores: 3, diskFreeGb: 100 },
		}),
	];
	const plan = planFor(CARDTABLE, offers);
	assert.deepEqual(
		plan.ranked.map((r) => r.node),
		[],
		'this pass would place it nowhere'
	);
	const el = eligibilityFor(CARDTABLE, offers, plan);
	assert.deepEqual(el.eligible, ['claw-8', 'claw-9', 'claw-5']);
	assert.deepEqual(el.ruledOut, []);
	assert.deepEqual(el.unknown, []);
});

test('a fact about the node rules it out: a rule, the runtime, or a unit the empty node cannot fit', () => {
	const el = forPlan(AUTO_ARCHIVEBOT, [
		offer('claw-1', { link: 'wifi' }),
		offer('claw-2', { pm2Peer: false }),
		offer('claw-3', { runtime: { node: '20.1.0', tools: { 'yt-dlp': true } } }),
		offer('claw-4', { runtime: { node: '22.23.2', tools: { 'yt-dlp': false } } }),
		offer('claw-5', { measured: { memTotalMb: 7000, nproc: 8 } }),
		offer('claw-6', { measured: { memTotalMb: 16000, nproc: 1 } }),
		offer('claw-7', { hostable: { memoryMb: 9000, cores: 7, diskFreeGb: 4 } }),
		offer('claw-8'),
	]);
	assert.deepEqual(el.eligible, ['claw-8']);
	const why = Object.fromEntries(el.ruledOut.map((r) => [r.node, r.reasons.join('; ')]));
	assert.match(why['claw-1'], /fails "wired"/);
	assert.match(why['claw-2'], /fails "pm2-peer"/);
	assert.match(why['claw-3'], /node 20\.1\.0 does not satisfy >=22\.12/);
	assert.match(why['claw-4'], /yt-dlp does not run/);
	assert.match(why['claw-5'], /empty, it would offer 856 MiB; the unit needs 1024/);
	assert.match(why['claw-6'], /0 cores; the unit needs 1/);
	assert.match(why['claw-7'], /4 GB free, state needs 10/);
});

test('an unbounded neighbour counts against the empty node, as it does in the offer', () => {
	const el = forPlan(CARDTABLE, [
		offer('claw-8', { pm2: { present: true, unbounded: [], unboundedMb: 6000 } }),
	]);
	assert.match(
		el.ruledOut[0].reasons.join(),
		/empty, it would offer 3856 MiB; the unit needs 4096/
	);
});

test('a node that did not answer, or a rule it could not tell, is unknown, never eligible or ruled out', () => {
	const el = forPlan(CARDTABLE, [
		{ node: 'claw-9', reachable: false, hostable: null, unknown: ['ssh: timeout'] },
		{ node: 'claw-3', reachable: false, hostable: null, unknown: [], expectedDown: true },
		offer('claw-8', { link: null }),
		offer('claw-5', { measured: { memTotalMb: null, nproc: 8 } }),
	]);
	assert.deepEqual(el.eligible, []);
	assert.deepEqual(el.ruledOut, []);
	assert.deepEqual(
		el.unknown.map((u) => [u.node, u.why]),
		[
			['claw-9', 'did not answer (ssh: timeout)'],
			['claw-3', 'expected down'],
			['claw-8', 'cannot tell whether "wired" holds'],
			['claw-5', 'installed memory or CI job cost unknown'],
		]
	);
});

test('a node a rule rules out is ruled out even when another fact is unknown', () => {
	const el = forPlan(CARDTABLE, [
		offer('claw-1', { link: 'wifi', measured: { memTotalMb: null, nproc: 8 } }),
	]);
	assert.deepEqual(el.unknown, []);
	assert.equal(el.ruledOut[0].node, 'claw-1');
});

test('the ciMayRead filter, once the plan applies it, rules out a claw not cut over', () => {
	const offers = [
		offer('claw-1'),
		offer('claw-2'),
		offer('claw-3'),
		offer('claw-4', { ci: { jobMb: 4096, keepJobs: 1, maxConcurrent: 3, cutOver: false } }),
	];
	const plan = planFor(CARDTABLE, offers);
	assert.equal(plan.ciMayReadPolicy, 'filter');
	const el = eligibilityFor(CARDTABLE, offers, plan);
	assert.deepEqual(el.eligible, ['claw-1', 'claw-2', 'claw-3']);
	assert.match(el.ruledOut[0].reasons[0], /not cut over/);
	// Advisory (too few cut over): the claw is still a candidate, as the plan still offers it.
	const few = offers.slice(2);
	assert.deepEqual(eligibilityFor(CARDTABLE, few, planFor(CARDTABLE, few)).eligible, [
		'claw-3',
		'claw-4',
	]);
});

test('repoOf reads the registered source, and says null for a local file', () => {
	assert.equal(
		repoOf({ source: 'WolffM/hadoku-cardtable:hosting.json' }),
		'WolffM/hadoku-cardtable'
	);
	assert.equal(repoOf({ source: 'WolffM/ArchiveBot:hosting.json' }), 'WolffM/ArchiveBot');
	assert.equal(repoOf({ source: './hosting.json' }), null);
	assert.equal(repoOf({ source: 'fixture' }), null);
	assert.equal(repoOf({}), null);
});

// ---------------------------------------------------------------- the document

const NOW = Date.now();
const iso = (agoMs) => new Date(NOW - agoMs).toISOString();
const AT = iso(3 * 60_000);
const MANIFEST = {
	machines: {
		hokon: { role: 'backstop' },
		'claw-4': {},
		'claw-6': {},
		'claw-8': {},
		'claw-9': {},
	},
};
const entry = (req, repo) => ({ request: req, source: `${repo}:hosting.json` });
const AUTO_CARDTABLE = request({
	...raw('cardtable'),
	placement: { require: ['wired'], auto: true },
});
const REGISTRY = {
	tenants: {
		cardtable: entry(AUTO_CARDTABLE, 'WolffM/hadoku-cardtable'),
		archivebot: entry(ARCHIVEBOT, 'WolffM/ArchiveBot'),
	},
};
const DRAINS = {
	nodes: {
		'claw-8': {
			kind: 'hosting',
			since: iso(2 * 86_400_000),
			hosting: { tenant: 'cardtable', memoryMb: 4096, cores: 4, port: 7621 },
		},
	},
};
const HOSTING = {
	nodes: {
		'claw-4': [
			{ tenant: 'archivebot', memoryMb: 1024, cores: 1, port: 3004, since: iso(3 * 86_400_000) },
		],
		// Past its end: not placed.
		'claw-6': [
			{ tenant: 'cardtable', memoryMb: 4096, cores: 4, port: 7621, until: iso(12 * 3_600_000) },
		],
	},
	apps: {},
};
const LAST = {
	at: AT,
	tenants: {
		cardtable: {
			eligibility: {
				eligible: ['claw-8', 'claw-9'],
				ruledOut: [{ node: 'claw-4', reasons: ['fails "not-beside-unbounded"'] }],
				unknown: [{ node: 'claw-6', why: 'did not answer (ssh: timeout)' }],
			},
		},
		archivebot: {
			eligibility: { eligible: ['claw-4', 'claw-6'], ruledOut: [], unknown: [] },
		},
	},
};
const doc = (over = {}) =>
	eligibilityDocument({
		registry: REGISTRY,
		manifest: MANIFEST,
		drainDoc: DRAINS,
		hostingDoc: HOSTING,
		last: LAST,
		problems: [],
		now: NOW,
		...over,
	});

test('per node: placed from the ledger, eligible widened by candidates only for an auto tenant', () => {
	const d = doc();
	assert.equal(d.ok, true);
	assert.equal(d.contract, HOSTING_ELIGIBILITY_CONTRACT);
	assert.equal(d.at, AT);
	assert.deepEqual(d.nodes, {
		'claw-4': { placed: ['WolffM/ArchiveBot'], eligible: ['WolffM/ArchiveBot'], unknown: [] },
		'claw-6': {
			placed: [],
			// archivebot is a candidate here, but hand-placed: not eligible until it is placed.
			eligible: [],
			unknown: [
				{ repo: 'WolffM/hadoku-cardtable', app: 'cardtable', why: 'did not answer (ssh: timeout)' },
			],
		},
		'claw-8': {
			placed: ['WolffM/hadoku-cardtable'],
			eligible: ['WolffM/hadoku-cardtable'],
			unknown: [],
		},
		'claw-9': { placed: [], eligible: ['WolffM/hadoku-cardtable'], unknown: [] },
	});
	assert.deepEqual(
		d.notLent.map((n) => n.node),
		['hokon'],
		'the backstop is listed, never a candidate'
	);
	const archivebot = d.tenants.find((t) => t.app === 'archivebot');
	assert.equal(archivebot.auto, false);
	assert.deepEqual(archivebot.candidates, ['claw-4', 'claw-6']);
	assert.deepEqual(archivebot.eligible, ['claw-4']);
	const cardtable = d.tenants.find((t) => t.app === 'cardtable');
	assert.deepEqual(cardtable.placed, [
		{ node: 'claw-8', role: 'primary', mode: 'whole', until: null },
	]);
	assert.deepEqual(cardtable.ruledOut, LAST.tenants.cardtable.eligibility.ruledOut);
});

test("a standby and an open move's target are placed: both must hold the credential before they serve", () => {
	const hostingDoc = {
		...HOSTING,
		nodes: {
			...HOSTING.nodes,
			'claw-9': [
				{ tenant: 'archivebot', role: 'standby', memoryMb: 1024, cores: 1, port: 3004, since: AT },
			],
		},
	};
	const d = doc({ hostingDoc });
	assert.deepEqual(d.nodes['claw-9'].placed, ['WolffM/ArchiveBot']);
	assert.deepEqual(d.nodes['claw-9'].eligible, ['WolffM/ArchiveBot', 'WolffM/hadoku-cardtable']);
	assert.equal(d.tenants.find((t) => t.app === 'archivebot').placed[1].role, 'standby');
});

test('an unknown node already placed is not listed as unknown: it is eligible from the ledger', () => {
	const last = structuredClone(LAST);
	last.tenants.cardtable.eligibility.unknown = [{ node: 'claw-8', why: 'did not answer' }];
	assert.deepEqual(doc({ last }).nodes['claw-8'].unknown, []);
});

test('could not look: any unreadable source is ok:false with why, and no nodes map at all', () => {
	for (const [over, re] of [
		[
			{ registry: null, problems: ['the tenant registry (hosting-tenants.json) is unreadable: x'] },
			/registry/,
		],
		[{ manifest: null, problems: ['the fleet manifest is unreadable: x'] }, /manifest/],
		[{ drainDoc: null, problems: ['the drain record is unreadable: x'] }, /drain/],
		[{ hostingDoc: null, problems: ['the hosting record is unreadable: x'] }, /hosting record/],
		[{ last: null, problems: ['the converger has kept no pass'] }, /kept no pass/],
		[{ last: null }, /kept no pass/],
	]) {
		const d = doc(over);
		assert.equal(d.ok, false);
		assert.equal(d.nodes, null, 'never an empty map');
		assert.match(d.error, re);
	}
});

test('a stale, undated or pre-eligibility converger pass, or a tenant it missed, fails the document', () => {
	const stale = doc({ last: { ...LAST, at: new Date(NOW - STALE_PASS_MS - 1000).toISOString() } });
	assert.equal(stale.ok, false);
	assert.match(stale.error, /more than 30 minutes ago/);
	assert.equal(stale.nodes, null);
	assert.ok(stale.tenants, 'the tenant rows are kept, to diagnose');

	assert.match(doc({ last: { ...LAST, at: 'yesterday' } }).error, /no readable `at`/);

	const old = structuredClone(LAST);
	delete old.tenants.archivebot.eligibility;
	assert.match(doc({ last: old }).error, /no eligibility for archivebot: it predates eligibility/);

	const missed = structuredClone(LAST);
	delete missed.tenants.archivebot;
	assert.match(doc({ last: missed }).error, /did not cover archivebot/);
});

test('a tenant whose repo is unrecorded, or a slice of an unregistered tenant, fails the document', () => {
	const registry = structuredClone(REGISTRY);
	registry.tenants.archivebot.source = './hosting.json';
	const d = doc({ registry });
	assert.equal(d.ok, false);
	assert.match(d.error, /archivebot was registered from \.\/hosting\.json, so its repo is unknown/);

	const hostingDoc = {
		...HOSTING,
		nodes: { ...HOSTING.nodes, 'claw-9': [{ tenant: 'pygmalion', memoryMb: 1, cores: 1 }] },
	};
	assert.match(
		doc({ hostingDoc }).error,
		/claw-9 holds a slice of pygmalion, which is not a registered tenant/
	);
});

test('no tenant registered is no evidence, and fails', () => {
	const d = doc({ registry: { tenants: {} } });
	assert.equal(d.ok, false);
	assert.match(d.error, /no tenant is registered/);
});

test('a node eligible for nothing is listed with empty lists: it was looked at', () => {
	const d = doc();
	assert.deepEqual(d.nodes['claw-6'].eligible, []);
	assert.ok('claw-6' in d.nodes);
});
