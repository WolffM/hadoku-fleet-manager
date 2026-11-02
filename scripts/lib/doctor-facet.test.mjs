import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDoctor } from './doctor-parse.mjs';
import { healthFacet, healthRecord, bootcampPointer } from './doctor-facet.mjs';
import { ADVISORY, doctorFindings } from './doctor-findings.mjs';
import {
	CLAW1,
	CLAW5,
	HOKON,
	facetOf,
	NOW,
	find,
	workProbe,
	FAILED_CLAW3,
	FAILED_CLAW1,
	FAILED_CLAW4,
	failedFacet,
	PM2_HOKON,
	PM2_CLAW4,
	PM2_CLAW6,
	PM2_CLAW5,
	pm2Facet,
} from './doctor-fixtures.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// THE FACET
// ═══════════════════════════════════════════════════════════════════════════

void test('$health is a flat {at, by, ...} sibling, like $benchmark and $capabilities', () => {
	const h = facetOf(CLAW1);
	assert.equal(h.at, '2026-09-10T17:07:52.000Z');
	assert.equal(h.by, 'fleet doctor');
	assert.equal(h.node, 'claw-1');
	// Nothing nested under a `$supply` parent — supply-ledger-2026-09-07.md
	// records why the flat shape is the one production already has.
	assert.ok(!('$supply' in h));
	for (const k of ['thermal', 'smart', 'disk', 'network', 'reboot', 'watchdog', 'runners']) {
		assert.ok(k in h, `the facet must carry ${k}`);
	}
});

void test('every field the inventory page needs is in the RECORD, not in a live probe', () => {
	// §H's third done-when. A page cannot ssh to nine boxes to draw a row, so a
	// round trip through JSON must lose nothing the row needs.
	const h = JSON.parse(JSON.stringify(facetOf(CLAW1)));
	assert.equal(h.thermal.sensor, 'hwmon.3.coretemp.Package_id_0');
	assert.equal(h.thermal.idleC, 61);
	assert.equal(h.thermal.loadC, 97);
	assert.equal(h.thermal.riseC, 36);
	assert.equal(h.thermal.loadSeconds, 60);
	assert.equal(h.smart.powerOnHours, 19_727);
	assert.equal(h.smart.health, 'PASSED');
	assert.equal(h.disk.freePct, 89.5);
	assert.equal(h.disk.device, 'sda');
	assert.equal(h.network.wifiManager, 'networkmanager');
	assert.equal(h.network.ssid, 'ExampleNet_5G');
	assert.equal(h.network.operstate, 'up');
	assert.equal(h.reboot.required, false);
	assert.equal(h.kernel, '6.12.73+deb13-amd64');
	assert.equal(h.product, 'GE70 2PE');
});

void test('the wifi manager is the REAL manager per node, never an assumption', () => {
	// The fleet is mixed: claw-1 and claw-7 on NetworkManager, claw-2/claw-3
	// still on ifupdown, claw-4/5/6 with no radio at all, claw-7 SPLIT. Assuming
	// one manager fleet-wide would be wrong on six nodes out of eight.
	assert.equal(facetOf(CLAW1).network.wifiManager, 'networkmanager');
	assert.equal(facetOf(CLAW5).network.wifiManager, 'none', 'no radio is a fact, not a fault');
	assert.equal(facetOf(HOKON).network.wifiManager, 'networkmanager');
});

void test('the bootcamp verdict is labelled a POINTER at $capabilities, not evidence', () => {
	const h = facetOf(CLAW1, {
		capabilities: {
			at: '2026-09-08T05:27:28.098Z',
			by: 'fleet bootcamp',
			earned: ['gh', 'ffmpeg'],
			unearned: [],
			blocked: [],
			unprobed: [],
		},
	});
	assert.equal(h.bootcamp.from, '$capabilities');
	assert.equal(h.bootcamp.verdict, 'PASSES');
	assert.deepEqual(h.bootcamp.earned, ['gh', 'ffmpeg']);
	const failing = facetOf(CLAW1, {
		capabilities: { at: '2026-09-08T05:27:28.098Z', blocked: [{ id: 'gh', detail: 'absent' }] },
	});
	assert.equal(failing.bootcamp.verdict, 'FAILS');
	assert.deepEqual(failing.bootcamp.blocked, ['gh']);
});

void test('the pointer is attached in memory and NEVER stored — healthRecord drops it (Wave 3h)', () => {
	// `$health` moved to the state dir and `$capabilities` stayed in the
	// manifest, so a stored pointer would be a cross-tree read frozen at write
	// time. S §2.5: it moves with its target or it is dropped. The reader
	// re-derives it from the CURRENT manifest (`bootcampPointer`).
	const caps = { at: '2026-09-08T05:27:28.098Z', by: 'fleet bootcamp', earned: ['gh'] };
	const h = facetOf(CLAW1, { capabilities: caps });
	assert.deepEqual(h.bootcamp, bootcampPointer(caps), 'one implementation, two call sites');
	const stored = healthRecord(h);
	assert.equal('bootcamp' in stored, false);
	assert.equal(stored.at, h.at, 'everything else is kept');
	assert.equal(stored.thermal.sensor, h.thermal.sensor);
	assert.ok(h.bootcamp, 'and the input is not mutated');
});

void test('a node with no $capabilities says so rather than claiming a verdict', () => {
	const h = facetOf(CLAW1);
	assert.equal(h.bootcamp.at, null);
	assert.match(h.bootcamp.why, /no \$capabilities record/);
	const fs = find(doctorFindings(h, { nowMs: NOW }), 'bootcamp-record');
	assert.equal(fs.length, 1);
	assert.equal(fs[0].class, ADVISORY);
});

void test('healthFacet: disk.work is populated ONLY when the probe positively says the source differs', () => {
	const sameDisk = healthFacet({
		node: 'claw-x',
		probe: parseDoctor(
			workProbe([
				'D disk.work.sameAsRoot yes',
				'D disk.work.fs ext4',
				'D disk.work.totalKb 1000000',
				'D disk.work.availKb 900000',
			])
		),
	});
	assert.equal(sameDisk.disk.work, null, '"yes" (same disk) must not draw a second finding');

	const unknown = healthFacet({
		node: 'claw-x',
		probe: parseDoctor(workProbe(['D disk.work.sameAsRoot unknown'])),
	});
	assert.equal(
		unknown.disk.work,
		null,
		'could not tell is read as "nothing extra to report", not "different"'
	);

	const different = healthFacet({
		node: 'claw-x',
		probe: parseDoctor(
			workProbe([
				'D disk.work.sameAsRoot no',
				'D disk.work.fs xfs',
				'D disk.work.totalKb 2000000',
				'D disk.work.availKb 100000',
			])
		),
	});
	assert.deepEqual(different.disk.work, {
		fs: 'xfs',
		totalKb: 2000000,
		availKb: 100000,
		freePct: 5,
		why: null,
	});
});

void test('healthFacet: disk.consumers reports the known large consumers, KiB, 0 for "never built", why for "could not read"', () => {
	const h = healthFacet({
		node: 'claw-x',
		probe: parseDoctor(
			workProbe([
				'D consumer.jitKb 40000',
				'D consumer.warmKb 0',
				'D consumer.cacheKb 5500000',
				'U consumer.pnpmStoreKb pnpm store path produced nothing this run could resolve to an existing directory',
				'D consumer.seed|~/.cache/cardtable-forge 123456',
			])
		),
	});
	assert.deepEqual(h.disk.consumers, {
		jitKb: 40000,
		warmKb: 0,
		cacheKb: 5500000,
		pnpmStoreKb: null,
		pnpmStoreWhy:
			'pnpm store path produced nothing this run could resolve to an existing directory',
		seeds: [{ cache: '~/.cache/cardtable-forge', kb: 123456 }],
	});
});

void test('healthFacet: disk.consumers on a probe that never ran this lane’s facts is all null/empty, not zero', () => {
	// `facetOf(CLAW1)` again: the real 2026-09-10 capture. Zero would read as
	// "measured and empty"; this is "never asked".
	assert.deepEqual(facetOf(CLAW1).disk.consumers, {
		jitKb: null,
		warmKb: null,
		cacheKb: null,
		pnpmStoreKb: null,
		pnpmStoreWhy: null,
		seeds: [],
	});
});

void test('healthFacet: an unreadable seed cache is reported with its reason, not dropped', () => {
	const h = healthFacet({
		node: 'claw-x',
		probe: parseDoctor(
			workProbe(['U consumer.seed|~/.cache/cardtable-forge the node produced no value for this'])
		),
	});
	assert.deepEqual(h.disk.consumers.seeds, [
		{ cache: '~/.cache/cardtable-forge', kb: null, why: 'the node produced no value for this' },
	]);
});

// ═══════════════════════════════════════════════════════════════════════════
// THE FLEET AS MEASURED — a regression pin on the real run
// ═══════════════════════════════════════════════════════════════════════════

void test('claw-1 renders the measured run exactly, throttle delta included', () => {
	const h = facetOf(CLAW1);
	assert.deepEqual(
		{
			sensor: h.thermal.sensor,
			idleC: h.thermal.idleC,
			loadC: h.thermal.loadC,
			riseC: h.thermal.riseC,
			throttleEvents: h.thermal.throttleEvents,
			hours: h.smart.powerOnHours,
			freePct: h.disk.freePct,
			wifi: h.network.wifiManager,
			watchdogSensor: h.watchdog.sensorPath,
			watchdogC: h.watchdog.sensorC,
		},
		{
			sensor: 'hwmon.3.coretemp.Package_id_0',
			idleC: 61,
			loadC: 97,
			riseC: 36,
			throttleEvents: 23_650,
			hours: 19_727,
			freePct: 89.5,
			wifi: 'networkmanager',
			// claw-1's watchdog IS aimed at the package zone, which is the correct
			// sensor — so the `wrong-sensor` finding must stay silent here.
			watchdogSensor: '/sys/class/thermal/thermal_zone3/temp',
			watchdogC: 62,
		}
	);
	assert.equal(find(doctorFindings(h, { nowMs: NOW }), 'watchdog').length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// FAILED UNITS — every failed system unit, not only actions.runner.*
// ═══════════════════════════════════════════════════════════════════════════

void test('healthFacet: failedUnits names each unit and when it failed, off the real capture', () => {
	assert.deepEqual(failedFacet(FAILED_CLAW3).failedUnits, {
		units: [{ unit: 'cktest-runner.service', since: '2026-10-25T15:23:19.000Z' }],
		why: null,
	});
	assert.deepEqual(failedFacet(FAILED_CLAW1).failedUnits.units, [
		{ unit: 'systemd-modules-load.service', since: '2026-10-25T14:22:49.000Z' },
	]);
});

void test('healthFacet: a counted zero is [], and an unlistable node is null with the reason', () => {
	assert.deepEqual(failedFacet(FAILED_CLAW4).failedUnits, { units: [], why: null });
	const blind = failedFacet(["U failedUnits systemctl could not list this node's units"]);
	assert.equal(blind.failedUnits.units, null, 'could not look is never an empty list');
	assert.match(blind.failedUnits.why, /could not list/);
});

void test('healthFacet: a failed unit whose timestamp the node withheld is kept, with since null', () => {
	const h = failedFacet([
		'D failedUnits.count 1',
		'U failedUnit.cktest-runner.service the node produced no value for this',
	]);
	assert.deepEqual(h.failedUnits.units, [{ unit: 'cktest-runner.service', since: null }]);
});

// ═══════════════════════════════════════════════════════════════════════════
// PM2 MANAGERS — measured here, claimed by doctor-run (lib/hosting-claims.mjs)
// ═══════════════════════════════════════════════════════════════════════════

void test('healthFacet: pm2Units carries each manager, its ceiling and running apps, off the real capture', () => {
	assert.deepEqual(pm2Facet(PM2_HOKON).pm2Units, {
		units: [{ unit: 'pm2-hadoku.service', bounded: true, tenant: null, apps: 28 }],
		why: null,
	});
	assert.deepEqual(pm2Facet(PM2_CLAW6).pm2Units.units, [
		{ unit: 'pm2-hadoku.service', bounded: false, tenant: null, apps: 0 },
	]);
	assert.deepEqual(pm2Facet(PM2_CLAW5).pm2Units, { units: [], why: null });
});

void test('healthFacet: a tenant manager is bounded by its hosting slice, though its own unit reads max (claw-4, fleet-manager#46)', () => {
	assert.deepEqual(pm2Facet(PM2_CLAW4).pm2Units.units, [
		{ unit: 'pm2-archivebot-svc.service', bounded: true, tenant: 'archivebot', apps: 1 },
		{ unit: 'pm2-hadoku.service', bounded: true, tenant: null, apps: 0 },
		{ unit: 'pm2-pygmalion-svc.service', bounded: true, tenant: 'pygmalion', apps: 1 },
	]);
	// system.slice's ceiling is shared by the whole node: it bounds no one manager.
	assert.deepEqual(
		pm2Facet([
			'D pm2Units.count 1',
			'D pm2Unit.pm2-hadoku.service max 0 /system.slice/pm2-hadoku.service 8589934592',
		]).pm2Units.units,
		[{ unit: 'pm2-hadoku.service', bounded: false, tenant: null, apps: 0 }]
	);
});

void test('healthFacet: an unreadable ceiling is unbounded and an uncounted manager has apps null', () => {
	assert.deepEqual(
		pm2Facet(['D pm2Units.count 1', 'D pm2Unit.pm2-hadoku.service U U']).pm2Units.units,
		[{ unit: 'pm2-hadoku.service', bounded: false, tenant: null, apps: null }]
	);
	const blind = pm2Facet(["U pm2Units systemctl could not list this node's pm2 units"]);
	assert.equal(blind.pm2Units.units, null, 'could not look is never an empty list');
	assert.equal(find(doctorFindings(blind, { nowMs: NOW }), 'pm2-claims')[0].status, 'unknown');
});
