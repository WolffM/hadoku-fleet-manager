#!/usr/bin/env node
/**
 * io-cost-ab: does enforcing io.weight help production without starving the
 * work beside it? (hadoku-fleet-manager#158)
 *
 * Alternates windows with io.cost OFF and ON on the root filesystem's disk,
 * under whatever load the box has, and never touches that load: no session is
 * stopped or throttled to make the comparison quiet. Each window records:
 *
 *   prod     the production cgroup's io.pressure (some/full, % of the window)
 *   ready    a readiness URL probed every second: p50/p99/max and failures
 *   low      every cgroup that declares io.weight BELOW the default (agent
 *            sessions, CI): their CPU seconds per second, the work they got
 *            done, and the bytes they moved on the root disk
 *   host     /proc/pressure/io and load1, so windows can be compared
 *
 * The verdict ships io.cost only when production pressure AND ready p99 fall
 * with it on, and the low-weight work keeps at least `--floor` of its OFF
 * rate (a collapse is a fail, not a trade).
 *
 * Switching needs root. It goes through `sudo -n /usr/local/sbin/fleet-io-cost
 * on|off|status` (scripts/io-cost.sh install grants exactly those). The state
 * the run found is restored at the end, and on SIGINT/SIGTERM.
 *
 *   node scripts/io-cost-ab.mjs [--windows 6] [--seconds 300] [--settle 30]
 *        [--prod-cgroup <cgroup, default: the most heavily weighted one>]
 *        [--ready-url http://127.0.0.1:4000/api/ready] [--floor 0.5]
 *        [--measure-only] [--json]
 *
 * `--measure-only` takes ONE window in the current state and switches
 * nothing; it needs no root (the OFF baseline before the helper exists).
 */
import { isMain } from './lib/is-main.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';

const CG = '/sys/fs/cgroup';
const HELPER = '/usr/local/sbin/fleet-io-cost';
const DEFAULT_WEIGHT = 100;

/** `some`/`full` totals (µs) out of a PSI file's text. */
export function parsePressure(text) {
	const out = {};
	for (const m of String(text).matchAll(/^(some|full) .*total=(\d+)/gm)) out[m[1]] = Number(m[2]);
	return out;
}

/** One device's `rbytes`/`wbytes` out of an io.stat file's text. */
export function ioStatBytes(text, dev) {
	const line = String(text)
		.split('\n')
		.find((l) => l.startsWith(`${dev} `));
	if (!line) return 0;
	const kv = Object.fromEntries(
		line
			.split(' ')
			.slice(1)
			.map((p) => p.split('='))
	);
	return Number(kv.rbytes ?? 0) + Number(kv.wbytes ?? 0);
}

/** p-th percentile (0..100) of numbers, nearest rank. null for none. */
export function percentile(xs, p) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

const read = (p) => {
	try {
		return readFileSync(p, 'utf8');
	} catch (e) {
		if (e.code === 'ENOENT') return null;
		throw e;
	}
};

/**
 * Every cgroup that declares io.weight below the default, without its
 * descendants (a slice and the scope in it would count the work twice).
 */
export function lowWeightCgroups(root = CG) {
	const found = [];
	const walk = (dir, rel) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			if (e.code === 'ENOENT') return; // a scope that ended mid-walk
			throw e;
		}
		for (const d of entries) {
			if (!d.isDirectory()) continue;
			const sub = rel ? `${rel}/${d.name}` : d.name;
			const w = /^default (\d+)/.exec(read(join(dir, d.name, 'io.weight')) ?? '');
			if (w && Number(w[1]) < DEFAULT_WEIGHT) found.push(sub);
			else walk(join(dir, d.name), sub);
		}
	};
	walk(root, '');
	return found;
}

/**
 * The cgroup the weights exist to protect: the one declaring the HIGHEST
 * io.weight, below the top level. null when none is above the default.
 */
export function heaviestCgroup(root = CG) {
	let best = null;
	const walk = (dir, rel) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			if (e.code === 'ENOENT') return;
			throw e;
		}
		for (const d of entries) {
			if (!d.isDirectory()) continue;
			const sub = rel ? `${rel}/${d.name}` : d.name;
			const w = /^default (\d+)/.exec(read(join(dir, d.name, 'io.weight')) ?? '');
			if (rel && w && Number(w[1]) > DEFAULT_WEIGHT && (!best || Number(w[1]) > best.weight))
				best = { cgroup: sub, weight: Number(w[1]) };
			walk(join(dir, d.name), sub);
		}
	};
	walk(root, '');
	return best?.cgroup ?? null;
}

/** The root filesystem's whole disks, as `MAJ:MIN`. */
function rootDisks() {
	const src = execFileSync('findmnt', ['-no', 'SOURCE', '/'], { encoding: 'utf8' })
		.split('\n')[0]
		.replace(/\[.*$/, '');
	return execFileSync('lsblk', ['-snro', 'MAJ:MIN,TYPE', src], { encoding: 'utf8' })
		.split('\n')
		.map((l) => l.split(' '))
		.filter((r) => r[1] === 'disk')
		.map((r) => r[0]);
}

/** The counters a window is the difference of. */
function snapshot({ prodCgroup, disks, low }) {
	const cg = (rel, file) => read(join(CG, rel, file));
	const lows = {};
	for (const rel of low) {
		const cpu = /usage_usec (\d+)/.exec(cg(rel, 'cpu.stat') ?? '');
		const io = cg(rel, 'io.stat');
		const psi = cg(rel, 'io.pressure');
		if (!cpu || io === null || psi === null) continue; // ended between listing and reading
		lows[rel] = {
			cpuUsec: Number(cpu[1]),
			bytes: disks.reduce((n, d) => n + ioStatBytes(io, d), 0),
			ioSome: parsePressure(psi).some ?? 0,
		};
	}
	const prod = cg(prodCgroup, 'io.pressure');
	if (prod === null) throw new Error(`the production cgroup ${prodCgroup} has no io.pressure`);
	return {
		t: process.hrtime.bigint(),
		prod: parsePressure(prod),
		host: parsePressure(readFileSync('/proc/pressure/io', 'utf8')),
		lows,
	};
}

/** What changed between two snapshots, as rates over the window. */
export function windowDelta(a, b) {
	const us = Number(b.t - a.t) / 1000;
	const pct = (x, y) => Math.round(((y - x) / us) * 1000) / 10;
	let cpu = 0;
	let bytes = 0;
	let some = 0;
	let n = 0;
	for (const [rel, e] of Object.entries(b.lows)) {
		const s = a.lows[rel] ?? { cpuUsec: 0, bytes: 0, ioSome: 0 }; // a scope born in the window
		cpu += e.cpuUsec - s.cpuUsec;
		bytes += e.bytes - s.bytes;
		some += e.ioSome - s.ioSome;
		n++;
	}
	return {
		seconds: Math.round(us / 1e5) / 10,
		prodSome: pct(a.prod.some, b.prod.some),
		prodFull: pct(a.prod.full, b.prod.full),
		hostSome: pct(a.host.some, b.host.some),
		hostFull: pct(a.host.full, b.host.full),
		lowCgroups: n,
		lowCpuPerSec: Math.round((cpu / us) * 100) / 100,
		lowMBps: Math.round((bytes / 1e6 / (us / 1e6)) * 10) / 10,
		lowIoSomeSum: pct(0, some),
	};
}

async function probeReady(url, deadline) {
	const ms = [];
	let fails = 0;
	while (Date.now() < deadline) {
		const t0 = performance.now();
		try {
			const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
			await r.arrayBuffer();
			if (r.ok) ms.push(performance.now() - t0);
			else fails++;
		} catch (e) {
			if (e.name !== 'TimeoutError' && e.name !== 'AbortError' && e.name !== 'TypeError') throw e;
			fails++;
		}
		const rest = 1000 - (performance.now() - t0);
		if (rest > 0) await new Promise((r) => setTimeout(r, rest));
	}
	const r = (x) => (x === null ? null : Math.round(x));
	return {
		probes: ms.length + fails,
		fails,
		p50: r(percentile(ms, 50)),
		p99: r(percentile(ms, 99)),
		max: r(ms.length ? Math.max(...ms) : null),
	};
}

const helper = (verb) =>
	execFileSync('sudo', ['-n', HELPER, verb], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});

/** `on` when every root disk reads enable=1, `off` when none does. */
function ioCostState(disks) {
	const qos = read(join(CG, 'io.cost.qos')) ?? '';
	const on = disks.filter((d) => new RegExp(`^${d} .*enable=1`, 'm').test(qos));
	return on.length === disks.length ? 'on' : on.length === 0 ? 'off' : 'mixed';
}

/** Mean of one field over the windows in one state. */
const mean = (ws, k) => {
	const xs = ws.map((w) => w[k]).filter((x) => typeof x === 'number');
	return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
};

/** The verdict over all windows. */
export function verdict(windows, floor) {
	const by = (s) => windows.filter((w) => w.state === s);
	const off = by('off');
	const on = by('on');
	if (!off.length || !on.length)
		return { ships: null, why: 'needs at least one window in each state' };
	const m = (ws) => ({
		prodSome: mean(ws, 'prodSome'),
		readyP99: mean(
			ws.map((w) => ({ p: w.ready.p99 })),
			'p'
		),
		readyFails: ws.reduce((n, w) => n + w.ready.fails, 0),
		lowCpuPerSec: mean(ws, 'lowCpuPerSec'),
		lowMBps: mean(ws, 'lowMBps'),
		hostSome: mean(ws, 'hostSome'),
		load1: mean(ws, 'load1'),
	});
	const a = m(off);
	const b = m(on);
	const keeps = a.lowCpuPerSec ? b.lowCpuPerSec / a.lowCpuPerSec : null;
	const reasons = [];
	if (!(b.prodSome < a.prodSome))
		reasons.push(`production io.pressure did not fall (${a.prodSome}% -> ${b.prodSome}%)`);
	if (!(b.readyP99 <= a.readyP99))
		reasons.push(`ready p99 did not fall (${a.readyP99} -> ${b.readyP99} ms)`);
	if (keeps !== null && keeps < floor)
		reasons.push(
			`low-weight work kept ${Math.round(keeps * 100)}% of its OFF rate, under the ${Math.round(floor * 100)}% floor`
		);
	return {
		ships: reasons.length === 0,
		why: reasons.length
			? reasons.join('; ')
			: 'production pressure and ready p99 fell, and the low-weight work held',
		off: a,
		on: b,
		lowKept: keeps === null ? null : Math.round(keeps * 100) / 100,
	};
}

function args(argv) {
	const o = {
		windows: 6,
		seconds: 300,
		settle: 30,
		prodCgroup: null,
		readyUrl: 'http://127.0.0.1:4000/api/ready',
		floor: 0.5,
		measureOnly: false,
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const val = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${a} needs a value`);
			return v;
		};
		if (a === '--windows') o.windows = Number(val());
		else if (a === '--seconds') o.seconds = Number(val());
		else if (a === '--settle') o.settle = Number(val());
		else if (a === '--prod-cgroup') o.prodCgroup = val();
		else if (a === '--ready-url') o.readyUrl = val();
		else if (a === '--floor') o.floor = Number(val());
		else if (a === '--measure-only') o.measureOnly = true;
		else if (a === '--json') o.json = true;
		else if (a === '--help' || a === '-h') {
			process.stdout.write(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0] + '*/\n');
			process.exit(0);
		} else throw new Error(`unknown argument ${a}`);
	}
	for (const k of ['windows', 'seconds', 'settle', 'floor'])
		if (!Number.isFinite(o[k]) || o[k] < 0) throw new Error(`--${k} must be a number >= 0`);
	return o;
}

async function main() {
	const o = args(process.argv.slice(2));
	const disks = rootDisks();
	o.prodCgroup ??= heaviestCgroup();
	if (!o.prodCgroup)
		throw new Error(
			'no cgroup declares an io.weight above the default; name one with --prod-cgroup'
		);
	const startState = ioCostState(disks);
	if (startState === 'mixed')
		throw new Error(`io.cost is on for some root disks and not others (${disks.join(', ')})`);
	if (!o.measureOnly) {
		statSync(HELPER); // throws ENOENT with the path: install it first (scripts/io-cost.sh install)
		helper('status');
	}
	const log = (s) => process.stderr.write(`[io-cost-ab] ${s}\n`);
	log(
		`production cgroup ${o.prodCgroup}; root disk ${disks.join(', ')}; io.cost ${startState} at start`
	);
	let restoring = false;
	const restore = () => {
		if (o.measureOnly || restoring) return;
		restoring = true;
		if (ioCostState(disks) !== startState) {
			helper(startState);
			log(`restored io.cost ${startState}`);
		}
	};
	for (const sig of ['SIGINT', 'SIGTERM'])
		process.on(sig, () => {
			restore();
			process.exit(130);
		});

	const windows = [];
	const n = o.measureOnly ? 1 : o.windows;
	try {
		for (let i = 0; i < n; i++) {
			const state = o.measureOnly ? startState : i % 2 === 0 ? 'off' : 'on';
			if (!o.measureOnly && ioCostState(disks) !== state) {
				helper(state);
				if (ioCostState(disks) !== state)
					throw new Error(`asked for io.cost ${state}; the kernel reads ${ioCostState(disks)}`);
				await new Promise((r) => setTimeout(r, o.settle * 1000));
			}
			const low = lowWeightCgroups();
			const a = snapshot({ prodCgroup: o.prodCgroup, disks, low });
			const l0 = loadavg()[0];
			const ready = await probeReady(o.readyUrl, Date.now() + o.seconds * 1000);
			const b = snapshot({ prodCgroup: o.prodCgroup, disks, low: lowWeightCgroups() });
			const w = {
				window: i + 1,
				state,
				...windowDelta(a, b),
				load1: Math.round(((l0 + loadavg()[0]) / 2) * 10) / 10,
				ready,
			};
			windows.push(w);
			log(
				`window ${w.window} io.cost ${state}: prod io some ${w.prodSome}% full ${w.prodFull}%, ` +
					`ready p50 ${ready.p50} p99 ${ready.p99} max ${ready.max} ms (${ready.fails}/${ready.probes} failed), ` +
					`low-weight ${w.lowCgroups} cgroups ${w.lowCpuPerSec} cpu/s ${w.lowMBps} MB/s, host io some ${w.hostSome}%, load1 ${w.load1}`
			);
		}
	} finally {
		restore();
	}
	const result = {
		disks,
		startState,
		prodCgroup: o.prodCgroup,
		windows,
		verdict: o.measureOnly ? null : verdict(windows, o.floor),
	};
	process.stdout.write(
		o.json ? JSON.stringify(result) + '\n' : JSON.stringify(result, null, 2) + '\n'
	);
}

if (isMain(import.meta.url)) {
	main().catch((e) => {
		process.stderr.write(`[io-cost-ab] ${e.stack ?? e}\n`);
		process.exit(1);
	});
}
