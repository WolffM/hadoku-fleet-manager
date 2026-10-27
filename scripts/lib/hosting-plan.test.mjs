import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import { STRICT_AFTER_CUT_OVER, planFor } from './hosting-plan.mjs';
import { validateHostingRequest } from './hosting-request.mjs';

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
	gpu: [],
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
	const many = Array.from({ length: STRICT_AFTER_CUT_OVER }, (_, i) => cut(`c${i}`));
	const strict = planFor(CARDTABLE, [...many, offer('root-claw')]);
	assert.equal(strict.ciMayReadPolicy, 'filter');
	assert.ok(!nodes(strict).includes('root-claw'));
	assert.match(why(strict, 'root-claw'), /not cut over/);
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
