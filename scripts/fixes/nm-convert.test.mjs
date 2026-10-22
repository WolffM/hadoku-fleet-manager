/**
 * nm-convert.sh reboots a machine and can leave it off the network. Its test
 * therefore EXECUTES it rather than reading it.
 *
 * A grep-the-source test is worth very little for a script like this: it passes
 * on a script whose guard is present and inverted, and the failure it is meant
 * to catch — the teardown running when nmcli never converged — is a failure of
 * ORDERING, which source text does not express. So the whole script is driven
 * end to end inside a temp root (`NM_CONVERT_ROOT`) against stubbed `nmcli`,
 * `systemctl`, `ip` and `logger` that record every call, in two worlds: one
 * where NetworkManager converges and one where it never does.
 *
 * THE ASSERTION THAT MATTERS is the negative one. In the world where nmcli
 * never reports the radio connected, `/etc/network/interfaces` must come out
 * byte-identical and `systemctl reboot` must never be called. Delete the
 * `[ "$NM_VERIFIED" != yes ]` guard — or invert it — and both of those fail.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from '../lib/test-tmpdir.mjs';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'nm-convert.sh');
const src = readFileSync(SCRIPT, 'utf8');

const WLAN = 'wlp3s0';
const ADDR = '192.0.2.203';

/** claw-3's real /etc/network/interfaces, captured 2026-09-09. */
const IFACES = `# This file describes the network interfaces available on your system
# and how to activate them. For more information, see interfaces(5).

source /etc/network/interfaces.d/*

# The loopback network interface
auto lo
iface lo inet loopback

# The primary network interface
allow-hotplug ${WLAN}
iface ${WLAN} inet dhcp
	wpa-conf /etc/wpa_supplicant/wpa_supplicant-${WLAN}.conf
`;

/** claw-3's real wpa_supplicant config, with the PSKs replaced. */
const WPA = `ctrl_interface=/run/wpa_supplicant
update_config=1

network={
	ssid="ExampleNet_5G"
	psk="not-the-real-one"
	priority=10
}

network={
	ssid="ExampleNet"
	psk="not-the-real-one"
	priority=1
}
`;

function write(path, content, mode = 0o644) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	chmodSync(path, mode);
}

/**
 * A node that looks exactly like claw-3 does today: radio on ifupdown,
 * NetworkManager installed but reporting the device `unmanaged`.
 *
 * `nmcliState` is what the stubbed nmcli reports for the radio AFTER
 * `nmcli device set ... managed yes`, and `nmcliAddr` what the stubbed `ip`
 * reports for it — the two levers the two worlds differ by.
 */
function fixture({
	nmcliState,
	nmcliConn,
	nmcliAddr,
	nmAlreadyRunning = true,
	ifupdownSupplicant = false,
	procTableReadable = true,
}) {
	const root = tempDir('nm-convert-');
	write(join(root, 'etc/network/interfaces'), IFACES);
	write(join(root, `etc/wpa_supplicant/wpa_supplicant-${WLAN}.conf`), WPA, 0o600);
	write(join(root, 'run/network/ifstate'), `lo=lo\n${WLAN}=${WLAN}\n`);
	mkdirSync(join(root, `sys/class/net/${WLAN}/wireless`), { recursive: true });
	mkdirSync(join(root, 'sys/class/net/lo'), { recursive: true });

	const bin = join(root, 'bin');
	const calls = join(root, 'calls.log');
	const flag = join(root, 'handed-over');
	// THE SECOND FLAG, AND THE ONE THIS SCRIPT SHIPPED BROKEN WITHOUT.
	// NetworkManager reads conf.d only when it starts or is told to re-read its
	// config, so `[ifupdown] managed=true` does not exist for an NM that is
	// already running when the file is written. Modelling `device set managed
	// yes` as instantly effective — which this fixture used to do — is what let
	// a script that cannot convert claw-2 or claw-3 pass its own test suite.
	const reread = join(root, 'nm-config-read');
	const managedConf = join(root, 'etc/NetworkManager/conf.d/10-fleet-managed.conf');
	mkdirSync(bin, { recursive: true });

	const stub = (name, body) => {
		const p = join(bin, name);
		writeFileSync(p, `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >>"${calls}"\n${body}\n`);
		chmodSync(p, 0o755);
	};

	// Before the handover the radio is `unmanaged`, exactly as claw-2 and claw-3
	// report today. TWO things have to happen before the stub answers with the
	// world under test: NM must have re-read its configuration (so the ifupdown
	// plugin stops holding the radio unmanaged) AND it must have been told to
	// manage the device. Either one alone leaves it `unmanaged`, which is what
	// claw-3 reported for the full 60s of the verify loop on 2026-09-10.
	//
	// `con up` records the device state AT THE MOMENT IT IS CALLED, so the race
	// that NM reported as "No suitable device found ... device lo" is a visible
	// fact in calls.log rather than something a test has to infer.
	stub(
		'nmcli',
		`state() {
  if [ -f "${flag}" ] && [ -f "${reread}" ]; then echo "${nmcliState}"; else echo unmanaged; fi
}
case "$*" in
  "--version") echo "nmcli tool, version 1.52.1" ;;
  "general reload conf") [ -f "${managedConf}" ] && : >"${reread}" ;;
  *"device set"*"managed yes") : >"${flag}" ;;
  *"con up"*) printf 'nmcli-con-up-against-state %s\\n' "$(state)" >>"${calls}" ;;
  *"device status")
    if [ "$(state)" = unmanaged ]; then
      echo "${WLAN}:wifi:unmanaged:"
    else
      echo "${WLAN}:wifi:${nmcliState}:${nmcliConn}"
    fi
    echo "lo:loopback:connected (externally):lo" ;;
esac
exit 0`
	);
	// BEFORE the handover the node is up on ifupdown at its pinned lease — which
	// is the state the conversion reads its "before" address from. AFTER it, the
	// address is whatever NetworkManager managed to get, and an empty one is a
	// radio NM took and never brought up.
	stub(
		'ip',
		`if [ -f "${flag}" ]; then A="${nmcliAddr}"; else A="${ADDR}"; fi
case "$*" in
  *"-4 addr show ${WLAN}") [ -n "$A" ] && echo "3: ${WLAN}    inet $A/24 brd x scope global ${WLAN}" ;;
  *"route show default")   [ -n "$A" ] && echo "default via 192.0.2.254 dev ${WLAN} proto dhcp src $A metric 600" ;;
esac
exit 0`
	);
	// `restart` and `reload` always make NM re-read conf.d. `start` does so ONLY
	// when NM was not already running — that is the whole difference between
	// claw-7, which converted cleanly on 2026-09-09, and claw-2/claw-3, which
	// both report the unit `active` and where `start` is a silent no-op.
	stub(
		'systemctl',
		`case "$*" in
  "restart NetworkManager"|"reload NetworkManager") [ -f "${managedConf}" ] && : >"${reread}" ;;
  "start NetworkManager")
    ${nmAlreadyRunning ? ':' : `[ -f "${managedConf}" ] && : >"${reread}"`} ;;
esac
exit 0`
	);
	stub('logger', 'exit 0');
	// The process table, which is where "who owns the radio's control socket" is
	// actually answerable. The D-Bus instance NetworkManager drives is always
	// there; the `-i <iface>` one is ifupdown's, and it is the blocker.
	//
	// IT ANSWERS `-p 1` SEPARATELY, and that is the fixture's whole point rather
	// than pedantry. claw-2 and claw-3 mount /proc `hidepid=invisible`, so a
	// non-root `ps -eo args=` on them returns the caller's OWN processes — a
	// non-empty list with no supplicant in it — and pid 1 returns nothing at all.
	// A stub that answers every invocation identically cannot express that state,
	// and a stub that answered it with silence would be modelling a missing `ps`
	// instead. `procTableReadable: false` is claw-3 under a non-root caller,
	// verbatim.
	stub(
		'ps',
		`case "$*" in
  "-p 1 -o args=")
    ${procTableReadable ? 'echo "/sbin/init"' : ':'} ;;
  *)
${
	procTableReadable
		? `    echo "/usr/sbin/wpa_supplicant -u -s -O DIR=/run/wpa_supplicant GROUP=netdev"
    ${
			ifupdownSupplicant
				? `echo "/usr/sbin/wpa_supplicant -s -B -P /run/wpa_supplicant.${WLAN}.pid -i ${WLAN} -D nl80211,wext -c /etc/wpa_supplicant/wpa_supplicant-${WLAN}.conf"`
				: ':'
		}`
		: `    echo "-sh"
    echo "ps -eo args="`
}
    ;;
esac
exit 0`
	);
	// The verify loop's real 20 x 3s is the whole point of it on a node whose
	// association plus DHCP takes tens of seconds, and it must NOT be shortened
	// in the script for the test's convenience. Shadowing `sleep` keeps the
	// iteration count and the ordering exactly as they ship and costs the suite
	// a minute per failing case. Not recorded — it would drown calls.log.
	writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
	chmodSync(join(bin, 'sleep'), 0o755);

	return { root, bin, calls, flag, reread, iface: join(root, 'etc/network/interfaces') };
}

/**
 * Put the fixture in the state a node is in AFTER a successful conversion: NM
 * has re-read its config and holds the radio. Both flags, always — a test that
 * sets only one is describing a node that does not exist.
 */
function alreadyManaged(fx) {
	writeFileSync(fx.flag, '');
	writeFileSync(fx.reread, '');
}

function run(fx, args) {
	return spawnSync('sh', [SCRIPT, ...args], {
		encoding: 'utf8',
		env: {
			...process.env,
			NM_CONVERT_ROOT: fx.root,
			PATH: `${fx.bin}:${process.env.PATH}`,
		},
		// `sleep 3` x20 in the verify loop would make the failing case a
		// two-minute test. The stub PATH shadows nothing else timing-related.
		timeout: 120_000,
	});
}

const callsIn = (fx) => (existsSync(fx.calls) ? readFileSync(fx.calls, 'utf8') : '');

test('the conversion script is valid POSIX sh', () => {
	const r = spawnSync('sh', ['-n', SCRIPT], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
});

test('--check reads claw-3 as ifupdown, and says so rather than exiting 0', () => {
	const fx = fixture({ nmcliState: 'unmanaged', nmcliConn: '', nmcliAddr: ADDR });
	const r = run(fx, ['--check']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /ifupdown:\s+HOLDS wlp3s0/);
	assert.match(r.stdout, /on IFUPDOWN/);
});

test('--convert without --yes refuses, and touches nothing', () => {
	const fx = fixture({ nmcliState: 'connected', nmcliConn: 'fleet-wifi-primary', nmcliAddr: ADDR });
	const r = run(fx, ['--convert']);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /REBOOTS this node/);
	assert.equal(readFileSync(fx.iface, 'utf8'), IFACES);
	assert.equal(callsIn(fx), '');
});

test('SAFETY GATE: nmcli never converges — interfaces untouched, no reboot', () => {
	// The whole reason this file executes the script. `unmanaged` forever is the
	// shape of a radio NM was handed and could not associate: the profile is
	// wrong, the PSK is wrong, the SSID moved. If the teardown runs here the node
	// reboots into a commented-out ifupdown stanza and an NM profile that does
	// not work — with no ethernet port to recover it on.
	const fx = fixture({ nmcliState: 'unmanaged', nmcliConn: '', nmcliAddr: '' });
	const r = run(fx, ['--convert', '--yes']);

	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.equal(
		readFileSync(fx.iface, 'utf8'),
		IFACES,
		'/etc/network/interfaces was modified even though nmcli never verified'
	);
	assert.doesNotMatch(
		callsIn(fx),
		/systemctl reboot/,
		'the node was rebooted without a verified profile'
	);
	assert.match(r.stderr, /did not verify/);
	assert.match(r.stderr, /never modified/);
	// It also puts the node back where it was rather than leaving it half-moved.
	assert.match(callsIn(fx), /nmcli device set wlp3s0 managed no/);
	assert.match(callsIn(fx), /systemctl restart networking/);
	// And it disarms the watchdog it armed — a rollback that leaves a boot-time
	// reverter behind on an unconverted node is a reboot loop.
	assert.equal(existsSync(join(fx.root, 'etc/fleet-net-rollback.armed')), false);
});

test('SAFETY GATE: NM associates but on a NEW address — refused, not celebrated', () => {
	// hokon reaches claw-3 at a LAN IP pinned in ~/.ssh/config. A conversion that
	// draws a fresh DHCP lease produces a node that is healthy and unreachable at
	// the same time, and every fleet gate reads it as dead. `cloned-mac-address=
	// permanent` is what prevents it; this is what CATCHES it when that fails.
	const fx = fixture({
		nmcliState: 'connected',
		nmcliConn: 'fleet-wifi-primary',
		nmcliAddr: '192.0.2.77',
	});
	const r = run(fx, ['--convert', '--yes']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stderr, /came back on 192\.0\.2\.77/);
	assert.equal(readFileSync(fx.iface, 'utf8'), IFACES);
	assert.doesNotMatch(callsIn(fx), /systemctl reboot/);
});

test('the happy path converts, keeps lo, and reboots rather than ifdown/ifup', () => {
	const fx = fixture({ nmcliState: 'connected', nmcliConn: 'fleet-wifi-primary', nmcliAddr: ADDR });
	const r = run(fx, ['--convert', '--yes']);
	assert.equal(r.status, 0, r.stdout + r.stderr);

	const after = readFileSync(fx.iface, 'utf8');
	// lo is left alone deliberately: NM does not manage loopback, and commenting
	// it out would leave the box without 127.0.0.1 if NM failed to start.
	assert.match(after, /^auto lo$/m);
	assert.match(after, /^iface lo inet loopback$/m);
	assert.match(
		after,
		/^# fleet: managed by NetworkManager \(nm-convert\.sh\) -- allow-hotplug wlp3s0$/m
	);
	assert.match(
		after,
		/^# fleet: managed by NetworkManager \(nm-convert\.sh\) -- iface wlp3s0 inet dhcp$/m
	);
	// The backup is the anchor everything rolls back to.
	assert.equal(readFileSync(join(fx.root, 'etc/network/interfaces.fleet-pre-nm'), 'utf8'), IFACES);

	const calls = callsIn(fx);
	assert.match(calls, /systemctl reboot/);
	assert.doesNotMatch(calls, /\bifdown\b/, 'ifdown is the 2026-09-07 trap and must never be used');
	assert.doesNotMatch(calls, /\bifup\b/);
});

test('both of the node’s own SSIDs come across, with priority preserved', () => {
	const fx = fixture({ nmcliState: 'connected', nmcliConn: 'fleet-wifi-primary', nmcliAddr: ADDR });
	run(fx, ['--convert', '--yes']);
	const dir = join(fx.root, 'etc/NetworkManager/system-connections');
	const primary = readFileSync(join(dir, 'fleet-wifi-primary.nmconnection'), 'utf8');
	const fallback = readFileSync(join(dir, 'fleet-wifi-fallback.nmconnection'), 'utf8');

	// 5 GHz first. A node that comes back preferring 2.4 GHz is measured 3.8-5.6x
	// slower (garage-network-constraint) and would look "converted" either way.
	assert.match(primary, /^ssid=ExampleNet_5G$/m);
	assert.match(primary, /^autoconnect-priority=10$/m);
	assert.match(fallback, /^ssid=ExampleNet$/m);
	assert.match(fallback, /^autoconnect-priority=1$/m);

	// The address pin. Without both of these NM draws a new lease and the node
	// is unreachable at the address every fleet script resolves it to.
	for (const f of [primary, fallback]) {
		assert.match(f, /^cloned-mac-address=permanent$/m);
		assert.match(f, /^dhcp-client-id=mac$/m);
	}
});

test('the watchdog is armed BEFORE the radio moves, and covers the reboot', () => {
	const fx = fixture({ nmcliState: 'connected', nmcliConn: 'fleet-wifi-primary', nmcliAddr: ADDR });
	run(fx, ['--convert', '--yes']);
	const calls = callsIn(fx);
	const armed = calls.indexOf('systemctl enable fleet-net-rollback.timer');
	const handover = calls.indexOf(`nmcli device set ${WLAN} managed yes`);
	assert.ok(armed >= 0, 'the boot watchdog was never enabled');
	assert.ok(
		armed < handover,
		'the watchdog must be armed before the radio is handed over — arming it after ' +
			'leaves the one failure it exists for (NM takes the radio and never gives it back) uncovered'
	);
	assert.ok(existsSync(join(fx.root, 'etc/fleet-net-rollback.armed')));

	const unit = readFileSync(join(fx.root, 'etc/systemd/system/fleet-net-rollback.timer'), 'utf8');
	// NOT network-online.target: that target is never reached on the one boot
	// this exists for, so a unit ordered after it would never run.
	assert.match(unit, /OnBootSec=/);
	assert.doesNotMatch(unit, /network-online/);

	const wd = readFileSync(join(fx.root, 'usr/local/sbin/fleet-net-rollback'), 'utf8');
	assert.match(wd, /cp -a .*interfaces\.fleet-pre-nm/, 'the watchdog cannot restore ifupdown');
	assert.match(wd, /systemctl reboot/);
	assert.match(wd, /rm -f .*fleet-net-rollback\.armed/, 'the watchdog never disarms itself');
});

test('converting is idempotent — a converged node is a no-op, not a second pass', () => {
	// Re-running a script that reboots a node must not reboot it again.
	const fx = fixture({ nmcliState: 'connected', nmcliConn: 'fleet-wifi-primary', nmcliAddr: ADDR });
	// A converged node no longer has the radio in ifstate.
	writeFileSync(join(fx.root, 'run/network/ifstate'), 'lo=lo\n');
	alreadyManaged(fx);
	const r = run(fx, ['--convert', '--yes']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /already converged/);
	assert.doesNotMatch(callsIn(fx), /systemctl reboot/);
	assert.equal(readFileSync(fx.iface, 'utf8'), IFACES);
});

test('a wired-only claw is not a failure, it is a box with no radio', () => {
	// claw-4/5/6. Reporting them as "not converted" would put three permanent
	// reds on a gate for a fact about the hardware.
	const root = tempDir('nm-convert-wired-');
	mkdirSync(join(root, 'sys/class/net/enp0s31f6'), { recursive: true });
	const r = spawnSync('sh', [SCRIPT, '--check'], {
		encoding: 'utf8',
		env: { ...process.env, NM_CONVERT_ROOT: root },
	});
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /no wireless interface/);
});

test('it refuses a test root that does not exist rather than writing to /', () => {
	const r = spawnSync('sh', [SCRIPT, '--check'], {
		encoding: 'utf8',
		env: { ...process.env, NM_CONVERT_ROOT: '/nope/not/a/directory' },
	});
	assert.equal(r.status, 2);
	assert.match(r.stderr, /is not a directory/);
});

test('the safety gate exists exactly once, and the teardown sits behind it', () => {
	// The executable tests above are the real guard. This one names the line, so
	// that a future edit which moves the teardown out from behind it fails with
	// the reason rather than with six unrelated assertions.
	const gate = src.indexOf('NM_VERIFIED=no');
	const check = src.indexOf('if [ "$NM_VERIFIED" != yes ]; then');
	const teardown = src.indexOf('neutralise_ifupdown\n');
	const reboot = src.lastIndexOf('systemctl reboot');
	assert.ok(gate > 0 && check > gate, 'NM_VERIFIED is not checked after it is set');
	assert.ok(check < teardown, 'the ifupdown teardown is not behind the nmcli verification');
	assert.ok(teardown < reboot, 'the node reboots before its ifupdown stanza is neutralised');
	assert.equal(
		(src.match(/NM_VERIFIED=yes/g) ?? []).length,
		1,
		'NM_VERIFIED is set to yes in more than one place — there must be exactly one gate'
	);
});

test('a SPLIT node is not converged, and --convert refuses it in favour of a reboot', () => {
	// claw-7 on 2026-09-09: NetworkManager on the radio, ifupdown still holding
	// enp8s0 from the boot before its conversion, two default routes (metric 600
	// and 1002). `--check` read "converged" until this case was added, and the
	// stale route at the better metric is exactly how a box blackholes itself
	// when the cable comes out. The fix is a reboot — /run is tmpfs — and NOT a
	// second conversion, which would rewrite profiles from a wpa_supplicant
	// config that no longer describes this radio.
	const fx = fixture({ nmcliState: 'connected', nmcliConn: 'fleet-wifi-primary', nmcliAddr: ADDR });
	writeFileSync(join(fx.root, 'run/network/ifstate'), 'lo=lo\nenp8s0=enp8s0\n');
	alreadyManaged(fx);

	const chk = run(fx, ['--check']);
	assert.equal(chk.status, 1, chk.stdout + chk.stderr);
	assert.match(chk.stderr, /SPLIT STACK/);
	assert.match(chk.stderr, /ifupdown still holds: enp8s0/);

	const conv = run(fx, ['--convert', '--yes']);
	assert.equal(conv.status, 1, conv.stdout + conv.stderr);
	assert.match(conv.stderr, /Reboot this node/);
	assert.doesNotMatch(callsIn(fx), /systemctl reboot/);
	assert.equal(readFileSync(fx.iface, 'utf8'), IFACES);
});

test('REGRESSION: an ALREADY-RUNNING NetworkManager must be made to re-read conf.d', () => {
	// claw-3, 2026-09-10 04:47Z. The script wrote 10-fleet-managed.conf, ran
	// `nmcli con reload` (which reloads connection PROFILES, not the config) and
	// `systemctl start NetworkManager` (a no-op — the unit was already active),
	// so `[ifupdown] managed=true` was never read. NM audited the handover as
	// `result="success"`, logged no device state change at all, and 60s later the
	// verify loop still read `unmanaged`. The conversion rolled itself back.
	//
	// The fixture's stub only sets its re-read flag if 10-fleet-managed.conf is
	// already on disk when NM is restarted, so a pass here also proves the
	// ordering: the config is written BEFORE the restart that reads it.
	const fx = fixture({
		nmcliState: 'connected',
		nmcliConn: 'fleet-wifi-primary',
		nmcliAddr: ADDR,
		nmAlreadyRunning: true,
	});
	const r = run(fx, ['--convert', '--yes']);
	assert.equal(
		r.status,
		0,
		'the conversion did not converge on a node whose NetworkManager was already ' +
			'running — this is claw-3 on 2026-09-10 exactly\n' +
			r.stdout +
			r.stderr
	);
	const calls = callsIn(fx);
	assert.match(
		calls,
		/systemctl (restart|reload) NetworkManager/,
		'NetworkManager was never restarted or reloaded, so it never re-read conf.d'
	);
	assert.match(calls, /systemctl reboot/);
});

test('REGRESSION: the profile is never activated against a radio still `unmanaged`', () => {
	// claw-3, 21:47:29.9800 — 30ms after the handover:
	//   op="connection-activate" name="fleet-wifi-primary" result="fail"
	//   reason="No suitable device found for this connection (device lo not
	//           available because profile is not compatible with device ...)"
	// NM was searching a device list the radio was not in yet. On claw-7
	// `autoconnect=true` covered for it, which is the only reason this shipped.
	const fx = fixture({ nmcliState: 'connected', nmcliConn: 'fleet-wifi-primary', nmcliAddr: ADDR });
	run(fx, ['--convert', '--yes']);
	const calls = callsIn(fx);
	assert.match(calls, /nmcli-con-up-against-state connected/, 'the profile was never activated');
	assert.doesNotMatch(
		calls,
		/nmcli-con-up-against-state unmanaged/,
		'a profile was activated against a radio NetworkManager had not taken yet'
	);
});

test('a radio NM will not take is diagnosed by name, and still rolls back through the one gate', () => {
	// The other half of the fix: when the radio does NOT leave `unmanaged`, the
	// script must say which fact it is missing rather than sitting out the verify
	// loop and reporting a generic timeout — and it must not invent a second exit
	// path around NM_VERIFIED.
	const fx = fixture({ nmcliState: 'unmanaged', nmcliConn: '', nmcliAddr: '' });
	const r = run(fx, ['--convert', '--yes']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stderr, /STILL 'unmanaged' after 20s/);
	assert.match(r.stderr, /10-fleet-managed\.conf/);
	assert.doesNotMatch(callsIn(fx), /nmcli-con-up-against-state/, 'it activated anyway');
	assert.equal(readFileSync(fx.iface, 'utf8'), IFACES);
	assert.doesNotMatch(callsIn(fx), /systemctl reboot/);
});

test('the claw-7 world — NM NOT already running — converged even unfixed', () => {
	// Why a broken script looked fine on 2026-09-09. claw-7 had NetworkManager
	// stopped, so `systemctl start` genuinely started it and it read conf.d on
	// the way up. claw-2 and claw-3 both report the unit `active`, so the same
	// line did nothing. The bug was a difference between the NODES, and diffing
	// them is what found it — CLAUDE.md's rule, and the fourth time it has paid.
	const fx = fixture({
		nmcliState: 'connected',
		nmcliConn: 'fleet-wifi-primary',
		nmcliAddr: ADDR,
		nmAlreadyRunning: false,
	});
	const r = run(fx, ['--convert', '--yes']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(callsIn(fx), /systemctl reboot/);
});

test('IMPASSE: a radio ifupdown holds through its own supplicant is refused, untouched', () => {
	// claw-3, 2026-09-10 05:00Z. NetworkManager took the device correctly and then:
	//   Couldn't initialize supplicant interface: wpa_supplicant couldn't grab this
	//   interface ... re-acquiring (#1..#5) ... keeps failing, giving up
	// ifupdown's `wpa-conf` supplicant owns /run/wpa_supplicant/wlp3s0, and the
	// D-Bus supplicant NM drives cannot create a control interface over it. The
	// radio stops at `unavailable`, so `connected` — which the safety gate
	// requires BEFORE the ifupdown teardown — is unreachable by construction.
	//
	// Refusing up front is the point: no watchdog armed, no radio handed over,
	// nothing to roll back on a box with no ethernet port.
	const fx = fixture({
		nmcliState: 'unavailable',
		nmcliConn: '',
		nmcliAddr: ADDR,
		ifupdownSupplicant: true,
	});
	const r = run(fx, ['--convert', '--yes']);

	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stderr, /own wpa_supplicant/);
	assert.match(r.stderr, /couldn't grab/);
	assert.equal(readFileSync(fx.iface, 'utf8'), IFACES);
	const calls = callsIn(fx);
	assert.doesNotMatch(calls, /systemctl reboot/);
	// The three things that must NOT have happened, because it refused BEFORE
	// them rather than at the safety gate 80 seconds later.
	assert.equal(
		existsSync(join(fx.root, 'etc/fleet-net-rollback.armed')),
		false,
		'the watchdog was armed on a node the script then refused to convert'
	);
	assert.doesNotMatch(calls, /nmcli device set wlp3s0 managed yes/, 'the radio was handed over');
	assert.equal(
		existsSync(
			join(fx.root, 'etc/NetworkManager/system-connections/fleet-wifi-primary.nmconnection')
		),
		false,
		'profiles were written for a conversion that cannot proceed'
	);
});

test('IMPASSE: --check names the competing supplicant rather than only "on IFUPDOWN"', () => {
	// "I could not look" must never render as "nothing is wrong", and neither
	// must "I looked and cannot tell you why". claw-2 and claw-3 both read
	// `unmanaged` on ifupdown; only the supplicant line says why converting them
	// is blocked rather than merely pending.
	const fx = fixture({
		nmcliState: 'unmanaged',
		nmcliConn: '',
		nmcliAddr: ADDR,
		ifupdownSupplicant: true,
	});
	const r = run(fx, ['--check']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /on IFUPDOWN/);
	assert.match(r.stdout, /OWN wpa_supplicant/);
});

test('COULD NOT LOOK: an unreadable process table refuses the conversion, it does not clear it', () => {
	// claw-2 and claw-3 mount /proc with `hidepid=invisible` — measured on both,
	// 2026-09-26, while claw-4 does not. Under a non-root caller `ps -eo args=`
	// there lists the caller's own seven processes and neither wpa_supplicant, so
	// the question "does ifupdown hold this radio through its own supplicant"
	// answered NO for the wrong reason.
	//
	// The old code was `if ifupdown_holds && ifupdown_supplicant`, and a shell
	// `&&` cannot tell 2 from 1: an unasked question scored as "nothing in the
	// way", and the script went on to arm a boot watchdog and hand over the radio
	// of a Surface with no ethernet port. This is the node whose process table is
	// blind but which IS in fact impassable — the worst case, and the one that
	// used to pass.
	const fx = fixture({
		nmcliState: 'unmanaged',
		nmcliConn: '',
		nmcliAddr: ADDR,
		ifupdownSupplicant: true,
		procTableReadable: false,
	});
	const r = run(fx, ['--convert', '--yes']);

	// 2 is this script's "could not look", distinct from 1 = "looked, not converged".
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.match(r.stderr, /COULD NOT BE READ/);
	assert.match(r.stderr, /pid 1/);
	assert.match(r.stderr, /hidepid/);

	// The same three negatives the readable impasse asserts: it refused BEFORE
	// touching anything, not at the safety gate eighty seconds later.
	assert.equal(readFileSync(fx.iface, 'utf8'), IFACES);
	const calls = callsIn(fx);
	assert.doesNotMatch(calls, /systemctl reboot/);
	assert.doesNotMatch(calls, /nmcli device set wlp3s0 managed yes/, 'the radio was handed over');
	assert.equal(
		existsSync(join(fx.root, 'etc/fleet-net-rollback.armed')),
		false,
		'the watchdog was armed on a node whose convertibility was never established'
	);
	assert.equal(
		existsSync(
			join(fx.root, 'etc/NetworkManager/system-connections/fleet-wifi-primary.nmconnection')
		),
		false,
		'profiles were written for a conversion that was never cleared to proceed'
	);
});

test('COULD NOT LOOK: --check says it could not look rather than staying silent', () => {
	// The quieter half of the same bug. `--check` does not require root, so this
	// IS its ordinary shape over ssh: `ssh claw-3 sh -s -- --check`. It printed
	// "on IFUPDOWN" and then nothing, which reads as a normal convert candidate —
	// the supplicant line is the only thing that distinguishes blocked from
	// merely pending, and its absence has to be stated, not inferred.
	const fx = fixture({
		nmcliState: 'unmanaged',
		nmcliConn: '',
		nmcliAddr: ADDR,
		ifupdownSupplicant: true,
		procTableReadable: false,
	});
	const r = run(fx, ['--check']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /on IFUPDOWN/);
	assert.match(r.stderr, /COULD NOT BE READ/);
	assert.match(r.stderr, /sudo sh nm-convert\.sh --check/);
	// And it does not invent the impasse it could not observe.
	assert.doesNotMatch(r.stdout, /OWN wpa_supplicant/);
});

test('COULD NOT LOOK is not the same as NO: a blind table never reads as convertible', () => {
	// The asymmetry that makes the guard worth having. Same node, same blind
	// process table, but nothing is actually holding the radio — the conversion
	// would have SUCCEEDED. It is still refused, because the script cannot tell
	// this node from the one above, and guessing right half the time on a box
	// with no ethernet port is not a safety property.
	const fx = fixture({
		nmcliState: 'connected',
		nmcliConn: 'fleet-wifi-primary',
		nmcliAddr: ADDR,
		ifupdownSupplicant: false,
		procTableReadable: false,
	});
	const r = run(fx, ['--convert', '--yes']);
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.equal(readFileSync(fx.iface, 'utf8'), IFACES);
	assert.doesNotMatch(callsIn(fx), /systemctl reboot/);
});

test('a wired-radio node has no competing supplicant and is NOT refused', () => {
	// The other side of the impasse check, and claw-7's case: no `-i <iface>`
	// supplicant in the process table, so nothing blocks the handover. Without
	// this, a refusal keyed on "ifupdown holds the radio" would block every
	// conversion including the one shape that demonstrably works.
	const fx = fixture({
		nmcliState: 'connected',
		nmcliConn: 'fleet-wifi-primary',
		nmcliAddr: ADDR,
		ifupdownSupplicant: false,
	});
	const r = run(fx, ['--convert', '--yes']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.doesNotMatch(r.stderr, /own wpa_supplicant/);
	assert.match(callsIn(fx), /systemctl reboot/);
});
