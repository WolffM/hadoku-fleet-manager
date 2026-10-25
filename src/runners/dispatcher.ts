/**
 * One dispatcher tick, as a pure function.
 *
 * Given what is queued and what the fleet looks like, decide what to mint. No
 * network, no ssh, no clock — so the whole decision, including the parts that
 * only go wrong under load, can be asserted in a unit test. That is deliberate:
 * every time this workstream learned something by pointing a probe at real
 * infrastructure it cost an outage (§12.9) or a leaked registration (§12.8).
 */
import {
	isForkSafe,
	choosePlacement,
	busyOf,
	satisfiesLabels,
	type NodeState,
	type RunIdentity,
} from './placement.js';
import { jitRunnerName } from './ephemeral.js';
import { jobQueuedSinceMs } from './queue-discovery.js';

export interface PendingRun extends RunIdentity {
	id: number;
	repo: string;
	/** The queued JOB this entry is for. One run contributes one entry PER
	 *  waiting job, so the run id does not identify an entry — this does. */
	jobId: number;
	/** Labels the queued JOB asked for, not the run. */
	labels?: string[];
	/**
	 * The queued JOB's own name — not the run's. The spill gate (#83) needs it
	 * for {@link SpeedModel.expectedExtraSec}'s (repo, job) lookup; without it,
	 * that call still works, just falling back to a coarser repo-level estimate
	 * (see `expectedExtraSec`'s own documented fallback order). #102's heavy-kind
	 * classifier (`HeavyModel.isHeavy`, `traffic.ts`) reuses this SAME field for
	 * the SAME reason — one (repo, job) key, not a second one.
	 *
	 * POPULATED by the producer since #89 (`dispatch-tick.ts`'s `pending.push`
	 * carries `jobName: j.name`, outside this lane) — this comment previously
	 * read "not yet populated" and named a line to add; that line landed before
	 * this wave and the comment was stale (CLAUDE.md: a comment read as evidence
	 * is how this codebase keeps re-discovering the same fact). Still optional
	 * on the type: a caller with no job name in hand (or a fixture predating
	 * #89) gets the coarser fallback rather than a crash.
	 */
	jobName?: string;
	/**
	 * ISO timestamp the GitHub runs API reports for this run's creation. Carried
	 * only so {@link queuedSinceMs} below can be derived from it without a
	 * second reader of the raw API response — `dispatch-tick.ts` already spreads
	 * the whole `QueuedRun` onto every entry it pushes, so this (and
	 * `run_started_at`) are present on every PendingRun in production today even
	 * though neither was declared on this type until now.
	 */
	created_at?: string;
	/** When the CURRENT attempt started — resets on a re-run. See
	 *  `queue-discovery.ts`'s own field of the same name for why this, not
	 *  `created_at` alone, is the age a re-run should be measured from. */
	run_started_at?: string;
	/**
	 * Epoch ms the CURRENT attempt started queuing — {@link queuedSinceMs} ran
	 * over `created_at`/`run_started_at`. `undefined` when neither timestamp
	 * parses, and that must never be read as "has waited long enough": the spill
	 * gate in `placement.ts` only ever spills a job whose wait is a known,
	 * measured number past its threshold.
	 *
	 * Optional on input — a caller that already computed it may set it directly
	 * — but `planTick` below derives it itself when absent, from the raw
	 * timestamps, so nothing upstream of this file has to be touched for the
	 * age gate to work end to end.
	 */
	queuedSinceMs?: number;
	/** The queued JOB's own `created_at` (#96): the spill gate's clock. */
	jobCreatedAt?: string;
	/**
	 * BACKED OFF, NOT RE-READ (#117): the run is in its probe backoff and this
	 * entry comes from its last jobs listing, not this tick's. It takes its
	 * place in the age order and is placed like any other job — but a node
	 * chosen for it is RESERVED, never minted on (see {@link TickPlan.reserved}).
	 *
	 * Without it a backed-off run is simply absent from the pass, so a slot that
	 * frees inside its backoff goes to whatever younger job was probed that tick.
	 * The backoff lifts on `placementFingerprint`, which reads the fast loop's
	 * probe — a minute stale, and blind to a JIT job ending when another starts
	 * on the same node — so under a steady stream the older run kept missing
	 * the slot it was waiting for.
	 */
	held?: boolean;
}

export interface MintAction {
	runId: number;
	jobId: number;
	repo: string;
	node: string;
	runnerName: string;
	/**
	 * `Placement.viaAffinity`, carried through: the chosen node held a
	 * verified-live listener for THIS repo. It was dropped here until 2026-09-18,
	 * so nothing could count it (`warm-affinity-measured-2-2026-09-15.md` §5d).
	 *
	 * NOT "affinity caused this". `choosePlacement` sets it whenever the node it
	 * picked is warm for the repo — including when plain ordering would have
	 * picked that same node anyway. That is the concentration metric again
	 * (74 % base rate with the term switched OFF, §3d), not the term's effect.
	 * {@link affinityMoved} is the causal half.
	 */
	viaAffinity: boolean;
	/**
	 * The affinity term MOVED this mint: the placement landed on a warm node AND
	 * the same walk without `repo` would have picked a different node. This is
	 * "because of the term", as opposed to "warm by chance" — the split W's
	 * after-arm cannot make from job-history, where both look the same.
	 * Always implies {@link viaAffinity}.
	 */
	affinityMoved: boolean;
	/**
	 * `Placement.heavy`, carried through (#102.4) — was the QUEUED JOB itself
	 * classified heavy. Needed here, not re-derived, for the SAME reason
	 * `viaAffinity` is: a second classifier in `dispatch-pass.ts`'s log line
	 * could disagree with the one `choosePlacement` actually ranked on.
	 */
	heavy: boolean;
	/**
	 * This node's `busyOf` reading AT THE MOMENT it was chosen — i.e. AFTER
	 * whatever earlier placements in this SAME tick already incremented, but
	 * BEFORE this job's own increment. This is "say what the rule did"
	 * (#102.4, §A.5's live check): the dispatch log's `placed=node@busy`
	 * report reads this directly rather than re-deriving it from a
	 * post-tick snapshot, which would already include this job's own mint.
	 */
	busyAtChoice: number;
}

export interface SkipReason {
	runId: number;
	jobId?: number;
	repo: string;
	reason: string;
	/**
	 * WHY, as a value rather than a sentence (#117). `unplaceable` is the one the
	 * dispatcher may back its probe off for: every node refused the job, and the
	 * next tick will ask the same nodes the same question.
	 */
	kind: 'in-flight' | 'fork' | 'unplaceable' | 'held';
	/**
	 * `unplaceable` only: the earliest moment a refusal that TIME lifts (a heavy
	 * hold, a slow-tier hold) would stop holding this job. Absent when no node
	 * refused on a clock, or the job's queue age is unknown — an unknown age
	 * never releases a hold (see `refusalFor`), so there is no moment to name.
	 */
	releaseAtMs?: number;
}

/**
 * What is already being served, by identity.
 *
 * TWO sets, because a name minted before the job-scoped format carries no job
 * id. Those block at RUN level — the conservative direction — and drain within
 * one job's TTL after a deploy.
 */
export interface InFlight {
	jobIds: ReadonlySet<number>;
	runIds: ReadonlySet<number>;
}

/** A slot held for a backed-off job older than whatever else wanted it. */
export interface ReservedSlot {
	runId: number;
	jobId: number;
	repo: string;
	node: string;
}

export interface TickPlan {
	mint: MintAction[];
	skipped: SkipReason[];
	/**
	 * Placements for {@link PendingRun.held} jobs. Capacity is consumed exactly
	 * as for a mint, so no younger job takes the slot this pass; nothing is
	 * minted, because the job was not re-read and may already be running. The
	 * caller re-probes these runs on the next tick and mints from a fresh read.
	 */
	reserved: ReservedSlot[];
}

/**
 * Decide the mints for one tick.
 *
 * Three properties this has to hold, each of which is a bug the fleet has
 * already produced in some form:
 *
 * 1. **Capacity is consumed as it is planned.** A tick that places five jobs
 *    against a snapshot showing three free slots must not place all five. The
 *    node state is decremented per assignment, so the cap binds WITHIN the
 *    tick and not merely between ticks. This is the whole of B2 at tick scope —
 *    eleven concurrent builds landed on a 7.7 GB box because nothing counted
 *    across a burst.
 * 2. **A JOB already being served is never minted for again.** `inFlight`
 *    covers the window between minting and the runner appearing in the API, and
 *    that window spans an mgmt-api restart — so the caller reconstructs it from
 *    live units (§12.2) rather than from memory.
 *
 *    This was keyed on the RUN until 2026-09-01, and both halves of that were
 *    wrong. A run contributes one pending entry per waiting job, so a 3-job run
 *    produced three entries carrying one run id and one tick clock — and
 *    `jitRunnerName` hashed exactly those, so all three names were IDENTICAL.
 *    The first mint won and the rest came back `409 Already exists`, ~4/day,
 *    into a `logger.warn` nothing read. The jobs that lost the collision then
 *    waited for a STANDING runner, quietly moving JIT load back onto the two
 *    claws this whole workstream exists to unload.
 * 3. **Every skip is reported.** A dispatcher that silently drops a run is
 *    indistinguishable from one that never saw it, and the fleet has already
 *    spent a day on a runner nobody knew had stopped listening.
 */
/** Up to the first `. ` (a sentence end, not a decimal point), at most 120 chars. */
export function firstSentence(reason: string): string {
	const end = reason.search(/\.\s/);
	const cut = end === -1 ? reason : reason.slice(0, end);
	return cut.length > 120 ? `${cut.slice(0, 119)}…` : cut;
}

/**
 * Runs only ONE eligible node can serve by labels go first; everything else
 * keeps the order it arrived in.
 *
 * #131. Placement puts the fewest-busy node first, so an idle hokon outranks
 * every busy claw, and a Forge shard (hadoku-builder + jdk21, which six claws
 * carry) that is earlier in priority order takes hokon's free slot. A
 * tenhands `pm2-host, taskauto` or dataplatform `av1-nvenc` job later in the
 * same pass then finds hokon full and has nowhere else to go. Placing the
 * single-node runs first lets each claim its node before a run with
 * alternatives is walked; the flexible run still gets a claw.
 *
 * Only LABELS decide "single-node", never current capacity: a node full this
 * tick is still that job's only home, and the job must be first in line for
 * it. Stable, so `byPriority`'s age-with-head-start order holds within both
 * groups. A run no node can serve stays where it was and is skipped as before.
 */
export function singleNodeFirst(
	pending: readonly PendingRun[],
	nodes: readonly NodeState[]
): PendingRun[] {
	const eligible = nodes.filter((m) => m.eligible);
	const homes = (run: PendingRun): number => {
		const wanted = run.labels ?? [];
		return eligible.filter((m) => !wanted.length || satisfiesLabels(m.labels ?? [], wanted)).length;
	};
	const single = pending.filter((r) => homes(r) === 1);
	return [...single, ...pending.filter((r) => !single.includes(r))];
}

export function planTick(
	pending: readonly PendingRun[],
	nodes: readonly NodeState[],
	order: readonly string[],
	inFlight: InFlight,
	nowMs: number
): TickPlan {
	const mint: MintAction[] = [];
	const skipped: SkipReason[] = [];
	const reserved: ReservedSlot[] = [];
	// A working copy: assignments below consume capacity from it.
	const state = new Map(nodes.map((m) => [m.name, { ...m }]));

	for (const run of singleNodeFirst(pending, nodes)) {
		if (inFlight.jobIds.has(run.jobId) || inFlight.runIds.has(run.id)) {
			skipped.push({
				runId: run.id,
				jobId: run.jobId,
				repo: run.repo,
				reason: 'already has a runner in flight',
				kind: 'in-flight',
			});
			continue;
		}
		const fork = isForkSafe(run);
		if (!fork.ok) {
			// Refusing is the whole point; saying so is how anyone finds out the
			// dispatcher is declining work rather than failing to see it.
			skipped.push({
				runId: run.id,
				jobId: run.jobId,
				repo: run.repo,
				reason: `fork safety: ${fork.reason}`,
				kind: 'fork',
			});
			continue;
		}
		const eligible = [...state.values()].filter((m) => m.eligible);
		// THE SLOW-TIER SPILL GATE'S PER-RUN INPUT (#83), measured from the JOB's
		// own creation, not the run's (#96: a dependent job inside an old run must
		// not look old the moment it exists). `queuedSinceMs` prefers
		// a value the producer already computed (`run.queuedSinceMs`) and falls
		// back to deriving it from the raw timestamps `dispatch-tick.ts` already
		// carries on every entry (`created_at`/`run_started_at`, spread onto it
		// before this type declared either) — see `PendingRun.queuedSinceMs`'s
		// own doc. `undefined` either way means "could not establish the age",
		// and `queuedSec` stays `undefined` for it rather than becoming `0` or
		// some other number that could read as "just started" — `placement.ts`
		// treats an `undefined` queue age as NEVER having waited long enough.
		const queuedAt = run.queuedSinceMs ?? jobQueuedSinceMs(run, run.jobCreatedAt);
		const spill = {
			queuedSec: queuedAt !== undefined ? Math.max(0, (nowMs - queuedAt) / 1000) : undefined,
			jobName: run.jobName,
		};
		// THE 4TH ARGUMENT IS THE WARM-AFFINITY TERM'S ONLY INPUT, and its absence
		// here is what made `a6a19a4` inert for five days and ~2,000 jobs
		// (`warm-affinity-measured-2026-09-14.md` §3: the deployed 0.22.108 called
		// this with three). `run.repo` is the mint's own request — already in hand,
		// already what `jitRunnerName` below is keyed on — so there is nothing to
		// source and nothing that can disagree with it.
		const placed = choosePlacement(order, eligible, run.labels ?? [], run.repo, spill);
		if (!placed.node) {
			const holds = placed.passed.flatMap((x) => (x.holdSec === undefined ? [] : [x.holdSec]));
			const releaseAtMs =
				queuedAt !== undefined && holds.length ? queuedAt + Math.min(...holds) * 1000 : undefined;
			skipped.push({
				// A held job's refusal is the one its backoff already recorded; it
				// is not a new observation and must not extend that backoff.
				kind: run.held ? 'held' : 'unplaceable',
				...(releaseAtMs === undefined ? {} : { releaseAtMs }),
				runId: run.id,
				jobId: run.jobId,
				repo: run.repo,
				// WHY each node refused, not only that all did — a heavy hold, a
				// full node and a missing label are three different waits. Each
				// reason cut to its first sentence: an `excludeRepos` note is a
				// paragraph, and this line repeats per queued job every pass.
				reason:
					(placed.reason ?? 'no placement') +
					(placed.passed.length
						? ` (${placed.passed.map((x) => `${x.node}: ${firstSentence(x.reason)}`).join('; ')})`
						: ''),
			});
			continue;
		}
		// The counterfactual: the SAME walk against the SAME snapshot, minus the
		// affinity term. Only asked when the term could have mattered, and pure —
		// it consumes nothing, so the capacity bookkeeping below is untouched.
		// The SAME `spill` context is passed so the comparison isolates the
		// affinity term alone rather than also varying the spill gate's answer.
		const affinityMoved =
			placed.viaAffinity &&
			choosePlacement(order, eligible, run.labels ?? [], undefined, spill).node !== placed.node;
		const chosen = state.get(placed.node)!;
		// READ BEFORE THIS JOB'S OWN INCREMENT — the dispatch log's `placed=`
		// report (#102.4) is "what the rule did", i.e. the load the walk
		// actually chose THIS node at, not the load it leaves behind.
		const busyAtChoice = busyOf(chosen);
		chosen.liveUnits += 1;
		// #102.4: this SAME object is what the NEXT run's `choosePlacement` call
		// reads `runningHeavy` off (via `eligible`, which holds references into
		// `state`) — raising it here is what lets a heavy job placed earlier in
		// THIS tick rank this node last for a lighter one later in it, without a
		// second classifier that could disagree with `choosePlacement`'s own
		// (`Placement.heavy`'s own doc explains why that field exists at all).
		if (placed.heavy) {
			chosen.runningHeavy = true;
			chosen.heavyJobs = (chosen.heavyJobs ?? 0) + 1;
		}
		// `placed.requiredMb` is the reserve admission ACTUALLY USED for this
		// placement (#77, `Placement.requiredMb`) — set only when a proven
		// lower-bound floor raised what `admitMint` checked above the node's
		// flat `requiredMb`. Decrementing by the flat figure regardless, as this
		// line did before #77, let a lower-bound mint consume less of the SAME
		// tick's remaining capacity than it had just been proven to need, so a
		// second job could still land beside it and overfill the node — wave 3t
		// lane C's two-jobs-one-tick case. `?? chosen.requiredMb` keeps every
		// ordinary repo's arithmetic bit-for-bit what it was on main.
		chosen.freeMb -= placed.requiredMb ?? chosen.requiredMb;
		if (run.held) {
			reserved.push({ runId: run.id, jobId: run.jobId, repo: run.repo, node: placed.node });
			continue;
		}
		mint.push({
			runId: run.id,
			jobId: run.jobId,
			repo: run.repo,
			node: placed.node,
			runnerName: jitRunnerName(placed.node, run.repo, nowMs, run.id, run.jobId),
			viaAffinity: placed.viaAffinity,
			affinityMoved,
			heavy: placed.heavy,
			busyAtChoice,
		});
	}
	return { mint, skipped, reserved };
}
