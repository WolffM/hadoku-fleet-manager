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
 *
 * Split out of `make-preseed.test.mjs` (wave 5s lane D, 1,000-line test
 * ceiling): this file holds the content/interface-picking checks; see the
 * sibling `make-preseed-*.test.mjs` files for telemetry, boot, target-guard,
 * netinst, node-usb-prep.sh and CLAWKIT sizing.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { directives, render, runWifiBranch } from './make-preseed-fixtures.mjs';

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
