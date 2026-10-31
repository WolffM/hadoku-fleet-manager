/**
 * The join between the fast loop and the JIT dispatcher.
 *
 * This lived inside `fleet-loop.ts` because that is where the fleet probe
 * happened to be, and it took that file from 1,333 lines to 1,522 — a module
 * that owns tier decisions gaining a second, unrelated job. Moved here so JIT
 * code sits with JIT code.
 *
 * NOTHING IS IMPORTED FROM `fleet-loop`. Every input is passed in, which is
 * what keeps this from becoming an import cycle: the fast loop already holds the
 * probe, the manifest and the sick set, so handing them over costs one call and
 * leaves the dependency pointing one way.
 */

import { readDrain } from './drain.js';
import {
	effectiveHosting,
	heldBackMb,
	readHostingDoc,
	sliceUsageProbe,
	takeSliceUsage,
} from './hosting-record.js';
import { admitMint } from './ephemeral.js';
import { guestUnitMemoryMaxMb } from './ephemeral.js';
import { JIT_UNIT_MAX_SEC } from './ephemeral.js';
import { JOB_RESERVE_DEFAULT_MB } from './ephemeral.js';
import { mintBudget } from './ephemeral.js';
import { spaceRefusal } from './ephemeral.js';
import { TMP_FREE_FLOOR_MB } from './ephemeral.js';
import { unitMemoryMaxMb } from './ephemeral.js';
import { WORK_FREE_FLOOR_MB } from './ephemeral.js';
import { warmListenersHeld } from './ephemeral.js';
import { orderCandidates, type TrafficNode } from './traffic.js';
import { recordDiskReadings } from './disk-watch.js';
import { isSchedulable } from './schedulable.js';
import { nodeHome } from '../lib/node-users.js';
import { mintsOnDemand } from '../lib/node-role.js';
import { isBackstopHeld } from './backstop-hold.js';
import { idleSecondsByNode, jobRecords } from '../job-history.js';
import { logger } from '../host.js';
import { withGhCaller } from '../gh-budget.js';
import { runDispatchTick } from './dispatch-tick.js';
import { SATURATED_QUEUED_MS } from './queue-discovery.js';
import { type DispatchPassResult } from './dispatch-pass.js';
import { type NodeState } from './placement.js';
import { chargedLikeDispatch, getCapacityLedger } from './capacity-ledger.js';
import {
	withoutGuests,
	offerFor,
	loadWorkloadGateContext,
	jobReserve,
	loadRepoReserves,
	shellOnNode,
	SPACE_PROBE_DF_CMD,
	parseSpaceProbe,
	type EphemeralTickInput,
	type RepoReserve,
	type ReserveSource,
} from './ephemeral-shared.js';
import { dispatchWarmCache, warmRepoByNode } from './dispatch-warm-cache.js';
import { getSpeedModel, getHeavyModel } from './speed-heavy-cache.js';

// Bare re-export for runner-health.ts (lane A, untouched this wave).
export { loadWorkloadGateContext, __setWorkloadGateContextForTesting } from './ephemeral-shared.js';

/**
 * The guests the dispatcher mints for on demand (#120), in manifest order.
 *
 * Operator, 2026-10-19: "the runners get brought online the same way the JIT
 * process does. not having standing runners squatting on ram." Until then the
 * guest kept ~30 standing listeners alive around the clock (~2.8 GB RSS+swap on
 * the production host) and the backstop's promotion was a label flip on them.
 * Now promotion is a mint, and demotion leaves nothing listening.
 *
 * A DRAINED guest is still returned: the drain reaches placement as
 * `NodeState.drained` like every other node's, which is what keeps it from
 * taking anything — the drain is the guest's red light, and it has to read the
 * same way here as it does on a claw.
 */
export function onDemandGuests(input: EphemeralTickInput): string[] {
	return Object.keys(input.nodes).filter((n) => mintsOnDemand(input.nodes[n]));
}

/**
 * Which `admitMint` clause refused a node's GENERIC admission check this tick
 * — see {@link AdmissionVerdict}. `admitMint` has returned exactly three
 * refusal shapes since it was written (`ephemeral.ts`): drained, at-capacity,
 * and memory (the plain clause and the #76 lower-bound PLACEMENT clause,
 * folded together here as 'memory' — both are refused for want of room, and
 * the generic check below never sets `requiredIsLowerBound`, so the
 * placement wording can never actually reach this classifier; it is handled
 * anyway so a future caller that DOES set it is not silently misread).
 *
 * `'other'` is defensive. A reason this file does not recognise must not
 * silently satisfy `clause === 'memory'` and feed the starvation finding
 * (`runner-health.ts`) something `admitMint` was never asked to mean.
 *
 * `'space'` (#101): refused for want of `/tmp` or `~/.hadoku/jit` free space,
 * never folded into `'memory'` — a dataplatform pytest run plus a site build
 * can fill a tmpfs while plenty of RAM remains free, and the finding needs to
 * say which resource actually ran out.
 */
export type AdmissionClause = 'drained' | 'concurrency' | 'memory' | 'space' | 'other';

function classifyAdmissionClause(reason: string): AdmissionClause {
	if (reason.startsWith('drained:')) return 'drained';
	if (reason.startsWith('at capacity:')) return 'concurrency';
	if (reason.startsWith('memory:') || reason.startsWith('placement:')) return 'memory';
	if (reason.startsWith('space:')) return 'space';
	return 'other';
}

/**
 * The verdict `admitMint` reaches for one EPHEMERAL node's GENERIC admission
 * check this tick — DISPLAY, never a second decision (wave 4a §A.1, #100).
 *
 * `placement.ts`'s `refusalFor` calls `admitMint` again, per queued run, with
 * the run's own repo's reserve substituted in when #76's lower bound applies
 * — THAT call is the one which actually gates a mint. This verdict is
 * computed from the SAME `NodeState` `dispatchEphemeral` already builds for
 * placement, before any run is known, so it answers "could this node take A
 * job right now" rather than "could it take THIS one" — close enough to
 * drive a finding and a panel field, wrong to feed back into scheduling.
 * Nothing here changes what `admitMint` admits, the reserves, or the order.
 *
 * WHY THIS EXISTS: claw-6 and claw-2 were refused by the memory clause on
 * every tick for days (2026-09-30 / 2026-10-04) and nothing recorded it —
 * `admitMint`'s own refusal reached nowhere past a per-run log line, and
 * `admissionFree` (fleet-report-types.ts) counts SLOTS and never applies this
 * clause. This is that answer, held where a reader can reach it without
 * re-deriving `admitMint`'s own logic.
 */
export type AdmissionVerdict =
	| { ok: true }
	| {
			ok: false;
			clause: AdmissionClause;
			/** This node's free memory, measured this tick (`NodeState.freeMb`) —
			 *  or, when `clause === 'space'`, the free MB on the filesystem named
			 *  by {@link filesystem} instead. */
			availableMb: number;
			/** What this generic check reserved against it (`NodeState.requiredMb`)
			 *  — or, when `clause === 'space'`, the floor that filesystem failed to
			 *  clear ({@link TMP_FREE_FLOOR_MB} or {@link WORK_FREE_FLOOR_MB}). */
			needMb: number;
			/** Only set when `clause === 'space'`: which filesystem refused —
			 *  `'tmp'` for `/tmp`, `'work'` for the filesystem holding
			 *  `~/.hadoku/jit`. Absent for every other clause. */
			filesystem?: 'tmp' | 'work';
			/** Only set (`true`) when `clause === 'space'` AND the free space on
			 *  {@link filesystem} could not be read (`spaceRefusal`'s `freeMb:
			 *  null`) — `availableMb` is then `0` and is NOT a measurement, only a
			 *  placeholder so the field stays a `number`. A reader that prints
			 *  "…MB free" must check this first. Absent for every other case,
			 *  including a measured below-floor space refusal. */
			unreadable?: true;
			/** Which of `jobReserve`'s three answers produced `needMb`. Meaningless
			 *  for `clause === 'space'` (carried anyway — it is cheap and callers
			 *  already read it unconditionally). */
			reserveBasis: ReserveSource;
			/** `admitMint`'s own reason string, verbatim — the detail a clause alone
			 *  cannot carry (e.g. the exact capacity count, or the exact MB gap). */
			reason: string;
	  };

/**
 * THE VERDICT SNAPSHOT — same shape as `warmRepoByNode` above: module-level,
 * replaced WHOLESALE once per `dispatchEphemeral` pass, never mutated in
 * place, and only ever handed out as a copy (`admissionVerdictsForReport`).
 *
 * WHOLESALE for the same reason `setWarmRepos` is: a node that stops being
 * reachable, or drops out of `input.ephemeral`, must stop being reported on
 * the very next pass rather than carrying a frozen verdict forever.
 *
 * EMPTY AFTER A RESTART, and that is the honest answer, not a bug — mgmt-api
 * restarts ~5x/day and this is in-memory. An ABSENT entry must NEVER be read
 * as "admitted": it means "this pass could not look", and `runner-health.ts`'s
 * starvation check treats it that way — carrying its last known finding
 * forward rather than clearing an alert on a tick that learned nothing.
 */
let admissionVerdictByNode: ReadonlyMap<string, AdmissionVerdict> = new Map();

/** #101: which nodes have already had their `/tmp`/`_work` free space logged
 * once this process's lifetime — see the probe in `dispatchEphemeral`'s node
 * loop. Module-level so "once" means once per mgmt-api process, not once per
 * 15 s tick; reset is never needed because a restart clears it along with
 * everything else in-memory here. */
const loggedSpaceProbeOnce = new Set<string>();

/** Test seam. Not part of the supported API. */
export function __resetAdmissionVerdictsForTesting(): void {
	admissionVerdictByNode = new Map();
	loggedSpaceProbeOnce.clear();
}

/**
 * Test seam: inject the verdict snapshot directly, bypassing a real
 * `dispatchEphemeral` pass. Not part of the supported API.
 *
 * `runner-health.ts`'s starvation check is this file's READER, not its
 * producer — a test of the reader should not have to drive the dispatcher's
 * whole I/O-heavy pass (GitHub `gh`, `sh`, the warm cache, the speed model)
 * just to get one node refused on memory. `dispatchEphemeral` itself is
 * exercised end to end in `warm-cache.test.ts`.
 */
export function __setAdmissionVerdictsForTesting(
	verdicts: ReadonlyMap<string, AdmissionVerdict>
): void {
	admissionVerdictByNode = new Map(verdicts);
}

/**
 * What the last `dispatchEphemeral` pass's generic admission check found, for
 * `runner-health.ts`'s starvation finding and `routes/fleet.ts`'s panel field.
 *
 * Copied, same rule as `warmReposForPlacement` — a caller must not be able to
 * mutate the fleet's belief about its own admission state.
 */
export function admissionVerdictsForReport(): ReadonlyMap<string, AdmissionVerdict> {
	return new Map(admissionVerdictByNode);
}

/** `admitMint(ns)`, folded into the shape callers actually want to read. */
function admissionVerdictFor(ns: NodeState, reserveBasis: ReserveSource): AdmissionVerdict {
	const admit = admitMint(ns);
	if (admit.ok) return { ok: true };
	const reason = admit.reason ?? 'refused';
	const clause = classifyAdmissionClause(reason);
	if (clause === 'space') {
		// Single source of truth with `admitMint` itself — ask `spaceRefusal`
		// the SAME question rather than re-deriving `filesystem` from a string
		// match on `reason`.
		const space = spaceRefusal(ns);
		return {
			ok: false,
			clause,
			availableMb: space?.freeMb ?? 0,
			needMb: space?.floorMb ?? TMP_FREE_FLOOR_MB,
			filesystem: space?.filesystem ?? 'tmp',
			...(space?.freeMb === null ? { unreadable: true as const } : {}),
			reserveBasis,
			reason,
		};
	}
	return {
		ok: false,
		clause,
		availableMb: ns.freeMb,
		needMb: ns.requiredMb,
		reserveBasis,
		reason,
	};
}

/**
 * Jobs per day per repo, from the persisted history.
 *
 * Feeds the hot/cold poll split. This was a literal empty map for the pilot's
 * whole first day, which made EVERY repo cold: a 10-minute poll interval instead
 * of 60 s, so a starved job waited up to eleven minutes for a runner that could
 * have been minted in two. `deriveHotRepos` exists precisely to stop a
 * hand-maintained list going stale, and it was wired to nothing.
 */
export function recentJobsPerDay(): Map<string, number> {
	const out = new Map<string, number>();
	try {
		const records = jobRecords();
		if (!records.length) return out;
		let oldest = Infinity;
		for (const r of records) {
			const t = Date.parse(r.startedAt);
			if (Number.isFinite(t)) oldest = Math.min(oldest, t);
		}
		const days = Math.max(1, (Date.now() - oldest) / 86_400_000);
		const counts = new Map<string, number>();
		for (const r of records) counts.set(r.repo, (counts.get(r.repo) ?? 0) + 1);
		for (const [repo, n] of counts) out.set(repo, n / days);
	} catch {
		// A missing or unreadable history means every repo polls cold — slower,
		// never wrong. It must not take the dispatch pass down with it.
	}
	return out;
}

/**
 * Mint for the nodes the manifest marks `ephemeral: true`.
 *
 * RETURNS WHAT THE PASS OBSERVED, and the distinction between the two
 * non-result answers is the whole point:
 *
 *   - a zeroed result means "looked, nothing to do" — no node is declared
 *     ephemeral, so there is nothing this pass could have minted.
 *   - `null` means COULD NOT LOOK: nodes are declared but not one of them was
 *     reachable with a readable memory figure, so this pass has no idea whether
 *     work was waiting.
 *
 * This returned `void` until 2026-09-01, which collapsed all three answers into
 * one. `recordDispatch` reads a missing result as "attempted and all failed", so
 * the Fleet panel reported `failingSince` from the first tick after every
 * restart, with null counts and a zero mint total, on a dispatcher that was
 * minting ~55 jobs a day successfully. A healthy thing rendered as broken is the
 * same class of bug as "I could not look" rendering as "nothing is wrong".
 */
export async function dispatchEphemeral(
	tickInput: EphemeralTickInput,
	token: string,
	gh: Parameters<typeof runDispatchTick>[2],
	/**
	 * Injected for the reason this file just learned the hard way. The dispatch
	 * RESULT was dropped on the floor here for three days while unit tests on
	 * both sides of the call stayed green, because nothing exercised the seam
	 * between them. The `minQueuedMs` this function chooses is the same shape of
	 * fact — computed here, consumed there — so it gets a seam that can be
	 * asserted without shelling to the garage.
	 */
	sh: typeof shellOnNode = shellOnNode,
	run: typeof runDispatchTick = runDispatchTick,
	/**
	 * `fleet-runner-coverage.json`'s per-repo reserves — `jobReserve`'s `repo`
	 * answer, the most specific of the three, and `admitMint`'s placement clause
	 * depends on seeing an unclamped lower-bound figure where one exists (#76).
	 * Injected for the same seam reason `sh`/`run` are: a test pins the roster's
	 * content without writing a coverage file to disk for every case. Defaults
	 * to the real read, which is itself fail-open to an empty map (see
	 * {@link loadRepoReserves}) — an unreadable roster costs the per-repo
	 * answer, never the whole mint pass.
	 */
	repoReserves: ReadonlyMap<string, RepoReserve> = loadRepoReserves(),
	/** Injected for the same seam reason as `sh`/`run` above — the speed
	 *  model's rebuild cadence (#83) is computed here, consumed by every
	 *  `NodeState` this tick builds. Appended last so every existing positional
	 *  call keeps today's `Date.now()` behaviour unchanged. */
	nowMs: number = Date.now()
): Promise<DispatchPassResult | null> {
	// Before ANY I/O: the warm cache, the `free -m` probe and the mint all reach
	// the nodes this set names. See `withoutGuests`.
	const input = withoutGuests(tickInput);
	// THE ON-DEMAND GUESTS (#120), minted for beside the claws but never part of
	// `input.ephemeral`: that set is general CI capacity, and the warm cache just
	// below must not see a guest at all — on-demand means no listener parked on
	// the production host's memory. They are placed LAST and offered
	// `hadoku-builder` only while the backstop holds them; see `offerFor`.
	const guests = onDemandGuests(input);
	const minting = [...input.ephemeral, ...guests];
	if (!minting.length) return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	const isGuest = (name: string): boolean => guests.includes(name);
	// The backstop hold is read ONCE per tick. Placement's `NodeState.labels` and
	// the mint's `labelsFor` both ask this, seconds apart, with probes and GitHub
	// polls in between — and runner-health flips the hold on its own clock. On
	// 2026-10-23 it demoted hokon at 19:21:42, and at 19:21:48 the mint of a
	// `hadoku-builder` job hokon had been PLACED for registered without
	// `hadoku-builder`. The job could never land on it, and "already has a
	// runner in flight" kept every claw from taking it for the unit's full TTL.
	const heldThisTick = new Set(guests.filter(isBackstopHeld));
	const eligibleFor = (name: string): boolean => !isGuest(name) || heldThisTick.has(name);
	// ONE state-dir read for this whole tick — see `offerFor`'s own doc. A
	// second read from `dispatchWarmCache`'s OWN call below (it is also called
	// directly, with its own tick) is accepted: both are one read of a small
	// local file, and keeping each entry point self-contained is simpler than
	// threading a context through a call this function does not otherwise own.
	const workloadGate = loadWorkloadGateContext(Object.keys(input.nodes));

	// WARM CACHE OF ONE (P4.1). Runs on its own clock (WARM_CACHE_INTERVAL_MS)
	// and must neither block the JIT mint pass below nor be blocked by it — a
	// slow or failing warm-cache probe must still let this tick mint. Caught
	// here rather than let `dispatchWarmCache`'s own internal catch be the only
	// guard, because a bug in the orchestration around it (not just inside one
	// node's branch) must not read as a dispatch-pass failure on the Fleet
	// panel — `DispatchPassResult` says nothing about the warm cache at all.
	try {
		await withGhCaller('warm-cache', () => dispatchWarmCache(input, token, gh, sh));
	} catch (err) {
		logger.warn(`[warm-cache] tick failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	// REAL free memory, in MB, read from the nodes.
	//
	// The tier probe's `free` is FREE SLOTS (`cap - workers`), not megabytes, and
	// passing it as `freeMb` made admission compute `3 - 4096` and refuse every
	// mint forever — a units mismatch that reads as a correctly-wired dispatcher
	// declining work. One ssh per EPHEMERAL node per tick, so the cost is
	// bounded by the pilot's size, not the fleet's.
	//
	// INSTALLED capacity rides the same call, in the same `free -m` line. It is
	// what the per-unit cap is derived from (`MemTotal − minFreeMb`, the slice's
	// own ceiling — see `unitMemoryMaxMb`), and adding a second ssh for a number
	// already on this line would have doubled the tick's per-node cost for
	// nothing. `$7` is available, `$2` is total; the warm half reads the same two
	// columns the same way.
	const freeMbByNode = new Map<string, number>();
	const sliceCeilingMbByNode = new Map<string, number>();
	// #101: SPACE, read on the SAME ssh call as `free -m` rather than a second
	// round-trip — the fleet already blacked itself out once on an
	// unconditional per-node call run too often (REAP_INTERVAL_MS,
	// 2026-09-06), and this one piggybacks on a call this tick already makes.
	// `df -Pm` (POSIX, MB) on `/tmp`, and on whichever of `~/.hadoku/jit`,
	// `~/.hadoku`, or `$HOME` exists — a node that has never minted has no
	// `jit` directory yet, and that absence is not "unreadable". ALWAYS set,
	// never left unset: `undefined` on `AdmissionInput.tmpFreeMb`/`workFreeMb`
	// means "this caller never looked" (prove-job's literal only) and the
	// live tick must never silently become that caller — see `AdmissionInput`.
	const tmpFreeMbByNode = new Map<string, number | null>();
	const tmpSizeMbByNode = new Map<string, number | null>();
	const workFreeMbByNode = new Map<string, number | null>();
	// SHARED HOSTING (src/runners/hosting-record.ts): a hosting node's probe also
	// reads the tenant slice's usage, on the same ssh, so admission can hold back
	// exactly the part of the slice the tenant is not using yet.
	const sharedHosting = effectiveHosting(readHostingDoc());
	const heldBackMbByNode = new Map<string, number>();
	await Promise.all(
		minting.map(async (name) => {
			const hosted = sharedHosting[name];
			const raw = await sh(
				name,
				"free -m | awk '/^Mem:/{print $7, $2}'; " +
					SPACE_PROBE_DF_CMD +
					(hosted ? `; ${sliceUsageProbe(hosted.tenant)}` : '')
			);
			const { rest: out, sliceCurrentMb } = takeSliceUsage(raw);
			if (hosted) {
				heldBackMbByNode.set(
					name,
					heldBackMb({ declaredMb: hosted.memoryMb, sliceCurrentMb, since: hosted.since })
				);
			}
			const { first, tmpFreeMb, tmpSizeMb, workFreeMb } = parseSpaceProbe(out);
			const [free, total] = first.split(/\s+/).map(Number);
			if (Number.isFinite(free) && free > 0) freeMbByNode.set(name, free);
			// The FLOOR that keeps the claw alive, subtracted here rather than on
			// the node: `minFreeMb` is operator config and MemTotal is measured, so
			// this is the one place both are in hand. A node whose total is smaller
			// than its own floor is a manifest error — `runners-slice-install.sh`
			// answers SLICE-FAIL for it — and it must not become a cap of zero.
			//
			// A GUEST'S CEILING IS ITS ALLOWANCE. On the production host CI gets
			// `slice.maxMb`, deliberately far below MemTotal − minFreeMb, and
			// admission must measure a guest job against what the slice will
			// actually let it have, not against memory production is using.
			const floorCeiling = total - (input.nodes[name]?.minFreeMb ?? 1536);
			const allowance = isGuest(name) ? input.nodes[name]?.slice?.maxMb : undefined;
			const ceiling =
				typeof allowance === 'number' && allowance > 0
					? Math.min(floorCeiling, allowance)
					: floorCeiling;
			if (Number.isFinite(total) && total > 0 && ceiling > 0)
				sliceCeilingMbByNode.set(name, ceiling);
			tmpFreeMbByNode.set(name, tmpFreeMb);
			tmpSizeMbByNode.set(name, tmpSizeMb);
			workFreeMbByNode.set(name, workFreeMb);
			// LOGGED ONCE PER PROCESS LIFETIME PER NODE, not every 15 s tick —
			// `runner-health.ts`'s own tick, and any verdict CHANGE below, are the
			// other two places this is visible. grep: "space probe".
			if (!loggedSpaceProbeOnce.has(name)) {
				loggedSpaceProbeOnce.add(name);
				logger.info(
					`[ephemeral-tick] space probe ${name}: /tmp free=${tmpFreeMb ?? 'unreadable'}MB ` +
						`of ${tmpSizeMb ?? 'unknown'}MB, ` +
						`_work free=${workFreeMb ?? 'unreadable'}MB`
				);
			}
		})
	);
	// Wave 4c §F: hand the SAME per-node space-probe maps this tick already
	// built for admission's own space clause to the early-warning registry in
	// disk-watch.ts/runner-health.ts. No second probe, no second ssh — see
	// disk-watch.ts's own header for why this registry lives there instead of
	// beside admissionVerdictByNode here, and why WHOLESALE replace is the rule.
	recordDiskReadings(tmpFreeMbByNode, workFreeMbByNode, tmpSizeMbByNode);

	const nodes: NodeState[] = [];
	// Once per tick. A drain is operator state on disk; re-reading it per node
	// would let a node change status halfway through one placement decision.
	const drainRecords = readDrain();
	const drainedNodes = new Set(Object.keys(drainRecords));
	// ONCE PER TICK, not per node (#83): the model is the same fleet-wide
	// answer for every node this tick builds, rebuilt on its own cadence
	// rather than this one's. EVERY DECLARED MACHINE, not only `input.ephemeral`
	// — `buildSpeedModel` needs the fleet's own node roster to attribute a
	// runner name to a node (rather than guessing from a naming convention),
	// and a non-ephemeral node (claw-4, claw-6, hokon) still needs to be
	// attributable even though it is never a mint TARGET, or every job that
	// actually ran there would misattribute into "the other claws" baseline
	// for nothing, or vanish from it entirely.
	const speedModel = getSpeedModel(nowMs, Object.keys(input.nodes));
	// THE SAME CACHED HEAVY MODEL `dispatchWarmCache` uses (#102) — see
	// `getHeavyModel`'s own cadence note.
	const heavyModel = getHeavyModel(nowMs);
	const candidates: string[] = [];
	// THE GENERIC ADMISSION VERDICT (wave 4a §A.1, #100), built fresh this pass
	// and published wholesale after the loop — see `admissionVerdictByNode`'s
	// own note on why wholesale, not merged.
	const nextVerdicts = new Map<string, AdmissionVerdict>();
	for (const name of minting) {
		const p = input.fleetProbe.get(name);
		const m = input.nodes[name];
		if (!p?.reachable || !m) continue;
		// An unreadable memory figure must not silently become 0 and refuse every
		// mint. Declining is right — admission needs a real number — but it has to
		// be VISIBLE, because the previous failure of this exact shape produced a
		// dispatcher that looked healthy and minted nothing.
		if (!freeMbByNode.has(name)) {
			logger.warn(
				`[ephemeral-tick] ${name} mints but its free memory could not be read — not minting there this tick`
			);
			continue;
		}
		// The SAME refusal for the total, and for the same reason. The per-unit cap
		// is now derived from it, so a node here without a measured ceiling would
		// mint at the fallback — a tighter cap than the operator asked for, applied
		// silently, which is #26 coming back through the "I could not look" door.
		// Both numbers come off one `free -m` line, so this fires only when that
		// line was malformed rather than absent.
		if (!sliceCeilingMbByNode.has(name)) {
			logger.warn(
				`[ephemeral-tick] ${name} mints but its installed memory could not be read ` +
					`(or is not above minFreeMb=${m.minFreeMb ?? 1536}) — not minting there this tick`
			);
			continue;
		}
		candidates.push(name);
		const sliceCeilingMb = sliceCeilingMbByNode.get(name);
		const capMb = isGuest(name)
			? guestUnitMemoryMaxMb({ requestedMb: m.slice?.unitMaxMb, sliceMaxMb: m.slice?.maxMb })
			: unitMemoryMaxMb({ requestedMb: m.slice?.unitMaxMb, sliceCeilingMb });
		// PER NODE HERE, per repo once the run is known — hoisted out of the literal
		// below because the warm reservation is measured in the same unit and must
		// be the same number, not a second estimate of it. `.from` rides along for
		// the generic admission verdict below — it is the same `reserveBasis` a
		// per-run `admitMint` call would have reserved against, absent a repo.
		const genericReserve = jobReserve({ nodeJobP95Mb: m.jobP95Mb, capMb });
		const requiredMb = genericReserve.mb;
		// THE REPO'S OWN ANSWER, BUT ONLY WHEN IT IS A PROVEN FLOOR (#76, scoped
		// 2026-10-02). `requiredMb` above is the node-level fallback every repo
		// has always reserved. Activating a repo's own `jobP95Mb` for EVERY
		// covered repo — not only the capped ones — would be a second, unasked
		// admission change: a repo measured ABOVE the node figure would newly
		// refuse a node it fits on today, and one measured BELOW it would newly
		// pack tighter than today. Neither is what #76 asked for — "Only a
		// reservation PROVEN to be a lower bound is raised" — so an ORDINARY
		// repo (measured or fleet-p95, `lowerBound` false) gets NO entry here at
		// all and `refusalFor` falls straight through to `requiredMb`, bit for
		// bit today's behaviour. Only a repo whose own capped runs proved a
		// floor is in this map, and even then the stored figure is the RAW
		// floor — `refusalFor` takes `max(requiredMb, floor)` at the point of
		// use, so the override can only RAISE the reservation, never lower it.
		const requiredMbByRepo = new Map<string, { mb: number; lowerBound: boolean }>();
		for (const repo of input.repos) {
			const r = jobReserve({
				repoReserve: repoReserves.get(repo),
				nodeJobP95Mb: m.jobP95Mb,
				capMb,
			});
			if (!r.lowerBound) continue;
			requiredMbByRepo.set(repo, { mb: r.mb, lowerBound: true });
		}
		// THE WARM RESERVATION — the other half of the warm placement decision
		// `dispatchWarmCache` made a few lines above, in the unit THIS pass spends.
		// A node the warm cache may place a listener on holds one slot of its
		// `maxConcurrent` back for it, because a listener is handed work by GitHub
		// without passing `admitMint` at all: the cap bound mints exactly (max 3
		// concurrent JIT units on claw-3 against `maxConcurrent: 3`) and was
		// exceeded only by the path it does not sit on (max 4 including the warm
		// listener, at 48 job starts in the 14 days to 2026-09-22).
		//
		// DERIVED FROM ELIGIBILITY, NOT FROM AN OBSERVATION OF THE SLOT, and that
		// is deliberate. `warmRepoByNode` — the affinity map read below — is empty
		// for the first 60 s after each of mgmt-api's ~5 daily restarts and drops
		// any node whose listing call failed; its own note says staleness there is
		// safe in ONE direction, because affinity only ever PREFERS a node. A
		// reservation read from it would be unsafe in precisely the other one: a
		// live listener with no slot held for it, after every restart. Eligibility
		// is measured fresh on this tick from the same `free -m` line, so it can
		// neither go stale nor read empty after a restart. What it costs is a slot
		// held on an eligible node whose listener is MISSING — and a cache that is
		// not filling is a fault `fleet check-warm-canary` already fails on, not a
		// state to size the thermal cap around.
		const warmListeners = warmListenersHeld({
			usableMb: sliceCeilingMb!,
			jobMb: requiredMb,
			role: m.role,
			maxConcurrent: m.maxConcurrent,
		});
		const ns: NodeState = {
			name,
			healthy: !input.isSick(name),
			// An operator holding this box out of service. Read HERE and passed
			// down, because placement.ts is pure on purpose — decisions there
			// must be assertable without a filesystem.
			drained: drainedNodes.has(name),
			drainedAs: drainRecords[name],
			// NODE-WIDE `placement: "excluded"` (reconcile-fleet-runners.mjs's own
			// `placementFor`/`mayRunRepo`: "the reconciler must not register here
			// at all"). Found while writing the placement-keys guard (#82's shape,
			// for a different key): nothing on the JIT path read this before —
			// `eligible` was hardcoded `true` for every node, so a node an operator
			// marked `excluded` from STANDING registration would still mint
			// EPHEMERAL ones, which is exactly the "two assignment paths disagree"
			// bug this wave's guard exists to catch. No manifest machine sets this
			// today (verified: neither `manifests/fleet-runner-manifest.json` nor
			// the production copy declares it), so this changes nothing live; it
			// closes the gap for the day one does.
			eligible: m.placement !== 'excluded',
			// THE MANIFEST'S PER-REPO REFUSALS, carried through verbatim (#82).
			// Read HERE, beside `drained` above, for the same reason: a `Map`
			// rather than the raw `Record` so `placement.ts` gets O(1) lookup, and
			// built fresh every tick rather than cached, so an operator editing
			// the manifest takes effect on the next tick like every other
			// manifest-sourced field here.
			excludedRepos: m.excludeRepos ? new Map(Object.entries(m.excludeRepos)) : undefined,
			// THE SPEED MODEL (#83), the SAME object for every node this tick —
			// see `getSpeedModel`'s own cadence note just above the loop.
			speedModel,
			// WHAT THIS NODE OFFERS, derived — not the manifest's declared array.
			// `placement.ts:287` refuses a node whose labels do not satisfy the
			// job, so the fleet breaks HERE, one step before the mint, if this
			// reads a stripped declaration. Substituted at this line rather than
			// inside `choosePlacement`: placement.ts is pure on purpose and is
			// handed a label list, exactly like `drained` above.
			labels: offerFor(input.nodes, name, workloadGate, eligibleFor(name)),
			// #15: placement keeps part of a guest back from overflow work.
			onDemandGuest: isGuest(name),
			// P5.1 (`warm-listener-cache-2026-09-05.md`): "placement must gain
			// warm-affinity as a first-order term ahead of least-loaded". The term
			// shipped in `a6a19a4` and was INERT for five days and ~2,000 jobs
			// because this line did not exist and nothing anywhere ever assigned
			// `NodeState.warmRepo` — `warm-affinity-measured-2026-09-14.md` §3
			// proved it in source and in the deployed package. This is the FLEET
			// half of that wiring; the queued job's own repo is the other half,
			// supplied by `dispatcher.ts`'s `choosePlacement` call. Either one
			// missing makes both inert, which is why they were wired together.
			//
			// Read from the warm tick's last observation, which is GitHub's runner
			// listing rather than this process's fill/rotate bookkeeping — see
			// `warmRepoByNode` and `warmRegistration`. `undefined` for a node the
			// warm cache is not eligible for, has not reached yet, or could not
			// confirm; placement documents that as "falls through to plain
			// ordering", never as a reason to refuse the node.
			warmRepo: warmRepoByNode.get(name),
			liveUnits: 0,
			// Standing registrations GitHub can assign WITHOUT asking us. On a
			// node mid-migration this is non-zero and must count against the cap,
			// or the mint budget is computed against a fiction.
			//
			// JOBS, NOT DISTINCT REPOS (#102.1). This was
			// `[...p.busyRepos.values()].filter((n) => n > 0).length` — the COUNT
			// OF REPOS with at least one running worker, not the count of workers —
			// so three simultaneous cardtable Forge jobs on one claw read as
			// `standingBusy: 1`, and `TrafficNode.busy` (built from this same
			// field below) looked perfectly idle for the second and third job. The
			// tick already has the real count on the SAME probe line
			// (`ProbeResult.workers`, `fleet-loop.ts`) — no second probe.
			// `p.workers` absent (a caller that predates #102) falls back to the
			// old distinct-repo approximation rather than 0.
			standingBusy:
				p.workers ?? (p.busyRepos ? [...p.busyRepos.values()].filter((n) => n > 0).length : 0),
			// `p.workers` is EVERY Runner.Worker on the box — a JIT unit's and the
			// held warm listener's included. `dispatch-pass.ts` takes those back
			// out once it has listed the units; it needs the held count to do so.
			warmHeld: warmListeners,
			// GitHub cannot currently place a job here — see `NodeState.schedulable`'s
			// own doc for why `choosePlacement` needs this now that it re-ranks by
			// busy itself, rather than only trusting the order an already-schedulability-
			// aware `orderCandidates` produced upstream.
			schedulable: isSchedulable(name),
			// THE HEAVY MODEL (#102), the SAME object for every node this tick —
			// see `getHeavyModel`'s own cadence note, mirroring `speedModel` just
			// below.
			heavyModel,
			// THE OBSERVED INITIAL VALUE (#102.4): is this node CURRENTLY running a
			// job from a repo that runs heavy kinds? REPO-LEVEL ONLY — see
			// `HeavyModel.isHeavyRepo`'s own doc for why a running worker's exact
			// job name is not observable here without a new per-job read, and the
			// conservative direction that approximation takes. `planTick` RAISES
			// this to `true` on the SAME object as it places heavy jobs within the
			// tick; this is only the floor it starts from.
			runningHeavy:
				heavyModel !== undefined && p.busyRepos
					? [...p.busyRepos.entries()].some(([repo, n]) => n > 0 && heavyModel.isHeavyRepo(repo))
					: false,
			// ONE expression of the budget, shared with the fleet panel. See
			// `mintBudget`: this used to be the only copy, and the route's copy
			// disagreed with it.
			//
			// WHAT THE PANEL REPORTS IS STILL THE CEILING, and it is still true:
			// `routes/fleet` calls this with the manifest entry alone, so it prints
			// `maxConcurrent` — the bound on CONCURRENT WORK here, which the listener
			// is part of. What the dispatcher may MINT is that ceiling less the slots
			// held for listeners. The two numbers answer different questions; they do
			// not disagree.
			maxConcurrent: mintBudget({ maxConcurrent: m.maxConcurrent, warmListeners }).slots,
			freeMb: freeMbByNode.get(name) ?? 0,
			// The ESTIMATE, not the cap. Reserving unitMaxMb per job made claw-1
			// admit ONE concurrent mint at 10GB free, which is how 13 jobs sat
			// queued on 2026-09-01 while dispatch logged 'no node can take this
			// job right now'. MemoryMax still caps the unit at unitMaxMb.
			//
			// CLAMPED to the cap. The estimate is operator-edited; the cap is what
			// the kernel enforces. A jobP95Mb above the cap would admit work the
			// unit is then OOM-killed for - a reservation promising room the job is
			// not permitted to use. Min() lets the two disagree only safely.
			//
			// THE FALLBACK IS NO LONGER THE CAP (2026-09-14). It was
			// `jobP95Mb ?? unitMaxMb`, which read as one number because the two
			// happened to be the same 4096. The cap is now this node's slice
			// ceiling, and reserving ~13.8 GB for an unmeasured job would admit ONE
			// mint and queue the rest — the 2026-09-01 shape this very comment was
			// written about. An unmeasured job reserves JOB_RESERVE_DEFAULT_MB; the
			// clamp still holds, it is simply no longer doing the work.
			//
			// PER NODE HERE, per repo once the run is known: this is the answer for
			// a job whose repo has no figure (`jobReserve`'s `node`/`default`). The
			// queued run's own figure is `jobReserve` with its `repoReserve`, read
			// via `requiredMbByRepo` below.
			requiredMb,
			// A shared hosting slice's unused share is held back on top of the floor,
			// so no job is admitted into memory the tenant was promised.
			minFreeMb: (m.minFreeMb ?? 1536) + (heldBackMbByNode.get(name) ?? 0),
			// #76: `refusalFor` (placement.ts) looks this up by the queued job's
			// repo and overrides `requiredMb`/`requiredIsLowerBound` with it when
			// present. A repo not in the map (never measured) leaves `requiredMb`
			// above untouched.
			requiredMbByRepo,
			// #76: what `admitMint`'s placement clause compares a lower-bound
			// `requiredMb` against — this node's own ceiling, the same number
			// `capMb` above was derived from.
			sliceCeilingMb,
			// #101: ALWAYS a number or `null` here, never left `undefined` — the
			// probe above sets both maps for every node in `input.ephemeral`
			// unconditionally, so `.get(name)` is never missing for a node that
			// reaches this point. `undefined` is reserved for callers with no
			// node to probe at all (`prove-job.ts`).
			tmpFreeMb: tmpFreeMbByNode.get(name) ?? null,
			workFreeMb: workFreeMbByNode.get(name) ?? null,
		};
		nodes.push(ns);
		// THE GENERIC VERDICT (wave 4a §A.1, #100) — `admitMint` run on the SAME
		// `ns` placement just built, before any queued run is known. See
		// `admissionVerdictFor`'s own docblock for why this is display and not a
		// second gate.
		// Charged as the dispatcher charged it, when its ledger is fresh — see
		// `chargedLikeDispatch`. Display only: `ns` itself goes to placement as is.
		const verdict = admissionVerdictFor(
			chargedLikeDispatch(name, ns, getCapacityLedger()),
			genericReserve.from
		);
		nextVerdicts.set(name, verdict);
		// #101: LOGGED ON CHANGE, not every 15 s tick — the probe above already
		// logs once per process lifetime; this catches a node crossing the
		// floor in either direction afterwards. grep: "space verdict".
		{
			const wasSpace = (() => {
				const prev = admissionVerdictByNode.get(name);
				return !!prev && !prev.ok && prev.clause === 'space';
			})();
			const isSpace = !verdict.ok && verdict.clause === 'space';
			if (wasSpace !== isSpace) {
				logger.info(
					`[ephemeral-tick] space verdict change ${name}: tmpFree=${ns.tmpFreeMb ?? 'unreadable'}MB ` +
						`(floor ${TMP_FREE_FLOOR_MB}MB), _workFree=${ns.workFreeMb ?? 'unreadable'}MB ` +
						`(floor ${WORK_FREE_FLOOR_MB}MB) -> ${isSpace ? 'REFUSED' : 'admitted'}`
				);
			}
		}
	}
	// PUBLISHED EVEN WHEN EMPTY — see `admissionVerdictByNode`'s own note. Every
	// node this pass could not reach, or could not read memory for, is simply
	// absent from `nextVerdicts`, which is exactly "could not look" for THAT
	// node and must be published as such rather than left stale.
	admissionVerdictByNode = nextVerdicts;
	// COULD NOT LOOK, not "nothing to do". Every declared node was unreachable
	// or refused to report its free memory (both logged above), so this pass
	// cannot vouch for anything — including that no work was waiting.
	if (!nodes.length) return null;

	// Who the dispatcher tries first. `busy` is the OBSERVED count of runners
	// already working, so a node that quietly took jobs straight from GitHub
	// sinks in the order without anything having to notice. idleSeconds comes
	// from job history — the end of the last job each node served — so equals
	// rotate. A node with no history stays null and sorts LAST among equals.
	const idleByNode = idleSecondsByNode(nodes.map((m2) => m2.name));
	const trafficNodes: TrafficNode[] = nodes.map((m2) => ({
		name: m2.name,
		busy: m2.standingBusy + m2.liveUnits,
		idleSeconds: idleByNode.get(m2.name) ?? null,
		// From runner-health's last pass. A node whose registrations are all
		// offline looks IDLE to a load-based ordering and would otherwise win
		// every placement — see runners/schedulable.ts for the 2026-09-02 case.
		schedulable: isSchedulable(m2.name),
		// THE SAME speed model this tick already built above (#83's continuous
		// sibling, wave 3z) — no second reader of job history. `null` (thin
		// history) reaches `orderCandidates` as-is; it is the ORDERING's job to
		// treat that as neutral, not this call site's.
		speedFactor: speedModel.factorOf?.(m2.name) ?? null,
	}));
	// GUESTS LAST, whatever the ordering thinks of them. A guest is idle on most
	// ticks and fast, so a load- or speed-ranked order would put the production
	// host FIRST — the inverse of a backstop. It takes what no claw can: a job
	// only its labels fit, or one every claw refused this pass.
	const placementOrder = [
		...orderCandidates(
			candidates.filter((n) => !isGuest(n)),
			trafficNodes
		),
		...orderCandidates(candidates.filter(isGuest), trafficNodes),
	];

	// THE AGE GATE. `MIN_QUEUED_MS` is a proxy for "a standing runner would have
	// taken this by now". With a standing runner eligible (a promoted reserve),
	// the gate is SATURATED_QUEUED_MS: every claw is ephemeral, so every standing
	// slot is below them and "the standing fleet above is full" held on every
	// tick the tier ladder ever computed it — the 90 s default was never the
	// live value. With NOTHING standing there is no runner to wait for and no
	// slot that can free, so the proxy waits for an event that cannot occur and
	// the gate is removed.
	//
	// It costs more than the gate: `mintableRuns` SKIPS a run younger than the
	// gate rather than deferring it, so a job discovered at age 20 s waits for
	// the next poll entirely (measured 2026-09-02: 85-95 s of queue where
	// discovery alone accounts for ~30 s).
	//
	// Undefined (not passed) keeps the gate. Only an explicit empty set removes it.
	const nothingStanding = input.standingEligible !== undefined && input.standingEligible.size === 0;

	return await run(
		{
			order: placementOrder,
			nodes,
			repos: input.repos,
			recentJobCounts: recentJobsPerDay(),
			labelsFor: (node) => offerFor(input.nodes, node, workloadGate, eligibleFor(node)),
			// The HARD CAP, from the manifest — the counterpart to requiredMb's
			// estimate above. Hardcoded 4096 until 2026-09-01, which happened to
			// match every node's declared unitMaxMb and so hid the fact that the
			// declaration was read by nothing.
			memoryMaxMbFor: (repo, node) => {
				void repo;
				// A GUEST'S CAP IS ITS OWN, not a share of the claws' — see
				// `guestUnitMemoryMaxMb` for why the claw rule below would hand one
				// job the whole guest allowance.
				if (isGuest(node)) {
					const g = input.nodes[node]?.slice;
					return guestUnitMemoryMaxMb({ requestedMb: g?.unitMaxMb, sliceMaxMb: g?.maxMb });
				}
				// THE SLICE CEILING, not a flat number (issue #26). See
				// `unitMemoryMaxMb`: a cap below the slice's own ceiling is a second,
				// tighter bound that fires first and attributes the death to whatever
				// was allocating — brave-quartet's `wasm-size` died that way on claw-2
				// against 4 GiB while the node had 13.8 GiB of CI budget unspent.
				//
				// STILL THE FLEET MIN FOR A CLAW, though the node is now known (#120
				// passes it, for the guest above). This used to be forced — the node
				// was chosen after this was asked — and is now only unchanged: a claw
				// cap read off its own ceiling is a separate decision from #120, and
				// it would widen the cap on every larger claw at once. Claws only: a
				// guest's allowance is not a claw's ceiling and must not lower it.
				// Every claw in `nodes` has a MEASURED ceiling, because the loop above
				// refuses to admit a node without one, so this cannot silently fall
				// back while any claw was admitted.
				const ceilings = nodes
					.filter((n) => !isGuest(n.name))
					.map((n) =>
						unitMemoryMaxMb({
							requestedMb: input.nodes[n.name]?.slice?.unitMaxMb,
							sliceCeilingMb: sliceCeilingMbByNode.get(n.name),
						})
					)
					.filter((v) => v > 0);
				return ceilings.length ? Math.min(...ceilings) : JOB_RESERVE_DEFAULT_MB;
			},
			// The node's own slice, now that the mint path carries it (#120). Only
			// the guest declares one today; every claw resolves to the default.
			sliceNameFor: (node) => input.nodes[node]?.slice?.name,
			homeDirFor: (node) => nodeHome(input.nodes[node], 'ci'),
			// NOT an orphan timeout. It was 3600 until 2026-09-14 and read as one,
			// and systemd stopped the unit at the hour whether it held an idle
			// listener or a build at minute 59 — issue #22. Orphans are bounded by
			// the reap sweep, which deletes the REGISTRATION (the thing that does
			// harm); a running job is bounded by GitHub's own `timeout-minutes`.
			// This is only the backstop above that ceiling.
			ttlSeconds: JIT_UNIT_MAX_SEC,
			minQueuedMs: nothingStanding ? 0 : SATURATED_QUEUED_MS,
		},
		token,
		gh,
		sh
	);
}
