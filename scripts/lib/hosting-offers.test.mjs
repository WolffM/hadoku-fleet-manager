import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	CI_KEEP_JOBS,
	ciJobsAfter,
	offerFor,
	parseOfferProbe,
	runtimeProbe,
} from './hosting-offers.mjs';

const MIB = 1048576;
const probe = (over = '') =>
	[
		'OFFER-BEGIN',
		'memTotalMb=32000',
		'nproc=12',
		'diskFreeGb=150',
		'routeDev=enp3s0',
		'wireless=no',
		over,
		'OFFER-END',
	].join('\n');
const MACHINE = { minFreeMb: 4096, maxConcurrent: 4, slice: { unitMaxMb: 4096 } };

test('the offer is MemTotal less the floor, the CI it keeps, the tenants and any unbounded neighbour', () => {
	const o = offerFor({
		node: 'claw-9',
		machine: MACHINE,
		facts: parseOfferProbe(probe()),
		tenants: [{ tenant: 'cardtable', memoryMb: 4096, cores: 4, mode: 'shared' }],
		pm2Peer: false,
		labels: ['cuda', 'nvenc-h264', 'rust'],
	});
	assert.equal(CI_KEEP_JOBS, 1);
	assert.equal(o.hostable.memoryMb, 32000 - 4096 - 4096 * CI_KEEP_JOBS - 4096);
	assert.equal(o.hostable.cores, 12 - 4 - 1, 'CI keeps a core');
	assert.equal(o.link, 'wired');
	assert.deepEqual(o.unknown, []);
	assert.deepEqual(o.gpu, ['cuda', 'nvenc-h264'], 'GPU labels come from what the node offers');
});

test('labels it could not read are unknown, and offer no GPU', () => {
	const o = offerFor({
		node: 'n',
		machine: MACHINE,
		facts: parseOfferProbe(probe()),
		pm2Peer: false,
	});
	assert.equal(o.labels, null);
	assert.deepEqual(o.gpu, []);
	assert.ok(o.unknown.includes('the labels it offers are unknown'));
});

test('an unbounded pm2 is charged at what it holds, and named; a bounded one at its ceiling', () => {
	const f = parseOfferProbe(
		probe(
			`pm2=pm2-hadoku.service max ${190 * MIB}\npm2=pm2-archivebot.service ${1024 * MIB} ${300 * MIB}`
		)
	);
	const o = offerFor({ node: 'claw-4', machine: MACHINE, facts: f, pm2Peer: true });
	assert.deepEqual(o.pm2.unbounded, ['pm2-hadoku.service']);
	assert.equal(o.pm2.unboundedMb, 190);
	// MUTATION: charge a bounded manager nothing (the rule before 2026-11-02)
	// and bounding claw-4's idle admin pm2 would ADD its ceiling to the offer.
	assert.equal(o.pm2.boundedMb, 1024, 'charged at its ceiling, not the 300 it holds');
	assert.equal(o.hostable.memoryMb, 32000 - 4096 - 4096 - 190 - 1024);
});

test('bounding an idle pm2 charges its ceiling, in the offer and in what CI keeps (claw-6, 2026-11-02)', () => {
	const at = (line) =>
		offerFor({
			node: 'claw-6',
			machine: { ...MACHINE, maxConcurrent: 8 },
			facts: parseOfferProbe(probe(line)),
			pm2Peer: true,
		});
	const before = at(`pm2=pm2-hadoku.service max ${41 * MIB}`);
	const after = at(`pm2=pm2-hadoku.service ${512 * MIB} ${41 * MIB}`);
	assert.deepEqual(after.pm2.unbounded, [], 'not-beside-unbounded no longer reads it');
	assert.equal(after.pm2.boundedMb, 512);
	assert.equal(before.hostable.memoryMb - after.hostable.memoryMb, 512 - 41);
	// 32000 − 4096 − 512 = 27392 → 6 jobs of 4096; a 4 GB slice on top → 5.
	assert.equal(ciJobsAfter(after, 0), 6);
	assert.equal(ciJobsAfter(after, 4096), 5);
	// The ceiling is in the room: 27392 − 3000 = 24392 → 5, where a free pm2 (24904) would say 6.
	assert.equal(ciJobsAfter(after, 3000), 5);
	assert.equal(ciJobsAfter({ ...after, pm2: { ...after.pm2, boundedMb: 0 } }, 3000), 6);
});

test('an unreadable ceiling is not a ceiling: charged at what it holds', () => {
	const [p] = parseOfferProbe(probe(`pm2=pm2-hadoku.service ? ${64 * MIB}`)).pm2;
	assert.equal(p.bounded, false);
	assert.equal(p.currentMb, 64);
});

test('a tenant manager is bounded by its slice and charged once, through its declaration (claw-4, fleet-manager#46)', () => {
	// The probe's real lines, 2026-11-02: each tenant unit reads `max`, its slice holds the ceiling.
	const facts = parseOfferProbe(
		probe(
			[
				'pm2=pm2-archivebot-svc.service max 385826816 /hosting.slice/hosting-archivebot.slice/pm2-archivebot-svc.service 1073741824',
				'pm2=pm2-hadoku.service 536870912 38494208 /system.slice/pm2-hadoku.service max',
				'pm2=pm2-pygmalion-svc.service max 194646016 /hosting.slice/hosting-pygmalion.slice/pm2-pygmalion-svc.service 536870912',
			].join('\n')
		)
	);
	const [archive, admin, pyg] = facts.pm2;
	assert.deepEqual(
		[archive.by, archive.maxMb, archive.tenant, admin.by, admin.maxMb, pyg.tenant],
		['slice', 1024, 'archivebot', 'unit', 512, 'pygmalion']
	);
	const tenants = [
		{ tenant: 'archivebot', memoryMb: 1024, cores: 1, mode: 'shared' },
		{ tenant: 'pygmalion', memoryMb: 512, cores: 1, mode: 'shared' },
	];
	const o = offerFor({
		node: 'claw-4',
		machine: MACHINE,
		facts,
		tenants,
		pm2Peer: true,
		labels: [],
	});
	assert.deepEqual(o.pm2.unbounded, [], 'not-beside-unbounded holds beside a bounded tenant');
	assert.deepEqual(o.pm2.tenantCharged, [
		'pm2-archivebot-svc.service',
		'pm2-pygmalion-svc.service',
	]);
	assert.equal(o.pm2.unboundedMb, 0);
	assert.equal(o.pm2.boundedMb, 512, 'only the admin manager, at its own ceiling');
	assert.equal(
		o.hostable.memoryMb,
		32000 - 4096 - 4096 - 1024 - 512 - 512,
		'each tenant charged once'
	);

	// A tenant manager running where its tenant is NOT declared is still a
	// bounded neighbour: charged at its slice's ceiling, not dropped.
	const stray = offerFor({
		node: 'claw-4',
		machine: MACHINE,
		facts,
		tenants: [tenants[1]],
		pm2Peer: true,
		labels: [],
	});
	assert.deepEqual(stray.pm2.tenantCharged, ['pm2-pygmalion-svc.service']);
	assert.equal(stray.pm2.boundedMb, 1024 + 512);
});

test('a manager whose slice ceiling is unreadable, or outside a tenant slice, is unbounded', () => {
	const facts = parseOfferProbe(
		probe(
			[
				'pm2=pm2-x-svc.service max 1048576 /hosting.slice/hosting-x.slice/pm2-x-svc.service ?',
				'pm2=pm2-hadoku.service max 1048576 /system.slice/pm2-hadoku.service 8589934592',
				'pm2=pm2-old.service max 1048576',
			].join('\n')
		)
	);
	assert.deepEqual(
		facts.pm2.map((p) => p.bounded),
		[false, false, false]
	);
});

test('a measured job size wins over the per-unit cap; neither known is UNKNOWN, not zero', () => {
	const f = parseOfferProbe(probe());
	assert.equal(
		offerFor({ node: 'n', machine: { ...MACHINE, jobP95Mb: 3400 }, facts: f, pm2Peer: false }).ci
			.jobMb,
		3400
	);
	const blind = offerFor({ node: 'n', machine: { minFreeMb: 1024 }, facts: f, pm2Peer: false });
	assert.equal(blind.hostable.memoryMb, null);
	assert.match(blind.unknown[0], /what a CI job costs here is unknown/);
});

test('could not look is said, never an empty offer', () => {
	assert.equal(parseOfferProbe('OFFER-BEGIN\nmemTotalMb=1'), null);
	assert.deepEqual(offerFor({ node: 'n', machine: MACHINE, facts: null }).reachable, false);
	const wifi = parseOfferProbe(probe().replace('wireless=no', 'wireless=yes'));
	assert.equal(wifi.link, 'wifi');
	const noRoute = parseOfferProbe(probe().replace('routeDev=enp3s0', 'routeDev='));
	assert.ok(
		offerFor({ node: 'n', machine: MACHINE, facts: noRoute, pm2Peer: false }).unknown.some((u) =>
			/wired or Wi-Fi/.test(u)
		)
	);
	assert.ok(
		offerFor({ node: 'n', machine: MACHINE, facts: parseOfferProbe(probe()), pm2Peer: null })
			.unknown.length
	);
});

test('what a slice costs CI, in jobs', () => {
	const o = offerFor({
		node: 'claw-9',
		machine: MACHINE,
		facts: parseOfferProbe(probe()),
		pm2Peer: false,
	});
	// 32000 − 4096 = 27904 → 6 jobs of 4096, capped at maxConcurrent 4.
	assert.equal(ciJobsAfter(o, 0), 4);
	// A 16 GB slice leaves 11520 → 2 jobs.
	assert.equal(ciJobsAfter(o, 16384), 2);
	assert.equal(ciJobsAfter({ reachable: false }, 0), null);
});

test('the runtime half: node from its own --version, tools by exit status, an unasked probe is undefined', () => {
	const f = parseOfferProbe(
		probe().replace('OFFER-END', 'node=v24.11.0\ntool=yt-dlp ok\ntool=deno no\nOFFER-END')
	);
	assert.equal(f.node, '24.11.0');
	assert.deepEqual(f.tools, { 'yt-dlp': true, deno: false });
	assert.equal(parseOfferProbe(probe().replace('OFFER-END', 'node=\nOFFER-END')).node, null);
	assert.equal(parseOfferProbe(probe()).node, undefined);
	const script = runtimeProbe(['ffmpeg']);
	assert.match(script, /env -i PATH=\/usr\/local\/bin:\/usr\/bin:\/bin ffmpeg --version/);
	assert.match(script, /\|\| env -i PATH=\S+ ffmpeg -version/);
});
