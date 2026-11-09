/**
 * WARM YIELD — a warm listener gives its slot to the queue when spare claws can
 * cover normal CI (operator, 2026-11-09: "everything is about the queue").
 *
 * WHY. The mint budget is `maxConcurrent` minus the warm-held slots
 * (`mintBudget`), so on a 2-slot claw an IDLE listener halves what the
 * dispatcher may mint there. claw-10 sat full 64–82% of 11-06..08 holding a
 * hadoku_site listener while jdk21 jobs, which only four claws can run, waited
 * 31–59 min at p95. Every other repo waited 2–2.5 min.
 *
 * TWO HALVES, ON THE TWO CLOCKS THAT ALREADY EXIST.
 *
 *   1. {@link WarmYieldPass}, inside the dispatch pass (15 s): planTick's
 *      observer sees each job it could not place and the node states it read.
 *      A node that refused a job only on `at capacity`, holds a slot for a
 *      verified-live listener, and would admit the job with that slot given
 *      back (the whole of `refusalFor`, memory and slice included), becomes a
 *      REQUEST — if the listener's repo is covered elsewhere: another live
 *      listener for it, or {@link WARM_YIELD_SPARE} other claws that could mint
 *      its job right now, counted through the same `refusalFor` on the pass's
 *      final node states. An unmeasured node is refused there, so it is never
 *      spare.
 *   2. {@link warmYieldStep}, inside the warm tick (60 s): acts on a request
 *      only for a listener that is IDLE by the busy read the warm cache already
 *      trusts (`warmSlotLocked`; a listener it could not confirm reads busy),
 *      and `evictWarmListener` checks the process tree again before deleting.
 *      Then the node is held out of the warm planner while jobs keep waiting
 *      for it and for {@link WARM_YIELD_COOLDOWN_MS} after, and until it has a
 *      free slot to put a listener in.
 *
 * `maxConcurrent` is never touched: the yield changes what the reserved slot
 * holds, not how many there are.
 */
import { logger } from '../host.js';
import { warmRunnerName } from '../lib/jit-naming.js';
import { BUILDER_LABEL } from '../lib/capability-registry-ids.js';
import { type GhLike } from '../lib/fleet-vocabulary.js';
import { refusalFor } from './placement-refusal.js';
import type { NodeState } from './placement-node-state.js';
import type { PlanObservation } from './dispatcher.js';
import { warmSlotLocked } from './ephemeral-warm.js';
import { evictWarmListener } from './ephemeral-exec.js';
import { warmBackoffActive } from './warm-backoff.js';
import { recordWarmYieldDecision } from './decision-log-record.js';
import type { ObservedWarmNode } from './dispatch-warm-cache-state.js';
import type { WarmCacheDecision } from './ephemeral-warm.js';
import { forgetWarmDecision } from './decision-log.js';
import type { shellOnNode } from './ephemeral-shared.js';
import {
	WARM_YIELD_AFTER_MS,
	WARM_YIELD_COOLDOWN_MS,
	WARM_YIELD_SPARE,
	confirmWarmYield,
	liftWarmYield,
	noteWarmYieldDemand,
	pruneWarmYields,
	recordWarmYield,
	setWarmYieldRequests,
	setWarmYieldWaiting,
	warmSlotYielded,
	warmYieldEntry,
	warmYieldRequestFor,
	warmYieldWaitingFor,
	yieldedNodes,
	type WarmYieldJob,
	type WarmYieldRequest,
} from './warm-yields.js';

/** The labels an ordinary job asks for: what "could mint that repo's job" is measured against. */
const NORMAL_CI_LABELS: readonly string[] = ['self-hosted', BUILDER_LABEL];

const atCapacity = (reason: string): boolean => reason.startsWith('at capacity:');

/** `m` with its warm-held slot handed back to the mint budget. */
export function withSlotReleased(m: NodeState): NodeState {
	const held = m.warmHeld ?? 0;
	return {
		...m,
		maxConcurrent: m.maxConcurrent + (held > 0 ? 1 : 0),
		warmHeld: Math.max(0, held - 1),
	};
}

interface Candidate {
	job: WarmYieldJob;
	/** Nodes that would admit the job with their slot released, in walk order. */
	nodes: string[];
}

/** A request the pass turned down, for the log. */
export interface WarmYieldDecline {
	node: string;
	warmRepo: string;
	job: WarmYieldJob;
	spare: number;
}

const held = (repo: string | null): string => (repo === null ? 'empty' : `idle ${repo}`);

/**
 * One dispatch pass's view of the yield question. Hand {@link observe} to
 * planTick (it reads, it keeps only names and numbers), then call
 * {@link finish} once planTick has returned.
 */
export class WarmYieldPass {
	private readonly candidates: Candidate[] = [];
	/** planTick's live working copies; read only after it has returned. */
	private finalNodes: readonly NodeState[] = [];
	readonly demand = new Set<string>();

	constructor(
		private readonly nowMs: number,
		private readonly afterMs = WARM_YIELD_AFTER_MS
	) {}

	/** Never throws: an observer that threw would throw out of planTick. */
	readonly observe = (o: PlanObservation): void => {
		try {
			this.see(o);
		} catch (err) {
			logger.warn(
				`[warm-yield] could not weigh run ${o.run.id} (${o.run.repo}): ` +
					`${err instanceof Error ? err.message : String(err)} — dispatch is unaffected`
			);
		}
	};

	private see(o: PlanObservation): void {
		if (o.candidates.length) this.finalNodes = o.candidates;
		if (o.outcome !== 'unplaceable' && o.outcome !== 'held') return;
		const passed = o.placed?.passed ?? [];
		const full = passed.filter((p) => atCapacity(p.reason)).map((p) => p.node);
		for (const n of full) this.demand.add(n);
		if (o.queuedSec === undefined || o.queuedSec * 1000 < this.afterMs) return;
		const nodes: string[] = [];
		for (const name of full) {
			const m = o.candidates.find((c) => c.name === name);
			if (!m || !(m.warmHeld && m.warmHeld > 0)) continue;
			const r = refusalFor(
				withSlotReleased(m),
				o.run.labels ?? [],
				o.run.repo,
				{ queuedSec: o.queuedSec, jobName: o.run.jobName },
				o.placed?.heavy ?? false
			);
			if (r.reason === null) nodes.push(name);
		}
		if (!nodes.length) return;
		this.candidates.push({
			job: {
				repo: o.run.repo,
				runId: o.run.id,
				jobId: o.run.jobId,
				jobName: o.run.jobName,
				queuedSec: Math.round(o.queuedSec),
			},
			nodes,
		});
	}

	/**
	 * The requests, at most one node per job and one job per node, oldest job
	 * first (planTick's own order). A node whose listener's repo would be left
	 * uncovered is declined, not requested.
	 */
	finish(): {
		requests: WarmYieldRequest[];
		declined: WarmYieldDecline[];
		waiting: Map<string, WarmYieldJob>;
	} {
		const requests: WarmYieldRequest[] = [];
		const declined: WarmYieldDecline[] = [];
		const waiting = new Map<string, WarmYieldJob>();
		const taken = new Set<string>();
		const byName = new Map(this.finalNodes.map((m) => [m.name, m]));
		const empty = (node: string): boolean => (byName.get(node)?.warmRepo ?? null) === null;
		for (const c of this.candidates) {
			for (const node of c.nodes) if (!waiting.has(node)) waiting.set(node, c.job);
			// An EMPTY slot first: it gives nothing up, and a request spent on a
			// node whose listener turns out busy leaves the job waiting while an
			// empty slot beside it stays reserved (claw-4 and claw-10, 09:14Z
			// 2026-11-09). Otherwise walk order.
			const order = [...c.nodes.filter(empty), ...c.nodes.filter((n) => !empty(n))];
			for (const node of order) {
				if (taken.has(node)) continue;
				const warmRepo = byName.get(node)?.warmRepo ?? null;
				const cover = warmRepoCover(this.finalNodes, node, warmRepo, taken);
				// A slot with no live listener gives nothing up: nothing to cover.
				if (warmRepo !== null && cover.otherWarm.length === 0 && cover.spare < WARM_YIELD_SPARE) {
					declined.push({ node, warmRepo, job: c.job, spare: cover.spare });
					continue;
				}
				taken.add(node);
				requests.push({ node, warmRepo, job: c.job, ...cover, atMs: this.nowMs });
				break;
			}
		}
		return { requests, declined, waiting };
	}
}

/**
 * Is `repo` covered without `node`'s listener? Other live listeners for it,
 * and the claws (never a backstop, never one GitHub cannot place on, never one
 * already yielding) that would mint its ordinary job right now — asked through
 * `refusalFor` itself, so a full, unmeasured, drained, excluded or slow node is
 * not spare. `null` (an empty slot) counts the claws free for any ordinary job,
 * for the record only.
 */
export function warmRepoCover(
	nodes: readonly NodeState[],
	node: string,
	repo: string | null,
	yielding: ReadonlySet<string> = new Set()
): { spare: number; otherWarm: string[] } {
	const others = nodes.filter((m) => m.name !== node && !yielding.has(m.name));
	return {
		otherWarm: repo === null ? [] : others.filter((m) => m.warmRepo === repo).map((m) => m.name),
		spare: others.filter(
			(m) =>
				!m.onDemandBackstop &&
				m.schedulable !== false &&
				refusalFor(m, NORMAL_CI_LABELS, repo ?? undefined).reason === null
		).length,
	};
}

const declinedLogged = new Map<string, number>();
/** node -> the suppression reason last logged, digits blanked: one line per change. */
const suppressLogged = new Map<string, string>();

/** Publish one pass's answer: the requests, the demand, and a line per new decline. */
export function publishWarmYieldPass(pass: WarmYieldPass, nowMs: number): WarmYieldRequest[] {
	const { requests, declined, waiting } = pass.finish();
	setWarmYieldRequests(requests);
	setWarmYieldWaiting(waiting, nowMs);
	noteWarmYieldDemand(pass.demand, nowMs);
	for (const r of requests) {
		logger.info(
			`[warm-yield] ${r.node}: asking its ${held(r.warmRepo)} warm slot to yield to ` +
				`${r.job.repo} job ${r.job.jobId} (queued ${r.job.queuedSec}s, refused only on capacity); ` +
				`spare=${r.spare}` +
				(r.otherWarm.length ? ` warm=${r.otherWarm.join(',')}` : '')
		);
	}
	for (const d of declined) {
		const key = `${d.node}\0${d.job.jobId}`;
		if (declinedLogged.has(key)) continue;
		declinedLogged.set(key, nowMs);
		logger.info(
			`[warm-yield] ${d.node}: keeping its ${d.warmRepo} listener although ${d.job.repo} job ` +
				`${d.job.jobId} waits ${d.job.queuedSec}s for it — CI is not easy: spare=${d.spare} ` +
				`< ${WARM_YIELD_SPARE} and no other live ${d.warmRepo} listener`
		);
	}
	for (const [k, at] of declinedLogged) if (nowMs - at > 6 * 3600_000) declinedLogged.delete(k);
	return requests;
}

/** What the warm tick should do with a node after {@link warmYieldStep}. */
export type WarmYieldStep =
	{ hold: true; reason: string; evicted: boolean } | { hold: false; failed: boolean };

/**
 * The warm tick's half, for one observed node, before the joint allocation.
 * `hold: true` keeps the node out of `planWarmFleet` this tick (no fill).
 *
 * `freeSlotFor` answers whether the node has room for a listener again —
 * `null` is "could not look", and a node that cannot be shown to have room
 * stays yielded.
 *
 * `stillWarm` answers whether another node's listener for a repo is still
 * live this tick (another node may have yielded its own a moment ago).
 */
export async function warmYieldStep(a: {
	o: ObservedWarmNode;
	nowMs: number;
	token: string;
	gh: GhLike & { get: (path: string, token: string, repo?: string) => Promise<unknown> };
	sh: typeof shellOnNode;
	freeSlotFor: (node: string) => boolean | null;
	stillWarm: (node: string, repo: string) => boolean;
}): Promise<WarmYieldStep> {
	const { o, nowMs } = a;
	pruneWarmYields(nowMs);
	if (warmSlotYielded(o.node) && o.current) {
		// A listener is there again, so its slot must be counted again: the
		// yield is over, whatever the queue is doing.
		const e = warmYieldEntry(o.node)!;
		liftWarmYield(o.node, nowMs);
		suppressLogged.delete(o.node);
		logger.warn(
			`[warm-yield] ${o.node}: a ${o.current.repo} listener is present on a yielded slot — ` +
				'counting its slot again'
		);
		recordWarmYieldDecision(
			{
				node: o.node,
				action: 'refill',
				warmRepo: e.warmRepo,
				job: e.job,
				spare: e.spare,
				reason: 'a listener is present again',
			},
			nowMs
		);
		return { hold: false, failed: false };
	}
	if (warmSlotYielded(o.node)) {
		const e = warmYieldEntry(o.node)!;
		const sinceDemand = nowMs - e.lastDemandMs;
		const room = a.freeSlotFor(o.node);
		const why =
			sinceDemand < WARM_YIELD_COOLDOWN_MS
				? `a job waited for ${o.node} ${Math.round(sinceDemand / 1000)}s ago ` +
					`(cooldown ${WARM_YIELD_COOLDOWN_MS / 1000}s)`
				: room !== true
					? room === null
						? 'could not read whether it has a free slot'
						: 'no free slot for a listener yet'
					: null;
		if (why !== null) {
			confirmWarmYield(o.node, nowMs);
			const reason = `yielded to the queue: ${why}`;
			recordWarmYieldDecision(
				{
					node: o.node,
					action: 'refill-suppressed',
					warmRepo: e.warmRepo,
					job: e.job,
					spare: e.spare,
					reason,
				},
				nowMs
			);
			const sig = why.replace(/\d+/g, '#');
			if (suppressLogged.get(o.node) !== sig) {
				suppressLogged.set(o.node, sig);
				logger.info(
					`[warm-yield] ${o.node}: not refilling its warm slot (${held(e.warmRepo)} slot yielded to ${e.job.repo} ` +
						`job ${e.job.jobId}, spare=${e.spare}) — ${why}`
				);
			}
			return { hold: true, reason, evicted: false };
		}
		liftWarmYield(o.node, nowMs);
		suppressLogged.delete(o.node);
		recordWarmYieldDecision(
			{
				node: o.node,
				action: 'refill',
				warmRepo: e.warmRepo,
				job: e.job,
				spare: e.spare,
				reason: 'queue drained and cooldown passed',
			},
			nowMs
		);
		logger.info(
			`[warm-yield] ${o.node}: the queue that took its slot drained ${Math.round(sinceDemand / 1000)}s ago — ` +
				'the warm planner may refill it'
		);
		return { hold: false, failed: false };
	}

	const r = warmYieldRequestFor(o.node, nowMs);
	if (!r) return { hold: false, failed: false };
	const cur = o.current;
	if (!cur) {
		// AN EMPTY SLOT: released only on the node's own word that no listener
		// is there. A listener the pass named may have gone since (evicted for
		// a heavy job, say); that is still an empty slot.
		if (o.slotEmpty !== true) return { hold: false, failed: false };
		const empty: WarmYieldRequest = { ...r, warmRepo: null, otherWarm: [] };
		recordWarmYield(empty, nowMs);
		return yielded(o.node, empty, nowMs, false);
	}
	if (r.warmRepo === null || cur.repo !== r.warmRepo) return { hold: false, failed: false };
	if (
		warmSlotLocked({ busy: cur.busy, mintedOrRefreshedAtMs: cur.mintedOrRefreshedAtMs, nowMs }) ||
		warmBackoffActive(o.node, nowMs)
	) {
		recordWarmYieldDecision(
			{
				node: o.node,
				action: 'yield-refused',
				warmRepo: r.warmRepo,
				job: r.job,
				spare: r.spare,
				reason: 'listener busy, just assigned, or not confirmed idle',
			},
			nowMs
		);
		return { hold: false, failed: false };
	}
	const repo = r.warmRepo;
	const covered = r.otherWarm.some((n) => a.stillWarm(n, repo)) || r.spare >= WARM_YIELD_SPARE;
	if (!covered) return { hold: false, failed: false };
	const evicted = await evictWarmListener(
		o.node,
		cur.repo,
		warmRunnerName(o.node, cur.repo),
		a.token,
		a.gh,
		a.sh
	);
	if (!evicted) {
		logger.warn(`[warm-yield] ${o.node}: could not evict its ${cur.repo} listener for the queue`);
		return { hold: false, failed: true };
	}
	recordWarmYield(r, nowMs);
	return yielded(o.node, r, nowMs, true);
}

function yielded(
	node: string,
	r: WarmYieldRequest,
	nowMs: number,
	evicted: boolean
): WarmYieldStep {
	const reason =
		`yielded its ${held(r.warmRepo)} slot to ${r.job.repo} job ${r.job.jobId} ` +
		`(queued ${r.job.queuedSec}s); spare=${r.spare}` +
		(r.otherWarm.length ? ` warm=${r.otherWarm.join(',')}` : '');
	recordWarmYieldDecision(
		{ node, action: 'yield', warmRepo: r.warmRepo, job: r.job, spare: r.spare, reason },
		nowMs
	);
	logger.info(`[warm-yield] ${node}: ${reason}`);
	return { hold: true, reason: `yielded to the queue: ${reason}`, evicted };
}

/**
 * Lifts the yield of every node the warm tick READ as unable to hold a
 * listener at all. Such a node is never observed, so `warmYieldStep` never
 * runs for it and nothing else would ever lift its yield. Live
 * (fleet-manager#79): claw-1 yielded at 15:24:41Z 11-09, its maxConcurrent
 * went 2 → 1 at 15:30, and the entry stayed unlifted, its `lastDemandMs`
 * still advancing hours later. A node that could not be read is not in
 * `ineligible` and keeps its yield.
 */
export function liftYieldsOfIneligible(ineligible: ReadonlySet<string>, nowMs: number): void {
	for (const node of yieldedNodes()) {
		if (!ineligible.has(node)) continue;
		const e = warmYieldEntry(node)!;
		liftWarmYield(node, nowMs);
		suppressLogged.delete(node);
		const reason = 'the node can no longer hold a warm listener, so there is no slot to give back';
		logger.warn(`[warm-yield] ${node}: ${reason} — yield lifted`);
		recordWarmYieldDecision(
			{ node, action: 'refill', warmRepo: e.warmRepo, job: e.job, spare: e.spare, reason },
			nowMs
		);
	}
}

/** node -> the suppression episode in progress: the action its one row recorded. */
const noFillEpisodes = new Map<string, string>();

/**
 * NO FILL, NO ROTATE ONTO A WAITED-FOR NODE (warm-nofill, 2026-11-09). Turns
 * the planner's `fill` or `rotate` on a node a job is waiting for (the pass's
 * WAITING set: refused there only on capacity, and admitted with the warm
 * slot given back — the yield's own test) into `locked`, so the slot is not
 * handed to a fresh listener GitHub may give any job of that repo. Live:
 * claw-10 filled at 09:15:34Z while a cardtable job waited 246 s refused
 * "at capacity: 1/1" there; claw-4 rotated to a fresh bomberman listener at
 * 09:16:34Z.
 *
 * `keep` and the rest pass through untouched: a busy listener is never
 * touched here, and an idle one is the yield's to take, under its cover rule.
 * One `warm-refill` row per episode, an episode ending on the first tick the
 * node is not waited for. Mutates `decisions`.
 */
export function holdWarmChangesForQueue(
	decisions: Map<string, WarmCacheDecision>,
	nodes: readonly string[],
	nowMs: number
): void {
	for (const node of nodes) {
		const job = warmYieldWaitingFor(node, nowMs);
		if (!job) {
			noFillEpisodes.delete(node);
			continue;
		}
		const d = decisions.get(node);
		if (!d || (d.action !== 'fill' && d.action !== 'rotate')) continue;
		decisions.set(node, { action: 'locked' });
		const action = d.action === 'fill' ? 'fill-suppressed' : 'rotate-suppressed';
		if (noFillEpisodes.get(node) === action) continue;
		noFillEpisodes.set(node, action);
		const change = d.action === 'fill' ? `fill with ${d.repo}` : `rotate ${d.from} -> ${d.to}`;
		const reason =
			`not ${d.action === 'fill' ? 'filling' : 'rotating'} its warm slot (${change}): ` +
			`${job.repo} job ${job.jobId} has waited ${job.queuedSec}s for it, refused only on ` +
			'capacity — the slot stays free for JIT';
		// An earlier episode may have written this very row; the log keeps a
		// row only when it differs from the last, which would hide this one.
		forgetWarmDecision('warm-refill', node);
		recordWarmYieldDecision(
			{
				node,
				action,
				warmRepo: d.action === 'fill' ? null : d.from,
				job,
				spare: null,
				reason,
			},
			nowMs
		);
		logger.info(`[warm-yield] ${node}: ${reason}`);
	}
}

/** Test seam. */
export function __resetWarmYieldLogForTesting(): void {
	declinedLogged.clear();
	suppressLogged.clear();
	noFillEpisodes.clear();
}
