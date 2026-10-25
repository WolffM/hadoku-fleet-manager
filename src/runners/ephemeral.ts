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

import { isGuestNode } from '../lib/node-role.js';

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

export interface AdmissionInput {
	/**
	 * Has an operator taken this node out of service?
	 *
	 * Optional, and absent means NOT drained — deliberately, because the
	 * dispatcher is not the safety net here. A drained standing node is stopped
	 * by its label; a drained ephemeral node is stopped by this. A caller that
	 * forgets it loses the second, not both, and `fleet drain --status` reads
	 * observed busy counts rather than trusting either.
	 */
	drained?: boolean;
	/** The drain record behind `drained`, so the refusal names it rather than
	 *  calling every drain "maintenance". Absent: the old generic wording. */
	drainedAs?: { kind?: string; reason?: string };

	/** Spawned-and-not-yet-exited JIT units on this node. NOT registrations:
	 * §12.8 showed a registration outlives its listener. */
	liveUnits: number;
	/** Standing (non-JIT) registrations still able to accept work here. GitHub
	 * assigns to those without asking us, so they count against the same cap. */
	standingBusy: number;
	maxConcurrent: number;
	freeMb: number;
	/** This repo's harvested unreclaimable peak. Count caps invitations; memory
	 * gates admission (§7-B). */
	requiredMb: number;
	minFreeMb: number;
	/**
	 * Was {@link requiredMb} itself built from capped runs — OOM-killed, or
	 * pinned at a node's own ceiling — rather than an uncapped measurement?
	 *
	 * A RESERVATION FROM CAPPED RUNS IS A LOWER BOUND, never the whole truth
	 * (#76, CLAUDE.md). `demand-derive.mjs`'s `deriveJobReserves` already raises
	 * `requiredMb` to the highest cap the repo's own runs hit — brave-quartet's
	 * three runs were all capped, two at claw-2/claw-4's 6,313 MB slice ceiling —
	 * but a number is not its own provenance: nothing downstream of that raise
	 * can tell "this is the most we've ever measured and the true need may be
	 * higher" apart from "this is what the job needs" without this flag
	 * travelling with it. Absent (the default) means an ordinary estimate —
	 * every caller before #76 — and the clause below never fires.
	 */
	requiredIsLowerBound?: boolean;
	/**
	 * This node's own per-unit ceiling — the slice's ceiling (`MemTotal −
	 * minFreeMb`), or wider if the manifest says so. See {@link unitMemoryMaxMb},
	 * which derives the same number for the unit's `MemoryMax`.
	 *
	 * NEEDED TO TELL PLACEMENT FROM CONTENTION (#67). Without it, a lower-bound
	 * `requiredMb` bigger than this node could ever give it still gets admitted
	 * whenever `freeMb` happens to be high enough right now — fits beside other
	 * jobs today, OOM-killed the next time something else is also running, the
	 * same "start and kill" #26 already named. Absent is tolerated (an older
	 * caller, or a node whose installed memory could not be read) and the new
	 * clause below never fires — admission falls back to the plain `freeMb`
	 * check it has always done.
	 */
	sliceCeilingMb?: number;
	/**
	 * Free MB on `/tmp`, measured this tick (`df -Pm /tmp`) — never declared.
	 * Three states: `undefined` means this caller never looked (today only
	 * `prove-job.ts`'s hand-built literal, which has no node to probe and must
	 * not fire the clause below); `null` means the live tick looked and the
	 * `df` came back unreadable, which refuses exactly like a measured value
	 * under the floor — "could not look" is never read as "there is room"
	 * (AGENTS.md); a number is compared against {@link TMP_FREE_FLOOR_MB}.
	 * The live tick (`ephemeral-tick.ts`'s node builder) must always supply
	 * one of the latter two, never leave this undefined.
	 */
	tmpFreeMb?: number | null;
	/**
	 * Free MB on the filesystem holding `~/.hadoku/jit` (falling back to
	 * `~/.hadoku` or `$HOME` when the jit directory has never been created —
	 * same three states as {@link tmpFreeMb}, compared against
	 * {@link WORK_FREE_FLOOR_MB}.
	 */
	workFreeMb?: number | null;
}

export interface AdmissionResult {
	ok: boolean;
	reason?: string;
}

/**
 * How much headroom a lower-bound floor needs ABOVE the cap that produced it,
 * before a node's slice counts as clearing it (#76, manager correction
 * 2026-10-02).
 *
 * THE FLOOR IS THE CAP THE JOB WAS KILLED AT, so its true need is STRICTLY
 * above it — "lower bound" means exactly that, not "approximately this". A
 * slice that merely exceeds the floor by a few megabytes is still gambling
 * that the uncapped need happens to land in that gap: claw-2 measured at
 * 6,336 MB against brave-quartet's 6,313 MB floor admitted on a 23 MB
 * margin — a coin flip away from the exact "start and kill" shape (#26) this
 * lane exists to stop, not a cleared floor.
 *
 * 10%. Not measured from a distribution (there isn't one — the whole point of
 * a capped run is that nothing sampled past the cap), so this is a safety
 * margin, not a percentile. Beside `JOB_RESERVE_DEFAULT_MB`'s own precedent:
 * that constant is "an ESTIMATE of appetite", chosen to clear a measured worst
 * case with margin; this one is the same shape of judgement call for a number
 * that cannot be measured past its own ceiling at all.
 */
export const LOWER_BOUND_HEADROOM = 0.1;

/**
 * Free-MB floor on `/tmp` below which a node is refused a mint (#101).
 *
 * #101: claw-4's tmpfs filled 03:22-04:14Z and failed 4 jobs while memory
 * admission still passed — a dataplatform pytest run plus a site build wrote
 * GBs onto a 7.8 GB tmpfs. Chosen to refuse a node observed at 300 MB free
 * and admit one observed at 3 GB free (the two reference points the wave that
 * added this clause measured against), and to refuse NO claw on the fleet as
 * measured 2026-10-06 (claw-4 itself sat at ~4.7 GB free that day). 2,048 MB:
 * comfortably under the 3 GB admit case, comfortably over the 300 MB refuse
 * case, round enough to reason about.
 */
export const TMP_FREE_FLOOR_MB = 2048;

/**
 * Free-MB floor on the filesystem holding `~/.hadoku/jit` below which a node
 * is refused a mint (#101) — same reasoning and same value as
 * {@link TMP_FREE_FLOOR_MB}: JIT payloads and job workspaces land here, and a
 * node that cannot give a job `/tmp` space is no safer here.
 */
export const WORK_FREE_FLOOR_MB = 2048;

/**
 * May this node take one more job right now?
 *
 * Both clauses of §7-B's acceptance criterion, in one place: standing
 * registrations plus live mints must not exceed `maxConcurrent`, and the mint
 * must not push free memory below what this repo actually needs.
 *
 * The memory clause is why a count cap alone is not enough — measured
 * 2026-08-26, three concurrent jobs at p95 want 8.2 GB on claw-2's 7.7 GB, so a
 * node can sit inside `maxConcurrent: 3` and still be over its budget
 * (§12.6).
 */
export function admitMint(i: AdmissionInput): AdmissionResult {
	// FIRST, before capacity and before memory. A node an operator has taken out
	// of service is refused however much room it has — the question "is there
	// space" does not arise once the answer to "should anything land here" is no.
	//
	// This is the ephemeral half of a soft-close. The standing half is the label
	// strip in setTierEligibility, and both are needed: the dispatcher mints for
	// claw-1 and claw-3, GitHub assigns directly to the other five.
	// The `drained:` prefix is what classifyAdmissionClause reads; the rest names
	// the drain. Every drain read as "for maintenance" until 2026-10-25, so a
	// claw mid-reboot and a claw lent to a tenant looked identical everywhere.
	if (i.drained) {
		const d = i.drainedAs;
		return {
			ok: false,
			reason: d?.reason
				? `drained: ${d.kind ?? 'maintenance'}: ${d.reason}`
				: 'drained: held out of service for maintenance',
		};
	}
	const inFlight = i.liveUnits + i.standingBusy;
	if (inFlight >= i.maxConcurrent) {
		return { ok: false, reason: `at capacity: ${inFlight}/${i.maxConcurrent} in flight` };
	}
	// PLACEMENT, not contention (#67, #76). `requiredMb` built from capped runs
	// is a FLOOR, not a ceiling: the job is KNOWN to have used at least this
	// much, on a run that was itself stopped from going higher — so the true
	// need is STRICTLY above it, not approximately at it. If this node's own
	// slice does not clear that floor WITH {@link LOWER_BOUND_HEADROOM} of
	// margin, no amount of waiting fixes it — the question answered below ("is
	// there room right now") does not apply once the answer to "could this node
	// ever hold it, completely alone" is no. A slice a few megabytes over the
	// floor is still gambling that the uncapped need lands in that gap (claw-2
	// measured at 6,336 MB against a 6,313 MB floor — a 23 MB margin, found and
	// corrected 2026-10-02): that is the brave-quartet shape (#26) with extra
	// digits, not a cleared floor.
	if (i.requiredIsLowerBound && typeof i.sliceCeilingMb === 'number') {
		const floorWithHeadroom = Math.ceil(i.requiredMb * (1 + LOWER_BOUND_HEADROOM));
		if (i.sliceCeilingMb < floorWithHeadroom) {
			return {
				ok: false,
				reason:
					`placement: this repo's known floor is ${i.requiredMb}MB — every run that produced ` +
					`it was itself capped (OOM-killed, or pinned at a node's own ceiling), so the true ` +
					`need is above it — and this node's slice tops out at ${i.sliceCeilingMb}MB, under ` +
					`the ${floorWithHeadroom}MB (${Math.round(LOWER_BOUND_HEADROOM * 100)}% headroom) ` +
					`this floor needs before the slice counts as clearing it`,
			};
		}
	}
	const after = i.freeMb - i.requiredMb;
	if (after < i.minFreeMb) {
		return {
			ok: false,
			reason:
				`memory: ${i.freeMb}MB free, this repo peaks at ${i.requiredMb}MB, ` +
				`would leave ${after}MB against a ${i.minFreeMb}MB floor`,
		};
	}
	// SPACE (#101). `undefined` is "this caller never looked" (prove-job's
	// hand-built literal) and the clause does not fire. `null` is "the live
	// tick looked and could not read it" — refused, same as a measured value
	// under the floor, never admitted on a guess (AGENTS.md). A node cannot
	// run a job without `/tmp` or `_work` space regardless of how much
	// memory it has, so this runs after the memory clause rather than instead
	// of it.
	const space = spaceRefusal(i);
	if (space) return { ok: false, reason: space.reason };
	return { ok: true };
}

/**
 * The SPACE clause (#101), pulled out of `admitMint` so the warm path
 * (`ephemeral-tick.ts`'s `dispatchWarmCache`) can ask the identical question
 * from its OWN measurement instead of reading `admitMint`'s combined,
 * first-refusing-clause-wins verdict — a node that is both at capacity (or
 * memory-starved) AND out of `/tmp` would otherwise report `concurrency`/
 * `memory` and keep a warm listener it should not (#101 masking).
 *
 * `undefined` on either input never refuses (the caller never looked — only
 * `prove-job.ts`'s hand-built literal today). `null` refuses exactly like a
 * measured value under the floor: "could not look" is never read as "there
 * is room" (AGENTS.md). `/tmp` is checked before `_work`, same order
 * `admitMint` always used, so a caller that cares which one fired first can
 * still tell from `filesystem`.
 *
 * Returns `null` when neither filesystem refuses.
 */
export function spaceRefusal(i: {
	tmpFreeMb?: number | null;
	workFreeMb?: number | null;
}): { filesystem: 'tmp' | 'work'; freeMb: number | null; floorMb: number; reason: string } | null {
	if (i.tmpFreeMb === null) {
		return {
			filesystem: 'tmp',
			freeMb: null,
			floorMb: TMP_FREE_FLOOR_MB,
			reason: 'space: could not read /tmp free space',
		};
	}
	if (typeof i.tmpFreeMb === 'number' && i.tmpFreeMb < TMP_FREE_FLOOR_MB) {
		return {
			filesystem: 'tmp',
			freeMb: i.tmpFreeMb,
			floorMb: TMP_FREE_FLOOR_MB,
			reason: `space: /tmp has ${i.tmpFreeMb}MB free, under the ${TMP_FREE_FLOOR_MB}MB floor`,
		};
	}
	if (i.workFreeMb === null) {
		return {
			filesystem: 'work',
			freeMb: null,
			floorMb: WORK_FREE_FLOOR_MB,
			reason: 'space: could not read _work free space',
		};
	}
	if (typeof i.workFreeMb === 'number' && i.workFreeMb < WORK_FREE_FLOOR_MB) {
		return {
			filesystem: 'work',
			freeMb: i.workFreeMb,
			floorMb: WORK_FREE_FLOOR_MB,
			reason: `space: _work has ${i.workFreeMb}MB free, under the ${WORK_FREE_FLOOR_MB}MB floor`,
		};
	}
	return null;
}

/**
 * Reject a jitconfig that would be unsafe to run from a hardlinked slot.
 *
 * `generate-jitconfig` sets `DisableUpdate: True` today, but that is GitHub's
 * default rather than our guarantee. On ext4 a hardlink is a second name for one
 * inode, so a runner that self-updated in place would rewrite the payload shared
 * by every slot on the node at once — the same mechanism this repo already
 * documents for the pnpm store. Cheap to check, catastrophic to assume.
 */
export function assertSafeJitConfig(encoded: string): AdmissionResult {
	let runnerCfg: Record<string, unknown>;
	try {
		const outer = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<
			string,
			string
		>;
		const inner = outer['.runner'];
		if (!inner) return { ok: false, reason: 'jitconfig has no .runner section' };
		runnerCfg = JSON.parse(Buffer.from(inner, 'base64').toString('utf8')) as Record<
			string,
			unknown
		>;
	} catch (err) {
		return { ok: false, reason: `jitconfig is unreadable: ${(err as Error).message}` };
	}
	if (String(runnerCfg.DisableUpdate) !== 'True') {
		return {
			ok: false,
			reason:
				'jitconfig does not set DisableUpdate — a self-update would rewrite the ' +
				'hardlinked payload shared by every slot on this node',
		};
	}
	if (String(runnerCfg.Ephemeral) !== 'True') {
		return { ok: false, reason: 'jitconfig is not Ephemeral — it would outlive its job' };
	}
	return { ok: true };
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
	/** `"claw"` | `"guest"`. Read through `isGuestNode`, never directly. */
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
 * A GUEST HOLDS NONE, BY ROLE. hokon's 63402 MB passes any memory test that
 * can be written (it would read 6 here), so memory shape must not be what
 * excludes it: a guest lends the fleet a backstop registration and is
 * otherwise none of the fleet's business (operator, 2026-09-14). The warm tick
 * also drops guests before any ssh (`withoutGuests`); this is the second
 * answer, so a caller that forgets the first still gets zero.
 *
 * TOTAL over its inputs: a non-positive or non-finite figure anywhere reads
 * as zero listeners — "I could not measure it" must never read as room.
 */
export function warmEligibleSlots(i: WarmEligibilityInput): number {
	if (isGuestNode(i)) return 0;
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
	/** `"claw"` | `"guest"`. Read through `isGuestNode`, never directly. */
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
	if (isGuestNode(i)) return 0;
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
 * (guest).
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

/** The busy-lock's other half — see {@link warmSlotLocked}. Same value as the
 * dispatcher's own SATURATED_QUEUED_MS-adjacent reasoning: GitHub's assign
 * window measured p50 9s, p90 17s, so 20s covers it with margin without
 * pinning a slot open for long after a job that never arrived. */
export const WARM_ASSIGN_WINDOW_MS = 20_000;

export interface WarmLockInput {
	/** From the GitHub API — authoritative, but polled, hence the second clause
	 * below. */
	busy: boolean;
	/** When this warm listener was last minted OR handed a job (refreshed to
	 * MRU). */
	mintedOrRefreshedAtMs: number;
	nowMs: number;
}

/**
 * May this warm slot be evicted right now?
 *
 * Two conditions, not one — see "Eviction, and the window that makes it
 * unsafe" in the design doc. `busy` alone misses the gap between GitHub
 * deciding to dispatch and the job reporting started: a listener is idle by
 * every observable signal in that window and already has work coming, so
 * evicting there kills a job that never got the chance to exist. The second
 * clause is what covers it.
 */
export function warmSlotLocked(i: WarmLockInput): boolean {
	if (i.busy) return true;
	return i.nowMs - i.mintedOrRefreshedAtMs < WARM_ASSIGN_WINDOW_MS;
}

/** A live warm slot, as observed on its node. */
export interface WarmSlotState {
	repo: string;
	busy: boolean;
	mintedOrRefreshedAtMs: number;
}

export type WarmCacheDecision =
	| { action: 'idle' } // nothing has been observed served here yet
	| { action: 'keep' } // the slot already holds the right repo
	| { action: 'fill'; repo: string } // no slot yet; mint one
	| { action: 'locked' } // wrong repo, but not safe to evict yet
	| { action: 'rotate'; from: string; to: string }; // wrong repo, safe to evict

/**
 * One job a node has already served, reduced to the two facts selection needs.
 *
 * Deliberately NOT `JobRecord`: everything in this module is pure and must not
 * depend on job-history's wire shape, and the caller has already resolved the
 * runner name to a node (`nodeOf`) by the time it gets here.
 */
export interface WarmServedJob {
	/** `owner/repo`, exactly the string that will be handed to the mint. */
	repo: string;
	/** job-history's `startedAt`, parsed. Non-finite values are dropped. */
	startedAtMs: number;
	/**
	 * How long the job held its runner (job-history's `durationSec`, in ms).
	 * Only {@link planWarmFleet} reads it, to tell a repo whose jobs run one at
	 * a time from one whose jobs OVERLAP — see {@link warmUnitValues}. Absent
	 * reads as zero: no overlap, which is the plain distinct-repo allocation.
	 * That errs toward spreading listeners, never toward an eviction.
	 */
	durationMs?: number;
}

/**
 * How far back a job counts AT ALL. Older than this and it is not evidence
 * about what the node will serve next; it is history.
 *
 * SIX HOURS, and the two measurements that fix it — both replayed from
 * `~/.hadoku-mgmt/job-history.jsonl`, see
 * `docs/planning/warm-selection-2026-09-09.md` for the scripts:
 *
 *  - BELOW 6 h the window is empty too often, and an empty window is no signal
 *    at all (`{action:'idle'}`, which keeps whatever the slot already holds).
 *    Per eligible node over the 7 days to 2026-09-09, sampling every 10 min, a
 *    window is empty at: 1 h → 67.3% of samples, 2 h → 52.6%, 3 h → 43.1%,
 *    4 h → 36.0%, 6 h → 27.1%, 12 h → 14.9%. The curve flattens after 6 h.
 *  - ABOVE 6 h buys no throughput. Replaying the cache-of-one over the same
 *    7 days, total jobs served by the warm slot is 1500 (W=3 h), 1503 (4 h),
 *    1507 (6 h), 1513 (12 h) — under 1% across a 4x change in window. What DOES
 *    keep changing above 6 h is how long a genuine shift in concentration takes
 *    to reach the slot, which is the thing the operator's "nothing is pinned"
 *    rules out. 6 h is the knee.
 *
 * 6 h also clears the busy repo's own lulls: over the same 7 days the p95
 * gap between consecutive `hadoku_site` jobs on an eligible node is 44.7 min
 * (claw-1), 155.9 (claw-3), 168.7 (claw-4) and 124.0 (claw-5), so the
 * dominant repo never falls out of its own window during a normal quiet spell.
 */
export const WARM_HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * How fast a job's vote decays INSIDE the window: after this long, a job counts
 * half as much as one that just landed.
 *
 * NINETY MINUTES, which is {@link WARM_HISTORY_WINDOW_MS} / 4, and the ratio is
 * what actually matters:
 *
 *  - THE RATIO IS THE SAFETY PROPERTY. A job at the very edge of the window
 *    still weighs `2^-(window/halfLife)` of a job that just landed, so one
 *    fresh job can outrank at most `2^(window/halfLife)` old ones. At 6 h / 90
 *    min that is 2^4 = 16: **a repo with a single job in the window can never
 *    outrank a repo with 17 or more, wherever in the window those 17 fell.**
 *    Issue #16's "a repo with one job in the window never evicts one with
 *    fifty" therefore holds with a 3x margin, structurally, not by tuning.
 *    Any change to either constant must keep `2^(window/halfLife) < 50`.
 *  - It is also where the measured yield turns the corner. Replaying this very
 *    function over the 7 days to 2026-09-09 with a 6 h window, the fraction of
 *    fills that went on to serve >=1 job is 48.1% (halfLife 45 min), 51.1%
 *    (60), 57.0% (75), **60.3% (90)**, 60.0% (105), 58.2% (120), against 41.9%
 *    for MRU. The same shape holds on a 14-day replay (50.0 / 49.3 / 54.0 /
 *    **56.0** / 56.2 / 53.2 against 41.1%), so it is not one week's weather.
 *    The bigger win is churn: 68 fills over those 7 days where MRU took 554,
 *    each fill being a DELETE, a registration-token POST and a provisioning
 *    ssh — while serving 1507 jobs against MRU's 1367.
 *  - Responsiveness, which is the other half of "nothing is pinned": a repo
 *    that stops firing halves every 90 min, so it is overtaken within a few
 *    hours rather than at the end of the window.
 *
 * ZERO IS A LEGAL VALUE AND MEANS "MRU": with no decay time at all, only the
 * single most recent job carries any weight, so the argmax is exactly the
 * last-served repo — the behaviour this selection replaced. That is the limit
 * of the formula, not a special case bolted on, and
 * `src/tests/ephemeral.test.ts` mutates it to zero and asserts MRU comes back.
 */
export const WARM_HALF_LIFE_MS = 90 * 60 * 1000;

/**
 * Scores are compared for equality within this — they are sums of powers of
 * two, so an exact tie is common (two repos with one job each at the same
 * instant) and a float-equality test would break it arbitrarily.
 */
const WARM_SCORE_EPSILON = 1e-9;

/**
 * Decayed recent frequency per repo, for ONE node's history.
 *
 * Age is measured from the NEWEST job still in the window, not from `nowMs`.
 * That is deliberate and load-bearing twice over: it makes the ranking depend
 * only on how recent jobs are relative to EACH OTHER (so a tick that runs five
 * minutes after a quiet spell ranks the same as one that runs five seconds
 * after a burst), and it is what makes a half-life of zero collapse to MRU
 * rather than to "every score is zero".
 */
export function warmRepoScores(
	served: readonly WarmServedJob[],
	nowMs: number,
	opts: { windowMs?: number; halfLifeMs?: number } = {}
): Map<string, number> {
	const windowMs = opts.windowMs ?? WARM_HISTORY_WINDOW_MS;
	const halfLifeMs = opts.halfLifeMs ?? WARM_HALF_LIFE_MS;
	const scores = new Map<string, number>();
	let newestMs = -Infinity;
	for (const j of served) {
		if (!Number.isFinite(j.startedAtMs)) continue;
		if (nowMs - j.startedAtMs > windowMs) continue;
		if (j.startedAtMs > newestMs) newestMs = j.startedAtMs;
	}
	if (!Number.isFinite(newestMs)) return scores;
	for (const j of served) {
		if (!Number.isFinite(j.startedAtMs)) continue;
		if (nowMs - j.startedAtMs > windowMs) continue;
		// Clamped, so a timestamp ahead of the newest (clock skew between a node
		// and hokon) can never weigh MORE than a job that just landed.
		const ageMs = Math.max(0, newestMs - j.startedAtMs);
		const weight = halfLifeMs <= 0 ? (ageMs === 0 ? 1 : 0) : 2 ** (-ageMs / halfLifeMs);
		scores.set(j.repo, (scores.get(j.repo) ?? 0) + weight);
	}
	return scores;
}

/**
 * The repo this node's warm slot SHOULD hold, or null when the window holds
 * nothing to go on.
 *
 * Ties go to the repo already in the slot when there is one — a tie is not a
 * reason to pay a DELETE, a registration-token POST and a provisioning ssh —
 * and otherwise to the more recently served repo.
 */
export function warmTargetRepo(
	served: readonly WarmServedJob[],
	nowMs: number,
	opts: { windowMs?: number; halfLifeMs?: number; preferRepo?: string | null } = {}
): string | null {
	const scores = warmRepoScores(served, nowMs, opts);
	if (scores.size === 0) return null;
	const windowMs = opts.windowMs ?? WARM_HISTORY_WINDOW_MS;
	const latestMs = new Map<string, number>();
	for (const j of served) {
		if (!Number.isFinite(j.startedAtMs)) continue;
		if (nowMs - j.startedAtMs > windowMs) continue;
		const prev = latestMs.get(j.repo);
		if (prev === undefined || j.startedAtMs > prev) latestMs.set(j.repo, j.startedAtMs);
	}
	let best: string | null = null;
	let bestScore = -Infinity;
	for (const [repo, score] of scores) {
		if (best === null || score > bestScore + WARM_SCORE_EPSILON) {
			best = repo;
			bestScore = score;
			continue;
		}
		if (score < bestScore - WARM_SCORE_EPSILON) continue;
		if (repo === opts.preferRepo) {
			best = repo;
			continue;
		}
		if (best === opts.preferRepo) continue;
		if ((latestMs.get(repo) ?? -Infinity) > (latestMs.get(best) ?? -Infinity)) best = repo;
	}
	return best;
}

/**
 * The whole cache-of-one policy in one place, over plain data.
 *
 * DYNAMIC, nothing pinned, nothing seeded — see "The cache is DYNAMIC" in the
 * design doc, and the operator's 2026-09-09 restatement of it. What SHOULD be
 * warm is derived from the node's own job history every tick; no repo is ever
 * named in a file. `residentRepos` is the disaster backstop and is a different
 * mechanism entirely.
 *
 * The SIGNAL changed on 2026-09-09 (issue #16) and nothing else did: last-served
 * MRU became decayed recent frequency ({@link WARM_HALF_LIFE_MS}), because MRU
 * chases the repo that just went quiet. Both locks are unchanged and still sit
 * between the target and any eviction — a busy listener and one inside the
 * ~20 s assign window are `locked`, never rotated.
 *
 * NO LONGER WHAT THE TICK CALLS (wave 3k §B): the tick decides every node at
 * once through {@link planWarmFleet}, because this per-node argmax, asked on
 * every node over a shared skewed history, cannot see what the others hold.
 * It stays the one-node rule its own tests pin and the baseline the fleet
 * allocation's replay is measured against.
 */
export function planWarmCache(i: {
	current: WarmSlotState | null;
	nowMs: number;
	/** Defaults to {@link WARM_HISTORY_WINDOW_MS}. Tests override it. */
	windowMs?: number;
	/** Defaults to {@link WARM_HALF_LIFE_MS}. Zero is MRU — see there. */
	halfLifeMs?: number;
	/**
	 * The node's own served jobs, scored by {@link warmTargetRepo}. The ONLY
	 * signal: the MRU `lastServedRepo` arm this used to accept beside it was
	 * deleted in wave 3k §A, because the production call site
	 * kept passing it for twelve days after this signal was built — both arms
	 * typechecked, so nothing said the fix was inert.
	 */
	served: readonly WarmServedJob[];
}): WarmCacheDecision {
	const target = warmTargetRepo(i.served, i.nowMs, {
		windowMs: i.windowMs,
		halfLifeMs: i.halfLifeMs,
		preferRepo: i.current?.repo ?? null,
	});
	if (!target) return { action: 'idle' };
	if (!i.current) return { action: 'fill', repo: target };
	if (i.current.repo === target) return { action: 'keep' };
	if (
		warmSlotLocked({
			busy: i.current.busy,
			mintedOrRefreshedAtMs: i.current.mintedOrRefreshedAtMs,
			nowMs: i.nowMs,
		})
	) {
		return { action: 'locked' };
	}
	return { action: 'rotate', from: i.current.repo, to: target };
}

// --- the fleet allocation (wave 3k §B) ----------------------------------------

/**
 * How much a listener a node ALREADY holds is worth, relative to one it would
 * have to mint: a challenger displaces an incumbent only when its marginal
 * value is more than this many times the incumbent's.
 *
 * THIS IS THE DAMPING, and it exists because the fleet allocation is decided at
 * the boundary between the last listener granted and the first one refused,
 * which is the long tail — two or three recent jobs apiece, swapping rank every
 * time one of them runs a job. Without it every such swap is a rotation, and a
 * rotation is a DELETE, a registration-token POST and a provisioning ssh, paid
 * to hold a repo worth no more than the one just evicted. A RATIO, not a
 * margin, because the values have no fixed scale (decayed counts anchored at
 * the newest job — see {@link warmRepoScores}), so an additive margin would be
 * enormous at the head and meaningless in the tail.
 *
 * TWO, chosen by replay — `docs/planning/warm-allocation-2026-09-21.md`
 * tabulates served coverage and mints across 1, 1.5, 2, 3 and 4 over the same
 * 14 days. It does not weaken either lock (those are absolute) and it cannot
 * pin anything: an incumbent whose repo stops firing halves every
 * {@link WARM_HALF_LIFE_MS}, so it is overtaken within one half-life of a
 * challenger doubling it, and a repo that leaves the window is worth zero,
 * which no ratio protects.
 */
export const WARM_INCUMBENT_RATIO = 2;

/**
 * What the 1st, 2nd, ... `maxUnits`th warm listener for each repo is worth:
 * `values.get(repo)[k - 1]` is the decayed count of that repo's jobs that
 * started while `k - 1` of its OTHER jobs were still running.
 *
 * WHY NOT JUST THE SCORE. A warm listener serves ONE job at a time. A repo
 * whose jobs fan out — hadoku_site: of 4,766 jobs in 14 days only 801 started
 * with no other hadoku_site job running — gets from its first listener only the
 * jobs that arrive while it is free; the rest go cold unless a second listener
 * is there too. So the value of a SECOND listener for the head repo can dwarf
 * the value of a FIRST for the tenth, and ranking repos by volume alone
 * (`#54`'s "82%") counts a job as warm when the only listener that could take
 * it is already busy. Replayed, that ranking SERVED fewer jobs than the
 * per-node argmax it was meant to replace; see the doc above.
 *
 * A job whose start rank is k is served by k listeners but not by k - 1, so
 * this is exactly the marginal value of the kth. Weights are
 * {@link warmRepoScores}'s, so the values across all ranks sum to the score.
 * Jobs with no duration never overlap and all rank 1, so the whole value sits
 * on the first listener — the "Nth node takes the Nth uncovered repo" case.
 */
export function warmUnitValues(
	served: readonly WarmServedJob[],
	nowMs: number,
	maxUnits: number,
	opts: { windowMs?: number; halfLifeMs?: number } = {}
): Map<string, number[]> {
	const windowMs = opts.windowMs ?? WARM_HISTORY_WINDOW_MS;
	const halfLifeMs = opts.halfLifeMs ?? WARM_HALF_LIFE_MS;
	const inWindow = served.filter(
		(j) => Number.isFinite(j.startedAtMs) && nowMs - j.startedAtMs <= windowMs
	);
	const values = new Map<string, number[]>();
	if (!inWindow.length || maxUnits < 1) return values;
	const newestMs = Math.max(...inWindow.map((j) => j.startedAtMs));
	const byRepo = new Map<string, WarmServedJob[]>();
	for (const j of inWindow) {
		let list = byRepo.get(j.repo);
		if (!list) byRepo.set(j.repo, (list = []));
		list.push(j);
	}
	for (const [repo, list] of byRepo) {
		// Stable, so jobs that started in the same second keep file order and
		// rank one after another rather than all claiming the first listener.
		const ordered = [...list].sort((a, b) => a.startedAtMs - b.startedAtMs);
		const units = new Array<number>(maxUnits).fill(0);
		let runningEnds: number[] = [];
		for (const j of ordered) {
			runningEnds = runningEnds.filter((end) => end > j.startedAtMs);
			const rank = runningEnds.length + 1;
			const d = j.durationMs;
			runningEnds.push(j.startedAtMs + (d !== undefined && Number.isFinite(d) && d > 0 ? d : 0));
			if (rank > maxUnits) continue;
			// Same weight, and the same clamp, as warmRepoScores.
			const ageMs = Math.max(0, newestMs - j.startedAtMs);
			units[rank - 1] += halfLifeMs <= 0 ? (ageMs === 0 ? 1 : 0) : 2 ** (-ageMs / halfLifeMs);
		}
		values.set(repo, units);
	}
	return values;
}

/** One node the CALLER has already judged eligible, with what it holds now. */
export interface WarmFleetNode {
	node: string;
	current: WarmSlotState | null;
}

const byNodeName = (a: WarmFleetNode, b: WarmFleetNode) =>
	a.node < b.node ? -1 : a.node > b.node ? 1 : 0;

/**
 * node → repo, the whole fleet at once. `null` means "nothing worth holding
 * beyond what is already granted" — the node keeps what it has, if anything.
 */
function assignWarmRepos(
	nodes: readonly WarmFleetNode[],
	values: ReadonlyMap<string, readonly number[]>,
	latestMs: ReadonlyMap<string, number>,
	locked: ReadonlySet<string>,
	ratio: number
): Map<string, string | null> {
	const out = new Map<string, string | null>();
	// Deterministic whatever order the caller observed its nodes in — the tick
	// observes them in parallel, and an allocation that depended on which ssh
	// answered first would churn on its own.
	const byName = [...nodes].sort(byNodeName);

	// 1. LOCKED NODES KEEP THEIR REPO, and each one is a listener that repo
	//    already has: the next listener anyone is granted for it is valued as
	//    its SECOND, not its first. This runs first so no ranking can move them.
	const granted = new Map<string, number>();
	for (const n of byName) {
		if (!n.current || !locked.has(n.node)) continue;
		out.set(n.node, n.current.repo);
		granted.set(n.current.repo, (granted.get(n.current.repo) ?? 0) + 1);
	}
	const free = byName.filter((n) => !out.has(n.node));
	const holders = new Map<string, WarmFleetNode[]>();
	for (const n of free) {
		if (!n.current) continue;
		let list = holders.get(n.current.repo);
		if (!list) holders.set(n.current.repo, (list = []));
		list.push(n);
	}

	// 2. GREEDY BY MARGINAL VALUE, one listener at a time: each round grants the
	//    listener worth most, where a repo's next listener is worth what its
	//    (granted + 1)th serves, times the ratio while a free node already holds
	//    it. Over repos that do not overlap that is exactly "the Nth node takes
	//    the Nth most valuable uncovered repo"; over one that does, a second
	//    listener competes on what it would actually serve.
	const incumbentsLeft = new Map([...holders].map(([repo, list]) => [repo, list.length]));
	const newcomers: string[] = [];
	// One round per free node: at most one listener each.
	for (const _ of free) {
		let best: { repo: string; eff: number; incumbent: boolean } | null = null;
		for (const [repo, units] of values) {
			const k = granted.get(repo) ?? 0;
			const v = units[k] ?? 0;
			if (v <= 0) continue;
			const incumbent = (incumbentsLeft.get(repo) ?? 0) > 0;
			const eff = incumbent ? v * ratio : v;
			if (best && eff < best.eff - WARM_SCORE_EPSILON) continue;
			if (best && eff <= best.eff + WARM_SCORE_EPSILON) {
				// Ties: an incumbent, then the more recently served, then by name.
				if (best.incumbent !== incumbent) {
					if (best.incumbent) continue;
				} else {
					const bl = latestMs.get(best.repo) ?? -Infinity;
					const l = latestMs.get(repo) ?? -Infinity;
					if (l < bl || (l === bl && repo > best.repo)) continue;
				}
			}
			best = { repo, eff, incumbent };
		}
		if (!best) break;
		granted.set(best.repo, (granted.get(best.repo) ?? 0) + 1);
		if (best.incumbent) {
			const list = holders.get(best.repo) ?? [];
			const left = incumbentsLeft.get(best.repo) ?? 0;
			const keeper = list[list.length - left];
			if (keeper) out.set(keeper.node, best.repo);
			incumbentsLeft.set(best.repo, left - 1);
		} else {
			newcomers.push(best.repo);
		}
	}

	// 3. Newcomers go to the nodes whose eviction costs least: an empty slot
	//    first (a fill evicts nothing), then a displaced holder, least valuable
	//    repo first.
	const cost = (n: WarmFleetNode): number =>
		n.current ? (values.get(n.current.repo) ?? []).reduce((a, b) => a + b, 0) : -Infinity;
	const open = free.filter((n) => !out.has(n.node)).sort((a, b) => cost(a) - cost(b));
	for (const repo of newcomers) {
		const n = open.shift();
		if (n) out.set(n.node, repo);
	}
	// Nothing left worth a listener: they keep what they hold.
	for (const n of open) out.set(n.node, n.current?.repo ?? null);
	return out;
}

/**
 * The warm cache across the WHOLE fleet, over plain data: which repo each
 * eligible node's slot should hold, decided jointly.
 *
 * WHY JOINT (wave 3k §B, issue #54). {@link planWarmCache} asks each node
 * "what have you served most?" on its own, so no node's answer can take into
 * account what another node already holds. Here the fleet's listeners are
 * granted one at a time to whichever repo the NEXT listener is worth most to
 * — see {@link warmUnitValues} for what "worth" has to mean when one listener
 * serves one job at a time.
 *
 * DYNAMIC, exactly like planWarmCache: every value is derived from the
 * fleet's served history, every tick. No repo is named anywhere;
 * `residentRepos` is a different mechanism.
 *
 * ONLY THE NODES GIVEN. Eligibility (drain, memory, guest role) is the
 * caller's; this never widens it.
 *
 * BOTH LOCKS STILL SIT BETWEEN THE TARGET AND ANY EVICTION. A busy listener or
 * one inside {@link WARM_ASSIGN_WINDOW_MS} keeps its repo whatever the ranking
 * says, and counts as a listener that repo already HAS: nobody else is moved
 * onto it unless a further one is worth it in its own right. A locked node
 * reports `locked` when the unlocked allocation would warm its repo nowhere,
 * `keep` otherwise.
 *
 * STABILITY: an incumbent is ranked at {@link WARM_INCUMBENT_RATIO} x its
 * marginal value — see there for the value and why.
 *
 * COULD NOT LOOK: `served: null` (history unreadable) and an empty window both
 * hold every slot as-is — `idle` everywhere, never an eviction.
 */
export function planWarmFleet(i: {
	nodes: readonly WarmFleetNode[];
	/** The fleet's served jobs, every node's. `null` = could not read them. */
	served: readonly WarmServedJob[] | null;
	nowMs: number;
	/** Defaults to {@link WARM_HISTORY_WINDOW_MS}. */
	windowMs?: number;
	/** Defaults to {@link WARM_HALF_LIFE_MS}. */
	halfLifeMs?: number;
	/** Defaults to {@link WARM_INCUMBENT_RATIO}. 1 is no damping. */
	incumbentRatio?: number;
}): Map<string, WarmCacheDecision> {
	const decisions = new Map<string, WarmCacheDecision>();
	const windowMs = i.windowMs ?? WARM_HISTORY_WINDOW_MS;
	const values = i.served
		? warmUnitValues(i.served, i.nowMs, i.nodes.length, {
				windowMs,
				halfLifeMs: i.halfLifeMs,
			})
		: new Map<string, number[]>();
	if (!i.served || values.size === 0) {
		for (const n of i.nodes) decisions.set(n.node, { action: 'idle' });
		return decisions;
	}
	const latestMs = new Map<string, number>();
	for (const j of i.served) {
		if (!Number.isFinite(j.startedAtMs) || i.nowMs - j.startedAtMs > windowMs) continue;
		if (j.startedAtMs > (latestMs.get(j.repo) ?? -Infinity)) latestMs.set(j.repo, j.startedAtMs);
	}
	const ratio = i.incumbentRatio ?? WARM_INCUMBENT_RATIO;
	const locked = new Set(
		i.nodes
			.filter(
				(n) =>
					n.current !== null &&
					warmSlotLocked({
						busy: n.current.busy,
						mintedOrRefreshedAtMs: n.current.mintedOrRefreshedAtMs,
						nowMs: i.nowMs,
					})
			)
			.map((n) => n.node)
	);
	const actual = assignWarmRepos(i.nodes, values, latestMs, locked, ratio);
	// What the fleet would warm with no lock in the way — only to tell a locked
	// node that is merely standing still (`keep`) from one the lock is holding
	// on a repo the allocation no longer wants anywhere (`locked`).
	const wanted = new Set(
		(locked.size ? assignWarmRepos(i.nodes, values, latestMs, new Set(), ratio) : actual).values()
	);

	for (const n of i.nodes) {
		const target = actual.get(n.node) ?? null;
		if (n.current && locked.has(n.node)) {
			decisions.set(n.node, wanted.has(n.current.repo) ? { action: 'keep' } : { action: 'locked' });
		} else if (target === null) {
			decisions.set(n.node, { action: 'idle' });
		} else if (!n.current) {
			decisions.set(n.node, { action: 'fill', repo: target });
		} else if (n.current.repo === target) {
			decisions.set(n.node, { action: 'keep' });
		} else {
			decisions.set(n.node, { action: 'rotate', from: n.current.repo, to: target });
		}
	}
	return decisions;
}

/**
 * GitHub's own bound on ONE JOB, in seconds: `timeout-minutes`, default 360.
 *
 * Nothing on this side needs to bound a job that is RUNNING — GitHub already
 * does, it is the party that knows when the job started, and it cancels the job
 * cleanly instead of shooting the listener out from under it.
 */
export const GITHUB_JOB_CEILING_SEC = 360 * 60;

/**
 * The floor for a JIT unit's `RuntimeMaxSec` — GitHub's ceiling plus a cleanup
 * margin.
 *
 * WHY THIS IS NOT 3600 ANY MORE (issue #22). Until 2026-09-14 every JIT unit
 * was minted with `RuntimeMaxSec=3600`, and the comment beside it said the TTL
 * "bounds an orphaned listener that lost the race to a warm runner". systemd
 * does not know the difference. It stops the unit at 3600 s whether that unit
 * is an idle orphan or a job at minute 59 of a build, and on 2026-09-10
 * brave-quartet's `check` (run 34543150470) died at **3,601 s** in
 * `Post Run Swatinem/rust-cache@v2` with every substantive step green —
 * `The runner has received a shutdown signal`. Every gate was green through it,
 * because no gate moves a byte for an hour.
 *
 * TWO BOUNDS, NOT ONE. The orphan and the job need different mechanisms:
 *
 *   - an ORPHAN is a listener that never accepted a job. It is bounded by the
 *     reap sweep (`reapJitRunners`), which sees no live unit for the
 *     registration and deletes it once the name's mint epoch is past the grace.
 *     That is a bound on the REGISTRATION, which is the thing that actually
 *     does harm — GitHub schedules onto it and the job hangs.
 *   - a JOB is bounded by {@link GITHUB_JOB_CEILING_SEC}. A cap below it is not
 *     a safety net, it is a second, dumber timeout that fires FIRST and
 *     attributes the death to whatever step happened to be running.
 *
 * So why keep a `RuntimeMaxSec` at all rather than drop it the way
 * {@link buildWarmSpawnPlan} does? Because a JIT unit, unlike a warm listener,
 * is supposed to serve exactly one job and exit; a unit still alive well past
 * GitHub's own ceiling is wedged by definition and nothing else on the node
 * would ever collect it. The margin above the ceiling exists so the backstop
 * can never be the thing that kills a job GitHub itself would have cancelled —
 * including its `Post *` steps, which is where #22's casualty died.
 *
 * The floor is applied inside {@link buildSpawnPlan} rather than trusted to the
 * call site, so the property holds for EVERY input rather than for the one path
 * anyone traced.
 */
export const JIT_UNIT_MAX_SEC = GITHUB_JOB_CEILING_SEC + 30 * 60;

/**
 * The cgroup slice every minted unit is placed into.
 *
 * WHY A MINTED UNIT NEEDS A SLICE AT ALL. The per-unit `MemoryMax` bounds ONE
 * runner; the slice bounds their SUM, and only the sum is what the 2026-08-04
 * outage was about — an uncontained job reached ~51 GB anon-RSS, the OOM killer
 * took `pm2-hadoku.service` with it, 23 services down, the host unreachable for
 * ~11 minutes. `runners.slice` and its aggregate ceiling exist because of that
 * hour.
 *
 * ALL-JIT SILENTLY GAVE THE CONTAINMENT BACK. `runners-slice-install.sh` places
 * STANDING units (`actions.runner.*`, `actions-runner-*`, `github-runner*`) into
 * the slice, and every claw is now ephemeral: nothing it places exists there any
 * more. A `systemd-run --user` unit with no `Slice=` lands in `app.slice`, which
 * is `MemoryMax=infinity`. Measured on claw-3 2026-09-14 20:20Z: three live
 * units (two `jit-*`, one `warm-*`), all `Slice=app.slice`, while
 * `runners.slice` was loaded at 14,543,749,120 bytes and contained nothing. The
 * fleet had a group ceiling on an empty group and no ceiling on the runners.
 *
 * APPLIED INSIDE THE BUILDERS, never trusted to a call site — the same rule
 * {@link JIT_UNIT_MAX_SEC} states for the same reason. Placement is the property
 * every mint must have, not the property the one traced path happens to pass.
 *
 * THE DEFAULT, NOT THE ONLY NAME. `machines[].slice.name` defaults to this and
 * exactly one machine overrides it: hokon, to `ci-runner.slice`, a hand-authored
 * slice whose CPU and IO weights are why it exists. Until 2026-10-19 no JIT
 * unit could land there, and this comment said the name would have to be
 * threaded the day one could. #120 made hokon an on-demand guest, so it is:
 * the node's declared name travels `dispatch-pass` → `MintRequest.sliceName` →
 * {@link buildSpawnPlan}. The WARM path still uses the default alone, because a
 * guest never holds a warm listener ({@link warmListenerSlots}).
 */
export const DEFAULT_RUNNER_SLICE = 'runners.slice';

/**
 * The slice a plan will place its unit in.
 *
 * NEVER THROWS, and never returns empty. Both builders run AFTER the
 * registration exists — `generate-jitconfig` for a JIT mint, `config.sh` for a
 * warm one — so a throw here would leave a black-hole runner GitHub schedules
 * onto with nothing listening (§12.8), which is strictly worse than a unit in
 * the default slice. A name systemd would reject (anything not ending `.slice`)
 * therefore falls back to the default rather than aborting: the failure
 * direction is "contained in the fleet's own slice", never "uncontained".
 */
export function resolveSliceName(name?: string | null): string {
	const trimmed = (name ?? '').trim();
	return /^[A-Za-z0-9_.\\:-]+\.slice$/.test(trimmed) ? trimmed : DEFAULT_RUNNER_SLICE;
}

/**
 * What a job is RESERVED at when nothing has measured it.
 *
 * Deliberately NOT the per-unit cap any more. The two were one number until
 * 2026-09-14 — `Math.min(jobP95Mb ?? unitMaxMb, unitMaxMb)` — and that was fine
 * only while the cap happened to sit in the middle of the measured band. The
 * cap is now the slice's own ceiling ({@link unitMemoryMaxMb}), and a node
 * reserving ~13.8 GB for an unmeasured job would admit exactly one mint and
 * queue everything else: the 2026-09-01 shape, where 13 jobs sat queued while
 * dispatch logged "no node can take this job right now".
 *
 * 4096 is the same number, from the same harvest, for the same reason it was
 * ever chosen: 674 job windows, p95 2,663 MB, max 2,954 MB, so a 4 GB
 * reservation is ~1.4x the worst job ever observed and clears every one of them.
 * It is an ESTIMATE of appetite, which is all a reservation ever was.
 */
export const JOB_RESERVE_DEFAULT_MB = 4096;

/**
 * The per-unit `MemoryMax` for a minted runner: the slice's own ceiling, never
 * a number below it.
 *
 * THE FLAT 4096 KILLED REAL WORK (issue #26). brave-quartet's `wasm-size` job of
 * run 34543150470 was OOM-killed on claw-2 — `oom-kill:constraint=CONSTRAINT_MEMCG`
 * against the unit's own 4 GiB, eight parallel `rustc` processes resident, the
 * largest ~830 MB RSS. GitHub recorded the step as CANCELLED rather than failed,
 * which is the shape you get when the runner is killed out from under the job,
 * so nothing in CI said "out of memory" either. A parallel cargo build and a
 * flat 4 GiB per unit are simply incompatible, and every candidate the original
 * harvest considered (3072 and up) was chosen against a sample that contained no
 * such build.
 *
 * THE OPERATOR'S RULE, 2026-09-12: no hard per-job memory cap; a floor keeps the
 * claw alive. The floor is `minFreeMb`, and it is already expressed — the slice
 * ceiling IS `measured MemTotal − minFreeMb`. So a unit permitted to reach the
 * slice ceiling can consume everything CI is allowed to have and not one byte of
 * what the box needs to stay reachable.
 *
 * WHY A NUMBER AND NOT `infinity`. Two things are lost by dropping the property:
 * the kill stops being ATTRIBUTABLE to a named unit (§12.2 — the difference
 * between a cgroup kill naming `jit-claw-2-…` and an unexplained exit 137), and
 * `MemorySwapMax=0` is the only remaining bound on a runaway, which on claw-1's
 * 7200rpm disk means thrashing instead of failing fast. A cap equal to the
 * ceiling keeps both and can never be the thing that kills a job the slice would
 * have allowed — which is the whole complaint #26 made.
 *
 * SAFE ONLY BECAUSE THE UNIT IS IN THE SLICE. The slice bounds the SUM; this
 * bounds ONE. Raising the per-unit cap without containment would have been the
 * 2026-08-04 outage with extra steps — which is why `--property=Slice=` shipped
 * first, in its own commit, and was verified live before this landed.
 *
 * THIS IS THE CEILING {@link AdmissionInput.sliceCeilingMb} CARRIES INTO
 * `admitMint` (#76). The two read the same measurement for two different
 * questions: this function grants a RUNNING unit room up to the whole slice
 * because there is no hard per-job cap; `admitMint`'s placement clause asks
 * whether a job's own KNOWN FLOOR (from capped runs) fits inside that same
 * ceiling before the unit is ever spawned. A node that would happily let the
 * unit grow this far is still the wrong node to START a job on whose floor
 * already exceeds it.
 *
 * TOTAL over its inputs, like {@link JIT_UNIT_MAX_SEC}'s floor. A ceiling that
 * is not a usable positive number falls back to the requested cap: the caller
 * is `dispatchEphemeral`, which refuses to mint on a node whose memory it could
 * not read, so the fallback is unreachable from production — but a builder that
 * throws or emits `MemoryMax=0M` on a bad input would turn one unreadable node
 * into a dead mint, and this runs after the registration exists.
 */
export function unitMemoryMaxMb(o: {
	/** The node's declared `slice.unitMaxMb`. It may only WIDEN the cap. */
	requestedMb?: number | null;
	/** Measured `MemTotal − minFreeMb` for the node the unit will run on. */
	sliceCeilingMb?: number | null;
}): number {
	const requested =
		typeof o.requestedMb === 'number' && o.requestedMb > 0
			? Math.floor(o.requestedMb)
			: JOB_RESERVE_DEFAULT_MB;
	const ceiling =
		typeof o.sliceCeilingMb === 'number' && Number.isFinite(o.sliceCeilingMb)
			? Math.floor(o.sliceCeilingMb)
			: 0;
	return ceiling > 0 ? Math.max(requested, ceiling) : requested;
}

/**
 * The per-unit `MemoryMax` for a runner minted on an ON-DEMAND GUEST (#120).
 *
 * NOT {@link unitMemoryMaxMb}, because the operator's rule there is for the
 * CLAWS and is the opposite of the one the production host carries. A claw has
 * no hard per-job cap: a unit may grow to the whole slice, because the slice
 * IS everything CI may have. On the guest the manifest says otherwise, in its
 * own `$why`s: `slice.maxMb` is a deliberate allowance far below
 * MemTotal − minFreeMb (CI must not grow into the space production needs), and
 * `slice.unitMaxMb` sits BELOW that so one runaway is one dead unit rather than
 * a slice-wide kill of its siblings. Widening to the ceiling, as the claw rule
 * does, would hand one job the whole guest allowance.
 *
 * So the declared cap is the cap, clamped to the slice it has to fit inside.
 * Total like its sibling: an absent cap is {@link JOB_RESERVE_DEFAULT_MB}, never
 * zero, because this runs after the registration exists.
 */
export function guestUnitMemoryMaxMb(o: {
	/** The guest's declared `slice.unitMaxMb`. */
	requestedMb?: number | null;
	/** The guest's declared `slice.maxMb` — the guest allowance. */
	sliceMaxMb?: number | null;
}): number {
	const positive = (v: number | null | undefined): number | null =>
		typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
	const requested = positive(o.requestedMb) ?? JOB_RESERVE_DEFAULT_MB;
	const slice = positive(o.sliceMaxMb);
	return slice === null ? requested : Math.min(requested, slice);
}

const UNIT_LABELS_PREFIX = 'jit labels=';
/** A label the description can carry and `list-units`' whitespace split gives back intact. */
const SAFE_LABEL = /^[A-Za-z0-9._-]+$/;

/**
 * A JIT unit's description: the labels its registration was minted with.
 *
 * The unit name is the only record of a mint that survives an mgmt-api restart
 * (B9), and it carries the job, not the labels. On 2026-10-23 a hokon mint for
 * a `hadoku-builder` job registered without `hadoku-builder`; the unit held the
 * job "in flight" and no claw could take it. The labels belong beside the name,
 * on the node, where `list-units` already prints them for free.
 *
 * `null` when any label would not survive the round trip — the reader then sees
 * no stamp, which is "unknown", never "mismatched".
 */
export function jitUnitDescription(labels: readonly string[]): string | null {
	if (!labels.length || !labels.every((l) => SAFE_LABEL.test(l))) return null;
	return `${UNIT_LABELS_PREFIX}${labels.join(',')}`;
}

/**
 * The labels {@link jitUnitDescription} stamped, read back from `list-units`'
 * DESCRIPTION column. `null` for a unit minted before the stamp existed (its
 * description is systemd-run's own `[systemd-run] /bin/sh -c …`) or anything
 * else unrecognised.
 */
export function labelsFromUnitDescription(description: string): string[] | null {
	const d = description.trim();
	if (!d.startsWith(UNIT_LABELS_PREFIX)) return null;
	const labels = d.slice(UNIT_LABELS_PREFIX.length).split(',');
	return labels.length && labels.every((l) => SAFE_LABEL.test(l)) ? labels : null;
}

export interface SpawnPlan {
	/** Where the config must be written, mode 0600, before the unit starts. */
	configPath?: string;
	/** The config itself — never an argv token. */
	configContent?: string;
	unit: string;
	argv: string[];
}

/**
 * The `systemd-run` invocation for one mint.
 *
 * A transient USER unit rather than a child process, because mgmt-api restarts
 * ~5x/day and the job that restarts it runs on hokon — the pilot. A child would
 * die with its parent mid-job; a transient unit survives, keeps its pid, and
 * stays discoverable by glob for the post-restart sweep (§12.2, verified).
 *
 * `RuntimeMaxSec` is a BACKSTOP against a wedged unit, floored at
 * {@link JIT_UNIT_MAX_SEC} — see that constant for why it cannot be an orphan
 * timeout. `MemoryMax`/`MemorySwapMax` put the per-job cap in the unit's own
 * cgroup — which is what makes a kill ATTRIBUTABLE to a named unit instead of an
 * unexplained exit 137 (§12.2). `Slice=` is the OTHER half of that and the one
 * all-JIT lost: the per-unit cap bounds one runner, the slice bounds their sum
 * ({@link DEFAULT_RUNNER_SLICE}).
 */
export function buildSpawnPlan(o: {
	unit: string;
	slot: string;
	jitConfig: string;
	memoryMaxMb: number;
	/**
	 * The node's `machines[].slice.name`. Absent — or anything systemd would
	 * refuse — resolves to {@link DEFAULT_RUNNER_SLICE}; see
	 * {@link resolveSliceName} for why this cannot throw.
	 */
	sliceName?: string | null;
	/**
	 * A REQUEST, and it can only ever WIDEN the backstop — see
	 * {@link JIT_UNIT_MAX_SEC}. Anything below GitHub's own job ceiling is
	 * floored, because a caller passing an orphan-sized number here is precisely
	 * what issue #22 was.
	 */
	ttlSeconds: number;
	/**
	 * The labels the registration was minted with, stamped into the unit's
	 * description so the dispatcher can read them back off `list-units` — see
	 * {@link jitUnitDescription}. Absent leaves systemd-run's default.
	 */
	labels?: readonly string[];
}): SpawnPlan {
	// THE JITCONFIG DOES NOT GO IN THE COMMAND LINE.
	//
	// It contains `.credentials` — a real OAuth token for the runner. As an argv
	// token it lands in two places: `/proc/<pid>/cmdline`, readable by any local
	// user unless /proc is mounted with hidepid; and the systemd journal, which records the full ExecStart at unit
	// start and KEEPS IT. The second is the one that matters — the process dies
	// with the job, the journal entry does not.
	//
	// `--jitconfig` is the only interface actions/runner exposes (it is not even
	// in `--help` on 2.336.0), so the flag itself is unavoidable. What is
	// avoidable is systemd ever seeing the value: the config is written to the
	// slot at mode 0600 and the unit reads it back at exec time. systemd logs a
	// command line with a file path in it, and the secret never enters the
	// journal.
	const cfgPath = `${o.slot}/.jitconfig`;
	// THE FLOOR, not the request. `Math.max` rather than a throw: this is called
	// AFTER `generate-jitconfig` has already created the registration, so
	// throwing here would leak a black-hole runner GitHub schedules onto. Widening
	// a backstop is always safe; narrowing it below GitHub's ceiling is #22.
	const runtimeMaxSec = Math.max(o.ttlSeconds, JIT_UNIT_MAX_SEC);
	const description = o.labels ? jitUnitDescription(o.labels) : null;
	return {
		unit: o.unit,
		configPath: cfgPath,
		configContent: o.jitConfig,
		argv: [
			'systemd-run',
			'--user',
			`--unit=${o.unit}`,
			...(description ? [`--description=${description}`] : []),
			'--collect',
			`--property=RuntimeMaxSec=${runtimeMaxSec}`,
			// THE GROUP CEILING. Without it systemd puts a `--user` transient unit in
			// `app.slice`, which is MemoryMax=infinity — see DEFAULT_RUNNER_SLICE.
			`--property=Slice=${resolveSliceName(o.sliceName)}`,
			`--property=MemoryMax=${o.memoryMaxMb}M`,
			// Swap is `infinity` on every runner unit today. A job allowed to swap
			// freely thrashes claw-1's 7200rpm disk rather than failing fast.
			'--property=MemorySwapMax=0',
			'/bin/sh',
			'-c',
			// `exec` so the listener replaces the shell and systemd supervises the
			// runner itself rather than a wrapper it would have to signal through.
			// Read it, DELETE it, then exec. The file exists for milliseconds rather
			// than for the life of the job: the credential is single-use and the
			// runner is ephemeral, but a token sitting in a file after the job that
			// used it is finished is a credential nobody is watching. Observed
			// after the first successful canary — the slot still held its
			// .jitconfig once the runner had unregistered itself.
			//
			// `rm` before `exec` is deliberate: exec replaces this shell, so
			// anything after it never runs. If the exec fails the mint has failed
			// anyway, and the next mint's RESET=1 rebuilds the slot from scratch.
			`C=$(cat ${cfgPath}); rm -f ${cfgPath}; exec ${o.slot}/bin/Runner.Listener run --jitconfig "$C"`,
		],
	};
}

/**
 * The `systemd-run` invocation for a warm listener.
 *
 * Deliberately NOT {@link buildSpawnPlan} with different arguments — the two
 * units differ in a way that is not cosmetic:
 *
 *   - no `RuntimeMaxSec` at all. A JIT unit carries one only as a backstop
 *     against a wedged unit, ABOVE GitHub's own job ceiling
 *     ({@link JIT_UNIT_MAX_SEC}); a warm listener is SUPPOSED to sit idle
 *     waiting for a job, so it has no such ceiling to sit above and any cap
 *     here would manufacture the exact cold miss the cache exists to avoid.
 *   - no jitconfig, so no `configPath`/`configContent` and no secret-in-argv
 *     problem to solve. `config.sh` (run by `warm-provision.sh` before this
 *     plan is built) already wrote `.credentials`/`.runner` into the slot;
 *     `Runner.Listener run` reads them from its own binary's real path, same
 *     as a JIT slot does (see jit-provision.sh's payload note), so nothing
 *     sensitive is ever an argv token here.
 *
 * What the two do NOT differ in is containment. A warm listener is standing, so
 * it sits in the slice for LONGER than a JIT unit does, and it serves jobs with
 * the same appetite — {@link DEFAULT_RUNNER_SLICE} applies identically, and the
 * claw-3 reading that found `Slice=app.slice` found it on the warm unit too.
 */
export function buildWarmSpawnPlan(o: {
	unit: string;
	slot: string;
	memoryMaxMb: number;
	/** As {@link buildSpawnPlan}'s — defaulted, never trusted to the caller. */
	sliceName?: string | null;
}): SpawnPlan {
	return {
		unit: o.unit,
		argv: [
			'systemd-run',
			'--user',
			`--unit=${o.unit}`,
			'--collect',
			`--property=Slice=${resolveSliceName(o.sliceName)}`,
			`--property=MemoryMax=${o.memoryMaxMb}M`,
			'--property=MemorySwapMax=0',
			`${o.slot}/bin/Runner.Listener`,
			'run',
		],
	};
}
