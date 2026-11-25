#!/usr/bin/env node
/**
 * fleet dev-usage — what each repo's agent sessions and CI jobs use on THIS box,
 * and what the proposed dev-slice ceilings would have clipped. The shadow week
 * for per-repo slices on hokon (docs/tools/slice.md, "Dev slices").
 *
 * USAGE
 *   fleet dev-usage [--hours N] [--json]   report the window (default 24 h)
 *   fleet dev-usage --sample               record one interval (the user timer
 *                                          deploy/systemd/user-priority/dev-usage.timer)
 *
 * --sample reads the user manager's cgroups: every tmux pane scope under
 * app.slice, any other app.slice cgroup holding a `claude` process (a session
 * started in Konsole), and every unit under ci.slice/ci-runner.slice. It moves
 * nothing and sets nothing. The first sample after a gap only seeds the
 * counters; a row needs two.
 *
 * Unreadable app.slice FAILS (exit 1): no cgroup tree is not "no sessions".
 * A report with no rows in the window fails too.
 */
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { writeJsonAtomicSync } from '../dist/lib/atomic-json.js';
import { stateDir } from '../dist/lib/fleet-paths.js';
import { createEmitter } from './lib/emit.mjs';
import {
	PROPOSED,
	repoOfCiUnit,
	repoOfPath,
	summarizeDevUsage,
	usageRow,
} from './lib/dev-usage.mjs';

const argv = process.argv.slice(2);
const out = createEmitter({ json: argv.includes('--json') });
if (argv.includes('--help') || argv.includes('-h')) {
	out.log(
		'fleet dev-usage [--hours N] [--json]   per-repo use of this box, against the proposed dev-slice ceilings'
	);
	out.log('fleet dev-usage --sample              record one interval (run by dev-usage.timer)');
	process.exit(0);
}

/** A sample older than this does not pair with the next: the timer was off. */
const MAX_GAP_MS = 5 * 60_000;
const KEEP_DAYS = 30;

const DIR = join(stateDir(), 'dev-usage');
const LAST = join(DIR, 'dev-usage-last.json');
const uid = process.getuid?.() ?? 1000;
const USER = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service`;
const HOME = homedir();

const read = (f) => readFileSync(f, 'utf8');
const tryRead = (f) => {
	try {
		return read(f);
	} catch {
		return null;
	}
};
const lsDirs = (d) =>
	readdirSync(d, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);

/** usage_usec, rbytes+wbytes, memory.current and memory.swap.current of one cgroup. */
function counters(cg) {
	const usage = Number(/^usage_usec (\d+)/m.exec(tryRead(join(cg, 'cpu.stat')) ?? '')?.[1] ?? NaN);
	let io = 0;
	for (const m of (tryRead(join(cg, 'io.stat')) ?? '').matchAll(/\b[rw]bytes=(\d+)/g))
		io += Number(m[1]);
	return {
		usageUsec: usage,
		ioBytes: io,
		memBytes: Number(tryRead(join(cg, 'memory.current')) ?? 0),
		swapBytes: Number(tryRead(join(cg, 'memory.swap.current')) ?? 0),
	};
}

function pidsOf(cg) {
	return (tryRead(join(cg, 'cgroup.procs')) ?? '').split('\n').filter(Boolean);
}

function cwdOf(pid) {
	try {
		return readlinkSync(`/proc/${pid}/cwd`);
	} catch {
		return null;
	}
}

function knownRepos() {
	const names = new Set();
	for (const d of [join(HOME, 'repos'), join(HOME, 'srv')]) {
		try {
			for (const n of lsDirs(d)) names.add(n);
		} catch {
			// a missing ~/srv only narrows scratchpad attribution to (other)
		}
	}
	return names;
}

function snapshot() {
	const app = join(USER, 'app.slice');
	let children;
	try {
		children = lsDirs(app);
	} catch (err) {
		throw new Error(`cannot list ${app}: ${err.message}`);
	}
	const ctx = { home: HOME, repos: knownRepos() };
	const groups = [];
	for (const name of children) {
		const cg = join(app, name);
		const pids = pidsOf(cg);
		const claudePid = pids.find((p) => tryRead(`/proc/${p}/comm`)?.trim() === 'claude');
		if (!name.startsWith('tmux-spawn-') && !claudePid) continue;
		const c = counters(cg);
		if (!Number.isFinite(c.usageUsec)) continue;
		const where = cwdOf(claudePid ?? pids[0]);
		groups.push({
			id: name,
			kind: 'dev',
			repo: repoOfPath(where, ctx),
			claude: Boolean(claudePid),
			...c,
		});
	}
	const ciDir = join(USER, 'ci.slice', 'ci-runner.slice');
	let ciUnits = [];
	try {
		ciUnits = lsDirs(ciDir);
	} catch {
		// ci-runner.slice exists only while a runner is up; no slice is no CI here
	}
	const node = hostname().split('.')[0];
	for (const name of ciUnits) {
		const repo = repoOfCiUnit(name, node);
		if (!repo) continue;
		const c = counters(join(ciDir, name));
		if (Number.isFinite(c.usageUsec)) groups.push({ id: name, kind: 'ci', repo, ...c });
	}
	return { t: Date.now(), groups };
}

function box() {
	const some = (r) =>
		Number(/some avg10=([\d.]+)/.exec(tryRead(`/proc/pressure/${r}`) ?? '')?.[1] ?? NaN);
	const avail = Number(/MemAvailable:\s+(\d+)/.exec(tryRead('/proc/meminfo') ?? '')?.[1] ?? NaN);
	return {
		load1: Number((tryRead('/proc/loadavg') ?? '').split(' ')[0]),
		cpuSome10: some('cpu'),
		ioSome10: some('io'),
		memSome10: some('memory'),
		memAvailMb: Math.round(avail / 1024),
	};
}

/** One ledger file per UTC day; the capture group is the day. */
const DAY_FILE = /^dev-usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const dayOf = (f) => DAY_FILE.exec(f)?.[1] ?? null;
const dayFile = (ms) => join(DIR, `dev-usage-${new Date(ms).toISOString().slice(0, 10)}.jsonl`);

function sample() {
	mkdirSync(DIR, { recursive: true });
	const cur = snapshot();
	let prev = null;
	const raw = tryRead(LAST);
	if (raw) {
		try {
			prev = JSON.parse(raw);
		} catch (err) {
			out.warn(`fleet dev-usage: ${LAST} unreadable (${err.message}); reseeding`);
		}
	}
	writeJsonAtomicSync(LAST, cur);
	const row = prev && cur.t - prev.t <= MAX_GAP_MS ? usageRow(prev, cur) : null;
	if (row) appendFileSync(dayFile(cur.t), `${JSON.stringify({ ...row, box: box() })}\n`);
	const cutoff = new Date(cur.t - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
	for (const f of readdirSync(DIR)) {
		const day = dayOf(f);
		if (day && day < cutoff) rmSync(join(DIR, f));
	}
	const dev = cur.groups.filter((g) => g.kind === 'dev');
	out.log(
		`dev-usage: ${dev.length} dev cgroup(s) (${dev.filter((g) => g.claude).length} with claude), ` +
			`${cur.groups.length - dev.length} CI unit(s); ${row ? 'row written' : 'seeded counters, no row'}`
	);
	if (out.json) out.emit({ ok: true, wrote: Boolean(row), groups: cur.groups.length });
}

function report() {
	const hoursAt = argv.indexOf('--hours');
	const hours = hoursAt > -1 ? Number(argv[hoursAt + 1]) : 24;
	if (!(hours > 0)) {
		out.warn('fleet dev-usage: --hours takes a number above 0');
		process.exit(2);
	}
	const since = Date.now() - hours * 3_600_000;
	const rows = [];
	let bad = 0;
	let files = [];
	try {
		files = readdirSync(DIR).filter((f) => dayOf(f));
	} catch {
		// no directory: the recorder never ran; reported below as no rows
	}
	for (const f of files.sort()) {
		if (dayOf(f) < new Date(since).toISOString().slice(0, 10)) continue;
		for (const line of read(join(DIR, f)).split('\n')) {
			if (!line) continue;
			try {
				const r = JSON.parse(line);
				if (Date.parse(r.t) >= since) rows.push(r);
			} catch {
				bad += 1;
			}
		}
	}
	const s = summarizeDevUsage(rows);
	const ok = s.samples > 0;
	const n = (v, w = 6) => String(v ?? '-').padStart(w);
	out.log(
		`dev sessions, ${s.samples} sample(s) ${s.from ?? ''} .. ${s.to ?? ''}; proposed ceiling ` +
			`${PROPOSED.devCores} cores / ${Math.round(PROPOSED.devMemoryHighMb / 1024)} GiB`
	);
	out.log(
		`  all dev: cores p50 ${s.dev.coresP50}  p95 ${s.dev.coresP95}  max ${s.dev.coresMax}; ` +
			`mem p95 ${s.dev.memMbP95 ?? '-'} MiB  max ${s.dev.memMbMax ?? '-'} MiB`
	);
	out.log(
		`  would clip: CPU ${s.dev.cpuOverMinutes} min (${s.dev.clippedCoreHours} core-h deferred), ` +
			`memory ${s.dev.memOverMinutes} min over MemoryHigh` +
			(s.dev.clippedBy.length
				? `; by ${s.dev.clippedBy.map((c) => `${c.repo} ${c.coreHours}`).join(', ')}`
				: '')
	);
	for (const [label, repos] of [
		['DEV', s.dev.repos],
		['CI', s.ci.repos],
	]) {
		out.log('');
		out.log(
			`${label.padEnd(24)} ${n('core-h', 7)} ${n('share')} ${n('p50')} ${n('p95')} ${n('max')} ${n('memP95', 7)} ${n('memMax', 7)} ${n('swpMax', 7)} ${n('peak', 5)}`
		);
		for (const r of repos)
			out.log(
				`${r.repo.padEnd(24)} ${n(r.coreHours, 7)} ${n(r.share)} ${n(r.coresP50)} ${n(r.coresP95)} ${n(r.coresMax)} ` +
					`${n(r.memMbP95, 7)} ${n(r.memMbMax, 7)} ${n(r.swapMbMax, 7)} ${n(r.peakGroups, 5)}`
			);
		if (!repos.length) out.log('  none in the window');
	}
	if (!ok)
		out.warn(`fleet dev-usage: no samples in the last ${hours} h; is dev-usage.timer running?`);
	if (bad) out.warn(`fleet dev-usage: ${bad} unreadable line(s) skipped`);
	if (out.json)
		out.emit({
			ok,
			hours,
			badLines: bad,
			...(ok ? {} : { reason: `no samples in the last ${hours} h` }),
			...s,
		});
	process.exit(ok ? 0 : 1);
}

if (argv.includes('--sample')) {
	try {
		sample();
	} catch (err) {
		out.warn(`fleet dev-usage --sample: ${err.message}`);
		if (out.json) out.emit({ ok: false, reason: err.message });
		process.exit(1);
	}
} else {
	report();
}
