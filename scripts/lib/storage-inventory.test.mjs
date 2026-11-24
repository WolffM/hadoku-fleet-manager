import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSmart, parseStorage, parseLsblkRow } from './storage-inventory.mjs';
import { parse as parseBenchmark } from './benchmark-inventory.mjs';
import { benchmarkScript } from './benchmark-measure.mjs';
import { parseDoctor } from './doctor-parse.mjs';
import { CLAW1, CLAW7_SMART } from './doctor-fixtures.mjs';
import { CLAW9, CLAW9_NOROOT, CLAW9_NOTOOL, CLAW10, CLAW4, CLAW2 } from './storage-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = dirname(HERE);
const disk = (inv, d) => inv.disks.find((x) => x.device === d);

// ── parseSmart (moved here from doctor-parse.mjs with the inventory) ────────

void test('SMART reads the RAW_VALUE column, not the normalised one', () => {
	// claw-1's drive is 19,727 hours at 39 °C. Reading the wrong column gave
	// 55 hours at 150 °C — both plausible-looking numbers, both the normalised
	// columns, and neither of them a measurement of anything.
	const s = parseSmart(parseDoctor(CLAW1).smart);
	assert.equal(s.health, 'PASSED');
	assert.equal(s.powerOnHours, 19_727);
	assert.equal(s.temperatureC, 39);
	assert.equal(s.reallocated, 0);
	assert.equal(s.pendingSectors, 0);
});

void test('Percent_Lifetime_Remain is a percent USED in the raw column', () => {
	// claw-7's MX100: normalised 067, raw 33, summing to 100. The attribute NAME
	// describes the normalised column; the raw column is the used half.
	const s = parseSmart(CLAW7_SMART);
	assert.equal(s.powerOnHours, 91_529);
	assert.equal(s.lifetimeRemainingPct, 67);
	assert.equal(s.temperatureC, 35);
	assert.equal(s.reallocated, 1);
});

void test('an NVMe SMART log is read from its key/value shape', () => {
	const s = parseSmart([
		'SMART/Health Information (NVMe Log 0x02)',
		'SMART overall-health self-assessment test result: PASSED',
		'Temperature:                        44 Celsius',
		'Available Spare:                    100%',
		'Percentage Used:                    4%',
		'Power On Hours:                     1,280',
		'Media and Data Integrity Errors:    0',
	]);
	assert.equal(s.powerOnHours, 1280, 'thousands separators are stripped');
	assert.equal(s.temperatureC, 44);
	assert.equal(s.lifetimeRemainingPct, 96);
});

void test('a drive that REFUSED SMART is never read as PASSED', () => {
	// claw-4 carries four empty USB card-reader slots that answer exactly this.
	const s = parseSmart([
		'smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.94+deb13-amd64] (local build)',
		'/dev/sdc: Unknown USB bridge [0x058f:0x6362 (0x100)]',
		'Please specify device type with the -d option.',
	]);
	assert.equal(s.health, null);
	assert.match(s.reason, /Unknown USB bridge/);
});

// ── the inventory, against real nodes ──────────────────────────────────────

void test('a blank disk reads blank, named by serial, with SMART answered', () => {
	// claw-9 sdb, 2026-11-23: a 931.5G WD10EZEX with no partition table and no
	// signature. Root is sda, so sda is the one disk that is NOT a candidate.
	const inv = parseStorage(CLAW9);
	assert.equal(inv.root, true);
	assert.equal(inv.smartTool, '/usr/sbin/smartctl');
	assert.deepEqual(
		inv.disks.map((d) => d.device),
		['sda', 'sdb']
	);
	const sdb = disk(inv, 'sdb');
	assert.equal(sdb.blank, true);
	assert.equal(sdb.serial, 'SERIAL-claw-9-sdb');
	assert.equal(
		sdb.model,
		'WDC WD10EZEX-08WN4A0',
		'the full lsblk model, not the 16-byte sysfs one'
	);
	assert.equal(sdb.sizeBytes, 1_000_204_886_016);
	assert.equal(sdb.rotational, true);
	assert.equal(sdb.transport, 'sata');
	assert.equal(sdb.isRoot, false);
	assert.equal(sdb.mounted, false);
	assert.equal(sdb.partitionTable, null);
	assert.equal(sdb.smart.status, 'ok');
	assert.ok(sdb.smart.powerOnHours > 0);
	const sda = disk(inv, 'sda');
	assert.equal(sda.isRoot, true);
	assert.equal(sda.blank, false);
	assert.deepEqual(sda.mountpoints, ['/', '[SWAP]']);
	assert.deepEqual(
		sda.partitions.map((p) => [p.name, p.fstype, p.mountpoint]),
		[
			['sda1', 'ext4', '/'],
			['sda2', 'swap', '[SWAP]'],
		]
	);
});

void test('NTFS data disks carry their filesystem, UUID and label, and SMART disabled is its own status', () => {
	const inv = parseStorage(CLAW10);
	const sdb = disk(inv, 'sdb');
	assert.equal(sdb.blank, false);
	assert.equal(sdb.partitionTable, 'gpt');
	assert.deepEqual(sdb.partitions, [
		{
			name: 'sdb1',
			sizeBytes: 3_000_591_450_112,
			fstype: 'ntfs',
			uuid: 'D0E43614E435FD72',
			label: 'Raw Vid Backup',
			mountpoint: null,
		},
	]);
	// The drive SAYS SMART is off. That is not a failure and not a refusal.
	assert.equal(sdb.smart.status, 'disabled');
	assert.equal(sdb.smart.health, null);
	const sdc = disk(inv, 'sdc');
	assert.equal(sdc.partitionTable, 'dos');
	assert.equal(sdc.partitions[0].fstype, 'ntfs');
	assert.equal(sdc.smart.status, 'ok');
});

void test('a USB bridge that hides SMART is unsupported, and an empty slot has no media', () => {
	const inv = parseStorage(CLAW4);
	for (const d of ['sdc', 'sdd', 'sde', 'sdf']) {
		const r = disk(inv, d);
		assert.equal(r.transport, 'usb');
		assert.equal(r.removable, true);
		assert.equal(r.mediaPresent, false);
		assert.equal(r.blank, false, 'no media is not a blank disk');
		assert.equal(r.smart.status, 'unsupported');
		assert.match(r.smart.why, /Unknown USB bridge/);
	}
	const sdb = disk(inv, 'sdb');
	assert.equal(sdb.mediaPresent, true);
	assert.equal(sdb.smart.status, 'ok');
});

void test('an NVMe reads its key/value SMART log', () => {
	const nv = disk(parseStorage(CLAW2), 'nvme0n1');
	assert.equal(nv.kind, 'nvme');
	assert.equal(nv.transport, 'nvme');
	assert.equal(nv.isRoot, true);
	assert.equal(nv.smart.status, 'ok');
	assert.equal(nv.smart.powerOnHours, 530);
	assert.equal(nv.smart.lifetimeRemainingPct, 93);
});

void test('no SMART tool, not root, and a refusal are three different statuses', () => {
	// The same node, three ways. Each is a different job for whoever reads it.
	const notool = parseStorage(CLAW9_NOTOOL);
	assert.equal(notool.smartTool, null);
	assert.ok(notool.disks.every((d) => d.smart.status === 'no-tool'));
	const noroot = parseStorage(CLAW9_NOROOT);
	assert.equal(noroot.root, false);
	assert.equal(noroot.smartTool, '/usr/sbin/smartctl');
	assert.ok(noroot.disks.every((d) => d.smart.status === 'not-root'));
	// lsblk needs no root: the blank disk is still found.
	assert.equal(disk(noroot, 'sdb').blank, true);
});

void test('a probe that did not run or was cut off throws, never reads as fewer disks', () => {
	assert.throws(() => parseStorage(''), /no STORAGE-BEGIN/);
	assert.throws(() => parseStorage(CLAW9.slice(0, CLAW9.indexOf('STORAGE-END'))), /truncated/);
});

void test('lsblk escapes are undone', () => {
	assert.deepEqual(parseLsblkRow('NAME="sdb1" LABEL="Raw\\x20Vid"'), {
		NAME: 'sdb1',
		LABEL: 'Raw Vid',
	});
});

// ── the contract ───────────────────────────────────────────────────────────

/** Field names of one `export interface` in the .d.mts. */
function declared(name) {
	const dts = readFileSync(join(HERE, 'storage-inventory.d.mts'), 'utf8').replace(
		/\/\*\*[\s\S]*?\*\//g,
		''
	);
	const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(dts);
	assert.ok(m, `storage-inventory.d.mts declares ${name}`);
	return [...m[1].matchAll(/^\s*(\w+)\??:/gm)].map((x) => x[1]).sort();
}

void test('every record carries exactly the keys storage-inventory.d.mts declares', () => {
	const keys = (o) => Object.keys(o).sort();
	for (const fx of [CLAW9, CLAW9_NOROOT, CLAW9_NOTOOL, CLAW10, CLAW4, CLAW2]) {
		const inv = parseStorage(fx);
		assert.deepEqual(keys(inv), declared('StorageInventory'));
		for (const d of inv.disks) {
			assert.deepEqual(keys(d), declared('StorageDisk'));
			assert.deepEqual(keys(d.smart), declared('StorageSmart'));
			for (const p of d.partitions) assert.deepEqual(keys(p), declared('StoragePartition'));
			if (d.filesystem) assert.deepEqual(keys(d.filesystem), declared('StorageFilesystem'));
		}
	}
});

// ── one device loop ────────────────────────────────────────────────────────

void test('benchmark-node.sh walks no disks itself: storage_probe is the one loop', () => {
	const sh = readFileSync(join(SCRIPTS, 'benchmark-node.sh'), 'utf8').replace(/^[ \t]*#.*$/gm, '');
	assert.doesNotMatch(sh, /\/sys\/block|smartctl/);
	assert.match(sh, /storage_probe/);
	assert.ok(benchmarkScript().startsWith(readFileSync(join(SCRIPTS, 'storage-probe.sh'), 'utf8')));
});

void test("the benchmark record's flat disk keys come from the same SMART read", () => {
	// What benchmark-node.sh's output carries: the storage block inside BENCH.
	const r = parseBenchmark(`BENCH-BEGIN v1\nhostname claw-2\n${CLAW2}BENCH-END claw-2\n`);
	assert.equal(r['disk.nvme0n1.kind'], 'nvme');
	assert.equal(r['disk.nvme0n1.smartHealth'], 'PASSED');
	assert.equal(r['disk.nvme0n1.powerOnHours'], '530');
	assert.equal(r['disk.nvme0n1.percentageUsed'], '7');
	assert.equal(r['disk.nvme0n1.unsafeShutdowns'], '23');
	assert.equal(r['disk.nvme0n1.mediaErrors'], '0');
	assert.equal(r['disk.nvme0n1.reallocated'], undefined, 'NVMe has no reallocated count');
	assert.equal(r['disk.nvme0n1.mountpoints'], '/boot/efi,/,[SWAP]');
	assert.ok(!('disk' in r) && !('P' in r) && !('S' in r), 'storage rows are not flat keys');
	const ata = parseBenchmark(`BENCH-BEGIN v1\n${CLAW9}BENCH-END claw-9\n`);
	assert.equal(ata['disk.sdb.reallocated'], '0');
	assert.ok(Number(ata['disk.sdb.powerOnHours']) > 0);
});

void test('the probe runs here and its output parses', () => {
	// Read-only on whatever box runs the suite. Not root, so SMART is not-root
	// or no-tool; the point is the shell and the parser agree.
	const out = execFileSync('sh', [join(SCRIPTS, 'storage-probe.sh')], { encoding: 'utf8' });
	const inv = parseStorage(out);
	const want = readdirSync('/sys/block').filter((d) => !/^(loop|ram|sr|dm-|zram|md)/.test(d));
	assert.deepEqual(inv.disks.map((d) => d.device).sort(), want.sort());
});

void test('the disk-qualify fields: TRIM from smartctl -i, attribute 198, the kernel zone model', () => {
	const inv = parseStorage(CLAW9);
	assert.equal(disk(inv, 'sda').trim, true, 'the SSD prints TRIM Command: Available');
	assert.equal(disk(inv, 'sdb').trim, null, 'a spinning disk prints no TRIM line: not reported');
	assert.equal(disk(inv, 'sdb').smart.offlineUncorrectable, 0);
	assert.equal(disk(inv, 'sdb').zoned, null, 'this capture predates the zoned line');
	const zoned = parseStorage(
		CLAW9.replace('disk.sdb.kind ata', 'disk.sdb.kind ata\ndisk.sdb.zoned none')
	);
	assert.equal(disk(zoned, 'sdb').zoned, 'none');
	assert.equal(disk(parseStorage(CLAW2), 'nvme0n1').smart.offlineUncorrectable, null);
});
