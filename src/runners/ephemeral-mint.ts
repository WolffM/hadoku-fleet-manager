import { ciUnitProperties, JIT_UNIT_MAX_SEC } from './ephemeral.js';

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
	// It contains `.credentials` — a real OAuth token for the runner, private key
	// included. As an argv token it lands in two places: the systemd journal,
	// which records the full ExecStart at unit start and KEEPS IT; and
	// `/proc/<pid>/cmdline`, which ANY local user can read for the whole job
	// unless /proc is mounted hidepid. Once CI has its own user and tenants share
	// the claw (`<app>-svc`, `<app>-agent`), the second is a tenant taking jobs
	// and their secrets — reported from claw-4 on 2026-10-27, read off `ps`.
	//
	// So the config is written to the slot at mode 0600 and handed to the
	// listener in `ACTIONS_RUNNER_INPUT_JITCONFIG`. `--jitconfig` is not the only
	// door: actions/runner's CommandSettings reads every arg from
	// `ACTIONS_RUNNER_INPUT_<NAME>`, masks it, and REMOVES it from its own
	// environment before starting the worker, so job steps do not inherit it.
	// `/proc/<pid>/environ` is readable only by the same user (and root).
	// Executed on claw-4's payload: a bad value through the env answers the same
	// Base-64 error as through the flag, and neither answers "Not configured".
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
			...ciUnitProperties(o),
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
			`ACTIONS_RUNNER_INPUT_JITCONFIG=$(cat ${cfgPath}); export ACTIONS_RUNNER_INPUT_JITCONFIG; rm -f ${cfgPath}; exec ${o.slot}/bin/Runner.Listener run`,
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
			...ciUnitProperties(o),
			`${o.slot}/bin/Runner.Listener`,
			'run',
		],
	};
}
