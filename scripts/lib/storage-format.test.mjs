import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nodeStatus } from './qualify-disk-inventory.mjs';
import { mergeQualifyResults } from './qualify-results.mjs';
import { CLAW10, CLAW4, CLAW9 } from './storage-fixtures.mjs';
import { parseStorage } from './storage-inventory.mjs';
import {
	DISK_QUALIFY_TESTS,
	REFUSED_EXIT,
	convergeNode,
	formatScript,
	judgeDisk,
	mountPointFor,
	planNode,
	qualifiedFor,
	rootWrapped,
} from './storage-format.mjs';

const C9 = parseStorage(CLAW9);
const C10 = parseStorage(CLAW10);
const C4 = parseStorage(CLAW4);
const disk = (inv, dev) => inv.disks.find((d) => d.device === dev);

/** A ledger in which F2 judged `serials` on `node` with `verdict` for every disk test. */
function ledger(node, serials, verdict = 'pass', overrides = {}) {
	const results = {};
	for (const id of DISK_QUALIFY_TESTS) {
		const v = overrides[id] ?? verdict;
		results[`${node}::${id}`] = {
			last: {
				at: new Date(Date.now() - 3_600_000).toISOString(),
				status: v === 'pass' ? 'pass' : 'fail',
				reason: 'fixture',
				metrics: { disks: serials.map((serial) => ({ serial, verdict: v, reason: `${id} ${v}` })) },
			},
			lastPass: null,
		};
	}
	return { ok: true, results };
}
const EMPTY = { ok: true, results: {} };

describe('qualifiedFor: F2 verdicts by serial', () => {
	it('no ledger entry is "not qualified", never a pass', () => {
		const q = qualifiedFor(EMPTY, 'claw-9', 'SERIAL-claw-9-sdb');
		assert.equal(q.ok, false);
		assert.match(q.reason, /^not qualified: no disk-smr result for claw-9/);
	});
	it('an unreadable ledger is not qualified, with its reason', () => {
		const q = qualifiedFor({ ok: false, reason: 'bad json' }, 'claw-9', 'X');
		assert.deepEqual(q, { ok: false, reason: 'not qualified: bad json' });
	});
	it('every disk test must pass THIS serial', () => {
		assert.equal(
			qualifiedFor(ledger('claw-9', ['SERIAL-claw-9-sdb']), 'claw-9', 'SERIAL-claw-9-sdb').ok,
			true
		);
		const other = qualifiedFor(ledger('claw-9', ['SOMEONE-ELSE']), 'claw-9', 'SERIAL-claw-9-sdb');
		assert.match(other.reason, /did not judge SERIAL-claw-9-sdb/);
		const burn = qualifiedFor(
			ledger('claw-9', ['SERIAL-claw-9-sdb'], 'pass', { 'disk-burnin': 'fail' }),
			'claw-9',
			'SERIAL-claw-9-sdb'
		);
		assert.match(burn.reason, /disk-burnin .* says fail/);
		const blocked = qualifiedFor(
			ledger('claw-9', ['SERIAL-claw-9-sdb'], 'pass', { 'disk-smart': 'blocked' }),
			'claw-9',
			'SERIAL-claw-9-sdb'
		);
		assert.match(blocked.reason, /disk-smart .* says blocked/);
	});
});

describe('qualifiedFor reads the ledger F2 actually writes', () => {
	it('a ledger built by nodeStatus + mergeQualifyResults: pass, then a burn-in fail', () => {
		const at = new Date().toISOString();
		const disks = (v) => [
			{ serial: 'WD-A', device: 'sdb', verdict: v, reason: 'r' },
			{ serial: 'WD-B', device: 'sdc', verdict: 'fail', reason: 'SMR' },
		];
		const window = (burn) =>
			DISK_QUALIFY_TESTS.map((id) => ({
				id,
				...nodeStatus(id, disks(id === 'disk-burnin' ? burn : 'pass')),
			}));
		let results = mergeQualifyResults({}, 'claw-9', window('pass'), at);
		const L = () => ({ ok: true, results });
		assert.equal(qualifiedFor(L(), 'claw-9', 'WD-A').ok, true);
		assert.match(qualifiedFor(L(), 'claw-9', 'WD-B').reason, /says fail/);
		results = mergeQualifyResults(results, 'claw-9', window('fail'), at);
		assert.match(
			qualifiedFor(L(), 'claw-9', 'WD-A').reason,
			/disk-burnin .* says fail/,
			'the NEWEST result decides'
		);
	});
});

describe('judgeDisk: the refusals, on real-node fixtures', () => {
	it('claw-9 sdb (blank WD10EZEX) is refused until F2 qualifies it', () => {
		const j = judgeDisk({ node: 'claw-9', inventory: C9, disk: disk(C9, 'sdb'), ledger: EMPTY });
		assert.equal(j.verdict, 'refused');
		assert.deepEqual(j.reasons, ['not qualified: no disk-smr result for claw-9']);
		assert.equal(j.script, null);
	});
	it('claw-9 sdb, qualified, would format and names itself by serial', () => {
		const j = judgeDisk({
			node: 'claw-9',
			inventory: C9,
			disk: disk(C9, 'sdb'),
			ledger: ledger('claw-9', ['SERIAL-claw-9-sdb']),
		});
		assert.equal(j.verdict, 'would-format');
		assert.deepEqual(j.reasons, []);
		assert.match(j.script, /^SERIAL='SERIAL-claw-9-sdb'$/m);
		assert.match(j.script, /^MNT='\/srv\/storage\/SERIAL-claw-9-sdb'$/m);
		assert.match(j.script, /UUID=\$UUID \$MNT ext4 defaults,nofail,/);
	});
	it('the root disk is refused even when qualified', () => {
		const j = judgeDisk({
			node: 'claw-9',
			inventory: C9,
			disk: disk(C9, 'sda'),
			ledger: ledger('claw-9', ['SERIAL-claw-9-sda']),
			wipeSignature: true,
		});
		assert.equal(j.verdict, 'refused');
		assert.ok(j.reasons.includes('the root disk'));
		assert.ok(j.reasons.some((r) => r.startsWith('mounted: ')));
	});
	it("claw-10's NTFS disks are refused without --wipe-signature, qualified or not", () => {
		for (const dev of ['sdb', 'sdc']) {
			const d = disk(C10, dev);
			const unq = judgeDisk({ node: 'claw-10', inventory: C10, disk: d, ledger: EMPTY });
			assert.equal(unq.verdict, 'refused');
			assert.ok(
				unq.reasons.some((r) => /ntfs.*refused without --wipe-signature/.test(r)),
				unq.reasons
			);
			assert.ok(unq.reasons.some((r) => r.startsWith('not qualified')));
			const q = judgeDisk({
				node: 'claw-10',
				inventory: C10,
				disk: d,
				ledger: ledger('claw-10', [d.serial]),
			});
			assert.equal(q.verdict, 'refused');
			const wipe = judgeDisk({
				node: 'claw-10',
				inventory: C10,
				disk: d,
				ledger: ledger('claw-10', [d.serial]),
				wipeSignature: true,
			});
			assert.equal(wipe.verdict, 'would-format');
			assert.match(wipe.reasons[0], /^will WIPE .*ntfs/);
			assert.match(wipe.script, /^WIPE=1$/m);
		}
	});
	it("a serial two disks share is refused (claw-4's card readers)", () => {
		const d = disk(C4, 'sdc');
		const j = judgeDisk({
			node: 'claw-4',
			inventory: C4,
			disk: d,
			ledger: ledger('claw-4', [d.serial]),
		});
		assert.ok(j.reasons.some((r) => /shared by more than one disk/.test(r)));
	});
	it('no serial, an unsafe serial, an unlooked-at disk, a mounted disk: each refused', () => {
		const base = { ...disk(C9, 'sdb') };
		const L = ledger('claw-9', ['SERIAL-claw-9-sdb', 'a b; rm -rf /']);
		const cases = [
			[{ serial: null }, /no serial/],
			[{ serial: 'a b; rm -rf /' }, /not a safe path word/],
			[{ blank: null }, /not looked at is not blank/],
			[{ mounted: true, mountpoints: ['/mnt/x'] }, /mounted: \/mnt\/x/],
			[{ mediaPresent: false, sizeBytes: 0 }, /no media/],
		];
		for (const [patch, re] of cases) {
			const d = { ...base, ...patch };
			const inv = { ...C9, disks: [disk(C9, 'sda'), d] };
			const j = judgeDisk({ node: 'claw-9', inventory: inv, disk: d, ledger: L });
			assert.equal(j.verdict, 'refused', JSON.stringify(patch));
			assert.ok(
				j.reasons.some((r) => re.test(r)),
				`${re}: ${j.reasons}`
			);
		}
	});
	it('a disk already mounted at its fleet path is converged, not refused', () => {
		const d = {
			...disk(C9, 'sdb'),
			mounted: true,
			mountpoints: [mountPointFor('SERIAL-claw-9-sdb')],
		};
		const j = judgeDisk({
			node: 'claw-9',
			inventory: { ...C9, disks: [d] },
			disk: d,
			ledger: EMPTY,
		});
		assert.equal(j.verdict, 'converged');
	});
	it('only ext4 and xfs', () => {
		const j = judgeDisk({
			node: 'claw-9',
			inventory: C9,
			disk: disk(C9, 'sdb'),
			ledger: ledger('claw-9', ['SERIAL-claw-9-sdb']),
			fs: 'btrfs',
		});
		assert.equal(j.verdict, 'refused');
		const x = judgeDisk({
			node: 'claw-9',
			inventory: C9,
			disk: disk(C9, 'sdb'),
			ledger: ledger('claw-9', ['SERIAL-claw-9-sdb']),
			fs: 'xfs',
		});
		assert.match(x.script, /mkfs\.xfs/);
	});
	it('planNode lists candidates only: never the root disk unless named', () => {
		assert.deepEqual(
			planNode({ node: 'claw-9', inventory: C9, ledger: EMPTY }).map((d) => d.device),
			['sdb']
		);
	});
});

describe('convergeNode: never acts without --confirm and a matching disk', () => {
	const calls = () => ({ hold: 0, run: 0 });
	const depsFor = (inv, L, c) => ({
		readInventory: async () => ({ ok: true, inventory: inv }),
		readLedger: () => L,
		hold: async (node, reason, act) => {
			c.hold++;
			return { status: 'measured', result: await act(), heldBy: 'bootcamp' };
		},
		runRoot: async () => {
			c.run++;
			return { ok: true, stdout: 'FORMATTED x\n', stderr: '' };
		},
	});
	const L = ledger('claw-9', ['SERIAL-claw-9-sdb']);

	it('no --confirm: a dry run, nothing held, nothing run', async () => {
		const c = calls();
		const r = await convergeNode({
			node: 'claw-9',
			disk: 'SERIAL-claw-9-sdb',
			deps: depsFor(C9, L, c),
		});
		assert.equal(r.status, 'dry-run');
		assert.deepEqual(c, { hold: 0, run: 0 });
	});
	it('--confirm without --disk: still a dry run', async () => {
		const c = calls();
		const r = await convergeNode({ node: 'claw-9', confirm: true, deps: depsFor(C9, L, c) });
		assert.equal(r.status, 'dry-run');
		assert.deepEqual(c, { hold: 0, run: 0 });
	});
	it('--confirm with a serial the node does not have: refused, nothing run', async () => {
		const c = calls();
		const r = await convergeNode({
			node: 'claw-9',
			disk: 'SERIAL-claw-9-sdX',
			confirm: true,
			deps: depsFor(C9, L, c),
		});
		assert.equal(r.status, 'refused');
		assert.match(r.reason, /no disk with serial SERIAL-claw-9-sdX/);
		assert.deepEqual(c, { hold: 0, run: 0 });
	});
	it('--confirm on the root disk, or an unqualified one: refused, nothing run', async () => {
		for (const [d, l] of [
			['SERIAL-claw-9-sda', ledger('claw-9', ['SERIAL-claw-9-sda'])],
			['SERIAL-claw-9-sdb', EMPTY],
		]) {
			const c = calls();
			const r = await convergeNode({
				node: 'claw-9',
				disk: d,
				confirm: true,
				wipeSignature: true,
				deps: depsFor(C9, l, c),
			});
			assert.equal(r.status, 'refused', d);
			assert.deepEqual(c, { hold: 0, run: 0 });
		}
	});
	it('--confirm on an NTFS disk without --wipe-signature: refused', async () => {
		const c = calls();
		const r = await convergeNode({
			node: 'claw-10',
			disk: 'SERIAL-claw-10-sdb',
			confirm: true,
			deps: depsFor(C10, ledger('claw-10', ['SERIAL-claw-10-sdb']), c),
		});
		assert.equal(r.status, 'refused');
		assert.deepEqual(c, { hold: 0, run: 0 });
	});
	it('--confirm on a qualified blank disk: runs once, inside the hold', async () => {
		const c = calls();
		const r = await convergeNode({
			node: 'claw-9',
			disk: 'SERIAL-claw-9-sdb',
			confirm: true,
			deps: depsFor(C9, L, c),
		});
		assert.equal(r.status, 'formatted');
		assert.deepEqual(c, { hold: 1, run: 1 });
	});
	it('the node script refusing is `refused`; a hold that never opened is could-not-look', async () => {
		const c = calls();
		const deps = depsFor(C9, L, c);
		deps.runRoot = async () => ({
			ok: false,
			stdout: '',
			stderr: 'REFUSED x on claw-9: mounted: /mnt\n',
			error: 'exit 3',
		});
		assert.equal(
			(await convergeNode({ node: 'claw-9', disk: 'SERIAL-claw-9-sdb', confirm: true, deps }))
				.status,
			'refused'
		);
		deps.hold = async () => ({ status: 'inconclusive', reason: 'never went quiet' });
		const r = await convergeNode({
			node: 'claw-9',
			disk: 'SERIAL-claw-9-sdb',
			confirm: true,
			deps,
		});
		assert.equal(r.status, 'could-not-look');
		assert.equal(r.reason, 'never went quiet');
	});
	it('an unreadable probe is could-not-look', async () => {
		const r = await convergeNode({
			node: 'claw-9',
			deps: { readInventory: async () => ({ ok: false, reason: 'ssh: timeout' }) },
		});
		assert.deepEqual([r.status, r.reason], ['could-not-look', 'ssh: timeout']);
	});
});

describe('formatScript: the node re-checks everything before its first write', () => {
	const dirs = [];
	after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

	// Stubs for every block-device tool. Each logs its argv; lsblk answers from
	// the STUB_* environment, as the node would at that moment.
	const LSBLK = `#!/bin/sh
echo "lsblk $*" >> "$STUB/log"
dev=""; for a in "$@"; do case $a in /dev/*) dev=\${a#/dev/} ;; esac; done
case "$*" in
  "-dnpo NAME") for p in $STUB_DISKS; do echo "/dev/\${p%%=*}"; done ;;
  "-dno SERIAL "*) for p in $STUB_DISKS; do [ "\${p%%=*}" = "$dev" ] && echo "\${p#*=}  "; done ;;
  "-dno TYPE "*) echo disk ;;
  "-nro MOUNTPOINT "*) echo ""; [ -n "\${STUB_MOUNT:-}" ] && echo "$STUB_MOUNT"; true ;;
  "-nro NAME "*) echo "$dev"; [ -n "\${STUB_PARTS:-}" ] && echo "$STUB_PARTS"; true ;;
  "-nrpo NAME,TYPE "*) echo "/dev/$dev disk"; [ -e "$STUB/parted" ] && echo "/dev/\${dev}1 part"; true ;;
esac
`;
	const LOGGER = (name, body = '') => `#!/bin/sh\necho "${name} $*" >> "$STUB/log"\n${body}\n`;
	const stubs = {
		lsblk: LSBLK,
		wipefs: LOGGER(
			'wipefs',
			'case "$1" in --noheadings) [ -n "${STUB_SIG:-}" ] && echo "$STUB_SIG"; true ;; esac'
		),
		sfdisk: LOGGER('sfdisk', 'cat > "$STUB/sfdisk.in"; touch "$STUB/parted"'),
		udevadm: LOGGER('udevadm'),
		'mkfs.ext4': LOGGER('mkfs.ext4'),
		blkid: LOGGER('blkid', 'echo 1111-uuid'),
		findmnt: LOGGER('findmnt', 'echo 1111-uuid'),
		install: LOGGER('install'),
		chattr: LOGGER('chattr'),
		cp: LOGGER('cp'),
		systemctl: LOGGER('systemctl'),
		mount: LOGGER('mount'),
		getent: LOGGER('getent', 'exit 2'),
		useradd: LOGGER('useradd'),
	};
	const WRITES = /^(wipefs -a|sfdisk|mkfs|install|chattr|cp|mount|useradd|systemctl)/m;

	function run(env, { wipe = false, fstab = '', drop = null } = {}) {
		const stub = mkdtempSync(join(tmpdir(), 'storage-format-'));
		dirs.push(stub);
		mkdirSync(join(stub, 'bin'));
		mkdirSync(join(stub, 'sys', 'sdb', 'holders'), { recursive: true });
		for (const [n, body] of Object.entries(stubs)) {
			if (n === drop) continue;
			writeFileSync(join(stub, 'bin', n), body);
			chmodSync(join(stub, 'bin', n), 0o755);
		}
		writeFileSync(join(stub, 'fstab'), fstab);
		writeFileSync(join(stub, 'log'), '');
		if (env.holder) writeFileSync(join(stub, 'sys', 'sdb', 'holders', env.holder), '');
		const script = formatScript({ serial: 'WD-ABC123', device: '/dev/sdb', wipeSignature: wipe })
			.replace("FSTAB='/etc/fstab'", `FSTAB='${join(stub, 'fstab')}'`)
			.replace("SYSBLOCK='/sys/block'", `SYSBLOCK='${join(stub, 'sys')}'`);
		const r = spawnSync('sh', ['-c', script], {
			encoding: 'utf8',
			env: {
				// No /usr/sbin: the real parted, mkfs and wipefs never answer here.
				PATH: `${join(stub, 'bin')}:/usr/bin:/bin`,
				STUB: stub,
				STUB_DISKS: 'sda=ROOT-1 sdb=WD-ABC123',
				...env,
			},
		});
		return {
			...r,
			stub,
			log: readFileSync(join(stub, 'log'), 'utf8'),
			fstab: readFileSync(join(stub, 'fstab'), 'utf8'),
		};
	}

	it('the script under test really is the one shipped (only FSTAB/SYSBLOCK differ)', () => {
		const s = formatScript({ serial: 'WD-ABC123', device: '/dev/sdb' });
		assert.equal(s.match(/\/etc\/fstab/g).length, 1);
		assert.equal(s.match(/\/sys\/block/g).length, 1);
	});

	const refusals = [
		[
			'the serial is on another device now',
			{ STUB_DISKS: 'sda=ROOT-1 sdc=WD-ABC123' },
			/serial is \/dev\/sdc now/,
		],
		['no disk carries the serial', { STUB_DISKS: 'sda=ROOT-1 sdb=WD-OTHER' }, /matches 0 disks/],
		['two disks carry it', { STUB_DISKS: 'sdb=WD-ABC123 sdc=WD-ABC123' }, /matches 2 disks/],
		['a partition is mounted', { STUB_MOUNT: '/data' }, /mounted: \/data/],
		['it is swap', { STUB_MOUNT: '[SWAP]' }, /mounted: \[SWAP\]/],
		['a device-mapper holder', { holder: 'dm-0' }, /held by dm-0/],
		['a signature', { STUB_SIG: 'ntfs' }, /needs --wipe-signature/],
		['a partition', { STUB_PARTS: 'sdb1' }, /needs --wipe-signature/],
	];
	for (const [what, env, re] of refusals) {
		it(`refuses, having written nothing, when ${what}`, () => {
			const r = run(env);
			assert.equal(r.status, REFUSED_EXIT, r.stderr);
			assert.match(r.stderr, /^REFUSED WD-ABC123 on /m);
			assert.match(r.stderr, re);
			assert.doesNotMatch(r.log, WRITES);
			assert.equal(r.fstab, '');
		});
	}
	it('refuses, having written nothing, when a tool it needs is missing', () => {
		const r = run({}, { drop: 'sfdisk' });
		assert.equal(r.status, REFUSED_EXIT, r.stderr);
		assert.match(r.stderr, /sfdisk is not installed/);
		assert.doesNotMatch(r.log, WRITES);
	});
	it('refuses when fstab already names the mount point', () => {
		const line = `UUID=old ${mountPointFor('WD-ABC123')} ext4 defaults 0 2\n`;
		const r = run({}, { fstab: line });
		assert.equal(r.status, REFUSED_EXIT);
		assert.doesNotMatch(r.log, WRITES);
		assert.equal(r.fstab, line);
	});
	it('mounted still refuses with --wipe-signature', () => {
		const r = run({ STUB_MOUNT: '/data', STUB_SIG: 'ext4' }, { wipe: true });
		assert.equal(r.status, REFUSED_EXIT);
		assert.doesNotMatch(r.log, WRITES);
	});
	it('a blank disk whose serial matches: GPT, mkfs, fstab by UUID with nofail, mount, garage dir', () => {
		const r = run({});
		assert.equal(r.status, 0, r.stderr);
		const writes = r.log.split('\n').filter((l) => WRITES.test(l));
		assert.deepEqual(
			writes.map((l) => l.split(' ')[0]),
			[
				'sfdisk',
				'wipefs',
				'mkfs.ext4',
				'install',
				'chattr',
				'cp',
				'systemctl',
				'mount',
				'useradd',
				'install',
			]
		);
		assert.match(
			r.log,
			/^wipefs -a \/dev\/sdb1$/m,
			'only the NEW partition is wiped, not the disk'
		);
		assert.match(r.log, /^sfdisk --quiet \/dev\/sdb$/m);
		assert.equal(
			readFileSync(join(r.stub, 'sfdisk.in'), 'utf8'),
			'label: gpt\nname=fleet-storage, type=linux\n'
		);
		assert.match(
			r.fstab,
			/^UUID=1111-uuid \/srv\/storage\/WD-ABC123 ext4 defaults,nofail,noatime,x-systemd.device-timeout=30s 0 2$/m
		);
		assert.match(r.log, /^chattr \+i \/srv\/storage\/WD-ABC123$/m);
		assert.match(
			r.log,
			/^install -d -m 0750 -o garage -g garage \/srv\/storage\/WD-ABC123\/garage$/m
		);
		assert.match(
			r.stdout,
			/^FORMATTED WD-ABC123 \/dev\/sdb1 1111-uuid \/srv\/storage\/WD-ABC123$/m
		);
	});
	it('--wipe-signature wipes the old signature, then formats', () => {
		const r = run({ STUB_SIG: 'ntfs' }, { wipe: true });
		assert.equal(r.status, 0, r.stderr);
		assert.ok(r.log.indexOf('wipefs -a /dev/sdb\n') < r.log.indexOf('sfdisk'));
	});
	it('the partition table the script asks sfdisk for is real: one GPT partition, 1 MiB to the end', () => {
		// The real sfdisk, on a regular file: no device, no privilege.
		const dir = mkdtempSync(join(tmpdir(), 'storage-format-img-'));
		dirs.push(dir);
		const img = join(dir, 'img');
		writeFileSync(img, '');
		execFileSync('truncate', ['-s', '64M', img]);
		const input = formatScript({ serial: 'WD-1', device: '/dev/sdb' }).match(
			/printf '([^']+)' \| sfdisk/
		)[1];
		const sfdisk =
			['/usr/sbin/sfdisk', '/sbin/sfdisk'].find((p) => spawnSync(p, ['--version']).status === 0) ??
			'sfdisk';
		execFileSync(sfdisk, ['--quiet', img], { input: input.replaceAll('\\n', '\n') });
		const dump = execFileSync(sfdisk, ['--dump', img], { encoding: 'utf8' });
		assert.match(dump, /^label: gpt$/m);
		const parts = dump.split('\n').filter((l) => l.startsWith(img));
		assert.equal(parts.length, 1);
		assert.match(
			parts[0],
			/start=\s+2048, size=\s+126976, type=0FC63DAF-8483-4772-8E79-3D69D8477DE4.*name="fleet-storage"/
		);
	});
	it('rootWrapped feeds the script to sudo sh on stdin, quoted', () => {
		const w = rootWrapped('echo hi');
		assert.equal(w, "sudo -n sh -s <<'STORAGE_FORMAT_EOF'\necho hi\nSTORAGE_FORMAT_EOF");
		assert.equal(
			execFileSync('sh', ['-n', '-c', formatScript({ serial: 'WD-1', device: '/dev/sdb' })]).length,
			0
		);
	});
	it('formatScript refuses an unsafe serial or device outright', () => {
		assert.throws(
			() => formatScript({ serial: "x'; rm -rf / #", device: '/dev/sdb' }),
			/unsafe serial/
		);
		assert.throws(
			() => formatScript({ serial: 'WD-1', device: '/dev/sdb; reboot' }),
			/unsafe device/
		);
	});
});
