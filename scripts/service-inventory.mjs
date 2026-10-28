#!/usr/bin/env node
/**
 * `fleet service-inventory` — every RESIDENT workload on this node, measured.
 *
 * Wave 3-prep lane S. The four Wave-3 migrations are PM2 services, cron jobs,
 * deployment checkouts and the dataplatform mirror, and none of them is in the
 * demand ledger. This measures them WHERE THEY RUN, the way CI jobs are
 * measured — from the kernel and the supervisor, never from a declaration.
 *
 * Schema and the reader contract: `docs/planning/service-ledger-2026-09-10.md`.
 * Pure logic: `scripts/lib/service-inventory.mjs`.
 *
 * `fleet service-inventory` since Wave 3a — the COMMANDS row landed with the
 * `--write` path below. It is NOT under `json-contract.mjs` and no cron parses
 * it; adding it there is a CROSS-REPO change that names the mgmt-api consumer
 * in the same pass.
 *
 * THE READER FOR A FACET MAY NOT READ WHAT THE WRITER WROTE. Nothing here
 * trusts PM2's own `monit` numbers for memory: `monit.memory` is the RSS of the
 * pid PM2 forked, and most apps here are wrappers whose real work is a child
 * (cloudflared, a venv python, a game server). Every figure is re-derived from
 * `/proc` and `/sys/fs/cgroup` over the whole process subtree. PM2 is consulted
 * only for the roster (which apps exist, their cwd and restart counts) —
 * the one question it is the authority on.
 *
 * Usage:
 *   fleet service-inventory [--slices] [--json] [--write] [--window-ms N]
 *     --slices      every DECLARED hosting slice, on its own node, from here
 *                   (lib/slice-inventory-run.mjs); replaces only `kind: slice`
 *     --json        machine-readable rows on stdout
 *     --write       merge the resident rows into stateDir()/demand-ledger.jsonl
 *     --window-ms   CPU/net sample window (default 10000)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

import {
	RESIDENT_CLASS,
	descendantPids,
	durationStats,
	egressClassFor,
	flattenCronProfiles,
	isMeasured,
	mergeResidentRows,
	millicores,
	parseCpuStatUsec,
	parseCronRuns,
	parseSsSockets,
	unmeasured,
	validateResidentRow,
} from './lib/service-inventory.mjs';
import { keepStdoutWhole } from './lib/emit.mjs';
import { stateDir } from './lib/paths.mjs';
import { hubRepo } from '../dist/lib/fleet-config.js';

// STDOUT MUST ARRIVE WHOLE. This script prints a JSON document and then exits,
// and on a pipe `process.exit` throws away whatever the stream still had
// queued — measured on this host, 149,133 bytes in and 146,176 out, which
// `JSON.parse` then rejects mid-string. `keepStdoutWhole` puts fd 1 in
// blocking mode so there is nothing left to lose. Issue #33; the shared
// emitter calls the same function for the scripts that use it.
keepStdoutWhole();

const ARGV = process.argv.slice(2);
const JSON_OUT = ARGV.includes('--json');
const WRITE = ARGV.includes('--write');
const WINDOW_MS = Number(ARGV[ARGV.indexOf('--window-ms') + 1]) || 10_000;

if (ARGV.includes('--slices')) {
	const { runSliceInventory } = await import('./lib/slice-inventory-run.mjs');
	const r = await runSliceInventory({ windowMs: WINDOW_MS, write: WRITE });
	if (JSON_OUT) console.log(JSON.stringify(r, null, 2));
	else {
		const gb = (n) => (typeof n === 'number' ? `${(n / 1e9).toFixed(2)} GB` : 'unmeasured');
		console.log(`hosting slices at ${r.at} (${r.declaredNodes} node(s) declare one):`);
		for (const row of r.rows) {
			console.log(
				`  ${`${row.host}/${row.name}`.padEnd(28)} peak=${gb(row.ram).padEnd(10)} now=${gb(row.detail.memoryCurrent).padEnd(10)} ` +
					`cpu=${typeof row.cpu === 'number' ? `${row.cpu}m` : 'unmeasured'}`
			);
		}
		if (r.write) {
			console.log(
				`\nwrote ${r.write.written} slice row(s) -> ${r.write.path} (replaced ${r.write.replaced}` +
					`${r.write.removedHosts.length ? `, removed ${r.write.removedHosts.join(', ')}` : ''})`
			);
		}
	}
	for (const f of r.findings) console.error(`  ✗ ${f}`);
	process.exit(r.ok ? 0 : 1);
}

const HOME = homedir();
const SRV = join(HOME, 'srv');
const SITE = join(SRV, hubRepo());
const PM2_SLICE = '/sys/fs/cgroup/system.slice/pm2-hadoku.service';
const AT = new Date().toISOString();
const NODE = (process.env.FLEET_NODE || hostname()).split('.')[0];

const findings = [];
const fail = (why) => findings.push(why);

function read(path) {
	return readFileSync(path, 'utf8');
}

function sh(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

// --- the process tree, from the kernel -------------------------------------
// Listeners from the process tree, never a `.env` (CLAUDE.md). Same rule for a
// service's real memory: the tree, never the supervisor's own number.

/** pid → ppid for every process on the box, out of `/proc/<pid>/stat`. */
function ppidMap() {
	const map = new Map();
	for (const name of readdirSync('/proc')) {
		if (!/^\d+$/.test(name)) continue;
		let stat;
		try {
			stat = read(`/proc/${name}/stat`);
		} catch (err) {
			// A pid that exited between readdir and read is normal and not a gap:
			// it held no resources by the time we looked. Any OTHER errno is.
			if (err.code === 'ENOENT' || err.code === 'ESRCH') continue;
			throw err;
		}
		// comm can contain spaces and parens, so fields are counted from the LAST ')'.
		const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		map.set(Number(name), Number(after[1]));
	}
	return map;
}

/**
 * The kernel's tick, by EXECUTING `getconf` rather than assuming 100.
 *
 * Every field in `/proc/<pid>/stat` that this file divides by it is in ticks,
 * so a wrong constant scales every CPU figure silently. It is 100 on every box
 * in this fleet; asking costs one exec and removes the assumption.
 */
const CLK_TCK = (() => {
	try {
		const n = Number(sh('getconf', ['CLK_TCK']).trim());
		if (n > 0) return n;
	} catch {
		/* fall through to the finding below */
	}
	fail('`getconf CLK_TCK` could not be read, so no CPU figure here can be scaled correctly.');
	return null;
})();
const bootSeconds = () => Number(read('/proc/uptime').split(' ')[0]);

/** utime+stime in microseconds, and start time, for one pid. */
function procCpu(pid) {
	if (!CLK_TCK) return null;
	let stat;
	try {
		stat = read(`/proc/${pid}/stat`);
	} catch {
		return null;
	}
	const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
	// after the comm: field 3 = state, so utime is index 11, stime 12, starttime 19
	const utime = Number(f[11]);
	const stime = Number(f[12]);
	const starttime = Number(f[19]);
	return { usec: ((utime + stime) / CLK_TCK) * 1e6, startSeconds: starttime / CLK_TCK };
}

/** Pss (proportional, shared pages charged fairly) and VmHWM (kernel peak RSS). */
function procMem(pid) {
	let pss = 0;
	try {
		const m = /^Pss:\s+(\d+) kB$/m.exec(read(`/proc/${pid}/smaps_rollup`));
		if (m) pss = Number(m[1]) * 1024;
	} catch {
		return null; // exited, or not ours — the caller counts it as a missing pid
	}
	let hwm = 0;
	try {
		const m = /^VmHWM:\s+(\d+) kB$/m.exec(read(`/proc/${pid}/status`));
		if (m) hwm = Number(m[1]) * 1024;
	} catch {
		/* status vanished with the pid; pss above already succeeded, so keep it */
	}
	return { pss, hwm };
}

// --- PM2 roster ------------------------------------------------------------

function pm2Apps() {
	let raw;
	try {
		raw = sh('pm2', ['jlist']);
	} catch (err) {
		fail(
			`could not read \`pm2 jlist\` (${err.code ?? err.message}). That is a broken scan, not a clean box.`
		);
		return [];
	}
	let apps;
	try {
		apps = JSON.parse(raw);
	} catch (err) {
		fail(`\`pm2 jlist\` did not return JSON (${err.message}) — unreadable, not clean.`);
		return [];
	}
	if (!Array.isArray(apps) || !apps.length) {
		fail('PM2 reports ZERO apps. The ecosystem does not run on nothing — unreadable, not clean.');
		return [];
	}
	return apps.map((a) => ({
		name: a.name,
		pid: a.pid,
		pmCwd: a.pm2_env?.pm_cwd ?? null,
		restarts: a.pm2_env?.restart_time ?? null,
		status: a.pm2_env?.status ?? null,
		uptimeMs: a.pm2_env?.pm_uptime ?? null,
	}));
}

// --- GPU -------------------------------------------------------------------

/** pid → VRAM bytes, by EXECUTING nvidia-smi. `null` means the GPU is unreadable. */
function gpuByPid() {
	let out;
	try {
		out = sh('nvidia-smi', [
			'--query-compute-apps=pid,used_memory',
			'--format=csv,noheader,nounits',
		]);
	} catch (err) {
		fail(
			`nvidia-smi could not be read (${err.code ?? err.message}) — GPU demand is unmeasured, not zero.`
		);
		return null;
	}
	const map = new Map();
	for (const line of out.split('\n')) {
		const m = /^\s*(\d+)\s*,\s*(\d+)/.exec(line);
		if (m) map.set(Number(m[1]), Number(m[2]) * 1024 * 1024);
	}
	return map;
}

// --- disk ------------------------------------------------------------------

/** Apparent size in bytes of a directory tree, or an explicit reason. */
function duBytes(path, { timeoutMs = 180_000 } = {}) {
	if (!existsSync(path)) return { why: `${path} does not exist on this node` };
	try {
		const out = sh('du', ['-sb', '--apparent-size', path], {
			timeout: timeoutMs,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { bytes: Number(out.split('\t')[0]) };
	} catch (err) {
		return { why: `du -sb ${path} failed after ${timeoutMs}ms (${err.code ?? err.message})` };
	}
}

// --- the sample window -----------------------------------------------------

function sampleNet() {
	try {
		return parseSsSockets(sh('ss', ['-tinp'], { stdio: ['ignore', 'pipe', 'pipe'] }));
	} catch (err) {
		fail(
			`\`ss -tinp\` could not be read (${err.code ?? err.message}) — net demand is unmeasured, not zero.`
		);
		return null;
	}
}

function sliceCpuUsec() {
	try {
		return parseCpuStatUsec(read(join(PM2_SLICE, 'cpu.stat')));
	} catch (err) {
		fail(`could not read ${PM2_SLICE}/cpu.stat (${err.code ?? err.message}).`);
		return null;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- rows ------------------------------------------------------------------

function provenance(sources, scope) {
	return { at: AT, by: 'fleet service-inventory', host: NODE, sources, scope };
}

/**
 * PM2 rows.
 *
 * `scope` is `per-service` for every number derived from `/proc` over the
 * subtree, because that IS per-service. The cgroup figures are slice-wide —
 * measured 2026-09-10, `system.slice/pm2-hadoku.service` has NO child cgroups
 * (one flat cgroup, 67 processes), so `memory.peak`, `cpu.stat` and `io.stat`
 * cannot be attributed to an app by the cgroup at all. They are reported ONCE,
 * as the slice row in the summary, and each app's `detail` carries its share of
 * the slice's CPU so R can apportion instead of guessing.
 */
/**
 * An app's disk footprint — or the row that already carries those bytes.
 *
 * THREE WAYS THIS MEASURES THE WRONG THING, each refused by name rather than
 * silently reported:
 *
 * 1. A shared checkout. Eighteen apps run out of `~/srv/hadoku_site`; charging
 *    each one 1.7 GB would inflate resident disk demand by ~30 GB. The
 *    `kind:checkout` row owns those bytes.
 * 2. `pm_cwd` IS the home directory (`jd-clipboard-watch`). Measured
 *    2026-09-10: `du -sb ~` returns 990 GB, which is the operator's whole home,
 *    not a clipboard helper's footprint. A number that large would dominate
 *    every placement decision and it would be pure noise.
 * 3. Two apps sharing one tree (`valheim` and `valheim-panel`, both under
 *    `/mnt/games/valheim-server`). The FIRST app seen carries the bytes; the
 *    second names it, so summing the column stays correct.
 */
function appDisk(app, cwdOwner) {
	if (!app.pmCwd) {
		return unmeasured(`PM2 reports no pm_cwd for ${app.name}, so there is no tree to measure`);
	}
	if (app.pmCwd.startsWith(SITE)) {
		return unmeasured(
			`runs out of the shared ${SITE} checkout (pm_cwd ${app.pmCwd}); those bytes are the kind:checkout row for ${hubRepo()}, and charging them here would double-count`
		);
	}
	if (app.pmCwd.replace(/\/+$/, '') === HOME) {
		return unmeasured(
			`pm_cwd is the home directory itself (${HOME}); du there measures the operator's whole home, not this app — no tree belongs to ${app.name} alone`
		);
	}
	const owner = cwdOwner.get(app.pmCwd);
	if (owner && owner !== app.name) {
		return unmeasured(
			`shares the tree at ${app.pmCwd} with PM2 app "${owner}", whose row carries those bytes`
		);
	}
	const d = duBytes(app.pmCwd);
	return isMeasured(d.bytes) ? d.bytes : unmeasured(d.why);
}

async function pm2Rows(apps, egressSpec) {
	// First app seen per cwd owns that tree's bytes — see appDisk case 3.
	const cwdOwner = new Map();
	for (const a of apps) if (a.pmCwd && !cwdOwner.has(a.pmCwd)) cwdOwner.set(a.pmCwd, a.name);
	const ppids = ppidMap();
	const gpu = gpuByPid();
	const net0 = sampleNet();
	const cpu0 = new Map();
	const uptime0 = bootSeconds();
	const subtrees = new Map();
	for (const a of apps) {
		const pids = a.pid ? descendantPids(a.pid, ppids) : [];
		subtrees.set(a.name, pids);
		cpu0.set(
			a.name,
			pids.reduce((n, p) => n + (procCpu(p)?.usec ?? 0), 0)
		);
	}

	await sleep(WINDOW_MS);

	const uptime1 = bootSeconds();
	const wallMs = (uptime1 - uptime0) * 1000;
	const net1 = sampleNet();

	const rows = [];
	const sliceCpu = sliceCpuUsec();
	let lifetimeCpuTotal = 0;
	for (const a of apps) {
		const pids = subtrees.get(a.name);
		const mems = pids.map(procMem).filter(Boolean);
		const cpuNow = pids.reduce((n, p) => n + (procCpu(p)?.usec ?? 0), 0);
		const first = a.pid ? procCpu(a.pid) : null;
		const lifetimeSeconds = first ? uptime1 - first.startSeconds : null;
		lifetimeCpuTotal += cpuNow;

		const ram = mems.length
			? mems.reduce((n, m) => n + m.hwm, 0)
			: unmeasured(
					`no readable pid for PM2 app ${a.name} (status ${a.status}); /proc/<pid>/smaps_rollup returned nothing`
				);
		const steady = mems.length ? mems.reduce((n, m) => n + m.pss, 0) : null;

		const cpu =
			lifetimeSeconds && lifetimeSeconds > 0
				? millicores(cpuNow, lifetimeSeconds * 1000)
				: unmeasured(
						`could not read /proc/${a.pid}/stat starttime, so there is no wall window to divide by`
					);

		let net;
		if (!net0 || !net1) {
			net = unmeasured('`ss -tinp` could not be read, so no socket counters exist to difference');
		} else {
			const b0 = pids.reduce((n, p) => n + (net0.get(p)?.bytes ?? 0), 0);
			const b1 = pids.reduce((n, p) => n + (net1.get(p)?.bytes ?? 0), 0);
			net = Math.max(0, Math.round(((b1 - b0) / wallMs) * 1000));
		}

		const disk = appDisk(a, cwdOwner);

		rows.push({
			class: RESIDENT_CLASS,
			kind: 'pm2',
			name: a.name,
			host: NODE,
			ram,
			cpu,
			disk,
			net,
			gpu: gpu
				? pids.reduce((n, p) => n + (gpu.get(p) ?? 0), 0)
				: unmeasured('nvidia-smi could not be read'),
			detail: {
				pid: a.pid,
				pmCwd: a.pmCwd,
				restarts: a.restarts,
				status: a.status,
				subtreePids: pids.length,
				egressClass: egressClassFor(a.name, a.pmCwd, egressSpec),
				ram: {
					steadyBytes: steady,
					peakBytes: mems.length ? mems.reduce((n, m) => n + m.hwm, 0) : null,
					basis:
						'proc-status-VmHWM summed over the subtree — a kernel-recorded peak RSS, so shared pages are counted once per process and the sum is an UPPER bound',
				},
				cpu: {
					windowMillicores:
						wallMs > 0 ? millicores(cpuNow - (cpu0.get(a.name) ?? 0), wallMs) : null,
					lifetimeSeconds: lifetimeSeconds ? Math.round(lifetimeSeconds) : null,
				},
				net: {
					windowMs: Math.round(wallMs),
					sockets: net1 ? pids.reduce((n, p) => n + (net1.get(p)?.sockets ?? 0), 0) : null,
					blindSpot:
						'TCP only, attributed by owning pid; a socket opened AND closed inside the window contributes nothing, and UDP is not counted',
				},
			},
			provenance: provenance(
				[
					'pm2 jlist',
					'/proc/<pid>/stat',
					'/proc/<pid>/status (VmHWM)',
					'/proc/<pid>/smaps_rollup (Pss)',
					'ss -tinp',
					'nvidia-smi --query-compute-apps',
					'manifests/egress-slices.json',
				],
				'per-service'
			),
		});
	}
	return { rows, sliceCpu, lifetimeCpuTotal, wallMs };
}

/**
 * Cron rows.
 *
 * Cadence, timeout and route come from `profiles.json` (operator config, read
 * only). The DURATION is measured, from the cron worker's own log — the worker
 * logs `execute_job <name>` on dispatch and httpx logs the POST's response, and
 * the delta is the route's wall time. That log is the job record these routes
 * leave, and it is the supervisor's, not a declaration.
 *
 * The four resource columns are `unmeasured` with the reason, and the reason is
 * the finding: the work executes INSIDE mgmt-api's process (`runJobThread`,
 * `services/mgmt-api/src/routes/cron.ts`), so the kernel attributes its memory,
 * CPU and sockets to mgmt-api's pid, which the `kind:pm2` row for `mgmt-api`
 * already carries. There is no per-request accounting anywhere, and the job
 * record that exists (`recordJobResult` → the monitoring sink, `db/execution-log`)
 * carries name, status and durationMs only — no peak. Inventing a split would
 * be arithmetic dressed as measurement.
 */
function cronRows() {
	const profilesPath = join(SITE, 'services', 'cron-worker', 'profiles.json');
	if (!existsSync(profilesPath)) {
		fail(
			`no cron profiles at ${profilesPath} — a cron inventory that looked at nothing is not a pass.`
		);
		return [];
	}
	const jobs = flattenCronProfiles(JSON.parse(read(profilesPath)));

	const logDir = join(HOME, '.pm2', 'logs');
	let logText = '';
	const logsRead = [];
	try {
		for (const f of readdirSync(logDir).filter((f) => f.startsWith('cron-worker-error'))) {
			logText += read(join(logDir, f));
			logsRead.push(f);
		}
	} catch (err) {
		fail(`could not read cron-worker logs in ${logDir} (${err.code ?? err.message}).`);
	}
	if (!logsRead.length) {
		fail(
			`no cron-worker log in ${logDir} — every cron duration would be unmeasured with no reason but "did not look".`
		);
	}
	// A privileged job's route segment differs from its job name, so the worker's
	// dispatch line and httpx's completion line carry different strings for the
	// same run. The profile is the authority on the mapping.
	const jobByRouteKey = new Map(
		jobs.filter((j) => j.route).map((j) => [j.route.replace(/\/+$/, '').split('/').pop(), j.name])
	);
	const { runs, openDispatches, abandonedDispatches, orphanCompletions, negativeDurations } =
		parseCronRuns(logText, jobByRouteKey);
	if (negativeDurations) {
		fail(
			`${negativeDurations} cron completion(s) preceded their dispatch after timestamp sorting — ` +
				'the cron-worker log format changed and every duration here is suspect.'
		);
	}

	const sources = [
		`~/srv/${hubRepo()}/services/cron-worker/profiles.json`,
		...logsRead.map((f) => `~/.pm2/logs/${f}`),
	];
	const inProcess =
		"the route executes inside mgmt-api's own process (routes/cron.ts runJobThread), so the kernel attributes it to mgmt-api's pid — already counted by the kind:pm2 row for mgmt-api. No per-request accounting exists, and the job record (recordJobResult → monitoring sink, db/execution-log) carries name/status/durationMs only.";

	return jobs.map((j) => ({
		class: RESIDENT_CLASS,
		kind: 'cron',
		name: j.name,
		host: NODE,
		ram: unmeasured(inProcess),
		cpu: unmeasured(inProcess),
		disk: unmeasured(
			`${inProcess} Its writes land in mgmt-api's state dir and the data volumes, measured as the kind:checkout and kind:mirror rows.`
		),
		net: unmeasured(inProcess),
		gpu: unmeasured(inProcess),
		detail: {
			...j,
			measured: durationStats(runs.get(j.name)) ?? {
				runs: 0,
				why: `no completed run of ${j.name} in the ${logsRead.length} retained cron-worker log file(s)`,
			},
			openDispatches: openDispatches.get(j.name) ?? 0,
			// A dispatch the worker logged and no completion ever answered. Carried
			// per job because it is an operational fact about THAT job, not noise:
			// the run happened and its outcome is unknown.
			abandonedDispatches: abandonedDispatches.get(j.name) ?? 0,
			orphanCompletions: orphanCompletions.get(j.name) ?? 0,
			executesIn: 'mgmt-api',
		},
		provenance: provenance(sources, 'per-service'),
	}));
}

/**
 * Deployment-checkout rows.
 *
 * One per directory under `~/srv`. `node_modules` is measured separately
 * because it is the part a claw would have to rebuild rather than copy, and
 * redeploy cadence comes from the checkout's own git mtime — the deployer
 * touches it, so the kernel's timestamp is the record.
 */
function checkoutRows() {
	let entries;
	try {
		entries = readdirSync(SRV, { withFileTypes: true }).filter((e) => e.isDirectory());
	} catch (err) {
		fail(
			`could not list ${SRV} (${err.code ?? err.message}) — zero checkouts scanned is a failure, not a pass.`
		);
		return [];
	}
	if (!entries.length) {
		fail(
			`${SRV} holds ZERO deploy directories. mgmt-api runs from one of them — unreadable, not clean.`
		);
		return [];
	}
	return entries.map((e) => {
		const path = join(SRV, e.name);
		const total = duBytes(path);
		const mods = duBytes(join(path, 'node_modules'));
		let lastDeployAt = null;
		for (const probe of ['.git/FETCH_HEAD', '.git/HEAD', 'package.json']) {
			try {
				lastDeployAt = new Date(statSync(join(path, probe)).mtimeMs).toISOString();
				break;
			} catch {
				/* try the next probe; "no probe matched" is reported as null below */
			}
		}
		return {
			class: RESIDENT_CLASS,
			kind: 'checkout',
			name: e.name,
			host: NODE,
			ram: unmeasured('a checkout is bytes on disk; the processes it hosts are the kind:pm2 rows'),
			cpu: unmeasured(
				'a checkout consumes CPU only through the processes it hosts (the kind:pm2 rows)'
			),
			disk: isMeasured(total.bytes) ? total.bytes : unmeasured(total.why),
			net: unmeasured(
				"a checkout has no sockets of its own; its redeploy traffic is the deployer's, not a resident rate"
			),
			gpu: 0,
			detail: {
				path,
				nodeModulesBytes: isMeasured(mods.bytes) ? mods.bytes : null,
				nodeModulesWhy: isMeasured(mods.bytes) ? null : mods.why,
				lastDeployAt,
				lastDeployFrom: lastDeployAt
					? 'mtime of .git/FETCH_HEAD, .git/HEAD or package.json, whichever exists first'
					: null,
			},
			provenance: provenance(['du -sb --apparent-size', 'stat(2) mtime'], 'per-service'),
		};
	});
}

/**
 * Mirror rows — the dataplatform data layer.
 *
 * Paths are resolved from the config the service ACTUALLY loads (the user
 * override wins over the committed default, which is the order
 * `server/dataplatform/config.py` documents), never from the committed file
 * alone: the committed one carries Windows drive letters and resolves to
 * nothing on this box.
 *
 * Growth/day is measured from file mtimes, not from a declaration and not from
 * two `du` runs days apart — bytes whose mtime falls in the last 24 h, and in
 * the 7 days before that for a second reading. A file REWRITTEN in place counts
 * its whole size, which overstates growth; that is stated in `detail` rather
 * than corrected, because the correction would need a previous size nothing
 * records.
 */
function mirrorRows() {
	const cfgPaths = [
		join(HOME, '.config', 'dataplatform', 'config.toml'),
		join(HOME, 'repos', 'hadoku-dataplatform', 'server', 'config.toml'),
	];
	const cfg = {};
	const cfgRead = [];
	for (const p of [...cfgPaths].reverse()) {
		if (!existsSync(p)) continue;
		cfgRead.push(p);
		for (const line of read(p).split('\n')) {
			const m = /^\s*([a-z_]+)\s*=\s*"([^"]*)"/.exec(line);
			if (m) cfg[m[1]] = m[2];
		}
	}
	if (!cfgRead.length) {
		fail(
			`no dataplatform config found at ${cfgPaths.join(' or ')} — the mirror's paths are unknown, ` +
				'so it cannot be reported as absent either.'
		);
		return [];
	}

	const targets = [
		{
			name: 'dataplatform-data-root',
			path: cfg.data_root,
			role: 'catalog.db + CAS store + staging + manifests + processed',
		},
		{
			name: 'dataplatform-videos',
			path: cfg.archive_dest_path,
			role: 'encoded archive output (Phase 6 pipeline)',
		},
		{
			name: 'dataplatform-backup-sync',
			path: cfg.backup_sync_path,
			role: 'nightly rsync of everything except videos/',
		},
	].filter((t) => t.path);

	const mounts = (() => {
		try {
			return read('/proc/self/mountinfo');
		} catch {
			return '';
		}
	})();
	const mountFor = (path) => {
		let best = null;
		for (const line of mounts.split('\n')) {
			const f = line.split(' ');
			const mp = f[4];
			if (!mp || !(path === mp || path.startsWith(`${mp.replace(/\/$/, '')}/`))) continue;
			if (!best || mp.length > best.mp.length)
				best = { mp, fstype: line.split(' - ')[1]?.split(' ')[0] ?? null };
		}
		return best;
	};

	const sized = targets.map((t) => ({ ...t, total: duBytes(t.path, { timeoutMs: 480_000 }) }));

	return sized.map((t) => {
		const { total } = t;
		const growth = growthByMtime(t.path);
		const mount = mountFor(t.path);
		// `archive_dest_path` is INSIDE `data_root` on this box, so the two du
		// figures overlap and summing the disk column across mirror rows
		// double-counts 500+ GB. Measured, not assumed: the containment is a
		// prefix test on the resolved paths, and the nested row's own measured
		// bytes are subtracted so R has a usable non-overlapping figure.
		const nested = sized.filter(
			(o) => o.name !== t.name && o.path.startsWith(`${t.path.replace(/\/+$/, '')}/`)
		);
		const nestedBytes = nested.every((o) => isMeasured(o.total.bytes))
			? nested.reduce((n, o) => n + o.total.bytes, 0)
			: null;
		return {
			class: RESIDENT_CLASS,
			kind: 'mirror',
			name: t.name,
			host: NODE,
			ram: unmeasured(
				'a mirror is bytes on a volume; the process that reads and writes it is the kind:pm2 row for dataplatform'
			),
			cpu: unmeasured(
				'same as ram — the dataplatform service and the daily-pipeline cron carry the CPU'
			),
			disk: isMeasured(total.bytes) ? total.bytes : unmeasured(total.why),
			net: unmeasured(
				"local volume, no sockets of its own; ingest traffic is the scraper's and the archive source is a local disk"
			),
			gpu: unmeasured(
				'the archive encode runs NVENC/NVDEC (archive_hwaccel=cuda) inside the daily-pipeline, not in a resident process, so no steady VRAM reservation exists to read — see detail.requires'
			),
			detail: {
				path: t.path,
				role: t.role,
				mountPoint: mount?.mp ?? null,
				fstype: mount?.fstype ?? null,
				containsRows: nested.map((o) => o.name),
				diskExcludingNestedRows:
					nested.length === 0
						? isMeasured(total.bytes)
							? total.bytes
							: null
						: nestedBytes !== null && isMeasured(total.bytes)
							? total.bytes - nestedBytes
							: null,
				overlapWarning: nested.length
					? `disk includes the ${nested.map((o) => o.name).join(', ')} row(s) nested under this path — DO NOT sum the mirror rows' disk column; use diskExcludingNestedRows`
					: null,
				growth,
				requires: mirrorRequires(t, mount),
				configFrom: cfgRead,
			},
			provenance: provenance(
				['du -sb --apparent-size', 'stat(2) mtime', '/proc/self/mountinfo', ...cfgRead],
				'per-service'
			),
		};
	});
}

/** What this volume needs that a claw does not have. Derived from the mount, not asserted. */
function mirrorRequires(target, mount) {
	const out = [];
	if (mount?.fstype && mount.fstype !== 'btrfs' && mount.fstype !== 'ext4') {
		out.push(
			`an ${mount.fstype} volume at ${mount.mp} — no claw carries one, and rsync -a cannot represent 0600 on it`
		);
	}
	out.push(
		`${mount?.mp ?? target.path} is a named fstab mount on this node; a claw would need the physical disk moved or the path re-pointed`
	);
	if (/videos/.test(target.path)) {
		out.push(
			'NVENC/NVDEC for the encode step (config archive_hwaccel=cuda) — hokon has an RTX 4090; no claw has a GPU'
		);
	}
	return out;
}

/** Bytes whose mtime falls in the last day, and in the 7 days before that. */
function growthByMtime(path, { budgetMs = 240_000 } = {}) {
	const now = Date.now();
	const day = 86_400_000;
	const deadline = now + budgetMs;
	let lastDay = 0;
	let prior7 = 0;
	let files = 0;
	let unreadable = 0;
	let truncated = false;
	const walk = (dir, depth) => {
		if (depth > 12) return;
		if (Date.now() > deadline) {
			// A truncated walk UNDERSTATES growth, so it must not read as a number.
			// Saying so is the whole difference between a partial scan and a lie.
			truncated = true;
			return;
		}
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			unreadable += 1;
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				walk(p, depth + 1);
				continue;
			}
			if (!e.isFile()) continue;
			let st;
			try {
				st = statSync(p);
			} catch {
				unreadable += 1;
				continue;
			}
			files += 1;
			const age = now - st.mtimeMs;
			if (age <= day) lastDay += st.size;
			else if (age <= 8 * day) prior7 += st.size;
		}
	};
	walk(path, 0);
	if (!files) {
		return {
			why: `no readable files under ${path} (${unreadable} unreadable entr(ies)) — growth is unmeasured, not zero`,
		};
	}
	if (truncated) {
		return {
			why:
				`the mtime walk of ${path} hit its ${budgetMs}ms budget after ${files} file(s); a truncated walk ` +
				'UNDERSTATES growth, so no number is reported. Raise --growth-budget-ms to settle it.',
			filesScanned: files,
		};
	}
	return {
		bytesLastDay: lastDay,
		bytesPerDayOverPrior7: Math.round(prior7 / 7),
		files,
		unreadableDirs: unreadable,
		basis:
			'sum of st_size for files whose mtime falls in the window; a file rewritten in place counts its whole size, so this OVERSTATES growth and never understates it',
	};
}

// --- main ------------------------------------------------------------------

const egressSpecPath = join(import.meta.dirname, '..', 'manifests', 'egress-slices.json');
let egressSpec = null;
try {
	egressSpec = JSON.parse(read(egressSpecPath));
} catch (err) {
	fail(
		`could not read the egress taxonomy at ${egressSpecPath} (${err.code ?? err.message}) — every PM2 row's egress class would be a guess.`
	);
}

const apps = pm2Apps();
const { rows: pm2, sliceCpu, lifetimeCpuTotal, wallMs } = await pm2Rows(apps, egressSpec);
const rows = [...pm2, ...cronRows(), ...checkoutRows(), ...mirrorRows()];
for (const r of rows) validateResidentRow(r);

if (!rows.length) fail('ZERO resident rows. A measurement of nothing is not a measurement.');

const slice = {
	cgroup: PM2_SLICE,
	memoryCurrent: num(join(PM2_SLICE, 'memory.current')),
	memoryPeak: num(join(PM2_SLICE, 'memory.peak')),
	cpuUsageUsec: sliceCpu,
	procs: (() => {
		try {
			return read(join(PM2_SLICE, 'cgroup.procs')).split('\n').filter(Boolean).length;
		} catch {
			return null;
		}
	})(),
	io: (() => {
		try {
			return read(join(PM2_SLICE, 'io.stat')).trim().split('\n');
		} catch {
			return null;
		}
	})(),
	childCgroups: childCgroupCount(),
	split:
		childCgroupCount() === 0
			? "NONE. The slice has no child cgroups, so memory.peak / cpu.stat / io.stat cannot be attributed per service BY THE CGROUP. Per-service figures in the rows come from /proc over each app's process subtree; the slice figures here are whole-slice totals and must not be summed with them."
			: `${childCgroupCount()} child cgroup(s) exist — a per-service cgroup split is now POSSIBLE and this script does not yet use it. Re-read the schema doc before trusting the /proc figures as the best available.`,
	subtreeCpuUsecSum: lifetimeCpuTotal,
	sampleWindowMs: Math.round(wallMs),
};

function num(path) {
	try {
		return Number(read(path).trim());
	} catch {
		return null;
	}
}

/**
 * How many child cgroups the PM2 slice has — MEASURED, never assumed.
 *
 * This is the question that decides whether a per-service cgroup split is even
 * available, and the answer changes the moment someone gives PM2 apps their own
 * units. Hard-coding "none" would make this script's honesty note into a stale
 * comment, and a comment has been read as evidence in this codebase three times.
 */
function childCgroupCount() {
	try {
		return readdirSync(PM2_SLICE, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
	} catch {
		return null;
	}
}

let writeResult = null;
if (WRITE) {
	const path = join(stateDir(), 'demand-ledger.jsonl');
	const existing = existsSync(path) ? read(path) : '';
	const merged = mergeResidentRows(existing, rows, NODE);
	writeFileSync(path, merged.text);
	writeResult = { path, ...merged };
	delete writeResult.text;
}

const report = {
	ok: findings.length === 0,
	at: AT,
	host: NODE,
	counts: {
		total: rows.length,
		pm2: rows.filter((r) => r.kind === 'pm2').length,
		cron: rows.filter((r) => r.kind === 'cron').length,
		checkout: rows.filter((r) => r.kind === 'checkout').length,
		mirror: rows.filter((r) => r.kind === 'mirror').length,
	},
	slice,
	write: writeResult,
	findings,
	rows,
};

if (JSON_OUT) {
	console.log(JSON.stringify(report, null, 2));
} else {
	const gb = (n) => (isMeasured(n) ? `${(n / 1e9).toFixed(2)} GB` : 'unmeasured');
	console.log(`resident inventory on ${NODE} at ${AT}`);
	for (const kind of ['pm2', 'cron', 'checkout', 'mirror']) {
		const of = rows.filter((r) => r.kind === kind);
		console.log(`\n${kind} (${of.length}):`);
		for (const r of of) {
			console.log(
				`  ${r.name.padEnd(30)} ram=${gb(r.ram).padEnd(12)} cpu=${String(isMeasured(r.cpu) ? `${r.cpu}m` : 'unmeasured').padEnd(12)} ` +
					`disk=${gb(r.disk).padEnd(12)} net=${isMeasured(r.net) ? `${r.net} B/s` : 'unmeasured'}`
			);
		}
	}
	console.log(
		`\nslice ${slice.cgroup}: current=${gb(slice.memoryCurrent)} peak=${gb(slice.memoryPeak)} procs=${slice.procs} childCgroups=${slice.childCgroups}`
	);
	if (writeResult) {
		console.log(
			`\nwrote ${writeResult.written} resident row(s) -> ${writeResult.path} ` +
				`(kept ${writeResult.kept} non-resident line(s), replaced ${writeResult.replaced})`
		);
	}
}

if (findings.length) {
	console.error(`\n✗ service inventory (${findings.length}):`);
	for (const f of findings) console.error(`  ${f}`);
	process.exit(1);
}
