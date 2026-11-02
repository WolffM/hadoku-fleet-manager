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
 * THIS FILE'S OWN JOB, after the wave shrink-1 split, is just the two things
 * nothing else here does: deciding whether a decision CHANGED since the last
 * one written (dedup, below) and holding the sink that takes rows once it
 * has. The row shapes live in `decision-log-types.ts`, building rows for the
 * JIT and warm paths lives in `decision-log-record.ts`, and the day-file
 * storage lives in `decision-log-storage.ts` — each re-exported here under
 * its original name, so every existing importer of `decision-log.js` keeps
 * compiling unchanged.
 */
import { logger } from '../host.js';
import {
	DECISION_SCHEMA,
	type DecisionPath,
	type DecisionKind,
	type NodeFigures,
	type DecisionRule,
	type DecisionRecord,
} from './decision-log-types.js';
import {
	DECISION_LOG_DIR,
	DECISION_RETENTION_DAYS,
	DECISION_LOG_MAX_BYTES,
	decisionLogDir,
	appendToDayFile,
	__resetDecisionStorageForTesting,
	pruneDecisionLog,
	readDecisions,
	filterDecisions,
	type PruneResult,
	type DecisionRead,
	type DecisionFilter,
} from './decision-log-storage.js';
import {
	fingerprintHash,
	JitDecisionBook,
	recordWarmAssignments,
	recordWarmListenerDecisions,
	type JitPlacementObservation,
	type WarmAssignment,
	type WarmListenerDecision,
} from './decision-log-record.js';

export {
	DECISION_SCHEMA,
	type DecisionPath,
	type DecisionKind,
	type NodeFigures,
	type DecisionRule,
	type DecisionRecord,
};
export {
	DECISION_LOG_DIR,
	DECISION_RETENTION_DAYS,
	DECISION_LOG_MAX_BYTES,
	decisionLogDir,
	pruneDecisionLog,
	readDecisions,
	filterDecisions,
	type PruneResult,
	type DecisionRead,
	type DecisionFilter,
};
export {
	fingerprintHash,
	JitDecisionBook,
	recordWarmAssignments,
	recordWarmListenerDecisions,
	type JitPlacementObservation,
	type WarmAssignment,
	type WarmListenerDecision,
};

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

/** Exported for `decision-log-record.ts`'s own catch blocks — not public API. */
export function warn(what: string, err: unknown, nowMs: number): void {
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
	__resetDecisionStorageForTesting();
}
