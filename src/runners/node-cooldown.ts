/**
 * NODE COOLDOWN — a node that turned long work away because it was busy is
 * not offered more long work for a while, with a backoff that grows with
 * each further busy outcome and ends on a clean one (#103, operator decision
 * 2026-11-16 on hadoku_site#566). Fleet-wide: it reads every node the same.
 *
 * SHADOW, not enforced ({@link COOLDOWN_ENFORCED} is false). Every placement
 * that the cooldown WOULD have refused is recorded on its dispatch decision
 * (`cooldown`), and `fleet backstop --status` lists the cooling nodes, so
 * the would-refuse count and how each such job ended can be read before the
 * cooldown moves a single real job. A new control starts quiet.
 *
 * WHAT COUNTS. Read from job-history, which GitHub wrote, never from what
 * the dispatcher intended:
 *   - BUSY: a job CANCELLED after running at least its kind's success p90.
 *     A cancel that outlived nine successes in ten is a `timeout-minutes`
 *     cancel, not a superseded run (those die early: run 43109990294's
 *     cancels on 2026-11-11 were 103–1146 s against a p90 of ~4,060 s). Also
 *     a job that SUCCEEDED but took {@link COOLDOWN_SLOW_FACTOR} x its kind's
 *     p90: done, but on a node too busy to do it at the lane's pace.
 *   - CLEAN: a success within its kind's p90. It resets the streak and ends
 *     the cooldown. A success between p90 and the slow bar is neither: on
 *     2026-11-16 a forge-e2e that finished at 4,499 s of a 4,500 s limit on
 *     hokon would otherwise have vouched for the node two hours before two
 *     more shards there timed out.
 *   - NEUTRAL: everything else. A failure is the product's red until shown
 *     otherwise (`node-regression.ts` owns that question), and a kind with
 *     fewer than {@link COOLDOWN_NORM_MIN_SUCCESSES} successes has no norm.
 *
 * ONLY LONG KINDS, both ways: kinds whose success p90 is at least
 * {@link COOLDOWN_LONG_SEC}. Measured over 11-09..11-16 replaying every kind:
 * short jobs on a busy node succeed (17 of the 19 jobs a whole-node cooldown
 * would have refused on hokon succeeded), and a short success resetting the
 * streak meant no streak ever built. The load the operator measured on hokon
 * (load5 18-20 on 12 cores, from its own work) slows a 60-75 minute shard
 * past its limit; it does not stop a 30 s lint.
 *
 * REJECTIONS. A node refusing a mint is the other input the decision names.
 * It is not wired here: a `mint-failed` decision carries the mint's error,
 * not a node-side busy verdict, and there were 23 in the 8 days to 11-16, none
 * on hokon. Admission already keeps jobs off nodes without the memory.
 */
import { jobRecords, historyVersion, type JobRecord } from '../job-history-store.js';
import { finishedAtMs } from '../job-history-index.js';
import { jobKind } from '../lib/job-kind.js';
import { nodeOf } from './census.js';
import type { CooldownNote } from './decision-log-types.js';

/** Shadow: recorded, never acted on. Flipping this is the next stage, with its counts. */
export const COOLDOWN_ENFORCED = false;
/** A kind is LONG when its fleet success p90 is at least this (20 min). */
export const COOLDOWN_LONG_SEC = 1200;
/** The first cooldown, minutes. Doubles per further busy outcome. */
export const COOLDOWN_BASE_MIN = 30;
/** The longest one cooldown runs, minutes: the cap the doubling stops at. */
export const COOLDOWN_CAP_MIN = 240;
/** A success this many times its kind's p90 is a busy outcome, not a clean one. */
export const COOLDOWN_SLOW_FACTOR = 1.5;
/** A kind needs this many successes before it has a norm at all. */
export const COOLDOWN_NORM_MIN_SUCCESSES = 10;
/** How far back norms and streaks look. */
export const COOLDOWN_LOOKBACK_DAYS = 7;

export type CooldownClass = 'busy' | 'clean' | 'neutral';

const kindKey = (repo: string, name: string): string => `${repo}|${jobKind(name)}`;

function p90(xs: number[]): number {
	const a = [...xs].sort((x, y) => x - y);
	return a[Math.min(a.length - 1, Math.floor(0.9 * (a.length - 1) + 0.5))];
}

/** PURE. `repo|kind` -> success p90 seconds, for kinds with enough successes. */
export function kindNorms(
	records: readonly Readonly<JobRecord>[],
	sinceMs: number
): Map<string, number> {
	const by = new Map<string, number[]>();
	for (const r of records) {
		if (r.conclusion !== 'success' || !(Date.parse(r.startedAt) >= sinceMs)) continue;
		const k = kindKey(r.repo, r.name);
		const xs = by.get(k);
		if (xs) xs.push(r.durationSec);
		else by.set(k, [r.durationSec]);
	}
	const out = new Map<string, number>();
	for (const [k, xs] of by) if (xs.length >= COOLDOWN_NORM_MIN_SUCCESSES) out.set(k, p90(xs));
	return out;
}

/** PURE. The kind's p90 when it is a LONG kind, else null. */
export function longNorm(
	norms: ReadonlyMap<string, number>,
	repo: string,
	name: string
): number | null {
	const p = norms.get(kindKey(repo, name));
	return p !== undefined && p >= COOLDOWN_LONG_SEC ? p : null;
}

/** PURE. One finished job, judged against its kind's norm. */
export function classifyOutcome(
	r: Readonly<JobRecord>,
	norms: ReadonlyMap<string, number>
): CooldownClass {
	const p = longNorm(norms, r.repo, r.name);
	if (p === null) return 'neutral';
	if (r.conclusion === 'cancelled') return r.durationSec >= p ? 'busy' : 'neutral';
	if (r.conclusion === 'success')
		return r.durationSec >= COOLDOWN_SLOW_FACTOR * p
			? 'busy'
			: r.durationSec <= p
				? 'clean'
				: 'neutral';
	return 'neutral';
}

/** The minutes of cooldown the `streak`th busy outcome in a row earns. */
export const cooldownMinutes = (streak: number): number =>
	Math.min(COOLDOWN_CAP_MIN, COOLDOWN_BASE_MIN * 2 ** Math.max(0, streak - 1));

export interface NodeCooldown {
	node: string;
	/** Busy outcomes since the last clean one. */
	streak: number;
	/** When this cooldown ends (epoch ms). */
	untilMs: number;
	/** The busy outcome that set it. */
	last: {
		repo: string;
		name: string;
		runId: number;
		jobId: number;
		conclusion: string;
		durationSec: number;
		p90Sec: number;
		endedAt: string;
	};
}

/**
 * PURE. Every node cooling at `nowMs`. Walks each node's long-kind outcomes
 * in the order they ENDED: busy extends the streak and starts a cooldown of
 * {@link cooldownMinutes}(streak) from that end; clean resets both.
 */
export function nodeCooldowns(
	records: readonly Readonly<JobRecord>[],
	nodes: readonly string[],
	nowMs: number
): Map<string, NodeCooldown> {
	const sinceMs = nowMs - COOLDOWN_LOOKBACK_DAYS * 86_400_000;
	const norms = kindNorms(records, sinceMs);
	const judged: { node: string; end: number; cls: CooldownClass; r: Readonly<JobRecord> }[] = [];
	for (const r of records) {
		if (!(Date.parse(r.startedAt) >= sinceMs)) continue;
		const cls = classifyOutcome(r, norms);
		if (cls === 'neutral') continue;
		const node = nodeOf(r.runner, nodes);
		if (!nodes.includes(node)) continue;
		judged.push({ node, end: finishedAtMs(r), cls, r });
	}
	judged.sort((a, b) => a.end - b.end);
	const state = new Map<string, NodeCooldown | null>();
	for (const j of judged) {
		if (j.end > nowMs) continue;
		if (j.cls === 'clean') {
			state.set(j.node, null);
			continue;
		}
		const streak = (state.get(j.node)?.streak ?? 0) + 1;
		state.set(j.node, {
			node: j.node,
			streak,
			untilMs: j.end + cooldownMinutes(streak) * 60_000,
			last: {
				repo: j.r.repo,
				name: j.r.name,
				runId: j.r.runId,
				jobId: j.r.jobId,
				conclusion: j.r.conclusion,
				durationSec: j.r.durationSec,
				p90Sec: norms.get(kindKey(j.r.repo, j.r.name)) ?? 0,
				endedAt: new Date(j.end).toISOString(),
			},
		});
	}
	const out = new Map<string, NodeCooldown>();
	for (const [n, c] of state) if (c && c.untilMs > nowMs) out.set(n, c);
	return out;
}

/** One line for a cooling node: what set it, and until when. */
export function describeCooldown(c: NodeCooldown, nowMs: number): string {
	const mins = Math.ceil((c.untilMs - nowMs) / 60_000);
	const what =
		c.last.conclusion === 'cancelled'
			? `cancelled at ${c.last.durationSec}s`
			: `took ${c.last.durationSec}s`;
	return (
		`${c.node} cooling ${mins} min more (streak ${c.streak}): ${c.last.repo} ${c.last.name} ` +
		`${what}, kind p90 ${c.last.p90Sec}s`
	);
}

/**
 * The live view over the in-process job-history, recomputed only when the
 * history changes or a minute has passed (a cooldown ends on the clock).
 */
export class LiveCooldowns {
	private key = '';
	private cooling = new Map<string, NodeCooldown>();
	private norms = new Map<string, number>();

	constructor(private readonly read: () => readonly Readonly<JobRecord>[] = jobRecords) {}

	refresh(nodes: readonly string[], nowMs: number): ReadonlyMap<string, NodeCooldown> {
		const key = `${historyVersion()}|${Math.floor(nowMs / 60_000)}|${nodes.join(',')}`;
		if (key !== this.key) {
			const records = this.read();
			this.cooling = nodeCooldowns(records, nodes, nowMs);
			this.norms = kindNorms(records, nowMs - COOLDOWN_LOOKBACK_DAYS * 86_400_000);
			this.key = key;
		}
		return this.cooling;
	}

	/** The note for placing `repo`'s `jobName` on `node`, or null when it is not cooling or the job is short. */
	noteFor(node: string, repo: string, jobName: string, nowMs: number): CooldownNote | null {
		const c = this.cooling.get(node);
		if (!c || c.untilMs <= nowMs || longNorm(this.norms, repo, jobName) === null) return null;
		return {
			enforced: COOLDOWN_ENFORCED,
			streak: c.streak,
			until: new Date(c.untilMs).toISOString(),
			why: describeCooldown(c, nowMs),
		};
	}
}

export const liveCooldowns = new LiveCooldowns();
