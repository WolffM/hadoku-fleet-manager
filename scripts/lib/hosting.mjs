/**
 * HOSTING — a node lent to a tenant's RESIDENT service, with CI held off it.
 *
 * The request it answers: hadoku-cardtable's
 * docs/requests/FLEET_MANAGER_FORGE_HOSTING.md §3 and §5 (2026-10-24). The
 * scope line is the operator's: the fleet gets the node online, reports its
 * status, and FAITHFULLY SERVES THE RESOURCES IT DECLARES. Which node hosts
 * what, failover and alerting are the tenant's. Nothing here chooses a node.
 *
 * WHAT A HOSTING NODE IS, IN FOUR FACTS, EACH WITH ITS OWN WRITER AND READER:
 *
 *   1. NO CI. A drain record of `kind: 'hosting'` (src/runners/drain.ts). The
 *      drain already has every enforcement point the fleet has — placement, the
 *      label strip, the warm-listener eviction — and `drain-check` already
 *      proves it from job history. A second mechanism would be a second place
 *      to forget one. Observed here by the process tree: no `Runner.Listener`,
 *      no `Runner.Worker`.
 *   2. DECLARED RESOURCES, SERVED. A user slice with `MemoryMax`, `MemorySwapMax=0`
 *      and `CPUQuota`. READ BACK FROM THE KERNEL (`memory.max`, `cpu.max`,
 *      `memory.swap.max` under the slice's own cgroup), never from the unit
 *      file this module wrote — the reader may not read what the writer wrote.
 *   3. THE TENANT'S AGENT, SUPERVISED. A user service in that slice with
 *      `Restart=always`, started by a `.path` unit the moment the tenant's
 *      executable exists, so the tenant installs its own agent and the fleet
 *      only keeps it running. Observed as a LISTENER on the declared port whose
 *      process sits in the slice's cgroup — not as `systemctl is-active`.
 *   4. ONE LAN PORT, from the controller only. A ufw rule allowing the
 *      controller's reserved LAN address (`machines.<controller>.lan.ip`) to the
 *      port. Read back from `ufw status`, which is the kernel's rule set as ufw
 *      renders it, not the command this module ran.
 *
 * CORES ARE A QUOTA, NOT PINNED CPUS. The claws' user manager delegates
 * `cpu io memory pids` and not `cpuset` (measured on claw-8, 2026-10-24), so a
 * user slice cannot be given `AllowedCPUs`. `CPUQuota=N*100%` is what can be
 * served and what is verified. A JVM's `availableProcessors()` may not read a
 * NESTED cgroup's quota, so a tenant should size its pools explicitly
 * (`-XX:ActiveProcessorCount=N`) rather than trust the JVM's guess.
 */

/**
 * Every tenant the fleet can host for. A table, not a parameter, so the unit
 * names, the executable path and the port are reviewed facts rather than
 * whatever somebody typed. Adding a tenant is adding a row.
 */
export const TENANTS = {
	cardtable: {
		/** The slice that carries the declared resources. */
		slice: 'hosting-cardtable.slice',
		/** The supervised agent. */
		service: 'cardtable-agent.service',
		/** Starts the agent once the tenant has installed it. */
		pathUnit: 'cardtable-agent.path',
		/** Installed by the TENANT; the fleet never ships it. Relative to $HOME. */
		exec: '.local/share/cardtable-agent/run',
		/** Handed to the agent as CARDTABLE_AGENT_PORT. Checked free on every node 2026-10-24. */
		port: 7621,
	},
};

/** The node whose LAN address may reach a hosting port: the tenant's coordinator runs there. */
export const CONTROLLER_NODE = 'hokon';

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

/**
 * The deploy script: write the slice, the agent service and its path unit,
 * start them, and open the port to the controller. Idempotent — a re-run with
 * the same declaration rewrites the same files and adds no second ufw rule.
 *
 * `MEMORY_MB` is written as `MemoryMax`, and `MemorySwapMax=0` beside it: a
 * JVM that swaps misses the AI's 5 s decision cutoff, which the tenant sees as
 * worse play rather than as an error. Out of memory is a loud failure the
 * tenant handles; swapping is a quiet one it cannot.
 */
export function deployScript(tenantName, { memoryMb, cores }, controllerIp) {
	const t = TENANTS[tenantName];
	return `${assign({
		SLICE: t.slice,
		SERVICE: t.service,
		PATH_UNIT: t.pathUnit,
		EXEC_REL: t.exec,
		PORT: t.port,
		MEMORY_MB: memoryMb,
		CPU_PCT: cores * 100,
		CONTROLLER_IP: controllerIp,
		TENANT: tenantName,
	})}
set -eu
U="$HOME/.config/systemd/user"
mkdir -p "$U" "$HOME/$(dirname "$EXEC_REL")"
cat >"$U/$SLICE" <<EOF
[Unit]
Description=fleet hosting: resources declared for $TENANT

[Slice]
MemoryAccounting=yes
MemoryMax=\${MEMORY_MB}M
MemorySwapMax=0
CPUAccounting=yes
CPUQuota=\${CPU_PCT}%
EOF
cat >"$U/$SERVICE" <<EOF
[Unit]
Description=fleet hosting: $TENANT agent, supervised
ConditionPathIsExecutable=%h/$EXEC_REL
StartLimitIntervalSec=0

[Service]
Slice=$SLICE
ExecStart=%h/$EXEC_REL
Environment=CARDTABLE_AGENT_PORT=$PORT
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
cat >"$U/$PATH_UNIT" <<EOF
[Unit]
Description=fleet hosting: start the $TENANT agent once it is installed

[Path]
PathExists=%h/$EXEC_REL
Unit=$SERVICE

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user start "$SLICE"
systemctl --user enable --now "$PATH_UNIT" >/dev/null 2>&1
systemctl --user enable "$SERVICE" >/dev/null 2>&1
if [ -x "$HOME/$EXEC_REL" ]; then systemctl --user restart "$SERVICE"; fi
if ! sudo -n ufw status 2>/dev/null | grep -Eq "^$PORT/tcp +ALLOW +$CONTROLLER_IP( |$)"; then
	sudo -n ufw allow from "$CONTROLLER_IP" to any port "$PORT" proto tcp comment "fleet hosting: $TENANT agent" >/dev/null
fi
echo HOSTING-DEPLOYED
`;
}

/** The teardown: everything `deployScript` wrote, and the ufw rule. The tenant's own files stay. */
export function removeScript(tenantName, controllerIp) {
	const t = TENANTS[tenantName];
	return `${assign({ SLICE: t.slice, SERVICE: t.service, PATH_UNIT: t.pathUnit, PORT: t.port, CONTROLLER_IP: controllerIp })}
set -eu
U="$HOME/.config/systemd/user"
systemctl --user disable --now "$PATH_UNIT" "$SERVICE" >/dev/null 2>&1 || true
rm -f "$U/$PATH_UNIT" "$U/$SERVICE" "$U/$SLICE"
systemctl --user daemon-reload
systemctl --user stop "$SLICE" >/dev/null 2>&1 || true
while sudo -n ufw status 2>/dev/null | grep -Eq "^$PORT/tcp +ALLOW +$CONTROLLER_IP( |$)"; do
	sudo -n ufw delete allow from "$CONTROLLER_IP" to any port "$PORT" proto tcp >/dev/null
done
echo HOSTING-REMOVED
`;
}

/**
 * The OBSERVATION. One ssh, every fact from the place the kernel keeps it.
 * `KEY=value` lines between markers so a truncated answer is detectable.
 *
 * `ControlGroup` is asked of systemd for the PATH only; every value is read
 * from `/sys/fs/cgroup` under it. Port ownership is the listener's pid looked
 * up in that pid's own `/proc/<pid>/cgroup`, not the unit's state.
 */
export function observeScript(tenantName) {
	const t = TENANTS[tenantName] ?? TENANTS.cardtable;
	return `${assign({ SLICE: t.slice, PORT: t.port, EXEC_REL: t.exec })}
echo OBSERVE-BEGIN
echo "memTotalMb=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)"
echo "nproc=$(nproc 2>/dev/null)"
echo "uptimeSec=$(cut -d. -f1 /proc/uptime)"
echo "ciWorkers=$(pgrep -c -f '[R]unner\\.Worker' || true)"
echo "ciListeners=$(pgrep -c -f '[R]unner\\.Listener' || true)"
cg=$(systemctl --user show "$SLICE" -p ControlGroup --value 2>/dev/null)
echo "sliceCgroup=$cg"
if [ -n "$cg" ] && [ -d "/sys/fs/cgroup$cg" ]; then
	echo "memoryMax=$(cat "/sys/fs/cgroup$cg/memory.max" 2>/dev/null)"
	echo "swapMax=$(cat "/sys/fs/cgroup$cg/memory.swap.max" 2>/dev/null)"
	echo "cpuMax=$(cat "/sys/fs/cgroup$cg/cpu.max" 2>/dev/null)"
	echo "memoryCurrent=$(cat "/sys/fs/cgroup$cg/memory.current" 2>/dev/null)"
fi
echo "agentInstalled=$([ -x "$HOME/$EXEC_REL" ] && echo yes || echo no)"
pid=$(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -n1 | cut -d= -f2)
echo "listenerPid=$pid"
if [ -n "$pid" ]; then echo "listenerCgroup=$(cut -d: -f3 "/proc/$pid/cgroup" 2>/dev/null)"; fi
echo "ufwPort=$(sudo -n ufw status 2>/dev/null | grep -Ec "^$PORT/tcp +ALLOW" || true)"
echo "ufwReadable=$(sudo -n ufw status >/dev/null 2>&1 && echo yes || echo no)"
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
	return {
		memTotalMb: num('memTotalMb'),
		nproc: num('nproc'),
		uptimeSec: num('uptimeSec'),
		ciWorkers: num('ciWorkers'),
		ciListeners: num('ciListeners'),
		sliceCgroup: kv.sliceCgroup || null,
		memoryMax: kv.memoryMax ?? null,
		swapMax: kv.swapMax ?? null,
		cpuMax: kv.cpuMax ?? null,
		memoryCurrent: num('memoryCurrent'),
		agentInstalled: kv.agentInstalled === 'yes',
		listenerPid: num('listenerPid'),
		listenerCgroup: kv.listenerCgroup || null,
		ufwPortRules: num('ufwPort'),
		ufwReadable: kv.ufwReadable === 'yes',
	};
}

/** `cpu.max` is `<quota> <period>` or `max <period>`. Cores = quota / period; unlimited is null. */
export function coresFromCpuMax(cpuMax) {
	const [q, p] = String(cpuMax ?? '').split(/\s+/);
	const quota = Number(q);
	const period = Number(p);
	if (!Number.isFinite(quota) || !Number.isFinite(period) || period <= 0) return null;
	return Math.round((quota / period) * 100) / 100;
}

/** `memory.max` in MiB; `max` (unlimited) and unreadable are null. */
export function mibFromMemoryMax(memoryMax) {
	const n = Number(memoryMax);
	return Number.isFinite(n) ? Math.round(n / 1048576) : null;
}

/**
 * Judge one hosting node: what was DECLARED (the drain record's `hosting`)
 * against what was OBSERVED. Returns `{ observed, findings }`, findings classed
 * `blocking` or `advisory` the way `preflight.mjs` classes them.
 *
 * Every could-not-read is BLOCKING. A tenant reads this to decide where a live
 * match may go, and "I could not see the cgroup" must not read as "the cgroup
 * is fine".
 */
export function judgeHosting(declared, obs) {
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
	const cores = coresFromCpuMax(obs.cpuMax);
	const agentInCgroup = Boolean(obs.listenerCgroup && obs.listenerCgroup.includes(`/${t.slice}/`));
	const observed = {
		memoryMb,
		cores,
		swapMb: obs.swapMax === '0' ? 0 : mibFromMemoryMax(obs.swapMax),
		memoryInUseMb: obs.memoryCurrent === null ? null : Math.round(obs.memoryCurrent / 1048576),
		agent:
			obs.listenerPid === null
				? obs.agentInstalled
					? 'not-listening'
					: 'not-installed'
				: agentInCgroup
					? 'listening'
					: 'listening-outside-slice',
		port: t.port,
		portOpenToController: obs.ufwReadable ? obs.ufwPortRules > 0 : null,
		ciWorkers: obs.ciWorkers,
		ciListeners: obs.ciListeners,
	};
	if (!obs.sliceCgroup)
		block('hosting-slice', `${t.slice} has no cgroup — the resources are not being served`);
	else {
		if (memoryMb === null)
			block(
				'hosting-memory',
				`memory.max reads "${obs.memoryMax}", not the declared ${declared.memoryMb} MiB`
			);
		else if (memoryMb !== declared.memoryMb) {
			block('hosting-memory', `memory.max is ${memoryMb} MiB, declared ${declared.memoryMb} MiB`);
		}
		if (cores === null)
			block('hosting-cores', `cpu.max reads "${obs.cpuMax}", not a ${declared.cores}-core quota`);
		else if (cores !== declared.cores)
			block('hosting-cores', `cpu.max is ${cores} cores, declared ${declared.cores}`);
		if (obs.swapMax !== '0') block('hosting-swap', `memory.swap.max is "${obs.swapMax}", not 0`);
	}
	if (obs.ciWorkers === null || obs.ciListeners === null) {
		block('hosting-ci', 'could not count CI processes on the node');
	} else if (obs.ciWorkers > 0 || obs.ciListeners > 0) {
		block(
			'hosting-ci',
			`CI is on a hosting node: ${obs.ciWorkers} Runner.Worker, ${obs.ciListeners} Runner.Listener`
		);
	}
	if (!obs.ufwReadable)
		block(
			'hosting-port',
			'could not read ufw, so whether the controller can reach the agent is unknown'
		);
	else if (!(obs.ufwPortRules > 0))
		block('hosting-port', `no ufw rule opens ${t.port}/tcp to the controller`);
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
	return { observed, findings };
}
