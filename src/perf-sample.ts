/**
 * PERFORMANCE SAMPLES, every 5 minutes, for every node in the manifest: the
 * controller pings each node's LAN address, and each node runs the read-only
 * probe in `perf-probe.ts`. One row per node goes to `perf-sample-store.ts`.
 *
 * Operator, 2026-11-04: extensive data on the performance of each and every
 * claw, so host bars (network for every service, disk for a service that moves
 * a lot of data) are set from measurements. Wi-Fi's weakness is latency, jitter
 * and loss, which nothing measured on a claw before this.
 *
 * A node that cannot be reached still gets a row: `ok: false` with the reason,
 * and the controller's ping (which says whether the LAN path is up at all).
 * Could-not-look is a row that says so, never a gap and never zeros.
 *
 * Costs: one ssh and ~4 s of pings per node per tick, all nodes in parallel;
 * the controller's own pings are local `ping` processes. No GitHub call.
 */
import { spawn } from 'node:child_process';

import { logger, stateDir } from './host.js';
import { readManifestState } from './lib/manifest.js';
import { isLocalNode } from './lib/node-identity.js';
import { nodeShell } from './node-shell.js';
import {
	parsePerfProbe,
	PERF_PROBE_SCRIPT,
	PING_COUNT,
	pingStats,
	pingTimesOf,
} from './perf-probe.js';
import {
	appendPerfRows,
	perfDir,
	PERF_SCHEMA,
	type PerfSampleRow,
	type PingStats,
} from './perf-sample-store.js';
import {
	computeFirstDelayMs,
	createOverlapGuard,
	finishTick,
	scheduleRepeating,
	type Verdict,
} from './lib/job-runner.js';

/** Between passes. Matches the job-registry row's `clockMs`. */
export const PERF_SAMPLE_MS = 5 * 60_000;
const FIRST_PASS_MIN_MS = 2 * 60_000;
/** The probe pings for ~4 s; this bounds a hung ssh. */
const PROBE_TIMEOUT_MS = 30_000;
const JOB_NAME = 'fleet:perf-samples';

/** Runs `bin argv`, feeding `input` on stdin. Resolves with what came back; never rejects. */
function run(
	bin: string,
	argv: string[],
	input: string | null,
	timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string; why?: string }> {
	return new Promise((resolve) => {
		let stdout = '';
		let stderr = '';
		let done = false;
		const finish = (r: { code: number | null; why?: string }) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ ...r, stdout, stderr });
		};
		const child = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish({ code: null, why: `timed out after ${timeoutMs / 1000} s` });
		}, timeoutMs);
		child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
		child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
		child.on('error', (err) => finish({ code: null, why: err.message }));
		child.on('close', (code) => finish({ code }));
		child.stdin.on('error', () => undefined);
		child.stdin.end(input ?? '');
	});
}

/** The controller's view of a node's LAN path: a ping burst to its reserved address. */
async function controllerPing(ip: string): Promise<PingStats> {
	const r = await run(
		'ping',
		['-n', '-c', String(PING_COUNT), '-i', '0.2', '-W', '1', ip],
		null,
		15_000
	);
	return pingStats(ip, pingTimesOf(r.stdout), PING_COUNT);
}

interface SampleNode {
	node: string;
	lanIp: string | null;
}

/** One node's row. NEVER THROWS: every failure becomes `ok: false` with its reason. */
export async function sampleNode(
	n: SampleNode,
	at: string,
	deps: {
		ping?: (ip: string) => Promise<PingStats>;
		probe?: (
			node: string
		) => Promise<{ code: number | null; stdout: string; stderr: string; why?: string }>;
	} = {}
): Promise<PerfSampleRow> {
	const ping = deps.ping ?? controllerPing;
	const probe =
		deps.probe ??
		((node: string) => {
			const [bin, argv] = nodeShell(node, 'admin', 'bash -s');
			return run(bin, argv, PERF_PROBE_SCRIPT, PROBE_TIMEOUT_MS);
		});
	// The controller does not ping itself: its own LAN path is not a measurement of anything.
	const lanP = n.lanIp && !isLocalNode(n.node) ? ping(n.lanIp) : Promise.resolve(null);
	const [lan, res] = await Promise.all([
		lanP.catch(() => null),
		probe(n.node).catch((err: unknown) => ({
			code: null,
			stdout: '',
			stderr: '',
			why: err instanceof Error ? err.message : String(err),
		})),
	]);
	const base = { v: PERF_SCHEMA, at, node: n.node, lan } as const;
	if (res.why) return { ...base, ok: false, why: `could not run the probe: ${res.why}` };
	const parsed = parsePerfProbe(res.stdout);
	if (!parsed.ok) {
		const tail = res.stderr.trim().split('\n').pop()?.slice(0, 200);
		return { ...base, ok: false, why: `${parsed.why}; exit ${res.code}${tail ? `: ${tail}` : ''}` };
	}
	return { ...base, ok: true, ...parsed.fields };
}

/** Every manifest node with its reserved LAN address. THROWS on an unreadable manifest. */
function sampleNodes(): SampleNode[] {
	const m = readManifestState();
	if (!m.ok) throw new Error(`cannot read the fleet manifest (${m.why})`);
	const machines = (m.doc.machines ?? {}) as Record<string, { lan?: { ip?: string } }>;
	return Object.entries(machines).map(([node, v]) => ({ node, lanIp: v.lan?.ip ?? null }));
}

/** One tick: sample every node, append. NEVER THROWS; the verdict carries what went wrong. */
export async function perfSampleTick(
	nowMs: number = Date.now(),
	deps: { nodes?: SampleNode[]; dir?: string; sample?: typeof sampleNode } = {}
): Promise<{ verdict: Verdict; why?: string; rows: number; unmeasured: string[] }> {
	let nodes: SampleNode[];
	try {
		nodes = deps.nodes ?? sampleNodes();
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		logger.warn(`[perf-sample] ${why}`);
		return { verdict: 'unavailable', why, rows: 0, unmeasured: [] };
	}
	if (!nodes.length)
		return { verdict: 'unavailable', why: 'the manifest names no nodes', rows: 0, unmeasured: [] };
	const at = new Date(nowMs).toISOString();
	const sample = deps.sample ?? sampleNode;
	const rows = await Promise.all(nodes.map((n) => sample(n, at)));
	const unmeasured = rows.filter((r) => !r.ok).map((r) => r.node);
	try {
		appendPerfRows(deps.dir ?? perfDir(stateDir()), rows, nowMs);
	} catch (err) {
		const why = `could not record ${rows.length} row(s): ${err instanceof Error ? err.message : String(err)}`;
		logger.warn(`[perf-sample] ${why}`);
		return { verdict: 'broke', why, rows: 0, unmeasured };
	}
	// A node we could not measure is recorded as such; the tick itself did its job.
	return {
		verdict: 'ok',
		...(unmeasured.length ? { why: `not measured: ${unmeasured.join(', ')}` } : {}),
		rows: rows.length,
		unmeasured,
	};
}

export async function perfSamplePass(nowMs: number = Date.now()): Promise<void> {
	const r = await perfSampleTick(nowMs);
	await finishTick({
		jobName: JOB_NAME,
		intervalMs: PERF_SAMPLE_MS,
		now: nowMs,
		verdict: r.verdict,
		durationMs: Date.now() - nowMs,
		why: r.why,
		data: { rows: r.rows, unmeasured: r.unmeasured },
		kind: 'recorder',
	});
}

let started = false;
let guard = createOverlapGuard();
let scheduled: ReturnType<typeof scheduleRepeating> | null = null;

/** Test seam: clear the timer and the `started` guard. */
export function __stopPerfSamplingForTesting(): void {
	scheduled?.stop();
	scheduled = null;
	started = false;
	guard = createOverlapGuard();
}

/** Start the clock. Controller-only: `createFleetManager().start()` gates it. */
export function startPerfSampling(): void {
	if (started) return;
	started = true;
	const pass = () => guard.run(() => perfSamplePass());
	const firstIn = computeFirstDelayMs(
		{ intervalMs: PERF_SAMPLE_MS, firstPassMinMs: FIRST_PASS_MIN_MS },
		null
	);
	scheduled = scheduleRepeating(firstIn, PERF_SAMPLE_MS, pass, JOB_NAME);
}
