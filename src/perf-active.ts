/**
 * ACTIVE PERFORMANCE TESTS: disk and network measured by doing the work, on an
 * IDLE node only, one node at a time, each node about every
 * {@link ACTIVE_EVERY_MS}. The passive recorder (`perf-sample.ts`) sees what a
 * node is doing; this measures what it CAN do, for the host bars (R10): disk
 * for a service that moves a lot of data, network for every service.
 *
 * IDLE IS PROVEN, NOT ASSUMED (measured-capabilities-idle-only: a busy box once
 * read 1169 against 1024). The node's script refuses to run unless it has no CI
 * job and its I/O and CPU pressure are under {@link IDLE_IO_PCT} /
 * {@link IDLE_CPU_PCT}, then counts CI workers once a second for the whole disk
 * test, the same evidence bootcamp uses. The controller re-counts after the
 * network test. Any worker seen = `disturbed`, and the numbers are DROPPED, not
 * recorded beside a live job. No drain is taken: the tests are seconds long,
 * so a job that lands meets brief contention rather than a node out of service.
 *
 *   disk   64 synced 4 KiB writes (O_DSYNC: what a database commit waits on),
 *          256 MiB written with the page cache bypassed and flushed, then read
 *          back the same way. On the root disk (a claw's /tmp is RAM), in the
 *          admin user's ~/.cache, removed on exit whatever happens.
 *   net    100 MiB controller -> node and node -> controller over ssh, the time
 *          of a bare `ssh true` subtracted. On this LAN the claws reach the
 *          controller through a wireless bridge, so this is the path a service
 *          on a claw actually has to the controller, not the claw's own link.
 *
 * A node under a maintenance, training or reboot drain is not tested.
 */
import { spawn } from 'node:child_process';

import { logger, stateDir } from './host.js';
import { type ActivePerfRow, PERF_SCHEMA } from './lib/perf-row.js';
import { readManifestState } from './lib/manifest.js';
import { isLocalNode } from './lib/node-identity.js';
import { nodeShell } from './node-shell.js';
import { appendActiveRow, perfDir, readActiveRows } from './perf-sample-store.js';
import { readDrain, type DrainState } from './runners/drain.js';
import {
	computeFirstDelayMs,
	createOverlapGuard,
	finishTick,
	scheduleRepeating,
	type Verdict,
} from './lib/job-runner.js';

/** Between ticks; each tick tests at most one node. */
export const PERF_ACTIVE_TICK_MS = 15 * 60_000;
/** How often each node is measured. */
export const ACTIVE_EVERY_MS = 6 * 3_600_000;
/** After a busy or failed attempt, wait this long before trying the node again. */
export const ACTIVE_RETRY_MS = 30 * 60_000;
/** Pressure (avg10, % of time stalled) at or above which a node is not idle. */
export const IDLE_IO_PCT = 5;
export const IDLE_CPU_PCT = 25;
export const NET_BYTES = 100 * 1024 * 1024;
const SYNC_OPS = 64;
const SEQ_MIB = 256;
const JOB_NAME = 'fleet:perf-active';
const OUT_OF_SERVICE = new Set(['maintenance', 'training', 'reboot']);

/**
 * The node-side half. Every `${...}` here is a JavaScript constant interpolated
 * on purpose; the shell parts must never use `${...}` (it would be read as JS).
 */
export const ACTIVE_SCRIPT = String.raw`w() { pgrep -ax Runner.Worker 2>/dev/null | grep -c " spawnclient "; }
psi() { awk '{split($2,a,"="); print a[2]; exit}' /proc/pressure/$1 2>/dev/null; }
wb=$(w); iob=$(psi io); cpb=$(psi cpu)
[ -z "$iob" ] && iob=100; [ -z "$cpb" ] && cpb=100
echo "workersBefore=$wb"; echo "ioSome10=$iob"; echo "cpuSome10=$cpb"
if [ "$wb" != 0 ] || ! awk -v i="$iob" -v c="$cpb" -v mi=${IDLE_IO_PCT} -v mc=${IDLE_CPU_PCT} 'BEGIN{exit !(i<mi && c<mc)}'; then echo "idle=0"; echo "end=1"; exit 0; fi
echo "idle=1"
D="$HOME/.cache/fleet-perf-active"; rm -rf "$D"; mkdir -p "$D" || { echo "why=cannot create $D"; echo "end=1"; exit 0; }
mon=""; trap 'rm -rf "$D"; [ -n "$mon" ] && kill "$mon" 2>/dev/null' EXIT
echo 0 > "$D/maxw"
( m=0; while :; do c=$(w); if [ "$c" -gt "$m" ]; then m=$c; echo "$m" > "$D/maxw"; fi; sleep 1; done ) & mon=$!
avail=$(df --output=avail -k "$D" | tail -n1 | tr -dc 0-9); [ -z "$avail" ] && avail=0
if [ "$avail" -lt 1048576 ]; then echo "skip=under 1 GiB free on the root disk"; echo "end=1"; exit 0; fi
echo "fs=$(df --output=fstype "$D" | tail -n1)"
ns() { date +%s%N; }
t0=$(ns); dd if=/dev/zero of="$D/sync" bs=4k count=${SYNC_OPS} oflag=dsync status=none && echo "syncWriteNs=$(( $(ns) - t0 ))"
t0=$(ns); dd if=/dev/zero of="$D/seq" bs=1M count=${SEQ_MIB} oflag=direct conv=fsync status=none && echo "seqWriteNs=$(( $(ns) - t0 ))"
t0=$(ns); dd if="$D/seq" of=/dev/null bs=1M iflag=direct status=none && echo "seqReadNs=$(( $(ns) - t0 ))"
echo "maxWorkers=$(cat "$D/maxw")"
echo "end=1"
`;

const num = (v: string | undefined): number | null => {
	if (v === undefined || v.trim() === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};
const round = (n: number, places = 2): number => Math.round(n * 10 ** places) / 10 ** places;

export type ActiveParse =
	| { torn: true; why: string }
	| {
			torn: false;
			idle: boolean;
			reading: NonNullable<ActivePerfRow['idle']>;
			skip: string | null;
			why: string | null;
			disk: NonNullable<ActivePerfRow['disk']> | null;
			maxWorkers: number | null;
	  };

/** The node script's output. PURE. */
export function parseActive(stdout: string): ActiveParse {
	const kv = new Map<string, string>();
	for (const line of String(stdout).split('\n')) {
		const eq = line.indexOf('=');
		if (eq > 0) kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
	}
	if (kv.get('end') !== '1') return { torn: true, why: 'the test did not finish (no end marker)' };
	const reading = {
		workers: num(kv.get('workersBefore')),
		ioSome10: num(kv.get('ioSome10')),
		cpuSome10: num(kv.get('cpuSome10')),
	};
	const secs = (k: string) => {
		const v = num(kv.get(k));
		return v === null || v <= 0 ? null : v / 1e9;
	};
	const sync = secs('syncWriteNs');
	const sw = secs('seqWriteNs');
	const sr = secs('seqReadNs');
	const ran = sync !== null || sw !== null || sr !== null;
	return {
		torn: false,
		idle: kv.get('idle') === '1',
		reading,
		skip: kv.get('skip') || null,
		why: kv.get('why') || null,
		disk: ran
			? {
					fs: kv.get('fs') || null,
					syncWriteMs: sync === null ? null : round((sync * 1000) / SYNC_OPS),
					seqWriteMBps: sw === null ? null : round((SEQ_MIB * 1.048576) / sw),
					seqReadMBps: sr === null ? null : round((SEQ_MIB * 1.048576) / sr),
				}
			: null,
		maxWorkers: num(kv.get('maxWorkers')),
	};
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	ms: number;
	bytesOut: number;
	why?: string;
}

/** Runs `bin argv`; `input` is a string or a byte count of zeros to stream in. Never rejects. */
function run(
	bin: string,
	argv: string[],
	input: string | number | null,
	timeoutMs: number,
	countOnly = false
): Promise<RunResult> {
	return new Promise((resolve) => {
		const t0 = process.hrtime.bigint();
		let stdout = '';
		let stderr = '';
		let bytesOut = 0;
		let done = false;
		const finish = (r: { code: number | null; why?: string }) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ ...r, stdout, stderr, bytesOut, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
		};
		const child = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish({ code: null, why: `timed out after ${timeoutMs / 1000} s` });
		}, timeoutMs);
		child.stdout.on('data', (d: Buffer) => {
			bytesOut += d.length;
			if (!countOnly) stdout += d.toString();
		});
		child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
		child.on('error', (err) => finish({ code: null, why: err.message }));
		child.on('close', (code) => finish({ code }));
		child.stdin.on('error', () => undefined);
		if (typeof input === 'number') {
			const chunk = Buffer.alloc(1024 * 1024);
			let left = input;
			const pump = () => {
				while (left > 0) {
					const n = Math.min(left, chunk.length);
					left -= n;
					if (!child.stdin.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
						child.stdin.once('drain', pump);
						return;
					}
				}
				child.stdin.end();
			};
			pump();
		} else child.stdin.end(input ?? '');
	});
}

export interface ActiveDeps {
	script: (node: string) => Promise<RunResult>;
	net: (node: string) => Promise<NonNullable<ActivePerfRow['net']> | { why: string }>;
	workers: (node: string) => Promise<number | null>;
}

const liveDeps: ActiveDeps = {
	script: (node) => {
		const [bin, argv] = nodeShell(node, 'admin', 'bash -s');
		return run(bin, argv, ACTIVE_SCRIPT, 120_000);
	},
	net: async (node) => {
		const shell = (cmd: string) => nodeShell(node, 'admin', cmd);
		const [b0, a0] = shell('true');
		const base = await run(b0, a0, null, 20_000);
		if (base.why || base.code !== 0)
			return { why: `ssh to the node failed: ${base.why ?? `exit ${base.code}`}` };
		const [b1, a1] = shell('cat > /dev/null');
		const up = await run(b1, a1, NET_BYTES, 120_000);
		const [b2, a2] = shell(`head -c ${NET_BYTES} /dev/zero`);
		const down = await run(b2, a2, null, 120_000, true);
		const mbps = (r: RunResult, bytes: number) => {
			const ms = r.ms - base.ms;
			return r.why || r.code !== 0 || ms <= 0 ? null : round((bytes * 8) / 1e6 / (ms / 1000), 1);
		};
		return {
			upMbps: mbps(up, NET_BYTES),
			downMbps: down.bytesOut === NET_BYTES ? mbps(down, NET_BYTES) : null,
			bytes: NET_BYTES,
		};
	},
	workers: async (node) => {
		const [bin, argv] = nodeShell(
			node,
			'admin',
			'pgrep -ax Runner.Worker 2>/dev/null | grep -c " spawnclient "'
		);
		const r = await run(bin, argv, null, 20_000);
		return num(r.stdout.trim());
	},
};

/** One node, end to end. NEVER THROWS. */
export async function testNode(
	node: string,
	at: string,
	deps: ActiveDeps = liveDeps
): Promise<ActivePerfRow> {
	const base = { v: PERF_SCHEMA, at, node } as const;
	let res: RunResult;
	try {
		res = await deps.script(node);
	} catch (err) {
		return { ...base, outcome: 'failed', why: err instanceof Error ? err.message : String(err) };
	}
	if (res.why) return { ...base, outcome: 'failed', why: `could not run the test: ${res.why}` };
	const p = parseActive(res.stdout);
	if (p.torn) {
		const tail = res.stderr.trim().split('\n').pop()?.slice(0, 200);
		return {
			...base,
			outcome: 'failed',
			why: `${p.why}; exit ${res.code}${tail ? `: ${tail}` : ''}`,
		};
	}
	if (!p.idle)
		return {
			...base,
			outcome: 'busy',
			idle: p.reading,
			why: `not idle: ${p.reading.workers ?? '?'} CI job(s), io ${p.reading.ioSome10 ?? '?'}%, cpu ${p.reading.cpuSome10 ?? '?'}%`,
		};
	if (p.skip) return { ...base, outcome: 'skipped', idle: p.reading, why: p.skip };
	if (p.why) return { ...base, outcome: 'failed', idle: p.reading, why: p.why };
	if (!p.disk)
		return { ...base, outcome: 'failed', idle: p.reading, why: 'no disk measurement came back' };
	if ((p.maxWorkers ?? 1) > 0)
		return {
			...base,
			outcome: 'disturbed',
			idle: p.reading,
			maxWorkers: p.maxWorkers,
			why: 'a CI job arrived during the disk test; numbers dropped',
		};
	// The controller does not measure its own network to itself.
	if (isLocalNode(node))
		return {
			...base,
			outcome: 'measured',
			idle: p.reading,
			disk: p.disk,
			net: null,
			maxWorkers: 0,
		};
	const net = await deps
		.net(node)
		.catch((err: unknown) => ({ why: err instanceof Error ? err.message : String(err) }));
	const after = await deps.workers(node).catch(() => null);
	if (after === null)
		return {
			...base,
			outcome: 'measured',
			idle: p.reading,
			disk: p.disk,
			net: null,
			maxWorkers: 0,
			why: 'could not re-count CI workers after the network test; network dropped',
		};
	if (after > 0)
		return {
			...base,
			outcome: 'measured',
			idle: p.reading,
			disk: p.disk,
			net: null,
			maxWorkers: after,
			why: 'a CI job arrived during the network test; network dropped',
		};
	if ('why' in net)
		return {
			...base,
			outcome: 'measured',
			idle: p.reading,
			disk: p.disk,
			net: null,
			maxWorkers: 0,
			why: net.why,
		};
	return { ...base, outcome: 'measured', idle: p.reading, disk: p.disk, net, maxWorkers: 0 };
}

/**
 * Which node to test now, or null. PURE. Never a node under an out-of-service
 * drain; never one measured within {@link ACTIVE_EVERY_MS} or attempted within
 * {@link ACTIVE_RETRY_MS}; of the rest, the one measured longest ago (never
 * measured first), then the one TRIED longest ago, then by name.
 */
export function pickNode(
	nodes: readonly string[],
	rows: readonly ActivePerfRow[],
	drains: DrainState,
	nowMs: number
): string | null {
	const lastMeasured = new Map<string, number>();
	const lastTried = new Map<string, number>();
	for (const r of rows) {
		const t = Date.parse(r.at);
		lastTried.set(r.node, Math.max(lastTried.get(r.node) ?? 0, t));
		if (r.outcome === 'measured')
			lastMeasured.set(r.node, Math.max(lastMeasured.get(r.node) ?? 0, t));
	}
	const due = nodes.filter((n) => {
		const kind = drains[n]?.kind ?? (drains[n] ? 'maintenance' : null);
		if (kind && OUT_OF_SERVICE.has(kind)) return false;
		if (nowMs - (lastMeasured.get(n) ?? 0) < ACTIVE_EVERY_MS) return false;
		return nowMs - (lastTried.get(n) ?? 0) >= ACTIVE_RETRY_MS;
	});
	// Longest since measured first; among equals, the one tried longest ago, so a
	// node that stays busy does not starve the others every time its retry comes due.
	due.sort(
		(a, b) =>
			(lastMeasured.get(a) ?? 0) - (lastMeasured.get(b) ?? 0) ||
			(lastTried.get(a) ?? 0) - (lastTried.get(b) ?? 0) ||
			a.localeCompare(b)
	);
	return due[0] ?? null;
}

function manifestNodes(): string[] {
	const m = readManifestState();
	if (!m.ok) throw new Error(`cannot read the fleet manifest (${m.why})`);
	return Object.keys(m.doc.machines ?? {});
}

/** One tick: pick, test, record. NEVER THROWS. */
export async function perfActiveTick(
	nowMs: number = Date.now(),
	deps: { nodes?: string[]; dir?: string; drains?: DrainState; test?: typeof testNode } = {}
): Promise<{
	verdict: Verdict;
	why?: string;
	node: string | null;
	outcome: ActivePerfRow['outcome'] | null;
}> {
	const dir = deps.dir ?? perfDir(stateDir());
	let node: string | null;
	try {
		const rows = readActiveRows(dir, { sinceMs: nowMs - ACTIVE_EVERY_MS - ACTIVE_RETRY_MS }).rows;
		node = pickNode(deps.nodes ?? manifestNodes(), rows, deps.drains ?? readDrain(nowMs), nowMs);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		logger.warn(`[perf-active] ${why}`);
		return { verdict: 'unavailable', why, node: null, outcome: null };
	}
	if (!node) return { verdict: 'ok', node: null, outcome: null };
	const row = await (deps.test ?? testNode)(node, new Date(nowMs).toISOString());
	try {
		appendActiveRow(dir, row, nowMs);
	} catch (err) {
		const why = `could not record ${node}'s test: ${err instanceof Error ? err.message : String(err)}`;
		logger.warn(`[perf-active] ${why}`);
		return { verdict: 'broke', why, node, outcome: row.outcome };
	}
	return {
		verdict: 'ok',
		...(row.why ? { why: `${node}: ${row.why}` } : {}),
		node,
		outcome: row.outcome,
	};
}

export async function perfActivePass(nowMs: number = Date.now()): Promise<void> {
	const r = await perfActiveTick(nowMs);
	await finishTick({
		jobName: JOB_NAME,
		intervalMs: PERF_ACTIVE_TICK_MS,
		now: nowMs,
		verdict: r.verdict,
		durationMs: Date.now() - nowMs,
		why: r.why,
		data: { node: r.node, outcome: r.outcome },
		kind: 'recorder',
	});
}

let started = false;
let guard = createOverlapGuard();
let scheduled: ReturnType<typeof scheduleRepeating> | null = null;

export function __stopPerfActiveForTesting(): void {
	scheduled?.stop();
	scheduled = null;
	started = false;
	guard = createOverlapGuard();
}

/** Start the clock. Controller-only: `createFleetManager().start()` gates it. */
export function startPerfActive(): void {
	if (started) return;
	started = true;
	const pass = () => guard.run(() => perfActivePass());
	const firstIn = computeFirstDelayMs(
		{ intervalMs: PERF_ACTIVE_TICK_MS, firstPassMinMs: 10 * 60_000 },
		null
	);
	scheduled = scheduleRepeating(firstIn, PERF_ACTIVE_TICK_MS, pass, JOB_NAME);
}
