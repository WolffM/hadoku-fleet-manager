/**
 * node-usb-prep.sh: a by-id device path must resolve to its real block
 * device BEFORE any guard sees it. Split out of `make-preseed.test.mjs`
 * (wave 5s lane D, 1,000-line test ceiling): see that file's original
 * header (now `make-preseed-content.test.mjs`) for the rest of this suite,
 * and the doc comment on the first test below for the CI run this
 * reproduces.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
	readFileSync,
	readdirSync,
	lstatSync,
	statSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './test-tmpdir.mjs';
import { NODE_USB_PREP } from './make-preseed-fixtures.mjs';

/**
 * node-usb-prep.sh: a by-id device path must resolve to its real block
 * device BEFORE any guard sees it.
 *
 * `/dev/disk/by-id/usb-ADATA_USB_Flash_Drive_...-0:0` is the stable path the
 * operator is told to use (CLAUDE.md, this wave's own re-image command), but
 * it is a SYMLINK whose own name routinely ends in a digit that has nothing
 * to do with partitioning (a SCSI target:lun suffix, "-0:0" here) —
 * `usb_guard_whole_disk`'s `*[0-9]` partition heuristic
 * (lib/usb-device-guard.sh, owned by a different lane) cannot tell that
 * apart from a real partition number and refuses the symlink as a
 * partition. `BASE` (built by stripping everything up to the last slash)
 * and every `"${DEV}1"`-style path built later would also resolve against
 * the symlink's own name, not the device it points at.
 *
 * This file does not own node-usb-prep.sh's test coverage as a separate
 * file (none exists in this repo), so the fix is proven two ways instead,
 * both against the SHIPPED text — not a reimplementation:
 *
 *   1. EXECUTION: the resolve block is sliced out of node-usb-prep.sh by
 *      the same inert `:` sentinel technique make-preseed.sh's
 *      TARGET-GUARD-CHECK uses (`DEV-RESOLVE-BEGIN`/`-END`), and run
 *      against a REAL symlink in a throwaway dir, pointed at a REAL block
 *      device already present on this machine (`/dev/sda` et al. — picked
 *      dynamically, never assumed, and never written to or mounted: only
 *      `readlink -f` and a `[ -b ]` stat, which need no root). This is
 *      possible precisely because the resolve step has no other
 *      dependency — it does not need `set -euo pipefail`, the rest of the
 *      script's guards, or root.
 *   2. STATIC ORDER: the sentinel's position in the file is checked against
 *      `usb_guard_whole_disk "$DEV"`'s, confirming the resolve is textually
 *      before the first guard that would otherwise misread a by-id name.
 */
/**
 * Picks the first entry in `dir` that IS a block device.
 *
 * `followSymlinks` defaults to false — `lstatSync`, not `statSync` — which
 * matters: CI run 37055170760 (claw hardware) hit `/dev/cdrom`, a symlink to
 * `/dev/sr0`, as `readdirSync`'s first qualifying entry under the OLD
 * `statSync`-based picker. `statSync` follows symlinks, so a symlink whose
 * TARGET is a block device reads as one itself — the picker returned
 * `/dev/cdrom`, and "already-canonical path unchanged" then disagreed with
 * itself, because `/dev/cdrom` was never canonical. `lstatSync` reports the
 * entry's own type without following it, so a symlink is never mistaken for
 * the device it points at, regardless of what that device is. `followSymlinks`
 * exists only so the test below can reconstruct the OLD behaviour
 * side-by-side with the fix, not because production code should ever want it.
 */
function findBlockDeviceIn(dir, { followSymlinks = false } = {}) {
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	for (const name of names) {
		const p = join(dir, name);
		let st;
		try {
			st = followSymlinks ? statSync(p) : lstatSync(p);
		} catch {
			continue;
		}
		if (st.isBlockDevice()) return p;
	}
	return null;
}

function findAnyBlockDevice() {
	return findBlockDeviceIn('/dev');
}

function devResolveSnippet() {
	const src = readFileSync(NODE_USB_PREP, 'utf8');
	const start = src.indexOf(': DEV-RESOLVE-BEGIN');
	const end = src.indexOf(': DEV-RESOLVE-END');
	assert.ok(start > -1 && end > -1, 'the DEV-RESOLVE sentinels are missing from node-usb-prep.sh');
	return src.slice(start, end);
}

function runDevResolve(givenDev) {
	const script = [
		'die() { printf "DIE:%s\\n" "$*"; exit 1; }',
		`DEV=${JSON.stringify(givenDev)}`,
		devResolveSnippet(),
		'printf "FINAL_DEV:%s\\n" "$DEV"',
	].join('\n');
	try {
		const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
		return { ok: true, out };
	} catch (err) {
		return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
	}
}

test('node-usb-prep.sh resolves a by-id-style symlink to the real block device it points at', () => {
	const real = findAnyBlockDevice();
	assert.ok(real, 'no block device found under /dev at all — cannot exercise this without one');
	// Compared against for every assertion below, never `real` itself — see
	// the CI-reproduction test for why `real` alone was not trustworthy
	// under the OLD (statSync) picker. `findAnyBlockDevice` is lstat-based
	// now, so `real` already equals its own realpath, but asserting against
	// the explicitly-recomputed canonical form is the belt-and-suspenders
	// version of that claim rather than a restatement of it.
	const canonical = realpathSync(real);

	const dir = tempDir('dev-resolve-byid-');
	const byId = join(dir, 'usb-ADATA_USB_Flash_Drive_0123456789ABCDEF-0:0');
	symlinkSync(real, byId);

	const { ok, out } = runDevResolve(byId);
	assert.ok(ok, `resolve should succeed for a symlink to a real block device; got: ${out}`);
	assert.match(out, /given:\s+.*usb-ADATA/);
	assert.match(out, new RegExp(`resolved to:\\s+${canonical.replace(/\//g, '\\/')}`));
	assert.match(out, new RegExp(`FINAL_DEV:${canonical.replace(/\//g, '\\/')}`));
});

test('node-usb-prep.sh leaves an already-canonical /dev path unchanged (readlink -f is a no-op on it)', () => {
	const real = findAnyBlockDevice();
	assert.ok(real, 'no block device found under /dev at all');
	const canonical = realpathSync(real);
	assert.equal(
		real,
		canonical,
		'findAnyBlockDevice must only ever return something that is already its own realpath'
	);
	const { ok, out } = runDevResolve(real);
	assert.ok(ok);
	assert.match(out, new RegExp(`FINAL_DEV:${canonical.replace(/\//g, '\\/')}`));
});

/**
 * Reproduces CI run 37055170760, then proves the fix.
 *
 * The bug needed no fake /dev: on that claw, `/dev/cdrom` (a real symlink to
 * `/dev/sr0`) sorted ahead of other block-device entries under the OLD
 * `statSync`-based picker, which follows symlinks — so it read as a block
 * device itself and was returned as "the" device, even though it is not its
 * own realpath. This machine has no optical drive, so the exact entry name
 * cannot be reproduced here; what is reproduced is the decisive mechanism —
 * a symlink whose TARGET is a block device — using a symlink built fresh in
 * a throwaway directory, pointed at a real block device already on this
 * machine. `findBlockDeviceIn`'s `followSymlinks` option reconstructs
 * exactly what the OLD code would have picked from that directory, so this
 * is a comparison against the actual prior behaviour, not a hypothetical.
 */
test('the picker uses lstat, not stat, so a symlink is never mistaken for the block device it points at', () => {
	const real = findAnyBlockDevice();
	assert.ok(real, 'no block device found under /dev at all');
	const canonical = realpathSync(real);

	const dir = tempDir('dev-fake-cdrom-');
	// Named like the CI box's actual first-found entry; what matters is that
	// it is A symlink to A block device, not this exact name.
	const fakeCdrom = join(dir, 'cdrom');
	symlinkSync(real, fakeCdrom);

	// What the OLD picker (statSync, follows symlinks) would have selected
	// from this directory: the symlink itself, because what it resolves to
	// IS a block device. This is the fixture-level proof that the bug is
	// real and reproduced, not assumed.
	const oldPick = findBlockDeviceIn(dir, { followSymlinks: true });
	assert.equal(
		oldPick,
		fakeCdrom,
		'fixture bug: the old picker should have selected the symlink here'
	);
	assert.notEqual(
		realpathSync(oldPick),
		oldPick,
		'the old pick must itself be a symlink (not its own realpath), or this fixture is not reproducing the CI failure shape'
	);

	// The FIXED picker (lstat) on the SAME directory: nothing qualifies,
	// because the only entry there is a symlink — it is excluded on its OWN
	// type, never by chance.
	assert.equal(
		findBlockDeviceIn(dir, { followSymlinks: false }),
		null,
		'a directory containing only a symlink must yield nothing from the fixed picker'
	);

	// And the fixed picker still finds a REAL device once one is actually
	// available — the fix excludes symlinks, it does not just always return
	// null. `findAnyBlockDevice` (real /dev) is exactly that "move on to a
	// source with a genuine block device" step.
	const fixed = findAnyBlockDevice();
	assert.equal(fixed, canonical);
	assert.equal(realpathSync(fixed), canonical, 'the fixed pick must already be its own realpath');
});

test('node-usb-prep.sh refuses a broken symlink rather than guessing', () => {
	const dir = tempDir('dev-resolve-broken-');
	const byId = join(dir, 'usb-broken-0:0');
	symlinkSync('/dev/this-does-not-exist-xyz', byId);
	const { ok, out } = runDevResolve(byId);
	assert.ok(!ok, 'a symlink to nothing must not resolve to a usable device');
	assert.match(out, /DIE:.*did not resolve to a block device/);
});

test('node-usb-prep.sh refuses a symlink that resolves to something that is not a block device', () => {
	const dir = tempDir('dev-resolve-notblock-');
	const regularFile = join(dir, 'not-a-device');
	writeFileSync(regularFile, 'just a file');
	const byId = join(dir, 'usb-notblock-0:0');
	symlinkSync(regularFile, byId);
	const { ok, out } = runDevResolve(byId);
	assert.ok(!ok, 'resolving to a regular file must not pass as a block device');
	assert.match(out, /DIE:.*did not resolve to a block device/);
});

test('the DEV-RESOLVE sentinel sits BEFORE usb_guard_whole_disk in file order — static check', () => {
	const src = readFileSync(NODE_USB_PREP, 'utf8');
	const resolveAt = src.indexOf(': DEV-RESOLVE-BEGIN');
	const guardAt = src.indexOf('usb_guard_whole_disk "$DEV"');
	assert.ok(resolveAt > -1, 'resolve sentinel missing');
	assert.ok(guardAt > -1, 'usb_guard_whole_disk call missing — did it move or get renamed?');
	assert.ok(
		resolveAt < guardAt,
		'DEV must be canonicalized before the first guard reads it, or a by-id symlink reaches the guard under its own (wrong) name'
	);
});
