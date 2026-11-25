/**
 * Per-repo resource use on hokon, for the dev-slices shadow week. PURE.
 *
 * Agent sessions on hokon each run in a tmux pane's own transient
 * `tmux-spawn-<uuid>.scope` under app.slice, with CPUWeight=20 EACH
 * (deploy/systemd/user-priority). Weight per pane means the more sessions are
 * open, the larger their combined share: 52 panes at 20 outweigh Firefox ten to
 * one. The plan (docs/tools/slice.md, "Dev slices") is one dev slice with a
 * total ceiling and one child per repo. Before any cap is set, this records
 * what each repo actually used and what the proposed ceilings WOULD have
 * clipped. CI jobs on hokon are attributed per repo the same way, from their
 * unit names, so one report covers both halves.
 *
 * Nothing here moves a process or sets a limit.
 */

/** The ceilings under trial. Shadow only: reported against, never applied. */
export const PROPOSED = Object.freeze({
	/** Every dev session together, in cores (CPUQuota=800%). */
	devCores: 8,
	/** Every dev session together: MemoryHigh, in MiB. */
	devMemoryHighMb: 24 * 1024,
});

/** The bucket for a pane whose working directory names no known repo. */
export const OTHER = '(other)';

/**
 * The repo a working directory belongs to. `~/repos/<r>/…` and `~/srv/<r>/…`
 * name it directly, worktrees included (they sit inside the repo). A session
 * scratchpad, `/tmp/claude-<uid>/-home-hadoku-repos-<r>…/`, encodes the path
 * with `/` and `.` as `-`, so the repo is the longest known name the encoded
 * rest starts with; a dash inside a repo name makes a plain split ambiguous.
 *
 * @param {string | null | undefined} path
 * @param {{ home: string, repos: Iterable<string> }} ctx
 * @returns {string}
 */
export function repoOfPath(path, { home, repos }) {
	if (!path) return OTHER;
	const p = path.replace(/ \(deleted\)$/, '');
	for (const root of [`${home}/repos/`, `${home}/srv/`]) {
		if (p.startsWith(root)) {
			const name = p.slice(root.length).split('/')[0];
			return name || OTHER;
		}
	}
	const enc = /^\/tmp\/claude-\d+\/([^/]+)/.exec(p)?.[1];
	if (enc) {
		const encHome = home.replace(/[/.]/g, '-');
		for (const root of [`${encHome}-repos-`, `${encHome}-srv-`]) {
			if (!enc.startsWith(root)) continue;
			const rest = enc.slice(root.length);
			let best = '';
			for (const r of repos) {
				const e = r.replace(/[/.]/g, '-');
				if ((rest === e || rest.startsWith(`${e}-`)) && e.length > best.length) best = r;
			}
			return best || OTHER;
		}
	}
	return OTHER;
}

/**
 * The repo a CI unit on this node serves, from its name: a JIT mint
 * `jit-<node>-<repo>-j<digits>…` or a standing `actions-runner-<repo>.service`.
 * null for anything else in the CI slice.
 *
 * @param {string} unit
 * @param {string} node
 * @returns {string | null}
 */
export function repoOfCiUnit(unit, node) {
	const jit = new RegExp(`^jit-${node.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(.+)-j\\d+`).exec(
		unit
	);
	if (jit) return jit[1];
	const standing = /^actions-runner-(.+)\.service$/.exec(unit);
	return standing ? standing[1] : null;
}

/**
 * @typedef {object} Group  one cgroup at one instant
 * @property {string} id         the cgroup's name; deltas pair groups by it
 * @property {'dev' | 'ci'} kind
 * @property {string} repo
 * @property {boolean} [claude]  a Claude process is in it
 * @property {number} usageUsec  cpu.stat usage_usec
 * @property {number} ioBytes    io.stat rbytes + wbytes, every device
 * @property {number} memBytes   memory.current
 * @property {number} swapBytes  memory.swap.current
 *
 * @typedef {object} Snapshot
 * @property {number} t  epoch ms
 * @property {Group[]} groups
 *
 * @typedef {object} RepoUse
 * @property {number} cores   mean cores over the interval
 * @property {number} memMb
 * @property {number} swapMb
 * @property {number} ioMBps
 * @property {number} groups  cgroups counted (panes, or CI units)
 * @property {number} claudes
 */

const MB = 1024 * 1024;
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * One ledger row: what each repo used between two snapshots. A group must be in
 * both, with counters that did not go backwards, to count its CPU and I/O; a
 * group born inside the interval would otherwise bill its whole lifetime to it.
 * Memory is a level, so it is read from the later snapshot for every group.
 *
 * @param {Snapshot} prev
 * @param {Snapshot} cur
 * @returns {{ t: string, intervalS: number, dev: Record<string, RepoUse>, ci: Record<string, RepoUse> } | null}
 *   null when the interval is not positive (a clock step, or the same snapshot twice).
 */
export function usageRow(prev, cur) {
	const intervalS = (cur.t - prev.t) / 1000;
	if (!(intervalS > 0)) return null;
	const before = new Map(prev.groups.map((g) => [`${g.kind}:${g.id}`, g]));
	/** @type {{ dev: Record<string, RepoUse>, ci: Record<string, RepoUse> }} */
	const out = { dev: {}, ci: {} };
	for (const g of cur.groups) {
		const acc = (out[g.kind][g.repo] ??= {
			cores: 0,
			memMb: 0,
			swapMb: 0,
			ioMBps: 0,
			groups: 0,
			claudes: 0,
		});
		acc.groups += 1;
		if (g.claude) acc.claudes += 1;
		acc.memMb += g.memBytes / MB;
		acc.swapMb += g.swapBytes / MB;
		const p = before.get(`${g.kind}:${g.id}`);
		if (p && g.usageUsec >= p.usageUsec && g.ioBytes >= p.ioBytes) {
			acc.cores += (g.usageUsec - p.usageUsec) / 1e6 / intervalS;
			acc.ioMBps += (g.ioBytes - p.ioBytes) / MB / intervalS;
		}
	}
	for (const side of [out.dev, out.ci]) {
		for (const u of Object.values(side)) {
			u.cores = r2(u.cores);
			u.memMb = Math.round(u.memMb);
			u.swapMb = Math.round(u.swapMb);
			u.ioMBps = r2(u.ioMBps);
		}
	}
	return { t: new Date(cur.t).toISOString(), intervalS: r2(intervalS), ...out };
}

/** Nearest-rank percentile of an ascending-sorted list; null when empty. */
function pct(sorted, p) {
	if (sorted.length === 0) return null;
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * @param {Array<Record<string, RepoUse>>} sides  one side's map per row, with the row's interval
 * @param {number[]} intervals
 */
function perRepo(sides, intervals) {
	/** @type {Map<string, { cores: number[], mem: number[], swap: number[], coreSeconds: number, peakGroups: number }>} */
	const by = new Map();
	let total = 0;
	sides.forEach((side, k) => {
		for (const [repo, u] of Object.entries(side)) {
			const e = by.get(repo) ?? { cores: [], mem: [], swap: [], coreSeconds: 0, peakGroups: 0 };
			e.cores.push(u.cores);
			e.mem.push(u.memMb);
			e.swap.push(u.swapMb);
			e.coreSeconds += u.cores * intervals[k];
			e.peakGroups = Math.max(e.peakGroups, u.groups);
			total += u.cores * intervals[k];
			by.set(repo, e);
		}
	});
	return [...by.entries()]
		.map(([repo, e]) => {
			const c = [...e.cores].sort((a, b) => a - b);
			const m = [...e.mem].sort((a, b) => a - b);
			return {
				repo,
				samples: c.length,
				coreHours: r2(e.coreSeconds / 3600),
				share: total > 0 ? r2(e.coreSeconds / total) : 0,
				coresP50: pct(c, 50),
				coresP95: pct(c, 95),
				coresMax: c[c.length - 1],
				memMbP95: pct(m, 95),
				memMbMax: m[m.length - 1],
				swapMbMax: Math.max(...e.swap),
				peakGroups: e.peakGroups,
			};
		})
		.sort((a, b) => b.coreHours - a.coreHours);
}

/**
 * The shadow verdict over a window of ledger rows: per-repo use on each side,
 * and, for the dev side as a whole, how often the proposed ceilings would have
 * bitten and which repos were running when they did.
 *
 * @param {Array<ReturnType<typeof usageRow>>} rows
 * @param {typeof PROPOSED} [proposed]
 */
export function summarizeDevUsage(rows, proposed = PROPOSED) {
	const good = rows.filter((r) => r != null);
	const intervals = good.map((r) => r.intervalS);
	const devTotals = good.map((r) => {
		const us = Object.values(r.dev);
		return {
			cores: us.reduce((s, u) => s + u.cores, 0),
			memMb: us.reduce((s, u) => s + u.memMb, 0),
		};
	});
	/** @type {Map<string, number>} core-seconds above the cap, split by each repo's share of that row */
	const clippedBy = new Map();
	let cpuOverS = 0;
	let memOverS = 0;
	let clippedCoreSeconds = 0;
	good.forEach((r, k) => {
		const { cores, memMb } = devTotals[k];
		if (memMb > proposed.devMemoryHighMb) memOverS += r.intervalS;
		if (cores <= proposed.devCores) return;
		cpuOverS += r.intervalS;
		const excess = (cores - proposed.devCores) * r.intervalS;
		clippedCoreSeconds += excess;
		for (const [repo, u] of Object.entries(r.dev)) {
			clippedBy.set(repo, (clippedBy.get(repo) ?? 0) + (excess * u.cores) / cores);
		}
	});
	const cores = devTotals.map((d) => d.cores).sort((a, b) => a - b);
	const mem = devTotals.map((d) => d.memMb).sort((a, b) => a - b);
	return {
		samples: good.length,
		from: good[0]?.t ?? null,
		to: good[good.length - 1]?.t ?? null,
		proposed,
		dev: {
			coresP50: r2(pct(cores, 50) ?? 0),
			coresP95: r2(pct(cores, 95) ?? 0),
			coresMax: r2(cores[cores.length - 1] ?? 0),
			memMbP95: pct(mem, 95),
			memMbMax: mem[mem.length - 1] ?? null,
			/** Minutes the whole dev side ran above the proposed CPU ceiling. */
			cpuOverMinutes: r2(cpuOverS / 60),
			/** Core-hours the ceiling would have deferred: work slowed, not lost. */
			clippedCoreHours: r2(clippedCoreSeconds / 3600),
			memOverMinutes: r2(memOverS / 60),
			clippedBy: [...clippedBy.entries()]
				.map(([repo, s]) => ({ repo, coreHours: r2(s / 3600) }))
				.filter((e) => e.coreHours > 0)
				.sort((a, b) => b.coreHours - a.coreHours),
			repos: perRepo(
				good.map((r) => r.dev),
				intervals
			),
		},
		ci: {
			repos: perRepo(
				good.map((r) => r.ci),
				intervals
			),
		},
	};
}
