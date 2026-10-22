/**
 * The preseed must answer the questions that actually stopped an install.
 *
 * On 2026-08-30 a real claw-4 install died at:
 *
 *     [!!] Configuring popularity-contest
 *     /media/cdrom/: Please insert the disc labeled 'Debian ... NETINST'
 *
 * The installer had registered the Ventoy-loopmounted ISO as an apt "cdrom"
 * source; pkgsel went back to it and the loop device was gone. Two directives
 * prevent it and both are asserted here by name, because a preseed that renders
 * cleanly and omits one of them looks identical until a box is already
 * half-installed in a garage.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
	writeFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	existsSync,
	chmodSync,
	openSync,
	writeSync,
	closeSync,
	statSync,
	lstatSync,
	realpathSync,
	symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './test-tmpdir.mjs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { randomBytes, createHash } from 'node:crypto';

const LIB = fileURLToPath(new URL('./make-preseed.sh', import.meta.url));
const NODE_USB_PREP = fileURLToPath(new URL('../node-usb-prep.sh', import.meta.url));

function render({ ssid = '', psk = '' } = {}) {
	const dir = tempDir('preseed-');
	const key = join(dir, 'k.pub');
	writeFileSync(key, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 fleet@test\n');
	return execFileSync(
		'bash',
		['-c', `. "${LIB}"; render_preseed hadoku '$6$x$y' '${ssid}' '${psk}' '${key}' 'Etc/UTC'`],
		{ encoding: 'utf8' }
	);
}

const directives = (src) =>
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
function runWifiBranch() {
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

test('the cdrom-as-apt-source directives are present — this is the 2026-08-30 failure', () => {
	const out = render();
	for (const key of [
		'apt-setup/cdrom/set-first',
		'apt-setup/cdrom/set-next',
		'apt-setup/cdrom/set-failed',
		'apt-setup/disable-cdrom-entries',
	]) {
		assert.ok(
			directives(out).some((d) => d.includes(key)),
			`${key} is missing. Without it the Ventoy loop-mounted ISO becomes an apt ` +
				`source and pkgsel stops asking for a disc that does not exist.`
		);
	}
	assert.ok(
		directives(out).some((d) => d.includes('popularity-contest/participate boolean false')),
		'popularity-contest is what was being configured when the install stopped'
	);
});

test('the target disk is NOT preseeded — it is the one question worth asking', () => {
	assert.ok(
		!directives(render()).some((d) => d.startsWith('d-i partman-auto/disk')),
		'preseeding the disk means this stick, booted on the wrong machine, ' +
			'repartitions it with no prompt'
	);
});

test('no desktop, and ssh is installed — a build node, not a workstation', () => {
	const d = directives(render());
	// Nothing beyond what makes the node reachable. Everything else crosses the
	// network after partitioning, and a link that drops late discards a finished
	// base system — which is how an install died at 75% of "installing programs".
	assert.ok(
		d.some((x) => x === 'tasksel tasksel/first multiselect'),
		'no tasksel bundle'
	);
	assert.ok(
		d.some((x) => x === 'd-i pkgsel/upgrade select none'),
		'no full-upgrade'
	);
	assert.ok(d.some((x) => x.includes('pkgsel/include') && x.includes('openssh-server')));
	assert.ok(
		!d.some((x) => x.includes('pkgsel/include') && x.includes('jq')),
		"jq is node-bootstrap's job"
	);
});

test('the fleet key and passwordless sudo are installed by late_command', () => {
	const out = render();
	assert.match(out, /authorized_keys/, 'the node must be reachable at first boot');
	assert.match(out, /NOPASSWD:ALL/, 'provision-fleet cannot write system units without it');
});

test('wifi is absent unless asked for, and persists into the installed system when it is', () => {
	const without = render();
	assert.ok(!without.includes('wireless_essid'), 'no wifi keys when none were given');
	assert.match(without, /ethernet-only/, 'and it says so, rather than staying silent');

	const with_ = render({ ssid: 'GarageNet', psk: 'hunter2hunter2' });
	assert.match(with_, /netcfg\/wireless_essid string GarageNet/, 'installer gets on wifi');
	// netcfg's keys do not survive the reboot. Without this the node comes up
	// after first boot with no network and no way in.
	assert.match(with_, /wpa_supplicant-\$W\.conf/, 'and so does the installed system');
	assert.match(with_, /systemctl enable wpa_supplicant@\$W/);
});

/**
 * THE INTERFACE NAME IS DERIVED ON THE NODE, NOT WRITTEN HERE.
 *
 * This test replaces two assertions that pinned the literal string
 * `wpa_supplicant-wlan0.conf`, and the way they failed is the point. Debian
 * trixie uses predictable interface names and nothing in this preseed sets
 * `net.ifnames=0`, so the radio is `wlp3s0` or similar and `wlan0` exists on no
 * box this stick images. The old assertions therefore passed on the bug and
 * would have gone red on the fix — the failure mode `verify-stick.sh` hit three
 * separate times, recorded in onboarding-status-2026-08-31.md as "gates pinned
 * to implementation strings expire in the worst direction".
 *
 * The bug was quiet because `[Match] Name=wl*` in the networkd file matched
 * correctly: the box would come up with a wireless interface, systemd-networkd
 * asking for DHCP on it, and `wpa_supplicant@wlan0` failing to start under a
 * name nobody would think to look for — so the radio never associated.
 *
 * What is asserted now is the PROPERTY: the name is computed on the node, from
 * sysfs, with nothing but shell builtins.
 */
test('the wireless interface name is derived on the node, never hardcoded', () => {
	const with_ = render({ ssid: 'GarageNet', psk: 'hunter2hunter2' });

	assert.ok(
		!/wpa_supplicant[-@]wlan0/.test(with_),
		'`wlan0` must not be written into the preseed: trixie uses predictable ' +
			'interface names, so it names an interface that does not exist'
	);
	assert.match(
		with_,
		/for d in \/sys\/class\/net\/\*\/wireless/,
		'the name must be derived by walking sysfs on the node'
	);
	// Builtins only. late_command runs in the installer, where this file's own
	// history is a list of tools that are absent or behave differently — no
	// `iw`, no `ip -br`, and a busybox `tr` that ate every letter `n` out of the
	// disk models. Parameter expansion needs nothing but the shell.
	assert.match(with_, /\$\{d%\/wireless\}/, 'strip the suffix with parameter expansion');
	assert.match(with_, /\$\{p##\*\/\}/, 'take the basename with parameter expansion');

	// AND IT MUST NOT HAVE EXPANDED AT RENDER TIME. WIFI_LATE is double-quoted
	// (it interpolates $ssid and $psk), so an unescaped $W would resolve on the
	// CONTROL HOST to the empty string and bake a broken path into the file —
	// the same mistake WIFI_PICK's comment records, where a command substitution
	// ran on hokon and baked in hokon's own `wlp13s0`.
	assert.ok(
		!/wpa_supplicant-\.conf/.test(with_),
		'$W expanded at render time — the config path came out empty'
	);
	assert.ok(
		!with_.includes('wlp'),
		'a real interface name from the RENDERING host leaked into the preseed'
	);
});

/**
 * A RADIO THE INSTALLER CANNOT SEE MUST PRODUCE NO CONFIG AT ALL — claw-9.
 *
 * The test above pins the rendered STRING `wpa_supplicant-wlan0`, and the bug
 * walked straight past it. `late_command` derives the interface name on the
 * node, so a line reading `[ -n "$W" ] || W=wlan0` renders as nothing the regex
 * matches and then builds the forbidden filename on the box. The guard measured
 * the rendering; the defect lived in what the node computes. That is why this
 * test EXECUTES the branch against a fake sysfs instead of reading it.
 *
 * Measured on claw-9, 2026-09-20: its BCM4360 needs `broadcom-sta-dkms`, which
 * is not in the installer, so `/sys/class/net/*&#47;wireless` was empty at
 * late_command time, `$W` fell back to `wlan0`, and the install finished with
 * `/etc/wpa_supplicant/wpa_supplicant-wlan0.conf` holding a LIVE PSK for an
 * interface that has never existed, plus `wpa_supplicant@wlan0` enabled and a
 * `[Match] Name=wl*` networkd file aimed at the real radio. The driver landed
 * after first boot and the radio came up as `wlp9s0`, so none of it applied.
 *
 * An absent radio is the NORMAL case for every Broadcom card this fleet meets —
 * node-bootstrap section 5f installs the driver and 11b configures it. The
 * preseed's job there is to write nothing and say why.
 */
test('no wireless interface in the installer writes NO wifi config', () => {
	const { noRadio, withRadio } = runWifiBranch();

	assert.equal(
		noRadio.wpaConfs.length,
		0,
		`wrote ${noRadio.wpaConfs.join(', ')} for a radio the installer cannot see`
	);
	assert.equal(noRadio.networkdFiles.length, 0, 'wrote a networkd .network file with no radio');
	assert.deepEqual(noRadio.enabled, [], 'enabled a unit for an interface that does not exist');
	assert.ok(noRadio.marker, 'said nothing — "I could not look" must not render as silence');
	assert.match(noRadio.marker, /node-bootstrap/, 'the marker must name who picks the radio up');

	// The control. Absent the radio it must write nothing; PRESENT, it must
	// still write everything, under the derived name. A fix that simply stops
	// writing would pass every assertion above and break every wifi node.
	assert.deepEqual(withRadio.wpaConfs, ['wpa_supplicant-wlp9s0.conf']);
	assert.deepEqual(withRadio.enabled, ['wpa_supplicant@wlp9s0', 'systemd-networkd']);
	assert.equal(withRadio.networkdFiles.length, 1, 'the real radio still needs its DHCP file');
	assert.equal(withRadio.marker, '', 'a box that HAS a radio must not be told wifi was deferred');
});

/**
 * The stick images the WHOLE fleet, so it must not carry one node's name.
 *
 * Until 2026-08-30 `fleet onboard` asked for a hostname and preseeded it, which
 * silently made every stick single-use: the second node it imaged came up
 * answering to the first one's name, and a fleet with two claw-4s reports one
 * machine flapping rather than two machines working.
 */
test('no node name is baked in — the FALLBACK is a name node-bootstrap handles', () => {
	const out = render();
	const d = directives(out);

	// `seen false` ASKS d-i to re-ask the question. MEASURED 2026-09-01: it does
	// not get asked, and this test's name claimed for two days that it did.
	//
	// Ventoy's auto_install boots Debian with `priority=critical`, and the
	// priority filter suppresses every question below critical REGARDLESS of
	// `seen` — netcfg/get_hostname is priority high. So the directive is
	// correct, harmless, and does not do what it was added to do; claw-5 came up
	// as `localhost` because of this, not because networking was skipped.
	//
	// It stays because it costs nothing and would work at a lower priority. What
	// actually names a node is the fallback below plus node-bootstrap.sh, which
	// ASKS at the console and writes the hostname and /etc/hosts together.
	assert.ok(
		d.some((x) => x === 'd-i netcfg/get_hostname seen false'),
		'the hostname question must be re-askable, or one stick names the whole fleet identically'
	);

	// NOT belt and braces — this is the LOAD-BEARING half, since the question
	// above is never actually asked at priority=critical. The value left behind
	// must be one node-bootstrap.sh treats as "nobody named this box", so the
	// operator is asked at the console rather than the node being enrolled under
	// a placeholder for the rest of its life.
	const seeded = d.find((x) => x.startsWith('d-i netcfg/get_hostname string'));
	// `localhost` specifically, not `debian`: the fallback must not name a
	// distro. os.distro already lives in the profile, and a placeholder saying
	// "debian" becomes a statement the moment a second distro has a profile.
	assert.equal(
		seeded,
		'd-i netcfg/get_hostname string localhost',
		'the fallback must be a value node-bootstrap refuses, and must not name a distro'
	);
});

/**
 * No backticks in the generated file.
 *
 * The heredoc that renders this preseed is UNQUOTED, because it interpolates
 * the user, the key and the timezone. That also makes every backtick a command
 * substitution — evaluated as root, since `fleet onboard` re-execs under sudo.
 *
 * Five comments used backticks for code style and were executed at render time
 * on 2026-08-30, leaving holes in the output where the words should have been:
 * "# resets debconf's seen flag" with nothing in front of it. Nothing failed;
 * the file just quietly lost its explanations, and any backticked text that
 * happened to name a real command would have RUN.
 *
 * Quoting the delimiter would stop the execution and break the interpolation
 * the file exists for. So the rule is a rule, and this is what enforces it.
 */
test('the rendered preseed contains no backtick — they execute at render time', () => {
	for (const opts of [{}, { ssid: 'GarageNet', psk: 'hunter2hunter2' }]) {
		const out = render(opts);
		assert.ok(
			!out.includes('`'),
			'a backtick survived into the output, which means one was written into an ' +
				'unquoted heredoc and command-substituted as root'
		);
		// The tell-tale of the bug: a comment that starts with nothing.
		assert.ok(
			!/^#\s{2,}\w/m.test(
				out
					.split('\n')
					.filter((l) => l.startsWith('#'))
					.join('\n')
			) || !out.includes('#  resets'),
			'a comment lost its opening word to command substitution'
		);
	}
});

/**
 * The interface is chosen ON THE NODE, from what is actually there.
 *
 * 'choose_interface auto' takes the first interface with a carrier, which on a
 * desktop with an ethernet port and no cable is a coin flip — and it is what
 * failed claw-4 on 2026-08-30. early_command runs before netcfg, in the
 * installer environment, so the node can answer the question about itself.
 *
 * The two assertions below are about ESCAPING, which is where this went wrong
 * twice. The command must reach the stick as literal text: the first attempt
 * double-quoted it, so `$(ls /sys/class/net ...)` ran on the CONTROL HOST at
 * render time and baked hokon's own wlp13s0 into a file meant for other
 * machines.
 */
test('the interface picker reaches the node as a command, not as a result', () => {
	const out = render({ ssid: 'GarageNet', psk: 'hunter2hunter2' });
	assert.match(out, /d-i preseed\/early_command string/, 'the picker must be present');
	assert.match(
		out,
		/\$\(ls \/sys\/class\/net/,
		'the listing must be LITERAL — evaluated here it names the control host'
	);
	assert.match(out, /debconf-set netcfg\/choose_interface \$i/, 'and must set what it found');
});

test('no interface name from the machine that built the stick leaks in', () => {
	// The exact bug: hokon rendered `for i in \wlp13s0` because $( ) expanded at
	// assignment. Any concrete wl*/en* name in the output is that bug returning.
	for (const opts of [{}, { ssid: 'GarageNet', psk: 'hunter2hunter2' }]) {
		const picker = (render(opts).match(/early_command string[\s\S]*?netcfg will ask/) ?? [''])[0];
		assert.ok(
			!/\b(wl|en)[a-z]*\d+[a-z0-9]*\b/.test(picker),
			`a concrete interface name is baked into the picker — it must resolve on the ` +
				`node, not on the machine that wrote the stick`
		);
	}
});

test('the wireless branch exists only when there are credentials to use', () => {
	// A wl* interface with no PSK is worse than none: netcfg selects it, cannot
	// associate, and reports the same failure as an unplugged cable.
	assert.ok(!render().includes('picking wireless'), 'no credentials, no wireless branch');
	assert.ok(
		render({ ssid: 'GarageNet', psk: 'hunter2hunter2' }).includes('picking wireless'),
		'credentials given, wireless branch present'
	);
});

/**
 * netcfg/dhcp_options must stay unset.
 *
 * It is the menu offered AFTER a DHCP failure. Preseeding it answers "what
 * now?" identically every time — and answering "retry" turns a link that will
 * never get a lease into an infinite loop with no way out, because the menu
 * that would have offered manual configuration is the one being suppressed.
 */
test('the post-failure network menu is left for the operator', () => {
	for (const opts of [{}, { ssid: 'GarageNet', psk: 'hunter2hunter2' }]) {
		assert.ok(
			!directives(render(opts)).some((d) => d.startsWith('d-i netcfg/dhcp_options')),
			'preseeding this removes the only exit from a failed autoconfiguration'
		);
	}
});

/**
 * The install must leave evidence behind.
 *
 * d-i's logs live on a ramdisk that dies with it, so a failed install has
 * always left nothing to read — the operator photographs a screen and the
 * failure gets diagnosed from a sentence. This repo's rule is that "I could not
 * look" must never render as "nothing is wrong", and a stick that comes back
 * silent is exactly that.
 */
test('the installer writes telemetry to the stick', () => {
	const out = render();
	// NOT `mount LABEL=...` - busybox mount, which the installer has, does not
	// resolve labels. The device is found first, then mounted.
	assert.match(out, /mount -t ext4 "\$p" \/clawkit/, 'it has to reach the stick to write to it');
	assert.match(out, /dmesg > \$D\/dmesg\.txt/, 'dmesg is where a missing firmware names itself');
	assert.match(out, /cp \/var\/log\/syslog/, 'syslog carries the interface decision');
	// A hard power-off is the normal way an install dies. Without the sync the
	// last snapshot is still in page cache and the stick comes back empty.
	assert.match(out, /sync; N=\$\(\(N\+1\)\); sleep/, 'each pass must be flushed, not buffered');
});

test('telemetry commands reach the node literally, not evaluated here', () => {
	// Same escaping trap as the interface picker: $( ) written unquoted into
	// this heredoc runs on the machine BUILDING the stick.
	const out = render();
	assert.match(out, /\$\(date -u \+%Y%m%dT%H%M%SZ\)/, 'the run directory is named on the node');
	assert.ok(
		!/\/clawkit\/telemetry\/20\d{6}T/.test(out),
		'a concrete timestamp is baked in — that means $( ) evaluated at render time'
	);
});

/**
 * The box surveys itself, so the profile can be checked rather than trusted.
 *
 * Until now the profile DECLARED what a node was and nothing on the node ever
 * disagreed until node-bootstrap's lid check, which runs after the OS is
 * already installed. DMI chassis type, a battery and a lid switch are the
 * machine's own answer, available before the first partition is written.
 *
 * All of it is read from sysfs and procfs, never from a tool: lspci, iw and
 * dmidecode may not exist in the installer, and a survey that needs them
 * returns nothing on exactly the box that needed surveying.
 */
test('the installer surveys the hardware from sysfs, not from tools', () => {
	const out = render();
	for (const [what, probe] of [
		['chassis type', /\/sys\/class\/dmi\/id\/chassis_type/],
		['cpu', /\/proc\/cpuinfo/],
		['memory', /MemTotal \/proc\/meminfo/],
		['battery', /\/sys\/class\/power_supply/],
		['lid switch', /\/proc\/acpi\/button\/lid/],
		['per-nic driver', /net\.\$i\.driver=/],
		['per-nic wireless flag', /net\.\$i\.wireless=/],
		['disks', /disk\.\$d\.bytes=/],
	]) {
		assert.match(out, probe, `the survey must record ${what}`);
	}
});

test('the survey runs on the node, not on the machine building the stick', () => {
	const out = render();
	const hw = (out.match(/hardware\.txt[\s\S]{0,80}/) ?? [''])[0];
	assert.ok(hw.length > 0, 'the survey must write hardware.txt');
	// The control host is an x86 desktop with its own DMI strings; if any of
	// them appear, $( ) expanded here instead of there.
	assert.ok(
		!/Micro-Star|MS-7D70|Ryzen/.test(out),
		'a control-host DMI string leaked into the preseed'
	);
});

/**
 * The telemetry loop must not hold early_command open.
 *
 * d-i runs preseed/early_command and consumes its output. A subshell
 * backgrounded with a bare '&' inherits that pipe, so the parent reads until
 * EOF — which never comes while a child holds the write end. The installer
 * draws no screen, the console is dead, and because early_command never
 * returned no telemetry is written either: the diagnostic disappears along with
 * the thing it was diagnosing.
 *
 * Measured, not reasoned: reproducing it hung a test harness for two minutes.
 */
test('the telemetry loop drops inherited descriptors and does not run forever', () => {
	const out = render();
	assert.match(
		out,
		/<\/dev\/null >\/dev\/null 2>&1 & \) &/,
		'the loop must close stdin/stdout/stderr and double-fork, or it holds ' +
			"early_command's pipe open and the installer never starts"
	);
	assert.ok(
		!/\( while true; do/.test(out),
		'an unbounded loop outlives the install it was watching; bound it with a counter'
	);
});

/**
 * Telemetry must prove its filesystem is mounted, not that a directory exists.
 *
 * The first version guarded on '[ -d /clawkit ]' — a directory mkdir had
 * created one line earlier — so it was true whether the mount worked or not,
 * and every byte went to the installer's ramdisk and died with it. The stick
 * came back empty twice, looking exactly as though the loop had never run.
 */
test('telemetry finds the device and verifies the mount', () => {
	const out = render();
	// NOT blkid: it may not exist in the initrd, and it was both the lookup and
	// the fallback, so a missing binary skipped the whole block silently.
	assert.match(out, /modprobe ext4/, 'the filesystem module must be loaded before the mount');
	assert.match(
		out,
		/bootstrap\/node-bootstrap\.sh \] && break/,
		'the partition is identified by its contents'
	);
	assert.match(out, /grep -q " \/clawkit " \/proc\/mounts/, 'the guard must be /proc/mounts');
	assert.ok(
		!/if \[ -d \/clawkit \]; then/.test(out),
		'[ -d ] is true after mkdir regardless of the mount — it cannot be the guard'
	);
	assert.match(
		out,
		/T=\$\(\(T\+1\)\); sleep 2/,
		'and it must keep retrying while the device appears'
	);
});

/**
 * claw-4 and claw-6 install over ETHERNET, through the media bridge.
 *
 * The early_command has always preferred a wired interface with a carrier, but
 * nothing guaranteed the INSTALLED system kept it. netcfg writes a stanza for
 * the interface it was told to configure, and a run where networking is skipped
 * tells it none — so the system comes up holding only loopback, the port is
 * live, a cable does nothing, and node-bootstrap dies at the jq install saying
 * "check networking". That is precisely how claw-5 arrived.
 */
test('wired is preferred over wireless, and the ORDER is the whole rule', () => {
	const out = render({ ssid: 'Somewhere', psk: 'secret' });
	const wired = out.indexOf('picking wired');
	const wireless = out.indexOf('picking wireless');
	assert.ok(wired > -1, 'no wired branch in the interface picker');
	assert.ok(wireless > -1, 'no wireless branch when credentials were given');
	// A box with both a cable and credentials must take the cable. Reversing
	// these puts a fleet node on wifi while its switch port sits idle.
	assert.ok(wired < wireless, 'the wireless branch runs BEFORE the wired one');
	// BOUND TO THE PICKER, not to the file. The string `carrier ... = 1` also
	// appears in the late_command fallback, so a bare `includes` stayed green
	// when the picker's own carrier test was mutated away — measured. Assert it
	// sits in the branch that precedes 'picking wired'.
	const branch = out.slice(Math.max(0, wired - 240), wired);
	assert.match(
		branch,
		/carrier 2>\/dev\/null\)" = 1/,
		'the wired branch does not require a carrier, so it would claim a dead port'
	);
});

test('the installed system gets a wired stanza when d-i wrote none', () => {
	for (const opts of [{}, { ssid: 'Somewhere', psk: 'secret' }]) {
		const out = render(opts);
		assert.match(out, /iface\[\[:space:\]\]\+\(en\|eth\)/, 'no wired fallback in late_command');
		assert.ok(out.includes('iface %s inet dhcp'), 'the fallback writes no dhcp stanza');
		// GUARDED BOTH WAYS. It must not fight netcfg's own configuration, and
		// it must not invent one for a port with nothing plugged into it.
		assert.ok(
			out.includes('if ! grep -qE'),
			'the fallback is unconditional — it would fight netcfg on a normal install'
		);
		assert.ok(
			out.includes('/target/etc/network/interfaces'),
			'the fallback must write into the TARGET, not the installer'
		);
	}
});

/**
 * claw-4's install wrote a 854 MB syslog.txt onto a 1 GB partition — 7.5 million
 * lines, 99.9% of them one repeating PCIe AER message from a failing wifi card.
 * It came within 50 MB of filling CLAWKIT.
 *
 * Had it filled, the telemetry would have stopped, and it would have taken with
 * it the only evidence that diagnosed the fault. A diagnostic that destroys its
 * own medium under exactly the conditions it exists to record is worse than no
 * diagnostic.
 */
test('the syslog copy is capped, and says when it elided', () => {
	const out = render();
	assert.ok(
		!/^\s*cp \/var\/log\/syslog \$D\/syslog\.txt[^;]*;\s*\\$/m.test(out.replace(/\s+/g, ' ')) ||
			out.includes('TELEMETRY CAP'),
		'the syslog is copied without a size check'
	);
	assert.match(out, /TELEMETRY CAP/, 'nothing states that the log was truncated');
	assert.match(out, /head -c \d+/, 'the head of the log is not preserved');
	assert.match(out, /tail -c \d+/, 'the tail — where it died — is not preserved');
	// The cap must actually bound the result, not just annotate it.
	const head = Number(out.match(/head -c (\d+)/)?.[1]);
	const tail = Number(out.match(/tail -c (\d+)/)?.[1]);
	assert.ok(head > 0 && tail > 0 && head + tail < 20_000_000, `cap is ${head + tail} bytes`);
});

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

/**
 * §6.1 — the netinst partition (#51).
 *
 * These exercise the partition-reading helpers against a plain sparse FILE,
 * never a block device — `sfdisk`/`blkid -p -O/-S` resolve a GPT partition's
 * byte range identically whether `dev` is `/dev/sdg` or a regular file, which
 * is the property that lets this be proven here without root and without
 * touching CLAWKIT.
 */
const SBIN_PATH = `${process.env.PATH}:/usr/sbin:/sbin`;
const sbinEnv = () => ({ ...process.env, PATH: SBIN_PATH });

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

function pubkeyChoicesSnippet() {
	const src = readFileSync(NODE_USB_PREP, 'utf8');
	const start = src.indexOf(': PUBKEY-CHOICES-BEGIN');
	const end = src.indexOf(': PUBKEY-CHOICES-END');
	assert.ok(
		start > -1 && end > -1,
		'the PUBKEY-CHOICES sentinels are missing from node-usb-prep.sh'
	);
	return src.slice(start, end);
}

// Regression: on 2026-10-02 the operator's first interactive run died with
// "no .pub files in /home/hadoku/.ssh" while three keys sat in it. The span
// read $SEEN before assigning it, and `set -u` killed the subshell on its
// first key. Run the REAL span under the script's own shell options.
test('node-usb-prep.sh lists every ssh public key under set -u, the fleet key first and once', () => {
	const home = tempDir('pubkey-choices-');
	mkdirSync(join(home, '.ssh'));
	for (const name of ['id_ed25519.pub', 'id_ed25519_hokon.pub', 'phone_landing.pub']) {
		writeFileSync(join(home, '.ssh', name), `ssh-ed25519 AAAA ${name}-comment\n`);
	}
	const fleetKey = join(home, '.ssh', 'id_ed25519_hokon');
	const script = [
		'set -euo pipefail',
		`oper_home() { printf '%s' ${JSON.stringify(home)}; }`,
		`FLEET_KEY=${JSON.stringify(fleetKey)}`,
		pubkeyChoicesSnippet(),
		'printf "COUNT:%s\\n" "${#KEY_CHOICES[@]}"',
		'printf "ROW:%s\\n" "${KEY_CHOICES[@]}"',
	].join('\n');
	const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
	assert.match(out, /^COUNT:3$/m, `expected all three keys, deduplicated; got:\n${out}`);
	const rows = out.split('\n').filter((l) => l.startsWith('ROW:'));
	assert.match(
		rows[0],
		/id_ed25519_hokon\.pub.*the key every claw already authorises/,
		'the fleet key must be listed first and marked'
	);
	assert.equal(
		rows.filter((r) => r.includes('id_ed25519_hokon.pub')).length,
		1,
		'the fleet key must not be listed twice'
	);
});

function kitSpecSnippet() {
	const src = readFileSync(NODE_USB_PREP, 'utf8');
	const start = src.indexOf(': KIT-SPEC-BEGIN');
	const end = src.indexOf(': KIT-SPEC-END');
	assert.ok(start > -1 && end > -1, 'the KIT-SPEC sentinels are missing from node-usb-prep.sh');
	return src.slice(start, end);
}

// Regression: the first real full rebuild with --netinst-iso (2026-10-02)
// created CLAWKIT with `,,83` (all free space). That swallowed the whole
// 1,787 MB reserve, so the netinst append failed with "Invalid argument". The
// earlier image test pre-built all four partitions and never ran the step
// where CLAWKIT is carved out of the combined reserve. This one starts where
// Ventoy leaves the disk: two partitions, then a free tail exactly the size
// of CLAWKIT + netinst.
function runKitThenNetinst({ netinst }) {
	const KIT_MB = 16;
	const NETINST_MB = 40;
	const dir = tempDir('kit-spec-');
	const img = join(dir, 'disk.img');
	execFileSync('truncate', ['-s', `${1 + 16 + 8 + KIT_MB + NETINST_MB}MiB`, img]);
	execFileSync('sfdisk', [img], { input: 'label: dos\n', env: sbinEnv() });
	execFileSync('sfdisk', ['--append', img], { input: 'size=16MiB\n', env: sbinEnv() }); // Ventoy
	execFileSync('sfdisk', ['--append', img], { input: 'size=8MiB\n', env: sbinEnv() }); // VTOYEFI
	const script = [
		'set -euo pipefail',
		`KIT_MB=${KIT_MB}`,
		netinst ? `NETINST_ISO_MB=${NETINST_MB}` : 'NETINST_ISO_MB=""',
		kitSpecSnippet(),
		`echo "$KIT_SPEC" | sfdisk --append ${JSON.stringify(img)} >/dev/null`,
		netinst
			? `printf 'size=%sMiB\\n' "$NETINST_ISO_MB" | sfdisk --append ${JSON.stringify(img)} >/dev/null`
			: 'true',
	].join('\n');
	execFileSync('bash', ['-c', script], { env: sbinEnv(), stdio: 'pipe' });
	const dump = execFileSync('sfdisk', ['-d', img], { encoding: 'utf8', env: sbinEnv() });
	return dump.split('\n').filter((l) => /^\S+ : start=/.test(l));
}

test('with --netinst-iso, CLAWKIT is sized to its own share and partition 4 fits in the rest of the reserve', () => {
	const src = readFileSync(NODE_USB_PREP, 'utf8');
	assert.ok(
		src.includes(`printf 'size=%sMiB\\n' "$NETINST_ISO_MB"`),
		'the netinst append in node-usb-prep.sh changed; update this test to match it'
	);
	const parts = runKitThenNetinst({ netinst: true });
	assert.equal(
		parts.length,
		4,
		`expected Ventoy, VTOYEFI, CLAWKIT and netinst; got:\n${parts.join('\n')}`
	);
	assert.match(
		parts[2],
		/size=\s*32768\b/,
		`CLAWKIT should be exactly 16 MiB (32768 sectors); got ${parts[2]}`
	);
	assert.match(
		parts[3],
		/size=\s*81920\b/,
		`netinst should be exactly 40 MiB (81920 sectors); got ${parts[3]}`
	);
});

test('without --netinst-iso, CLAWKIT still takes all of the free reserve', () => {
	const parts = runKitThenNetinst({ netinst: false });
	assert.equal(parts.length, 3);
	assert.match(
		parts[2],
		/size=\s*114688\b/,
		`CLAWKIT should fill the 56 MiB tail; got ${parts[2]}`
	);
});
