/**
 * The traffic simulator's fleet: each node as the dispatcher saw it over the
 * corpus window, built from OBSERVED data rather than today's manifest.
 *
 * PURE. The caller parses job history, the dispatch log's capacity rows and
 * the manifest; this assembles them.
 *
 * - LABELS are the labels of the jobs a node actually served. Live dispatch
 *   derives them from today's manifest and proofs (`offerFor`), which is right
 *   for now and wrong for 10-28: capabilities were earned and revoked during
 *   the window. A backstop (hokon) offers `hadoku-builder` only while the
 *   engine has it promoted, so that label is held back from its base set.
 * - CAPACITY over time is a timeline replayed from the dispatch log's
 *   `capacity` rows: the whole ceiling (`max + warmHeld`), the warm slots and
 *   the repo they listened for, health, drain, schedulability, the memory
 *   floor and the per-job reserve. Warm slots are REPLAYED as recorded, not
 *   decided: JIT gets the ceiling minus them, and a job of the warm repo takes
 *   one the moment it arrives. Without them the first cut gave JIT every slot
 *   and read general CI's q95 at 83 s against 202 s recorded. claw-1 and claw-3 lost slots on
 *   11-09 and the timeline carries that; a fixed manifest would not.
 * - MEMORY: `idleFreeMb` is the node's median free memory while it ran
 *   nothing, and `mbPerJob` what one running job really took there: the
 *   drop in free memory per busy slot, from every capacity row with work on
 *   the node. NOT the repo's reserve. A reserve is a peak, and live `freeMb`
 *   is measured, so subtracting reserves double-counts: the first cut did,
 *   and three site jobs (6,336 MB lower-bound reserve) "used" 19 GB, which
 *   refused general jobs on memory fleet-wide and doubled the simulated q95
 *   against history. Measured 2026-11-11, a running job takes 0.4-2.3 GB at
 *   the median by node; a light job is charged the median, a heavy one p75.
 * - EXCLUSIONS come from the manifest (`excludeRepos`), the only source.
 */
import { BUILDER_LABEL } from '../lib/capability-registry-ids.js';
import { isBackstopNode } from '../lib/node-role.js';
import type { SimJob } from './sim-corpus.js';

export interface CapacityPoint {
	atMs: number;
	/** The node's whole ceiling: JIT slots plus warm slots. */
	maxConcurrent: number;
	/** Slots a warm listener held, and the repo it listened for. JIT gets the rest. */
	warmHeld: number;
	warmRepo: string | null;
	healthy: boolean;
	drained: boolean;
	schedulable: boolean;
	minFreeMb: number;
	requiredMb: number;
	/**
	 * Free memory with no CI on the node: the recorded `freeMb` plus what the
	 * recorded jobs there took (`busy x mbPerJob.light`), rounded to
	 * {@link BASE_FREE_STEP_MB}. Hosting tenants and tmpfs move it over the
	 * window; the engine subtracts only its own simulated jobs from it.
	 */
	baseFreeMb: number;
}

/** Rounding of {@link CapacityPoint.baseFreeMb}, so the timeline is not one point per row. */
export const BASE_FREE_STEP_MB = 256;

export interface SimNodeSpec {
	name: string;
	/** Labels it offers. For a backstop, WITHOUT the label promotion grants. */
	labels: readonly string[];
	backstop: boolean;
	excludeRepos: ReadonlyMap<string, string>;
	/** The manifest's `heavyThirdHoldSec`, carried as the live dispatcher reads it. */
	heavyThirdHoldSec?: number;
	idleFreeMb: number;
	/** Observed MB one running job takes here: `light` (median) and `heavy` (p75). */
	mbPerJob: { light: number; heavy: number };
	/** Sorted by time; the point in force at `t` is the last one at or before it. */
	timeline: readonly CapacityPoint[];
}

/** A node the dispatch log never saw busy: the fleet-wide medians, 2026-11-11. */
export const DEFAULT_MB_PER_JOB = { light: 1200, heavy: 2600 };

/** The label a backstop gains while promoted. */
export const PROMOTION_LABEL = BUILDER_LABEL;

/** One `capacity` entry of a dispatch-decision row, as the log writes it. */
export interface CapacityRow {
	node: string;
	busy: number;
	max: number;
	warmHeld?: number;
	warmRepo?: string | null;
	warmBusy?: number;
	freeMb: number;
	requiredMb: number;
	minFreeMb: number;
	healthy: boolean;
	drained: boolean;
	schedulable?: boolean;
}

export interface ManifestMachine {
	maxConcurrent?: number;
	minFreeMb?: number;
	role?: string;
	excludeRepos?: Record<string, string>;
	heavyThirdHoldSec?: number;
	$measured?: { memTotalMb?: number };
}

const median = (xs: number[]): number | null => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};

export function buildFleet(args: {
	jobs: readonly SimJob[];
	capacity: readonly { atMs: number; rows: readonly CapacityRow[] }[];
	machines: Readonly<Record<string, ManifestMachine>>;
}): SimNodeSpec[] {
	const { jobs, capacity, machines } = args;
	const labels = new Map<string, Set<string>>();
	for (const j of jobs) {
		const set = labels.get(j.histNode) ?? new Set<string>();
		for (const l of j.labels) set.add(l);
		labels.set(j.histNode, set);
	}

	const snaps = [...capacity].sort((x, y) => x.atMs - y.atMs);
	const idleFree = new Map<string, number[]>();
	const busyRows: { node: string; busy: number; freeMb: number }[] = [];
	for (const snap of snaps) {
		for (const c of snap.rows) {
			const busy = c.busy + (c.warmBusy ?? 0);
			if (busy === 0) {
				const f = idleFree.get(c.node) ?? [];
				f.push(c.freeMb);
				idleFree.set(c.node, f);
			} else busyRows.push({ node: c.node, busy, freeMb: c.freeMb });
		}
	}
	const idleMedian = new Map([...idleFree].map(([n, xs]) => [n, median(xs)!]));
	const perJob = new Map<string, number[]>();
	for (const r of busyRows) {
		const idle = idleMedian.get(r.node);
		if (idle === undefined) continue;
		const list = perJob.get(r.node) ?? [];
		list.push(Math.max(0, (idle - r.freeMb) / r.busy));
		perJob.set(r.node, list);
	}
	const quantile = (xs: number[], q: number): number => {
		const sorted = [...xs].sort((x, y) => x - y);
		return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
	};
	const mbPerJob = new Map(
		[...perJob].map(([n, xs]) => [
			n,
			{ light: Math.round(quantile(xs, 0.5)), heavy: Math.round(quantile(xs, 0.75)) },
		])
	);
	const lightOf = (n: string): number => mbPerJob.get(n)?.light ?? DEFAULT_MB_PER_JOB.light;

	const points = new Map<string, CapacityPoint[]>();
	for (const snap of snaps) {
		for (const c of snap.rows) {
			const busy = c.busy + (c.warmBusy ?? 0);
			const p: CapacityPoint = {
				atMs: snap.atMs,
				maxConcurrent: c.max + (c.warmHeld ?? 0),
				warmHeld: c.warmHeld ?? 0,
				warmRepo: c.warmRepo ?? null,
				healthy: c.healthy,
				drained: c.drained,
				schedulable: c.schedulable !== false,
				minFreeMb: c.minFreeMb,
				requiredMb: c.requiredMb,
				baseFreeMb:
					Math.round((c.freeMb + busy * lightOf(c.node)) / BASE_FREE_STEP_MB) * BASE_FREE_STEP_MB,
			};
			const list = points.get(c.node) ?? [];
			const last = list.at(-1);
			const same =
				last &&
				last.maxConcurrent === p.maxConcurrent &&
				last.warmHeld === p.warmHeld &&
				last.warmRepo === p.warmRepo &&
				last.healthy === p.healthy &&
				last.drained === p.drained &&
				last.schedulable === p.schedulable &&
				last.minFreeMb === p.minFreeMb &&
				last.requiredMb === p.requiredMb &&
				last.baseFreeMb === p.baseFreeMb;
			if (!same) list.push(p);
			points.set(c.node, list);
		}
	}

	const names = new Set([...labels.keys(), ...points.keys()]);
	const out: SimNodeSpec[] = [];
	for (const name of [...names].sort()) {
		const m = machines[name] ?? {};
		const backstop = isBackstopNode(m);
		const memTotal = m.$measured?.memTotalMb;
		const offered = [...(labels.get(name) ?? [])].filter(
			(l) => !(backstop && l === PROMOTION_LABEL)
		);
		let timeline = points.get(name) ?? [];
		if (!timeline.length) {
			// Never in the dispatch log: the manifest's figures, in force throughout.
			timeline = [
				{
					atMs: 0,
					maxConcurrent: m.maxConcurrent ?? 1,
					warmHeld: 0,
					warmRepo: null,
					healthy: true,
					drained: false,
					schedulable: true,
					minFreeMb: m.minFreeMb ?? 1536,
					requiredMb: 3400,
					baseFreeMb: memTotal ? Math.round(memTotal * 0.8) : 8000,
				},
			];
		}
		out.push({
			name,
			labels: offered.sort(),
			backstop,
			excludeRepos: new Map(Object.entries(m.excludeRepos ?? {})),
			heavyThirdHoldSec: m.heavyThirdHoldSec,
			idleFreeMb: idleMedian.get(name) ?? (memTotal ? Math.round(memTotal * 0.8) : 8000),
			mbPerJob: mbPerJob.get(name) ?? { ...DEFAULT_MB_PER_JOB },
			timeline,
		});
	}
	return out;
}

/** The capacity point in force at `atMs`: the last at or before it, else the first. */
export function capacityAt(spec: SimNodeSpec, atMs: number): CapacityPoint {
	const t = spec.timeline;
	let lo = 0;
	let hi = t.length - 1;
	if (atMs < t[0].atMs) return t[0];
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (t[mid].atMs <= atMs) lo = mid;
		else hi = mid - 1;
	}
	return t[lo];
}
