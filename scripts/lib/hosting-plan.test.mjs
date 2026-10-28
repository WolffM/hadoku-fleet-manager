import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import { planFor } from './hosting-plan.mjs';
import { ADVISORY_UNTIL_DEFAULT, validateHostingRequest } from './hosting-request.mjs';

const request = (name) =>
	validateHostingRequest(
		JSON.parse(readFileSync(new URL(`./fixtures/hosting-${name}.json`, import.meta.url), 'utf8'))
	).request;
const CARDTABLE = request('cardtable');
const ARCHIVEBOT = request('archivebot');

/** An offer shaped like collectOffers'; 16 GB wired claw, 8 cores, nothing on it. */
const offer = (node, over = {}) => ({
	node,
	reachable: true,
	hostable: { memoryMb: 9000, cores: 7, diskFreeGb: 100 },
	measured: { memTotalMb: 16000, nproc: 8 },
	minFreeMb: 2048,
	link: 'wired',
	ci: { jobMb: 4096, keepJobs: 1, maxConcurrent: 3, cutOver: false },
	tenants: [],
	pm2: { present: false, unbounded: [], unboundedMb: 0 },
	pm2Peer: false,
	drain: null,
	labels: [],
	gpu: [],
	runtime: { node: '22.23.2', tools: {} },
	unknown: [],
	...over,
});
const nodes = (plan) => plan.ranked.map((r) => r.node);
const why = (plan, node) => plan.refused.find((r) => r.node === node)?.reasons.join('; ') ?? '';

test("cardtable's next slice: wired, bounded neighbours, one per node, ranked by CI cost", () => {
	const plan = planFor(CARDTABLE, [
		offer('claw-9', { tenants: [{ tenant: 'cardtable', memoryMb: 4096, cores: 4 }] }),
		offer('claw-8'),
		offer('claw-5', {
			hostable: { memoryMb: 20000, cores: 7, diskFreeGb: 100 },
			measured: { memTotalMb: 32000, nproc: 8 },
		}),
		offer('claw-1', { link: 'wifi' }),
		offer('claw-4', {
			pm2: { present: true, unbounded: ['pm2-hadoku.service'], unboundedMb: 190 },
		}),
		offer('claw-3', { hostable: { memoryMb: 9000, cores: 3, diskFreeGb: 100 } }),
		offer('claw-6', { drain: { kind: 'maintenance', until: null } }),
	]);
	assert.deepEqual(plan.held, ['claw-9']);
	// claw-5 has room for more CI after the slice, so it loses fewer jobs.
	assert.deepEqual(nodes(plan), ['claw-5', 'claw-8']);
	assert.match(why(plan, 'claw-9'), /already holds a cardtable slice/);
	assert.match(why(plan, 'claw-1'), /fails "wired"/);
	assert.match(why(plan, 'claw-4'), /fails "not-beside-unbounded"/);
	assert.match(why(plan, 'claw-3'), /offers 3 cores, the unit needs 4/);
	assert.match(why(plan, 'claw-6'), /drained \(maintenance\)/);
});

test('claw-4 rejoins once its pm2 is bounded (cardtable ruling 4)', () => {
	const bounded = offer('claw-4', { pm2: { present: true, unbounded: [], unboundedMb: 0 } });
	assert.deepEqual(nodes(planFor(CARDTABLE, [bounded])), ['claw-4']);
});

test('ciMayRead:false is advisory until enough candidates are cut over, then a filter', () => {
	const advisory = planFor(CARDTABLE, [
		offer('a'),
		offer('b', { ci: { ...offer('b').ci, cutOver: true } }),
	]);
	assert.equal(advisory.ciMayReadPolicy, 'advisory');
	assert.deepEqual(nodes(advisory), ['b', 'a'], 'a cut-over claw ranks first');
	assert.match(advisory.ranked[1].risk, /still runs with sudo/);

	const cut = (n) => offer(n, { ci: { ...offer(n).ci, cutOver: true } });
	const many = Array.from({ length: ADVISORY_UNTIL_DEFAULT }, (_, i) => cut(`c${i}`));
	const strict = planFor(CARDTABLE, [...many, offer('root-claw')]);
	assert.equal(strict.ciMayReadPolicy, 'filter');
	assert.ok(!nodes(strict).includes('root-claw'));
	assert.match(why(strict, 'root-claw'), /not cut over/);
});

test("the strictness is the tenant's: advisoryUntil 0 filters with no claw cut over", () => {
	const strictBot = { ...ARCHIVEBOT, isolation: { ciMayRead: false, advisoryUntil: 0 } };
	const peers = [offer('claw-4', { pm2Peer: true }), offer('claw-6', { pm2Peer: true })];
	const plan = planFor(strictBot, peers);
	assert.equal(plan.ciMayReadPolicy, 'filter');
	assert.deepEqual(nodes(plan), []);
	assert.match(why(plan, 'claw-4'), /not cut over/);
	// cardtable, against the same claws, keeps its own ruling.
	assert.equal(planFor(CARDTABLE, peers).ciMayReadPolicy, 'advisory');
});

test('a request stored without advisoryUntil means the default, never no bar', () => {
	const stored = { ...CARDTABLE, isolation: { ciMayRead: false } };
	const cut = (n) => offer(n, { ci: { ...offer(n).ci, cutOver: true } });
	const many = Array.from({ length: ADVISORY_UNTIL_DEFAULT }, (_, i) => cut(`c${i}`));
	assert.equal(planFor(stored, [...many, offer('root-claw')]).ciMayReadPolicy, 'filter');
});

test('label:<id> reads the labels the node offers now; unreadable labels refuse, never pass', () => {
	const forge = { ...CARDTABLE, placement: { require: ['label:jdk21'] } };
	const plan = planFor(forge, [
		offer('claw-8', { labels: ['jdk21', 'rust'] }),
		offer('claw-1', { labels: ['rust'] }),
		offer('claw-2', { labels: null }),
	]);
	assert.deepEqual(nodes(plan), ['claw-8']);
	assert.match(why(plan, 'claw-1'), /fails "label:jdk21"/);
	assert.match(why(plan, 'claw-2'), /cannot tell whether "label:jdk21" holds/);
});

test('a tenant at its max is offered nothing', () => {
	const held = (n) => offer(n, { tenants: [{ tenant: 'archivebot', memoryMb: 1024, cores: 1 }] });
	const plan = planFor(ARCHIVEBOT, [held('claw-4'), offer('claw-8', { pm2Peer: true })]);
	assert.equal(plan.atMax, true);
	assert.deepEqual(plan.ranked, []);
});

test('archivebot needs a pm2 peer; could-not-tell and could-not-look refuse, with the reason', () => {
	const plan = planFor(ARCHIVEBOT, [
		offer('claw-4', { pm2Peer: true }),
		offer('claw-8'),
		offer('claw-5', { pm2Peer: null }),
		offer('claw-2', { reachable: false, unknown: ['ssh: timeout'] }),
		offer('claw-9', {
			hostable: { memoryMb: null, cores: 7, diskFreeGb: 100 },
			pm2Peer: true,
			unknown: ['MemTotal unreadable'],
		}),
	]);
	assert.deepEqual(nodes(plan), ['claw-4']);
	assert.match(why(plan, 'claw-8'), /fails "pm2-peer"/);
	assert.match(why(plan, 'claw-5'), /cannot tell whether "pm2-peer" holds/);
	assert.match(why(plan, 'claw-2'), /did not answer \(ssh: timeout\)/);
	assert.match(why(plan, 'claw-9'), /hostable memory unknown: MemTotal unreadable/);
});

test('runtime: node in its range and every tool executed on the service PATH, or refused saying which', () => {
	const req = {
		...ARCHIVEBOT,
		runtime: { ...ARCHIVEBOT.runtime, node: '>=24.0.0 <25.0.0', tools: ['yt-dlp', 'deno'] },
	};
	const peer = { pm2Peer: true, ci: { jobMb: 4096, keepJobs: 1, maxConcurrent: 3, cutOver: true } };
	const plan = planFor(req, [
		offer('fits', { ...peer, runtime: { node: '24.11.0', tools: { 'yt-dlp': true, deno: true } } }),
		offer('old', { ...peer, runtime: { node: '22.23.2', tools: { 'yt-dlp': true, deno: true } } }),
		offer('none', { ...peer, runtime: { node: null, tools: { 'yt-dlp': true, deno: false } } }),
		offer('unasked', { ...peer, runtime: { node: undefined, tools: {} } }),
	]);
	assert.deepEqual(nodes(plan), ['fits']);
	assert.match(why(plan, 'old'), /node 22\.23\.2 does not satisfy >=24\.0\.0 <25\.0\.0/);
	assert.match(
		why(plan, 'none'),
		/no node on the service PATH; deno does not run on the service PATH/
	);
	assert.match(why(plan, 'unasked'), /node version unknown; whether yt-dlp runs is unknown/);
});

/** ArchiveBot requires a pm2 peer. */
const peer = (node, over = {}) => offer(node, { pm2Peer: true, ...over });
const FENCED = (standby) => ({
	...ARCHIVEBOT,
	isolation: { ciMayRead: true },
	availability: { ...ARCHIVEBOT.availability, fence: 'data-lease', standby },
});
const slice = (role) => ({
	tenant: 'archivebot',
	memoryMb: 1024,
	cores: 1,
	...(role ? { role } : {}),
});

test('a standby is its own entry: never in held, never at max, never the primary node', () => {
	const plan = planFor(FENCED(1), [
		peer('claw-4', { tenants: [slice()] }),
		peer('claw-6', { tenants: [slice('standby')] }),
		peer('claw-8'),
	]);
	assert.deepEqual(plan.held, ['claw-4'], 'the standby is not a primary');
	assert.equal(plan.atMax, true);
	assert.deepEqual(plan.standby, { wanted: 1, held: ['claw-6'], ranked: [] });
	assert.match(why(plan, 'claw-6'), /already holds a archivebot slice/);

	const fresh = planFor(FENCED(1), [peer('claw-4', { tenants: [slice()] }), peer('claw-8')]);
	assert.deepEqual(
		fresh.standby.ranked.map((r) => [r.node, r.role]),
		[['claw-8', 'standby']]
	);
	// Nothing held yet: the first pick is the primary's, so the standby starts after it.
	const none = planFor(FENCED(1), [peer('claw-5'), peer('claw-8')]);
	assert.deepEqual(nodes(none), ['claw-5', 'claw-8']);
	assert.deepEqual(
		none.standby.ranked.map((r) => r.node),
		['claw-8']
	);
});

test('a standby passes the same rules as the primary, runtime included, and a shortfall says so', () => {
	const req = { ...FENCED(2), runtime: { ...ARCHIVEBOT.runtime, tools: ['ffmpeg'] } };
	const plan = planFor(req, [
		peer('claw-4', { tenants: [slice()], runtime: { node: '22.23.2', tools: { ffmpeg: true } } }),
		peer('claw-6', { runtime: { node: '22.23.2', tools: { ffmpeg: false } } }),
		peer('claw-8', { runtime: { node: '22.23.2', tools: { ffmpeg: true } } }),
	]);
	assert.deepEqual(
		plan.standby.ranked.map((r) => r.node),
		['claw-8']
	);
	assert.match(why(plan, 'claw-6'), /ffmpeg does not run/);
	assert.match(plan.standby.short, /2 standby wanted, 0 held, and only 1 other node\(s\) fit/);
});

test('a request without a standby plans byte-for-byte as before', () => {
	const plan = planFor(ARCHIVEBOT, [peer('claw-4')]);
	assert.ok(!('standby' in plan));
});
