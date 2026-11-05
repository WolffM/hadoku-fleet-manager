/**
 * The performance probe's parsers, the store, and the tick. The probe text is
 * shaped on a real Wi-Fi claw's output (addresses replaced with 192.0.2.x).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileSync } from 'node:child_process';

import {
	parsePerfProbe,
	PERF_PROBE_SCRIPT,
	pingStats,
	pingTimesOf,
	PING_COUNT,
} from '../perf-probe.js';
import {
	appendPerfRows,
	prunePerfDir,
	readPerfRows,
	PERF_SCHEMA,
	type PerfSampleRow,
} from '../perf-sample-store.js';
import { perfSampleTick, sampleNode } from '../perf-sample.js';

const WIFI_PROBE = `iface=wlp5s0
gw=192.0.2.1
bootId=9e2575b8-7385-40a6-9ea7-9c8d4f048fed
uptime=115382.02
kind=wifi
speed=
carrier=2
rx_bytes=4874254396
tx_bytes=1403629159
rx_errors=0
tx_errors=0
rx_dropped=55584
tx_dropped=0
signalProc=-55
psi.cpu.some=9.10
psi.cpu.full=0.00
psi.io.some=2.53
psi.io.full=1.85
psi.memory.some=0.00
psi.memory.full=0.00
psi300.cpu.some=38.42
psi300.cpu.full=0.00
psi300.io.some=0.40
psi300.io.full=0.12
psi300.memory.some=0.00
psi300.memory.full=0.00
workers=3
load=4.31 2.17 1.36
cores=8
memTotalKb=12170508
memAvailKb=10385276
swapUsedKb=1816
disk=sda
diskstats=500663,16768767,2546453,2862240,120062554,26934361,4851756
rootUsed=9
tempMilli=94000
tempSensor=coretemp
gwping=3.75,6.13,1.25,3.19,
end=1
`;

void test('a whole Wi-Fi probe parses into every field, signal from /proc/net/wireless', () => {
	const r = parsePerfProbe(WIFI_PROBE);
	assert.ok(r.ok);
	const f = r.fields;
	assert.deepEqual(f.link?.wifi, { signalDbm: -55, txBitrateMbps: null });
	assert.equal(f.link?.kind, 'wifi');
	assert.equal(f.link?.speedMbps, null, 'no negotiated speed is unknown, not zero');
	assert.equal(f.link?.rxDropped, 55584);
	assert.deepEqual(f.psi, {
		cpuSome: 9.1,
		ioSome: 2.53,
		ioFull: 1.85,
		memorySome: 0,
		memoryFull: 0,
	});
	assert.deepEqual(f.psi300, {
		cpuSome: 38.42,
		ioSome: 0.4,
		ioFull: 0.12,
		memorySome: 0,
		memoryFull: 0,
	});
	assert.equal(f.workers, 3);
	assert.deepEqual(f.load, { one: 4.31, five: 2.17, fifteen: 1.36, cores: 8 });
	assert.deepEqual(f.memory, { totalMb: 11885, availableMb: 10142, swapUsedMb: 2 });
	assert.equal(f.disk?.device, 'sda');
	assert.equal(f.disk?.writeSectors, 120062554);
	assert.equal(f.disk?.ioMs, 4851756);
	assert.equal(f.disk?.rootUsedPct, 9);
	assert.equal(f.cpuTempC, 94);
	assert.equal(f.cpuTempSensor, 'coretemp');
	assert.equal(f.gateway?.target, '192.0.2.1');
	assert.equal(f.gateway?.received, 4);
	assert.equal(f.gateway?.sent, PING_COUNT);
});

void test('a probe without its end marker is unreadable, never half a row', () => {
	const r = parsePerfProbe(WIFI_PROBE.replace('end=1\n', ''));
	assert.equal(r.ok, false);
});

void test('a key the node could not read is null, not zero', () => {
	const r = parsePerfProbe('iface=\ngw=\nkind=\nload=\ndiskstats=\ntempMilli=\nend=1\n');
	assert.ok(r.ok);
	assert.equal(r.fields.link?.kind, null);
	assert.equal(r.fields.gateway, null);
	assert.equal(r.fields.load?.one, null);
	assert.equal(r.fields.disk?.reads, null);
	assert.equal(r.fields.cpuTempC, null);
	assert.equal(r.fields.workers, null, 'no pgrep is could-not-count, not zero jobs');
	assert.equal(r.fields.psi300?.cpuSome, null);
});

void test('ping stats: percentiles, jitter, and loss as sent minus received', () => {
	const s = pingStats('192.0.2.7', [3, 5, 4, 100, 4], 20);
	assert.deepEqual(s, {
		target: '192.0.2.7',
		sent: 20,
		received: 5,
		minMs: 3,
		p50Ms: 4,
		p95Ms: 100,
		maxMs: 100,
		jitterMs: 48.75,
	});
	const none = pingStats('192.0.2.7', [], 20);
	assert.equal(none.received, 0);
	assert.equal(none.p50Ms, null);
	assert.equal(none.jitterMs, null);
});

void test("ping's own output yields the reply times in order", () => {
	const out =
		'64 bytes from 192.0.2.7: icmp_seq=1 ttl=64 time=3.06 ms\n64 bytes: icmp_seq=2 time=12.4 ms\n';
	assert.deepEqual(pingTimesOf(out), [3.06, 12.4]);
});

const row = (node: string, at: string, extra: Partial<PerfSampleRow> = {}): PerfSampleRow => ({
	v: PERF_SCHEMA,
	at,
	node,
	ok: true,
	...extra,
});

void test('the store appends per UTC day, reads oldest first, filters by node and time, counts torn lines', () => {
	const dir = mkdtempSync(join(tmpdir(), 'perf-store-'));
	try {
		const now = Date.now();
		const t = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
		appendPerfRows(dir, [row('claw-1', t(10)), row('claw-2', t(10))], now);
		appendPerfRows(dir, [row('claw-1', t(5))], now);
		const day = t(5).slice(0, 10);
		writeFileSync(
			join(dir, `perf-${day}.jsonl`),
			readFileSync(join(dir, `perf-${day}.jsonl`), 'utf8') + '{"torn'
		);
		const all = readPerfRows(dir);
		assert.equal(all.rows.length, 3);
		assert.equal(all.badLines, 1);
		assert.ok(Date.parse(all.rows[0].at) <= Date.parse(all.rows[2].at));
		assert.equal(readPerfRows(dir, { node: 'claw-1' }).rows.length, 2);
		assert.equal(readPerfRows(dir, { sinceMs: now - 7 * 60_000 }).rows.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

void test('a missing directory is no rows yet; a day file past retention is pruned', () => {
	assert.equal(readPerfRows('/nonexistent/perf').rows.length, 0);
	const dir = mkdtempSync(join(tmpdir(), 'perf-prune-'));
	try {
		mkdirSync(dir, { recursive: true });
		const old = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
		writeFileSync(join(dir, `perf-${old}.jsonl`), '');
		assert.deepEqual(prunePerfDir(dir, Date.now()), [`perf-${old}.jsonl`]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const lan = pingStats('192.0.2.9', [3, 4], 20);

void test('a node whose probe cannot run is ok:false with the reason, and still carries the controller ping', async () => {
	const r = await sampleNode({ node: 'claw-9', lanIp: '192.0.2.9' }, new Date().toISOString(), {
		ping: () => Promise.resolve(lan),
		probe: () =>
			Promise.resolve({ code: null, stdout: '', stderr: '', why: 'timed out after 30 s' }),
	});
	assert.equal(r.ok, false);
	assert.match(r.why ?? '', /timed out/);
	assert.deepEqual(r.lan, lan);
	assert.equal(r.link, undefined, 'no fabricated fields on a failed row');
});

void test('a torn probe is ok:false naming the exit and the last stderr line', async () => {
	const r = await sampleNode({ node: 'claw-9', lanIp: null }, new Date().toISOString(), {
		probe: () =>
			Promise.resolve({ code: 255, stdout: 'iface=eth0\n', stderr: 'x\nConnection reset\n' }),
	});
	assert.equal(r.ok, false);
	assert.match(r.why ?? '', /no end marker.*exit 255: Connection reset/);
	assert.equal(r.lan, null);
});

void test('a whole probe becomes an ok row', async () => {
	const r = await sampleNode({ node: 'claw-1', lanIp: '192.0.2.9' }, new Date().toISOString(), {
		ping: () => Promise.resolve(lan),
		probe: () => Promise.resolve({ code: 0, stdout: WIFI_PROBE, stderr: '' }),
	});
	assert.equal(r.ok, true);
	assert.equal(r.link?.kind, 'wifi');
	assert.deepEqual(r.lan, lan);
});

void test('the tick records every node, names the unmeasured ones, and an empty manifest is unavailable', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'perf-tick-'));
	try {
		const r = await perfSampleTick(Date.now(), {
			dir,
			nodes: [
				{ node: 'claw-1', lanIp: null },
				{ node: 'claw-2', lanIp: null },
			],
			sample: (n, at) =>
				Promise.resolve(
					n.node === 'claw-2'
						? { v: PERF_SCHEMA, at, node: n.node, ok: false, why: 'unreachable', lan: null }
						: { v: PERF_SCHEMA, at, node: n.node, ok: true, lan: null }
				),
		});
		assert.equal(r.verdict, 'ok');
		assert.equal(r.rows, 2);
		assert.deepEqual(r.unmeasured, ['claw-2']);
		assert.equal(readPerfRows(dir).rows.length, 2);
		const empty = await perfSampleTick(Date.now(), { dir, nodes: [] });
		assert.equal(empty.verdict, 'unavailable');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

void test('the probe script itself runs under bash on this machine and parses whole', () => {
	// The script is a template literal, where `${...}` is JavaScript, not shell:
	// one slipped in once and compiled into a script bash could not run.
	assert.ok(!PERF_PROBE_SCRIPT.includes('${'), 'no ${...} in the probe script');
	const out = execFileSync('bash', ['-s'], {
		input: PERF_PROBE_SCRIPT,
		encoding: 'utf8',
		timeout: 30_000,
	});
	const r = parsePerfProbe(out);
	assert.ok(r.ok, out.slice(-300));
	assert.equal(typeof r.fields.load?.cores, 'number');
	assert.equal(typeof r.fields.memory?.totalMb, 'number');
	assert.equal(
		typeof r.fields.psi300?.cpuSome,
		'number',
		'avg300 is the 4th field of /proc/pressure'
	);
	assert.equal(typeof r.fields.workers, 'number');
});
