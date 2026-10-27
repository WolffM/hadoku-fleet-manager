/**
 * HOSTING — a node lent to a tenant's RESIDENT service.
 *
 * The request it answers: hadoku-cardtable's
 * docs/requests/FLEET_MANAGER_FORGE_HOSTING.md §3–§9 (2026-10-24/25). The
 * scope line is the operator's: the fleet gets the node online, reports its
 * status, and FAITHFULLY SERVES THE RESOURCES IT DECLARES. Which node hosts
 * what, failover and alerting are the tenant's. Nothing here chooses a node.
 *
 * TWO MODES, ONE SET OF UNITS:
 *   - `whole`: CI is held off the node by a drain of `kind: 'hosting'`
 *     (src/runners/drain.ts), checked by the process tree.
 *   - `shared` (§7/§8): CI keeps the node. The tenant gets its slice ahead of
 *     CI, and the slice's idle share goes back to CI. The record is in
 *     `fleet-hosting.json` (src/runners/hosting-record.ts), which explains the
 *     priority and why it is elastic rather than partitioned.
 *
 * WHAT IS SERVED, EACH WITH ITS OWN WRITER AND READER:
 *   1. RESOURCES. The system slice `hosting.slice/hosting-<tenant>.slice`:
 *      `MemoryMax`, `MemoryMin` and `MemorySwapMax=0`, plus `CPUQuota` at the
 *      declared cores. The parent `hosting.slice` carries `CPUWeight=10000` and
 *      the same `MemoryMin`, because the root cgroup weighs the parent against
 *      `user.slice` (CI) and `system.slice` (pm2), and a parent's protection
 *      bounds its child's. READ BACK FROM THE KERNEL under each cgroup, never
 *      from the unit files written here.
 *   2. THE AGENT, AS ITS OWN USER (§9). A system user with no login shell, no
 *      sudo and no group shared with the CI user, home 0700. A system unit with
 *      `User=` that user, in the slice, `Restart=always`, at
 *      `OOMScoreAdjust=-500`. Observed as the LISTENER on the port: its uid,
 *      cgroup and `oom_score_adj` from `/proc`, not `systemctl is-active`.
 *   3. THE EXECUTABLE, ROOT-OWNED. `/opt/hosting/<tenant>/run`, root:root 0755.
 *      The fleet never ships it: `--install` streams the tenant's file over ssh
 *      straight into a root-owned path, checks its sha256 there and only then
 *      swaps it in. No step passes through anything the CI user can write.
 *   4. CI RANKS BELOW. Every CI process sits in `runners.slice` at
 *      `oom_score_adj` ≥ 500 (src/runners/ephemeral.ts `ciUnitProperties`).
 *      Read from `/proc` for every Runner process on the box.
 *   5. ONE PORT, FROM THE CONTROLLER ONLY. On the LAN, a ufw rule from its
 *      reserved address. On the tailnet, an allow from the controller's own
 *      tailnet addresses and a deny for everyone else, both PREPENDED above
 *      the mesh's blanket `Anywhere on tailscale0` allow, which otherwise lets
 *      every node in (cardtable found claw-8 reaching claw-9's agent,
 *      2026-10-27). Read back by CONNECTING: from the controller, which must
 *      get through, and from another node, which must not ({@link probeReach}).
 *
 * THE CI USER KEEPS NOPASSWD SUDO on the claws (operator, 2026-10-25). The
 * agent's own user stops a job reaching it without sudo, not one that
 * deliberately becomes root. Cardtable records that as accepted risk R1.
 *
 * CORES ARE A QUOTA, NOT PINNED CPUS. A JVM may not read a nested cgroup's
 * quota, so a tenant should size its pools explicitly
 * (`-XX:ActiveProcessorCount=N`) rather than trust the JVM's guess.
 */
import {
	AGENT_OOM_SCORE_ADJ,
	CI_OOM_SCORE_ADJ,
	HOSTING_CPU_WEIGHT,
	HOSTING_PARENT_SLICE,
	hostingSliceCgroup,
	hostingSliceName,
} from '../../dist/runners/hosting-record.js';
import { ciUnitProperties } from '../../dist/runners/ephemeral.js';
import { isGuestNode } from '../../dist/lib/node-role.js';

/**
 * Every tenant the fleet can host for. A table, not a parameter, so the unit
 * names, the user, the executable path and the port are reviewed facts rather
 * than whatever somebody typed. Adding a tenant is adding a row.
 */
export const TENANTS = {
	cardtable: {
		slice: hostingSliceName('cardtable'),
		service: 'cardtable-agent.service',
		pathUnit: 'cardtable-agent.path',
		/** The agent's own system user (§9). */
		user: 'cardtable-agent',
		home: '/var/lib/cardtable-agent',
		/** Root-owned; written only by `--install`. */
		exec: '/opt/hosting/cardtable/run',
		/** Handed to the agent as CARDTABLE_AGENT_PORT. Checked free on every node 2026-10-24. */
		port: 7621,
	},
};

/** The node whose LAN address may reach a hosting port: the tenant's coordinator runs there. */
export const CONTROLLER_NODE = 'hokon';

/** `--install` refuses anything larger. The agent fetches its own jar; this is a launcher. */
export const INSTALL_MAX_BYTES = 64 * 1024 * 1024;

/** A memory size from the command line: `12G`, `12288M`, `12288` (MiB). Throws on anything else. */
export function parseMemoryMb(spec) {
	const m = /^(\d+(?:\.\d+)?)\s*([GM])?i?B?$/i.exec(String(spec ?? '').trim());
	if (!m) throw new Error(`cannot read memory "${spec}" — use 12G or 12288M`);
	const n = Number(m[1]) * ((m[2] ?? 'M').toUpperCase() === 'G' ? 1024 : 1);
	if (!(n >= 256) || !Number.isInteger(n))
		throw new Error(`memory "${spec}" must be a whole number of MiB, at least 256`);
	return n;
}

/** Whole cores, at least 1. A fractional quota is expressible but not a promise anybody plans around. */
export function parseCores(spec) {
	const n = Number(spec);
	if (!Number.isInteger(n) || n < 1)
		throw new Error(`cores "${spec}" must be a whole number, at least 1`);
	return n;
}

/**
 * Would this declaration fit the node as MEASURED? Returns the reasons it
 * would not; empty when it fits. `memTotalMb`/`nproc` come from the node at
 * deploy time, never the manifest's rounded `ramGb`.
 */
export function fitProblems({ memoryMb, cores }, { memTotalMb, nproc }, minFreeMb = 1024) {
	const out = [];
	if (!Number.isFinite(memTotalMb)) out.push("could not read the node's MemTotal");
	else if (memoryMb > memTotalMb - minFreeMb) {
		out.push(
			`${memoryMb} MiB declared, but the node measures ${memTotalMb} MiB and keeps ${minFreeMb} MiB for itself`
		);
	}
	if (!Number.isFinite(nproc)) out.push("could not read the node's CPU count");
	else if (cores > nproc) out.push(`${cores} cores declared, but the node has ${nproc}`);
	return out;
}

/** Inputs as plain assignments ahead of a script body — nothing substituted into the body. */
const assign = (vars) =>
	Object.entries(vars)
		.map(([k, v]) => `${k}=${shellQuote(String(v))}`)
		.join('\n');

/** Single-quote for bash. Every value here is ours, but a quote costs nothing. */
export const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

const tenantVars = (t, tenantName) => ({
	TENANT: tenantName,
	PARENT: HOSTING_PARENT_SLICE,
	SLICE: t.slice,
	SERVICE: t.service,
	PATH_UNIT: t.pathUnit,
	AGENT_USER: t.user,
	AGENT_HOME: t.home,
	EXEC: t.exec,
	PORT: t.port,
});

/**
 * Raise every process already in CI's slice to CI's OOM score. New CI units
 * carry it from `ciUnitProperties`; units minted before it (a warm listener
 * lives for hours) and the job steps under them do not, until they cycle.
 * Raising one's own score needs no privilege.
 */
const RAISE_CI_OOM = `
for f in $(find /sys/fs/cgroup/user.slice -path '*/runners.slice*' -name cgroup.procs 2>/dev/null); do
	for p in $(cat "$f" 2>/dev/null); do
		cur=$(cat "/proc/$p/oom_score_adj" 2>/dev/null) || continue
		[ "$cur" -lt "$CI_OOM" ] && echo "$CI_OOM" >"/proc/$p/oom_score_adj" 2>/dev/null || true
	done
done`;

/** Delete every rule for the port on tailscale0, by number, one at a time: numbers shift after each. */
const DROP_TAILNET_RULES = `
while n=$($S ufw status numbered | grep -E "^\\[ *[0-9]+\\] $PORT/tcp( \\(v6\\))? on tailscale0 " | head -n1 | sed -E 's/^\\[ *([0-9]+)\\].*/\\1/'); [ -n "$n" ]; do
	$S ufw --force delete "$n" >/dev/null
done`;

/**
 * The tailnet half of "from the controller only". ufw matches rules in order
 * and the mesh's \`Anywhere on tailscale0\` allow comes first, so a rule
 * appended after it is never reached. \`prepend\` puts a rule at the top of
 * its own address family's list. Rewritten only when the head of either list
 * is not already exactly these rules, so a re-deploy changes nothing.
 */
const TAILNET_RULES = `
tailnet_head() { $S ufw status | sed 's/ *#.*//' | awk 'NF{$1=$1;print}' | grep ' on tailscale0 ' | grep $1 '(v6)' | head -n "$2"; }
want4=$(printf '%s\\n' "$PORT/tcp on tailscale0 ALLOW $CTL_TS4" "$PORT/tcp on tailscale0 DENY Anywhere")
if [ -n "$CTL_TS6" ]; then
	want6=$(printf '%s\\n' "$PORT/tcp (v6) on tailscale0 ALLOW $CTL_TS6" "$PORT/tcp (v6) on tailscale0 DENY Anywhere (v6)")
else
	want6="$PORT/tcp (v6) on tailscale0 DENY Anywhere (v6)"
fi
if [ "$(tailnet_head -v "$(echo "$want4" | wc -l)")" != "$want4" ] || [ "$(tailnet_head -e "$(echo "$want6" | wc -l)")" != "$want6" ]; then
${DROP_TAILNET_RULES}
	$S ufw prepend deny in on tailscale0 to any port "$PORT" proto tcp comment "fleet hosting: $TENANT agent, closed to the tailnet" >/dev/null
	if [ -n "$CTL_TS6" ]; then
		$S ufw prepend allow in on tailscale0 from "$CTL_TS6" to any port "$PORT" proto tcp comment "fleet hosting: $TENANT agent, controller" >/dev/null
	fi
	$S ufw prepend allow in on tailscale0 from "$CTL_TS4" to any port "$PORT" proto tcp comment "fleet hosting: $TENANT agent, controller" >/dev/null
fi`;

/**
 * The deploy script. Idempotent: a re-run with the same declaration rewrites
 * the same files, keeps the user and adds no second ufw rule. Run as the CI
 * user over ssh, with every privileged step through `sudo -n`.
 */
export function deployScript(tenantName, { memoryMb, cores }, controller) {
	const t = TENANTS[tenantName];
	return `${assign({
		...tenantVars(t, tenantName),
		MEMORY_MB: memoryMb,
		CPU_PCT: cores * 100,
		WEIGHT: HOSTING_CPU_WEIGHT,
		AGENT_OOM: AGENT_OOM_SCORE_ADJ,
		CI_OOM: CI_OOM_SCORE_ADJ,
		CONTROLLER_IP: controller.lan,
		CTL_TS4: controller.tailnet4,
		CTL_TS6: controller.tailnet6 ?? '',
	})}
set -eu
S="sudo -n"
if ! id -u "$AGENT_USER" >/dev/null 2>&1; then
	$S useradd --system --user-group --home-dir "$AGENT_HOME" --no-create-home --shell /usr/sbin/nologin "$AGENT_USER"
fi
$S install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0700 "$AGENT_HOME"
$S install -d -o root -g root -m 0755 "$(dirname "$EXEC")"
unit() { $S tee "/etc/systemd/system/$1" >/dev/null; }
unit "$PARENT" <<EOF
[Unit]
Description=fleet hosting: every tenant slice, weighed against user.slice (CI) and system.slice

[Slice]
CPUAccounting=yes
CPUWeight=$WEIGHT
MemoryAccounting=yes
MemoryMin=\${MEMORY_MB}M
EOF
unit "$SLICE" <<EOF
[Unit]
Description=fleet hosting: resources declared for $TENANT

[Slice]
MemoryAccounting=yes
MemoryMin=\${MEMORY_MB}M
MemoryMax=\${MEMORY_MB}M
MemorySwapMax=0
CPUAccounting=yes
CPUQuota=\${CPU_PCT}%
EOF
unit "$SERVICE" <<EOF
[Unit]
Description=fleet hosting: $TENANT agent, as $AGENT_USER, supervised
ConditionPathIsExecutable=$EXEC
StartLimitIntervalSec=0

[Service]
User=$AGENT_USER
Group=$AGENT_USER
Slice=$SLICE
ExecStart=$EXEC
WorkingDirectory=$AGENT_HOME
Environment=CARDTABLE_AGENT_PORT=$PORT
Restart=always
RestartSec=2
OOMScoreAdjust=$AGENT_OOM
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$AGENT_HOME

[Install]
WantedBy=multi-user.target
EOF
unit "$PATH_UNIT" <<EOF
[Unit]
Description=fleet hosting: start the $TENANT agent once it is installed

[Path]
PathExists=$EXEC
Unit=$SERVICE

[Install]
WantedBy=multi-user.target
EOF
$S systemctl daemon-reload
$S systemctl start "$PARENT" "$SLICE"
$S systemctl enable --now "$PATH_UNIT" >/dev/null 2>&1
$S systemctl enable "$SERVICE" >/dev/null 2>&1
if [ -x "$EXEC" ]; then $S systemctl restart "$SERVICE"; fi
${RAISE_CI_OOM}
if ! $S ufw status 2>/dev/null | grep -Eq "^$PORT/tcp +ALLOW +$CONTROLLER_IP( |$)"; then
	$S ufw allow from "$CONTROLLER_IP" to any port "$PORT" proto tcp comment "fleet hosting: $TENANT agent" >/dev/null
fi
${TAILNET_RULES}
echo HOSTING-DEPLOYED
`;
}

/**
 * The teardown: every unit, the slice cgroups, the ufw rule and the
 * executable. The agent's user and home stay: they hold what the tenant
 * fetched, and a user id is cheap to keep and costly to reuse by accident.
 */
export function removeScript(tenantName, controllerIp) {
	const t = TENANTS[tenantName];
	return `${assign({ ...tenantVars(t, tenantName), CONTROLLER_IP: controllerIp })}
set -eu
S="sudo -n"
$S systemctl disable --now "$PATH_UNIT" "$SERVICE" >/dev/null 2>&1 || true
$S systemctl stop "$SLICE" "$PARENT" >/dev/null 2>&1 || true
for u in "$PATH_UNIT" "$SERVICE" "$SLICE" "$PARENT"; do $S rm -f "/etc/systemd/system/$u"; done
$S rm -f "$EXEC" "$EXEC.new"
$S systemctl daemon-reload
while $S ufw status 2>/dev/null | grep -Eq "^$PORT/tcp +ALLOW +$CONTROLLER_IP( |$)"; do
	$S ufw delete allow from "$CONTROLLER_IP" to any port "$PORT" proto tcp >/dev/null
done
${DROP_TAILNET_RULES}
echo HOSTING-REMOVED
`;
}

/**
 * Put the tenant's executable in place, never through a CI-writable path.
 *
 * The bytes travel in this script's own heredoc and are written by root into
 * `<exec>.new`, inside a root-owned 0755 directory. The sha256 is checked on
 * THAT file, after root owns it, so nothing between the controller and the
 * node can swap it unseen. Only then is it chmodded and renamed over the old
 * one, and the agent restarted.
 */
export function installScript(tenantName, base64, sha256) {
	const t = TENANTS[tenantName];
	return `${assign({ ...tenantVars(t, tenantName), WANT: sha256 })}
set -eu
S="sudo -n"
[ -d "$(dirname "$EXEC")" ] || { echo "INSTALL-FAIL not deployed: $(dirname "$EXEC") is missing"; exit 1; }
$S sh -c 'umask 077; base64 -d >"$1"' sh "$EXEC.new" <<'B64'
${base64}
B64
got=$($S sha256sum "$EXEC.new" | cut -d' ' -f1)
if [ "$got" != "$WANT" ]; then $S rm -f "$EXEC.new"; echo "INSTALL-FAIL sha256 $got, expected $WANT"; exit 1; fi
$S chown root:root "$EXEC.new"
$S chmod 0755 "$EXEC.new"
$S mv -f "$EXEC.new" "$EXEC"
$S systemctl restart "$SERVICE"
echo "INSTALL-OK $got"
`;
}

/** Restart the agent: what a coordinator runs after the agent upgrades itself. */
export function restartScript(tenantName) {
	const t = TENANTS[tenantName];
	return `${assign({ SERVICE: t.service })}
set -eu
sudo -n systemctl restart "$SERVICE"
echo "RESTARTED $(systemctl show "$SERVICE" -p MainPID --value)"
`;
}

/**
 * A process contained EXACTLY as a CI job is (`ciUnitProperties`), with no
 * GitHub job behind it: the load and the intruder in cardtable's tests
 * A2/A5/A6/A10. `memoryMaxMb` is the node's own slice ceiling, as the
 * minter's is. Runs in the background unless `wait`.
 */
export function ciShapedScript(
	command,
	{ memoryMaxMb, wait = false, unit = `ci-shaped-${Date.now()}` }
) {
	const argv = [
		'systemd-run',
		'--user',
		`--unit=${unit}`,
		'--collect',
		...(wait ? ['--wait', '--pipe'] : []),
		...ciUnitProperties({ memoryMaxMb }),
		'/bin/sh',
		'-c',
		command,
	];
	return `set -eu\n${argv.map(shellQuote).join(' ')}\necho ${shellQuote(`CI-SHAPED ${unit}`)}\n`;
}

/**
 * The OBSERVATION. One ssh, every fact from the place the kernel keeps it.
 * `KEY=value` lines between markers so a truncated answer is detectable.
 * Cgroup values from `/sys/fs/cgroup`, identities and scores from `/proc`,
 * modes from `stat`. Nothing from a unit file.
 */
export function observeScript(tenantName) {
	const t = TENANTS[tenantName] ?? TENANTS.cardtable;
	return `${assign({
		...tenantVars(t, tenantName),
		SLICE_CG: hostingSliceCgroup(tenantName),
		PARENT_CG: `/${HOSTING_PARENT_SLICE}`,
	})}
# The CI user is the one this ssh runs as: it owns every runner on the box.
CI_USER=$(id -un)
r() { cat "$1" 2>/dev/null; }
echo OBSERVE-BEGIN
echo "memTotalMb=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)"
echo "nproc=$(nproc 2>/dev/null)"
echo "uptimeSec=$(cut -d. -f1 /proc/uptime)"
echo "bootId=$(r /proc/sys/kernel/random/boot_id)"
echo "ciWorkers=$(pgrep -c -f '[R]unner\\.Worker' || true)"
echo "ciListeners=$(pgrep -c -f '[R]unner\\.Listener' || true)"
c=/sys/fs/cgroup$SLICE_CG
p=/sys/fs/cgroup$PARENT_CG
if [ -d "$c" ]; then
	echo "sliceCgroup=$SLICE_CG"
	echo "memoryMax=$(r $c/memory.max)"
	echo "memoryMin=$(r $c/memory.min)"
	echo "swapMax=$(r $c/memory.swap.max)"
	echo "cpuMax=$(r $c/cpu.max)"
	echo "memoryCurrent=$(r $c/memory.current)"
	echo "oomKills=$(awk '/^oom_kill /{print $2}' $c/memory.events 2>/dev/null)"
	echo "throttledUsec=$(awk '/^throttled_usec /{print $2}' $c/cpu.stat 2>/dev/null)"
fi
if [ -d "$p" ]; then
	echo "parentWeight=$(r $p/cpu.weight)"
	echo "parentMemoryMin=$(r $p/memory.min)"
fi
if pw=$(getent passwd "$AGENT_USER"); then
	echo "agentUid=$(echo "$pw" | cut -d: -f3)"
	echo "agentShell=$(echo "$pw" | cut -d: -f7)"
	echo "agentGroups=$(id -G "$AGENT_USER" 2>/dev/null)"
	echo "ciGroups=$(id -G "$CI_USER" 2>/dev/null)"
	echo "agentSudo=$(sudo -n -l -U "$AGENT_USER" 2>/dev/null | grep -c 'may run' || true)"
fi
echo "homeStat=$(stat -c '%U:%G:%a' "$AGENT_HOME" 2>/dev/null)"
echo "execDirStat=$(stat -c '%U:%G:%a' "$(dirname "$EXEC")" 2>/dev/null)"
echo "execStat=$(stat -c '%U:%G:%a' "$EXEC" 2>/dev/null)"
echo "agentInstalled=$([ -x "$EXEC" ] && echo yes || echo no)"
pid=$(sudo -n ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -n1 | cut -d= -f2)
echo "listenerPid=$pid"
if [ -n "$pid" ]; then
	echo "listenerCgroup=$(cut -d: -f3 "/proc/$pid/cgroup" 2>/dev/null)"
	echo "listenerUid=$(awk '/^Uid:/{print $2}' "/proc/$pid/status" 2>/dev/null)"
	echo "listenerOom=$(sudo -n cat "/proc/$pid/oom_score_adj" 2>/dev/null)"
fi
n=0; out=0; low=0; min=
for q in $(pgrep -f '[R]unner\\.(Listener|Worker)'); do
	n=$((n+1))
	grep -q '/runners.slice/' "/proc/$q/cgroup" 2>/dev/null || out=$((out+1))
	a=$(cat "/proc/$q/oom_score_adj" 2>/dev/null || echo 0)
	[ "$a" -lt ${CI_OOM_SCORE_ADJ} ] && low=$((low+1))
	if [ -z "$min" ] || [ "$a" -lt "$min" ]; then min=$a; fi
done
echo "ciProcs=$n"
echo "ciOutsideRunners=$out"
echo "ciBelowOom=$low"
echo "ciMinOom=$min"
echo "tailnet4=$(tailscale ip -4 2>/dev/null | head -n1)"
echo "tailnet6=$(tailscale ip -6 2>/dev/null | head -n1)"
echo OBSERVE-END
`;
}

/** Parse `observeScript` output. `null` when the end marker never arrived: the answer is incomplete. */
export function parseObserved(stdout) {
	const text = String(stdout ?? '');
	const begin = text.indexOf('OBSERVE-BEGIN');
	const end = text.indexOf('OBSERVE-END');
	if (begin === -1 || end === -1 || end < begin) return null;
	const kv = {};
	for (const line of text.slice(begin, end).split('\n')) {
		const i = line.indexOf('=');
		if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	const num = (k) => (kv[k] === undefined || kv[k] === '' ? null : Number(kv[k]));
	const str = (k) => kv[k] || null;
	return {
		memTotalMb: num('memTotalMb'),
		nproc: num('nproc'),
		uptimeSec: num('uptimeSec'),
		bootId: str('bootId'),
		ciWorkers: num('ciWorkers'),
		ciListeners: num('ciListeners'),
		sliceCgroup: str('sliceCgroup'),
		memoryMax: kv.memoryMax ?? null,
		memoryMin: kv.memoryMin ?? null,
		swapMax: kv.swapMax ?? null,
		cpuMax: kv.cpuMax ?? null,
		memoryCurrent: num('memoryCurrent'),
		oomKills: num('oomKills'),
		throttledUsec: num('throttledUsec'),
		parentWeight: num('parentWeight'),
		parentMemoryMin: kv.parentMemoryMin ?? null,
		agentUid: num('agentUid'),
		agentShell: str('agentShell'),
		agentGroups: str('agentGroups')?.split(/\s+/) ?? null,
		ciGroups: str('ciGroups')?.split(/\s+/) ?? null,
		agentSudo: num('agentSudo'),
		homeStat: str('homeStat'),
		execDirStat: str('execDirStat'),
		execStat: str('execStat'),
		agentInstalled: kv.agentInstalled === 'yes',
		listenerPid: num('listenerPid'),
		listenerCgroup: str('listenerCgroup'),
		listenerUid: num('listenerUid'),
		listenerOom: num('listenerOom'),
		ciProcs: num('ciProcs'),
		ciOutsideRunners: num('ciOutsideRunners'),
		ciBelowOom: num('ciBelowOom'),
		ciMinOom: num('ciMinOom'),
		tailnet4: str('tailnet4'),
		tailnet6: str('tailnet6'),
	};
}

/** How long a probe waits for an answer. ufw DROPS, so a closed port is a timeout, not a refusal. */
const PROBE_TIMEOUT_S = 3;

/**
 * Try to CONNECT to the port on each address, from whichever node this runs
 * on. `PROBE <label> <how>` per target, then `PROBE-END`. `how` is what the
 * connection did: `connected`, `refused` (the packet reached the box and
 * nothing listens, so the firewall let it in), `timeout`, `noroute`, or
 * `error`.
 */
export function portProbeScript(targets, port) {
	const lines = Object.entries(targets).map(
		([label, addr]) => `probe ${shellQuote(label)} ${shellQuote(addr)}`
	);
	return `${assign({ PORT: port })}
probe() {
	out=$(timeout ${PROBE_TIMEOUT_S} bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$2" "$PORT" 2>&1); rc=$?
	if [ $rc -eq 0 ]; then how=connected
	elif [ $rc -eq 124 ]; then how=timeout
	else case "$out" in
		*"Connection refused"*) how=refused ;;
		*"No route to host"*|*"Network is unreachable"*) how=noroute ;;
		*) how=error ;;
	esac; fi
	echo "PROBE $1 $how"
}
${lines.join('\n')}
echo PROBE-END
`;
}

/** `{ label: 'open' | 'filtered' | 'unknown' }` from {@link portProbeScript}, or null if it never finished. */
export function parsePortProbe(stdout) {
	const text = String(stdout ?? '');
	if (!text.includes('PROBE-END')) return null;
	const out = {};
	for (const m of text.matchAll(/^PROBE (\S+) (\S+)$/gm)) {
		out[m[1]] = ['connected', 'refused'].includes(m[2])
			? 'open'
			: ['timeout', 'noroute'].includes(m[2])
				? 'filtered'
				: 'unknown';
	}
	return out;
}

/** How many other nodes are asked before "nobody could look" is the answer. */
const PEER_TRIES = 3;

/** Non-guest nodes other than `node` and the controller: who may try the port from outside. */
export function peerCandidates(manifest, node) {
	return Object.entries(manifest.machines ?? {})
		.filter(([n, m]) => n !== node && n !== CONTROLLER_NODE && !isGuestNode(m))
		.map(([n]) => n);
}

/**
 * Is the port reachable from the controller, and from nothing else? Measured
 * by connecting, never by reading ufw: the rule that was written is not the
 * path a packet takes (the mesh allow sat above it). The controller tries
 * every address; then other nodes, in turn, until one answers.
 *
 * `addrs` is `{ lan, tailnet4, tailnet6 }`; a null address is not probed and
 * {@link judgeHosting} says so. `run` is `runOn`.
 */
export async function probeReach({ port, addrs, peers, run }) {
	const targets = Object.fromEntries(Object.entries(addrs).filter(([, a]) => a));
	const script = portProbeScript(targets, port);
	const opts = { timeoutMs: 30_000, connectTimeout: 6 };
	const controller = parsePortProbe((await run(CONTROLLER_NODE, script, opts)).stdout);
	let peer = null;
	for (const name of peers.slice(0, PEER_TRIES)) {
		const got = parsePortProbe((await run(name, script, opts)).stdout);
		if (got) {
			peer = { node: name, ...got };
			break;
		}
	}
	return { addrs, controller, peer };
}

/** `cpu.max` is `<quota> <period>` or `max <period>`. Cores = quota / period; unlimited is null. */
export function coresFromCpuMax(cpuMax) {
	const [q, p] = String(cpuMax ?? '').split(/\s+/);
	const quota = Number(q);
	const period = Number(p);
	if (!Number.isFinite(quota) || !Number.isFinite(period) || period <= 0) return null;
	return Math.round((quota / period) * 100) / 100;
}

/** `memory.max`/`memory.min` in MiB; `max` (unlimited) and unreadable are null. */
export function mibFromMemoryMax(memoryMax) {
	const n = Number(memoryMax);
	return memoryMax === null || memoryMax === '' || !Number.isFinite(n)
		? null
		: Math.round(n / 1048576);
}

/** `user:group:octal` from `stat`, and whether anyone but the owner may write it. */
const parseStat = (s) => {
	const [owner, group, mode] = String(s ?? '').split(':');
	if (!owner || !mode) return null;
	const bits = parseInt(mode, 8);
	return { owner, group, mode, othersWrite: (bits & 0o022) !== 0 };
};

/**
 * Judge one hosting node: what was DECLARED against what was OBSERVED.
 * `mode` is `whole` (CI must be absent) or `shared` (CI must rank below).
 * Returns `{ observed, findings }`, findings classed `blocking` or `advisory`
 * the way `preflight.mjs` classes them.
 *
 * Every could-not-read is BLOCKING. A tenant reads this to decide where a live
 * match may go, and "I could not see the cgroup" must not read as "the cgroup
 * is fine".
 */
export function judgeHosting(declared, obs, mode = 'whole', reach = null) {
	const findings = [];
	const block = (category, why) => findings.push({ class: 'blocking', category, why });
	const advise = (category, why) => findings.push({ class: 'advisory', category, why });
	const t = TENANTS[declared.tenant];
	if (!t) {
		block('hosting-tenant', `declared tenant "${declared.tenant}" is not in the TENANTS table`);
		return { observed: null, findings };
	}
	if (!obs) {
		block('hosting-unobserved', 'the node did not finish answering, so nothing it serves is known');
		return { observed: null, findings };
	}
	const memoryMb = mibFromMemoryMax(obs.memoryMax);
	const memoryMinMb = mibFromMemoryMax(obs.memoryMin);
	const parentMinMb = mibFromMemoryMax(obs.parentMemoryMin);
	const cores = coresFromCpuMax(obs.cpuMax);
	const agentInSlice = Boolean(obs.listenerCgroup && obs.listenerCgroup.includes(`/${t.slice}/`));
	const home = parseStat(obs.homeStat);
	const execDir = parseStat(obs.execDirStat);
	const exec = parseStat(obs.execStat);
	const sharedGroups =
		obs.agentGroups && obs.ciGroups
			? obs.agentGroups.filter((g) => obs.ciGroups.includes(g))
			: null;
	const observed = {
		mode,
		memoryMb,
		memoryMinMb,
		cores,
		swapMb: obs.swapMax === '0' ? 0 : mibFromMemoryMax(obs.swapMax),
		memoryInUseMb: obs.memoryCurrent === null ? null : Math.round(obs.memoryCurrent / 1048576),
		parent: { cpuWeight: obs.parentWeight, memoryMinMb: parentMinMb },
		agent:
			obs.listenerPid === null
				? obs.agentInstalled
					? 'not-listening'
					: 'not-installed'
				: agentInSlice
					? 'listening'
					: 'listening-outside-slice',
		agentUser: {
			name: t.user,
			uid: obs.agentUid,
			shell: obs.agentShell,
			sharedGroupsWithCi: sharedGroups,
			sudo: obs.agentSudo === null ? null : obs.agentSudo > 0,
		},
		agentProcess:
			obs.listenerPid === null ? null : { uid: obs.listenerUid, oomScoreAdj: obs.listenerOom },
		files: { home: obs.homeStat, execDir: obs.execDirStat, exec: obs.execStat },
		ci: {
			workers: obs.ciWorkers,
			listeners: obs.ciListeners,
			processes: obs.ciProcs,
			outsideRunnersSlice: obs.ciOutsideRunners,
			belowOomFloor: obs.ciBelowOom,
			minOomScoreAdj: obs.ciMinOom,
		},
		slice: { oomKills: obs.oomKills, throttledUsec: obs.throttledUsec },
		port: t.port,
		portOpenToController: reach?.controller ? reach.controller.lan === 'open' : null,
		portReach: reach
			? {
					controller: reach.controller,
					peer: reach.peer,
				}
			: null,
		bootId: obs.bootId,
	};

	// 1. resources
	if (!obs.sliceCgroup)
		block('hosting-slice', `${t.slice} has no cgroup — the resources are not being served`);
	else {
		if (memoryMb !== declared.memoryMb)
			block(
				'hosting-memory',
				`memory.max reads "${obs.memoryMax}", not the declared ${declared.memoryMb} MiB`
			);
		if (memoryMinMb !== declared.memoryMb)
			block(
				'hosting-memory-min',
				`memory.min reads "${obs.memoryMin}", not the declared ${declared.memoryMb} MiB`
			);
		if (cores !== declared.cores)
			block('hosting-cores', `cpu.max reads "${obs.cpuMax}", not a ${declared.cores}-core quota`);
		if (obs.swapMax !== '0') block('hosting-swap', `memory.swap.max is "${obs.swapMax}", not 0`);
		if (!(parentMinMb >= declared.memoryMb))
			block(
				'hosting-memory-min',
				`${HOSTING_PARENT_SLICE} memory.min reads "${obs.parentMemoryMin}", so the slice's protection is capped below ${declared.memoryMb} MiB`
			);
		if (obs.parentWeight !== HOSTING_CPU_WEIGHT)
			block(
				'hosting-cpu-weight',
				`${HOSTING_PARENT_SLICE} cpu.weight is ${obs.parentWeight}, not ${HOSTING_CPU_WEIGHT}: CI would contend as an equal`
			);
	}

	// 2. the agent's own user
	if (obs.agentUid === null) block('hosting-user', `the system user ${t.user} does not exist`);
	else {
		if (obs.agentShell !== '/usr/sbin/nologin')
			block('hosting-user', `${t.user} has the shell ${obs.agentShell}, not /usr/sbin/nologin`);
		if (sharedGroups === null)
			block('hosting-user', `could not read the groups of ${t.user} and the CI user`);
		else if (sharedGroups.length)
			block('hosting-user', `${t.user} shares group(s) ${sharedGroups.join(',')} with the CI user`);
		if (obs.agentSudo === null) block('hosting-user', `could not read ${t.user}'s sudo rights`);
		else if (obs.agentSudo > 0) block('hosting-user', `${t.user} may run sudo`);
	}
	if (!home || home.owner !== t.user || home.mode !== '700')
		block('hosting-files', `${t.home} is ${obs.homeStat ?? 'missing'}, not ${t.user}-owned 0700`);
	for (const [path, s] of [
		[t.exec.replace(/\/[^/]+$/, ''), execDir],
		[t.exec, exec],
	]) {
		if (s === null && path === t.exec) continue; // not installed yet: the agent advisory says so
		if (!s || s.owner !== 'root' || s.othersWrite)
			block(
				'hosting-files',
				`${path} is ${s ? `${s.owner}:${s.group} ${s.mode}` : 'missing'}; only root may write it`
			);
	}

	// 3. the agent process
	if (observed.agent === 'listening-outside-slice') {
		block(
			'hosting-agent',
			`the process on ${t.port} is not in ${t.slice}, so the declared limits do not apply to it`
		);
	} else if (observed.agent !== 'listening') {
		// The fleet supervises the agent; it does not ship it. Not installed yet is
		// the tenant's next step, not a fault in what the fleet serves.
		advise('hosting-agent', `the ${declared.tenant} agent is ${observed.agent} on ${t.port}`);
	}
	if (obs.listenerPid !== null) {
		if (obs.listenerUid !== obs.agentUid)
			block(
				'hosting-agent',
				`the process on ${t.port} runs as uid ${obs.listenerUid}, not ${t.user}`
			);
		if (obs.listenerOom === null) block('hosting-oom', `could not read the agent's oom_score_adj`);
		else if (obs.listenerOom !== AGENT_OOM_SCORE_ADJ)
			block(
				'hosting-oom',
				`the agent's oom_score_adj is ${obs.listenerOom}, not ${AGENT_OOM_SCORE_ADJ}`
			);
	}

	// 4. CI: absent (whole) or ranked below (shared)
	if (obs.ciWorkers === null || obs.ciListeners === null || obs.ciProcs === null) {
		block('hosting-ci', 'could not count CI processes on the node');
	} else if (mode === 'whole') {
		if (obs.ciWorkers > 0 || obs.ciListeners > 0)
			block(
				'hosting-ci',
				`CI is on a whole-box hosting node: ${obs.ciWorkers} Runner.Worker, ${obs.ciListeners} Runner.Listener`
			);
	} else {
		if (obs.ciOutsideRunners > 0)
			block(
				'hosting-ci',
				`${obs.ciOutsideRunners} CI process(es) run outside runners.slice, unranked against the slice`
			);
		if (obs.ciBelowOom > 0)
			block(
				'hosting-oom',
				`${obs.ciBelowOom} CI process(es) have oom_score_adj below ${CI_OOM_SCORE_ADJ} (lowest ${obs.ciMinOom}), so a global OOM may not take CI first`
			);
	}

	// 5. the port: open to the controller, and to nothing else.
	if (!reach) {
		block('hosting-port', `${t.port}/tcp was not probed, so who can reach the agent is unknown`);
	} else {
		const ctl = reach.controller;
		if (!ctl) block('hosting-port', `the controller did not finish probing ${t.port}/tcp`);
		else if (ctl.lan !== 'open')
			block(
				'hosting-port',
				`the controller cannot reach ${t.port}/tcp on the node's LAN address (${ctl.lan ?? 'not probed'})`
			);
		else if (reach.addrs.tailnet4 && ctl.tailnet4 !== 'open')
			advise(
				'hosting-port',
				`the controller reaches ${t.port}/tcp on the LAN but not on the tailnet (${ctl.tailnet4})`
			);
		for (const label of ['lan', 'tailnet4'])
			if (!reach.addrs[label])
				block(
					'hosting-port-exposed',
					`the node's ${label} address is unknown, so whether ${t.port}/tcp is closed there is unknown`
				);
		if (!reach.peer) {
			block(
				'hosting-port-exposed',
				`no other node finished probing ${t.port}/tcp, so whether it is closed to the fleet is unknown`
			);
		} else {
			for (const [label, addr] of Object.entries(reach.addrs)) {
				if (!addr) continue;
				const v = reach.peer[label];
				if (v === 'open')
					block(
						'hosting-port-exposed',
						`${reach.peer.node} reaches ${t.port}/tcp on the ${label} address: only the controller may`
					);
				else if (v !== 'filtered')
					block(
						'hosting-port-exposed',
						`${reach.peer.node} could not tell whether ${t.port}/tcp on the ${label} address is closed (${v ?? 'not probed'})`
					);
			}
		}
	}

	// Information for the tenant, not a fault in what is served.
	if (obs.oomKills > 0)
		advise(
			'hosting-slice-oom',
			`the slice has hit its own memory.max ${obs.oomKills} time(s) since it started`
		);
	return { observed, findings };
}
