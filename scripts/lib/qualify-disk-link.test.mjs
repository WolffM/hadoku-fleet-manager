import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
	DISK_REJECTIONS_FILE,
	readDiskRejections,
	recordDiskRejections,
	rejectionsIn,
	withRejections,
} from './disk-rejections.mjs';
import { diskQualified } from './garage-layout.mjs';
import { judgeLink, linkReadScript, parseLinkRead, rejectionOf } from './qualify-disk-link.mjs';
import { resultKey } from './qualify-results.mjs';
import { qualifiedFor } from './storage-format.mjs';

// claw-10, 2026-11-24, boot 0 (journalctl -k -o short-unix): the boot probe
// lines, then what enabling SMART on W1F41TH6 (sdb, ata1.00) did.
const CLAW10 = [
	'DEV sda WD-WCATR9739694 ata2 1:0:1:0',
	'DEV sdb W1F41TH6 ata1 0:0:0:0',
	'DEV sdc S625NJ0NC07701T ata2 1:0:0:0',
	'DISK_LINK_BEGIN',
	'1764000975.1 claw-10 kernel: ata2.01: SATA link up 3.0 Gbps (SStatus 123 SControl 300)',
	'1764000975.2 claw-10 kernel: ata1.00: configured for UDMA/133',
	'1764000975.3 claw-10 kernel: ata8: SATA link down (SStatus 0 SControl 300)',
	'1764000975.4 claw-10 kernel: sd 1:0:1:0: [sda] Attached SCSI disk',
	'1764011625.0 claw-10 kernel: ata1.00: link is slow to respond, please be patient (ready=0)',
	'1764011629.0 claw-10 kernel: ata1.00: SRST failed (errno=-16)',
	'1764011675.0 claw-10 kernel: ata1.00: limiting SATA link speed to 1.5 Gbps',
	'1764011680.0 claw-10 kernel: ata1.00: reset failed, giving up',
	'1764011680.1 claw-10 kernel: ata1.00: disable device',
	'1764011680.2 claw-10 kernel: ata1.01: disable device',
	'1764011680.3 claw-10 kernel: sd 0:0:0:0: [sdb] tag#0 FAILED Result: hostbyte=DID_BAD_TARGET driverbyte=DRIVER_OK cmd_age=0s',
	'LINK_RC 0',
	'DISK_LINK_END',
].join('\n');

void test('the claw-10 log rejects W1F41TH6 and leaves the WD Black and the root clean', () => {
	const read = parseLinkRead(CLAW10);
	assert.equal(read.complete, true);
	const st = judgeLink({ serial: 'W1F41TH6' }, read);
	assert.equal(st.verdict, 'fail');
	assert.match(st.reason, /^REJECTED: the kernel logged 6 link error/);
	assert.match(st.reason, /sdb \(ata1\)/);
	// ata1.01 is the optical drive: no block device here, so not W1F41TH6's.
	assert.ok(!st.errors.some((l) => /ata1\.01/.test(l)));

	const wd = judgeLink({ serial: 'WD-WCATR9739694' }, read);
	assert.equal(wd.verdict, 'pass', 'boot probe lines are not errors');
	assert.deepEqual(
		wd.nodeImpact.map((x) => [x.device, x.errors]),
		[['sdb', 6]],
		"another device's errors are node impact, not the candidate's"
	);
	assert.equal(judgeLink({ serial: 'S625NJ0NC07701T' }, read).verdict, 'pass');
});

void test('a port-level reset counts against every device on that port', () => {
	const read = parseLinkRead(
		CLAW10.replace('LINK_RC 0', '1764020000.0 claw-10 kernel: ata2: hard resetting link\nLINK_RC 0')
	);
	assert.equal(judgeLink({ serial: 'WD-WCATR9739694' }, read).verdict, 'fail');
	assert.equal(judgeLink({ serial: 'S625NJ0NC07701T' }, read).verdict, 'fail');
	// ata2 is not ata20.
	const other = parseLinkRead(
		CLAW10.replace(
			'LINK_RC 0',
			'1764020000.0 claw-10 kernel: ata20: hard resetting link\nLINK_RC 0'
		)
	);
	assert.equal(judgeLink({ serial: 'WD-WCATR9739694' }, other).verdict, 'pass');
});

void test('a read that did not finish, or no journal, is blocked, never a pass', () => {
	const cut = parseLinkRead(CLAW10.replace(/LINK_RC 0\nDISK_LINK_END/, ''));
	assert.equal(judgeLink({ serial: 'W1F41TH6' }, cut).verdict, 'blocked');
	const failed = parseLinkRead(CLAW10.replace('LINK_RC 0', 'LINK_RC 1'));
	assert.match(judgeLink({ serial: 'W1F41TH6' }, failed).reason, /exited 1/);
	const none = parseLinkRead('DEV sdb W1F41TH6 ata1 0:0:0:0\nLINK_NO_JOURNAL\n');
	assert.equal(judgeLink({ serial: 'W1F41TH6' }, none).verdict, 'blocked');
	assert.match(judgeLink({ serial: 'NOPE' }, parseLinkRead(CLAW10)).reason, /0 block devices/);
});

void test('an NVMe controller timeout is the NVMe disk', () => {
	const read = parseLinkRead(
		[
			'DEV nvme0n1 S6S2NS0TB21436H - -',
			'DISK_LINK_BEGIN',
			'1764000000.0 claw-8 kernel: nvme nvme0: I/O 12 QID 3 timeout, aborting',
			'LINK_RC 0',
			'DISK_LINK_END',
		].join('\n')
	);
	assert.equal(judgeLink({ serial: 'S6S2NS0TB21436H' }, read).verdict, 'fail');
});

void test('the read script windows the log and refuses a bad window', () => {
	assert.match(linkReadScript({ sinceSec: 1764011600 }), /--since=@1764011600/);
	assert.doesNotMatch(linkReadScript(), /--since/);
	assert.throws(() => linkReadScript({ sinceSec: 'now; rm -rf /' }), /bad sinceSec/);
});

void test('a rejection persists by serial, and format and layout refuse the disk', () => {
	const dir = mkdtempSync(join(tmpdir(), 'disk-rej-'));
	try {
		const link = judgeLink({ serial: 'W1F41TH6' }, parseLinkRead(CLAW10));
		const results = [
			{
				id: 'disk-link',
				metrics: {
					disks: [
						{ serial: 'W1F41TH6', rejection: rejectionOf('W1F41TH6', link, 'disk-link') },
						{ serial: 'WD-WCATR9739694', rejection: null },
					],
				},
			},
		];
		assert.equal(rejectionsIn(results).length, 1);
		const first = recordDiskRejections(dir, 'claw-10', results, 'T-first');
		assert.deepEqual(first, { ok: true, added: ['W1F41TH6'] });
		// Seen again: kept, never re-dated.
		assert.deepEqual(recordDiskRejections(dir, 'claw-10', results, 'T-later'), {
			ok: true,
			added: [],
		});
		const rej = readDiskRejections(dir);
		assert.equal(rej.rejected.W1F41TH6.at, 'T-first');
		assert.equal(rej.rejected.W1F41TH6.rule, 'link');

		const pass = { last: { at: 'T', status: 'pass', metrics: { disks: [] } } };
		const all = (serial, root = false) =>
			Object.fromEntries(
				['disk-smr', 'disk-smart', 'disk-burnin'].map((id) => [
					resultKey('claw-10', id),
					{
						last: {
							...pass.last,
							metrics: root
								? { rootDisk: { serial, verdict: 'pass' } }
								: { disks: [{ serial, verdict: 'pass' }] },
						},
					},
				])
			);
		const ledger = withRejections({ ok: true, results: all('W1F41TH6') }, rej);
		assert.match(qualifiedFor(ledger, 'claw-10', 'W1F41TH6').reason, /rejected .* link rule/);
		const wd = withRejections({ ok: true, results: all('WD-WCATR9739694') }, rej);
		assert.deepEqual(qualifiedFor(wd, 'claw-10', 'WD-WCATR9739694'), { ok: true });
		// A rejected ROOT disk is refused as a root zone too.
		const root = withRejections({ ok: true, results: all('W1F41TH6', true) }, rej);
		assert.match(
			diskQualified(root, 'claw-10', { serial: null, root: true, capacityBytes: 1 }).why,
			/rejected/
		);

		// Unreadable record: the ledger is unreadable, never "nothing rejected".
		writeFileSync(join(dir, DISK_REJECTIONS_FILE), '{torn');
		const torn = withRejections({ ok: true, results: {} }, readDiskRejections(dir));
		assert.equal(torn.ok, false);
		assert.equal(recordDiskRejections(dir, 'claw-10', results, 'T').ok, false);
		assert.equal(
			readFileSync(join(dir, DISK_REJECTIONS_FILE), 'utf8'),
			'{torn',
			'never overwritten'
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
