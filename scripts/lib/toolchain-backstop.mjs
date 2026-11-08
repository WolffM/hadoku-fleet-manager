/**
 * toolchain-backstop — the BACKSTOP-ONLY advisory readiness block, split out
 * of toolchain-doctor.mjs for size (wave gates2 lane F1a, 800-line ceiling).
 *
 * Everything here is ADVISORY (`buildBackstop`'s own `advisory: true`): it
 * answers "could the backstop actually take load right now", never "is the
 * backstop converged" (that is judged by the SAME REPAIRS rules as any claw,
 * in toolchain-doctor.mjs). Nothing here ever feeds `drift`.
 */
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Single-quote a string for the shell. */
const shq = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

/**
 * WHICH harvester file is judged is read from the RUNNING service, never a
 * constant (#114). This was `~/.local/bin/runner-mem-harvest.py`, the 2026-08
 * hand-install; the throttle payload moved every node to
 * `~/.hadoku/runner-mem-harvest.py` (hokon on 2026-10-11) and removed the old
 * copy, so the doctor hashed a file that no longer existed and reported drift
 * on a harvester that was running fine. The unit's `ExecStart` would be the
 * deployer's own record; the process's argv is what the kernel is executing.
 */
const HARVESTER_UNIT = 'runner-mem-harvest.service';
// `scripts/lib/` -> `scripts/`. This moved out of `check-fleet-toolchain.mjs`
// (`scripts/`), and the sibling `runner-mem-harvest.py` stayed where it was —
// the path is relative to THIS file now, so it still has to climb one level.
export const HARVESTER_PKG_PATH = new URL('../runner-mem-harvest.py', import.meta.url);
/**
 * The ABSOLUTE local path to this package's own `runner-mem-harvest.py`,
 * resolved from wherever THIS module was loaded from. When this doctor runs
 * in-process inside mgmt-api on hokon (the backstop it is reporting on), that is
 * already the production path — no assumption about mgmt-api's install
 * layout is baked in here; `import.meta.url` IS that layout. See
 * "verify in the consumer's environment".
 */
const HARVESTER_PKG_LOCAL_PATH = fileURLToPath(HARVESTER_PKG_PATH);

/**
 * `_work` ADVISORY THRESHOLDS (#79 hygiene, re-scaled #126).
 *
 * The finding that motivated this is ~3.2 GB across the `_work` dirs under
 * `~/actions-runner-*` on a root disk at 75% on hokon. Neither number alone
 * is a problem: a few hundred MB of fresh job artifacts is normal churn on
 * any runner, and 3.2 GB is irrelevant on a disk with room to spare. It is a
 * finding only against the disk pressure that makes it one, so both must
 * hold before this advisory fires.
 *
 * THE PRESSURE IS FREE SPACE, NOT A PERCENTAGE (#126). The first version
 * gated on `/` being 70%+ used, and on hokon's 1.8 TB volume that is 387 GB
 * free: the advisory fired, the operator cleared 1.2 GB, and the disk moved
 * 0%. An advisory whose fix cannot change the condition it reports is noise.
 * So `_work` must be at least WORK_ADVISORY_FREE_SHARE of what is free —
 * clearing it would grow free space by a tenth or more — which fires on a
 * small disk running out and never on a large one with room to spare.
 */
export const WORK_ADVISORY_MIN_MB = 1024;
export const WORK_ADVISORY_FREE_SHARE = 0.1;

/**
 * WHICH `*.service.d` NAMES ARE THIS FLEET'S TO ADVISE ON (#79, manager
 * correction 2026-10-03, re-corrected 2026-10-03: no node name baked in).
 *
 * The drop-in scan is generic (any `*.service.d` with no matching unit), but
 * the backstop is not a box this package owns outright — it also carries the
 * operator's own desktop session (an `app-…@.service.d` template unit, say).
 * Those `@`-template units commonly have no persistent unit FILE at all (the
 * session instantiates them), so "no unit" there is normal, not drift, and
 * recommending `rm -r` on someone's desktop config is not this doctor's
 * business. `actions-runner-` is the live runner naming everywhere (every
 * `actions-runner-*.service.d` on the backstop has a matching unit); it
 * may ALSO carry a legacy PER-NODE naming from before that scheme —
 * `<node>-runner-b/c/d`, verified on hokon: `hokon-runner-b.service.d` exists
 * with `systemctl --user list-unit-files 'hokon-runner*'` finding nothing.
 *
 * The node name is NOT hardcoded here — `lib/ecosystem-literals.test.mjs`
 * gates exactly that (a hostname baked into a published library), and
 * correctly failed when it first was: `hokon-runner-` as a literal moved
 * `hokon`'s count from 39 to 40. It is derived from the node `buildBackstop`
 * is actually being called FOR, which is already known at every call site.
 */
export function fleetDropinPattern(nodeName) {
	const node = typeof nodeName === 'string' ? nodeName : '';
	const escaped = node.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`^(actions-runner-${escaped ? `|${escaped}-runner-` : ''})`);
}

/**
 * ADVISORY-ONLY readiness facts for the BACKSTOP — never requested for a claw.
 *
 * Every line here READS the kernel or the filesystem; nothing here installs,
 * starts, stops or writes anything, so it carries none of `check-capabilities`'
 * (now deleted; see docs/planning/wave-gates2-2026-11-08.md) mutation risk. It
 * answers "could the backstop actually take load", not "is the backstop
 * converged" — its toolchain is judged by the same rules as a claw's, above.
 *
 *   bk-avail-kb      /proc/meminfo MemAvailable — what ci-throttle's floor
 *                    (the node's declared `minFreeMb`) is actually compared
 *                    against.
 *   bk-tophold       the single largest resident process, by RSS — whatever is
 *                    actually holding memory today, not a name hardcoded here.
 *   bk-unitmax       one line per `actions-runner-*` / `actions.runner.*` unit:
 *                    the KERNEL's own `memory.max` for that unit's cgroup, read
 *                    the same way `deploy-runners-slice.mjs` reads it for a claw
 *                    — "the reader for a facet may not read what the writer
 *                    wrote" applies here too: the manifest's declared
 *                    `slice.unitMaxMb` is not asked.
 *   bk-harvest-path  the script the RUNNING harvester executes, from its main
 *                    PID's argv; empty when the service is not running.
 *   bk-harvest-bytes the byte count of that file, or `-1` if absent.
 *                    Compared locally against this package's own copy.
 *   bk-harvest-sha   sha256 of that same file, or empty if absent/unreadable.
 *                    A byte count can coincide (#79) — this is the content
 *                    comparison the drift verdict actually uses.
 *   bk-dropin        one line per `*.service.d` drop-in directory under
 *                    `~/.config/systemd/user/`, with `present`/`orphan`
 *                    depending on whether `systemctl --user list-unit-files`
 *                    knows the unit it is a drop-in FOR. Read-only: no
 *                    `status`, just a listing.
 *   bk-work-kb       total `du -sk` across every `_work` dir under
 *                    `~/actions-runner-*`, summed here rather than left as
 *                    several numbers a consumer would have to add up itself.
 *   bk-root-free-kb  `df`'s available KB on `/`, the free space the `_work`
 *                    total above is judged against.
 */
export function backstopProbeScript() {
	return `
printf 'bk-avail-kb\\t%s\\n' "$(awk '/MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null)"
printf 'bk-tophold\\t%s\\n' "$(ps -eo rss,comm --no-headers 2>/dev/null | sort -rn | head -n1 | awk '{rss=$1; $1=""; sub(/^ /,""); printf "%d\\t%s", int(rss/1024), $0}')"
for u in $(systemctl --user list-units 'actions-runner-*' --all --no-legend --plain 2>/dev/null | awk '{print $1}'); do
  cg=$(systemctl --user show "$u" -p ControlGroup --value 2>/dev/null)
  mx=$(cat "/sys/fs/cgroup\${cg}/memory.max" 2>/dev/null)
  printf 'bk-unitmax\\t%s\\t%s\\n' "$u" "$mx"
done
for u in $(systemctl list-units 'actions.runner.*' --all --no-legend --plain 2>/dev/null | awk '{print $1}'); do
  cg=$(systemctl show "$u" -p ControlGroup --value 2>/dev/null)
  mx=$(cat "/sys/fs/cgroup\${cg}/memory.max" 2>/dev/null)
  printf 'bk-unitmax\\t%s\\t%s\\n' "$u" "$mx"
done
hpid=$(systemctl --user show ${HARVESTER_UNIT} -p MainPID --value 2>/dev/null)
hpath=''
[ -n "$hpid" ] && [ "$hpid" != 0 ] && hpath=$(tr '\\0' '\\n' < "/proc/$hpid/cmdline" 2>/dev/null | grep -m1 'runner-mem-harvest\\.py$')
printf 'bk-harvest-path\\t%s\\n' "$hpath"
printf 'bk-harvest-bytes\\t%s\\n' "$([ -n "$hpath" ] && wc -c < "$hpath" 2>/dev/null || echo -1)"
printf 'bk-harvest-sha\\t%s\\n' "$([ -n "$hpath" ] && sha256sum "$hpath" 2>/dev/null | awk '{print $1}')"
for d in "$HOME"/.config/systemd/user/*.service.d; do
  [ -d "$d" ] || continue
  u=$(basename "$d"); u=\${u%.d}
  listed=$(systemctl --user list-unit-files "$u" --no-legend --plain 2>/dev/null)
  printf 'bk-dropin\\t%s\\t%s\\n' "$d" "$([ -n "$listed" ] && echo present || echo orphan)"
done
work_kb=0
for d in "$HOME"/runners/actions-runner-*/_work "$HOME"/actions-runner-*/_work; do
  [ -d "$d" ] || continue
  k=$(du -sk "$d" 2>/dev/null | awk '{print $1}')
  work_kb=$((work_kb + \${k:-0}))
done
printf 'bk-work-kb\\t%s\\n' "$work_kb"
printf 'bk-root-free-kb\\t%s\\n' "$(df -Pk / 2>/dev/null | awk 'NR==2{print $4}')"
`;
}

/**
 * The advisory backstop-readiness report for ONE backstop, from facts the probe
 * above already gathered. Pure, so it is testable against a fixture without a
 * node.
 *
 * NEVER FEEDS `drift`. This answers "could the backstop take load right now",
 * which is a fact about the FLEET's exposure, not about whether the backstop
 * itself needs repair. A consumer (the mgmt-api
 * digest) must not page on anything in here; see `advisory: true`.
 *
 * `sliceMaxMb` is the node's OWN declared `slice.maxMb` (hokon: 16384) —
 * read from the manifest, not measured, because the claim being contrasted
 * is a RULE ("a claw's per-unit cap reaches its slice", issue #26), not a
 * second measurement of another box. Citing hokon's own slice ceiling next
 * to its own measured per-unit cap is in hand already (the manifest entry
 * this node was selected from); nothing is ssh'd for it.
 *
 * `advisories` (#79 hygiene) is the three drifts the big-four audit found
 * that nothing reported: the running harvester's CONTENT (not byte
 * count), orphan systemd drop-in dirs, and `_work` size against disk
 * pressure. Each entry is `{ id, blocking: false, message, fix }` — `fix` is
 * the exact one-line command the OPERATOR runs by hand; this doctor never
 * runs it, and `blocking: false` is asserted by every test below because
 * none of this may ever become an `@here` (operator, 2026-10-01).
 */
export function buildBackstop(
	facts,
	{
		minFreeMb,
		repoHarvestBytes,
		repoHarvestSha,
		sliceMaxMb,
		harvesterPkgPath = HARVESTER_PKG_LOCAL_PATH,
		nodeName,
	}
) {
	const unitMaxMbValues = [
		...new Set(
			(facts.unitMax ?? [])
				.map((u) => u.max)
				.filter((m) => m && m !== 'max')
				.map((m) => Math.round(Number(m) / 1048576))
				.filter((m) => Number.isFinite(m) && m > 0)
		),
	].sort((x, y) => x - y);
	const availableMb =
		typeof facts.bkAvailKb === 'number' ? Math.round(facts.bkAvailKb / 1024) : null;
	const floorMb = typeof minFreeMb === 'number' ? minFreeMb : null;
	const available = availableMb === null || floorMb === null ? null : availableMb >= floorMb;
	const harvesterBytes =
		typeof facts.bkHarvestBytes === 'number' && facts.bkHarvestBytes >= 0
			? facts.bkHarvestBytes
			: null;
	// CONTENT, not byte count — a byte count can coincide (#79's actual find:
	// the hand-installed copy lacks #47's jit-*/warm-* stems and #76's
	// clipped-window flag, and could do so at an unchanged length). Either
	// side's hash missing is "I could not look", which is drift, never a
	// silent match — this never reads `undefined === undefined` as agreement,
	// the same trap `provenanceDrift` documents for the claw-side deploy.
	const harvesterSha =
		typeof facts.bkHarvestSha === 'string' && facts.bkHarvestSha.length > 0
			? facts.bkHarvestSha
			: null;
	const repoSha =
		typeof repoHarvestSha === 'string' && repoHarvestSha.length > 0 ? repoHarvestSha : null;
	const harvesterDrift = harvesterSha === null || repoSha === null || harvesterSha !== repoSha;
	// Does the measured per-unit cap reach this node's OWN slice ceiling? A
	// claw's units are expected to (issue #26); a flat sub-slice cap here is
	// the mismatch this whole readiness block exists to say out loud — a job
	// that would have fit in the slice is OOM-killed at the smaller number.
	const sliceCeilingMb = typeof sliceMaxMb === 'number' ? sliceMaxMb : null;
	const unitCapReachesSlice =
		unitMaxMbValues.length !== 1 || sliceCeilingMb === null
			? null
			: unitMaxMbValues[0] >= sliceCeilingMb;

	// ADVISORY FINDINGS (#79 hygiene). Each fires independently, each carries
	// the exact command an operator runs by hand, and none is folded into
	// `drift` anywhere in this file — see the doc comment above.
	const advisories = [];
	const harvesterPath =
		typeof facts.bkHarvestPath === 'string' && facts.bkHarvestPath.length > 0
			? facts.bkHarvestPath
			: null;
	if (harvesterDrift) {
		// The script is read once at startup, so a reinstall without a restart
		// leaves the old code running and this advisory standing.
		const reinstall = (to) =>
			`install -m 755 ${harvesterPkgPath} ${to} && systemctl --user restart ${HARVESTER_UNIT}`;
		advisories.push({
			id: 'harvester-drift',
			blocking: false,
			message:
				harvesterPath === null
					? `${HARVESTER_UNIT} is not running — there is no harvester process (#47/#76) whose ` +
						`script could be compared, so no per-job memory is being sampled`
					: harvesterSha === null
						? `${harvesterPath}, the script the running harvester executes, is unreadable — ` +
							`its content could not be compared`
						: `${harvesterPath} (the running harvester) does not match this package's ` +
							`runner-mem-harvest.py by CONTENT (installed sha256 ${harvesterSha.slice(0, 12)}…, ` +
							`package ${repoSha === null ? 'unknown' : `${repoSha.slice(0, 12)}…`}) — a byte ` +
							`count can coincide; this is sha256`,
			fix:
				harvesterPath === null
					? `systemctl --user enable --now ${HARVESTER_UNIT}`
					: reinstall(harvesterPath),
		});
	}
	// FLEET-OWNED NAMES ONLY (manager correction, 2026-10-03). The generic scan
	// also catches `app-invokeai@.service.d` / `app-org.kde.dolphin@.service.d`
	// on hokon: those are the OPERATOR's desktop session's own template/
	// transient units, never shipped or managed by this package, and "no unit
	// file" is normal for a `@`-template drop-in — it is not an orphan by this
	// package's definition. Advising `rm -r` on the operator's own desktop
	// config is exactly the "this package has no business recommending that"
	// mistake. `hokon-runner-{b,c,d}` is a LEGACY runner name from before the
	// `actions-runner-<repo>` scheme (confirmed live: `systemctl --user
	// list-unit-files 'hokon-runner*'` finds nothing, while every
	// `actions-runner-*.service.d` on hokon DOES have a matching unit) — both
	// prefixes are the fleet's own naming, so both are in scope; nothing else
	// is.
	const orphanDirs = (facts.dropins ?? [])
		.filter((d) => d.status === 'orphan')
		.filter((d) => fleetDropinPattern(nodeName).test(basename(d.dir).replace(/\.d$/, '')))
		.map((d) => d.dir);
	if (orphanDirs.length) {
		advisories.push({
			id: 'orphan-dropins',
			blocking: false,
			message:
				`${orphanDirs.length} fleet-owned systemd user drop-in dir(s) have no matching unit ` +
				`(systemctl --user list-unit-files reports nothing for them): ${orphanDirs.join(', ')}`,
			fix: `rm -r ${orphanDirs.map(shq).join(' ')}`,
		});
	}
	const workMb = typeof facts.bkWorkKb === 'number' ? Math.round(facts.bkWorkKb / 1024) : 0;
	const freeKb = typeof facts.bkRootFreeKb === 'number' ? facts.bkRootFreeKb : null;
	if (
		workMb >= WORK_ADVISORY_MIN_MB &&
		freeKb !== null &&
		facts.bkWorkKb >= freeKb * WORK_ADVISORY_FREE_SHARE
	) {
		advisories.push({
			id: 'backstop-work-size',
			blocking: false,
			message:
				`~/runners/actions-runner-*/_work totals ~${workMb} MB on a root disk with ` +
				`${Math.round(freeKb / 1024)} MB free (advisory floor: ${WORK_ADVISORY_MIN_MB} MB and ` +
				`${WORK_ADVISORY_FREE_SHARE * 100}%+ of free space)`,
			// Runner.Worker, NOT Runner.Listener (manager correction, 2026-10-03):
			// the Listener is the long-lived poller and is running on every
			// registered runner whether idle or not — `ps -eo args` on hokon shows
			// it live for every cohort member. The Worker process exists only
			// while a job is actually executing, so it is the one signal that
			// means "a job is in progress" — gating the prune on Listener would
			// have pruned nothing, ever.
			fix:
				'for d in ~/runners/actions-runner-*; do pgrep -f "$d/bin/Runner.Worker" >/dev/null 2>&1 || ' +
				'rm -rf "$d"/_work/*; done',
		});
	}

	return {
		advisory: true,
		unitMaxMb: unitMaxMbValues,
		unitCount: (facts.unitMax ?? []).length,
		sliceMaxMb: sliceCeilingMb,
		unitCapReachesSlice,
		floorMb,
		availableMb,
		available,
		topHolder: facts.bkTopHold ?? null,
		harvesterPath,
		harvesterBytes,
		harvesterRepoBytes: repoHarvestBytes,
		harvesterSha,
		harvesterRepoSha: repoSha,
		harvesterDrift,
		advisories,
	};
}
