/**
 * The traffic simulator's three objectives, measured the SAME way for a
 * simulated run and for what really happened (operator, 2026-11-11):
 *
 *   1. the OLDEST job in the queue, at every tick: its peak, its p95 and its
 *      time-weighted mean, overall and per label class;
 *   2. real work over orchestration: the job's own run phase as a share of
 *      every second its slot was held (GitHub's pickup after the mint, setup,
 *      run, cleanup);
 *   3. available capacity: free claw slots over time, overall and for each
 *      label class, and the share of ticks a class had a slot free for the
 *      next arrival.
 *
 * `historicalOutcomes` turns the corpus into outcomes as they happened, so
 * `measure` over it is the baseline a simulation is validated against: one
 * function, one tick grid, for both.
 *
 * Capacity counts CLAWS only. A backstop is not general capacity: it carries
 * the builder label only while promoted, and counting its slots would report
 * room the fleet does not offer.
 *
 * PURE.
 */
import { isLaneLabel } from '../lib/capability-labels.js';
import { satisfiesLabels } from './placement-node-state.js';
import type { Corpus, SimJob } from './sim-corpus.js';
import { capacityAt, type SimNodeSpec } from './sim-fleet.js';

export interface JobOutcome {
	key: number;
	arrivalMs: number;
	placedMs: number | null;
	/** When GitHub reports the job started: placed + pickup. */
	startMs: number | null;
	endMs: number | null;
	node: string | null;
	/** Seconds the job's slot was held, mint to end of cleanup. */
	slotSec: number;
	/** Of those, the job's own run phase. */
	runSec: number;
	pickupSec: number;
	setupSec: number;
	cleanupSec: number;
}

export interface Percentiles {
	n: number;
	p50: number | null;
	p95: number | null;
	p99: number | null;
	max: number | null;
}

export interface OldestReport {
	peakSec: number;
	p95Sec: number;
	meanSec: number;
}

export interface ClassReport {
	jobs: number;
	queueSec: Percentiles;
	oldest: OldestReport;
	/** Free claw slots whose labels serve this class. Null when no claw does. */
	freeSlots: { mean: number; shareOfTicksWithFree: number } | null;
}

export interface SimMetricsReport {
	window: { fromMs: number; toMs: number; ticks: number };
	jobs: { measured: number; unserved: number };
	queueSec: Percentiles;
	oldest: OldestReport;
	efficiency: {
		runSec: number;
		slotSec: number;
		/** runSec / slotSec: the share of held slot time spent on the job's own work. */
		ratio: number | null;
		pickupSec: number;
		setupSec: number;
		cleanupSec: number;
	};
	capacity: { meanSlots: number; meanBusy: number; meanFree: number; utilization: number | null };
	classes: Record<string, ClassReport>;
	days: {
		day: string;
		jobs: number;
		queueP50: number | null;
		queueP95: number | null;
		oldestPeakSec: number;
	}[];
}

/** A job's capability class: its labels beyond `self-hosted` and lanes, sorted. */
export function labelClassOf(labels: readonly string[]): string {
	const extra = labels
		.filter((l) => l.toLowerCase() !== 'self-hosted' && !isLaneLabel(l))
		.map((l) => l.toLowerCase())
		.sort();
	return extra.length ? extra.join('+') : 'any';
}

export function percentiles(xs: readonly number[]): Percentiles {
	if (!xs.length) return { n: 0, p50: null, p95: null, p99: null, max: null };
	const s = [...xs].sort((a, b) => a - b);
	const at = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))];
	return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] };
}

/** What really happened, as outcomes `measure` reads exactly like a simulation's. */
export function historicalOutcomes(
	corpus: Corpus,
	fromMs = -Infinity,
	toMs = Infinity
): JobOutcome[] {
	return corpus.jobs
		.filter((j) => j.arrivalMs >= fromMs && j.arrivalMs < toMs)
		.map((j) => {
			const pickup = j.assignSec ?? 0;
			return {
				key: j.key,
				arrivalMs: j.arrivalMs,
				placedMs: j.histStartMs - pickup * 1000,
				startMs: j.histStartMs,
				endMs: j.histStartMs + j.workSec * 1000,
				node: j.histNode,
				slotSec: pickup + j.workSec,
				runSec: j.runSec,
				pickupSec: pickup,
				setupSec: j.setupSec,
				cleanupSec: j.cleanupSec,
			};
		});
}

/** A min-heap of queue intervals by arrival; started ones are dropped lazily. */
class OldestHeap {
	private h: { arrival: number; start: number }[] = [];
	push(arrival: number, start: number): void {
		const h = this.h;
		h.push({ arrival, start });
		let i = h.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (h[p].arrival <= h[i].arrival) break;
			[h[p], h[i]] = [h[i], h[p]];
			i = p;
		}
	}
	/** Age in seconds of the oldest job still waiting at `t`, or 0. */
	oldestAt(t: number): number {
		const h = this.h;
		while (h.length && h[0].start <= t) {
			const last = h.pop()!;
			if (h.length) {
				h[0] = last;
				let i = 0;
				for (;;) {
					const l = 2 * i + 1;
					const r = l + 1;
					let m = i;
					if (l < h.length && h[l].arrival < h[m].arrival) m = l;
					if (r < h.length && h[r].arrival < h[m].arrival) m = r;
					if (m === i) break;
					[h[m], h[i]] = [h[i], h[m]];
					i = m;
				}
			}
		}
		return h.length ? (t - h[0].arrival) / 1000 : 0;
	}
}

const oldestOf = (series: number[]): OldestReport => {
	const p = percentiles(series);
	const total = series.reduce((a, b) => a + b, 0);
	return {
		peakSec: p.max ?? 0,
		p95Sec: p.p95 ?? 0,
		meanSec: series.length ? total / series.length : 0,
	};
};

export function measure(
	outcomes: readonly JobOutcome[],
	jobs: ReadonlyMap<number, SimJob>,
	fleet: readonly SimNodeSpec[],
	opts: { tickSec?: number; fromMs?: number; toMs?: number } = {}
): SimMetricsReport {
	const tickSec = opts.tickSec ?? 15;
	const tickMs = tickSec * 1000;
	const arrivals = outcomes.map((o) => o.arrivalMs);
	const fromMs = Math.floor((opts.fromMs ?? Math.min(...arrivals)) / tickMs) * tickMs;
	const toMs = opts.toMs ?? Math.max(...arrivals);

	const claws = fleet.filter((s) => !s.backstop);
	const classLabels = new Map<string, readonly string[]>();
	const byClass = new Map<string, JobOutcome[]>();
	for (const o of outcomes) {
		const j = jobs.get(o.key)!;
		const c = labelClassOf(j.labels);
		if (!classLabels.has(c)) classLabels.set(c, j.labels);
		const list = byClass.get(c) ?? [];
		list.push(o);
		byClass.set(c, list);
	}
	const servers = new Map(
		[...classLabels].map(([c, labels]) => [
			c,
			claws.filter((s) => satisfiesLabels(s.labels, labels)).map((s) => s.name),
		])
	);

	// Queue intervals, sorted by arrival, fed to heaps as the grid passes them.
	const sorted = [...outcomes].sort((a, b) => a.arrivalMs - b.arrivalMs);
	const heap = new OldestHeap();
	const classHeap = new Map([...byClass.keys()].map((c) => [c, new OldestHeap()]));
	const oldest: number[] = [];
	const classOldest = new Map([...byClass.keys()].map((c) => [c, [] as number[]]));
	const dayPeak = new Map<string, number>();

	// Busy slots per claw: placed at or before t, not yet ended.
	const starts = new Map(claws.map((s) => [s.name, [] as number[]]));
	const ends = new Map(claws.map((s) => [s.name, [] as number[]]));
	for (const o of outcomes) {
		if (o.node === null || o.placedMs === null || !starts.has(o.node)) continue;
		starts.get(o.node)!.push(o.placedMs);
		ends.get(o.node)!.push(o.endMs ?? Infinity);
	}
	for (const s of claws) {
		starts.get(s.name)!.sort((a, b) => a - b);
		ends.get(s.name)!.sort((a, b) => a - b);
	}
	const sp = new Map(claws.map((s) => [s.name, 0]));
	const ep = new Map(claws.map((s) => [s.name, 0]));
	const classFree = new Map([...byClass.keys()].map((c) => [c, { sum: 0, withFree: 0 }]));
	let slotsSum = 0;
	let busySum = 0;
	let freeSum = 0;
	let ticks = 0;
	let at = 0;

	for (let t = fromMs; t <= toMs; t += tickMs) {
		ticks++;
		while (at < sorted.length && sorted[at].arrivalMs <= t) {
			const o = sorted[at++];
			const start = o.startMs ?? Infinity;
			heap.push(o.arrivalMs, start);
			classHeap.get(labelClassOf(jobs.get(o.key)!.labels))!.push(o.arrivalMs, start);
		}
		const age = heap.oldestAt(t);
		oldest.push(age);
		const day = new Date(t).toISOString().slice(0, 10);
		dayPeak.set(day, Math.max(dayPeak.get(day) ?? 0, age));
		for (const [c, h] of classHeap) classOldest.get(c)!.push(h.oldestAt(t));

		const freeBy = new Map<string, number>();
		for (const s of claws) {
			const st = starts.get(s.name)!;
			const en = ends.get(s.name)!;
			let i = sp.get(s.name)!;
			while (i < st.length && st[i] <= t) i++;
			sp.set(s.name, i);
			let k = ep.get(s.name)!;
			while (k < en.length && en[k] <= t) k++;
			ep.set(s.name, k);
			const busy = i - k;
			const cap = capacityAt(s, t);
			const slots = cap.healthy && !cap.drained && cap.schedulable ? cap.maxConcurrent : 0;
			const free = Math.max(0, slots - busy);
			slotsSum += slots;
			busySum += busy;
			freeSum += free;
			freeBy.set(s.name, free);
		}
		for (const [c, names] of servers) {
			const f = names.reduce((sum, n) => sum + (freeBy.get(n) ?? 0), 0);
			const acc = classFree.get(c)!;
			acc.sum += f;
			if (f > 0) acc.withFree++;
		}
	}

	const queueOf = (list: readonly JobOutcome[]): number[] =>
		list.flatMap((o) => (o.startMs === null ? [] : [(o.startMs - o.arrivalMs) / 1000]));
	const done = outcomes.filter((o) => o.endMs !== null);
	const sum = (f: (o: JobOutcome) => number): number => done.reduce((a, o) => a + f(o), 0);
	const runSec = sum((o) => o.runSec);
	const slotSec = sum((o) => o.slotSec);

	const classes: Record<string, ClassReport> = {};
	for (const [c, list] of [...byClass].sort((a, b) => b[1].length - a[1].length)) {
		const acc = classFree.get(c)!;
		classes[c] = {
			jobs: list.length,
			queueSec: percentiles(queueOf(list)),
			oldest: oldestOf(classOldest.get(c)!),
			freeSlots: servers.get(c)!.length
				? { mean: acc.sum / ticks, shareOfTicksWithFree: acc.withFree / ticks }
				: null,
		};
	}

	const byDay = new Map<string, JobOutcome[]>();
	for (const o of outcomes) {
		const d = new Date(o.arrivalMs).toISOString().slice(0, 10);
		const list = byDay.get(d) ?? [];
		list.push(o);
		byDay.set(d, list);
	}

	return {
		window: { fromMs, toMs, ticks },
		jobs: { measured: outcomes.length, unserved: outcomes.length - done.length },
		queueSec: percentiles(queueOf(outcomes)),
		oldest: oldestOf(oldest),
		efficiency: {
			runSec,
			slotSec,
			ratio: slotSec > 0 ? runSec / slotSec : null,
			pickupSec: sum((o) => o.pickupSec),
			setupSec: sum((o) => o.setupSec),
			cleanupSec: sum((o) => o.cleanupSec),
		},
		capacity: {
			meanSlots: slotsSum / ticks,
			meanBusy: busySum / ticks,
			meanFree: freeSum / ticks,
			utilization: slotsSum > 0 ? busySum / slotsSum : null,
		},
		classes,
		days: [...byDay]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([day, list]) => {
				const q = percentiles(queueOf(list));
				return {
					day,
					jobs: list.length,
					queueP50: q.p50,
					queueP95: q.p95,
					oldestPeakSec: dayPeak.get(day) ?? 0,
				};
			}),
	};
}
