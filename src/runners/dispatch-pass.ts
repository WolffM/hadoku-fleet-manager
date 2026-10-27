/**
 * The dispatch pass: turn "this node may mint" into runners that exist.
 *
 * Runs once per dispatcher pass, and only for nodes carrying `ephemeral: true`
 * — every claw since 2026-09-07, so this path serves the fleet's CI. On a fleet where nothing sets it
 * `runDispatchPass` returns immediately and costs one map lookup.
 *
 * WHY THIS IS A SEPARATE PASS FROM setTierEligibility
 * --------------------------------------------------
 * Label toggling is idempotent and stateless: it asks GitHub what the labels
 * are and makes them match. Minting is neither. It creates registrations that
 * outlive the process that made them (§12.8), it must not exceed a cap that is
 * shared with runners GitHub places without asking (B2), and after an mgmt-api
 * restart the truth about what is in flight lives on the NODES, not here.
 * Folding that into the label loop would have hidden all three.
 */
import { logger } from '../host.js';
import { withGhCaller } from '../gh-budget.js';
import { planTick, type PendingRun, type SkipReason } from './dispatcher.js';
import {
	mintEphemeralRunner,
	liveJitUnitRecords,
	liveJitSlots,
	evictWarmListener,
	retireStrandedJit,
	type LiveJitUnit,
	warmRegistration,
	reapJitRunners,
	REAP_INTERVAL_MS,
	REAP_IDLE_INTERVAL_MS,
	type GhLike,
	type ShellLike,
} from './ephemeral-exec.js';
import { JIT_PREFIX, WARM_PREFIX, parseJitName, warmRunnerName } from './ephemeral.js';
import { recordCapacityLedger } from './capacity-ledger.js';
import { nodeOf } from './census.js';
import { recordDispatchDay } from './dispatch-daily.js';
import { satisfiesLabels, type NodeState } from './placement.js';
import type { FleetDispatchAffinity } from '../fleet-report-types.js';

export interface DispatchPassInput {
	/** Nodes allowed to mint, in placement order (see runners/traffic.ts). */
	order: string[];
	nodes: NodeState[];
	/** Queued runs the poll found, already filtered to `queued`. */
	pending: PendingRun[];
	/** Labels each node must project onto anything it mints. */
	labelsFor: (node: string) => string[];
	/** The node's ci user's home (`nodeHome(machine, 'ci')`): where its slots live. */
	homeDirFor: (node: string) => string;
	/**
	 * Where a node with no standing install may fetch a runner release.
	 * Resolved once per tick by the caller — see runnerTarballUrl.
	 */
	tarballUrl?: string | null;
	/**
	 * The unit's `MemoryMax` for a mint of `repo` on `node`. Asked per mint,
	 * once placement has chosen the node, because a guest's cap is its own
	 * declared one and a claw's is not (see `guestUnitMemoryMaxMb`).
	 */
	memoryMaxMbFor: (repo: string, node: string) => number;
	/**
	 * The slice a unit on `node` is placed in, from the manifest. Absent means
	 * every unit goes to the default slice.
	 */
	sliceNameFor?: (node: string) => string | null | undefined;
	ttlSeconds: number;
	/** Repos to sweep for orphaned JIT registrations. */
	repos?: string[];
	/** Injectable clock. Absent means `Date.now()`; tests drive the reap gate. */
	nowMs?: number;
	/**
	 * The in-progress SIBLINGS of every run `pending` came from, off the job
	 * listings the producer already read to find the waiting jobs.
	 *
	 * Two things only this knows. Its freshness: `NodeState.standingBusy` is
	 * the fleet probe's worker count, up to a fast-loop tick old, and a WARM
	 * listener's job is not a live JIT unit either — so on 2026-10-08 22:08:09Z
	 * claw-4 read `busy 0` with forge-e2e (3) eleven seconds into its warm
	 * listener, and took forge-e2e (2) and forge-jvm on top of it. And the
	 * running job's exact NAME, which the probe cannot see, so it is the one
	 * source of `NodeState.heavyJobs`. Absent is "none known", today's walk.
	 */
	runningJobs?: readonly RunningJob[];
}

/** One in-progress job, by the runner GitHub assigned it to. */
export interface RunningJob {
	repo: string;
	runner: string;
	jobName: string;
}

export interface DispatchPassResult {
	minted: number;
	failed: number;
	skipped: number;
	inFlight: number;
	/**
	 * Orphans deleted, or `null` for a pass that did not sweep — the reap runs
	 * on its own clock (REAP_INTERVAL_MS), so most passes do not. Not `0`: this
	 * is the "I could not look" distinction, and `fleet-report-types` already
	 * types the field `number | null` for exactly that reason.
	 */
	reaped: number | null;
	/**
	 * The pass's `unplaceable` skips, for the dispatcher's probe backoff (#117).
	 * Optional so every existing result literal stands; absent is "none".
	 */
	unplaceable?: SkipReason[];
	/**
	 * `repo#runId` of every held (backed-off) run this pass reserved a slot for.
	 * The dispatcher lifts their backoff so the next tick re-reads and mints.
	 */
	reserved?: string[];
}

/**
 * How long a node stays "running heavy" for the WARM tick after this pass
 * placed or saw a heavy job there — two fast-loop probes, by which time the
 * probe's own repo-level attribution has caught up.
 */
export const HEAVY_MARK_MS = 120_000;

/** node -> when this pass last placed or saw a heavy job there. Module state:
 *  lost on restart, which only reopens the ≤60 s window the probe leaves. */
const heavyMarkedAtMs = new Map<string, number>();

/** Did a dispatch pass place or see a heavy job on `node` within HEAVY_MARK_MS? */
export function heavyMarkedRecently(node: string, nowMs: number): boolean {
	const at = heavyMarkedAtMs.get(node);
	return at !== undefined && nowMs - at < HEAVY_MARK_MS;
}

/** Test seams. */
export function __resetHeavyMarksForTesting(): void {
	heavyMarkedAtMs.clear();
}
export function __markHeavyForTesting(node: string, atMs: number): void {
	heavyMarkedAtMs.set(node, atMs);
}

/**
 * When the reap last swept, epoch ms. 0 means "not yet this process".
 *
 * The docblock below says this pass reconstructs its state from the NODES
 * rather than remembering it, because mgmt-api restarts ~5x a day and anything
 * held here is wrong when it matters. This one is deliberate and does not break
 * that rule: it is a rate limiter, not a fact about the fleet. Losing it on
 * restart makes the next pass sweep immediately, which is the SAFE direction —
 * one extra listing per repo, once, versus a missed orphan — and no decision
 * anywhere reads it.
 */
let lastReapMs = 0;

/**
 * Per repo: when the sweep last READ its listing, and whether that listing still
 * held a `jit-*` registration afterwards. See REAP_IDLE_INTERVAL_MS (#116).
 *
 * The same kind of state as `lastReapMs` — a rate limiter, not a fact any
 * decision reads. Lost on restart, the next sweep walks every repo: the safe
 * direction, once.
 *
 * `heldJit` is GitHub's answer, off the reap's own listing — not a record of
 * what this process minted. The mint record below only ever ADDS a repo to a
 * sweep; nothing in this process's memory can take one out of it.
 */
const reapBook = new Map<string, { listedAtMs: number; heldJit: boolean }>();
/** repo -> when this process last minted there. Adds work; never removes it. */
const mintedAtMs = new Map<string, number>();

/**
 * The repos this sweep must list: any never listed, any that last held a JIT
 * registration, any minted to since its listing, and every other one once
 * REAP_IDLE_INTERVAL_MS has passed.
 */
export function reapTargets(repos: readonly string[], nowMs: number): string[] {
	return repos.filter((repo) => {
		const seen = reapBook.get(repo);
		if (!seen || seen.heldJit) return true;
		if ((mintedAtMs.get(repo) ?? -Infinity) >= seen.listedAtMs) return true;
		return nowMs - seen.listedAtMs >= REAP_IDLE_INTERVAL_MS;
	});
}

/** Test seam. Not part of the supported API. */
export function __resetReapClockForTesting(): void {
	lastReapMs = 0;
	reapBook.clear();
	mintedAtMs.clear();
}

/**
 * How many successful mints warm affinity landed on a warm node, and how many
 * it MOVED there — `warm-affinity-measured-2-2026-09-15.md` §5e.
 *
 * Module state, and that does not break the reconstruct-from-the-nodes rule
 * above for the same reason `lastReapMs` does not: no decision reads it. It
 * resets on restart, which is why the per-pass `[dispatch]` log line carries
 * the per-pass counts and the re-cut sums THOSE, never these totals.
 */
let affinity: FleetDispatchAffinity = {
	lastPass: null,
	totals: { minted: 0, mintedViaAffinity: 0, mintedAffinityMoved: 0 },
};

/** The affinity counters, for `GET /fleet`'s `dispatch.affinity`. */
export function getDispatchAffinitySnapshot(): FleetDispatchAffinity {
	return affinity;
}

/** Test seam. Not part of the supported API. */
export function __resetAffinityCountersForTesting(): void {
	affinity = {
		lastPass: null,
		totals: { minted: 0, mintedViaAffinity: 0, mintedAffinityMoved: 0 },
	};
}

/**
 * One dispatch pass.
 *
 * State is reconstructed from the nodes at the TOP of every pass rather than
 * carried between them. mgmt-api restarts ~5 times a day and the job that
 * restarts it runs on the pilot node, so anything remembered in this process
 * is wrong at exactly the moment it matters most (B9). The transient units ARE
 * the record.
 */

/** Lowest slot index not currently in use on this node, reserved as it goes. */
function takeFreeSlot(used: Map<string, Set<number>>, node: string): number {
	const slots = used.get(node) ?? new Set<number>();
	used.set(node, slots);
	let i = 0;
	while (slots.has(i)) i++;
	slots.add(i);
	return i;
}

export async function runDispatchPass(
	input: DispatchPassInput,
	token: string,
	gh: GhLike & { get: (path: string, token: string, repo?: string) => Promise<unknown> },
	sh: ShellLike
): Promise<DispatchPassResult> {
	if (!input.order.length) {
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	}

	// REAP BEFORE THE EARLY RETURN. A quiet fleet is exactly when orphans
	// accumulate unnoticed, and gating the sweep on there being work to dispatch
	// would mean the sweep never runs on the days it matters most.
	//
	// GATED ON ITS OWN CLOCK, not on the tick. The comment here used to say the
	// sweep was "cheap: one reachability probe and one runner listing per repo",
	// which was true against the ladder's 60s tick and false the moment the
	// dispatcher moved to its own 15s one — same sweep, four times an hour's
	// worth of calls, 6,480/hr against a 5,000/hr budget. See REAP_INTERVAL_MS
	// for the measurement. The dispatcher may look for work as fast as it likes;
	// the reap must not ride along.
	const nowMs = input.nowMs ?? Date.now();
	const fresh = input.pending.filter((p) => !p.held);
	// `null`, not 0. A pass that did not sweep has NOT observed zero orphans, and
	// collapsing the two would let a sweep that stopped running read for as long
	// as anyone cared to look like a fleet that never leaks.
	let reaped: number | null = null;
	if (nowMs - lastReapMs >= REAP_INTERVAL_MS) {
		// Stamped BEFORE the await, so a slow sweep cannot let the next pass in
		// behind it and double the cost it was gated to bound.
		lastReapMs = nowMs;
		const targets = reapTargets(input.repos ?? [], nowMs);
		// Nothing due is a sweep that LOOKED — every repo was read within
		// REAP_IDLE_INTERVAL_MS and held nothing — so it reports 0, not `null`.
		// Skipping the node probe too: it only ever qualifies a listing.
		if (targets.length) {
			const res = await withGhCaller('reap', () =>
				reapJitRunners(targets, input.order, token, gh, sh, {
					nowMs,
					// Only jobs READ as queued this tick: a held entry is the last
					// listing's word, and releasing a unit is not done on hearsay.
					queuedJobIds: new Set(fresh.map((p) => p.jobId)),
				})
			);
			reaped = res.reaped;
			for (const o of res.observed) reapBook.set(o.repo, { listedAtMs: nowMs, heldJit: o.heldJit });
		} else {
			reaped = 0;
		}
	}

	// Held entries only matter when something fresh could take their slot, so
	// a pass with nothing fresh has nothing to do.
	if (!fresh.length) {
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped };
	}

	// Reconstruct in-flight state from the nodes.
	const unitsByNode = new Map<string, string[]>();
	const unitRecordsByNode = new Map<string, LiveJitUnit[]>();
	const usedSlots = new Map<string, Set<number>>();
	await Promise.all(
		input.order.map(async (m) => {
			const [units, slots] = await Promise.all([liveJitUnitRecords(m, sh), liveJitSlots(m, sh)]);
			unitRecordsByNode.set(m, units);
			unitsByNode.set(
				m,
				units.map((u) => u.name)
			);
			usedSlots.set(m, slots);
		})
	);
	// Reconstructed from the UNIT NAMES, which is the only record that survives
	// an mgmt-api restart (B9). This was previously declared and never populated,
	// so `planTick`'s "a run already being served is never minted for again" was
	// vacuous here — the one caller it exists for. The run id is in the name for
	// exactly this.
	//
	// Slot indices come from the same place. They used to be the mint loop's
	// counter, which restarts at 0 every pass while provisioning runs RESET=1 —
	// so a pass overlapping a live mint would reset the slot underneath it and
	// clobber its config, reproducing §12.16 in the code written to prevent it.
	const inFlightJobIds = new Set<number>();
	const inFlightRunIds = new Set<number>();
	let inFlight = 0;
	// A RUNNER GITHUB GAVE TO A DIFFERENT JOB. Labels are generic, so a runner
	// minted for job X is assigned to whichever matching job GitHub picks; on
	// 2026-10-09 18:46Z three runners minted for three queued verify-run shards
	// all went to a push run's shards. The unit still carries X's id, so X read
	// "already has a runner in flight" for a whole shard while nothing was
	// serving it. A unit whose runner is BUSY (seen running a job in the listings
	// this pass read) while its own job is still QUEUED is serving someone else:
	// X is not in flight. The unit still counts toward its node's load.
	const busyRunners = new Set((input.runningJobs ?? []).map((j) => j.runner));
	const queuedJobs = new Map(fresh.map((p) => [p.jobId, p]));
	let reassigned = 0;
	// A RUNNER THAT CAN NEVER TAKE ITS OWN JOB. Its labels do not satisfy the
	// job's, so GitHub will never assign the two — and holding the job "in
	// flight" kept every other node from taking it for the unit's whole TTL
	// (2026-10-23: a hokon mint registered without `hadoku-builder` after a
	// backstop demote, 49 minutes of ci:queue-health red until a hand delete).
	// The labels are the mint's own stamp on the unit; an unstamped unit is
	// UNKNOWN and keeps the conservative answer. A busy one is serving some other
	// job its labels fit, which the branch above already handles.
	const stranded: { node: string; repo: string; name: string; has: string[]; wants: string[] }[] =
		[];
	for (const [node, units] of unitRecordsByNode) {
		inFlight += units.length;
		for (const { name: u, labels } of units) {
			const parsed = parseJitName(u);
			if (!parsed) continue;
			const job = parsed.jobId !== null ? queuedJobs.get(parsed.jobId) : undefined;
			if (job && busyRunners.has(u)) {
				reassigned++;
				continue;
			}
			const wants = job?.labels ?? [];
			if (job && labels && wants.length && !satisfiesLabels(labels, wants)) {
				stranded.push({ node, repo: job.repo, name: u, has: labels, wants });
				continue;
			}
			// A name from before the job-scoped format has no job id. Block its
			// whole RUN rather than guessing — the conservative direction, and it
			// clears as those units exit.
			if (parsed.jobId === null) inFlightRunIds.add(parsed.runId);
			else inFlightJobIds.add(parsed.jobId);
		}
	}

	if (reassigned) {
		logger.info(
			`[dispatch] ${reassigned} runner(s) minted for a still-queued job are serving another job — ` +
				`those jobs are placed again, not held as in flight`
		);
	}
	for (const s of stranded) {
		const retired = await withGhCaller('reap', () =>
			retireStrandedJit(s.node, s.repo, s.name, token, gh, sh)
		);
		logger.warn(
			`[dispatch] STRANDED ${s.name}: carries ${s.has.join(',')}, its job wants ${s.wants.join(',')} — ` +
				(retired ? 'retired; ' : 'could not be retired; ') +
				'the job is placed again, not held as in flight'
		);
	}

	// Feed live unit counts into admission, so a mint from a PREVIOUS pass — or
	// from before a restart — counts against the cap exactly like one from this
	// pass. Without this the first tick after a restart would mint a second
	// runner for work already being served.
	//
	// THE PROBE COUNTS A JIT JOB'S OWN WORKER, AND SO DID THIS. `standingBusy`
	// arrives as the probe's count of every Runner.Worker on the box (#102, so
	// three Forge shards read busy 3). A running JIT unit IS a Runner.Worker,
	// and its unit is in `liveUnits`; the held warm listener's worker is one
	// too, and its slot is already out of `maxConcurrent` (`mintBudget`). So
	// `liveUnits + standingBusy` charged every JIT job twice and a busy
	// listener three times: on 2026-10-21 claw-1 read `at capacity: 2/2` with
	// one JIT job and an idle listener, claw-3 `3/2` with one job and a busy
	// one, and the fleet served a 20-run fan-out on about half its slots while
	// `fleet traffic` showed every node admitted. The units are the only
	// record of which workers are JIT, and they are listed just above, so the
	// subtraction lives here. Clamped: a unit whose listener is still
	// registering has no worker yet, and a held slot whose listener is missing
	// has none either — neither may drive the count below zero.
	//
	// THE SIBLINGS (`runningJobs`) correct the probe in one direction only. A
	// node runs AT LEAST its visible standing siblings, so `standingBusy` takes
	// the larger of the two — never their sum, since the probe may already have
	// counted them. JIT siblings are skipped there: their units are in
	// `liveUnits` already. A WARM sibling is charged exactly once: through the
	// held slot when the node holds one for it (then it is `warmBusy`, which
	// only the busy RANK reads), and as a standing job when it does not — the
	// 2026-10-08 22:08:09Z replay and the dispatch-tick sibling test are both
	// that second shape, a listener's job the probe has not seen on a node
	// whose fixture holds nothing for it. `heavyJobs` counts every heavy
	// sibling, JIT, warm or standing, because nothing else counts them by name.
	const heavyModel = input.nodes.find((m) => m.heavyModel)?.heavyModel;
	const names = input.nodes.map((m) => m.name);
	const siblings = new Map<string, { standing: number; warm: number; heavy: number }>();
	for (const j of input.runningJobs ?? []) {
		const node = nodeOf(j.runner, names);
		const c = siblings.get(node) ?? { standing: 0, warm: 0, heavy: 0 };
		if (j.runner.startsWith(WARM_PREFIX)) c.warm++;
		else if (!j.runner.startsWith(JIT_PREFIX)) c.standing++;
		if (heavyModel?.isHeavy(j.repo, j.jobName)) c.heavy++;
		siblings.set(node, c);
	}
	const nodes = input.nodes.map((m) => {
		const sib = siblings.get(m.name);
		const units = unitsByNode.get(m.name)?.length ?? 0;
		const held = m.warmHeld ?? 0;
		const standingBusy = Math.max(0, m.standingBusy - units - held);
		return {
			...m,
			liveUnits: m.liveUnits + units,
			standingBusy,
			...(sib
				? {
						standingBusy: Math.max(standingBusy, sib.standing + Math.max(0, sib.warm - held)),
						warmBusy: (m.warmBusy ?? 0) + Math.min(sib.warm, held),
						heavyJobs: (m.heavyJobs ?? 0) + sib.heavy,
						runningHeavy: m.runningHeavy || sib.heavy > 0,
					}
				: {}),
		};
	});

	// THE LEDGER, before placement mutates `nodes`: what admission charged each
	// node at the start of this pass, beside what it could see, judged by one
	// invariant — `capacity-ledger.ts` says which and why. `observedRunning` is
	// the larger of the probe's Runner.Worker count and the standing + warm
	// siblings the job listings showed, because either one is an observation of
	// a running job and the probe is up to a fast-loop tick stale (the
	// 2026-10-08 22:08 shape: a listener took a shard eleven seconds after the
	// probe). A broken clause is said here every pass; runner-health pages when
	// it stays broken.
	const ledger = recordCapacityLedger(
		nodes.map((n, i) => {
			const sib = siblings.get(n.name);
			const observedRunning = Math.max(
				input.nodes[i].standingBusy,
				(sib?.standing ?? 0) + (sib?.warm ?? 0)
			);
			return {
				node: n.name,
				liveUnits: n.liveUnits,
				probeWorkers: observedRunning,
				standingBusy: n.standingBusy,
				warmHeld: n.warmHeld ?? 0,
				budget: n.maxConcurrent,
				inFlight: n.liveUnits + n.standingBusy,
			};
		}),
		nowMs
	);
	for (const e of ledger.nodes) {
		if (!e.ok) logger.warn(`[dispatch] CAPACITY INVARIANT broken on ${e.node}: ${e.why}`);
	}

	const plan = planTick(
		byPriority(input.pending),
		nodes,
		input.order,
		{ jobIds: inFlightJobIds, runIds: inFlightRunIds },
		// The SAME injected clock the reap gate reads (#92). A second
		// `Date.now()` here let a test on a fixed clock read every run as queued
		// for weeks, which clears the slow-tier spill threshold trivially.
		nowMs
	);
	let minted = 0;
	let failed = 0;
	// Counted on SUCCESS only, like `minted`: a mint that failed put no runner on
	// the warm node, so counting its placement would credit the term with a job
	// it did not place.
	let mintedViaAffinity = 0;
	let mintedAffinityMoved = 0;
	// #102.4's "say what the rule did" — same SUCCESS-only rule as the affinity
	// counters just above, and for the same reason.
	let mintedHeavy = 0;
	/** Heavy jobs that placed on a node already busy (`busyAtChoice > 0`) because
	 *  no empty node existed — the "a heavy job still places" half of §A.4,
	 *  made visible rather than only asserted in a test. */
	let mintedHeavyOnBusy = 0;
	/** `node@busy` for every SUCCESSFUL mint this pass, in placement order — the
	 *  per-mint busy report §A.4's live check asks for ("the dispatch log shows
	 *  the new busy numbers"), read straight off `MintAction.busyAtChoice`
	 *  rather than re-derived from a post-tick snapshot that would already
	 *  include each job's own increment. */
	const placedEntries: string[] = [];
	/** Nodes a heavy job was SUCCESSFULLY minted on this pass. */
	const mintedHeavyOn: string[] = [];

	// Serial, deliberately. Each mint consumes capacity that the next one's
	// admission check has to see, and the plan above already allocated against a
	// snapshot — running them concurrently would let two mints land in the same
	// slot index and clobber each other's config (§12.16).
	for (const action of plan.mint) {
		const slotIndex = takeFreeSlot(usedSlots, action.node);
		// BEFORE the call: a mint that fails after GitHub created the
		// registration has still put a `jit-*` name in this repo.
		mintedAtMs.set(action.repo, nowMs);
		const res = await withGhCaller('mint', () =>
			mintEphemeralRunner(
				{
					node: action.node,
					repo: action.repo,
					runnerName: action.runnerName,
					labels: input.labelsFor(action.node),
					slotIndex,
					homeDir: input.homeDirFor(action.node),
					tarballUrl: input.tarballUrl ?? null,
					memoryMaxMb: input.memoryMaxMbFor(action.repo, action.node),
					sliceName: input.sliceNameFor?.(action.node) ?? null,
					ttlSeconds: input.ttlSeconds,
				},
				token,
				gh,
				sh
			)
		);
		if (res.ok) {
			minted++;
			if (action.viaAffinity) mintedViaAffinity++;
			if (action.affinityMoved) mintedAffinityMoved++;
			if (action.heavy) {
				mintedHeavyOn.push(action.node);
				mintedHeavy++;
				if (action.busyAtChoice > 0) mintedHeavyOnBusy++;
			}
			placedEntries.push(`${action.node}@${action.busyAtChoice}`);
		} else {
			failed++;
			// The run stays queued and the next pass places it elsewhere. Logged
			// rather than thrown so one bad node cannot stop the pass for the rest.
			logger.warn(`[dispatch] mint failed for ${action.repo} on ${action.node}: ${res.reason}`);
		}
	}
	await closeWarmBesideHeavy(nodes, mintedHeavyOn, heavyModel, nowMs, token, gh, sh);
	// A held run's refusal was said when it was last probed and is said again
	// when it is next probed; repeating it every pass is what the backoff's own
	// log line exists to replace.
	for (const s of plan.skipped) {
		if (s.kind === 'held') continue;
		logger.info(`[dispatch] skipped run ${s.runId} (${s.repo}): ${s.reason}`);
	}
	if (plan.reserved.length) {
		logger.info(
			`[dispatch] held ${plan.reserved.length} slot(s) for older backed-off run(s) rather than ` +
				`give them to younger jobs; re-reading them next tick: ` +
				plan.reserved.map((r) => `${r.repo}#${r.runId}@${r.node}`).join(', ')
		);
	}
	if (minted) {
		const t = affinity.totals;
		affinity = {
			lastPass: {
				at: new Date(nowMs).toISOString(),
				minted,
				mintedViaAffinity,
				mintedAffinityMoved,
			},
			totals: {
				minted: t.minted + minted,
				mintedViaAffinity: t.mintedViaAffinity + mintedViaAffinity,
				mintedAffinityMoved: t.mintedAffinityMoved + mintedAffinityMoved,
			},
		};
	}
	recordDispatchDay(nowMs, { minted, failed, mintedViaAffinity });
	if (minted || failed) {
		// THE RECORD for W's after-arm (§5e): the re-cut greps these lines and sums
		// the PER-PASS fields, which survive a restart; the `total-` fields are
		// since process start and do not. Append new fields at the END — the
		// re-cut's parser keys on `name=value`, but a reader eyeballing a pm2 tail
		// should not have to relearn the order.
		logger.info(
			`[dispatch] minted=${minted} failed=${failed} in-flight=${inFlight} ` +
				`via-affinity=${mintedViaAffinity} affinity-moved=${mintedAffinityMoved} ` +
				`total-minted=${affinity.totals.minted} ` +
				`total-via-affinity=${affinity.totals.mintedViaAffinity} ` +
				`total-affinity-moved=${affinity.totals.mintedAffinityMoved} ` +
				// #102.4 — ADDITIVE, appended after every existing token so a reader
				// or a parser keyed on the fields above sees them byte-identical.
				`heavy=${mintedHeavy} heavy-on-busy=${mintedHeavyOnBusy} ` +
				`placed=${placedEntries.join(',')}`
		);
	}
	return {
		minted,
		failed,
		skipped: plan.skipped.filter((x) => x.kind !== 'held').length,
		inFlight,
		reaped,
		unplaceable: plan.skipped.filter((x) => x.kind === 'unplaceable'),
		reserved: [...new Set(plan.reserved.map((r) => `${r.repo}#${r.runId}`))],
	};
}

/**
 * THE WARM HALF OF THE HEAVY HOLD (#102). The hold refuses a JIT mint beside
 * a heavy job, but a warm listener is a standing registration GitHub hands
 * work to without asking: cardtable run 37857873226 (2026-10-08 23:10Z) had
 * forge-e2e (2) held off claw-8 and claw-9 by `heavy hold`, and claw-4's idle
 * warm listener took it 54 s after claw-4 started forge-e2e (1) — inside the
 * warm tick's 60 s, whose own heavy check reads the probe and had not seen it.
 *
 * So the moment a node is running a heavy job — placed this pass, or a heavy
 * sibling seen in a queued run's listing — its warm listener for a heavy-kind
 * repo goes, if idle. A BUSY one is left alone: stopping it would kill its job.
 * The node is marked so the warm tick does not refill it before the probe
 * catches up ({@link heavyMarkedRecently}). One runner listing per such node,
 * only on the pass that FIRST marks it, so a long shard costs one call, not
 * one every 15 s.
 */
async function closeWarmBesideHeavy(
	nodes: readonly NodeState[],
	mintedHeavyOn: readonly string[],
	heavyModel: NodeState['heavyModel'],
	nowMs: number,
	token: string,
	gh: GhLike & { get: (path: string, token: string, repo?: string) => Promise<unknown> },
	sh: ShellLike
): Promise<void> {
	if (!heavyModel) return;
	const heavyNow = new Set(mintedHeavyOn);
	for (const m of nodes) if ((m.heavyJobs ?? 0) > 0) heavyNow.add(m.name);
	for (const m of nodes) {
		if (!heavyNow.has(m.name)) continue;
		const fresh = !heavyMarkedRecently(m.name, nowMs);
		heavyMarkedAtMs.set(m.name, nowMs);
		if (!fresh || !m.warmRepo || !heavyModel.isHeavyRepo(m.warmRepo)) continue;
		const name = warmRunnerName(m.name, m.warmRepo);
		const reg = await warmRegistration(m.warmRepo, name, token, gh);
		if (!reg || reg.busy) {
			logger.info(
				`[dispatch] ${m.name} is running a heavy job; its warm listener for ${m.warmRepo} is ` +
					`${reg ? 'busy' : 'unreadable'} and stays — the warm tick evicts it once idle`
			);
			continue;
		}
		const evicted = await evictWarmListener(m.name, m.warmRepo, name, token, gh, sh);
		logger.info(
			`[dispatch] ${m.name} is running a heavy job: ${evicted ? 'evicted' : 'could not evict'} ` +
				`its idle warm listener for ${m.warmRepo} (#102)`
		);
	}
}

/**
 * How far ahead of the queue each event band starts, in milliseconds of age.
 *
 * A HEAD START, NOT A LANE. A push still goes first among jobs that arrived
 * within a few minutes of it — the 2026-10-09 case below — but a job that has
 * waited longer than its band's head start outranks every push that arrived
 * after that. Until 2026-10-25 the bands were strict, and a strict lane starves
 * the lower one for as long as the upper one keeps arriving: that morning a
 * package fan-out queued 57 `repository_dispatch` auto-update runs, every one
 * of which pushes a commit, so pushes never ran out. hadoku-study run
 * 40165607402 (queued 05:27:37Z) and hadoku-resume-bot 40165520825 (05:26:07Z)
 * waited 47 minutes; between 05:27:37 and their mints at 06:12–06:14 the
 * dispatcher minted 87 runners, 65 of them for push runs created AFTER them,
 * and not one for a younger auto-update run — age order held inside the band
 * and the band was the whole wait.
 *
 * 300 s per band is the fan-out's own p90 job wait that day (571 self-hosted
 * jobs, created_at -> started_at: p50 84 s, p90 311 s) and the line at which
 * ci:queue-health declares the fleet not serving work. It keeps the 2026-10-09
 * order exactly: a verify-branch dispatch (band 2, ten minutes) still yields
 * to a push that arrived up to ten minutes after it.
 */
export const BAND_HEAD_START_MS = 300_000;

/**
 * The order a pass places queued jobs in: oldest first, with a PUSH given a
 * head start over everything else and a manual dispatch starting furthest back
 * (see {@link BAND_HEAD_START_MS}).
 *
 * Capacity a job kind can use is sometimes three nodes deep (jdk21), and then
 * order is the whole policy. On 2026-10-09 20:27Z cardtable's push to main —
 * the run its deploy waits on — had three Forge shards queued since 20:05
 * behind eleven verify-branch dispatches that arrived after it, because the
 * pass placed jobs in the order repos and runs were listed. A dispatch is
 * somebody checking a branch; a push is the branch everyone else builds on.
 * Stable, and a job with no readable age sorts last.
 */
export function byPriority(pending: readonly PendingRun[]): PendingRun[] {
	const band = (r: PendingRun): number =>
		r.event === 'push' ? 0 : r.event === 'workflow_dispatch' ? 2 : 1;
	const rank = (r: PendingRun): number => {
		const t = Date.parse(r.jobCreatedAt ?? (r as { created_at?: string }).created_at ?? '');
		return Number.isFinite(t) ? t + band(r) * BAND_HEAD_START_MS : Number.POSITIVE_INFINITY;
	};
	return [...pending].sort((a, b) => rank(a) - rank(b) || band(a) - band(b));
}
