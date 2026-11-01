/**
 * The JIT/warm-runner naming convention, and the mint-floor threshold
 * watchers explain their alerts against — moved out of
 * `src/runners/ephemeral.ts`/`ephemeral-admission.ts` (wave clean-1 lane C,
 * cut (iii)). Both ci-scheduling (minting, admission) and observation
 * (`disk-watch.ts`, `runner-health-watch.ts`, which describe a disk alert
 * relative to the SAME floor the dispatcher mints against) need these facts,
 * and config is the one layer both can legally reach. `ephemeral.ts` and
 * `ephemeral-admission.ts` re-export every name here under its original
 * path, so no existing importer changes.
 */

/** Every JIT runner name starts with this. The sweep keys its reaping on it. */
export const JIT_PREFIX = 'jit-';

/** Every warm listener's unit/registration name starts with this — distinct
 * from {@link JIT_PREFIX} so the JIT reaper's sweep, which keys on that prefix
 * alone, never touches a warm listener and never ages one out from under a job
 * it did not mint. */
export const WARM_PREFIX = 'warm-';

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

/**
 * Is this a proof runner minted for `node`? Stricter than a prefix: a real
 * mint never ends `-j0-r0-` (see `prove-job-parse.ts`'s `proofRunnerName`,
 * which mints with exactly that run/job id so a canary can never collide
 * with a real run).
 */
export function isProofRunnerName(name: string, node: string): boolean {
	return (
		name.startsWith(`${JIT_PREFIX}${node}-proof-`) &&
		/-j0-r0-\d+$/.test(name.replace(/\.service$/, ''))
	);
}

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
