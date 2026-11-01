/**
 * §6.10 — a retry must not inherit a dirty /target (#51). Split out of
 * `make-preseed.test.mjs` (wave 5s lane D, 1,000-line test ceiling): the
 * target-guard sentinels, the mount-safety half (busybox `rm` has no
 * --one-file-system, so nothing is deleted unless every mount strictly below
 * $TGT is confirmed gone first). See `make-preseed-content.test.mjs` for the
 * rest of this file's original header.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './test-tmpdir.mjs';
import { render } from './make-preseed-fixtures.mjs';

/**
 * §6.10 — a retry must not inherit a dirty /target (#51).
 *
 * claw-9, 2026-09-21: a corrupted debootstrap left `/target` half-unpacked,
 * and d-i re-ran the same menu item on it three more times, every retry
 * hitting `tar: can't open './usr/share/doc/...': File exists` — base-installer
 * has no early_command hook of its own, so the fix watches /var/log/syslog
 * for the failure and wipes /target itself, from the OTHER side of the race.
 *
 * This executes the ACTUAL check body shipped inside early_command — sliced
 * out by the `: TARGET-GUARD-CHECK-BEGIN`/`-END` sentinels, which are inert
 * `:` no-ops at runtime and exist for exactly this — against a sandboxed
 * $FLEET_TG_TARGET, not a reimplementation of it. That is what makes the
 * mutation test below real: breaking the shipped logic breaks the test.
 */
function targetGuardCheckBody() {
	const out = render();
	const start = out.indexOf('TGT="${FLEET_TG_TARGET');
	const end = out.indexOf(': TARGET-GUARD-CHECK-END', start);
	assert.ok(start > -1 && end > -1, 'the target-guard sentinels are missing from early_command');
	return out.slice(start, end);
}

/**
 * `mounts`: paths that FLEET_TG_MOUNTS reports as mounted strictly below the
 * target, standing in for /proc/mounts. `unmountSucceeds`: whether the
 * stubbed `umount`/`umount -l` actually clears the fixture (simulating a
 * real unmount's effect on /proc/mounts) or leaves it untouched no matter
 * how many times it is tried (simulating a mount nothing can detach).
 *
 * /dev/console itself cannot be faked without root, so the "refuses and
 * says why" half of a mutation is checked through `logger` (which fires
 * right beside the console printf in the shipped code) plus a static check
 * elsewhere that the console printf text exists at all.
 */
function runTargetGuard(targetDir, { mounts = [], unmountSucceeds = true } = {}) {
	const sandbox = tempDir('target-guard-run-');
	const bin = join(sandbox, 'bin');
	mkdirSync(bin, { recursive: true });
	const log = join(sandbox, 'logger.out');
	writeFileSync(join(bin, 'logger'), '#!/bin/sh\necho "$*" >> ' + log + '\n');
	chmodSync(join(bin, 'logger'), 0o755);

	const mountsFile = join(sandbox, 'mounts');
	writeFileSync(
		mountsFile,
		mounts.map((mp) => `tmpfs ${mp} tmpfs rw 0 0`).join('\n') + (mounts.length ? '\n' : '')
	);

	const umountBody = unmountSucceeds
		? [
				'#!/bin/sh',
				'target="$1"',
				'[ "$1" = "-l" ] && target="$2"',
				`grep -v " $target " "${mountsFile}" > "${mountsFile}.tmp" 2>/dev/null`,
				`mv "${mountsFile}.tmp" "${mountsFile}" 2>/dev/null || true`,
				'exit 0',
				'',
			].join('\n')
		: '#!/bin/sh\nexit 1\n';
	writeFileSync(join(bin, 'umount'), umountBody);
	chmodSync(join(bin, 'umount'), 0o755);

	execFileSync('sh', ['-c', targetGuardCheckBody()], {
		stdio: ['ignore', 'ignore', 'ignore'],
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FLEET_TG_TARGET: targetDir,
			FLEET_TG_MOUNTS: mountsFile,
		},
	});
	return {
		logged: existsSync(log) ? readFileSync(log, 'utf8') : '',
		mountsAfter: existsSync(mountsFile) ? readFileSync(mountsFile, 'utf8') : '',
	};
}

test('the target guard watches for both debconf failure names and is bounded/double-forked like telemetry', () => {
	const out = render();
	assert.match(out, /base-installer\/debootstrap-failed/);
	assert.match(out, /base-installer\/kernel\/failed-install/);
	assert.match(
		out,
		/\) <\/dev\/null >\/dev\/null 2>&1 & \) & \\\n {4}for i in/,
		'the guard must close stdin/stdout/stderr and double-fork before the interface picker runs, or it holds the pipe open like the telemetry bug it copies the fix from'
	);
	assert.match(out, /while \[ \$T -lt 360 \]/, 'the watchdog must be bounded, like telemetry');
	// Only NEW syslog content is examined each pass, or a line that matches once
	// matches forever and the guard refires on every tick after the first.
	assert.match(out, /SEEN=\$CUR/, 'a line-count watermark is required to avoid refiring forever');
});

test('a dirty /target after a failed bootstrap-base is wiped and the cleanup is logged twice', () => {
	const dir = tempDir('target-guard-dirty-');
	mkdirSync(join(dir, 'sub'), { recursive: true });
	writeFileSync(join(dir, 'leftover.deb'), 'half-unpacked');
	writeFileSync(join(dir, '.hidden-leftover'), 'also half-unpacked');
	const { logged } = runTargetGuard(dir);
	assert.match(logged, /dirty target after a failed bootstrap-base/);
	assert.match(logged, /target cleaned - safe to retry/);
	assert.deepEqual(readdirSync(dir), [], 'every entry, including the hidden one, must be gone');
});

test('a clean /target is left alone and nothing is logged', () => {
	const dir = tempDir('target-guard-clean-');
	const { logged } = runTargetGuard(dir);
	assert.equal(logged, '', 'an empty target must not be touched or logged about');
});

/**
 * The mount-safety half of §6.10. By the time base-installer fails, /target
 * routinely has /target/proc, /target/sys (and on EFI hardware
 * /target/sys/firmware/efi/efivars beneath THAT), a /target/dev bind and
 * /target/boot/efi all mounted. busybox `rm` has no --one-file-system:
 * walking into efivars deletes real NVRAM boot variables, and walking into a
 * /dev bind deletes the installer's own device nodes (same inodes, not a
 * copy). So nothing is deleted unless every mount strictly below $TGT is
 * confirmed gone first.
 */
test('a nested mount that will not unmount: nothing is deleted, and the refusal is logged', () => {
	const dir = tempDir('target-guard-stuck-mount-');
	writeFileSync(join(dir, 'leftover.deb'), 'half-unpacked');
	const nested = join(dir, 'proc');
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(nested, 'cpuinfo'), 'pretend procfs content');

	const { logged } = runTargetGuard(dir, { mounts: [nested], unmountSucceeds: false });

	assert.match(logged, /could not clear every mount under .* before wiping - refusing/);
	assert.ok(!/target cleaned - safe to retry/.test(logged), 'must not claim success');
	assert.ok(
		existsSync(join(dir, 'leftover.deb')),
		'the dirty file must survive — nothing was deleted'
	);
	assert.ok(existsSync(join(nested, 'cpuinfo')), 'the "mounted" content must survive untouched');
});

test('a nested mount that DOES unmount cleanly: the mount is cleared first, then the target is wiped', () => {
	const dir = tempDir('target-guard-clearable-mount-');
	writeFileSync(join(dir, 'leftover.deb'), 'half-unpacked');
	const nested = join(dir, 'proc');
	mkdirSync(nested, { recursive: true });

	const { logged, mountsAfter } = runTargetGuard(dir, { mounts: [nested], unmountSucceeds: true });

	assert.match(logged, /target cleaned - safe to retry/);
	assert.ok(
		!/could not clear every mount/.test(logged),
		'a clearable mount must not trigger a refusal'
	);
	assert.deepEqual(
		readdirSync(dir),
		[],
		'the target must be wiped once nothing remains mounted beneath it'
	);
	assert.equal(mountsAfter.trim(), '', 'the stubbed unmount must have cleared the fixture');
});

test('the console refusal and FLEET_TG_MOUNTS override both exist in the shipped text', () => {
	const out = render();
	assert.match(out, /refusing to delete anything/);
	assert.match(out, /FLEET_TG_MOUNTS:-\/proc\/mounts/);
});
