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
 *          Then fio, 4 KiB random I/O over that same file, page cache bypassed:
 *          IOPS at queue depth 32 (reads, then writes) and read latency at
 *          depth 1. dd cannot measure random I/O, and it is what a database or
 *          a cache actually does.
 *   net    100 MiB controller -> node and node -> controller over ssh, the time
 *          of a bare `ssh true` subtracted. On this LAN the claws reach the
 *          controller through a wireless bridge, so this is the path a service
 *          on a claw actually has to the controller, not the claw's own link.
 *   peer   iperf3 between this claw and one other idle claw, both directions:
 *          the path two copies of a redundant tenant use. The peer is the
 *          claw this one was paired with longest ago, so over days every pair
 *          is covered. The peer runs a one-shot `iperf3 -s -1` per direction,
 *          on {@link IPERF_PORT} (open from the LAN in the node profiles'
 *          openPorts); nothing listens there between tests. A CI job on the
 *          peer afterwards drops the peer numbers.
 *
 * A node under a maintenance, training or reboot drain is not tested.
 */
import { spawn } from 'node:child_process';

import { logger, stateDir } from './host.js';
import { type ActivePerfRow, PERF_SCHEMA } from './lib/perf-row.js';
import { readManifestState } from './lib/manifest.js';
import { isLocalNode } from './lib/node-identity.js';
import { isBackstopNode, type RoleBearingNode } from './lib/node-role.js';
import { nodeShell } from './node-shell.js';
import { CI_WORKERS_FN } from './perf-probe.js';
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
/** Each fio job's measured seconds, after one second of ramp. */
const FIO_SECONDS = 5;
export const IPERF_PORT = 5201;
/** Each iperf3 direction's measured seconds, after one omitted second. */
const PEER_SECONDS = 5;
/** Candidate peers checked for idleness before giving up on a peer this tick. */
const PEER_TRIES = 3;
const JOB_NAME = 'fleet:perf-active';
const OUT_OF_SERVICE = new Set(['maintenance', 'training', 'reboot']);

/**
 * The node-side half. Every `${...}` here is a JavaScript constant interpolated
 * on purpose; the shell parts must never use `${...}` (it would be read as JS).
 */
export const ACTIVE_SCRIPT = String.raw`${CI_WORKERS_FN}
psi() { awk '{split($2,a,"="); print a[2]; exit}' /proc/pressure/$1 2>/dev/null; }
wb=$(ciw); iob=$(psi io); cpb=$(psi cpu)
[ -z "$iob" ] && iob=100; [ -z "$cpb" ] && cpb=100
echo "workersBefore=$wb"; echo "ioSome10=$iob"; echo "cpuSome10=$cpb"
if [ "$wb" != 0 ] || ! awk -v i="$iob" -v c="$cpb" -v mi=${IDLE_IO_PCT} -v mc=${IDLE_CPU_PCT} 'BEGIN{exit !(i<mi && c<mc)}'; then echo "idle=0"; echo "end=1"; exit 0; fi
echo "idle=1"
D="$HOME/.cache/fleet-perf-active"; rm -rf "$D"; mkdir -p "$D" || { echo "why=cannot create $D"; echo "end=1"; exit 0; }
mon=""; trap 'rm -rf "$D"; [ -n "$mon" ] && kill "$mon" 2>/dev/null' EXIT
echo 0 > "$D/maxw"
( m=0; while :; do c=$(ciw); if [ "$c" -gt "$m" ]; then m=$c; echo "$m" > "$D/maxw"; fi; sleep 1; done ) & mon=$!
avail=$(df --output=avail -k "$D" | tail -n1 | tr -dc 0-9); [ -z "$avail" ] && avail=0
if [ "$avail" -lt 1048576 ]; then echo "skip=under 1 GiB free on the root disk"; echo "end=1"; exit 0; fi
echo "fs=$(df --output=fstype "$D" | tail -n1)"
ns() { date +%s%N; }
t0=$(ns); dd if=/dev/zero of="$D/sync" bs=4k count=${SYNC_OPS} oflag=dsync status=none && echo "syncWriteNs=$(( $(ns) - t0 ))"
t0=$(ns); dd if=/dev/zero of="$D/seq" bs=1M count=${SEQ_MIB} oflag=direct conv=fsync status=none && echo "seqWriteNs=$(( $(ns) - t0 ))"
t0=$(ns); dd if="$D/seq" of=/dev/null bs=1M iflag=direct status=none && echo "seqReadNs=$(( $(ns) - t0 ))"
fj() { fio --name=t --filename="$D/seq" --size=${SEQ_MIB}M --rw=$1 --bs=4k --direct=1 --ioengine=libaio --iodepth=$2 --runtime=${FIO_SECONDS} --ramp_time=1 --time_based --output-format=json 2>/dev/null | tr -d '\n\t'; }
if ! command -v fio >/dev/null 2>&1; then echo "fioWhy=fio is not installed"
elif [ ! -f "$D/seq" ]; then echo "fioWhy=the sequential write did not leave a file to test"
else echo "fio.randread32=$(fj randread 32)"; echo "fio.randwrite32=$(fj randwrite 32)"; echo "fio.randread1=$(fj randread 1)"; fi
echo "maxWorkers=$(cat "$D/maxw")"
echo "end=1"
`;

const num = (v: string | undefined): number | null => {
	if (v === undefined || v.trim() === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};
const round = (n: number, places = 2): number => Math.round(n * 10 ** places) / 10 ** places;

interface FioSide {
	iops?: number;
	clat_ns?: { percentile?: Record<string, number> };
}
interface FioJob {
	error?: number;
	read?: FioSide;
	write?: FioSide;
}

/** One fio JSON document's job: IOPS and depth-1 latency percentiles, or why not. PURE. */
export function fioResult(
	json: string | undefined,
	side: 'read' | 'write'
): { iops: number; p50Us: number | null; p99Us: number | null } | { why: string } {
	if (!json) return { why: 'fio printed nothing' };
	let job: FioJob | undefined;
	try {
		job = (JSON.parse(json) as { jobs?: FioJob[] }).jobs?.[0];
	} catch {
		return { why: `fio output is not JSON: ${json.slice(0, 80)}` };
	}
	if (!job) return { why: 'fio reported no job' };
	if (job.error) return { why: `fio job failed with error ${job.error}` };
	const x = job[side];
	if (typeof x?.iops !== 'number' || !(x.iops > 0)) return { why: `fio measured no ${side}s` };
	const p = x.clat_ns?.percentile ?? {};
	const us = (k: string) => (typeof p[k] === 'number' ? round(p[k] / 1000, 1) : null);
	return { iops: Math.round(x.iops), p50Us: us('50.000000'), p99Us: us('99.000000') };
}

/** The fio fields of a disk row from the script's three documents. PURE. */
function fioFields(kv: Map<string, string>): Partial<NonNullable<ActivePerfRow['disk']>> {
	const missing = kv.get('fioWhy');
	if (missing) return { fioWhy: missing };
	if (!kv.has('fio.randread32')) return {};
	const rr = fioResult(kv.get('fio.randread32'), 'read');
	const rw = fioResult(kv.get('fio.randwrite32'), 'write');
	const r1 = fioResult(kv.get('fio.randread1'), 'read');
	const whys = [rr, rw, r1].flatMap((r) => ('why' in r ? [r.why] : []));
	return {
		randReadIops: 'why' in rr ? null : rr.iops,
		randWriteIops: 'why' in rw ? null : rw.iops,
		qd1ReadP50Us: 'why' in r1 ? null : r1.p50Us,
		qd1ReadP99Us: 'why' in r1 ? null : r1.p99Us,
		...(whys.length ? { fioWhy: [...new Set(whys)].join('; ') } : {}),
	};
}

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
					...fioFields(kv),
				}
			: null,
		maxWorkers: num(kv.get('maxWorkers')),
	};
}

type PeerResult = NonNullable<ActivePerfRow['peer']>;

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * The client half, run on the tested node: one run each way, each retried
 * while the peer's one-shot server is not listening yet. `ip` is checked to
 * be an IPv4 address before it is written into a shell script.
 */
export function peerClientScript(ip: string): string {
	if (!IPV4.test(ip)) throw new Error(`not an IPv4 address: ${ip}`);
	return String.raw`c() { o=""; for i in 1 2 3 4 5; do o=$(iperf3 -c ${ip} -p ${IPERF_PORT} -t ${PEER_SECONDS} -O 1 -J $1 2>/dev/null | tr -d '\n\t'); case "$o" in *'"error"'*|'') sleep 1;; *) break;; esac; done; echo "$o"; }
command -v iperf3 >/dev/null 2>&1 || { echo "why=iperf3 is not installed"; echo "end=1"; exit 0; }
sleep 1
echo "out=$(c)"
echo "in=$(c '-R --get-server-output')"
echo "end=1"
`;
}

/** The peer's half: one one-shot server per direction, bounded so nothing outlives the test. */
// The server reports in JSON so that `--get-server-output` hands the reverse
// run's SENDER figures (its TCP round trip) back to the client.
export const PEER_SERVER_CMD = `timeout ${PEER_SECONDS * 2 + 30} sh -c 'iperf3 -s -1 -J -p ${IPERF_PORT} >/dev/null 2>&1; iperf3 -s -1 -J -p ${IPERF_PORT} >/dev/null 2>&1'`;

interface IperfSender {
	mean_rtt?: number;
	max_rtt?: number;
}
interface IperfEnd {
	error?: string;
	end?: {
		sum_received?: { bits_per_second?: number };
		sum_sent?: { retransmits?: number };
		streams?: { sender?: IperfSender }[];
	};
	server_output_json?: { end?: { streams?: { sender?: IperfSender }[] } };
}

interface IperfOk {
	mbps: number;
	retransmits: number | null;
	rttMs: number | null;
	rttMaxMs: number | null;
}

/**
 * One iperf3 JSON document: the receiver's Mb/s, the sender's retransmits and
 * the sender's loaded TCP round trip, or why not. PURE. The client holds the
 * round trip when it sent; in a reverse run the server sent, and its figures
 * arrive in `server_output_json` (iperf3 reports 0 for the side that did not).
 */
export function iperfResult(json: string | undefined): IperfOk | { why: string } {
	if (!json) return { why: 'iperf3 printed nothing (the peer never answered)' };
	let d: IperfEnd;
	try {
		d = JSON.parse(json) as IperfEnd;
	} catch {
		return { why: `iperf3 output is not JSON: ${json.slice(0, 80)}` };
	}
	if (d.error) return { why: `iperf3: ${d.error}` };
	const bps = d.end?.sum_received?.bits_per_second;
	if (typeof bps !== 'number' || !(bps > 0)) return { why: 'iperf3 measured nothing' };
	const rt = d.end?.sum_sent?.retransmits;
	const sender = [
		d.end?.streams?.[0]?.sender,
		d.server_output_json?.end?.streams?.[0]?.sender,
	].find((x) => typeof x?.mean_rtt === 'number' && x.mean_rtt > 0);
	const ms = (us: number | undefined) =>
		typeof us === 'number' && us > 0 ? round(us / 1000, 1) : null;
	return {
		mbps: round(bps / 1e6, 1),
		retransmits: typeof rt === 'number' ? rt : null,
		rttMs: ms(sender?.mean_rtt),
		rttMaxMs: ms(sender?.max_rtt),
	};
}

/** The client script's output, as a peer result. PURE. */
export function parsePeer(peer: string, stdout: string): PeerResult {
	const kv = new Map<string, string>();
	for (const line of String(stdout).split('\n')) {
		const eq = line.indexOf('=');
		if (eq > 0) kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
	}
	const none = { node: peer, outMbps: null, inMbps: null, retransmits: null };
	if (kv.get('end') !== '1')
		return { ...none, why: 'the peer test did not finish (no end marker)' };
	const missing = kv.get('why');
	if (missing) return { ...none, why: missing };
	const out = iperfResult(kv.get('out'));
	const back = iperfResult(kv.get('in'));
	const whys = [
		...('why' in out ? [`out: ${out.why}`] : []),
		...('why' in back ? [`in: ${back.why}`] : []),
	];
	const rts = [out, back].flatMap((r) =>
		'why' in r || r.retransmits === null ? [] : [r.retransmits]
	);
	return {
		node: peer,
		outMbps: 'why' in out ? null : out.mbps,
		inMbps: 'why' in back ? null : back.mbps,
		retransmits: rts.length ? rts.reduce((a, b) => a + b, 0) : null,
		outRttMs: 'why' in out ? null : out.rttMs,
		outRttMaxMs: 'why' in out ? null : out.rttMaxMs,
		inRttMs: 'why' in back ? null : back.rttMs,
		inRttMaxMs: 'why' in back ? null : back.rttMaxMs,
		...(whys.length ? { why: whys.join('; ') } : {}),
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
	/** iperf3 from `node` to `peer` at `ip` and back. Never rejects. */
	peer: (node: string, peer: string, ip: string) => Promise<PeerResult>;
}

/** A claw another claw can be paired with. */
export interface PeerCandidate {
	node: string;
	ip: string;
}

const liveDeps: ActiveDeps = {
	script: (node) => {
		const [bin, argv] = nodeShell(node, 'admin', 'bash -s');
		return run(bin, argv, ACTIVE_SCRIPT, 180_000);
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
		const [bin, argv] = nodeShell(node, 'admin', `${CI_WORKERS_FN}; ciw`);
		const r = await run(bin, argv, null, 20_000);
		return num(r.stdout.trim());
	},
	peer: async (node, peer, ip) => {
		let script: string;
		try {
			script = peerClientScript(ip);
		} catch (err) {
			return {
				node: peer,
				outMbps: null,
				inMbps: null,
				retransmits: null,
				why: err instanceof Error ? err.message : String(err),
			};
		}
		const [sb, sa] = nodeShell(peer, 'admin', PEER_SERVER_CMD);
		const server = run(sb, sa, null, (PEER_SECONDS * 2 + 40) * 1000);
		const [cb, ca] = nodeShell(node, 'admin', 'bash -s');
		const client = await run(cb, ca, script, 120_000);
		const served = await server;
		const r = parsePeer(peer, client.stdout);
		// The server's exit says why a peer never answered: 127 is no iperf3 there.
		if (r.outMbps === null && served.code === 127)
			return { ...r, why: `iperf3 is not installed on ${peer}` };
		if (client.why) return { ...r, why: `could not run the peer test: ${client.why}` };
		return r;
	},
};

/**
 * The peers to try for `node`, best first. PURE. Never the node itself or one
 * under an out-of-service drain; the claw this node was paired with longest
 * ago comes first (never paired first), in either direction, then by name.
 */
export function pickPeers(
	node: string,
	candidates: readonly PeerCandidate[],
	rows: readonly ActivePerfRow[],
	drains: DrainState
): PeerCandidate[] {
	const lastPaired = new Map<string, number>();
	for (const r of rows) {
		const other = r.node === node ? r.peer?.node : r.peer?.node === node ? r.node : undefined;
		if (!other) continue;
		lastPaired.set(other, Math.max(lastPaired.get(other) ?? 0, Date.parse(r.at)));
	}
	return candidates
		.filter((c) => {
			if (c.node === node) return false;
			const kind = drains[c.node]?.kind ?? (drains[c.node] ? 'maintenance' : null);
			return !(kind && OUT_OF_SERVICE.has(kind));
		})
		.sort(
			(a, b) =>
				(lastPaired.get(a.node) ?? 0) - (lastPaired.get(b.node) ?? 0) ||
				a.node.localeCompare(b.node)
		);
}

/**
 * The peer test: the first of up to {@link PEER_TRIES} candidates with no CI
 * job runs it, and is re-counted after. Null when no candidate was idle or
 * there were none; a peer that took a job meanwhile keeps its name, with its
 * numbers dropped.
 */
async function peerTest(
	node: string,
	peers: readonly PeerCandidate[],
	deps: ActiveDeps
): Promise<PeerResult | null> {
	for (const c of peers.slice(0, PEER_TRIES)) {
		const before = await deps.workers(c.node).catch(() => null);
		if (before !== 0) continue;
		const r = await deps.peer(node, c.node, c.ip).catch((err: unknown): PeerResult => ({
			node: c.node,
			outMbps: null,
			inMbps: null,
			retransmits: null,
			why: err instanceof Error ? err.message : String(err),
		}));
		const after = await deps.workers(c.node).catch(() => null);
		if (after === 0) return r;
		return {
			node: c.node,
			outMbps: null,
			inMbps: null,
			retransmits: null,
			why:
				after === null
					? `could not re-count CI workers on ${c.node}; peer numbers dropped`
					: `a CI job arrived on ${c.node} during the peer test; peer numbers dropped`,
		};
	}
	return null;
}

/** One node, end to end; `peers` best first (empty: no peer test). NEVER THROWS. */
export async function testNode(
	node: string,
	at: string,
	deps: ActiveDeps = liveDeps,
	peers: readonly PeerCandidate[] = []
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
	const peer = await peerTest(node, peers, deps);
	// One re-count covers both network tests: a job that arrived during either
	// cannot be placed in time, so both are dropped.
	const after = await deps.workers(node).catch(() => null);
	const measured = { ...base, outcome: 'measured', idle: p.reading, disk: p.disk } as const;
	if (after === null || after > 0)
		return {
			...measured,
			net: null,
			peer: null,
			maxWorkers: after ?? 0,
			why:
				after === null
					? 'could not re-count CI workers after the network tests; network dropped'
					: 'a CI job arrived during the network tests; network dropped',
		};
	const whys = ['why' in net ? net.why : null, peer?.why ? `peer ${peer.node}: ${peer.why}` : null]
		.filter(Boolean)
		.join('; ');
	return {
		...measured,
		net: 'why' in net ? null : net,
		peer,
		maxWorkers: 0,
		...(whys ? { why: whys } : {}),
	};
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

export interface ManifestNode {
	node: string;
	ip: string | null;
	backstop: boolean;
	/** False when the manifest says `peerTest: false`: never paired either way. */
	peerTest: boolean;
}

function manifestNodes(): ManifestNode[] {
	const m = readManifestState();
	if (!m.ok) throw new Error(`cannot read the fleet manifest (${m.why})`);
	const machines = (m.doc.machines ?? {}) as Record<
		string,
		RoleBearingNode & { lan?: { ip?: string }; peerTest?: boolean }
	>;
	return Object.entries(machines).map(([node, v]) => ({
		node,
		ip: v.lan?.ip ?? null,
		backstop: isBackstopNode(v),
		peerTest: v.peerTest !== false,
	}));
}

/** How far back pair history is read: long enough for every pair to come round. */
const PAIR_HISTORY_MS = 14 * 24 * 3_600_000;

/**
 * Who a claw may be paired with: every other claw with a LAN address. The
 * backstop and the controller are never a peer, and a backstop is never paired.
 * Nor is a claw whose manifest entry says `peerTest: false` (claw-1..3: CI only,
 * never a host, operator 2026-11-05), so the pairs measure the claws that may host.
 * Its disk and controller tests still run.
 */
export function peerCandidates(node: string, nodes: readonly ManifestNode[]): PeerCandidate[] {
	const self = nodes.find((n) => n.node === node);
	if (!self || self.backstop || !self.peerTest) return [];
	return nodes.flatMap((n) =>
		n.node !== node && !n.backstop && n.peerTest && n.ip && !isLocalNode(n.node)
			? [{ node: n.node, ip: n.ip }]
			: []
	);
}

/** One tick: pick, test, record. NEVER THROWS. */
export async function perfActiveTick(
	nowMs: number = Date.now(),
	deps: {
		nodes?: ManifestNode[];
		dir?: string;
		drains?: DrainState;
		test?: (node: string, at: string, peers: PeerCandidate[]) => Promise<ActivePerfRow>;
	} = {}
): Promise<{
	verdict: Verdict;
	why?: string;
	node: string | null;
	outcome: ActivePerfRow['outcome'] | null;
}> {
	const dir = deps.dir ?? perfDir(stateDir());
	let node: string | null;
	let peers: PeerCandidate[] = [];
	try {
		const rows = readActiveRows(dir, { sinceMs: nowMs - PAIR_HISTORY_MS }).rows;
		const nodes = deps.nodes ?? manifestNodes();
		const drains = deps.drains ?? readDrain(nowMs);
		node = pickNode(
			nodes.map((n) => n.node),
			rows,
			drains,
			nowMs
		);
		if (node) peers = pickPeers(node, peerCandidates(node, nodes), rows, drains);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		logger.warn(`[perf-active] ${why}`);
		return { verdict: 'unavailable', why, node: null, outcome: null };
	}
	if (!node) return { verdict: 'ok', node: null, outcome: null };
	const at = new Date(nowMs).toISOString();
	const row = await (deps.test ?? ((n, a, p) => testNode(n, a, liveDeps, p)))(node, at, peers);
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
