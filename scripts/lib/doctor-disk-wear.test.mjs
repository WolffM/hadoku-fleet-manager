/**
 * #155: every disk's SMART error counts, root included, learned per serial and
 * judged for growth, against the verbatim claw-10 storage-probe capture (its
 * 870 EVO root: 22 reallocated, 2886 reported uncorrectable).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	WEAR_SPEC,
	judgeWear,
	rootWearText,
	wearFindings,
	wearReadings,
	wearText,
} from './doctor-disk-wear.mjs';
import { judgeDoctor } from './doctor-baseline.mjs';
import { disksLine, storageFacet } from './doctor-findings-disks.mjs';
import { doctorFindings } from './doctor-findings.mjs';
import { learnReading } from './node-baselines.mjs';
import { ADVISORY } from './preflight.mjs';
import { CLAW10 } from './storage-fixtures.mjs';

const ROOT = 'SERIAL-claw-10-sda';
const AT = '2026-11-24T00:00:00Z';
const health = () => ({ node: 'claw-10', storage: storageFacet(CLAW10.split('\n')) });
const byQuantity = (rs) => Object.fromEntries(rs.map((r) => [r.quantity, r.value]));

/** A store that has learned every reading of `h` once, then `bump` on top. */
function learned(h, bump = {}) {
	const q = {};
	for (const r of wearReadings(h))
		q[r.quantity] = learnReading(null, r.value + (bump[r.quantity] ?? 0), WEAR_SPEC, AT, false);
	return q;
}

void test('the root disk is read: claw-10 root carries 22 reallocated and 2886 uncorrectable', () => {
	const rs = byQuantity(wearReadings(health()));
	assert.equal(rs[`disk.${ROOT}.reallocated`], 22);
	assert.equal(rs[`disk.${ROOT}.reportedUncorrect`], 2886);
	assert.ok(wearReadings(health()).some((r) => r.isRoot && r.serial === ROOT));
});

void test('a disk with SMART switched off contributes no count: unread is not zero', () => {
	assert.ok(!wearReadings(health()).some((r) => r.serial === 'SERIAL-claw-10-sdb'));
});

void test('first reading learns: no finding, and every count joins the window', () => {
	const h = health();
	const judged = judgeDoctor(h, {}, AT);
	h.baseline = judged.stamp;
	assert.ok(judged.stamp.diskWear.every((x) => x.verdict === 'learning'));
	assert.equal(
		judged.window.readings.filter((r) => r.quantity.startsWith('disk.')).length,
		wearReadings(h).length
	);
	assert.deepEqual(wearFindings(h), []);
});

void test('a non-zero count that holds still is within, and does not warn', () => {
	const h = health();
	h.baseline = judgeDoctor(h, learned(h), AT).stamp;
	assert.ok(h.baseline.diskWear.every((x) => x.verdict === 'within'));
	assert.deepEqual(wearFindings(h), []);
});

void test('one more reallocated sector is a quiet growth finding naming the serial', () => {
	const h = health();
	const q = learned(h, { [`disk.${ROOT}.reallocated`]: -1 });
	h.baseline = judgeDoctor(h, q, AT).stamp;
	const fs = wearFindings(h);
	assert.equal(fs.length, 1);
	const [x] = fs;
	assert.equal(x.category, 'disk-wear');
	assert.equal(x.status, 'reallocated-grew');
	assert.equal(x.class, ADVISORY);
	assert.equal(x.shadow, true);
	assert.deepEqual([x.from, x.to, x.serial], [21, 22, ROOT]);
	assert.match(x.why, /sda \(serial SERIAL-claw-10-sda, root\) realloc count grew 21 → 22/);
	assert.ok(doctorFindings(h).some((y) => y.category === 'disk-wear'));
});

void test('a count that fell re-learns without a finding', () => {
	const h = health();
	h.baseline = judgeDoctor(h, learned(h, { [`disk.${ROOT}.reallocated`]: 5 }), AT).stamp;
	assert.equal(
		h.baseline.diskWear.find((x) => x.quantity === `disk.${ROOT}.reallocated`).direction,
		'better'
	);
	assert.deepEqual(wearFindings(h), []);
});

void test('growth re-seeds the estimate, so the same count next time is within', () => {
	const h = health();
	const { readings } = judgeWear(h, learned(h, { [`disk.${ROOT}.reallocated`]: -1 }));
	const r = readings.find((x) => x.quantity === `disk.${ROOT}.reallocated`);
	assert.equal(r.drifted, true);
	const after = learnReading(learnReading(null, 21, WEAR_SPEC, AT, false), 22, WEAR_SPEC, AT, true);
	const again = judgeWear(h, { [r.quantity]: after }).stamp.find((x) => x.quantity === r.quantity);
	assert.equal(again.verdict, 'within');
});

void test('the render shows the root counts beside smart, and the other disks on disks', () => {
	const h = health();
	assert.match(rootWearText(h), /^realloc 22 .*uncorrectable 2886$/);
	assert.match(disksLine(h.storage), /sdc \d+G ok \S+h realloc \d+/);
	assert.equal(wearText({ reallocated: null }), '');
	// No inventory: the root SMART facet's two counts.
	assert.equal(
		rootWearText({ smart: { reallocated: 3, pendingSectors: 0 } }),
		'realloc 3 pending 0'
	);
});
