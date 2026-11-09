/**
 * THE WARM-YIELD BOOK — which nodes gave their warm listener's slot to the
 * queue, and what the dispatcher last asked of them (warm-yield, operator
 * 2026-11-09: "if there are more claws available than we need to handle normal
 * CI, then it's okay for some to give up their slot to help the queue").
 *
 * Two writers' worth of facts, one owner:
 *
 *   - REQUESTS and DEMAND come from the dispatch pass (`warm-yield.ts`), every
 *     15 s: which node should give its slot to which waiting job, and which
 *     nodes a queued job was refused by on capacity alone.
 *   - YIELDS come from the warm tick (`dispatch-warm-cache.ts`), every 60 s:
 *     the listener was evicted, so the node stops holding a slot for one, and
 *     the warm planner may not refill it while a job is still waiting for that
 *     node or for {@link WARM_YIELD_COOLDOWN_MS} after the last one.
 *
 * The reservation a yield releases is read in `buildNodeStates`
 * (`ephemeral-tick-nodestate.ts`), so the node's whole `maxConcurrent` is the
 * mint budget again. The ceiling itself never moves.
 *
 * On disk for two readers in other places: `fleet warm-canary` (another
 * process), which must not call a node that yielded "not warm", and this
 * process after a restart, which must not refill a yielded node in the middle
 * of the queue it yielded to. Lost or unreadable, the book is empty: every
 * eligible node is refilled and the canary scores every node, which is the
 * strict direction for both.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../host.js';
import { writeJsonAtomic } from '../lib/atomic-json.js';

/**
 * How long a job must have been unplaceable before a warm slot yields to it.
 *
 * 60 s, from the decision logs (`~/.hadoku-mgmt/dispatch-decisions/`,
 * 2026-11-06..09): of 4,108 jobs without a jdk label, 75% were placed by a
 * queue age of 55 s, while the median jdk21 job placed at 81 s and its p90 at
 * 1,831 s. A job still waiting at 60 s is past the point where the next
 * pass or two would normally have found it a slot, so a yield then is aimed
 * at a real wait, not at the churn of an ordinary minute.
 */
export const WARM_YIELD_AFTER_MS = 60_000;

/**
 * How many OTHER claws must be able to mint the warm listener's repo right
 * now before its slot may go — when no other warm listener for that repo is
 * live. Two, so that losing one listener never leaves that repo's next job a
 * single place to land.
 */
export const WARM_YIELD_SPARE = 2;

/**
 * How long after the last job waiting for a yielded node the warm planner
 * still leaves its slot empty. The hysteresis: without it a queue that pauses
 * for one warm tick would refill the slot and yield it again on the next job,
 * paying a delete, a registration and a provisioning ssh each way.
 */
export const WARM_YIELD_COOLDOWN_MS = 10 * 60_000;

/**
 * A request older than this is not acted on: the pass that wrote it saw a job
 * that has had three passes to be placed or to leave the queue since.
 */
export const WARM_YIELD_REQUEST_TTL_MS = 45_000;

/**
 * How long after a yield lifts the warm cache may take to refill the node:
 * one warm tick to come round, plus a mint. The same figure, and the same
 * measurement, as `HEAVY_MARK_REFILL_MS`.
 */
export const WARM_YIELD_REFILL_MS = 120_000;

/**
 * A yield the warm tick has not re-confirmed within this long is not trusted
 * by the canary: the writer stopped, so the node is scored like any other.
 */
export const WARM_YIELD_CONFIRM_STALE_MS = 5 * 60_000;

export const WARM_YIELDS_FILE = 'warm-yields.json';

/** One waiting job a slot could go to. */
export interface WarmYieldJob {
	repo: string;
	runId: number;
	jobId: number;
	jobName?: string;
	/** Seconds the job had been queued when the pass asked. */
	queuedSec: number;
}

/** The dispatch pass asking `node` to give its warm slot to `job`. */
export interface WarmYieldRequest {
	node: string;
	/**
	 * The repo the node's verified-live listener holds, or `null` when the pass
	 * saw no live listener in the slot it reserves: a node the warm cache is
	 * keeping empty (a heavy job, say) still holds the slot back from the mint
	 * budget. The warm tick releases such a slot only on the node's own word
	 * that no listener is there.
	 */
	warmRepo: string | null;
	job: WarmYieldJob;
	/** Other claws that could mint `warmRepo`'s job right now. */
	spare: number;
	/** Other nodes holding a verified-live listener for `warmRepo`. */
	otherWarm: string[];
	atMs: number;
}

/** A node whose listener was evicted for the queue. */
export interface WarmYieldEntry {
	/** `null`: the slot held no listener when it yielded. */
	warmRepo: string | null;
	job: WarmYieldJob;
	spare: number;
	yieldedAtMs: number;
	/** The last pass that saw a job wait for this node on capacity. */
	lastDemandMs: number;
	/** The last warm tick that kept the slot empty. */
	confirmedAtMs: number;
	/** When the warm planner was allowed to refill it; `null` while yielded. */
	liftedAtMs: number | null;
}

export type WarmYieldDoc = Readonly<Record<string, WarmYieldEntry>>;

let requests = new Map<string, WarmYieldRequest>();
/** node -> the oldest job the last pass saw waiting for it (see {@link setWarmYieldWaiting}). */
let waiting = new Map<string, { job: WarmYieldJob; atMs: number }>();
let entries: Map<string, WarmYieldEntry> | null = null;
let fileDir: string | null = null;

function book(): Map<string, WarmYieldEntry> {
	if (entries) return entries;
	const doc = readWarmYields();
	entries = new Map(Object.entries(doc ?? {}));
	return entries;
}

function persist(): void {
	writeJsonAtomic(join(fileDir ?? stateDir(), WARM_YIELDS_FILE), Object.fromEntries(book()), {
		fsync: false,
	});
}

/**
 * The yields on disk: `{}` when there is no file yet, `null` when there is one
 * that does not parse, so a caller can say it could not read them.
 */
export function readWarmYields(dir = fileDir ?? stateDir()): WarmYieldDoc | null {
	const path = join(dir, WARM_YIELDS_FILE);
	if (!existsSync(path)) return {};
	try {
		const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
		if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
		const out: Record<string, WarmYieldEntry> = {};
		for (const [node, e] of Object.entries(doc as Record<string, unknown>)) {
			const v = e as Partial<WarmYieldEntry> | null;
			if (
				v &&
				(typeof v.warmRepo === 'string' || v.warmRepo === null) &&
				Number.isFinite(v.yieldedAtMs) &&
				Number.isFinite(v.lastDemandMs) &&
				Number.isFinite(v.confirmedAtMs)
			)
				out[node] = v as WarmYieldEntry;
		}
		return out;
	} catch {
		return null;
	}
}

/**
 * Does the yield book explain why `node` holds no listener right now? The
 * yield itself while the warm tick keeps confirming it, then the refill window
 * after it lifts. Returns how long ago the node yielded, or `null`.
 */
export function warmYieldWithholds(doc: WarmYieldDoc, node: string, nowMs: number): number | null {
	const e = doc[node];
	if (!e) return null;
	const live =
		e.liftedAtMs === null || e.liftedAtMs === undefined
			? nowMs - e.confirmedAtMs < WARM_YIELD_CONFIRM_STALE_MS
			: nowMs - e.liftedAtMs < WARM_YIELD_REFILL_MS;
	return live ? Math.max(0, nowMs - e.yieldedAtMs) : null;
}

/** The pass's requests, replacing the last pass's wholesale. */
export function setWarmYieldRequests(next: readonly WarmYieldRequest[]): void {
	requests = new Map(next.map((r) => [r.node, r]));
}

/** The live request for `node`, if the last pass made one recently enough. */
export function warmYieldRequestFor(node: string, nowMs: number): WarmYieldRequest | undefined {
	const r = requests.get(node);
	return r && nowMs - r.atMs <= WARM_YIELD_REQUEST_TTL_MS ? r : undefined;
}

/**
 * The pass's WAITING set, replacing the last pass's wholesale: every node a
 * job has waited {@link WARM_YIELD_AFTER_MS} for, refused there only on
 * capacity, and that node would admit with its warm slot given back — the
 * same test a request is made from, for every such node, not only the one a
 * request names. The warm planner may not fill or rotate these
 * (warm-nofill, 2026-11-09).
 */
export function setWarmYieldWaiting(next: ReadonlyMap<string, WarmYieldJob>, nowMs: number): void {
	waiting = new Map([...next].map(([node, job]) => [node, { job, atMs: nowMs }]));
}

/** The job waiting for `node`, if the last pass saw one recently enough. */
export function warmYieldWaitingFor(node: string, nowMs: number): WarmYieldJob | undefined {
	const w = waiting.get(node);
	return w && nowMs - w.atMs <= WARM_YIELD_REQUEST_TTL_MS ? w.job : undefined;
}

/** A job waited for each of these nodes on capacity this pass. */
export function noteWarmYieldDemand(nodes: Iterable<string>, nowMs: number): void {
	const b = book();
	for (const n of nodes) {
		const e = b.get(n);
		if (e && e.liftedAtMs === null) e.lastDemandMs = Math.max(e.lastDemandMs, nowMs);
	}
}

/** Is `node`'s slot given to the queue right now (its reservation released)? */
export function warmSlotYielded(node: string): boolean {
	const e = book().get(node);
	return e !== undefined && e.liftedAtMs === null;
}

/** Every node whose slot is given to the queue right now. */
export function yieldedNodes(): string[] {
	return [...book()].filter(([, e]) => e.liftedAtMs === null).map(([node]) => node);
}

export function warmYieldEntry(node: string): WarmYieldEntry | undefined {
	return book().get(node);
}

/** The warm tick evicted `node`'s listener for `r`. */
export function recordWarmYield(r: WarmYieldRequest, nowMs: number): void {
	book().set(r.node, {
		warmRepo: r.warmRepo,
		job: r.job,
		spare: r.spare,
		yieldedAtMs: nowMs,
		lastDemandMs: nowMs,
		confirmedAtMs: nowMs,
		liftedAtMs: null,
	});
	requests.delete(r.node);
	persist();
}

/** The warm tick kept `node`'s slot empty this tick. */
export function confirmWarmYield(node: string, nowMs: number): void {
	const e = book().get(node);
	if (!e) return;
	e.confirmedAtMs = nowMs;
	persist();
}

/** The warm planner may refill `node` from now on. */
export function liftWarmYield(node: string, nowMs: number): void {
	const e = book().get(node);
	if (!e) return;
	e.liftedAtMs = nowMs;
	persist();
}

/** Drops lifted entries the canary no longer needs. */
export function pruneWarmYields(nowMs: number): void {
	const b = book();
	let changed = false;
	for (const [node, e] of b) {
		if (e.liftedAtMs !== null && nowMs - e.liftedAtMs >= WARM_YIELD_REFILL_MS) {
			b.delete(node);
			changed = true;
		}
	}
	if (changed) persist();
}

/** Test seam: an empty book, read from and written to `dir` (null = stateDir). */
export function __resetWarmYieldsForTesting(dir: string | null = null): void {
	requests = new Map();
	waiting = new Map();
	entries = null;
	fileDir = dir;
}
