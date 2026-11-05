/**
 * The active tests: idle is proven before and during, a disturbed result is
 * dropped, the scheduler picks one due node, and every failure is a row.
 *
 * Fixture nodes are `fx-claw-N`, never a real node's name. `peerCandidates` and
 * `testNode` ask `isLocalNode()`, which compares against this box's hostname,
 * so a fixture named `claw-2` silently became "this node" when CI ran on
 * claw-2, and the suite went red only on whichever claws its names matched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	ACTIVE_EVERY_MS,
	ACTIVE_RETRY_MS,
	ACTIVE_SCRIPT,
	NET_BYTES,
	fioResult,
	iperfResult,
	parseActive,
	parsePeer,
	peerCandidates,
	peerClientScript,
	perfActiveTick,
	pickNode,
	pickPeers,
	testNode,
	type ActiveDeps,
	type ManifestNode,
} from '../perf-active.js';
import { PERF_SCHEMA, readActiveRows, type ActivePerfRow } from '../perf-sample-store.js';

const IDLE_RUN = `workersBefore=0
ioSome10=0.89
cpuSome10=0.00
idle=1
fs=ext4
syncWriteNs=2368000000
seqWriteNs=2590000000
seqReadNs=2500000000
maxWorkers=0
end=1
`;

void test('the node script is valid bash, and its shell never uses ${...}', () => {
	execFileSync('bash', ['-n'], { input: ACTIVE_SCRIPT });
	assert.ok(
		!ACTIVE_SCRIPT.includes('${'),
		'every ${...} must have been interpolated by JavaScript'
	);
});

void test('an idle run parses to per-op sync latency and MB/s', () => {
	const p = parseActive(IDLE_RUN);
	assert.equal(p.torn, false);
	if (p.torn) return;
	assert.equal(p.idle, true);
	assert.deepEqual(p.disk, {
		fs: 'ext4',
		syncWriteMs: 37,
		seqWriteMBps: 103.64,
		seqReadMBps: 107.37,
	});
	assert.equal(p.maxWorkers, 0);
});

void test('a run without its end marker is torn', () => {
	assert.equal(parseActive('idle=1\n').torn, true);
});

const deps = (stdout: string, over: Partial<ActiveDeps> = {}): ActiveDeps => ({
	script: () => Promise.resolve({ code: 0, stdout, stderr: '', ms: 1, bytesOut: 0 }),
	net: () => Promise.resolve({ upMbps: 177.6, downMbps: 114.5, bytes: NET_BYTES }),
	workers: () => Promise.resolve(0),
	peer: (_node, peer) =>
		Promise.resolve({ node: peer, outMbps: 93.3, inMbps: 78.8, retransmits: 0 }),
	...over,
});
const at = new Date().toISOString();

void test('a busy node is a busy row with the gate reading, and nothing else ran', async () => {
	let netCalled = false;
	const r = await testNode(
		'fx-claw-9',
		at,
		deps('workersBefore=2\nioSome10=0.5\ncpuSome10=28.18\nidle=0\nend=1\n', {
			net: () => {
				netCalled = true;
				return Promise.resolve({ upMbps: 1, downMbps: 1, bytes: 1 });
			},
		})
	);
	assert.equal(r.outcome, 'busy');
	assert.match(r.why ?? '', /2 CI job\(s\)/);
	assert.equal(r.disk, undefined);
	assert.equal(netCalled, false);
});

void test('a CI job during the disk test drops the numbers: disturbed, no disk recorded', async () => {
	const r = await testNode('fx-claw-9', at, deps(IDLE_RUN.replace('maxWorkers=0', 'maxWorkers=1')));
	assert.equal(r.outcome, 'disturbed');
	assert.equal(r.disk, undefined);
	assert.equal(r.maxWorkers, 1);
});

void test('an idle node is measured, disk and network both', async () => {
	const r = await testNode('fx-claw-9', at, deps(IDLE_RUN));
	assert.equal(r.outcome, 'measured');
	assert.equal(r.disk?.syncWriteMs, 37);
	assert.deepEqual(r.net, { upMbps: 177.6, downMbps: 114.5, bytes: NET_BYTES });
});

void test('a CI job during the network test keeps the disk and drops the network', async () => {
	const r = await testNode('fx-claw-9', at, deps(IDLE_RUN, { workers: () => Promise.resolve(1) }));
	assert.equal(r.outcome, 'measured');
	assert.equal(r.net, null);
	assert.match(r.why ?? '', /network dropped/);
	const unknown = await testNode(
		'fx-claw-9',
		at,
		deps(IDLE_RUN, { workers: () => Promise.resolve(null) })
	);
	assert.equal(unknown.net, null, 'could not re-count is not zero');
});

void test('low disk space is skipped; a broken run is failed with exit and stderr', async () => {
	const skip = await testNode(
		'fx-claw-9',
		at,
		deps(
			'workersBefore=0\nioSome10=0\ncpuSome10=0\nidle=1\nskip=under 1 GiB free on the root disk\nend=1\n'
		)
	);
	assert.equal(skip.outcome, 'skipped');
	const torn = await testNode(
		'fx-claw-9',
		at,
		deps('', {
			script: () =>
				Promise.resolve({
					code: 255,
					stdout: 'idle=1\n',
					stderr: 'Connection reset\n',
					ms: 1,
					bytesOut: 0,
				}),
		})
	);
	assert.equal(torn.outcome, 'failed');
	assert.match(torn.why ?? '', /exit 255: Connection reset/);
	const unreachable = await testNode(
		'fx-claw-9',
		at,
		deps('', {
			script: () =>
				Promise.resolve({
					code: null,
					stdout: '',
					stderr: '',
					ms: 1,
					bytesOut: 0,
					why: 'timed out after 120 s',
				}),
		})
	);
	assert.equal(unreachable.outcome, 'failed');
});

const row = (
	node: string,
	minsAgo: number,
	outcome: ActivePerfRow['outcome'],
	now: number
): ActivePerfRow => ({
	v: PERF_SCHEMA,
	at: new Date(now - minsAgo * 60_000).toISOString(),
	node,
	outcome,
});

void test('pickNode: never-measured first, then oldest; recent attempts and out-of-service drains wait', () => {
	const now = Date.now();
	const nodes = ['fx-claw-1', 'fx-claw-2', 'fx-claw-3', 'fx-claw-4'];
	const everyMin = ACTIVE_EVERY_MS / 60_000;
	const retryMin = ACTIVE_RETRY_MS / 60_000;
	const rows = [
		row('fx-claw-1', everyMin + 60, 'measured', now), // due, measured longest ago among measured
		row('fx-claw-2', 30, 'measured', now), // fresh: not due
		row('fx-claw-3', retryMin - 5, 'busy', now), // never measured, but tried too recently
	];
	// fx-claw-4 is never measured and never tried: first
	assert.equal(pickNode(nodes, rows, {}, now), 'fx-claw-4');
	assert.equal(
		pickNode(
			nodes,
			rows,
			{ 'fx-claw-4': { kind: 'reboot', reason: 'x', since: '' } } as never,
			now
		),
		'fx-claw-1'
	);
	assert.equal(
		pickNode(nodes, rows, { 'fx-claw-4': { kind: 'lease', reason: 'x', since: '' } } as never, now),
		'fx-claw-4',
		"a tenant's lease does not stop a test"
	);
	assert.equal(pickNode(['fx-claw-2'], rows, {}, now), null);
});

void test('the tick tests the picked node and records its row; nothing due is a quiet ok', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'perf-active-'));
	try {
		const now = Date.now();
		const nodes: ManifestNode[] = [{ node: 'fx-claw-1', ip: '192.0.2.1', backstop: false }];
		const r = await perfActiveTick(now, {
			dir,
			nodes,
			drains: {},
			test: (node, when) =>
				Promise.resolve({ v: PERF_SCHEMA, at: when, node, outcome: 'busy', why: 'not idle' }),
		});
		assert.deepEqual([r.verdict, r.node, r.outcome], ['ok', 'fx-claw-1', 'busy']);
		assert.equal(readActiveRows(dir).rows.length, 1);
		const again = await perfActiveTick(now + 60_000, { dir, nodes, drains: {} });
		assert.deepEqual(
			[again.verdict, again.node],
			['ok', null],
			'retried only after ACTIVE_RETRY_MS'
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

void test('pickNode: a node that stays busy does not starve an untried one', () => {
	const now = Date.now();
	const retryMin = ACTIVE_RETRY_MS / 60_000;
	const rows = [row('fx-claw-10', retryMin + 1, 'busy', now)];
	assert.equal(pickNode(['fx-claw-10', 'fx-claw-2'], rows, {}, now), 'fx-claw-2');
});

const fioDoc = (side: 'read' | 'write', iops: number, p50 = 82_432, p99 = 104_960) =>
	JSON.stringify({
		jobs: [
			{
				error: 0,
				[side]: { iops, clat_ns: { percentile: { '50.000000': p50, '99.000000': p99 } } },
			},
		],
	});

void test('fio: IOPS at depth 32 and depth-1 latency in microseconds join the disk reading', () => {
	const p = parseActive(
		IDLE_RUN.replace(
			'maxWorkers=0',
			`fio.randread32=${fioDoc('read', 88956.4)}\nfio.randwrite32=${fioDoc('write', 72671)}\nfio.randread1=${fioDoc('read', 10552)}\nmaxWorkers=0`
		)
	);
	assert.equal(p.torn, false);
	if (p.torn) return;
	assert.deepEqual(
		[p.disk?.randReadIops, p.disk?.randWriteIops, p.disk?.qd1ReadP50Us, p.disk?.qd1ReadP99Us],
		[88956, 72671, 82.4, 105]
	);
	assert.equal(p.disk?.fioWhy, undefined);
	assert.equal(p.disk?.syncWriteMs, 37, 'the dd numbers are untouched');
});

void test('fio: missing, broken or failed is null with the reason, never a zero', () => {
	const missing = parseActive(
		IDLE_RUN.replace('maxWorkers=0', 'fioWhy=fio is not installed\nmaxWorkers=0')
	);
	assert.equal(!missing.torn && missing.disk?.randReadIops, undefined);
	assert.equal(!missing.torn && missing.disk?.fioWhy, 'fio is not installed');
	const broken = parseActive(
		IDLE_RUN.replace(
			'maxWorkers=0',
			`fio.randread32=\nfio.randwrite32=${JSON.stringify({ jobs: [{ error: 5 }] })}\nfio.randread1=${fioDoc('read', 10552)}\nmaxWorkers=0`
		)
	);
	assert.equal(broken.torn, false);
	if (broken.torn) return;
	assert.equal(broken.disk?.randReadIops, null);
	assert.equal(broken.disk?.randWriteIops, null);
	assert.equal(broken.disk?.qd1ReadP50Us, 82.4);
	assert.match(broken.disk?.fioWhy ?? '', /printed nothing.*error 5/);
	assert.deepEqual(fioResult('{', 'read'), { why: 'fio output is not JSON: {' });
});

const iperfDoc = (bps: number, retransmits?: number) =>
	JSON.stringify({ end: { sum_received: { bits_per_second: bps }, sum_sent: { retransmits } } });

void test('iperf3: the receiver counts the rate; retransmits sum over both directions', () => {
	const r = parsePeer(
		'fx-claw-6',
		`out=${iperfDoc(93_312_345, 2)}\nin=${iperfDoc(78_800_000, 1)}\nend=1\n`
	);
	assert.deepEqual(r, { node: 'fx-claw-6', outMbps: 93.3, inMbps: 78.8, retransmits: 3 });
	const half = parsePeer(
		'fx-claw-6',
		`out=${iperfDoc(93_000_000)}\nin=${JSON.stringify({ error: 'unable to connect to server' })}\nend=1\n`
	);
	assert.equal(half.outMbps, 93);
	assert.equal(half.inMbps, null);
	assert.equal(half.retransmits, null);
	assert.match(half.why ?? '', /in: iperf3: unable to connect/);
	assert.match(
		parsePeer('fx-claw-6', 'why=iperf3 is not installed\nend=1\n').why ?? '',
		/not installed/
	);
	assert.match(parsePeer('fx-claw-6', 'out=').why ?? '', /did not finish/);
	assert.deepEqual(iperfResult(''), { why: 'iperf3 printed nothing (the peer never answered)' });
});

void test('the client script is valid bash, takes only an IPv4 address, and its shell never uses ${...}', () => {
	const sh = peerClientScript('192.0.2.6');
	execFileSync('bash', ['-n'], { input: sh });
	assert.ok(!sh.includes('${'));
	assert.ok(sh.includes('-c 192.0.2.6 -p 5201'));
	assert.throws(() => peerClientScript('192.0.2.6; rm -rf /'), /not an IPv4/);
});

const peerRow = (node: string, peer: string, minsAgo: number, now: number): ActivePerfRow => ({
	...row(node, minsAgo, 'measured', now),
	peer: { node: peer, outMbps: 1, inMbps: 1, retransmits: 0 },
});

void test('pickPeers: never paired first, then paired longest ago in either direction; drains wait', () => {
	const now = Date.now();
	const c = (node: string) => ({ node, ip: '192.0.2.1' });
	const cands = [c('fx-claw-2'), c('fx-claw-3'), c('fx-claw-4'), c('fx-claw-5')];
	const rows = [
		peerRow('fx-claw-1', 'fx-claw-2', 60, now), // paired an hour ago, from fx-claw-1
		peerRow('fx-claw-3', 'fx-claw-1', 600, now), // paired ten hours ago, from fx-claw-3
		peerRow('fx-claw-4', 'fx-claw-5', 1, now), // not involving fx-claw-1
	];
	assert.deepEqual(
		pickPeers('fx-claw-1', [c('fx-claw-1'), ...cands], rows, {}).map((p) => p.node),
		['fx-claw-4', 'fx-claw-5', 'fx-claw-3', 'fx-claw-2']
	);
	assert.deepEqual(
		pickPeers('fx-claw-1', cands, rows, {
			'fx-claw-4': { kind: 'reboot', reason: 'x', since: '' },
		} as never).map((p) => p.node),
		['fx-claw-5', 'fx-claw-3', 'fx-claw-2']
	);
});

void test('peerCandidates: claws with a LAN address only; the backstop is neither peer nor paired', () => {
	const nodes: ManifestNode[] = [
		{ node: 'fx-claw-1', ip: '192.0.2.1', backstop: false },
		{ node: 'fx-claw-2', ip: '192.0.2.2', backstop: false },
		{ node: 'fx-claw-3', ip: null, backstop: false },
		{ node: 'big', ip: '192.0.2.9', backstop: true },
	];
	assert.deepEqual(peerCandidates('fx-claw-1', nodes), [{ node: 'fx-claw-2', ip: '192.0.2.2' }]);
	assert.deepEqual(peerCandidates('big', nodes), []);
});

const c6 = { node: 'fx-claw-6', ip: '192.0.2.6' };
const c4 = { node: 'fx-claw-4', ip: '192.0.2.4' };

void test('the peer test runs against the first idle candidate and joins the row', async () => {
	const counts: Record<string, number[]> = {
		'fx-claw-9': [0],
		'fx-claw-4': [1],
		'fx-claw-6': [0, 0],
	};
	const workers = (n: string) => Promise.resolve(counts[n]?.shift() ?? 0);
	const r = await testNode('fx-claw-9', at, deps(IDLE_RUN, { workers }), [c4, c6]);
	assert.equal(r.outcome, 'measured');
	assert.deepEqual(r.peer, { node: 'fx-claw-6', outMbps: 93.3, inMbps: 78.8, retransmits: 0 });
	assert.equal(r.why, undefined);
	const none = await testNode(
		'fx-claw-9',
		at,
		deps(IDLE_RUN, { workers: (n) => Promise.resolve(n === 'fx-claw-9' ? 0 : 2) }),
		[c4, c6]
	);
	assert.equal(none.peer, null, 'no idle peer: not tested, not a zero');
});

void test('a CI job on the peer during its test drops the peer numbers, keeping its name', async () => {
	const counts: Record<string, number[]> = { 'fx-claw-6': [0, 1] };
	const workers = (n: string) => Promise.resolve(counts[n]?.shift() ?? 0);
	const r = await testNode('fx-claw-9', at, deps(IDLE_RUN, { workers }), [c6]);
	assert.equal(r.peer?.node, 'fx-claw-6');
	assert.equal(r.peer?.outMbps, null);
	assert.match(r.why ?? '', /peer fx-claw-6: a CI job arrived on fx-claw-6/);
	assert.deepEqual(
		r.net,
		{ upMbps: 177.6, downMbps: 114.5, bytes: NET_BYTES },
		'the controller test stands'
	);
});

void test('a CI job on the tested node after the network tests drops both of them', async () => {
	const counts: Record<string, number[]> = { 'fx-claw-9': [1] };
	const workers = (n: string) => Promise.resolve(counts[n]?.shift() ?? 0);
	const r = await testNode('fx-claw-9', at, deps(IDLE_RUN, { workers }), [c6]);
	assert.equal(r.net, null);
	assert.equal(r.peer, null);
	assert.equal(r.disk?.syncWriteMs, 37);
});
