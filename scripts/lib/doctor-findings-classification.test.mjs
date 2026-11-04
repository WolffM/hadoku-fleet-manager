/**
 * `doctorFindings` — classification that is not a numeric threshold: the
 * default class, watchdog existence/load-trigger, the radio, a staged
 * reboot, the backstop role, failed systemd units and pm2 claims.
 *
 * Split out of `doctor-findings.test.mjs` (wave 5s lane B) to bring that file
 * under the 1,000-line test ceiling. A whole-block move: every test body
 * below is unchanged from where it lived in that file. The threshold
 * MUTATION tests (die °C, disk %, SMART hours, sensor-tracking) live in
 * `doctor-findings-thresholds.test.mjs`; the recorded-fleet regression pin
 * lives in `doctor-findings-regression.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { healthRecord } from './doctor-facet.mjs';
import { claimPm2Units } from './hosting-claims.mjs';
import { PM2_MEMORY_MAX_MB_DEFAULT } from './pm2-boot-floor.mjs';
import { doctorFindings } from './doctor-findings.mjs';
import {
	ADVISORY,
	BLOCKING,
	advisoryFindings,
	blockingFindings,
	backstopAdvisory,
} from './preflight.mjs';
import {
	CLAW1,
	HOKON,
	facetOf,
	NOW,
	find,
	FAILED_CLAW3,
	FAILED_CLAW4,
	failedFacet,
	NIC_CLAW4_INCIDENT,
	NIC_CLAW9,
	NIC_WIFI,
	PM2_CLAW6,
	pm2Facet,
} from './doctor-fixtures.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// FINDINGS — CLASS
// ═══════════════════════════════════════════════════════════════════════════

void test('BLOCKING is the default: an unrecognised class fails the gate', () => {
	// Same property preflight.mjs holds, inherited by importing its filter rather
	// than by reimplementing it. A classifier that has to opt IN to silence
	// cannot silence anything by accident.
	const made = [{ class: 'whatever' }, { class: undefined }, { class: ADVISORY }];
	assert.equal(blockingFindings(made).length, 2);
	assert.equal(advisoryFindings(made).length, 1);
});

void test('every "I could not look" finding is BLOCKING and carries its reason', () => {
	// hokon: no passwordless sudo, so SMART was refused. A refusal must never
	// render as a pass, and the finding must say WHICH refusal it was — a missing
	// smartctl, a sudo refusal and a USB bridge are three different jobs.
	const fs = doctorFindings(facetOf(HOKON), { nowMs: NOW });
	const smart = find(fs, 'smart-health');
	assert.equal(smart.length, 1);
	assert.equal(smart[0].class, BLOCKING);
	assert.equal(smart[0].status, 'unreadable');
	assert.match(smart[0].why, /sudo -n was refused/);
});

void test('a node with NO die sensor fails rather than passing silently', () => {
	const h = facetOf(
		`DOCTOR-BEGIN v1\nD hostname claw-x\nU idle.sensors no readable sensor under /sys/class/thermal or /sys/class/hwmon\nD disk.root.totalKb 100\nD disk.root.availKb 90\nD smart.device sda\nS SMART overall-health self-assessment test result: PASSED\nS   9 Power_On_Hours          0x0032   100   100   000    Old_age   Always       -       10\nDOCTOR-END claw-x`
	);
	const fs = find(doctorFindings(h, { nowMs: NOW }), 'thermal-sensor');
	assert.equal(fs[0].class, BLOCKING);
	assert.equal(fs[0].status, 'no-die-sensor');
});

void test('a watchdog unit that does not EXIST is a fact, not a finding', () => {
	// hokon has no `watchdog` package — it is a claw safety control. Judging the
	// production host by the claws' rule reported it BLOCKING for not running
	// software nobody installed there.
	const h = facetOf(HOKON);
	assert.equal(h.watchdog.enabled, 'not-found');
	assert.equal(find(doctorFindings(h, { nowMs: NOW }), 'watchdog').length, 0);
	// A unit that exists and is stopped IS a finding: claw-1 rebooted four times
	// on 2026-08-17 with this exact state.
	const stopped = facetOf(CLAW1.replace('D watchdog.active active', 'D watchdog.active inactive'));
	const w = find(doctorFindings(stopped, { nowMs: NOW }), 'watchdog');
	assert.equal(w[0].class, BLOCKING);
	assert.equal(w[0].status, 'not-running');
});

void test('any watchdog load trigger is a finding; none is silent', () => {
	// claw-8, 2026-10-30: only max-load-1 = 64 was written, the daemon derived a
	// 15-minute ceiling of 32, and a responsive node was rebooted at 52/48/34.
	assert.equal(facetOf(CLAW1).watchdog.loadTrigger, 'none');
	const loaded = facetOf(
		CLAW1.replace('D watchdog.loadTrigger none', 'D watchdog.loadTrigger max-load-1=64')
	);
	assert.equal(loaded.watchdog.loadTrigger, 'max-load-1=64');
	const w = find(doctorFindings(loaded, { nowMs: NOW }), 'watchdog');
	assert.equal(w.length, 1);
	assert.equal(w[0].class, ADVISORY);
	assert.equal(w[0].status, 'load-trigger');
});

void test('a radio nothing connected is advisory; the two writers DISAGREEING is not', () => {
	const agreed = doctorFindings(facetOf(HOKON), { nowMs: NOW });
	const a = find(agreed, 'wifi-link');
	assert.equal(a[0].class, ADVISORY);
	assert.equal(a[0].status, 'not-connected');
	// NetworkManager claiming `connected` over a kernel link that is down means
	// one of the two is lying about the link the fleet falls back on.
	const lying = HOKON.replace(
		'WMGR dev wlp13s0:wifi:disconnected:',
		'WMGR dev wlp13s0:wifi:connected:ExampleNet'
	);
	const l = find(doctorFindings(facetOf(lying), { nowMs: NOW }), 'wifi-link');
	assert.equal(l[0].class, BLOCKING);
	assert.equal(l[0].status, 'contradicts');
});

void test('a SPLIT radio is blocking — a stale route outlives its carrier', () => {
	// claw-7, live on 2026-09-10: NM holds wlp9s0 while ifupdown still holds
	// enp8s0 from before the conversion.
	const split = CLAW1.replace(
		'WMGR dev enp4s0:ethernet:unavailable:',
		'WMGR dev enp4s0:ethernet:unavailable:\nWMGR ifupdown enp4s0'
	);
	const h = facetOf(split);
	assert.equal(h.network.wifiManager, 'split');
	const fs = find(doctorFindings(h, { nowMs: NOW }), 'wifi-manager');
	assert.equal(fs[0].class, BLOCKING);
});

void test('a staged reboot is judged by preflight, not by a second copy of the rule', () => {
	const fs = find(doctorFindings(facetOf(HOKON), { nowMs: NOW }), 'pending-reboot');
	assert.equal(fs.length, 1);
	assert.equal(fs[0].class, ADVISORY, 'staged 11d ago, inside the 30d window');
	// TIME MAKES IT STRICTER. Past the escalation window the same record blocks.
	const later = doctorFindings(facetOf(HOKON), { nowMs: NOW + 40 * 86_400_000 });
	assert.equal(find(later, 'pending-reboot')[0].class, BLOCKING);
});

void test("a staged reboot names the reboot cycle's last decision, and a held node blocks", () => {
	const h = facetOf(HOKON);
	h.reboot.cycle = { status: 'deferred', why: 'dkms missing for 6.12.113: wl.ko.xz', at: 'T1' };
	const fs = find(doctorFindings(h, { nowMs: NOW }), 'pending-reboot');
	assert.match(
		fs[0].why,
		/last looked at T1: deferred — dkms missing for 6\.12\.113: wl\.ko\.xz\./
	);
	assert.equal(find(doctorFindings(h, { nowMs: NOW }), 'reboot-held').length, 0);
	h.reboot.cycle = { status: 'held', why: 'booted the old kernel', at: 'T2' };
	const held = find(doctorFindings(h, { nowMs: NOW }), 'reboot-held');
	assert.equal(held[0].class, BLOCKING);
	assert.match(held[0].why, /fleet drain .* --undo/);
});

// --- the wiring: the classifier must be what `fleet doctor` actually exits on ---
//
// Same reasoning as `preflight.test.mjs`'s wiring block: a classifier nothing
// calls is worse than none, because the gate then looks role-aware and pages on
// the backstop anyway.

test('doctor-run.mjs applies the backstop role before deciding its exit code', () => {
	const src = readFileSync(
		resolve(dirname(fileURLToPath(import.meta.url)), 'doctor-run.mjs'),
		'utf8'
	);
	assert.match(
		src,
		/const classified = backstopAdvisory\(findings, BACKSTOPS\)/,
		'`fleet doctor` no longer applies the backstop role to its findings'
	);
	assert.match(
		src,
		/const BACKSTOPS = backstopNodeNames\(manifest\)/,
		'and the backstop set must come from the manifest role'
	);
	assert.match(
		src,
		/const blocking = blockingFindings\(classified\)/,
		'and its blocking set no longer comes from the classifier'
	);
	assert.match(
		src,
		/const advisory = advisoryFindings\(classified\)/,
		'a backstop finding classified out of `blocking` must still land in `advisory`'
	);
});

test('the backstop’s findings come back advisory, except unreachable', () => {
	// Driven through `doctorFindings`' real output rather than a hand-made
	// finding, so this measures the categories the facet actually produces.
	const fs = backstopAdvisory(doctorFindings(facetOf(CLAW1), { nowMs: NOW }), new Set(['claw-1']));
	assert.ok(fs.length > 0, 'the fixture must produce findings, or this asserts nothing');
	assert.equal(blockingFindings(fs).length, 0, 'nothing about the backstop blocks');
	assert.equal(advisoryFindings(fs).length, fs.length, 'and nothing is dropped');
	// MUTATION: as a claw the same node keeps whatever it had.
	const asClaw = doctorFindings(facetOf(CLAW1), { nowMs: NOW });
	assert.deepEqual(
		fs.map((f) => f.category),
		asClaw.map((f) => f.category),
		'the same findings, in the same order — only the class moved'
	);
});

test('an UNREACHABLE backstop still blocks — it is no use in an emergency', () => {
	const fs = backstopAdvisory(
		doctorFindings({ node: 'hokon', reachable: false, why: 'ssh refused' }),
		['hokon']
	);
	assert.deepEqual(
		fs.map((f) => [f.category, f.class]),
		[['unreachable', BLOCKING]]
	);
});

void test('a failed unit is an ADVISORY finding that names the unit and its age', () => {
	const fs = find(doctorFindings(failedFacet(FAILED_CLAW3), { nowMs: NOW }), 'failed-units');
	assert.equal(fs.length, 1);
	assert.equal(fs[0].class, ADVISORY);
	assert.equal(fs[0].status, 'failed');
	assert.match(fs[0].why, /cktest-runner\.service \(since 2026-10-25T15:23:19\.000Z\)/);
	assert.equal(
		blockingFindings(doctorFindings(failedFacet(FAILED_CLAW3), { nowMs: NOW })).some(
			(f) => f.category === 'failed-units'
		),
		false,
		'a leftover unit must not refuse a node work'
	);
});

void test('no failed unit draws no finding; an unlistable node draws an advisory, never silence', () => {
	assert.equal(
		find(doctorFindings(failedFacet(FAILED_CLAW4), { nowMs: NOW }), 'failed-units').length,
		0
	);
	const blind = find(
		doctorFindings(failedFacet(["U failedUnits systemctl could not list this node's units"]), {
			nowMs: NOW,
		}),
		'failed-units'
	);
	assert.equal(blind.length, 1);
	assert.equal(blind[0].class, ADVISORY);
	assert.equal(blind[0].status, 'unknown');
});

void test('a failed actions.runner unit is left to runner-units, not reported twice', () => {
	const fs = doctorFindings(
		failedFacet([
			'D failedUnits.count 1',
			'D failedUnit.actions.runner.WolffM-hadoku_site.claw-x.service 1792941799',
			'D runners.failed 1',
		]),
		{ nowMs: NOW }
	);
	assert.equal(find(fs, 'failed-units').length, 0);
	assert.equal(find(fs, 'runner-units').length, 1);
});

void test('a STORED record from before this probe draws nothing; a fresh probe that skipped it is unknown', () => {
	// node-status re-judges stored `$health` records, and one written before
	// 2026-10-27 has no `failedUnits` key at all: it never asked.
	const { failedUnits: _, ...stored } = facetOf(CLAW1);
	assert.equal(find(doctorFindings(stored, { nowMs: NOW }), 'failed-units').length, 0);
	// A probe output parsed NOW without the count line did not answer — the
	// 2026-09-10 claw-1 capture is exactly that — and may not read as clean.
	const fresh = find(doctorFindings(facetOf(CLAW1), { nowMs: NOW }), 'failed-units');
	assert.equal(fresh.length, 1);
	assert.equal(fresh[0].status, 'unknown');
});

void test('pm2 claims render by severity, and are never stored in the record', () => {
	const h = {
		...pm2Facet(PM2_CLAW6),
		pm2Claims: [
			{
				unit: 'pm2-hadoku.service',
				claim: 'app-layer-idle',
				severity: 'advisory',
				by: 'app-layer',
				why: 'idle',
			},
			{ unit: 'pm2-x.service', claim: 'unclaimed', severity: 'fail', by: null, why: 'nobody' },
			{ unit: 'pm2-y-svc.service', claim: 'tenant', severity: 'ok', by: 'y', why: 'declared' },
		],
	};
	const fs = find(doctorFindings(h, { nowMs: NOW }), 'pm2-claims');
	assert.deepEqual(
		fs.map((f) => [f.status, f.class]),
		[
			['app-layer-idle', ADVISORY],
			['unclaimed', BLOCKING],
		]
	);
	assert.equal('pm2Claims' in healthRecord(h), false);
	// A stored record re-judged without the join (node-status) draws nothing.
	assert.equal(find(doctorFindings(healthRecord(h), { nowMs: NOW }), 'pm2-claims').length, 0);
});

void test("claw-6's idle admin pm2, once pm2-boot bounds it, is a declared host and draws no finding", () => {
	// The join doctor-run makes: the probe's units, claimed against the app
	// layer's host list. Unbounded it is `app-layer-idle`; at the floor's
	// default ceiling the same idle daemon is claimed and budgeted, so `ok`.
	const judged = (lines) => {
		const h = pm2Facet(lines);
		h.pm2Claims = claimPm2Units({
			units: h.pm2Units.units,
			tenants: [],
			declaredHere: [],
			appLayer: { unit: 'pm2-hadoku.service', host: true },
		});
		return find(doctorFindings(h, { nowMs: NOW }), 'pm2-claims').map((f) => f.status);
	};
	assert.deepEqual(judged(PM2_CLAW6), ['app-layer-idle']);
	const bounded = PM2_CLAW6.map((l) =>
		l.replace(' max 0', ` ${PM2_MEMORY_MAX_MB_DEFAULT * 1048576} 0`)
	);
	assert.notDeepEqual(bounded, PM2_CLAW6);
	assert.deepEqual(judged(bounded), []);
});

void test('NIC: the 2026-11-03 cable reads as degraded AND flapping, both advisory; a gigabit, quiet link draws nothing', () => {
	const incident = find(
		doctorFindings(failedFacet(NIC_CLAW4_INCIDENT), { nowMs: NOW }),
		'nic-link'
	);
	assert.deepEqual(
		incident.map((x) => [x.status, x.class]),
		[
			['degraded', ADVISORY],
			['flapping', ADVISORY],
		]
	);
	assert.match(incident[0].why, /enp0s31f6 negotiated 100 Mbps, below 1000/);
	assert.match(incident[1].why, /dropped its link 633 times this boot/);
	assert.equal(find(doctorFindings(failedFacet(NIC_CLAW9), { nowMs: NOW }), 'nic-link').length, 0);
});

void test('NIC: Wi-Fi is not judged on speed; an unreadable link is an advisory, never silence', () => {
	assert.equal(find(doctorFindings(failedFacet(NIC_WIFI), { nowMs: NOW }), 'nic-link').length, 0);
	const blind = find(
		doctorFindings(failedFacet(['U nic no default route']), { nowMs: NOW }),
		'nic-link'
	);
	assert.deepEqual(
		blind.map((x) => x.status),
		['unknown']
	);
	const noJournal = find(
		doctorFindings(
			failedFacet([
				'D nic.iface enp8s0',
				'D nic.kind wired',
				'D nic.speedMbps 1000',
				"U nic.linkDowns this boot's kernel journal could not be read",
			]),
			{ nowMs: NOW }
		),
		'nic-link'
	);
	assert.deepEqual(
		noJournal.map((x) => x.status),
		['unknown']
	);
	assert.match(noJournal[0].why, /kernel journal could not be read/);
});
