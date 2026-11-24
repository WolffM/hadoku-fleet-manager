/**
 * SMART on every disk (#138): the facet from the probe's `T ` lines, and the
 * per-disk findings, against the verbatim storage-probe.sh captures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { diskFindings, disksLine, storageFacet } from './doctor-findings-disks.mjs';
import { parseDoctor } from './doctor-parse.mjs';
import { doctorProbe, storageBlock } from './doctor-probe.mjs';
import { doctorFindings } from './doctor-findings.mjs';
import { ADVISORY } from './preflight.mjs';
import { CLAW1, facetOf } from './doctor-fixtures.mjs';
import { CLAW10, CLAW2, CLAW4, CLAW9, CLAW9_NOROOT, CLAW9_NOTOOL } from './storage-fixtures.mjs';

const lines = (fx) => fx.split('\n');
const health = (fx) => ({ node: 'claw-x', storage: storageFacet(lines(fx)) });
const statuses = (fs) => fs.map((x) => x.status);

void test('a node whose disks all read PASSED and young has no disk finding', () => {
	for (const fx of [CLAW9, CLAW2, CLAW4]) assert.deepEqual(diskFindings(health(fx)), []);
});

void test('claw-10: SMART switched off and a five-year drive are each named by serial', () => {
	const fs = diskFindings(health(CLAW10));
	assert.deepEqual(statuses(fs), ['smart-disabled', 'aging']);
	assert.deepEqual(
		fs.map((x) => x.serial),
		['SERIAL-claw-10-sdb', 'SERIAL-claw-10-sdc']
	);
	assert.match(fs[0].why, /sdb \(serial SERIAL-claw-10-sdb\)/);
});

void test('every finding is advisory and marked shadow: a new reading ships quiet', () => {
	const all = [CLAW10, CLAW9_NOROOT, CLAW9_NOTOOL].flatMap((fx) => diskFindings(health(fx)));
	assert.ok(all.length >= 4);
	for (const x of all) {
		assert.equal(x.class, ADVISORY);
		assert.equal(x.shadow, true);
		assert.equal(x.category, 'disk-smart');
	}
});

void test('claw-4: an empty card-reader slot is not a disk and is not judged', () => {
	const h = health(CLAW4);
	assert.equal(h.storage.disks.filter((d) => !d.mediaPresent).length, 4);
	assert.deepEqual(diskFindings(h), []);
	assert.match(disksLine(h.storage), /sdc empty slot/);
});

void test('no tool and not root are their own reasons, once per node, never healthy', () => {
	const noTool = diskFindings(health(CLAW9_NOTOOL));
	assert.deepEqual(statuses(noTool), ['no-tool']);
	assert.match(noTool[0].why, /SERIAL-claw-9-sdb/);
	assert.doesNotMatch(noTool[0].why, /SERIAL-claw-9-sda/, 'root is judged by smart-health');
	assert.deepEqual(statuses(diskFindings(health(CLAW9_NOROOT))), ['not-root']);
});

void test('a USB bridge that hides a present drive is usb-bridge, not unsupported', () => {
	const h = health(CLAW4);
	h.storage.disks[2].mediaPresent = true;
	const fs = diskFindings(h);
	assert.deepEqual(statuses(fs), ['usb-bridge']);
	assert.match(fs[0].why, /Unknown USB bridge/);
});

void test('a failing drive, pending sectors and a ten-year drive each fire', () => {
	const h = health(CLAW9);
	const sdb = h.storage.disks[1].smart;
	Object.assign(sdb, { status: 'failing', health: 'FAILED!' });
	assert.deepEqual(statuses(diskFindings(h)), ['failing']);
	Object.assign(sdb, { status: 'ok', health: 'PASSED', pendingSectors: 8, powerOnHours: 90_000 });
	assert.deepEqual(statuses(diskFindings(h)), ['pending-sectors', 'beyond-service-life']);
	Object.assign(sdb, { pendingSectors: 0, powerOnHours: null });
	assert.deepEqual(statuses(diskFindings(h)), ['no-hours']);
	Object.assign(sdb, { status: 'something-new' });
	assert.deepEqual(statuses(diskFindings(h)), ['no-answer']);
});

void test('no inventory is a finding: not recorded, not handed the probe, or cut off', () => {
	assert.deepEqual(statuses(diskFindings({ node: 'n' })), ['not-recorded']);
	const unhanded = storageFacet([], { storage: 'the doctor was not handed storage-probe.sh' });
	assert.deepEqual(statuses(diskFindings({ node: 'n', storage: unhanded })), [
		'inventory-unreadable',
	]);
	const cut = storageFacet(lines(CLAW9).slice(0, 30));
	assert.equal(cut.read, false);
	assert.match(cut.why, /STORAGE-END/);
	assert.deepEqual(statuses(diskFindings({ node: 'n', storage: cut })), ['inventory-unreadable']);
});

void test('the T prefix keeps storage-probe S lines out of the root drive smartctl lines', () => {
	const raw = CLAW1.replace(
		/^DOCTOR-END /m,
		`${lines(CLAW9)
			.map((l) => `T ${l}`)
			.join('\n')}\nDOCTOR-END `
	);
	const probe = parseDoctor(raw);
	assert.equal(probe.complete, true);
	assert.deepEqual(probe.storage, lines(CLAW9));
	assert.equal(parseDoctor(CLAW1).smart.length, probe.smart.length);
	const h = facetOf(raw);
	assert.equal(h.storage.read, true);
	assert.equal(h.storage.disks.length, 2);
	assert.ok(doctorFindings(h).every((x) => x.category !== 'disk-smart'));
});

void test('the probe runs the real storage-probe.sh through its heredoc and prefixes it', () => {
	const sh = readFileSync(new URL('../storage-probe.sh', import.meta.url), 'utf8');
	// As a non-root user with no sudo: the inventory says root=no, never fails.
	const block = ['ROOTOK=no', 'SUDO=', ...storageBlock(sh)].join('\n');
	const out = execFileSync('sh', ['-c', block], { encoding: 'utf8' });
	const ts = out.split('\n').filter((l) => l.startsWith('T '));
	assert.equal(ts.length, out.trim().split('\n').length, 'every line is T-prefixed');
	const facet = storageFacet(ts.map((l) => l.slice(2)));
	assert.equal(facet.read, true, facet.why);
	assert.match(doctorProbe({ storageProbeSh: sh, loadSeconds: 0 }), /FLEET_STORAGE_PROBE_EOF/);
	assert.match(doctorProbe({ loadSeconds: 0 }), /U storage|unk storage/);
	assert.throws(() => storageBlock('x\nFLEET_STORAGE_PROBE_EOF\ny'), /terminator/);
});
