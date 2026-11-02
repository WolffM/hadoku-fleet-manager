/**
 * What a job is reserved at — the default, the per-repo/per-node answer
 * shape, and the pure pick between them — moved out of
 * `src/runners/ephemeral-slice.ts` and `ephemeral-shared.ts` (wave clean-1
 * lane C/D, cut (iii)). `jobReserve` is pure and `scripts/check-warm-canary.mjs`
 * (observation) needs the same answer `admitMint` (ci-scheduling) does, so
 * config is the one layer both can legally reach. Both files re-export every
 * name here under its original path.
 *
 * `unitMemoryMaxMb` moved here too (wave clean-2 lane C, cut (iii)): it is
 * pure over `JOB_RESERVE_DEFAULT_MB` alone, and `check-warm-canary.mjs` needs
 * the identical per-unit cap the dispatcher's own sizing computes — the same
 * reason `jobReserve` is here rather than in `ephemeral-slice.ts`.
 */

/**
 * What a job is RESERVED at when nothing has measured it.
 *
 * Deliberately NOT the per-unit cap any more. The two were one number until
 * 2026-09-14 — `Math.min(jobP95Mb ?? unitMaxMb, unitMaxMb)` — and that was fine
 * only while the cap happened to sit in the middle of the measured band. The
 * cap is now the slice's own ceiling (`unitMemoryMaxMb`), and a node
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

/** A repo's derived reserve, as `reconcile --write-coverage` writes it. */
export interface RepoReserve {
	mb: number;
	/** `measured`: this repo's own p95. `fleet-p95`: under the min runs. */
	basis: 'measured' | 'fleet-p95';
	runs: number;
	/**
	 * Was `mb` itself raised to (or backed by) a run that hit a cap — OOM-killed,
	 * or pinned at a node's own ceiling? See `demand-derive.mjs`'s
	 * `deriveJobReserves`, which sets this. Additive; absent means false, the
	 * shape every repo carried before #76. A `true` here means `mb` is a FLOOR,
	 * not a measurement admission can trust as exact — {@link jobReserve} and
	 * `admitMint`'s placement clause both read it.
	 */
	lowerBound?: boolean;
}

/** Which answer admission used. The log line carries it as `from=`. */
export type ReserveSource = 'repo' | 'node' | 'default';

/**
 * What admission RESERVES for one queued job on one node — Wave 3g J2.
 *
 * THREE ANSWERS, IN ORDER, and the caller is told which one it got:
 *
 *   1. `repo`    the queued run's repo, from `fleet-runner-coverage.json`'s
 *                `facets[repo].jobP95Mb`. DERIVED from job-metrics, never
 *                declared. The memory axis is the repo (Wave 3d J: 35 %
 *                cross-node spread against 423 % across repos on one node),
 *                so this is the answer the other two only approximate. A
 *                `fleet-p95` basis is still this answer: the repo is covered
 *                and measured as a fleet, it just has too few runs of its own.
 *   2. `node`    the node's hand-set `jobP95Mb` — what every job reserved
 *                before this existed. Reached for a repo the roster has no
 *                figure for (not covered yet, or the file unreadable).
 *   3. `default` {@link JOB_RESERVE_DEFAULT_MB}.
 *
 * CLAMPED TO THE CAP, whichever answered — UNLESS the answer is a LOWER BOUND
 * (#76). `min()` lets an ordinary estimate and the cap disagree only in the
 * safe direction: a reserve above `MemoryMax` promises room the unit is not
 * permitted to use, so trimming it to the cap costs nothing the job could ever
 * have spent. A FLOOR built from capped runs is the opposite case — clamping
 * it down to a cap smaller than the floor would erase the one fact that makes
 * the floor meaningful (that THIS node's ceiling cannot be shown to clear it)
 * before `admitMint` ever sees it, which is the bug this whole mechanism exists
 * to catch. So a lower-bound repo reserve is passed through UNCLAMPED, and
 * `admitMint`'s own placement clause is where it is compared against the cap.
 * The clamp does not change `from` either way.
 */
export function jobReserve(i: {
	repoReserve?: RepoReserve | null;
	nodeJobP95Mb?: number;
	capMb: number;
}): { mb: number; from: ReserveSource; lowerBound: boolean } {
	const usable = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
	const pick: { mb: number; from: ReserveSource; lowerBound: boolean } = usable(i.repoReserve?.mb)
		? { mb: i.repoReserve.mb, from: 'repo', lowerBound: i.repoReserve?.lowerBound === true }
		: usable(i.nodeJobP95Mb)
			? { mb: i.nodeJobP95Mb, from: 'node', lowerBound: false }
			: { mb: JOB_RESERVE_DEFAULT_MB, from: 'default', lowerBound: false };
	return {
		mb: pick.lowerBound ? pick.mb : Math.min(pick.mb, i.capMb),
		from: pick.from,
		lowerBound: pick.lowerBound,
	};
}

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
 * THIS IS THE CEILING `AdmissionInput.sliceCeilingMb` CARRIES INTO
 * `admitMint` (#76). The two read the same measurement for two different
 * questions: this function grants a RUNNING unit room up to the whole slice
 * because there is no hard per-job cap; `admitMint`'s placement clause asks
 * whether a job's own KNOWN FLOOR (from capped runs) fits inside that same
 * ceiling before the unit is ever spawned. A node that would happily let the
 * unit grow this far is still the wrong node to START a job on whose floor
 * already exceeds it.
 *
 * TOTAL over its inputs, like `JIT_UNIT_MAX_SEC`'s floor. A ceiling that
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
