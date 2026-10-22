/**
 * The fixture is a VERBATIM capture from claw-1, 2026-09-08.
 *
 * It is worth having as real bytes rather than as a tidy invention, because
 * every awkward thing in it is a thing that actually happens and that a
 * hand-written fixture would have smoothed away: `lo` and `tailscale0` appear
 * in the address listing but not in the interface listing (they are filtered on
 * the node), the address lines carry a trailing `\` and a `valid_lft` tail, and
 * claw-1's ethernet port is present with a MAC and NO address — it is the
 * unused port the fleet has never plugged in.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
	parseInterfaces,
	preferredAddress,
	proposeLanRecord,
	isIpv4,
	parseWifiManager,
	sshTarget,
	sshNameCandidates,
	chooseSshHostName,
	INTERFACE_PROBE,
	WIFI_MANAGER_PROBE,
	SSH_SUFFIX_ENV,
} from './node-interfaces.mjs';

const CLAW_1 = `ADDR 1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever
ADDR 3: wlp5s0    inet 192.0.2.122/24 brd 192.0.2.255 scope global dynamic noprefixroute wlp5s0\\       valid_lft 10604sec preferred_lft 10604sec
ADDR 4: tailscale0    inet 198.51.100.114/32 scope global tailscale0\\       valid_lft forever preferred_lft forever
IF enp4s0 no 02:00:00:00:00:01
IF wlp5s0 yes 02:00:00:00:00:02`;

test('parses claw-1 exactly as captured', () => {
	assert.deepEqual(parseInterfaces(CLAW_1), [
		{ name: 'enp4s0', wireless: false, mac: '02:00:00:00:00:01', ipv4: null },
		{ name: 'wlp5s0', wireless: true, mac: '02:00:00:00:00:02', ipv4: '192.0.2.122' },
	]);
});

test('the wired port with a MAC and no address survives parsing', () => {
	// claw-1 has an unused gigabit port. Dropping an interface for want of an
	// address would hide the very thing worth knowing about it — see
	// `garage-network-constraint`: wiring it is a free 4x.
	const wired = parseInterfaces(CLAW_1).find((i) => i.name === 'enp4s0');
	assert.equal(wired.ipv4, null);
	assert.equal(wired.mac, '02:00:00:00:00:01');
});

test('tailscale and loopback addresses do not leak in', () => {
	// They appear in the ADDR listing and are filtered from the IF listing on the
	// node. If either ever became an "interface" here, the fleet could end up
	// addressing a claw on 100.64.x — measured unusable from hokon (the ssh
	// attempt times out at 30s; NordVPN blocks direct and DERP is too slow).
	const names = parseInterfaces(CLAW_1).map((i) => i.name);
	assert.deepEqual(names, ['enp4s0', 'wlp5s0']);
});

test('the preferred address is the radio — the link that survives a cable pull', () => {
	const pref = preferredAddress(parseInterfaces(CLAW_1));
	assert.equal(pref.name, 'wlp5s0');
	assert.equal(pref.ipv4, '192.0.2.122');
	// And that IS claw-1's ssh HostName, which is why claw-1 stays reachable
	// however its ethernet port is treated.
});

test('a wired-only node has no preferred address rather than a wrong one', () => {
	// claw-4/5/6 are wired with no radio at all. Returning the wired interface
	// here would assert "this survives a cable pull" about a cable.
	const wiredOnly = parseInterfaces(
		'ADDR 2: enp0s31f6    inet 192.0.2.158/24 brd x\nIF enp0s31f6 no 02:00:00:00:00:aa'
	);
	assert.equal(preferredAddress(wiredOnly), null);
});

test('empty output yields no interfaces, not a crash', () => {
	// "I could not look" must not render as a node with one nameless interface.
	assert.deepEqual(parseInterfaces(''), []);
	assert.equal(preferredAddress([]), null);
});

test('the probe filters the interfaces whose addresses must never be used', () => {
	for (const skip of ['tailscale*', 'docker*', 'veth*', 'br-*']) {
		assert.ok(INTERFACE_PROBE.includes(skip), `the probe must skip ${skip}`);
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// WHICH STACK OWNS THE RADIO
// ═══════════════════════════════════════════════════════════════════════════
//
// Every fixture below is a VERBATIM capture taken by running WIFI_MANAGER_PROBE
// against the live claw named, 2026-09-09. They are the whole fleet, and the
// point of keeping all seven is that the fleet holds FOUR different answers —
// which is precisely what issue #8 is about, and what a two-node fixture set
// would have flattened into "NM or not".

const PROBE_CAPTURES = {
	// NetworkManager, but on a HAND-MADE profile named after the SSID rather
	// than a fleet-* one. Converged as far as "which manager", not as far as
	// "the same shape".
	'claw-1': `WMGR radio wlp5s0
WMGR nmcli 1.52.1
WMGR dev wlp5s0:wifi:connected:ExampleNet_5G
WMGR dev tailscale0:tun:connected (externally):tailscale0
WMGR dev lo:loopback:connected (externally):lo
WMGR dev p2p-dev-wlp5s0:wifi-p2p:disconnected:
WMGR dev enp4s0:ethernet:unavailable:
WMGR profile ExampleNet_5G
WMGR profile ExampleNet`,
	// ifupdown. NOTE that nmcli answers and NetworkManager is RUNNING on this
	// box — the radio is simply not its. Anything that asked "is NM installed"
	// or "is NM running" would call claw-2 converged.
	'claw-2': `WMGR radio wlp1s0
WMGR nmcli 1.52.1
WMGR dev tailscale0:tun:connected (externally):tailscale0
WMGR dev lo:loopback:connected (externally):lo
WMGR dev wlp1s0:wifi:unmanaged:
WMGR ifupdown wlp1s0`,
	'claw-3': `WMGR radio wlp3s0
WMGR nmcli 1.52.1
WMGR dev tailscale0:tun:connected (externally):tailscale0
WMGR dev lo:loopback:connected (externally):lo
WMGR dev wlp3s0:wifi:unmanaged:
WMGR ifupdown wlp3s0`,
	// Wired-only desktops. No radio, no nmcli at all, ifupdown on the cable.
	'claw-4': 'WMGR radio -\nWMGR nmcli -\nWMGR ifupdown enp0s31f6',
	'claw-5': 'WMGR radio -\nWMGR nmcli -\nWMGR ifupdown enp5s0',
	'claw-6': 'WMGR radio -\nWMGR nmcli -\nWMGR ifupdown enp3s0',
	// Converted by node-bootstrap 11b on 2026-09-08 and STILL SPLIT: NM holds
	// the radio, ifupdown still holds enp8s0 from the boot before the
	// conversion. `ip route` on this box shows two default routes, metric 600
	// (NM, wifi) and 1002 (the installer's dhclient, wired).
	'claw-7': `WMGR radio wlp9s0
WMGR nmcli 1.52.1
WMGR dev wlp9s0:wifi:connected:fleet-wifi-primary
WMGR dev tailscale0:tun:connected (externally):tailscale0
WMGR dev lo:loopback:connected (externally):lo
WMGR dev enp8s0:ethernet:disconnected:
WMGR dev eno1:ethernet:unavailable:
WMGR profile fleet-wifi-fallback
WMGR profile fleet-wifi-primary
WMGR profile fleet-wired
WMGR ifupdown enp8s0`,
};

test('the fleet as measured on 2026-09-09 — four answers across seven claws', () => {
	const got = Object.fromEntries(
		Object.entries(PROBE_CAPTURES).map(([n, out]) => [n, parseWifiManager(out).manager])
	);
	assert.deepEqual(got, {
		'claw-1': 'networkmanager',
		'claw-2': 'ifupdown',
		'claw-3': 'ifupdown',
		'claw-4': 'none',
		'claw-5': 'none',
		'claw-6': 'none',
		'claw-7': 'split',
	});
});

test('a running NetworkManager is NOT the question — claw-2 has one and is on ifupdown', () => {
	// The discriminator this replaced. NM's own wifi backend IS wpa_supplicant,
	// and NM is installed and answering on claw-2 and claw-3, so both "is the
	// unit active" and "is nmcli present" score them as converged. Only the
	// radio's own device state and ifupdown's own ifstate get it right.
	const claw2 = parseWifiManager(PROBE_CAPTURES['claw-2']);
	assert.equal(claw2.nmVersion, '1.52.1');
	assert.equal(claw2.nmState, 'unmanaged');
	assert.equal(claw2.manager, 'ifupdown');
	assert.match(claw2.reason, /ifupdown holds wlp1s0/);
});

test('claw-7 is SPLIT even though NetworkManager holds its radio', () => {
	// The state 11b exists to prevent, found on a node 11b had already
	// converted: the stanza was commented out but /run/network/ifstate was not
	// cleared, so the pre-conversion dhclient lease and its default route
	// survive until the next reboot. A stale wired default route outlives the
	// carrier it was learned on — that is how a pulled cable blackholes a box.
	const r = parseWifiManager(PROBE_CAPTURES['claw-7']);
	assert.equal(r.manager, 'split');
	assert.equal(r.nmConnection, 'fleet-wifi-primary');
	assert.deepEqual(r.ifupdownHolds, ['enp8s0']);
	assert.match(r.reason, /ifupdown still holds enp8s0/);
});

test('a wired-only claw reports `none`, and `none` is not a fault', () => {
	// claw-4/5/6 have no radio. Folding them in with the wifi claws when asking
	// "do all the claws match" would put three permanent reds on a gate for a
	// fact about the hardware.
	const r = parseWifiManager(PROBE_CAPTURES['claw-4']);
	assert.equal(r.manager, 'none');
	assert.equal(r.radio, null);
	assert.deepEqual(r.ifupdownHolds, ['enp0s31f6']);
});

test('an unreachable node reports `unknown`, never `none`', () => {
	// "I could not look" must never render as "nothing is wrong" — and `none`
	// here would mean "measured, and this box has no radio", which is a
	// completely different sentence about claw-3.
	for (const empty of ['', '   \n\n', 'ssh: connect to host claw-3 port 22: No route to host']) {
		const r = parseWifiManager(empty);
		assert.equal(r.manager, 'unknown');
		assert.match(r.reason, /produced no output/);
	}
});

test('a radio nobody configures is `unmanaged`, which is an answer, not a shrug', () => {
	const r = parseWifiManager('WMGR radio wlan0\nWMGR nmcli 1.52.1\nWMGR dev wlan0:wifi:unmanaged:');
	assert.equal(r.manager, 'unmanaged');
	assert.match(r.reason, /nothing configures it/);
});

test('an nmcli connection name containing a colon does not shift the fields', () => {
	// `nmcli -t` escapes a literal colon as `\:`. Splitting naively puts the
	// state in the connection column and reads a connected radio as unmanaged.
	const r = parseWifiManager(
		'WMGR radio wlan0\nWMGR nmcli 1.52.1\nWMGR dev wlan0:wifi:connected:Guest\\: 5G'
	);
	assert.equal(r.nmState, 'connected');
	assert.equal(r.nmConnection, 'Guest: 5G');
	assert.equal(r.manager, 'networkmanager');
});

test('the probe reads the two files the two stacks write, not a config we wrote', () => {
	// A verifier that reads its own writer's artifact cannot fail. Both of these
	// are written by the stack being detected.
	assert.ok(WIFI_MANAGER_PROBE.includes('/run/network/ifstate'), 'ifupdown state file');
	assert.ok(WIFI_MANAGER_PROBE.includes('device status'), "NetworkManager's device list");
	assert.ok(
		!/is-active|is-enabled/.test(WIFI_MANAGER_PROBE),
		"a wpa_supplicant or NetworkManager unit's state is not the question — NM runs on the ifupdown claws too"
	);
});

// ═══════════════════════════════════════════════════════════════════════════
// THE ONE SSH RESOLVER
// ═══════════════════════════════════════════════════════════════════════════

test('a node name resolves to itself when no suffix is declared', () => {
	assert.equal(sshTarget('claw-3', {}), 'claw-3');
	assert.equal(sshTarget('  claw-3  ', {}), 'claw-3');
	assert.equal(sshTarget('hokon', { [SSH_SUFFIX_ENV]: '' }), 'hokon');
});

test('a declared suffix moves every ssh path at once', () => {
	// The tailnet migration issue #8 asks for is this env var, not six edits.
	// It is not the default because Tailscale SSH check-mode intercepts the
	// tailnet path — see the comment on sshTarget; verified 2026-09-09.
	assert.equal(
		sshTarget('claw-3', { [SSH_SUFFIX_ENV]: 'example.ts.net' }),
		'claw-3.example.ts.net'
	);
	assert.equal(
		sshTarget('claw-3', { [SSH_SUFFIX_ENV]: '.example.ts.net.' }),
		'claw-3.example.ts.net'
	);
});

test('an already-qualified name is not suffixed twice', () => {
	const env = { [SSH_SUFFIX_ENV]: 'example.ts.net' };
	assert.equal(sshTarget('claw-3.example.ts.net', env), 'claw-3.example.ts.net');
});

test('an IP literal is refused — an address is a lease, not an identity', () => {
	// This is the enforceable half of "ssh targets are names". claw-3 moved
	// during the 2026-09-07 SSID rename and six scripts read a live node as
	// unreachable, because each of them had let ~/.ssh/config's pinned address
	// stand in for the node.
	assert.throws(() => sshTarget('192.0.2.203'), /is an IP address, not a node name/);
	assert.throws(() => sshTarget('198.51.100.128'), /is an IP address, not a node name/);
	// A name that merely CONTAINS digits is fine.
	assert.equal(sshTarget('claw-10', {}), 'claw-10');
});

test('an empty or non-string node is a TypeError, not a bare `ssh`', () => {
	// `ssh ""` opens an interactive prompt-shaped hang under BatchMode; naming
	// the caller's bug here is cheaper than reading it out of a cron timeout.
	for (const bad of ['', '   ', null, undefined, 3, {}]) {
		assert.throws(() => sshTarget(bad, {}), /non-empty name/);
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// THE WRITE SIDE — WHAT GOES IN `HostName`
// ═══════════════════════════════════════════════════════════════════════════

test('the candidates are names, most durable first, and never an address', () => {
	// With no suffix declared there is exactly one name worth trying, and it is
	// not the bare node name: `HostName claw-3` in a block headed `Host claw-3`
	// is a resolver question disguised as a config entry.
	assert.deepEqual(
		sshNameCandidates('claw-3', {}).map((c) => c.name),
		['claw-3.local']
	);
	assert.deepEqual(
		sshNameCandidates('claw-3', { [SSH_SUFFIX_ENV]: 'example.ts.net' }).map((c) => c.name),
		['claw-3.example.ts.net', 'claw-3.local']
	);
	// Every candidate says WHY it is one, so a rejection is reportable.
	for (const c of sshNameCandidates('claw-3', { [SSH_SUFFIX_ENV]: 'ts.net' })) {
		assert.ok(c.why.length > 10, `${c.name} has no reason`);
	}
});

test('a PROVEN name wins, and the entry is not pinned to a lease', () => {
	const r = chooseSshHostName({
		node: 'claw-3',
		address: '192.0.2.203',
		probes: [
			{ name: 'claw-3.example.ts.net', reachable: true, reason: 'answered ssh' },
			{ name: 'claw-3.local', reachable: false, reason: 'could not resolve' },
		],
	});
	assert.equal(r.hostName, 'claw-3.example.ts.net');
	assert.equal(r.kind, 'name');
	assert.equal(r.pinnedToLease, false);
});

test('the FIRST proven candidate wins — order is durability, not luck', () => {
	const r = chooseSshHostName({
		node: 'claw-3',
		address: '192.0.2.203',
		probes: [
			{ name: 'claw-3.example.ts.net', reachable: true },
			{ name: 'claw-3.local', reachable: true },
		],
	});
	assert.equal(r.hostName, 'claw-3.example.ts.net');
});

test('THE FLEET AS IT IS TODAY: no name answers, so the address is written — and SAID to be a pin', () => {
	// Measured 2026-09-26. The tailnet name resolves for all eight claws and
	// then hangs: `enroll-node.mjs` runs `tailscale up --ssh`, so tailscaled is
	// in front of port 22 and this tailnet's ACL answers `check` with a browser
	// login. No claw publishes mDNS — avahi-daemon is not installed on any of
	// them. Both reasons have to survive into the output, because one is an ACL
	// change in a web console and the other is a package on eight boxes.
	const r = chooseSshHostName({
		node: 'claw-3',
		address: '192.0.2.203',
		probes: [
			{
				name: 'claw-3.example.ts.net',
				reachable: false,
				reason: 'the session opened but never returned within 15s',
			},
			{ name: 'claw-3.local', reachable: false, reason: 'Could not resolve hostname' },
		],
	});
	assert.equal(r.hostName, '192.0.2.203');
	assert.equal(r.kind, 'address');
	assert.equal(
		r.pinnedToLease,
		true,
		'an address pin that does not announce itself is the 2026-09-07 outage'
	);
	assert.match(r.why, /PINNED TO A DHCP LEASE/);
	// The two reasons are carried, not collapsed into "no name worked".
	assert.match(r.why, /never returned within 15s/);
	assert.match(r.why, /Could not resolve hostname/);
	assert.deepEqual(
		r.rejected.map((x) => x.name),
		['claw-3.example.ts.net', 'claw-3.local']
	);
});

test('"I could not look" is NOT "the name works": only reachable === true counts', () => {
	// The whole failure mode this decision exists to refuse. A probe that could
	// not be run is indistinguishable, from here, from one that failed — and
	// writing an unproven name produces a node that is healthy and unreachable
	// at the same time, which every gate in this repo reports as dead.
	for (const bad of [null, undefined, 'yes', 1, {}]) {
		const r = chooseSshHostName({
			node: 'claw-3',
			address: '192.0.2.203',
			probes: [{ name: 'claw-3.local', reachable: bad, reason: 'the probe never ran' }],
		});
		assert.equal(
			r.hostName,
			'192.0.2.203',
			`reachable: ${JSON.stringify(bad)} was treated as proof`
		);
		assert.equal(r.pinnedToLease, true);
	}
});

test('a probe that recorded no reason still reports one, rather than an empty string', () => {
	// A `catch {}` that discards the reason makes the finding unactionable: a
	// rate limit, a timeout and a deleted host are three different jobs.
	const r = chooseSshHostName({
		node: 'claw-3',
		address: '192.0.2.203',
		probes: [{ name: 'claw-3.local', reachable: false }],
	});
	assert.equal(r.rejected[0].reason, 'no reason was recorded');
});

test('no name and no address writes NOTHING — it does not invent a target', () => {
	const r = chooseSshHostName({ node: 'claw-9', address: null, probes: [] });
	assert.equal(r.hostName, null);
	assert.equal(r.kind, 'none');
	assert.equal(r.pinnedToLease, false);
	assert.match(r.why, /nothing can be written/);
});

test('an address with no probes at all is still a pin, and says it was never tried', () => {
	const r = chooseSshHostName({ node: 'claw-9', address: '192.0.2.121' });
	assert.equal(r.kind, 'address');
	assert.equal(r.pinnedToLease, true);
	assert.match(r.why, /No name was tried/);
});

// claw-8 as read 2026-10-11: dual-homed, ethernet is its address of record
// (.93 in ~/.ssh/config) and its radio holds a second lease (.98).
const CLAW8 = [
	{ name: 'eno2', wireless: false, mac: '02:00:00:00:0A:B3', ipv4: '192.0.2.93' },
	{ name: 'wlo1', wireless: true, mac: '02:00:00:00:00:04', ipv4: '192.0.2.98' },
];

test('proposeLanRecord reserves the address ssh actually uses, not the radio', () => {
	assert.deepEqual(proposeLanRecord(CLAW8, '192.0.2.93'), {
		iface: 'eno2',
		mac: '02:00:00:00:0a:b3',
		ip: '192.0.2.93',
	});
});

test('proposeLanRecord falls back to the radio when ssh resolves to a name', () => {
	assert.equal(proposeLanRecord(CLAW8, 'claw-8.tailnet.ts.net').iface, 'wlo1');
});

test('proposeLanRecord on a wired-only node with an unresolved ssh name', () => {
	const claw4 = [
		{ name: 'enp0s31f6', wireless: false, mac: '02:00:00:00:de:05', ipv4: '192.0.2.158' },
	];
	assert.equal(proposeLanRecord(claw4, null).ip, '192.0.2.158');
});

test('proposeLanRecord has nothing to reserve when no interface holds an address', () => {
	assert.equal(
		proposeLanRecord([{ name: 'enp4s0', wireless: false, mac: '02:00:00:00:00:01', ipv4: null }]),
		null
	);
});

test('isIpv4 separates an address from a name', () => {
	assert.equal(isIpv4('192.0.2.93'), true);
	assert.equal(isIpv4('claw-8'), false);
	assert.equal(isIpv4(null), false);
});
