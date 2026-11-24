import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateTest } from './qualify-registry.mjs';
import { selectDiskForm, withLinkCheck } from './qualify-disk-forms.mjs';
import { describe, makeWipeTest, parseWipe, planWipe, wipeScript } from './qualify-disk-wipe.mjs';

// What claw-10's WD-WCATR9739694 carried before the coordinator wiped it by
// hand (2026-11-24): a dos table and one ntfs partition labelled Storage1.
const LSBLK = JSON.stringify({
	blockdevices: [
		{
			name: 'sda',
			type: 'disk',
			size: 1000204886016,
			fstype: null,
			label: null,
			uuid: null,
			pttype: 'dos',
			children: [
				{
					name: 'sda1',
					type: 'part',
					size: 1000202788864,
					fstype: 'ntfs',
					label: 'Storage1',
					uuid: '2A5C4E6B5C4E3417',
					pttype: 'dos',
				},
			],
		},
	],
});
const SIG = (dev, sigs) =>
	`WIPE_SIG_BEGIN ${dev}\n${sigs.length ? JSON.stringify({ signatures: sigs }) : ''}\nWIPE_SIG_END ${dev}`;
const LISTED = [
	'WIPE_DEV /dev/sda',
	'WIPE_LSBLK_BEGIN',
	LSBLK,
	'WIPE_LSBLK_END',
	SIG('/dev/sda1', [
		{ device: 'sda1', offset: '0x3', type: 'ntfs', uuid: '2A5C4E6B5C4E3417', label: 'Storage1' },
	]),
	SIG('/dev/sda', [{ device: 'sda', offset: '0x1fe', type: 'dos', uuid: null, label: null }]),
];

void test('the listing records type, label, uuid and size, and says it in words', () => {
	const w = parseWipe([...LISTED, 'WIPE_END'].join('\n'));
	assert.equal(w.complete, true);
	assert.equal(w.dev, '/dev/sda');
	assert.deepEqual(
		w.signatures.map((x) => [x.device, x.type, x.label]),
		[
			['sda1', 'ntfs', 'Storage1'],
			['sda', 'dos', null],
		]
	);
	assert.equal(w.partitions[0].sizeBytes, 1000202788864);
	assert.equal(
		describe(w),
		'a dos partition table; sda1 ntfs "Storage1" 1000.2 GB; signatures: ntfs, dos'
	);
	assert.match(describe(parseWipe('WIPE_DEV /dev/sda\nWIPE_END')), /^nothing/);
});

void test('the script lists without --confirm and writes only with it', () => {
	const plan = wipeScript({ serial: 'WD-WCATR9739694', apply: false });
	assert.doesNotMatch(plan, /wipefs -a/);
	const apply = wipeScript({ serial: 'WD-WCATR9739694', apply: true });
	assert.match(apply, /for p in \$parts; do wipefs -a "\$p"/);
	assert.ok(
		apply.indexOf('wipefs -a "$p"') < apply.indexOf('wipefs -a "$dev"'),
		'partitions first'
	);
	assert.ok(apply.indexOf('is mounted') < apply.indexOf('wipefs -a'), 'every guard before a write');
	assert.throws(() => wipeScript({ serial: "x'; rm -rf /", apply: true }));
});

const fakeCtx = (outputs) => {
	const calls = [];
	return {
		calls,
		ctx: {
			node: 'claw-10',
			exec: async (script) => {
				calls.push(script);
				const next = outputs.shift();
				return { ok: true, stdout: typeof next === 'function' ? next(script) : next };
			},
		},
	};
};
const LINK_CLEAN = [
	'DEV sda WD-WCATR9739694 ata2 1:0:1:0',
	'DISK_LINK_BEGIN',
	'LINK_RC 0',
	'DISK_LINK_END',
].join('\n');
const LINK_RESET = LINK_CLEAN.replace(
	'LINK_RC 0',
	'1764011629.0 claw-10 kernel: ata2.01: SRST failed (errno=-16)\nLINK_RC 0'
);

void test('a confirmed wipe passes only when blkid then finds nothing, and records what it cleared', async () => {
	const t = withLinkCheck(makeWipeTest({ serial: 'WD-WCATR9739694' }), ['WD-WCATR9739694']);
	assert.deepEqual(validateTest(t), []);
	const { ctx } = fakeCtx([
		[...LISTED, 'WIPE_AFTER 2', 'WIPE_PARTS_AFTER 0', 'WIPE_END'].join('\n'),
		LINK_CLEAN,
	]);
	const r = await t.run(ctx);
	assert.equal(r.status, 'pass', r.reason);
	assert.match(r.reason, /is blank; it carried a dos partition table; sda1 ntfs "Storage1"/);
	assert.equal(r.metrics.disks[0].found.signatures[0].label, 'Storage1');

	const left = fakeCtx([
		[...LISTED, 'WIPE_AFTER 0', 'WIPE_PARTS_AFTER 0', 'WIPE_END'].join('\n'),
		LINK_CLEAN,
	]);
	assert.equal((await t.run(left.ctx)).status, 'fail');
});

void test('a link error during the wipe rejects the disk; an unread log is never a pass', async () => {
	const t = withLinkCheck(makeWipeTest({ serial: 'WD-WCATR9739694' }), ['WD-WCATR9739694']);
	const done = [...LISTED, 'WIPE_AFTER 2', 'WIPE_PARTS_AFTER 0', 'WIPE_END'].join('\n');
	const reset = await t.run(fakeCtx([done, LINK_RESET]).ctx);
	assert.equal(reset.status, 'fail');
	assert.equal(reset.metrics.disks[0].rejection.rule, 'link');
	assert.equal(reset.metrics.disks[0].rejection.step, 'disk-wipe');
	const blind = await t.run(fakeCtx([done, 'DEV sda WD-WCATR9739694 ata2 1:0:1:0\n']).ctx);
	assert.equal(blind.status, 'could-not-look');
	assert.match(blind.reason, /kernel log was not read/);
});

void test('a refusal on the node writes nothing and is could-not-look', async () => {
	const t = makeWipeTest({ serial: 'WD-WCC6Y3VLV8SU' });
	const r = await t.run(
		fakeCtx(['WIPE_REFUSE /dev/sdb is mounted: /srv/storage/WD-WCC6Y3VLV8SU']).ctx
	);
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /nothing written: .* is mounted/);
	const plan = await planWipe(fakeCtx(['WIPE_REFUSE /dev/sdb is mounted: x']).ctx, 'X1234');
	assert.match(plan.error, /refused on claw-10/);
});

void test('the forms: one step at a time, never --next, the plan writes nothing', async () => {
	const log = () => {};
	const base = { node: 'claw-10', next: false, rejected: () => ({ ok: true, rejected: {} }), log };
	assert.equal(await selectDiskForm({ ...base, argv: ['--json'], planExec: null }), null);
	const both = await selectDiskForm({
		...base,
		argv: ['--disks', '--wipe', 'X1234'],
		planExec: null,
	});
	assert.equal(both.done.code, 2);
	const nxt = await selectDiskForm({ ...base, next: true, argv: ['--disks'], planExec: null });
	assert.equal(nxt.done.code, 2);
	const { ctx, calls } = fakeCtx([[...LISTED, 'WIPE_END'].join('\n')]);
	const plan = await selectDiskForm({
		...base,
		argv: ['--wipe', 'WD-WCATR9739694'],
		planExec: ctx.exec,
	});
	assert.equal(plan.done.doc.status, 'dry-run');
	assert.equal(plan.done.doc.plan.signatures.length, 2);
	assert.doesNotMatch(calls[0], /wipefs -a/);
	const go = await selectDiskForm({
		...base,
		argv: ['--wipe', 'WD-WCATR9739694', '--confirm'],
		planExec: null,
	});
	assert.deepEqual(
		go.tests.map((x) => x.id),
		['disk-wipe']
	);
	const torn = await selectDiskForm({
		...base,
		argv: ['--disks'],
		rejected: () => ({ ok: false, reason: 'torn' }),
		planExec: null,
	});
	assert.equal(torn.done.code, 1);
});
