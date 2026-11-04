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

import { perfDir, readPerfRows } from '../dist/perf-sample-store.js';
import { stateDir } from '../dist/lib/fleet-paths.js';
import { createEmitter } from './lib/emit.mjs';
import { summarizePerf } from './lib/perf-summary.mjs';

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
const ok = nodes.length > 0;

const f = (v, w = 6) => String(v ?? '-').padStart(w);
out.log(
	`${'node'.padEnd(8)} ${'link'.padEnd(5)} ${f('n', 4)} ${f('lan50')} ${f('lan95')} ${f('jit95')} ${f('loss%')} ` +
		`${f('gw95')} ${f('sig')} ${f('ioPSI95')} ${f('util95')} ${f('wMB95')} ${f('await95')} ${f('temp')}`
);
for (const n of nodes) {
	out.log(
		`${n.node.padEnd(8)} ${String(n.link?.kind ?? '-').padEnd(5)} ${f(n.samples, 4)} ` +
			`${f(n.lan?.rttP50Ms.p50)} ${f(n.lan?.rttP95Ms.p95)} ${f(n.lan?.jitterMs.p95)} ${f(n.lan?.lossPct)} ` +
			`${f(n.gateway?.rttP95Ms.p95)} ${f(n.link?.wifiSignalDbm?.p50)} ${f(n.psi.ioSome.p95)} ` +
			`${f(n.disk?.utilPct.p95)} ${f(n.disk?.writeMBps.p95)} ${f(n.disk?.awaitMs.p95)} ${f(n.cpuTempC.p50)}` +
			(n.unmeasured ? `  (${n.unmeasured} unmeasured${n.lastWhy ? `: ${n.lastWhy}` : ''})` : '')
	);
}
if (!ok)
	out.warn(
		`fleet perf: no samples in the last ${hours} h${node ? ` for ${node}` : ''}; is fleet:perf-samples running?`
	);
if (read.badLines) out.warn(`fleet perf: ${read.badLines} unreadable line(s) skipped`);
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
	});
process.exit(ok ? 0 : 1);
