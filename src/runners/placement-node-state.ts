/**
 * `NodeState` — wave 5s lane A split of `placement.ts` (pure move), so that
 * file falls under the 800-line source ceiling.
 *
 * The capability check (`satisfiesLabels`, `IMPLICIT_LABELS`) and the shape
 * every node this tick's walk ranks against (`NodeState`) — see
 * `placement.ts` for the ranking and refusal logic that reads this shape.
 * Every name here is re-exported from `placement.ts` so its existing
 * importers compile unchanged.
 */
import { IMPLICIT_LABELS as REGISTRY_IMPLICIT_LABELS } from '../lib/capability-labels.js';
import type { AdmissionInput } from './ephemeral-admission.js';
import type { SpeedModel } from './speed-tier.js';
import type { HeavyModel } from './heavy-model.js';

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
	/**
	 * An on-demand backstop (#120): minted for the work only it can do, and given
	 * `hadoku-builder` only while the backstop holds it. On such a node,
	 * OVERFLOW work is capped below the node's own capacity (#15, see
	 * {@link BACKSTOP_SOLE_CARRIER_SLOTS}). Absent means a claw.
	 */
	onDemandBackstop?: boolean;
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
