#!/usr/bin/env node
/**
 * io-cost-ab: does enforcing io.weight keep the interactive desktop
 * responsive under agent IO, without hurting production or stalling the
 * agents? (hadoku-fleet-manager#158)
 *
 * Alternates OFF and ON windows under whatever load the box has, and never
 * touches that load: no session is stopped or throttled to make the comparison
 * quiet. OFF is io.cost off on the root disk and the top-level slices at their
 * default weight; ON is io.cost on (`ctrl=auto`) AND `slices-on`
 * (system.slice 1000 over user.slice 100: without it production's own weight
 * competes only inside system.slice, the first A/B's regression). Each window
 * records:
 *
 *   inter    the interactive probe: once a second, a 4k O_DIRECT read of a
 *            random block of a probe file plus a 4k write with fsync, run in
 *            a transient scope under the user's session.slice, where the
 *            desktop is, so the kernel charges it as it charges the desktop.
 *            p50/p99/max of the pair, and session.slice's io.pressure
 *   prod     the production cgroup's io.pressure (some/full, % of the window)
 *   ready    a readiness URL probed every second: p50/p99/max and failures
 *   low      every cgroup that declares io.weight BELOW the default (agent
 *            sessions, CI): their CPU seconds per second and the bytes they
 *            moved on the root disk
 *   host     /proc/pressure/io and load1, so windows can be compared
 *
 * The verdict ships only when the interactive p99 falls, production
 * io.pressure and ready p99 do not rise past the noise band (`--band`, plus
 * 1 point of pressure / 50 ms of p99), and the low-weight work keeps at least
 * `--floor` of its OFF CPU rate. Slower agents are the point; stalled ones
 * are a fail.
 *
 * Switching needs root. It goes through `sudo -n /usr/local/sbin/fleet-io-cost
 * on|off|slices-on|slices-off` (scripts/io-cost.sh install grants exactly its
 * fixed verbs). The state the run found is restored at the end, and on
 * SIGINT/SIGTERM.
 *
 *   node scripts/io-cost-ab.mjs [--windows 6] [--seconds 300] [--settle 30]
 *        [--prod-cgroup <cgroup, default: the most heavily weighted one in
 *         system.slice>] [--ready-url http://127.0.0.1:4000/api/ready]
 *        [--floor 0.25] [--band 0.25] [--probe-dir <dir on the root disk,
 *         default ~/.cache/fleet-io-cost-ab>] [--measure-only] [--json]
 *
 * `--measure-only` takes ONE window in the current state and switches
 * nothing; it needs no root.
 */
import { keepStdoutWhole } from './lib/emit.mjs';
import { isMain } from './lib/is-main.mjs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CG = '/sys/fs/cgroup';
const HELPER = '/usr/local/sbin/fleet-io-cost';
const DEFAULT_WEIGHT = 100;
/** What `fleet-io-cost slices-on` sets; must match SLICE_WEIGHTS in io-cost.sh. */
export const SLICE_WEIGHTS = { 'system.slice': 1000, 'user.slice': 100 };
/** The probe file's size: 4096 distinct 4k blocks to read at random. */
const PROBE_FILE_MB = 16;
/** Absolute noise allowance on top of `--band`. */
const BAND_PRESSURE_PTS = 1;
const BAND_P99_MS = 50;

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

/**
 * cgroups whose io.weight this user may not read (a subtree delegated to
 * another user). They are skipped, never classified, and the result names
 * them so a skipped production or agent cgroup is visible.
 */
export const unreadable = new Set();

/** A cgroup's io.weight text, or null if absent or unreadable (recorded). */
const readWeight = (p) => {
	try {
		return readFileSync(p, 'utf8');
	} catch (e) {
		if (e.code === 'ENOENT') return null;
		if (e.code === 'EACCES') {
			unreadable.add(p.replace(`${CG}/`, '').replace(/\/io\.weight$/, ''));
			return null;
		}
		throw e;
	}
};

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
			if (e.code === 'EACCES') return void unreadable.add(rel);
			throw e;
		}
		for (const d of entries) {
			if (!d.isDirectory()) continue;
			const sub = rel ? `${rel}/${d.name}` : d.name;
			const w = /^default (\d+)/.exec(readWeight(join(dir, d.name, 'io.weight')) ?? '');
			if (w && Number(w[1]) < DEFAULT_WEIGHT) found.push(sub);
			else walk(join(dir, d.name), sub);
		}
	};
	walk(root, '');
	return found;
}

/**
 * The cgroup the weights exist to protect: the one in system.slice declaring
 * the HIGHEST io.weight. null when none is above the default. Only
 * system.slice: the desktop's session.slice weighs 1000 too, and it is the
 * interactive side, not production.
 */
export function heaviestCgroup(root = CG) {
	let best = null;
	const walk = (dir, rel) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			if (e.code === 'ENOENT') return;
			if (e.code === 'EACCES') return void unreadable.add(rel);
			throw e;
		}
		for (const d of entries) {
			if (!d.isDirectory()) continue;
			const sub = rel ? `${rel}/${d.name}` : d.name;
			const w = /^default (\d+)/.exec(readWeight(join(dir, d.name, 'io.weight')) ?? '');
			if (rel && w && Number(w[1]) > DEFAULT_WEIGHT && (!best || Number(w[1]) > best.weight))
				best = { cgroup: sub, weight: Number(w[1]) };
			walk(join(dir, d.name), sub);
		}
	};
	walk(join(root, 'system.slice'), 'system.slice');
	return best?.cgroup ?? null;
}

/** The whole disks under a path's filesystem (default `/`), as `MAJ:MIN`. */
function rootDisks(target = '/') {
	const src = execFileSync('findmnt', ['-no', 'SOURCE', '-T', target], { encoding: 'utf8' })
		.split('\n')[0]
		.replace(/\[.*$/, '');
	return execFileSync('lsblk', ['-snro', 'MAJ:MIN,TYPE', src], { encoding: 'utf8' })
		.split('\n')
		.map((l) => l.split(' '))
		.filter((r) => r[1] === 'disk')
		.map((r) => r[0]);
}

/** The counters a window is the difference of. */
function snapshot({ prodCgroup, interCgroup, disks, low }) {
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
	const inter = cg(interCgroup, 'io.pressure');
	if (inter === null) throw new Error(`the interactive cgroup ${interCgroup} has no io.pressure`);
	return {
		t: process.hrtime.bigint(),
		prod: parsePressure(prod),
		inter: parsePressure(inter),
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
		interSome: pct(a.inter.some, b.inter.some),
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

/** Seconds out of dd's own `copied, 0.00507 s` line (LC_ALL=C). */
export function ddSeconds(stderr) {
	const m = /copied, ([\d.e+-]+) s/.exec(String(stderr));
	return m ? Number(m[1]) : null;
}

/** p50/p99/max (ms) of the probe's samples, and how many failed. */
export function summarizeProbe(samples, cgroup) {
	const ok = samples.filter((x) => typeof x.ms === 'number');
	const r = (x) => (x === null ? null : Math.round(x * 10) / 10);
	const of = (k) => ok.map((x) => x[k]);
	return {
		cgroup,
		samples: samples.length,
		fails: samples.length - ok.length,
		p50: r(percentile(of('ms'), 50)),
		p99: r(percentile(of('ms'), 99)),
		max: r(ok.length ? Math.max(...of('ms')) : null),
		readP99: r(percentile(of('readMs'), 99)),
		writeP99: r(percentile(of('writeMs'), 99)),
		firstError: samples.find((x) => x.err)?.err ?? null,
	};
}

/**
 * The probe itself, run INSIDE the session.slice scope: one line naming its
 * cgroup, then once a second a 4k O_DIRECT read of a random block of the
 * probe file (never served from the page cache) and a 4k write with fsync,
 * each timed by dd itself so the fork under load does not count.
 */
async function interactiveProbe(dir, seconds) {
	process.stdout.write(
		JSON.stringify({ cgroup: readFileSync('/proc/self/cgroup', 'utf8').trim() }) + '\n'
	);
	const blocks = (PROBE_FILE_MB * 1024 * 1024) / 4096;
	const env = { ...process.env, LC_ALL: 'C' };
	// dd prints its timing on stderr, which execFileSync does not return.
	const dd = (argv) => {
		const r = spawnSync('dd', argv, { encoding: 'utf8', env, stdio: ['ignore', 'ignore', 'pipe'] });
		const secs = r.status === 0 ? ddSeconds(r.stderr) : null;
		if (secs !== null) return secs;
		return {
			err: `dd exit ${r.status ?? r.signal}: ${String(r.stderr ?? r.error)
				.trim()
				.split('\n')
				.pop()}`,
		};
	};
	const deadline = Date.now() + seconds * 1000;
	while (Date.now() < deadline) {
		const t0 = Date.now();
		const skip = Math.floor(Math.random() * blocks);
		const rd = dd([
			`if=${join(dir, 'read.bin')}`,
			'of=/dev/null',
			'bs=4k',
			'count=1',
			`skip=${skip}`,
			'iflag=direct',
		]);
		const wr = dd([
			'if=/dev/zero',
			`of=${join(dir, 'write.bin')}`,
			'bs=4k',
			'count=1',
			'conv=notrunc,fsync',
		]);
		const line =
			typeof rd === 'number' && typeof wr === 'number'
				? { ms: (rd + wr) * 1000, readMs: rd * 1000, writeMs: wr * 1000 }
				: {
						err: [rd, wr]
							.filter((x) => typeof x !== 'number')
							.map((x) => x?.err ?? 'dd printed no time')
							.join('; '),
					};
		process.stdout.write(JSON.stringify(line) + '\n');
		const rest = 1000 - (Date.now() - t0);
		if (rest > 0) await new Promise((r) => setTimeout(r, rest));
	}
}

/** Make the probe's files, on the root disk; the read file is written past the cache. */
function prepareProbeDir(dir, disks) {
	mkdirSync(dir, { recursive: true });
	const here = rootDisks(dir);
	if (!here.length || !here.every((d) => disks.includes(d)))
		throw new Error(
			`--probe-dir ${dir} is on ${here.join(', ') || 'no disk'}, not the root disk ${disks.join(', ')}`
		);
	execFileSync('dd', [
		'if=/dev/urandom',
		`of=${join(dir, 'read.bin')}`,
		'bs=1M',
		`count=${PROBE_FILE_MB}`,
		'oflag=direct',
		'status=none',
	]);
}

/**
 * Run the probe for `seconds` in a transient scope under the user's
 * session.slice, where the desktop is. Resolves when the scope has named its
 * cgroup (so the window's snapshots can start), with `done` for the summary.
 * A probe that is not in session.slice is refused: it would measure the
 * wrong party, which is what the first A/B did.
 */
function startInteractiveProbe(dir, seconds) {
	const child = spawn(
		'systemd-run',
		[
			'--user',
			'--slice=session.slice',
			'--scope',
			'--quiet',
			'--collect',
			'--',
			process.execPath,
			fileURLToPath(import.meta.url),
			'--interactive-probe',
			dir,
			String(seconds),
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);
	const samples = [];
	let cgroup = null;
	let err = '';
	let buf = '';
	let named;
	const ready = new Promise((res, rej) => {
		named = { res, rej };
	});
	child.stderr.on('data', (d) => (err += d));
	child.stdout.on('data', (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = JSON.parse(buf.slice(0, i));
			buf = buf.slice(i + 1);
			if ('cgroup' in line) {
				cgroup = line.cgroup.replace(/^0::/, '');
				if (!/\/session\.slice\/[^/]+\.scope$/.test(cgroup)) {
					child.kill();
					named.rej(
						new Error(`the interactive probe landed in ${cgroup}, not under session.slice`)
					);
				} else named.res(cgroup.replace(/^\//, '').replace(/\/[^/]+\.scope$/, ''));
			} else samples.push(line);
		}
	});
	const done = new Promise((res, rej) =>
		child.on('close', (code) => {
			if (cgroup === null) {
				const e = new Error(
					`the interactive probe never started (systemd-run exit ${code}): ${err.trim()}`
				);
				named.rej(e);
				return rej(e);
			}
			if (code !== 0) return rej(new Error(`the interactive probe exited ${code}: ${err.trim()}`));
			const sum = summarizeProbe(samples, cgroup);
			// "I could not look" is not a latency: a window whose probe mostly failed
			// has no interactive number to compare.
			if (sum.samples - sum.fails < Math.max(1, sum.samples / 2))
				return rej(
					new Error(
						`the interactive probe failed ${sum.fails} of ${sum.samples} samples: ${sum.firstError ?? 'no samples'}`
					)
				);
			res(sum);
		})
	);
	return { ready, done, child };
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

/** `on` when both slices read slices-on's weights, `off` when both read the default. */
function slicesState() {
	const w = (s) => Number(/^default (\d+)/.exec(read(join(CG, s, 'io.weight')) ?? '')?.[1]);
	const ws = Object.entries(SLICE_WEIGHTS).map(([s, want]) => [w(s), want]);
	if (ws.every(([got, want]) => got === want)) return 'on';
	if (ws.every(([got]) => got === DEFAULT_WEIGHT)) return 'off';
	return 'mixed';
}

/** ON is io.cost on AND slices-on; OFF is both off; anything else is mixed. */
function abState(disks) {
	const io = ioCostState(disks);
	const sl = slicesState();
	return io === sl ? io : 'mixed';
}

/** Put the box in `on` or `off`, each half through its own fixed verb, and read it back. */
function setState(disks, want) {
	if (ioCostState(disks) !== want) helper(want);
	if (slicesState() !== want) helper(`slices-${want}`);
	const got = abState(disks);
	if (got !== want)
		throw new Error(
			`asked for ${want}; io.cost reads ${ioCostState(disks)}, slices ${slicesState()}`
		);
}

/** Mean of one field over the windows in one state. */
const mean = (ws, k) => {
	const xs = ws.map((w) => w[k]).filter((x) => typeof x === 'number');
	return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
};

/** Does `on` stay within `off`'s noise band: on <= off * (1 + band) + abs. */
const withinBand = (off, on, band, abs) => on <= off * (1 + band) + abs;

/** The verdict over all windows. */
export function verdict(windows, floor, band = 0.25) {
	const by = (s) => windows.filter((w) => w.state === s);
	const off = by('off');
	const on = by('on');
	if (!off.length || !on.length)
		return { ships: null, why: 'needs at least one window in each state' };
	const m = (ws) => ({
		interP99: mean(
			ws.map((w) => ({ p: w.inter.p99 })),
			'p'
		),
		interSome: mean(ws, 'interSome'),
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
	const pct = Math.round(band * 100);
	const reasons = [];
	if (!(b.interP99 < a.interP99))
		reasons.push(`interactive p99 did not fall (${a.interP99} -> ${b.interP99} ms)`);
	if (!withinBand(a.prodSome, b.prodSome, band, BAND_PRESSURE_PTS))
		reasons.push(
			`production io.pressure rose past the band (${a.prodSome}% -> ${b.prodSome}%, band +${pct}% +${BAND_PRESSURE_PTS} pt)`
		);
	if (!withinBand(a.readyP99, b.readyP99, band, BAND_P99_MS))
		reasons.push(
			`ready p99 rose past the band (${a.readyP99} -> ${b.readyP99} ms, band +${pct}% +${BAND_P99_MS} ms)`
		);
	if (keeps !== null && keeps < floor)
		reasons.push(
			`low-weight work kept ${Math.round(keeps * 100)}% of its OFF rate, under the ${Math.round(floor * 100)}% floor`
		);
	return {
		ships: reasons.length === 0,
		why: reasons.length
			? reasons.join('; ')
			: 'interactive p99 fell, production held within the band, and the low-weight work kept its floor',
		band: `on <= off * ${1 + band} + ${BAND_PRESSURE_PTS} pt pressure / ${BAND_P99_MS} ms p99`,
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
		floor: 0.25,
		band: 0.25,
		probeDir: join(homedir(), '.cache', 'fleet-io-cost-ab'),
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
		else if (a === '--band') o.band = Number(val());
		else if (a === '--probe-dir') o.probeDir = val();
		else if (a === '--measure-only') o.measureOnly = true;
		else if (a === '--json') o.json = true;
		else if (a === '--help' || a === '-h') {
			process.stdout.write(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0] + '*/\n');
			process.exit(0);
		} else throw new Error(`unknown argument ${a}`);
	}
	for (const k of ['windows', 'seconds', 'settle', 'floor', 'band'])
		if (!Number.isFinite(o[k]) || o[k] < 0) throw new Error(`--${k} must be a number >= 0`);
	if (o.seconds < 10)
		throw new Error('--seconds must be at least 10, or the probe has nothing to rank');
	return o;
}

/** Refuse before switching anything if the grant cannot switch both halves. */
function checkGrant() {
	statSync(HELPER); // throws ENOENT with the path: install it first (scripts/io-cost.sh install)
	const grants = execFileSync('sudo', ['-n', '-l'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	// sudo wraps its listing at 80 columns, splitting one entry across lines:
	// rejoin it, then keep only the NOPASSWD entries (a password rule would
	// prompt, and -n refuses a prompt).
	const nopass = (grants.replace(/\s+/g, ' ').match(/NOPASSWD:[^(]*/g) ?? []).join(' ');
	const missing = ['on', 'off', 'slices-on', 'slices-off'].filter(
		(v) => !new RegExp(`${HELPER} ${v}(,|$| )`).test(nopass)
	);
	if (missing.length)
		throw new Error(
			`the sudo grant does not cover ${missing.map((v) => `fleet-io-cost ${v}`).join(', ')}; ` +
				'the operator re-runs: sudo bash scripts/io-cost.sh install'
		);
}

async function main() {
	// Both the result document and the probe's sample lines go through a pipe.
	keepStdoutWhole();
	const argv = process.argv.slice(2);
	if (argv[0] === '--interactive-probe') return interactiveProbe(argv[1], Number(argv[2]));
	const o = args(argv);
	const disks = rootDisks();
	o.prodCgroup ??= heaviestCgroup();
	if (!o.prodCgroup)
		throw new Error(
			'no cgroup in system.slice declares an io.weight above the default; name one with --prod-cgroup'
		);
	const startState = abState(disks);
	if (startState === 'mixed' && !o.measureOnly)
		throw new Error(
			`io.cost reads ${ioCostState(disks)} and the slices ${slicesState()}; the A/B starts only from both on or both off`
		);
	if (!o.measureOnly) {
		checkGrant();
		helper('status');
	}
	const log = (s) => process.stderr.write(`[io-cost-ab] ${s}\n`);
	log(
		`production cgroup ${o.prodCgroup}; root disk ${disks.join(', ')}; io.cost ${ioCostState(disks)}, slices ${slicesState()} at start`
	);
	prepareProbeDir(o.probeDir, disks);
	let probe = null;
	let restoring = false;
	const restore = () => {
		probe?.child.kill();
		if (!restoring) rmSync(o.probeDir, { recursive: true, force: true });
		if (o.measureOnly || restoring) return;
		restoring = true;
		if (abState(disks) !== startState) {
			setState(disks, startState);
			log(`restored ${startState}: io.cost ${ioCostState(disks)}, slices ${slicesState()}`);
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
			if (!o.measureOnly && abState(disks) !== state) {
				setState(disks, state);
				await new Promise((r) => setTimeout(r, o.settle * 1000));
			}
			probe = startInteractiveProbe(o.probeDir, o.seconds);
			const interCgroup = await probe.ready;
			const low = lowWeightCgroups();
			const a = snapshot({ prodCgroup: o.prodCgroup, interCgroup, disks, low });
			const l0 = loadavg()[0];
			const ready = await probeReady(o.readyUrl, Date.now() + o.seconds * 1000);
			const inter = await probe.done;
			probe = null;
			const b = snapshot({ prodCgroup: o.prodCgroup, interCgroup, disks, low: lowWeightCgroups() });
			const w = {
				window: i + 1,
				state,
				...windowDelta(a, b),
				load1: Math.round(((l0 + loadavg()[0]) / 2) * 10) / 10,
				inter,
				ready,
			};
			windows.push(w);
			log(
				`window ${w.window} ${state}: interactive p50 ${inter.p50} p99 ${inter.p99} max ${inter.max} ms ` +
					`(read p99 ${inter.readP99}, write+fsync p99 ${inter.writeP99}; ${inter.fails}/${inter.samples} failed; session.slice io some ${w.interSome}%), ` +
					`prod io some ${w.prodSome}% full ${w.prodFull}%, ` +
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
		unreadableCgroups: [...unreadable].sort(),
		windows,
		verdict: o.measureOnly ? null : verdict(windows, o.floor, o.band),
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
