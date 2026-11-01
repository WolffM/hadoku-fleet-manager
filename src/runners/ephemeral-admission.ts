/**
 * Ephemeral mint admission — wave 5r lane D split of `ephemeral.ts` (pure
 * move), so that file falls under the 800-line source ceiling.
 *
 * May this node take one more job right now, and is a jitconfig safe to run
 * from a hardlinked slot — see `ephemeral.ts` for the naming, mint-budget
 * and warm-cache placement this admission decision sits beside. Every name
 * here is re-exported from `ephemeral.ts` so its existing importers compile
 * unchanged.
 */
import { TMP_FREE_FLOOR_MB } from '../lib/jit-naming.js';
export { TMP_FREE_FLOOR_MB } from '../lib/jit-naming.js';

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
