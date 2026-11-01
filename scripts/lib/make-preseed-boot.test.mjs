/**
 * The boot disk and the preseed's own freshness. Split out of
 * `make-preseed.test.mjs` (wave 5s lane D, 1,000-line test ceiling): the
 * bootdev pin (claw-9's cross-disk GRUB failure), the early_command shell
 * syntax, and `preseed_rerender`/`preseed_is_stale` (#51 — a stale PRESEED,
 * not a stale payload). See `make-preseed-content.test.mjs` for the rest of
 * this file's original header.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './test-tmpdir.mjs';
import { LIB, render } from './make-preseed-fixtures.mjs';

/**
 * The boot disk, which is what actually broke claw-9.
 *
 * `grub-installer/bootdev string default` was in this file from the beginning
 * and means "the first disk d-i enumerates" — not "the disk this install just
 * partitioned". Every claw before claw-9 had exactly one disk, so the two were
 * the same and the bug could not show. claw-9 was built in a reused chassis
 * with the old drive still cabled, root went to the SSD, GRUB went to the
 * leftover, and the install died at the last step on `embedding is not
 * possible` — which reads as a failing drive and got two healthy SSDs pulled.
 *
 * Asserted by name, like the cdrom directives above, for the same reason: a
 * preseed that renders cleanly and has quietly lost this pin looks identical
 * until a box is half-installed in a garage.
 */
test('bootdev is never left to d-i to guess', () => {
	const out = render();
	assert.ok(
		!/^d-i grub-installer\/bootdev string default$/m.test(out),
		'bootdev is pinned back to `default` — that is the first disk, not the root disk'
	);
	assert.match(out, /^d-i partman\/early_command string/m);
	assert.match(out, /debconf-set grub-installer\/bootdev/);
});

test('the pin only fires when there is exactly one fixed disk', () => {
	const out = render();
	const cmd = out.slice(out.indexOf('d-i partman/early_command'));
	// `list-devices disk` is d-i's own enumerator; anything else is a guess.
	assert.match(cmd, /list-devices disk/);
	// The install stick must never be a candidate for the bootloader.
	assert.match(cmd, /removable/);
	// One disk => pin it. More than one => warn, and leave d-i alone.
	assert.match(cmd, /if \[ \$# -eq 1 \]/);
	assert.match(cmd, /else/);
});

test('several disks produce a reason on the console, not just a log line', () => {
	const cmd = render().slice(render().indexOf('d-i partman/early_command'));
	assert.match(cmd, />\/dev\/console/);
	// The operator needs the fix, not just the fact.
	assert.match(cmd, /disconnect/i);
	// And the error it will otherwise hit, so the two can be connected.
	assert.match(cmd, /embedding is not possible/);
});

/**
 * The early_command is a single shell string that d-i runs with `sh -c`. A
 * syntax error in it is invisible here and fatal in a garage, so it is parsed.
 */
test('the early_command is valid shell', () => {
	const out = render();
	const start = out.indexOf('d-i partman/early_command string');
	assert.notEqual(start, -1);
	const body = out
		.slice(start, out.indexOf('\n\n', start))
		.replace(/^d-i partman\/early_command string\s*/, '');
	execFileSync('sh', ['-n'], { input: body });
});

/**
 * A stale PRESEED, not a stale payload — #51.
 *
 * `stick-stamp.sh` already catches a CLAWKIT payload that is behind this
 * checkout, by re-hashing rather than trusting a recorded version.
 * `preseed.cfg` on the Ventoy partition had no equivalent: `verify-stick.sh`
 * only checked four substrings (`modprobe ext4`, `/proc/mounts`, the
 * node-bootstrap mount guard, `preseed/early_command`) that have been true
 * since 2026-08-30 and would STILL be true on a preseed a month out of date.
 *
 * Measured against a real stick on 2026-10-01: its preseed.cfg was last
 * rendered 2026-09-08 (mtime), thirteen days before claw-9's 2026-09-21
 * install and missing the 2026-09-20 grub/bootdev-pin fix — it still read
 * `d-i grub-installer/bootdev string default`, the unconditional
 * first-disk-wins line `f0ddc3b` replaced with the conditional
 * `partman/early_command` pin below. That gap is what let grub-installer fail
 * with "embedding is not possible ... cross-disk install" twice that night:
 * the box had two fixed disks (the SSD being installed to, and its
 * predecessor's old HDD still cabled) and the pin that would have WARNED
 * about that, instead of guessing wrong, was not on the stick.
 *
 * `preseed_rerender`/`preseed_is_stale` close that gap the same way
 * `stamp_compare` closes it for the payload: read the operator-supplied
 * values back out of the file on the stick and re-render them through THIS
 * checkout's generator, rather than trusting anything the file claims about
 * itself.
 */
function runLib(script) {
	return execFileSync('bash', ['-c', `. "${LIB}"; ${script}`], { encoding: 'utf8' });
}

function preseedIsStale(file) {
	try {
		runLib(`preseed_is_stale '${file}'`);
		return 0;
	} catch (err) {
		return err.status;
	}
}

test('preseed_rerender reproduces what render_preseed just wrote, modulo the timestamp', () => {
	const out = render({ ssid: 'GarageNet', psk: 'hunter2hunter2' });
	const dir = tempDir('preseed-rerender-');
	const file = join(dir, 'preseed.cfg');
	writeFileSync(file, out);
	const again = runLib(`preseed_rerender '${file}'`);
	const strip = (s) => s.replace(/^# Generated by fleet onboard on.*$/m, '').trim();
	assert.equal(strip(again), strip(out));
});

test('preseed_rerender round-trips an ethernet-only (no wifi) preseed too', () => {
	const out = render();
	const dir = tempDir('preseed-rerender-nowifi-');
	const file = join(dir, 'preseed.cfg');
	writeFileSync(file, out);
	const again = runLib(`preseed_rerender '${file}'`);
	const strip = (s) => s.replace(/^# Generated by fleet onboard on.*$/m, '').trim();
	assert.equal(strip(again), strip(out));
});

test('preseed_is_stale says CURRENT for a preseed this checkout just rendered', () => {
	const out = render({ ssid: 'GarageNet', psk: 'hunter2hunter2' });
	const dir = tempDir('preseed-stale-current-');
	const file = join(dir, 'preseed.cfg');
	writeFileSync(file, out);
	assert.equal(preseedIsStale(file), 0);
});

test('preseed_is_stale says STALE for a preseed shaped like the one that cost claw-9 the night of 2026-09-21', () => {
	const out = render({ ssid: 'GarageNet', psk: 'hunter2hunter2' });
	// Reproduce the pre-2026-09-20 shape: the unconditional bootdev line in
	// place of the conditional partman/early_command pin. This is the exact
	// textual difference measured against the real, out-of-date stick.
	const stale = out.replace(
		/d-i partman\/early_command string[\s\S]*?fi\n/,
		'd-i grub-installer/bootdev string default\n'
	);
	assert.notEqual(
		stale,
		out,
		'fixture did not actually change anything — test is not exercising the guard'
	);
	const dir = tempDir('preseed-stale-old-');
	const file = join(dir, 'preseed.cfg');
	writeFileSync(file, stale);
	assert.equal(preseedIsStale(file), 1);
});

test('preseed_is_stale says it could not tell for a file with no preseed content', () => {
	const dir = tempDir('preseed-stale-garbage-');
	const file = join(dir, 'preseed.cfg');
	writeFileSync(file, 'not a preseed\n');
	assert.equal(preseedIsStale(file), 2);
});
