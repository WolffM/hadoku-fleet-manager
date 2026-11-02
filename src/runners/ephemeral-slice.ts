/**
 * Ephemeral unit sizing and cgroup containment — wave 5r lane D split of
 * `ephemeral.ts` (pure move), so that file falls under the 800-line source
 * ceiling.
 *
 * The slice every minted unit (JIT or warm) is placed into, and the
 * per-unit `MemoryMax` it is given — see `ephemeral.ts` for the naming,
 * mint-budget, admission and warm-cache placement this sizing sits beside.
 * Every name here is re-exported from `ephemeral.ts` so its existing
 * importers compile unchanged.
 */

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
 * The cgroup slice every minted unit is placed into, the name resolver, and
 * `ciUnitProperties` (below) all moved to `ci-unit-properties.ts` (wave
 * layers-3 lane S, cut (iii) layer debt): `deploy-runners-slice.mjs`
 * (lifecycle) and `scripts/lib/hosting.mjs` (tenancy) both need the identical
 * pure answer this file's `ci-scheduling` classification could not legally
 * give either of them. Re-exported here under their original path so every
 * existing `ci-scheduling` importer keeps compiling and behaving
 * byte-identically.
 */
export { DEFAULT_RUNNER_SLICE, resolveSliceName, ciUnitProperties } from './ci-unit-properties.js';

/**
 * What a job is RESERVED at when nothing has measured it. Moved to
 * `src/lib/job-reserve.ts` (wave clean-1 lane C/D, cut (iii)): `jobReserve`
 * is pure and `scripts/check-warm-canary.mjs` (observation) needs the same
 * answer. Re-exported here under its original path.
 */
import { JOB_RESERVE_DEFAULT_MB } from '../lib/job-reserve.js';
export { JOB_RESERVE_DEFAULT_MB };

/**
 * The per-unit `MemoryMax` for a minted runner. Moved to `src/lib/job-reserve.ts`
 * (wave clean-2 lane C, cut (iii) layer debt): pure over `JOB_RESERVE_DEFAULT_MB`
 * alone, and `scripts/check-warm-canary.mjs` (observation) needs the identical
 * answer the dispatcher's own sizing (ci-scheduling) does — the same "one
 * declaration, config layer" shape as `JOB_RESERVE_DEFAULT_MB` right above.
 * Re-exported here under its original path.
 */
export { unitMemoryMaxMb } from '../lib/job-reserve.js';

/**
 * The per-unit `MemoryMax` for a runner minted on an ON-DEMAND BACKSTOP (#120).
 *
 * NOT {@link unitMemoryMaxMb}, because the operator's rule there is for the
 * CLAWS and is the opposite of the one the production host carries. A claw has
 * no hard per-job cap: a unit may grow to the whole slice, because the slice
 * IS everything CI may have. On the backstop the manifest says otherwise, in its
 * own `$why`s: `slice.maxMb` is a deliberate allowance far below
 * MemTotal − minFreeMb (CI must not grow into the space production needs), and
 * `slice.unitMaxMb` sits BELOW that so one runaway is one dead unit rather than
 * a slice-wide kill of its siblings. Widening to the ceiling, as the claw rule
 * does, would hand one job the whole backstop allowance.
 *
 * So the declared cap is the cap, clamped to the slice it has to fit inside.
 * Total like its sibling: an absent cap is {@link JOB_RESERVE_DEFAULT_MB}, never
 * zero, because this runs after the registration exists.
 */
export function backstopUnitMemoryMaxMb(o: {
	/** The backstop's declared `slice.unitMaxMb`. */
	requestedMb?: number | null;
	/** The backstop's declared `slice.maxMb` — the backstop allowance. */
	sliceMaxMb?: number | null;
}): number {
	const positive = (v: number | null | undefined): number | null =>
		typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
	const requested = positive(o.requestedMb) ?? JOB_RESERVE_DEFAULT_MB;
	const slice = positive(o.sliceMaxMb);
	return slice === null ? requested : Math.min(requested, slice);
}
