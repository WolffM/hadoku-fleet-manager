/**
 * The traffic simulator: the REAL dispatch code driven over a recorded
 * workload in virtual time, with no node behind it (operator, 2026-11-11:
 * "sandbox and simulate" a traffic-management change before it reaches a
 * claw, because of deadlock and drain churn).
 *
 * PURE and deterministic: the same corpus, fleet, models and policy give the
 * same result. Nothing here reads a file, spawns a process or calls GitHub.
 *
 * Each virtual tick ({@link SimOptions.tickSec}, the live dispatcher's 15 s)
 * does what the live dispatch pass does, in its order:
 *
 *   1. advance every placed job; a finished one frees its slot and releases
 *      any job inferred to depend on it (`sim-corpus.ts`);
 *   2. admit arrivals;
 *   3. promote or calm the backstop (a simplified controller, below);
 *   4. build each node's `NodeState` from the capacity timeline plus the
 *      simulated jobs on it, order candidates with the real
 *      `orderCandidates` (backstops last), and hand the queue in the real
 *      `byPriority` order to the POLICY. The baseline policy is `planTick`.
 *
 * A placed job holds its slot through four phases: GitHub's pickup after the
 * mint (`assignSec`), setup, run, cleanup. Run also slows by
 * {@link SimOptions.contention} for each extra heavy job beside a heavy one
 * (measured 1.14-1.53x per double, 2026-11-11).
 *
 * MOVING A JOB. Its recorded run already carries whatever contention it met
 * then, so that is divided out first ({@link soloRunSec}): the first cut
 * charged it twice and ran 32% more Forge hours than history. Then setup and
 * run scale by THIS KIND's measured median on the new node over the node that
 * ran it ({@link kindRatio}), and only for a kind too thin on either node by
 * the node-level speed factor: claw-8 is the fastest Forge node without being
 * the fastest node.
 *
 * WARM SLOTS are replayed from the dispatch log, not decided (sim-fleet.ts):
 * a node's recorded warm slot serves only its recorded repo, at arrival, with
 * no mint. A policy that wants warm slots to yield has to say so itself.
 *
 * WHAT IT DOES NOT MODEL, and every report must say so: GitHub handing a job
 * to a runner minted for another (steals); warm refills and rotation as
 * decisions; the real backstop controller (its thresholds, holds and
 * force switch); node outages beyond what the dispatch log's capacity rows
 * recorded; a job's memory beyond its repo's reserve.
 */
import { planTick, type PendingRun, type TickPlan } from './dispatcher.js';
import { byPriority } from './dispatch-pass-order.js';
import { orderCandidates, type TrafficNode } from './traffic.js';
import { choosePlacement } from './placement.js';
import { satisfiesLabels, type NodeState } from './placement-node-state.js';
import type { SpeedModel } from './speed-tier.js';
import type { HeavyModel } from './heavy-model.js';
import { SATURATION_QUEUE_SECONDS } from './backstop.js';
import type { Corpus, SimJob } from './sim-corpus.js';
import { capacityAt, PROMOTION_LABEL, type SimNodeSpec } from './sim-fleet.js';
import type { JobOutcome } from './sim-metrics.js';

export interface SimOptions {
	/** The dispatcher's cadence. */
	tickSec?: number;
	/** The JIT age gate (live: 0 with nothing standing eligible, else 30). */
	minQueuedSec?: number;
	/** Run-phase slowdown per extra heavy job beside a heavy job. */
	contention?: number;
	/** GitHub pickup after a mint, for a record that has none. */
	defaultAssignSec?: number;
	/** Keep ticking this long past the last arrival so the queue can drain. */
	drainSec?: number;
	/** A job waiting this long beside a node baseline admission accepts is starved. */
	starveSec?: number;
	/** The backstop calms after this long with no saturated job. */
	backstopCalmSec?: number;
	/** Only jobs arriving in [fromMs, toMs). Dependants of an excluded job arrive as recorded. */
	fromMs?: number;
	toMs?: number;
}

export interface SimModels {
	speed: SpeedModel;
	heavy?: HeavyModel;
	/**
	 * Per-repo job reserve, the live `fleet-runner-coverage.json` facets: what
	 * ADMISSION demands (lower-bound repos). What a running job CONSUMES is the
	 * node's observed `mbPerJob` (sim-fleet.ts), never this.
	 */
	reserves: ReadonlyMap<string, { mb: number; lowerBound: boolean }>;
}

/** What a policy sees each tick; the same inputs the live `planTick` gets. */
export interface SimTick {
	nowMs: number;
	pending: PendingRun[];
	nodes: NodeState[];
	order: string[];
}

export interface SimPolicy {
	name: string;
	plan(tick: SimTick): TickPlan;
	/** Counters the policy keeps (reservation flips, say), read once at the end. */
	stats?(): Record<string, number>;
	/** May the replayed warm slot on `node` take a job this tick? Omitted: yes. */
	warmAllowed?(node: string): boolean;
}

const NONE = { jobIds: new Set<number>(), runIds: new Set<number>() };

/** A warm listener's pickup: it is already registered, so GitHub hands the job over in seconds. */
export const WARM_PICKUP_SEC = 3;

/** Today's dispatcher, unchanged. */
export function baselinePolicy(): SimPolicy {
	return { name: 'baseline', plan: (t) => planTick(t.pending, t.nodes, t.order, NONE, t.nowMs) };
}

export interface SimResult {
	policy: string;
	outcomes: JobOutcome[];
	/** Job-seconds a job waited past `starveSec` while baseline admission had a node for it. */
	starvedJobSec: number;
	/** Distinct jobs that did. */
	starvedJobs: number;
	policyStats: Record<string, number>;
	backstopPromotions: number;
	/** Jobs still queued or running when the run ended. */
	unserved: number;
	/** Jobs a replayed warm slot took. */
	warmServed: number;
	ticks: number;
}

interface Running {
	job: SimJob;
	out: JobOutcome;
	node: string;
	heavy: boolean;
	heavyRepo: boolean;
	/** Took a replayed warm slot, not a JIT one. */
	warm: boolean;
	/** Free memory this job takes off its node while placed (observed, sim-fleet.ts). */
	reserveMb: number;
	/** Wall seconds of pickup + setup left. */
	pre: number;
	/** SOLO seconds of run left (contention stretches them). */
	run: number;
	/** Wall seconds of cleanup left. */
	post: number;
}

export function simulate(
	corpus: Corpus,
	fleet: readonly SimNodeSpec[],
	models: SimModels,
	policy: SimPolicy,
	opts: SimOptions = {}
): SimResult {
	const tickSec = opts.tickSec ?? 15;
	const tickMs = tickSec * 1000;
	const minQueuedMs = (opts.minQueuedSec ?? 0) * 1000;
	const contention = opts.contention ?? 0.3;
	const defaultAssignSec = opts.defaultAssignSec ?? 9;
	const starveMs = (opts.starveSec ?? 300) * 1000;
	const calmMs = (opts.backstopCalmSec ?? 600) * 1000;
	const fromMs = opts.fromMs ?? -Infinity;
	const toMs = opts.toMs ?? Infinity;

	const inWindow = corpus.jobs.filter((j) => j.arrivalMs >= fromMs && j.arrivalMs < toMs);
	const inSet = new Set(inWindow.map((j) => j.key));
	const byJobId = new Map(inWindow.map((j) => [j.jobId, j]));
	const outcomes = new Map<number, JobOutcome>();
	const waitingOn = new Map<number, SimJob[]>();
	const stream: SimJob[] = [];
	for (const j of inWindow) {
		outcomes.set(j.key, {
			key: j.key,
			arrivalMs: j.arrivalMs,
			placedMs: null,
			startMs: null,
			endMs: null,
			node: null,
			slotSec: 0,
			runSec: 0,
			pickupSec: 0,
			setupSec: 0,
			cleanupSec: 0,
		});
		if (j.dependsOn && inSet.has(j.dependsOn.key)) {
			const list = waitingOn.get(j.dependsOn.key) ?? [];
			list.push(j);
			waitingOn.set(j.dependsOn.key, list);
		} else stream.push(j);
	}
	const lastArrival = inWindow.at(-1)?.arrivalMs ?? 0;
	const endMs = lastArrival + (opts.drainSec ?? 6 * 3600) * 1000;

	const factor = (n: string): number => models.speed.factorOf?.(n) ?? 1;
	const solo = soloRunSec(
		inWindow,
		(j) => models.heavy?.isHeavy(j.repo, j.name) ?? false,
		contention
	);
	const ratioOf = kindRatio(inWindow, solo, factor);
	const requiredMbByRepo = new Map(
		[...models.reserves].filter(([, r]) => r.lowerBound).map(([repo, r]) => [repo, r])
	);
	const specs = new Map(fleet.map((s) => [s.name, s]));
	const running = new Map<string, Running[]>(fleet.map((s) => [s.name, []]));
	const lastEndMs = new Map<string, number>();
	const pending: SimJob[] = [];
	const released: SimJob[] = [];
	const starvedKeys = new Set<number>();
	let starvedJobSec = 0;
	let streamAt = 0;
	let promoted = false;
	let lastSaturatedMs = -Infinity;
	let promotions = 0;
	let ticks = 0;
	let warmServed = 0;

	const heavyIs = (j: SimJob): boolean => models.heavy?.isHeavy(j.repo, j.name) ?? false;
	const heavyRepo = (j: SimJob): boolean => models.heavy?.isHeavyRepo(j.repo) ?? false;

	const advance = (fromMs: number): void => {
		for (const [node, list] of running) {
			const heavyHere = list.filter((r) => r.heavy).length;
			for (let i = list.length - 1; i >= 0; i--) {
				const r = list[i];
				const slow = r.heavy && heavyHere > 1 ? 1 + contention * (heavyHere - 1) : 1;
				const left = step(r, tickSec, slow);
				if (done(r)) {
					const end = fromMs + (tickSec - left) * 1000;
					r.out.endMs = end;
					r.out.slotSec = (end - (r.out.placedMs ?? end)) / 1000;
					list.splice(i, 1);
					lastEndMs.set(node, Math.max(lastEndMs.get(node) ?? 0, end));
					for (const dep of waitingOn.get(r.job.key) ?? []) {
						const arrival = end + (dep.dependsOn?.gapSec ?? 0) * 1000;
						outcomes.get(dep.key)!.arrivalMs = arrival;
						released.push(dep);
					}
				}
			}
		}
	};

	const nodeStates = (now: number): NodeState[] =>
		fleet.map((s) => {
			const cap = capacityAt(s, now);
			const list = running.get(s.name)!;
			const jit = list.filter((r) => !r.warm);
			const used = list.reduce((sum, r) => sum + r.reserveMb, 0);
			return {
				name: s.name,
				healthy: cap.healthy,
				eligible: true,
				drained: cap.drained,
				schedulable: cap.schedulable,
				labels: s.backstop && promoted ? [...s.labels, PROMOTION_LABEL] : s.labels,
				onDemandBackstop: s.backstop,
				excludedRepos: s.excludeRepos.size ? s.excludeRepos : undefined,
				liveUnits: jit.length,
				standingBusy: 0,
				maxConcurrent: Math.max(0, cap.maxConcurrent - cap.warmHeld),
				freeMb: Math.max(0, cap.baseFreeMb - used),
				requiredMb: cap.requiredMb,
				minFreeMb: cap.minFreeMb,
				requiredMbByRepo,
				speedModel: models.speed,
				heavyModel: models.heavy,
				heavyJobs: list.filter((r) => r.heavy).length,
				runningHeavy: list.some((r) => r.heavyRepo),
			};
		});

	const orderOf = (nodes: readonly NodeState[], now: number): string[] => {
		const traffic: TrafficNode[] = nodes.map((n) => ({
			name: n.name,
			busy: n.liveUnits,
			idleSeconds: lastEndMs.has(n.name) ? (now - lastEndMs.get(n.name)!) / 1000 : null,
			schedulable: n.schedulable,
			speedFactor: models.speed.factorOf?.(n.name) ?? null,
		}));
		const names = nodes.map((n) => n.name);
		const back = (n: string): boolean => specs.get(n)?.backstop === true;
		return [
			...orderCandidates(
				names.filter((n) => !back(n)),
				traffic
			),
			...orderCandidates(names.filter(back), traffic),
		];
	};

	/** Put `job` on `node` at `atMs`: a JIT mint, or a replayed warm slot. */
	const place = (job: SimJob, node: string, atMs: number, warm: boolean): void => {
		pending.splice(pending.indexOf(job), 1);
		const out = outcomes.get(job.key)!;
		const ratio = ratioOf(job, node);
		const pickup = warm
			? Math.min(job.assignSec ?? WARM_PICKUP_SEC, WARM_PICKUP_SEC)
			: (job.assignSec ?? defaultAssignSec);
		out.placedMs = atMs;
		out.startMs = atMs + pickup * 1000;
		out.node = node;
		out.pickupSec = pickup;
		out.setupSec = job.setupSec * ratio;
		out.cleanupSec = job.cleanupSec;
		if (warm) warmServed++;
		const spec = specs.get(node)!;
		running.get(node)!.push({
			job,
			out,
			node,
			heavy: heavyIs(job),
			heavyRepo: heavyRepo(job),
			warm,
			reserveMb: heavyIs(job) ? spec.mbPerJob.heavy : spec.mbPerJob.light,
			pre: pickup + job.setupSec * ratio,
			run: (solo.get(job.key) ?? job.runSec) * ratio,
			post: job.cleanupSec,
		});
		// Placed before `now` (a warm slot takes a job the moment it arrives):
		// the seconds already behind it are worked off here, since the next
		// tick advance only covers (now, now + tick].
		if (atMs < now) step(running.get(node)!.at(-1)!, (now - atMs) / 1000, 1);
	};

	const asRun = (j: SimJob): PendingRun => {
		const arrival = outcomes.get(j.key)!.arrivalMs;
		return {
			id: j.runId,
			jobId: j.jobId,
			repo: j.repo,
			repository: { full_name: j.repo },
			head_repository: { full_name: j.repo, fork: false },
			event: j.event,
			labels: [...j.labels],
			jobName: j.name,
			jobCreatedAt: new Date(arrival).toISOString(),
			queuedSinceMs: arrival,
		};
	};

	let now = Math.floor((inWindow[0]?.arrivalMs ?? 0) / tickMs) * tickMs;
	const anythingLeft = (): boolean =>
		streamAt < stream.length ||
		released.length > 0 ||
		pending.length > 0 ||
		[...running.values()].some((l) => l.length > 0);
	while (now <= endMs && anythingLeft()) {
		ticks++;
		advance(now - tickMs);

		while (streamAt < stream.length && stream[streamAt].arrivalMs <= now)
			pending.push(stream[streamAt++]);
		for (let i = released.length - 1; i >= 0; i--) {
			if (outcomes.get(released[i].key)!.arrivalMs <= now) {
				pending.push(released[i]);
				released.splice(i, 1);
			}
		}

		const saturated = pending.some(
			(j) =>
				j.labels.includes(PROMOTION_LABEL) &&
				now - outcomes.get(j.key)!.arrivalMs >= SATURATION_QUEUE_SECONDS * 1000
		);
		if (saturated) lastSaturatedMs = now;
		if (!promoted && saturated) {
			promoted = true;
			promotions++;
		} else if (promoted && now - lastSaturatedMs >= calmMs) promoted = false;

		// REPLAYED WARM SLOTS take their repo's jobs first, at arrival, no mint.
		for (const s of fleet) {
			const cap = capacityAt(s, now);
			if (!cap.warmHeld || !cap.warmRepo || !cap.healthy || cap.drained) continue;
			if (policy.warmAllowed && !policy.warmAllowed(s.name)) continue;
			let free = cap.warmHeld - running.get(s.name)!.filter((r) => r.warm).length;
			for (const j of [...pending]) {
				if (free <= 0) break;
				if (j.repo !== cap.warmRepo || s.excludeRepos.has(j.repo)) continue;
				if (!satisfiesLabels(s.labels, j.labels)) continue;
				const arrival = outcomes.get(j.key)!.arrivalMs;
				place(j, s.name, Math.max(arrival, now - tickMs), true);
				free--;
			}
		}

		let nodes = nodeStates(now);
		const order = orderOf(nodes, now);
		const eligible = pending.filter((j) => now - outcomes.get(j.key)!.arrivalMs >= minQueuedMs);
		if (eligible.length) {
			const plan = policy.plan({
				nowMs: now,
				pending: byPriority(eligible.map(asRun)),
				nodes,
				order,
			});
			for (const m of plan.mint) {
				const job = byJobId.get(m.jobId);
				if (job && pending.includes(job)) place(job, m.node, now, false);
			}
			nodes = nodeStates(now);
		}

		// STARVATION: a job past `starveSec` that today's admission would place
		// on a node right now, but the policy left queued. Zero for baseline by
		// construction, so it is asked only of another policy.
		if (policy.name !== 'baseline') {
			const freshOrder = orderOf(nodes, now);
			for (const j of pending) {
				const ageSec = (now - outcomes.get(j.key)!.arrivalMs) / 1000;
				if (ageSec * 1000 < starveMs) continue;
				const p = choosePlacement(freshOrder, nodes, j.labels, j.repo, {
					queuedSec: ageSec,
					jobName: j.name,
				});
				if (p.node) {
					starvedKeys.add(j.key);
					starvedJobSec += tickSec;
				}
			}
		}
		now += tickMs;
	}

	const all = [...outcomes.values()];
	return {
		policy: policy.name,
		outcomes: all,
		starvedJobSec,
		starvedJobs: starvedKeys.size,
		policyStats: policy.stats?.() ?? {},
		backstopPromotions: promotions,
		unserved: all.filter((o) => o.endMs === null).length,
		warmServed,
		ticks,
	};
}

/**
 * Work `sec` wall seconds off a placed job, phase by phase: pickup and setup,
 * then run (stretched by `slow`), then cleanup. Returns the seconds left over
 * once the job is done, 0 while it is not.
 */
function step(r: Running, sec: number, slow: number): number {
	let left = sec;
	let d = Math.min(r.pre, left);
	r.pre -= d;
	left -= d;
	if (r.pre <= 0 && r.run > 0 && left > 0) {
		d = Math.min(r.run * slow, left);
		r.run -= d / slow;
		r.out.runSec += d;
		left -= d;
	}
	if (r.pre <= 0 && r.run <= 1e-9 && r.post > 0 && left > 0) {
		d = Math.min(r.post, left);
		r.post -= d;
		left -= d;
	}
	return done(r) ? left : 0;
}

function done(r: Running): boolean {
	return r.pre <= 0 && r.run <= 1e-9 && r.post <= 1e-9;
}

/**
 * Each heavy job's run with its recorded contention divided out: the
 * time-averaged count of OTHER heavy jobs on the same node during its run,
 * at the same per-job slowdown the engine applies. A light job is unchanged.
 */
export function soloRunSec(
	jobs: readonly SimJob[],
	isHeavy: (j: SimJob) => boolean,
	contention: number
): Map<number, number> {
	const out = new Map<number, number>();
	const byNode = new Map<string, SimJob[]>();
	for (const j of jobs) {
		if (!isHeavy(j)) continue;
		const list = byNode.get(j.histNode) ?? [];
		list.push(j);
		byNode.set(j.histNode, list);
	}
	for (const list of byNode.values()) {
		list.sort((a, b) => a.histStartMs - b.histStartMs);
		for (let i = 0; i < list.length; i++) {
			const j = list[i];
			const s = j.histStartMs;
			const e = s + j.workSec * 1000;
			let overlapMs = 0;
			for (let k = 0; k < list.length; k++) {
				if (k === i) continue;
				const o = list[k];
				if (o.histStartMs >= e) break;
				const os = o.histStartMs;
				const oe = os + o.workSec * 1000;
				overlapMs += Math.max(0, Math.min(e, oe) - Math.max(s, os));
			}
			const extra = j.workSec > 0 ? overlapMs / (j.workSec * 1000) : 0;
			out.set(j.key, j.runSec / (1 + contention * extra));
		}
	}
	return out;
}

/** Minimum runs of a kind on BOTH nodes before its own medians decide a move. */
export const KIND_MIN_RUNS = 3;

/**
 * How much longer (or shorter) `job` runs on `node` than on the node that
 * really ran it: the median solo run of its (repo, job name) on each, when
 * both have {@link KIND_MIN_RUNS}; else the node-level speed factor.
 */
export function kindRatio(
	jobs: readonly SimJob[],
	solo: ReadonlyMap<number, number>,
	factor: (node: string) => number
): (job: SimJob, node: string) => number {
	const runs = new Map<string, Map<string, number[]>>();
	for (const j of jobs) {
		if (j.conclusion && j.conclusion !== 'success') continue;
		const kind = `${j.repo}\u0000${j.name}`;
		const byNode = runs.get(kind) ?? new Map<string, number[]>();
		const list = byNode.get(j.histNode) ?? [];
		list.push(solo.get(j.key) ?? j.runSec);
		byNode.set(j.histNode, list);
		runs.set(kind, byNode);
	}
	const medians = new Map<string, Map<string, number>>();
	for (const [kind, byNode] of runs) {
		const m = new Map<string, number>();
		for (const [node, xs] of byNode) {
			if (xs.length < KIND_MIN_RUNS) continue;
			const s = [...xs].sort((a, b) => a - b);
			m.set(node, s[Math.floor(s.length / 2)]);
		}
		medians.set(kind, m);
	}
	return (job, node) => {
		if (node === job.histNode) return 1;
		const m = medians.get(`${job.repo}\u0000${job.name}`);
		const to = m?.get(node);
		const from = m?.get(job.histNode);
		if (to !== undefined && from !== undefined && from > 0 && to > 0) return to / from;
		return factor(node) / factor(job.histNode);
	};
}
