#!/usr/bin/env node
/**
 * fleet perf — every node's measured performance over a window: LAN latency,
 * jitter and loss from the controller, the node's own gateway path, link
 * health, disk throughput/utilisation/await, pressure stalls, load, memory and
 * temperature. Reads the `fleet:perf-samples` recorder's store
 * (src/perf-sample-store.ts); it measures nothing itself.
 *
 * USAGE
 *   fleet perf [<node>] [--hours N] [--json]     default: every node, last 24 h
 *
 * No samples in the window FAILS (exit 1): the recorder not running, or not
 * deployed yet, must never read as a fleet with nothing to report.
 */
import process from 'node:process';

import { perfDir, readActiveRows, readPerfRows } from '../dist/perf-sample-store.js';
import { stateDir } from '../dist/lib/fleet-paths.js';
import { createEmitter } from './lib/emit.mjs';
import { summarizeActiveAll, summarizePeers, summarizePerf } from './lib/perf-summary.mjs';

const argv = process.argv.slice(2);
const out = createEmitter({ json: argv.includes('--json') });
if (argv.includes('--help') || argv.includes('-h')) {
	out.log(
		'fleet perf [<node>] [--hours N] [--json]   measured performance per node (default 24 h)'
	);
	process.exit(0);
}
const hoursAt = argv.indexOf('--hours');
const hours = hoursAt > -1 ? Number(argv[hoursAt + 1]) : 24;
if (!(hours > 0)) {
	out.warn('fleet perf: --hours takes a number above 0');
	process.exit(2);
}
const node = argv.find((a, k) => !a.startsWith('--') && argv[k - 1] !== '--hours');
const NOW = Date.now();
const sinceMs = NOW - hours * 3_600_000;

const read = readPerfRows(perfDir(stateDir()), { sinceMs, node });
const nodes = summarizePerf(read.rows);
const activeRead = readActiveRows(perfDir(stateDir()), { sinceMs, node });
const active = summarizeActiveAll(activeRead.rows);
const peers = summarizePeers(activeRead.rows);
const ok = nodes.length > 0;

const f = (v, w = 6) => String(v ?? '-').padStart(w);
out.log(
	`${'node'.padEnd(8)} ${'link'.padEnd(5)} ${f('n', 4)} ${f('lan50')} ${f('lan95')} ${f('jit95')} ${f('loss%')} ` +
		`${f('gw95')} ${f('sig')} ${f('cpu5m95', 7)} ${f('ioPSI95', 7)} ${f('util95')} ${f('wMB95')} ${f('await95')} ${f('temp')}`
);
for (const n of nodes) {
	out.log(
		`${n.node.padEnd(8)} ${String(n.link?.kind ?? '-').padEnd(5)} ${f(n.samples, 4)} ` +
			`${f(n.lan?.rttP50Ms.p50)} ${f(n.lan?.rttP95Ms.p95)} ${f(n.lan?.jitterMs.p95)} ${f(n.lan?.lossPct)} ` +
			`${f(n.gateway?.rttP95Ms.p95)} ${f(n.link?.wifiSignalDbm?.p50)} ${f(n.cpuSome300.p95, 7)} ${f(n.psi.ioSome.p95, 7)} ` +
			`${f(n.disk?.utilPct.p95)} ${f(n.disk?.writeMBps.p95)} ${f(n.disk?.awaitMs.p95)} ${f(n.cpuTempC.p50)}` +
			(n.unmeasured ? `  (${n.unmeasured} unmeasured${n.lastWhy ? `: ${n.lastWhy}` : ''})` : '')
	);
}
out.log('');
out.log(
	`ACTIVE (idle-only)  ${f('ok', 3)} ${f('busy', 4)} ${f('dist', 4)} ${f('syncW', 6)} ${f('seqW', 6)} ${f('seqR', 6)} ` +
		`${f('rIOPS', 7)} ${f('wIOPS', 7)} ${f('qd1p99', 7)} ${f('upMb', 6)} ${f('downMb', 6)}  fs`
);
for (const a of active) {
	out.log(
		`${a.node.padEnd(19)} ${f(a.measured, 3)} ${f(a.busy, 4)} ${f(a.disturbed, 4)} ${f(a.syncWriteMs.p50, 6)} ` +
			`${f(a.seqWriteMBps.p50, 6)} ${f(a.seqReadMBps.p50, 6)} ${f(a.randReadIops.p50, 7)} ${f(a.randWriteIops.p50, 7)} ` +
			`${f(a.qd1ReadP99Us.p50, 7)} ${f(a.upMbps.p50, 6)} ${f(a.downMbps.p50, 6)}  ${a.fs ?? '-'}` +
			(a.measured === 0 && a.lastWhy ? `  (${a.lastWhy})` : a.fioWhy ? `  (fio: ${a.fioWhy})` : '')
	);
}
if (!active.length) out.log('  no active tests in the window yet');
out.log('');
out.log(
	`PEERS (claw <-> claw, iperf3 p50)       ${f('runs', 4)} ${f('a->b', 7)} ${f('b->a', 7)} ${f('rttA>B', 7)} ${f('rttB>A', 7)} ${f('retx', 5)}`
);
for (const p of peers) {
	out.log(
		`${`${p.a} <-> ${p.b}`.padEnd(39)} ${f(p.runs, 4)} ${f(p.aToBMbps.p50, 7)} ${f(p.bToAMbps.p50, 7)} ` +
			`${f(p.aToBRttMs.p50, 7)} ${f(p.bToARttMs.p50, 7)} ${f(p.retransmits, 5)}` +
			(p.aToBMbps.p50 === null && p.lastWhy ? `  (${p.lastWhy})` : '')
	);
}
if (!peers.length) out.log('  no claw-to-claw tests in the window yet');
if (!ok)
	out.warn(
		`fleet perf: no samples in the last ${hours} h${node ? ` for ${node}` : ''}; is fleet:perf-samples running?`
	);
if (read.badLines + activeRead.badLines)
	out.warn(`fleet perf: ${read.badLines + activeRead.badLines} unreadable line(s) skipped`);
for (const u of activeRead.unreadable) out.warn(`fleet perf: ${u.file} unreadable: ${u.why}`);
for (const u of read.unreadable) out.warn(`fleet perf: ${u.file} unreadable: ${u.why}`);

if (out.json)
	out.emit({
		ok,
		generatedAt: new Date(NOW).toISOString(),
		window: { hours, since: new Date(sinceMs).toISOString() },
		...(ok ? {} : { reason: `no samples in the last ${hours} h` }),
		badLines: read.badLines,
		unreadable: read.unreadable,
		nodes,
		active,
		peers,
	});
process.exit(ok ? 0 : 1);
