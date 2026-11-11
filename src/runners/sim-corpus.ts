/**
 * The traffic simulator's workload: every job in `job-history.jsonl`, turned
 * into an arrival the simulated dispatcher must serve (operator, 2026-11-11:
 * "use the entire corpus of jobhistory as the sandbox simulation dataset").
 *
 * PURE. The caller reads the files; this only reshapes records.
 *
 * What a record gives, and what it does not:
 *
 * - ARRIVAL is when GitHub created the job: `startedAt - queueSec`. A record
 *   with no `queueSec` (GitHub omitted `created_at`) arrives at `startedAt`
 *   and is counted in `noQueueSec`, never silently treated as a zero wait.
 * - WORK is `durationSec` on the node that ran it. The engine rescales it for
 *   whatever node the simulated dispatcher picks.
 * - HOSTED jobs (GitHub's own runners) never reached the fleet; they are kept
 *   out of the workload and counted, so a report can say how many.
 * - DEPENDENCY is inferred, not recorded: a job created within
 *   {@link DEPENDENCY_GAP_SEC} after another job of the SAME run finished was
 *   almost certainly waiting on it (`needs:`). Its simulated arrival follows
 *   that job's SIMULATED end by the same gap, so a dispatcher that serves the
 *   first job later also delays the second, as GitHub would. Without this, a
 *   policy that slows `changes` would wrongly look free for the Forge shards
 *   behind it.
 */
import type { JobRecord } from '../job-history-store.js';
import { HOSTED_NODE, nodeOf } from './census.js';

/** Seconds after a same-run job's end within which a new job is read as its dependant. */
export const DEPENDENCY_GAP_SEC = 20;

export type HistoricalClass = 'jit' | 'warm' | 'standing';

export interface SimJob {
	/** Index into the corpus; stable for a given input. */
	key: number;
	repo: string;
	runId: number;
	jobId: number;
	name: string;
	labels: readonly string[];
	/** The trigger, when the dispatch log recorded one; `push` otherwise. */
	event: string;
	/** Historical arrival (job created), ms. The engine shifts dependants. */
	arrivalMs: number;
	/** Seconds the job held its runner on {@link histNode}: setup + run + cleanup. */
	workSec: number;
	/**
	 * The three phases of {@link workSec}, from GitHub's step timings. `runSec`
	 * is the job's own work; setup and cleanup are orchestration around it.
	 * A record without phase timings reads as all run, and is counted.
	 */
	setupSec: number;
	runSec: number;
	cleanupSec: number;
	/** GitHub's own runner pickup after a mint (`assignSec`), seconds. */
	assignSec: number | null;
	histNode: string;
	histClass: HistoricalClass;
	histQueueSec: number | null;
	histStartMs: number;
	conclusion?: string;
	/** The same-run job this one waited on, by key, and the gap after its end. */
	dependsOn?: { key: number; gapSec: number };
}

export interface Corpus {
	jobs: SimJob[];
	/** Records the fleet never saw: GitHub-hosted runners. */
	hosted: number;
	/** Records whose runner names no fleet node. */
	unattributed: number;
	/** Records with no `queueSec`, arriving at their start. */
	noQueueSec: number;
	/** Records with no phase timings, counted as all run. */
	noPhases: number;
	/** Records repeating a job id already read; the first is kept. */
	duplicates: number;
	firstArrivalMs: number;
	lastArrivalMs: number;
}

function classOf(runner: string): HistoricalClass {
	if (runner.startsWith('jit-')) return 'jit';
	if (runner.startsWith('warm-')) return 'warm';
	return 'standing';
}

/**
 * Build the workload. `nodes` are the fleet's node names (the manifest's
 * machines), which `nodeOf` needs to attribute a runner name; `events` maps a
 * job id to its trigger, from the dispatch log.
 */
export function buildCorpus(
	records: readonly JobRecord[],
	nodes: readonly string[],
	events: ReadonlyMap<number, string> = new Map()
): Corpus {
	let hosted = 0;
	let unattributed = 0;
	let noQueueSec = 0;
	let noPhases = 0;
	let duplicates = 0;
	const seen = new Set<number>();
	const jobs: SimJob[] = [];
	for (const r of records) {
		// One job, one arrival: the ingest has written the same job twice (job
		// 124524418308, 2026-10-31), and two arrivals sharing an id wedged the
		// engine's mint lookup on the first cut.
		if (seen.has(r.jobId)) {
			duplicates++;
			continue;
		}
		seen.add(r.jobId);
		const runner = r.runner ?? '';
		const node = runner ? nodeOf(runner, nodes) : HOSTED_NODE;
		if (node === HOSTED_NODE) {
			hosted++;
			continue;
		}
		if (!nodes.includes(node)) {
			unattributed++;
			continue;
		}
		const startMs = Date.parse(r.startedAt);
		if (!Number.isFinite(startMs) || !(r.durationSec >= 0)) {
			unattributed++;
			continue;
		}
		const q = typeof r.queueSec === 'number' && r.queueSec >= 0 ? r.queueSec : null;
		if (q === null) noQueueSec++;
		const phases = phasesOf(r);
		if (!phases) noPhases++;
		jobs.push({
			key: 0,
			repo: r.repo,
			runId: r.runId,
			jobId: r.jobId,
			name: r.name,
			labels: r.labels ?? [],
			event: events.get(r.jobId) ?? 'push',
			arrivalMs: startMs - (q ?? 0) * 1000,
			workSec: r.durationSec,
			...(phases ?? { setupSec: 0, runSec: r.durationSec, cleanupSec: 0 }),
			assignSec: typeof r.assignSec === 'number' && r.assignSec >= 0 ? r.assignSec : null,
			histNode: node,
			histClass: classOf(runner),
			histQueueSec: q,
			histStartMs: startMs,
			conclusion: r.conclusion,
		});
	}
	jobs.sort((a, b) => a.arrivalMs - b.arrivalMs || a.jobId - b.jobId);
	jobs.forEach((j, i) => (j.key = i));
	inferDependencies(jobs);
	return {
		jobs,
		hosted,
		unattributed,
		noQueueSec,
		noPhases,
		duplicates,
		firstArrivalMs: jobs[0]?.arrivalMs ?? 0,
		lastArrivalMs: jobs.at(-1)?.arrivalMs ?? 0,
	};
}

/**
 * Setup, run and cleanup that add up to the record's duration, or null when
 * GitHub gave no step timings. A run phase the record omits is the remainder.
 */
export function phasesOf(
	r: Pick<JobRecord, 'durationSec' | 'setupSec' | 'runSec' | 'cleanupSec'>
): { setupSec: number; runSec: number; cleanupSec: number } | null {
	const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
	if (!ok(r.setupSec) && !ok(r.runSec) && !ok(r.cleanupSec)) return null;
	const setupSec = ok(r.setupSec) ? r.setupSec : 0;
	const cleanupSec = ok(r.cleanupSec) ? r.cleanupSec : 0;
	const runSec = ok(r.runSec) ? r.runSec : Math.max(0, r.durationSec - setupSec - cleanupSec);
	return { setupSec, runSec, cleanupSec };
}

/**
 * For each job, the same-run job that ended latest at or before its creation,
 * within {@link DEPENDENCY_GAP_SEC}. A small negative gap is allowed: GitHub
 * stamps a dependant's creation in the same second its predecessor's
 * completion lands, and `startedAt + durationSec` rounds.
 */
export function inferDependencies(jobs: SimJob[]): void {
	const byRun = new Map<number, SimJob[]>();
	for (const j of jobs) {
		const list = byRun.get(j.runId);
		if (list) list.push(j);
		else byRun.set(j.runId, [j]);
	}
	for (const run of byRun.values()) {
		if (run.length < 2) continue;
		for (const j of run) {
			let best: SimJob | undefined;
			let bestEnd = -Infinity;
			for (const p of run) {
				if (p === j) continue;
				const end = p.histStartMs + p.workSec * 1000;
				const gap = (j.arrivalMs - end) / 1000;
				if (gap < -2 || gap > DEPENDENCY_GAP_SEC) continue;
				if (end > bestEnd) {
					best = p;
					bestEnd = end;
				}
			}
			if (best && best.arrivalMs <= j.arrivalMs) {
				j.dependsOn = { key: best.key, gapSec: Math.max(0, (j.arrivalMs - bestEnd) / 1000) };
			}
		}
	}
}
