/**
 * Traffic policies the simulator can score (`fleet simulate --policy`).
 *
 * A policy takes the tick the live dispatcher would see and returns its plan.
 * `baseline` is today's `planTick` unchanged. Every other policy is a
 * candidate or a reconstruction, and lives HERE, not in the dispatcher, until
 * the simulator has scored it against the baseline over the whole corpus.
 */
import { isLaneLabel } from '../lib/capability-labels.js';
import { SATURATION_QUEUE_SECONDS } from './backstop.js';
import { planTick, type PendingRun, type TickPlan } from './dispatcher.js';
import type { HeavyModel } from './heavy-model.js';
import { choosePlacement } from './placement.js';
import { IMPLICIT_LABELS, type NodeState } from './placement-node-state.js';
import { HEAVY_HOLD_SEC } from './placement-slow.js';
import type { SimPolicy, SimTick } from './sim-engine.js';

const NONE = { jobIds: new Set<number>(), runIds: new Set<number>() };

/**
 * The dispatcher as it ran before 2026-11-11 (3295dbe): a heavy job never
 * doubled onto a node already running a heavy job until it had queued
 * {@link HEAVY_HOLD_SEC}. Every record in the corpus up to that deploy ran
 * under it, so THIS is the policy a validation run replays against history.
 *
 * Reconstructed by dropping the mints the old hold refused. The walk ranks a
 * heavy job onto the node running the fewest heavy jobs, so a mint onto a
 * node already running one means every admissible node already ran one; the
 * old code refused all of them, which is exactly a dropped mint. A dropped
 * mint frees the slot it took in this tick's working state only after the
 * tick: a later job in the same tick saw it as taken, a small pessimism.
 */
export function legacyHoldPolicy(): SimPolicy {
	return {
		name: 'legacy-hold',
		plan(t: SimTick): TickPlan {
			const plan = planTick(t.pending, t.nodes, t.order, NONE, t.nowMs);
			const node = new Map(t.nodes.map((n) => [n.name, n]));
			const run = new Map(t.pending.map((r) => [r.jobId, r]));
			const mint = plan.mint.filter((m) => {
				const n = node.get(m.node);
				const r = run.get(m.jobId);
				if (!n || !r || !(n.heavyJobs && n.heavyJobs > 0)) return true;
				if (!n.heavyModel?.isHeavy(r.repo, r.jobName)) return true;
				const queuedSec = (t.nowMs - (r.queuedSinceMs ?? t.nowMs)) / 1000;
				return queuedSec >= HEAVY_HOLD_SEC || n.heavyJobs > 1;
			});
			return { ...plan, mint };
		},
	};
}

/**
 * RESERVATION (operator, 2026-11-11): while queued jobs need a capability only
 * some claws carry, take just enough of those claws out of general CI to serve
 * them, and give them back when the queue no longer needs them.
 *
 * Everything is read from the tick: the queue and the claws' current labels.
 * No label is named.
 *
 * - SCARCE: a job label not every schedulable claw carries (lane and implicit
 *   labels aside). A job with one is NARROW; its class is its scarce labels.
 * - ADMISSIBLE: a claw is reserved for a class only if the REAL placement walk
 *   would take one of the class's waiting jobs there with the claw's general
 *   work drained away. A claw that refuses the job anyway (memory, the heavy
 *   hold, a repo exclusion) would sit reserved and idle: that is the deadlock
 *   this check exists to prevent. Draining is credited no memory back, so the
 *   check errs toward not reserving.
 * - JUST ENOUGH: claws already reserved for the class are kept first (sticky,
 *   so a reservation does not hop between claws), then more are added in the
 *   tick's walk order until their slots cover the waiting jobs. A heavy class
 *   counts one slot per admissible claw, the hold's own rule.
 * - PLANNING: narrow jobs are planned first against every claw; then the rest,
 *   with reserved claws ineligible.
 * - GENERAL CI FIRST, when both are stuck: a job with no scarce label that has
 *   waited `generalFirstSec` and was still skipped releases one reserved claw
 *   that would take it, for `releaseCooldownSec`. Static priority, general CI
 *   ahead; one release per tick, so it backs off gradually.
 * - LINGER: a claw stays reserved `lingerSec` after the last tick it was
 *   needed, so shards arriving in waves do not reserve, release and reserve.
 * - WARM: a reserved claw's warm slot takes no general job either.
 *
 * Two switches, so the simulator can tell the parts apart:
 * - `reserve` 0 keeps the narrow-first planning and reserves nothing.
 * - `memoryCredit` 1 credits each drained general job's reserve back to the
 *   claw's free memory in the admissibility check, so a claw blocked for the
 *   class on MEMORY (not slots) can be reserved too. With it 0, a claw is
 *   reserved only when slots are what blocks the class, and a full claw takes
 *   no general job anyway: the reservation then mostly duplicates the
 *   narrow-first pass.
 */
export interface ReservationParams {
	lingerSec: number;
	generalFirstSec: number;
	releaseCooldownSec: number;
	/** 1: take claws out of general CI. 0: narrow-first planning only. */
	reserve: number;
	/** 1: credit drained general jobs' memory in the admissibility check. */
	memoryCredit: number;
}

export const RESERVATION_DEFAULTS: ReservationParams = {
	lingerSec: 120,
	generalFirstSec: SATURATION_QUEUE_SECONDS,
	releaseCooldownSec: 300,
	reserve: 1,
	memoryCredit: 0,
};

interface Reservation {
	forClass: string;
	lastNeededMs: number;
}

/** A job's scarce labels: those not every schedulable claw carries, lanes and implicit labels aside. */
export function scarceLabelsOf(
	labels: readonly string[],
	universal: ReadonlySet<string>
): string[] {
	return labels
		.map((l) => l.toLowerCase())
		.filter((l) => !IMPLICIT_LABELS.has(l) && !isLaneLabel(l) && !universal.has(l))
		.sort();
}

/** Labels every claw in `claws` carries. */
export function universalLabels(claws: readonly NodeState[]): Set<string> {
	const sets = claws.map((n) => new Set((n.labels ?? []).map((l) => l.toLowerCase())));
	if (!sets.length) return new Set();
	return new Set([...sets[0]].filter((l) => sets.every((s) => s.has(l))));
}

export function reservationPolicy(over: Partial<ReservationParams> = {}): SimPolicy {
	const p = { ...RESERVATION_DEFAULTS, ...over };
	const reserved = new Map<string, Reservation>();
	const releasedUntil = new Map<string, number>();
	const stats = {
		reservationStarts: 0,
		reservationEnds: 0,
		drains: 0,
		generalFirstReleases: 0,
		reservedNodeSec: 0,
	};
	let lastTickMs: number | null = null;

	const end = (node: string): void => {
		if (reserved.delete(node)) stats.reservationEnds++;
	};

	return {
		name: 'reservation',
		stats: () => ({ ...stats }),
		warmAllowed: (node) => !reserved.has(node),
		plan(t: SimTick): TickPlan {
			const now = t.nowMs;
			if (lastTickMs !== null) stats.reservedNodeSec += (reserved.size * (now - lastTickMs)) / 1000;
			lastTickMs = now;

			const claws = t.nodes.filter(
				(n) =>
					!n.onDemandBackstop && n.eligible && n.healthy && !n.drained && n.schedulable !== false
			);
			const universal = universalLabels(claws);
			const classOf = (r: PendingRun): string =>
				scarceLabelsOf(r.labels ?? [], universal).join('+');
			const demand = new Map<string, PendingRun[]>();
			for (const r of t.pending) {
				const c = classOf(r);
				if (!c) continue;
				const list = demand.get(c) ?? [];
				list.push(r);
				demand.set(c, list);
			}

			const heavyModel = t.nodes.find((n) => n.heavyModel)?.heavyModel;
			const queuedSec = (r: PendingRun): number => (now - (r.queuedSinceMs ?? now)) / 1000;
			/** Would the walk place one of `jobs` on `n` with its general work drained away? */
			const admits = (n: NodeState, jobs: readonly PendingRun[]): boolean => {
				const general = Math.max(0, n.liveUnits - (n.heavyJobs ?? 0));
				const drained: NodeState = {
					...n,
					liveUnits: n.heavyJobs ?? 0,
					standingBusy: 0,
					warmBusy: 0,
					freeMb: n.freeMb + (p.memoryCredit ? general * n.requiredMb : 0),
				};
				return jobs.slice(0, 5).some(
					(r) =>
						choosePlacement([n.name], [drained], r.labels ?? [], r.repo, {
							queuedSec: queuedSec(r),
							jobName: r.jobName,
						}).node === n.name
				);
			};

			for (const [c, jobs] of p.reserve ? demand : []) {
				const heavy = jobs.some((r) => heavyModel?.isHeavy(r.repo, r.jobName) ?? false);
				const slotsOf = (n: NodeState): number => (heavy ? 1 : n.maxConcurrent);
				const mine = claws.filter((n) => reserved.get(n.name)?.forClass === c);
				const free = t.order
					.map((name) => claws.find((n) => n.name === name))
					.filter(
						(n): n is NodeState =>
							n !== undefined && !reserved.has(n.name) && (releasedUntil.get(n.name) ?? 0) <= now
					);
				let covered = 0;
				for (const n of [...mine, ...free]) {
					if (covered >= jobs.length) break;
					if (!admits(n, jobs)) continue;
					covered += slotsOf(n);
					const had = reserved.get(n.name);
					if (!had) {
						stats.reservationStarts++;
						if (n.liveUnits > (n.heavyJobs ?? 0)) stats.drains++;
					}
					reserved.set(n.name, { forClass: c, lastNeededMs: now });
				}
			}
			for (const [node, res] of reserved) {
				if (now - res.lastNeededMs >= p.lingerSec * 1000) end(node);
			}

			const narrow = t.pending.filter((r) => classOf(r) !== '');
			const wide = t.pending.filter((r) => classOf(r) === '');
			const first = planTick(narrow, t.nodes, t.order, NONE, now);
			const after = consume(t.nodes, first, heavyModel, t.pending);
			const without = (exempt: ReadonlySet<string>): NodeState[] =>
				after.map((n) =>
					reserved.has(n.name) && !exempt.has(n.name) ? { ...n, eligible: false } : n
				);
			let second = planTick(wide, without(new Set()), t.order, NONE, now);

			const stuck = wide.find(
				(r) => queuedSec(r) >= p.generalFirstSec && second.skipped.some((s) => s.jobId === r.jobId)
			);
			if (stuck) {
				const give = after.find(
					(n) =>
						reserved.has(n.name) &&
						choosePlacement([n.name], [n], stuck.labels ?? [], stuck.repo, {
							queuedSec: queuedSec(stuck),
							jobName: stuck.jobName,
						}).node === n.name
				);
				if (give) {
					end(give.name);
					releasedUntil.set(give.name, now + p.releaseCooldownSec * 1000);
					stats.generalFirstReleases++;
					second = planTick(wide, without(new Set([give.name])), t.order, NONE, now);
				}
			}
			return {
				mint: [...first.mint, ...second.mint],
				skipped: [...first.skipped, ...second.skipped],
				reserved: [...first.reserved, ...second.reserved],
			};
		},
	};
}

/** `nodes` after `plan`'s mints, the way planTick's own working copy counts them. */
export function consume(
	nodes: readonly NodeState[],
	plan: TickPlan,
	heavyModel: HeavyModel | undefined,
	pending: readonly PendingRun[]
): NodeState[] {
	const out = new Map(nodes.map((n) => [n.name, { ...n }]));
	const byJob = new Map(pending.map((r) => [r.jobId, r]));
	for (const m of plan.mint) {
		const n = out.get(m.node);
		if (!n) continue;
		n.liveUnits += 1;
		n.freeMb -= n.requiredMb;
		const r = byJob.get(m.jobId);
		if (r && heavyModel?.isHeavy(r.repo, r.jobName)) n.heavyJobs = (n.heavyJobs ?? 0) + 1;
		if (r && heavyModel?.isHeavyRepo(r.repo)) n.runningHeavy = true;
	}
	return [...out.values()];
}
