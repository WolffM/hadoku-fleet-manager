/**
 * The installer must leave evidence behind, and must not stall itself doing
 * it: telemetry, hardware survey, wired/wireless network stanzas and the
 * syslog cap this suite guards. Split out of `make-preseed.test.mjs` (wave 5s
 * lane D, 1,000-line test ceiling); see `make-preseed-content.test.mjs` for
 * the rest of this file's original header.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { render } from './make-preseed-fixtures.mjs';

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
