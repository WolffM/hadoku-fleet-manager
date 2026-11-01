/**
 * make-preseed's shared fixtures — `render_preseed`'s output, parsed into
 * directives, and the sandboxed wifi-branch execution every section below
 * needs. Split out of `make-preseed.test.mjs` (wave 5s lane D, 1,000-line
 * test ceiling): see that file's header for the installer failure this suite
 * guards against.
 *
 * `SBIN_PATH`/`sbinEnv` is here too, not because it renders anything, but
 * because both the netinst-partition and the CLAWKIT-sizing sections need
 * `sfdisk` on PATH to build a throwaway disk image, and it is the one piece
 * of fixture state shared across files that are otherwise independent.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { tempDir } from './test-tmpdir.mjs';

export const LIB = fileURLToPath(new URL('./make-preseed.sh', import.meta.url));
export const NODE_USB_PREP = fileURLToPath(new URL('../node-usb-prep.sh', import.meta.url));

/** sfdisk/blkid live in /usr/sbin — not guaranteed on PATH for a test runner. */
export const SBIN_PATH = `${process.env.PATH}:/usr/sbin:/sbin`;
export const sbinEnv = () => ({ ...process.env, PATH: SBIN_PATH });

export function render({ ssid = '', psk = '' } = {}) {
	const dir = tempDir('preseed-');
	const key = join(dir, 'k.pub');
	writeFileSync(key, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 fleet@test\n');
	return execFileSync(
		'bash',
		['-c', `. "${LIB}"; render_preseed hadoku '$6$x$y' '${ssid}' '${psk}' '${key}' 'Etc/UTC'`],
		{ encoding: 'utf8' }
	);
}

export const directives = (src) =>
	src
		.split('\n')
		.filter((l) => /^(d-i|popularity-contest|tasksel) /.test(l))
		.map((l) => l.trim());

/**
 * Run the RENDERED late_command's wifi branch against a fake sysfs.
 *
 * The preseed is unfolded exactly as d-i unfolds it (a `\`-continued value is
 * one line), then the three absolutes it touches are pointed at a sandbox and
 * `in-target` / `logger` are replaced by recorders. Nothing else is rewritten,
 * so the logic under test is the logic that ships.
 */
export function runWifiBranch() {
	const rendered = render({ ssid: 'GarageNet', psk: 'hunter2hunter2' });

	const line = rendered
		.split('\n')
		.reduce(
			(acc, l) => {
				if (acc.done) return acc;
				if (!acc.started && !l.startsWith('d-i preseed/late_command')) return acc;
				acc.started = true;
				acc.parts.push(l.replace(/\\$/, ''));
				if (!l.endsWith('\\')) acc.done = true;
				return acc;
			},
			{ started: false, done: false, parts: [] }
		)
		.parts.join('')
		.replace(/^d-i preseed\/late_command string /, '');

	assert.ok(line.includes('/sys/class/net'), 'late_command did not unfold — harness is stale');

	const once = (wireless) => {
		const root = tempDir('wifi-branch-');
		// Everything the WHOLE late_command writes into /target — the wifi branch
		// runs last, so the lines before it have to land somewhere. Running all of
		// it, rather than snipping out the branch, is what keeps this honest: a
		// separator that breaks the chain would show up here.
		for (const d of [
			'target/etc/wpa_supplicant',
			'target/etc/systemd/network',
			'target/etc/sudoers.d',
			'target/etc/network',
			'target/home/hadoku/.ssh',
			'sys/class/net',
			'bin',
		]) {
			mkdirSync(join(root, d), { recursive: true });
		}
		for (const iface of wireless) {
			mkdirSync(join(root, 'sys/class/net', iface, 'wireless'), { recursive: true });
		}

		// `in-target` carries a hyphen, which POSIX shells refuse in a function
		// name — dash dies with "Bad function name" before running a line. d-i
		// provides it as a COMMAND, so the stub is one too.
		writeFileSync(
			join(root, 'bin/in-target'),
			`#!/bin/sh\nprintf '%s\\n' "$*" >> ${root}/in-target\n`
		);
		writeFileSync(join(root, 'bin/logger'), '#!/bin/sh\nexit 0\n');
		chmodSync(join(root, 'bin/in-target'), 0o755);
		chmodSync(join(root, 'bin/logger'), 0o755);

		const body = line
			.replace(/\/sys\/class\/net/g, `${root}/sys/class/net`)
			.replace(/\/target/g, `${root}/target`)
			.replace(/> \/dev\/console/g, `>> ${root}/console`);

		execFileSync('sh', ['-c', body], {
			stdio: 'pipe',
			env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
		});

		const inTarget = existsSync(join(root, 'in-target'))
			? readFileSync(join(root, 'in-target'), 'utf8')
			: '';

		return {
			wpaConfs: readdirSync(join(root, 'target/etc/wpa_supplicant')),
			networkdFiles: readdirSync(join(root, 'target/etc/systemd/network')),
			// `systemctl enable ssh` runs unconditionally further up the same
			// late_command and is not this branch's business.
			enabled: inTarget
				.split('\n')
				.filter((l) => l.startsWith('systemctl enable '))
				.map((l) => l.replace('systemctl enable ', ''))
				.filter((u) => /wpa_supplicant|networkd/.test(u)),
			marker: existsSync(join(root, 'target/etc/fleet-wifi-deferred'))
				? readFileSync(join(root, 'target/etc/fleet-wifi-deferred'), 'utf8')
				: '',
		};
	};

	// claw-9 at late_command time: a Broadcom card present on the PCI bus and no
	// wireless interface anywhere, because its driver is built after first boot.
	return { noRadio: once([]), withRadio: once(['wlp9s0']) };
}
