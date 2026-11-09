/**
 * job-rollups-fleet — the FLEET-WIDE half of a day's rollup (wave fleettab
 * §A): jobs/queue/failures for the whole fleet and by job class, per-node
 * job counts and run hours, why dispatch passes could not place a job, and
 * how many claws were available. Split out of `job-rollups.ts` (same reason
 * every other split in this package gives: a second shape bolted onto the
 * first would have pushed it toward the 800-line source ceiling, and the two
 * shapes are keyed differently — `RollupRow` is one row per (node, repo,
 * kind); everything here is one value (or one small array) per DAY).
 *
 * WHY THIS IS A SEPARATE SHAPE, NOT MORE `RollupRow`S. The existing rows
 * already fold every job by (node, repo, kind) including a `node: '*'` fleet
 * total — but they carry percentiles, not raw sums, so "total runner-hours
 * this day" cannot be recovered from them, and `waits`/`availability` are not
 * about jobs at all. This module reads the SAME organic `JobRecord[]`
 * `job-rollups.ts` already pulled for the day (no second job-history read),
 * plus whatever the dispatch-decision log and capacity-sample store still
 * hold for that day, and builds one more thing to put in the envelope
 * alongside `rows`.
 *
 * THE CLASS RULE LIVES HERE, AND ONLY HERE ({@link classifyJob}). "The
 * window" the contract describes ("the repo's short name when that repo had
 * 10% or more of the window's jobs") is taken to mean THE DAY: a rollup row
 * is written once, backfilled from whatever job-history still holds, and
 * must mean the same thing however many days a later `/fleet/performance?
 * days=N` request spans. A repo's share of a 7-day window and a 30-day
 * window differ, so freezing the threshold at write time against anything
 * wider than the row's own day would make the stored class drift with the
 * query that happens to read it — the same mistake AGENTS.md calls out for a
 * gate that gets easier to pass the worse things get, in miniature: here it
 * would make a day's own figure depend on a request parameter.
 *
 * `waits`/`availability` ARE `null` ON A DAY THEIR OWN SOURCE STORE DID NOT
 * HOLD DATA FOR — never zero-filled. The decision log keeps
 * `DECISION_RETENTION_DAYS` (job-history's 14 plus one) and the capacity
 * sampler {@link CAPACITY_SAMPLE_RETENTION_DAYS} (14); a rollup is written
 * ~{@link SETTLE_HOURS} after the day ends, comfortably inside both, so a
 * freshly-written day almost always gets real numbers. A day backfilled long
 * after the fact, or re-read from a schema-1 line this wave did not touch,
 * gets `null` instead of a manufactured zero.
 */
import { nodeOf } from './runners/census.js';
import { percentile } from './job-history-stats.js';
import { failuresByZone } from './job-history-zone.js';
import type { JobRecord } from './job-history-store.js';
import type { DecisionRecord } from './runners/decision-log-types.js';
import type { CapacitySampleRow } from './capacity-sample-store.js';

/** A sample's size and p50/p80/p95 — the three quantiles the Performance view charts. */
export interface QuantileSpread {
	n: number;
	p50: number | null;
	p80: number | null;
	p95: number | null;
}

export interface NodeDayAggregate {
	node: string;
	jobs: number;
	runnerHours: number;
	/** Non-success, non-cancelled jobs / jobs. 0 when there were none, never `NaN`. */
	failRate: number;
	/** `null`: no capacity sample for this node on this day (store unreadable, outside retention, or never sampled). */
	fullShare: number | null;
	/** `null`, same reasons as {@link fullShare}. */
	unavailableShare: number | null;
}

export interface WaitsDayAggregate {
	capacity: number;
	constraints: number;
	held: number;
	other: number;
}

export interface AvailabilityDayAggregate {
	/**
	 * The SHARE (0..1) of this day's capacity samples, across every node and
	 * tick, that were available — not drained/unreachable/absent/sick/offline.
	 * Matches the tracker's one-off `claw_availability` (`docs/handoff/
	 * snapshot/availability.json`), which this is cross-checked against.
	 */
	claws: number;
}

export interface FleetDayAggregate {
	jobs: number;
	runnerHours: number;
	cancelled: number;
	failures: { code: number; setup: number; fleet: number };
	queue: { all: QuantileSpread; byClass: Record<string, QuantileSpread> };
	nodes: NodeDayAggregate[];
	/** `null`: the dispatch-decision log held no rows for this day. */
	waits: WaitsDayAggregate | null;
	/** `null`: the capacity-sample store held no rows for this day. */
	availability: AvailabilityDayAggregate | null;
}

/** `"owner/repo"` -> `"repo"`. A bare name (no `/`) is returned unchanged. */
export function repoShortName(repo: string): string {
	const i = repo.lastIndexOf('/');
	return i === -1 ? repo : repo.slice(i + 1);
}

const JDK21_LABEL = 'jdk21';
/** The contract's own threshold: a repo earns its own class at 10% of the day's jobs. */
export const CLASS_REPO_SHARE = 0.1;

/**
 * THE CLASS RULE (wave fleettab §A, contract). One job -> one class:
 * `jdk21` when its own labels say so, else the repo's short name once that
 * repo clears {@link CLASS_REPO_SHARE} of the day, else `other`.
 *
 * `repoCounts`/`totalJobs` are the caller's to build once per day and reuse
 * across every job in it — recomputing a fleet-wide count per job would be
 * quadratic in the day's job count for no reason.
 */
export function classifyJob(
	labels: readonly string[],
	repo: string,
	repoCounts: ReadonlyMap<string, number>,
	totalJobs: number
): string {
	if (labels.includes(JDK21_LABEL)) return 'jdk21';
	const count = repoCounts.get(repo) ?? 0;
	if (totalJobs > 0 && count / totalJobs >= CLASS_REPO_SHARE) return repoShortName(repo);
	return 'other';
}

function quantileSpread(xs: readonly (number | undefined)[]): QuantileSpread {
	const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
	return { n: v.length, p50: percentile(v, 50), p80: percentile(v, 80), p95: percentile(v, 95) };
}

// ── waits: which clause refused every candidate ────────────────────────────

const WAITS_CAPACITY_RE = /^(at capacity:|memory:)/;
const WAITS_HELD_RE = /^(slow (tier|kind):|reserved for |drained:|heavy hold:)/;
const WAITS_CONSTRAINTS_RE = /^(repo excluded here:|placement:|does not carry)/;

/**
 * One unplaceable pass's bucket, by the contract's own cascade: capacity
 * first (any candidate refused `at capacity` or `memory`), else held (slow
 * tier/kind, hokon's reserved-overflow count, a drain, the heavy hold), else
 * constraints (an exclusion, the placement floor, a missing label), else
 * `other` — a refusal shape none of the three above recognise.
 *
 * Deliberately its OWN mapping, not `decision-log.ts`'s `refusalCategory`:
 * that function puts `reserved for` and `memory:` in the same bucket
 * (`capacity`) for a different purpose — collapsing a flapping mechanism so
 * the decision log does not rewrite a row every pass. The contract draws the
 * line differently (`memory` with capacity, `reserved` with held), so this
 * reads the raw reason text rather than reusing that category.
 */
export function waitBucket(
	reasons: readonly string[]
): 'capacity' | 'held' | 'constraints' | 'other' {
	if (reasons.some((r) => WAITS_CAPACITY_RE.test(r))) return 'capacity';
	if (reasons.some((r) => WAITS_HELD_RE.test(r))) return 'held';
	if (reasons.some((r) => WAITS_CONSTRAINTS_RE.test(r))) return 'constraints';
	return 'other';
}

function buildWaits(decisions: readonly DecisionRecord[]): WaitsDayAggregate {
	const out: WaitsDayAggregate = { capacity: 0, constraints: 0, held: 0, other: 0 };
	for (const d of decisions) {
		// `held` folds into `unplaceable` for dedup (decision-log.ts's own
		// `decisionSignature`); both are the same kind of pass here.
		if (d.kind !== 'unplaceable' && d.kind !== 'held') continue;
		out[waitBucket(d.refused.map((x) => x.reason))] += 1;
	}
	return out;
}

// ── availability: which claws were up ───────────────────────────────────────

/** Mirrors `ClawState` (`lib/fleet-vocabulary.ts`) — not imported, same reason `capacity-sample-store.ts` inlines it: a layer edge, not drift. */
const UNAVAILABLE_STATES = new Set(['offline', 'absent', 'unreachable', 'sick']);

function isUnavailableSample(s: CapacitySampleRow): boolean {
	return s.drained || UNAVAILABLE_STATES.has(s.state ?? '');
}

/**
 * `null` on an EMPTY input, same reasoning as `fullShare`/`unavailableShare`
 * per node: the sampler ticks every five minutes, so zero rows never means
 * "zero claws were available" — it means nothing was recorded, which is
 * "could not look", not a measured zero (AGENTS.md).
 *
 * `claws` is the fleet-wide SHARE of samples available (manager decision,
 * wave fleettab: matches the tracker's `claw_availability` fraction, not a
 * mean headcount) — every node's every tick that day, pooled.
 */
function buildAvailability(samples: readonly CapacitySampleRow[]): AvailabilityDayAggregate | null {
	if (!samples.length) return null;
	const available = samples.filter((s) => !isUnavailableSample(s)).length;
	return { claws: available / samples.length };
}

// ── the day aggregate itself ─────────────────────────────────────────────────

export interface FleetDayAggregateInputs {
	/** Dispatch-decision rows for this day, oldest first. `null`/absent: the log held none — `waits` comes back `null`. */
	decisions?: readonly DecisionRecord[] | null;
	/** Capacity-sample rows for this day. `null`/absent: the store held none — `fullShare`/`unavailableShare`/`availability` come back `null`. */
	capacitySamples?: readonly CapacitySampleRow[] | null;
}

/**
 * Build one day's fleet-wide aggregate from the SAME organic records
 * `job-rollups.ts`'s `rollupDay` already filtered for this day (never
 * probes, never a different day). PURE given its inputs.
 */
export function buildFleetDayAggregate(
	organicRecords: readonly JobRecord[],
	nodes: readonly string[],
	inputs: FleetDayAggregateInputs = {}
): FleetDayAggregate {
	const jobs = organicRecords.length;
	// `runSec` (job-history-phases.ts) is the RUN phase alone — the minted
	// runner's own setup/cleanup overhead excluded — and is what the tracker's
	// one-off `runner_hours` (`docs/handoff/snapshot/jobs_daily.json`) turned
	// out to mean: cross-checked exactly against three live days (2026-10-29,
	// 11-02, 11-05), `durationSec` (total wall time) overran the tracker's
	// figure by 4-12%, and `runSec` matched it to the SECOND on every one.
	// `durationSec` is the fallback for the rare job `jobPhases` could not
	// split (an unusable step record) — never absent, unlike `runSec`.
	const runnerHoursOf = (rs: readonly JobRecord[]): number =>
		rs.reduce((s, r) => s + (r.runSec ?? r.durationSec), 0) / 3600;
	const zones = failuresByZone(organicRecords);

	const repoCounts = new Map<string, number>();
	for (const r of organicRecords) repoCounts.set(r.repo, (repoCounts.get(r.repo) ?? 0) + 1);

	const byClass = new Map<string, JobRecord[]>();
	for (const r of organicRecords) {
		const cls = classifyJob(r.labels, r.repo, repoCounts, jobs);
		const xs = byClass.get(cls);
		if (xs) xs.push(r);
		else byClass.set(cls, [r]);
	}
	const queueByClass: Record<string, QuantileSpread> = {};
	for (const [cls, rs] of [...byClass.entries()].sort((a, b) => a[0].localeCompare(b[0])))
		queueByClass[cls] = quantileSpread(rs.map((r) => r.queueSec));

	const byNode = new Map<string, JobRecord[]>();
	for (const r of organicRecords) {
		const node = nodeOf(r.runner, nodes);
		const xs = byNode.get(node);
		if (xs) xs.push(r);
		else byNode.set(node, [r]);
	}
	const sampleByNode = new Map<string, CapacitySampleRow[]>();
	for (const s of inputs.capacitySamples ?? []) {
		const xs = sampleByNode.get(s.node);
		if (xs) xs.push(s);
		else sampleByNode.set(s.node, [s]);
	}
	const haveSamples = (inputs.capacitySamples ?? null) !== null;
	const nodeRows: NodeDayAggregate[] = [...byNode.entries()]
		.map(([node, rs]) => {
			const nonSuccess = rs.filter(
				(r) => r.conclusion !== 'success' && r.conclusion !== 'cancelled'
			).length;
			const samples = sampleByNode.get(node) ?? [];
			const fullShare =
				haveSamples && samples.length
					? samples.filter((s) => WAITS_CAPACITY_RE.test(s.refusalReason ?? '')).length /
						samples.length
					: null;
			const unavailableShare =
				haveSamples && samples.length
					? samples.filter(isUnavailableSample).length / samples.length
					: null;
			return {
				node,
				jobs: rs.length,
				runnerHours: runnerHoursOf(rs),
				failRate: rs.length ? nonSuccess / rs.length : 0,
				fullShare,
				unavailableShare,
			};
		})
		.sort((a, b) => a.node.localeCompare(b.node));

	return {
		jobs,
		runnerHours: runnerHoursOf(organicRecords),
		cancelled: zones.cancelled,
		failures: { code: zones.content, setup: zones.seam, fleet: zones.runner + zones.fleet },
		queue: { all: quantileSpread(organicRecords.map((r) => r.queueSec)), byClass: queueByClass },
		nodes: nodeRows,
		waits: inputs.decisions == null ? null : buildWaits(inputs.decisions),
		availability: inputs.capacitySamples == null ? null : buildAvailability(inputs.capacitySamples),
	};
}
