/**
 * dispatch-warm-cache.ts's state and small helpers: the fleet-served-jobs
 * reader, the slice-override complaint, the dead-listener reap, the
 * verified-live warm-affinity map, and the result/observation types the main
 * tick builds and reads.
 *
 * Wave 5r lane B split of dispatch-warm-cache.ts (plan: 800-line ceiling,
 * pure move): every body below is unmodified from dispatch-warm-cache.ts
 * apart from the `export`s needed to keep each name re-exported from there —
 * `setWarmRepos`, `EMPTY_WARM_RESULT`, `ObservedWarmSlot` and
 * `ObservedWarmNode` were module-private there and stay that way from this
 * module's own callers' point of view (dispatch-warm-cache.ts does not
 * re-export them further, since nothing outside it ever read them).
 */
import { DEFAULT_RUNNER_SLICE, resolveSliceName } from './ephemeral.js';
import { type WarmServedJob, type WarmSlotState } from './ephemeral-warm.js';
import { evictWarmListener, warmRegistration, type GhLike } from './ephemeral-exec.js';
import { type EphemeralTickInput, shellOnNode } from './ephemeral-shared.js';
import { jobRecords } from '../job-history-store.js';
import { logger } from '../host.js';

/**
 * Every job the FLEET has served, from the persisted history, as the `served`
 * input `planWarmFleet` scores — or `null` when the history could not be read.
 *
 * This is the ONLY input that says what SHOULD be warm — see
 * "The cache is DYNAMIC" in warm-listener-cache-2026-09-05.md. No repo is ever
 * seeded or declared; recent traffic is scored every tick and that answer moves
 * on its own as traffic does.
 *
 * FLEET-WIDE, not per node (wave 3k §B). Lane A reshaped this from the MRU
 * `lastServedRepoByNode` into every job per node; the joint allocation needs
 * the fleet's demand instead, because a warm listener serves its repo's next
 * job wherever GitHub would otherwise have sent it — hokon's and the
 * ineligible nodes' jobs included. Which node served a job says nothing about
 * what a slot elsewhere should hold, so the runner is not resolved at all.
 */
export function fleetServedJobs(): WarmServedJob[] | null {
	try {
		const out: WarmServedJob[] = [];
		for (const r of jobRecords()) {
			const startedAtMs = Date.parse(r.startedAt);
			if (!Number.isFinite(startedAtMs)) continue;
			// The duration is what tells a repo whose jobs overlap from one whose
			// jobs run one at a time — see warmUnitValues.
			out.push({ repo: r.repo, startedAtMs, durationMs: r.durationSec * 1000 });
		}
		return out;
	} catch (err) {
		// COULD NOT LOOK, and it must not be read as "looked, found nothing" in
		// any way that evicts. `null` reaches planWarmFleet as `idle` on every
		// node: every existing slot is KEPT and nothing is filled — slower to
		// warm, never wrong. The partial walk is discarded rather than scored,
		// because a half-read history could rank a repo that merely came first in
		// the file above the one that dominates. Said out loud so the two cases
		// stay distinguishable in the log.
		logger.warn(
			`[warm-cache] job history unreadable, holding every slot as-is: ${
				err instanceof Error ? err.message : String(err)
			}`
		);
		return null;
	}
}

/**
 * Nodes already warned about a slice override, so the check costs one log line
 * per node per process rather than one per tick. Module-level mutable state, in
 * a file that already holds sixteen such singletons — mgmt-api restarts ~5x/day,
 * so the worst case is the warning repeating five times a day, which is the
 * right cadence for something an operator has to act on.
 */
const warnedSliceOverride = new Set<string>();

/**
 * The slice the WARM minter will use for a listener on this node, and a loud
 * complaint if the manifest asked for something else.
 *
 * `buildWarmSpawnPlan` defaults to {@link DEFAULT_RUNNER_SLICE} and the node's
 * name cannot reach it: a warm mint's slice would have to travel through
 * `mintWarmListener`. The JIT path no longer has this gap — since #120 its
 * `MintRequest` carries the node's slice. That is sound only while every
 * warm-capable node agrees with the default, which is true (hokon is the sole
 * override, and as a backstop it never holds a listener).
 *
 * "Sound only while" is exactly the kind of claim that rots silently, so it is
 * ASSERTED at the mint sites rather than asserted in a comment. The hard gate
 * lives in `deploy-runners-slice.mjs`, which reads the same manifest and fails
 * `fleet slice --check`; this is the runtime half, on the path that would
 * actually mint the wrong placement.
 *
 * It does NOT refuse the mint. An uncontained runner is bad; no runner at all is
 * worse, and a node whose override is `ci-runner.slice` still gets a real
 * ceiling from the default — just not the one its operator asked for.
 */
export function checkMintSlice(nodes: EphemeralTickInput['nodes'], node: string): void {
	const declared = nodes[node]?.slice?.name;
	const want = resolveSliceName(declared);
	if (want === DEFAULT_RUNNER_SLICE || warnedSliceOverride.has(node)) return;
	warnedSliceOverride.add(node);
	logger.error(
		`[mint] ${node} declares slice.name=${declared} but the warm path can only place listeners in ` +
			`${DEFAULT_RUNNER_SLICE}: the name is not threaded through mintWarmListener. Its ` +
			`warm-* units will be contained in ${DEFAULT_RUNNER_SLICE}, NOT in ${want}. Thread it, ` +
			`or drop the override — 'fleet slice --check' fails until one of those happens.`
	);
}

/** Test seam: the warning is once-per-node-per-process, so a test asserting it
 *  fires must be able to start from a clean sheet. Exported rather than reset
 *  from inside the check, because the once-per-process behaviour IS the thing
 *  under test on the second call. */
export function resetMintSliceWarnings(): void {
	warnedSliceOverride.clear();
}

/**
 * Remove a warm registration whose listener is positively known dead — #61.
 *
 * THE LEAK THIS CLOSES. A warm unit is transient, so a reboot takes it with
 * it while `$HOME/.hadoku/warm/repo` survives. `currentWarmSlot` then reads
 * "no slot" (correctly — there is no listener), the planner takes the FILL
 * branch rather than the rotate branch, and `mintWarmListener` runs `RESET=1`,
 * which overwrites the marker with the NEW repo. Nothing ever held the old
 * repo's name again, so nothing ever deleted `warm-<node>-<old-repo>`. That is
 * how `warm-claw-9-hadoku-tenhands` outlived claw-9's 2026-09-22/23 migration
 * reboots with carriers `[]`. `reapJitRunners` cannot cover it: that sweep is
 * `jit-` prefixed, and by design — it reasons about slot indices in the
 * process tree, which a warm listener has none of.
 *
 * THREE INDEPENDENT FACTS, and a delete needs all three, each from a reader
 * that is not the writer of the thing it reads:
 *
 *   1. the marker names the repo          (the node's own record)
 *   2. systemd reports the unit NOT active (the kernel, and `active === false`
 *      rather than `null` — "could not look" is not "dead")
 *   3. GitHub reports the registration OFFLINE and not busy (the registry)
 *
 * Any disagreement means no delete. An unreachable node never gets this far
 * (the observation pass returns before the marker read), an unreadable listing
 * reads as `null` from `warmRegistration` and stops here, and a registration
 * that is online or busy means something IS answering — the marker is stale,
 * the registration is not, and deleting it would cancel a running job. Same
 * fail-closed direction as §12.8's reap on an unreachable node.
 *
 * Returns whether a registration was actually removed.
 */
export async function reapDeadWarmListener(
	node: string,
	repo: string,
	unit: string,
	token: string,
	gh: GhLike & { get: (path: string, token: string, repo?: string) => Promise<unknown> },
	sh: typeof shellOnNode
): Promise<boolean> {
	const reg = await warmRegistration(repo, unit, token, gh);
	if (!reg) return false;
	if (reg.online || reg.busy) return false;
	logger.warn(
		`[warm-cache] ${node}: reaping ${unit} on ${repo} — marker present, unit dead, ` +
			'registration offline. A warm listener died outside this code path.'
	);
	return evictWarmListener(node, repo, unit, token, gh, sh);
}

/**
 * P5.1's placement input: the repo each node holds a VERIFIED-LIVE warm
 * listener for, as of the last warm-cache tick that actually ran.
 *
 * WHY THIS IS A MODULE-LEVEL MAP AND NOT RE-DERIVED PER DISPATCH. The two
 * clocks differ on purpose — `dispatchWarmCache` runs at
 * WARM_CACHE_INTERVAL_MS (60 s) because its per-node probe is a GitHub listing
 * whose ceiling is its spend, while `dispatchEphemeral` runs at the dispatch tick's 15 s.
 * Re-deriving this on every dispatch would quadruple exactly the call this
 * fleet already blacked itself out on (REAP_INTERVAL_MS, 2026-09-06: 19 minutes
 * of every hour at `remaining: 0`). So the dispatcher reads the last
 * observation, which is at most 60 s old.
 *
 * STALENESS IS SAFE IN ONE DIRECTION ONLY, AND IT IS THIS ONE. A stale entry
 * makes placement PREFER a node; every refusal in `choosePlacement` — demoted,
 * drained, unhealthy, label mismatch, `admitMint` — still runs against that node
 * exactly as it would have, so the worst case is a job placed on a node whose
 * listener rotated in the last minute, i.e. a cold mint where a warm hit was
 * expected. That is today's behaviour, not a regression.
 *
 * EMPTY AFTER A RESTART, and that is the honest answer rather than a bug.
 * mgmt-api restarts ~5x/day, so for up to 60 s after each one no node carries
 * affinity — which is precisely what `warmRepo: undefined` is documented to
 * mean ("no listener, or nobody looked — either way this falls through to plain
 * ordering"). It is NEVER a reason to refuse a node, so an empty map costs
 * latency and cannot cost correctness. Persisting it would be the opposite
 * trade: a warm slot remembered across a restart it did not survive.
 */
export let warmRepoByNode: ReadonlyMap<string, string> = new Map();

/**
 * Replace the observation wholesale, and say so when it moved.
 *
 * WHOLESALE because a node that lost its listener must stop being preferred on
 * the very next pass — the same rule and the same reason as
 * `setUnschedulableNodes` in schedulable.ts.
 *
 * The log line is this lane's answer to "make it observable at the same time"
 * (`warm-affinity-measured-2026-09-14.md` §10.3). It is the placement INPUT,
 * not the outcome; summing `Placement.viaAffinity` needs a counter that
 * `planTick`/`runDispatchPass` do not carry yet. Joining these lines against
 * `job-history`'s `jit-<node>-<repo>-…` records is what turns "did affinity
 * change anything" into a number in the meantime — §5 of that doc, but against
 * an observation with a timestamp rather than against the warm records
 * themselves.
 */
export function setWarmRepos(next: ReadonlyMap<string, string>): void {
	const changed =
		next.size !== warmRepoByNode.size ||
		[...next].some(([node, repo]) => warmRepoByNode.get(node) !== repo);
	warmRepoByNode = next;
	if (!changed) return;
	logger.info(
		`[warm-affinity] verified-live listeners: ${
			next.size
				? [...next]
						.map(([node, repo]) => `${node}=${repo}`)
						.sort()
						.join(' ')
				: '(none — placement falls through to plain ordering)'
		}`
	);
}

/**
 * What the last warm-cache tick observed, for the dispatcher and for tests.
 *
 * Copied, so a caller cannot mutate the fleet's belief — same rule as
 * `unschedulableNodes()`.
 */
export function warmReposForPlacement(): ReadonlyMap<string, string> {
	return new Map(warmRepoByNode);
}

/** Test seam. Not part of the supported API. */
export function __resetWarmReposForTesting(): void {
	warmRepoByNode = new Map();
}

export interface WarmCacheResult {
	filled: number;
	rotated: number;
	kept: number;
	locked: number;
	evicted: number;
	/**
	 * Registrations removed because the listener behind them was positively
	 * observed DEAD — #61's ghost, counted apart from `evicted` on purpose.
	 * An eviction is this tick deciding to move a live slot; a reap is this
	 * tick finding one it never got to decide about. Summing them would hide
	 * exactly the number that says whether the leak is back.
	 */
	reaped: number;
	failed: number;
}

export const EMPTY_WARM_RESULT: WarmCacheResult = {
	filled: 0,
	rotated: 0,
	kept: 0,
	locked: 0,
	evicted: 0,
	reaped: 0,
	failed: 0,
};

/** What the warm tick's observation pass learned about one ELIGIBLE node —
 *  everything the joint allocation and the act pass after it need. */
/**
 * `WarmSlotState` plus the registration's OWN labels (wave 4e follow-up,
 * #102) — a LOCAL widening, not an edit to `ephemeral.ts`'s `WarmSlotState`:
 * `planWarmFleet` (pure, in that file) only ever reads `repo`/`busy`/
 * `mintedOrRefreshedAtMs` off `current`, so handing it one of these costs
 * nothing there and needs no change to its own type. `null` means "could not
 * read the registration's labels" (the same `reg` miss that already makes
 * `busy`/`online` unavailable) — never "it has none".
 */
export type ObservedWarmSlot = WarmSlotState & { labels: string[] | null };

export interface ObservedWarmNode {
	node: string;
	m: EphemeralTickInput['nodes'][string];
	installedMb: number;
	current: ObservedWarmSlot | null;
	/** #101: this pass's OWN measurement, not borrowed from the dispatch
	 *  tick's verdict — see the probe below and `spaceRefusal`. */
	tmpFreeMb: number | null;
	workFreeMb: number | null;
}
