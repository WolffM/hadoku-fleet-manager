/**
 * The refusals that stand between `fleet usb-prep` and someone's root disk.
 *
 * These are testable at all only because the guards take OBSERVED VALUES rather
 * than devices — no function in usb-device-guard.sh opens a block device, reads
 * /sys or shells out to lsblk. `node-usb-prep.sh` observes; these decide. That
 * split is what turns "cannot be tested without hardware" into "is tested on
 * every commit".
 *
 * THE CASE THIS SUITE EXISTS FOR is `usb_guard_not_root_disk` with an EMPTY
 * list. The original script's own comment records it: `lsblk -no PKNAME`
 * returns empty for hokon's btrfs -> LVM -> LUKS -> nvme root, so the guard
 * compared against "" and PASSED FOR EVERY DEVICE, including the root disk.
 * Nothing about that is visible from reading the code, and no fixture built from
 * a working node reproduces it. It needs a test that hands the guard nothing
 * and demands a refusal.
 *
 * Each case is aimed where the guard LOOKS (handoff §4): the arguments are
 * otherwise valid, so deleting the branch under test makes the call succeed and
 * the assertion fail.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GUARD = fileURLToPath(new URL('usb-device-guard.sh', import.meta.url));

/**
 * Call one guard with the given arguments and return its verdict.
 *
 * Runs the REAL file rather than a copy of its logic. A test that reimplemented
 * the checks in JavaScript would pass forever while the shell drifted.
 */
function guard(fn, ...args) {
	const r = spawnSync('bash', ['-c', `set -u; . "$0"; ${fn} "$@"`, GUARD, ...args], {
		encoding: 'utf8',
	});
	if (r.error) throw r.error;
	return { ok: r.status === 0, status: r.status, why: `${r.stderr}${r.stdout}` };
}

// ── whole disk vs partition ─────────────────────────────────────────────────

test('a whole disk is accepted', () => {
	assert.ok(guard('usb_guard_whole_disk', '/dev/sdb').ok);
});

test('a PARTITION is refused — we repartition, and /dev/sdb1 means /dev/sdb', () => {
	const r = guard('usb_guard_whole_disk', '/dev/sdb1');
	assert.equal(r.ok, false);
	assert.match(r.why, /looks like a PARTITION/);
});

test('no device at all is refused; nothing is ever guessed', () => {
	const r = guard('usb_guard_whole_disk', '');
	assert.equal(r.ok, false);
	assert.match(r.why, /NEVER guessed/);
});

// ── removable ───────────────────────────────────────────────────────────────

test('removable=1 passes, removable=0 refuses', () => {
	assert.ok(guard('usb_guard_removable', '1', '/dev/sdb').ok);
	const r = guard('usb_guard_removable', '0', '/dev/sdb');
	assert.equal(r.ok, false);
	assert.match(r.why, /NOT flagged removable/);
});

test('an UNREADABLE removable flag refuses — "I could not look" is not "yes"', () => {
	// /sys/block/<name>/removable does not exist for a device that is not there.
	// Treating the empty read as anything but a refusal is how a typo'd device
	// name reaches the partitioner.
	const r = guard('usb_guard_removable', '', '/dev/sdz');
	assert.equal(r.ok, false);
	assert.match(r.why, /could not read the removable flag/);
});

// ── the root disk ───────────────────────────────────────────────────────────

test('an EMPTY root-disk list REFUSES — this is the bug the original had', () => {
	// `lsblk -no PKNAME` returned empty for a btrfs -> LVM -> LUKS -> nvme root,
	// the loop ran zero times, and the guard passed for the root disk itself.
	// With the empty-list branch deleted this call succeeds, which is exactly the
	// silent pass being pinned.
	const r = guard('usb_guard_not_root_disk', 'sdb');
	assert.equal(r.ok, false);
	assert.match(r.why, /could not resolve which disk \/ lives on/);
});

test('a root-disk list of one empty string also refuses', () => {
	// The other shape the same failed read takes: one argument that is "".
	const r = guard('usb_guard_not_root_disk', 'sdb', '');
	assert.equal(r.ok, false);
	assert.match(r.why, /could not resolve/);
});

test('the root disk itself is refused, even at the end of a multi-disk stack', () => {
	// hokon's root resolves to two physical disks; the target must be checked
	// against every one, not just the first.
	const r = guard('usb_guard_not_root_disk', 'nvme1n1', 'nvme0n1', 'nvme1n1');
	assert.equal(r.ok, false);
	assert.match(r.why, /is the ROOT disk/);
});

test('a device that is on none of the root disks passes', () => {
	assert.ok(guard('usb_guard_not_root_disk', 'sdb', 'nvme0n1', 'nvme1n1').ok);
});

// ── system mounts ───────────────────────────────────────────────────────────

test('a partition mounted at a system path refuses', () => {
	for (const mnt of ['/', '/boot', '/boot/efi', '/home', '/usr', '/var', '/etc']) {
		const r = guard('usb_guard_no_system_mounts', `/dev/sdb1 ${mnt}`);
		assert.equal(r.ok, false, `${mnt} must refuse`);
		assert.match(r.why, /is mounted at/);
	}
});

test('an auto-mounted stick under /media or /run is fine — it gets unmounted', () => {
	assert.ok(guard('usb_guard_no_system_mounts', '/dev/sdb1 /media/hadoku/CLAWKIT').ok);
	assert.ok(guard('usb_guard_no_system_mounts', '/dev/sdb1 /run/media/hadoku/x').ok);
});

test('nothing mounted is a pass here, unlike an empty root-disk list', () => {
	// The asymmetry is deliberate and worth pinning: an empty mount list is a
	// real observation ("nothing is mounted"), while an empty root-disk list is a
	// failed read. Same emptiness, opposite meaning.
	assert.ok(guard('usb_guard_no_system_mounts').ok);
	assert.ok(guard('usb_guard_no_system_mounts', '/dev/sdb1').ok);
});

// ── size ────────────────────────────────────────────────────────────────────

test('a plausible stick passes and an oversized device refuses', () => {
	assert.ok(guard('usb_guard_size', '32000000000', '/dev/sdb').ok, '32GB');
	const r = guard('usb_guard_size', '4000000000000', '/dev/sdb');
	assert.equal(r.ok, false);
	assert.match(r.why, /larger than any stick we use/);
});

test('a size of zero or garbage refuses rather than arithmetic-ing on it', () => {
	assert.equal(guard('usb_guard_size', '0', '/dev/sdb').ok, false);
	assert.equal(guard('usb_guard_size', '', '/dev/sdb').ok, false);
	assert.equal(guard('usb_guard_size', 'not-a-number', '/dev/sdb').ok, false);
});

// ── the CLAWKIT reserve ─────────────────────────────────────────────────────

test('a reserve that leaves Ventoy under 4GB refuses', () => {
	// The operator would only find out at the console of a node with no OS.
	const r = guard('usb_guard_reserve', '8000', '8000000000'); // 8GB stick, 8GB reserve
	assert.equal(r.ok, false);
	assert.match(r.why, /leaves Ventoy under 4GB/);
});

test('a reserve too small to hold the payload refuses', () => {
	const r = guard('usb_guard_reserve', '16', '32000000000');
	assert.equal(r.ok, false);
	assert.match(r.why, /too small/);
});

test('a sane reserve on a sane stick passes', () => {
	assert.ok(guard('usb_guard_reserve', '1024', '32000000000').ok);
});

// ── ventoy ──────────────────────────────────────────────────────────────────

test('a missing Ventoy says what to fetch and does NOT offer to fetch it', () => {
	const r = guard('usb_guard_ventoy', '');
	assert.equal(r.ok, false);
	assert.match(r.why, /will not download it/);
	assert.match(r.why, /github\.com\/ventoy\/Ventoy\/releases/);
	assert.ok(
		!/curl .*\| *(sh|bash)/.test(r.why),
		'it must not hand the operator a pipe-to-shell for a bootloader installer'
	);
});

test('a readable Ventoy2Disk.sh passes', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ventoy-'));
	try {
		const p = join(dir, 'Ventoy2Disk.sh');
		writeFileSync(p, '#!/bin/sh\nexit 0\n');
		assert.ok(guard('usb_guard_ventoy', p).ok);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── the ssh public key ──────────────────────────────────────────────────────

// Well-formed, and nobody's: 32 bytes of 0x42 under the ed25519 header.
const REAL_KEY =
	'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC fleet@example';

function withKeyFile(contents, fn) {
	const dir = mkdtempSync(join(tmpdir(), 'pubkey-'));
	try {
		const p = join(dir, 'k.pub');
		writeFileSync(p, contents);
		return fn(p);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('a real public key passes', () => {
	withKeyFile(`${REAL_KEY}\n`, (p) => assert.ok(guard('usb_guard_pubkey', p).ok));
});

test('an EMPTY key file refuses — findings 1 and 2 of the retrospective', () => {
	// "sshd was hardened around a key that was not there", and four of that
	// cluster could not be recovered over the network. Catching it here means
	// catching it on the control host, before the stick is carried to a garage.
	withKeyFile('', (p) => {
		const r = guard('usb_guard_pubkey', p);
		assert.equal(r.ok, false);
		assert.match(r.why, /EMPTY/);
	});
});

test('a file that is not a key at all refuses', () => {
	withKeyFile('this is my key, honest\n', (p) => {
		const r = guard('usb_guard_pubkey', p);
		assert.equal(r.ok, false);
		assert.match(r.why, /does not contain a public key/);
	});
});

test('a PRIVATE key refuses — this stick is carried between nodes', () => {
	// It is named for what it IS, not for what it is not. "this does not look
	// like a public key" is true and sends the operator back with the same file.
	withKeyFile(
		`-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----\n`,
		(p) => {
			const r = guard('usb_guard_pubkey', p);
			assert.equal(r.ok, false);
			assert.match(r.why, /contains a PRIVATE KEY/);
		}
	);
});

test('a private key that ALSO contains a public line still refuses', () => {
	// THE MUTATION-AIMED CASE. The key-type check PASSES on this file — there is
	// a real `ssh-ed25519 ...` line in it — so only the separate PRIVATE KEY
	// check can refuse it. Delete that check and this file is copied onto a stick
	// and carried between nodes. This is also why the private-key check runs
	// FIRST in the guard: ordering it second would make the two tests above
	// indistinguishable and this one the only real coverage.
	withKeyFile(`${REAL_KEY}\n-----BEGIN OPENSSH PRIVATE KEY-----\nx\n`, (p) => {
		const r = guard('usb_guard_pubkey', p);
		assert.equal(r.ok, false);
		assert.match(r.why, /contains a PRIVATE KEY/);
	});
});

test('a nonexistent key path refuses', () => {
	const r = guard('usb_guard_pubkey', '/nonexistent/id_ed25519.pub');
	assert.equal(r.ok, false);
	assert.match(r.why, /not found/);
});

test('no key path at all refuses', () => {
	const r = guard('usb_guard_pubkey', '');
	assert.equal(r.ok, false);
	assert.match(r.why, /no way in/);
});

/**
 * A payload refresh must not begin by destroying the partition.
 *
 * `--skip-ventoy` skips VENTOY and still ran mkfs.ext4 on CLAWKIT, so the
 * refresh path wiped the partition it exists to update — including telemetry
 * from a failed install and any logs the installer's own dumper had saved
 * there, which is usually the reason a refresh is happening at all.
 */
import { readFileSync as _rf } from 'node:fs';
import { fileURLToPath as _furl } from 'node:url';
const _prep = _rf(_furl(new URL('../node-usb-prep.sh', import.meta.url)), 'utf8');
const _code = _prep
	.split('\n')
	.map((l) => (l.trimStart().startsWith('#') ? '' : l))
	.join('\n');

test('mkfs is guarded by the refresh mode, not run unconditionally', () => {
	assert.match(_code, /REFRESH_PAYLOAD/, '--refresh-payload must exist');
	const i = _code.indexOf('mkfs.ext4 -F -L');
	assert.ok(i > 0, 'the format must still exist for a real build');
	const before = _code.slice(Math.max(0, i - 300), i);
	assert.match(
		before,
		/if \[ "\$REFRESH_PAYLOAD" = true \]/,
		'the format must sit behind the refresh guard, or a refresh erases the stick'
	);
});

test('the refresh door asks for the non-destructive mode', () => {
	const r = _rf(_furl(new URL('../refresh-preseed.sh', import.meta.url)), 'utf8');
	assert.match(r, /--refresh-payload/, 'refresh must not use the formatting path');
	assert.ok(!/--skip-ventoy --confirm/.test(r), '--skip-ventoy still formats');
});
