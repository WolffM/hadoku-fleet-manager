/**
 * Parse a node's network interfaces out of what `fleet enroll` asks it for.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES INSIDE enroll-node.mjs: it is the
 * half that decides whether the fleet can still reach a node after its cable
 * comes out, and that is worth being able to test against real output rather
 * than against an intention. The fixture beside this file is a verbatim capture
 * from claw-1.
 *
 * IT PARSES HERE, NOT OVER THERE. The first version extracted the address on
 * the node with `awk "{split($4,...)}"`, which is two bugs in one line: inside
 * double quotes the remote SHELL consumes `$4` before awk sees it, and the
 * escaping needed to prevent that produced characters the linter correctly
 * called useless. The remote side emits raw lines; the reasoning lives here.
 */

/** The remote command whose output `parseInterfaces` reads. One definition. */
export const INTERFACE_PROBE =
	'ip -o -4 addr show 2>/dev/null | sed "s/^/ADDR /"; ' +
	'for d in /sys/class/net/*; do i=$(basename "$d"); ' +
	'[ "$i" = lo ] && continue; ' +
	'case "$i" in tailscale*|docker*|veth*|br-*) continue;; esac; ' +
	'w=no; [ -e "$d/wireless" ] && w=yes; ' +
	'printf "IF %s %s %s\\n" "$i" "$w" "$(cat "$d/address" 2>/dev/null)"; ' +
	'done';

/**
 * @param {string} out stdout of INTERFACE_PROBE
 * @returns {{name: string, wireless: boolean, mac: string|null, ipv4: string|null}[]}
 */
export function parseInterfaces(out) {
	// `ip -o -4 addr` renders one interface per line:
	//   3: wlp5s0    inet 192.0.2.122/24 brd ... scope global dynamic ...
	// The trailing `\` and valid_lft tail are ignored; only the first address
	// per interface is taken, because a second is an alias rather than the
	// address the fleet reaches this node on.
	const addrs = new Map();
	for (const m of out.matchAll(/^ADDR \d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/gm)) {
		if (!addrs.has(m[1])) addrs.set(m[1], m[2]);
	}
	// `mac` is `(\S*)` and not `(\S+)`: a device with no address file yields an
	// empty field, and dropping the whole interface because its MAC was
	// unreadable would hide a NIC that exists.
	return [...out.matchAll(/^IF (\S+) (yes|no) (\S*)$/gm)].map((m) => ({
		name: m[1],
		wireless: m[2] === 'yes',
		mac: m[3] || null,
		ipv4: addrs.get(m[1]) ?? null,
	}));
}

/**
 * The interface the fleet should address this node on.
 *
 * THE WIRELESS ONE, WHEN THERE IS ONE, and that is not a preference — it is the
 * only link that is present in both states. hokon reaches every claw by a
 * hardcoded LAN IP; ethernet and wireless are different MACs drawing different
 * DHCP leases, so a dual-homed node addressed on its WIRED lease vanishes from
 * every gate at once the moment the cable comes out. claw-3 is the worked
 * example of the answer: its stable .203 lives on the radio, with its USB
 * ethernet secondary, so the address is identical plugged or unplugged.
 *
 * Returns null when the node has no radio — a wired-only node is a normal node
 * and has nothing to choose.
 */
export function preferredAddress(ifaces) {
	return ifaces.find((i) => i.wireless && i.ipv4) ?? ifaces.find((i) => i.wireless) ?? null;
}

/** True for a dotted-quad — what ssh resolves a node to when its HostName is an address. */
export function isIpv4(s) {
	return typeof s === 'string' && IPV4_LITERAL.test(s);
}

/**
 * The `{mac, ip}` to reserve on the gateway for this node, or null.
 *
 * THE ADDRESS THE FLEET ACTUALLY USES, FIRST. When ssh resolves the node to an
 * address one of its interfaces holds, that interface is the answer: the
 * reservation exists to keep exactly that address still, and proposing another
 * would pin a lease nothing reaches the node on. claw-8 is the case that
 * decides it — ethernet .93 is its address of record and its radio holds .98,
 * so {@link preferredAddress}'s radio-first rule would reserve the wrong one.
 *
 * Only when ssh resolves to a NAME, or to nothing this box holds, does it fall
 * back to the radio-first doctrine, then to any interface with an address.
 */
export function proposeLanRecord(ifaces, sshResolvesTo = null) {
	const held = isIpv4(sshResolvesTo) ? ifaces.find((i) => i.ipv4 === sshResolvesTo) : null;
	const pick =
		held ??
		(preferredAddress(ifaces)?.ipv4 ? preferredAddress(ifaces) : null) ??
		ifaces.find((i) => i.ipv4) ??
		null;
	if (!pick?.mac || !pick.ipv4) return null;
	return { iface: pick.name, mac: pick.mac.toLowerCase(), ip: pick.ipv4 };
}

// ═══════════════════════════════════════════════════════════════════════════
// WHICH STACK OWNS THE RADIO — OBSERVED, NEVER DECLARED
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The remote command whose output {@link parseWifiManager} reads.
 *
 * WHY `systemctl is-active wpa_supplicant` IS NOT IN IT. That was the first
 * discriminator tried and it is worthless here: NetworkManager's own wifi
 * backend IS wpa_supplicant, so the unit runs on claw-1 (NM) and on claw-7 (NM)
 * exactly as it runs on an ifupdown box. Measured 2026-09-09 across all seven
 * claws — the unit was running on five of them under three different owners.
 *
 * The signal that actually separates them is `/run/network/ifstate`: ifupdown
 * writes `<iface>=<iface>` there for every interface it has brought up and
 * removes it on `ifdown`. It is the file the 2026-09-07 claw-3 outage turned on
 * (a stale entry made `ifup` a no-op and cost a garage trip — see
 * `garage-network-constraint` in this package's memory), it is written by the
 * stack being detected rather than by us, and because /run is tmpfs it is
 * rebuilt from scratch on every boot. Cross-checked against the radio's own
 * NetworkManager device state, which is the other side's writer.
 */
export const WIFI_MANAGER_PROBE = [
	'r=; for d in /sys/class/net/*/wireless; do [ -e "$d" ] || continue; ' +
		'r=$(basename "$(dirname "$d")"); break; done',
	'printf "WMGR radio %s\\n" "${r:--}"',
	'if command -v nmcli >/dev/null 2>&1; then ' +
		'printf "WMGR nmcli %s\\n" "$(nmcli --version 2>/dev/null | awk "{print \\$NF}")"; ' +
		'nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status 2>/dev/null | sed "s/^/WMGR dev /"; ' +
		'else printf "WMGR nmcli -\\n"; fi',
	'for f in /etc/NetworkManager/system-connections/*.nmconnection; do [ -e "$f" ] || continue; ' +
		'printf "WMGR profile %s\\n" "$(basename "$f" .nmconnection)"; done',
	'[ -f /run/network/ifstate ] && awk -F= \'$1 != "lo" && $1 != "" ' +
		'{ printf "WMGR ifupdown %s\\n", $1 }\' /run/network/ifstate',
	'exit 0',
].join('; ');

/** NM device states that mean "NetworkManager is holding this device". */
const NM_HOLDS = new Set([
	'connected',
	'connecting',
	'disconnected',
	'deactivating',
	'unavailable',
]);

/** Split an `nmcli -t` row, honouring its `\:` escaping of literal colons. */
function nmFields(row) {
	return row.split(/(?<!\\):/).map((f) => f.replace(/\\:/g, ':'));
}

/**
 * Which stack owns this node's radio.
 *
 * @param {string} out stdout of {@link WIFI_MANAGER_PROBE}
 * @returns {{
 *   manager: 'networkmanager'|'ifupdown'|'split'|'unmanaged'|'none'|'unknown',
 *   radio: string|null, nmVersion: string|null, nmState: string|null,
 *   nmConnection: string|null, nmProfiles: string[], ifupdownHolds: string[],
 *   reason: string
 * }}
 *
 * SIX ANSWERS, NOT TWO, and every one of them was observed on a real claw:
 *
 * - `networkmanager` — claw-1, claw-7's radio. NM holds it and nothing else does.
 * - `ifupdown` — claw-2, claw-3. NM is INSTALLED AND RUNNING on both, which is
 *   why "is NetworkManager running" is not the question; the radio is
 *   `unmanaged` and ifstate names it.
 * - `split` — two managers on one box. claw-7 on 2026-09-09: NM held wlp9s0
 *   while ifupdown still held enp8s0 from before the conversion, giving it two
 *   default routes (metric 600 and 1002). Not a cosmetic state — a stale
 *   ifupdown default route outlives the carrier it was learned on, which is the
 *   exact way a pulled cable blackholes a box.
 * - `unmanaged` — a radio nobody has configured. A real, actionable answer.
 * - `none` — no radio. claw-4/5/6. A fact about the box, not a fault, and NOT
 *   comparable with the others when asking "do all the claws match".
 * - `unknown` — the probe said nothing. "I could not look" must never render as
 *   "nothing is wrong", so this is never collapsed into `none`.
 */
export function parseWifiManager(out) {
	const rows = [...String(out).matchAll(/^WMGR (\S+) ?(.*)$/gm)].map((m) => [m[1], m[2].trim()]);
	const base = {
		manager: 'unknown',
		radio: null,
		nmVersion: null,
		nmState: null,
		nmConnection: null,
		nmProfiles: [],
		ifupdownHolds: [],
		reason: 'the wifi-manager probe produced no output',
	};
	if (rows.length === 0) return base;

	const val = (k) => rows.find(([key]) => key === k)?.[1] ?? null;
	const all = (k) => rows.filter(([key]) => key === k).map(([, v]) => v);

	const radioRaw = val('radio');
	const radio = radioRaw && radioRaw !== '-' ? radioRaw : null;
	const nmVersionRaw = val('nmcli');
	const nmVersion = nmVersionRaw && nmVersionRaw !== '-' ? nmVersionRaw : null;
	const nmProfiles = all('profile').sort();
	const ifupdownHolds = all('ifupdown').sort();

	const devRow = radio
		? all('dev')
				.map(nmFields)
				.find((f) => f[0] === radio)
		: undefined;
	const nmState = devRow?.[2] ?? null;
	const nmConnection = devRow?.[3] || null;

	const state = { ...base, radio, nmVersion, nmState, nmConnection, nmProfiles, ifupdownHolds };
	const strays = ifupdownHolds.filter((i) => i !== radio);

	if (!radio) {
		return {
			...state,
			manager: 'none',
			reason: 'no wireless interface on this box (no /sys/class/net/*/wireless)',
		};
	}
	// `unavailable` is in NM_HOLDS but carries no connection: NM owns the device
	// and the device has no carrier. That is NM's answer, not nobody's.
	const nmHolds = nmState !== null && NM_HOLDS.has(nmState);
	const ifHolds = ifupdownHolds.includes(radio);

	if (nmHolds && ifHolds) {
		return {
			...state,
			manager: 'split',
			reason: `both stacks hold ${radio}: NetworkManager reports "${nmState}" and ifupdown still records it in /run/network/ifstate`,
		};
	}
	if (ifHolds) {
		return {
			...state,
			manager: 'ifupdown',
			reason: `ifupdown holds ${radio} (/run/network/ifstate)${nmState ? `; NetworkManager reports "${nmState}"` : ''}`,
		};
	}
	if (nmHolds) {
		if (strays.length > 0) {
			return {
				...state,
				manager: 'split',
				reason: `NetworkManager holds ${radio} but ifupdown still holds ${strays.join(', ')} — that interface keeps a default route its carrier no longer justifies`,
			};
		}
		return {
			...state,
			manager: 'networkmanager',
			reason: `NetworkManager holds ${radio} as "${nmState}"${nmConnection ? ` on connection "${nmConnection}"` : ''}`,
		};
	}
	if (nmState === 'unmanaged' || nmState === null) {
		return {
			...state,
			manager: 'unmanaged',
			reason: nmVersion
				? `${radio} exists and nothing configures it: NetworkManager calls it "${nmState ?? 'absent from its device list'}" and ifupdown does not record it`
				: `${radio} exists, NetworkManager is not installed, and ifupdown does not record it`,
		};
	}
	return { ...state, manager: 'unknown', reason: `unrecognised NetworkManager state "${nmState}"` };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE ONE SSH RESOLVER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Env var naming the DNS suffix every fleet ssh target is addressed under.
 * Unset means "the bare node name", which is what `~/.ssh/config` resolves.
 */
export const SSH_SUFFIX_ENV = 'FLEET_SSH_SUFFIX';

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The string this repo hands to `ssh` for a node. One definition.
 *
 * WHY A FUNCTION AND NOT `node`. Six scripts pass the manifest's node name
 * straight to `ssh` and let `~/.ssh/config` decide what it means, and that file
 * pins every claw to a **LAN IP**. An address is not an identity: claw-3's
 * ssh entry was correct until the 2026-09-07 SSID rename moved it, and the
 * fleet then read a live node as permanently unreachable from six different
 * scripts at once with no single place to correct it. This is that place.
 *
 * WHAT IT ENFORCES TODAY: never an IP literal. A caller that has resolved a
 * node to an address before reaching ssh has thrown away the only thing that
 * survives a new lease, and it fails here rather than at the next rename.
 *
 * WHY THE TAILNET IS NOT THE DEFAULT — MEASURED, NOT ASSUMED. Issue #8 asks for
 * tailnet names. They resolve (MagicDNS answers `claw-1.<tailnet>.ts.net` on
 * hokon) and the peers are up, but **Tailscale SSH is enabled on the claws and
 * its ACL action for this tailnet is `check`**, so a connection over the tailnet
 * is intercepted by tailscaled and answered with:
 *
 *     # Tailscale SSH requires an additional check.
 *     # To authenticate, visit: https://login.tailscale.com/a/...
 *
 * and then hangs. Verified 2026-09-09 against claw-1 (by tailnet IP) and claw-4
 * (by MagicDNS name); both timed out at 20s under `BatchMode=yes`. That is a
 * browser login in the middle of every unattended cron, so flipping the default
 * would take the whole fleet offline to every gate at once. It is an operator
 * change in the Tailscale admin console (an `ssh` rule for `tag:claw` with
 * `action: "accept"`), not a code change.
 *
 * So the suffix is a SWITCH, not a hardcoded answer. Once the ACL accepts,
 * `FLEET_SSH_SUFFIX=<tailnet>.ts.net` moves every ssh path in this repo at once
 * and any per-node pins in `~/.ssh/config` stop mattering.
 *
 * IT DOES NOT ANSWER "IS THIS NODE ME". That is `isLocalNode()` in
 * `src/lib/node-identity.ts` and nowhere else; a caller decides local-vs-remote
 * there and only then asks this for a target.
 *
 * @param {string} node manifest node name, e.g. `claw-3`
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function sshTarget(node, env = process.env) {
	if (typeof node !== 'string' || !node.trim()) {
		throw new TypeError(`sshTarget: node must be a non-empty name, got ${JSON.stringify(node)}`);
	}
	const name = node.trim();
	if (IPV4_LITERAL.test(name)) {
		throw new TypeError(
			`sshTarget: "${name}" is an IP address, not a node name. Fleet ssh targets are names — ` +
				'an address is a DHCP lease and moves without telling anybody. Pass the manifest ' +
				`node name and set ${SSH_SUFFIX_ENV} if it needs a domain.`
		);
	}
	const suffix = (env?.[SSH_SUFFIX_ENV] ?? '').trim().replace(/^\.+|\.+$/g, '');
	if (!suffix) return name;
	// Already qualified (an operator typed the FQDN) — do not double-suffix it.
	return name.endsWith(`.${suffix}`) ? name : `${name}.${suffix}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// WHAT A FLEET-WRITTEN ssh ENTRY PUTS IN `HostName`
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The names worth TRYING for a node, most durable first.
 *
 * `sshTarget` is the read side of issue #8 — it refuses to hand `ssh` an IP
 * literal. This is the WRITE side, and it is the half that was missing: every
 * `Host claw-N` block in `~/.ssh/config` carries `HostName <LAN IP>`, and
 * `writeSshConfig` in `enroll-node.mjs` is the one piece of code in this repo
 * that CREATES those pins. A resolver that refuses IPs while the only writer
 * emits them is a rule with no reach.
 *
 * The order is by what survives what, not by preference:
 *
 * 1. `<node>.<FLEET_SSH_SUFFIX>` when the operator has set a domain. On this
 *    fleet that switch means the tailnet: a Tailscale address is handed out by
 *    the coordination server rather than by the gateway's DHCP, so it survives
 *    a lease change, an SSID rename and a renumbered LAN — the three things
 *    that have each cost a garage trip. Measured 2026-09-26: MagicDNS answers
 *    for all eight claws and `tailscale ping` reaches every one of them DIRECT
 *    over the LAN (claw-1 2ms via 192.0.2.122:41641, claw-4 5ms), so the
 *    tailnet name is not a detour through a relay.
 * 2. `<node>.local` — mDNS, which is answered by the node itself and therefore
 *    follows a new lease with no record to update anywhere.
 *
 * NEITHER IS ASSUMED TO WORK, and that is the point of returning candidates
 * rather than an answer. On 2026-09-26 both are unusable on this fleet: no claw
 * publishes mDNS (avahi-daemon is not installed on any of them), and every claw
 * runs Tailscale SSH — `enroll-node.mjs` itself passes `--ssh` to
 * `tailscale up` — so a connection to the tailnet name is intercepted by
 * tailscaled and answered with "Tailscale SSH requires an additional check"
 * under this tailnet's `check` ACL, then hangs. Verified against claw-1 by
 * tailnet IP and by MagicDNS name, both timing out at 10s under
 * `BatchMode=yes`. A writer that emitted a name on the strength of it resolving
 * would strand the node the moment it was written.
 *
 * @param {string} node
 * @param {Record<string, string|undefined>} [env]
 * @returns {{name: string, why: string}[]}
 */
export function sshNameCandidates(node, env = process.env) {
	const name = String(node ?? '').trim();
	if (!name) return [];
	const out = [];
	const qualified = sshTarget(name, env);
	if (qualified !== name) {
		out.push({
			name: qualified,
			why: `${SSH_SUFFIX_ENV} names the domain this fleet addresses nodes under`,
		});
	}
	out.push({
		name: `${name}.local`,
		why: 'mDNS is answered by the node itself, so it follows a new DHCP lease unaided',
	});
	return out;
}

/**
 * Decide what `HostName` a fleet-written ssh block should carry.
 *
 * THE RULE: a name only on PROOF. `probes` are the results of actually opening
 * a session to each candidate, and only `reachable === true` counts. An
 * unreachable name and a name that could not be tested are the same answer here
 * — "not proven" — because writing either one produces a node that is healthy
 * and unreachable at the same time, which every gate in this repo reports as
 * dead. "I could not look" must never render as "nothing is wrong", and on the
 * write side the way it would render is a config entry nobody can connect to.
 *
 * THE FALLBACK IS NOT SILENT. When no name is proven the block gets the address
 * the node answered on, and `pinnedToLease` says so, carrying every candidate's
 * REASON rather than discarding them — a browser-login interception, a name
 * that does not resolve, and a refused key are three different operator jobs,
 * and a `catch {}` that kept none of them is what made five findings
 * undiagnosable in `check-queue-health`.
 *
 * It needs no edit on the day the blocker clears: flip the Tailscale ACL for
 * `tag:claw` to `accept` (or stop passing `--ssh` to `tailscale up`), set
 * `FLEET_SSH_SUFFIX`, and the next enrolment writes a name because the probe
 * starts succeeding.
 *
 * @param {{node: string, address?: string|null, probes?: {name: string, reachable: boolean|null, reason?: string}[]}} args
 * @returns {{hostName: string|null, kind: 'name'|'address'|'none', pinnedToLease: boolean, why: string, rejected: {name: string, reason: string}[]}}
 */
export function chooseSshHostName({ node, address = null, probes = [] } = {}) {
	const list = Array.isArray(probes) ? probes : [];
	const proven = list.find((p) => p && p.reachable === true);
	const rejected = list
		.filter((p) => p && p.reachable !== true)
		.map((p) => ({ name: p.name, reason: p.reason || 'no reason was recorded' }));

	if (proven) {
		return {
			hostName: proven.name,
			kind: 'name',
			pinnedToLease: false,
			why: `${proven.name} answered ssh, so this node is addressed by a name that survives a new lease`,
			rejected,
		};
	}
	if (address) {
		return {
			hostName: address,
			kind: 'address',
			pinnedToLease: true,
			why:
				`no name reached ${node}, so the entry is PINNED TO A DHCP LEASE and this node ` +
				'is lost to every fleet gate at once if that address moves' +
				(rejected.length
					? `. Tried: ${rejected.map((r) => `${r.name} (${r.reason})`).join('; ')}`
					: '. No name was tried'),
			rejected,
		};
	}
	return {
		hostName: null,
		kind: 'none',
		pinnedToLease: false,
		why: `neither a working name nor an address is known for ${node}; nothing can be written`,
		rejected,
	};
}
