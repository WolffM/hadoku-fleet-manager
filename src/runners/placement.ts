/**
 * Where a job should be minted, and whether it may be minted at all.
 *
 * B8 (never mint for a fork) from docs/planning/fleet-rearchitecture-2026-08-25.md. Pure, for the same reason as
 * ephemeral.ts: these are decisions, and decisions can be asserted without
 * touching a node.
 */
import { IMPLICIT_LABELS as REGISTRY_IMPLICIT_LABELS } from '../capabilities.js';
import { admitMint, type AdmissionInput, type AdmissionResult } from './ephemeral.js';
import type { SpeedModel } from './speed-tier.js';
import type { HeavyModel } from './traffic.js';

// ---------------------------------------------------------------------------
// B8 — fork safety
// ---------------------------------------------------------------------------

export interface RunIdentity {
	/** The repo the workflow belongs to. */
	repository?: { full_name?: string };
	/** Where the CODE came from. Differs from `repository` for a fork PR. */
	head_repository?: { full_name?: string; fork?: boolean };
	event?: string;
}

/**
 * May a runner be minted for this run?
 *
 * **This gate FAILS CLOSED**, unlike every other guard in this workstream. The
 * supersede gate and the throttle both proceed on their own malfunction, because
 * the cost of a false skip there is wasted work. Here the cost of a false ALLOW
 * is executing a stranger's code on a node holding vault credentials, PM2
 * control and the production host — so anything unproven is refused.
 *
 * The fleet already has four controls that stop a fork PR reaching a self-hosted
 * runner (§6), and this deliberately does not rely on any of them. §6's own
 * audit had to be retracted once for reading a comment as a live trigger; a
 * dispatcher that mints from a queued-jobs API is a NEW path those controls were
 * not designed against, and `runs-on` having filtered it is not something the
 * mint can observe.
 */
export function isForkSafe(run: RunIdentity): AdmissionResult {
	// pull_request_target runs base-repo secrets against head-repo code. Nothing
	// in this fleet uses it (check:supply-chain enforces that), so seeing one here
	// means something changed underneath us.
	if (run.event === 'pull_request_target') {
		return { ok: false, reason: 'pull_request_target: base secrets, head code' };
	}
	const base = run.repository?.full_name;
	const head = run.head_repository?.full_name;
	if (!base) return { ok: false, reason: 'run has no repository — cannot prove it is first-party' };
	// A run with no head_repository is not a code-bearing PR event (schedule,
	// workflow_dispatch, repository_dispatch). Those are first-party by
	// construction: only someone with write access can trigger them.
	if (head === undefined) return { ok: true };
	if (run.head_repository?.fork === true) {
		return { ok: false, reason: `head repository ${head} is a fork` };
	}
	if (head !== base) {
		return { ok: false, reason: `head repository ${head} is not ${base}` };
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Placement: capability, then order
// ---------------------------------------------------------------------------

/**
 * Labels every self-hosted runner carries implicitly, lower-cased for matching.
 *
 * DERIVED from the capability registry's `IMPLICIT_LABELS`, which is the single
 * cased list — this was a third literal copy of it. Kept as an export because
 * `satisfiesLabels` below and two tests read it as a Set.
 */
export const IMPLICIT_LABELS = new Set(REGISTRY_IMPLICIT_LABELS.map((l) => l.toLowerCase()));

/** Can this node serve a job asking for `wanted`? */
export function satisfiesLabels(nodeLabels: readonly string[], wanted: readonly string[]): boolean {
	const have = new Set(nodeLabels.map((l) => l.toLowerCase()));
	return wanted.every((w) => IMPLICIT_LABELS.has(w.toLowerCase()) || have.has(w.toLowerCase()));
}

export interface NodeState extends AdmissionInput {
	name: string;
	/** What this node advertises. A job wanting more than this cannot run here. */
	labels?: readonly string[];
	/** The node is reachable and not quarantined. */
	healthy: boolean;
	/**
	 * A NODE-LEVEL flag, independent of which repo is asking.
	 *
	 * This used to be documented as "the manifest's excludeRepos, inverted" —
	 * wrong even when it was written: `excludeRepos` is keyed per repo, and a
	 * single boolean cannot carry a per-repo answer. `ephemeral-tick.ts`
	 * accordingly hardcoded this `true` for every node (#82) — the per-repo
	 * question was never actually asked anywhere on the JIT path. The real
	 * per-repo answer is {@link excludedRepos} below, added wave 3w. `eligible`
	 * stays for whatever node-wide "do not place anything here at all" signal a
	 * future caller wants (today, nothing sets it `false`); every existing
	 * caller and test that reads it as "always true today" is unaffected.
	 */
	eligible: boolean;
	/**
	 * Repos this node refuses, with the manifest's own reason — the manifest's
	 * `excludeRepos`, carried through verbatim (#82).
	 *
	 * ENFORCEMENT ONLY STARTED wave 3w, 2026-10-03. Before it, `ephemeral-tick.ts`
	 * built every `NodeState` with `eligible: true` and nothing read
	 * `excludeRepos` on the JIT path at all — the reconciler (`placement-rules.mjs`)
	 * honoured it for STANDING registrations, but a node's live JIT eligibility and
	 * its standing-runner roster are two different assignment paths (the "two
	 * assignment paths" class this wave's guard exists to catch), and nothing kept
	 * them in agreement: claw-3 ran 122 of its 815 jobs (15%) for repos its own
	 * `excludeRepos` claimed to exclude, as recently as 2026-10-03T09:21Z.
	 *
	 * `undefined`, or a map with no entry for the queued repo, means "not
	 * excluded" — every caller before this wave, and every node the manifest
	 * declares no `excludeRepos` for, see today's walk unchanged.
	 */
	excludedRepos?: ReadonlyMap<string, string>;
	/**
	 * The repo a LIVE warm-cache-of-one listener on this node currently serves.
	 *
	 * P5.1 (`docs/planning/warm-listener-cache-2026-09-05.md`): "placement must
	 * gain warm-affinity as a first-order term ahead of least-loaded". A
	 * registration is REPO-SCOPED — a listener warm for `hadoku_site` is worth
	 * nothing to a `hadoku-pygmalion` job — so this names the ONE repo, not a
	 * boolean.
	 *
	 * MUST come from the GitHub runner listing reporting this node's `warm-*`
	 * registration as online, never from the warm-cache tick's own fill/rotate
	 * bookkeeping. Issue #17: that bookkeeping said the cache was fine on
	 * claw-3/4/5 while every one of their listeners had failed every fill since
	 * 23:04Z and only claw-1 actually held one — "the reader for a facet may
	 * not read what the writer wrote" (CLAUDE.md), same as cgroup limits coming
	 * from the kernel and not `systemctl show`. `choosePlacement` cannot enforce
	 * that source itself — it stays pure, the same reason `healthy` and
	 * `eligible` are already caller-verified booleans rather than something
	 * this file goes and checks.
	 *
	 * `undefined` means no listener, or nobody looked — either way this falls
	 * through to plain ordering, exactly like `unmeasured` does everywhere else
	 * in this workstream. Never a reason to refuse the node; only a reason not
	 * to prefer it.
	 */
	warmRepo?: string;

	/**
	 * A PROVEN FLOOR for this repo on this node, where one exists — never an
	 * ordinary estimate (#76, scoped 2026-10-02). The builder (`ephemeral-tick.ts`'s
	 * `dispatchEphemeral`) adds an entry ONLY when `jobReserve`'s answer for this
	 * repo is `lowerBound: true`: a repo whose own figure is merely measured or
	 * fleet-p95 — above OR below the node's hand-set `jobP95Mb` — gets no entry
	 * at all, so it reserves exactly what it does on main today. Activating every
	 * repo's own figure here would be a second, unasked admission change; only a
	 * reservation PROVEN to be a lower bound is allowed to move anything.
	 *
	 * Keyed on the queued job's repo, which `choosePlacement` already receives as
	 * its own `repo` parameter for the affinity term, so nothing new has to reach
	 * this function from outside it. `undefined` — the whole map, or one repo's
	 * entry in it — is every caller before #76, and every one that never
	 * supplies `repo` to `choosePlacement` either: both fall straight through to
	 * the plain `requiredMb`/`requiredIsLowerBound` already on `m`.
	 */
	requiredMbByRepo?: ReadonlyMap<string, { mb: number; lowerBound: boolean }>;

	/**
	 * The fleet's speed model (#83), shared by reference across every
	 * `NodeState` in one tick — `ephemeral-tick.ts` rebuilds it on its own
	 * cadence (see `SPEED_MODEL_REBUILD_INTERVAL_MS`) and hands the SAME object
	 * to every node, which is why this is attached per-node rather than taken as
	 * a separate argument to {@link choosePlacement}: `NodeState` is already
	 * the one thing this file's whole call chain (`dispatcher.ts` ->
	 * `dispatch-pass.ts` -> `dispatch-tick.ts`, none of which know or care about
	 * this field) carries through untouched, so piggybacking on it needs no
	 * signature change outside this lane.
	 *
	 * `undefined` for a caller that never attaches one — every test and every
	 * caller before this wave — and `refusalFor` treats a node with no model
	 * the same as one whose model says 'unknown': never held back.
	 */
	speedModel?: SpeedModel;

	/**
	 * GitHub cannot currently place a job here — mirrors `TrafficNode.schedulable`
	 * (`traffic.ts`), carried onto `NodeState` too (#102) now that `choosePlacement`
	 * does its OWN busy-aware re-rank (see `walkOrder` below) rather than only
	 * walking whatever order the caller already ranked. Without this, a node with
	 * zero WORKING registrations but `busy: 0` would look perfectly idle to the
	 * busy-ascending step and win every placement — the exact 2026-09-02 claw-4
	 * shape `orderCandidates`'s own doc describes, reintroduced one layer down.
	 *
	 * `undefined` means nobody looked and is treated as schedulable — absent
	 * evidence must not silently remove a working node from the fleet, same
	 * rule as `TrafficNode.schedulable`.
	 */
	schedulable?: boolean;

	/**
	 * The fleet's heavy-kind model (#102), shared by reference across every
	 * `NodeState` this tick builds — the SAME pattern as {@link speedModel}.
	 * `undefined` for a caller that never attaches one (every test and every
	 * caller before this wave): every job then reads as light and no node is
	 * ever treated as `runningHeavy`, i.e. today's walk bit for bit.
	 */
	heavyModel?: HeavyModel;

	/**
	 * Is this node CURRENTLY serving at least one heavy-kind job — #102.4,
	 * "a light job ranks a node running a heavy job last". `ephemeral-tick.ts`
	 * sets the OBSERVED initial value from the probe's per-repo attribution
	 * (`HeavyModel.isHeavyRepo`, since a running worker's exact job name is not
	 * observable — see that method's own note on the approximation this rests
	 * on). `planTick`'s own working copy then RAISES this to `true` on the SAME
	 * object when IT places a heavy job there this tick, so a burst of heavy
	 * jobs spreads across nodes exactly like `liveUnits` already does for busy.
	 *
	 * `undefined`/`false` is "not known to be running one" — every caller
	 * before this wave, and the safe default once a heavy job's own classifier
	 * (`HeavyModel`) is absent.
	 */
	runningHeavy?: boolean;

	/**
	 * How many heavy-KIND jobs this node is KNOWN, by exact job name, to be
	 * running — the input to {@link HEAVY_HOLD_SEC}'s hold, which
	 * {@link runningHeavy} cannot feed because it is repo-level: a light
	 * cardtable `check` reads as "running heavy" there, and a refusal built
	 * on that would hold a Forge shard off a node doing nothing heavy.
	 *
	 * Sourced from the queued runs' own job listings (`dispatch-pass.ts`'s
	 * `runningJobs`), which name the runner and the job of every in-progress
	 * SIBLING — the run that is pushing its other shards out right now — plus
	 * `planTick`'s own heavy placements this tick. A heavy job from a run with
	 * nothing left queued is not in any listing this tick reads, so this is a
	 * LOWER bound: the hold can miss one, never invent one.
	 */
	heavyJobs?: number;

	/**
	 * Warm listeners this node HOLDS a slot for — the same count `mintBudget`
	 * already spent out of `maxConcurrent` (`ephemeral-tick.ts`). Carried here
	 * so `dispatch-pass.ts` can keep a held listener's own Runner.Worker OUT of
	 * `standingBusy`: the probe counts every Worker on the box, and a slot
	 * that is held whether or not the listener is busy must not be charged a
	 * second time when it is. Absent means none held — every caller before
	 * 2026-10-21, and every hand-built test fixture.
	 */
	warmHeld?: number;

	/**
	 * HELD warm listeners on this node SEEN running a job, by runner name, in
	 * the queued runs' own job listings (`dispatch-pass.ts`'s `runningJobs`).
	 * Load for the busy-ascending RANK (`busyOf`), never for admission: the
	 * slot each occupies is already out of `maxConcurrent` via
	 * {@link warmHeld}. A busy listener the node holds NO slot for is not
	 * here — it is a standing job and lands in `standingBusy`. A lower bound,
	 * like `heavyJobs`: a listener serving a run with nothing left queued is
	 * in no listing this tick reads.
	 */
	warmBusy?: number;
}

/**
 * How long a heavy job holds out for a node not already running a heavy job
 * (#102) before taking one that is.
 *
 * Doubling two heavy jobs on one node buys no wall time and costs reds:
 * cardtable run 37851403985 (2026-10-08 22:08Z) put forge-e2e (2), (3) and
 * forge-jvm on claw-4 at once because three jdk21 nodes cannot hold four
 * jdk21 jobs one apiece. Both doubled shards took ~16 min against 7-11 alone
 * on claw-8/9 — about what running them back to back costs — and every
 * spec that failed, 8 of them, was the play server's 20 s match-create POST
 * timing out under CPU starvation. Shard 1, alone on claw-9, was green.
 *
 * 3600 s, raised from 900 on 2026-10-09: under a real backlog the clock, not a
 * freed node, was how holds ended. Eleven verify dispatches queued in ten
 * minutes, every job passed 900 s, and claw-4 took two Forge shards at load 13
 * on 8 cores — the doubling the hold exists to stop, at the moment it costs
 * most. A node frees as soon as one shard finishes (~10 min), so waiting is
 * never slower than doubling; the clock stays only so a heavy job never queues
 * forever (#102.4), matching the stuck-run ceiling.
 */
export const HEAVY_HOLD_SEC = 3600;

/**
 * The floor a slow-tier node must clear before it takes a job, when
 * {@link SpeedModel.expectedExtraSec} has nothing to estimate from (#83).
 *
 * 100s, the SAME number and the SAME precedent as the fleet's existing guest
 * backstop gate (`backstop.ts`'s `SATURATION_QUEUE_SECONDS`: the last-30-days
 * p90 of `hadoku-builder` queue time, 1,247 jobs). That gate already answers
 * "how long is a wait that means something" for spilling onto the fleet's
 * other last-resort capacity; a slow claw is the same question asked one
 * tier up, so it reuses the answer rather than picking a second number that
 * could silently drift from it.
 */
export const SPILL_FLOOR_SEC = 100;

export interface Placement {
	node?: string;
	/** Why each node ahead of the chosen one was passed over. Kept because a
	 * dispatcher that silently picks the last candidate looks identical to one
	 * that is broken, and "why did this land there" is the question that gets
	 * asked. */
	passed: { node: string; reason: string; holdSec?: number }[];
	/** Why there is no node. Set only when `node` is not. */
	reason?: string;
	/**
	 * Was the chosen node preferred BECAUSE of warm affinity, rather than
	 * because it was already first among the survivors?
	 *
	 * Not a decision by itself — a caller averaging this over many placements
	 * is how "how often is a warm claw actually the reason a job landed where
	 * it did" gets answered with a number instead of an adjective (P5.3).
	 * `false` (never `undefined`) whenever a node was chosen without `repo`
	 * being supplied, or without that node carrying affinity for it, so a
	 * caller can sum this field directly without a null check.
	 */
	viaAffinity: boolean;
	/**
	 * The reserve admission ACTUALLY USED to decide this placement, when it
	 * differs from the chosen node's flat `requiredMb` (#77).
	 *
	 * Set only by the SAME clause in {@link refusalFor} that raises what
	 * `admitMint` checks for a proven lower-bound reserve
	 * (`NodeState.requiredMbByRepo`, #76): `Math.max(node.requiredMb, own.mb)`.
	 * `undefined` for every ordinary repo — no entry, or an entry with
	 * `lowerBound: false` — which is every call site before #76 and every
	 * repo without a proven floor today.
	 *
	 * `planTick` decrements the chosen node's `freeMb` by
	 * `placed.requiredMb ?? chosen.requiredMb` specifically so an ordinary
	 * repo consumes exactly what it always has (bit-for-bit today's
	 * arithmetic) and only a lower-bound reserve changes what one mint takes
	 * out of the SAME tick's remaining capacity. Before this field existed,
	 * `planTick` decremented by the node's flat `requiredMb` regardless of
	 * what `admitMint` actually admitted against, so a lower-bound repo's
	 * mint freed up less headroom than it had just been proven to need —
	 * wave 3t lane C's two-jobs-one-tick overfill.
	 */
	requiredMb?: number;
	/**
	 * Was the QUEUED JOB ITSELF classified heavy (#102) — from whichever
	 * node's {@link NodeState.heavyModel} this walk found (the same shared
	 * object on every node this tick), keyed on (`repo`, `spill?.jobName`).
	 *
	 * SURFACED here rather than left for the caller to re-derive, because
	 * `planTick` needs it to raise the CHOSEN node's `runningHeavy` for the
	 * rest of the tick, and re-deriving it there would be a SECOND classifier
	 * that could disagree with this one — the same "ONE ranking function, not
	 * two" rule #102.2 states for the busy/affinity walk itself.
	 *
	 * `false` whenever `repo` is omitted or no node carries a `heavyModel` —
	 * every caller before this wave sees no change from this field existing.
	 */
	heavy: boolean;
}

/** This node's running jobs — standing registrations GitHub assigned directly,
 *  plus live (minted, not yet finished) units — see `traffic.ts`'s
 *  `TrafficNode.busy` for the ordering concept this mirrors. Computed fresh
 *  every call rather than cached on the node, because `planTick` mutates
 *  `standingBusy`/`liveUnits` on this SAME object between placements within
 *  one tick (#102.2) — a cached value here would go stale after the first
 *  placement.
 *
 * EXPORTED so `planTick` (dispatcher.ts) can read the SAME number it just
 * ranked on, for the dispatch log's `placed=node@busy` report (#102.4) —
 * never a second formula that could silently drift from the one the walk
 * actually used. */
export function busyOf(m: NodeState): number {
	return m.standingBusy + m.liveUnits + (m.warmBusy ?? 0);
}

/**
 * Context about the QUEUED JOB the spill gate (#83) needs, beyond `repo` and
 * `wantedLabels` — kept as its own object rather than two more positional
 * parameters because both are specific to that one gate, unlike `repo`, which
 * the affinity term also reads.
 */
export interface SpillContext {
	/**
	 * Seconds the current attempt has been queued, per {@link queuedSinceMs}
	 * (`queue-discovery.ts`) — computed by the CALLER, which holds `nowMs`;
	 * this file stays clockless. `undefined` when the run's timestamps could
	 * not be read, and that must NEVER be treated as "has waited long enough" —
	 * see the gate below, which refuses whenever this is `undefined`.
	 */
	queuedSec?: number;
	/** The queued JOB's own name, for `SpeedModel.expectedExtraSec`'s (repo,
	 *  job) lookup. `undefined` falls back to that function's own (repo), then
	 *  node-ratio, fallback order — never an error. */
	jobName?: string;
}

/**
 * Every per-node refusal in the walk, in order, or `reason: null` for "take
 * it" — alongside the reserve admission actually checked, for a caller that
 * must decrement the SAME number out of its own working copy (#77;
 * {@link Placement.requiredMb}).
 */
function refusalFor(
	m: NodeState,
	wantedLabels: readonly string[],
	repo?: string,
	spill?: SpillContext,
	heavy = false
): {
	reason: string | null;
	requiredMb?: number;
	/**
	 * Set on a refusal that TIME alone lifts: the job's queued age, in seconds,
	 * at which this node stops holding it. The dispatcher's probe backoff (#117)
	 * reads it so a hold that is about to release is re-asked at that moment,
	 * not two minutes later. Absent on every refusal a clock cannot change.
	 */
	holdSec?: number;
} {
	if (!m.healthy) return { reason: 'unhealthy or quarantined' };
	if (!m.eligible) return { reason: 'repo excluded here' };
	// PER-REPO EXCLUSION (#82). `m.eligible` above is node-wide and nothing sets
	// it `false` today — this is the manifest's actual `excludeRepos` answer,
	// keyed on the repo THIS job belongs to. `undefined` `repo`, an `undefined`
	// map, or a map with no entry for this repo all fall straight through —
	// every caller before this wave, and every node with no `excludeRepos`.
	const excludedReason = repo ? m.excludedRepos?.get(repo) : undefined;
	if (excludedReason !== undefined) return { reason: `repo excluded here: ${excludedReason}` };
	if (wantedLabels.length && !satisfiesLabels(m.labels ?? [], wantedLabels)) {
		return { reason: `does not carry ${wantedLabels.join(', ')}` };
	}
	// `admitMint` refuses `drained` first, ahead of capacity and memory: an
	// operator saying "nothing lands here" outranks every job-shaped argument.
	//
	// THE QUEUED JOB'S OWN REPO FLOOR, ONLY WHEN ONE IS PROVEN (#76, scoped
	// 2026-10-02). `requiredMbByRepo` is SUPPOSED to hold an entry only for a
	// repo whose own reserve is `lowerBound: true` — the builder
	// (`dispatchEphemeral`) filters on exactly that before it ever inserts one.
	// `own.lowerBound` is checked AGAIN here anyway: this function must not
	// trust a map it did not build to already honour the one rule that makes
	// the override safe, the same reason `admitMint`'s own placement clause
	// re-checks `requiredIsLowerBound` rather than trusting a caller's
	// `requiredMb` at face value. An ORDINARY repo's own figure — above or
	// below the node's — is never consulted, so every repo with no entry, or a
	// `false` one, takes `m` unchanged — bit-for-bit today's walk. And even for
	// a repo that clears the check, the override is `max(m.requiredMb, own.mb)`,
	// never `own.mb` alone: a floor PROVEN on another node (or this one, at a
	// smaller cap) can only RAISE what this node reserves, never shrink it
	// below what every other job already reserves here today.
	const own = repo ? m.requiredMbByRepo?.get(repo) : undefined;
	// `undefined` unless the lower-bound clause actually raises the number —
	// the SAME condition that builds the override below, so this can never
	// disagree with what `admitMint` was actually asked about.
	const requiredMb = own?.lowerBound ? Math.max(m.requiredMb, own.mb) : undefined;
	const admit = admitMint(
		requiredMb !== undefined ? { ...m, requiredMb, requiredIsLowerBound: true } : m
	);
	if (!admit.ok) return { reason: admit.reason ?? 'refused' };

	// THE HEAVY HOLD (#102) — see HEAVY_HOLD_SEC. Exact counts only
	// (`heavyJobs`, never the repo-level `runningHeavy`), and an unknown queue
	// age holds, the same rule the spill gate below states for itself.
	const heavyHere = m.heavyJobs ?? 0;
	if (heavy && heavyHere > 0) {
		const queuedSec = spill?.queuedSec;
		if (queuedSec === undefined || queuedSec < HEAVY_HOLD_SEC) {
			const waited = queuedSec === undefined ? 'unknown' : `${Math.round(queuedSec)}s`;
			return {
				reason:
					`heavy hold: already running ${heavyHere} heavy job(s) ` +
					`(queued ${waited} < ${HEAVY_HOLD_SEC}s)`,
				holdSec: HEAVY_HOLD_SEC,
			};
		}
	}

	// THE SLOW-TIER SPILL GATE (#83). Checked LAST, after capacity, so a slow
	// node that is also just plain full still refuses on capacity — the
	// refusal a caller would otherwise expect — rather than on a wait that
	// would be moot anyway. `'normal'` and `'unknown'` are UNAFFECTED: the
	// operator's rule ("if the best claws are already working... queueing to
	// the bottom of the barrel becomes worth it under heavy load") only ever
	// holds back the nodes measured slow, and a brand-new node with no history
	// is `'unknown'`, which places like `'normal'` so it can EARN history
	// rather than being judged on none (§B.3/§A.4 of the wave brief).
	if (m.speedModel?.tierOf(m.name) === 'slow') {
		// `expectedExtraSec` needs `repo`; without one there is nothing to look
		// up and the floor-times-ratio fallback below applies, exactly as it
		// does when the lookup itself returns `null`.
		const extraSec =
			repo !== undefined ? m.speedModel.expectedExtraSec(m.name, repo, spill?.jobName) : null;
		const { p25, p50 } = m.speedModel.describe(m.name);
		// NOT ZERO when there is nothing to estimate from (§A.4): a null extra
		// falls back to the floor scaled by this node's own overall ratio
		// (`describe().p50`), so a node measured only mildly slow overall does
		// not inherit the SAME floor as one measured catastrophically slow on
		// everything. `p50 ?? 1` is the "nothing to scale by either" case —
		// `tierOf` returning 'slow' already implies MIN_KINDS qualifying ratios
		// exist (speed-tier.ts), so this is defensive, not an expected path.
		const thresholdSec =
			extraSec !== null ? Math.max(SPILL_FLOOR_SEC, extraSec) : SPILL_FLOOR_SEC * (p50 ?? 1);
		const queuedSec = spill?.queuedSec;
		// `undefined` is NEVER "waited long enough" — a run whose queue age
		// could not be established must never spill, which is why this is a
		// strict `<` against a defined number rather than `queuedSec < threshold`
		// alone (that would coerce `undefined < x` to `false`, i.e. "not held
		// back", by accident rather than by this being asserted explicitly).
		if (queuedSec === undefined || queuedSec < thresholdSec) {
			const waited = queuedSec === undefined ? 'unknown' : `${Math.round(queuedSec)}s`;
			return {
				reason:
					`slow tier: holding for a faster node (queued ${waited} < ${Math.round(thresholdSec)}s; ` +
					`${m.name} p25 ${p25 ?? 'null'})`,
				holdSec: thresholdSec,
			};
		}
	}
	return { reason: null, requiredMb };
}

/**
 * Pick a node, re-ranking `order` (the tick's once-per-pass baseline from
 * `orderCandidates`: speed/idle/schedulability/name) against the fleet's
 * CURRENT load, then taking the first survivor with no refusal.
 *
 * ONE RANKING FUNCTION, NOT TWO (#102.2). Before this wave, `order` was
 * walked exactly as given except for one unconditional reorder: every node
 * carrying a verified-live listener for `repo` was stable-sorted to the
 * FRONT, regardless of how busy it already was — the 05:29:43Z tick that
 * logged `via-affinity=2 affinity-moved=2` while claw-9 stacked three
 * cardtable Forge jobs. That was two ranking engines (the baseline order,
 * then a second affinity-only reorder on top of it) which could — and did —
 * disagree about whether load mattered more than a warm cache. This function
 * is the single replacement: for the ONE job being placed, `walkOrder` below
 * sorts the candidates by
 *
 *   0. for a job that IS heavy: fewest heavy jobs already running
 *      ({@link NodeState.heavyJobs}) — and a node with any is refused
 *      outright until {@link HEAVY_HOLD_SEC};
 *   1. busy — THIS node's running jobs plus live units ({@link busyOf}),
 *      read off the SAME `NodeState` objects `planTick` mutates between
 *      placements (#102.2), so a burst of jobs in one tick sees each other's
 *      placements, not a tick-stale snapshot;
 *   2. for a job NOT itself heavy (#102.4): a node already running a
 *      heavy-kind job sorts after one that is not — "a light job ranks a
 *      node running a heavy job last";
 *   3. warm affinity for `repo` (P5.1) — now correctly a TIE-BREAK among
 *      nodes equal on (1) and (2), never an override of either;
 *   4. the position `order` already gave two nodes neither of the above can
 *      tell apart — so this NEVER disagrees with the tick's own baseline
 *      ranking, only refines it within the tick as placements happen.
 *
 * Everything that must NOT be used at all — unhealthy, quarantined, excluded,
 * missing a label, drained, full, unschedulable — is still a REFUSAL below,
 * not a rank, because a rank can always be out-voted by a heuristic. A
 * per-node ceiling (thermal or otherwise) is the node's `maxConcurrent`,
 * which `admitMint` enforces.
 *
 * There used to be a `demoted` refusal fed by the tier ladder, plus a second
 * walk re-admitting demoted nodes for labels only they carried (issue #35).
 * Nothing in production ever set `demoted`, so both were tested code that could
 * not fire; they went with the ladder on 2026-09-21.
 *
 * `repo` ALSO SELECTS A PER-NODE MEMORY FIGURE, not only the affinity/heavy
 * terms (#76): `refusalFor` reads `NodeState.requiredMbByRepo` for it before
 * calling `admitMint`, so the SAME `repo` this function already took for warm
 * affinity is what lets a job whose own measured runs were all capped (a
 * lower bound, never the whole truth) refuse a node whose slice cannot be
 * shown to hold it — see {@link AdmissionInput.requiredIsLowerBound} and the
 * PLACEMENT clause in `admitMint` for the mechanism. A caller that never
 * populates the map, or never supplies `repo`, sees today's walk unchanged.
 *
 * "A `repo` the caller never supplied" WAS EVERY DISPATCH THIS FLEET MADE for
 * the first five days warm affinity existed. The term is not a no-op any
 * more; see the `repo` parameter's own note for what now supplies it and what
 * keeps it supplied.
 */
export function choosePlacement(
	order: readonly string[],
	nodes: readonly NodeState[],
	/**
	 * Labels the queued JOB asked for.
	 *
	 * Minting a runner that cannot match them spawns a listener nothing will ever
	 * schedule onto — `QueuedRun.labels` has carried a comment saying exactly that
	 * since the field was written, and nothing read it. On 2026-08-29 claw-3
	 * minted for a tenhands job wanting `pm2-host, taskauto`, which it does not
	 * and cannot carry.
	 */
	wantedLabels: readonly string[] = [],
	/**
	 * The queued JOB's repo.
	 *
	 * **SUPPLIED BY THE LIVE MINT PATH SINCE 2026-09-15.** `dispatcher.ts`'s
	 * `planTick` passes `run.repo`, and `ephemeral-tick.ts` supplies the
	 * matching `NodeState.warmRepo` off GitHub's runner listing. Until then it
	 * was supplied by NOTHING, and the whole affinity term below was dead code
	 * in production for five days and ~2,000 jobs while the tracker recorded it
	 * as "landed unmeasured" — `warm-affinity-measured-2026-09-14.md` §3
	 * falsified that in source and in the deployed 0.22.108.
	 *
	 * An OPTIONAL parameter is a feature that can ship switched off without
	 * anything going red, so what guards it is a test of the CALL SITE and not
	 * the type: `placement.test.ts`'s "the live mint path supplies the queued
	 * run's repo" fails if this argument is dropped again.
	 *
	 * Still optional, because omitting it is still SAFE rather than merely
	 * tolerated: the affinity/heavy terms below then treat every node as
	 * equal, so a caller with no repo in hand gets today's walk bit for bit.
	 */
	repo?: string,
	/**
	 * The slow-tier spill gate's (#83) per-run inputs — see {@link SpillContext}.
	 * Omitted entirely by a caller with nothing to offer: `refusalFor` then
	 * never sees a `queuedSec`, which is the same "never spill" path an
	 * explicit `undefined` takes, so a caller unaware of this parameter gets
	 * today's walk bit for bit. `spill.jobName` doubles as the heavy-kind
	 * classifier's exact-match key (#102) — the same field `expectedExtraSec`
	 * already reads, not a second one.
	 */
	spill?: SpillContext
): Placement {
	const byName = new Map(nodes.map((m) => [m.name, m]));

	// THE HEAVY MODEL (#102), shared by reference across every node this tick
	// built — the SAME pattern as `speedModel`. `undefined` when no node
	// carries one (every caller before this wave): `heavy` stays `false`,
	// which is the safe default documented on {@link Placement.heavy}.
	const heavyModel = nodes.find((n) => n.heavyModel)?.heavyModel;
	const heavy = repo !== undefined && heavyModel ? heavyModel.isHeavy(repo, spill?.jobName) : false;

	// UNSCHEDULABLE NODES NEVER WIN A RE-RANK, same rule and same reason as
	// `orderCandidates`'s own split (traffic.ts): "fewest busy" alone would
	// rank a node with zero WORKING registrations first — it looks perfectly
	// idle. Split OFF before the comparator runs, not folded into it, so busy/
	// heavy/affinity can never promote one past a placeable node.
	const known = order.filter((n) => byName.has(n));
	const unknown = order.filter((n) => !byName.has(n));
	const placeable = known.filter((n) => byName.get(n)?.schedulable !== false);
	const unplaceable = known.filter((n) => byName.get(n)?.schedulable === false);

	// THE POSITION `order` ALREADY GAVE EACH NODE — the final tie-break below,
	// and the thing that makes this a REFINEMENT of the tick's baseline
	// ranking rather than a second one that can disagree with it (#102.2's
	// own "ONE ranking function" rule). Two nodes busy/heavy/affinity cannot
	// tell apart keep exactly the relative order `orderCandidates` already
	// gave them upstream.
	const posOf = new Map(order.map((n, i) => [n, i]));

	const walkOrder = [...placeable].sort((a, b) => {
		const x = byName.get(a)!;
		const y = byName.get(b)!;
		// 1. Fewest jobs in flight — THIS is the fix for "busy counted distinct
		//    repos, not jobs" (#102.1): `busyOf` reads the actual running+live
		//    count, and it is read fresh here, after whatever `planTick` has
		//    already mutated onto these SAME objects this tick (#102.2).
		// 0. A heavy job takes the node running the FEWEST heavy jobs first
		//    (#102): once HEAVY_HOLD_SEC expires and every node has one, two
		//    light jobs are still a better neighbour than one Forge shard.
		if (heavy) {
			const xh = x.heavyJobs ?? 0;
			const yh = y.heavyJobs ?? 0;
			if (xh !== yh) return xh - yh;
		}
		const xb = busyOf(x);
		const yb = busyOf(y);
		if (xb !== yb) return xb - yb;
		// 2. Heavy avoidance (#102.4), ONLY for a job that is not itself heavy:
		//    a node already running a heavy-kind job sorts after one that is
		//    not. A heavy job does not apply this — it already gets what it
		//    wants from step 1 (an empty node, when one exists) and must still
		//    place on a busy node rather than queue forever when none does.
		if (!heavy) {
			const xh = x.runningHeavy ? 1 : 0;
			const yh = y.runningHeavy ? 1 : 0;
			if (xh !== yh) return xh - yh;
		}
		// 3. Warm affinity (P5.1) — a TIE-BREAK among nodes equal on (1) and
		//    (2), never an override of either. `repo === undefined` (no caller
		//    wired up, or the counterfactual walk below) skips this entirely,
		//    which is the same "reorders to nothing" fallback this term has
		//    always had.
		if (repo !== undefined) {
			const xa = x.warmRepo === repo ? 0 : 1;
			const ya = y.warmRepo === repo ? 0 : 1;
			if (xa !== ya) return xa - ya;
		}
		// 4. The baseline order's own position — see `posOf` above.
		return posOf.get(a)! - posOf.get(b)!;
	});

	const passed: Placement['passed'] = [];
	const note = (node: string, reason: string, holdSec?: number): void => {
		passed.push(holdSec === undefined ? { node, reason } : { node, reason, holdSec });
	};
	for (const name of [...walkOrder, ...unplaceable, ...unknown]) {
		const m = byName.get(name);
		if (!m) {
			note(name, 'not in the fleet');
			continue;
		}
		const { reason, requiredMb, holdSec } = refusalFor(m, wantedLabels, repo, spill, heavy);
		if (reason) {
			note(name, reason, holdSec);
			continue;
		}
		return {
			node: name,
			passed,
			viaAffinity: repo !== undefined && m.warmRepo === repo,
			requiredMb,
			heavy,
		};
	}
	// QUEUE, do not force. Every node being full is the normal shape of a
	// burst, and minting anyway is precisely the OOM this workstream exists to
	// stop — the fleet already has a bounded smoother for jobs GitHub has already
	// placed (§11.1), and it is not a cap.
	return { passed, reason: 'no node can take this job right now', viaAffinity: false, heavy };
}
