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

import { CI_OOM_SCORE_ADJ } from './hosting-record.js';

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
 * threaded the day one could. #120 made hokon an on-demand backstop, so it is:
 * the node's declared name travels `dispatch-pass` → `MintRequest.sliceName` →
 * {@link buildSpawnPlan}. The WARM path still uses the default alone, because a
 * backstop never holds a warm listener ({@link warmListenerSlots}).
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
 * The containment every CI unit carries: a JIT runner, a warm listener, and
 * the `--ci-shaped` test unit `fleet hosting` starts. ONE list, so a test unit
 * is contained exactly the way a real job is, and the two cannot drift.
 */
export function ciUnitProperties(o: { memoryMaxMb: number; sliceName?: string | null }): string[] {
	return [
		// THE GROUP CEILING. Without it systemd puts a `--user` transient unit in
		// `app.slice`, which is MemoryMax=infinity — see DEFAULT_RUNNER_SLICE.
		`--property=Slice=${resolveSliceName(o.sliceName)}`,
		`--property=MemoryMax=${o.memoryMaxMb}M`,
		// Swap is `infinity` on every runner unit today. A job allowed to swap
		// freely thrashes claw-1's 7200rpm disk rather than failing fast.
		'--property=MemorySwapMax=0',
		// CI is the first thing a global OOM takes, before pm2, sshd or a
		// hosting tenant (src/runners/hosting-record.ts).
		`--property=OOMScoreAdjust=${CI_OOM_SCORE_ADJ}`,
	];
}

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
