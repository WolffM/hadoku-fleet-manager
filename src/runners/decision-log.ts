/**
 * THE DISPATCH DECISION LOG (refactor plan §7.3, T1) — why each job went where
 * it went, and why every other node was refused it.
 *
 * Before this the winner was recorded only as job-history's `runner`, the
 * refusals only as `[dispatch] skipped run …` pm2 lines (7 days), and the
 * capacity the walk read only in the last pass's in-memory ledger. "Why did job
 * J go to node N" could not be answered after the fact, and the refactor about
 * to rewrite the dispatch code would have had no before-and-after.
 *
 * THREE WRITERS, ONE PER WAY A JOB REACHES A NODE (see the traffic model: the
 * dispatcher never sees the second path's jobs):
 *
 *   - `jit`, from `runDispatchPass` through `planTick`'s observer: every queued
 *     job the pass decided about — placed (and whether the mint worked),
 *     reserved for a backed-off run, unplaceable, held, in flight, fork-refused.
 *   - `warm-assigned`, from the same pass: a job GitHub handed straight to a
 *     `warm-*` listener, seen in the job listings the pass already read. Only
 *     jobs of runs that still had a job waiting are visible there, so this is a
 *     SAMPLE of the warm path, not a census; job-history's `runner` is the census.
 *   - `warm-listener`, from `dispatchWarmCache`: each node's slot decision
 *     (fill, keep, rotate, idle, locked, withheld, never-warm and why) — the
 *     placement decision the warm path actually makes, keyed by node, so a
 *     `warm-*` runner in job-history joins to why that node held that repo.
 *
 * WRITTEN ONLY WHEN THE DECISION CHANGES. Dispatch runs every 15 s, and a job
 * waiting an hour must not leave 240 copies of one refusal. Each job (or warm
 * node) keeps a signature — kind, outcome, winner, the candidate SET, and every
 * refusal with its digits blanked, so "queued 45s < 300s" and "queued 60s <
 * 300s" are one decision. The full text and figures are still in the row that
 * is written. The signatures are module memory, LOST ON RESTART (mgmt-api
 * restarts dozens of times a day): the first pass after a restart writes one
 * duplicate row for every job still queued and every warm node. That is the
 * accepted cost — persisting the signatures would put a read-modify-write on
 * the 15 s path to save a row per job per restart.
 *
 * NEVER BREAKS OR SLOWS A PASS. Every entry point catches, warns (rate
 * limited, with a count of what it suppressed) and returns. No GitHub call, no
 * ssh — every figure is one the pass already held. Placement reads nothing
 * from here; `placement-equivalence` tests run the same scenarios with and
 * without the sink and assert identical decisions.
 *
 * STORAGE IS THIS FILE'S BUSINESS ALONE, so a move to SQLite touches only it.
 * Today: one JSONL file per UTC day under `<stateDir>/dispatch-decisions/`,
 * appended (one `appendFileSync` per pass, so a crash costs at most a torn
 * last line, which the reader counts and skips). Retention is by whole day
 * file — {@link DECISION_RETENTION_DAYS}, one past job-history's window so
 * every job-history row can still join — with a byte cap,
 * {@link DECISION_LOG_MAX_BYTES}, that drops the oldest days first and WARNS
 * when that cuts inside the retention window.
 */
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import { logger, stateDir } from '../host.js';
import { RETENTION_DAYS } from '../job-history.js';
import type { PlanObservation } from './dispatcher.js';
import { busyOf, type NodeState, type WalkKey } from './placement.js';

export const DECISION_SCHEMA = 1;
export const DECISION_LOG_DIR = 'dispatch-decisions';
/** One day past job-history's window, so every job it holds still joins here. */
export const DECISION_RETENTION_DAYS = RETENTION_DAYS + 1;
/**
 * The byte cap across every day file. The original estimate (~13 MB/day from
 * a placed-job row size times an assumed job count) missed the dominant cost:
 * `unplaceable`/`held` rows, which carry every candidate's refusal plus the
 * full capacity table and get rewritten on every wording flap (see
 * `refusalCategory`). Measured live, 2026-10-29 00:00-00:35Z, BEFORE that fix:
 * 768 rows / 2.68 MB in 35 min, ~108 MB/day — the 320 MiB cap held ~3 days,
 * not the 15-day window.
 *
 * Replaying a copy of that window plus the preceding day (874 rows / 3.05 MB
 * total) through the new, category-based signature: 661 rows / 2.23 MB, a
 * 24% row / 27% byte cut. Replay script committed as
 * `docs/planning/wave5a-decision-replay.mjs` (private) —
 * `node wave5a-decision-replay.mjs 2026-10-28.jsonl 2026-10-29.jsonl` against
 * local copies of the two files. The same replay, re-run after fixing a
 * send-back regression (the unmatched-reason fallback hashed the RAW
 * sentence, including its own moving digits, instead of a blanked one; two
 * refusal shapes with no category — `slow tier`/`slow kind`'s spill hold,
 * `placement`'s OOM-derived memory floor — would therefore have flapped on
 * their own numbers) produced the SAME counts: neither shape collided with
 * another in this snapshot, so the regression changed correctness, not the
 * measured rate. Coverage check on both files: every refusal reason observed
 * (5,737 of them) now maps to a NAMED category — zero fall to `other:`.
 *
 * Projected from the two measured windows, the fix leaves ~61-79 MB/day; at
 * the higher figure {@link DECISION_RETENTION_DAYS} (15) days needs ~1.1 GB.
 * This cap is ~1.5x that floor; hitting it means the row rate changed again,
 * and the warning says so.
 */
export const DECISION_LOG_MAX_BYTES = 1536 * 1024 * 1024;

const DAY_MS = 86_400_000;

export type DecisionPath = 'jit' | 'warm';

export type DecisionKind =
	| 'placed'
	| 'reserved'
	| 'unplaceable'
	| 'held'
	| 'in-flight'
	| 'fork'
	| 'warm-assigned'
	| 'warm-listener';

/** What one node looked like to the walk at the moment of the decision. */
export interface NodeFigures {
	node: string;
	/** `busyOf` — the walk's own ranking number. */
	busy: number;
	max: number;
	/** Live JIT units charged here, this pass's earlier placements included. */
	units: number;
	standing: number;
	warmBusy: number;
	warmHeld: number;
	freeMb: number;
	requiredMb: number;
	minFreeMb: number;
	heavyJobs: number;
	runningHeavy: boolean;
	warmRepo: string | null;
	healthy: boolean;
	drained: boolean;
	/** `null` when the node carries no schedulability verdict. */
	schedulable: boolean | null;
}

export interface DecisionRule {
	/** The winner's index in `candidates`: how many nodes were asked first. */
	position: number;
	/** The node right behind the winner, and the walk term that put it behind. */
	rankedOver: { node: string; key: WalkKey } | null;
	viaAffinity: boolean;
	/** The affinity term changed the node (the counterfactual walk differed). */
	affinityMoved: boolean;
	busyAtChoice: number | null;
	/** This job's place in the pass's own order (age, band, single-node first). */
	passIndex: number | null;
}

export interface DecisionRecord {
	v: typeof DECISION_SCHEMA;
	at: string;
	path: DecisionPath;
	kind: DecisionKind;
	repo: string;
	runId: number | null;
	/** job-history's `jobId`: the join key. Null only on `warm-listener` rows. */
	jobId: number | null;
	jobName: string | null;
	labels: string[];
	event: string | null;
	/** The queue age the hold gates read; null when it could not be established. */
	queuedSec: number | null;
	heavy: boolean | null;
	/** The tick's baseline order (`orderCandidates`) — what `baseline-order` means. */
	order: string[];
	/** Every node the walk asked, in the order it asked. */
	candidates: string[];
	refused: { node: string; reason: string; holdSec?: number }[];
	winner: string | null;
	rule: DecisionRule | null;
	/** `placed` only: whether the mint that followed worked. */
	outcome: 'minted' | 'mint-failed' | null;
	/** The runner name minted, or the warm listener that took the job. */
	runner: string | null;
	error: string | null;
	/** A skip's reason, or a warm-listener decision's. */
	reason: string | null;
	/** `warm-listener` only: fill, keep, rotate, idle, locked, withheld, never-warm. */
	action: string | null;
	capacity: NodeFigures[];
	/**
	 * A short hash of `placementFingerprint` for this job's labels — what the
	 * probe backoff compares. Equal hashes across rows mean the nodes that could
	 * take the job had not changed.
	 */
	fingerprint: string | null;
}

// --------------------------------------------------------------------------
// The sink. Default: the day files. Tests swap it, or switch the log off.
// --------------------------------------------------------------------------

export type DecisionSink = (records: readonly DecisionRecord[], nowMs: number) => void;

let sink: DecisionSink | null = appendToDayFile;

/** Is the log on? `runDispatchPass` hands `planTick` no observer when not. */
export function decisionLogEnabled(): boolean {
	return sink !== null;
}

/** Test seam: `null` switches the log off entirely; a function captures rows. */
export function __setDecisionSinkForTesting(s: DecisionSink | null): void {
	sink = s;
}
/** Test seam: back to the day files. */
export function __restoreDecisionSinkForTesting(): void {
	sink = appendToDayFile;
}

// --------------------------------------------------------------------------
// Warnings: said, never thrown, and never once per 15 s tick.
// --------------------------------------------------------------------------

const WARN_EVERY_MS = 10 * 60_000;
let lastWarnMs = -Infinity;
let suppressedWarnings = 0;

function warn(what: string, err: unknown, nowMs: number): void {
	if (nowMs - lastWarnMs < WARN_EVERY_MS) {
		suppressedWarnings++;
		return;
	}
	const extra = suppressedWarnings ? ` (${suppressedWarnings} more since the last warning)` : '';
	lastWarnMs = nowMs;
	suppressedWarnings = 0;
	const msg = err instanceof Error ? err.message : String(err);
	logger.warn(`[decision-log] ${what}: ${msg}${extra} — dispatch is unaffected`);
}

// --------------------------------------------------------------------------
// Dedup: write when the decision changes.
// --------------------------------------------------------------------------

/** key -> the last written signature, and when the key was last seen. */
const lastWritten = new Map<string, { sig: string; seenMs: number }>();
/** A key unseen this long has left the queue; forgetting it costs nothing. */
const FORGET_AFTER_MS = 6 * 60 * 60_000;
let lastForgetMs = 0;

const blankDigits = (s: string | null): string => (s ?? '').replace(/\d+(\.\d+)?/g, '#');

function keyOf(r: DecisionRecord): string {
	return r.kind === 'warm-listener'
		? `warm-listener:${r.winner ?? r.candidates[0] ?? ''}`
		: `${r.kind === 'warm-assigned' ? 'warm' : 'jit'}:${r.repo}#${r.jobId ?? r.runId}`;
}

/**
 * The refusal's CATEGORY, not its literal sentence. Three mechanisms answer
 * the same question — "does this node have room for this job right now" —
 * and flip between each other on their own clock as other jobs start and
 * stop: a free-slot count (`at capacity`), hokon's reserved-overflow count
 * (`reserved for`), and a memory headroom check (`memory:`). The 2026-10-29
 * incident was one job whose candidate set never changed, where hokon's
 * reason flapped `reserved` <-> `at capacity` and claw-8's flapped `memory`
 * <-> `at capacity`: 29 rows in 32 minutes, each the full row with all nine
 * refusals and the capacity table, because `blankDigits` alone still left the
 * wording different. A structural refusal — a label, an exclusion, a drain,
 * the heavy hold — is config, not a live reading, so it keeps its own
 * category: unlike capacity it does not flap pass to pass. `slow tier`/`slow
 * kind` (the spill gate holding a job for a faster node) and `placement`
 * (the OOM-derived memory floor) are their own categories for the same
 * reason — each is a HOLD whose own digits (queued seconds, the floor in MB)
 * move every pass while the decision does not; counted across both measured
 * snapshot day files, both were previously unmatched and fell to the
 * fallback below, where they would have flapped on their own numbers.
 *
 * Unmatched text (a refusal shape nothing here has seen) is its own category
 * too, so a genuinely new reason still writes rather than silently joining
 * `other` across different ones — but BLANKED, like every category here:
 * the raw sentence still carries the moving digits (`queued 123s < 456s`),
 * and an unmatched fallback that kept them would flap worse than writing
 * nothing changed at all, which is the bug this comment is itself a fix for
 * (the first version of this file used the raw sentence here).
 */
const REFUSAL_CATEGORIES: readonly [RegExp, string][] = [
	[/^drained:/, 'drained'],
	[/^repo excluded here:/, 'excluded'],
	[/^does not carry/, 'label'],
	[/^heavy hold:/, 'heavy-hold'],
	[/^fork/, 'fork'],
	[/^at capacity:/, 'capacity'],
	[/^reserved for /, 'capacity'],
	[/^memory:/, 'capacity'],
	[/^slow (tier|kind):/, 'slow-hold'],
	[/^placement:/, 'placement'],
];

export function refusalCategory(reason: string | null | undefined): string {
	const s = reason ?? '';
	for (const [re, cat] of REFUSAL_CATEGORIES) if (re.test(s)) return cat;
	return `other:${blankDigits(s)}`;
}

/**
 * What makes two rows the same decision. `held` is folded into `unplaceable`:
 * a backed-off job alternates the two every probe while nothing changed. A
 * refusal's CATEGORY is compared, not its literal text (`refusalCategory`) —
 * the full reason stays on the row that IS written, so "why" is still
 * queryable; only the decision of whether to write a new row ignores the
 * capacity mechanism's wording.
 */
export function decisionSignature(r: DecisionRecord): string {
	return JSON.stringify([
		r.kind === 'held' ? 'unplaceable' : r.kind,
		r.outcome,
		r.winner,
		r.action,
		r.runner,
		[...r.candidates].sort(),
		[...r.refused]
			.map((x) => `${x.node}=${refusalCategory(x.reason)}`)
			.sort()
			.join('|'),
		blankDigits(r.reason),
		blankDigits(r.error),
	]);
}

/**
 * Keep the rows whose decision changed, then write them. Signatures are
 * recorded only after the sink succeeds, so a failed write is retried on the
 * next pass rather than lost.
 */
export function emitDecisions(
	records: readonly DecisionRecord[],
	nowMs: number,
	/** Fills fields that are not part of the signature, on the rows being written only. */
	enrich?: (r: DecisionRecord) => void
): number {
	const write = sink;
	if (!write || !records.length) return 0;
	try {
		const changed: { r: DecisionRecord; key: string; sig: string }[] = [];
		const batch = new Set<string>();
		for (const r of records) {
			const key = keyOf(r);
			const sig = decisionSignature(r);
			const prev = lastWritten.get(key);
			if (prev) prev.seenMs = nowMs;
			if (prev?.sig === sig || batch.has(`${key}\0${sig}`)) continue;
			batch.add(`${key}\0${sig}`);
			changed.push({ r, key, sig });
		}
		forgetStale(nowMs);
		if (!changed.length) return 0;
		if (enrich) for (const c of changed) enrich(c.r);
		write(
			changed.map((c) => c.r),
			nowMs
		);
		for (const c of changed) lastWritten.set(c.key, { sig: c.sig, seenMs: nowMs });
		return changed.length;
	} catch (err) {
		warn('could not record dispatch decisions', err, nowMs);
		return 0;
	}
}

function forgetStale(nowMs: number): void {
	if (nowMs - lastForgetMs < 10 * 60_000) return;
	lastForgetMs = nowMs;
	for (const [k, v] of lastWritten) if (nowMs - v.seenMs > FORGET_AFTER_MS) lastWritten.delete(k);
}

/** Test seam: what a restart does to the dedup memory. */
export function __resetDecisionLogForTesting(): void {
	lastWritten.clear();
	lastForgetMs = 0;
	lastWarnMs = -Infinity;
	suppressedWarnings = 0;
	prunedDay = null;
	bytesSincePrune = 0;
	bytesAtPrune = 0;
}

// --------------------------------------------------------------------------
// Building rows.
// --------------------------------------------------------------------------

export function nodeFigures(m: NodeState): NodeFigures {
	return {
		node: m.name,
		busy: busyOf(m),
		max: m.maxConcurrent,
		units: m.liveUnits,
		standing: m.standingBusy,
		warmBusy: m.warmBusy ?? 0,
		warmHeld: m.warmHeld ?? 0,
		freeMb: m.freeMb,
		requiredMb: m.requiredMb,
		minFreeMb: m.minFreeMb,
		heavyJobs: m.heavyJobs ?? 0,
		runningHeavy: m.runningHeavy ?? false,
		warmRepo: m.warmRepo ?? null,
		healthy: m.healthy,
		drained: m.drained ?? false,
		schedulable: m.schedulable ?? null,
	};
}

/** A short, stable hash of a fingerprint string. */
export function fingerprintHash(fp: string): string {
	return createHash('sha1').update(fp).digest('hex').slice(0, 12);
}

const roundSec = (s: number | undefined): number | null =>
	s === undefined ? null : Math.round(s * 10) / 10;

function blank(at: string, path: DecisionPath, kind: DecisionKind, repo: string): DecisionRecord {
	return {
		v: DECISION_SCHEMA,
		at,
		path,
		kind,
		repo,
		runId: null,
		jobId: null,
		jobName: null,
		labels: [],
		event: null,
		queuedSec: null,
		heavy: null,
		order: [],
		candidates: [],
		refused: [],
		winner: null,
		rule: null,
		outcome: null,
		runner: null,
		error: null,
		reason: null,
		action: null,
		capacity: [],
		fingerprint: null,
	};
}

/**
 * The JIT half: collects {@link PlanObservation}s during `planTick`, learns
 * each mint's result, and writes the changed decisions at the end of the pass.
 * Every method catches: an observer that throws would throw out of planTick.
 */
export class JitDecisionBook {
	private readonly rows = new Map<number, DecisionRecord>();
	private readonly at: string;
	private broken = false;

	constructor(
		private readonly nowMs: number,
		private readonly order: readonly string[],
		/** `placementFingerprint` for one job, from the tick that owns it. */
		private readonly fingerprintFor?: (repo: string, labels: readonly string[]) => string
	) {
		this.at = new Date(nowMs).toISOString();
	}

	/** planTick's observer. Copies what it needs inside the call; keeps no node. */
	readonly observe = (o: PlanObservation): void => {
		if (this.broken) return;
		try {
			const r = blank(this.at, 'jit', o.outcome, o.run.repo);
			r.runId = o.run.id;
			r.jobId = o.run.jobId;
			r.jobName = o.run.jobName ?? null;
			r.labels = [...(o.run.labels ?? [])];
			r.event = o.run.event ?? null;
			r.queuedSec = roundSec(o.queuedSec);
			r.order = [...this.order];
			r.reason = o.reason ?? null;
			r.capacity = o.candidates.map(nodeFigures);
			const p = o.placed;
			if (p) {
				r.heavy = p.heavy;
				r.candidates = [...(p.walk ?? [])];
				r.refused = p.passed.map((x) => ({ ...x }));
				r.winner = p.node ?? null;
				if (p.node) {
					r.rule = {
						position: r.candidates.indexOf(p.node),
						rankedOver: p.rankedOver ? { ...p.rankedOver } : null,
						viaAffinity: p.viaAffinity,
						affinityMoved: o.affinityMoved ?? false,
						busyAtChoice: o.busyAtChoice ?? null,
						passIndex: o.passIndex,
					};
				}
			}
			this.rows.set(o.run.jobId, r);
		} catch (err) {
			this.broken = true;
			warn('could not observe a placement', err, this.nowMs);
		}
	};

	/** What the mint for a placed job did. */
	minted(jobId: number, runnerName: string, res: { ok: boolean; reason?: string }): void {
		const r = this.rows.get(jobId);
		if (!r) return;
		r.outcome = res.ok ? 'minted' : 'mint-failed';
		r.runner = runnerName;
		r.error = res.ok ? null : (res.reason ?? 'unknown');
	}

	/** Write the pass's changed decisions. Returns how many rows were written. */
	flush(): number {
		if (this.broken) return 0;
		try {
			const fp = this.fingerprintFor;
			// Hashed only for the rows that changed: most passes write nothing.
			return emitDecisions([...this.rows.values()], this.nowMs, (r) => {
				if (fp && r.kind !== 'in-flight' && r.kind !== 'fork') {
					r.fingerprint = fingerprintHash(fp(r.repo, r.labels));
				}
			});
		} catch (err) {
			warn('could not record dispatch decisions', err, this.nowMs);
			return 0;
		}
	}
}

/** A job GitHub gave a `warm-*` listener directly, seen in the pass's listings. */
export interface WarmAssignment {
	repo: string;
	runner: string;
	jobName: string;
	jobId?: number;
	runId?: number;
}

/** The warm path's per-job rows. Jobs with no id in the listing are skipped. */
export function recordWarmAssignments(
	jobs: readonly WarmAssignment[],
	nodeOfRunner: (runner: string) => string,
	nodes: readonly NodeState[],
	nowMs: number
): number {
	if (!sink || !jobs.length) return 0;
	try {
		const at = new Date(nowMs).toISOString();
		const byName = new Map(nodes.map((n) => [n.name, n]));
		const rows: DecisionRecord[] = [];
		for (const j of jobs) {
			if (j.jobId === undefined) continue;
			const node = nodeOfRunner(j.runner);
			const r = blank(at, 'warm', 'warm-assigned', j.repo);
			r.runId = j.runId ?? null;
			r.jobId = j.jobId;
			r.jobName = j.jobName;
			r.winner = node;
			r.candidates = [node];
			r.runner = j.runner;
			r.reason = `GitHub assigned it to ${node}'s warm listener for ${j.repo}`;
			const m = byName.get(node);
			r.capacity = m ? [nodeFigures(m)] : [];
			rows.push(r);
		}
		return emitDecisions(rows, nowMs);
	} catch (err) {
		warn('could not record warm assignments', err, nowMs);
		return 0;
	}
}

/** One node's warm-cache slot decision this tick. */
export interface WarmListenerDecision {
	node: string;
	action: 'fill' | 'keep' | 'rotate' | 'idle' | 'locked' | 'withheld' | 'never-warm';
	/** The repo the slot holds or is being given. */
	repo: string | null;
	/** The repo a rotate takes the slot from. */
	from?: string | null;
	reason: string | null;
}

/** The warm cache's per-node rows. */
export function recordWarmListenerDecisions(
	/** Built only when the log is on, and inside the catch: a throw here is a warning. */
	build: () => readonly WarmListenerDecision[],
	nowMs: number
): number {
	if (!sink) return 0;
	try {
		const decisions = build();
		if (!decisions.length) return 0;
		const at = new Date(nowMs).toISOString();
		const rows = decisions.map((d) => {
			const r = blank(at, 'warm', 'warm-listener', d.repo ?? d.from ?? '');
			r.winner = d.node;
			r.candidates = [d.node];
			r.action = d.action;
			r.reason = d.from ? `${d.from} -> ${d.repo}${d.reason ? `: ${d.reason}` : ''}` : d.reason;
			return r;
		});
		return emitDecisions(rows, nowMs);
	} catch (err) {
		warn('could not record warm listener decisions', err, nowMs);
		return 0;
	}
}

// --------------------------------------------------------------------------
// Storage: day files, appended, pruned by whole day.
// --------------------------------------------------------------------------

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function decisionLogDir(root: string = stateDir()): string {
	return join(root, DECISION_LOG_DIR);
}

let prunedDay: string | null = null;
let bytesAtPrune = 0;
let bytesSincePrune = 0;

function appendToDayFile(records: readonly DecisionRecord[], nowMs: number): void {
	const dir = decisionLogDir();
	const day = utcDay(nowMs);
	if (prunedDay !== day || bytesAtPrune + bytesSincePrune > DECISION_LOG_MAX_BYTES) {
		const pruned = pruneDecisionLog(dir, nowMs);
		prunedDay = day;
		bytesAtPrune = pruned.bytes;
		bytesSincePrune = 0;
		if (pruned.overCap) {
			throw new Error(
				`today's file alone is over the ${DECISION_LOG_MAX_BYTES}-byte cap; not recording until the next day`
			);
		}
	}
	mkdirSync(dir, { recursive: true });
	const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
	// ONE append per pass: O_APPEND keeps a concurrent reader from seeing a
	// half-written batch interleaved with another, and a crash mid-write costs
	// at most the torn tail the reader counts and skips.
	appendFileSync(join(dir, `${day}.jsonl`), text);
	bytesSincePrune += Buffer.byteLength(text);
}

export interface PruneResult {
	/** Bytes kept. */
	bytes: number;
	removed: string[];
	/** Day files the CAP removed although they were inside the retention window. */
	trimmedInWindow: string[];
	/** Today's file alone exceeds the cap. */
	overCap: boolean;
}

/** Drop day files past retention, then the oldest until under the byte cap. */
export function pruneDecisionLog(
	dir: string,
	nowMs: number,
	maxBytes: number = DECISION_LOG_MAX_BYTES
): PruneResult {
	const res: PruneResult = { bytes: 0, removed: [], trimmedInWindow: [], overCap: false };
	if (!existsSync(dir)) return res;
	const oldest = utcDay(nowMs - DECISION_RETENTION_DAYS * DAY_MS);
	const today = utcDay(nowMs);
	const files = readdirSync(dir)
		.flatMap((f) => {
			const m = DAY_FILE.exec(f);
			return m ? [{ f, day: m[1], bytes: statSync(join(dir, f)).size }] : [];
		})
		.sort((a, b) => a.day.localeCompare(b.day));
	const kept: typeof files = [];
	for (const x of files) {
		if (x.day < oldest) {
			unlinkSync(join(dir, x.f));
			res.removed.push(x.f);
		} else kept.push(x);
	}
	let total = kept.reduce((s, x) => s + x.bytes, 0);
	while (total > maxBytes && kept.length && kept[0].day !== today) {
		const x = kept.shift()!;
		unlinkSync(join(dir, x.f));
		res.removed.push(x.f);
		res.trimmedInWindow.push(x.f);
		total -= x.bytes;
	}
	res.bytes = total;
	res.overCap = total > maxBytes;
	if (res.trimmedInWindow.length) {
		logger.warn(
			`[decision-log] over the ${maxBytes}-byte cap: removed ${res.trimmedInWindow.join(', ')}, ` +
				`inside the ${DECISION_RETENTION_DAYS}-day window — those days no longer join to job-history`
		);
	}
	return res;
}

export interface DecisionRead {
	records: DecisionRecord[];
	/** Day files read. */
	files: number;
	/** Lines that did not parse — a torn tail is one; many is a different fact. */
	badLines: number;
	/** Day files that exist and could not be read, with why. */
	unreadable: { file: string; why: string }[];
}

/**
 * Every row with `sinceMs <= at < untilMs`, oldest first. Reads only the day
 * files that can hold such a row. A missing directory throws: "no log" is a
 * different answer from "no decisions".
 */
export function readDecisions(
	dir: string,
	opts: { sinceMs?: number; untilMs?: number } = {}
): DecisionRead {
	const sinceMs = opts.sinceMs ?? 0;
	const untilMs = opts.untilMs ?? Infinity;
	const firstDay = utcDay(sinceMs);
	const out: DecisionRead = { records: [], files: 0, badLines: 0, unreadable: [] };
	const files = readdirSync(dir)
		.filter((f) => {
			const m = DAY_FILE.exec(f);
			return m !== null && m[1] >= firstDay;
		})
		.sort();
	for (const f of files) {
		let raw: string;
		try {
			raw = readFileSync(join(dir, f), 'utf8');
		} catch (err) {
			out.unreadable.push({ file: f, why: err instanceof Error ? err.message : String(err) });
			continue;
		}
		out.files++;
		for (const line of raw.split('\n')) {
			if (!line.trim()) continue;
			let r: DecisionRecord;
			try {
				r = JSON.parse(line) as DecisionRecord;
			} catch {
				out.badLines++;
				continue;
			}
			const t = Date.parse(r.at);
			if (!Number.isFinite(t)) {
				out.badLines++;
				continue;
			}
			if (t >= sinceMs && t < untilMs) out.records.push(r);
		}
	}
	out.records.sort((a, b) => a.at.localeCompare(b.at));
	return out;
}

export interface DecisionFilter {
	jobId?: number;
	runId?: number;
	node?: string;
	repo?: string;
}

/** Rows about a job, a run, a repo, or a node (won it, or refused it). */
export function filterDecisions(
	records: readonly DecisionRecord[],
	f: DecisionFilter
): DecisionRecord[] {
	return records.filter(
		(r) =>
			(f.jobId === undefined || r.jobId === f.jobId) &&
			(f.runId === undefined || r.runId === f.runId) &&
			(f.repo === undefined || r.repo === f.repo) &&
			(f.node === undefined || r.winner === f.node || r.refused.some((x) => x.node === f.node))
	);
}
