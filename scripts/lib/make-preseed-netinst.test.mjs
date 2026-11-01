/**
 * §6.1 — the netinst partition, the preseed-initrd cpio, the netinst grub.cfg
 * (#51). Split out of `make-preseed.test.mjs` (wave 5s lane D, 1,000-line
 * test ceiling). See `make-preseed-content.test.mjs` for the rest of this
 * file's original header.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { tempDir } from './test-tmpdir.mjs';
import { LIB, render, sbinEnv } from './make-preseed-fixtures.mjs';

/**
 * §6.1 — the netinst partition (#51).
 *
 * These exercise the partition-reading helpers against a plain sparse FILE,
 * never a block device — `sfdisk`/`blkid -p -O/-S` resolve a GPT partition's
 * byte range identically whether `dev` is `/dev/sdg` or a regular file, which
 * is the property that lets this be proven here without root and without
 * touching CLAWKIT.
 */
function runNetinst(script) {
	return execFileSync('bash', ['-c', `. "${LIB}"; ${script}`], {
		encoding: 'utf8',
		env: sbinEnv(),
	});
}

/**
 * An MBR (`dos`) image shaped like the REAL stick, not an assumption:
 * `lsblk -o NAME,PTTYPE,PARTLABEL,LABEL /dev/sdg` (read-only) shows `PTTYPE
 * dos`, `sdg1 Ventoy/exfat`, `sdg2 VTOYEFI`, `sdg3 CLAWKIT` — because
 * `node-usb-prep.sh` runs `Ventoy2Disk.sh -I -r` with no `-g`. An earlier
 * version of this test built `label: gpt`, which proved a layout the stick
 * does not have: GPT's `name=` field does not exist on a `dos` table at
 * all, so the name-keyed lookup it was testing found nothing on the real
 * device. This builds the four primaries in the real order — Ventoy,
 * VTOYEFI, CLAWKIT, then the netinst partition as the 4th and LAST slot an
 * MBR table has room for.
 */
function makeMbrImage() {
	const dir = tempDir('netinst-img-');
	const img = join(dir, 'disk.img');
	execFileSync('truncate', ['-s', '96MiB', img]);
	execFileSync('sfdisk', [img], { input: 'label: dos\n', env: sbinEnv() });
	execFileSync('sfdisk', ['--append', img], { input: 'size=16MiB\n', env: sbinEnv() }); // Ventoy
	execFileSync('sfdisk', ['--append', img], { input: 'size=8MiB\n', env: sbinEnv() }); // VTOYEFI
	execFileSync('sfdisk', ['--append', img], { input: 'size=16MiB\n', env: sbinEnv() }); // CLAWKIT
	execFileSync('sfdisk', ['--append', img], { input: 'size=40MiB\n', env: sbinEnv() }); // netinst (4th)
	return img;
}

/** The 4th partition's byte offset and size, read independently of the
 * function under test (straight from `sfdisk -d`, matched by device-path
 * suffix, the same way a `dos` table's entries are named — there is no
 * `name=` field to match on instead), so the test does not just check
 * partition_sector_by_number against itself. */
function fourthPartitionRange(img) {
	const dump = execFileSync('sfdisk', ['-d', img], { encoding: 'utf8', env: sbinEnv() });
	const line = dump.split('\n').find((l) => l.startsWith(`${img}4 `) || l.startsWith(`${img}4:`));
	assert.ok(line, 'sfdisk -d did not show a 4th partition');
	const start = Number(line.match(/start= *(\d+)/)[1]);
	const size = Number(line.match(/size= *(\d+)/)[1]);
	return { offset: start * 512, bytes: size * 512 };
}

test('NETINST_PART_NUMBER is 4 — Ventoy, VTOYEFI, CLAWKIT already take 1-3 on the real (MBR) stick', () => {
	const out = runNetinst('printf %s "$NETINST_PART_NUMBER"').trim();
	assert.equal(out, '4');
});

test('partition_sector_by_number finds the 4th partition on a plain MBR FILE, no device required', () => {
	const img = makeMbrImage();
	const { offset, bytes } = fourthPartitionRange(img);
	const out = runNetinst(`partition_sector_by_number '${img}' 4`).trim();
	const [start, size] = out.split(' ').map(Number);
	assert.equal(start * 512, offset);
	assert.equal(size * 512, bytes);
});

test('partition_sector_by_number returns nothing for a partition number that does not exist', () => {
	const img = makeMbrImage();
	const result = execFileSync(
		'bash',
		['-c', `. "${LIB}"; partition_sector_by_number '${img}' 9 && echo FOUND || echo NOTFOUND`],
		{ encoding: 'utf8', env: sbinEnv() }
	).trim();
	assert.equal(result, 'NOTFOUND');
});

test('partition_count reports how many primaries an MBR table already has', () => {
	const img = makeMbrImage();
	const count = runNetinst(`partition_count '${img}'`).trim();
	assert.equal(count, '4', 'Ventoy, VTOYEFI, CLAWKIT, netinst — all four MBR primary slots');
});

test('netinst_partition_bytes reads back exactly what was written at the 4th partition offset', () => {
	const img = makeMbrImage();
	const { offset } = fourthPartitionRange(img);
	const payload = Buffer.from(Array.from({ length: 1024 * 64 }, (_, i) => i % 256));
	const fd = openSync(img, 'r+');
	writeSync(fd, payload, 0, payload.length, offset);
	closeSync(fd);

	const out = execFileSync(
		'bash',
		['-c', `. "${LIB}"; netinst_partition_bytes '${img}' 4 ${payload.length}`],
		{ env: sbinEnv(), maxBuffer: payload.length * 2 }
	);
	assert.deepEqual(out, payload);
});

test('netinst_verify matches the bytes that were written and rejects a single flipped one', () => {
	const img = makeMbrImage();
	const { offset } = fourthPartitionRange(img);
	const payload = randomBytes(1024 * 256);
	const fd = openSync(img, 'r+');
	writeSync(fd, payload, 0, payload.length, offset);
	closeSync(fd);
	const sha256 = createHash('sha256').update(payload).digest('hex');

	const good = runNetinst(
		`netinst_verify '${img}' 4 ${payload.length} ${sha256} && echo MATCH || echo MISMATCH`
	).trim();
	assert.equal(good, 'MATCH');

	// Mutation: flip one byte of the SOURCE checksum's expectation (equivalent
	// to corruption in transit) and the same check must fail.
	const wrongSha = sha256.replace(/^./, sha256[0] === '0' ? '1' : '0');
	const bad = runNetinst(
		`netinst_verify '${img}' 4 ${payload.length} ${wrongSha} && echo MATCH || echo MISMATCH`
	).trim();
	assert.equal(bad, 'MISMATCH');

	// And a FINDING, not a pass, for a partition number that does not exist —
	// could-not-look must never render as nothing-is-wrong.
	const missing = runNetinst(
		`netinst_verify '${img}' 9 ${payload.length} ${sha256} && echo MATCH || echo MISMATCH`
	).trim();
	assert.equal(missing, 'MISMATCH');
});

/**
 * netinst_partition_fs_uuid must resolve to the SAME value GRUB's
 * `search --fs-uuid` would — both read the Primary Volume Descriptor's
 * MODIFICATION date/time field, byte for byte, confirmed by reading
 * grub-core/fs/iso9660.c and libblkid's superblocks/iso9660.c. This builds a
 * minimal, hand-written PVD (no real ISO needed — and no dependency on one
 * happening to exist on whatever machine runs this test) and checks the
 * computed UUID independently of blkid, not merely "whatever blkid says".
 * NONE of this depends on the partition table type — fs-uuid is a property
 * of the filesystem — which is why the fixture can stay MBR throughout.
 */
function buildFakeIso9660Pvd(modified16) {
	assert.equal(modified16.length, 16, 'fixture bug: need exactly 16 ascii digits');
	const buf = Buffer.alloc(2048 * 18, 0);
	const pvd = 2048 * 16;
	buf.writeUInt8(1, pvd); // volume descriptor type: PVD
	buf.write('CD001', pvd + 1, 'ascii');
	buf.writeUInt8(1, pvd + 6); // descriptor version
	buf.write('FLEETTEST'.padEnd(32, ' '), pvd + 40, 'ascii'); // volume id
	buf.write(modified16, pvd + 830, 'ascii'); // modification date/time, 16 digits
	buf.writeUInt8(0, pvd + 830 + 16); // GMT offset byte
	const term = 2048 * 17;
	buf.writeUInt8(255, term); // volume descriptor set terminator
	buf.write('CD001', term + 1, 'ascii');
	buf.writeUInt8(1, term + 6);
	return buf;
}

function expectedIsoUuid(digits16) {
	const g = (a, b) => digits16.slice(a, b);
	return [g(0, 4), g(4, 6), g(6, 8), g(8, 10), g(10, 12), g(12, 14), g(14, 16)].join('-');
}

test('netinst_partition_fs_uuid matches the value computed from the ISO9660 spec, at an arbitrary partition offset', () => {
	const img = makeMbrImage();
	const { offset } = fourthPartitionRange(img);
	const modified = '2026100212003000'; // 2026-10-02 12:00:30.00
	const pvd = buildFakeIso9660Pvd(modified);
	const fd = openSync(img, 'r+');
	writeSync(fd, pvd, 0, pvd.length, offset);
	closeSync(fd);

	const want = expectedIsoUuid(modified);
	const got = runNetinst(`netinst_partition_fs_uuid '${img}' 4`).trim();
	assert.equal(got, want, 'computed independently of blkid, from the ISO9660 spec offsets');

	// And it must be the SAME value blkid itself reports, since that is the
	// claim this function exists to make — not merely a plausible-looking one.
	const { bytes: sizeBytes } = fourthPartitionRange(img);
	const viaBlkid = execFileSync(
		'blkid',
		['-p', '-O', String(offset), '-S', String(sizeBytes), '-o', 'value', '-s', 'UUID', img],
		{ encoding: 'utf8', env: sbinEnv() }
	).trim();
	assert.equal(got, viaBlkid);
});

test('preseed_build_initrd_cpio / preseed_initrd_cpio_read round-trip a preseed byte for byte', () => {
	const content = render({ ssid: 'GarageNet', psk: 'hunter2hunter2' });
	const dir = tempDir('netinst-cpio-');
	const preseed = join(dir, 'preseed.cfg');
	writeFileSync(preseed, content);
	const archive = join(dir, 'preseed-initrd.cpio.gz');
	runNetinst(`preseed_build_initrd_cpio '${preseed}' '${archive}' && echo OK`);
	assert.ok(existsSync(archive));
	const back = runNetinst(`preseed_initrd_cpio_read '${archive}'`);
	assert.equal(back, content);
});

test('preseed_initrd_cpio_read fails closed on a missing or empty archive', () => {
	const dir = tempDir('netinst-cpio-missing-');
	const result = execFileSync(
		'bash',
		[
			'-c',
			`. "${LIB}"; preseed_initrd_cpio_read '${join(dir, 'nope.cpio.gz')}' && echo OK || echo FAIL`,
		],
		{ encoding: 'utf8' }
	).trim();
	assert.equal(result, 'FAIL');
});

test('netinst_meta_write / netinst_meta_read round-trip the recorded ISO identity', () => {
	const dir = tempDir('netinst-meta-');
	const iso = join(dir, 'fake.iso');
	writeFileSync(iso, 'not a real iso, just needs a stable sha\n');
	const mnt = tempDir('netinst-meta-mnt-');
	runNetinst(`netinst_meta_write '${mnt}' '${iso}' 'abcd-ef01-2345'`);
	const name = runNetinst(`netinst_meta_read '${mnt}' name`).trim();
	const fsuuid = runNetinst(`netinst_meta_read '${mnt}' fsuuid`).trim();
	const partition = runNetinst(`netinst_meta_read '${mnt}' partition`).trim();
	const partitionNumber = runNetinst(`netinst_meta_read '${mnt}' partition_number`).trim();
	assert.equal(name, 'fake.iso');
	assert.equal(fsuuid, 'abcd-ef01-2345');
	assert.equal(partition, 'DINSTALL');
	assert.equal(partitionNumber, '4');
});

test("render_netinst_grub_cfg uses the vendor's own append line verbatim, plus a second initrd image, and loads BOTH partition-table drivers", () => {
	const cfg = runNetinst(`render_netinst_grub_cfg 'abcd-ef01' 'install/preseed-initrd.cpio.gz'`);
	// Quoted verbatim from Debian 13.6.0's own boot/grub/grub.cfg "... Automated
	// install" menuentry — confirmed by reading the real ISO (7z x -so), not
	// reinvented here.
	assert.match(
		cfg,
		/linux {2}\(\$isopart\)\/install\.amd\/vmlinuz auto=true priority=critical vga=788 --- quiet/
	);
	assert.match(
		cfg,
		/initrd \(\$isopart\)\/install\.amd\/initrd\.gz \(\$kitpart\)\/install\/preseed-initrd\.cpio\.gz/
	);
	assert.match(cfg, /search --no-floppy --fs-uuid --set=isopart abcd-ef01/);
	assert.match(cfg, /search --no-floppy --label --set=kitpart CLAWKIT/);
	// BOTH `part_msdos` and `part_gpt` — the real stick is MBR (`dos`), but
	// `search --fs-uuid` itself does not care about table type, so loading
	// both costs nothing and keeps this config working if a stick is ever
	// built on a GPT-labelled disk instead.
	for (const mod of [
		'part_msdos',
		'part_gpt',
		'iso9660',
		'ext2',
		'search_fs_uuid',
		'search_label',
	]) {
		assert.match(cfg, new RegExp(`insmod ${mod}`));
	}
});

test('netinst_grub_cfg_is_stale says CURRENT for what this checkout just rendered, STALE for an edited copy, and 2 for garbage', () => {
	const dir = tempDir('netinst-grubcfg-');
	const current = join(dir, 'ventoy_grub.cfg');
	writeFileSync(
		current,
		runNetinst(`render_netinst_grub_cfg 'fixed-uuid-1234' 'install/preseed-initrd.cpio.gz'`)
	);
	const currentStatus = execFileSync(
		'bash',
		['-c', `. "${LIB}"; netinst_grub_cfg_is_stale '${current}'; echo $?`],
		{ encoding: 'utf8' }
	).trim();
	assert.equal(currentStatus, '0');

	const stale = join(dir, 'stale_grub.cfg');
	writeFileSync(
		stale,
		readFileSync(current, 'utf8').replace('insmod ext2\n', 'insmod ext2\ninsmod fat\n')
	);
	const staleStatus = execFileSync(
		'bash',
		['-c', `. "${LIB}"; netinst_grub_cfg_is_stale '${stale}'; echo $?`],
		{ encoding: 'utf8' }
	).trim();
	assert.equal(staleStatus, '1');

	const garbage = join(dir, 'garbage.cfg');
	writeFileSync(garbage, 'not a grub config\n');
	const garbageStatus = execFileSync(
		'bash',
		['-c', `. "${LIB}"; netinst_grub_cfg_is_stale '${garbage}'; echo $?`],
		{ encoding: 'utf8' }
	).trim();
	assert.equal(garbageStatus, '2');
});
