/**
 * ci-unit-properties — the systemd containment every CI unit carries, and
 * the slice name it resolves to. Split out of `ephemeral-slice.ts` (wave
 * layers-3 lane S, cut (iii) layer debt).
 *
 * TWO DOMAINS NEED THE IDENTICAL ANSWER. `deploy-runners-slice.mjs`
 * (lifecycle) sizes a STANDING runner's unit to the same ceiling the JIT
 * minter uses, and `scripts/lib/hosting.mjs` (tenancy) contains its
 * `--ci-shaped` test unit exactly the way a real CI job is contained
 * (`ciUnitProperties`) — both reached into `ephemeral.ts`
 * (`ci-scheduling`) for it, which is the domain-crosses-domain edge cut
 * (iii) forbids. `ciUnitProperties` and `resolveSliceName` are pure
 * (`CI_OOM_SCORE_ADJ` is the one import, a flat `state` constant — see
 * `hosting-record.ts` — never `ci-scheduling` itself), so they move to their
 * own module below `ci-scheduling`, which both a tenancy and a lifecycle
 * file may legally import. `ephemeral.ts`/`ephemeral-slice.ts` re-export
 * every name here under its original path, so every existing `ci-scheduling`
 * importer (`ephemeral-mint.ts` and the rest) keeps compiling and behaving
 * byte-identically.
 */

import { CI_OOM_SCORE_ADJ } from './hosting-record.js';

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
