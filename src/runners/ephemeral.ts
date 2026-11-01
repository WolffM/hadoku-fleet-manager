/**
 * Ephemeral (JIT) runner minting — the decision half of workstream B.
 *
 * Everything here is PURE. Minting talks to GitHub and spawning talks to
 * systemd, but the rules that decide *whether* and *how* are functions over
 * plain data, because the interesting failures are all decisions:
 *
 *   - minting past a node's concurrency cap is the OOM mechanism (B2)
 *   - a name without a mint timestamp cannot be aged, so the sweep must treat it
 *     as immediately reapable (§12.8)
 *   - a jitconfig without DisableUpdate would let a runner rewrite a payload
 *     that is HARDLINKED into every other slot on the box (§12.16)
 *
 * A test can assert all of that without registering a runner. That matters:
 * every probe in this workstream that touched real infrastructure to learn
 * something cost an outage or a leak.
 *
 * NOTHING here is wired into the fast loop. It activates only for a node
 * carrying `ephemeral: true` in fleet-runner-manifest.json, and no node does.
 */

import { isBackstopNode } from '../lib/node-role.js';
export {
	type AdmissionInput,
	type AdmissionResult,
	LOWER_BOUND_HEADROOM,
	TMP_FREE_FLOOR_MB,
	WORK_FREE_FLOOR_MB,
	admitMint,
	spaceRefusal,
	assertSafeJitConfig,
} from './ephemeral-admission.js';
export {
	GITHUB_JOB_CEILING_SEC,
	JIT_UNIT_MAX_SEC,
	DEFAULT_RUNNER_SLICE,
	resolveSliceName,
	JOB_RESERVE_DEFAULT_MB,
	unitMemoryMaxMb,
	ciUnitProperties,
	backstopUnitMemoryMaxMb,
} from './ephemeral-slice.js';

/** Every JIT runner name starts with this. The sweep keys its reaping on it. */
export const JIT_PREFIX = 'jit-';

/**
 * GitHub's hard ceiling on a runner name. `generate-jitconfig` answers 422 —
 * not a validation warning — for anything longer, so this is a correctness
 * bound on {@link jitRunnerName}, not a style preference.
 */
export const MAX_RUNNER_NAME = 64;

/**
 * `jit-<node>-<repo-slug>-r<runId>-<epochSeconds>`.
 *
 * The trailing epoch is LOAD-BEARING, not decoration. The runners API returns no
 * creation timestamp, so the name is the only mint-time fact that survives into
 * the reaping sweep — and a grace held in mgmt-api's memory would reset on each
 * of its ~5 daily restarts and reap a fleet's worth of healthy mints (§12.8).
 *
 * THE RUN ID IS LOAD-BEARING FOR THE SAME REASON. `planTick` documents that a
 * run already being served is never minted for again, and `dispatch-pass`
 * reconstructs that set from live units rather than memory because the window
 * spans an mgmt-api restart. But the name carried no run id, so the set could
 * not be reconstructed at all — `inFlightRunIds` was built empty on every pass
 * and the guarantee was vacuous in its only caller. A second mint for a run
 * already being served is a wasted registration and a doubled job.
 *
 * systemd unit names admit only [A-Za-z0-9:_.\-], so the slug is narrowed to
 * that. Repo owners are dropped: names are per-repo already and the owner is
 * constant across this fleet.
 */
export function jitRunnerName(
	node: string,
	repo: string,
	nowMs: number,
	runId: number,
	jobId: number
): string {
	const slug = repo
		.split('/')
		.pop()!
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, '-');
	// `j<jobId>` goes BEFORE `-r<runId>-<epoch>`, not after, so the trailing
	// `-r…-<epoch>` shape `parseJitName` and the reaper key on is unchanged and
	// names minted by the previous version still parse. Appending it instead
	// would make every live unit unparseable at rollover, and §12.8 treats an
	// unaged name as IMMEDIATELY reapable — the sweep would kill running jobs.
	//
	// THE NAME MUST FIT IN 64 CHARACTERS. GitHub rejects a longer one with a 422
	// at generate-jitconfig, and that rejection is per-repo-name-length, so it
	// hides until a repo with a long name is the one that needs a mint. On
	// 2026-09-02 this repo — `hadoku-fleet-manager`, 20 characters — produced a
	// 69-character name and could not mint AT ALL, while `hadoku_site` (11) had
	// been minting all along. CI for this repo sat queued with no runner able to
	// take it, because the conversion to all-ephemeral had just removed the
	// standing claws that used to absorb it.
	//
	// The SLUG is the only part that may be shortened. Everything else is
	// load-bearing:
	//   - `node` is how `nodeOf` attributes a runner to a machine, by longest
	//     declared-name prefix. Truncate it and the runner reads as unknown.
	//   - `-j…-r…-<epoch>` is what `parseJitName` and the reaper key on, and an
	//     unparseable name is treated as IMMEDIATELY reapable (§12.8) — clamping
	//     the tail to fit would kill running jobs.
	// Nothing reads the slug back; it is there so a human can see what a unit is
	// for. Truncating it cannot collide, because the job id, run id and epoch
	// that follow are unique on their own.
	//
	// This stays TOTAL — it never throws. `planTick` is not wrapped by its caller
	// in `dispatch-pass`, so a throw here would abort the whole pass and stop
	// minting for every node, turning one bad name into a fleet-wide outage.
	const head = `${JIT_PREFIX}${node}-`;
	const tail = `-j${jobId}-r${runId}-${Math.floor(nowMs / 1000)}`;
	const budget = MAX_RUNNER_NAME - head.length - tail.length;
	// A node name long enough to leave no room is an operator naming problem, not
	// something to paper over: drop the slug entirely and let the mint fail loudly
	// at GitHub rather than mint an unparseable name the reaper would kill.
	if (budget < 1) return `${JIT_PREFIX}${node}${tail}`;
	return `${head}${slug.slice(0, budget)}${tail}`;
}

/**
 * Recover the run id and mint time from a JIT unit or runner name.
 *
 * Parsing a name back is not elegant, but the alternative is state, and state is
 * what §12.8 and B9 both rule out: the units on the nodes ARE the record,
 * precisely because they survive the ~5 daily restarts of the process that made
 * them. Returns null for anything that is not ours, so a stray unit is ignored
 * rather than misread.
 */
export function parseJitName(
	name: string
): { runId: number; jobId: number | null; mintedAtMs: number } | null {
	const bare = name.replace(/\.service$/, '');
	if (!name.startsWith(JIT_PREFIX)) return null;
	// `jobId` is null for a name minted before the job-scoped format. Those are
	// still parseable — they must be, or the reaper would treat live units as
	// ageless — and the caller falls back to blocking at RUN level for them.
	const withJob = /-j(\d+)-r(\d+)-(\d+)$/.exec(bare);
	if (withJob)
		return {
			runId: Number(withJob[2]),
			jobId: Number(withJob[1]),
			mintedAtMs: Number(withJob[3]) * 1000,
		};
	const m = /-r(\d+)-(\d+)$/.exec(bare);
	if (!m) return null;
	return { runId: Number(m[1]), jobId: null, mintedAtMs: Number(m[2]) * 1000 };
}

/** The JIT root under a node's home directory — the one place this path is
 * spelled; `slotDir` and the space probe both derive from it. */
export function jitRoot(home: string): string {
	return `${home}/.hadoku/jit`;
}

/** Where a mint's hardlinked payload slot lives. Same filesystem as the shared
 * payload, or `cp -al` silently becomes a 674 MB real copy (§12.16). */
export function slotDir(home: string, index: number): string {
	return `${jitRoot(home)}/slot${index}`;
}

/**
 * How many concurrent jobs the dispatcher will run on one node, and WHERE that
 * number came from.
 *
 * ONE ANSWER, TWO READERS. `ephemeral-tick` mints against it and `routes/fleet`
 * reports it, so the panel and the dispatcher cannot disagree about a node's
 * budget.
 *
 * `maxConcurrent` is the only declaration. It is also the per-node ceiling for
 * anything that is not about memory — a thermally marginal node is capped here,
 * because admission enforces it on every mint. The `basis` is returned so a
 * panel can show a node running on the `default` guess rather than on anything
 * its operator chose: `scripts/enroll-node.mjs` omits `maxConcurrent` on
 * purpose, so a freshly enrolled node is exactly that case. (A borrowed
 * `tierCapacity` fallback sat between the two until the tier ladder was retired
 * on 2026-09-21; every node declared `maxConcurrent`, so it never fired.)
 *
 * `warmListeners` IS A SPEND AGAINST THAT CEILING, NOT A SECOND CEILING.
 * `maxConcurrent` bounds CONCURRENT WORK on the box; every warm listener the
 * node holds can be handed a job by GitHub without passing through this
 * function at all, so a listener occupies one of those slots whether or not it
 * is holding a job this instant. What is left is what the dispatcher may MINT.
 * Measured on claw-3 over the 14 days to 2026-09-22 (n=927): max concurrent JIT
 * units 3 — the cap held exactly for mints — and max concurrent including the
 * warm listener 4, at 48 job starts, every one of them the listener taking a
 * hadoku_site job while three JIT jobs ran. `maxConcurrent: 3` went on that node
 * on 2026-08-17 after two thermal-crash reboots and, since the tier ladder was
 * retired on 2026-09-21, it is the ONLY thermal control there. A cap that binds
 * one of a node's two intake paths is not a cap.
 *
 * SIZED HELD, NOT BUSY-RIGHT-NOW, and for the same reason {@link
 * warmEligibleSlots} sizes the listener's MEMORY busy: the listener does not
 * ask. A reservation conditional on an observation of "it is idle" is decided
 * in this process and spent by GitHub 200 ms later — which is exactly the race
 * those 48 starts are. The two units are now consistent: a node holds a
 * listener only when its memory half AND its count half each hold a whole job
 * beside it.
 */
export type MintBudgetBasis = 'declared' | 'default';

export interface MintBudget {
	slots: number;
	basis: MintBudgetBasis;
}

/**
 * @see MintBudget
 *
 * The RETURN SHAPE is unchanged by the reservation on purpose: `slots` is what
 * the dispatcher may mint and has always been, so a caller that knows nothing
 * about warm listeners (the fleet panel's `routes/fleet`) keeps reporting the
 * node's whole ceiling, which is still the true bound on concurrent work there.
 */
export function mintBudget(m: {
	maxConcurrent?: number | null;
	/**
	 * Warm listeners this node HOLDS — standing registrations GitHub can hand
	 * work to without asking us. Each one spends a slot of the cap. Absent means
	 * none, which is every caller that predates the reservation.
	 */
	warmListeners?: number;
}): MintBudget {
	const held = Number.isFinite(m.warmListeners) ? Math.max(0, Math.floor(m.warmListeners!)) : 0;
	// Never below zero: a node whose whole cap is spent on listeners mints
	// nothing, and `warmConcurrencySlots` is what stops a listener landing there
	// in the first place.
	const spend = (slots: number): number => Math.max(0, slots - held);
	if (typeof m.maxConcurrent === 'number')
		return { slots: spend(m.maxConcurrent), basis: 'declared' };
	// The tick has always ended `?? 1` rather than refusing to mint. Kept: a
	// node that mints one job at a time is recoverable, a node the dispatcher
	// silently skips looks identical to a broken one.
	return { slots: spend(1), basis: 'default' };
}
// --- warm cache of one -------------------------------------------------------
//
// P4.1 (docs/planning/warm-listener-cache-2026-09-05.md). Everything above this
// point decides an EPHEMERAL mint: a registration that lasts one job. A warm
// listener is the opposite kind of object — a STANDING registration, built and
// torn down on a separate path, precisely because `assertSafeJitConfig` above
// REQUIRES `Ephemeral: 'True'` and must keep requiring it (§12.16 still applies
// to the payload a warm listener runs from). Nothing here changes admission or
// the ephemeral mint path; the warm cache is additive capacity those functions
// already know how to count once it exists (a warm listener serving a job is a
// standing registration like any other, and `admitMint`'s `standingBusy` was
// written for exactly that shape).

/** Every warm listener's unit/registration name starts with this — distinct
 * from {@link JIT_PREFIX} so the JIT reaper's sweep, which keys on that prefix
 * alone, never touches a warm listener and never ages one out from under a job
 * it did not mint. */
export const WARM_PREFIX = 'warm-';

/**
 * `warm-<node>-<repo-slug>`. No run id, no epoch: a warm listener is not
 * per-job, and the cache is of ONE per node, so nothing needs to disambiguate
 * two live warm listeners on the same node — there is only ever one, and the
 * previous one is evicted before this name is ever minted.
 *
 * Same 64-character GitHub ceiling as {@link jitRunnerName} and the same
 * response to running out of room: drop the slug rather than mint a name
 * GitHub will reject or truncate unpredictably.
 */
export function warmRunnerName(node: string, repo: string): string {
	const slug = repo
		.split('/')
		.pop()!
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, '-');
	const head = `${WARM_PREFIX}${node}-`;
	const budget = MAX_RUNNER_NAME - head.length;
	if (budget < 1) return `${WARM_PREFIX}${node}`.slice(0, MAX_RUNNER_NAME);
	return `${head}${slug.slice(0, budget)}`;
}

/** Where a warm listener's slot lives. Cache of ONE, so there is no index —
 * unlike {@link slotDir}, which is per-mint and numbered. A fixed path is also
 * how discovery works: the marker file beside it records which repo is
 * currently registered there, because that fact must survive an mgmt-api
 * restart the same way every other fact in this workstream does (§12.8, B9) —
 * on the NODE, not in memory. */
export function warmSlotDir(home: string): string {
	return `${home}/.hadoku/warm/listener`;
}

/** What {@link warmEligibleSlots} needs to know about one node. */
export interface WarmEligibilityInput {
	/**
	 * `free -m`'s total column, MEASURED live — never the manifest's `ramGb`,
	 * which fleet-runner-manifest.json's own `$why-display-only` note says
	 * "DECIDES NOTHING" and is rounded (claw-1 measures 11885 MiB, not 11*1024).
	 */
	installedMb: number;
	/** The floor that keeps the box alive; `usable` is what is left above it. */
	minFreeMb: number;
	/**
	 * ONE JOB'S WORTH, in the unit a MINT uses: exactly what admission reserves
	 * for a job on this node whose repo it cannot name — `jobReserve`'s
	 * node/default answer, clamped to the unit's cap. The warm listener's repo
	 * is chosen AFTER eligibility (by the fleet allocator), so the node's figure
	 * is the only honest one here.
	 */
	jobMb: number;
	/** `"claw"` | `"backstop"`. Read through `isBackstopNode`, never directly. */
	role?: unknown;
}

/**
 * How many warm listeners a node may hold without touching the JIT reserve.
 *
 * TWO OBJECTS, TWO UNITS. This used to be `floor(usable / 4096) >= 2` — one
 * number standing in for both the thing reserved and the thing reserving. Now:
 *
 *   - THE MINT RESERVE is half of usable (`installedMb − minFreeMb`), the
 *     operator's settled "50% of usable reserved for JIT whatever the warm
 *     cache holds" (work arrives in bursts; what matters is several COLD repos
 *     wanting a mint at once). It is measured in MB and spent in `jobMb`
 *     units — one mint needs one job's worth.
 *   - THE LISTENER is sized at what it occupies BUSY, which is also `jobMb`:
 *     a warm listener serves the same jobs a JIT unit does and is capped the
 *     same (#26, settled). Its 44 MB (29 listeners, 1,304 MB RSS on hokon —
 *     `warm-listener-cache-2026-09-05.md` §1) is its IDLE rent, and it is NOT
 *     the figure the reservation is computed against.
 *
 * WHY BUSY AND NOT IDLE. A listener is idle only until it does the one thing
 * it exists for, and it does that WITHOUT PASSING ADMISSION — GitHub hands it
 * a job whatever the node's free memory says, whereas every mint is admitted
 * against live free memory first. The reserve exists for the burst, and in a
 * burst the listener is busy. Sized at 44 MB, claw-2 (usable 6336 MB) would
 * pass with 72 listeners to spare, and its one busy listener (p95 3337 MB,
 * 390 jobs) plus one cold mint (3400 MB reserved) is 6737 MB against 6336 —
 * the listener eligible by spending the mint reserve, which is the one thing
 * this rule may not do. Sizing the listener busy makes that impossible by
 * construction: the warm half and the JIT half are the same size, so a node
 * holds a listener only when its JIT half ALSO holds a full mint.
 *
 * A BACKSTOP HOLDS NONE, BY ROLE. hokon's 63402 MB passes any memory test that
 * can be written (it would read 6 here), so memory shape must not be what
 * excludes it: the backstop lends the fleet a reserve registration and is
 * otherwise none of the fleet's business (operator, 2026-09-14). The warm tick
 * also drops backstops before any ssh (`withoutBackstops`); this is the second
 * answer, so a caller that forgets the first still gets zero.
 *
 * TOTAL over its inputs: a non-positive or non-finite figure anywhere reads
 * as zero listeners — "I could not measure it" must never read as room.
 */
export function warmEligibleSlots(i: WarmEligibilityInput): number {
	if (isBackstopNode(i)) return 0;
	return warmMemorySlots(i.installedMb - i.minFreeMb, i.jobMb);
}

/** The memory half of {@link warmEligibleSlots}, over the node's USABLE figure
 * — the one both readers already have in hand (`installedMb − minFreeMb` in the
 * warm tick, `sliceCeilingMbByNode` in the dispatch tick). */
function warmMemorySlots(usableMb: number, jobMb: number): number {
	if (!Number.isFinite(usableMb) || usableMb <= 0) return 0;
	if (!Number.isFinite(jobMb) || jobMb <= 0) return 0;
	const mintReserveMb = Math.ceil(usableMb / 2);
	return Math.max(0, Math.floor((usableMb - mintReserveMb) / jobMb));
}

/**
 * How many warm listeners a node's own CONCURRENCY CAP leaves room for — the
 * count half of eligibility, beside {@link warmEligibleSlots}' memory half.
 *
 * The same shape as the memory rule and for the same reason. There, a listener
 * is eligible only when the JIT half still holds a whole mint; here, a listener
 * is eligible only when the cap still holds a whole JIT slot beside it. A node
 * capped at 1 that held a listener would have nothing left to mint with — the
 * dispatcher would skip it forever while every check on it read green — and a
 * node capped at 0 does not arise because {@link mintBudget} floors there.
 *
 * WHY THE CAP HAS TO BE CONSULTED AT ALL. `maxConcurrent` is enforced on the
 * MINT path (`admitMint`) and nowhere else, and on the machine by
 * `scripts/admin/ci-throttle.sh`, whose own manifest note records that it
 * "cannot enforce because MAX_WAIT_S=90 admits rather than fails". A standing
 * listener takes neither path: it is already registered and long-polling, so
 * GitHub hands it work directly. Until 2026-09-24 this function did not exist
 * and warm placement was a MEMORY test alone, which is how claw-3 — capped at 3
 * on thermals, 96-99 °C under load against a 100 °C trip — ran 4 concurrent
 * jobs 48 times in 14 days.
 *
 * UNDECLARED IS ZERO, not a guess: `mintBudget`'s `default` basis is one slot,
 * which the listener would take whole. A freshly enrolled node (enroll-node.mjs
 * omits `maxConcurrent` deliberately) therefore carries no listener until its
 * operator chooses a ceiling. That is the same direction every other "nobody
 * measured this" answer in this module takes.
 */
export function warmConcurrencySlots(m: { maxConcurrent?: number | null }): number {
	const { slots } = mintBudget(m);
	if (!Number.isFinite(slots)) return 0;
	// One slot back for the JIT half — see the memory rule's mint reserve.
	return Math.max(0, slots - 1);
}

/** What {@link warmListenerSlots} needs to know about one node. */
export interface WarmPlacementInput {
	/** `installedMb − minFreeMb`, MEASURED. Never the manifest's `ramGb`. */
	usableMb: number;
	/** One job's worth, in the unit a MINT uses — see {@link
	 * WarmEligibilityInput.jobMb}. */
	jobMb: number;
	/** `"claw"` | `"backstop"`. Read through `isBackstopNode`, never directly. */
	role?: unknown;
	/** The node's declared concurrency ceiling, or absent. */
	maxConcurrent?: number | null;
}

/**
 * How many warm listeners this node may hold: BOTH halves, one answer.
 *
 * ONE RULE, TWO READERS, and that is the whole point of it being here rather
 * than at either call site. `dispatchWarmCache` asks it to decide whether to
 * PLACE a listener; `dispatchEphemeral` asks it to decide how many slots of the
 * cap to hold BACK for one. If those two disagreed, either the node would carry
 * a listener nobody reserved for (the 48 starts) or reserve a slot for a
 * listener it is not allowed to hold (capacity thrown away for nothing). They
 * are handed the same measured `usableMb` and the same `jobMb` on the same
 * tick, so they cannot.
 *
 * The MINIMUM, because each half is a separate necessary condition: memory that
 * fits a listener beside a whole mint, and a cap that fits one beside a whole
 * JIT slot. Either reading zero is zero.
 */
export function warmListenerSlots(i: WarmPlacementInput): number {
	if (isBackstopNode(i)) return 0;
	return Math.min(warmMemorySlots(i.usableMb, i.jobMb), warmConcurrencySlots(i));
}

/**
 * The warm cache is a cache of ONE per node — see {@link warmRunnerName}, which
 * needs no run id or epoch precisely because there is never a second live
 * listener on a node to disambiguate from.
 */
export const WARM_CACHE_SIZE = 1;

/**
 * How many warm listeners this node actually HOLDS: the allowance
 * ({@link warmListenerSlots}) clamped to the cache of one.
 *
 * THE ALLOWANCE IS NOT THE HOLDING, and reserving against the allowance would
 * be a bug of its own — claw-3's memory admits two listeners at its 3400 MB job
 * figure, so a cap of 3 less two reserved leaves ONE JIT slot on the
 * second-busiest node in the fleet, to protect a listener the tick will never
 * mint. This is the number `mintBudget`'s `warmListeners` wants; the allowance
 * is what `warmCacheEligible` reads.
 */
export function warmListenersHeld(i: WarmPlacementInput): number {
	return Math.min(WARM_CACHE_SIZE, warmListenerSlots(i));
}

/**
 * May a node hold a warm listener at all? At least one listener's busy
 * footprint must fit beside the untouched mint reserve — see
 * {@link warmEligibleSlots}, whose count this reads. DERIVED, not a name
 * check: on today's fleet it reads true for claw-1/3/4/5/8/9 and false for
 * claw-2/6 (their JIT half, ~3160 MB, holds less than one mint) and hokon
 * (backstop).
 *
 * The COUNT it is given decides everything, so which count matters: the warm
 * tick and the dispatch tick both pass {@link warmListenerSlots} (memory AND
 * the concurrency cap). The memory-only {@link warmEligibleSlots} remains what
 * `scripts/lib/warm-canary.mjs` measures against, because the canary's question
 * is "does this node have ROOM for the listener it is missing", and a cap is
 * not room.
 */
export function warmCacheEligible(listenerSlots: number): boolean {
	return listenerSlots >= 1;
}
